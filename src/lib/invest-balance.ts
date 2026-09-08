/**
 * Investment balance and holding display-layer calculations.
 *
 * Display-layer rule: fund display data is read from FundHolding, stocks from
 * StockHolding, and precious metals from PreciousMetalHolding. Each asset type
 * keeps its own data source so stocks/metals are never mixed into fund holdings.
 * Reading here never triggers recalculation, avoiding duplicate computation.
 */

import { prisma } from "@/lib/db/prisma";
import { cache } from "react";
import { toNumber } from "@/lib/date-utils";
import { AccountKind, FundCashFlowKind, FundSubtype, StockTransactionAction } from "@prisma/client";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { getEffectiveLatestFundNavMap } from "@/lib/fund/navCache";
import { getFundProfileNameMap, normalizeFundDisplayName } from "@/lib/fund/fundProfile";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { computeAccountDisplayBalances } from "@/lib/server/account-balance";
import { optionalPrismaFindMany } from "@/lib/server/optional-prisma-delegate";

export type InvestBalanceDetail = {
  marketValue: number;
  totalCost: number;
  floatingPnL: number;
};

/** Position detail display row — generated directly from the fundHolding table. */
export type PositionDisplayRow = {
  fundCode: string;
  accountId?: string | null;
  stockCode?: string | null;
  market?: string | null;
  securityId?: string | null;
  wealthProductId?: string | null;
  propertyAssetId?: string | null;
  assetType?: string | null;
  attributes?: unknown | null;
  propertyType?: string | null;
  address?: string | null;
  status?: string | null;
  purchasePrice?: number | null;
  note?: string | null;
  name: string;
  holdingDate: string;
  units: number;
  hasUnits?: boolean;
  avgCost: number;
  cost: number;
  nav: number | null;
  navDate: string;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
  pendingCost: number;
  historicalProfit: number;
};

export type ClearedPositionRow = {
  fundCode: string;
  accountId?: string | null;
  stockCode?: string | null;
  market?: string | null;
  securityId?: string | null;
  wealthProductId?: string | null;
  propertyAssetId?: string | null;
  name: string;
  units?: number;
  avgCost?: number;
  cost?: number;
  nav?: number | null;
  navDate?: string;
  marketValue?: number;
  floatingPnL?: number;
  floatingPnLRate?: number;
  historicalProfit: number;
  totalInvested: number;
  returnRate: number;
  firstBuyDate: string;
  clearedDate: string;
  totalBuyAmount: number;
  totalRedeemAmount: number;
};

export type PositionDisplayResult = {
  positions: PositionDisplayRow[];
  clearedPositions: ClearedPositionRow[];
  totalMarketValue: number;
  totalCost: number;
  positionHistoricalProfit: number;
  clearedHistoricalProfit: number;
  totalHistoricalProfit: number;
  cashBalance?: number;
  cashAccountId?: string | null;
  cashAccountName?: string | null;
  totalAssetValue?: number;
};

type PropertyAssetDisplayRow = {
  id: string;
  accountId: string;
  mortgageLoanAccountId?: string | null;
  name: string;
  status: string | null;
  assetType?: string | null;
  propertyType?: string | null;
  address?: string | null;
  attributes?: unknown | null;
  purchaseDate?: Date | null;
  purchasePrice?: unknown | null;
  cost: unknown;
  marketValue: unknown;
  latestValuationDate?: Date | null;
  note?: string | null;
  createdAt?: Date;
};

function isCashInSubtype(subtype: FundSubtype | string | null | undefined) {
  return subtype === FundSubtype.redeem || subtype === FundSubtype.switch_out || subtype === FundSubtype.dividend_cash;
}

function isDividendSubtype(subtype: FundSubtype | string | null | undefined) {
  return subtype === FundSubtype.dividend_cash;
}

function wealthProfitFromParts(params: {
  realizedProfit?: unknown;
  interest?: unknown;
  fee?: unknown;
}) {
  if (params.realizedProfit != null) return toNumber(params.realizedProfit);
  return toNumber(params.interest) - toNumber(params.fee);
}

function wealthDisplayCode(productName: string, productId?: string | null) {
  return productId || productName;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function holdingKey(accountId: string, fundCode: string) {
  return `${accountId}::${fundCode}`;
}

function dateOnlyString(value: Date | null | undefined) {
  return value ? value.toISOString().slice(0, 10) : "";
}

function stockFeeTotal(row: {
  fee?: unknown;
  commission?: unknown;
  stampTax?: unknown;
  transferFee?: unknown;
  exchangeFee?: unknown;
  regulatoryFee?: unknown;
  otherFee?: unknown;
}) {
  return toNumber(row.fee) +
    toNumber(row.commission) +
    toNumber(row.stampTax) +
    toNumber(row.transferFee) +
    toNumber(row.exchangeFee) +
    toNumber(row.regulatoryFee) +
    toNumber(row.otherFee);
}

function stockSellProceeds(row: { grossAmount?: unknown; netAmount?: unknown; fee?: unknown; commission?: unknown; stampTax?: unknown; transferFee?: unknown; exchangeFee?: unknown; regulatoryFee?: unknown; otherFee?: unknown }) {
  const grossAmount = Math.abs(toNumber(row.grossAmount));
  const netAmount = row.netAmount == null ? null : Math.abs(toNumber(row.netAmount));
  return netAmount ?? Math.max(0, grossAmount - stockFeeTotal(row));
}

function displayPendingAmount(row: {
  grossAmount: unknown;
  refundAmount: unknown;
  cashFlows: Array<{ kind: FundCashFlowKind | string; amount: unknown }>;
}) {
  const gross = Math.abs(toNumber(row.grossAmount));
  const refundByRow = Math.abs(toNumber(row.refundAmount));
  const refundByFlows = row.cashFlows
    .filter((flow) => flow.kind === FundCashFlowKind.refund_in)
    .reduce((sum, flow) => sum + Math.abs(toNumber(flow.amount)), 0);
  return Math.max(0, gross - Math.max(refundByRow, refundByFlows));
}

function isMissingStockHoldingsTableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("stock_holdings") && (
    message.includes("does not exist") ||
    message.includes("not exist") ||
    message.includes("P2021")
  );
}

async function loadStockHoldingsForInvestSummary(accountIds: string[]) {
  if (accountIds.length === 0) return [];
  try {
    return await prisma.stockHolding.findMany({
      where: { accountId: { in: accountIds } },
    });
  } catch (error) {
    if (isMissingStockHoldingsTableError(error)) return [];
    throw error;
  }
}

async function loadPropertyAssetsForInvestSummary(accountIds: string[]) {
  if (accountIds.length === 0) return [];
  return optionalPrismaFindMany<PropertyAssetDisplayRow>(
    prisma,
    "propertyAsset",
    {
      where: { accountId: { in: accountIds }, deletedAt: null },
      // The sidebar/overview summary only needs value fields. Keep this
      // query narrow so a newly added optional column cannot hide all fixed
      // assets while an older database is catching up.
      select: { accountId: true, status: true, cost: true, marketValue: true },
    },
    { tableNames: ["property_assets"] },
  );
}

async function loadPropertyAssetsForPositionDisplay(accountIds: string[], householdId?: string) {
  const ids = Array.from(new Set(accountIds.filter(Boolean)));
  if (ids.length === 0) return [];
  return optionalPrismaFindMany<PropertyAssetDisplayRow>(
    prisma,
    "propertyAsset",
    {
      where: { accountId: { in: ids }, ...(householdId ? { householdId } : {}), deletedAt: null },
      orderBy: [{ status: "asc" }, { latestValuationDate: "desc" }, { createdAt: "asc" }],
      // The fixed-asset table does not need every PropertyAsset column. Keep
      // this query narrow so a newly added optional column cannot hide all
      // positions while an older local database is catching up.
      select: {
        id: true,
        accountId: true,
        name: true,
        status: true,
        assetType: true,
        propertyType: true,
        address: true,
        attributes: true,
        purchaseDate: true,
        purchasePrice: true,
        cost: true,
        marketValue: true,
        latestValuationDate: true,
        note: true,
        createdAt: true,
      },
    },
    { tableNames: ["property_assets"] },
  );
}

function buildPropertyPositionDisplay(propertyAssets: PropertyAssetDisplayRow[]): PositionDisplayResult {
  const positions: PositionDisplayRow[] = propertyAssets
    .filter((asset) => asset.status !== "sold" && asset.status !== "disposed")
    .map((asset) => {
      const cost = toNumber(asset.cost);
      const marketValue = toNumber(asset.marketValue);
      const floatingPnL = marketValue - cost;
      return {
        fundCode: asset.id,
        accountId: asset.accountId,
        propertyAssetId: asset.id,
        mortgageLoanAccountId: asset.mortgageLoanAccountId ?? null,
        assetType: asset.assetType ?? null,
        propertyType: asset.propertyType ?? null,
        address: asset.address ?? null,
        attributes: asset.attributes ?? null,
        status: asset.status ?? "active",
        purchasePrice: asset.purchasePrice == null ? null : toNumber(asset.purchasePrice),
        note: asset.note ?? null,
        name: asset.name,
        holdingDate: asset.purchaseDate ? asset.purchaseDate.toISOString().slice(0, 10) : "",
        units: 0,
        hasUnits: false,
        avgCost: 0,
        cost,
        nav: null,
        navDate: asset.latestValuationDate ? asset.latestValuationDate.toISOString().slice(0, 10) : "",
        marketValue,
        floatingPnL,
        floatingPnLRate: cost > 0 ? floatingPnL / cost : 0,
        pendingCost: 0,
        historicalProfit: 0,
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue || a.name.localeCompare(b.name));
  const clearedPositions: ClearedPositionRow[] = propertyAssets
    .filter((asset) => asset.status === "sold" || asset.status === "disposed")
    .map((asset) => ({
      fundCode: asset.id,
      propertyAssetId: asset.id,
      name: asset.name,
      historicalProfit: toNumber(asset.marketValue) - toNumber(asset.cost),
      totalInvested: toNumber(asset.cost),
      returnRate: toNumber(asset.cost) > 0 ? (toNumber(asset.marketValue) - toNumber(asset.cost)) / toNumber(asset.cost) : 0,
      firstBuyDate: asset.purchaseDate ? asset.purchaseDate.toISOString().slice(0, 10) : "",
      clearedDate: asset.latestValuationDate ? asset.latestValuationDate.toISOString().slice(0, 10) : "",
      totalBuyAmount: toNumber(asset.cost),
      totalRedeemAmount: toNumber(asset.marketValue),
    }));
  const totalMarketValue = positions.reduce((sum, row) => sum + row.marketValue, 0);
  const totalCost = positions.reduce((sum, row) => sum + row.cost, 0);
  const positionHistoricalProfit = positions.reduce((sum, row) => sum + row.historicalProfit, 0);
  const clearedHistoricalProfit = clearedPositions.reduce((sum, row) => sum + row.historicalProfit, 0);
  const totalHistoricalProfit = positionHistoricalProfit + clearedHistoricalProfit;
  return { positions, clearedPositions, totalMarketValue, totalCost, positionHistoricalProfit, clearedHistoricalProfit, totalHistoricalProfit };
}

async function loadDisplayPendingCostByHoldingKey(ctx: HouseholdContext, accountIds: string[]) {
  const result = new Map<string, number>();
  if (accountIds.length === 0) return result;

  const pendingRows = await prisma.fundTransaction.findMany({
    where: {
      ...ctx.hidFilter,
      fundAccountId: { in: accountIds },
      fundSubtype: FundSubtype.buy,
      deletedAt: null,
      OR: [
        { units: null },
        { units: { lte: 0 } },
      ],
    },
    select: {
      fundAccountId: true,
      fundCode: true,
      grossAmount: true,
      refundAmount: true,
      cashFlows: {
        select: { kind: true, amount: true },
      },
    },
  });

  for (const row of pendingRows) {
    if (!row.fundAccountId || !row.fundCode) continue;
    const key = holdingKey(row.fundAccountId, row.fundCode);
    result.set(key, roundMoney((result.get(key) ?? 0) + displayPendingAmount(row)));
  }

  return result;
}

const WEALTH_PRINCIPAL_EPS = 0.01;
const WEALTH_UNITS_EPS = 0.000001;

export function isWealthHoldingCleared(hasUnits: boolean, principal: number, units: number) {
  return hasUnits
    ? principal <= WEALTH_PRINCIPAL_EPS || units <= WEALTH_UNITS_EPS
    : principal <= WEALTH_PRINCIPAL_EPS;
}

export function resetWealthHoldingBucket(bucket: { principal?: number; units?: number; remaining?: number; remainingUnits?: number; cycleHasUnits: boolean }) {
  if ("principal" in bucket) bucket.principal = 0;
  if ("units" in bucket) bucket.units = 0;
  if ("remaining" in bucket) bucket.remaining = 0;
  if ("remainingUnits" in bucket) bucket.remainingUnits = 0;
  bucket.cycleHasUnits = false;
}

/**
 * Compute balance summaries for all investment accounts (display layer).
 *
 * Data source: fundHolding table (maintained by recalcFundPositions on write).
 * Does not call recalcFundPositions here, so reads never trigger a full
 * recalculation.
 */
export const computeInvestBalances = cache(
  async (ctx: HouseholdContext): Promise<Map<string, InvestBalanceDetail>> => {
  const accounts = await prisma.account.findMany({
    where: { kind: AccountKind.investment, ...ctx.hidFilter },
    select: { id: true, kind: true, investProductType: true },
  });
  const investIds = accounts.filter(isPureInvestmentAccount).map(a => a.id);
  if (investIds.length === 0) return new Map();

  const metalAccountIds = accounts
    .filter((account) => isPureInvestmentAccount(account) && account.investProductType === "metal")
    .map((account) => account.id);
  const wealthAccountIds = accounts
    .filter((account) => isPureInvestmentAccount(account) && account.investProductType === "wealth")
    .map((account) => account.id);
  const stockAccountIds = accounts
    .filter((account) => isPureInvestmentAccount(account) && account.investProductType === "stock")
    .map((account) => account.id);
  const propertyAccountIds = accounts
    .filter((account) => isPureInvestmentAccount(account) && account.investProductType === "property")
    .map((account) => account.id);
  const nonFundAccountIds = new Set([...metalAccountIds, ...wealthAccountIds, ...stockAccountIds, ...propertyAccountIds]);
  const fundAccountIds = investIds.filter((id) => !nonFundAccountIds.has(id));

  const allHoldings = await prisma.fundHolding.findMany({
    where: { accountId: { in: fundAccountIds } },
  });
  const allMetalHoldings = await prisma.preciousMetalHolding.findMany({
    where: { accountId: { in: metalAccountIds } },
  });
  const allWealthTransactions = await prisma.wealthTransaction.findMany({
    where: { accountId: { in: wealthAccountIds }, deletedAt: null },
    include: { WealthProduct: true },
  });
  const allStockHoldings = await loadStockHoldingsForInvestSummary(stockAccountIds);
  const allPropertyAssets = await loadPropertyAssetsForInvestSummary(propertyAccountIds);
  const stockCashBalanceByAccountId = stockAccountIds.length > 0
    ? await computeAccountDisplayBalances(
        stockAccountIds.map((id) => ({ id, kind: AccountKind.investment, investProductType: "stock" })),
        ctx.hidFilter,
      )
    : new Map<string, number>();

  const holdingsByAccountId = new Map<string, typeof allHoldings>();
  for (const holding of allHoldings) {
    const holdings = holdingsByAccountId.get(holding.accountId);
    if (holdings) {
      holdings.push(holding);
    } else {
      holdingsByAccountId.set(holding.accountId, [holding]);
    }
  }

  const fundCodes = [...new Set(allHoldings.map(h => h.fundCode))];
  const displayPendingByHoldingKey = await loadDisplayPendingCostByHoldingKey(ctx, fundAccountIds);
  const latestNavByCode = new Map<string, { nav: number; date: string }>();
  if (fundCodes.length > 0) {
    const caches = await getEffectiveLatestFundNavMap(fundCodes);
    for (const [fundCode, c] of caches) {
      const d = c.navDate;
      const dateStr = `${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`;
      latestNavByCode.set(fundCode, { nav: c.nav, date: dateStr });
    }
  }

  const result = new Map<string, InvestBalanceDetail>();

  for (const acctId of investIds) {
    const holdings = holdingsByAccountId.get(acctId) ?? [];
    let marketValue = 0;
    let totalCost = 0;

    for (const h of holdings) {
      const units = toNumber(h.units);
      const storedCost = toNumber(h.cost);
      const storedPending = toNumber(h.pendingCost);
      const displayPending = displayPendingByHoldingKey.get(holdingKey(h.accountId, h.fundCode)) ?? 0;
      const displayCost = Math.max(0, storedCost - storedPending) + displayPending;
      const navInfo = latestNavByCode.get(h.fundCode);
      const latestNav = navInfo?.nav ?? toNumber(h.nav ?? 0);
      const confirmedCost = Math.max(0, storedCost - storedPending);
      const confirmedMV = latestNav > 0 && units > 0 ? units * latestNav : confirmedCost;
      marketValue += confirmedMV + displayPending;
      totalCost += displayCost;
    }

    const floatingPnL = marketValue - totalCost;
    result.set(acctId, { marketValue, totalCost, floatingPnL });
  }

  for (const acctId of metalAccountIds) {
    const holdings = allMetalHoldings.filter((holding) => holding.accountId === acctId);
    const marketValue = holdings.reduce((sum, holding) => sum + toNumber(holding.marketValue), 0);
    const totalCost = holdings.reduce((sum, holding) => sum + toNumber(holding.cost), 0);
    result.set(acctId, { marketValue, totalCost, floatingPnL: marketValue - totalCost });
  }

  for (const acctId of wealthAccountIds) {
    const buckets = new Map<string, { principal: number; units: number; cycleHasUnits: boolean }>();
    const events: Array<{
      key: string;
      date: string;
      createdAt: Date;
      action: "buy" | "cash_in" | "dividend";
      principalDelta: number;
      units: number | null;
    }> = [];

    // Manual NAV (unit value) entered by the user per wealth product, keyed the
    // same way as the holding buckets so market value follows the manual NAV.
    const wealthManualNavByKey = new Map<string, number>();
    for (const row of allWealthTransactions) {
      const wp = row.WealthProduct;
      if (!wp || wp.manualNav == null) continue;
      const nav = toNumber(wp.manualNav);
      if (!Number.isFinite(nav) || nav <= 0) continue;
      const key = row.wealthProductId ?? row.productName ?? `wealth:${row.id}`;
      if (!wealthManualNavByKey.has(key)) wealthManualNavByKey.set(key, nav);
    }

    for (const row of allWealthTransactions) {
      if (row.accountId !== acctId) continue;
      const gross = Math.abs(toNumber(row.grossAmount));
      const productKey = row.wealthProductId ?? row.productName ?? `wealth:${row.id}`;
      events.push({
        key: productKey,
        date: row.tradeDate.toISOString().slice(0, 10),
        createdAt: row.createdAt,
        action: isDividendSubtype(row.action) ? "dividend" : isCashInSubtype(row.action) ? "cash_in" : "buy",
        principalDelta: isCashInSubtype(row.action) ? -gross : gross,
        units: row.units == null ? null : Math.abs(toNumber(row.units)),
      });
    }
    events.sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.getTime() - b.createdAt.getTime() || a.key.localeCompare(b.key));
    for (const event of events) {
      if (event.action === "dividend") continue;
      const bucket = buckets.get(event.key) ?? { principal: 0, units: 0, cycleHasUnits: false };
      if (event.action === "cash_in") {
        bucket.principal += event.principalDelta;
        if (event.units != null) {
          bucket.cycleHasUnits = true;
          bucket.units -= event.units;
        }
        const cleared = isWealthHoldingCleared(bucket.cycleHasUnits, bucket.principal, bucket.units);
        if (cleared) {
          resetWealthHoldingBucket(bucket);
        }
      } else {
        if (event.units != null) {
          bucket.cycleHasUnits = true;
          bucket.units += event.units;
        }
        bucket.principal += event.principalDelta;
      }
      buckets.set(event.key, bucket);
    }
    let totalCost = 0;
    let marketValue = 0;
    for (const [key, bucket] of buckets.entries()) {
      const principal = isWealthHoldingCleared(bucket.cycleHasUnits, bucket.principal, bucket.units)
        ? 0
        : Math.max(0, Number(bucket.principal.toFixed(2)));
      totalCost += principal;
      const manualNav = bucket.cycleHasUnits && bucket.units > 0 ? (wealthManualNavByKey.get(key) ?? null) : null;
      marketValue += manualNav != null && bucket.units > 0
        ? roundMoney(bucket.units * manualNav)
        : principal;
    }
    totalCost = Number(totalCost.toFixed(2));
    marketValue = Number(marketValue.toFixed(2));
    result.set(acctId, { marketValue, totalCost, floatingPnL: Number((marketValue - totalCost).toFixed(2)) });
  }

  for (const acctId of stockAccountIds) {
    const holdings = allStockHoldings.filter((holding) => holding.accountId === acctId);
    const cashBalance = stockCashBalanceByAccountId.get(acctId) ?? 0;
    const holdingMarketValue = holdings.reduce((sum, holding) => sum + toNumber(holding.marketValue), 0);
    const holdingCost = holdings.reduce((sum, holding) => sum + toNumber(holding.cost), 0);
    const marketValue = holdingMarketValue + cashBalance;
    const totalCost = holdingCost + cashBalance;
    result.set(acctId, { marketValue, totalCost, floatingPnL: marketValue - totalCost });
  }

  for (const acctId of propertyAccountIds) {
    const assets = allPropertyAssets.filter((asset) => asset.accountId === acctId && asset.status !== "sold" && asset.status !== "disposed");
    const marketValue = assets.reduce((sum, asset) => sum + toNumber(asset.marketValue), 0);
    const totalCost = assets.reduce((sum, asset) => sum + toNumber(asset.cost), 0);
    result.set(acctId, { marketValue, totalCost, floatingPnL: marketValue - totalCost });
  }

  return result;
},
);

/**
 * Compute position detail display data for a single investment account (display layer).
 *
 * Data sources: fund accounts read FundHolding + FundNavCache; stock accounts
 * read StockHolding; precious-metal accounts read PreciousMetalHolding.
 * No longer accumulates entry by entry, keeping numbers consistent with the
 * Sidebar/invest pages.
 */
/** Cached version: does not recompute twice within the same HTTP request. */
export const computePositionDisplay = cache(
  async (
    ctx: HouseholdContext,
    accountId: string,
  ): Promise<PositionDisplayResult> => {
  const account = await prisma.account.findFirst({
    where: { id: accountId, ...ctx.hidFilter },
    select: { investProductType: true, institutionId: true },
  });
  if (!account) {
    return { positions: [], clearedPositions: [], totalMarketValue: 0, totalCost: 0, positionHistoricalProfit: 0, clearedHistoricalProfit: 0, totalHistoricalProfit: 0 };
  }

  if (account.investProductType === "property") {
    const propertyAssets = await loadPropertyAssetsForPositionDisplay([accountId], ctx.householdId);
    return buildPropertyPositionDisplay(propertyAssets);
  }

  if (account.investProductType === "stock") {
    const stockHoldings = await prisma.stockHolding.findMany({
      where: { accountId, householdId: ctx.householdId },
      orderBy: [{ market: "asc" }, { stockCode: "asc" }],
    });
    const mapStockHolding = (holding: (typeof stockHoldings)[number]): PositionDisplayRow => {
      const quantity = toNumber(holding.quantity);
      const cost = toNumber(holding.cost);
      const latestPrice = holding.latestPrice != null ? toNumber(holding.latestPrice) : null;
      const marketValue = toNumber(holding.marketValue);
      const floatingPnL = marketValue - cost;
      return {
        fundCode: `${holding.market}:${holding.stockCode}`,
        accountId: holding.accountId,
        stockCode: holding.stockCode,
        market: holding.market,
        securityId: holding.securityId,
        name: holding.stockName || holding.stockCode,
        holdingDate: "",
        units: quantity,
        avgCost: toNumber(holding.avgCost),
        cost,
        nav: latestPrice,
        navDate: dateOnlyString(holding.latestPriceDate),
        marketValue,
        floatingPnL,
        floatingPnLRate: cost > 0 ? floatingPnL / cost : 0,
        pendingCost: 0,
        historicalProfit: toNumber(holding.historicalProfit),
      };
    };
    const positions = stockHoldings
      .filter((holding) => toNumber(holding.quantity) > 0.000001)
      .map(mapStockHolding);
    const clearedHoldings = stockHoldings.filter((holding) => toNumber(holding.quantity) <= 0.000001);
    const clearedSecurityIds = Array.from(
      new Set(clearedHoldings.map((holding) => holding.securityId).filter((securityId): securityId is string => Boolean(securityId))),
    );
    const clearedStats = new Map<string, { firstBuyDate: string; clearedDate: string; totalBuyAmount: number; totalRedeemAmount: number }>();
    if (clearedSecurityIds.length > 0) {
      const clearedTransactions = await prisma.stockTransaction.findMany({
        where: {
          householdId: ctx.householdId,
          stockAccountId: accountId,
          deletedAt: null,
          securityId: { in: clearedSecurityIds },
        },
        select: {
          securityId: true,
          action: true,
          tradeDate: true,
          grossAmount: true,
          netAmount: true,
          fee: true,
          commission: true,
          stampTax: true,
          transferFee: true,
          exchangeFee: true,
          regulatoryFee: true,
          otherFee: true,
        },
        orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      });
      for (const row of clearedTransactions) {
        if (!row.securityId) continue;
        const stats = clearedStats.get(row.securityId) ?? {
          firstBuyDate: "",
          clearedDate: "",
          totalBuyAmount: 0,
          totalRedeemAmount: 0,
        };
        const tradeDate = dateOnlyString(row.tradeDate);
        if (row.action === StockTransactionAction.buy) {
          if (!stats.firstBuyDate || tradeDate < stats.firstBuyDate) stats.firstBuyDate = tradeDate;
          stats.totalBuyAmount += Math.abs(toNumber(row.grossAmount)) + stockFeeTotal(row);
        } else if (row.action === StockTransactionAction.sell) {
          stats.clearedDate = tradeDate || stats.clearedDate;
          stats.totalRedeemAmount += stockSellProceeds(row);
        } else if (row.action === StockTransactionAction.merge_share) {
          stats.clearedDate = tradeDate || stats.clearedDate;
        }
        clearedStats.set(row.securityId, stats);
      }
    }
    const clearedPositions: ClearedPositionRow[] = clearedHoldings
      .map((holding) => {
        const row = mapStockHolding(holding);
        const stats = clearedStats.get(holding.securityId);
        const totalInvested = roundMoney(stats?.totalBuyAmount ?? 0);
        const historicalProfit = roundMoney(row.historicalProfit);
        return {
          fundCode: row.fundCode,
          accountId: row.accountId,
          stockCode: row.stockCode,
          market: row.market,
          securityId: row.securityId,
          name: row.name,
          units: row.units,
          avgCost: row.avgCost,
          cost: row.cost,
          nav: row.nav,
          navDate: row.navDate,
          marketValue: row.marketValue,
          floatingPnL: row.floatingPnL,
          floatingPnLRate: row.floatingPnLRate,
          historicalProfit,
          totalInvested,
          returnRate: totalInvested > 0 ? historicalProfit / totalInvested : 0,
          firstBuyDate: stats?.firstBuyDate ?? "",
          clearedDate: stats?.clearedDate ?? "",
          totalBuyAmount: totalInvested,
          totalRedeemAmount: roundMoney(stats?.totalRedeemAmount ?? 0),
        };
      })
      .sort((left, right) => {
        const dateCompare = (right.clearedDate || "").localeCompare(left.clearedDate || "");
        if (dateCompare !== 0) return dateCompare;
        return left.fundCode.localeCompare(right.fundCode);
      });
    const totalMarketValue = positions.reduce((sum, row) => sum + row.marketValue, 0);
    const totalCost = positions.reduce((sum, row) => sum + row.cost, 0);
    const positionHistoricalProfit = positions.reduce((sum, row) => sum + row.historicalProfit, 0);
    const clearedHistoricalProfit = clearedPositions.reduce((sum, row) => sum + row.historicalProfit, 0);
    const totalHistoricalProfit = positionHistoricalProfit + clearedHistoricalProfit;
    const brokerageCashAccount = account.institutionId
      ? await prisma.account.findFirst({
          where: {
            ...(ctx.hidFilter ?? {}),
            institutionId: account.institutionId,
            kind: { in: [AccountKind.bank_debit, AccountKind.cash, AccountKind.ewallet] },
            isPlaceholder: { not: true },
          },
          select: { id: true, name: true, kind: true, investProductType: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
      : null;
    const cashAccountId = brokerageCashAccount?.id ?? accountId;
    const stockCashBalanceMap = await computeAccountDisplayBalances(
      [{
        id: cashAccountId,
        kind: brokerageCashAccount?.kind ?? AccountKind.investment,
        investProductType: brokerageCashAccount?.investProductType ?? "stock",
      }],
      ctx.hidFilter,
    );
    const cashBalance = stockCashBalanceMap.get(cashAccountId) ?? 0;
    return {
      positions,
      clearedPositions,
      totalMarketValue,
      totalCost,
      positionHistoricalProfit,
      clearedHistoricalProfit,
      totalHistoricalProfit,
      cashBalance,
      cashAccountId,
      cashAccountName: brokerageCashAccount?.name ?? null,
      totalAssetValue: totalMarketValue + cashBalance,
    };
  }

  if (account.investProductType === "metal") {
    const metalHoldings = await prisma.preciousMetalHolding.findMany({
      where: { accountId },
      orderBy: [{ metalTypeName: "asc" }, { metalUnitName: "asc" }],
    });
    const positions: PositionDisplayRow[] = metalHoldings
      .filter((holding) => toNumber(holding.quantity) > 0.000001)
      .map((holding) => {
        const quantity = toNumber(holding.quantity);
        const cost = toNumber(holding.cost);
        const unitPrice = holding.unitPrice != null ? toNumber(holding.unitPrice) : null;
        const marketValue = toNumber(holding.marketValue);
        const floatingPnL = marketValue - cost;
        return {
          fundCode: holding.metalTypeId,
          name: `${holding.metalTypeName} · ${holding.metalUnitName}`,
          holdingDate: "",
          units: quantity,
          avgCost: toNumber(holding.avgCost),
          cost,
          nav: unitPrice,
          navDate: "",
          marketValue,
          floatingPnL,
          floatingPnLRate: cost > 0 ? floatingPnL / cost : 0,
          pendingCost: 0,
          historicalProfit: toNumber(holding.historicalProfit),
        };
      });
    const totalMarketValue = positions.reduce((sum, row) => sum + row.marketValue, 0);
    const totalCost = positions.reduce((sum, row) => sum + row.cost, 0);
    const positionHistoricalProfit = positions.reduce((sum, row) => sum + row.historicalProfit, 0);
    const clearedHistoricalProfit = 0;
    const totalHistoricalProfit = positionHistoricalProfit + clearedHistoricalProfit;
    return { positions, clearedPositions: [], totalMarketValue, totalCost, positionHistoricalProfit, clearedHistoricalProfit, totalHistoricalProfit };
  }

  if (account.investProductType === "wealth") {
    const rows = await prisma.wealthTransaction.findMany({
      where: { accountId, deletedAt: null },
      include: { WealthProduct: true },
      orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
    });
    // Manual NAV (unit value) entered by the user per wealth product. It drives
    // the displayed NAV, market value and floating P&L of wealth holdings.
    const manualNavByKey = new Map<string, { nav: number; date: string }>();
    for (const row of rows) {
      const wp = row.WealthProduct;
      if (!wp || wp.manualNav == null) continue;
      const nav = toNumber(wp.manualNav);
      if (!Number.isFinite(nav) || nav <= 0) continue;
      const key = row.wealthProductId ?? row.productName ?? wp.name ?? "";
      if (key && !manualNavByKey.has(key)) {
        manualNavByKey.set(key, {
          nav,
          date: wp.manualNavDate ? wp.manualNavDate.toISOString().slice(0, 10) : "",
        });
      }
    }
    const buckets = new Map<string, {
      fundCode: string;
      wealthProductId: string | null;
      name: string;
      holdingDate: string;
      remaining: number;
      remainingUnits: number;
      cycleHasUnits: boolean;
      historicalProfit: number;
      totalBuyAmount: number;
      totalRedeemAmount: number;
      firstBuyDate: string;
      clearedDate: string;
    }>();

    const wealthEvents: Array<{
      key: string;
      wealthProductId: string | null;
      productName: string;
      tradeDate: string;
      createdAt: Date;
      action: "buy" | "cash_in" | "dividend";
      buyAmount: number;
      principalOut: number;
      units: number | null;
      arrival: number;
      profit: number;
    }> = [];

    for (const row of rows) {
      const productName = row.WealthProduct?.name ?? row.productName ?? "未命名理财";
      const fundCode = wealthDisplayCode(productName, row.wealthProductId);
      const key = fundCode || productName;
      const tradeDate = row.tradeDate.toISOString().slice(0, 10);
      const gross = Math.abs(toNumber(row.grossAmount));
      const units = row.units == null ? null : Math.abs(toNumber(row.units));
      const arrival = row.arrivalAmount == null ? gross : Math.abs(toNumber(row.arrivalAmount));
      const profit = wealthProfitFromParts({
        realizedProfit: row.realizedProfit,
        interest: row.interest,
        fee: row.fee,
      });
      wealthEvents.push({
        key,
        wealthProductId: row.wealthProductId ?? null,
        productName,
        tradeDate,
        createdAt: row.createdAt,
        action: isDividendSubtype(row.action) ? "dividend" : isCashInSubtype(row.action) ? "cash_in" : "buy",
        buyAmount: gross,
        principalOut: gross,
        units,
        arrival,
        profit,
      });
    }

    wealthEvents.sort((a, b) =>
      a.tradeDate.localeCompare(b.tradeDate) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.key.localeCompare(b.key)
    );

    for (const event of wealthEvents) {
      const bucket = buckets.get(event.key) ?? {
        fundCode: event.key,
        wealthProductId: event.wealthProductId,
        name: event.productName,
        holdingDate: "",
        remaining: 0,
        remainingUnits: 0,
        cycleHasUnits: false,
        historicalProfit: 0,
        totalBuyAmount: 0,
        totalRedeemAmount: 0,
        firstBuyDate: "",
        clearedDate: "",
      };

      if (event.action === "dividend") {
        bucket.historicalProfit += event.arrival;
        bucket.clearedDate = event.tradeDate;
      } else if (event.action === "cash_in") {
        if (event.units != null) {
          bucket.cycleHasUnits = true;
          bucket.remainingUnits -= event.units;
        }
        bucket.remaining -= event.principalOut;
        const cleared = isWealthHoldingCleared(bucket.cycleHasUnits, bucket.remaining, bucket.remainingUnits);
        if (cleared) {
          resetWealthHoldingBucket(bucket);
          bucket.holdingDate = "";
        }
        bucket.totalRedeemAmount += event.arrival;
        bucket.historicalProfit += event.profit;
        bucket.clearedDate = event.tradeDate;
      } else {
        const wasCleared = isWealthHoldingCleared(bucket.cycleHasUnits, bucket.remaining, bucket.remainingUnits);
        if (wasCleared) bucket.holdingDate = event.tradeDate;
        if (event.units != null) {
          bucket.cycleHasUnits = true;
          bucket.remainingUnits += event.units;
        }
        bucket.remaining += event.buyAmount;
        bucket.totalBuyAmount += event.buyAmount;
        if (!bucket.firstBuyDate || event.tradeDate < bucket.firstBuyDate) bucket.firstBuyDate = event.tradeDate;
      }

      buckets.set(event.key, bucket);
    }

    const positions: PositionDisplayRow[] = [];
    const clearedPositions: ClearedPositionRow[] = [];
    for (const bucket of buckets.values()) {
      const remaining = Number(bucket.remaining.toFixed(2));
      const remainingUnits = Number(bucket.remainingUnits.toFixed(6));
      const hasActiveHolding = !isWealthHoldingCleared(bucket.cycleHasUnits, remaining, remainingUnits);
      if (hasActiveHolding) {
        const manualNavInfo = manualNavByKey.get(bucket.fundCode);
        const displayNav = manualNavInfo ? manualNavInfo.nav : 1;
        const marketValue = manualNavInfo && bucket.cycleHasUnits && remainingUnits > 0
          ? roundMoney(remainingUnits * displayNav)
          : remaining;
        const floatingPnL = roundMoney(marketValue - remaining);
        positions.push({
          fundCode: bucket.fundCode,
          wealthProductId: bucket.wealthProductId,
          name: bucket.name,
          holdingDate: bucket.holdingDate,
          units: bucket.cycleHasUnits ? remainingUnits : 0,
          hasUnits: bucket.cycleHasUnits,
          avgCost: bucket.cycleHasUnits && remainingUnits > 0 ? remaining / remainingUnits : 0,
          cost: remaining,
          nav: displayNav,
          navDate: manualNavInfo?.date ?? "",
          marketValue,
          floatingPnL,
          floatingPnLRate: remaining > 0 ? floatingPnL / remaining : 0,
          pendingCost: 0,
          historicalProfit: Number(bucket.historicalProfit.toFixed(2)),
        });
      } else if (bucket.totalBuyAmount > 0) {
        clearedPositions.push({
          fundCode: bucket.fundCode,
          wealthProductId: bucket.wealthProductId,
          name: bucket.name,
          historicalProfit: Number(bucket.historicalProfit.toFixed(2)),
          totalInvested: Number(bucket.totalBuyAmount.toFixed(2)),
          returnRate: bucket.totalBuyAmount > 0 ? bucket.historicalProfit / bucket.totalBuyAmount : 0,
          firstBuyDate: bucket.firstBuyDate,
          clearedDate: bucket.clearedDate || bucket.firstBuyDate,
          totalBuyAmount: Number(bucket.totalBuyAmount.toFixed(2)),
          totalRedeemAmount: Number(bucket.totalRedeemAmount.toFixed(2)),
        });
      }
    }

    positions.sort((a, b) => b.marketValue - a.marketValue);
    clearedPositions.sort((a, b) => b.clearedDate.localeCompare(a.clearedDate));
    const totalMarketValue = positions.reduce((sum, row) => sum + row.marketValue, 0);
    const totalCost = positions.reduce((sum, row) => sum + row.cost, 0);
    const positionHistoricalProfit = positions.reduce((sum, row) => sum + row.historicalProfit, 0);
    const clearedHistoricalProfit = clearedPositions.reduce((sum, row) => sum + row.historicalProfit, 0);
    const totalHistoricalProfit = positionHistoricalProfit + clearedHistoricalProfit;
    return { positions, clearedPositions, totalMarketValue, totalCost, positionHistoricalProfit, clearedHistoricalProfit, totalHistoricalProfit };
  }

  const holdings = await prisma.fundHolding.findMany({
    where: { accountId },
  });

  // Check if this is a money fund account (NAV always 1)
  const isMoney = account?.investProductType === "money";

  const fundCodes = [...new Set(holdings.map(h => h.fundCode))];
  const displayPendingByHoldingKey = await loadDisplayPendingCostByHoldingKey(ctx, [accountId]);
  // Account-level money classification is the default for legacy holdings, but
  // a fund transaction carries the more precise product type. This prevents a
  // misclassified money account from forcing an ordinary fund's NAV to 1.
  const fundProductTypeByCode = new Map<string, string>();
  if (fundCodes.length > 0) {
    const fundTransactions = await prisma.fundTransaction.findMany({
      where: {
        fundAccountId: accountId,
        fundCode: { in: fundCodes },
        deletedAt: null,
      },
      select: { fundCode: true, fundProductType: true },
    });
    for (const transaction of fundTransactions) {
      if (transaction.fundCode && transaction.fundProductType) {
        fundProductTypeByCode.set(transaction.fundCode, transaction.fundProductType);
      }
    }
  }
  // Load the latest cached NAV for every held fund, money funds included, so the
  // position row can always pair the displayed NAV with its date. Money funds
  // keep NAV = 1 (their cached value is the per-10k yield, not the unit NAV).
  const latestNavByCode = new Map<string, { nav: number; date: string; name: string | null }>();
  const profileNameByCode = await getFundProfileNameMap(fundCodes);
  if (fundCodes.length > 0) {
    const caches = await getEffectiveLatestFundNavMap(fundCodes);
    for (const [fundCode, c] of caches) {
      // Keep the full YYYY-MM-DD date in the payload; clients format for display.
      latestNavByCode.set(fundCode, { nav: c.nav, date: c.navDate.toISOString().slice(0, 10), name: c.name });
    }
  }

  const positions: PositionDisplayRow[] = [];
  const clearedPositions: ClearedPositionRow[] = [];

  for (const h of holdings) {
    const units = toNumber(h.units);
    const storedCost = toNumber(h.cost);
    const storedPending = toNumber(h.pendingCost);
    const pending = displayPendingByHoldingKey.get(holdingKey(h.accountId, h.fundCode)) ?? 0;
    const cost = Math.max(0, storedCost - storedPending) + pending;
    const avgCost = toNumber(h.avgCost);
    const navInfo = latestNavByCode.get(h.fundCode);
    const isMoneyFund = isMoney && fundProductTypeByCode.get(h.fundCode) !== "fund";
    const latestNav = isMoneyFund ? 1 : (navInfo?.nav ?? (h.nav != null ? toNumber(h.nav) : 0));
    const navDateStr = navInfo?.date ?? "";
    const profileName = profileNameByCode.get(h.fundCode);
    const cachedNavName = normalizeFundDisplayName(h.fundCode, navInfo?.name);
    const storedName = normalizeFundDisplayName(h.fundCode, h.fundName);
    const displayName = profileName || cachedNavName || storedName || h.fundCode;
    const historicalProfit = toNumber(h.historicalProfit);

    const confirmedCost = Math.max(0, storedCost - storedPending);
    const confirmedMV = latestNav > 0 && units > 0 ? units * latestNav : confirmedCost;
    const marketValue = confirmedMV + pending;
    const floatingPnL = marketValue - cost;
    const floatingPnLRate = cost > 0 ? floatingPnL / cost : 0;

    if (units > 0.0001 || pending > 0.01) {
      positions.push({
        fundCode: h.fundCode,
        name: displayName,
        holdingDate: "",
        units,
        avgCost,
        cost,
        nav: latestNav > 0 ? latestNav : null,
        navDate: navDateStr,
        marketValue,
        floatingPnL,
        floatingPnLRate,
        pendingCost: pending,
        historicalProfit,
      });
    } else {
      clearedPositions.push({
        fundCode: h.fundCode,
        name: displayName,
        historicalProfit,
        totalInvested: 0,
        returnRate: 0,
        firstBuyDate: "",
        clearedDate: "",
        totalBuyAmount: 0,
        totalRedeemAmount: 0,
      });
    }
  }

  positions.sort((a, b) => b.marketValue - a.marketValue);
  clearedPositions.sort((a, b) => b.clearedDate.localeCompare(a.clearedDate) || b.historicalProfit - a.historicalProfit);

  // Batch-query cleared funds: total invested amount + first purchase time + cleared time + buy/redeem amounts
  if (clearedPositions.length > 0) {
    const clearedCodes = clearedPositions.map(c => c.fundCode);
    // Total invested amount (sum of ABS(amount) over all buy transactions)
    const investedRows = await prisma.fundTransaction.groupBy({
      by: ["fundCode"],
      where: {
        ...ctx.hidFilter,
        fundCode: { in: clearedCodes },
        fundSubtype: "buy",
        fundAccountId: accountId,
        deletedAt: null,
      },
      _sum: { grossAmount: true },
    });
    const investedMap = new Map<string, number>();
    for (const row of investedRows) {
      if (row.fundCode) {
        investedMap.set(row.fundCode, Math.abs(toNumber(row._sum.grossAmount ?? 0)));
      }
    }
    // First purchase time (date of the earliest buy transaction)
    const firstBuyRows = await prisma.fundTransaction.groupBy({
      by: ["fundCode"],
      where: {
        ...ctx.hidFilter,
        fundCode: { in: clearedCodes },
        fundSubtype: "buy",
        fundAccountId: accountId,
        deletedAt: null,
      },
      _min: { applyDate: true },
    });
    const firstBuyMap = new Map<string, string>();
    for (const row of firstBuyRows) {
      if (row.fundCode && row._min.applyDate) {
        firstBuyMap.set(row.fundCode, row._min.applyDate.toISOString().slice(0, 10));
      }
    }
    // Cleared time (date of the last redemption)
    const clearedDateRows = await prisma.fundTransaction.groupBy({
      by: ["fundCode"],
      where: {
        ...ctx.hidFilter,
        fundCode: { in: clearedCodes },
        fundSubtype: { in: ["redeem"] },
        fundAccountId: accountId,
        deletedAt: null,
      },
      _max: { applyDate: true },
    });
    const clearedDateMap = new Map<string, string>();
    for (const row of clearedDateRows) {
      if (row.fundCode && row._max.applyDate) {
        clearedDateMap.set(row.fundCode, row._max.applyDate.toISOString().slice(0, 10));
      }
    }
    // Buy amount and recovered amount: only transactions before the cleared date are counted
    // Recovered amount = redemption arrival + cash dividend arrival, keeping the same cash-flow basis as cleared profit
    const clearedTxRows = await prisma.fundTransaction.findMany({
      where: {
        ...ctx.hidFilter,
        fundCode: { in: clearedCodes },
        fundAccountId: accountId,
        fundSubtype: { in: ["buy", "redeem", "dividend_cash"] },
        deletedAt: null,
      },
      select: { fundCode: true, fundSubtype: true, grossAmount: true, arrivalAmount: true, applyDate: true },
    });
    const buyAmountMap = new Map<string, number>();
    const redeemAmountMap = new Map<string, number>();
    for (const row of clearedTxRows) {
      if (!row.fundCode) continue;
      const clearedDate = clearedDateMap.get(row.fundCode);
      const txDate = row.applyDate.toISOString().slice(0, 10);
      if (clearedDate && txDate > clearedDate) continue;
      if (row.fundSubtype === "buy") {
        buyAmountMap.set(row.fundCode, (buyAmountMap.get(row.fundCode) ?? 0) + Math.abs(toNumber(row.grossAmount)));
      } else {
        const arrival = toNumber(row.arrivalAmount ?? 0);
        const amt = Math.abs(toNumber(row.grossAmount));
        redeemAmountMap.set(row.fundCode, (redeemAmountMap.get(row.fundCode) ?? 0) + (arrival > 0 ? arrival : amt));
      }
    }
    for (const c of clearedPositions) {
      c.totalInvested = investedMap.get(c.fundCode) ?? 0;
      c.firstBuyDate = firstBuyMap.get(c.fundCode) ?? "";
      c.clearedDate = clearedDateMap.get(c.fundCode) ?? "";
      c.totalBuyAmount = buyAmountMap.get(c.fundCode) ?? 0;
      c.totalRedeemAmount = redeemAmountMap.get(c.fundCode) ?? 0;
      c.historicalProfit = c.totalRedeemAmount - c.totalBuyAmount;
      c.returnRate = c.totalInvested > 0 ? c.historicalProfit / c.totalInvested : 0;
    }
  }

  const totalMarketValue = positions.reduce((s, p) => s + p.marketValue, 0);
  const totalCost = positions.reduce((s, p) => s + p.cost, 0);
  const positionHistoricalProfit = positions.reduce((s, p) => s + p.historicalProfit, 0);
  const clearedHistoricalProfit = clearedPositions.reduce((s, c) => s + c.historicalProfit, 0);
  const totalHistoricalProfit = positionHistoricalProfit + clearedHistoricalProfit;

  return { positions, clearedPositions, totalMarketValue, totalCost, positionHistoricalProfit, clearedHistoricalProfit, totalHistoricalProfit };
},
);

export const computeFixedAssetPositionDisplay = cache(
  async (ctx: HouseholdContext): Promise<PositionDisplayResult> => {
    const accounts = await prisma.account.findMany({
      where: {
        ...ctx.hidFilter,
        kind: AccountKind.investment,
        investProductType: "property",
        isActive: true,
        isPlaceholder: { not: true },
      },
      select: { id: true },
    });
    const propertyAssets = await loadPropertyAssetsForPositionDisplay(
      accounts.map((account) => account.id),
      ctx.householdId,
    );
    return buildPropertyPositionDisplay(propertyAssets);
  },
);
