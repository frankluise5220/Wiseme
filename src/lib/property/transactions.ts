import { AccountKind, Prisma, PropertyTransactionAction, TransactionType } from "@prisma/client";

import { toNumber } from "@/lib/date-utils";
import { normalizeFixedAssetType } from "@/lib/fixed-asset";
import { prisma } from "@/lib/db/prisma";
import { upsertEntryBusinessCashFlowLink } from "@/lib/server/entry-business-link";

type TxClient = Prisma.TransactionClient | typeof prisma;

type CashEntrySnapshot = {
  id: string;
  accountId: string;
  accountName?: string | null;
  amount: unknown;
  type: TransactionType | string;
  date: Date;
  postedAt?: Date | null;
  currency?: string | null;
  note?: string | null;
};

type FixedAssetSyncResult = {
  touched: boolean;
  propertyAssetIds: string[];
  accountIds: string[];
};

function emptySyncResult(): FixedAssetSyncResult {
  return { touched: false, propertyAssetIds: [], accountIds: [] };
}

function compactStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

function decimalString(value: number | null | undefined) {
  return value == null ? null : String(value);
}

function transactionCost(row: { action: PropertyTransactionAction | string; amount: unknown; fee?: unknown | null; tax?: unknown | null }) {
  if (row.action !== PropertyTransactionAction.purchase && row.action !== PropertyTransactionAction.improvement) return 0;
  return Math.abs(toNumber(row.amount)) + Math.abs(toNumber(row.fee)) + Math.abs(toNumber(row.tax));
}

function saleRecovery(row: { amount: unknown; fee?: unknown | null; tax?: unknown | null }) {
  return Math.max(0, Math.abs(toNumber(row.amount)) - Math.abs(toNumber(row.fee)) - Math.abs(toNumber(row.tax)));
}

function isMortgageLoanAccount(account: { kind: AccountKind; isConsumerLoan?: boolean | null } | null | undefined) {
  return account?.kind === AccountKind.loan && account.isConsumerLoan !== true;
}

export async function linkExpenseToFixedAsset(
  client: TxClient,
  params: {
    householdId: string;
    propertyAccountId: string;
    propertyAssetId?: string | null;
    cashEntry: CashEntrySnapshot;
    propertyName?: string | null;
  },
) {
  const amount = Math.abs(toNumber(params.cashEntry.amount));
  if (amount <= 0) throw new Error("Fixed asset amount must be greater than zero");
  if (params.cashEntry.type !== TransactionType.expense && params.cashEntry.type !== "expense") {
    throw new Error("Fixed asset links require an expense cash entry");
  }

  const propertyAccount = await client.account.findFirst({
    where: {
      id: params.propertyAccountId,
      householdId: params.householdId,
      kind: AccountKind.investment,
      investProductType: "property",
      isActive: true,
      isPlaceholder: { not: true },
    },
    select: { id: true, name: true, kind: true, investProductType: true, fixedAssetType: true, currency: true },
  });
  if (!propertyAccount) throw new Error("Fixed asset account not found");
  const fundingAccount = await client.account.findFirst({
    where: {
      id: params.cashEntry.accountId,
      householdId: params.householdId,
      isPlaceholder: { not: true },
    },
    select: { id: true, kind: true, isConsumerLoan: true },
  });
  const mortgageLoanAccountId = isMortgageLoanAccount(fundingAccount) ? (fundingAccount?.id ?? null) : null;

  const requestedPropertyAssetId = params.propertyAssetId?.trim() ?? "";
  const requestedPropertyAsset = requestedPropertyAssetId
    ? await client.propertyAsset.findFirst({
        where: {
          id: requestedPropertyAssetId,
          householdId: params.householdId,
          accountId: propertyAccount.id,
          status: "active",
          deletedAt: null,
        },
      })
    : null;
  if (requestedPropertyAssetId && !requestedPropertyAsset) {
    throw new Error("Fixed asset not found");
  }

  const tradeDate = params.cashEntry.postedAt ?? params.cashEntry.date;
  const note = params.cashEntry.note?.trim() || null;
  const propertyName = params.propertyName?.trim() || propertyAccount.name;
  const nextAssetType = normalizeFixedAssetType(propertyAccount.fixedAssetType);

  const existingLinked = await client.propertyTransaction.findFirst({
    where: { householdId: params.householdId, cashEntryId: params.cashEntry.id, deletedAt: null },
    select: { id: true, propertyAssetId: true, accountId: true },
  });
  if (existingLinked) {
    let targetPropertyAssetId = requestedPropertyAsset?.id ?? existingLinked.propertyAssetId;
    const shouldSwitchAsset = Boolean(
      requestedPropertyAsset?.id && requestedPropertyAsset.id !== existingLinked.propertyAssetId,
    );
    if (existingLinked.accountId !== propertyAccount.id || shouldSwitchAsset) {
      const accountAsset = requestedPropertyAsset ?? await client.propertyAsset.findFirst({
        where: {
          householdId: params.householdId,
          accountId: propertyAccount.id,
          status: "active",
          deletedAt: null,
        },
        orderBy: [{ purchaseDate: "asc" }, { createdAt: "asc" }],
      });
      const targetAsset = accountAsset ?? await client.propertyAsset.create({
        data: {
          householdId: params.householdId,
          accountId: propertyAccount.id,
          mortgageLoanAccountId,
          name: propertyName,
          assetType: nextAssetType,
          propertyType: "fixed_asset",
          currency: propertyAccount.currency ?? params.cashEntry.currency ?? "CNY",
          purchaseDate: tradeDate,
          purchasePrice: String(amount),
          cost: String(amount),
          marketValue: String(amount),
          latestValuationDate: tradeDate,
          note,
        },
      });
      if (targetAsset.assetType !== nextAssetType) {
        await client.propertyAsset.update({ where: { id: targetAsset.id }, data: { assetType: nextAssetType } });
      }
      if (mortgageLoanAccountId) {
        await client.propertyAsset.update({
          where: { id: targetAsset.id },
          data: { mortgageLoanAccountId },
        });
      }
      targetPropertyAssetId = targetAsset.id;
    }
    await client.propertyTransaction.update({
      where: { id: existingLinked.id },
      data: {
        accountId: propertyAccount.id,
        cashAccountId: params.cashEntry.accountId,
        propertyAssetId: targetPropertyAssetId,
        tradeDate,
        amount: String(amount),
        note,
        deletedAt: null,
      },
    });
    await client.account.update({
      where: { id: propertyAccount.id },
      data: { fixedAssetType: nextAssetType },
    });
    await upsertEntryBusinessCashFlowLink(client, {
      householdId: params.householdId,
      cashEntryId: params.cashEntry.id,
      propertyTransactionId: existingLinked.id,
      businessType: "property",
      cashFlowDirection: "outflow",
      source: "expense_fixed_asset",
      note: "Linked expense entry to fixed asset transaction",
      metadata: {
        splitRecord: true,
        independentBusinessTransaction: true,
        cashEntryType: "expense",
      },
    });
    await recalcPropertyAssetsFromTransactions(client, {
      householdId: params.householdId,
      propertyAssetIds: [existingLinked.propertyAssetId, targetPropertyAssetId],
    });
    return existingLinked.id;
  }

  const existingAsset = await client.propertyAsset.findFirst({
    where: {
      householdId: params.householdId,
      accountId: propertyAccount.id,
      status: "active",
      deletedAt: null,
    },
    orderBy: [{ purchaseDate: "asc" }, { createdAt: "asc" }],
  });
  const targetExistingAsset = requestedPropertyAsset ?? existingAsset;

  const action = targetExistingAsset ? PropertyTransactionAction.improvement : PropertyTransactionAction.purchase;
  const propertyAsset = targetExistingAsset
    ? await client.propertyAsset.update({
        where: { id: targetExistingAsset.id },
        data: { cost: String(toNumber(targetExistingAsset.cost) + amount) },
      })
    : await client.propertyAsset.create({
        data: {
          householdId: params.householdId,
          accountId: propertyAccount.id,
          name: propertyName,
          assetType: nextAssetType,
          propertyType: "fixed_asset",
          currency: propertyAccount.currency ?? params.cashEntry.currency ?? "CNY",
          purchaseDate: tradeDate,
          purchasePrice: String(amount),
          cost: String(amount),
          marketValue: String(amount),
          latestValuationDate: tradeDate,
          note,
        },
      });

  if (!targetExistingAsset) {
    await client.propertyValuation.create({
      data: {
        householdId: params.householdId,
        propertyAssetId: propertyAsset.id,
        valuationDate: tradeDate,
        marketValue: String(amount),
        source: "expense_fixed_asset",
        note,
      },
    });
  }

  await client.account.update({
    where: { id: propertyAccount.id },
    data: { fixedAssetType: nextAssetType },
  });

  const row = await client.propertyTransaction.create({
      data: {
        householdId: params.householdId,
        accountId: propertyAccount.id,
        cashAccountId: params.cashEntry.accountId,
        cashEntryId: params.cashEntry.id,
      propertyAssetId: propertyAsset.id,
      action,
      source: "expense_fixed_asset",
      tradeDate,
      amount: String(amount),
      note,
    },
  });

  await upsertEntryBusinessCashFlowLink(client, {
    householdId: params.householdId,
    cashEntryId: params.cashEntry.id,
    propertyTransactionId: row.id,
    businessType: "property",
    cashFlowDirection: "outflow",
    source: "expense_fixed_asset",
    note: "Linked expense entry to fixed asset transaction",
    metadata: {
      splitRecord: true,
      independentBusinessTransaction: true,
      cashEntryType: "expense",
    },
  });

  await recalcPropertyAssetsFromTransactions(client, {
    householdId: params.householdId,
    propertyAssetIds: [propertyAsset.id],
  });

  return row.id;
}

export async function syncLinkedFixedAssetTransactionFromCashEntry(
  client: TxClient,
  params: {
    householdId: string;
    cashEntry: CashEntrySnapshot;
  },
): Promise<FixedAssetSyncResult> {
  const row = await client.propertyTransaction.findFirst({
    where: { householdId: params.householdId, cashEntryId: params.cashEntry.id, deletedAt: null },
    select: { id: true, propertyAssetId: true, accountId: true, cashAccountId: true, action: true, fee: true, tax: true },
  });
  if (!row) return emptySyncResult();

  const propertyAssetIds = [row.propertyAssetId];
  const accountIds = compactStrings([row.accountId, row.cashAccountId, params.cashEntry.accountId]);
  const isExpense = params.cashEntry.type === TransactionType.expense || params.cashEntry.type === "expense";
  const isCashIn = params.cashEntry.type === TransactionType.income || params.cashEntry.type === "income";
  const isSale = row.action === PropertyTransactionAction.sale;
  const feeAbs = Math.abs(toNumber(row.fee));
  const taxAbs = Math.abs(toNumber(row.tax));

  // A sale linked to an income cash entry stays a sale business record;
  // only purchases/improvements linked to a converted non-expense entry are unlinked.
  if (!isExpense && !(isCashIn && isSale)) {
    const deletedAt = new Date();
    await client.propertyTransaction.update({
      where: { id: row.id },
      data: { deletedAt },
    });
    await client.entryBusinessLink.updateMany({
      where: {
        householdId: params.householdId,
        deletedAt: null,
        OR: [{ cashEntryId: params.cashEntry.id }, { propertyTransactionId: row.id }],
      },
      data: { deletedAt },
    });
    await recalcPropertyAssetsFromTransactions(client, { householdId: params.householdId, propertyAssetIds });
    return { touched: true, propertyAssetIds, accountIds };
  }

  const cashAmount = Math.abs(toNumber(params.cashEntry.amount));
  if (cashAmount <= 0) return emptySyncResult();
  const tradeDate = params.cashEntry.postedAt ?? params.cashEntry.date;
  const note = params.cashEntry.note?.trim() || null;
  // Keep the business amount as the gross price; the cash entry stores the
  // fee/tax-inclusive outflow or the fee/tax-exclusive sale inflow.
  const businessAmount = isCashIn
    ? cashAmount + feeAbs + taxAbs
    : Math.max(0, cashAmount - feeAbs - taxAbs);

  await client.propertyTransaction.update({
    where: { id: row.id },
    data: {
      cashAccountId: params.cashEntry.accountId,
      tradeDate,
      amount: String(businessAmount),
      note,
      deletedAt: null,
    },
  });
  await recalcPropertyAssetsFromTransactions(client, { householdId: params.householdId, propertyAssetIds });
  return { touched: true, propertyAssetIds, accountIds };
}

export async function recalcPropertyAssetsFromTransactions(
  client: TxClient,
  params: {
    householdId: string;
    propertyAssetIds: string[];
  },
) {
  const ids = Array.from(new Set(params.propertyAssetIds.filter(Boolean)));
  if (ids.length === 0) return;

  for (const propertyAssetId of ids) {
    const rows = await client.propertyTransaction.findMany({
      where: { householdId: params.householdId, propertyAssetId, deletedAt: null },
      orderBy: [{ tradeDate: "asc" }, { createdAt: "asc" }],
    });
    const relatedAccountIds = Array.from(new Set(rows.map((row) => row.cashAccountId).filter((value): value is string => Boolean(value))));
    const relatedAccounts = relatedAccountIds.length > 0
      ? await client.account.findMany({
          where: { householdId: params.householdId, id: { in: relatedAccountIds } },
          select: { id: true, kind: true, isConsumerLoan: true },
        })
      : [];
    const mortgageLoanAccountIds = new Set(
      relatedAccounts.filter((account) => isMortgageLoanAccount(account)).map((account) => account.id),
    );
    const latestMortgageLoanAccountId = rows.reduce<string | null>((current, row) => {
      if (!row.cashAccountId || !mortgageLoanAccountIds.has(row.cashAccountId)) return current;
      if (row.action === PropertyTransactionAction.sale || row.action === PropertyTransactionAction.disposal) return current;
      return row.cashAccountId;
    }, null);

    if (rows.length === 0) {
      await client.propertyAsset.updateMany({
        where: { id: propertyAssetId, householdId: params.householdId, deletedAt: null },
        data: { deletedAt: new Date(), cost: "0", marketValue: "0", status: "deleted", mortgageLoanAccountId: null },
      });
      continue;
    }

    const firstPurchase = rows.find((row) => row.action === PropertyTransactionAction.purchase);
    const latestTerminal = [...rows].reverse().find(
      (row) => row.action === PropertyTransactionAction.sale || row.action === PropertyTransactionAction.disposal,
    );
    const cost = rows.reduce((sum, row) => sum + transactionCost(row), 0);
    const manualValuation = await client.propertyValuation.findFirst({
      where: { householdId: params.householdId, propertyAssetId, source: "manual" },
      orderBy: [{ valuationDate: "desc" }, { createdAt: "desc" }],
    });
    const marketValue = latestTerminal
      ? saleRecovery(latestTerminal)
      : manualValuation
        ? toNumber(manualValuation.marketValue)
        : cost;
    const latestValuationDate = latestTerminal?.settlementDate ?? latestTerminal?.tradeDate ?? manualValuation?.valuationDate ?? firstPurchase?.tradeDate ?? rows[0]?.tradeDate ?? null;

    await client.propertyAsset.updateMany({
      where: { id: propertyAssetId, householdId: params.householdId },
      data: {
        deletedAt: null,
        cost: String(cost),
        marketValue: String(marketValue),
        latestValuationDate,
        status: latestTerminal
          ? latestTerminal.action === PropertyTransactionAction.disposal ? "disposed" : "sold"
          : latestMortgageLoanAccountId ? "mortgaged" : "active",
        mortgageLoanAccountId: latestTerminal ? null : latestMortgageLoanAccountId,
        purchaseDate: firstPurchase?.tradeDate ?? rows[0]?.tradeDate ?? null,
        purchasePrice: decimalString(firstPurchase ? Math.abs(toNumber(firstPurchase.amount)) : null),
      },
    });
  }
}
