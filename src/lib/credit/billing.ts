import { addDaysUtc, clampDay, startOfDayUtc, toNumber } from "@/lib/date-utils";
import { TransactionType, type Prisma } from "@prisma/client";

export type CreditBillSummary = {
  month: string;
  start: Date;
  end: Date;
  due: Date | null;
  bill: number;
  paid: number;
  remain: number;
  overpaid: number;
  expenseAbs: number;
  income: number;
  isCurrentCycle: boolean;
};

export type CreditBillCascadeRow = {
  month: string;
  bill: number;
  billDelta?: number;
  paid: number;
};

export type CreditBillOverrideInput = {
  statementMonth?: string | null;
  amount: number;
};

export type CreditBillCumulative = {
  cumulativeRemain: number;
  cumulativeOverpaid: number;
};

export type CreditBillFlowEntry = {
  accountId?: string | null;
  toAccountId?: string | null;
  amount?: unknown;
  type?: string | null;
  categoryName?: string | null;
  date?: Date | null;
  postedAt?: Date | null;
};

export type CreditCardCyclePersistRow = {
  statementMonth: string;
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date | null;
  expenseAbs: number;
  income: number;
  paid: number;
  rawBill: number;
  effectiveBill: number;
  cumulativeRemain: number;
  cumulativeOverpaid: number;
  isCurrentCycle: boolean;
  isLocked: boolean;
  lockSource: string | null;
};

export type CreditCardBillingDayRule = {
  effectiveDate: Date;
  billingDay: number;
};

export type CreditBillCycleDefinition = {
  start: Date;
  end: Date;
  due: Date | null;
  today: Date;
  isCurrentCycle: boolean;
  billingDay: number;
};

export const CREDIT_CARD_BILLING_DAY_INITIAL_DATE = new Date(Date.UTC(1900, 0, 1));

export const CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE = "manual_cycle";
export const CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE = "statement_import";

export function hasCreditCardCycleLockSource(
  lockSource: string | null | undefined,
  source: string,
) {
  return String(lockSource ?? "")
    .split(",")
    .map((item) => item.trim())
    .includes(source);
}

export function mergeCreditCardCycleLockSources(
  ...sources: Array<string | null | undefined>
) {
  const merged = new Set<string>();
  for (const source of sources) {
    for (const item of String(source ?? "").split(",")) {
      const normalized = item.trim();
      if (normalized) merged.add(normalized);
    }
  }
  return merged.size > 0 ? Array.from(merged).join(",") : null;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function nextCreditBillStatementMonth(statementMonth: string) {
  const match = statementMonth.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return null;
  const nextDate = new Date(Date.UTC(year, month, 1));
  return `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function paidFromNextCycleIncome(
  statementMonth: string,
  incomeByMonth: ReadonlyMap<string, number>,
) {
  const nextMonth = nextCreditBillStatementMonth(statementMonth);
  return nextMonth ? incomeByMonth.get(nextMonth) ?? 0 : 0;
}

export function applyNextCyclePaidToCreditBillSummaries<T extends { month: string; income: number }>(
  summaries: readonly T[],
) {
  const incomeByMonth = new Map(summaries.map((summary) => [summary.month, summary.income]));
  return summaries.map((summary) => ({
    ...summary,
    paid: paidFromNextCycleIncome(summary.month, incomeByMonth),
  }));
}

export function creditBillUnpaidAmount(row: { effectiveBill?: unknown; paid?: unknown }) {
  return Math.max(0, roundMoney(toNumber(row.effectiveBill) - toNumber(row.paid)));
}

export function isCreditBillSettled(row: { isCurrentCycle?: boolean; effectiveBill?: unknown; paid?: unknown }) {
  const effectiveBill = toNumber(row.effectiveBill);
  if (row.isCurrentCycle || effectiveBill <= 0) return false;
  return roundMoney(toNumber(row.paid)) + 0.005 >= roundMoney(effectiveBill);
}

export function creditCardDisplayBalanceFromCurrentCycle(
  cycle: { effectiveBill?: unknown; cumulativeRemain?: unknown; cumulativeOverpaid?: unknown } | null | undefined,
  fallback = 0,
) {
  if (!cycle) return fallback;
  if (cycle.effectiveBill != null) return toNumber(cycle.effectiveBill);
  return toNumber(cycle.cumulativeRemain) - toNumber(cycle.cumulativeOverpaid);
}

export function signedCreditBillAmountFromCardSide(
  entry: CreditBillFlowEntry,
  billAccountIdSet: ReadonlySet<string>,
) {
  const fromBillAccount = billAccountIdSet.has(entry.accountId ?? "");
  const toBillAccount = billAccountIdSet.has(entry.toAccountId ?? "");
  if (fromBillAccount && toBillAccount) return 0;
  const amount = toNumber(entry.amount);
  if (fromBillAccount) return amount;
  if (toBillAccount) return -amount;
  return null;
}

/**
 * Credit-card expense and income rows are grouped by their posting date when
 * available. Other bill flows, such as transfers and investments, keep using
 * their business date because they normally do not have a posting date.
 */
export function creditBillEffectiveDate(entry: {
  type?: string | null;
  date?: Date | null;
  postedAt?: Date | null;
}) {
  if (
    (entry.type === TransactionType.expense || entry.type === TransactionType.income) &&
    entry.postedAt
  ) {
    return entry.postedAt;
  }
  return entry.date ?? null;
}

/**
 * Build the Prisma date predicate used by credit-bill cycle queries. Prisma
 * cannot express a per-row COALESCE in a normal date filter, so expense and
 * income rows are split into posted-date and legacy date-fallback branches.
 */
export function creditBillDateRangeWhere(
  start: Date,
  endExclusive: Date,
): Prisma.TxRecordWhereInput {
  const postedDateTypes = [TransactionType.expense, TransactionType.income];
  const dateRange = { gte: start, lt: endExclusive };
  return {
    OR: [
      { type: { in: postedDateTypes }, postedAt: dateRange },
      { type: { in: postedDateTypes }, postedAt: null, date: dateRange },
      { type: { notIn: postedDateTypes }, date: dateRange },
    ],
  };
}

/**
 * Classify a credit-bill flow row into the display side (outflow vs inflow)
 * from the signed cash-flow amount on the credit-card side. Transaction type
 * describes business classification only; it must not override direction.
 *
 * Outflow = negative amount on the card side.
 * Inflow = positive amount on the card side, including repayments, refunds,
 * income, and transfers into the card.
 *
 * Returns "outflow" | "inflow" | null (null = skip, e.g. internal transfer).
 */
export function classifyCreditBillFlowSide(
  entry: CreditBillFlowEntry,
  billAccountIdSet: ReadonlySet<string>,
): "outflow" | "inflow" | null {
  const signedAmount = signedCreditBillAmountFromCardSide(entry, billAccountIdSet);
  if (signedAmount == null || signedAmount === 0) return null;
  return signedAmount < 0 ? "outflow" : "inflow";
}

export function summarizeCreditBillSignedFlows(
  entries: readonly CreditBillFlowEntry[],
  billAccountIdSet: ReadonlySet<string>,
) {
  let expenseAbs = 0;
  let income = 0;
  for (const entry of entries) {
    const side = classifyCreditBillFlowSide(entry, billAccountIdSet);
    if (!side) continue;
    const signedAmount = signedCreditBillAmountFromCardSide(entry, billAccountIdSet);
    if (signedAmount == null) continue;
    const abs = Math.abs(signedAmount);
    if (side === "outflow") expenseAbs += abs;
    else income += abs;
  }
  const roundedExpenseAbs = roundMoney(expenseAbs);
  const roundedIncome = roundMoney(income);
  return {
    expenseAbs: roundedExpenseAbs,
    income: roundedIncome,
    bill: roundMoney(roundedExpenseAbs - roundedIncome),
  };
}

function parseStatementMonth(statementMonth: string) {
  const match = statementMonth.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex > 11) return null;
  return { year, monthIndex };
}

function monthKey(year: number, monthIndex: number) {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function compareMonth(a: string, b: string) {
  return a.localeCompare(b);
}

function dueForCycleEnd(
  periodEnd: Date,
  billingDay: number,
  repaymentDay: number | null | undefined,
  repaymentOffsetDays?: number | null,
) {
  if (repaymentOffsetDays != null && repaymentOffsetDays > 0) {
    return addDaysUtc(periodEnd, repaymentOffsetDays);
  }
  if (!repaymentDay || repaymentDay < 1) return null;
  const dueMonthOffset = repaymentDay <= billingDay ? 1 : 0;
  const dueMonth = periodEnd.getUTCMonth() + dueMonthOffset;
  const dueYear = periodEnd.getUTCFullYear() + Math.floor(dueMonth / 12);
  const dueMonthNorm = ((dueMonth % 12) + 12) % 12;
  return new Date(Date.UTC(dueYear, dueMonthNorm, clampDay(dueYear, dueMonthNorm, repaymentDay)));
}

function normalizeBillingDayRules(rules: readonly CreditCardBillingDayRule[], fallbackBillingDay?: number | null) {
  const validRules = rules
    .map((rule) => ({
      effectiveDate: startOfDayUtc(rule.effectiveDate),
      billingDay: Math.trunc(rule.billingDay),
    }))
    .filter((rule) => Number.isFinite(rule.billingDay) && rule.billingDay >= 1 && rule.billingDay <= 31)
    .sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime());

  if (validRules.length === 0 && fallbackBillingDay) {
    return [{ effectiveDate: new Date(Date.UTC(1900, 0, 1)), billingDay: fallbackBillingDay }];
  }
  return validRules;
}

export function billingDayAtDate(
  rules: readonly CreditCardBillingDayRule[],
  date: Date,
  fallbackBillingDay?: number | null,
) {
  const normalized = normalizeBillingDayRules(rules, fallbackBillingDay);
  if (normalized.length === 0) return null;
  const target = startOfDayUtc(date).getTime();
  let active = normalized[0]!;
  for (const rule of normalized) {
    if (rule.effectiveDate.getTime() > target) break;
    active = rule;
  }
  return active.billingDay;
}

export function cycleForStatementMonth(
  statementMonth: string,
  billingDay: number,
  repaymentDay: number | null | undefined,
  now: Date,
  repaymentOffsetDays?: number | null,
): CreditBillCycleDefinition | null {
  const parsed = parseStatementMonth(statementMonth);
  if (!parsed) return null;
  const end = new Date(Date.UTC(parsed.year, parsed.monthIndex, clampDay(parsed.year, parsed.monthIndex, billingDay)));
  const previousEnd = new Date(Date.UTC(parsed.year, parsed.monthIndex - 1, clampDay(parsed.year, parsed.monthIndex - 1, billingDay)));
  const start = addDaysUtc(previousEnd, 1);
  const today = startOfDayUtc(now);
  const isCurrentCycle = today.getTime() >= start.getTime() && today.getTime() < addDaysUtc(end, 1).getTime();
  const due = dueForCycleEnd(end, billingDay, repaymentDay, repaymentOffsetDays);

  return { start, end, due, today, isCurrentCycle, billingDay };
}

export function buildCreditBillCycleDefinitionsFromBillingDayRules(params: {
  months: string[];
  billingDayRules: readonly CreditCardBillingDayRule[];
  repaymentDay?: number | null;
  repaymentOffsetDays?: number | null;
  now: Date;
  fallbackBillingDay?: number | null;
}) {
  const sortedMonths = Array.from(new Set(params.months)).sort(compareMonth);
  const rules = normalizeBillingDayRules(params.billingDayRules, params.fallbackBillingDay);
  const definitions = new Map<string, CreditBillCycleDefinition>();
  if (sortedMonths.length === 0 || rules.length === 0) return definitions;

  const first = parseStatementMonth(sortedMonths[0]!);
  const last = parseStatementMonth(sortedMonths[sortedMonths.length - 1]!);
  if (!first || !last) return definitions;

  const firstMonthIndex = first.year * 12 + first.monthIndex;
  const lastMonthIndex = last.year * 12 + last.monthIndex;
  let activeRuleIndex = 0;
  let previousEnd: Date | null = null;
  const today = startOfDayUtc(params.now);

  for (let monthIndexAbs = firstMonthIndex - 1; monthIndexAbs <= lastMonthIndex; monthIndexAbs++) {
    const year = Math.floor(monthIndexAbs / 12);
    const monthIndex = monthIndexAbs % 12;
    const statementMonth = monthKey(year, monthIndex);
    let activeRule = rules[activeRuleIndex]!;
    let end = new Date(Date.UTC(year, monthIndex, clampDay(year, monthIndex, activeRule.billingDay)));

    while (activeRuleIndex + 1 < rules.length) {
      const nextRule = rules[activeRuleIndex + 1]!;
      if (nextRule.effectiveDate.getTime() > end.getTime()) break;
      const nextEnd = new Date(Date.UTC(year, monthIndex, clampDay(year, monthIndex, nextRule.billingDay)));
      if (nextEnd.getTime() < nextRule.effectiveDate.getTime()) break;
      activeRuleIndex += 1;
      activeRule = nextRule;
      end = nextEnd;
    }

    const start = previousEnd ? addDaysUtc(previousEnd, 1) : addDaysUtc(
      new Date(Date.UTC(year, monthIndex - 1, clampDay(year, monthIndex - 1, activeRule.billingDay))),
      1,
    );
    previousEnd = end;
    if (monthIndexAbs < firstMonthIndex) continue;
    const isCurrentCycle = today.getTime() >= start.getTime() && today.getTime() < addDaysUtc(end, 1).getTime();
    definitions.set(statementMonth, {
      start,
      end,
      due: dueForCycleEnd(end, activeRule.billingDay, params.repaymentDay, params.repaymentOffsetDays),
      today,
      isCurrentCycle,
      billingDay: activeRule.billingDay,
    });
  }

  return definitions;
}

export function cycleForStatementMonthWithBillingDayRules(params: {
  statementMonth: string;
  billingDayRules: readonly CreditCardBillingDayRule[];
  repaymentDay?: number | null;
  repaymentOffsetDays?: number | null;
  now: Date;
  fallbackBillingDay?: number | null;
}) {
  return buildCreditBillCycleDefinitionsFromBillingDayRules({
    months: [params.statementMonth],
    billingDayRules: params.billingDayRules,
    repaymentDay: params.repaymentDay,
    repaymentOffsetDays: params.repaymentOffsetDays,
    now: params.now,
    fallbackBillingDay: params.fallbackBillingDay,
  }).get(params.statementMonth) ?? null;
}

export function statementMonthForDateWithBillingDayRules(params: {
  date: Date;
  billingDayRules: readonly CreditCardBillingDayRule[];
  now: Date;
  fallbackBillingDay?: number | null;
}) {
  const date = startOfDayUtc(params.date);
  const months = [
    monthKey(date.getUTCFullYear(), date.getUTCMonth()),
    monthKey(date.getUTCFullYear(), date.getUTCMonth() + 1),
  ];
  const definitions = buildCreditBillCycleDefinitionsFromBillingDayRules({
    months,
    billingDayRules: params.billingDayRules,
    now: params.now,
    fallbackBillingDay: params.fallbackBillingDay,
  });
  const timestamp = date.getTime();
  return Array.from(definitions.entries()).find(([, cycle]) => (
    timestamp >= cycle.start.getTime() && timestamp < addDaysUtc(cycle.end, 1).getTime()
  ))?.[0] ?? null;
}

export function fillMissingCreditBillSummaries(params: {
  months: string[];
  summaryByMonth: Map<string, CreditBillSummary>;
  billingDay: number;
  repaymentDay?: number | null;
  repaymentOffsetDays?: number | null;
  now: Date;
  cycleByMonth?: ReadonlyMap<string, CreditBillCycleDefinition>;
}) {
  const { months, summaryByMonth, billingDay, repaymentDay, repaymentOffsetDays, now, cycleByMonth } = params;

  return months
    .map((month) => {
      const existing = summaryByMonth.get(month);
      if (existing) return existing;

      const base = cycleByMonth?.get(month) ?? cycleForStatementMonth(month, billingDay, repaymentDay ?? null, now, repaymentOffsetDays);
      if (!base) return null;

      return {
        month,
        start: base.start,
        end: base.end,
        due: base.due,
        bill: 0,
        paid: 0,
        remain: 0,
        overpaid: 0,
        expenseAbs: 0,
        income: 0,
        isCurrentCycle: base.isCurrentCycle,
      } satisfies CreditBillSummary;
    })
    .filter((item): item is CreditBillSummary => !!item);
}

export function computeCreditBillCascade(params: {
  monthsForCascade: string[];
  summaryByMonth: Map<string, Pick<CreditBillSummary, "bill" | "paid" | "expenseAbs" | "income">>;
  overrides: CreditBillOverrideInput[];
}) {
  const { monthsForCascade, summaryByMonth, overrides } = params;

  const overrideByMonth = new Map<string, number>(
    overrides
      .filter((item): item is { statementMonth: string; amount: number } => !!item.statementMonth)
      .map((item) => [item.statementMonth, Number(item.amount)]),
  );

  const allMonthsForCascade: CreditBillCascadeRow[] = Array.from(new Set(monthsForCascade))
    .sort((a, b) => a.localeCompare(b))
    .map((month) => {
      const summary = summaryByMonth.get(month);
      return {
        month,
        bill: summary?.bill ?? 0,
        billDelta: summary ? summary.expenseAbs - summary.income : 0,
        paid: summary?.paid ?? 0,
      };
    });

  const effectiveBillByMonth = new Map<string, number>();
  let previousBill = 0;
  for (const row of allMonthsForCascade) {
    const override = overrideByMonth.get(row.month);
    const effective = override !== undefined
      ? override
      : previousBill + (row.billDelta ?? row.bill);
    effectiveBillByMonth.set(row.month, effective);
    previousBill = effective;
  }

  const cumulativeByMonth = new Map<string, CreditBillCumulative>();
  for (const row of allMonthsForCascade) {
    const effectiveBill = effectiveBillByMonth.get(row.month) ?? row.bill;
    const afterPaid = effectiveBill - row.paid;
    cumulativeByMonth.set(row.month, {
      cumulativeRemain: Math.max(0, afterPaid),
      cumulativeOverpaid: Math.max(0, -afterPaid),
    });
  }

  return {
    overrideByMonth,
    allMonthsForCascade,
    effectiveBillByMonth,
    cumulativeByMonth,
  };
}

export function mergeCreditBillSummariesWithCascade(
  summaries: CreditBillSummary[],
  effectiveBillByMonth: Map<string, number>,
  cumulativeByMonth: Map<string, CreditBillCumulative>,
) {
  return summaries.map((summary) => {
    const cumulative = cumulativeByMonth.get(summary.month);
    const effectiveBill = effectiveBillByMonth.get(summary.month) ?? summary.bill;
    return {
      ...summary,
      effectiveBill,
      cumulativeRemain: cumulative?.cumulativeRemain ?? summary.remain,
      cumulativeOverpaid: cumulative?.cumulativeOverpaid ?? summary.overpaid,
    };
  });
}

export function buildCreditCardCyclePersistRows(params: {
  billingDay: number;
  repaymentDay?: number | null;
  repaymentOffsetDays?: number | null;
  months: CreditBillCascadeRow[];
  summaryByMonth: ReadonlyMap<string, CreditBillSummary>;
  effectiveBillByMonth: Map<string, number>;
  cumulativeByMonth: Map<string, CreditBillCumulative>;
  overrideByMonth: Map<string, number>;
  now: Date;
  cycleByMonth?: ReadonlyMap<string, CreditBillCycleDefinition>;
}) {
  const {
    billingDay,
    repaymentDay,
    repaymentOffsetDays,
    months,
    summaryByMonth,
    effectiveBillByMonth,
    cumulativeByMonth,
    overrideByMonth,
    now,
    cycleByMonth,
  } = params;

  const rows = months
    .map((row) => {
      const summary = summaryByMonth.get(row.month);
      const cycle = summary ?? cycleByMonth?.get(row.month) ?? cycleForStatementMonth(row.month, billingDay, repaymentDay ?? null, now, repaymentOffsetDays);
      if (!cycle) return null;

      const effectiveBill = effectiveBillByMonth.get(row.month) ?? row.bill;
      const cumulative = cumulativeByMonth.get(row.month);
      const hasOverride = overrideByMonth.has(row.month);

      return {
        statementMonth: row.month,
        periodStart: cycle.start,
        periodEnd: cycle.end,
        dueDate: cycle.due ?? null,
        expenseAbs: summary?.expenseAbs ?? 0,
        income: summary?.income ?? 0,
        paid: summary?.paid ?? row.paid,
        rawBill: summary?.bill ?? row.bill,
        effectiveBill,
        cumulativeRemain: cumulative?.cumulativeRemain ?? 0,
        cumulativeOverpaid: cumulative?.cumulativeOverpaid ?? 0,
        isCurrentCycle: cycle.isCurrentCycle,
        isLocked: hasOverride,
        lockSource: hasOverride ? "override" : null,
      } satisfies CreditCardCyclePersistRow;
    })
    .filter((row): row is CreditCardCyclePersistRow => !!row);
  return Array.from(new Map(rows.map((row) => [row.statementMonth, row])).values());
}
