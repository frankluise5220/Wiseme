/**
 * API: /api/v1/bill/installment
 *
 * POST JSON body:
 *   accountId: Account.id for a credit-card account
 *   statementMonth?: string (YYYY-MM), optional compatibility override; normally derived from date
 *   amount: number, the statement amount to finance; positive and not capped by calculated unpaid amount
 *   date: string (YYYY-MM-DD), the statement-installment confirmation date and source statement-month owner
 *   firstPaymentDate?: string (YYYY-MM-DD), first generated principal/fee posting date; defaults to date
 *   totalRuns: number (2-120)
 *   rateType: "period_fee" | "annual_interest"
 *   rate: number (0-100)
 *
 * Returns { ok: true, data } or { ok: false, error }.
 */
import { AccountKind, CreditCardInstallmentSourceType } from "@prisma/client";
import { NextResponse } from "next/server";

import { creditBillUnpaidAmount } from "@/lib/credit/billing";
import { type CreditCardInstallmentRateType } from "@/lib/credit/installment";
import { prisma } from "@/lib/db/prisma";
import { ensureBankInstallmentExpenseCategory } from "@/lib/default-categories";
import { toStatementMonth } from "@/lib/date-utils";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { getCreditBillAccountIds } from "@/lib/server/credit-card-institution-settings";
import { createCreditCardInstallmentPlan } from "@/lib/server/credit-card-installment";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseDateOnlyUtc(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function dateInCycle(date: Date, cycle: { periodStart: Date; periodEnd: Date }) {
  return date.getTime() >= cycle.periodStart.getTime() && date.getTime() <= cycle.periodEnd.getTime();
}

export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ ok: false, code: "INVALID_BODY", error: "无效的请求体" }, { status: 400 });

    const accountId = String(body.accountId ?? "").trim();
    const statementMonthInput = String(body.statementMonth ?? "").trim();
    const amount = roundMoney(Number(body.amount));
    const totalRuns = Number(body.totalRuns);
    const rate = Number(body.rate ?? 0);
    const rateType = String(body.rateType ?? "period_fee") as CreditCardInstallmentRateType;
    const dateInput = String(body.date ?? "").trim();
    const installmentDate = parseDateOnlyUtc(dateInput);
    const firstPaymentDateInput = String(body.firstPaymentDate ?? dateInput).trim();
    const firstPaymentDate = parseDateOnlyUtc(firstPaymentDateInput);

    if (!accountId) return NextResponse.json({ ok: false, code: "CREDIT_CARD_ACCOUNT_REQUIRED", error: "缺少信用卡账户" }, { status: 400 });
    if (statementMonthInput && !/^\d{4}-\d{2}$/.test(statementMonthInput)) {
      return NextResponse.json({ ok: false, code: "INVALID_STATEMENT_MONTH", error: "账单月份格式不正确" }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ ok: false, code: "INVALID_AMOUNT", error: "分期金额必须大于 0" }, { status: 400 });
    }
    if (!Number.isInteger(totalRuns) || totalRuns < 2 || totalRuns > 120) {
      return NextResponse.json({ ok: false, code: "INVALID_TOTAL_RUNS", error: "分期期数应为 2 至 120 期" }, { status: 400 });
    }
    if (rateType !== "period_fee" && rateType !== "annual_interest") {
      return NextResponse.json({ ok: false, code: "INVALID_RATE_TYPE", error: "分期费率类型不正确" }, { status: 400 });
    }
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      return NextResponse.json({ ok: false, code: "INVALID_RATE", error: "费率应为 0 至 100" }, { status: 400 });
    }
    if (!installmentDate) {
      return NextResponse.json({ ok: false, code: "INVALID_INSTALLMENT_DATE", error: "分期日期格式不正确" }, { status: 400 });
    }
    if (!firstPaymentDate) {
      return NextResponse.json({ ok: false, code: "INVALID_FIRST_PAYMENT_DATE", error: "首期入账日期格式不正确" }, { status: 400 });
    }

    const account = await prisma.account.findFirst({
      where: { id: accountId, householdId, kind: AccountKind.bank_credit, isActive: true },
      select: {
        id: true,
        name: true,
        householdId: true,
        institutionId: true,
        kind: true,
        creditBillMode: true,
        billingDay: true,
        repaymentDay: true,
      },
    });
    if (!account) return NextResponse.json({ ok: false, code: "CREDIT_CARD_ACCOUNT_NOT_FOUND", error: "信用卡账户不存在" }, { status: 404 });
    if (!account.billingDay) {
      return NextResponse.json({ ok: false, code: "BILLING_DAY_MISSING", error: "信用卡缺少账单日，无法创建账单分期" }, { status: 400 });
    }
    const billingDay = account.billingDay;
    const billAccountIds = await getCreditBillAccountIds(prisma, account);
    const storageAccountId = billAccountIds[0] ?? account.id;
    const cycle = await prisma.creditCardCycle.findFirst({
      where: {
        accountId: storageAccountId,
        periodStart: { lte: installmentDate },
        periodEnd: { gte: installmentDate },
      },
    });
    if (!cycle) {
      return NextResponse.json({ ok: false, code: "STATEMENT_CYCLE_NOT_FOUND", error: "这一期账单尚未生成，请先打开账单列表" }, { status: 404 });
    }
    const statementMonth = cycle.statementMonth;
    if (!dateInCycle(installmentDate, cycle)) {
      return NextResponse.json({ ok: false, code: "INSTALLMENT_DATE_NOT_IN_CYCLE", error: "分期日期没有归属到有效账单周期" }, { status: 400 });
    }
    if (statementMonthInput && statementMonthInput !== statementMonth) {
      return NextResponse.json({ ok: false, code: "STATEMENT_MONTH_MISMATCH", error: `分期日期归属 ${statementMonth} 账单，与提交的账单月份不一致` }, { status: 400 });
    }
    const existingPlan = await prisma.creditCardInstallmentPlan.findFirst({
      where: {
        householdId,
        accountId: { in: billAccountIds },
        sourceType: CreditCardInstallmentSourceType.statement,
        sourceStatementMonth: statementMonth,
        status: "active",
      },
      select: { id: true },
    });
    if (cycle.isCurrentCycle) {
      return NextResponse.json({ ok: false, code: "CURRENT_CYCLE_NOT_STATEMENT", error: "当前账期尚未出账，请在消费记录中使用消费分期" }, { status: 400 });
    }
    if (existingPlan) {
      return NextResponse.json({ ok: false, code: "INSTALLMENT_ALREADY_EXISTS", error: "这一期账单已经创建过账单分期" }, { status: 409 });
    }

    const referenceUnpaidAmount = creditBillUnpaidAmount(cycle);
    const originalAmount = Math.max(referenceUnpaidAmount, amount);
    const adjustmentDate = installmentDate;

    const firstPaymentStatementMonth = toStatementMonth(firstPaymentDate, billingDay);
    const created = await prisma.$transaction(async (tx) => {
      const category = await ensureBankInstallmentExpenseCategory(tx, householdId);
      return createCreditCardInstallmentPlan(tx, {
        category,
        householdId,
        account: { id: account.id, name: account.name },
        sourceType: CreditCardInstallmentSourceType.statement,
        sourceStatementMonth: statementMonth,
        originalAmount,
        principal: amount,
        totalRuns,
        rateType,
        rate,
        adjustmentDate,
        adjustmentStatementMonth: statementMonth,
        billingDay,
        firstPaymentDate,
        firstPaymentStatementMonth,
        label: `${statementMonth} 账单`,
      });
    });

    await recalcAndSaveAccountBalance(account.id);
    await invalidateCreditCardCycleCacheForAccountIds(billAccountIds);
    revalidateAfterTxChange();

    return NextResponse.json({
      ok: true,
      data: {
        planId: created.plan.id,
        sourceType: created.plan.sourceType,
        sourceStatementMonth: statementMonth,
        installmentPrincipal: amount,
        firstStatementMonth: firstPaymentStatementMonth,
        totalRuns,
      },
    });
  } catch (error) {
    console.error("[bill-installment] failed to create statement installment", error);
    return NextResponse.json(
      { ok: false, code: "CREATE_FAILED", error: error instanceof Error ? error.message : "创建账单分期失败" },
      { status: 500 },
    );
  }
}
