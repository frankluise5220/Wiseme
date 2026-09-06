import { AccountKind, FundCashFlowKind, FundSubtype, PropertyTransactionAction, StockTransactionAction, TransactionType } from "@prisma/client";

import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { isTradingClosedDate, toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import {
  calculateFundPositionsFromEntries,
  type FundPositionEntryLike,
} from "@/lib/fund/recalcPosition";
import { fundUnitsProfitStartDate } from "@/lib/fund/confirmDays";
import { allocateBuyFailedRefunds } from "@/lib/fund/refund-link";
import { normalizeFundUnitsDecimals } from "@/lib/fund/unit-precision";
import { fundNavTargetDateForOffset, fundTradingCalendarForName, getFundNavDateOffsets, getFundProfiles } from "@/lib/fund/fundProfile";
import { translate } from "@/lib/i18n-core";
import type { DisplayLanguage } from "@/lib/client/appPreferences";
import { loadFundStatisticSourceEntries, loadWealthStatisticSourceEntries } from "@/lib/server/investment-statistic-sources";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { isStockCashInAction, isStockCashOutAction, stockCashAmount, totalStockFee } from "@/lib/stock/cashFlow";
import { getInvestmentStatisticItems, type InvestmentStatisticEntryLike } from "@/lib/transaction-statistics";

export type InvestmentProfitPeriod = "day" | "month" | "year";
export type InvestmentProfitKind = "fund" | "stock" | "wealth" | "deposit" | "fixedAsset";

export type InvestmentProfitReportRow = {
  key: string;
  label: string;
  subLabel: string;
  fundProfit: number;
  stockProfit: number;
  wealthProfit: number;
  depositProfit: number;
  fixedAssetProfit: number;
  totalProfit: number;
  count: number;
};

export type InvestmentProfitMissingNav = {
  fundCode: string;
  date: string;
  accountId: string;
  accountName: string;
};

type ProfitEvent = {
  date: Date;
  kind: InvestmentProfitKind;
  profit: number;
};

type FundValuationMode = "profit" | "daily_nav_delta";

type Bucket = {
  key: string;
  label: string;
  subLabel: string;
  start: Date;
  end: Date;
};

type FundLikeAccount = {
  id: string;
  name: string;
  investProductType: string | null;
  costBasisMethod: string | null;
  fundUnitsDecimals: number;
  tradingCalendar: string | null;
};

type FundTxRow = {
  id: string;
  accountId: string;
  toAccountId: string | null;
  fundCode: string | null;
  fundName: string | null;
  amount: unknown;
  fundFee: unknown;
  fundArrivalAmount: unknown;
  fundUnits: unknown;
  fundSubtype: string | null;
  fundConfirmDate: Date | null;
  fundArrivalDate: Date | null;
  fundSourceEntryId: string | null;
  source: string | null;
  createdAt: Date;
  date: Date;
};

type FundBusinessTxRow = {
  id: string;
  fundAccountId: string;
  cashAccountId: string | null;
  cashEntryId: string | null;
  fundCode: string;
  fundName: string | null;
  fundSubtype: string;
  source: string | null;
  applyDate: Date;
  confirmDate: Date | null;
  arrivalDate: Date | null;
  grossAmount: unknown;
  arrivalAmount: unknown;
  fee: unknown;
  units: unknown;
  realizedProfit: unknown;
  createdAt: Date;
  cashFlows: Array<{
    txRecordId: string;
    kind: FundCashFlowKind | string;
    amount: unknown;
    flowDate: Date;
    accountId: string | null;
    createdAt: Date;
  }>;
};

type StockAccount = {
  id: string;
  name: string;
  investProductType: string | null;
};

type StockTxRow = {
  id: string;
  stockAccountId: string;
  securityId: string | null;
  market: string;
  stockCode: string;
  stockName: string | null;
  action: StockTransactionAction;
  tradeDate: Date;
  grossAmount: unknown;
  netAmount: unknown;
  quantity: unknown;
  fee: unknown;
  commission: unknown;
  stampTax: unknown;
  transferFee: unknown;
  exchangeFee: unknown;
  regulatoryFee: unknown;
  otherFee: unknown;
  createdAt: Date;
};

type StockPositionState = {
  market: string;
  stockCode: string;
  quantity: number;
  cost: number;
};

type PropertyTxRow = {
  id: string;
  accountId: string;
  cashEntryId: string | null;
  action: PropertyTransactionAction;
  tradeDate: Date;
  settlementDate: Date | null;
  realizedProfit: unknown | null;
  createdAt: Date;
  EntryBusinessLink: Array<{ cashEntryId: string | null }>;
};

/**
 * Per-fund NAV publication model, used to decide when a missing same-day NAV
 * is worth flagging:
 * - Money funds keep a constant unit NAV of 1; their cached "nav" is the
 *   per-10k daily yield, so a missing "NAV" row must never be flagged.
 * - Offshore funds publish NAV on their underlying market calendar with a lag,
 *   so trailing dates may legitimately have no NAV yet.
 */
type FundNavMeta = {
  isMoney: boolean;
  isQdii: boolean;
  tradingCalendar: string | null;
  calendarLocked?: boolean;
};

function fundNavMetaOf(name: string | null | undefined, tradingCalendar?: string | null): FundNavMeta {
  const value = String(name ?? "");
  const calendar = tradingCalendar ?? (value.trim() ? fundTradingCalendarForName(value) : null);
  return {
    isMoney: /\u8D27\u5E01/.test(value),
    // Offshore funds often publish on a non-CN market calendar and may lag the
    // report date. Their names may omit the literal "QDII", so use the canonical
    // fund-profile calendar inference instead of duplicating marker lists here.
    isQdii: Boolean(calendar && calendar !== "cn_fund"),
    tradingCalendar: calendar,
    calendarLocked: tradingCalendar != null,
  };
}

function mergeFundNavMeta(
  map: Map<string, FundNavMeta>,
  fundCode: string,
  name: string | null | undefined,
  tradingCalendar?: string | null,
) {
  const next = fundNavMetaOf(name, tradingCalendar);
  const current = map.get(fundCode);
  const calendarLocked = Boolean(current?.calendarLocked || next.calendarLocked);
  const finalCalendar = current?.calendarLocked && !next.calendarLocked
    ? current.tradingCalendar
    : next.calendarLocked
      ? next.tradingCalendar
      : next.tradingCalendar && next.tradingCalendar !== "cn_fund"
        ? next.tradingCalendar
        : current?.tradingCalendar ?? next.tradingCalendar ?? null;
  map.set(fundCode, {
    isMoney: Boolean(current?.isMoney || next.isMoney),
    isQdii: Boolean(finalCalendar && finalCalendar !== "cn_fund"),
    tradingCalendar: finalCalendar,
    calendarLocked,
  });
}

function fundValuationCalendar(account: FundLikeAccount, meta: FundNavMeta) {
  return meta.tradingCalendar && meta.tradingCalendar !== "cn_fund"
    ? meta.tradingCalendar
    : (account.tradingCalendar ?? "cn_fund");
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function utcDay(year: number, monthIndex: number, day: number) {
  return new Date(Date.UTC(year, monthIndex, day));
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function endOfMonth(year: number, month: number) {
  return utcDay(year, month, 0);
}

function monthLabel(language: DisplayLanguage, month: number) {
  return translate(language, "investmentProfitReport.monthLabel", { month });
}

function productKindOf(entry: InvestmentStatisticEntryLike): InvestmentProfitKind {
  if (entry.fundProductType === "stock") return "stock";
  if (entry.fundProductType === "property") return "fixedAsset";
  if (entry.fundProductType === "wealth") return "wealth";
  if (entry.fundProductType === "deposit") return "deposit";
  return "fund";
}

function createRow(bucket: Pick<Bucket, "key" | "label" | "subLabel">): InvestmentProfitReportRow {
  return {
    key: bucket.key,
    label: bucket.label,
    subLabel: bucket.subLabel,
    fundProfit: 0,
    stockProfit: 0,
    wealthProfit: 0,
    depositProfit: 0,
    fixedAssetProfit: 0,
    totalProfit: 0,
    count: 0,
  };
}

function addProfit(row: InvestmentProfitReportRow, kind: InvestmentProfitKind, profit: number, count = 1) {
  if (profit === 0) return;
  if (kind === "stock") row.stockProfit += profit;
  else if (kind === "wealth") row.wealthProfit += profit;
  else if (kind === "deposit") row.depositProfit += profit;
  else if (kind === "fixedAsset") row.fixedAssetProfit += profit;
  else row.fundProfit += profit;
  row.totalProfit += profit;
  row.count += count;
}

function eventBucketKey(date: Date, period: InvestmentProfitPeriod) {
  const key = ymd(date);
  if (period === "day") return key;
  if (period === "month") return key.slice(0, 7);
  return key.slice(0, 4);
}

function eventsFromEntry(
  entry: InvestmentStatisticEntryLike & { date: Date; source?: string | null },
  kindOverride?: InvestmentProfitKind,
) {
  if (entry.source === "insurance") return [];
  const kind = kindOverride ?? productKindOf(entry);
  return getInvestmentStatisticItems(entry).map((item): ProfitEvent => ({
    date: entry.date,
    kind,
    profit: item.type === "income" ? item.amount : -item.amount,
  }));
}

function propertyCashEntryIds(row: PropertyTxRow) {
  return Array.from(new Set([
    row.cashEntryId,
    ...row.EntryBusinessLink.map((link) => link.cashEntryId),
  ].filter(Boolean) as string[]));
}

function propertyProfitDate(row: PropertyTxRow) {
  return row.settlementDate ?? row.tradeDate;
}

function buildBuckets(
  period: InvestmentProfitPeriod,
  year: number,
  month: number,
  currentYear: number,
  firstYear: number,
  language: DisplayLanguage,
) {
  if (period === "day") {
    return Array.from({ length: daysInMonth(year, month) }, (_, index): Bucket => {
      const day = index + 1;
      const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const date = utcDay(year, month - 1, day);
      return {
        key,
        label: translate(language, "investmentProfitReport.dayLabel", { day }),
        subLabel: key,
        start: date,
        end: date,
      };
    });
  }

  if (period === "month") {
    return Array.from({ length: 12 }, (_, index): Bucket => {
      const m = index + 1;
      const key = `${year}-${String(m).padStart(2, "0")}`;
      return {
        key,
        label: monthLabel(language, m),
        subLabel: translate(language, "investmentProfitReport.monthSubLabel", { year, month: m }),
        start: utcDay(year, m - 1, 1),
        end: endOfMonth(year, m),
      };
    });
  }

  return Array.from({ length: currentYear - firstYear + 1 }, (_, index): Bucket => {
    const rowYear = firstYear + index;
    return {
      key: String(rowYear),
      label: translate(language, "investmentProfitReport.yearLabel", { year: rowYear }),
      subLabel: "",
      start: utcDay(rowYear, 0, 1),
      end: utcDay(rowYear, 11, 31),
    };
  });
}

function periodStart(period: InvestmentProfitPeriod, year: number, month: number, firstYear: number) {
  if (period === "day") return utcDay(year, month - 1, 1);
  if (period === "month") return utcDay(year, 0, 1);
  return utcDay(firstYear, 0, 1);
}

function periodEndExclusive(period: InvestmentProfitPeriod, year: number, month: number, currentYear: number) {
  if (period === "day") return utcDay(year, month, 1);
  if (period === "month") return utcDay(year + 1, 0, 1);
  return utcDay(currentYear + 1, 0, 1);
}

function baselineDateFor(period: InvestmentProfitPeriod, year: number, month: number, firstYear: number) {
  if (period === "day") return utcDay(year, month - 1, 0);
  if (period === "month") return utcDay(year, 0, 0);
  return utcDay(firstYear, 0, 0);
}

function calcDateOf(entry: FundPositionEntryLike) {
  const subtype = entry.subtype ?? (entry.amount < 0 ? "buy" : "redeem");
  return subtype === "buy" || subtype === "dividend_reinvest"
    ? (entry.confirmDate ?? entry.arrivalDate ?? "")
    : (entry.confirmDate ?? entry.arrivalDate ?? "");
}

function profitStartDateOf(entry: FundPositionEntryLike) {
  const subtype = entry.subtype ?? (entry.amount < 0 ? "buy" : "redeem");
  return subtype === "buy" || subtype === "dividend_reinvest"
    ? (entry.unitsProfitStartDate ?? calcDateOf(entry))
    : calcDateOf(entry);
}

function toFundEntry(row: FundTxRow, refundAmountByBuyId: Map<string, number>): FundPositionEntryLike {
  const amount = toNumber(row.amount);
  const subtype = row.fundSubtype ?? (amount < 0 ? FundSubtype.buy : FundSubtype.redeem);
  const fee = toNumber(row.fundFee ?? 0);
  const grossAfterRefund = subtype === FundSubtype.buy
    ? Math.max(0, Math.abs(amount) - (refundAmountByBuyId.get(row.id) ?? 0))
    : null;
  const netBuyAmount = subtype === FundSubtype.buy
    ? grossAfterRefund
    : null;
  return {
    id: row.id,
    fundCode: row.fundCode,
    amount,
    fee,
    arrivalAmount: row.fundArrivalAmount != null ? toNumber(row.fundArrivalAmount) : null,
    units: row.fundUnits != null ? toNumber(row.fundUnits) : null,
    subtype,
    source: row.source,
    isPending: subtype === FundSubtype.buy_failed || (row.fundConfirmDate == null && subtype === FundSubtype.buy),
    confirmDate: row.fundConfirmDate ? ymd(row.fundConfirmDate) : null,
    arrivalDate: row.fundArrivalDate ? ymd(row.fundArrivalDate) : null,
    netBuyAmount,
    pendingBuyAmount: grossAfterRefund,
  };
}

function cashFlowForReturn(entry: FundPositionEntryLike) {
  const subtype = entry.subtype ?? (entry.amount < 0 ? "buy" : "redeem");
  if (subtype === "buy_failed") return { cashIn: 0, cashOut: 0 };
  if (subtype === "buy" && entry.source !== "dividend") {
    return { cashIn: Math.max(0, toNumber(entry.pendingBuyAmount ?? entry.amount)), cashOut: 0 };
  }
  if (subtype === "redeem" || subtype === "switch_out" || subtype === "dividend_cash") {
    return { cashIn: 0, cashOut: Math.abs(entry.arrivalAmount ?? entry.amount) };
  }
  return { cashIn: 0, cashOut: 0 };
}

function isFundCashReceiptSubtype(subtype: string | null | undefined) {
  return subtype === FundSubtype.redeem || subtype === FundSubtype.switch_out || subtype === FundSubtype.dividend_cash;
}

function fundBusinessTxToReportRows(row: FundBusinessTxRow): FundTxRow[] {
  const cashReceipt = isFundCashReceiptSubtype(row.fundSubtype);
  const amount = row.fundSubtype === FundSubtype.buy || row.fundSubtype === FundSubtype.switch_in
    ? -Math.abs(toNumber(row.grossAmount))
    : Math.abs(toNumber(row.arrivalAmount ?? row.grossAmount));
  const mainId = row.cashEntryId ?? row.id;
  const main: FundTxRow = {
    id: mainId,
    accountId: cashReceipt ? row.fundAccountId : (row.cashAccountId ?? row.fundAccountId),
    toAccountId: cashReceipt ? row.cashAccountId : row.fundAccountId,
    fundCode: row.fundCode,
    fundName: row.fundName,
    amount,
    fundFee: row.fee,
    fundArrivalAmount: row.arrivalAmount,
    fundUnits: row.units,
    fundSubtype: row.fundSubtype,
    fundConfirmDate: row.confirmDate,
    fundArrivalDate: row.arrivalDate,
    fundSourceEntryId: null,
    source: row.source,
    createdAt: row.createdAt,
    date: row.applyDate,
  };
  const refunds = row.cashFlows
    .filter((flow) => flow.kind === FundCashFlowKind.refund_in)
    .map((flow): FundTxRow => ({
      id: flow.txRecordId,
      accountId: row.fundAccountId,
      toAccountId: flow.accountId ?? row.cashAccountId,
      fundCode: row.fundCode,
      fundName: row.fundName,
      amount: Math.abs(toNumber(flow.amount)),
      fundFee: null,
      fundArrivalAmount: flow.amount,
      fundUnits: null,
      fundSubtype: FundSubtype.buy_failed,
      fundConfirmDate: row.applyDate,
      fundArrivalDate: flow.flowDate,
      fundSourceEntryId: mainId,
      source: "regular_invest_refund",
      createdAt: flow.createdAt,
      date: flow.flowDate,
    }));
  return [main, ...refunds];
}

function latestNavOnOrBefore(
  navByCode: Map<string, Array<{ date: string; nav: number }>>,
  fundCode: string,
  date: string,
) {
  const rows = navByCode.get(fundCode);
  if (!rows?.length) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.date <= date) return row.nav;
  }
  return null;
}
function exactNavOnDate(
  navByCode: Map<string, Array<{ date: string; nav: number }>>,
  fundCode: string,
  date: string,
) {
  return navByCode.get(fundCode)?.find((row) => row.date === date)?.nav ?? null;
}

function hasNavAfterDate(
  navByCode: Map<string, Array<{ date: string; nav: number }>>,
  fundCode: string,
  date: string,
) {
  const rows = navByCode.get(fundCode);
  if (!rows?.length) return false;
  return rows[rows.length - 1]!.date > date;
}

function shouldRequireExactNav(
  dateKey: string,
  todayKey: string,
  tradingCalendar: string | null | undefined,
  meta: FundNavMeta,
  hasLaterNav: boolean,
) {
  if (dateKey >= todayKey) return false;
  if (isTradingClosedDate(dateKey, tradingCalendar ?? "cn_fund")) return false;
  // Offshore NAVs publish after the relevant market trading day. Only flag a
  // missing date once the fund has published NAVs dated after it (a genuine
  // mid-history gap); trailing dates may simply not be published yet.
  if (meta.isQdii || tradingCalendar !== "cn_fund") return hasLaterNav;
  return true;
}

function addMissingNav(
  missingNavByKey: Map<string, InvestmentProfitMissingNav>,
  item: InvestmentProfitMissingNav,
  tradingCalendar?: string | null,
) {
  if (isTradingClosedDate(item.date, tradingCalendar ?? "cn_fund")) return;
  const key = `${item.fundCode}|${item.date}`;
  if (!missingNavByKey.has(key)) missingNavByKey.set(key, item);
}

function accountMarketValueAt(params: {
  account: FundLikeAccount;
  entries: FundPositionEntryLike[];
  navByCode: Map<string, Array<{ date: string; nav: number }>>;
  fundMetaByCode: Map<string, FundNavMeta>;
  date: Date;
  todayKey: string;
  missingNavByKey: Map<string, InvestmentProfitMissingNav>;
}): { marketValue: number; moneyIncome: number } {
  const dateKey = ymd(params.date);
  const entriesToDate = params.entries.filter((entry) => {
    const calcDate = profitStartDateOf(entry);
    return !!calcDate && calcDate <= dateKey;
  });
  const calc = calculateFundPositionsFromEntries(
    entriesToDate,
    normalizeFundUnitsDecimals(params.account.fundUnitsDecimals),
    params.account.costBasisMethod,
  );

  let marketValue = 0;
  let moneyIncome = 0;
  for (const [fundCode, holding] of calc.holdings) {
    const units = holding.units;
    const pending = holding.pendingCost;
    const confirmedCost = holding.cost;
    if (units <= 0.0001 && pending <= 0.01) continue;
    const meta = params.fundMetaByCode.get(fundCode) ?? { isMoney: false, isQdii: false, tradingCalendar: null };
    const calendar = fundValuationCalendar(params.account, meta);

    if (meta.isMoney) {
      // Money funds keep a constant unit NAV of 1. The cached nav is the
      // per-10k daily yield when below 1, so market value is always
      // units x 1 and the yield is counted as same-day income.
      marketValue += units * 1 + pending;
      const exactNav = exactNavOnDate(params.navByCode, fundCode, dateKey);
      if (exactNav != null && exactNav < 1 && units > 0) {
        moneyIncome += (exactNav * units) / 10000;
      }
      continue;
    }

    const exactNav = exactNavOnDate(params.navByCode, fundCode, dateKey);
    if (units > 0 && exactNav == null && shouldRequireExactNav(dateKey, params.todayKey, calendar, meta, hasNavAfterDate(params.navByCode, fundCode, dateKey))) {
      addMissingNav(params.missingNavByKey, {
        fundCode,
        date: dateKey,
        accountId: params.account.id,
        accountName: params.account.name,
      }, calendar);
    }
    const nav = exactNav ?? latestNavOnOrBefore(params.navByCode, fundCode, dateKey);
    const confirmedMarketValue = nav != null && units > 0 ? units * nav : confirmedCost;
    marketValue += confirmedMarketValue + pending;
  }
  return {
    marketValue: roundMoney(marketValue),
    moneyIncome,
  };
}

function navRowIndexOnOrBefore(
  rows: Array<{ date: string; nav: number }>,
  dateKey: string,
) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]!.date <= dateKey) return index;
  }
  return -1;
}

function accountDailyNavDeltaProfit(params: {
  account: FundLikeAccount;
  entries: FundPositionEntryLike[];
  navByCode: Map<string, Array<{ date: string; nav: number }>>;
  fundMetaByCode: Map<string, FundNavMeta>;
  navDateOffsetByCode?: Map<string, number>;
  date: Date;
  todayKey: string;
  missingNavByKey: Map<string, InvestmentProfitMissingNav>;
}) {
  const reportDateKey = ymd(params.date);
  // Future report dates must not reuse the latest historical NAV and create
  // a duplicated profit row before that date has actually occurred.
  if (reportDateKey > params.todayKey) return { profit: 0, count: 0 };
  let profit = 0;
  let count = 0;
  const fundCodes = new Set(params.entries.map((entry) => entry.fundCode).filter(Boolean) as string[]);
  for (const fundCode of fundCodes) {
    const meta = params.fundMetaByCode.get(fundCode) ?? { isMoney: false, isQdii: false, tradingCalendar: null };
    const navRows = params.navByCode.get(fundCode) ?? [];
    const calendar = fundValuationCalendar(params.account, meta);
    if (isTradingClosedDate(reportDateKey, calendar)) continue;
    const dateKey = fundNavTargetDateForOffset({
      referenceDate: params.date,
      navDateOffset: params.navDateOffsetByCode?.get(fundCode) ?? 0,
      tradingCalendar: calendar,
    });
    const currentIndex = navRowIndexOnOrBefore(navRows, dateKey);
    if (currentIndex < 1) continue;
    const currentRow = navRows[currentIndex]!;
    const previousRow = navRows[currentIndex - 1]!;
    const hasExactNav = currentRow.date === dateKey;
    const hasLaterNav = hasNavAfterDate(params.navByCode, fundCode, dateKey);
    if (!hasExactNav && shouldRequireExactNav(dateKey, params.todayKey, calendar, meta, hasLaterNav)) {
      addMissingNav(params.missingNavByKey, {
        fundCode,
        date: dateKey,
        accountId: params.account.id,
        accountName: params.account.name,
      }, calendar);
    }
    const entriesToPositionDate = params.entries.filter((entry) => {
      const calcDate = profitStartDateOf(entry);
      return entry.fundCode === fundCode && !!calcDate && calcDate <= currentRow.date;
    });
    const calc = calculateFundPositionsFromEntries(
      entriesToPositionDate,
      normalizeFundUnitsDecimals(params.account.fundUnitsDecimals),
      params.account.costBasisMethod,
    );
    const units = calc.holdings.get(fundCode)?.units ?? 0;
    if (units <= 0.0001) continue;
    if (meta.isMoney) {
      if (currentRow.nav < 1) {
        profit += (currentRow.nav * units) / 10000;
        count += 1;
      }
      continue;
    }
    const fundProfit = units * (currentRow.nav - previousRow.nav);
    if (fundProfit !== 0) count += 1;
    profit += fundProfit;
  }
  return { profit: roundMoney(profit), count };
}
function bucketDailyNavDeltaProfit(params: {
  bucket: Bucket;
  accounts: FundLikeAccount[];
  entriesByAccountId: Map<string, FundPositionEntryLike[]>;
  navByCode: Map<string, Array<{ date: string; nav: number }>>;
  fundMetaByCode: Map<string, FundNavMeta>;
  navDateOffsetByCode: Map<string, number>;
  todayKey: string;
  missingNavByKey: Map<string, InvestmentProfitMissingNav>;
}) {
  let profit = 0;
  let count = 0;
  for (
    let date = new Date(params.bucket.start);
    date <= params.bucket.end;
    date.setUTCDate(date.getUTCDate() + 1)
  ) {
    for (const account of params.accounts) {
      const result = accountDailyNavDeltaProfit({
        account,
        entries: params.entriesByAccountId.get(account.id) ?? [],
        navByCode: params.navByCode,
        fundMetaByCode: params.fundMetaByCode,
        navDateOffsetByCode: params.navDateOffsetByCode,
        date,
        todayKey: params.todayKey,
        missingNavByKey: params.missingNavByKey,
      });
      profit += result.profit;
      count += result.count;
    }
  }
  return { profit: roundMoney(profit), count };
}

function bucketCashFlows(params: {
  entries: FundPositionEntryLike[];
  start: Date;
  end: Date;
}) {
  const start = ymd(params.start);
  const end = ymd(params.end);
  let cashIn = 0;
  let cashOut = 0;
  for (const entry of params.entries) {
    const calcDate = profitStartDateOf(entry);
    if (!calcDate || calcDate < start || calcDate > end) continue;
    const flow = cashFlowForReturn(entry);
    cashIn += flow.cashIn;
    cashOut += flow.cashOut;
  }
  return { cashIn, cashOut };
}

function roundQuantity(value: number) {
  return Math.max(0, Math.round(value * 1_000_000) / 1_000_000);
}

function roundNonNegativeMoney(value: number) {
  return Math.max(0, roundMoney(value));
}

function stockPriceKey(market: string, stockCode: string) {
  return `${market}:${stockCode}`;
}

function stockClosePriceOnOrBefore(
  priceByKey: Map<string, Array<{ date: string; price: number }>>,
  key: string,
  dateKey: string,
) {
  const rows = priceByKey.get(key);
  if (!rows?.length) return null;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.date <= dateKey) return row.price;
  }
  return null;
}

function applyStockTxToPosition(positions: Map<string, StockPositionState>, row: StockTxRow) {
  const market = row.market.trim();
  const stockCode = row.stockCode.trim();
  if (!market || !stockCode) return;
  const key = stockPriceKey(market, stockCode);
  const quantity = Math.abs(toNumber(row.quantity));
  const grossAmount = Math.abs(toNumber(row.grossAmount));
  const fee = totalStockFee(row);
  const current = positions.get(key) ?? {
    market,
    stockCode,
    quantity: 0,
    cost: 0,
  };

  if (row.action === StockTransactionAction.buy) {
    current.quantity = roundQuantity(current.quantity + quantity);
    current.cost = roundNonNegativeMoney(current.cost + grossAmount + fee);
  } else if (row.action === StockTransactionAction.sell) {
    const soldQuantity = quantity > 0 ? Math.min(current.quantity, quantity) : 0;
    const avgCost = current.quantity > 0 ? current.cost / current.quantity : 0;
    current.quantity = roundQuantity(current.quantity - soldQuantity);
    current.cost = roundNonNegativeMoney(current.cost - avgCost * soldQuantity);
  } else if (row.action === StockTransactionAction.bonus_share || row.action === StockTransactionAction.split_share) {
    current.quantity = roundQuantity(current.quantity + quantity);
  } else if (row.action === StockTransactionAction.merge_share) {
    current.quantity = roundQuantity(current.quantity - quantity);
  }

  current.market = market;
  current.stockCode = stockCode;
  positions.set(key, current);
}

function stockMarketValueAt(params: {
  txRows: StockTxRow[];
  priceByKey: Map<string, Array<{ date: string; price: number }>>;
  date: Date;
}) {
  const dateKey = ymd(params.date);
  const positions = new Map<string, StockPositionState>();
  for (const row of params.txRows) {
    if (ymd(row.tradeDate) > dateKey) continue;
    applyStockTxToPosition(positions, row);
  }

  let marketValue = 0;
  let positionCount = 0;
  for (const [key, position] of positions) {
    if (position.quantity <= 0.000001 && position.cost <= 0.01) continue;
    const closePrice = stockClosePriceOnOrBefore(params.priceByKey, key, dateKey);
    const positionValue = position.quantity > 0 && closePrice != null
      ? position.quantity * closePrice
      : position.cost;
    if (Math.abs(positionValue) > 0.005) {
      marketValue += positionValue;
      positionCount += 1;
    }
  }

  return {
    marketValue: roundMoney(marketValue),
    positionCount,
  };
}

function stockCashFlows(params: {
  txRows: StockTxRow[];
  start: Date;
  end: Date;
}) {
  const start = ymd(params.start);
  const end = ymd(params.end);
  let cashIn = 0;
  let cashOut = 0;
  let count = 0;
  for (const row of params.txRows) {
    const tradeDate = ymd(row.tradeDate);
    if (tradeDate < start || tradeDate > end) continue;
    const amount = Math.abs(stockCashAmount(row));
    if (amount <= 0.005) continue;
    if (isStockCashInAction(row.action)) {
      cashOut += amount;
      count += 1;
    } else if (isStockCashOutAction(row.action)) {
      cashIn += amount;
      count += 1;
    }
  }
  return { cashIn, cashOut, count };
}

async function applyStockValuationProfit(params: {
  rows: Map<string, InvestmentProfitReportRow>;
  buckets: Bucket[];
  accounts: StockAccount[];
  txRows: StockTxRow[];
}) {
  if (params.accounts.length === 0 || params.txRows.length === 0 || params.buckets.length === 0) return;

  const accountIds = new Set(params.accounts.map((account) => account.id));
  const txRows = params.txRows.filter((row) => accountIds.has(row.stockAccountId) && row.stockCode.trim());
  if (txRows.length === 0) return;

  const pricePairs = new Map<string, { market: string; stockCode: string }>();
  for (const row of txRows) {
    const market = row.market.trim();
    const stockCode = row.stockCode.trim();
    if (!market || !stockCode) continue;
    const key = stockPriceKey(market, stockCode);
    if (!pricePairs.has(key)) pricePairs.set(key, { market, stockCode });
  }
  const priceFilters = Array.from(pricePairs.values());
  const maxBoundary = params.buckets[params.buckets.length - 1]!.end;
  const priceRows = priceFilters.length
    ? await prisma.stockPriceCache.findMany({
        where: {
          priceDate: { lte: maxBoundary },
          OR: priceFilters.map((pair) => ({ market: pair.market, stockCode: pair.stockCode })),
        },
        select: { market: true, stockCode: true, priceDate: true, closePrice: true },
        orderBy: [{ market: "asc" }, { stockCode: "asc" }, { priceDate: "asc" }],
      })
    : [];
  const priceByKey = new Map<string, Array<{ date: string; price: number }>>();
  for (const row of priceRows) {
    const key = stockPriceKey(row.market, row.stockCode);
    const list = priceByKey.get(key) ?? [];
    list.push({ date: ymd(row.priceDate), price: toNumber(row.closePrice) });
    priceByKey.set(key, list);
  }

  const todayKey = ymd(new Date());
  const today = new Date(`${todayKey}T00:00:00.000Z`);
  let previousSnapshot = 0;
  for (const [index, bucket] of params.buckets.entries()) {
    if (index === 0) {
      const baseline = new Date(bucket.start);
      baseline.setUTCDate(baseline.getUTCDate() - 1);
      previousSnapshot = stockMarketValueAt({ txRows, priceByKey, date: baseline }).marketValue;
    }

    if (ymd(bucket.start) > todayKey) continue;
    const effectiveEnd = bucket.end > today ? today : bucket.end;
    if (ymd(effectiveEnd) < ymd(bucket.start)) continue;

    const current = stockMarketValueAt({ txRows, priceByKey, date: effectiveEnd });
    const flow = stockCashFlows({ txRows, start: bucket.start, end: effectiveEnd });
    const profit = roundMoney(current.marketValue + flow.cashOut - flow.cashIn - previousSnapshot);
    const row = params.rows.get(bucket.key);
    if (row) addProfit(row, "stock", profit, Math.max(1, current.positionCount, flow.count));
    previousSnapshot = current.marketValue;
  }
}

function propertySpend(row: { action: PropertyTransactionAction | string; amount: unknown; fee?: unknown | null; tax?: unknown | null }) {
  if (row.action !== PropertyTransactionAction.purchase && row.action !== PropertyTransactionAction.improvement) return 0;
  return Math.abs(toNumber(row.amount)) + Math.abs(toNumber(row.fee)) + Math.abs(toNumber(row.tax));
}

function propertyRecovery(row: { action: PropertyTransactionAction | string; amount: unknown; fee?: unknown | null; tax?: unknown | null }) {
  if (row.action !== PropertyTransactionAction.sale && row.action !== PropertyTransactionAction.disposal) return 0;
  return Math.max(0, Math.abs(toNumber(row.amount)) - Math.abs(toNumber(row.fee)) - Math.abs(toNumber(row.tax)));
}

function propertyCashFlowDate(row: { tradeDate: Date; settlementDate: Date | null }) {
  return row.settlementDate ?? row.tradeDate;
}

function propertyFixedMarketValueOnOrBefore(
  valByAsset: Map<string, Array<{ date: string; marketValue: number }>>,
  assetId: string,
  dateKey: string,
) {
  const rows = valByAsset.get(assetId);
  if (!rows?.length) return 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.date <= dateKey) return row.marketValue;
  }
  return 0;
}

/**
 * Fixed-asset valuation profit follows the same snapshot-cash-flow model as
 * stocks, but the market-value curve is driven by PropertyValuation history
 * (only recorded change dates participate), while purchase/improvement spend
 * and sale/disposal recovery are cash-flow corrections:
 *
 *   profit_bucket = endMarketValue + saleRecovery - purchaseSpend - startMarketValue
 *
 * An asset that has been sold/disposed stops contributing market value from
 * its sale date onward, so the sale period already carries the realized
 * profit via `saleRecovery - startMarketValue`, matching the report's
 * floating-and-realized unified column semantics.
 */
async function applyFixedAssetValuationProfit(params: {
  rows: Map<string, InvestmentProfitReportRow>;
  buckets: Bucket[];
  householdId: string;
  accountIds: string[];
}) {
  if (params.accountIds.length === 0 || params.buckets.length === 0) return;

  const assets = await prisma.propertyAsset.findMany({
    where: { householdId: params.householdId, accountId: { in: params.accountIds }, deletedAt: null },
    select: { id: true, status: true },
  });
  if (assets.length === 0) return;
  const assetIds = assets.map((asset) => asset.id);

  const valuationRows = await prisma.propertyValuation.findMany({
    where: { propertyAssetId: { in: assetIds } },
    select: { propertyAssetId: true, valuationDate: true, marketValue: true, source: true },
    orderBy: [{ propertyAssetId: "asc" }, { valuationDate: "asc" }, { createdAt: "asc" }],
  });
  const manualValByAsset = new Map<string, Array<{ date: string; marketValue: number }>>();
  for (const row of valuationRows) {
    if (row.source !== "manual") continue;
    const list = manualValByAsset.get(row.propertyAssetId) ?? [];
    list.push({ date: ymd(row.valuationDate), marketValue: toNumber(row.marketValue) });
    manualValByAsset.set(row.propertyAssetId, list);
  }

  const txRows = await prisma.propertyTransaction.findMany({
    where: { householdId: params.householdId, accountId: { in: params.accountIds }, deletedAt: null },
    select: {
      propertyAssetId: true,
      action: true,
      tradeDate: true,
      settlementDate: true,
      amount: true,
      fee: true,
      tax: true,
    },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  // Latest disposal/sale date per asset: after it the asset no longer carries
  // market value, mirroring how a cleared stock position drops to zero.
  const disposedAfterByAsset = new Map<string, string>();
  for (const row of txRows) {
    if (row.action !== PropertyTransactionAction.sale && row.action !== PropertyTransactionAction.disposal) continue;
    const dateKey = ymd(propertyCashFlowDate(row));
    const current = disposedAfterByAsset.get(row.propertyAssetId);
    if (!current || dateKey > current) disposedAfterByAsset.set(row.propertyAssetId, dateKey);
  }

  // Market-value curve per asset = cumulative cost steps (each purchase/
  // improvement raises value by what was actually spent) overridden by manual
  // valuations. This mirrors recalcPropertyAssetsFromTransactions
  // (marketValue = manualValuation ?: cumulative cost), so a fixed asset
  // without any manual valuation holds at its cost and never books a spurious
  // loss for improvements — only manual valuations move floating P&L.
  const marketPointsByAsset = new Map<string, Array<{ date: string; marketValue: number }>>();
  const costByAsset = new Map<string, number>();
  for (const row of txRows) {
    const assetId = row.propertyAssetId;
    const spend = propertySpend(row);
    const isPurchaseOrImprovement = row.action === PropertyTransactionAction.purchase
      || row.action === PropertyTransactionAction.improvement;
    if (isPurchaseOrImprovement && spend > 0) {
      const run = (costByAsset.get(assetId) ?? 0) + spend;
      costByAsset.set(assetId, run);
      const list = marketPointsByAsset.get(assetId) ?? [];
      list.push({ date: ymd(propertyCashFlowDate(row)), marketValue: run });
      marketPointsByAsset.set(assetId, list);
    }
  }
  for (const [assetId, vals] of manualValByAsset) {
    const list = marketPointsByAsset.get(assetId) ?? [];
    for (const v of vals) {
      list.push({ date: v.date, marketValue: v.marketValue });
    }
    marketPointsByAsset.set(assetId, list);
  }
  for (const list of marketPointsByAsset.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.marketValue - b.marketValue);
  }

  const computeSnapshot = (date: Date) => {
    const dateKey = ymd(date);
    let total = 0;
    for (const asset of assets) {
      const disposedAfter = disposedAfterByAsset.get(asset.id);
      if (disposedAfter && dateKey >= disposedAfter) continue;
      total += propertyFixedMarketValueOnOrBefore(marketPointsByAsset, asset.id, dateKey);
    }
    return total;
  };

  const todayKey = ymd(new Date());
  const today = new Date(`${todayKey}T00:00:00.000Z`);
  let previousSnapshot = 0;
  for (const [index, bucket] of params.buckets.entries()) {
    if (index === 0) {
      const baseline = new Date(bucket.start);
      baseline.setUTCDate(baseline.getUTCDate() - 1);
      previousSnapshot = computeSnapshot(baseline);
    }

    if (ymd(bucket.start) > todayKey) continue;
    const effectiveEnd = bucket.end > today ? today : bucket.end;
    if (ymd(effectiveEnd) < ymd(bucket.start)) continue;

    const endTotal = computeSnapshot(effectiveEnd);
    const startKey = ymd(bucket.start);
    const endKey = ymd(effectiveEnd);
    let cashIn = 0;
    let cashOut = 0;
    let count = 0;
    for (const row of txRows) {
      const flowDate = ymd(propertyCashFlowDate(row));
      if (flowDate < startKey || flowDate > endKey) continue;
      const spend = propertySpend(row);
      const recovery = propertyRecovery(row);
      if (spend > 0) cashIn += spend;
      if (recovery > 0) {
        cashOut += recovery;
        count += 1;
      }
    }
    const profit = roundMoney(endTotal + cashOut - cashIn - previousSnapshot);
    const row = params.rows.get(bucket.key);
    if (row) addProfit(row, "fixedAsset", profit, Math.max(1, count));
    previousSnapshot = endTotal;
  }
}

async function applyFundValuationProfit(params: {
  rows: Map<string, InvestmentProfitReportRow>;
  buckets: Bucket[];
  accounts: FundLikeAccount[];
  txRows: FundTxRow[];
  valuationMode?: FundValuationMode;
}) {
  if (params.accounts.length === 0 || params.buckets.length === 0) return [];

  const snapshotAccountIds = new Set(params.accounts.map((account) => account.id));
  const snapshotAccountById = new Map(params.accounts.map((account) => [account.id, account]));
  const entriesByAccountId = new Map<string, FundPositionEntryLike[]>();
  const fundCodes = new Set<string>();
  const fundMetaByCode = new Map<string, FundNavMeta>();
  const missingNavByKey = new Map<string, InvestmentProfitMissingNav>();
  const todayKey = ymd(new Date());
  const { refundAmountByBuyId } = allocateBuyFailedRefunds(params.txRows.map((row) => ({
    id: row.id,
    date: row.date,
    createdAt: row.createdAt,
    fundConfirmDate: row.fundConfirmDate,
    fundArrivalDate: row.fundArrivalDate,
    accountId: row.accountId,
    toAccountId: row.toAccountId,
    fundCode: row.fundCode,
    fundSubtype: row.fundSubtype,
    fundUnits: row.fundUnits != null ? toNumber(row.fundUnits) : null,
    source: row.source,
    amount: toNumber(row.amount),
    fundSourceEntryId: row.fundSourceEntryId,
  })));

  for (const row of params.txRows) {
    const accountId = row.toAccountId && snapshotAccountIds.has(row.toAccountId)
      ? row.toAccountId
      : row.accountId;
    if (!snapshotAccountIds.has(accountId)) continue;
    const account = snapshotAccountById.get(accountId);
    const entry = toFundEntry(row, refundAmountByBuyId);
    if (!entry.fundCode) continue;
    if (entry.confirmDate && (entry.subtype === FundSubtype.buy || entry.subtype === FundSubtype.dividend_reinvest)) {
      entry.unitsProfitStartDate = fundUnitsProfitStartDate(entry.confirmDate, account?.tradingCalendar);
    }
    fundCodes.add(entry.fundCode);
    mergeFundNavMeta(fundMetaByCode, entry.fundCode, row.fundName);
    const entries = entriesByAccountId.get(accountId) ?? [];
    entries.push(entry);
    entriesByAccountId.set(accountId, entries);
  }

  if (fundCodes.size === 0) return [];

  const fundProfiles = await getFundProfiles(fundCodes);
  for (const profile of fundProfiles) {
    mergeFundNavMeta(fundMetaByCode, profile.fundCode, profile.fundName, profile.tradingCalendar);
  }

  const navDateOffsetByCode = params.valuationMode === "daily_nav_delta"
    ? await getFundNavDateOffsets(fundCodes)
    : new Map<string, number>();

  const maxBoundary = params.buckets[params.buckets.length - 1]!.end;
  const navRows = await prisma.fundNavCache.findMany({
    where: {
      fundCode: { in: Array.from(fundCodes) },
      navDate: { lte: maxBoundary },
    },
    select: { fundCode: true, navDate: true, nav: true, name: true },
    orderBy: [{ fundCode: "asc" }, { navDate: "asc" }],
  });
  const navByCode = new Map<string, Array<{ date: string; nav: number }>>();
  for (const navRow of navRows) {
    const list = navByCode.get(navRow.fundCode) ?? [];
    list.push({ date: ymd(navRow.navDate), nav: toNumber(navRow.nav) });
    navByCode.set(navRow.fundCode, list);
    if (navRow.name) mergeFundNavMeta(fundMetaByCode, navRow.fundCode, navRow.name);
  }

  let previousSnapshot = 0;
  for (const [index, bucket] of params.buckets.entries()) {
    if (params.valuationMode === "daily_nav_delta") {
      const daily = bucketDailyNavDeltaProfit({
        bucket,
        accounts: params.accounts,
        entriesByAccountId,
        navByCode,
        fundMetaByCode,
        navDateOffsetByCode,
        todayKey,
        missingNavByKey,
      });
      const row = params.rows.get(bucket.key);
      if (row) addProfit(row, "fund", daily.profit, daily.count);
      continue;
    }

    if (index === 0) {
      const baseline = new Date(bucket.start);
      baseline.setUTCDate(baseline.getUTCDate() - 1);
      previousSnapshot = params.accounts.reduce((sum, account) => {
        const entries = entriesByAccountId.get(account.id) ?? [];
        return sum + accountMarketValueAt({ account, entries, navByCode, fundMetaByCode, date: baseline, todayKey, missingNavByKey }).marketValue;
      }, 0);
    }

    let currentSnapshot = 0;
    let moneyIncome = 0;
    let cashIn = 0;
    let cashOut = 0;
    let contributorCount = 0;
    for (const account of params.accounts) {
      const entries = entriesByAccountId.get(account.id) ?? [];
      const current = accountMarketValueAt({ account, entries, navByCode, fundMetaByCode, date: bucket.end, todayKey, missingNavByKey });
      currentSnapshot += current.marketValue;
      moneyIncome += current.moneyIncome;
      const flow = bucketCashFlows({ entries, start: bucket.start, end: bucket.end });
      cashIn += flow.cashIn;
      cashOut += flow.cashOut;
      if (flow.cashIn !== 0 || flow.cashOut !== 0 || current.moneyIncome !== 0) contributorCount += 1;
    }

    const profit = roundMoney(currentSnapshot + cashOut - cashIn - previousSnapshot + moneyIncome);
    const row = params.rows.get(bucket.key);
    if (row) addProfit(row, "fund", profit, Math.max(1, contributorCount));
    previousSnapshot = currentSnapshot;
  }

  return Array.from(missingNavByKey.values()).sort((a, b) =>
    a.date.localeCompare(b.date) || a.fundCode.localeCompare(b.fundCode, "zh-Hans-CN"),
  );
}

function findFirstDataYear(params: {
  currentYear: number;
  txRows: FundTxRow[];
  stockTxRows: Array<{ tradeDate: Date }>;
  propertyTxRows: PropertyTxRow[];
  eventRows: Array<{ date: Date }>;
}) {
  const years = [
    ...params.txRows.map((row) => (row.fundConfirmDate ?? row.date).getUTCFullYear()),
    ...params.stockTxRows.map((row) => row.tradeDate.getUTCFullYear()),
    ...params.propertyTxRows.map((row) => propertyProfitDate(row).getUTCFullYear()),
    ...params.eventRows.map((row) => row.date.getUTCFullYear()),
  ].filter((year) => Number.isInteger(year) && year >= 1900 && year <= params.currentYear);
  return years.length ? Math.min(...years) : params.currentYear;
}

export async function loadInvestmentProfitReport(
  ctx: HouseholdContext,
  params: {
    period: InvestmentProfitPeriod;
    year: number;
    month: number;
    accountIds?: string[] | null;
    tagIds?: string[] | null;
    fundValuationMode?: FundValuationMode;
  },
  language: DisplayLanguage = "zh-CN",
) {
  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const accountIds = Array.from(new Set(params.accountIds?.filter(Boolean) ?? []));
  const tagIds = Array.from(new Set(params.tagIds?.filter(Boolean) ?? []));

  const accounts = await prisma.account.findMany({
    where: {
      ...ctx.hidFilter,
      kind: AccountKind.investment,
      ...(accountIds.length ? { id: { in: accountIds } } : {}),
    },
    select: {
      id: true,
      name: true,
      kind: true,
      investProductType: true,
      costBasisMethod: true,
      fundUnitsDecimals: true,
      tradingCalendar: true,
    },
    orderBy: { name: "asc" },
  });
  const investmentAccounts = accounts.filter(isPureInvestmentAccount);
  const investmentAccountIds = investmentAccounts.map((account) => account.id);
  const stockAccounts: StockAccount[] = investmentAccounts
    .filter((account) => account.investProductType === "stock")
    .map((account) => ({
      id: account.id,
      name: account.name,
      investProductType: account.investProductType,
    }));
  const stockAccountIds = stockAccounts.map((account) => account.id);
  const propertyAccountIds = investmentAccounts
    .filter((account) => account.investProductType === "property")
    .map((account) => account.id);
  const snapshotAccounts: FundLikeAccount[] = investmentAccounts
    .filter((account) => account.investProductType === "fund"
      || account.investProductType == null
      || account.investProductType === "money")
    .map((account) => ({
      id: account.id,
      name: account.name,
      investProductType: account.investProductType,
      costBasisMethod: account.costBasisMethod,
      fundUnitsDecimals: account.fundUnitsDecimals ?? 2,
      tradingCalendar: account.tradingCalendar ?? "cn_fund",
    }));
  const snapshotAccountIds = new Set(snapshotAccounts.map((account) => account.id));

  const maxSnapshotDate = params.period === "year"
    ? utcDay(currentYear, 11, 31)
    : params.period === "day"
      ? endOfMonth(params.year, params.month)
      : endOfMonth(params.year, 12);
  const fundBusinessRows = snapshotAccountIds.size > 0
    ? await prisma.fundTransaction.findMany({
        where: {
          householdId: ctx.householdId,
          deletedAt: null,
          fundAccountId: { in: Array.from(snapshotAccountIds) },
          applyDate: { lte: maxSnapshotDate },
        },
        include: { cashFlows: true },
        orderBy: [{ confirmDate: "asc" }, { applyDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: 50000,
      })
    : [];
  const representedTxRecordIds = new Set<string>();
  for (const row of fundBusinessRows) {
    if (row.cashEntryId) representedTxRecordIds.add(row.cashEntryId);
    for (const flow of row.cashFlows) representedTxRecordIds.add(flow.txRecordId);
  }
  const snapshotAccountFilter = snapshotAccountIds.size
    ? { OR: [{ accountId: { in: Array.from(snapshotAccountIds) } }, { toAccountId: { in: Array.from(snapshotAccountIds) } }] }
    : {};
  const legacyFundTxRows = snapshotAccountIds.size > 0
    ? (await prisma.txRecord.findMany({
        where: {
          ...ctx.hidFilter,
          deletedAt: null,
          type: TransactionType.investment,
          fundCode: { not: null },
          date: { lte: maxSnapshotDate },
          ...snapshotAccountFilter,
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
          fundSourceEntryId: true,
          source: true,
          createdAt: true,
          date: true,
        },
        orderBy: [{ fundConfirmDate: "asc" }, { date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: 50000,
      })).filter((row) => !representedTxRecordIds.has(row.id))
    : [];
  const fundTxRows = [
    ...fundBusinessRows.flatMap((row) => fundBusinessTxToReportRows(row)),
    ...legacyFundTxRows,
  ];
  const stockTxRows: StockTxRow[] = stockAccountIds.length > 0
    ? await prisma.stockTransaction.findMany({
        where: {
          householdId: ctx.householdId,
          deletedAt: null,
          stockAccountId: { in: stockAccountIds },
          tradeDate: { lte: maxSnapshotDate },
        },
        select: {
          id: true,
          stockAccountId: true,
          securityId: true,
          market: true,
          stockCode: true,
          stockName: true,
          action: true,
          tradeDate: true,
          grossAmount: true,
          netAmount: true,
          quantity: true,
          fee: true,
          commission: true,
          stampTax: true,
          transferFee: true,
          exchangeFee: true,
          regulatoryFee: true,
          otherFee: true,
          createdAt: true,
        },
        orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        take: 50000,
      })
    : [];

  const broadStart = params.period === "year" ? utcDay(1970, 0, 1) : periodStart(params.period, params.year, params.month, params.year);
  const broadEndExclusive = periodEndExclusive(params.period, params.year, params.month, currentYear);
  const eventAccountFilter = investmentAccountIds.length
    ? { OR: [{ accountId: { in: investmentAccountIds } }, { toAccountId: { in: investmentAccountIds } }] }
    : {};
  const tagFilter = tagIds.length ? { EntryTag: { some: { tagId: { in: tagIds } } } } : {};

  const propertyActions = [
    PropertyTransactionAction.purchase,
    PropertyTransactionAction.improvement,
    PropertyTransactionAction.sale,
    PropertyTransactionAction.disposal,
  ].filter((value): value is NonNullable<typeof value> => value !== undefined);
  const propertyTxRows: PropertyTxRow[] = await (async () => {
    if (propertyAccountIds.length === 0 || propertyActions.length === 0) return [];
    const rows = await prisma.propertyTransaction.findMany({
      where: {
        householdId: ctx.householdId,
        deletedAt: null,
        accountId: { in: propertyAccountIds },
        action: { in: propertyActions },
        OR: [
          { settlementDate: { gte: broadStart, lt: broadEndExclusive } },
          { settlementDate: null, tradeDate: { gte: broadStart, lt: broadEndExclusive } },
        ],
      },
      select: {
        id: true,
        accountId: true,
        cashEntryId: true,
        action: true,
        tradeDate: true,
        settlementDate: true,
        realizedProfit: true,
        createdAt: true,
        EntryBusinessLink: {
          where: { deletedAt: null },
          select: { cashEntryId: true },
        },
      },
      orderBy: [{ settlementDate: "asc" }, { tradeDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 50000,
    });
    return rows as PropertyTxRow[];
  })();
  const propertyCashEntryIdList = Array.from(new Set(propertyTxRows.flatMap((row) => propertyCashEntryIds(row))));
  const taggedPropertyCashEntryIds = tagIds.length > 0
    ? new Set(propertyCashEntryIdList.length > 0
        ? (await prisma.txRecord.findMany({
            where: {
              ...ctx.hidFilter,
              deletedAt: null,
              id: { in: propertyCashEntryIdList },
              EntryTag: { some: { tagId: { in: tagIds } } },
            },
            select: { id: true },
          })).map((row) => row.id)
        : [])
    : null;
  const scopedPropertyTxRows = taggedPropertyCashEntryIds
    ? propertyTxRows.filter((row) => propertyCashEntryIds(row).some((id) => taggedPropertyCashEntryIds.has(id)))
    : propertyTxRows;
  const propertyCashEntryIdsInScope = new Set(scopedPropertyTxRows.flatMap((row) => propertyCashEntryIds(row)));

  const txEntries = await prisma.txRecord.findMany({
    where: {
      ...ctx.hidFilter,
      deletedAt: null,
      type: TransactionType.investment,
      date: { gte: broadStart, lt: broadEndExclusive },
      ...eventAccountFilter,
      ...tagFilter,
    },
    select: {
      id: true,
      accountId: true,
      toAccountId: true,
      date: true,
      amount: true,
      source: true,
      fundSubtype: true,
      fundProductType: true,
      fundCode: true,
      fundName: true,
      realizedProfit: true,
      depositInterest: true,
      fundFee: true,
      fundUnits: true,
      fundNav: true,
    },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: 50000,
  });

  const [fundStatisticEntries, wealthEntries] = await Promise.all([
    loadFundStatisticSourceEntries(ctx, {
      start: broadStart,
      endExclusive: broadEndExclusive,
      accountIds: accountIds.length ? accountIds : undefined,
      tagIds,
    }),
    loadWealthStatisticSourceEntries(ctx, {
      start: broadStart,
      endExclusive: broadEndExclusive,
      accountIds: accountIds.length ? accountIds : undefined,
      tagIds,
    }),
  ]);
  const independentStatisticEntryIds = new Set([
    ...fundStatisticEntries.flatMap((entry) => [entry.id, entry.entryId]),
    ...wealthEntries.flatMap((entry) => [entry.id, entry.entryId]),
  ]);

  const firstYear = params.period === "year"
    ? findFirstDataYear({
        currentYear,
        txRows: fundTxRows,
        stockTxRows,
        propertyTxRows: scopedPropertyTxRows,
        eventRows: [...txEntries, ...fundStatisticEntries, ...wealthEntries],
      })
    : params.year;
  const buckets = buildBuckets(params.period, params.year, params.month, currentYear, firstYear, language);
  const rows = new Map(buckets.map((bucket) => [bucket.key, createRow(bucket)]));

  const missingNavs = await applyFundValuationProfit({
    rows,
    buckets,
    accounts: snapshotAccounts,
    txRows: fundTxRows,
    valuationMode: params.fundValuationMode,
  });
  await applyStockValuationProfit({
    rows,
    buckets,
    accounts: stockAccounts,
    txRows: stockTxRows,
  });
  await applyFixedAssetValuationProfit({
    rows,
    buckets,
    householdId: ctx.householdId,
    accountIds: propertyAccountIds,
  });

  const accountTypeById = new Map(investmentAccounts.map((account) => [account.id, account.investProductType]));
  // Wealth cash flows are plain investment TxRecords whose fundProductType is
  // null, so without a lookup their realized profit would be classified as
  // fund profit. Link them to the wealth business rows to keep the column right.
  const wealthCashEntryRows = await prisma.wealthTransaction.findMany({
    where: { householdId: ctx.householdId, cashEntryId: { not: null } },
    select: { cashEntryId: true },
  });
  const wealthCashEntryIds = new Set(
    wealthCashEntryRows.map((row) => row.cashEntryId).filter(Boolean) as string[],
  );
  const stockCashEntryRows = stockAccountIds.length > 0
    ? await prisma.stockTransaction.findMany({
        where: {
          householdId: ctx.householdId,
          stockAccountId: { in: stockAccountIds },
          cashEntryId: { not: null },
        },
        select: { cashEntryId: true },
      })
    : [];
  const stockCashEntryIds = new Set(
    stockCashEntryRows.map((row) => row.cashEntryId).filter(Boolean) as string[],
  );

  const events = [
    ...txEntries.flatMap((entry) => {
      if (independentStatisticEntryIds.has(entry.id)) return [];
      const accountId = entry.toAccountId && accountTypeById.has(entry.toAccountId) ? entry.toAccountId : entry.accountId;
      if (snapshotAccountIds.has(accountId)) return [];
      if (stockCashEntryIds.has(entry.id)) return [];
      if (propertyCashEntryIdsInScope.has(entry.id)) return [];
      return eventsFromEntry(entry, wealthCashEntryIds.has(entry.id) ? "wealth" : undefined);
    }),
    ...fundStatisticEntries.flatMap((entry) => eventsFromEntry(entry)),
    ...wealthEntries.flatMap((entry) => eventsFromEntry(entry)),
  ].filter((event) => event.profit !== 0 && event.kind !== "deposit");

  for (const event of events) {
    const row = rows.get(eventBucketKey(event.date, params.period));
    if (row) addProfit(row, event.kind, event.profit);
  }

  const orderedRows = buckets.map((bucket) => rows.get(bucket.key)!).map((row) => ({
    ...row,
    fundProfit: roundMoney(row.fundProfit),
    stockProfit: roundMoney(row.stockProfit),
    wealthProfit: roundMoney(row.wealthProfit),
    depositProfit: roundMoney(row.depositProfit),
    fixedAssetProfit: roundMoney(row.fixedAssetProfit),
    totalProfit: roundMoney(row.totalProfit),
  }));
  const totals = orderedRows.reduce(
    (sum, row) => ({
      fundProfit: roundMoney(sum.fundProfit + row.fundProfit),
      stockProfit: roundMoney(sum.stockProfit + row.stockProfit),
      wealthProfit: roundMoney(sum.wealthProfit + row.wealthProfit),
      depositProfit: roundMoney(sum.depositProfit + row.depositProfit),
      fixedAssetProfit: roundMoney(sum.fixedAssetProfit + row.fixedAssetProfit),
      totalProfit: roundMoney(sum.totalProfit + row.totalProfit),
      count: sum.count + row.count,
    }),
    { fundProfit: 0, stockProfit: 0, wealthProfit: 0, depositProfit: 0, fixedAssetProfit: 0, totalProfit: 0, count: 0 },
  );

  return {
    rows: orderedRows,
    totals,
    eventCount: events.length,
    start: ymd(periodStart(params.period, params.year, params.month, firstYear)),
    end: ymd(buckets[buckets.length - 1]?.end ?? new Date()),
    baselineDate: ymd(baselineDateFor(params.period, params.year, params.month, firstYear)),
    missingNavs,
  };
}
