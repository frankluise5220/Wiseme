import { AccountKind, type Prisma } from "@prisma/client";
import { parseDebtAccountName } from "@/lib/account-import-match";
import { assertCounterpartyDisplayNamesUnique } from "@/lib/server/counterparty-name-unique";
import { ensureInstitutionForCounterparty } from "@/lib/server/counterparty-sync";

type Db = Prisma.TransactionClient;
type CreatedImportAccount = { id: string; name: string; kind: string; institutionName?: string | null };

const resolutionCache = new Map<string, Map<string, { accountId: string | null; created: boolean }>>();

function debtResolveCacheGet(householdId: string, key: string): { accountId: string | null; created: boolean } | undefined {
  return resolutionCache.get(householdId)?.get(key);
}
function debtResolveCacheSet(householdId: string, key: string, val: { accountId: string | null; created: boolean }) {
  let m = resolutionCache.get(householdId);
  if (!m) { m = new Map(); resolutionCache.set(householdId, m); }
  m.set(key, val);
}

/**
 * Resolves or creates a settlement Account for a counterparty whose name
 * appears in a "XX的往来款" style account name during import.
 *
 * 1. Extract the counterparty name from the "XX的往来款" style account name.
 * 2. Look up a Counterparty by name or shortName within the household.
 * 3. If found, look for an existing settlement Account linked to that Counterparty.
 * 4. If no account exists, create one (kind=settlement, counterpartyId set).
 *
 * Ordinary counterparty settlement accounts are object-owned. Do not split or
 * rewrite them by payable/receivable direction during import.
 *
 * Returns the account ID, or null if the name doesn't match the pattern
 * or no matching Counterparty was found.
 */
export async function resolveDebtAccountByCounterpartyName(
  tx: Db,
  householdId: string,
  accountName: string,
  options: {
    createCounterparty?: boolean;
    createAccount?: boolean;
    createdAccounts?: CreatedImportAccount[];
  } = {},
): Promise<string | null> {
  const cacheKey = accountName;
  const cached = options.createCounterparty || options.createAccount
    ? undefined
    : debtResolveCacheGet(householdId, cacheKey);
  if (cached !== undefined) return cached.accountId;
  // Try "XX的往来款" pattern first, then fall back to the raw name.
  const parsedCounterpartyName = parseDebtAccountName(accountName);
  if (!parsedCounterpartyName && (options.createCounterparty || options.createAccount)) return null;
  const counterpartyName = parsedCounterpartyName ?? accountName.trim();
  if (!counterpartyName) { debtResolveCacheSet(householdId, cacheKey, { accountId: null, created: false }); return null; }

  let counterparty = await tx.counterparty.findFirst({
    where: {
      householdId,
      OR: [
        { name: counterpartyName },
        { shortName: counterpartyName },
      ],
    },
    select: { id: true, name: true, shortName: true },
  });
  if (!counterparty && options.createCounterparty) {
    await assertCounterpartyDisplayNamesUnique(tx, { householdId, name: counterpartyName });
    const createdCounterparty = await tx.counterparty.create({
      data: { householdId, name: counterpartyName, shortName: null, type: "person" },
      select: { id: true, name: true, shortName: true, type: true, householdId: true, sourceInstitutionId: true },
    });
    await ensureInstitutionForCounterparty(tx, createdCounterparty);
    counterparty = createdCounterparty;
  }
  if (!counterparty) return null;

  // Accept legacy loan rows until the idempotent account-kind backfill has run.
  const existing = await tx.account.findFirst({
    where: {
      householdId,
      counterpartyId: counterparty.id,
      kind: { in: [AccountKind.settlement, AccountKind.loan] },
      isPlaceholder: { not: true },
    },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
  });
  if (existing) { debtResolveCacheSet(householdId, cacheKey, { accountId: existing.id, created: false });
    if (!existing.isActive || existing.kind !== AccountKind.settlement) {
      await tx.account.update({
        where: { id: existing.id },
        data: { isActive: true, kind: AccountKind.settlement },
      });
    }
    return existing.id;
  }

  if (!options.createAccount) return null;

  // Create a new settlement account for this counterparty.
  const group =
    (await tx.accountGroup.findFirst({
      where: { householdId, name: { in: ["往来款", "借入/借出", "负债"] } },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    })) ??
    (await tx.accountGroup.findFirst({
      where: { householdId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }));
  if (!group) { debtResolveCacheSet(householdId, cacheKey, { accountId: null, created: false }); return null; }
  const created = await tx.account.create({
    data: {
      name: accountName,
      kind: AccountKind.settlement,
      debtDirection: "receivable",
      currency: "CNY",
      groupId: group.id,
      counterpartyId: counterparty.id,
      householdId,
      isActive: true,
    },
  });
  debtResolveCacheSet(householdId, cacheKey, { accountId: created.id, created: true });
  options.createdAccounts?.push({ id: created.id, name: created.name, kind: created.kind });
  return created.id;
}
