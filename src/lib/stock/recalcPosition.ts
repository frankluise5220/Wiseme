import { StockTransactionAction } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";

function roundQuantity(value: number) {
  return Math.max(0, Math.round(value * 1_000_000) / 1_000_000);
}

function roundMoney(value: number) {
  return Math.max(0, Math.round((value + Number.EPSILON) * 100) / 100);
}

type StockLot = { quantity: number; cost: number };

function consumeStockLots(lots: StockLot[], toConsume: number, lifo: boolean): number {
  let remaining = toConsume;
  let costReduced = 0;
  const queue = lifo ? [...lots].reverse() : lots;
  for (const lot of queue) {
    if (remaining <= 0) break;
    const unitCost = lot.quantity > 0 ? lot.cost / lot.quantity : 0;
    const take = Math.min(lot.quantity, remaining);
    costReduced += unitCost * take;
    lot.quantity = roundQuantity(lot.quantity - take);
    lot.cost = roundMoney(Math.max(0, lot.cost - unitCost * take));
    remaining -= take;
  }
  for (let i = lots.length - 1; i >= 0; i -= 1) {
    if (lots[i].quantity <= 0) lots.splice(i, 1);
  }
  return costReduced;
}

type StockTransactionReplayRow = {
  securityId: string | null;
  market: string;
  stockCode: string;
  stockName: string | null;
  action: StockTransactionAction;
  quantity: unknown;
};

type StockPositionQuantityState = {
  securityId: string;
  market: string;
  stockCode: string;
  stockName: string | null;
  quantity: number;
};

function summarizeStockPositionQuantity(rows: StockTransactionReplayRow[]) {
  const positions = new Map<string, StockPositionQuantityState>();
  for (const row of rows) {
    if (!row.securityId) continue;
    const quantity = Math.abs(toNumber(row.quantity));
    const current = positions.get(row.securityId) ?? {
      securityId: row.securityId,
      market: row.market,
      stockCode: row.stockCode,
      stockName: row.stockName,
      quantity: 0,
    };
    if (row.action === StockTransactionAction.buy || row.action === StockTransactionAction.bonus_share || row.action === StockTransactionAction.split_share) {
      current.quantity = roundQuantity(current.quantity + quantity);
    } else if (row.action === StockTransactionAction.sell || row.action === StockTransactionAction.merge_share) {
      current.quantity = roundQuantity(current.quantity - quantity);
    }
    current.market = row.market;
    current.stockCode = row.stockCode;
    current.stockName = row.stockName ?? current.stockName;
    positions.set(row.securityId, current);
  }
  return Array.from(positions.values())
    .filter((item) => item.quantity > 0)
    .sort((left, right) => left.market.localeCompare(right.market) || left.stockCode.localeCompare(right.stockCode));
}

export async function computeStockHoldingsAsOfDate(accountId: string, asOfDate: Date, securityIds?: string[]) {
  const securityFilter = securityIds && securityIds.length > 0
    ? { securityId: { in: Array.from(new Set(securityIds.filter(Boolean))) } }
    : {};
  const rows = await prisma.stockTransaction.findMany({
    where: {
      deletedAt: null,
      stockAccountId: accountId,
      tradeDate: { lte: asOfDate },
      ...securityFilter,
    },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  return summarizeStockPositionQuantity(rows);
}

type StockPosition = {
  securityId: string;
  market: string;
  stockCode: string;
  stockName: string | null;
  quantity: number;
  cost: number;
  historicalProfit: number;
};

export async function recalcStockPositions(accountId: string, securityIds?: string[]) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    select: { id: true, kind: true, householdId: true, investProductType: true, costBasisMethod: true },
  });
  if (!account || account.kind !== "investment" || account.investProductType !== "stock") return;

  const securityFilter = securityIds && securityIds.length > 0
    ? { securityId: { in: Array.from(new Set(securityIds.filter(Boolean))) } }
    : {};
  const rows = await prisma.stockTransaction.findMany({
    where: {
      deletedAt: null,
      stockAccountId: accountId,
      ...securityFilter,
    },
    orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

  const positions = new Map<string, StockPosition>();
  const realizedProfitById = new Map<string, number | null>();
  const costBasisMethod = account.costBasisMethod === "fifo" || account.costBasisMethod === "lifo"
    ? account.costBasisMethod
    : "moving_avg";
  const lotBased = costBasisMethod === "fifo" || costBasisMethod === "lifo";
  const lifo = costBasisMethod === "lifo";
  const lotsBySecurityId = new Map<string, StockLot[]>();

  for (const row of rows) {
    if (!row.securityId) continue;
    const quantity = Math.abs(toNumber(row.quantity));
    const grossAmount = Math.abs(toNumber(row.grossAmount));
    const netAmount = row.netAmount == null ? null : Math.abs(toNumber(row.netAmount));
    const fee = toNumber(row.fee) + toNumber(row.commission) + toNumber(row.stampTax) +
      toNumber(row.transferFee) + toNumber(row.exchangeFee) + toNumber(row.regulatoryFee) + toNumber(row.otherFee);
    const current = positions.get(row.securityId) ?? {
      securityId: row.securityId,
      market: row.market,
      stockCode: row.stockCode,
      stockName: row.stockName,
      quantity: 0,
      cost: 0,
      historicalProfit: 0,
    };

    if (row.action === StockTransactionAction.sell) {
      const soldQuantity = quantity > 0 ? Math.min(current.quantity, quantity) : 0;
      let costReduced: number;
      if (lotBased) {
        const lots = lotsBySecurityId.get(row.securityId) ?? [];
        costReduced = consumeStockLots(lots, soldQuantity, lifo);
      } else {
        const avgCost = current.quantity > 0 ? current.cost / current.quantity : 0;
        costReduced = avgCost * soldQuantity;
      }
      const proceeds = netAmount ?? Math.max(0, grossAmount - fee);
      const realizedProfit = proceeds - costReduced;
      current.quantity = roundQuantity(current.quantity - soldQuantity);
      current.cost = roundMoney(current.cost - costReduced);
      current.historicalProfit += realizedProfit;
      realizedProfitById.set(row.id, realizedProfit);
    } else if (row.action === StockTransactionAction.buy) {
      current.quantity = roundQuantity(current.quantity + quantity);
      const buyCost = grossAmount + fee;
      current.cost = roundMoney(current.cost + buyCost);
      if (lotBased) {
        const lots = lotsBySecurityId.get(row.securityId) ?? [];
        lots.push({ quantity, cost: buyCost });
        lotsBySecurityId.set(row.securityId, lots);
      }
      realizedProfitById.set(row.id, null);
    } else if (row.action === StockTransactionAction.dividend) {
      const profit = netAmount ?? Math.max(0, grossAmount - fee);
      current.historicalProfit += profit;
      realizedProfitById.set(row.id, profit);
    } else if (row.action === StockTransactionAction.bonus_share || row.action === StockTransactionAction.split_share) {
      current.quantity = roundQuantity(current.quantity + quantity);
      if (lotBased) {
        const lots = lotsBySecurityId.get(row.securityId) ?? [];
        lots.push({ quantity, cost: 0 });
        lotsBySecurityId.set(row.securityId, lots);
      }
      realizedProfitById.set(row.id, null);
    } else if (row.action === StockTransactionAction.merge_share) {
      current.quantity = roundQuantity(current.quantity - quantity);
      if (lotBased) {
        const lots = lotsBySecurityId.get(row.securityId) ?? [];
        const mergeCost = consumeStockLots(lots, quantity, false);
        current.cost = roundMoney(current.cost - mergeCost);
      }
      realizedProfitById.set(row.id, null);
    } else {
      const adjustment = netAmount ?? grossAmount;
      current.historicalProfit -= adjustment;
      realizedProfitById.set(row.id, -adjustment);
    }

    positions.set(row.securityId, current);
  }

  for (const [id, realizedProfit] of realizedProfitById) {
    const row = rows.find((item) => item.id === id);
    await prisma.stockTransaction.update({
      where: { id },
      data: { realizedProfit },
    });
    if (row?.cashEntryId) {
      await prisma.txRecord.update({
        where: { id: row.cashEntryId },
        data: { realizedProfit },
      });
    }
  }

  const activeSecurityIds = new Set(positions.keys());
  const existing = await prisma.stockHolding.findMany({
    where: {
      accountId,
      ...(securityIds && securityIds.length > 0 ? { securityId: { in: securityIds } } : {}),
    },
    select: { securityId: true },
  });
  for (const holding of existing) {
    if (!activeSecurityIds.has(holding.securityId)) {
      await prisma.stockHolding.delete({
        where: { accountId_securityId: { accountId, securityId: holding.securityId } },
      });
    }
  }

  const latestPriceRows = await prisma.stockPriceCache.findMany({
    where: { securityId: { in: Array.from(activeSecurityIds) } },
    orderBy: [{ priceDate: "desc" }],
  });
  const latestPriceBySecurityId = new Map<string, { price: number; date: Date | null }>();
  for (const row of latestPriceRows) {
    if (row.securityId && !latestPriceBySecurityId.has(row.securityId)) {
      latestPriceBySecurityId.set(row.securityId, { price: toNumber(row.closePrice), date: row.priceDate });
    }
  }

  for (const position of positions.values()) {
    const quantity = roundQuantity(position.quantity);
    const cost = roundMoney(position.cost);
    const avgCost = quantity > 0 ? cost / quantity : 0;
    const latestInfo = latestPriceBySecurityId.get(position.securityId);
    const latestPrice = latestInfo ? latestInfo.price : (quantity > 0 ? avgCost : null);
    const latestPriceDate = latestInfo ? latestInfo.date : null;
    const marketValue = quantity > 0 && latestPrice != null ? roundMoney(quantity * latestPrice) : 0;

    await prisma.stockHolding.upsert({
      where: { accountId_securityId: { accountId, securityId: position.securityId } },
      create: {
        householdId: account.householdId,
        accountId,
        securityId: position.securityId,
        market: position.market,
        stockCode: position.stockCode,
        stockName: position.stockName,
        quantity,
        avgCost,
        cost,
        latestPrice,
        latestPriceDate,
        marketValue,
        historicalProfit: position.historicalProfit,
      },
      update: {
        market: position.market,
        stockCode: position.stockCode,
        stockName: position.stockName,
        quantity,
        avgCost,
        cost,
        latestPrice,
        latestPriceDate,
        marketValue,
        historicalProfit: position.historicalProfit,
      },
    });
  }
}
