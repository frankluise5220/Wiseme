import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { computeStockHoldingsAsOfDate, recalcStockPositions } from "@/lib/stock/recalcPosition";

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

async function assertStockAccount(accountId: string, householdId: string) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, kind: "investment", investProductType: "stock" },
    select: { id: true, currency: true },
  });
  if (!account) throw new Error("股票账户不存在或不属于当前账簿");
  return account;
}

/**
 * GET /api/v1/stocks/holdings
 * Lists stock holdings for one stock account.
 *
 * Query:
 * - accountId: string
 * - includeZero?: "1"
 * - tradeDate?: YYYY-MM-DD; returns positive holdings as of that trade date
 *
 * Response:
 * - { ok: true, data: { holdings, totalMarketValue, totalCost, floatingPnL } }
 */
export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const accountId = req.nextUrl.searchParams.get("accountId")?.trim() || "";
    if (!accountId) return NextResponse.json({ ok: false, code: "MISSING_STOCK_ACCOUNT", error: "缺少股票账户" }, { status: 400, headers: corsHeaders() });
    const account = await assertStockAccount(accountId, householdId);
    const includeZero = req.nextUrl.searchParams.get("includeZero") === "1";
    const tradeDateRaw = req.nextUrl.searchParams.get("tradeDate")?.trim() || "";
    const asOfDate = tradeDateRaw && /^\d{4}-\d{2}-\d{2}$/.test(tradeDateRaw)
      ? new Date(`${tradeDateRaw}T00:00:00.000Z`)
      : null;
    if (tradeDateRaw && !asOfDate) {
      return NextResponse.json({ ok: false, code: "INVALID_TRADE_DATE", error: "交易日期无效" }, { status: 400, headers: corsHeaders() });
    }

    if (asOfDate) {
      const rows = await computeStockHoldingsAsOfDate(accountId, asOfDate);
      const holdings = rows.map((item) => ({
        id: item.securityId,
        accountId,
        securityId: item.securityId,
        market: item.market,
        stockCode: item.stockCode,
        stockName: item.stockName,
        quantity: item.quantity,
        avgCost: 0,
        cost: 0,
        latestPrice: null,
        marketValue: 0,
        floatingPnL: 0,
        floatingPnLRate: 0,
        historicalProfit: 0,
      }));
      return NextResponse.json({
        ok: true,
        data: {
          accountId,
          currency: account.currency,
          holdings,
          totalMarketValue: 0,
          totalCost: 0,
          floatingPnL: 0,
        },
      }, { headers: corsHeaders() });
    }

    const rows = await prisma.stockHolding.findMany({
      where: {
        householdId,
        accountId,
        ...(includeZero ? {} : { quantity: { gt: 0 } }),
      },
      orderBy: [{ market: "asc" }, { stockCode: "asc" }],
    });
    const holdings = rows.map((item) => {
      const cost = toNumber(item.cost);
      const marketValue = toNumber(item.marketValue);
      const floatingPnL = marketValue - cost;
      return {
        id: item.id,
        accountId: item.accountId,
        securityId: item.securityId,
        market: item.market,
        stockCode: item.stockCode,
        stockName: item.stockName,
        quantity: toNumber(item.quantity),
        avgCost: toNumber(item.avgCost),
        cost,
        latestPrice: item.latestPrice == null ? null : toNumber(item.latestPrice),
        latestPriceDate: item.latestPriceDate ? item.latestPriceDate.toISOString().slice(0, 10) : null,
        marketValue,
        floatingPnL,
        floatingPnLRate: cost > 0 ? floatingPnL / cost : 0,
        historicalProfit: toNumber(item.historicalProfit),
      };
    });
    const totalMarketValue = holdings.reduce((sum, item) => sum + item.marketValue, 0);
    const totalCost = holdings.reduce((sum, item) => sum + item.cost, 0);

    return NextResponse.json({
      ok: true,
      data: {
        accountId,
        currency: account.currency,
        holdings,
        totalMarketValue,
        totalCost,
        floatingPnL: totalMarketValue - totalCost,
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "查询失败" }, { status: 500, headers: corsHeaders() });
  }
}

/**
 * POST /api/v1/stocks/holdings
 * Recalculates stock holdings for one stock account.
 *
 * Body:
 * - accountId: string
 * - securityIds?: string[]
 *
 * Response:
 * - { ok: true, data: { accountId } }
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json();
    const accountId = String(body.accountId ?? "").trim();
    if (!accountId) return NextResponse.json({ ok: false, code: "MISSING_STOCK_ACCOUNT", error: "缺少股票账户" }, { status: 400, headers: corsHeaders() });
    await assertStockAccount(accountId, householdId);
    const securityIds = Array.isArray(body.securityIds)
      ? body.securityIds.map((item) => String(item ?? "").trim()).filter(Boolean)
      : undefined;
    await recalcStockPositions(accountId, securityIds);
    return NextResponse.json({ ok: true, data: { accountId } }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "RECALC_FAILED", error: error instanceof Error ? error.message : "重算失败" }, { status: 500, headers: corsHeaders() });
  }
}
