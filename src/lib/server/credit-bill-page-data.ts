import { AccountKind, CreditCardInstallmentSourceType, TransactionType, type CreditBillingDayTxPeriod, type Prisma } from "@prisma/client";
import type { DetailEntry } from "@/components/DetailViewClient";
import type { CreditBillSummaryRow } from "@/components/CreditBillSummaryTable";
import { prisma } from "@/lib/db/prisma";
import { addDaysUtc, formatDateLocal, toNumber } from "@/lib/date-utils";
import {
  CREDIT_CARD_BILLING_DAY_INITIAL_DATE,
  CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE,
  CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE,
  applyNextCyclePaidToCreditBillSummaries,
  buildCreditCardCyclePersistRows,
  buildCreditBillCycleDefinitionsFromBillingDayRules,
  computeCreditBillCascade,
  creditBillDateRangeWhere,
  creditBillEffectiveDate,
  cycleForStatementMonthWithBillingDayRules,
  fillMissingCreditBillSummaries,
  hasCreditCardCycleLockSource,
  isCreditBillSettled,
  mergeCreditCardCycleLockSources,
  mergeCreditBillSummariesWithCascade,
  normalizeBillingDayTxPeriod,
  signedCreditBillAmountFromCardSide,
  classifyCreditBillFlowSide,
  summarizeCreditBillSignedFlows,
} from "@/lib/credit/billing";
import { normalizeCreditCardInstallmentStatementMonths, materializeDueInstallmentPayments } from "@/lib/server/credit-card-installment";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { getCreditBillAccountIds } from "@/lib/server/credit-card-institution-settings";
import { buildEntryBusinessLinkSummary, entryBusinessLinkSummaryInclude } from "@/lib/server/entry-business-link";

type SelectedBillAccount = {
  id: string;
  kind: AccountKind;
  billingDay: number | null;
  repaymentDay: number | null;
  billingDayTxPeriod?: CreditBillingDayTxPeriod | null;
};

export type CreditBillingDayRuleRow = {
  effectiveDate: string;
  billingDay: number;
  isInitial: boolean;
};

export type CreditBillPageData = {
  creditCardBill: {
    start: Date;
    end: Date;
    due: Date | null;
    repayEnd: Date;
    bill: number;
    paid: number;
    remain: number;
    overpaid: number;
    expenseAbs?: number;
    income?: number;
    statementMonth: string;
    isCurrentCycle: boolean;
  } | null;
  currentStatementMonth: string;
  settledBillMonth: string;
  lastRepayToAccountId: string | undefined;
  lastRepayFromAccountId: string | undefined;
  creditBillSummaryRows: CreditBillSummaryRow[];
  selectedCreditBillMonth: string;
  creditBillBalanceValue: number;
  creditCardBillDetails: { cycleEntries: unknown[]; details: DetailEntry[] } | null;
  currentPage: number;
  billListPageSize: number;
  hasCreditBillSummaries: boolean;
  showAllCreditBillDetails: boolean;
  billingDayRules: CreditBillingDayRuleRow[];
  billingDayTxPeriod: CreditBillingDayTxPeriod;
};

type LoadCreditBillPageDataParams = {
  householdId: string;
  selectedAccount: SelectedBillAccount | null;
  isBillAccount: boolean;
  billAccountIds: string[];
  billStorageAccountId: string;
  billMonthParam: string;
  billPage: number;
  billMonthsLimit: number;
  hideZeroBills: boolean;
  hideSettledBills: boolean;
  showRecentBillCycles: boolean;
  view: string;
  t: (key: string) => string;
  forceCycleRefresh?: boolean;
  categoryLabels: Map<string, string>;
  isSettlementDebtAccountId: (accountId: string | null | undefined) => boolean;
  isCreditCardRepaymentForDisplay: (entry: any) => boolean;
};

function ymdUtc(d: Date) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function mdUtcDots(d: Date) {
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${m}.${day}`;
}

function toValidDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function toIsoOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? date.toISOString() : null;
}

function toDateOnlyLocalOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? formatDateLocal(date) : null;
}

function toYmdOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? ymdUtc(date) : null;
}

export async function loadCreditBillPageData(params: LoadCreditBillPageDataParams): Promise<CreditBillPageData> {
  const {
    householdId,
    selectedAccount,
    isBillAccount,
    billAccountIds,
    billStorageAccountId,
    billMonthParam,
    billPage,
    billMonthsLimit,
    hideZeroBills,
    hideSettledBills,
    showRecentBillCycles,
    view,
    t,
    forceCycleRefresh = false,
    categoryLabels,
    isSettlementDebtAccountId,
    isCreditCardRepaymentForDisplay,
  } = params;

  const billAccountIdSet = new Set(billAccountIds);
  const scopedBillAccountIds = billAccountIds.length > 0 ? billAccountIds : selectedAccount ? [selectedAccount.id] : [];

  // Lazy materialization: create installment payment rows that became due
  // since the last daily job, so the bill view is correct even if the job
  // has not run yet. Non-fatal on failure.
  if (scopedBillAccountIds.length > 0) {
    await materializeDueInstallmentPayments(prisma, {
      householdId,
      accountIds: scopedBillAccountIds,
    }).catch((error) => {
      console.error("materialize installment payments failed:", error);
    });
  }

  const billScope: Prisma.TxRecordWhereInput | undefined = selectedAccount
    ? {
        OR: [
          { accountId: { in: scopedBillAccountIds } },
          { toAccountId: { in: scopedBillAccountIds } },
        ],
      }
    : undefined;

  const creditBillNow = new Date();
  const todayUtcStart = new Date(Date.UTC(creditBillNow.getUTCFullYear(), creditBillNow.getUTCMonth(), creditBillNow.getUTCDate()));
  const billingDayTxPeriod = normalizeBillingDayTxPeriod(selectedAccount?.billingDayTxPeriod);
  const billingDayRules = isBillAccount && selectedAccount?.kind === AccountKind.bank_credit && billAccountIds.length > 0
    ? await prisma.creditCardBillingDay.findMany({
        where: { accountId: { in: billAccountIds } },
        select: { effectiveDate: true, billingDay: true, updatedAt: true },
        orderBy: { effectiveDate: "asc" },
      })
    : [];
  const billingDayRuleRows: CreditBillingDayRuleRow[] = billingDayRules
    .slice()
    .sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime())
    .map((rule) => ({
      effectiveDate: ymdUtc(rule.effectiveDate),
      billingDay: rule.billingDay,
      isInitial: rule.effectiveDate.getTime() === CREDIT_CARD_BILLING_DAY_INITIAL_DATE.getTime(),
    }));
  const fallbackBillingDay = selectedAccount?.billingDay ?? null;
  const hasBillingDayRules = billingDayRules.length > 0 || !!fallbackBillingDay;
  // Bump this timestamp whenever the credit-bill flow calculation logic
  // changes (e.g. classifyCreditBillFlowSide). It forces persisted cycle
  // summaries to be recomputed with the new logic instead of reusing stale
  // cached values. Last bumped: 2026-08-29 15:55 (transfer rows now follow
  // the signed credit-card-side amount instead of always counting as inflow).
  const creditBillSummaryLogicUpdatedAt = new Date(Date.UTC(2026, 7, 29, 7, 55, 0));
  const latestBillingDayRuleUpdatedAt = billingDayRules.reduce<Date | null>(
    (latest, rule) => (!latest || rule.updatedAt > latest ? rule.updatedAt : latest),
    null,
  );
  const currentStatementMonth = (() => {
    if (!isBillAccount || !selectedAccount || !hasBillingDayRules) return "";
    const currentMonth = `${creditBillNow.getUTCFullYear()}-${String(creditBillNow.getUTCMonth() + 1).padStart(2, "0")}`;
    const nextMonthDate = new Date(Date.UTC(creditBillNow.getUTCFullYear(), creditBillNow.getUTCMonth() + 1, 1));
    const nextMonth = `${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth() + 1).padStart(2, "0")}`;
    const definitions = buildCreditBillCycleDefinitionsFromBillingDayRules({
      months: [currentMonth, nextMonth],
      billingDayRules,
      repaymentDay: selectedAccount.repaymentDay ?? null,
      now: creditBillNow,
      fallbackBillingDay,
    });
    const today = todayUtcStart.getTime();
    return Array.from(definitions.entries()).find(([, cycle]) => (
      today >= cycle.start.getTime() && today < addDaysUtc(cycle.end, 1).getTime()
    ))?.[0] ?? currentMonth;
  })();

  const normalizedCreditInstallments =
    isBillAccount && selectedAccount?.kind === AccountKind.bank_credit && selectedAccount.billingDay && billAccountIds.length > 0
      ? await prisma.$transaction((tx) =>
          normalizeCreditCardInstallmentStatementMonths(tx, {
            householdId,
            accountIds: billAccountIds,
            billingDay: selectedAccount.billingDay ?? 1,
            billingDayTxPeriod,
          }),
        )
      : { updatedEntries: 0, updatedPlans: 0 };
  if (normalizedCreditInstallments.updatedEntries > 0 || normalizedCreditInstallments.updatedPlans > 0) {
    await invalidateCreditCardCycleCacheForAccountIds(billAccountIds);
  }

  const isDisplayableBillMonth = (month: string) => !currentStatementMonth || month <= currentStatementMonth;
  const persistedCyclesInitial = isBillAccount && selectedAccount
    ? await prisma.creditCardCycle.findMany({
        where: {
          accountId: billStorageAccountId,
          ...(currentStatementMonth ? { statementMonth: { lte: currentStatementMonth } } : {}),
        },
        orderBy: { statementMonth: "desc" },
      })
    : [];
  const activeStatementInstallments = isBillAccount && selectedAccount?.kind === AccountKind.bank_credit
    ? await prisma.creditCardInstallmentPlan.findMany({
        where: {
          householdId,
          accountId: { in: billAccountIds },
          sourceType: CreditCardInstallmentSourceType.statement,
          sourceStatementMonth: { not: null },
          status: "active",
        },
        select: { sourceStatementMonth: true, installmentPrincipal: true },
      })
    : [];
  const statementInstallmentPrincipalByMonth = new Map(
    activeStatementInstallments.map((plan) => [
      plan.sourceStatementMonth ?? "",
      toNumber(plan.installmentPrincipal),
    ]),
  );
  const billOverrides = isBillAccount && selectedAccount
    ? await prisma.billOverride.findMany({
        where: { accountId: billStorageAccountId },
        orderBy: { statementMonth: "desc" },
      })
    : [];
  const persistedCycleByMonth = new Map(persistedCyclesInitial.map((cycle) => [cycle.statementMonth, cycle]));
  const latestBillTxUpdatedAt = isBillAccount && selectedAccount && billScope
    ? await prisma.txRecord.findFirst({
        where: { AND: [billScope] },
        orderBy: { updatedAt: "desc" },
        select: { updatedAt: true },
      })
    : null;
  const activeBillTxCount = isBillAccount && selectedAccount && billScope
    ? await prisma.txRecord.count({
        where: { AND: [billScope, { deletedAt: null }] },
      })
    : 0;
  const latestCycleUpdatedAt = persistedCyclesInitial.reduce<Date | null>(
    (latest, cycle) => (!latest || cycle.updatedAt > latest ? cycle.updatedAt : latest),
    null,
  );
  const latestOverrideUpdatedAt = billOverrides.reduce<Date | null>(
    (latest, override) => (!latest || override.updatedAt > latest ? override.updatedAt : latest),
    null,
  );
  const billOverrideAmountByMonthInitial = new Map(
    billOverrides.map((override) => [override.statementMonth, toNumber(override.amount)]),
  );
  const importedStatementCycleNeedsRecalc = persistedCyclesInitial.some((cycle) => {
    if (!hasCreditCardCycleLockSource(cycle.lockSource, CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE)) return false;
    const overrideAmount = billOverrideAmountByMonthInitial.get(cycle.statementMonth);
    if (overrideAmount === undefined) return false;
    return Math.abs(toNumber(cycle.effectiveBill) - overrideAmount) > 0.005;
  });
  const creditCycleCacheStale = !!(
    isBillAccount &&
    selectedAccount &&
    (
      forceCycleRefresh ||
      persistedCyclesInitial.length === 0 ||
      (
        activeBillTxCount === 0 &&
        persistedCyclesInitial.some((cycle) =>
          toNumber(cycle.expenseAbs) !== 0 ||
          toNumber(cycle.income) !== 0 ||
          toNumber(cycle.paid) !== 0 ||
          toNumber(cycle.rawBill) !== 0 ||
          toNumber(cycle.effectiveBill) !== 0 ||
          toNumber(cycle.cumulativeRemain) !== 0 ||
          toNumber(cycle.cumulativeOverpaid) !== 0
        )
      ) ||
      !latestCycleUpdatedAt ||
      latestCycleUpdatedAt < creditBillSummaryLogicUpdatedAt ||
      latestCycleUpdatedAt < todayUtcStart ||
      (!!latestBillingDayRuleUpdatedAt && latestBillingDayRuleUpdatedAt > latestCycleUpdatedAt) ||
      importedStatementCycleNeedsRecalc ||
      (!!latestBillTxUpdatedAt?.updatedAt && latestBillTxUpdatedAt.updatedAt > latestCycleUpdatedAt) ||
      (!!latestOverrideUpdatedAt && latestOverrideUpdatedAt > latestCycleUpdatedAt)
    )
  );

  // Available bill months are derived from the billing-day history table. The
  // billing day is the cycle end date; if it changes mid-cycle, the current
  // cycle's end date moves to the newly effective billing day.
  const availableBillMonths =
    isBillAccount && selectedAccount && hasBillingDayRules
      ? await (async () => {
          const rows = await prisma.txRecord.findMany({
            where: {
              AND: [billScope!, { deletedAt: null }],
            },
            select: { date: true, postedAt: true, type: true },
          });
          const candidateMonths = new Set<string>();
          for (const row of rows) {
            const date = creditBillEffectiveDate(row);
            if (!date) continue;
            candidateMonths.add(`${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`);
            const nextMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
            candidateMonths.add(`${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, "0")}`);
          }
          const cycleByMonth = buildCreditBillCycleDefinitionsFromBillingDayRules({
            months: Array.from(candidateMonths),
            billingDayRules,
            repaymentDay: selectedAccount.repaymentDay ?? null,
            now: creditBillNow,
            fallbackBillingDay,
            billingDayTxPeriod,
          });
          const months = new Set<string>();
          for (const row of rows) {
            const date = creditBillEffectiveDate(row);
            if (!date) continue;
            const timestamp = date.getTime();
            const matchedMonth = Array.from(cycleByMonth.entries()).find(([, cycle]) => (
              timestamp >= cycle.start.getTime() && timestamp < addDaysUtc(cycle.end, 1).getTime()
            ))?.[0];
            if (matchedMonth && isDisplayableBillMonth(matchedMonth)) months.add(matchedMonth);
          }
          return Array.from(months).sort((a, b) => b.localeCompare(a));
        })()
      : [];

  const showAllCreditBillDetails = billMonthParam === "all";
  const selectedBillMonth =
    !showAllCreditBillDetails && /^(\d{4})-(\d{2})$/.test(billMonthParam) && isDisplayableBillMonth(billMonthParam)
      ? billMonthParam
      : "";

  const creditCardBill =
    isBillAccount && selectedAccount && hasBillingDayRules
      ? await (async () => {
          const base = selectedBillMonth
            ? (() => {
                const persisted = persistedCycleByMonth.get(selectedBillMonth);
                if (persisted) {
                  const today = new Date(Date.UTC(creditBillNow.getUTCFullYear(), creditBillNow.getUTCMonth(), creditBillNow.getUTCDate()));
                  return {
                    start: persisted.periodStart,
                    end: persisted.periodEnd,
                    due: persisted.dueDate,
                    today,
                    isCurrentCycle: today >= persisted.periodStart && today < addDaysUtc(persisted.periodEnd, 1),
                  };
                }
                return cycleForStatementMonthWithBillingDayRules({
                  statementMonth: selectedBillMonth,
                  billingDayRules,
                  repaymentDay: selectedAccount.repaymentDay ?? null,
                  now: creditBillNow,
                  fallbackBillingDay,
                });
              })()
            : cycleForStatementMonthWithBillingDayRules({
                statementMonth: currentStatementMonth,
                billingDayRules,
                repaymentDay: selectedAccount.repaymentDay ?? null,
                now: creditBillNow,
                fallbackBillingDay,
              });
          if (!base) return null;

          const { start, end, due, today, isCurrentCycle } = base;
          const repayEnd = due && due.getTime() < today.getTime() ? due : today;
          const statementMonth = selectedBillMonth || currentStatementMonth;
          const cachedCycle = !creditCycleCacheStale
            ? persistedCyclesInitial.find((cycle) => cycle.statementMonth === statementMonth)
            : null;
          if (cachedCycle) {
            return {
              start: cachedCycle.periodStart,
              end: cachedCycle.periodEnd,
              due: cachedCycle.dueDate,
              repayEnd,
              bill: Number(cachedCycle.rawBill),
              paid: Number(cachedCycle.paid),
              remain: Number(cachedCycle.cumulativeRemain),
              overpaid: Number(cachedCycle.cumulativeOverpaid),
              statementMonth,
              isCurrentCycle: cachedCycle.isCurrentCycle,
            };
          }

          const cycleMatch = {
            ...creditBillDateRangeWhere(start, addDaysUtc(end, 1)),
            deletedAt: null,
          };
          const repaymentMatch = {
            amount: { lt: 0 },
            toAccountId: { in: billAccountIds },
            type: TransactionType.transfer,
            deletedAt: null,
            date: { gte: addDaysUtc(end, 1), lt: addDaysUtc(repayEnd, 1) },
          };
          const [cycleFlowRows, paidAgg] = await Promise.all([
            prisma.txRecord.findMany({
              where: {
                AND: [
                  cycleMatch,
                  ...(billScope ? [billScope] : []),
                  { OR: [{ accountId: { in: billAccountIds } }, { toAccountId: { in: billAccountIds } }] },
                ],
              },
              select: { accountId: true, toAccountId: true, amount: true, type: true, categoryName: true },
            }),
            prisma.txRecord.aggregate({
              where: {
                AND: [repaymentMatch, ...(billScope ? [billScope] : [])],
              },
              _sum: { amount: true },
            }),
          ]);

          const flows = summarizeCreditBillSignedFlows(cycleFlowRows, billAccountIdSet);
          const bill = flows.bill;
          const income = flows.income;
          const expenseAbs = flows.expenseAbs;
          const paid = Math.max(0, -toNumber(paidAgg._sum.amount ?? 0));
          const remainRaw = bill - paid;
          const remain = Math.max(0, remainRaw);
          const overpaid = Math.max(0, -remainRaw);

          return { start, end, due, repayEnd, bill, paid, remain, overpaid, expenseAbs, income, statementMonth, isCurrentCycle };
        })()
      : null;

  const settledBillMonth = (() => {
    if (!currentStatementMonth) return "";
    const m = currentStatementMonth.match(/^(\d{4})-(\d{2})$/);
    if (!m) return "";
    const y = Number(m[1]);
    const monthIndex = Number(m[2]) - 1;
    const d = new Date(Date.UTC(y, monthIndex - 1, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  })();

  const lastRepayToAccountId = await (async () => {
    if (!isBillAccount || !selectedAccount) return undefined;
    const lastEntry = await prisma.txRecord.findFirst({
      where: {
        accountId: { in: billAccountIds.length > 0 ? billAccountIds : [selectedAccount.id] },
        type: TransactionType.transfer,
        amount: { gt: 0 },
      },
      orderBy: { date: "desc" },
      take: 1,
    });
    if (!lastEntry) return undefined;
    return lastEntry.toAccountId ?? undefined;
  })();

  const lastRepayFromAccountId = await (async () => {
    if (!isBillAccount || !selectedAccount) return undefined;
    const lastEntry = await prisma.txRecord.findFirst({
      where: {
        accountId: { in: billAccountIds.length > 0 ? billAccountIds : [selectedAccount.id] },
        type: TransactionType.transfer,
        amount: { gt: 0 },
      },
      orderBy: { date: "desc" },
      take: 1,
    });
    if (!lastEntry) return undefined;
    return lastEntry.toAccountId ?? undefined;
  })();

  const billMonthsForList = (() => {
    const months = new Set<string>();
    for (const m of availableBillMonths) months.add(m);
    if (currentStatementMonth) months.add(currentStatementMonth);
    if (selectedBillMonth) months.add(selectedBillMonth);

    if (months.size > 0 && !hideZeroBills) {
      const sorted = Array.from(months).sort((a, b) => a.localeCompare(b));
      const earliest = sorted[0];
      const latest = sorted[sorted.length - 1];
      const [ey, em] = earliest.split("-").map(Number);
      const [ly, lm] = latest.split("-").map(Number);
      for (let y = ey; y <= ly; y++) {
        const startM = y === ey ? em : 1;
        const endM = y === ly ? lm : 12;
        for (let m = startM; m <= endM; m++) {
          months.add(`${y}-${String(m).padStart(2, "0")}`);
        }
      }
    }

    const sortedMonths = Array.from(months).sort((a, b) => b.localeCompare(a));
    const limitedMonths = sortedMonths.slice(0, billMonthsLimit);
    if (showRecentBillCycles && selectedBillMonth && !limitedMonths.includes(selectedBillMonth)) {
      limitedMonths.push(selectedBillMonth);
    }
    return limitedMonths;
  })();

  const billMonthsForCumulative = (() => {
    const merged = new Set<string>();
    if (currentStatementMonth) merged.add(currentStatementMonth);
    if (selectedBillMonth) merged.add(selectedBillMonth);
    for (const m of availableBillMonths) merged.add(m);

    const arr = Array.from(merged).sort((a, b) => a.localeCompare(b));
    if (arr.length === 0) return arr;
    const [ey, em] = arr[0]!.split("-").map(Number);
    const [ly, lm] = arr[arr.length - 1]!.split("-").map(Number);
    const full: string[] = [];
    for (let y = ey; y <= ly; y++) {
      const startM = y === ey ? em : 1;
      const endM = y === ly ? lm : 12;
      for (let m = startM; m <= endM; m++) {
        full.push(`${y}-${String(m).padStart(2, "0")}`);
      }
    }
    return full;
  })();

  const cycleDefinitionByMonth = buildCreditBillCycleDefinitionsFromBillingDayRules({
    months: Array.from(new Set([...billMonthsForCumulative, ...billMonthsForList, currentStatementMonth, selectedBillMonth].filter(Boolean))),
    billingDayRules,
    repaymentDay: selectedAccount?.repaymentDay ?? null,
    now: creditBillNow,
    fallbackBillingDay,
    billingDayTxPeriod,
  });

  const creditCycleDefinitions = (() => {
    const definitions: Array<{
      month: string;
      start: Date;
      end: Date;
      endExclusive: Date;
      due: Date | null;
      isCurrentCycle: boolean;
    }> = [];
    const account = selectedAccount;
    if (!isBillAccount || !account || !hasBillingDayRules) return definitions;

    for (const month of billMonthsForCumulative) {
      const persisted = persistedCycleByMonth.get(month);
      const base = persisted
        ? (() => {
            const today = new Date(Date.UTC(
              creditBillNow.getUTCFullYear(),
              creditBillNow.getUTCMonth(),
              creditBillNow.getUTCDate(),
            ));
            return {
              start: persisted.periodStart,
              end: persisted.periodEnd,
              due: persisted.dueDate,
              isCurrentCycle: today >= persisted.periodStart && today < addDaysUtc(persisted.periodEnd, 1),
            };
          })()
        : cycleDefinitionByMonth.get(month);
      if (!base) continue;
      definitions.push({
        month,
        start: base.start,
        end: base.end,
        endExclusive: addDaysUtc(base.end, 1),
        due: base.due,
        isCurrentCycle: base.isCurrentCycle,
      });
    }
    return definitions;
  })();

  const creditCycleDateRange = creditCycleDefinitions.length > 0
    ? {
        start: creditCycleDefinitions.reduce(
          (earliest, cycle) => cycle.start < earliest ? cycle.start : earliest,
          creditCycleDefinitions[0]!.start,
        ),
        endExclusive: creditCycleDefinitions.reduce(
          (latest, cycle) => cycle.endExclusive > latest ? cycle.endExclusive : latest,
          creditCycleDefinitions[0]!.endExclusive,
        ),
      }
    : null;

  const creditCycleActivityRows =
    creditCycleCacheStale &&
    isBillAccount &&
    selectedAccount &&
    billScope &&
    creditCycleDefinitions.length > 0
      ? await (() => {
          const rangeStart = creditCycleDateRange!.start;
          const rangeEndExclusive = creditCycleDateRange!.endExclusive;
          return prisma.txRecord.findMany({
            where: {
              AND: [
                billScope,
                { deletedAt: null },
                {
                  AND: [
                    { OR: [{ accountId: { in: billAccountIds } }, { toAccountId: { in: billAccountIds } }] },
                    creditBillDateRangeWhere(rangeStart, rangeEndExclusive),
                  ],
                },
              ],
            },
            select: {
              date: true,
              postedAt: true,
              amount: true,
              accountId: true,
              toAccountId: true,
              type: true,
              categoryName: true,
            },
          });
        })()
      : [];

  const creditCycleActivityByMonth = (() => {
    const totals = new Map(
      creditCycleDefinitions.map((cycle) => [
        cycle.month,
        { outflow: 0, inflow: 0 },
      ]),
    );
    const findMonthByDate = (date: Date | null) => {
      if (!date) return undefined;
      const timestamp = date.getTime();
      return creditCycleDefinitions.find(
        (cycle) => timestamp >= cycle.start.getTime() && timestamp < cycle.endExclusive.getTime(),
      )?.month;
    };

    for (const row of creditCycleActivityRows) {
      const side = classifyCreditBillFlowSide(row, billAccountIdSet);
      if (!side) continue;
      const signedAmount = signedCreditBillAmountFromCardSide(row, billAccountIdSet);
      if (signedAmount == null) continue;
      const month = findMonthByDate(creditBillEffectiveDate(row));
      if (!month) continue;
      const monthTotals = totals.get(month);
      if (!monthTotals) continue;
      if (side === "outflow") monthTotals.outflow += Math.abs(signedAmount);
      else monthTotals.inflow += Math.abs(signedAmount);
    }
    return totals;
  })();

  const persistedBillSummariesAll = persistedCyclesInitial.map((cycle) => ({
    month: cycle.statementMonth,
    start: cycle.periodStart,
    end: cycle.periodEnd,
    due: cycle.dueDate,
    bill: Number(cycle.rawBill),
    paid: Number(cycle.paid),
    remain: Number(cycle.cumulativeRemain),
    overpaid: Number(cycle.cumulativeOverpaid),
    expenseAbs: Number(cycle.expenseAbs),
    income: Number(cycle.income),
    isCurrentCycle: cycle.isCurrentCycle,
  }));

  const billSummariesAll =
    !creditCycleCacheStale
      ? persistedBillSummariesAll.filter((summary) => billMonthsForCumulative.includes(summary.month))
      : isBillAccount && selectedAccount && hasBillingDayRules && creditCycleDefinitions.length
        ? creditCycleDefinitions.map(({ month, start, end, due, isCurrentCycle }) => {
            const activity = creditCycleActivityByMonth.get(month) ?? {
              outflow: 0,
              inflow: 0,
            };
            const expenseAbs = activity.outflow;
            const income = activity.inflow;
            const bill = expenseAbs - income;
            return {
              month,
              start,
              end,
              due,
              bill,
              paid: 0,
              remain: bill,
              overpaid: 0,
              expenseAbs,
              income,
              isCurrentCycle,
            };
          })
        : [];

  const billSummariesAllWithNextCyclePaid = applyNextCyclePaidToCreditBillSummaries(billSummariesAll);
  const billSummaryByMonth = new Map(billSummariesAllWithNextCyclePaid.map((s) => [s.month, s]));
  const billSummaries = fillMissingCreditBillSummaries({
    months: billMonthsForList,
    summaryByMonth: billSummaryByMonth,
    billingDay: selectedAccount?.billingDay ?? 1,
    repaymentDay: selectedAccount?.repaymentDay ?? null,
    now: creditBillNow,
    cycleByMonth: cycleDefinitionByMonth,
  });

  const cachedOverrideByMonth = new Map<string, number>(
    billOverrides
      .filter((override) => !!override.statementMonth)
      .map((override) => [override.statementMonth, Number(override.amount)]),
  );
  const cachedEffectiveBillByMonth = new Map<string, number>(
    persistedCyclesInitial.map((cycle) => [cycle.statementMonth, Number(cycle.effectiveBill)]),
  );
  const cachedCumulativeByMonth = new Map<string, { cumulativeRemain: number; cumulativeOverpaid: number }>(
    persistedCyclesInitial.map((cycle) => [
      cycle.statementMonth,
      {
        cumulativeRemain: Number(cycle.cumulativeRemain),
        cumulativeOverpaid: Number(cycle.cumulativeOverpaid),
      },
    ]),
  );
  const creditCascade = !creditCycleCacheStale
    ? {
        overrideByMonth: cachedOverrideByMonth,
        allMonthsForCascade: persistedCyclesInitial
          .filter((cycle) => billMonthsForCumulative.includes(cycle.statementMonth))
          .sort((a, b) => a.statementMonth.localeCompare(b.statementMonth))
          .map((cycle) => ({
            month: cycle.statementMonth,
            bill: Number(cycle.rawBill),
            billDelta: Number(cycle.expenseAbs) - Number(cycle.income),
            paid: Number(cycle.paid),
          })),
        effectiveBillByMonth: cachedEffectiveBillByMonth,
        cumulativeByMonth: cachedCumulativeByMonth,
      }
    : computeCreditBillCascade({
        monthsForCascade: billMonthsForCumulative,
        summaryByMonth: billSummaryByMonth,
        overrides: billOverrides.map((override) => ({
          statementMonth: override.statementMonth,
          amount: Number(override.amount),
        })),
      });
  const {
    overrideByMonth,
    allMonthsForCascade,
    effectiveBillByMonth,
    cumulativeByMonth,
  } = creditCascade;
  const creditCardCyclePersistRows = buildCreditCardCyclePersistRows({
    billingDay: selectedAccount?.billingDay ?? 1,
    repaymentDay: selectedAccount?.repaymentDay ?? null,
    months: allMonthsForCascade,
    summaryByMonth: billSummaryByMonth,
    effectiveBillByMonth,
    cumulativeByMonth,
    overrideByMonth,
    now: creditBillNow,
    cycleByMonth: cycleDefinitionByMonth,
    billingDayTxPeriod,
  });

  if (creditCycleCacheStale && isBillAccount && selectedAccount) {
    await prisma.$transaction(async (tx) => {
      const persistStatementMonths = creditCardCyclePersistRows.map((row) => row.statementMonth);
      await tx.creditCardCycle.deleteMany({
        where: {
          accountId: billStorageAccountId,
          statementMonth: { notIn: persistStatementMonths },
          OR: [
            { lockSource: null },
            {
              AND: [
                { NOT: { lockSource: { contains: CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE } } },
                { NOT: { lockSource: { contains: CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE } } },
              ],
            },
          ],
        },
      });
      if (creditCardCyclePersistRows.length === 0) return;
      for (const row of creditCardCyclePersistRows) {
        const persistedCycle = persistedCycleByMonth.get(row.statementMonth);
        const hasManualCycleLock = hasCreditCardCycleLockSource(
          persistedCycle?.lockSource,
          CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE,
        );
        const hasStatementImportCycleLock = hasCreditCardCycleLockSource(
          persistedCycle?.lockSource,
          CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE,
        );
        const hasFixedCyclePeriodLock = hasManualCycleLock || hasStatementImportCycleLock;
        const lockSource = mergeCreditCardCycleLockSources(
          row.lockSource,
          hasManualCycleLock ? CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE : null,
          hasStatementImportCycleLock ? CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE : null,
        );
        const isLocked = row.isLocked || hasFixedCyclePeriodLock;
        const periodStart = hasFixedCyclePeriodLock && persistedCycle ? persistedCycle.periodStart : row.periodStart;
        const periodEnd = hasFixedCyclePeriodLock && persistedCycle ? persistedCycle.periodEnd : row.periodEnd;
        const dueDate = hasFixedCyclePeriodLock && persistedCycle ? persistedCycle.dueDate : row.dueDate;
        const isCurrentCycle = hasFixedCyclePeriodLock && persistedCycle
          ? todayUtcStart >= periodStart && todayUtcStart < addDaysUtc(periodEnd, 1)
          : row.isCurrentCycle;
        await tx.creditCardCycle.upsert({
          where: {
            accountId_statementMonth: {
              accountId: billStorageAccountId,
              statementMonth: row.statementMonth,
            },
          },
          create: {
            accountId: billStorageAccountId,
            statementMonth: row.statementMonth,
            periodStart,
            periodEnd,
            dueDate,
            expenseAbs: String(row.expenseAbs),
            income: String(row.income),
            paid: String(row.paid),
            rawBill: String(row.rawBill),
            effectiveBill: String(row.effectiveBill),
            cumulativeRemain: String(row.cumulativeRemain),
            cumulativeOverpaid: String(row.cumulativeOverpaid),
            isCurrentCycle,
            isLocked,
            lockSource,
          },
          update: {
            periodStart,
            periodEnd,
            dueDate,
            expenseAbs: String(row.expenseAbs),
            income: String(row.income),
            paid: String(row.paid),
            rawBill: String(row.rawBill),
            effectiveBill: String(row.effectiveBill),
            cumulativeRemain: String(row.cumulativeRemain),
            cumulativeOverpaid: String(row.cumulativeOverpaid),
            isCurrentCycle,
            isLocked,
            lockSource,
          },
        });
      }
    }, { maxWait: 10_000, timeout: 60_000 });
  }

  const billSummariesWithCumulative = mergeCreditBillSummariesWithCascade(
    billSummaries,
    effectiveBillByMonth,
    cumulativeByMonth,
  );
  const displayBillRows = billSummariesWithCumulative
    .filter((s) => hideZeroBills ? !(s.expenseAbs === 0 && s.income === 0 && s.bill === 0 && s.paid === 0 && !s.isCurrentCycle) : true)
    .filter((s) => hideSettledBills ? !isCreditBillSettled(s) : true);

  const billListPageSize = 12;
  const totalPages = Math.ceil(displayBillRows.length / billListPageSize);
  const currentPage = Math.min(billPage, totalPages || 1);
  const creditBillSummaryRows: CreditBillSummaryRow[] = displayBillRows.map((s) => ({
    month: s.month,
    periodStart: ymdUtc(s.start),
    periodEnd: ymdUtc(s.end),
    dueDate: s.due ? ymdUtc(s.due) : "",
    periodLabel: `${mdUtcDots(s.start)} ~ ${mdUtcDots(s.end)}`,
    dueLabel: s.due ? ymdUtc(s.due) : "-",
    expenseAbs: s.expenseAbs,
    income: s.income,
    paid: s.paid,
    effectiveBill: s.effectiveBill,
    isCurrentCycle: s.isCurrentCycle,
    hasOverride: billOverrides.some((o) => o.statementMonth === s.month),
    statementInstallmentPrincipal: statementInstallmentPrincipalByMonth.get(s.month) ?? null,
  }));

  const creditBillMonth = creditCardBill?.statementMonth ?? "";
  const selectedCreditBillMonth = showAllCreditBillDetails ? "" : (selectedBillMonth || creditBillMonth);
  const creditBillBalanceValue = (() => {
    if (!currentStatementMonth) return (creditCardBill?.remain ?? 0) - (creditCardBill?.overpaid ?? 0);
    const effective = effectiveBillByMonth.get(currentStatementMonth);
    if (effective !== undefined) return effective;
    const cum = cumulativeByMonth.get(currentStatementMonth);
    if (cum) return cum.cumulativeRemain - cum.cumulativeOverpaid;
    return (creditCardBill?.remain ?? 0) - (creditCardBill?.overpaid ?? 0);
  })();

  const creditCardBillDetails =
    view === "bill" && !showAllCreditBillDetails && creditCardBill && isBillAccount
      ? await (async () => {
          const { start, end } = creditCardBill;
          const cycleMatch = {
            type: { in: [TransactionType.expense, TransactionType.income, TransactionType.transfer, TransactionType.investment] },
            deletedAt: null,
            ...creditBillDateRangeWhere(start, addDaysUtc(end, 1)),
          };
          const cycleEntries = await prisma.txRecord.findMany({
            where: {
              AND: [cycleMatch, ...(billScope ? [billScope] : [])],
            },
            include: {
              EntryTag: { include: { Tag: true } },
              Attachment: { select: { id: true, name: true, mimeType: true, url: true } },
              ...entryBusinessLinkSummaryInclude,
              account: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
              toAccount: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
            },
            orderBy: [{ date: "desc" }, { createdAt: "desc" }],
            take: 500,
          });
          const details: DetailEntry[] = cycleEntries.map((e) => ({
            id: e.id,
            date: toYmdOrNull(e.date) ?? "",
            postedAt: toDateOnlyLocalOrNull(e.postedAt),
            createdAt: toIsoOrNull(e.createdAt),
            dayOrder: e.dayOrder ?? 0,
            amount: toNumber(e.type === TransactionType.transfer && billAccountIdSet.has(e.toAccountId ?? "") ? Math.abs(toNumber(e.amount)) : e.amount),
            currency: e.currency ?? "CNY",
            runningBalance: null,
            type: e.type,
            categoryId: e.categoryId,
            categoryName:
              e.type === TransactionType.expense || e.type === TransactionType.income
                ? e.categoryId
                  ? categoryLabels.get(e.categoryId) ?? e.categoryName ?? t("txForm.uncategorized")
                  : e.categoryName ?? t("txForm.uncategorized")
                : isCreditCardRepaymentForDisplay(e)
                  ? t("transaction.category.creditCardRepayment")
                  : e.categoryName,
            accountId: e.accountId,
            accountName: e.accountName,
            accountKind: e.account?.kind ?? null,
            accountDebtDirection: e.account?.debtDirection ?? null,
            accountIsSettlementDebt: isSettlementDebtAccountId(e.accountId),
            counterpartyInstitutionId: e.counterpartyInstitutionId ?? null,
            counterpartyInstitutionName: e.counterpartyInstitutionName ?? null,
            toAccountId: e.toAccountId,
            toAccountName: e.toAccountName,
            toAccountKind: e.toAccount?.kind ?? null,
            toAccountDebtDirection: e.toAccount?.debtDirection ?? null,
            toAccountIsSettlementDebt: isSettlementDebtAccountId(e.toAccountId),
            note: e.note,
            toNote: e.toNote,
            fundSubtype: e.fundSubtype,
            fundCode: e.fundCode,
            fundName: e.fundName,
            wealthProductId: e.wealthProductId ?? null,
            source: e.source,
            insuranceProductId: e.insuranceProductId ?? null,
            debtPrincipalAmount: e.debtPrincipalAmount != null ? toNumber(e.debtPrincipalAmount) : null,
            debtInterestAmount: e.debtInterestAmount != null ? toNumber(e.debtInterestAmount) : null,
            debtFeeAmount: e.debtFeeAmount != null ? toNumber(e.debtFeeAmount) : null,
            depositAnnualRate: e.depositAnnualRate != null ? toNumber(e.depositAnnualRate) : null,
            depositInterest: e.depositInterest != null ? toNumber(e.depositInterest) : null,
            fundProductType: e.fundProductType,
            metalTypeId: e.metalTypeId ?? null,
            metalTypeName: e.metalTypeName ?? null,
            metalUnitId: e.metalUnitId ?? null,
            metalUnitName: e.metalUnitName ?? null,
            metalQuantity: e.metalQuantity != null ? toNumber(e.metalQuantity) : null,
            metalUnitPrice: e.metalUnitPrice != null ? toNumber(e.metalUnitPrice) : null,
            metalFee: e.metalFee != null ? toNumber(e.metalFee) : null,
            fundUnits: e.fundUnits != null ? toNumber(e.fundUnits) : null,
            fundNav: e.fundNav != null ? toNumber(e.fundNav) : null,
            fundFee: e.fundFee != null ? toNumber(e.fundFee) : null,
            fundConfirmDate: toIsoOrNull(e.fundConfirmDate),
            fundArrivalDate: toIsoOrNull(e.fundArrivalDate),
            fundArrivalAmount: e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null,
            ...buildEntryBusinessLinkSummary(e),
            attachments: (e.Attachment || []).map((attachment: any) => ({
              id: attachment.id,
              name: attachment.name ?? "",
              mimeType: attachment.mimeType ?? null,
              url: attachment.url ?? `/api/v1/attachments/${encodeURIComponent(attachment.id)}`,
            })),
            entryTags: (e.EntryTag || []).map((et: any) => ({
              tagId: et.tagId,
              Tag: et.Tag ? { name: et.Tag.name, color: et.Tag.color } : null,
            })),
          }));
          return { cycleEntries, details };
        })()
      : null;

  return {
    creditCardBill,
    currentStatementMonth,
    settledBillMonth,
    lastRepayToAccountId,
    lastRepayFromAccountId,
    creditBillSummaryRows,
    selectedCreditBillMonth,
    creditBillBalanceValue,
    creditCardBillDetails,
    currentPage,
    billListPageSize,
    hasCreditBillSummaries: billSummariesWithCumulative.length > 0,
    showAllCreditBillDetails,
    billingDayRules: billingDayRuleRows,
    billingDayTxPeriod,
  };
}

export async function refreshCreditCardCycleCachesForAccountIds(params: {
  householdId: string;
  accountIds: Iterable<string | null | undefined>;
}) {
  const accountIds = Array.from(
    new Set(Array.from(params.accountIds).filter((accountId): accountId is string => Boolean(accountId))),
  );
  if (accountIds.length === 0) return 0;

  const accounts = await prisma.account.findMany({
    where: {
      id: { in: accountIds },
      householdId: params.householdId,
      kind: AccountKind.bank_credit,
      billingDay: { not: null },
    },
    select: {
      id: true,
      householdId: true,
      institutionId: true,
      kind: true,
      billingDay: true,
      repaymentDay: true,
      creditBillMode: true,
      billingDayTxPeriod: true,
    },
  });

  const refreshGroups = new Map<
    string,
    {
      selectedAccount: SelectedBillAccount;
      billAccountIds: string[];
      billStorageAccountId: string;
    }
  >();
  for (const account of accounts) {
    const billAccountIds = await getCreditBillAccountIds(prisma, account);
    const billStorageAccountId = billAccountIds[0] ?? account.id;
    if (refreshGroups.has(billStorageAccountId)) continue;
    refreshGroups.set(billStorageAccountId, {
      selectedAccount: account,
      billAccountIds,
      billStorageAccountId,
    });
  }

  for (const group of refreshGroups.values()) {
    await invalidateCreditCardCycleCacheForAccountIds(group.billAccountIds);
    await loadCreditBillPageData({
      householdId: params.householdId,
      selectedAccount: group.selectedAccount,
      isBillAccount: true,
      billAccountIds: group.billAccountIds,
      billStorageAccountId: group.billStorageAccountId,
      billMonthParam: "",
      billPage: 1,
      billMonthsLimit: 120,
      hideZeroBills: false,
      hideSettledBills: false,
      showRecentBillCycles: false,
      view: "refresh",
      t: (key) => key,
      forceCycleRefresh: true,
      categoryLabels: new Map(),
      isSettlementDebtAccountId: () => false,
      isCreditCardRepaymentForDisplay: () => false,
    });
  }

  return refreshGroups.size;
}
