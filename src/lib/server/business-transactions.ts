import { FundSubtype, Prisma, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { calculateWealthCashDividendProfit } from "@/lib/wealth-position";
import {
  classifyEntryBusinessType,
  upsertEntryBusinessCashFlowLink,
  type EntryBusinessType,
} from "@/lib/server/entry-business-link";

type TxClient = Prisma.TransactionClient | typeof prisma;

function normalSubtype(value: unknown): FundSubtype {
  return Object.values(FundSubtype).includes(value as FundSubtype) ? (value as FundSubtype) : FundSubtype.buy;
}

function isCashInSubtype(subtype: FundSubtype) {
  return subtype === FundSubtype.redeem || subtype === FundSubtype.switch_out || subtype === FundSubtype.dividend_cash;
}

function businessAccountIdOf(entry: { accountId: string; toAccountId?: string | null }, subtype: FundSubtype) {
  return isCashInSubtype(subtype) ? entry.accountId : entry.toAccountId ?? entry.accountId;
}

function fallbackCashAccountIdOf(entry: { accountId: string; toAccountId?: string | null }, subtype: FundSubtype) {
  if (isCashInSubtype(subtype)) return entry.toAccountId ?? null;
  return entry.toAccountId ? entry.accountId : null;
}

async function softDeleteIndependentBusinessProjection(client: TxClient, entryId: string) {
  const deletedAt = new Date();
  await Promise.all([
    client.insuranceTransaction.updateMany({ where: { id: entryId, deletedAt: null }, data: { deletedAt } }),
    client.wealthTransaction.updateMany({ where: { id: entryId, deletedAt: null }, data: { deletedAt } }),
    client.depositTransaction.updateMany({ where: { id: entryId, deletedAt: null }, data: { deletedAt } }),
    client.preciousMetalTransaction.updateMany({ where: { id: entryId, deletedAt: null }, data: { deletedAt } }),
    client.stockTransaction.updateMany({ where: { id: entryId, deletedAt: null }, data: { deletedAt } }),
    client.propertyTransaction.updateMany({ where: { id: entryId, deletedAt: null }, data: { deletedAt } }),
    client.entryBusinessLink.updateMany({
      where: {
        deletedAt: null,
        OR: [
          { businessEntryId: entryId },
          { insuranceTransactionId: entryId },
          { wealthTransactionId: entryId },
          { depositTransactionId: entryId },
          { preciousMetalTransactionId: entryId },
          { stockTransactionId: entryId },
          { propertyTransactionId: entryId },
        ],
      },
      data: { deletedAt },
    }),
  ]);
}

export async function syncIndependentBusinessTransactionFromTxRecord(
  client: TxClient,
  params: {
    businessEntryId: string;
    cashEntryId?: string | null;
  },
) {
  const entry = await client.txRecord.findUnique({
    where: { id: params.businessEntryId },
  });
  if (!entry || !entry.householdId) return null;

  const businessType = classifyEntryBusinessType(entry);
  if (entry.type !== TransactionType.investment || !businessType) {
    await softDeleteIndependentBusinessProjection(client, entry.id);
    return null;
  }

  const cashEntry = params.cashEntryId
    ? await client.txRecord.findUnique({
        where: { id: params.cashEntryId },
        select: { id: true, accountId: true, date: true, amount: true },
      })
    : null;

  const subtype = normalSubtype(entry.fundSubtype);
  const businessAccountId = businessAccountIdOf(entry, subtype);
  const cashAccountId = cashEntry?.accountId ?? fallbackCashAccountIdOf(entry, subtype);
  const cashEntryId = cashEntry?.id ?? entry.id;
  const absAmount = Math.abs(toNumber(entry.amount));
  const arrivalAmount = entry.fundArrivalAmount == null ? null : Math.abs(toNumber(entry.fundArrivalAmount));
  const principalAmount = isCashInSubtype(subtype) && subtype !== FundSubtype.dividend_cash
    ? Math.max(0, (arrivalAmount ?? absAmount) - toNumber(entry.depositInterest) + toNumber(entry.fundFee))
    : absAmount;
  const wealthRealizedProfit = subtype === FundSubtype.dividend_cash
    ? calculateWealthCashDividendProfit({ arrivalAmount, grossAmount: principalAmount })
    : entry.realizedProfit;
  let targetId: string | null = null;
  let targetType: EntryBusinessType = businessType;

  if (businessType === "insurance") {
    if (!entry.insuranceProductId) return null;
    const row = await client.insuranceTransaction.upsert({
      where: { id: entry.id },
      create: {
        id: entry.id,
        householdId: entry.householdId,
        accountId: businessAccountId,
        cashAccountId,
        cashEntryId,
        insuranceProductId: entry.insuranceProductId,
        action: entry.insuranceAction ?? (subtype === FundSubtype.buy ? "premium" : "refund"),
        source: entry.source,
        entryOrigin: entry.entryOrigin,
        tradeDate: entry.date,
        postedAt: entry.postedAt,
        arrivalDate: entry.fundArrivalDate,
        amount: absAmount,
        fee: entry.fundFee,
        realizedProfit: entry.realizedProfit,
        note: entry.note,
        deletedAt: entry.deletedAt,
      },
      update: {
        accountId: businessAccountId,
        cashAccountId,
        cashEntryId,
        insuranceProductId: entry.insuranceProductId,
        action: entry.insuranceAction ?? (subtype === FundSubtype.buy ? "premium" : "refund"),
        source: entry.source,
        entryOrigin: entry.entryOrigin,
        tradeDate: entry.date,
        postedAt: entry.postedAt,
        arrivalDate: entry.fundArrivalDate,
        amount: absAmount,
        fee: entry.fundFee,
        realizedProfit: entry.realizedProfit,
        note: entry.note,
        deletedAt: entry.deletedAt,
      },
    });
    targetId = row.id;
  } else if (businessType === "wealth") {
    const row = await client.wealthTransaction.upsert({
      where: { id: entry.id },
      create: {
        id: entry.id,
        householdId: entry.householdId,
        accountId: businessAccountId,
        cashAccountId,
        cashEntryId,
        wealthProductId: entry.wealthProductId,
        productName: entry.fundName,
        action: subtype,
        source: entry.source,
        entryOrigin: entry.entryOrigin,
        tradeDate: entry.date,
        confirmDate: entry.fundConfirmDate,
        arrivalDate: entry.fundArrivalDate,
        grossAmount: principalAmount,
        arrivalAmount,
        units: entry.fundUnits,
        nav: entry.fundNav,
        interest: entry.depositInterest,
        fee: entry.fundFee,
        annualRate: entry.depositAnnualRate,
        realizedProfit: wealthRealizedProfit,
        note: entry.note,
        deletedAt: entry.deletedAt,
      },
      update: {
        accountId: businessAccountId,
        cashAccountId,
        cashEntryId,
        wealthProductId: entry.wealthProductId,
        productName: entry.fundName,
        action: subtype,
        source: entry.source,
        entryOrigin: entry.entryOrigin,
        tradeDate: entry.date,
        confirmDate: entry.fundConfirmDate,
        arrivalDate: entry.fundArrivalDate,
        grossAmount: principalAmount,
        arrivalAmount,
        units: entry.fundUnits,
        nav: entry.fundNav,
        interest: entry.depositInterest,
        fee: entry.fundFee,
        annualRate: entry.depositAnnualRate,
        realizedProfit: wealthRealizedProfit,
        note: entry.note,
        deletedAt: entry.deletedAt,
      },
    });
    targetId = row.id;
  } else if (businessType === "deposit") {
    const isDepositCashIn = isCashInSubtype(subtype);
    const maturityDate = isDepositCashIn ? null : entry.fundArrivalDate;
    const depositArrivalDate = isDepositCashIn ? entry.fundArrivalDate : null;
    const row = await client.depositTransaction.upsert({
      where: { id: entry.id },
      create: {
        id: entry.id,
        householdId: entry.householdId,
        accountId: businessAccountId,
        cashAccountId,
        cashEntryId,
        sourceDepositTransactionId: entry.depositSourceEntryId,
        productName: entry.fundName ?? entry.fundCode,
        action: subtype,
        source: entry.source,
        entryOrigin: entry.entryOrigin,
        tradeDate: entry.date,
        maturityDate,
        arrivalDate: depositArrivalDate,
        principalAmount: absAmount,
        arrivalAmount,
        interest: entry.depositInterest,
        fee: entry.fundFee,
        annualRate: entry.depositAnnualRate,
        realizedProfit: entry.realizedProfit,
        note: entry.note,
        deletedAt: entry.deletedAt,
      },
      update: {
        accountId: businessAccountId,
        cashAccountId,
        cashEntryId,
        sourceDepositTransactionId: entry.depositSourceEntryId,
        productName: entry.fundName ?? entry.fundCode,
        action: subtype,
        source: entry.source,
        entryOrigin: entry.entryOrigin,
        tradeDate: entry.date,
        maturityDate,
        arrivalDate: depositArrivalDate,
        principalAmount: absAmount,
        arrivalAmount,
        interest: entry.depositInterest,
        fee: entry.fundFee,
        annualRate: entry.depositAnnualRate,
        realizedProfit: entry.realizedProfit,
        note: entry.note,
        deletedAt: entry.deletedAt,
      },
    });
    targetId = row.id;
  } else if (businessType === "metal") {
    if (!entry.metalTypeId || !entry.metalUnitId || !entry.metalTypeName || !entry.metalUnitName) return null;
    const row = await client.preciousMetalTransaction.upsert({
      where: { id: entry.id },
      create: {
        id: entry.id,
        householdId: entry.householdId,
        accountId: businessAccountId,
        cashAccountId,
        cashEntryId,
        metalTypeId: entry.metalTypeId,
        metalTypeName: entry.metalTypeName,
        metalUnitId: entry.metalUnitId,
        metalUnitName: entry.metalUnitName,
        action: subtype,
        source: entry.source,
        entryOrigin: entry.entryOrigin,
        tradeDate: entry.date,
        amount: absAmount,
        quantity: entry.metalQuantity,
        unitPrice: entry.metalUnitPrice,
        fee: entry.metalFee,
        realizedProfit: entry.realizedProfit,
        note: entry.note,
        deletedAt: entry.deletedAt,
      },
      update: {
        accountId: businessAccountId,
        cashAccountId,
        cashEntryId,
        metalTypeId: entry.metalTypeId,
        metalTypeName: entry.metalTypeName,
        metalUnitId: entry.metalUnitId,
        metalUnitName: entry.metalUnitName,
        action: subtype,
        source: entry.source,
        entryOrigin: entry.entryOrigin,
        tradeDate: entry.date,
        amount: absAmount,
        quantity: entry.metalQuantity,
        unitPrice: entry.metalUnitPrice,
        fee: entry.metalFee,
        realizedProfit: entry.realizedProfit,
        note: entry.note,
        deletedAt: entry.deletedAt,
      },
    });
    targetId = row.id;
  }

  if (!targetId) return null;

  await upsertEntryBusinessCashFlowLink(client, {
    householdId: entry.householdId,
    cashEntryId,
    businessEntryId: entry.id,
    fundTransactionId: targetType === "fund" ? targetId : null,
    insuranceTransactionId: targetType === "insurance" ? targetId : null,
    wealthTransactionId: targetType === "wealth" ? targetId : null,
    depositTransactionId: targetType === "deposit" ? targetId : null,
    preciousMetalTransactionId: targetType === "metal" ? targetId : null,
    stockTransactionId: targetType === "stock" ? targetId : null,
    propertyTransactionId: targetType === "property" ? targetId : null,
    businessType: targetType,
    cashFlowDirection: cashEntry ? (toNumber(cashEntry.amount) < 0 ? "outflow" : "inflow") : "none",
    source: entry.source,
    note: "Linked cash flow to independent business transaction",
    metadata: {
      splitRecord: true,
      independentBusinessTransaction: true,
    },
  });

  return { businessType: targetType, businessTransactionId: targetId };
}
