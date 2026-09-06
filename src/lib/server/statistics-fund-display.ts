import { getFundProfileNameMap, normalizeFundDisplayName } from "@/lib/fund/fundProfile";
import { getLatestFundNavMap } from "@/lib/fund/navCache";
import { prisma } from "@/lib/db/prisma";
import { chunk, IN_CHUNK_SIZE } from "@/lib/server/prisma-in-chunks";

type StatisticsFundNameSource = {
  id?: string | null;
  entryId?: string | null;
  fundCode?: string | null;
  fundName?: string | null;
};

type LinkedFundDisplaySource = {
  fundCode: string;
  fundName: string | null;
};

function normalizeStatisticFundCode(value: string | null | undefined) {
  const code = String(value ?? "").trim();
  return /^\d{6}$/.test(code) ? code : "";
}

export async function buildStatisticsFundDisplayResolver(
  entries: Iterable<StatisticsFundNameSource>,
  householdId?: string | null,
) {
  const rows = Array.from(entries);
  const entryIds = Array.from(new Set(rows.flatMap((row) => [
    String(row.id ?? "").trim(),
    String(row.entryId ?? "").trim(),
  ]).filter(Boolean)));
  const linkedFundByEntryId = new Map<string, LinkedFundDisplaySource>();

  if (entryIds.length > 0) {
    // 跨年区间可能让 entryIds 远超 999（SQLITE_MAX_VARIABLE_NUMBER），
    // OR 里有 3 个 in 子句更是放大风险。按 IN_CHUNK_SIZE 分批查然后去重合并。
    // 注意：单次 findMany 返回的 fundTransaction 可能在多个 chunk 中同时被命中
    // （如 cashEntryId 在 chunkA、cashFlows.txRecordId 在 chunkB），用 fundTransaction.id 去重。
    const select = {
      id: true,
      cashEntryId: true,
      fundCode: true,
      fundName: true,
      cashFlows: { select: { txRecordId: true } },
      EntryBusinessLink: {
        where: { deletedAt: null },
        select: { cashEntryId: true },
      },
    } as const;
    type LinkedFundRow = {
      id: string;
      cashEntryId: string | null;
      fundCode: string;
      fundName: string | null;
      cashFlows: Array<{ txRecordId: string | null }>;
      EntryBusinessLink: Array<{ cashEntryId: string | null }>;
    };
    const linkedFundRows: LinkedFundRow[] = [];
    const seenRowIds = new Set<string>();
    for (const part of chunk(entryIds, IN_CHUNK_SIZE)) {
      const rows = await prisma.fundTransaction.findMany({
        where: {
          ...(householdId ? { householdId } : {}),
          deletedAt: null,
          OR: [
            { cashEntryId: { in: part } },
            { cashFlows: { some: { txRecordId: { in: part } } } },
            { EntryBusinessLink: { some: { deletedAt: null, cashEntryId: { in: part } } } },
          ],
        },
        select,
      });
      for (const row of rows) {
        if (seenRowIds.has(row.id)) continue;
        seenRowIds.add(row.id);
        linkedFundRows.push(row);
      }
    }

    const rememberLinkedFund = (entryId: string | null | undefined, row: LinkedFundDisplaySource) => {
      const id = String(entryId ?? "").trim();
      if (id && !linkedFundByEntryId.has(id)) linkedFundByEntryId.set(id, row);
    };

    for (const row of linkedFundRows) {
      rememberLinkedFund(row.cashEntryId, row);
    }
    for (const row of linkedFundRows) {
      for (const flow of row.cashFlows) rememberLinkedFund(flow.txRecordId, row);
    }
    for (const row of linkedFundRows) {
      for (const link of row.EntryBusinessLink) rememberLinkedFund(link.cashEntryId, row);
    }
  }

  const fundCodes = Array.from(new Set([
    ...rows.map((row) => normalizeStatisticFundCode(row.fundCode)),
    ...Array.from(linkedFundByEntryId.values()).map((row) => normalizeStatisticFundCode(row.fundCode)),
  ].filter(Boolean)));
  const [profileNameByCode, latestNavByCode] = await Promise.all([
    getFundProfileNameMap(fundCodes),
    getLatestFundNavMap(fundCodes),
  ]);

  return function resolveStatisticsFundDisplay(entry: StatisticsFundNameSource) {
    const rawFundCode = String(entry.fundCode ?? "").trim();
    const storedName = String(entry.fundName ?? "").trim();
    const linkedFund =
      linkedFundByEntryId.get(String(entry.id ?? "").trim()) ??
      linkedFundByEntryId.get(String(entry.entryId ?? "").trim());
    const linkedCode = normalizeStatisticFundCode(linkedFund?.fundCode);
    const normalizedCode = normalizeStatisticFundCode(rawFundCode) || linkedCode;
    const fundCode = normalizedCode || rawFundCode;
    if (!normalizedCode) return { fundCode, fundName: storedName || fundCode };

    const fundName = (
      profileNameByCode.get(normalizedCode) ??
      normalizeFundDisplayName(normalizedCode, latestNavByCode.get(normalizedCode)?.name) ??
      normalizeFundDisplayName(normalizedCode, storedName) ??
      normalizeFundDisplayName(normalizedCode, linkedFund?.fundName) ??
      normalizedCode
    );
    return { fundCode: normalizedCode, fundName };
  };
}
