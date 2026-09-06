import { Prisma, type PrismaClient, type TxRecord } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { chunk, IN_CHUNK_SIZE } from "@/lib/server/prisma-in-chunks";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { syncFundTransactionsFromTxRecords } from "@/lib/fund/transactions";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { createManySkipDuplicatesCompat } from "@/lib/server/prisma-create-many";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";

type DbWriter = PrismaClient | Prisma.TransactionClient;
type UndoSnapshot = Record<string, unknown>;
export const ENTRY_UNDO_HISTORY_LIMIT = 5;
const ENTRY_UNDO_PREVIEW_LIMIT = 5;

export type EntryUndoPreviewItem = {
  id: string;
  date: string;
  type: string;
  amount: number | null;
  accountName: string;
  toAccountName: string;
  categoryName: string;
  counterpartyInstitutionName: string;
  fundCode: string;
  fundName: string;
  note: string;
};

export type EntryUndoPreview = {
  count: number;
  hiddenCount: number;
  items: EntryUndoPreviewItem[];
};

export type PreparedEntryUndo = {
  snapshots: UndoSnapshot[];
  entryIds: string[];
} | null;

function undoScope(ctx: HouseholdContext) {
  return { householdId: ctx.householdId, userId: ctx.user?.id ?? null };
}

function serializeRecords(records: TxRecord[], tagIdsByEntryId: Map<string, string[]>): UndoSnapshot[] {
  return JSON.parse(JSON.stringify(records.map((record) => ({
    ...record,
    _entryTagIds: tagIdsByEntryId.get(record.id) ?? [],
  })))) as UndoSnapshot[];
}

export async function prepareEntryUndo(
  db: DbWriter,
  householdId: string,
  requestedEntryIds: Iterable<string>,
): Promise<PreparedEntryUndo> {
  const ids = Array.from(new Set(Array.from(requestedEntryIds).filter(Boolean)));
  if (ids.length === 0) return null;

  const initial = await db.txRecord.findMany({
    where: { id: { in: ids }, OR: [{ householdId }, { householdId: null }] },
  });
  if (initial.length === 0) return null;

  const relatedIds = new Set(initial.map((record) => record.id));
  for (const record of initial) {
    if (record.fundSourceEntryId) relatedIds.add(record.fundSourceEntryId);
    if (record.depositSourceEntryId) relatedIds.add(record.depositSourceEntryId);
  }

  const sourceIds = Array.from(relatedIds);
  const planIds = Array.from(new Set(initial.map((record) => record.creditCardInstallmentPlanId).filter((id): id is string => !!id)));
  const sourcePlans = await db.creditCardInstallmentPlan.findMany({
    where: { householdId, sourceEntryId: { in: sourceIds } },
    select: { id: true },
  });
  for (const plan of sourcePlans) planIds.push(plan.id);
  const uniquePlanIds = Array.from(new Set(planIds));
  const installmentPlans = uniquePlanIds.length > 0
    ? await db.creditCardInstallmentPlan.findMany({
        where: { householdId, id: { in: uniquePlanIds } },
        select: { id: true, status: true },
      })
    : [];

  const related: TxRecord[] = [];
  const seenRelatedIds = new Set<string>();
  const relatedWhere = (part: string[]): Prisma.TxRecordWhereInput => ({
    OR: [
      { householdId, id: { in: part } },
      { householdId: null, id: { in: part } },
      { householdId, fundSourceEntryId: { in: part } },
      { householdId: null, fundSourceEntryId: { in: part } },
      { householdId, depositSourceEntryId: { in: part } },
      { householdId: null, depositSourceEntryId: { in: part } },
    ],
  });
  // The OR contains 6 `{ in: sourceIds }` clauses, so large batches exceed
  // SQLite's parameter limit. Query in sourceIds chunks and merge with dedupe.
  for (const part of chunk(sourceIds, IN_CHUNK_SIZE)) {
    const partRows = await db.txRecord.findMany({ where: relatedWhere(part) });
    for (const row of partRows) {
      if (seenRelatedIds.has(row.id)) continue;
      seenRelatedIds.add(row.id);
      related.push(row);
    }
  }
  if (planIds.length > 0) {
    for (const part of chunk(uniquePlanIds, IN_CHUNK_SIZE)) {
      const partRows = await db.txRecord.findMany({
        where: {
          OR: [
            { householdId, creditCardInstallmentPlanId: { in: part } },
            { householdId: null, creditCardInstallmentPlanId: { in: part } },
          ],
        },
      });
      for (const row of partRows) {
        if (seenRelatedIds.has(row.id)) continue;
        seenRelatedIds.add(row.id);
        related.push(row);
      }
    }
  }
  const entryTags = await db.entryTag.findMany({
    where: { entryId: { in: related.map((record) => record.id) } },
    select: { entryId: true, tagId: true },
  });
  const tagIdsByEntryId = new Map<string, string[]>();
  for (const entryTag of entryTags) {
    const tagIds = tagIdsByEntryId.get(entryTag.entryId) ?? [];
    tagIds.push(entryTag.tagId);
    tagIdsByEntryId.set(entryTag.entryId, tagIds);
  }

  const snapshots = serializeRecords(related, tagIdsByEntryId);
  if (snapshots[0] && installmentPlans.length > 0) {
    snapshots[0]._installmentPlanStatuses = installmentPlans.map((plan) => ({
      id: plan.id,
      status: plan.status,
    }));
  }
  return {
    snapshots,
    entryIds: related.map((record) => record.id),
  };
}

export async function saveEntryUndo(
  db: DbWriter,
  ctx: HouseholdContext,
  input: PreparedEntryUndo,
  action: "create" | "batch_create" | "edit" | "batch_edit" | "delete" | "batch_delete",
  label: string,
) {
  if (!input || input.snapshots.length === 0) return null;
  const created = await db.undoOperation.create({
    data: {
      householdId: ctx.householdId,
      userId: ctx.user?.id ?? null,
      action,
      label,
      snapshots: input.snapshots as Prisma.InputJsonValue,
      entryIds: input.entryIds as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  const older = await db.undoOperation.findMany({
    where: undoScope(ctx),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: ENTRY_UNDO_HISTORY_LIMIT,
    select: { id: true },
  });
  if (older.length > 0) {
    await db.undoOperation.deleteMany({
      where: { id: { in: older.map((operation) => operation.id) } },
    });
  }
  return created;
}

export async function getLatestEntryUndo(ctx: HouseholdContext) {
  return prisma.undoOperation.findFirst({
    where: { ...undoScope(ctx), undoneAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, label: true, action: true, createdAt: true, undoneAt: true, entryIds: true },
  });
}

export async function getAvailableEntryUndoCount(ctx: HouseholdContext) {
  return prisma.undoOperation.count({
    where: { ...undoScope(ctx), undoneAt: null },
  });
}

function previewText(value: unknown) {
  return value == null ? "" : String(value).trim();
}

function previewDate(value: unknown) {
  return previewText(value).slice(0, 10);
}

function previewNumber(value: unknown) {
  if (value == null || value === "") return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function snapshotPreviewItem(snapshot: UndoSnapshot): EntryUndoPreviewItem {
  return {
    id: previewText(snapshot.id),
    date: previewDate(snapshot.date),
    type: previewText(snapshot.type),
    amount: previewNumber(snapshot.amount),
    accountName: previewText(snapshot.accountName),
    toAccountName: previewText(snapshot.toAccountName),
    categoryName: previewText(snapshot.categoryName),
    counterpartyInstitutionName: previewText(snapshot.counterpartyInstitutionName),
    fundCode: previewText(snapshot.fundCode),
    fundName: previewText(snapshot.fundName) || previewText(snapshot.metalTypeName) || previewText(snapshot.insuranceProductName),
    note: previewText(snapshot.note) || previewText(snapshot.toNote),
  };
}

export async function getEntryUndoPreview(ctx: HouseholdContext, operationId: string): Promise<EntryUndoPreview | null> {
  const stored = await prisma.undoOperation.findFirst({
    where: { ...undoScope(ctx), id: operationId, undoneAt: null },
    select: { snapshots: true },
  });
  const snapshots = Array.isArray(stored?.snapshots)
    ? stored.snapshots as UndoSnapshot[]
    : [];
  if (snapshots.length === 0) return null;

  const items = snapshots
    .slice(0, ENTRY_UNDO_PREVIEW_LIMIT)
    .map(snapshotPreviewItem)
    .filter((item) => item.id || item.date || item.accountName || item.note);

  return {
    count: snapshots.length,
    hiddenCount: Math.max(0, snapshots.length - items.length),
    items,
  };
}

function restoreValue(value: unknown, type: string) {
  if (value == null) return null;
  if (type === "DateTime") return new Date(String(value));
  if (type === "BigInt") return BigInt(String(value));
  return value;
}

const txRecordScalarFields = new Map(
  (Prisma.dmmf.datamodel.models.find((model) => model.name === "TxRecord")?.fields ?? [])
    .filter((field) => field.kind !== "object")
    .map((field) => [field.name, field.type]),
);

function snapshotToUpdateData(snapshot: UndoSnapshot) {
  const data: Record<string, unknown> = {};
  for (const [field, type] of txRecordScalarFields) {
    if (field === "id" || field === "createdAt" || field === "updatedAt") continue;
    if (!(field in snapshot)) continue;
    data[field] = restoreValue(snapshot[field], type);
  }
  return data;
}

async function recalculateRestoredEntries(records: TxRecord[]) {
  const accountIds = new Set<string>();
  const fundAccounts = new Map<string, Set<string>>();
  const metalAccounts = new Set<string>();
  let touchedInvestment = false;

  for (const record of records) {
    accountIds.add(record.accountId);
    if (record.toAccountId) accountIds.add(record.toAccountId);
    if (record.type === "investment" || record.fundProductType) touchedInvestment = true;
    const investmentAccountId = record.fundSubtype === "redeem" || record.fundSubtype === "switch_out"
      ? record.accountId
      : record.toAccountId;
    if (!investmentAccountId) continue;
    if (record.metalTypeId || record.fundProductType === "metal") {
      metalAccounts.add(investmentAccountId);
    } else if (record.fundCode && record.fundProductType) {
      const codes = fundAccounts.get(investmentAccountId) ?? new Set<string>();
      codes.add(record.fundCode);
      fundAccounts.set(investmentAccountId, codes);
    }
  }

  await syncFundTransactionsFromTxRecords(records.map((record) => record.id)).catch((error) => {
    console.error("[entry-undo] failed to sync fund transactions", error);
  });
  for (const record of records) {
    await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: record.id }).catch((error) => {
      console.error("[entry-undo] failed to sync independent business transaction", { entryId: record.id, error });
    });
  }
  for (const [accountId, codes] of fundAccounts) {
    await recalcFundPositions(accountId, Array.from(codes)).catch((error) => {
      console.error("[entry-undo] failed to recalculate fund position", { accountId, error });
    });
  }
  for (const accountId of metalAccounts) {
    await recalcPreciousMetalPositions(accountId).catch((error) => {
      console.error("[entry-undo] failed to recalculate metal position", { accountId, error });
    });
  }
  for (const accountId of accountIds) {
    await recalcAndSaveAccountBalance(accountId).catch((error) => {
      console.error("[entry-undo] failed to recalculate account balance", { accountId, error });
    });
  }
  await invalidateCreditCardCycleCacheForAccountIds(accountIds).catch((error) => {
    console.error("[entry-undo] failed to invalidate credit-card cycles", error);
  });
  if (touchedInvestment) revalidateAfterInvestChange();
  else revalidateAfterTxChange();
}

export async function undoLatestEntryOperation(ctx: HouseholdContext) {
  const operation = await getLatestEntryUndo(ctx);
  if (!operation || operation.undoneAt) return null;
  const stored = await prisma.undoOperation.findUnique({
    where: { id: operation.id },
    select: { snapshots: true, action: true },
  });
  const snapshots = Array.isArray(stored?.snapshots)
    ? stored.snapshots as UndoSnapshot[]
    : [];
  if (snapshots.length === 0) return null;

  await prisma.$transaction(async (tx) => {
    if (operation.action === "create" || operation.action === "batch_create") {
      for (const snapshot of snapshots) {
        const id = String(snapshot.id ?? "");
        if (!id) continue;
        await tx.txRecord.updateMany({
          where: { id, OR: [{ householdId: ctx.householdId }, { householdId: null }], deletedAt: null },
          data: { deletedAt: new Date() },
        });
      }
      await tx.undoOperation.update({ where: { id: operation.id }, data: { undoneAt: new Date() } });
      return;
    }
    for (const snapshot of snapshots) {
      const id = String(snapshot.id ?? "");
      if (!id) continue;
      const current = await tx.txRecord.findFirst({
        where: { id, OR: [{ householdId: ctx.householdId }, { householdId: null }] },
        select: { id: true },
      });
      if (!current) throw new Error(`Record ${id} has been permanently deleted and cannot be undone`);
      await tx.txRecord.update({ where: { id }, data: snapshotToUpdateData(snapshot) as Prisma.TxRecordUncheckedUpdateInput });
      const tagIds = Array.isArray(snapshot._entryTagIds)
        ? snapshot._entryTagIds.map(String).filter(Boolean)
        : [];
      await tx.entryTag.deleteMany({ where: { entryId: id } });
      if (tagIds.length > 0) {
        await createManySkipDuplicatesCompat(tx.entryTag, tagIds.map((tagId) => ({ entryId: id, tagId })));
      }
    }
    const planStatuses = snapshots.flatMap((snapshot) =>
      Array.isArray(snapshot._installmentPlanStatuses)
        ? snapshot._installmentPlanStatuses as Array<{ id?: unknown; status?: unknown }>
        : [],
    );
    for (const plan of planStatuses) {
      const id = String(plan.id ?? "");
      const status = String(plan.status ?? "");
      if (!id || !status) continue;
      await tx.creditCardInstallmentPlan.updateMany({
        where: { id, householdId: ctx.householdId },
        data: { status: status as Prisma.EnumCreditCardInstallmentStatusFieldUpdateOperationsInput["set"] },
      });
    }
    await tx.undoOperation.update({ where: { id: operation.id }, data: { undoneAt: new Date() } });
  });

  const restored = await prisma.txRecord.findMany({
    where: {
      id: { in: snapshots.map((snapshot) => String(snapshot.id)) },
      OR: [{ householdId: ctx.householdId }, { householdId: null }],
    },
  });
  await recalculateRestoredEntries(restored);
  const remainingCount = await getAvailableEntryUndoCount(ctx);
  return { operationId: operation.id, label: operation.label, action: operation.action, restoredCount: restored.length, remainingCount, historyLimit: ENTRY_UNDO_HISTORY_LIMIT };
}
