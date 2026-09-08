import type { Prisma } from "@prisma/client";

type InstitutionNameStore = {
  institution: {
    findMany(args: {
      where: Prisma.InstitutionWhereInput;
      select: { id: true; householdId: true; name: true; shortName: true; type: true };
    }): Promise<InstitutionNameRow[]>;
  };
  account: { count(args: { where: Prisma.AccountWhereInput }): Promise<number> };
  counterparty: { count(args: { where: Prisma.CounterpartyWhereInput }): Promise<number> };
  insuranceProduct: { count(args: { where: Prisma.InsuranceProductWhereInput }): Promise<number> };
  insuranceProductMaster: { count(args: { where: Prisma.InsuranceProductMasterWhereInput }): Promise<number> };
  txRecord: { count(args: { where: Prisma.TxRecordWhereInput }): Promise<number> };
  wealthProduct: { count(args: { where: Prisma.WealthProductWhereInput }): Promise<number> };
};

type InstitutionNameRow = {
  id: string;
  householdId: string | null;
  name: string;
  shortName: string | null;
  type: string | null;
};

export class InstitutionNameUniqueError extends Error {
  status = 409;

  constructor(message: string) {
    super(message);
    this.name = "InstitutionNameUniqueError";
  }
}

export function isInstitutionNameUniqueError(error: unknown): error is InstitutionNameUniqueError {
  return error instanceof InstitutionNameUniqueError;
}

export function normalizeInstitutionDisplayName(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function institutionNameCandidates(name: unknown, shortName?: unknown) {
  const fullName = normalizeInstitutionDisplayName(name);
  const short = normalizeInstitutionDisplayName(shortName);
  return Array.from(new Set([fullName, short].filter(Boolean)));
}

function isCounterpartyMirrorInstitutionType(type: string | null | undefined) {
  return type === "person" || type === "organization";
}

async function isUnusedCounterpartyMirrorInstitution(store: InstitutionNameStore, row: InstitutionNameRow) {
  if (!isCounterpartyMirrorInstitutionType(row.type)) return false;

  const [
    accountCount,
    linkedCounterpartyCount,
    insuranceProductMasterCount,
    insuranceProductCount,
    activeTxRecordCount,
    wealthProductCount,
  ] = await Promise.all([
    store.account.count({ where: { institutionId: row.id } }),
    store.counterparty.count({ where: { sourceInstitutionId: row.id } }),
    store.insuranceProductMaster.count({ where: { institutionId: row.id } }),
    store.insuranceProduct.count({
      where: {
        OR: [
          { institutionId: row.id },
          { policyholderPersonId: row.id },
          { insuredPersonId: row.id },
        ],
      },
    }),
    store.txRecord.count({ where: { counterpartyInstitutionId: row.id, deletedAt: null } }),
    store.wealthProduct.count({ where: { institutionId: row.id } }),
  ]);

  return (
    accountCount === 0 &&
    linkedCounterpartyCount === 0 &&
    insuranceProductMasterCount === 0 &&
    insuranceProductCount === 0 &&
    activeTxRecordCount === 0 &&
    wealthProductCount === 0
  );
}

async function partitionInstitutionNameRows(store: InstitutionNameStore, rows: InstitutionNameRow[]) {
  const active: InstitutionNameRow[] = [];
  const reusableOrphans: InstitutionNameRow[] = [];

  for (const row of rows) {
    if (await isUnusedCounterpartyMirrorInstitution(store, row)) {
      reusableOrphans.push(row);
    } else {
      active.push(row);
    }
  }

  return { active, reusableOrphans };
}

export async function findInstitutionDisplayNameConflict(
  store: InstitutionNameStore,
  input: {
    householdId: string;
    name: unknown;
    shortName?: unknown;
    excludeId?: string | null;
  },
) {
  const candidates = institutionNameCandidates(input.name, input.shortName);
  if (candidates.length === 0) return null;

  const rows = await store.institution.findMany({
    where: {
      householdId: input.householdId,
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      OR: [
        { name: { in: candidates } },
        { shortName: { in: candidates } },
      ],
    },
    select: { id: true, householdId: true, name: true, shortName: true, type: true },
  });
  const { active } = await partitionInstitutionNameRows(store, rows);

  return candidates
    .map((candidate) => {
      const row = active.find((item) =>
        normalizeInstitutionDisplayName(item.name) === candidate ||
        normalizeInstitutionDisplayName(item.shortName) === candidate,
      );
      return row ? { value: candidate, institution: row } : null;
    })
    .find(Boolean) ?? null;
}

export async function findReusableInstitutionDisplayNameOrphan(
  store: InstitutionNameStore,
  input: {
    householdId: string;
    name: unknown;
    shortName?: unknown;
    excludeId?: string | null;
  },
) {
  const candidates = institutionNameCandidates(input.name, input.shortName);
  if (candidates.length === 0) return null;

  const rows = await store.institution.findMany({
    where: {
      householdId: input.householdId,
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      OR: [
        { name: { in: candidates } },
        { shortName: { in: candidates } },
      ],
    },
    select: { id: true, householdId: true, name: true, shortName: true, type: true },
  });
  const { reusableOrphans } = await partitionInstitutionNameRows(store, rows);

  return candidates
    .map((candidate) => {
      const row = reusableOrphans.find((item) =>
        normalizeInstitutionDisplayName(item.name) === candidate ||
        normalizeInstitutionDisplayName(item.shortName) === candidate,
      );
      return row ? { value: candidate, institution: row } : null;
    })
    .find(Boolean) ?? null;
}

export async function assertInstitutionDisplayNamesUnique(
  store: InstitutionNameStore,
  input: {
    householdId: string;
    name: unknown;
    shortName?: unknown;
    excludeId?: string | null;
  },
) {
  const fullName = normalizeInstitutionDisplayName(input.name);
  const shortName = normalizeInstitutionDisplayName(input.shortName);
  if (!fullName) {
    throw new InstitutionNameUniqueError("机构名称不能为空");
  }
  if (shortName && fullName === shortName) {
    throw new InstitutionNameUniqueError(`机构全称和简称不能相同：“${fullName}”`);
  }

  const conflict = await findInstitutionDisplayNameConflict(store, input);
  if (conflict) {
    const owner = conflict.institution.shortName
      ? `${conflict.institution.name}（${conflict.institution.shortName}）`
      : conflict.institution.name;
    throw new InstitutionNameUniqueError(`机构名称/简称“${conflict.value}”已被“${owner}”使用`);
  }
}
