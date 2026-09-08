import { prisma } from "@/lib/db/prisma";
import { queryFundNav } from "@/lib/fund/queryApi";
import {
  ensureFundProfile,
  fundTradingCalendarForProfile,
  getFundProfile,
  getFundProfiles,
  latestFundNavTargetDateForOffset,
} from "@/lib/fund/fundProfile";
import { AccountKind, FundProductType } from "@prisma/client";

const NAV_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "http://fundf10.eastmoney.com/",
};

export interface NavListItem {
  date: string;
  nav: number;
  cumNav: number;
  sgzt: string;
  shzt: string;
}

/**
 * Batch fetch a fund's historical NAVs (fetches the whole date range at once).
 * Returns the NAV list sorted by date descending, including purchase/redemption status.
 * The Eastmoney API returns at most 20 items per page; requesting more still returns 20.
 */
export async function fetchHistoricalNavList(
  fundCode: string,
  startDate: string,
  endDate: string
): Promise<NavListItem[]> {
  const allItems: NavListItem[] = [];
  let pageIndex = 1;
  const pageSize = 20;

  while (true) {
    const url = `http://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=${pageIndex}&pageSize=${pageSize}&startDate=${startDate}&endDate=${endDate}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(url, { headers: NAV_HEADERS, cache: "no-store", signal: controller.signal });
      if (!res.ok) break;
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { break; }

      const list: { FSRQ: string; DWJZ: string; LJJZ: string; SGZT: string; SHZT: string }[] = data?.Data?.LSJZList ?? [];
      if (list.length === 0) break;
      for (const item of list) {
        allItems.push({
          date: item.FSRQ,
          nav: parseFloat(item.DWJZ),
          cumNav: parseFloat(item.LJJZ),
          sgzt: item.SGZT ?? "",
          shzt: item.SHZT ?? "",
        });
      }
      if (list.length < pageSize) break;
      pageIndex++;
    } catch {
      break;
    } finally {
      clearTimeout(timeout);
    }
  }
  return allItems;
}

/**
 * Find the NAV for the target date in a preloaded NAV list (exact match).
 */
export function findNavExact(
  navList: NavListItem[],
  targetDate: string
): NavListItem | null {
  const exact = navList.find(item => item.date === targetDate);
  if (exact && exact.nav > 0) return exact;
  return null;
}

/**
 * Find the NAV for the target date or the most recent trading day before it (fallback lookup).
 */
export function findNavFallback(
  navList: NavListItem[],
  targetDate: string
): NavListItem | null {
  const targetTime = new Date(targetDate + "T00:00:00Z").getTime();
  const nowDate = new Date().toISOString().slice(0, 10);
  const nowTime = new Date(nowDate + "T00:00:00Z").getTime();
  // Don't fallback for today or future dates — the nav hasn't been published yet
  const recentThreshold = nowTime - 2 * 86400000; // 2 calendar days ago
  const isRecent = targetTime > recentThreshold;

  const sorted = [...navList].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  for (const item of sorted) {
    const itemTime = new Date(item.date + "T00:00:00Z").getTime();
    if (itemTime <= targetTime) {
      // For recent dates, only use exact match (don't use stale fallback)
      if (isRecent && itemTime < targetTime) continue;
      return item;
    }
  }
  // No fallback for recent dates
  if (isRecent) return null;
  return sorted[0] ?? null;
}

/**
 * Write a historical NAV list into the cache table in bulk (including purchase status).
 */
export async function preloadNavListToCache(
  fundCode: string,
  navList: NavListItem[]
): Promise<number> {
  let written = 0;
  // Check if any entry has a restricted purchase status and fetch purchase limit if so
  const hasRestriction = navList.some(n => n.sgzt?.includes("\u9650\u5236"));
  let purchaseLimit: number | null = null;
  if (hasRestriction) {
    purchaseLimit = await fetchPurchaseLimit(fundCode);
  }
  for (const navItem of navList) {
    try {
      const limit = (navItem.sgzt?.includes("\u9650\u5236")) ? purchaseLimit : undefined;
      await setFundNav(fundCode, utcDate(navItem.date), navItem.nav, navItem.cumNav, undefined, navItem.sgzt, limit ?? undefined);
      written++;
    } catch {
      // A single failed write must not abort the whole batch
    }
  }
  return written;
}

export type FundNavCacheRangeRequest = {
  fundCode: string;
  startDate: string;
  endDate: string;
};

export type FundNavCacheRangeRefreshResult = {
  requested: number;
  rangeCount: number;
  fundCount: number;
  fetched: number;
  written: number;
  failed: number;
  ranges: Array<FundNavCacheRangeRequest & {
    fetched: number;
    written: number;
    ok: boolean;
    error?: string;
  }>;
};

function isYmd(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Batch fill the historical NAV cache for the given fund/date ranges.
 *
 * Callers may pass multiple missing dates; they are merged per fund into a minimal
 * date range, fetched at once through the historical NAV API, then written to FundNavCache.
 */
export async function refreshFundNavCacheRanges(
  requests: FundNavCacheRangeRequest[],
): Promise<FundNavCacheRangeRefreshResult> {
  const grouped = new Map<string, { fundCode: string; startDate: string; endDate: string; requested: number }>();

  for (const request of requests) {
    const fundCode = request.fundCode.trim();
    const startDate = request.startDate.trim();
    const endDate = request.endDate.trim();
    if (!fundCode || !isYmd(startDate) || !isYmd(endDate)) continue;
    const from = startDate <= endDate ? startDate : endDate;
    const to = startDate <= endDate ? endDate : startDate;
    const current = grouped.get(fundCode);
    if (!current) {
      grouped.set(fundCode, { fundCode, startDate: from, endDate: to, requested: 1 });
    } else {
      current.startDate = current.startDate < from ? current.startDate : from;
      current.endDate = current.endDate > to ? current.endDate : to;
      current.requested += 1;
    }
  }

  let fetched = 0;
  let written = 0;
  let failed = 0;
  const ranges: FundNavCacheRangeRefreshResult["ranges"] = [];

  for (const range of grouped.values()) {
    try {
      const navList = await fetchHistoricalNavList(range.fundCode, range.startDate, range.endDate);
      const rangeWritten = navList.length > 0 ? await preloadNavListToCache(range.fundCode, navList) : 0;
      fetched += navList.length;
      written += rangeWritten;
      ranges.push({
        fundCode: range.fundCode,
        startDate: range.startDate,
        endDate: range.endDate,
        fetched: navList.length,
        written: rangeWritten,
        ok: true,
      });
    } catch (error) {
      failed++;
      ranges.push({
        fundCode: range.fundCode,
        startDate: range.startDate,
        endDate: range.endDate,
        fetched: 0,
        written: 0,
        ok: false,
        error: error instanceof Error ? error.message : "Fetch failed",
      });
    }
  }

  return {
    requested: requests.length,
    rangeCount: grouped.size,
    fundCount: grouped.size,
    fetched,
    written,
    failed,
    ranges,
  };
}

/**
 * Convert a date string to a UTC Date (avoids timezone issues).
 */
function utcDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

async function ensureFundProfileForAccount(fundCode: string, accountId?: string) {
  const householdId = accountId
    ? (await prisma.account.findUnique({
        where: { id: accountId },
        select: { householdId: true },
      }))?.householdId
    : null;
  await ensureFundProfile(fundCode, { householdId });
}


/**
 * Query a fund NAV (smart fetch).
 * Flow: check cache first → call the API when missing → write to cache → return the result.
 *
 * Usage:
 * - navDate must be built with utcDate() so the time is T00:00:00Z
 *   Correct: utcDate("2026-05-25") → 2026-05-25T00:00:00.000Z
 *   Wrong: new Date("2026-05-25") → may shift to T16:00:00Z in some environments
 *
 * Return value:
 * - dateMatch=true: the NAV date equals the requested date, safe for share calculation
 * - dateMatch=false: the NAV date differs from the requested date (e.g. a historical date
 *   was requested but the API returned the latest available NAV). The actualDate field
 *   contains the real NAV date and can be used to update the confirmation date.
 * - null: neither the cache nor the API has data
 *
 * @param fundCode Fund code
 * @param navDate NAV date (must be a Date built with utcDate, ensuring T00:00:00Z)
 * @param accountId Fund account ID (optional; used to prefer the account default API and institution scenarios)
 * @returns NAV info (nav, cumNav, name, dateMatch, actualDate) or null
 */
export async function getFundNav(
  fundCode: string,
  navDate: Date,
  accountId?: string,
): Promise<{ nav: number; cumNav: number | null; name: string | null; dateMatch: boolean; actualDate?: string } | null> {
  // 1. Query the cache table first
  const cached = await getFundNavFromCacheOnly(fundCode, navDate);

  if (cached) {
    // Best-effort: ensure the fund's static profile (fund company etc.) is
    // cached too. Fire-and-forget so a profile fetch never blocks NAV reads.
    void ensureFundProfileForAccount(fundCode, accountId).catch(() => {});
    return { ...cached, dateMatch: true }; // Cache dates always match
  }

  // 2. Cache miss: fetch from the external API (trying configured priorities)
  const dateStr = navDate.toISOString().slice(0, 10);
  const apiData = await queryFundNav(fundCode, dateStr, accountId);

  if (!apiData) return null;

  // 3. Check whether the NAV date matches the requested date
  const actualNavDate = apiData.date ? utcDate(apiData.date) : navDate;
  const actualDateStr = actualNavDate.toISOString().slice(0, 10);
  const dateMatch = actualDateStr === dateStr;

  // 4. As long as the external API returned a NAV, write it to the cache using the actual
  //    NAV date so fetched data is not left uncached.
  try {
    await setFundNav(
      fundCode,
      actualNavDate,
      apiData.nav,
      apiData.cumNav ?? undefined,
      apiData.name ?? undefined,
    );
  } catch (error) {
    console.warn("Failed to cache fund NAV", { fundCode, navDate: actualDateStr, error });
  }

  // Best-effort: also cache the fund's static profile (fund company etc.).
  void ensureFundProfileForAccount(fundCode, accountId).catch(() => {});

  // 5. Return the result (including date-match info and the actual NAV date)
  return {
    nav: apiData.nav,
    cumNav: apiData.cumNav ?? null,
    name: apiData.name ?? null,
    dateMatch,
    actualDate: actualDateStr,
  };
}

/**
 * Query a NAV for the given date from the cache only. Does not call external APIs or write to the cache.
 *
 * @param fundCode Fund code
 * @param navDate NAV date (must be built with utcDate, ensuring T00:00:00Z)
 * @returns NAV info (nav, cumNav, name, sgzt) or null when not cached
 */
export interface NavCacheEntry {
  nav: number;
  cumNav: number | null;
  name: string | null;
  sgzt: string | null;
  purchaseLimit: number | null;
}

export async function getFundNavFromCacheOnly(
  fundCode: string,
  navDate: Date
): Promise<NavCacheEntry | null> {
  const record = await prisma.fundNavCache.findUnique({
    where: { fundCode_navDate: { fundCode, navDate } },
  });
  if (!record) return null;
  return {
    nav: Number(record.nav),
    cumNav: record.cumNav ? Number(record.cumNav) : null,
    name: record.name,
    sgzt: record.sgzt ?? null,
    purchaseLimit: record.purchaseLimit ?? null,
  };
}

/**
 * Scrape the fund's daily purchase limit from the Tiantian Fund detail page.
 * Only called when sgzt contains the restricted purchase status token.
 */
const PURCHASE_LIMIT_CACHE = new Map<string, number | null>();

export async function fetchPurchaseLimit(fundCode: string): Promise<number | null> {
  if (PURCHASE_LIMIT_CACHE.has(fundCode)) return PURCHASE_LIMIT_CACHE.get(fundCode) ?? null;
  try {
    const res = await fetch(`http://fundf10.eastmoney.com/jjjz_${fundCode}.html`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      cache: "no-store",
    });
    const html = await res.text();
    const m = html.match(/\u5355\u65E5\u7D2F\u8BA1\u8D2D\u4E70\u4E0A\u9650(\d+)\u5143/);
    const limit = m ? parseInt(m[1], 10) : null;
    PURCHASE_LIMIT_CACHE.set(fundCode, limit);
    return limit;
  } catch {
    PURCHASE_LIMIT_CACHE.set(fundCode, null);
    return null;
  }
}

/**
 * Update a fund NAV (cache table).
 * Force-syncs the NAV into the FundNavCache table.
 *
 * @param fundCode Fund code
 * @param navDate NAV date (must be built with utcDate, ensuring T00:00:00Z)
 * @param nav Unit NAV
 * @param cumNav Cumulative NAV (optional)
 * @param name Fund name (optional)
 * @param sgzt Purchase status from the external provider.
 */
export async function setFundNav(
  fundCode: string,
  navDate: Date,
  nav: number,
  cumNav?: number | null,
  name?: string | null,
  sgzt?: string | null,
  purchaseLimit?: number | null
): Promise<void> {
  await prisma.fundNavCache.upsert({
    where: { fundCode_navDate: { fundCode, navDate } },
    create: { fundCode, navDate, nav, cumNav, name, sgzt, purchaseLimit },
    update: { nav, cumNav, name, sgzt, purchaseLimit },
  });
}

/**
 * Update a fund NAV inside a transaction.
 *
 * @param tx Prisma transaction client
 * @param fundCode Fund code
 * @param navDate NAV date (must be built with utcDate, ensuring T00:00:00Z)
 * @param nav Unit NAV
 * @param cumNav Cumulative NAV (optional)
 * @param name Fund name (optional)
 * @param sgzt Purchase status (optional)
 */
export async function setFundNavInTx(
  tx: any,
  fundCode: string,
  navDate: Date,
  nav: number,
  cumNav?: number | null,
  name?: string | null,
  sgzt?: string | null
): Promise<void> {
  await tx.fundNavCache.upsert({
    where: {
      fundCode_navDate: {
        fundCode,
        navDate,
      },
    },
    create: {
      fundCode,
      navDate,
      nav,
      cumNav,
      name,
      sgzt,
    },
    update: {
      nav,
      cumNav,
      name,
      sgzt,
    },
  });
}

/**
 * Query a fund's latest NAV.
 * Reads the newest NAV record from the FundNavCache table.
 *
 * @param fundCode Fund code
 * @returns The latest NAV info or null
 */
export async function getLatestFundNav(
  fundCode: string
): Promise<{ id: string; nav: number; cumNav: number | null; navDate: Date; name: string | null } | null> {
  const record = await prisma.fundNavCache.findFirst({
    where: { fundCode },
    orderBy: { navDate: "desc" },
  });

  if (!record) return null;

  return {
    id: record.id,
    nav: Number(record.nav),
    cumNav: record.cumNav ? Number(record.cumNav) : null,
    navDate: record.navDate,
    name: record.name,
  };
}

export async function getLatestFundNavOnOrBefore(
  fundCode: string,
  navDate: Date,
): Promise<{ id: string; nav: number; cumNav: number | null; navDate: Date; name: string | null } | null> {
  const record = await prisma.fundNavCache.findFirst({
    where: { fundCode, navDate: { lte: navDate } },
    orderBy: { navDate: "desc" },
  });

  if (!record) return null;

  return {
    id: record.id,
    nav: Number(record.nav),
    cumNav: record.cumNav ? Number(record.cumNav) : null,
    navDate: record.navDate,
    name: record.name,
  };
}

/**
 * Batch query the latest NAV for multiple fund codes.
 *
 * Returns only the newest cached record per fundCode so callers do not pull full history into JS to filter.
 */
export async function getLatestFundNavMap(
  fundCodes: string[],
): Promise<Map<string, { id: string; nav: number; cumNav: number | null; navDate: Date; name: string | null }>> {
  const codes = [...new Set(fundCodes.map((code) => code.trim()).filter(Boolean))];
  const result = new Map<string, { id: string; nav: number; cumNav: number | null; navDate: Date; name: string | null }>();
  if (codes.length === 0) return result;

  const latestDates = await prisma.fundNavCache.groupBy({
    by: ["fundCode"],
    where: { fundCode: { in: codes } },
    _max: { navDate: true },
  });

  const latestPairs = latestDates
    .map((row) => (row._max.navDate ? { fundCode: row.fundCode, navDate: row._max.navDate } : null))
    .filter((row): row is { fundCode: string; navDate: Date } => row != null);

  if (latestPairs.length === 0) return result;

  const rows = await prisma.fundNavCache.findMany({
    where: {
      OR: latestPairs.map((pair) => ({
        fundCode: pair.fundCode,
        navDate: pair.navDate,
      })),
    },
    select: {
      id: true,
      fundCode: true,
      nav: true,
      cumNav: true,
      navDate: true,
      name: true,
    },
  });

  for (const row of rows) {
    result.set(row.fundCode, {
      id: row.id,
      nav: Number(row.nav),
      cumNav: row.cumNav ? Number(row.cumNav) : null,
      navDate: row.navDate,
      name: row.name,
    });
  }

  return result;
}

export async function getEffectiveLatestFundNavMap(
  fundCodes: string[],
  now: Date = new Date(),
): Promise<Map<string, { id: string; nav: number; cumNav: number | null; navDate: Date; name: string | null }>> {
  const codes = [...new Set(fundCodes.map((code) => code.trim()).filter(Boolean))];
  const rawLatest = await getLatestFundNavMap(codes);
  if (codes.length === 0) return rawLatest;

  const profiles = await getFundProfiles(codes);
  const profileByCode = new Map(profiles.map((profile) => [profile.fundCode, profile]));
  const result = new Map<string, { id: string; nav: number; cumNav: number | null; navDate: Date; name: string | null }>();

  await Promise.all(codes.map(async (fundCode) => {
    const profile = profileByCode.get(fundCode);
    const targetDate = latestFundNavTargetDateForOffset({
      navDateOffset: profile?.navDateOffset ?? 0,
      tradingCalendar: profile ? fundTradingCalendarForProfile(profile) : "cn_fund",
      now,
    });
    const targetNavDate = utcDate(targetDate);
    const latest = rawLatest.get(fundCode);
    if (latest && latest.navDate.getTime() <= targetNavDate.getTime()) {
      result.set(fundCode, latest);
      return;
    }
    const bounded = await getLatestFundNavOnOrBefore(fundCode, targetNavDate);
    if (bounded) result.set(fundCode, bounded);
  }));

  return result;
}

/**
 * Refresh the latest available NAV for a fund and persist it through FundNavCache.
 *
 * "Latest" means the newest NAV the data source can provide right now — the
 * real-time estimate during the trading day, or the most recently confirmed
 * trading-day NAV outside market hours.  The API result's own date is used as
 * the cache key so the cached record reflects what the source actually said.
 *
 * navDateOffset is NOT used here.  It only controls which cached record is
 * chosen when displaying or calculating profit (getEffectiveLatestFundNavMap).
 */
export async function refreshLatestFundNav(
  fundCode: string,
  accountId?: string,
): Promise<{ id: string; nav: number; cumNav: number | null; navDate: Date; name: string | null } | null> {
  // Fetch the very latest NAV from the data source (no date constraint so the
  // real-time estimate API is eligible; dateStr would restrict us to date-aware
  // APIs only and defeat the purpose of "latest").
  const apiData = await queryFundNav(fundCode, undefined, accountId);
  if (!apiData?.date || !Number.isFinite(apiData.nav)) {
    // Nothing from the API; fall back to the newest record we already have.
    return getLatestFundNav(fundCode);
  }

  const navDate = utcDate(apiData.date);
  await setFundNav(
    fundCode,
    navDate,
    apiData.nav,
    apiData.cumNav ?? null,
    apiData.name ?? null,
  );

  // Return the record we just wrote.
  return getLatestFundNavOnOrBefore(fundCode, navDate);
}

export type RefreshHeldFundLatestNavsResult = {
  checked: number;
  latestNavAvailable: number;
  nameFixed: number;
  failed: number;
  fundCodes: string[];
};

const HOLDING_NAV_REFRESH_CONCURRENCY = 4;

/**
 * Refresh latest NAV for currently held fund-like positions.
 *
 * Current holdings are rows with remaining units or pending buy cost. Closed
 * historical holdings are skipped so daily background checks stay lightweight.
 */
export async function refreshHeldFundLatestNavs(options: {
  householdId?: string;
  accountId?: string;
}): Promise<RefreshHeldFundLatestNavsResult> {
  const householdId = options.householdId?.trim();
  const accountId = options.accountId?.trim();
  if (!householdId && !accountId) {
    throw new Error("refreshHeldFundLatestNavs requires householdId or accountId");
  }

  const holdings = await prisma.fundHolding.findMany({
    where: {
      ...(accountId ? { accountId } : {}),
      OR: [
        { units: { gt: 0 } },
        { pendingCost: { gt: 0 } },
      ],
      Account: {
        ...(householdId ? { householdId } : {}),
        kind: AccountKind.investment,
        isActive: true,
        isPlaceholder: false,
        OR: [
          { investProductType: null },
          { investProductType: { in: [FundProductType.fund, FundProductType.money] } },
        ],
      },
    },
    select: {
      accountId: true,
      fundCode: true,
      fundName: true,
    },
    orderBy: [
      { accountId: "asc" },
      { fundCode: "asc" },
    ],
  });

  let latestNavAvailable = 0;
  let nameFixed = 0;
  let failed = 0;
  const fundCodes = new Set<string>();

  for (let offset = 0; offset < holdings.length; offset += HOLDING_NAV_REFRESH_CONCURRENCY) {
    const batch = holdings.slice(offset, offset + HOLDING_NAV_REFRESH_CONCURRENCY);
    await Promise.all(batch.map(async (holding) => {
      const fundCode = holding.fundCode.trim();
      if (!fundCode) return;
      fundCodes.add(fundCode);
      try {
        const latestNav = await refreshLatestFundNav(fundCode, holding.accountId);
        if (!latestNav) return;
        latestNavAvailable++;

        const name = (latestNav.name ?? "").trim();
        if (name && name !== fundCode && name !== (holding.fundName ?? "").trim()) {
          await prisma.fundHolding.update({
            where: { accountId_fundCode: { accountId: holding.accountId, fundCode } },
            data: { fundName: name },
          });
          nameFixed++;
        }
      } catch {
        failed++;
      }
    }));
  }

  return {
    checked: holdings.length,
    latestNavAvailable,
    nameFixed,
    failed,
    fundCodes: [...fundCodes],
  };
}
