import { prisma } from "@/lib/db/prisma";

/**
 * Per-account transaction record counts for the settings account list.
 *
 * Counting rule mirrors the permanent-delete impact in
 * `/api/v1/accounts` DELETE (`accountId = X OR toAccountId = X`):
 * - recordCount: non-deleted (deletedAt = null) rows referencing the account
 *   as source or transfer target.
 * - deletedRecordCount: soft-deleted rows under the same rule.
 *
 * A transfer between two in-house accounts is counted once per account side,
 * which matches what the delete-confirm dialog reports.
 */
export type AccountRecordCount = {
  recordCount: number;
  deletedRecordCount: number;
};

export async function loadAccountRecordCounts(
  accountIds: readonly string[],
): Promise<Map<string, AccountRecordCount>> {
  const counts = new Map<string, AccountRecordCount>();
  const ids = Array.from(new Set(accountIds.filter(Boolean)));
  if (ids.length === 0) return counts;

  const [fromActive, toActive, fromDeleted, toDeleted] = await Promise.all([
    prisma.txRecord.groupBy({
      by: ["accountId"],
      where: { accountId: { in: ids }, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.txRecord.groupBy({
      by: ["toAccountId"],
      where: { toAccountId: { in: ids }, deletedAt: null },
      _count: { _all: true },
    }),
    prisma.txRecord.groupBy({
      by: ["accountId"],
      where: { accountId: { in: ids }, deletedAt: { not: null } },
      _count: { _all: true },
    }),
    prisma.txRecord.groupBy({
      by: ["toAccountId"],
      where: { toAccountId: { in: ids }, deletedAt: { not: null } },
      _count: { _all: true },
    }),
  ]);

  for (const row of fromActive) {
    const entry = counts.get(row.accountId) ?? { recordCount: 0, deletedRecordCount: 0 };
    entry.recordCount += row._count._all;
    counts.set(row.accountId, entry);
  }
  for (const row of toActive) {
    if (!row.toAccountId) continue;
    const entry = counts.get(row.toAccountId) ?? { recordCount: 0, deletedRecordCount: 0 };
    entry.recordCount += row._count._all;
    counts.set(row.toAccountId, entry);
  }
  for (const row of fromDeleted) {
    const entry = counts.get(row.accountId) ?? { recordCount: 0, deletedRecordCount: 0 };
    entry.deletedRecordCount += row._count._all;
    counts.set(row.accountId, entry);
  }
  for (const row of toDeleted) {
    if (!row.toAccountId) continue;
    const entry = counts.get(row.toAccountId) ?? { recordCount: 0, deletedRecordCount: 0 };
    entry.deletedRecordCount += row._count._all;
    counts.set(row.toAccountId, entry);
  }

  return counts;
}
