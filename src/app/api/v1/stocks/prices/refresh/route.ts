import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { queryStockLatestClosePrice } from "@/lib/stock/queryApi";
import { recalcStockPositions } from "@/lib/stock/recalcPosition";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

function dateOnlyUtc(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

async function assertStockAccount(accountId: string, householdId: string) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, kind: "investment", investProductType: "stock" },
    select: { id: true },
  });
  if (!account) throw new Error("股票账户不存在或不属于当前账簿");
  return account;
}

function serializeHolding(item: {
  id: string;
  accountId: string;
  securityId: string;
  market: string;
  stockCode: string;
  stockName?: string | null;
  quantity: unknown;
  avgCost: unknown;
  cost: unknown;
  latestPrice?: unknown | null;
  latestPriceDate?: Date | null;
  marketValue: unknown;
  historicalProfit: unknown;
}) {
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
}

/**
 * POST /api/v1/stocks/prices/refresh
 * Fetches latest closing prices for stock holdings, writes StockPriceCache, then recalculates StockHolding.
 *
 * Body:
 * - accountId: stock account id
 * - securityIds?: optional held security ids to refresh; omitted refreshes all positive holdings
 *
 * Response:
 * - { ok: true, data: { refreshed, failed, prices, holdings, totalMarketValue, totalCost, floatingPnL } }
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as { accountId?: unknown; securityIds?: unknown } | null;
    const accountId = String(body?.accountId ?? "").trim();
    if (!accountId) return NextResponse.json({ ok: false, error: "缺少股票账户" }, { status: 400, headers: corsHeaders() });
    await assertStockAccount(accountId, householdId);

    const securityIds = Array.isArray(body?.securityIds)
      ? body.securityIds.map((item) => String(item ?? "").trim()).filter(Boolean)
      : [];

    const holdings = await prisma.stockHolding.findMany({
      where: {
        householdId,
        accountId,
        quantity: { gt: 0 },
        ...(securityIds.length > 0 ? { securityId: { in: securityIds } } : {}),
      },
      include: { StockSecurity: { select: { exchange: true } } },
      orderBy: [{ market: "asc" }, { stockCode: "asc" }],
    });

    const prices: Array<{
      securityId: string;
      market: string;
      stockCode: string;
      closePrice: number;
      priceDate: string;
      source: string;
    }> = [];
    const failed: Array<{ securityId: string; stockCode: string; error: string }> = [];

    for (const holding of holdings) {
      const price = await queryStockLatestClosePrice(holding.market, holding.stockCode, holding.StockSecurity?.exchange);
      if (!price) {
        failed.push({ securityId: holding.securityId, stockCode: holding.stockCode, error: "未获取到收盘价" });
        continue;
      }
      await prisma.stockPriceCache.upsert({
        where: {
          market_stockCode_priceDate: {
            market: price.market,
            stockCode: price.stockCode,
            priceDate: dateOnlyUtc(price.priceDate),
          },
        },
        create: {
          securityId: holding.securityId,
          market: price.market,
          stockCode: price.stockCode,
          priceDate: dateOnlyUtc(price.priceDate),
          closePrice: String(price.closePrice),
          currency: price.currency,
          source: price.source,
        },
        update: {
          securityId: holding.securityId,
          closePrice: String(price.closePrice),
          currency: price.currency,
          source: price.source,
        },
      });
      prices.push({
        securityId: holding.securityId,
        market: price.market,
        stockCode: price.stockCode,
        closePrice: price.closePrice,
        priceDate: price.priceDate,
        source: price.source,
      });
    }

    const refreshedSecurityIds = prices.map((item) => item.securityId);
    if (refreshedSecurityIds.length > 0) {
      await recalcStockPositions(accountId, refreshedSecurityIds);
      revalidateAfterInvestChange();
    }

    const nextHoldings = await prisma.stockHolding.findMany({
      where: {
        householdId,
        accountId,
        quantity: { gt: 0 },
      },
      orderBy: [{ market: "asc" }, { stockCode: "asc" }],
    });
    const serializedHoldings = nextHoldings.map(serializeHolding);
    const totalMarketValue = serializedHoldings.reduce((sum, item) => sum + item.marketValue, 0);
    const totalCost = serializedHoldings.reduce((sum, item) => sum + item.cost, 0);

    return NextResponse.json({
      ok: true,
      data: {
        accountId,
        refreshed: prices.length,
        failed,
        prices,
        holdings: serializedHoldings,
        totalMarketValue,
        totalCost,
        floatingPnL: totalMarketValue - totalCost,
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "获取收盘价失败" },
      { status: 500, headers: corsHeaders() },
    );
  }
}
