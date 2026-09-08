import { AccountKind, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

type TxClient = Prisma.TransactionClient | typeof prisma;

type StockAccountLike = {
  id: string;
  householdId: string;
  groupId: string;
  institutionId?: string | null;
  currency?: string | null;
};

export const BROKERAGE_CASH_ACCOUNT_NAME = "证券资金账户";

function buildBrokerageCashAccountName(institution?: { name?: string | null; shortName?: string | null } | null) {
  const institutionName = institution?.shortName?.trim() || institution?.name?.trim() || "";
  return institutionName ? `${institutionName}的资金账户` : BROKERAGE_CASH_ACCOUNT_NAME;
}

export function isCashLikeBrokerageFundingKind(kind: string | null | undefined) {
  return kind === AccountKind.cash || kind === AccountKind.bank_debit || kind === AccountKind.ewallet;
}

/**
 * Ensure a stock account's brokerage has a visible funding account.
 *
 * Stock/fund holding accounts are business ledgers. Bank-securities transfers
 * land in the brokerage funding account, which can be shared by stock and fund
 * trades under the same brokerage institution.
 */
export async function ensureBrokerageCashAccountForStockAccount(
  client: TxClient,
  stockAccount: StockAccountLike,
) {
  if (!stockAccount.institutionId) return null;

  const currency = stockAccount.currency?.trim() || "CNY";
  const institution = await client.institution.findUnique({
    where: { id: stockAccount.institutionId },
    select: { name: true, shortName: true },
  });
  const existing = await client.account.findFirst({
    where: {
      householdId: stockAccount.householdId,
      groupId: stockAccount.groupId,
      institutionId: stockAccount.institutionId,
      currency,
      isPlaceholder: { not: true },
      OR: [
        { kind: AccountKind.ewallet },
        { kind: AccountKind.cash },
        { kind: AccountKind.bank_debit },
      ],
    },
    include: {
      AccountGroup: { select: { id: true, name: true } },
      Institution: { select: { id: true, name: true, shortName: true, type: true } },
      Counterparty: { select: { id: true, name: true, shortName: true, type: true } },
    },
    orderBy: [
      { isActive: "desc" },
      { createdAt: "asc" },
      { id: "asc" },
    ],
  });
  if (existing) return existing;

  return client.account.create({
    data: {
      name: buildBrokerageCashAccountName(institution),
      kind: AccountKind.ewallet,
      currency,
      groupId: stockAccount.groupId,
      institutionId: stockAccount.institutionId,
      householdId: stockAccount.householdId,
      isActive: true,
      investProductType: null,
      costBasisMethod: null,
      tradingCalendar: null,
      fundUnitsDecimals: 2,
    },
    include: {
      AccountGroup: { select: { id: true, name: true } },
      Institution: { select: { id: true, name: true, shortName: true, type: true } },
      Counterparty: { select: { id: true, name: true, shortName: true, type: true } },
    },
  });
}
