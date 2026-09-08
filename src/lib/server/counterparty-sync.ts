import type { Prisma } from "@prisma/client";
import { assertInstitutionDisplayNamesUnique } from "@/lib/server/institution-name-unique";

type CounterpartyStore = Pick<
  Prisma.TransactionClient,
  | "account"
  | "counterparty"
  | "institution"
  | "insuranceProduct"
  | "insuranceProductMaster"
  | "txRecord"
  | "wealthProduct"
>;

type InstitutionLike = {
  id: string;
  name: string;
  shortName?: string | null;
  type?: string | null;
  householdId?: string | null;
};

type CounterpartyLike = {
  id: string;
  name: string;
  shortName?: string | null;
  type?: string | null;
  householdId: string;
  sourceInstitutionId?: string | null;
};

const COUNTERPARTY_TYPES = new Set(["person", "organization"]);

function normalizeCounterpartyType(type?: string | null) {
  return type === "organization" ? "organization" : "person";
}

function isCounterpartyType(type?: string | null) {
  return COUNTERPARTY_TYPES.has(type ?? "");
}

function normalizeCounterpartySyncText(value?: string | null) {
  return String(value ?? "").trim();
}

function hasSameCounterpartySyncName(left: InstitutionLike, right: CounterpartyLike) {
  return (
    normalizeCounterpartySyncText(left.name) === normalizeCounterpartySyncText(right.name) &&
    normalizeCounterpartySyncText(left.shortName) === normalizeCounterpartySyncText(right.shortName)
  );
}

async function institutionHasBusinessUse(
  store: CounterpartyStore,
  institutionId: string,
  options?: { excludingCounterpartyId?: string },
) {
  const [
    accountCount,
    linkedCounterpartyCount,
    insuranceProductMasterCount,
    insuranceProductCount,
    activeTxRecordCount,
    wealthProductCount,
  ] = await Promise.all([
    store.account.count({ where: { institutionId } }),
    store.counterparty.count({
      where: {
        sourceInstitutionId: institutionId,
        ...(options?.excludingCounterpartyId ? { id: { not: options.excludingCounterpartyId } } : {}),
      },
    }),
    store.insuranceProductMaster.count({ where: { institutionId } }),
    store.insuranceProduct.count({
      where: {
        OR: [
          { institutionId },
          { policyholderPersonId: institutionId },
          { insuredPersonId: institutionId },
        ],
      },
    }),
    store.txRecord.count({ where: { counterpartyInstitutionId: institutionId, deletedAt: null } }),
    store.wealthProduct.count({ where: { institutionId } }),
  ]);

  return (
    accountCount > 0 ||
    linkedCounterpartyCount > 0 ||
    insuranceProductMasterCount > 0 ||
    insuranceProductCount > 0 ||
    activeTxRecordCount > 0 ||
    wealthProductCount > 0
  );
}

function counterpartyNameWhere(name: string, shortName?: string | null) {
  const short = shortName?.trim();
  return [
    { name },
    { shortName: name },
    ...(short ? [{ name: short }, { shortName: short }] : []),
  ];
}

export async function ensureCounterpartyForInstitution(
  store: CounterpartyStore,
  institution: InstitutionLike,
) {
  const householdId = institution.householdId;
  const name = institution.name.trim();
  if (!householdId || !name || !isCounterpartyType(institution.type)) return null;

  const type = normalizeCounterpartyType(institution.type);
  const shortName = institution.shortName?.trim() || null;
  const existing = await store.counterparty.findFirst({
    where: {
      householdId,
      OR: [
        { sourceInstitutionId: institution.id },
        ...counterpartyNameWhere(name, shortName),
      ],
    },
  });

  if (existing) {
    const data: Prisma.CounterpartyUpdateInput = {};
    if (!existing.sourceInstitutionId) data.SourceInstitution = { connect: { id: institution.id } };
    if (existing.sourceInstitutionId === institution.id || !existing.sourceInstitutionId) {
      data.name = name;
      data.shortName = shortName;
      data.type = type;
    }
    return Object.keys(data).length > 0
      ? store.counterparty.update({ where: { id: existing.id }, data })
      : existing;
  }

  return store.counterparty.create({
    data: {
      name,
      shortName,
      type,
      householdId,
      sourceInstitutionId: institution.id,
    },
  });
}

export async function ensureInstitutionForCounterparty(
  store: CounterpartyStore,
  counterparty: CounterpartyLike,
) {
  const householdId = counterparty.householdId;
  const name = counterparty.name.trim();
  if (!householdId || !name || !isCounterpartyType(counterparty.type)) return null;

  const type = normalizeCounterpartyType(counterparty.type);
  const shortName = counterparty.shortName?.trim() || null;
  if (counterparty.sourceInstitutionId) {
    const source = await store.institution.findFirst({
      where: { id: counterparty.sourceInstitutionId, householdId },
    });
    if (source) {
      await assertInstitutionDisplayNamesUnique(store, {
        householdId,
        name,
        shortName,
        excludeId: source.id,
      });
      return store.institution.update({
        where: { id: source.id },
        data: { name, shortName, type },
      });
    }
  }

  const existing = await store.institution.findFirst({
    where: {
      householdId,
      type: { in: ["person", "organization"] },
      OR: counterpartyNameWhere(name, shortName),
    },
  });

  await assertInstitutionDisplayNamesUnique(store, {
    householdId,
    name,
    shortName,
    excludeId: existing?.id ?? null,
  });

  const institution = existing
    ? await store.institution.update({
        where: { id: existing.id },
        data: { name, shortName, type },
      })
    : await store.institution.create({
        data: { householdId, name, shortName, type },
      });

  if (counterparty.sourceInstitutionId !== institution.id) {
    await store.counterparty.update({
      where: { id: counterparty.id },
      data: { sourceInstitutionId: institution.id },
    });
  }

  return institution;
}

export async function deleteUnusedSyncedInstitutionForCounterparty(
  store: CounterpartyStore,
  counterparty: CounterpartyLike,
) {
  if (!counterparty.sourceInstitutionId) return false;

  const institution = await store.institution.findFirst({
    where: { id: counterparty.sourceInstitutionId, householdId: counterparty.householdId },
  });
  if (!institution || !isCounterpartyType(institution.type)) return false;
  if (!hasSameCounterpartySyncName(institution, counterparty)) return false;
  if (await institutionHasBusinessUse(store, institution.id, { excludingCounterpartyId: counterparty.id })) return false;

  await store.institution.delete({ where: { id: institution.id } });
  return true;
}

export async function deleteUnusedSyncedCounterpartiesForInstitution(
  store: CounterpartyStore,
  institution: InstitutionLike,
) {
  const householdId = institution.householdId;
  if (!householdId || !isCounterpartyType(institution.type)) return 0;

  const counterparties = await store.counterparty.findMany({
    where: { sourceInstitutionId: institution.id, householdId },
  });
  let deleted = 0;
  for (const counterparty of counterparties) {
    if (!hasSameCounterpartySyncName(institution, counterparty)) continue;
    const accountCount = await store.account.count({ where: { counterpartyId: counterparty.id } });
    if (accountCount > 0) continue;
    await store.counterparty.delete({ where: { id: counterparty.id } });
    deleted += 1;
  }
  return deleted;
}
