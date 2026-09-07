import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db/prisma";
import { isTradingClosedDate } from "@/lib/date-utils";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { inferStockExchangeFromCode, normalizeStockCode, normalizeStockMarket } from "@/lib/stock/market";
import { queryStockClosePriceList } from "@/lib/stock/queryApi";

export const runtime = "nodejs";

/**
 * POST /api/v1/stocks/prices/missing
 *
 * Backfills historical close prices into StockPriceCache for stock codes held
 * in the current household. Mainly used by the investment income report when
 * a held stock is missing the close on a snapshot date.
 *
 * Body:
 *   { items: [{ market, stockCode, date, accountId? }] }
 *
 * Success:
 *   { ok: true, requested, stockCount, fetched, written, failed, resolvedItems, unresolvedItems, skippedClosed }
 */
type MissingPriceItem = {
  market?: unknown;
  stockCode?: unknown;
  date?: unknown;
  accountId?: unknown;
};

type PriceRangeRequest = {
  market: string;
  stockCode: string;
  startDate: string;
  endDate: string;
};

type MissingPriceRequest = {
  market: string;
  stockCode: string;
  date: string;
  accountId?: string;
};

function cleanYmd(value: unknown) {
  const text = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function cleanOptionalId(value: unknown) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 128) : undefined;
}

function normalizeRequests(body: { items?: MissingPriceItem[] }): MissingPriceRequest[] {
  const requests: MissingPriceRequest[] = [];
  for (const item of Array.isArray(body.items) ? body.items : []) {
    const market = normalizeStockMarket(item.market);
    const stockCode = normalizeStockCode(item.stockCode);
    const date = cleanYmd(item.date);
    if (!market || !stockCode || !date) continue;
    requests.push({ market, stockCode, date, accountId: cleanOptionalId(item.accountId) });
  }
  // Oldest first so a stock's backfill range reaches as far back as possible.
  requests.sort((a, b) => a.date.localeCompare(b.date) || a.stockCode.localeCompare(b.stockCode));
  return requests.slice(0, 1000);
}

function utcDate(dateStr: string) {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function requestKey(item: { market: string; stockCode: string; date: string }) {
  return `${item.market}|${item.stockCode}|${item.date}`;
}

async function resolveExactRequestStatus(requests: Array<{ market: string; stockCode: string; date: string; accountId?: string }>) {
  if (requests.length === 0) return { resolvedItems: [], unresolvedItems: [] };
  const cachedRows = await prisma.stockPriceCache.findMany({
    where: {
      OR: requests.map((item) => ({
        market: item.market,
        stockCode: item.stockCode,
        priceDate: utcDate(item.date),
      })),
    },
    select: { market: true, stockCode: true, priceDate: true },
  });
  const resolvedKeys = new Set(cachedRows.map((row) => `${row.market}|${row.stockCode}|${ymd(row.priceDate)}`));
  const resolvedItems: Array<{ market: string; stockCode: string; date: string }> = [];
  const unresolvedItems: Array<{ market: string; stockCode: string; date: string }> = [];
  for (const item of requests) {
    if (resolvedKeys.has(requestKey(item))) resolvedItems.push(item);
    else unresolvedItems.push(item);
  }
  return { resolvedItems, unresolvedItems };
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const requests = normalizeRequests(body);
    if (requests.length === 0) {
      return NextResponse.json({ ok: false, code: "MISSING_PRICE_DATES", error: "Missing stock price dates." }, { status: 400 });
    }

    const codes = Array.from(new Set(requests.map((item) => item.stockCode)));
    const [txCodes, holdingCodes] = await Promise.all([
      prisma.stockTransaction.findMany({
        where: { householdId: ctx.householdId, deletedAt: null, stockCode: { in: codes } },
        select: { stockCode: true },
        distinct: ["stockCode"],
      }),
      prisma.stockHolding.findMany({
        where: { householdId: ctx.householdId, stockCode: { in: codes } },
        select: { stockCode: true },
        distinct: ["stockCode"],
      }),
    ]);
    const householdCodes = new Set([
      ...txCodes.map((row) => row.stockCode),
      ...holdingCodes.map((row) => row.stockCode),
    ]);
    const allowed = requests.filter((item) => householdCodes.has(item.stockCode));
    if (allowed.length === 0) {
      return NextResponse.json({ ok: false, code: "NO_ELIGIBLE_STOCK_CODES", error: "No eligible stock codes in current ledger." }, { status: 403 });
    }

    // Exact-date requests on closed trading days can never have a close.
    const tradable = allowed.filter((item) => !isTradingClosedDate(item.date, "cn_fund"));
    const skippedClosed = allowed.length - tradable.length;
    if (tradable.length === 0) {
      return NextResponse.json({
        ok: true,
        requested: allowed.length,
        stockCount: 0,
        fetched: 0,
        written: 0,
        failed: 0,
        resolvedItems: [],
        unresolvedItems: [],
        resolved: 0,
        unresolved: 0,
        skippedClosed,
      });
    }

    // Collapse exact dates into one contiguous range per stock so each stock
    // needs a single kline call.
    const rangeByStock = new Map<string, PriceRangeRequest>();
    for (const item of tradable) {
      const key = `${item.market}|${item.stockCode}`;
      const range = rangeByStock.get(key);
      if (!range) {
        rangeByStock.set(key, { market: item.market, stockCode: item.stockCode, startDate: item.date, endDate: item.date });
      } else {
        if (item.date < range.startDate) range.startDate = item.date;
        if (item.date > range.endDate) range.endDate = item.date;
      }
    }

    let fetched = 0;
    let written = 0;
    let failed = 0;
    for (const range of rangeByStock.values()) {
      try {
        const list = await queryStockClosePriceList(
          range.market,
          range.stockCode,
          range.startDate,
          range.endDate,
          inferStockExchangeFromCode(range.market, range.stockCode),
        );
        if (!list || list.items.length === 0) {
          failed += 1;
          continue;
        }
        fetched += list.items.length;
        for (const item of list.items) {
          await prisma.stockPriceCache.upsert({
            where: {
              market_stockCode_priceDate: {
                market: list.market,
                stockCode: list.stockCode,
                priceDate: utcDate(item.priceDate),
              },
            },
            create: {
              market: list.market,
              stockCode: list.stockCode,
              priceDate: utcDate(item.priceDate),
              closePrice: String(item.closePrice),
              currency: list.currency,
              source: list.source,
            },
            update: {
              closePrice: String(item.closePrice),
              currency: list.currency,
              source: list.source,
            },
          });
          written += 1;
        }
      } catch {
        failed += 1;
      }
    }

    const exactStatus = await resolveExactRequestStatus(tradable);
    console.info("[stock-price-missing] refresh result", {
      requested: requests.length,
      allowed: allowed.length,
      stockCount: rangeByStock.size,
      fetched,
      written,
      failed,
      resolved: exactStatus.resolvedItems.length,
      unresolved: exactStatus.unresolvedItems.length,
      skippedClosed,
    });
    if (written > 0) {
      revalidateAfterInvestChange();
      revalidatePath("/reports");
    }

    return NextResponse.json({
      ok: true,
      requested: allowed.length,
      stockCount: rangeByStock.size,
      fetched,
      written,
      failed,
      ...exactStatus,
      resolved: exactStatus.resolvedItems.length,
      unresolved: exactStatus.unresolvedItems.length,
      skippedClosed,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "Failed to fetch missing stock prices." },
      { status: 500 },
    );
  }
}
