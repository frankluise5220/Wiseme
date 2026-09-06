import { Prisma, PropertyTransactionAction, TransactionType } from "@prisma/client";

import { toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { resolveCategorySnapshot } from "@/lib/default-categories";
import { getPropertyInvestmentCategoryName } from "@/lib/investment-category";
import {
  upsertEntryBusinessCashFlowLink,
  type EntryCashFlowDirection,
} from "@/lib/server/entry-business-link";
import { getCashFlowDate } from "@/lib/cash-flow-date";

type TxClient = Prisma.TransactionClient | typeof prisma;

export type PropertyCashFlowRow = {
  id: string;
  householdId: string;
  accountId: string;
  cashAccountId?: string | null;
  cashEntryId?: string | null;
  propertyAssetId: string;
  action: PropertyTransactionAction | string;
  source?: string | null;
  tradeDate: Date;
  settlementDate?: Date | null;
  amount: unknown;
  fee?: unknown | null;
  tax?: unknown | null;
  realizedProfit?: unknown | null;
  note?: string | null;
  PropertyAsset?: { name?: string | null } | null;
};

type AccountSnapshot = {
  id: string;
  name: string;
  currency?: string | null;
};

export function propertyActionLabel(action: PropertyTransactionAction | string) {
  if (action === PropertyTransactionAction.sale || action === "sale") return "房产出售";
  if (action === PropertyTransactionAction.disposal || action === "disposal") return "房产废弃";
  if (action === PropertyTransactionAction.improvement || action === "improvement") return "装修投入";
  return "房产购入";
}

export function propertyCashFlowDirection(action: PropertyTransactionAction | string): EntryCashFlowDirection {
  if (action === PropertyTransactionAction.sale || action === "sale") return "inflow";
  if (action === PropertyTransactionAction.disposal || action === "disposal") return "inflow";
  if (action === PropertyTransactionAction.purchase || action === "purchase") return "outflow";
  if (action === PropertyTransactionAction.improvement || action === "improvement") return "outflow";
  return "none";
}

export function propertyCashAmount(row: Partial<PropertyCashFlowRow>) {
  const action = row.action;
  if (!action || propertyCashFlowDirection(action) === "none") return 0;
  const amount = Math.abs(toNumber(row.amount));
  const fee = Math.abs(toNumber(row.fee));
  const tax = Math.abs(toNumber(row.tax));
  if (propertyCashFlowDirection(action) === "inflow") return Math.max(0, amount - fee - tax);
  return amount + fee + tax;
}

function buildPropertyCashFlowNote(row: PropertyCashFlowRow) {
  const label = propertyActionLabel(row.action);
  const targetName = row.PropertyAsset?.name || row.note?.trim();
  return row.note?.trim() || [label, targetName].filter(Boolean).join(" ");
}

export async function ensurePropertyTransactionCashFlow(
  client: TxClient,
  params: {
    householdId: string;
    row: PropertyCashFlowRow;
    propertyAccount: AccountSnapshot;
    cashAccount?: AccountSnapshot | null;
    metadata?: Record<string, unknown> | null;
  },
) {
  const direction = propertyCashFlowDirection(params.row.action);
  const cashAmount = propertyCashAmount(params.row);
  const shouldCreateCashEntry = direction !== "none" && cashAmount > 0 && params.row.cashAccountId && params.cashAccount;
  let cashEntryId: string | null = params.row.cashEntryId ?? null;

  if (shouldCreateCashEntry && params.cashAccount) {
    const isCashIn = direction === "inflow";
    const categoryName = getPropertyInvestmentCategoryName(params.row.action);
    const category = await resolveCategorySnapshot(client, params.householdId, {
      categoryName,
      type: "investment",
    });
    const signedCashAmount = isCashIn ? Math.abs(cashAmount) : -Math.abs(cashAmount);
    const cashDate = getCashFlowDate({
      direction,
      operationDate: params.row.tradeDate,
      settlementDate: params.row.settlementDate,
    });
    const cashEntryData = {
      householdId: params.householdId,
      date: cashDate,
      type: TransactionType.investment,
      accountId: isCashIn ? params.propertyAccount.id : params.cashAccount.id,
      accountName: isCashIn ? params.propertyAccount.name : params.cashAccount.name,
      toAccountId: isCashIn ? params.cashAccount.id : params.propertyAccount.id,
      toAccountName: isCashIn ? params.cashAccount.name : params.propertyAccount.name,
      amount: signedCashAmount,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? categoryName,
      currency: params.cashAccount.currency ?? params.propertyAccount.currency ?? "CNY",
      source: params.row.source ?? "manual",
      note: buildPropertyCashFlowNote(params.row),
      fundCode: null,
      fundProductType: null,
      fundSubtype: null,
      fundName: null,
      wealthProductId: null,
      metalTypeId: null,
      metalTypeName: null,
      metalUnitId: null,
      metalUnitName: null,
      metalQuantity: null,
      metalUnitPrice: null,
      metalFee: null,
      insuranceProductId: null,
      insuranceAction: null,
      insuranceProductName: null,
      fundUnits: null,
      fundNav: null,
      fundFee: null,
      fundConfirmDate: null,
      fundArrivalDate: null,
      fundArrivalAmount: null,
      depositAnnualRate: null,
      depositInterest: null,
      realizedProfit: params.row.realizedProfit == null ? null : toNumber(params.row.realizedProfit),
      deletedAt: null,
    };

    const existingCashEntry = cashEntryId
      ? await client.txRecord.findUnique({ where: { id: cashEntryId } })
      : null;
    const cashEntry = existingCashEntry
      ? await client.txRecord.update({ where: { id: existingCashEntry.id }, data: cashEntryData })
      : await client.txRecord.create({ data: cashEntryData });

    cashEntryId = cashEntry.id;
    await client.propertyTransaction.update({
      where: { id: params.row.id },
      data: {
        cashEntryId,
        cashAccountId: params.row.cashAccountId ?? params.cashAccount.id,
      },
    });
  }

  const linkId = await upsertEntryBusinessCashFlowLink(client, {
    householdId: params.householdId,
    cashEntryId,
    businessEntryId: null,
    propertyTransactionId: params.row.id,
    businessType: "property",
    cashFlowDirection: direction,
    source: params.row.source ?? "manual",
    note: "Linked cash flow to property transaction",
    metadata: {
      splitRecord: true,
      independentBusinessTransaction: true,
      ...(params.metadata ?? {}),
    },
  });

  return {
    cashEntryId,
    linkId: linkId ?? null,
    cashFlowDirection: direction,
    cashAmount: direction === "outflow" ? -Math.abs(cashAmount) : Math.abs(cashAmount),
  };
}
