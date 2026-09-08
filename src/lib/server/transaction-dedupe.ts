import { Prisma, TransactionType } from "@prisma/client";

// Dedupe window for import / AI-ingest flows: same record identity within the
// window is treated as a repeated import of the same statement.
const INGEST_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
// Manual create flow only guards against double-click / double-submit of the
// same form. A longer window would swallow legitimate consecutive entries that
// happen to share account, amount, and note.
const MANUAL_CREATE_DOUBLE_SUBMIT_WINDOW_MS = 5 * 1000;

function textOrNull(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  return text || null;
}

export async function findRecentTransactionDuplicate(
  tx: Prisma.TransactionClient,
  params: {
    householdId: string;
    type: TransactionType;
    date: Date;
    accountId: string;
    amount: number;
    toAccountId?: string | null;
    categoryId?: string | null;
    note?: string | null;
    source?: string | null;
    now?: Date;
  },
) {
  const source = textOrNull(params.source) ?? "manual";
  if (!source) return null;

  // Same-record identity follows business fields, not ingestion source.
  return tx.txRecord.findFirst({
    where: {
      householdId: params.householdId,
      deletedAt: null,
      type: params.type,
      date: params.date,
      accountId: params.accountId,
      toAccountId: params.toAccountId ?? null,
      amount: params.amount,
      note: textOrNull(params.note),
      createdAt: {
        gte: new Date((params.now ?? new Date()).getTime() - INGEST_DEDUPE_WINDOW_MS),
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function findRecentManualTransactionDuplicate(
  tx: Prisma.TransactionClient,
  params: Parameters<typeof findRecentTransactionDuplicate>[1],
) {
  const source = textOrNull(params.source) ?? "manual";
  if (source !== "manual") return null;
  const duplicate = await findRecentTransactionDuplicate(tx, { ...params, source });
  if (!duplicate) return null;
  // Manual create dedupe only protects against an immediate double submit, so
  // ignore matches older than the double-submit window.
  const now = params.now ?? new Date();
  if (duplicate.createdAt.getTime() < now.getTime() - MANUAL_CREATE_DOUBLE_SUBMIT_WINDOW_MS) {
    return null;
  }
  return duplicate;
}
