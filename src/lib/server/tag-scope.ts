import { prisma } from "@/lib/db/prisma";
import type { Prisma } from "@prisma/client";

export function readableTagWhere(householdId: string | null | undefined): Prisma.TagWhereInput {
  return householdId
    ? { OR: [{ householdId }, { householdId: null }] }
    : { householdId: null };
}

type TagUsage = {
  date: number;
  updatedAt: number;
};

/**
 * Returns readable tags with recently used tags first.
 * Usage is derived from active transaction dates because EntryTag has no own timestamp.
 */
export async function loadReadableTagsByRecentUse(householdId: string | null | undefined) {
  const [tags, usages] = await Promise.all([
    prisma.tag.findMany({
      where: readableTagWhere(householdId),
    }),
    householdId
      ? prisma.entryTag.findMany({
          where: {
            Tag: readableTagWhere(householdId),
            transactions: {
              householdId,
              deletedAt: null,
            },
          },
          select: {
            tagId: true,
            transactions: {
              select: {
                date: true,
                updatedAt: true,
              },
            },
          },
        })
      : Promise.resolve([]),
  ]);

  const latestUsageByTag = new Map<string, TagUsage>();
  for (const usage of usages) {
    const nextUsage = {
      date: usage.transactions.date.getTime(),
      updatedAt: usage.transactions.updatedAt.getTime(),
    };
    const previousUsage = latestUsageByTag.get(usage.tagId);
    if (
      !previousUsage ||
      nextUsage.date > previousUsage.date ||
      (nextUsage.date === previousUsage.date && nextUsage.updatedAt > previousUsage.updatedAt)
    ) {
      latestUsageByTag.set(usage.tagId, nextUsage);
    }
  }

  return tags.sort((a, b) => {
    const usageA = latestUsageByTag.get(a.id);
    const usageB = latestUsageByTag.get(b.id);
    if (usageA && !usageB) return -1;
    if (!usageA && usageB) return 1;
    if (usageA && usageB) {
      if (usageA.date !== usageB.date) return usageB.date - usageA.date;
      if (usageA.updatedAt !== usageB.updatedAt) return usageB.updatedAt - usageA.updatedAt;
    }
    return a.name.localeCompare(b.name, "zh-CN", { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id);
  });
}
