import { prisma } from "@/lib/db/prisma";

type MetalTypeRow = {
  id: string;
  code: string;
  name: string;
  shortName: string | null;
  sortOrder: number;
  isSystem: boolean;
  householdId: string | null;
};

type MetalUnitRow = {
  id: string;
  code: string;
  name: string;
  symbol: string | null;
  decimals: number;
  sortOrder: number;
  isSystem: boolean;
  householdId: string | null;
};

function dictionarySort<T extends { householdId: string | null; sortOrder: number; name: string; code: string }>(
  householdId: string,
) {
  return (a: T, b: T) => {
    const aScope = a.householdId === householdId ? 0 : 1;
    const bScope = b.householdId === householdId ? 0 : 1;
    if (aScope !== bScope) return aScope - bScope;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    const byName = a.name.localeCompare(b.name, "zh-Hans-CN");
    return byName || a.code.localeCompare(b.code);
  };
}

export async function listPreciousMetalDictionaries(householdId: string) {
  const [typeRows, unitRows] = await Promise.all([
    prisma.preciousMetalType.findMany({
      where: {
        isActive: true,
        OR: [{ householdId }, { householdId: null }],
      },
      select: {
        id: true,
        code: true,
        name: true,
        shortName: true,
        sortOrder: true,
        isSystem: true,
        householdId: true,
      },
    }),
    prisma.preciousMetalUnit.findMany({
      where: {
        isActive: true,
        OR: [{ householdId }, { householdId: null }],
      },
      select: {
        id: true,
        code: true,
        name: true,
        symbol: true,
        decimals: true,
        sortOrder: true,
        isSystem: true,
        householdId: true,
      },
    }),
  ]);

  const types = (typeRows as MetalTypeRow[]).sort(dictionarySort(householdId)).map((item) => ({
    id: item.id,
    code: item.code,
    name: item.name,
    shortName: item.shortName,
  }));
  const units = (unitRows as MetalUnitRow[]).sort(dictionarySort(householdId)).map((item) => ({
    id: item.id,
    code: item.code,
    name: item.name,
    symbol: item.symbol,
    decimals: item.decimals,
  }));

  return { types, units };
}
