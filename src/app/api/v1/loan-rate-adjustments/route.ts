import { NextResponse } from "next/server";
import { AccountKind, RegularInvestStatus, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import { decodeScheduledTaskMemo, encodeScheduledTaskMemo, shouldPreferLoanScheduledPlan } from "@/lib/scheduled-task";
import {
  listLoanRateAdjustmentsByAccountIds,
  replaceLoanRateAdjustmentsForAccount,
  resolveLoanRateAdjustments,
} from "@/lib/server/loan-rate-adjustments";
import {
  normalizeLoanRateAdjustments,
} from "@/lib/loan-repayment";
import { buildMortgageLprRateAdjustments } from "@/lib/loan-lpr";
import { formatDateUtc } from "@/lib/date-utils";

export const runtime = "nodejs";

/**
 * POST /api/v1/loan-rate-adjustments
 *
 * Updates the canonical rate-adjustment rows for one loan account.
 *
 * Request body:
 * - `accountId` (required): loan account ID in the current household.
 * - `adjustments`: optional full replacement list of `{ effectiveDate: YYYY-MM-DD, annualRate }`.
 * - `effectiveDate` + `annualRate`: optional single-row upsert when `adjustments` is omitted.
 * - `annualRate`: annual percentage rate; `0` is allowed, negative values are rejected.
 * - `mortgageLprDiscount`: optional mortgage/home-loan discount used only for LPR generation.
 * - `loanStartDate`: optional YYYY-MM-DD start date for mortgage LPR generation.
 *
 * Consumer loans only use explicit effective-date + annual-rate rows. Mortgage/home loans may
 * additionally generate LPR-derived adjustment rows. Saving adjustments updates repayment
 * schedule amounts for active/paused bill and auto-debit plans on the same loan account.
 *
 * Success: `{ ok: true, data: { adjustments, nextAmount } }`
 * Failure: `{ ok: false, code, error }`
 */

class ApiInputError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function parseDateOnly(value: unknown) {
  const text = String(value ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function parseAdjustmentList(value: unknown) {
  if (!Array.isArray(value)) return null;
  const items = value.map((item) => ({
    effectiveDate: parseDateOnly(item?.effectiveDate),
    annualRate: Number(item?.annualRate),
  }));
  const invalid = items.find((item) => !item.effectiveDate || !Number.isFinite(item.annualRate) || item.annualRate < 0);
  if (invalid) throw new ApiInputError("INVALID_RATE_ADJUSTMENTS", "Invalid rate adjustment records");
  return normalizeLoanRateAdjustments(items);
}

export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null);
    const accountId = String(body?.accountId ?? "").trim();
    let replacementAdjustments = parseAdjustmentList(body?.adjustments);
    const effectiveDate = parseDateOnly(body?.effectiveDate);
    const annualRate = Number(body?.annualRate);
    const mortgageLprDiscountRaw = body?.mortgageLprDiscount;
    const mortgageLprDiscount =
      mortgageLprDiscountRaw == null || mortgageLprDiscountRaw === ""
        ? null
        : Number(mortgageLprDiscountRaw);
    const loanStartDate = parseDateOnly(body?.loanStartDate);

    if (!accountId) return NextResponse.json({ ok: false, code: "MISSING_LOAN_ACCOUNT", error: "Missing loan account" }, { status: 400 });
    const loanAccount = await prisma.account.findFirst({
      where: {
        householdId,
        id: accountId,
        kind: AccountKind.loan,
        isPlaceholder: { not: true },
      },
      select: {
        isConsumerLoan: true,
        loanType: true,
      },
    });
    if (!loanAccount) return NextResponse.json({ ok: false, code: "LOAN_ACCOUNT_NOT_FOUND", error: "Loan account not found" }, { status: 404 });
    const resolvedLoanType = loanAccount.loanType ?? (loanAccount.isConsumerLoan === true ? "consumer" : "home");
    const isMortgageLoan = resolvedLoanType === "home" || resolvedLoanType === "mortgage";
    const effectiveMortgageLprDiscount = isMortgageLoan ? mortgageLprDiscount : null;
    if (
      isMortgageLoan &&
      mortgageLprDiscountRaw != null &&
      mortgageLprDiscountRaw !== "" &&
      (mortgageLprDiscount == null || !Number.isFinite(mortgageLprDiscount) || mortgageLprDiscount <= 0)
    ) {
      return NextResponse.json({ ok: false, code: "INVALID_LPR_DISCOUNT", error: "Invalid LPR rate discount" }, { status: 400 });
    }
    if (!replacementAdjustments) {
      if (!effectiveDate) return NextResponse.json({ ok: false, code: "INVALID_EFFECTIVE_DATE", error: "Invalid effective date" }, { status: 400 });
      if (!Number.isFinite(annualRate) || annualRate < 0) {
        return NextResponse.json({ ok: false, code: "INVALID_ANNUAL_RATE", error: "Invalid annual rate" }, { status: 400 });
      }
    }

    const plans = await prisma.regularInvestPlan.findMany({
      where: {
        householdId,
        accountId,
        fundCode: "loan_repayment",
        status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused] },
      },
      orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
    });
    let plan: (typeof plans)[number] | null = null;
    for (const item of plans) {
      if (shouldPreferLoanScheduledPlan(item, plan)) plan = item;
    }
    if (!plan) return NextResponse.json({ ok: false, code: "LOAN_PLAN_NOT_FOUND", error: "Loan repayment plan not found" }, { status: 404 });

    const memo = decodeScheduledTaskMemo(plan.memo);
    const tableAdjustments = (await listLoanRateAdjustmentsByAccountIds({
      householdId,
      accountIds: [plan.accountId],
    })).get(plan.accountId);
    const lprDiscountForGeneration = isMortgageLoan
      ? effectiveMortgageLprDiscount ?? memo.mortgageLprDiscount ?? null
      : null;
    const defaultLoanStartDate = loanStartDate || (plan.startDate ? formatDateUtc(plan.startDate) : undefined);
    const currentAdjustments = resolveLoanRateAdjustments({
      tableAdjustments,
      memoAdjustments: memo.loanRateAdjustments,
      mortgageLprDiscount: lprDiscountForGeneration,
      loanStartDate: defaultLoanStartDate,
    });
    if (isMortgageLoan && replacementAdjustments && replacementAdjustments.length === 0 && lprDiscountForGeneration != null && lprDiscountForGeneration > 0) {
      const loanStartEntry = loanStartDate
        ? null
        : await prisma.txRecord.findFirst({
            where: {
              householdId,
              accountId: plan.accountId,
              type: TransactionType.transfer,
              source: { in: ["debt_borrow_in", "debt_financed_purchase"] },
              deletedAt: null,
            },
            orderBy: [{ date: "asc" }, { createdAt: "asc" }],
            select: { date: true },
          });
      replacementAdjustments = buildMortgageLprRateAdjustments({
        discount: lprDiscountForGeneration,
        throughDate: formatDateUtc(new Date()),
        fromDate: loanStartDate || (loanStartEntry ? formatDateUtc(loanStartEntry.date) : defaultLoanStartDate),
      });
    }
    const adjustments = replacementAdjustments ?? currentAdjustments
      .filter((item) => item.effectiveDate !== effectiveDate);
    if (!replacementAdjustments) adjustments.push({ effectiveDate, annualRate });
    adjustments.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

    const planUpdates = plans.map((item) => {
      const itemMemo = decodeScheduledTaskMemo(item.memo);
      return {
        id: item.id,
        amount: item.amount,
        memo: itemMemo,
      };
    });

    await prisma.$transaction(async (tx) => {
      await replaceLoanRateAdjustmentsForAccount(tx, {
        householdId,
        accountId: plan.accountId,
        regularInvestPlanId: plan.id,
        adjustments,
      });
      for (const item of planUpdates) {
        await tx.regularInvestPlan.update({
          where: { id: item.id },
          data: {
            // 保存利率表不重算月供（不重新均份剩余本金）：月供只在
            // 重定价期由执行器按期内利率调整重算一次，或由用户显式
            // 重算/重建时更新。这里只同步利率表与折扣备注。
            memo: encodeScheduledTaskMemo({
              ...item.memo,
              mortgageLprDiscount: isMortgageLoan
                ? effectiveMortgageLprDiscount ?? item.memo.mortgageLprDiscount ?? null
                : null,
              loanRateAdjustments: [],
            }),
          },
        });
      }
    });

    revalidateAfterTxChange();
    return NextResponse.json({ ok: true, data: { adjustments, nextAmount: Number(plan.amount) } });
  } catch (error) {
    if (error instanceof ApiInputError) {
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { ok: false, code: "SAVE_FAILED", error: error instanceof Error ? error.message : "Failed to save rate adjustments" },
      { status: 500 },
    );
  }
}
