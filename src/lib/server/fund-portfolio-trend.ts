/**
 * Fund portfolio trend data loader.
 *
 * Produces one data point per calendar month for every fund account
 * in the household.  Each point contains:
 *   - cost:       running cost basis of all positions at month-end
 *   - marketValue: market value of all positions at month-end
 *   - netFlow:    net invested (buy - redeem) this month
 *   - floatingPnL: marketValue - cost
 *   - flowKind:   "buy" | "redeem" | "dividend" | "none"
 *
 * The algorithm walks forward month by month, simulating the holdings
 * as of the last available NAV date in each month.
 *
 * Benchmark data (沪深300) is loaded from BenchmarkCache and merged
 * into the response so the chart can overlay it.
 */

import { FundProductType, FundSubtype, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AccountKind } from "@prisma/client";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision-core";

export type FundTrendPoint = {
  /** YYYY-MM */
  month: string;
  /** Running cost basis of all positions at month-end (¥) */
  cost: number;
  /** Market value of all positions at month-end (¥) */
  marketValue: number;
  /** marketValue - cost (¥) */
  floatingPnL: number;
  /** Cumulative net invested up to and including this month (¥) */
  cumNetInvested: number;
  /** Net invested this month (¥): external buys - redeem proceeds - refunds */
  netFlow: number;
  /** Cash dividends received this month (¥); does not reduce cost */
  dividendCash: number;
  /** Primary flow kind for this month */
  flowKind: "buy" | "redeem" | "dividend" | "none";
};

export type BenchmarkPoint = {
  month: string;
  /** 沪深300 cumNav, normalised so the first month = 1.0 */
  normNav: number;
  /** Raw cumNav value from cache */
  rawNav: number;
};

export type FundPortfolioTrendData = {
  points: FundTrendPoint[];
  /** Months where no transaction happened at all (cost/marketValue repeat) */
  emptyMonths: string[];
  benchmark: BenchmarkPoint[];
  /** First and last month that have real transactions */
  rangeStart: string;
  rangeEnd: string;
};

function toMonth(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** Stable key for a buy transaction (used to link refunds). */
function buyKey(tx: {
  fundAccountId: string;
  fundCode: string;
  confirmDate: Date | null;
  applyDate: Date;
}): string {
  return `${tx.fundAccountId}:${tx.fundCode.trim()}:${(tx.confirmDate ?? tx.applyDate).toISOString()}`;
}

function monthRange(startMonth: string, endMonth: string): string[] {
  const months: string[] = [];
  const [sy, sm] = startMonth.split("-").map(Number);
  const [ey, em] = endMonth.split("-").map(Number);
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

// ── Benchmark cache ──────────────────────────────────────────────────────────

const BENCHMARK_CODE = "000300"; // 沪深300

interface BenchmarkCacheRow {
  navDate: Date;
  nav: Prisma.Decimal | number;
  cumNav: Prisma.Decimal | number | null;
}

type BenchmarkCacheDelegate = {
  findMany(args: {
    where: {
      code: string;
      navDate: { gte: Date; lte: Date };
    };
    orderBy: { navDate: "asc" };
    select: { navDate: true; nav: true; cumNav: true };
  }): Promise<BenchmarkCacheRow[]>;
  upsert(args: {
    where: { code_navDate: { code: string; navDate: Date } };
    create: {
      code: string;
      navDate: Date;
      nav: number;
      cumNav: number | null;
    };
    update: {
      nav: number;
      cumNav: number | null;
    };
  }): Promise<unknown>;
};

function getBenchmarkCacheDelegate(): BenchmarkCacheDelegate | null {
  return (prisma as unknown as { benchmarkCache?: BenchmarkCacheDelegate }).benchmarkCache ?? null;
}

function parseYmd(s: string): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/**
 * Fetch 沪深300 NAV data and cache it in the BenchmarkCache table.
 *
 * Implementation: pulls history from the Eastmoney fund API using
 * 510300 (华泰柏瑞沪深300ETF) as a mirror, since the API exposes
 * ETF NAVs.  Returns the count successfully written; failures are
 * silently dropped so the API can serve cached data as a fallback.
 */
export async function refreshBenchmarkCache(
  startDate: string,
  endDate: string,
): Promise<{ fetched: number }> {
  const benchmarkCache = getBenchmarkCacheDelegate();
  if (!benchmarkCache) return { fetched: 0 };

  try {
    const url = `http://api.fund.eastmoney.com/f10/lsjz?fundCode=510300&pageIndex=1&pageSize=20&startDate=${startDate}&endDate=${endDate}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "http://fundf10.eastmoney.com/",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { fetched: 0 };
    const json = await res.json();
    const list: { FSRQ: string; DWJZ: string; LJJZ: string }[] =
      json?.Data?.LSJZList ?? [];
    let fetched = 0;
    for (const item of list) {
      const date = parseYmd(item.FSRQ);
      if (!date) continue;
      const nav = parseFloat(item.DWJZ);
      const cumNav = parseFloat(item.LJJZ);
      if (!isFinite(nav) || nav <= 0) continue;
      await benchmarkCache.upsert({
        where: { code_navDate: { code: BENCHMARK_CODE, navDate: date } },
        create: { code: BENCHMARK_CODE, navDate: date, nav, cumNav: isFinite(cumNav) ? cumNav : null },
        update: { nav, cumNav: isFinite(cumNav) ? cumNav : null },
      });
      fetched++;
    }
    return { fetched };
  } catch {
    return { fetched: 0 };
  }
}

/**
 * Load 沪深300 monthly-end NAV data from BenchmarkCache.
 * Returns normalized nav so first month = 1.0.
 */
export async function loadBenchmarkMonthly(
  startMonth: string,
  endMonth: string,
): Promise<BenchmarkPoint[]> {
  const [sy, sm] = startMonth.split("-").map(Number);
  const [ey, em] = endMonth.split("-").map(Number);
  const startDate = new Date(Date.UTC(sy, sm - 1, 1));
  const endDate = new Date(Date.UTC(ey, em, 0));

  const benchmarkCache = getBenchmarkCacheDelegate();
  if (!benchmarkCache) return [];

  const rows = await benchmarkCache.findMany({
    where: {
      code: BENCHMARK_CODE,
      navDate: { gte: startDate, lte: endDate },
    },
    orderBy: { navDate: "asc" },
    select: { navDate: true, nav: true, cumNav: true },
  }).catch(() => []);

  if (rows.length === 0) return [];

  // Group into months, pick last available day per month
  const byMonth = new Map<string, BenchmarkCacheRow>();
  for (const row of rows) {
    const m = toMonth(row.navDate);
    byMonth.set(m, row);
  }

  const months = monthRange(startMonth, endMonth);
  const points: BenchmarkPoint[] = [];
  let baseNav: number | null = null;

  for (const month of months) {
    const row = byMonth.get(month);
    if (!row) continue;
    const rawNav = Number(row.cumNav ?? row.nav);
    if (baseNav === null) baseNav = rawNav;
    points.push({
      month,
      normNav: baseNav > 0 ? rawNav / baseNav : 1,
      rawNav,
    });
  }

  return points;
}

// ── Monthly NAV helper ──────────────────────────────────────────────────────

/**
 * For a given fund code and a target month (YYYY-MM), return the last
 * available NAV on or before the last day of that month.
 */
async function getNavOnOrBeforeMonthEnd(
  fundCode: string,
  month: string,
): Promise<{ nav: number; navDate: Date } | null> {
  const [y, m] = month.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(y, m - 1 + 1, 0)); // last day of month
  const row = await prisma.fundNavCache.findFirst({
    where: { fundCode, navDate: { lte: monthEnd } },
    orderBy: { navDate: "desc" },
    select: { nav: true, navDate: true },
  });
  if (!row || Number(row.nav) <= 0) return null;
  return { nav: Number(row.nav), navDate: row.navDate };
}

// ── Main loader ─────────────────────────────────────────────────────────────

export async function loadFundPortfolioTrendData(
  ctx: HouseholdContext,
  options: {
    /** Minimum month YYYY-MM (default: earliest tx) */
    startMonth?: string;
    /** Maximum month YYYY-MM (default: current month) */
    endMonth?: string;
    /** Account IDs to include */
    accountIds?: string[];
    /** Include benchmark data */
    includeBenchmark?: boolean;
  } = {},
): Promise<FundPortfolioTrendData> {
  const { startMonth: optStart, endMonth: optEnd, accountIds, includeBenchmark } = options;

  // ── 1. Find all investment accounts ─────────────────────────────────────
  const accountFilter = accountIds && accountIds.length > 0
    ? { id: { in: accountIds } }
    : {};
  const accounts = await prisma.account.findMany({
    where: {
      ...ctx.hidFilter,
      ...accountFilter,
      kind: AccountKind.investment,
      investProductType: { in: [FundProductType.fund, FundProductType.money] },
      isActive: true,
      isPlaceholder: { not: true },
    },
    select: { id: true, name: true, fundUnitsDecimals: true },
  });
  if (accounts.length === 0) {
    const now = new Date();
    const s = optStart ?? `${now.getUTCFullYear() - 1}-01`;
    const e = optEnd ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const bench = includeBenchmark ? await loadBenchmarkMonthly(s, e) : [];
    return { points: [], emptyMonths: [], benchmark: bench, rangeStart: s, rangeEnd: e };
  }
  const accountIds2 = accounts.map(a => a.id);

  // ── 2. Load all fund transactions (buy/redeem/dividend/switch) ──────────
  // Note: dividend reinvest lands as buy+source="dividend" (see
  // transactions/detail route), and regular invest lands as
  // buy+source="regular_invest".  buy_failed rows are failed-order
  // records: they never become holdings (recalcPosition skips them) and
  // their cash never entered the portfolio, so they are excluded below.
  // Refunds for failed regular-invest orders are carried on the buy row's
  // refundAmount column and/or linked refund_in cash flows — we take the
  // larger of the two (same as displayPendingAmount in invest-balance.ts).
  const transactions = await prisma.fundTransaction.findMany({
    where: {
      householdId: ctx.householdId,
      deletedAt: null,
      fundAccountId: { in: accountIds2 },
      fundSubtype: { in: [FundSubtype.buy, FundSubtype.redeem, FundSubtype.dividend_cash, FundSubtype.switch_in, FundSubtype.switch_out, FundSubtype.regular_invest] },
    },
    select: {
      fundAccountId: true,
      fundCode: true,
      fundSubtype: true,
      source: true,
      applyDate: true,
      confirmDate: true,
      createdAt: true,
      grossAmount: true,
      refundAmount: true,
      arrivalAmount: true,
      fee: true,
      nav: true,
      units: true,
      cashFlows: {
        select: { kind: true, amount: true },
      },
    },
    orderBy: [{ applyDate: "asc" }, { createdAt: "asc" }],
  });

  if (transactions.length === 0) {
    const now = new Date();
    const s = optStart ?? `${now.getUTCFullYear() - 1}-01`;
    const e = optEnd ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const bench = includeBenchmark ? await loadBenchmarkMonthly(s, e) : [];
    return { points: [], emptyMonths: [], benchmark: bench, rangeStart: s, rangeEnd: e };
  }

  // ── 3. Determine date range ─────────────────────────────────────────────
  // startMonth/endMonth CLIP the display window: the simulation always walks
  // from the earliest transaction (so cost basis inside the window is
  // correct), but only months >= startMonth are returned.
  let minDate = transactions[0]!.applyDate;
  let maxDate = transactions[transactions.length - 1]!.applyDate;
  if (optStart) {
    const [y, m] = optStart.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 1, 1));
    if (d < minDate) minDate = d;
  }
  const now = new Date();
  if (maxDate < now) maxDate = now;
  if (optEnd) {
    const [y, m] = optEnd.split("-").map(Number);
    const d = new Date(Date.UTC(y, m, 0)); // last day of end month
    // Never walk into the future: an end month beyond "now" is capped at now.
    if (d < maxDate) maxDate = d;
  }

  const startMonth = toMonth(minDate);
  const endMonth = toMonth(maxDate);
  const allMonths = monthRange(startMonth, endMonth);
  // Display window: months before optStart are simulated but not returned.
  const displayMonths = optStart
    ? allMonths.filter((m) => m >= optStart)
    : allMonths;

  // ── 4. Walk forward month by month ───────────────────────────────────────
  type Position = {
    fundCode: string;
    units: number;
    cost: number;
  };

  // State per account.  Units rounding follows the standard recalcPosition
  // pipeline: every step is rounded through roundFundUnits with the owning
  // account's fundUnitsDecimals so the simulated trend converges exactly
  // with the standard implementation.
  type AccountState = {
    decimals: number;
    positions: Map<string, Position>;
  };
  const stateByAccount = new Map<string, AccountState>();
  for (const account of accounts) {
    stateByAccount.set(account.id, {
      decimals: normalizeFundUnitsDecimals(account.fundUnitsDecimals),
      positions: new Map(),
    });
  }

  const txIndexByMonth = new Map<string, typeof transactions>();
  for (const tx of transactions) {
    // Use confirmDate (fallback applyDate) for month attribution —
    // matches recalcPosition's entryCalcDate ordering.
    const month = toMonth(tx.confirmDate ?? tx.applyDate);
    const list = txIndexByMonth.get(month) ?? [];
    list.push(tx);
    txIndexByMonth.set(month, list);
  }

  // Refund totals per buy row: max(row.refundAmount, sum(refund_in flows)) —
  // mirrors displayPendingAmount in invest-balance.ts.
  const refundByBuyKey = new Map<string, number>();
  for (const tx of transactions) {
    if (tx.fundSubtype !== FundSubtype.buy) continue;
    const code = tx.fundCode.trim();
    if (!code) continue;
    const byRow = Math.abs(Number(tx.refundAmount) || 0);
    const byFlows = tx.cashFlows
      .filter((f) => f.kind === "refund_in")
      .reduce((sum, f) => sum + Math.abs(Number(f.amount) || 0), 0);
    const refund = Math.min(Math.abs(Number(tx.grossAmount) || 0), Math.max(byRow, byFlows));
    if (refund > 0) {
      refundByBuyKey.set(buyKey(tx), refund);
    }
  }

  // Pre-load NAVs for the end of each month (batch per fund)
  // Cache: `${fundCode}:${month}` → nav
  const navLookupCache = new Map<string, { nav: number; navDate: Date } | null>();

  const points: FundTrendPoint[] = [];
  const emptyMonths: string[] = [];
  let cumNetInvested = 0;

  for (const month of allMonths) {
    const monthTxs = txIndexByMonth.get(month) ?? [];

    // Standard implementation orders same-month transactions by
    // confirmDate asc, applyDate asc, createdAt asc — mirror that here.
    // (The Prisma query already sorts by applyDate/createdAt; re-sorting
    // by confirmDate makes the intra-month order identical.)
    monthTxs.sort((a, b) => {
      const da = (a.confirmDate ?? a.applyDate).getTime();
      const db = (b.confirmDate ?? b.applyDate).getTime();
      if (da !== db) return da - db;
      if (a.applyDate.getTime() !== b.applyDate.getTime()) {
        return a.applyDate.getTime() - b.applyDate.getTime();
      }
      return a.createdAt.getTime() - b.createdAt.getTime();
    });

    // Process this month's transactions
    let netFlow = 0;
    let dividendCash = 0;
    let flowKind: FundTrendPoint["flowKind"] = "none";
    let hasBuy = false;
    let hasRedeem = false;
    let hasDividend = false;

    for (const tx of monthTxs) {
      const accountState = stateByAccount.get(tx.fundAccountId);
      if (!accountState) continue;
      const positions = accountState.positions;
      const decimals = accountState.decimals;

      const fundCode = tx.fundCode.trim();
      if (!fundCode) continue;

      const subtype = tx.fundSubtype;
      const src = tx.source ?? "";

      const grossAmount = Math.abs(Number(tx.grossAmount) || 0);
      const fee = Math.max(0, Number(tx.fee ?? 0));
      const nav = Number(tx.nav ?? 0);
      const units = Number(tx.units ?? 0);

      if (subtype === FundSubtype.buy || subtype === FundSubtype.switch_in || subtype === FundSubtype.regular_invest) {
        const isDividendReinvest = subtype === FundSubtype.buy && src === "dividend";
        const refundAmt = refundByBuyKey.get(buyKey(tx)) ?? 0;
        // net cost = gross (fee-inclusive) - linked refunds; fee is part of cost.
        // Units stay as recorded: a refunded order can still have confirmed
        // units (verified: sum(buys.units) - sum(redeems.units) = holding.units).
        const netCost = Math.max(0, grossAmount - refundAmt);

        // Dividend reinvest is an internal flow: money never left the
        // household, so it must not inflate net invested.
        if (!isDividendReinvest) {
          netFlow += netCost;
        }
        hasBuy = true;

        const pos = positions.get(fundCode) ?? { fundCode, units: 0, cost: 0 };
        pos.cost += netCost;
        // Per-row units are pre-rounded to the account's precision before
        // accumulating — mirrors recalcPosition's storedUnits handling.
        const rowUnits = units > 0 ? roundFundUnits(units, decimals) : 0;
        if (rowUnits > 0) {
          pos.units = roundFundUnits(pos.units + rowUnits, decimals);
        } else if (nav > 0) {
          // Fallback: derive units from principal (net of fee) / nav
          const sharePrincipal = Math.max(0, netCost - fee);
          pos.units = roundFundUnits(pos.units + sharePrincipal / nav, decimals);
        }
        positions.set(fundCode, pos);
      } else if (subtype === FundSubtype.redeem || subtype === FundSubtype.switch_out) {
        // Redeem proceeds (arrival amount preferred over gross) leave the portfolio
        const proceeds = Math.abs(Number(tx.arrivalAmount ?? tx.grossAmount) || 0);
        netFlow -= proceeds;
        hasRedeem = true;
        const pos = positions.get(fundCode);
        // A redeem with unknown units (still unconfirmed) must NOT touch the
        // position — same as recalcPosition, which only reduces when units > 0.
        if (pos && pos.units > 0 && units > 0) {
          const avgCost = pos.units > 0 ? pos.cost / pos.units : 0;
          const reducingUnits = Math.min(units, pos.units);
          pos.units = Math.max(0, roundFundUnits(pos.units - reducingUnits, decimals));
          pos.cost = Math.max(0, pos.cost - avgCost * reducingUnits);
          if (pos.units === 0) positions.delete(fundCode);
        }
      } else if (subtype === FundSubtype.dividend_cash) {
        // Cash dividend: realised profit, does NOT reduce cost basis
        // (matches recalcPosition.historicalProfit semantics).
        dividendCash += Math.abs(Number(tx.arrivalAmount ?? tx.grossAmount) || 0);
        hasDividend = true;
      }
    }

    // Determine flowKind for this month
    if (hasBuy) flowKind = "buy";
    else if (hasRedeem) flowKind = "redeem";
    else if (hasDividend) flowKind = "dividend";
    else flowKind = "none";

    // Aggregate positions across all accounts
    let totalUnits = 0;
    let totalCost = 0;
    const activePositions: { fundCode: string; units: number; cost: number }[] = [];
    for (const accountState of stateByAccount.values()) {
      for (const pos of accountState.positions.values()) {
        totalUnits += pos.units;
        totalCost += pos.cost;
        if (pos.units > 0) activePositions.push(pos);
      }
    }

    // Calculate market value using month-end NAV
    let marketValue = 0;
    if (totalUnits > 0) {
      for (const pos of activePositions) {
        const cacheKey = `${pos.fundCode}:${month}`;
        let navInfo = navLookupCache.get(cacheKey);
        if (navInfo === undefined) {
          navInfo = await getNavOnOrBeforeMonthEnd(pos.fundCode, month);
          navLookupCache.set(cacheKey, navInfo);
        }
        if (navInfo && navInfo.nav > 0) {
          marketValue += pos.units * navInfo.nav;
        } else {
          // No NAV available — skip this position's market value
        }
      }
    }

    const floatingPnL = marketValue - totalCost;
    cumNetInvested += netFlow;

    const hasTxs = monthTxs.length > 0;
    if (!hasTxs && month >= (optStart ?? "0000-00")) emptyMonths.push(month);
    // Months outside the display window are simulated for correctness but
    // not returned to the chart.
    if (month < (optStart ?? "0000-00")) continue;

    points.push({
      month,
      cost: Math.round(totalCost * 100) / 100,
      marketValue: Math.round(marketValue * 100) / 100,
      floatingPnL: Math.round(floatingPnL * 100) / 100,
      cumNetInvested: Math.round(cumNetInvested * 100) / 100,
      netFlow: Math.round(netFlow * 100) / 100,
      dividendCash: Math.round(dividendCash * 100) / 100,
      flowKind,
    });
  }

  // ── 5. Benchmark ────────────────────────────────────────────────────────
  // Benchmarks are normalized to the FIRST DISPLAYED month so the chart's
  // pct axis matches the visible window (not the simulation origin).
  const displayStart = displayMonths[0] ?? startMonth;
  const bench = includeBenchmark ? await loadBenchmarkMonthly(displayStart, endMonth) : [];

  return {
    points,
    emptyMonths,
    benchmark: bench,
    rangeStart: displayStart,
    rangeEnd: endMonth,
  };
}
