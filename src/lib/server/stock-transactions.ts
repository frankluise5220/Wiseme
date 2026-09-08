import { Prisma, StockTransactionAction } from "@prisma/client";
import { unstable_cache } from "next/cache";

import { formatDateUtc, toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { normalizeStockCode, normalizeStockMarket } from "@/lib/stock/market";

const STOCK_TRANSACTION_LIST_INCLUDE = {
  StockAccount: { select: { name: true, currency: true } },
  CashAccount: { select: { name: true, currency: true } },
  EntryBusinessLink: {
    where: { deletedAt: null },
    select: { id: true, cashEntryId: true },
  },
} as const;

type StockTransactionListRow = Prisma.StockTransactionGetPayload<{
  include: typeof STOCK_TRANSACTION_LIST_INCLUDE;
}>;

export type StockTransactionListItem = {
  id: string;
  linkId: string | null;
  linkIds: string[];
  cashEntryId: string | null;
  stockAccountId: string;
  stockAccountName: string;
  cashAccountId: string | null;
  cashAccountName: string | null;
  securityId: string | null;
  market: string;
  stockCode: string;
  stockName: string | null;
  action: StockTransactionAction;
  source: string;
  tradeDate: string;
  settleDate: string | null;
  grossAmount: number;
  netAmount: number | null;
  quantity: number | null;
  price: number | null;
  fee: number | null;
  commission: number | null;
  stampTax: number | null;
  transferFee: number | null;
  exchangeFee: number | null;
  regulatoryFee: number | null;
  otherFee: number | null;
  realizedProfit: number | null;
  externalLinkId: string | null;
  brokerTradeId: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

export function serializeStockTransaction(row: StockTransactionListRow): StockTransactionListItem {
  const linkIds = row.EntryBusinessLink.map((link) => link.id);
  return {
    id: row.id,
    linkId: linkIds[0] ?? null,
    linkIds,
    cashEntryId: row.cashEntryId ?? null,
    stockAccountId: row.stockAccountId,
    stockAccountName: row.StockAccount?.name ?? "",
    cashAccountId: row.cashAccountId ?? null,
    cashAccountName: row.CashAccount?.name ?? null,
    securityId: row.securityId ?? null,
    market: row.market,
    stockCode: row.stockCode,
    stockName: row.stockName ?? null,
    action: row.action,
    source: row.source ?? "manual",
    tradeDate: formatDateUtc(row.tradeDate),
    settleDate: row.settleDate ? formatDateUtc(row.settleDate) : null,
    grossAmount: toNumber(row.grossAmount),
    netAmount: row.netAmount == null ? null : toNumber(row.netAmount),
    quantity: row.quantity == null ? null : toNumber(row.quantity),
    price: row.price == null ? null : toNumber(row.price),
    fee: row.fee == null ? null : toNumber(row.fee),
    commission: row.commission == null ? null : toNumber(row.commission),
    stampTax: row.stampTax == null ? null : toNumber(row.stampTax),
    transferFee: row.transferFee == null ? null : toNumber(row.transferFee),
    exchangeFee: row.exchangeFee == null ? null : toNumber(row.exchangeFee),
    regulatoryFee: row.regulatoryFee == null ? null : toNumber(row.regulatoryFee),
    otherFee: row.otherFee == null ? null : toNumber(row.otherFee),
    realizedProfit: row.realizedProfit == null ? null : toNumber(row.realizedProfit),
    externalLinkId: row.externalLinkId ?? null,
    brokerTradeId: row.brokerTradeId ?? null,
    note: row.note ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadStockTransactions(params: {
  householdId: string;
  accountId?: string | null;
  securityId: string;
  market: string;
  stockCode: string;
  limit: number;
}) {
  const rows = await prisma.stockTransaction.findMany({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      ...(params.accountId ? { stockAccountId: params.accountId } : {}),
      ...(params.securityId
        ? {
            OR: [
              { securityId: params.securityId },
              ...(params.market && params.stockCode
                ? [{ securityId: null, market: params.market, stockCode: params.stockCode }]
                : []),
            ],
          }
        : {
            ...(params.market ? { market: params.market } : {}),
            ...(params.stockCode ? { stockCode: params.stockCode } : {}),
          }),
    },
    include: STOCK_TRANSACTION_LIST_INCLUDE,
    orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: params.limit,
  });
  return rows.map(serializeStockTransaction);
}

/**
 * Loads stock transaction details from the persistent Next.js data cache.
 * The cache key includes every scope/filter input so household data cannot be
 * shared across accounts or filters accidentally.
 */
export async function loadCachedStockTransactions(params: {
  householdId: string;
  accountId?: string | null;
  securityId?: string | null;
  market?: string | null;
  stockCode?: string | null;
  limit: number;
}) {
  const normalized = {
    householdId: params.householdId,
    accountId: String(params.accountId ?? "").trim(),
    securityId: String(params.securityId ?? "").trim(),
    market: params.market ? normalizeStockMarket(params.market) : "",
    stockCode: params.stockCode ? normalizeStockCode(params.stockCode) : "",
    limit: Math.max(1, Math.min(500, Math.trunc(params.limit))),
  };
  const cachedLoader = unstable_cache(
    () => loadStockTransactions(normalized),
    [
      "stock-transactions",
      normalized.householdId,
      normalized.accountId,
      normalized.securityId,
      normalized.market,
      normalized.stockCode,
      String(normalized.limit),
    ],
    {
      revalidate: false,
      tags: ["stock-transactions", `stock-transactions:${normalized.householdId}`],
    },
  );
  return cachedLoader();
}
