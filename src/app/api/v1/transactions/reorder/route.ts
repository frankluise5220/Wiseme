/**
 * POST /api/v1/transactions/reorder
 *
 * Body:
 * - { accountId: string; entryId: string; direction: "up" | "down" }
 * - { accountId: string; entryId: string; targetEntryId: string; targetPosition?: "before" | "after" }
 * - { accountId: string; accountIds: string[]; entryId: string; targetEntryId: string; targetPosition?: "before" | "after" }
 * Response: { ok: true, changed: boolean, orderedEntryIds: string[], runningBalances?: Record<string, number> } | { ok: false, code, error }
 *
 * Reorders ordinary TxRecord rows within the same displayed local date for one
 * account detail view. It never moves balance anchors; those remain end-of-day
 * records for running balance calculation.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { BALANCE_INITIALIZATION_SOURCE, BALANCE_RECONCILE_SOURCE, applyBalanceReconcileEntry, getBalanceReconcileTarget } from "@/lib/balance-reconcile";
import { compareDetailEntriesAsc, compareDetailEntriesDesc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterEntryOrderChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

type Direction = "up" | "down";
type TargetPosition = "before" | "after";

type ReorderRow = {
  id: string;
  date: Date;
  postedAt: Date | null;
  createdAt: Date;
  dayOrder: number | null;
  amount: unknown;
  type: string;
  accountId: string | null;
  toAccountId: string | null;
  debtPrincipalAmount: unknown;
  fundSubtype: string | null;
  source: string | null;
  toNote: string | null;
  fundArrivalDate: Date | null;
  fundArrivalAmount: unknown;
};

type LinkedWealthForReorder = {
  id: string;
  action: string;
  arrivalDate: Date | null;
  cashAccountId: string | null;
  deletedAt: Date | null;
};

function isWealthCashReceiptAction(action?: string | null) {
  return action === "redeem" || action === "dividend_cash";
}

function rowWithLinkedWealthDisplayDate(row: ReorderRow, wealthRow?: LinkedWealthForReorder | null): ReorderRow {
  if (!wealthRow || wealthRow.deletedAt || !isWealthCashReceiptAction(wealthRow.action)) return row;
  return {
    ...row,
    fundSubtype: wealthRow.action,
    fundArrivalDate: wealthRow.arrivalDate ?? row.fundArrivalDate,
    toAccountId: wealthRow.cashAccountId ?? row.toAccountId,
  };
}

function localDateKey(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isBalanceAnchor(entry: { source?: string | null; toNote?: string | null }) {
  const source = String(entry.source ?? "");
  if (source !== BALANCE_RECONCILE_SOURCE && source !== BALANCE_INITIALIZATION_SOURCE) return false;
  return getBalanceReconcileTarget(entry) != null;
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null) as {
      accountId?: unknown;
      entryId?: unknown;
      accountIds?: unknown;
      direction?: unknown;
      targetEntryId?: unknown;
      targetPosition?: unknown;
    } | null;
    const accountId = String(body?.accountId ?? "").trim();
    const entryId = String(body?.entryId ?? "").trim();
    const targetEntryId = String(body?.targetEntryId ?? "").trim();
    const targetPositionRaw = String(body?.targetPosition ?? "").trim();
    const targetPosition = (targetPositionRaw === "before" || targetPositionRaw === "after" ? targetPositionRaw : "") as TargetPosition | "";
    const direction = String(body?.direction ?? "").trim() as Direction;

    if (!accountId || !entryId || (!targetEntryId && direction !== "up" && direction !== "down")) {
      return NextResponse.json({ ok: false, code: "MISSING_PARAMS", error: "参数不完整" }, { status: 400 });
    }
    const accountIdsRaw = Array.isArray(body?.accountIds) ? body.accountIds : [];
    const scopeAccountIds = Array.from(new Set([
      accountId,
      ...accountIdsRaw.map((id) => String(id ?? "").trim()),
    ].filter(Boolean))).slice(0, 50);

    const { householdId } = await getHouseholdScope();
    const reorderRowSelect = {
      id: true,
      date: true,
      postedAt: true,
      createdAt: true,
      dayOrder: true,
      amount: true,
      type: true,
      accountId: true,
      toAccountId: true,
      debtPrincipalAmount: true,
      fundSubtype: true,
      source: true,
      toNote: true,
      fundArrivalDate: true,
      fundArrivalAmount: true,
    } as const;
    const targetRows = await prisma.txRecord.findMany({
      where: {
        id: entryId,
        deletedAt: null,
        householdId,
        OR: [
          { accountId: { in: scopeAccountIds } },
          { toAccountId: { in: scopeAccountIds } },
        ],
      },
      select: reorderRowSelect,
      take: 1,
    });
    const target = targetRows[0] ?? null;
    if (!target) {
      return NextResponse.json({ ok: false, code: "ENTRY_NOT_FOUND", error: "记录不存在" }, { status: 404 });
    }
    if (isBalanceAnchor(target)) {
      return NextResponse.json({ ok: false, code: "BALANCE_ANCHOR_NOT_MOVABLE", error: "余额校准记录固定在当天末尾，不能手动移动" }, { status: 400 });
    }

    const rows = await prisma.txRecord.findMany({
      where: {
        deletedAt: null,
        householdId,
        OR: [
          { accountId: { in: scopeAccountIds } },
          { toAccountId: { in: scopeAccountIds } },
        ],
      },
      select: reorderRowSelect,
    });

    const rowIds = rows.map((row) => row.id);
    const wealthLinks = rowIds.length > 0
      ? await prisma.entryBusinessLink.findMany({
          where: {
            householdId,
            deletedAt: null,
            wealthTransactionId: { not: null },
            OR: [
              { cashEntryId: { in: rowIds } },
              { businessEntryId: { in: rowIds } },
            ],
          },
          include: { WealthTransaction: true },
        })
      : [];
    const linkedWealthByEntryId = new Map<string, LinkedWealthForReorder>();
    for (const link of wealthLinks) {
      const wealthRow = link.WealthTransaction;
      if (!wealthRow) continue;
      if (link.cashEntryId) linkedWealthByEntryId.set(link.cashEntryId, wealthRow);
      if (link.businessEntryId) linkedWealthByEntryId.set(link.businessEntryId, wealthRow);
    }
    const displayRowOf = (row: ReorderRow) => rowWithLinkedWealthDisplayDate(row, linkedWealthByEntryId.get(row.id) ?? null);

    const targetDay = localDateKey(getDetailEntryDisplayDate(displayRowOf(target), accountId));
    const sameDayRows = rows
      .filter((row) => localDateKey(getDetailEntryDisplayDate(displayRowOf(row), accountId)) === targetDay)
      .filter((row) => !isBalanceAnchor(row))
      .sort((a, b) => compareDetailEntriesDesc(displayRowOf(a), displayRowOf(b), accountId));

    const currentIndex = sameDayRows.findIndex((row) => row.id === entryId);
    if (currentIndex < 0) {
      return NextResponse.json({ ok: false, code: "ENTRY_NOT_IN_DAY_LIST", error: "记录不在当前账户的同日列表中" }, { status: 400 });
    }

    let reorderedRows = [...sameDayRows];
    if (targetEntryId) {
      const targetIndex = sameDayRows.findIndex((row) => row.id === targetEntryId);
      if (targetIndex < 0) {
        return NextResponse.json({ ok: false, code: "REORDER_WITHIN_DAY_ONLY", error: "只能在同一天记录内调整顺序" }, { status: 400 });
      }
      if (targetIndex === currentIndex) {
        return NextResponse.json({ ok: true, changed: false, orderedEntryIds: sameDayRows.map((row) => row.id) });
      }
      const position = targetPosition || (currentIndex < targetIndex ? "after" : "before");
      const [moving] = reorderedRows.splice(currentIndex, 1);
      const targetIndexAfterRemoval = reorderedRows.findIndex((row) => row.id === targetEntryId);
      if (targetIndexAfterRemoval < 0) {
        return NextResponse.json({ ok: false, code: "TARGET_ENTRY_NOT_FOUND", error: "目标记录不存在" }, { status: 400 });
      }
      reorderedRows.splice(position === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval, 0, moving);
    } else {
      const nextIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
      const neighbor = sameDayRows[nextIndex];
      if (!neighbor) {
        return NextResponse.json({ ok: true, changed: false, orderedEntryIds: sameDayRows.map((row) => row.id) });
      }
      [reorderedRows[currentIndex], reorderedRows[nextIndex]] = [reorderedRows[nextIndex], reorderedRows[currentIndex]];
    }

    const normalizedOrders = new Map<string, number>();
    const step = 1000;
    for (let index = 0; index < reorderedRows.length; index += 1) {
      normalizedOrders.set(reorderedRows[index].id, (reorderedRows.length - index) * step);
    }

    const rowWithNormalizedOrder = (row: ReorderRow): ReorderRow => ({
      ...row,
      dayOrder: normalizedOrders.get(row.id) ?? row.dayOrder ?? 0,
    });
    const orderedRowsAfterChange = rows
      .map((row) => rowWithNormalizedOrder(displayRowOf(row)))
      .sort((a, b) => compareDetailEntriesDesc(a, b, accountId));
    const ascRowsAfterChange = [...orderedRowsAfterChange].sort((a, b) => compareDetailEntriesAsc(a, b, accountId));
    const affectedDayIdSet = new Set(sameDayRows.map((row) => row.id));
    const runningBalances: Record<string, number> = {};
    let runningBalance = 0;
    for (const row of ascRowsAfterChange) {
      runningBalance = applyBalanceReconcileEntry(runningBalance, row, accountId);
      if (affectedDayIdSet.has(row.id)) runningBalances[row.id] = runningBalance;
    }

    await prisma.$transaction(async (tx) => {
      for (const row of sameDayRows) {
        await tx.txRecord.updateMany({
          where: { id: row.id, householdId },
          data: { dayOrder: normalizedOrders.get(row.id) ?? 0 },
        });
      }
    });

    revalidateAfterEntryOrderChange();

    return NextResponse.json({ ok: true, changed: true, orderedEntryIds: reorderedRows.map((row) => row.id), runningBalances });
  } catch (error) {
    console.error("POST /api/v1/transactions/reorder error:", error);
    const message = error instanceof Error ? error.message : "调整顺序失败";
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: message || "调整顺序失败" }, { status: 500 });
  }
}
