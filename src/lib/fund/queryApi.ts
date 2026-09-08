/**
 * Unified fund NAV query entry point.
 *
 * Two calling modes:
 * 1. Query latest NAV: omit dateStr → try up to three APIs by priority and return the latest available NAV
 * 2. Query a specific date: pass dateStr → only use APIs that support date filtering (baseUrl contains the {date} placeholder),
 *    skipping APIs without date filtering (e.g. eastmoney realtime estimate) to avoid returning a NAV for the wrong date
 *
 * @param fundCode Fund code
 * @param dateStr NAV date (YYYY-MM-DD); omit to query the latest
 * @param accountId Fund account ID (optional, used for the account-level default API)
 * @returns NAV info or null
 */
import { prisma } from "@/lib/db/prisma";

type NavResult = {
  nav: number;
  cumNav?: number;
  name?: string;
  date: string;
} | null;

type FundQueryApiConfig = {
  id: string;
  code: string;
  name: string;
  baseUrl: string;
  priority: number;
  isActive: boolean;
  householdId: string | null;
};

export type FundIdentityResult = {
  code: string;
  name: string;
  fullName?: string;
  source: string;
} | null;

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "http://fundf10.eastmoney.com/",
};

const MAX_FUND_QUERY_API_ATTEMPTS = 3;

async function fetchFromUrl(url: string, parser: (data: any) => NavResult): Promise<NavResult> {
  try {
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) return null;
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch {
      // Tiantian Fund returns data in JS format
      const m = text.match(/\{.+\}/);
      if (!m) return null;
      try { data = JSON.parse(m[0]); } catch { return null; }
    }
    return parser(data);
  } catch {
    return null;
  }
}

// eastmoney parser — latest NAV (Tiantian Fund)
function parseEastmoney(data: any): NavResult {
  if (!data?.dwjz) return null;
  return {
    date: data.jzrq as string,
    nav: parseFloat(data.dwjz),
    cumNav: parseFloat(data.dwjz),
    name: data.name as string,
  };
}

/**
 * eastmoney_history parser — historical NAVs (Eastmoney)
 * Supports parsing multiple records to find the NAV closest to a target date.
 */
function parseEastmoneyHistoryList(data: any): { FSRQ: string; DWJZ: string; LJJZ: string }[] {
  return data?.Data?.LSJZList ?? [];
}

function parseEastmoneyHistory(data: any): NavResult {
  const list = parseEastmoneyHistoryList(data);
  if (list.length > 0) {
    return {
      date: list[0]!.FSRQ,
      nav: parseFloat(list[0]!.DWJZ),
      cumNav: parseFloat(list[0]!.LJJZ),
    };
  }
  return null;
}

// danjuan parser — Danjuan Fund
function parseDanjuan(data: any): NavResult {
  if (!data?.data?.nav) return null;
  return {
    date: data.data.nav_date || "",
    nav: parseFloat(data.data.nav),
    cumNav: data.data.cum_nav ? parseFloat(data.data.cum_nav) : undefined,
    name: data.data.fund_name,
  };
}

function findValueByKeys(data: unknown, keys: string[], depth = 0): unknown {
  if (depth > 8 || data == null || typeof data !== "object") return undefined;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findValueByKeys(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  const record = data as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null && String(record[key]).trim() !== "") {
      return record[key];
    }
  }
  for (const value of Object.values(record)) {
    const found = findValueByKeys(value, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function parseNumberValue(value: unknown): number | undefined {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseDateValue(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const dashed = raw.match(/\d{4}-\d{1,2}-\d{1,2}/)?.[0];
  if (dashed) {
    const [y, m, d] = dashed.split("-").map((part) => part.padStart(2, "0"));
    return `${y}-${m}-${d}`;
  }
  const compact = raw.match(/\d{8}/)?.[0];
  if (compact) return `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  return undefined;
}

// Alipay/Ant Fortune field names vary across API versions, so only read explicit NAV
// fields here instead of broadly guessing numbers.
function parseAlipay(data: any): NavResult {
  const nav = parseNumberValue(findValueByKeys(data, [
    "nav",
    "netValue",
    "unitNetValue",
    "fundNetValue",
    "dailyNetValue",
    "dwjz",
  ]));
  if (!nav) return null;

  const cumNav = parseNumberValue(findValueByKeys(data, [
    "cumNav",
    "totalNetValue",
    "accumulatedNetValue",
    "accumulativeNetValue",
    "ljjz",
  ]));
  const date = parseDateValue(findValueByKeys(data, [
    "date",
    "navDate",
    "netValueDate",
    "statisticDate",
    "jzrq",
  ]));
  if (!date) return null;
  const name = normalizeFundName(findValueByKeys(data, [
    "name",
    "fundName",
    "fundShortName",
    "shortName",
  ]));

  return {
    date,
    nav,
    cumNav,
    name: name ?? undefined,
  };
}

function normalizeFundName(name: unknown): string | null {
  const value = String(name ?? "").trim();
  if (!value || value.length < 2) return null;
  if (/基金历史净值|基金档案|天天基金|基金吧|搜索结果/.test(value)) return null;
  return value;
}

export async function queryFundIdentity(fundCode: string): Promise<FundIdentityResult> {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return null;

  try {
    const url = `http://fundf10.eastmoney.com/jjjz_${code}.html`;
    const res = await fetch(url, {
      headers: { ...headers, Referer: url },
      cache: "no-store",
    });
    if (res.ok) {
      const html = await res.text();
      const patterns = [
        /<title[^>]*>\s*([^<]*?)\s*[\uFF08(]\s*(\d{6})\s*[\uFF09)]/i,
        /<meta\s+name=["']keywords["']\s+content=["']([^,"']+),\s*(\d{6})[,"]/i,
        /<meta\s+name=["']description["']\s+content=["'][^"']*?提供([^("']+)[（(](\d{6})[）)]/i,
      ];
      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (!match || match[2] !== code) continue;
        const name = normalizeFundName(match[1]);
        if (name) return { code, name, source: "eastmoney-f10" };
      }
    }
  } catch {
    // Try the next source.
  }

  try {
    const url = `https://danjuanfunds.com/djapi/fund/${code}`;
    const res = await fetch(url, {
      headers: {
        ...headers,
        Referer: `https://danjuanfunds.com/fund/${code}`,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (res.ok) {
      const data: any = await res.json();
      const fdCode = String(data?.data?.fd_code ?? data?.fd_code ?? "").trim();
      if (fdCode === code) {
        const name = normalizeFundName(data?.data?.fd_name ?? data?.fd_name);
        if (name) {
          const fullName = normalizeFundName(data?.data?.fd_full_name ?? data?.fd_full_name) ?? undefined;
          return { code, name, fullName, source: "danjuan" };
        }
      }
    }
  } catch {
    // No identity result.
  }

  return null;
}

const PARSERS: Record<string, (data: any) => NavResult> = {
  eastmoney: parseEastmoney,
  eastmoney_history: parseEastmoneyHistory,
  danjuan: parseDanjuan,
  alipay: parseAlipay,
};

export type FundProfileResult = {
  code: string;
  name?: string;
  fundCompany?: string;
  custodian?: string;
  manager?: string;
  source: string;
} | null;

/**
 * Extract a labeled field from the fund overview page.
 * Provider link identifiers are not regulator-issued fund company codes, so
 * the parser returns display text only and ignores those identifiers.
 */
function extractLabeledField(html: string, label: string): { text: string } | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<th[^>]*>\\s*${escaped}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`, "i");
  const m = html.match(re);
  if (!m) return null;
  const cell = m[1] ?? "";
  const text = cell.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
  if (!text) return null;
  return { text };
}

/**
 * Fetch a fund profile from the Tiantian Fund overview page.
 * This is fund-level metadata, independent of the holding account.
 */
export async function queryFundProfile(fundCode: string): Promise<FundProfileResult> {
  const code = fundCode.trim();
  if (!/^\d{6}$/.test(code)) return null;

  try {
    const url = `http://fundf10.eastmoney.com/jbgk_${code}.html`;
    const res = await fetch(url, {
      headers: { ...headers, Referer: url },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const html = await res.text();

    const fundCompany = extractLabeledField(html, "\u57FA\u91D1\u7BA1\u7406\u4EBA");
    const custodian = extractLabeledField(html, "\u57FA\u91D1\u6258\u7BA1\u4EBA");
    const manager = extractLabeledField(html, "\u57FA\u91D1\u7ECF\u7406\u4EBA");

    const titleMatch = html.match(/<title[^>]*>\s*([^<]*?)\s*[\uFF08(]\s*(\d{6})\s*[\uFF09)]/i);
    const name = titleMatch && titleMatch[2] === code ? normalizeFundName(titleMatch[1]) : undefined;

    if (!fundCompany && !custodian && !manager && !name) return null;

    return {
      code,
      name: name ?? undefined,
      fundCompany: fundCompany?.text,
      custodian: custodian?.text,
      manager: manager?.text,
      source: "eastmoney-f10",
    };
  } catch {
    return null;
  }
}
/**
 * Get all active query APIs (sorted by priority).
 */
async function getActiveApis(householdId?: string | null): Promise<FundQueryApiConfig[]> {
  return prisma.fundQueryApi.findMany({
    where: {
      isActive: true,
      ...(householdId
        ? { OR: [{ householdId }, { householdId: null }] }
        : {}),
    },
    orderBy: [
      { priority: "asc" },
      { createdAt: "asc" },
    ],
  });
}

function moveApiToFront(apis: FundQueryApiConfig[], predicate: (api: FundQueryApiConfig) => boolean) {
  const selected = apis.find(predicate);
  if (!selected) return apis;
  return [selected, ...apis.filter((api) => api.id !== selected.id)];
}

function isAlipayInstitutionText(text: string) {
  return /支付宝|蚂蚁|Ant\s*Fortune|Alipay/i.test(text);
}

/**
 * Query historical NAVs (wider date range).
 * When an exact-date query fails, try querying NAVs around the target date and return the one closest to it.
 *
 * @param fundCode Fund code
 * @param targetDate Target date (YYYY-MM-DD)
 * @param rangeDays How many days to extend the range backward; defaults to 90 (covers a quarter)
 * @returns NAV info (including the actual NAV date) or null
 */
export async function queryHistoricalNav(
  fundCode: string,
  targetDate: string,
  rangeDays: number = 90
): Promise<NavResult> {
  // Calculate the query range: from rangeDays before the target date to the target date
  const target = new Date(targetDate + "T00:00:00Z");
  const startDate = new Date(target.getTime() - rangeDays * 24 * 60 * 60 * 1000);
  const endDate = target;

  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  // Query the eastmoney_history API (wider date range)
  const url = `http://api.fund.eastmoney.com/f10/lsjz?fundCode=${fundCode}&pageIndex=1&pageSize=50&startDate=${startStr}&endDate=${endStr}`;

  try {
    const res = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) return null;
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { return null; }

    const list = parseEastmoneyHistoryList(data);
    if (list.length === 0) return null;

    // Sort by date descending (newest first)
    const sortedList = list.sort((a, b) => new Date(b.FSRQ).getTime() - new Date(a.FSRQ).getTime());

    // Find the NAV on or before the target date (the confirmation date should not be later than the target date)
    const targetTime = target.getTime();
    for (const item of sortedList) {
      const itemDate = new Date(item.FSRQ + "T00:00:00Z");
      // Pick the NAV of the nearest trading day on or before the target date
      if (itemDate.getTime() <= targetTime) {
        return {
          date: item.FSRQ,
          nav: parseFloat(item.DWJZ),
          cumNav: parseFloat(item.LJJZ),
        };
      }
    }

    // If no NAV exists before the target date, return the closest one (the newest)
    const closest = sortedList[0];
    if (closest) {
      return {
        date: closest.FSRQ,
        nav: parseFloat(closest.DWJZ),
        cumNav: parseFloat(closest.LJJZ),
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Unified fund NAV query.
 * Prefers the account-configured default API; otherwise tries all active APIs by priority.
 */
export async function queryFundNav(
  fundCode: string,
  dateStr?: string,
  accountId?: string,
): Promise<NavResult> {
  let account:
    | {
        defaultFundQueryApiId: string | null;
        householdId: string | null;
        Institution: { name: string; shortName: string | null; type: string | null } | null;
      }
    | null = null;
  if (accountId) {
    account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        defaultFundQueryApiId: true,
        householdId: true,
        Institution: { select: { name: true, shortName: true, type: true } },
      },
    });
  }

  // Get the list of active APIs
  const activeApis = await getActiveApis(account?.householdId);
  if (activeApis.length === 0) return null;

  // Priority: account default API > account institution scenario > global priority order
  let orderedApis = activeApis;
  if (account?.defaultFundQueryApiId) {
    orderedApis = moveApiToFront(orderedApis, (api) => api.id === account!.defaultFundQueryApiId);
  } else if (account?.Institution) {
    const institutionText = `${account.Institution.name} ${account.Institution.shortName ?? ""}`;
    if (isAlipayInstitutionText(institutionText)) {
      orderedApis = moveApiToFront(orderedApis, (api) => /alipay|支付宝|蚂蚁/i.test(`${api.code} ${api.name}`));
    }
  }

  // Try at most three valid APIs after account and institution priority rules are applied.
  const candidateApis = orderedApis
    .filter((api) => PARSERS[api.code] && (!dateStr || api.baseUrl.includes("{date}")))
    .slice(0, MAX_FUND_QUERY_API_ATTEMPTS);

  for (const api of candidateApis) {
    const parser = PARSERS[api.code]!;

    let url = api.baseUrl;
    url = url.replaceAll("{code}", fundCode);
    if (dateStr) url = url.replaceAll("{date}", dateStr);

    const result = await fetchFromUrl(url, parser);
    if (result) return result;
  }

  // Exact-date query failed; use the wider-range fallback only if it fits the same request budget.
  if (dateStr && candidateApis.length < MAX_FUND_QUERY_API_ATTEMPTS) {
    const historicalResult = await queryHistoricalNav(fundCode, dateStr);
    if (historicalResult) return historicalResult;
  }

  return null;
}
