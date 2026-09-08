import type { Prisma } from "@prisma/client";

type CounterpartyNameStore = {
  counterparty: {
    findMany(args: {
      where: Prisma.CounterpartyWhereInput;
      select: { id: true; name: true; shortName: true };
    }): Promise<Array<{ id: string; name: string; shortName: string | null }>>;
  };
};

export class CounterpartyNameUniqueError extends Error {
  status = 409;

  constructor(message: string) {
    super(message);
    this.name = "CounterpartyNameUniqueError";
  }
}

export function isCounterpartyNameUniqueError(error: unknown): error is CounterpartyNameUniqueError {
  return error instanceof CounterpartyNameUniqueError;
}

export function normalizeCounterpartyDisplayName(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function counterpartyNameCandidates(name: unknown, shortName?: unknown) {
  const fullName = normalizeCounterpartyDisplayName(name);
  const short = normalizeCounterpartyDisplayName(shortName);
  return Array.from(new Set([fullName, short].filter(Boolean)));
}

export async function findCounterpartyDisplayNameConflict(
  store: CounterpartyNameStore,
  input: {
    householdId: string;
    name: unknown;
    shortName?: unknown;
    excludeId?: string | null;
  },
) {
  const candidates = counterpartyNameCandidates(input.name, input.shortName);
  if (candidates.length === 0) return null;

  const rows = await store.counterparty.findMany({
    where: {
      householdId: input.householdId,
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
      OR: [
        { name: { in: candidates } },
        { shortName: { in: candidates } },
      ],
    },
    select: { id: true, name: true, shortName: true },
  });

  return candidates
    .map((candidate) => {
      const row = rows.find((item) =>
        normalizeCounterpartyDisplayName(item.name) === candidate ||
        normalizeCounterpartyDisplayName(item.shortName) === candidate,
      );
      return row ? { value: candidate, counterparty: row } : null;
    })
    .find(Boolean) ?? null;
}

export async function assertCounterpartyDisplayNamesUnique(
  store: CounterpartyNameStore,
  input: {
    householdId: string;
    name: unknown;
    shortName?: unknown;
    excludeId?: string | null;
  },
) {
  const fullName = normalizeCounterpartyDisplayName(input.name);
  const shortName = normalizeCounterpartyDisplayName(input.shortName);
  if (!fullName) {
    throw new CounterpartyNameUniqueError("往来对象名称不能为空");
  }
  if (shortName && fullName === shortName) {
    throw new CounterpartyNameUniqueError(`往来对象名称和简称不能相同：“${fullName}”`);
  }

  const conflict = await findCounterpartyDisplayNameConflict(store, input);
  if (conflict) {
    const owner = conflict.counterparty.shortName
      ? `${conflict.counterparty.name}（${conflict.counterparty.shortName}）`
      : conflict.counterparty.name;
    throw new CounterpartyNameUniqueError(`往来对象名称/简称“${conflict.value}”已被“${owner}”使用`);
  }
}
