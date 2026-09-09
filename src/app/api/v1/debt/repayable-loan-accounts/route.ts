/**
 * GET /api/v1/debt/repayable-loan-accounts
 *
 * Returns institution loan accounts that still have payable principal on the
 * requested repayment date.
 *
 * Query params:
 * - date (required): YYYY-MM-DD repayment date.
 * - excludeEntryId (optional): repayment entry excluded while editing, so the
 *   original payment does not hide the loan account from the dropdown.
 *
 * Response:
 * - { ok: true, data: [{ accountId, balance, currentPlanId, currentDueDate,
 *     currentPrincipal, currentInterest, currentPayment, currentPaidAmount,
 *     currentUnpaidPeriod, currentPeriodPaid, prepayInterest?,
 *     prepayInterestFromDate?, prepayInterestDays?, prepayAnnualRate? }] }
 *   balance uses the debt account display sign; negative means payable debt.
 *   currentPrincipal / currentInterest are the remaining amounts for the
 *   current period in the loan's system-built repayment schedule.
 *   currentUnpaidPeriod is the schedule period containing the requested date.
 *   currentPeriodPaid is true only when transfers explicitly linked to that
 *   plan/period (or a legacy manual repayment mapped by date) cover the scheduled
 *   principal plus interest. Loan fields are null when the account has no
 *   repayment plan or nothing is left to repay.
 * - Consumer loans (loanType=consumer) additionally carry prepay interest
 *   preview fields: prepayInterest（自计息起点到该日期的按日应计利息）、
 *   prepayInterestFromDate、prepayInterestDays、prepayAnnualRate。
 */
import { AccountKind, IntervalUnit, RegularInvestStatus, TransactionType } from "@prisma/client";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { formatDateUtc, parseDateInputToUtc, toNumber } from "@/lib/date-utils";
import { resolveLoanRepaymentCoverage, resolveLoanRepaymentPeriodForDate } from "@/lib/loan-repayment-period";
import { ACTIVE_DEBT_EPSILON } from "@/lib/server/debt-view-data";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { computeLoanPrincipalBalancesAsOf } from "@/lib/server/account-balance";
import { decodeScheduledTaskMemo, getLoanScheduledPlanRole, shouldPreferLoanScheduledPlan } from "@/lib/scheduled-task";
import {
  calcLoanRunPartsWithRateAdjustments,
  calcLoanScheduledAmountForPeriodStart,
} from "@/lib/loan-repayment";
import { inferMortgageLprDiscountFromRateAdjustments } from "@/lib/loan-lpr";
import { resolveLoanRateAdjustments, listLoanRateAdjustmentsByAccountIds } from "@/lib/server/loan-rate-adjustments";
import { computeLoanPrepayInterestPreview } from "@/lib/server/loan-prepay-interest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type RepaymentPlanRow = {
  id: string;
  accountId: string;
  amount: unknown;
  intervalUnit: string;
  intervalValue: number;
  executionDay: number | null;
  secondaryExecutionDay: number | null;
  memo: string | null;
  startDate: Date;
  nextRunDate: Date | null;
  lastRunDate: Date | null;
  totalRuns: number | null;
  executedRuns: number | null;
};

function repaymentStartDateForPlan(plan: RepaymentPlanRow) {
  const savedDate = decodeScheduledTaskMemo(plan.memo).firstRepaymentDate;
  return savedDate ? parseDateInputToUtc(savedDate) ?? plan.startDate : plan.startDate;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const dateText = (url.searchParams.get("date") ?? "").trim();
  const excludeEntryId = (url.searchParams.get("excludeEntryId") ?? "").trim();
  const asOfDate = parseDateInputToUtc(dateText);
  if (!asOfDate) {
    return NextResponse.json({ ok: false, code: "INVALID_DATE", error: "Invalid repayment date" }, { status: 400 });
  }

  try {
    const { hidFilter, householdId } = await getHouseholdScope();
    const accounts = await prisma.account.findMany({
      where: {
        ...hidFilter,
        kind: AccountKind.loan,
        isActive: true,
        isPlaceholder: { not: true },
        counterpartyId: null,
        institutionId: { not: null },
      },
      select: {
        id: true,
        kind: true,
        investProductType: true,
        billingDay: true,
      },
    });
    const balanceByAccountId = await computeLoanPrincipalBalancesAsOf(accounts, hidFilter, asOfDate, {
      excludeEntryId: excludeEntryId || null,
    });

    const repayableAccountIds = accounts
      .filter((account) => (balanceByAccountId.get(account.id) ?? 0) < -ACTIVE_DEBT_EPSILON)
      .map((account) => account.id);

    // Load the bill-role repayment plan so the UI can default to its current installment.
    const plans = repayableAccountIds.length > 0
      ? await prisma.regularInvestPlan.findMany({
          where: {
            householdId,
            accountId: { in: repayableAccountIds },
            fundCode: "loan_repayment",
            status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused] },
          },
          select: {
            id: true,
            accountId: true,
            amount: true,
            intervalUnit: true,
            intervalValue: true,
            executionDay: true,
            secondaryExecutionDay: true,
            memo: true,
            startDate: true,
            nextRunDate: true,
            lastRunDate: true,
            totalRuns: true,
            executedRuns: true,
          },
          orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
        })
      : [];
    const planByAccountId = new Map<string, RepaymentPlanRow>();
    for (const plan of plans) {
      const existing = planByAccountId.get(plan.accountId);
      if (shouldPreferLoanScheduledPlan(plan, existing)) planByAccountId.set(plan.accountId, plan);
    }
    const rateAdjustmentsByAccountId = plans.length > 0
      ? await listLoanRateAdjustmentsByAccountIds({
          householdId,
          accountIds: Array.from(planByAccountId.keys()),
        })
      : new Map<string, Array<{ effectiveDate: string; annualRate: number }>>();

    const paidByPeriodKey = await computePaidAmountsByPeriod(
      householdId,
      repayableAccountIds,
      plans,
      asOfDate,
      excludeEntryId,
    );

    const data: Array<{
      accountId: string;
      balance: number;
      currentPlanId: string | null;
      currentDueDate: string | null;
      currentPrincipal: number | null;
      currentInterest: number | null;
      currentPayment: number | null;
      currentPaidAmount: number;
      currentUnpaidPeriod: number | null;
      currentPeriodPaid: boolean;
      prepayInterest?: number;
      prepayInterestFromDate?: string;
      prepayInterestDays?: number;
      prepayAnnualRate?: number | null;
    }> = accounts
      .map((account) => {
        const balance = balanceByAccountId.get(account.id) ?? 0;
        const plan = planByAccountId.get(account.id);
        const currentPeriod = plan
          ? resolveLoanRepaymentPeriodForDate({
              startDate: repaymentStartDateForPlan(plan),
              intervalUnit: plan.intervalUnit as IntervalUnit,
              intervalValue: plan.intervalValue,
              executionDay: plan.executionDay,
              secondaryExecutionDay: plan.secondaryExecutionDay,
              totalRuns: plan.totalRuns,
            }, asOfDate)
          : null;
        const paid = plan && currentPeriod
          ? paidByPeriodKey.get(`${plan.id}:${currentPeriod.period}`) ?? { principal: 0, interest: 0, total: 0 }
          : { principal: 0, interest: 0, total: 0 };
        const installment = currentPeriod
          ? computeCurrentInstallment(
              account.id,
              balance,
              currentPeriod.period,
              currentPeriod.previousDueDate,
              currentPeriod.dueDate,
              paid.principal,
              planByAccountId,
              rateAdjustmentsByAccountId,
            )
          : null;
        const coverage = installment
          ? resolveLoanRepaymentCoverage({
              scheduledPrincipal: installment.principal,
              scheduledInterest: installment.interest,
              paidPrincipal: paid.principal,
              paidInterest: paid.interest,
              paidTotal: paid.total,
            })
          : null;
        return {
          accountId: account.id,
          balance,
          currentPlanId: plan?.id ?? null,
          currentDueDate: currentPeriod ? formatDateUtc(currentPeriod.dueDate) : null,
          currentPrincipal: coverage?.remainingPrincipal ?? null,
          currentInterest: coverage?.remainingInterest ?? null,
          currentPayment: coverage
            ? coverage.remainingPrincipal + coverage.remainingInterest
            : null,
          currentPaidAmount: paid.total,
          currentUnpaidPeriod: installment ? currentPeriod?.period ?? null : null,
          currentPeriodPaid: coverage?.paid ?? false,
        };
      })
      .filter((row) => row.balance < -ACTIVE_DEBT_EPSILON)
      .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

    if (householdId) {
      for (const row of data) {
        const preview = await computeLoanPrepayInterestPreview({
          householdId,
          accountId: row.accountId,
          asOfDate,
          excludeEntryId: excludeEntryId || null,
        });
        if (!preview) continue;
        row.prepayInterest = preview.interest;
        row.prepayInterestFromDate = preview.fromDate;
        row.prepayInterestDays = preview.days;
        row.prepayAnnualRate = preview.annualRate;
      }
    }

    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error("GET /api/v1/debt/repayable-loan-accounts error:", error);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: "Internal server error" }, { status: 500 });
  }
}

/**
 * Sum actual transfers by repayment plan and period. Bill rows define an amount
 * due and never count as payment. Legacy manual repayments without a saved plan
 * link are matched to the schedule period containing their transaction date.
 */
async function computePaidAmountsByPeriod(
  householdId: string,
  accountIds: string[],
  plans: RepaymentPlanRow[],
  asOfDate: Date,
  excludeId: string,
) {
  const totals = new Map<string, { principal: number; interest: number; total: number }>();
  if (accountIds.length === 0 || plans.length === 0) return totals;
  const planIds = plans.map((plan) => plan.id);
  const rows = await prisma.txRecord.findMany({
    where: {
      householdId,
      deletedAt: null,
      date: { lte: asOfDate },
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: [
        { type: TransactionType.transfer, toAccountId: { in: accountIds }, source: "debt_repay_out" },
        {
          type: TransactionType.transfer,
          toAccountId: { in: accountIds },
          regularInvestPlanId: { in: planIds },
          source: "scheduled_task",
        },
      ],
    },
    select: {
      id: true,
      date: true,
      accountId: true,
      toAccountId: true,
      amount: true,
      debtPrincipalAmount: true,
      debtInterestAmount: true,
      regularInvestPlanId: true,
      installmentNo: true,
      source: true,
    },
  });

  const accountIdByPlanId = new Map(plans.map((p) => [p.id, p.accountId]));
  const planById = new Map(plans.map((p) => [p.id, p]));
  const planByAccountId = new Map<string, RepaymentPlanRow>();
  for (const plan of plans) {
    const existing = planByAccountId.get(plan.accountId);
    if (shouldPreferLoanScheduledPlan(plan, existing)) planByAccountId.set(plan.accountId, plan);
  }
  const accountSet = new Set(accountIds);
  for (const row of rows) {
    const accountId = row.regularInvestPlanId
      ? (accountIdByPlanId.get(row.regularInvestPlanId) ?? row.accountId)
      : (accountSet.has(row.accountId) ? row.accountId : (accountSet.has(row.toAccountId ?? "") ? row.toAccountId : row.accountId));
    if (!accountId || !accountSet.has(accountId)) continue;
    const linkedPlan = row.regularInvestPlanId ? planById.get(row.regularInvestPlanId) : null;
    const plan = planByAccountId.get(accountId);
    if (!plan) continue;
    if (row.source === "scheduled_task" && getLoanScheduledPlanRole(decodeScheduledTaskMemo(linkedPlan?.memo)) !== "auto_debit") continue;
    const resolvedPeriod = row.installmentNo && row.installmentNo > 0
      ? row.installmentNo
      : resolveLoanRepaymentPeriodForDate({
          startDate: repaymentStartDateForPlan(plan),
          intervalUnit: plan.intervalUnit as IntervalUnit,
          intervalValue: plan.intervalValue,
          executionDay: plan.executionDay,
          secondaryExecutionDay: plan.secondaryExecutionDay,
          totalRuns: plan.totalRuns,
        }, row.date)?.period ?? null;
    if (!resolvedPeriod) continue;
    const principal = Math.abs(toNumber(row.debtPrincipalAmount));
    const interest = Math.abs(toNumber(row.debtInterestAmount));
    const total = Math.max(principal + interest, Math.abs(toNumber(row.amount)));
    const key = `${plan.id}:${resolvedPeriod}`;
    const existing = totals.get(key) ?? { principal: 0, interest: 0, total: 0 };
    totals.set(key, {
      principal: existing.principal + principal,
      interest: existing.interest + interest,
      total: existing.total + total,
    });
  }
  return totals;
}

function computeCurrentInstallment(
  accountId: string,
  balance: number,
  periodNumber: number,
  previousDueDate: Date,
  dueDate: Date,
  paidPrincipal: number,
  planByAccountId: Map<string, RepaymentPlanRow>,
  rateAdjustmentsByAccountId: Map<string, Array<{ effectiveDate: string; annualRate: number }>>,
): { principal: number; interest: number } | null {
  const plan = planByAccountId.get(accountId);
  if (!plan || balance >= 0) return null;
  const memo = decodeScheduledTaskMemo(plan.memo);
  const annualRate = memo?.annualRate ?? null;
  const intervalMonths = memo?.repaymentIntervalMonths ?? (plan.intervalUnit === IntervalUnit.month ? plan.intervalValue : null);
  const runDateKey = formatDateUtc(dueDate);
  const previousRunDateKey = formatDateUtc(previousDueDate);
  const remainingRuns = plan.totalRuns == null
    ? null
    : Math.max(0, plan.totalRuns - Math.max(0, periodNumber - 1));
  if (remainingRuns == null || remainingRuns <= 0) return null;
  const loanStartDateKey = formatDateUtc(repaymentStartDateForPlan(plan));
  const rawLoanRateAdjustments = resolveLoanRateAdjustments({
    tableAdjustments: rateAdjustmentsByAccountId.get(accountId) ?? [],
    memoAdjustments: memo?.loanRateAdjustments,
    loanStartDate: loanStartDateKey,
  });
  const loanRateAdjustments = resolveLoanRateAdjustments({
    tableAdjustments: rateAdjustmentsByAccountId.get(accountId) ?? [],
    memoAdjustments: memo?.loanRateAdjustments,
    mortgageLprDiscount: memo?.mortgageLprDiscount ?? inferMortgageLprDiscountFromRateAdjustments(rawLoanRateAdjustments, { skipOnOrBefore: loanStartDateKey }),
    loanStartDate: loanStartDateKey,
  });
  const period = calcLoanScheduledAmountForPeriodStart({
    repaymentMethod: memo?.repaymentMethod,
    baseAnnualRate: annualRate,
    adjustments: loanRateAdjustments,
    intervalMonths: intervalMonths ?? 1,
    scheduledAmount: toNumber(plan.amount),
    remainingPrincipal: Math.abs(Number(balance)) + paidPrincipal,
    remainingRuns,
    periodStartDate: previousRunDateKey,
  });
  const parts = calcLoanRunPartsWithRateAdjustments({
    repaymentMethod: memo?.repaymentMethod,
    baseAnnualRate: annualRate,
    adjustments: loanRateAdjustments,
    intervalMonths: intervalMonths ?? 1,
    scheduledAmount: period,
    remainingPrincipal: Math.abs(Number(balance)) + paidPrincipal,
    remainingRuns,
    previousRunDate: previousRunDateKey,
    runDate: runDateKey,
  });
  return { principal: parts.principal, interest: parts.interest };
}
