import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import {
  defaultStockCurrencyForMarket,
  inferStockExchangeFromCode,
  inferStockMarketFromCode,
  normalizeStockCode,
  normalizeStockMarket,
} from "@/lib/stock/market";
import { queryStockIdentity } from "@/lib/stock/queryApi";

type TxClient = Prisma.TransactionClient | typeof prisma;

export { inferStockExchangeFromCode, inferStockMarketFromCode, normalizeStockCode, normalizeStockMarket } from "@/lib/stock/market";

type StockSecurityLookupItem = {
  id: string;
  market: string;
  stockCode: string;
  stockName: string | null;
  currency: string | null;
  exchange: string | null;
};

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function hasUsableStockName(value: unknown, stockCode: string) {
  const name = String(value ?? "").trim();
  return Boolean(name && name !== stockCode);
}

export function normalizeUsableStockName(value: unknown, stockCode: string) {
  const name = String(value ?? "").trim();
  return hasUsableStockName(name, stockCode) ? name : null;
}

async function findLocalStockName(client: TxClient, householdId: string, market: string, stockCode: string) {
  const holding = await client.stockHolding.findFirst({
    where: { householdId, market, stockCode, stockName: { not: null } },
    orderBy: { updatedAt: "desc" },
    select: { stockName: true },
  });
  if (hasUsableStockName(holding?.stockName, stockCode)) return String(holding?.stockName).trim();

  const transaction = await client.stockTransaction.findFirst({
    where: { householdId, market, stockCode, deletedAt: null, stockName: { not: null } },
    orderBy: [{ tradeDate: "desc" }, { updatedAt: "desc" }],
    select: { stockName: true },
  });
  if (hasUsableStockName(transaction?.stockName, stockCode)) return String(transaction?.stockName).trim();

  return null;
}

function toLookupItem(security: {
  id: string;
  market: string;
  stockCode: string;
  stockName: string | null;
  currency: string | null;
  exchange: string | null;
}): StockSecurityLookupItem {
  return {
    id: security.id,
    market: security.market,
    stockCode: security.stockCode,
    stockName: security.stockName,
    currency: security.currency,
    exchange: security.exchange,
  };
}

export async function resolveOrCreateStockSecurity(
  client: TxClient,
  params: {
    householdId: string;
    market: string;
    stockCode: string;
    stockName?: string | null;
    currency?: string | null;
    exchange?: string | null;
  },
) {
  const market = normalizeStockMarket(params.market);
  const stockCode = normalizeStockCode(params.stockCode);
  const explicitStockName = normalizeUsableStockName(params.stockName, stockCode);
  const explicitCurrency = String(params.currency ?? "").trim().toUpperCase();
  const explicitExchange = String(params.exchange ?? "").trim().toUpperCase();

  if (!stockCode) throw new Error("Stock code is required");

  const existing = await client.stockSecurity.findUnique({
    where: {
      householdId_market_stockCode: {
        householdId: params.householdId,
        market,
        stockCode,
      },
    },
  });
  // The name uses existing data in the table first: an explicitly passed name, or a name already saved in StockSecurity that differs from the code, both count as usable.
  // Only when no usable name exists at all (first purchase with no historical name) do we query the external stock lookup API.
  const explicitNameUsable = Boolean(explicitStockName);
  const storedNameUsable = Boolean(existing?.stockName && existing.stockName !== stockCode);
  const shouldQueryIdentity = !explicitNameUsable && !storedNameUsable;
  const identity = shouldQueryIdentity ? await queryStockIdentity(market, stockCode) : null;
  const stockName = explicitStockName || identity?.stockName || existing?.stockName || stockCode;
  const currency = explicitCurrency || identity?.currency || existing?.currency || defaultStockCurrencyForMarket(market);
  const exchange = explicitExchange || identity?.exchange || existing?.exchange || inferStockExchangeFromCode(market, stockCode);

  if (existing) {
    return client.stockSecurity.update({
      where: { id: existing.id },
      data: {
        stockName,
        currency,
        exchange,
        isActive: true,
      },
    });
  }

  try {
    return await client.stockSecurity.create({
      data: {
        householdId: params.householdId,
        market,
        stockCode,
        stockName,
        currency,
        exchange,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const createdByConcurrentLookup = await client.stockSecurity.findUnique({
      where: {
        householdId_market_stockCode: {
          householdId: params.householdId,
          market,
          stockCode,
        },
      },
    });
    if (!createdByConcurrentLookup) throw error;
    return client.stockSecurity.update({
      where: { id: createdByConcurrentLookup.id },
      data: {
        stockName: explicitStockName || identity?.stockName || createdByConcurrentLookup.stockName || stockCode,
        currency: explicitCurrency || identity?.currency || createdByConcurrentLookup.currency || defaultStockCurrencyForMarket(market),
        exchange: explicitExchange || identity?.exchange || createdByConcurrentLookup.exchange || inferStockExchangeFromCode(market, stockCode),
        isActive: true,
      },
    });
  }
}

/**
 * Lookup a stock security by code with local-first resolution.
 *
 * The lookup checks StockSecurity first, then local holdings and transactions,
 * and falls back to the external identity API only when localOnly is not set.
 */
export async function getStockSecurityByCode(
  client: TxClient,
  params: {
    householdId: string;
    market?: string;
    stockCode: string;
    localOnly?: boolean;
  },
): Promise<StockSecurityLookupItem | null> {
  const stockCode = normalizeStockCode(params.stockCode);
  const market = params.market ? normalizeStockMarket(params.market) : inferStockMarketFromCode(stockCode);
  if (!stockCode) return null;

  let security = await client.stockSecurity.findFirst({
    where: { householdId: params.householdId, market, stockCode, isActive: true },
  });

  if (!hasUsableStockName(security?.stockName, stockCode)) {
    const localStockName = await findLocalStockName(client, params.householdId, market, stockCode);
    if (localStockName) {
      security = await resolveOrCreateStockSecurity(client, {
        householdId: params.householdId,
        market,
        stockCode,
        stockName: localStockName,
        currency: security?.currency,
        exchange: security?.exchange,
      });
    }
  }

  if (!hasUsableStockName(security?.stockName, stockCode) && !params.localOnly) {
    const identity = await queryStockIdentity(market, stockCode);
    if (identity?.stockName && identity.stockName !== stockCode) {
      security = await resolveOrCreateStockSecurity(client, {
        householdId: params.householdId,
        market: identity.market,
        stockCode: identity.stockCode,
        stockName: identity.stockName,
        currency: identity.currency,
        exchange: identity.exchange,
      });
    }
  }

  return security ? toLookupItem(security) : null;
}
