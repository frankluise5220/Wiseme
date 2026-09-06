import { NextRequest, NextResponse } from "next/server";
import { StockTransactionAction } from "@prisma/client";
import { ENTRY_ORIGIN_EXCEL_IMPORT, ENTRY_ORIGIN_MANUAL, TRANSACTION_SOURCE_MANUAL } from "@/lib/transaction-semantics";
import { normalizeCurrency } from "@/lib/currency";
import { formatDateUtc, toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { ensureBrokerageCashAccountForStockAccount } from "@/lib/server/brokerage-cash-account";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { loadCachedStockTransactions, serializeStockTransaction } from "@/lib/server/stock-transactions";
import { ensureStockTransactionCashFlow } from "@/lib/stock/cashFlow";
import { calculateStockTransactionFeesByDate } from "@/lib/stock/feeRule";
import { recalcStockPositions } from "@/lib/stock/recalcPosition";
import { inferStockMarketFromCode, normalizeStockCode, normalizeStockMarket, normalizeUsableStockName, resolveOrCreateStockSecurity } from "@/lib/stock/securities";

export const runtime = "nodejs";

const STOCK_ACTIONS = new Set(Object.values(StockTransactionAction));

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

function parseDateOnly(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T00:00:00.000Z`)
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseNonNegativeNumber(value: unknown) {
  if (value == null || value === "") return 0;
  const num = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function parseOptionalNonNegativeNumber(value: unknown) {
  if (value == null || value === "") return null;
  return parseNonNegativeNumber(value);
}

function parseDeleteIds(raw: string | null) {
  return Array.from(new Set((raw ?? "").split(",").map((item) => item.trim()).filter(Boolean)));
}

type StockTransactionDeleteRow = {
  id: string;
  stockAccountId: string;
  cashAccountId: string | null;
  cashEntryId: string | null;
  securityId: string | null;
  EntryBusinessLink: Array<{ id: string }>;
};

async function deleteStockTransactionRows(householdId: string, rows: StockTransactionDeleteRow[]) {
  const deletedAt = new Date();
  const deletedIds = rows.map((row) => row.id);
  const cashEntryIds = Array.from(new Set(rows.map((row) => row.cashEntryId).filter((id): id is string => Boolean(id))));
  const linkIds = Array.from(new Set(rows.flatMap((row) => row.EntryBusinessLink.map((link) => link.id))));
  const stockAccountIds = new Set<string>();
  const cashAccountIds = new Set<string>();
  const stockRecalcMap = new Map<string, { full: boolean; securityIds: Set<string> }>();

  for (const row of rows) {
    stockAccountIds.add(row.stockAccountId);
    if (row.cashAccountId) cashAccountIds.add(row.cashAccountId);
    const info = stockRecalcMap.get(row.stockAccountId) ?? { full: false, securityIds: new Set<string>() };
    if (!row.securityId) info.full = true;
    else if (!info.full) info.securityIds.add(row.securityId);
    stockRecalcMap.set(row.stockAccountId, info);
  }

  await prisma.$transaction(async (tx) => {
    await tx.stockTransaction.updateMany({
      where: { id: { in: deletedIds }, householdId },
      data: { deletedAt },
    });
    if (cashEntryIds.length > 0) {
      await tx.txRecord.updateMany({
        where: { id: { in: cashEntryIds }, householdId },
        data: { deletedAt },
      });
    }
    await tx.entryBusinessLink.updateMany({
      where: {
        householdId,
        deletedAt: null,
        OR: [
          { stockTransactionId: { in: deletedIds } },
          ...(cashEntryIds.length > 0 ? [{ cashEntryId: { in: cashEntryIds } }] : []),
        ],
      },
      data: { deletedAt },
    });
  });

  for (const [accountId, info] of stockRecalcMap) {
    await recalcStockPositions(accountId, info.full ? undefined : Array.from(info.securityIds)).catch(
      logger.catchLog("stock-position-recalc-failed", "route.ts"),
    );
  }

  const balanceAccountIds = new Set([...stockAccountIds, ...cashAccountIds]);
  for (const accountId of balanceAccountIds) {
    await recalcAndSaveAccountBalance(accountId).catch(logger.catchLog("account-balance-recalc-failed", "route.ts"));
  }

  await invalidateCreditCardCycleCacheForAccountIds(balanceAccountIds).catch(
    logger.catchLog("credit-card-cycle-cache-invalidation-failed", "route.ts"),
  );
  revalidateAfterInvestChange();

  return {
    deletedIds,
    cashEntryIds,
    linkIds,
    stockAccountIds: Array.from(stockAccountIds),
    cashAccountIds: Array.from(cashAccountIds),
  };
}

function decimalString(value: number | null) {
  return value == null ? null : String(value);
}

function normalizeStockAction(value: unknown) {
  const action = String(value ?? StockTransactionAction.buy).trim();
  return STOCK_ACTIONS.has(action as StockTransactionAction)
    ? (action as StockTransactionAction)
    : StockTransactionAction.buy;
}

function isBuySellAction(action: StockTransactionAction) {
  return action === StockTransactionAction.buy || action === StockTransactionAction.sell;
}

async function assertStockAccount(accountId: string, householdId: string) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, kind: "investment", investProductType: "stock" },
    select: { id: true, householdId: true, groupId: true, institutionId: true, name: true, currency: true },
  });
  if (!account) throw new Error("Stock account was not found in the current household");
  return account;
}

async function findCashAccount(accountId: string | null, householdId: string, legacyStockAccountId?: string) {
  if (!accountId) return null;
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, isPlaceholder: { not: true } },
    select: { id: true, name: true, kind: true, investProductType: true, currency: true },
  });
  if (!account) throw new Error("Funding account was not found in the current household");
  const isCashLike = account.kind === "bank_debit" || account.kind === "cash" || account.kind === "ewallet";
  const isLegacyStockCash = account.id === legacyStockAccountId && account.kind === "investment" && account.investProductType === "stock";
  if (!isCashLike && !isLegacyStockCash) throw new Error("Funding account must be a cash, debit-card, or wallet account, or the legacy current stock account");
  return account;
}

/**
 * GET /api/v1/stocks/transactions
 * Lists stock transactions from the independent stock domain.
 *
 * Query:
 * - accountId?: stock account id
 * - securityId?: stock security id
 * - market?: stock market, such as CN/HK/US
 * - stockCode?: stock code
 * - limit?: number, default 200
 *
 * Response:
 * - { ok: true, data: { transactions: [{ id, linkId, cashEntryId, securityId, market, stockCode, action, ... }] } }
 */
export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const accountId = req.nextUrl.searchParams.get("accountId")?.trim() || "";
    const securityId = req.nextUrl.searchParams.get("securityId")?.trim() || "";
    const marketRaw = req.nextUrl.searchParams.get("market")?.trim() || "";
    const stockCodeRaw = req.nextUrl.searchParams.get("stockCode")?.trim() || "";
    const limitRaw = Number(req.nextUrl.searchParams.get("limit") ?? 200);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 200;

    if (accountId) await assertStockAccount(accountId, householdId);

    const rows = await loadCachedStockTransactions({
      householdId,
      accountId,
      securityId,
      market: marketRaw,
      stockCode: stockCodeRaw,
      limit,
    });

    return NextResponse.json(
      { ok: true, data: { transactions: rows } },
      { headers: corsHeaders() },
    );
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "Fetch failed" },
      { status: 500, headers: corsHeaders() },
    );
  }
}

/**
 * POST /api/v1/stocks/transactions
 * Creates a stock transaction and creates or links the cash-side TxRecord.
 *
 * Body:
 * - accountId | stockAccountId: stock account id
 * - cashAccountId?: cash/debit-card/wallet funding account id used for buy/sell/dividend/fee/tax cash flow; omitted values auto-use the stock account's brokerage default funding account
 * - securityId?: existing StockSecurity id
 * - market?: stock market; omitted values are inferred from stockCode where possible
 * - stockCode: stock code when securityId is not supplied
 * - stockName?: display name
 * - action: buy | sell | dividend | bonus_share | split_share | merge_share | fee_adjustment | tax_adjustment
 *   dividend uses grossAmount and optional netAmount for cash dividends; bonus_share is the no-cash stock dividend/transfer action
 * - tradeDate: YYYY-MM-DD
 * - settleDate?: YYYY-MM-DD
 * - grossAmount?: amount before fees for cash-only actions; buy/sell amount is calculated from quantity * price
 * - netAmount?: settled cash amount
 * - quantity, price are required for buy/sell
 * - fee?, commission?, stampTax?, transferFee?, exchangeFee?, regulatoryFee?, otherFee? optional import/manual overrides; omitted values are calculated from account stock fee rules for buy/sell
 * - externalLinkId?: broker/import source id for dedupe
 * - brokerTradeId?: broker trade id
 *
 * Response:
 * - { ok: true, data: { transaction, linkId, cashEntryId } }
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ ok: false, code: "INVALID_BODY", error: "Invalid request body" }, { status: 400, headers: corsHeaders() });

    const stockAccountId = String(body.stockAccountId ?? body.accountId ?? "").trim();
    if (!stockAccountId) return NextResponse.json({ ok: false, code: "STOCK_ACCOUNT_REQUIRED", error: "Stock account is required" }, { status: 400, headers: corsHeaders() });
    const stockAccount = await assertStockAccount(stockAccountId, householdId);
    const action = normalizeStockAction(body.action);
    const cashAccountIdRaw = String(body.cashAccountId ?? "").trim();
    const ensuredCashAccount = cashAccountIdRaw ? null : await ensureBrokerageCashAccountForStockAccount(prisma, stockAccount);
    const cashAccountId = cashAccountIdRaw || ensuredCashAccount?.id || "";
    const cashAccount = await findCashAccount(cashAccountId || null, householdId);
    const tradeDate = parseDateOnly(body.tradeDate);
    const settleDate = parseDateOnly(body.settleDate);
    if (!tradeDate) return NextResponse.json({ ok: false, code: "INVALID_TRADE_DATE", error: "Trade date is invalid" }, { status: 400, headers: corsHeaders() });

    const quantity = parseOptionalNonNegativeNumber(body.quantity);
    const price = parseOptionalNonNegativeNumber(body.price);
    const buySellAction = isBuySellAction(action);
    const grossAmountInput = parseOptionalNonNegativeNumber(body.grossAmount ?? body.amount);
    const grossFromQuantity = quantity != null && price != null ? quantity * price : 0;
    const grossAmount = buySellAction ? grossFromQuantity : grossAmountInput ?? grossFromQuantity;
    const netAmount = parseOptionalNonNegativeNumber(body.netAmount);
    const fee = parseOptionalNonNegativeNumber(body.fee);
    const commission = parseOptionalNonNegativeNumber(body.commission);
    const stampTax = parseOptionalNonNegativeNumber(body.stampTax);
    const transferFee = parseOptionalNonNegativeNumber(body.transferFee);
    const exchangeFee = parseOptionalNonNegativeNumber(body.exchangeFee);
    const regulatoryFee = parseOptionalNonNegativeNumber(body.regulatoryFee);
    const otherFee = parseOptionalNonNegativeNumber(body.otherFee);
    const externalLinkId = String(body.externalLinkId ?? "").trim() || null;
    const brokerTradeId = String(body.brokerTradeId ?? "").trim() || null;

    if (buySellAction && (!quantity || !price || grossAmount <= 0)) {
      return NextResponse.json({ ok: false, code: "QUANTITY_AND_PRICE_REQUIRED", error: "Buy/sell stock transactions require quantity and price" }, { status: 400, headers: corsHeaders() });
    }
    if ((action === StockTransactionAction.dividend || action === StockTransactionAction.fee_adjustment || action === StockTransactionAction.tax_adjustment) && grossAmount <= 0) {
      return NextResponse.json({ ok: false, code: "AMOUNT_REQUIRED", error: "Amount is required for this stock transaction" }, { status: 400, headers: corsHeaders() });
    }
    if ((action === StockTransactionAction.bonus_share || action === StockTransactionAction.split_share || action === StockTransactionAction.merge_share) && !quantity) {
      return NextResponse.json({ ok: false, code: "QUANTITY_REQUIRED", error: "Quantity is required for this stock transaction" }, { status: 400, headers: corsHeaders() });
    }
    if ((action === StockTransactionAction.buy || action === StockTransactionAction.sell || action === StockTransactionAction.dividend || action === StockTransactionAction.fee_adjustment || action === StockTransactionAction.tax_adjustment) && !cashAccount) {
      return NextResponse.json({ ok: false, code: "CASH_ACCOUNT_UNDETERMINED", error: "Funding account could not be resolved" }, { status: 400, headers: corsHeaders() });
    }

    if (externalLinkId) {
      const existing = await prisma.stockTransaction.findFirst({
        where: { householdId, stockAccountId, externalLinkId, deletedAt: null },
        include: {
          StockAccount: { select: { name: true, currency: true } },
          CashAccount: { select: { name: true, currency: true } },
          EntryBusinessLink: { where: { deletedAt: null }, select: { id: true, cashEntryId: true } },
        },
      });
      if (existing) {
        return NextResponse.json({
          ok: true,
          data: {
            duplicate: true,
            transaction: serializeStockTransaction(existing),
            linkId: existing.EntryBusinessLink[0]?.id ?? null,
            cashEntryId: existing.cashEntryId,
          },
        }, { headers: corsHeaders() });
      }
    }

    const security = body.securityId
      ? await prisma.stockSecurity.findFirst({
          where: { id: String(body.securityId).trim(), householdId, isActive: true },
        })
      : await resolveOrCreateStockSecurity(prisma, {
          householdId,
          market: body.market ? normalizeStockMarket(body.market) : inferStockMarketFromCode(body.stockCode),
          stockCode: normalizeStockCode(body.stockCode),
          stockName: normalizeUsableStockName(body.stockName, normalizeStockCode(body.stockCode)) ?? undefined,
          currency: normalizeCurrency(body.currency ?? stockAccount.currency),
          exchange: String(body.exchange ?? "").trim() || null,
        });
    if (!security) return NextResponse.json({ ok: false, code: "SECURITY_NOT_FOUND", error: "Stock security was not found" }, { status: 400, headers: corsHeaders() });

    const fees = buySellAction
      ? await (async () => {
          return calculateStockTransactionFeesByDate({
            accountId: stockAccountId,
            tradeDate,
            grossAmount,
            direction: action,
            securityId: security.id,
            market: security.market,
            stockCode: security.stockCode,
            overrides: {
              fee,
              commission,
              stampTax,
              transferFee,
              exchangeFee,
              regulatoryFee,
              otherFee,
            },
          });
        })()
      : {
          fee,
          commission,
          stampTax,
          transferFee,
          exchangeFee,
          regulatoryFee,
          otherFee,
        };

    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.stockTransaction.create({
        data: {
          householdId,
          stockAccountId,
          cashAccountId: cashAccount?.id ?? null,
          securityId: security.id,
          market: security.market,
          stockCode: security.stockCode,
          stockName: normalizeUsableStockName(body.stockName, security.stockCode) ?? security.stockName,
          action,
          source: String(body.source ?? TRANSACTION_SOURCE_MANUAL).trim() || TRANSACTION_SOURCE_MANUAL,
          entryOrigin: body.entryOrigin ? String(body.entryOrigin).trim() : (body.source === "excel_import" ? ENTRY_ORIGIN_EXCEL_IMPORT : ENTRY_ORIGIN_MANUAL),
          tradeDate,
          settleDate,
          grossAmount: String(grossAmount),
          netAmount: decimalString(netAmount),
          quantity: decimalString(quantity),
          price: decimalString(price),
          fee: decimalString(fees.fee),
          commission: decimalString(fees.commission),
          stampTax: decimalString(fees.stampTax),
          transferFee: decimalString(fees.transferFee),
          exchangeFee: decimalString(fees.exchangeFee),
          regulatoryFee: decimalString(fees.regulatoryFee),
          otherFee: decimalString(fees.otherFee),
          externalLinkId,
          brokerTradeId,
          note: String(body.note ?? "").trim() || null,
        },
      });
      const link = await ensureStockTransactionCashFlow(tx, {
        householdId,
        row,
        stockAccount,
        cashAccount,
        metadata: { createdBy: "stocks-transactions-api" },
      });
      return { id: row.id, link };
    });

    await recalcStockPositions(stockAccountId, [security.id]);
    await recalcAndSaveAccountBalance(stockAccountId).catch(() => undefined);
    if (cashAccountId) await recalcAndSaveAccountBalance(cashAccountId).catch(() => undefined);
    await invalidateCreditCardCycleCacheForAccountIds(new Set([stockAccountId, cashAccountId].filter((id): id is string => Boolean(id)))).catch(() => undefined);
    revalidateAfterInvestChange();

    const row = await prisma.stockTransaction.findUnique({
      where: { id: created.id },
      include: {
        StockAccount: { select: { name: true, currency: true } },
        CashAccount: { select: { name: true, currency: true } },
        EntryBusinessLink: { where: { deletedAt: null }, select: { id: true, cashEntryId: true } },
      },
    });

    return NextResponse.json({
      ok: true,
      data: {
        transaction: row ? serializeStockTransaction(row) : null,
        linkId: created.link.linkId,
        cashEntryId: created.link.cashEntryId,
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "CREATE_FAILED", error: error instanceof Error ? error.message : "Create failed" },
      { status: 500, headers: corsHeaders() },
    );
  }
}

/**
 * PATCH /api/v1/stocks/transactions
 * Updates an existing stock transaction, syncs the linked cash-side TxRecord
 * and EntryBusinessLink, then recalculates stock holdings and balances.
 *
 * Query:
 * - id: stock transaction id
 *
 * Body: same fields as POST; omitted fields keep their existing values.
 * stockAccountId / securityId / cashAccountId may be changed; the old cash flow
 * is replaced when the action or amounts change.
 *
 * Response:
 * - { ok: true, data: { transaction, linkId, cashEntryId } }
 */
export async function PATCH(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const id = req.nextUrl.searchParams.get("id")?.trim() || "";
    if (!id) return NextResponse.json({ ok: false, code: "MISSING_TRANSACTION_ID", error: "Missing transaction id" }, { status: 400, headers: corsHeaders() });

    const existing = await prisma.stockTransaction.findFirst({
      where: { id, householdId, deletedAt: null },
      include: {
        StockAccount: { select: { id: true, name: true, currency: true, institutionId: true } },
        CashAccount: { select: { id: true, name: true, currency: true } },
        EntryBusinessLink: { where: { deletedAt: null }, select: { id: true, cashEntryId: true } },
      },
    });
    if (!existing) return NextResponse.json({ ok: false, code: "TRANSACTION_NOT_FOUND", error: "Stock transaction was not found" }, { status: 404, headers: corsHeaders() });

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ ok: false, code: "INVALID_BODY", error: "Invalid request body" }, { status: 400, headers: corsHeaders() });

    const stockAccountId = String(body.stockAccountId ?? body.accountId ?? existing.stockAccountId).trim();
    const stockAccount = await assertStockAccount(stockAccountId, householdId);
    const action = normalizeStockAction(body.action ?? existing.action);
    const cashAccountIdRaw = String(body.cashAccountId ?? existing.cashAccountId ?? "").trim();
    const cashAccount = await findCashAccount(cashAccountIdRaw || null, householdId, stockAccountId);
    const tradeDate = parseDateOnly(body.tradeDate ?? formatDateUtc(existing.tradeDate));
    const settleDateRaw = body.settleDate !== undefined
      ? body.settleDate
      : existing.settleDate ? formatDateUtc(existing.settleDate) : null;
    const settleDate = parseDateOnly(settleDateRaw);
    if (!tradeDate) return NextResponse.json({ ok: false, code: "INVALID_TRADE_DATE", error: "Trade date is invalid" }, { status: 400, headers: corsHeaders() });

    const readNumber = (key: string): number | null => {
      if (body[key] === undefined) {
        const existingValue = existing[key as keyof typeof existing] as unknown;
        return existingValue == null ? null : toNumber(existingValue);
      }
      return parseOptionalNonNegativeNumber(body[key]);
    };
    const quantity = readNumber("quantity");
    const price = readNumber("price");
    const buySellAction = isBuySellAction(action);
    const grossAmountInput = readNumber("grossAmount");
    const grossFromQuantity = quantity != null && price != null ? quantity * price : 0;
    const grossAmount = buySellAction ? grossFromQuantity : grossAmountInput ?? grossFromQuantity;
    const netAmount = readNumber("netAmount");
    const fee = readNumber("fee");
    const commission = readNumber("commission");
    const stampTax = readNumber("stampTax");
    const transferFee = readNumber("transferFee");
    const exchangeFee = readNumber("exchangeFee");
    const regulatoryFee = readNumber("regulatoryFee");
    const otherFee = readNumber("otherFee");

    if (buySellAction && (!quantity || !price || grossAmount <= 0)) {
      return NextResponse.json({ ok: false, code: "QUANTITY_AND_PRICE_REQUIRED", error: "Buy/sell stock transactions require quantity and price" }, { status: 400, headers: corsHeaders() });
    }
    if ((action === StockTransactionAction.dividend || action === StockTransactionAction.fee_adjustment || action === StockTransactionAction.tax_adjustment) && grossAmount <= 0) {
      return NextResponse.json({ ok: false, code: "AMOUNT_REQUIRED", error: "Amount is required for this stock transaction" }, { status: 400, headers: corsHeaders() });
    }
    if ((action === StockTransactionAction.bonus_share || action === StockTransactionAction.split_share || action === StockTransactionAction.merge_share) && !quantity) {
      return NextResponse.json({ ok: false, code: "QUANTITY_REQUIRED", error: "Quantity is required for this stock transaction" }, { status: 400, headers: corsHeaders() });
    }
    if ((action === StockTransactionAction.buy || action === StockTransactionAction.sell || action === StockTransactionAction.dividend || action === StockTransactionAction.fee_adjustment || action === StockTransactionAction.tax_adjustment) && !cashAccount) {
      return NextResponse.json({ ok: false, code: "CASH_ACCOUNT_UNDETERMINED", error: "Funding account could not be resolved" }, { status: 400, headers: corsHeaders() });
    }

    const rawCode = normalizeStockCode(String(body.stockCode ?? existing.stockCode).trim());
    if (!rawCode) return NextResponse.json({ ok: false, code: "STOCK_CODE_REQUIRED", error: "Stock code is required" }, { status: 400, headers: corsHeaders() });
    const security = body.securityId || rawCode !== existing.stockCode
      ? await resolveOrCreateStockSecurity(prisma, {
          householdId,
          market: body.market ? normalizeStockMarket(body.market) : inferStockMarketFromCode(rawCode),
          stockCode: rawCode,
          stockName: normalizeUsableStockName(body.stockName, rawCode) ?? undefined,
          currency: normalizeCurrency(body.currency ?? stockAccount.currency),
          exchange: String(body.exchange ?? "").trim() || null,
        })
      : existing.securityId
        ? await prisma.stockSecurity.findFirst({ where: { id: existing.securityId, householdId, isActive: true } })
        : null;
    if (!security) return NextResponse.json({ ok: false, code: "SECURITY_NOT_FOUND", error: "Stock security was not found" }, { status: 400, headers: corsHeaders() });

    const fees = buySellAction
      ? await (async () => {
          return calculateStockTransactionFeesByDate({
            accountId: stockAccountId,
            tradeDate,
            grossAmount,
            direction: action,
            securityId: security.id,
            market: security.market,
            stockCode: security.stockCode,
            overrides: { fee, commission, stampTax, transferFee, exchangeFee, regulatoryFee, otherFee },
          });
        })()
      : { fee, commission, stampTax, transferFee, exchangeFee, regulatoryFee, otherFee };

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.stockTransaction.update({
        where: { id },
        data: {
          stockAccountId,
          cashAccountId: cashAccount?.id ?? null,
          securityId: security.id,
          market: security.market,
          stockCode: security.stockCode,
          stockName: normalizeUsableStockName(body.stockName ?? existing.stockName, security.stockCode) ?? security.stockName,
          action,
          source: String(body.source ?? existing.source ?? TRANSACTION_SOURCE_MANUAL).trim() || TRANSACTION_SOURCE_MANUAL,
          entryOrigin: body.entryOrigin ? String(body.entryOrigin).trim() : (existing.entryOrigin ?? ENTRY_ORIGIN_MANUAL),
          tradeDate,
          settleDate,
          grossAmount: String(grossAmount),
          netAmount: decimalString(netAmount),
          quantity: decimalString(quantity),
          price: decimalString(price),
          fee: decimalString(fees.fee),
          commission: decimalString(fees.commission),
          stampTax: decimalString(fees.stampTax),
          transferFee: decimalString(fees.transferFee),
          exchangeFee: decimalString(fees.exchangeFee),
          regulatoryFee: decimalString(fees.regulatoryFee),
          otherFee: decimalString(fees.otherFee),
          externalLinkId: String(body.externalLinkId ?? existing.externalLinkId ?? "").trim() || null,
          brokerTradeId: String(body.brokerTradeId ?? existing.brokerTradeId ?? "").trim() || null,
          note: String(body.note ?? existing.note ?? "").trim() || null,
        },
      });

      const link = await ensureStockTransactionCashFlow(tx, {
        householdId,
        row,
        stockAccount,
        cashAccount,
        metadata: { createdBy: "stocks-transactions-api", updatedBy: "stocks-transactions-patch" },
      });

      // If the new action no longer generates cash flow but the old record still has one,
      // soft-delete the old cash flow and the old link
      if (!link.cashEntryId && existing.cashEntryId) {
        await tx.txRecord.updateMany({
          where: { id: existing.cashEntryId, householdId },
          data: { deletedAt: new Date() },
        });
        await tx.entryBusinessLink.updateMany({
          where: { householdId, deletedAt: null, OR: [{ stockTransactionId: id }, { cashEntryId: existing.cashEntryId }] },
          data: { deletedAt: new Date() },
        });
        await tx.stockTransaction.update({ where: { id }, data: { cashEntryId: null } });
      }

      return { id: row.id, link, oldCashEntryId: existing.cashEntryId ?? null };
    });

    const recalcIds = new Set<string>([stockAccountId, existing.stockAccountId, cashAccount?.id ?? "", existing.cashAccountId ?? ""]);
    await recalcStockPositions(stockAccountId, security.id ? [security.id] : undefined);
    for (const accountId of recalcIds) {
      if (accountId) await recalcAndSaveAccountBalance(accountId).catch(() => undefined);
    }
    await invalidateCreditCardCycleCacheForAccountIds(recalcIds).catch(() => undefined);
    revalidateAfterInvestChange();

    const row = await prisma.stockTransaction.findUnique({
      where: { id: updated.id },
      include: {
        StockAccount: { select: { name: true, currency: true } },
        CashAccount: { select: { name: true, currency: true } },
        EntryBusinessLink: { where: { deletedAt: null }, select: { id: true, cashEntryId: true } },
      },
    });

    return NextResponse.json({
      ok: true,
      data: {
        transaction: row ? serializeStockTransaction(row) : null,
        linkId: updated.link.linkId,
        cashEntryId: updated.link.cashEntryId,
        oldCashEntryId: updated.oldCashEntryId,
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "UPDATE_FAILED", error: error instanceof Error ? error.message : "Update failed" },
      { status: 500, headers: corsHeaders() },
    );
  }
}

/**
 * DELETE /api/v1/stocks/transactions
 * Soft-deletes one or more stock transactions by stock transaction id, cash entry id, linkId, or ids.
 *
 * Query:
 * - id?: stock transaction id or cashEntryId
 * - ids?: comma-separated stock transaction ids for batch delete
 * - linkId?: EntryBusinessLink id
 *
 * Response:
 * - single delete: { ok: true, data: { id, cashEntryId, linkIds } }
 * - batch delete: { ok: true, data: { deletedIds, cashEntryIds, linkIds, count } }
 */
export async function DELETE(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const id = req.nextUrl.searchParams.get("id")?.trim() || "";
    const ids = parseDeleteIds(req.nextUrl.searchParams.get("ids"));
    const linkId = req.nextUrl.searchParams.get("linkId")?.trim() || "";
    const targetIds = ids.length > 0 ? ids : id ? [id] : [];
    const isBatchDelete = ids.length > 0;

    if (targetIds.length === 0 && !linkId) {
      return NextResponse.json({ ok: false, code: "MISSING_ID_OR_LINK_ID", error: "Missing id or linkId" }, { status: 400, headers: corsHeaders() });
    }

    const rows = await prisma.stockTransaction.findMany({
      where: {
        householdId,
        deletedAt: null,
        OR: [
          ...(targetIds.length > 0 ? [{ id: { in: targetIds } }, { cashEntryId: { in: targetIds } }] : []),
          ...(linkId ? [{ EntryBusinessLink: { some: { id: linkId, deletedAt: null } } }] : []),
        ],
      },
      include: {
        EntryBusinessLink: { where: { deletedAt: null }, select: { id: true } },
      },
    });
    if (rows.length === 0) return NextResponse.json({ ok: false, code: "TRANSACTION_NOT_FOUND", error: "Stock transaction was not found" }, { status: 404, headers: corsHeaders() });

    const summary = await deleteStockTransactionRows(householdId, rows);
    const shouldReturnBatch = isBatchDelete || rows.length > 1;

    if (shouldReturnBatch) {
      return NextResponse.json({
        ok: true,
        data: {
          deletedIds: summary.deletedIds,
          cashEntryIds: summary.cashEntryIds,
          linkIds: summary.linkIds,
          count: summary.deletedIds.length,
        },
      }, { headers: corsHeaders() });
    }

    const row = rows[0];
    return NextResponse.json({
      ok: true,
      data: {
        id: row.id,
        cashEntryId: row.cashEntryId,
        linkIds: row.EntryBusinessLink.map((link) => link.id),
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "DELETE_FAILED", error: error instanceof Error ? error.message : "Delete failed" },
      { status: 500, headers: corsHeaders() },
    );
  }
}
