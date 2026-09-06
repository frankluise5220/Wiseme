import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { normalizeCurrency } from "@/lib/currency";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { getStockSecurityByCode, inferStockMarketFromCode, normalizeStockCode, normalizeStockMarket, resolveOrCreateStockSecurity } from "@/lib/stock/securities";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

/**
 * GET /api/v1/stocks/securities
 * Lists stock securities for the current household.
 *
 * Query:
 * - market?: string; omitted exact lookups infer market from code
 * - code?: exact stock code. Exact lookup first checks local stock data and
 *   then falls back to the stock identity API unless localOnly=1 is supplied.
 * - localOnly?: "1" keeps exact lookup inside StockSecurity, holdings, and transactions.
 * - q?: string matches stock code or name
 *
 * Response:
 * - exact lookup: { ok: true, data: { security } }
 * - list lookup: { ok: true, data: { securities: [{ id, market, stockCode, stockName, currency, exchange }] } }
 */
export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const marketRaw = req.nextUrl.searchParams.get("market")?.trim() || "";
    const codeRaw = req.nextUrl.searchParams.get("code")?.trim() || "";
    const q = req.nextUrl.searchParams.get("q")?.trim() || "";
    const localOnly = req.nextUrl.searchParams.get("localOnly") === "1";
    const market = marketRaw ? normalizeStockMarket(marketRaw) : (codeRaw ? inferStockMarketFromCode(codeRaw) : "");

    if (codeRaw) {
      const security = await getStockSecurityByCode(prisma, {
        householdId,
        market,
        stockCode: codeRaw,
        localOnly,
      });

      return NextResponse.json({
        ok: true,
        data: {
          security,
        },
      }, { headers: corsHeaders() });
    }

    const rows = await prisma.stockSecurity.findMany({
      where: {
        householdId,
        isActive: true,
        ...(market ? { market } : {}),
        ...(q
          ? {
              OR: [
                { stockCode: { contains: normalizeStockCode(q) } },
                { stockName: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: [{ market: "asc" }, { stockCode: "asc" }],
      take: 100,
    });

    return NextResponse.json({
      ok: true,
      data: {
        securities: rows.map((item) => ({
          id: item.id,
          market: item.market,
          stockCode: item.stockCode,
          stockName: item.stockName,
          currency: item.currency,
          exchange: item.exchange,
        })),
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "Fetch failed" }, { status: 500, headers: corsHeaders() });
  }
}

/**
 * POST /api/v1/stocks/securities
 * Creates or returns a stock security master record.
 *
 * Body:
 * - market?: string; omitted values are inferred from stockCode where possible
 * - stockCode: string
 * - stockName?: string
 * - currency?: string
 * - exchange?: string
 *
 * Response:
 * - { ok: true, data: { security } }
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json();
    const stockCode = normalizeStockCode(body.stockCode);
    const market = body.market ? normalizeStockMarket(body.market) : inferStockMarketFromCode(stockCode);
    const stockName = String(body.stockName ?? "").trim() || undefined;
    const currency = normalizeCurrency(body.currency);
    const exchange = String(body.exchange ?? "").trim() || null;

    if (!stockCode) return NextResponse.json({ ok: false, code: "STOCK_CODE_REQUIRED", error: "Stock code is required" }, { status: 400, headers: corsHeaders() });

    const security = await resolveOrCreateStockSecurity(prisma, {
      householdId,
      market,
      stockCode,
      stockName,
      currency,
      exchange,
    });

    return NextResponse.json({
      ok: true,
      data: {
        security: {
          id: security.id,
          market: security.market,
          stockCode: security.stockCode,
          stockName: security.stockName,
          currency: security.currency,
          exchange: security.exchange,
        },
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "CREATE_FAILED", error: error instanceof Error ? error.message : "Create failed" }, { status: 500, headers: corsHeaders() });
  }
}
