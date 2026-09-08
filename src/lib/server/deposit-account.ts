import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getOrCreateDefaultAccountGroupId } from "@/lib/server/account-group-default";
import { isDepositAccount } from "@/lib/account-kind-utils";

type Db = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

type ResolveDepositAccountInput = {
  householdId: string;
  requestedAccountId?: string | null;
  cashAccountId?: string | null;
  fundName?: string | null;
  currency?: string | null;
};

const DEFAULT_DEPOSIT_ACCOUNT_NAME = "定期存款";

export async function resolveOrCreateDepositAccount(
  tx: Db,
  input: ResolveDepositAccountInput,
) {
  const requestedAccountId = input.requestedAccountId?.trim() || "";
  const cashAccountId = input.cashAccountId?.trim() || "";
  const depositName = DEFAULT_DEPOSIT_ACCOUNT_NAME;

  const requested =
    requestedAccountId
      ? await tx.account.findUnique({
          where: { id: requestedAccountId },
          select: {
            id: true,
            name: true,
            kind: true,
            groupId: true,
            householdId: true,
            institutionId: true,
            investProductType: true,
            currency: true,
          },
        })
      : null;

  if (requested && requested.householdId === input.householdId && isDepositAccount(requested)) {
    return requested;
  }

  const cashAccount =
    cashAccountId
      ? await tx.account.findUnique({
          where: { id: cashAccountId },
          select: {
            id: true,
            groupId: true,
            institutionId: true,
            householdId: true,
            currency: true,
          },
        })
      : null;

  const groupId =
    requested?.groupId ||
    (cashAccount?.householdId === input.householdId ? cashAccount.groupId : null) ||
    (await getOrCreateDefaultAccountGroupId(tx, input.householdId));
  const institutionId =
    requested?.institutionId ||
    (cashAccount?.householdId === input.householdId ? cashAccount.institutionId : null) ||
    null;
  const currency =
    input.currency?.trim().toUpperCase() ||
    requested?.currency ||
    (cashAccount?.householdId === input.householdId ? cashAccount.currency : null) ||
    "CNY";

  const exactScope: Prisma.AccountWhereInput = {
    householdId: input.householdId,
    name: depositName,
    groupId,
    institutionId: institutionId ?? null,
  };

  const candidates = await tx.account.findMany({
    where: exactScope,
    select: {
      id: true,
      name: true,
      kind: true,
      groupId: true,
      householdId: true,
      institutionId: true,
      investProductType: true,
      currency: true,
    },
  });

  const existing = candidates.find((account) => isDepositAccount(account)) ?? null;
  if (existing) return existing;

  return tx.account.create({
    data: {
      name: depositName,
      kind: "investment",
      investProductType: "deposit",
      currency,
      householdId: input.householdId,
      groupId,
      institutionId,
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      kind: true,
      groupId: true,
      householdId: true,
      institutionId: true,
      investProductType: true,
      currency: true,
    },
  });
}
