import { IntervalUnit, RegularInvestStatus, TransactionType } from "@prisma/client";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { formatDateUtc, toNumber } from "@/lib/date-utils";
import {
  calcLoanScheduledAmount,
  estimateLoanEqualPaymentRemainingRuns,
  getEffectiveLoanAnnualRate,
  roundLoanMoney,
} from "@/lib/loan-repayment";
import {
  decodeScheduledTaskMemo,
  encodeScheduledTaskMemo,
  shouldPreferLoanAutoDebitPlan,
  shouldPreferLoanScheduledPlan,
} from "@/lib/scheduled-task";
import {
  DEFAULT_LOAN_PREPAY_STRATEGY,
  parseLoanPrepayStrategy,
  type LoanPrepayStrategy,
} from "@/lib/loan-prepay-strategy";
import { calcInitialScheduledRunDate } from "@/lib/scheduled-task-date";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { listLoanRateAdjustmentsByAccountIds, resolveLoanRateAdjustments } from "@/lib/server/loan-rate-adjustments";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

/**
 * POST /api/v1/loan-repayment/recalculate
 * Body: { accountId: string, startDate?: "YYYY-MM-DD" }
 * If startDate points to a prepayment record, the recalculation strategy is read from that record.
 * For reduce-term prepayments, the carried payment is the generated/manual payment from
 * the repayment period before that prepayment. The natural remaining runs are solved
 * from remaining principal, effective rate, and carried payment; the old remaining
 * term is not an input or cap.
 * If startDate is only a rate adjustment, the payment is recalculated over the
 * current plan's remaining runs and the plan term is preserved.
 * Recalculates only the loan repayment plan from the current loan balance,
 * existing executed count, selected start date, and stored loan rate adjustments.
 * Existing repayment transaction records are factual history and are never deleted or rebuilt here.
 */
function parseDateOnlyUtc(value: unknown) {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function parseLoanTotalRunsFromNote(note?: string | null) {
  const match = String(note ?? "").match(/期数[：:]\s*(\d+)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function alignToRepaymentRunDate(
  date: Date,
  plan: { intervalUnit: IntervalUnit; intervalValue: number; executionDay?: number | null },
) {
  return calcInitialScheduledRunDate(date, plan.intervalUnit, plan.intervalValue, plan.executionDay, false);
}

async function getPrepaymentStrategyForStartDate(params: {
  householdId: string;
  accountId: string;
  date: Date | null;
}): Promise<{ strategy: LoanPrepayStrategy } | null> {
  if (!params.date) return null;
  const row = await prisma.txRecord.findFirst({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      source: "debt_prepay_out",
      type: TransactionType.transfer,
      toAccountId: params.accountId,
      date: params.date,
    },
    orderBy: { id: "desc" },
    select: { toNote: true },
  });
  if (!row) return null;
  return { strategy: parseLoanPrepayStrategy(row.toNote) ?? DEFAULT_LOAN_PREPAY_STRATEGY };
}

function structuredPaymentTotal(row: {
  amount: unknown;
  debtPrincipalAmount?: unknown;
  debtInterestAmount?: unknown;
  debtFeeAmount?: unknown;
}) {
  const hasStructuredSplit =
    row.debtPrincipalAmount != null ||
    row.debtInterestAmount != null ||
    row.debtFeeAmount != null;
  if (!hasStructuredSplit) return Math.abs(toNumber(row.amount));
  return (
    Math.abs(toNumber(row.debtPrincipalAmount)) +
    Math.abs(toNumber(row.debtInterestAmount)) +
    Math.abs(toNumber(row.debtFeeAmount))
  );
}

async function getCarriedPaymentAmountBeforeDate(params: {
  householdId: string;
  accountId: string;
  planId: string;
  date: Date | null;
}) {
  if (!params.date) return null;
  const generatedRow = await prisma.txRecord.findFirst({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      regularInvestPlanId: params.planId,
      source: { in: ["scheduled_task", "loan_bill"] },
      date: { lt: params.date },
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: {
      amount: true,
      debtPrincipalAmount: true,
      debtInterestAmount: true,
      debtFeeAmount: true,
    },
  });
  const generatedAmount = generatedRow ? structuredPaymentTotal(generatedRow) : null;
  if (generatedAmount != null && generatedAmount > 0.005) return generatedAmount;

  const manualRepaymentRow = await prisma.txRecord.findFirst({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      source: "debt_repay_out",
      type: TransactionType.transfer,
      toAccountId: params.accountId,
      date: { lt: params.date },
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    select: {
      amount: true,
      debtPrincipalAmount: true,
      debtInterestAmount: true,
      debtFeeAmount: true,
    },
  });
  const manualAmount = manualRepaymentRow ? structuredPaymentTotal(manualRepaymentRow) : null;
  return manualAmount != null && manualAmount > 0.005 ? manualAmount : null;
}

export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null);
    const accountId = String(body?.accountId ?? "").trim();
    const requestedStartDate = body?.startDate ? parseDateOnlyUtc(body.startDate) : null;

    if (!accountId) return NextResponse.json({ ok: false, code: "LOAN_ACCOUNT_REQUIRED", error: "缺少贷款账户" }, { status: 400 });
    if (body?.startDate && !requestedStartDate) {
      return NextResponse.json({ ok: false, code: "INVALID_START_DATE", error: "重算起始日期不正确" }, { status: 400 });
    }

    const plans = await prisma.regularInvestPlan.findMany({
      where: {
        householdId,
        accountId,
        fundCode: "loan_repayment",
        status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused] },
      },
      include: {
        Account_RegularInvestPlan_accountIdToAccount: {
          select: { id: true, balance: true },
        },
      },
      orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
    });
    let scheduledPlan: (typeof plans)[number] | null = null;
    let autoDebitPlan: (typeof plans)[number] | null = null;
    for (const candidate of plans) {
      if (shouldPreferLoanScheduledPlan(candidate, scheduledPlan)) scheduledPlan = candidate;
      if (shouldPreferLoanAutoDebitPlan(candidate, autoDebitPlan)) autoDebitPlan = candidate;
    }
    const plan = autoDebitPlan ?? scheduledPlan;
    if (!plan) return NextResponse.json({ ok: false, code: "RECALC_PLAN_NOT_FOUND", error: "未找到可重算的还款计划" }, { status: 404 });

    const memo = decodeScheduledTaskMemo(plan.memo);
    if (memo.type !== "loan_repayment") {
      return NextResponse.json({ ok: false, code: "NOT_LOAN_REPAYMENT_PLAN", error: "当前计划不是贷款还款计划" }, { status: 400 });
    }
    if (memo.repaymentMethod === "自由还款") {
      return NextResponse.json({ ok: false, code: "FREE_REPAYMENT_NOT_RECALCULABLE", error: "自由还款没有固定计划，不需要重算" }, { status: 400 });
    }

    const originalBorrow = await prisma.txRecord.findFirst({
      where: {
        householdId,
        deletedAt: null,
        source: { in: ["debt_borrow_in", "debt_financed_purchase"] },
        type: TransactionType.transfer,
        accountId: plan.accountId,
      },
      orderBy: { date: "asc" },
      select: { date: true, note: true },
    });
    const originalTotalRuns = memo.originalTotalRuns ?? parseLoanTotalRunsFromNote(originalBorrow?.note);
    const remainingPrincipal = Math.abs(toNumber(plan.Account_RegularInvestPlan_accountIdToAccount.balance));
    const executedRuns = Math.max(0, plan.executedRuns ?? 0);
    const intervalMonths = memo.repaymentIntervalMonths ?? (plan.intervalUnit === IntervalUnit.month ? plan.intervalValue : 1);
    const executedRunsBeforeRequestedStart = requestedStartDate
      ? await prisma.txRecord.count({
          where: {
            householdId,
            regularInvestPlanId: plan.id,
            source: { in: ["scheduled_task", "loan_bill"] },
            deletedAt: null,
            date: { lt: requestedStartDate },
          },
        })
      : executedRuns;
    const remainingRunsAtRequestedStart =
      originalTotalRuns != null
        ? Math.max(0, originalTotalRuns - executedRunsBeforeRequestedStart)
        : plan.totalRuns == null
          ? null
          : Math.max(0, plan.totalRuns - executedRunsBeforeRequestedStart);
    const effectiveRemainingRuns = requestedStartDate
      ? remainingRunsAtRequestedStart
      : plan.totalRuns == null
        ? null
        : Math.max(0, plan.totalRuns - executedRuns);
    const alignedRequestedStartDate = requestedStartDate
      ? alignToRepaymentRunDate(requestedStartDate, plan)
      : plan.nextRunDate;
    const recalculateStartDate = formatDateUtc(alignedRequestedStartDate) < formatDateUtc(plan.nextRunDate)
      ? plan.nextRunDate
      : alignedRequestedStartDate;
    const prepaymentAtStartDate =
      await getPrepaymentStrategyForStartDate({
        householdId,
        accountId: plan.accountId,
        date: requestedStartDate,
      });
    const isPrepaymentRecalculation = !!prepaymentAtStartDate;
    const strategy = prepaymentAtStartDate?.strategy ?? null;
    const tableAdjustments = (await listLoanRateAdjustmentsByAccountIds({
      householdId,
      accountIds: [plan.accountId],
    })).get(plan.accountId);
    const adjustments = resolveLoanRateAdjustments({
      tableAdjustments,
      memoAdjustments: memo.loanRateAdjustments,
      mortgageLprDiscount: memo.mortgageLprDiscount,
      loanStartDate: originalBorrow?.date ? formatDateUtc(originalBorrow.date) : memo.firstRepaymentDate ?? formatDateUtc(plan.startDate),
    });

    if (remainingPrincipal <= 0.005) {
      await prisma.regularInvestPlan.update({
        where: { id: plan.id },
        data: {
          status: RegularInvestStatus.completed,
          endDate: new Date(),
          memo: encodeScheduledTaskMemo({ ...memo, originalTotalRuns: originalTotalRuns ?? memo.originalTotalRuns ?? null, loanRateAdjustments: [] }),
        },
      });
      revalidateAfterTxChange();
      return NextResponse.json({ ok: true, data: { status: "completed", nextAmount: 0, remainingRuns: 0 } });
    }
    if (strategy === "settle") {
      return NextResponse.json({ ok: false, code: "SETTLE_REQUIRES_ZERO_BALANCE", error: "全部结清要求贷款余额为 0，请检查提前还本金金额" }, { status: 400 });
    }

    const nextRunDateKey = formatDateUtc(recalculateStartDate);
    const effectiveAnnualRate = getEffectiveLoanAnnualRate({
      baseAnnualRate: memo.annualRate,
      adjustments,
      date: nextRunDateKey,
    });
    const carriedPaymentAmount =
      prepaymentAtStartDate && strategy === "reduce_term"
        ? await getCarriedPaymentAmountBeforeDate({
            householdId,
            accountId: plan.accountId,
            planId: plan.id,
            date: alignedRequestedStartDate,
          })
        : null;
    const currentAmount = carriedPaymentAmount ?? toNumber(plan.amount);
    const updateData: { amount?: number; totalRuns?: number; nextRunDate: Date; memo: string } = {
      nextRunDate: recalculateStartDate,
      memo: encodeScheduledTaskMemo({ ...memo, originalTotalRuns: originalTotalRuns ?? memo.originalTotalRuns ?? null, loanRateAdjustments: [] }),
    };

    if (!isPrepaymentRecalculation) {
      if (!effectiveRemainingRuns || effectiveRemainingRuns <= 0) {
        return NextResponse.json({ ok: false, code: "INSUFFICIENT_REMAINING_RUNS", error: "计划剩余期数不足，无法重算" }, { status: 400 });
      }
      const nextAmount = calcLoanScheduledAmount({
        repaymentMethod: memo.repaymentMethod,
        annualRate: effectiveAnnualRate,
        principal: remainingPrincipal,
        totalRuns: effectiveRemainingRuns,
        intervalMonths,
      });
      if (!nextAmount || nextAmount <= 0) {
        return NextResponse.json({ ok: false, code: "SCHEDULED_AMOUNT_CALC_FAILED", error: "无法重算月供，请检查利率、剩余本金和剩余期数" }, { status: 400 });
      }
      updateData.amount = nextAmount;
    } else if (strategy === "reduce_payment") {
      const fixedTermRemainingRuns = effectiveRemainingRuns;
      if (!fixedTermRemainingRuns || fixedTermRemainingRuns <= 0) {
        return NextResponse.json({ ok: false, code: "ORIGINAL_TERM_INSUFFICIENT", error: "原始贷款期限不足，无法按期限不变重算月供" }, { status: 400 });
      }
      const nextAmount = calcLoanScheduledAmount({
        repaymentMethod: memo.repaymentMethod,
        annualRate: effectiveAnnualRate,
        principal: remainingPrincipal,
        totalRuns: fixedTermRemainingRuns,
        intervalMonths,
      });
      if (!nextAmount || nextAmount <= 0) {
        return NextResponse.json({ ok: false, code: "SCHEDULED_AMOUNT_CALC_FAILED", error: "无法重算月供，请检查利率、剩余本金和剩余期数" }, { status: 400 });
      }
      updateData.amount = nextAmount;
      if (originalTotalRuns != null && originalTotalRuns > executedRuns) {
        updateData.totalRuns = originalTotalRuns;
      }
    } else {
      if (currentAmount <= 0) {
        return NextResponse.json({ ok: false, code: "INVALID_PLAN_AMOUNT", error: "当前计划金额不正确，无法按月供不变重算" }, { status: 400 });
      }
      const estimatedRuns = estimateLoanEqualPaymentRemainingRuns({
        annualRate: effectiveAnnualRate,
        intervalMonths,
        scheduledAmount: currentAmount,
        remainingPrincipal,
      });
      if (estimatedRuns == null) {
        return NextResponse.json({ ok: false, code: "PAYMENT_TOO_LOW_FOR_FIXED_PAYMENT", error: "Current payment is not enough to amortize the loan at the effective rate" }, { status: 400 });
      }
      if (estimatedRuns <= 0) {
        return NextResponse.json({ ok: false, code: "ZERO_REMAINING_PRINCIPAL", error: "剩余本金已为 0，无法按月供不变重算" }, { status: 400 });
      }
      if (carriedPaymentAmount != null && Math.abs(currentAmount - toNumber(plan.amount)) > 0.005) {
        updateData.amount = roundLoanMoney(currentAmount);
      }
      updateData.totalRuns = executedRunsBeforeRequestedStart + estimatedRuns;
    }

    const updatedPlan = await prisma.regularInvestPlan.update({
      where: { id: plan.id },
      data: updateData,
      select: { amount: true, totalRuns: true, executedRuns: true },
    });

    revalidateAfterTxChange();
    return NextResponse.json({
      ok: true,
      data: {
        status: "active",
        nextAmount: toNumber(updatedPlan.amount),
        totalRuns: updatedPlan.totalRuns,
        remainingRuns: updatedPlan.totalRuns == null ? null : Math.max(0, updatedPlan.totalRuns - Math.max(0, updatedPlan.executedRuns ?? 0)),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "RECALC_FAILED", error: error instanceof Error ? error.message : "重算还款计划失败" },
      { status: 500 },
    );
  }
}
