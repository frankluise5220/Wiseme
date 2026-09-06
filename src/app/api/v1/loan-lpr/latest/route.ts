import { NextResponse } from "next/server";

import { FIVE_YEAR_LPR_HISTORY } from "@/lib/loan-lpr";

export const runtime = "nodejs";

/**
 * GET /api/v1/loan-lpr/latest
 *
 * Returns the latest 5-year LPR quote for the "查询新LPR" button in the
 * loan rate-adjustment dialog. Live source is ChinaMoney (official LPR
 * publisher); falls back to the built-in static table when the network
 * fetch fails. Results are cached in memory for 6 hours (LPR quotes are
 * published monthly on the 20th), so repeated clicks do not refetch.
 *
 * Success: { ok: true, data: { date, rate, source } }
 * - source: "chinamoney" (live quote) | "static" (built-in fallback)
 */

const CHINAMONEY_LPR_URL = "https://www.chinamoney.com.cn/ags/ms/cm-u-bk-currency/LprHis?lang=CN&reference=1,yesterday";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type LprLatestResult = {
  date: string;
  rate: number;
  source: "chinamoney" | "static";
};

let cached: { result: LprLatestResult; fetchedAt: number } | null = null;

function parseDateOnly(value: unknown) {
  const text = String(value ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function parseRate(value: unknown) {
  const rate = Number(String(value ?? "").trim());
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function parseRate5y(record: Record<string, unknown>) {
  return parseRate(record["5Y"]) ?? parseRate(record.fiveYearRate) ?? parseRate(record.lpr5y);
}

async function fetchLatestLprFromChinaMoney(): Promise<LprLatestResult | null> {
  try {
    const response = await fetch(CHINAMONEY_LPR_URL, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Referer: "https://www.chinamoney.com.cn/chinese/bklpr/",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { records?: Array<Record<string, unknown>> } | null;
    const records = Array.isArray(payload?.records) ? payload.records : [];
    for (const record of records) {
      const date = parseDateOnly(record.showDateCN ?? record.date);
      if (!date) continue;
      const rate = parseRate5y(record);
      if (rate != null) return { date, rate, source: "chinamoney" };
    }
    return null;
  } catch {
    return null;
  }
}

function staticLatestLpr(): LprLatestResult {
  const latest = FIVE_YEAR_LPR_HISTORY[FIVE_YEAR_LPR_HISTORY.length - 1]!;
  return { date: latest.date, rate: latest.fiveYearRate, source: "static" };
}

export async function GET() {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return NextResponse.json({ ok: true, data: cached.result });
  }
  const live = await fetchLatestLprFromChinaMoney();
  const result = live ?? staticLatestLpr();
  // Only successful live fetches get the full TTL; a static fallback may be
  // retried sooner (after 1 minute) in case the network hiccup was transient.
  cached = { result, fetchedAt: now - (live ? 0 : CACHE_TTL_MS - 60_000) };
  return NextResponse.json({ ok: true, data: result });
}
