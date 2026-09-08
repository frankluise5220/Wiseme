/**
 * API: /api/v1/properties
 *
 * GET
 *   Query: accountId?: property investment account id
 *   Response: { ok: true, data: { assets, transactions } } where each asset includes mortgageLoanAccountId when linked.
 *
 * POST
 *   Body: {
 *     accountId, cashAccountId?, propertyAssetId?,
 *     action: "purchase" | "improvement" | "sale",
 *     name?, assetType?, propertyType?, address?, attributes?, tradeDate, settlementDate?,
 *     amount, fee?, tax?, marketValue?, note?
 *   }
 *   Creates/updates the property asset, writes a PropertyTransaction, and
 *   creates the linked cash-side TxRecord when cashAccountId is supplied.
 *
 * PUT
 *   Body: { propertyAssetId, name?, assetType?, propertyType?, address?, attributes?, purchaseDate?,
 *          purchasePrice?, note? }
 *   Updates the fixed asset info fields on the PropertyAsset record.
 */
import { NextRequest, NextResponse } from "next/server";
import { AccountKind, Prisma, PropertyTransactionAction } from "@prisma/client";

import { normalizeCurrency } from "@/lib/currency";
import { normalizeFixedAssetType } from "@/lib/fixed-asset";
import { formatDateUtc, toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { ensurePropertyTransactionCashFlow } from "@/lib/property/cashFlow";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

const PROPERTY_ACTIONS = new Set(Object.values(PropertyTransactionAction));

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
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

function decimalString(value: number | null) {
  return value == null ? null : String(value);
}

function parseAttributes(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value == null) return Prisma.JsonNull;
  if (typeof value === "object" && !Array.isArray(value)) return value as Prisma.InputJsonValue;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Prisma.InputJsonValue) : Prisma.JsonNull;
    } catch {
      return Prisma.JsonNull;
    }
  }
  return Prisma.JsonNull;
}

function normalizePropertyAction(value: unknown) {
  const action = String(value ?? PropertyTransactionAction.purchase).trim();
  return PROPERTY_ACTIONS.has(action as PropertyTransactionAction)
    ? (action as PropertyTransactionAction)
    : PropertyTransactionAction.purchase;
}

async function assertPropertyAccount(accountId: string, householdId: string) {
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, kind: AccountKind.investment, investProductType: "property" },
    select: { id: true, householdId: true, name: true, currency: true, fixedAssetType: true },
  });
  if (!account) throw new Error("房产账户不存在或不属于当前账簿");
  return account;
}

async function findCashAccount(accountId: string | null, householdId: string) {
  if (!accountId) return null;
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, isPlaceholder: { not: true } },
    select: { id: true, name: true, kind: true, currency: true },
  });
  if (!account) throw new Error("资金账户不存在或不属于当前账簿");
  const isCashLike = account.kind === AccountKind.bank_debit || account.kind === AccountKind.cash || account.kind === AccountKind.ewallet;
  if (!isCashLike) throw new Error("房产资金账户必须是现金、借记卡或钱包账户");
  return account;
}

function serializeAsset(row: {
  id: string;
  accountId: string;
  mortgageLoanAccountId?: string | null;
  name: string;
  assetType?: string | null;
  propertyType?: string | null;
  address?: string | null;
  attributes?: unknown | null;
  currency?: string | null;
  purchaseDate?: Date | null;
  purchasePrice?: unknown | null;
  cost: unknown;
  marketValue: unknown;
  latestValuationDate?: Date | null;
  status: string;
  note?: string | null;
}) {
  return {
    id: row.id,
    accountId: row.accountId,
    mortgageLoanAccountId: row.mortgageLoanAccountId ?? null,
    name: row.name,
    assetType: normalizeFixedAssetType(row.assetType),
    propertyType: row.propertyType ?? null,
    address: row.address ?? null,
    attributes: row.attributes ?? null,
    currency: normalizeCurrency(row.currency),
    purchaseDate: row.purchaseDate ? formatDateUtc(row.purchaseDate) : null,
    purchasePrice: row.purchasePrice == null ? null : toNumber(row.purchasePrice),
    cost: toNumber(row.cost),
    marketValue: toNumber(row.marketValue),
    latestValuationDate: row.latestValuationDate ? formatDateUtc(row.latestValuationDate) : null,
    status: row.status,
    note: row.note ?? null,
  };
}

function serializeTransaction(row: {
  id: string;
  accountId: string;
  cashAccountId?: string | null;
  cashEntryId?: string | null;
  propertyAssetId: string;
  action: PropertyTransactionAction;
  source?: string | null;
  tradeDate: Date;
  settlementDate?: Date | null;
  amount: unknown;
  fee?: unknown | null;
  tax?: unknown | null;
  realizedProfit?: unknown | null;
  note?: string | null;
  PropertyAsset?: { name?: string | null } | null;
  Account?: { name?: string | null } | null;
  CashAccount?: { name?: string | null } | null;
  EntryBusinessLink?: Array<{ id: string }> | null;
}) {
  return {
    id: row.id,
    linkId: row.EntryBusinessLink?.[0]?.id ?? null,
    cashEntryId: row.cashEntryId ?? null,
    accountId: row.accountId,
    accountName: row.Account?.name ?? "",
    cashAccountId: row.cashAccountId ?? null,
    cashAccountName: row.CashAccount?.name ?? null,
    propertyAssetId: row.propertyAssetId,
    propertyName: row.PropertyAsset?.name ?? null,
    action: row.action,
    source: row.source ?? "manual",
    tradeDate: formatDateUtc(row.tradeDate),
    settlementDate: row.settlementDate ? formatDateUtc(row.settlementDate) : null,
    amount: toNumber(row.amount),
    fee: row.fee == null ? null : toNumber(row.fee),
    tax: row.tax == null ? null : toNumber(row.tax),
    realizedProfit: row.realizedProfit == null ? null : toNumber(row.realizedProfit),
    note: row.note ?? null,
  };
}

export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const accountId = req.nextUrl.searchParams.get("accountId")?.trim() || "";
    if (accountId) await assertPropertyAccount(accountId, householdId);
    // The transaction list is only needed by full property views; entry dialogs
    // pass transactions=0 to skip the heavy query. linkedCashEntryId asks for
    // the single property transaction linked to one cash entry (loan/fixed-asset
    // edit prefill).
    const includeTransactions = req.nextUrl.searchParams.get("transactions") !== "0";
    const linkedCashEntryId = req.nextUrl.searchParams.get("linkedCashEntryId")?.trim() || "";

    const [assets, transactions, linkedTransaction] = await Promise.all([
      prisma.propertyAsset.findMany({
        where: { householdId, deletedAt: null, ...(accountId ? { accountId } : {}) },
        orderBy: [{ status: "asc" }, { latestValuationDate: "desc" }, { createdAt: "asc" }],
      }),
      includeTransactions
        ? prisma.propertyTransaction.findMany({
            where: { householdId, deletedAt: null, ...(accountId ? { accountId } : {}) },
            include: {
              Account: true,
              CashAccount: true,
              PropertyAsset: true,
              EntryBusinessLink: { where: { deletedAt: null }, select: { id: true }, take: 1 },
            },
            orderBy: [{ tradeDate: "desc" }, { createdAt: "desc" }],
            take: 500,
          })
        : Promise.resolve([] as Array<Prisma.PropertyTransactionGetPayload<{ include: {
            Account: true;
            CashAccount: true;
            PropertyAsset: true;
            EntryBusinessLink: { where: { deletedAt: null }; select: { id: true }; take: 1 };
          } }>>),
      linkedCashEntryId
        ? prisma.propertyTransaction.findFirst({
            where: { householdId, cashEntryId: linkedCashEntryId, deletedAt: null },
            select: { accountId: true, propertyAssetId: true },
          })
        : Promise.resolve(null),
    ]);

    return NextResponse.json({
      ok: true,
      data: {
        assets: assets.map(serializeAsset),
        transactions: transactions.map(serializeTransaction),
        linkedTransaction: linkedTransaction
          ? {
              cashEntryId: linkedCashEntryId,
              accountId: linkedTransaction.accountId,
              propertyAssetId: linkedTransaction.propertyAssetId,
            }
          : null,
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "查询失败" },
      { status: 500, headers: corsHeaders() },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ ok: false, code: "INVALID_REQUEST_BODY", error: "请求体无效" }, { status: 400, headers: corsHeaders() });

    const accountId = String(body.accountId ?? "").trim();
    if (!accountId) return NextResponse.json({ ok: false, code: "MISSING_PROPERTY_ACCOUNT", error: "缺少房产账户" }, { status: 400, headers: corsHeaders() });
    const propertyAccount = await assertPropertyAccount(accountId, householdId);
    const cashAccountId = String(body.cashAccountId ?? "").trim() || null;
    const cashAccount = await findCashAccount(cashAccountId, householdId);
    const action = normalizePropertyAction(body.action);
    const tradeDate = parseDateOnly(body.tradeDate);
    const settlementDate = parseDateOnly(body.settlementDate);
    if (!tradeDate) return NextResponse.json({ ok: false, code: "INVALID_TRADE_DATE", error: "交易日期无效" }, { status: 400, headers: corsHeaders() });

    const amount = parseNonNegativeNumber(body.amount);
    const fee = parseOptionalNonNegativeNumber(body.fee);
    const tax = parseOptionalNonNegativeNumber(body.tax);
    const marketValueInput = parseOptionalNonNegativeNumber(body.marketValue);
    const isDisposal = action === PropertyTransactionAction.disposal;
    if (amount <= 0 && !isDisposal) return NextResponse.json({ ok: false, code: "INVALID_AMOUNT", error: "交易金额必须大于 0" }, { status: 400, headers: corsHeaders() });

    const touchedAccountIds = new Set<string>([accountId]);
    if (cashAccountId) touchedAccountIds.add(cashAccountId);

    const created = await prisma.$transaction(async (tx) => {
      const totalCostDelta = amount + (fee ?? 0) + (tax ?? 0);
      let propertyAssetId = String(body.propertyAssetId ?? "").trim();
      let existingAsset = propertyAssetId
        ? await tx.propertyAsset.findFirst({ where: { id: propertyAssetId, householdId, accountId, deletedAt: null } })
        : null;
      const nextAssetType = normalizeFixedAssetType(
        action === PropertyTransactionAction.purchase
          ? body.assetType ?? propertyAccount.fixedAssetType
          : existingAsset?.assetType ?? propertyAccount.fixedAssetType,
      );

      if (action === PropertyTransactionAction.purchase) {
        const assetName = String(body.name ?? "").trim();
        if (!assetName) throw new Error("购入房产需要填写房产名称");
        const initialMarketValue = marketValueInput ?? totalCostDelta;
        existingAsset = await tx.propertyAsset.create({
          data: {
            householdId,
            accountId,
            name: assetName,
            assetType: nextAssetType,
            propertyType: String(body.propertyType ?? "").trim() || null,
            address: String(body.address ?? "").trim() || null,
            attributes: parseAttributes(body.attributes),
            currency: propertyAccount.currency ?? cashAccount?.currency ?? "CNY",
            purchaseDate: tradeDate,
            purchasePrice: decimalString(amount),
            cost: String(totalCostDelta),
            marketValue: String(initialMarketValue),
            latestValuationDate: tradeDate,
            note: String(body.note ?? "").trim() || null,
          },
        });
        propertyAssetId = existingAsset.id;
        await tx.propertyValuation.create({
          data: {
            householdId,
            propertyAssetId,
            valuationDate: tradeDate,
            marketValue: String(initialMarketValue),
            source: "purchase",
            note: "购入时初始估值",
          },
        });
      } else {
        if (!existingAsset) throw new Error("房产不存在或不属于当前账户");
        const isTerminal = action === PropertyTransactionAction.sale || action === PropertyTransactionAction.disposal;
        const recovery = isTerminal ? Math.max(0, amount - (fee ?? 0) - (tax ?? 0)) : 0;
        const nextCost = action === PropertyTransactionAction.improvement
          ? toNumber(existingAsset.cost) + totalCostDelta
          : toNumber(existingAsset.cost);
        const nextMarketValue = isTerminal
          ? recovery
          : marketValueInput ?? toNumber(existingAsset.marketValue);
        await tx.propertyAsset.update({
          where: { id: existingAsset.id },
          data: {
            assetType: nextAssetType,
            cost: String(nextCost),
            marketValue: String(nextMarketValue),
            latestValuationDate: marketValueInput != null || isTerminal ? (settlementDate ?? tradeDate) : existingAsset.latestValuationDate,
            status: action === PropertyTransactionAction.sale ? "sold" : isDisposal ? "disposed" : existingAsset.status,
          },
        });
        if (marketValueInput != null || isTerminal) {
          await tx.propertyValuation.create({
            data: {
              householdId,
              propertyAssetId: existingAsset.id,
              valuationDate: settlementDate ?? tradeDate,
              marketValue: String(nextMarketValue),
              source: action === PropertyTransactionAction.sale ? "sale" : isDisposal ? "disposal" : "manual",
              note: action === PropertyTransactionAction.sale ? "出售回收金额" : isDisposal ? "废弃回收金额" : "交易后手动估值",
            },
          });
        }
      }

      await tx.account.update({
        where: { id: accountId },
        data: { fixedAssetType: nextAssetType as any },
      });

      const isTerminalAction = action === PropertyTransactionAction.sale || action === PropertyTransactionAction.disposal;
      const realizedProfit = isTerminalAction && existingAsset
        ? Math.max(0, amount - (fee ?? 0) - (tax ?? 0)) - toNumber(existingAsset.cost)
        : null;
      const row = await tx.propertyTransaction.create({
        data: {
          householdId,
          accountId,
          cashAccountId: cashAccount?.id ?? null,
          propertyAssetId,
          action,
          source: String(body.source ?? "manual").trim() || "manual",
          tradeDate,
          settlementDate,
          amount: String(amount),
          fee: decimalString(fee),
          tax: decimalString(tax),
          realizedProfit: decimalString(realizedProfit),
          note: String(body.note ?? "").trim() || null,
        },
        include: { Account: true, CashAccount: true, PropertyAsset: true },
      });
      const link = await ensurePropertyTransactionCashFlow(tx, {
        householdId,
        row,
        propertyAccount: row.Account,
        cashAccount: row.CashAccount,
        metadata: { createdBy: "properties-api" },
      });
      return { id: row.id, link };
    });

    for (const id of touchedAccountIds) {
      await recalcAndSaveAccountBalance(id).catch(() => undefined);
    }
    await invalidateCreditCardCycleCacheForAccountIds(touchedAccountIds).catch(() => undefined);
    revalidateAfterInvestChange();

    const row = await prisma.propertyTransaction.findUnique({
      where: { id: created.id },
      include: {
        Account: true,
        CashAccount: true,
        PropertyAsset: true,
        EntryBusinessLink: { where: { deletedAt: null }, select: { id: true }, take: 1 },
      },
    });

    return NextResponse.json({
      ok: true,
      data: {
        transaction: row ? serializeTransaction(row) : null,
        linkId: created.link.linkId,
        cashEntryId: created.link.cashEntryId,
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "CREATE_FAILED", error: error instanceof Error ? error.message : "创建失败" },
      { status: 500, headers: corsHeaders() },
    );
  }
}


export async function PUT(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const propertyAssetId = String(body?.propertyAssetId ?? "").trim();
    if (!propertyAssetId) {
      return NextResponse.json({ ok: false, code: "MISSING_PROPERTY_ASSET_ID", error: "Missing propertyAssetId" }, { status: 400, headers: corsHeaders() });
    }
    const asset = await prisma.propertyAsset.findFirst({
      where: { id: propertyAssetId, householdId, deletedAt: null },
    });
    if (!asset) {
      return NextResponse.json({ ok: false, code: "PROPERTY_ASSET_NOT_FOUND", error: "Property asset not found" }, { status: 404, headers: corsHeaders() });
    }
    const name = String(body?.name ?? "").trim();
    if (!name) {
      return NextResponse.json({ ok: false, code: "INVALID_NAME", error: "Asset name is required" }, { status: 400, headers: corsHeaders() });
    }
    const purchaseDate = parseDateOnly(body?.purchaseDate);
    const purchasePrice = parseOptionalNonNegativeNumber(body?.purchasePrice);
    const nextStatus = String(body?.status ?? "").trim() || "active";
    const updated = await prisma.$transaction(async (tx) => {
      const nextAssetType = normalizeFixedAssetType(body?.assetType);
      const updatedAsset = await tx.propertyAsset.update({
        where: { id: propertyAssetId },
        data: {
          name,
          assetType: nextAssetType,
          propertyType: String(body?.propertyType ?? "").trim() || null,
          address: String(body?.address ?? "").trim() || null,
          attributes: parseAttributes(body?.attributes),
          purchaseDate,
          purchasePrice: purchasePrice == null ? null : String(purchasePrice),
          note: String(body?.note ?? "").trim() || null,
          status: nextStatus,
        },
      });
      await tx.account.updateMany({
        where: { id: updatedAsset.accountId, householdId, kind: AccountKind.investment, investProductType: "property" },
        data: { fixedAssetType: nextAssetType as any },
      });
      return updatedAsset;
    });
    revalidateAfterInvestChange();
    return NextResponse.json({ ok: true, data: { asset: serializeAsset(updated) } }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "UPDATE_FAILED", error: error instanceof Error ? error.message : "Update failed" },
      { status: 500, headers: corsHeaders() },
    );
  }
}
