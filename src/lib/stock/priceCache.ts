import { Prisma } from "@prisma/client";

import { formatDateUtc, parseDateInputToUtc, parseFlexibleDateToYmd, toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import {
  inferStockExchangeFromCode,
  inferStockMarketFromCode,
  normalizeStockCode,
  normalizeStockMarket,
} from "@/lib/stock/market";
import { queryStockClosePriceByDate, queryStockClosePriceList } from "@/lib/stock/queryApi";

type TxClient = Prisma.TransactionClient | typeof prisma;

export type StockClosePriceLookupItem = {
  market: string;
  stockCode: string;
  closePrice: number;
  priceDate: string;
  currency: string;
  exchange?: string | null;
  source: string;
};

function parseDateOnly(value: unknown) {
  const ymd = parseFlexibleDateToYmd(value);
  return ymd ? parseDateInputToUtc(ymd) : null;
}

function dateOnlyUtc(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function toLookupItem(row: {
  market: string;
  stockCode: string;
  closePrice: unknown;
  priceDate: Date;
  currency: string;
  source: string;
}): StockClosePriceLookupItem {
  return {
    market: row.market,
    stockCode: row.stockCode,
    closePrice: toNumber(row.closePrice),
    priceDate: formatDateUtc(row.priceDate),
    currency: row.currency,
    source: row.source,
  };
}

export async function getStockClosePriceByDate(
  client: TxClient,
  params: {
    market?: string;
    stockCode: string;
    priceDate: string | Date;
    securityId?: string | null;
    exchange?: string | null;
  },
): Promise<StockClosePriceLookupItem | null> {
  const stockCode = normalizeStockCode(params.stockCode);
  const market = params.market ? normalizeStockMarket(params.market) : inferStockMarketFromCode(stockCode);
  const targetDate = parseDateOnly(params.priceDate);
  if (!stockCode || !targetDate) return null;

  const cached = await client.stockPriceCache.findFirst({
    where: {
      market,
      stockCode,
      priceDate: targetDate,
    },
  });
  if (cached) return toLookupItem(cached);

  const external = await queryStockClosePriceByDate(
    market,
    stockCode,
    formatDateUtc(targetDate),
    params.exchange ?? inferStockExchangeFromCode(market, stockCode),
  );
  if (!external) return null;

  const priceDate = dateOnlyUtc(external.priceDate);
  await client.stockPriceCache.upsert({
    where: {
      market_stockCode_priceDate: {
        market: external.market,
        stockCode: external.stockCode,
        priceDate,
      },
    },
    create: {
      ...(params.securityId ? { securityId: params.securityId } : {}),
      market: external.market,
      stockCode: external.stockCode,
      priceDate,
      closePrice: String(external.closePrice),
      currency: external.currency,
      source: external.source,
    },
    update: {
      ...(params.securityId ? { securityId: params.securityId } : {}),
      closePrice: String(external.closePrice),
      currency: external.currency,
      source: external.source,
    },
  });

  return external;
}

export type RefreshHeldStockClosePricesResult = {
  checked: number;
  refreshed: number;
  failed: number;
  securityIds: string[];
};

function ymdUtc(value: Date) {
  return value.toISOString().slice(0, 10);
}

/**
 * Refresh daily closing prices for currently held stocks, from the last cached
 * price date (or a bounded lookback) up to today. Writes each trading-day close
 * into StockPriceCache so holdings can show the latest close with its date.
 */
export async function refreshHeldStockClosePrices(options: {
  householdId?: string;
  accountId?: string;
}): Promise<RefreshHeldStockClosePricesResult> {
  const householdId = options.householdId?.trim();
  const accountId = options.accountId?.trim();
  if (!householdId && !accountId) {
    throw new Error("refreshHeldStockClosePrices requires householdId or accountId");
  }

  const holdings = await prisma.stockHolding.findMany({
    where: {
      ...(accountId ? { accountId } : {}),
      quantity: { gt: 0 },
      ...(householdId ? { householdId } : {}),
    },
    select: {
      accountId: true,
      securityId: true,
      market: true,
      stockCode: true,
      StockSecurity: { select: { exchange: true } },
    },
    orderBy: [{ market: "asc" }, { stockCode: "asc" }],
  });

  let refreshed = 0;
  let failed = 0;
  const securityIds = new Set<string>();

  for (const holding of holdings) {
    const stockCode = holding.stockCode.trim();
    if (!stockCode) continue;
    securityIds.add(holding.securityId);
    try {
      const lastCached = await prisma.stockPriceCache.findFirst({
        where: { market: holding.market, stockCode: holding.stockCode },
        orderBy: { priceDate: "desc" },
        select: { priceDate: true },
      });

      // Start from the day after the last cached date, bounded to a 60-day lookback.
      const today = new Date();
      const todayStr = ymdUtc(today);
      let startStr: string;
      if (lastCached?.priceDate) {
        const next = new Date(lastCached.priceDate.getTime() + 24 * 60 * 60 * 1000);
        startStr = ymdUtc(next);
      } else {
        const lookback = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000);
        startStr = ymdUtc(lookback);
      }
      if (startStr > todayStr) continue;

      const list = await queryStockClosePriceList(
        holding.market,
        holding.stockCode,
        startStr,
        todayStr,
        holding.StockSecurity?.exchange,
      );
      if (!list || list.items.length === 0) continue;

      for (const item of list.items) {
        await prisma.stockPriceCache.upsert({
          where: {
            market_stockCode_priceDate: {
              market: list.market,
              stockCode: list.stockCode,
              priceDate: new Date(`${item.priceDate}T00:00:00.000Z`),
            },
          },
          create: {
            securityId: holding.securityId,
            market: list.market,
            stockCode: list.stockCode,
            priceDate: new Date(`${item.priceDate}T00:00:00.000Z`),
            closePrice: String(item.closePrice),
            currency: list.currency,
            source: list.source,
          },
          update: {
            securityId: holding.securityId,
            closePrice: String(item.closePrice),
            currency: list.currency,
            source: list.source,
          },
        });
      }
      refreshed++;
    } catch {
      failed++;
    }
  }

  return {
    checked: holdings.length,
    refreshed,
    failed,
    securityIds: [...securityIds],
  };
}