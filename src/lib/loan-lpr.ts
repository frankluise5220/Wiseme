import { normalizeLoanRateAdjustments, type LoanRateAdjustment } from "./loan-repayment";

export const MORTGAGE_BASE_BENCHMARK_RATE = 4.9;
export const MORTGAGE_LPR_CONVERSION_BASE_RATE = 4.8;

export type LprQuote = {
  date: string;
  fiveYearRate: number;
};

export type MortgageBankExecutionRate = {
  date: string;
  rate: number;
  source: "benchmark" | "lpr";
};

export type MortgageLprAdjustmentBasis = "annual_reprice" | "lpr_quote";

// PBOC RMB loan benchmark rates, over-5-year term. Used for pre-LPR mortgage loans.
export const MORTGAGE_BENCHMARK_RATE_HISTORY: MortgageBankExecutionRate[] = [
  { date: "2010-10-20", rate: 6.14, source: "benchmark" },
  { date: "2010-12-26", rate: 6.4, source: "benchmark" },
  { date: "2011-02-09", rate: 6.6, source: "benchmark" },
  { date: "2011-04-06", rate: 6.8, source: "benchmark" },
  { date: "2011-07-07", rate: 7.05, source: "benchmark" },
  { date: "2012-06-08", rate: 6.8, source: "benchmark" },
  { date: "2012-07-06", rate: 6.55, source: "benchmark" },
  { date: "2014-11-22", rate: 6.15, source: "benchmark" },
  { date: "2015-03-01", rate: 5.9, source: "benchmark" },
  { date: "2015-05-11", rate: 5.65, source: "benchmark" },
  { date: "2015-06-28", rate: 5.4, source: "benchmark" },
  { date: "2015-08-26", rate: 5.15, source: "benchmark" },
  { date: "2015-10-24", rate: 4.9, source: "benchmark" },
];

export const FIVE_YEAR_LPR_HISTORY: LprQuote[] = [
  { date: "2019-08-20", fiveYearRate: 4.85 },
  { date: "2019-11-20", fiveYearRate: 4.8 },
  { date: "2020-02-20", fiveYearRate: 4.75 },
  { date: "2020-04-20", fiveYearRate: 4.65 },
  { date: "2022-01-20", fiveYearRate: 4.6 },
  { date: "2022-05-20", fiveYearRate: 4.45 },
  { date: "2022-08-22", fiveYearRate: 4.3 },
  { date: "2023-06-20", fiveYearRate: 4.2 },
  { date: "2024-02-20", fiveYearRate: 3.95 },
  { date: "2024-07-22", fiveYearRate: 3.85 },
  { date: "2024-10-21", fiveYearRate: 3.6 },
  { date: "2025-05-20", fiveYearRate: 3.5 },
];

function roundRate(value: number) {
  return Math.round(value * 1000) / 1000;
}

function roundDiscount(value: number) {
  return Math.round(value * 10000) / 10000;
}

function dateOnlyToUtcDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function formatDateOnly(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function getLatestFiveYearLpr(date: string) {
  const target = date.slice(0, 10);
  let latest: LprQuote | null = null;
  for (const quote of FIVE_YEAR_LPR_HISTORY) {
    if (quote.date <= target) latest = quote;
    else break;
  }
  return latest;
}

export function getMortgageBankExecutionRate(date: string): MortgageBankExecutionRate | null {
  const target = date.slice(0, 10);
  const lpr = getLatestFiveYearLpr(target);
  if (lpr) return { date: lpr.date, rate: lpr.fiveYearRate, source: "lpr" };

  let latest: MortgageBankExecutionRate | null = null;
  for (const quote of MORTGAGE_BENCHMARK_RATE_HISTORY) {
    if (quote.date <= target) latest = quote;
    else break;
  }
  return latest;
}

export function calcMortgageLprSpreadFromDiscount(discount: number) {
  return roundRate(MORTGAGE_BASE_BENCHMARK_RATE * discount - MORTGAGE_LPR_CONVERSION_BASE_RATE);
}

export function calcMortgageAnnualRateFromLprDiscount(params: {
  discount: number;
  lprRate: number;
}) {
  return roundRate(params.lprRate + calcMortgageLprSpreadFromDiscount(params.discount));
}

export function inferMortgageLprDiscountFromRateAdjustments(adjustments: LoanRateAdjustment[]) {
  const normalized = normalizeLoanRateAdjustments(adjustments);
  for (const adjustment of normalized) {
    const effectiveDate = dateOnlyToUtcDate(adjustment.effectiveDate);
    if (!effectiveDate || !Number.isFinite(adjustment.annualRate) || adjustment.annualRate <= 0) continue;

    const lpr =
      getLatestFiveYearLpr(adjustment.effectiveDate) ??
      getLatestFiveYearLpr(formatDateOnly(addUtcDays(effectiveDate, -1)));
    if (!lpr) continue;

    const spread = roundRate(adjustment.annualRate - lpr.fiveYearRate);
    const discount = roundDiscount((spread + MORTGAGE_LPR_CONVERSION_BASE_RATE) / MORTGAGE_BASE_BENCHMARK_RATE);
    if (discount <= 0 || discount > 2) continue;

    const expectedAnnualRate = calcMortgageAnnualRateFromLprDiscount({
      discount,
      lprRate: lpr.fiveYearRate,
    });
    if (Math.abs(expectedAnnualRate - adjustment.annualRate) <= 0.005) return discount;
  }

  return null;
}

export function buildMortgageLprRateAdjustments(params: {
  discount: number;
  throughDate: string;
  fromDate?: string;
  repriceMonth?: number;
  repriceDay?: number;
  firstRepriceYear?: number;
  includeUnchanged?: boolean;
  basis?: MortgageLprAdjustmentBasis;
}) {
  const through = dateOnlyToUtcDate(params.throughDate);
  if (!through || !Number.isFinite(params.discount) || params.discount <= 0) return [];

  const repriceMonth = Math.min(12, Math.max(1, Math.trunc(params.repriceMonth ?? 1)));
  const repriceDay = Math.min(31, Math.max(1, Math.trunc(params.repriceDay ?? 1)));
  const from = params.fromDate ? dateOnlyToUtcDate(params.fromDate) : null;
  const basis = params.basis ?? "annual_reprice";
  const firstRepriceYear = Math.max(2020, Math.trunc(params.firstRepriceYear ?? 2021));
  const throughYear = through.getUTCFullYear();
  const spread = calcMortgageLprSpreadFromDiscount(params.discount);
  let previousRate = roundRate((from && params.fromDate
    ? (getMortgageBankExecutionRate(params.fromDate)?.rate ?? MORTGAGE_BASE_BENCHMARK_RATE)
    : MORTGAGE_BASE_BENCHMARK_RATE) * params.discount);
  const rows: LoanRateAdjustment[] = [];

  if (basis === "lpr_quote") {
    for (const quote of FIVE_YEAR_LPR_HISTORY) {
      const effectiveDate = dateOnlyToUtcDate(quote.date);
      if (!effectiveDate) continue;
      if (effectiveDate > through) break;
      if (from && effectiveDate <= from) continue;

      const annualRate = roundRate(quote.fiveYearRate + spread);
      if (params.includeUnchanged || Math.abs(annualRate - previousRate) >= 0.0005) {
        rows.push({ effectiveDate: quote.date, annualRate });
        previousRate = annualRate;
      }
    }

    return normalizeLoanRateAdjustments(rows);
  }

  for (let year = firstRepriceYear; year <= throughYear; year += 1) {
    const effectiveDate = new Date(Date.UTC(year, repriceMonth - 1, repriceDay));
    if (effectiveDate > through) break;
    if (from && effectiveDate <= from) continue;
    if (effectiveDate.getUTCMonth() !== repriceMonth - 1) continue;

    const lprLookupDate = formatDateOnly(addUtcDays(effectiveDate, -1));
    const lpr = getLatestFiveYearLpr(lprLookupDate);
    if (!lpr) continue;

    const annualRate = roundRate(lpr.fiveYearRate + spread);
    if (params.includeUnchanged || Math.abs(annualRate - previousRate) >= 0.0005) {
      rows.push({ effectiveDate: formatDateOnly(effectiveDate), annualRate });
      previousRate = annualRate;
    }
  }

  return normalizeLoanRateAdjustments(rows);
}

function isAnnualRepriceDate(params: {
  effectiveDate: string;
  repriceMonth?: number;
  repriceDay?: number;
  firstRepriceYear?: number;
}) {
  const effectiveDate = dateOnlyToUtcDate(params.effectiveDate);
  if (!effectiveDate) return false;
  const repriceMonth = Math.min(12, Math.max(1, Math.trunc(params.repriceMonth ?? 1)));
  const repriceDay = Math.min(31, Math.max(1, Math.trunc(params.repriceDay ?? 1)));
  const firstRepriceYear = Math.max(2020, Math.trunc(params.firstRepriceYear ?? 2021));
  return (
    effectiveDate.getUTCFullYear() >= firstRepriceYear &&
    effectiveDate.getUTCMonth() === repriceMonth - 1 &&
    effectiveDate.getUTCDate() === repriceDay
  );
}

function isLegacyLprQuoteDateGeneratedAdjustment(params: {
  adjustment: LoanRateAdjustment;
  discount: number;
  repriceMonth?: number;
  repriceDay?: number;
  firstRepriceYear?: number;
}) {
  if (isAnnualRepriceDate({
    effectiveDate: params.adjustment.effectiveDate,
    repriceMonth: params.repriceMonth,
    repriceDay: params.repriceDay,
    firstRepriceYear: params.firstRepriceYear,
  })) {
    return false;
  }
  const quote = FIVE_YEAR_LPR_HISTORY.find((item) => item.date === params.adjustment.effectiveDate);
  if (!quote) return false;
  const expectedRate = calcMortgageAnnualRateFromLprDiscount({
    discount: params.discount,
    lprRate: quote.fiveYearRate,
  });
  return Math.abs(expectedRate - params.adjustment.annualRate) <= 0.005;
}

export function normalizeMortgageLprAdjustmentHistory(params: {
  adjustments?: LoanRateAdjustment[] | null;
  discount?: number | null;
  throughDate: string;
  fromDate?: string | null;
  repriceMonth?: number;
  repriceDay?: number;
  firstRepriceYear?: number;
}) {
  const adjustments = normalizeLoanRateAdjustments(params.adjustments);
  const discount = Number(params.discount);
  if (!Number.isFinite(discount) || discount <= 0) return adjustments;

  const hasLegacyQuoteRows = adjustments.some((adjustment) =>
    isLegacyLprQuoteDateGeneratedAdjustment({
      adjustment,
      discount,
      repriceMonth: params.repriceMonth,
      repriceDay: params.repriceDay,
      firstRepriceYear: params.firstRepriceYear,
    }),
  );
  if (!hasLegacyQuoteRows) return adjustments;

  const annualRows = buildMortgageLprRateAdjustments({
    discount,
    throughDate: params.throughDate,
    fromDate: params.fromDate ?? undefined,
    repriceMonth: params.repriceMonth,
    repriceDay: params.repriceDay,
    firstRepriceYear: params.firstRepriceYear,
  });
  const byDate = new Map(annualRows.map((item) => [item.effectiveDate, item]));
  for (const adjustment of adjustments) {
    if (isLegacyLprQuoteDateGeneratedAdjustment({
      adjustment,
      discount,
      repriceMonth: params.repriceMonth,
      repriceDay: params.repriceDay,
      firstRepriceYear: params.firstRepriceYear,
    })) {
      continue;
    }
    byDate.set(adjustment.effectiveDate, adjustment);
  }

  return normalizeLoanRateAdjustments(Array.from(byDate.values()));
}
