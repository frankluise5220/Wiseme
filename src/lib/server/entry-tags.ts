import { prisma } from "@/lib/db/prisma";
import { readableTagWhere } from "@/lib/server/tag-scope";
import type { Prisma } from "@prisma/client";

type EntryTagTx = {
  tag: Pick<typeof prisma.tag, "findMany">;
  entryTag: Pick<typeof prisma.entryTag, "deleteMany" | "createMany">;
};

/**
 * Splits a user-entered tags cell (string or echoed array) into unique trimmed
 * tag names. Accepts the same separators as the statement import: ，,、；;
 */
export function parseTagNamesInput(value: unknown) {
  const parts = Array.isArray(value)
    ? value.map((item) => String(item))
    : String(value ?? "").split(/[，,、；;]+/);
  return Array.from(new Set(
    parts
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 20),
  ));
}

/**
 * Resolves tag names against the readable tag scope, creating missing tags in
 * the current household. Used by the fund/stock import flows where tags come
 * from an Excel column and may reference tags that do not exist yet.
 */
export async function resolveOrCreateTagIdsByNames(
  tx: Prisma.TransactionClient,
  householdId: string | null | undefined,
  names: readonly string[],
) {
  const ids: string[] = [];
  for (const name of names) {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) continue;
    const existing = await tx.tag.findFirst({
      where: { name: trimmed, ...readableTagWhere(householdId) },
      select: { id: true },
    });
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const created = await tx.tag.create({
      data: { name: trimmed, householdId: householdId ?? null },
    });
    ids.push(created.id);
  }
  return Array.from(new Set(ids));
}

export async function attachEntryTagsByNames(input: {
  tx: Prisma.TransactionClient;
  entryId: string;
  householdId?: string | null;
  names: readonly string[];
}) {
  if (!input.entryId) return;
  const tagIds = await resolveOrCreateTagIdsByNames(input.tx, input.householdId ?? null, input.names);
  if (tagIds.length === 0) return;
  // The SQLite Prisma client does not support createMany skipDuplicates, so
  // filter existing entry-tag links manually. Semantics match skipDuplicates.
  const existing = await input.tx.entryTag.findMany({
    where: { entryId: input.entryId, tagId: { in: tagIds } },
    select: { tagId: true },
  });
  const existingTagIds = new Set(existing.map((row) => row.tagId));
  const freshTagIds = tagIds.filter((tagId) => !existingTagIds.has(tagId));
  if (freshTagIds.length === 0) return;
  await input.tx.entryTag.createMany({
    data: freshTagIds.map((tagId) => ({ entryId: input.entryId, tagId })),
  });
}

export function normalizeTagIds(tagIds: readonly string[]) {
  return Array.from(new Set(
    tagIds
      .map((id) => String(id ?? "").trim())
      .filter(Boolean),
  ));
}

export async function resolveWritableTagIds(
  tx: Pick<EntryTagTx, "tag">,
  householdId: string | null | undefined,
  tagIds: readonly string[],
) {
  const ids = normalizeTagIds(tagIds);
  if (ids.length === 0) return [];
  const tags = await tx.tag.findMany({
    where: {
      id: { in: ids },
      ...readableTagWhere(householdId),
    },
    select: { id: true },
  });
  const validIds = new Set(tags.map((tag) => tag.id));
  return ids.filter((id) => validIds.has(id));
}

export async function attachEntryTags(input: {
  tx: EntryTagTx;
  entryId: string;
  householdId?: string | null;
  tagIds: readonly string[];
}) {
  const tagIds = await resolveWritableTagIds(input.tx, input.householdId, input.tagIds);
  if (tagIds.length === 0) return;
  await input.tx.entryTag.createMany({
    data: tagIds.map((tagId) => ({ entryId: input.entryId, tagId })),
  });
}

export async function replaceEntryTags(input: {
  tx: EntryTagTx;
  entryId: string;
  householdId?: string | null;
  tagIds: readonly string[];
}) {
  await input.tx.entryTag.deleteMany({ where: { entryId: input.entryId } });
  await attachEntryTags(input);
}
