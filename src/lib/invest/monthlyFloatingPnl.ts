import { AccountKind } from "@prisma/client";

import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import {
  calculateFundPositionsFromEntries,
  type FundPositionEntryLike,
} from "@/lib/fund/recalcPosition";
import { fundUnitsProfitStartDate } from "@/lib/fund/confirmDays";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import type { HouseholdContext } from "@/lib/server/household-scope";

export type SnapshotPosition = {
  fundCode: string;
  fundName: string | null;
  units: number;
  cost: number;
  nav: number | null;
  navDate: string | null;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
};

export type AccountSnapshot = {
  accountId: string;
  accountName: string;
  date: string;
  totalCost: number;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
  missingNavCodes: string[];
  positions: SnapshotPosition[];
};

export type MonthlyBuySummary = {
  amount: number;
  units: number;
  count: number;
};

export type AccountMonthlyFloatingPnl = {
  accountId: string;
  accountName: string;
  baseline: AccountSnapshot;
  end: AccountSnapshot;
  floatingPnLChange: number;
  floatingPnLRateChange: number;
  monthlyBuy: MonthlyBuySummary;
};

export type MonthlyFloatingPnlResult = {
  month: string;
  baselineDate: string;
  endDate: string;
  baselineFloatingPnL: number;
  baselineFloatingPnLRate: number;
  endFloatingPnL: number;
  endFloatingPnLRate: number;
  floatingPnLChange: number;
  floatingPnLRateChange: number;
  monthlyBuy: MonthlyBuySummary;
  accounts: AccountMonthlyFloatingPnl[];
};

type InvestmentAccount = {
  id: string;
  name: string;
  costBasisMethod: string | null;
  fundUnitsDecimals: number;
  tradingCalendar: string | null;
};

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function roundRate(value: number) {
  return Math.round(value * 1000000) / 1000000;
}

function emptyMonthlyBuySummary(): MonthlyBuySummary {
  return { amount: 0, units: 0, count: 0 };
}

function buildMonthlyBuySummary(entries: FundPositionEntryLike[], monthStart: Date, monthEnd: Date) {
  const start = ymd(monthStart);
  const end = ymd(monthEnd);
  let amount = 0;
  let units = 0;
  let count = 0;

  for (const entry of entries) {
    const subtype = entry.subtype ?? (entry.amount < 0 ? "buy" : "redeem");
    const confirmDate = entry.confirmDate ?? entry.arrivalDate;
    if (subtype !== "buy" || !confirmDate || confirmDate < start || confirmDate > end) continue;
    if (entry.source === "dividend") continue;
    amount += Math.abs(entry.amount);
    units += entry.units ?? 0;
    count += 1;
  }

  return {
    amount: roundMoney(amount),
    units: roundFundUnits(units, 6),
    count,
  } satisfies MonthlyBuySummary;
}

function toEntryLike(row: {
  id: string;
  fundCode: string | null;
  amount: unknown;
  fundFee: unknown;
  fundArrivalAmount: unknown;
  fundUnits: unknown;
  fundSubtype: string | null;
  source: string | null;
  fundConfirmDate: Date | null;
  fundArrivalDate: Date | null;
  tradingCalendar?: string | null;
}): FundPositionEntryLike {
  const amount = toNumber(row.amount);
  const fee = toNumber(row.fundFee ?? 0);
  const grossAmount = Math.abs(amount);
  const netBuyAmount = row.fundSubtype === "buy" ? Math.max(0, grossAmount - fee) : null;
  return {
    id: row.id,
    fundCode: row.fundCode,
    amount,
    fee,
    arrivalAmount: row.fundArrivalAmount != null ? toNumber(row.fundArrivalAmount) : null,
    units: row.fundUnits != null ? toNumber(row.fundUnits) : null,
    subtype: row.fundSubtype,
    source: row.source,
    isPending: row.fundSubtype === "buy_failed" || (row.fundConfirmDate == null && row.fundSubtype === "buy"),
    confirmDate: row.fundConfirmDate ? ymd(row.fundConfirmDate) : null,
    arrivalDate: row.fundArrivalDate ? ymd(row.fundArrivalDate) : null,
    unitsProfitStartDate: row.fundConfirmDate ? fundUnitsProfitStartDate(ymd(row.fundConfirmDate), row.tradingCalendar) : null,
    netBuyAmount,
    pendingBuyAmount: row.fundSubtype === "buy" ? grossAmount : null,
  };
}

async function findNavOnOrBefore(fundCodes: string[], targetDate: Date) {
  const rows = await prisma.fundNavCache.findMany({
    where: {
      fundCode: { in: fundCodes },
      navDate: { lte: targetDate },
    },
    orderBy: [{ fundCode: "asc" }, { navDate: "desc" }],
    select: { fundCode: true, navDate: true, nav: true, name: true },
  });
  const result = new Map<string, { nav: number; navDate: string; name: string | null }>();
  for (const row of rows) {
    if (result.has(row.fundCode)) continue;
    result.set(row.fundCode, {
      nav: toNumber(row.nav),
      navDate: ymd(row.navDate),
      name: row.name ?? null,
    });
  }
  return result;
}

async function buildAccountSnapshot(params: {
  account: InvestmentAccount;
  entries: FundPositionEntryLike[];
  fundNameByCode: Map<string, string>;
  date: Date;
}) {
  const fundUnitsDecimals = normalizeFundUnitsDecimals(params.account.fundUnitsDecimals);
  const entriesToDate = params.entries.filter((entry) => {
    const subtype = entry.subtype ?? (entry.amount < 0 ? "buy" : "redeem");
    const calcDate = subtype === "buy" || subtype === "dividend_reinvest"
      ? (entry.unitsProfitStartDate ?? entry.confirmDate ?? entry.arrivalDate)
      : entry.confirmDate;
    return !!calcDate && calcDate <= ymd(params.date);
  });
  const calc = calculateFundPositionsFromEntries(entriesToDate, fundUnitsDecimals, params.account.costBasisMethod);
  const fundCodes = [...calc.holdings.entries()]
    .filter(([, holding]) => holding.units > 0.0001 || holding.pendingCost > 0.01)
    .map(([fundCode]) => fundCode);
  const navByCode = fundCodes.length ? await findNavOnOrBefore(fundCodes, params.date) : new Map();

  let totalCost = 0;
  let marketValue = 0;
  const missingNavCodes: string[] = [];
  const positions: SnapshotPosition[] = [];

  for (const [fundCode, holding] of calc.holdings) {
    const units = roundFundUnits(holding.units, fundUnitsDecimals);
    const cost = roundMoney(holding.cost + holding.pendingCost);
    if (units <= 0.0001 && cost <= 0.01) continue;
    const navInfo = navByCode.get(fundCode);
    if (!navInfo && units > 0.0001) missingNavCodes.push(fundCode);
    const confirmedCost = holding.cost;
    const confirmedMarketValue = navInfo && units > 0 ? units * navInfo.nav : confirmedCost;
    const rowMarketValue = roundMoney(confirmedMarketValue + holding.pendingCost);
    const floatingPnL = roundMoney(rowMarketValue - cost);
    totalCost += cost;
    marketValue += rowMarketValue;
    positions.push({
      fundCode,
      fundName: navInfo?.name ?? params.fundNameByCode.get(fundCode) ?? null,
      units,
      cost,
      nav: navInfo?.nav ?? null,
      navDate: navInfo?.navDate ?? null,
      marketValue: rowMarketValue,
      floatingPnL,
      floatingPnLRate: cost > 0 ? roundRate(floatingPnL / cost) : 0,
    });
  }

  const roundedCost = roundMoney(totalCost);
  const roundedMarketValue = roundMoney(marketValue);
  const roundedFloatingPnL = roundMoney(roundedMarketValue - roundedCost);
  return {
    accountId: params.account.id,
    accountName: params.account.name,
    date: ymd(params.date),
    totalCost: roundedCost,
    marketValue: roundedMarketValue,
    floatingPnL: roundedFloatingPnL,
    floatingPnLRate: roundedCost > 0 ? roundRate(roundedFloatingPnL / roundedCost) : 0,
    missingNavCodes,
    positions: positions.sort((a, b) => b.marketValue - a.marketValue),
  } satisfies AccountSnapshot;
}

/**
 * Reads transaction and NAV source data, rebuilds month-start/month-end fund
 * positions, and returns the canonical monthly floating PnL view.
 */
export async function computeMonthlyFloatingPnl(params: {
  ctx: HouseholdContext;
  year: number;
  month: number;
  accountIds?: string[] | null;
}): Promise<MonthlyFloatingPnlResult> {
  const monthKey = `${params.year}-${String(params.month).padStart(2, "0")}`;
  const monthStart = new Date(Date.UTC(params.year, params.month - 1, 1));
  const monthEnd = new Date(Date.UTC(params.year, params.month, 0));
  const baselineDate = monthStart;

  const accounts = await prisma.account.findMany({
    where: {
      ...params.ctx.hidFilter,
      kind: AccountKind.investment,
      ...(params.accountIds?.length ? { id: { in: params.accountIds } } : {}),
    },
    select: { id: true, name: true, kind: true, investProductType: true, costBasisMethod: true, fundUnitsDecimals: true, tradingCalendar: true },
    orderBy: { name: "asc" },
  });
  const investmentAccounts = accounts.filter(isPureInvestmentAccount);
  const accountIds = investmentAccounts.map((account) => account.id);
  if (accountIds.length === 0) {
    return {
      month: monthKey,
      baselineDate: ymd(baselineDate),
      endDate: ymd(monthEnd),
      baselineFloatingPnL: 0,
      baselineFloatingPnLRate: 0,
      endFloatingPnL: 0,
      endFloatingPnLRate: 0,
      floatingPnLChange: 0,
      floatingPnLRateChange: 0,
      monthlyBuy: emptyMonthlyBuySummary(),
      accounts: [],
    };
  }

  const txRows = await prisma.txRecord.findMany({
    where: {
      deletedAt: null,
      fundCode: { not: null },
      OR: [{ toAccountId: { in: accountIds } }, { accountId: { in: accountIds } }],
      ...params.ctx.hidFilter,
    },
    select: {
      id: true,
      accountId: true,
      toAccountId: true,
      fundCode: true,
      fundName: true,
      amount: true,
      fundFee: true,
      fundArrivalAmount: true,
      fundUnits: true,
      fundSubtype: true,
      fundConfirmDate: true,
      fundArrivalDate: true,
      source: true,
      date: true,
      createdAt: true,
    },
    orderBy: [{ fundConfirmDate: "asc" }, { date: "asc" }, { createdAt: "asc" }],
  });

  const entriesByAccountId = new Map<string, FundPositionEntryLike[]>();
  const fundNameByCode = new Map<string, string>();
  const investmentAccountById = new Map(investmentAccounts.map((account) => [account.id, account]));
  for (const row of txRows) {
    const accountId = accountIds.includes(row.toAccountId ?? "") ? row.toAccountId! : row.accountId;
    if (!accountIds.includes(accountId)) continue;
    const account = investmentAccountById.get(accountId);
    const entry = toEntryLike({ ...row, tradingCalendar: account?.tradingCalendar ?? "cn_fund" });
    if (entry.units != null) entry.units = roundFundUnits(entry.units, 6);
    const list = entriesByAccountId.get(accountId) ?? [];
    list.push(entry);
    entriesByAccountId.set(accountId, list);
    const code = row.fundCode?.trim();
    const name = row.fundName?.trim();
    if (code && name && name !== code && !fundNameByCode.has(code)) fundNameByCode.set(code, name);
  }

  const accountResults: AccountMonthlyFloatingPnl[] = [];
  let baselineFloatingPnL = 0;
  let baselineTotalCost = 0;
  let endFloatingPnL = 0;
  let endTotalCost = 0;
  let monthlyBuyAmount = 0;
  let monthlyBuyUnits = 0;
  let monthlyBuyCount = 0;
  for (const account of investmentAccounts) {
    const entries = entriesByAccountId.get(account.id) ?? [];
    const baseline = await buildAccountSnapshot({ account, entries, fundNameByCode, date: baselineDate });
    const end = await buildAccountSnapshot({ account, entries, fundNameByCode, date: monthEnd });
    const monthlyBuy = buildMonthlyBuySummary(entries, monthStart, monthEnd);
    baselineFloatingPnL += baseline.floatingPnL;
    baselineTotalCost += baseline.totalCost;
    endFloatingPnL += end.floatingPnL;
    endTotalCost += end.totalCost;
    monthlyBuyAmount += monthlyBuy.amount;
    monthlyBuyUnits += monthlyBuy.units;
    monthlyBuyCount += monthlyBuy.count;
    accountResults.push({
      accountId: account.id,
      accountName: account.name,
      baseline,
      end,
      floatingPnLChange: roundMoney(end.floatingPnL - baseline.floatingPnL),
      floatingPnLRateChange: roundRate(end.floatingPnLRate - baseline.floatingPnLRate),
      monthlyBuy,
    });
  }

  const baselineFloatingPnLRate = baselineTotalCost > 0 ? roundRate(baselineFloatingPnL / baselineTotalCost) : 0;
  const endFloatingPnLRate = endTotalCost > 0 ? roundRate(endFloatingPnL / endTotalCost) : 0;

  return {
    month: monthKey,
    baselineDate: ymd(baselineDate),
    endDate: ymd(monthEnd),
    baselineFloatingPnL: roundMoney(baselineFloatingPnL),
    baselineFloatingPnLRate,
    endFloatingPnL: roundMoney(endFloatingPnL),
    endFloatingPnLRate,
    floatingPnLChange: roundMoney(endFloatingPnL - baselineFloatingPnL),
    floatingPnLRateChange: roundRate(endFloatingPnLRate - baselineFloatingPnLRate),
    monthlyBuy: {
      amount: roundMoney(monthlyBuyAmount),
      units: roundFundUnits(monthlyBuyUnits, 6),
      count: monthlyBuyCount,
    },
    accounts: accountResults,
  };
}
