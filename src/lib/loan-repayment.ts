import type { IntervalUnit } from "@prisma/client";

import { formatDateUtc, startOfDayUtc } from "@/lib/date-utils";
import { calcNextScheduledRunDate } from "@/lib/scheduled-task-date";

export function roundLoanMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export type LoanRateAdjustment = {
  effectiveDate: string;
  annualRate: number;
};

export type LoanRepaymentSchedulePreviewRow = {
  period: number;
  date: string;
  payment: number;
  principal: number;
  interest: number;
  remainingPrincipal: number;
  annualRate: number | null;
};

export const FREE_REPAYMENT_METHOD = "\u81ea\u7531\u8fd8\u6b3e";
export const EQUAL_PAYMENT_REPAYMENT_METHOD = "\u7b49\u989d\u672c\u606f";
export const EQUAL_PRINCIPAL_REPAYMENT_METHOD = "\u7b49\u989d\u672c\u91d1";
export const INSTALLMENT_REPAYMENT_METHOD = "\u5206\u671f\u8fd8\u6b3e";
export const INTEREST_FIRST_REPAYMENT_METHOD = "\u5148\u8fd8\u5229\u606f\u4e00\u6b21\u6027\u8fd8\u672c";
export const LEGACY_INTEREST_FREE_INSTALLMENT_REPAYMENT_METHOD = "\u514d\u606f\u5206\u671f\u8fd8\u672c";

export function normalizeLoanRepaymentMethod(method?: string | null) {
  const value = String(method ?? "").trim();
  if (!value) return FREE_REPAYMENT_METHOD;
  return value === LEGACY_INTEREST_FREE_INSTALLMENT_REPAYMENT_METHOD ? INSTALLMENT_REPAYMENT_METHOD : value;
}

export function isInstallmentRepaymentMethod(method?: string | null) {
  return normalizeLoanRepaymentMethod(method) === INSTALLMENT_REPAYMENT_METHOD;
}

export function allowsZeroAnnualRateRepaymentMethod(method?: string | null) {
  const normalized = normalizeLoanRepaymentMethod(method);
  return (
    normalized === INSTALLMENT_REPAYMENT_METHOD ||
    normalized === EQUAL_PAYMENT_REPAYMENT_METHOD ||
    normalized === EQUAL_PRINCIPAL_REPAYMENT_METHOD
  );
}

export function normalizeLoanRateAdjustments(adjustments?: LoanRateAdjustment[] | null) {
  return [...(adjustments ?? [])]
    .map((item) => ({
      effectiveDate: String(item.effectiveDate ?? "").slice(0, 10),
      annualRate: Number(item.annualRate),
    }))
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate) && Number.isFinite(item.annualRate) && item.annualRate >= 0)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
}

export function getEffectiveLoanAnnualRate(params: {
  baseAnnualRate?: number | null;
  adjustments?: LoanRateAdjustment[] | null;
  date: string;
}) {
  let rate = params.baseAnnualRate ?? null;
  for (const item of normalizeLoanRateAdjustments(params.adjustments)) {
    if (item.effectiveDate <= params.date) rate = item.annualRate;
    else break;
  }
  return rate;
}

function dateOnlyToUtcMs(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return NaN;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function formatDateOnlyFromUtcMs(value: number) {
  return new Date(value).toISOString().slice(0, 10);
}

export function hasLoanRateAdjustmentInPeriod(params: {
  adjustments?: LoanRateAdjustment[] | null;
  startDateExclusive: string;
  endDateInclusive: string;
}) {
  return normalizeLoanRateAdjustments(params.adjustments).some(
    (item) => item.effectiveDate > params.startDateExclusive && item.effectiveDate <= params.endDateInclusive,
  );
}

export function calcLoanPeriodInterestByDailyRate(params: {
  principal: number;
  baseAnnualRate?: number | null;
  adjustments?: LoanRateAdjustment[] | null;
  startDateExclusive: string;
  endDateInclusive: string;
}) {
  const principal = Math.max(0, params.principal);
  const startMs = dateOnlyToUtcMs(params.startDateExclusive);
  const endMs = dateOnlyToUtcMs(params.endDateInclusive);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || principal <= 0) return 0;

  let interest = 0;
  const dayMs = 24 * 60 * 60 * 1000;
  for (let day = startMs + dayMs; day <= endMs; day += dayMs) {
    const date = formatDateOnlyFromUtcMs(day);
    const rate = getEffectiveLoanAnnualRate({
      baseAnnualRate: params.baseAnnualRate,
      adjustments: params.adjustments,
      date,
    });
    if (rate != null && Number.isFinite(rate) && rate > 0) {
      interest += principal * (rate / 100) / 360;
    }
  }
  return roundLoanMoney(interest);
}

export type LoanPrincipalAdjustmentInPeriod = {
  date: string;
  amount: number;
};

/**
 * 计算窗口 (startDateExclusive, endDateInclusive] 内的按日应计利息（rate/360，
 * 与 calcLoanPeriodInterestByDailyRate 同口径），并支持窗口内本金递减事件：
 * 事件在其发生日计息后生效（当天仍按事件前的本金计息）。
 * 用于消费贷提前还款：从借款日（或最近一次已结息日）到提前还款日的利息。
 */
export function calcLoanAccruedInterestBetweenDates(params: {
  principal: number;
  baseAnnualRate?: number | null;
  adjustments?: LoanRateAdjustment[] | null;
  principalReductions?: LoanPrincipalAdjustmentInPeriod[] | null;
  startDateExclusive: string;
  endDateInclusive: string;
}) {
  const startMs = dateOnlyToUtcMs(params.startDateExclusive);
  const endMs = dateOnlyToUtcMs(params.endDateInclusive);
  let principal = Math.max(0, params.principal);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || principal <= 0) return 0;

  const dayMs = 24 * 60 * 60 * 1000;
  // 封顶约 10 年，避免异常数据导致超长循环。
  if (endMs - startMs > 3700 * dayMs) return 0;

  const reductions = [...(params.principalReductions ?? [])]
    .map((item) => ({
      date: String(item.date ?? "").slice(0, 10),
      amount: Math.max(0, Number(item.amount)),
    }))
    .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.date) && item.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  let interest = 0;
  let eventIndex = 0;
  for (let day = startMs + dayMs; day <= endMs; day += dayMs) {
    const date = formatDateOnlyFromUtcMs(day);
    const rate = getEffectiveLoanAnnualRate({
      baseAnnualRate: params.baseAnnualRate,
      adjustments: params.adjustments,
      date,
    });
    if (rate != null && Number.isFinite(rate) && rate > 0 && principal > 0) {
      interest += principal * (rate / 100) / 360;
    }
    while (eventIndex < reductions.length && reductions[eventIndex]!.date === date) {
      principal = Math.max(0, principal - reductions[eventIndex]!.amount);
      eventIndex += 1;
    }
  }
  return roundLoanMoney(interest);
}

export function calcLoanPeriodInterestByDailyRateWithPrincipalAdjustments(params: {
  principal: number;
  baseAnnualRate?: number | null;
  adjustments?: LoanRateAdjustment[] | null;
  principalAdjustments?: LoanPrincipalAdjustmentInPeriod[] | null;
  intervalMonths?: number | null;
  startDateExclusive: string;
  endDateInclusive: string;
}) {
  const startMs = dateOnlyToUtcMs(params.startDateExclusive);
  const endMs = dateOnlyToUtcMs(params.endDateInclusive);
  const startingPrincipal = Math.max(0, params.principal);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || startingPrincipal <= 0) return 0;

  const dayMs = 24 * 60 * 60 * 1000;
  const intervalMonths = Math.max(1, params.intervalMonths || 1);
  const periodDays = Math.max(1, intervalMonths * 30);
  if (periodDays <= 0) return 0;

  const principalAdjustments = [...(params.principalAdjustments ?? [])]
    .map((item) => ({
      date: String(item.date ?? "").slice(0, 10),
      elapsedDays: Math.max(0, Math.round((dateOnlyToUtcMs(item.date) - startMs) / dayMs)),
      amount: Math.max(0, Number(item.amount)),
    }))
    .filter((item) => Number.isFinite(item.elapsedDays) && item.amount > 0 && item.elapsedDays > 0 && item.elapsedDays < periodDays)
    .sort((a, b) => a.elapsedDays - b.elapsedDays);

  let interest = 0;
  let principal = startingPrincipal;
  let cursor = 0;

  const addSegmentInterest = (days: number, date: string) => {
    if (days <= 0 || principal <= 0) return;
    const rate = getEffectiveLoanAnnualRate({
      baseAnnualRate: params.baseAnnualRate,
      adjustments: params.adjustments,
      date,
    });
    if (rate != null && Number.isFinite(rate) && rate > 0 && principal > 0) {
      interest += principal * days * (rate / 100) / 360;
    }
  };

  for (const adjustment of principalAdjustments) {
    const elapsedDays = Math.min(periodDays, Math.max(cursor, adjustment.elapsedDays));
    addSegmentInterest(elapsedDays - cursor, adjustment.date);
    principal = Math.max(0, principal - adjustment.amount);
    cursor = elapsedDays;
  }
  addSegmentInterest(periodDays - cursor, params.endDateInclusive);

  return roundLoanMoney(interest);
}

export function calcLoanScheduledAmount(params: {
  repaymentMethod?: string | null;
  annualRate?: number | null;
  principal: number;
  totalRuns: number;
  intervalMonths?: number | null;
}) {
  const method = normalizeLoanRepaymentMethod(params.repaymentMethod);
  const principal = Math.max(0, params.principal);
  const totalRuns = Math.max(0, params.totalRuns);
  if (
    principal <= 0 ||
    totalRuns <= 0 ||
    params.annualRate == null ||
    !Number.isFinite(params.annualRate) ||
    params.annualRate < 0
  ) {
    return null;
  }

  const periodRate =
    params.annualRate > 0
      ? (params.annualRate / 100 / 12) * Math.max(1, params.intervalMonths || 1)
      : 0;
  if (periodRate <= 0) {
    return allowsZeroAnnualRateRepaymentMethod(method) ? roundLoanMoney(principal / totalRuns) : null;
  }

  if (!Number.isFinite(periodRate)) return null;

  if (isInstallmentRepaymentMethod(method)) {
    return roundLoanMoney((principal / totalRuns) + (principal * periodRate));
  }
  if (method === EQUAL_PRINCIPAL_REPAYMENT_METHOD) {
    return roundLoanMoney((principal / totalRuns) + (principal * periodRate));
  }
  if (method === INTEREST_FIRST_REPAYMENT_METHOD) {
    return roundLoanMoney(principal * periodRate);
  }
  if (method !== EQUAL_PAYMENT_REPAYMENT_METHOD) return null;

  const factor = Math.pow(1 + periodRate, totalRuns);
  if (!Number.isFinite(factor) || factor <= 1) return null;
  return roundLoanMoney((principal * periodRate * factor) / (factor - 1));
}

export function calcLoanScheduledAmountExact(params: {
  repaymentMethod?: string | null;
  annualRate?: number | null;
  principal: number;
  totalRuns: number;
  intervalMonths?: number | null;
}) {
  const method = normalizeLoanRepaymentMethod(params.repaymentMethod);
  const principal = Math.max(0, params.principal);
  const totalRuns = Math.max(0, params.totalRuns);
  if (
    principal <= 0 ||
    totalRuns <= 0 ||
    params.annualRate == null ||
    !Number.isFinite(params.annualRate) ||
    params.annualRate < 0
  ) {
    return null;
  }

  const periodRate =
    params.annualRate > 0
      ? (params.annualRate / 100 / 12) * Math.max(1, params.intervalMonths || 1)
      : 0;
  if (periodRate <= 0) {
    return allowsZeroAnnualRateRepaymentMethod(method) ? principal / totalRuns : null;
  }
  if (method !== EQUAL_PAYMENT_REPAYMENT_METHOD) {
    return isInstallmentRepaymentMethod(method) || method === EQUAL_PRINCIPAL_REPAYMENT_METHOD
      ? (principal / totalRuns) + (principal * periodRate)
      : null;
  }
  const factor = Math.pow(1 + periodRate, totalRuns);
  if (!Number.isFinite(periodRate) || !Number.isFinite(factor) || factor <= 1) return null;
  return (principal * periodRate * factor) / (factor - 1);
}

export function estimateLoanEqualPaymentRemainingRuns(params: {
  annualRate?: number | null;
  intervalMonths?: number | null;
  scheduledAmount: number;
  remainingPrincipal: number;
}) {
  // Dependency chain for reduce-term prepayment:
  // remaining principal + effective rate + carried scheduled amount -> natural payoff runs -> plan.totalRuns.
  const principal = Math.max(0, params.remainingPrincipal);
  const scheduledAmount = Math.max(0, params.scheduledAmount);
  if (principal <= 0.005) return 0;
  if (scheduledAmount <= 0.005) return null;
  const periodRate =
    params.annualRate != null && Number.isFinite(params.annualRate) && params.annualRate > 0
      ? (params.annualRate / 100 / 12) * Math.max(1, params.intervalMonths || 1)
      : 0;
  if (periodRate <= 0) return Math.max(1, Math.ceil(principal / scheduledAmount));
  const denominator = scheduledAmount - principal * periodRate;
  if (denominator <= 0.005) return null;
  const runs = Math.log(scheduledAmount / denominator) / Math.log(1 + periodRate);
  if (!Number.isFinite(runs) || runs <= 0) return null;
  const naturalRuns = Math.max(1, Math.ceil(runs - 1e-10));
  return naturalRuns <= 1200 ? naturalRuns : null;
}

export function calcLoanRunParts(params: {
  repaymentMethod?: string | null;
  annualRate?: number | null;
  intervalMonths?: number | null;
  scheduledAmount: number;
  scheduledAmountExact?: number | null;
  remainingPrincipal: number;
  remainingRuns: number;
}) {
  const method = normalizeLoanRepaymentMethod(params.repaymentMethod);
  const remainingPrincipal = Math.max(0, params.remainingPrincipal);
  const remainingRuns = Math.max(1, params.remainingRuns);
  const periodRate =
    params.annualRate != null && Number.isFinite(params.annualRate) && params.annualRate > 0
      ? (params.annualRate / 100 / 12) * Math.max(1, params.intervalMonths || 1)
      : 0;
  const interest = periodRate > 0 ? roundLoanMoney(remainingPrincipal * periodRate) : 0;

  if (method === INTEREST_FIRST_REPAYMENT_METHOD) {
    return {
      principal: remainingRuns <= 1 ? roundLoanMoney(remainingPrincipal) : 0,
      interest,
    };
  }

  if (method === EQUAL_PRINCIPAL_REPAYMENT_METHOD) {
    return {
      principal: roundLoanMoney(Math.min(remainingPrincipal, remainingPrincipal / remainingRuns)),
      interest,
    };
  }

  if (isInstallmentRepaymentMethod(method)) {
    return {
      principal: roundLoanMoney(Math.min(remainingPrincipal, remainingPrincipal / remainingRuns)),
      principalExact: Math.min(remainingPrincipal, remainingPrincipal / remainingRuns),
      interest,
    };
  }

  const scheduledAmount = Math.max(0, params.scheduledAmount);
  const scheduledAmountExact =
    params.scheduledAmountExact != null && Number.isFinite(params.scheduledAmountExact) && params.scheduledAmountExact > 0
      ? params.scheduledAmountExact
      : scheduledAmount;
  const principalExact = Math.min(remainingPrincipal, Math.max(0, scheduledAmountExact - interest));
  const principal = roundLoanMoney(principalExact);
  return {
    principal,
    principalExact,
    interest,
  };
}

export function calcLoanScheduledAmountForPeriodStart(params: {
  repaymentMethod?: string | null;
  baseAnnualRate?: number | null;
  adjustments?: LoanRateAdjustment[] | null;
  intervalMonths?: number | null;
  scheduledAmount: number;
  remainingPrincipal: number;
  remainingRuns: number;
  periodStartDate?: string | null;
}) {
  const adjustments = normalizeLoanRateAdjustments(params.adjustments);
  if (!params.periodStartDate || !adjustments.some((item) => item.effectiveDate <= params.periodStartDate!)) {
    return params.scheduledAmount;
  }
  const annualRate = getEffectiveLoanAnnualRate({
    baseAnnualRate: params.baseAnnualRate,
    adjustments,
    date: params.periodStartDate,
  });
  // 生效利率与基础利率相同（如放款日初始利率行）不构成重定价：
  // 保持原月供，禁止用 annuity(期初余额, 剩余期数) 自算跳变。
  if (annualRate == null || (params.baseAnnualRate != null && Math.abs(annualRate - params.baseAnnualRate) < 1e-9)) {
    return params.scheduledAmount;
  }
  return (
    calcLoanScheduledAmount({
      repaymentMethod: params.repaymentMethod,
      annualRate,
      principal: params.remainingPrincipal,
      totalRuns: params.remainingRuns,
      intervalMonths: params.intervalMonths,
    }) ?? params.scheduledAmount
  );
}

export function calcLoanRunPartsWithRateAdjustments(params: {
  repaymentMethod?: string | null;
  baseAnnualRate?: number | null;
  adjustments?: LoanRateAdjustment[] | null;
  principalAdjustments?: LoanPrincipalAdjustmentInPeriod[] | null;
  intervalMonths?: number | null;
  scheduledAmount: number;
  scheduledAmountExact?: number | null;
  preserveScheduledAmount?: boolean;
  remainingPrincipal: number;
  remainingRuns: number;
  previousRunDate?: string | null;
  runDate: string;
}) {
  const adjustments = normalizeLoanRateAdjustments(params.adjustments);
  const hasRateAdjustmentInThisPeriod = params.previousRunDate
    ? hasLoanRateAdjustmentInPeriod({
        adjustments,
        startDateExclusive: params.previousRunDate,
        endDateInclusive: params.runDate,
      })
    : false;
  const hasPrincipalAdjustmentInThisPeriod = (params.principalAdjustments?.length ?? 0) > 0;
  const remainingPrincipal = Math.max(0, params.remainingPrincipal);
  const remainingRuns = Math.max(1, params.remainingRuns);
  const effectiveAnnualRate = getEffectiveLoanAnnualRate({
    baseAnnualRate: params.baseAnnualRate,
    adjustments,
    date: params.runDate,
  });
  const shouldPreserveScheduledAmount =
    hasPrincipalAdjustmentInThisPeriod ||
    (params.preserveScheduledAmount && !hasRateAdjustmentInThisPeriod);
  const scheduledAmount = shouldPreserveScheduledAmount
    ? params.scheduledAmount
    : calcLoanScheduledAmount({
        repaymentMethod: params.repaymentMethod,
        annualRate: effectiveAnnualRate,
        principal: remainingPrincipal,
        totalRuns: remainingRuns,
        intervalMonths: params.intervalMonths,
      }) ?? params.scheduledAmount;
  const scheduledAmountExact = shouldPreserveScheduledAmount
    ? params.scheduledAmountExact ?? params.scheduledAmount
    : calcLoanScheduledAmountExact({
        repaymentMethod: params.repaymentMethod,
        annualRate: effectiveAnnualRate,
        principal: remainingPrincipal,
        totalRuns: remainingRuns,
        intervalMonths: params.intervalMonths,
      }) ?? params.scheduledAmountExact ?? scheduledAmount;

  if (params.previousRunDate && hasPrincipalAdjustmentInThisPeriod) {
    const periodStartAnnualRate = getEffectiveLoanAnnualRate({
      baseAnnualRate: params.baseAnnualRate,
      adjustments,
      date: params.previousRunDate,
    });
    const periodStartScheduledAmount = hasRateAdjustmentInThisPeriod
      ? calcLoanScheduledAmount({
          repaymentMethod: params.repaymentMethod,
          annualRate: periodStartAnnualRate,
          principal: remainingPrincipal,
          totalRuns: remainingRuns,
          intervalMonths: params.intervalMonths,
        }) ?? params.scheduledAmount
      : params.scheduledAmount;
    const periodStartScheduledAmountExact = hasRateAdjustmentInThisPeriod
      ? calcLoanScheduledAmountExact({
          repaymentMethod: params.repaymentMethod,
          annualRate: periodStartAnnualRate,
          principal: remainingPrincipal,
          totalRuns: remainingRuns,
          intervalMonths: params.intervalMonths,
        }) ?? params.scheduledAmountExact ?? periodStartScheduledAmount
      : params.scheduledAmountExact ?? periodStartScheduledAmount;
    const periodStartParts = calcLoanRunParts({
      repaymentMethod: params.repaymentMethod,
      annualRate: periodStartAnnualRate,
      intervalMonths: params.intervalMonths,
      scheduledAmount: periodStartScheduledAmount,
      scheduledAmountExact: periodStartScheduledAmountExact,
      remainingPrincipal,
      remainingRuns,
    });
    const interest = hasPrincipalAdjustmentInThisPeriod
      ? calcLoanPeriodInterestByDailyRateWithPrincipalAdjustments({
          principal: remainingPrincipal,
          baseAnnualRate: params.baseAnnualRate,
          adjustments,
          principalAdjustments: params.principalAdjustments,
          intervalMonths: params.intervalMonths,
          startDateExclusive: params.previousRunDate,
          endDateInclusive: params.runDate,
        })
      : calcLoanPeriodInterestByDailyRate({
          principal: remainingPrincipal,
          baseAnnualRate: params.baseAnnualRate,
          adjustments,
          startDateExclusive: params.previousRunDate,
          endDateInclusive: params.runDate,
        });
    const principalExact = hasPrincipalAdjustmentInThisPeriod
      ? Math.min(remainingPrincipal, Math.max(0, periodStartScheduledAmountExact - interest))
      : periodStartParts.principalExact;
    const principal = roundLoanMoney(Math.min(remainingPrincipal, Math.max(0, principalExact ?? periodStartParts.principal)));
    return {
      principal,
      interest,
      payment: roundLoanMoney(principal + interest),
      annualRate: effectiveAnnualRate,
      scheduledAmount: hasPrincipalAdjustmentInThisPeriod ? periodStartScheduledAmount : scheduledAmount,
      scheduledAmountExact: hasPrincipalAdjustmentInThisPeriod ? periodStartScheduledAmountExact : scheduledAmountExact,
      principalExact,
      usedDailyInterest: true,
    };
  }

  const parts = calcLoanRunParts({
    repaymentMethod: params.repaymentMethod,
    annualRate: effectiveAnnualRate,
    intervalMonths: params.intervalMonths,
    scheduledAmount,
    scheduledAmountExact,
    remainingPrincipal,
    remainingRuns,
  });
  return {
    principal: parts.principal,
    interest: parts.interest,
    payment: roundLoanMoney(parts.principal + parts.interest),
    annualRate: effectiveAnnualRate,
    scheduledAmount,
    scheduledAmountExact,
    principalExact: parts.principalExact,
    usedDailyInterest: false,
  };
}

export function buildLoanRepaymentSchedulePreview(params: {
  principal: number;
  repaymentMethod?: string | null;
  baseAnnualRate?: number | null;
  adjustments?: LoanRateAdjustment[] | null;
  intervalMonths?: number | null;
  totalRuns: number;
  firstRunDate: Date;
  maxRows?: number | null;
}): LoanRepaymentSchedulePreviewRow[] {
  const principal = Math.max(0, Number(params.principal));
  const totalRuns = Math.floor(Number(params.totalRuns));
  const firstRunDate = startOfDayUtc(params.firstRunDate);
  if (
    principal <= 0 ||
    !Number.isFinite(totalRuns) ||
    totalRuns <= 0 ||
    !Number.isFinite(firstRunDate.getTime())
  ) {
    return [];
  }

  const intervalMonths = Math.max(1, Math.floor(Number(params.intervalMonths) || 1));
  const maxRows = Math.min(Math.max(1, Math.floor(Number(params.maxRows) || totalRuns)), totalRuns, 600);
  const adjustments = normalizeLoanRateAdjustments(params.adjustments);
  const executionDay = firstRunDate.getUTCDate();
  let runDate = firstRunDate;
  let previousRunDate = firstRunDate;
  let remainingPrincipal = roundLoanMoney(principal);
  let exactRemainingPrincipal = principal;
  let scheduledAmount = calcLoanScheduledAmountForPeriodStart({
    repaymentMethod: params.repaymentMethod,
    baseAnnualRate: params.baseAnnualRate,
    adjustments,
    intervalMonths,
    scheduledAmount: calcLoanScheduledAmount({
      repaymentMethod: params.repaymentMethod,
      annualRate: params.baseAnnualRate,
      principal,
      totalRuns,
      intervalMonths,
    }) ?? principal,
    remainingPrincipal,
    remainingRuns: totalRuns,
    periodStartDate: formatDateUtc(firstRunDate),
  });
  let scheduledAmountExact = calcLoanScheduledAmountExact({
    repaymentMethod: params.repaymentMethod,
    annualRate: params.baseAnnualRate,
    principal: exactRemainingPrincipal,
    totalRuns,
    intervalMonths,
  }) ?? scheduledAmount;
  const rows: LoanRepaymentSchedulePreviewRow[] = [];

  for (let index = 0; index < maxRows && remainingPrincipal > 0.005; index += 1) {
    const remainingRunsForThisRun = Math.max(1, totalRuns - index);
    const parts = calcLoanRunPartsWithRateAdjustments({
      repaymentMethod: params.repaymentMethod,
      baseAnnualRate: params.baseAnnualRate,
      adjustments,
      intervalMonths,
      scheduledAmount,
      scheduledAmountExact,
      preserveScheduledAmount: true,
      remainingPrincipal: exactRemainingPrincipal,
      remainingRuns: remainingRunsForThisRun,
      previousRunDate: formatDateUtc(previousRunDate),
      runDate: formatDateUtc(runDate),
    });
    scheduledAmount = parts.scheduledAmount;
    scheduledAmountExact = parts.scheduledAmountExact ?? scheduledAmount;
    exactRemainingPrincipal = Math.max(0, exactRemainingPrincipal - (parts.principalExact ?? parts.principal));
    remainingPrincipal = Math.max(0, roundLoanMoney(remainingPrincipal - parts.principal));
    rows.push({
      period: index + 1,
      date: formatDateUtc(runDate),
      payment: parts.payment,
      principal: parts.principal,
      interest: parts.interest,
      remainingPrincipal,
      annualRate: parts.annualRate,
    });
    previousRunDate = runDate;
    runDate = calcNextScheduledRunDate(
      runDate,
      "month" as IntervalUnit,
      intervalMonths,
      executionDay,
      false,
    );
  }

  return rows;
}
