import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

/**
 * Related-account counts shown next to institution / family member / counterparty names.
 *
 * The rules live in one place so the three settings pages and the settings cache
 * APIs (`/api/v1/accounts/internal`, `/api/v1/settings/bootstrap`) cannot drift apart:
 * - Institution (family members are `Institution` rows with type `family_member`):
 *   accounts whose `institutionId` points at it, PLUS insurance accounts whose
 *   product references it (`InsuranceProduct.institutionId` for the insurer,
 *   `InsurancePolicy` isn't a thing here — the actual pass uses
 *   `InsuranceProduct.institutionId` / `policyholderPersonId` / `insuredPersonId`).
 *   Family members own their account links through the owner group
 *   (`AccountGroup.name` matched by name), not through `institutionId` — so their
 *   count is the number of accounts they own (a single account has exactly one owner).
 * - Counterparty: accounts whose `counterpartyId` points at it, PLUS accounts linked
 *   through the mirrored institution (`Counterparty.sourceInstitutionId`). Historical
 *   往来款 accounts were created before `Counterparty` existed and only carry
 *   `institutionId`, so both links must be counted — same rule as
 *   `src/lib/server/advance-account.ts` (`relationWhere`).
 * - Placeholder accounts are internal artifacts and are never counted.
 *
 * This is the single source of truth for the *display* count. The delete guard in
 * `/delete` routes uses `counterpartyLinkedAccountsWhere()` for counterparties; the
 * family-member / institution delete guard mirrors the ownership rule.
 */

export type AccountLinkRow = {
  id: string;
  institutionId: string | null;
  counterpartyId?: string | null;
  isPlaceholder?: boolean;
  groupId?: string | null;
  AccountGroup?: { name?: string | null } | null;
};

export type InstitutionLinkRow = {
  id: string;
  name: string;
  type?: string | null;
};

export type CounterpartyLinkRow = { id: string; sourceInstitutionId?: string | null };

export type InsuranceProductLinkRow = {
  accountId: string;
  institutionId?: string | null;
  policyholderPersonId?: string | null;
  insuredPersonId?: string | null;
};

export const INSURANCE_PRODUCT_LINK_SELECT = {
  accountId: true,
  institutionId: true,
  policyholderPersonId: true,
  insuredPersonId: true,
} as const;

/**
 * Every account that belongs to a counterparty, whether linked directly or through
 * the mirrored institution. Used by the delete guard so it cannot reject/allow
 * differently from the count shown in the settings list.
 */
export function counterpartyLinkedAccountsWhere(counterparty: CounterpartyLinkRow) {
  const or = [{ counterpartyId: counterparty.id }] as NonNullable<Prisma.AccountWhereInput["OR"]>;
  if (counterparty.sourceInstitutionId) {
    or.push({ institutionId: counterparty.sourceInstitutionId });
  }
  return { OR: or } satisfies Prisma.AccountWhereInput;
}

const ACCOUNT_LINK_SELECT = {
  id: true,
  institutionId: true,
  counterpartyId: true,
  isPlaceholder: true,
} as const;

const ACCOUNT_LINK_SELECT_WITH_OWNER = {
  id: true,
  institutionId: true,
  counterpartyId: true,
  isPlaceholder: true,
  AccountGroup: { select: { name: true } },
} as const;

function isCountableAccount(account: { isPlaceholder?: boolean }) {
  return account.isPlaceholder !== true;
}

function ensureSet(map: Map<string, Set<string>>, key: string) {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  return set;
}

function institutionTypeById(id: string, institutions: readonly InstitutionLinkRow[]): string | undefined {
  for (const inst of institutions) if (inst.id === id) return inst.type ?? undefined;
  return undefined;
}

/**
 * Related-account counts keyed by institution id.
 *
 * Non-family institutions (banks, insurers, …) are counted by `institutionId`,
 * plus insurance-product links (`institutionId` / policyholder / insured) when those
 * reference a non-family institution.
 *
 * Family members (`type === "family_member"`) are counted by ownership: the distinct
 * accounts whose `AccountGroup.name` (after trimming) equals the member's name.
 * Insurance policy membership does NOT add extra counts for a family member — an
 * account has exactly one owner, and the sums across all family members equal the
 * total owned (non-placeholder) accounts.
 */
export function countAccountsByInstitution(
  accounts: readonly AccountLinkRow[],
  insuranceProducts: readonly InsuranceProductLinkRow[] = [],
  institutions: readonly InstitutionLinkRow[] = [],
) {
  const accountIdsByInstitutionId = new Map<string, Set<string>>();

  // Family member institutions matched by owner-group name.
  const familyByName = new Map<string, string[]>();
  for (const inst of institutions) {
    if (inst.type === "family_member" && inst.name) {
      const arr = familyByName.get(inst.name.trim()) ?? [];
      arr.push(inst.id);
      familyByName.set(inst.name.trim(), arr);
    }
  }

  // Pass 1: direct institutionId links. Accounts pointing at a family-member
  // institution are skipped here — family members are attributed by ownership below.
  for (const account of accounts) {
    if (!isCountableAccount(account) || !account.institutionId) continue;
    if (institutionTypeById(account.institutionId, institutions) === "family_member") continue;
    ensureSet(accountIdsByInstitutionId, account.institutionId).add(account.id);
  }

  // Pass 2: family ownership. Count each owned account toward every family member
  // whose name matches the account's owner group name.
  for (const account of accounts) {
    if (!isCountableAccount(account)) continue;
    const ownerName = account.AccountGroup?.name?.trim();
    if (!ownerName) continue;
    const memberIds = familyByName.get(ownerName);
    if (memberIds) {
      for (const id of memberIds) ensureSet(accountIdsByInstitutionId, id).add(account.id);
    }
  }

  // Pass 3: insurance-product links for non-family institutions (insurers).
  const placeholderAccountIds = new Set(
    accounts.filter((a) => a.isPlaceholder === true).map((a) => a.id),
  );
  for (const product of insuranceProducts) {
    if (placeholderAccountIds.has(product.accountId)) continue;
    for (const institutionId of [product.institutionId, product.policyholderPersonId, product.insuredPersonId]) {
      if (!institutionId) continue;
      if (institutionTypeById(institutionId, institutions) === "family_member") continue;
      ensureSet(accountIdsByInstitutionId, institutionId).add(product.accountId);
    }
  }

  const counts = new Map<string, number>();
  for (const [institutionId, accountIds] of accountIdsByInstitutionId) {
    counts.set(institutionId, accountIds.size);
  }
  return counts;
}

export function countAccountsByCounterparty(
  accounts: readonly AccountLinkRow[],
  counterparties: readonly CounterpartyLinkRow[],
) {
  const accountIdsByCounterpartyId = new Map<string, Set<string>>();
  const counterpartyIdByInstitutionId = new Map<string, string>();
  for (const counterparty of counterparties) {
    ensureSet(accountIdsByCounterpartyId, counterparty.id);
    if (counterparty.sourceInstitutionId) {
      counterpartyIdByInstitutionId.set(counterparty.sourceInstitutionId, counterparty.id);
    }
  }

  for (const account of accounts) {
    if (!isCountableAccount(account)) continue;
    if (account.counterpartyId) ensureSet(accountIdsByCounterpartyId, account.counterpartyId).add(account.id);
    if (account.institutionId) {
      const viaInstitutionId = counterpartyIdByInstitutionId.get(account.institutionId);
      if (viaInstitutionId) ensureSet(accountIdsByCounterpartyId, viaInstitutionId).add(account.id);
    }
  }

  const counts = new Map<string, number>();
  for (const [counterpartyId, accountIds] of accountIdsByCounterpartyId) {
    counts.set(counterpartyId, accountIds.size);
  }
  return counts;
}

export async function loadInstitutionAccountCounts(hidFilter: { householdId: string }) {
  const [accounts, insuranceProducts, institutions] = await Promise.all([
    prisma.account.findMany({ where: hidFilter, select: ACCOUNT_LINK_SELECT_WITH_OWNER }),
    prisma.insuranceProduct.findMany({ where: hidFilter, select: INSURANCE_PRODUCT_LINK_SELECT }),
    prisma.institution.findMany({ where: hidFilter, select: { id: true, name: true, type: true } }),
  ]);
  return countAccountsByInstitution(accounts, insuranceProducts, institutions);
}

export async function loadCounterpartyAccountCounts(hidFilter: { householdId: string }) {
  const [accounts, counterparties] = await Promise.all([
    prisma.account.findMany({ where: hidFilter, select: ACCOUNT_LINK_SELECT }),
    prisma.counterparty.findMany({ where: hidFilter, select: { id: true, sourceInstitutionId: true } }),
  ]);
  return countAccountsByCounterparty(accounts, counterparties);
}

export function withAccountCounts<T extends { id: string }>(rows: readonly T[], counts: Map<string, number>) {
  return rows.map((row) => ({ ...row, accountCount: counts.get(row.id) ?? 0 }));
}
