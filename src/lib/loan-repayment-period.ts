import type { IntervalUnit } from "@prisma/client";

import { formatDateUtc, startOfDayUtc } from "@/lib/date-utils";
import { calcInitialScheduledRunDate, calcNextScheduledRunDate } from "@/lib/scheduled-task-date";

export type LoanRepaymentPeriodPlan = {
  startDate: Date;
  intervalUnit: IntervalUnit;
  intervalValue: number;
  executionDay?: number | null;
  secondaryExecutionDay?: number | null;
  totalRuns?: number | null;
};

export type LoanRepaymentPeriod = {
  period: number;
  dueDate: Date;
  previousDueDate: Date;
};

export function resolveLoanRepaymentPeriodForDate(
  plan: LoanRepaymentPeriodPlan,
  value: Date,
): LoanRepaymentPeriod | null {
  const targetDate = startOfDayUtc(value);
  let previousDueDate = startOfDayUtc(plan.startDate);
  let dueDate = calcInitialScheduledRunDate(
    plan.startDate,
    plan.intervalUnit,
    plan.intervalValue,
    plan.executionDay,
    false,
    plan.secondaryExecutionDay,
  );
  let period = 1;
  const maxPeriods = Math.min(Math.max(plan.totalRuns ?? 1200, 1), 1200);

  if (targetDate < dueDate) return { period, dueDate, previousDueDate };

  while (period < maxPeriods) {
    const nextDueDate = calcNextScheduledRunDate(
      dueDate,
      plan.intervalUnit,
      plan.intervalValue,
      plan.executionDay,
      false,
      plan.secondaryExecutionDay,
    );
    if (nextDueDate <= dueDate || nextDueDate > targetDate) break;
    previousDueDate = dueDate;
    dueDate = nextDueDate;
    period += 1;
  }

  return { period, dueDate, previousDueDate };
}

export function resolveLoanRepaymentCoverage(params: {
  scheduledPrincipal: number;
  scheduledInterest: number;
  paidPrincipal: number;
  paidInterest: number;
  paidTotal: number;
}) {
  const scheduledPrincipal = Math.max(0, params.scheduledPrincipal);
  const scheduledInterest = Math.max(0, params.scheduledInterest);
  let coveredPrincipal = Math.max(0, params.paidPrincipal);
  let coveredInterest = Math.max(0, params.paidInterest);
  let unallocated = Math.max(0, params.paidTotal - coveredPrincipal - coveredInterest);

  const interestGap = Math.max(0, scheduledInterest - coveredInterest);
  const interestAllocation = Math.min(unallocated, interestGap);
  coveredInterest += interestAllocation;
  unallocated -= interestAllocation;
  coveredPrincipal += unallocated;

  return {
    remainingPrincipal: Math.max(0, scheduledPrincipal - coveredPrincipal),
    remainingInterest: Math.max(0, scheduledInterest - coveredInterest),
    scheduledTotal: scheduledPrincipal + scheduledInterest,
    paid: params.paidTotal + 0.005 >= scheduledPrincipal + scheduledInterest,
  };
}

export function loanRepaymentPeriodKey(planId: string, period: number) {
  return `${planId}:${period}`;
}

export function isSameLoanRepaymentDueDate(left: Date, right: Date) {
  return formatDateUtc(left) === formatDateUtc(right);
}
