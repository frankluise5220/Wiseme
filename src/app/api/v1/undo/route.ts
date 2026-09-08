/**
 * GET /api/v1/undo: returns the latest undoable user entry operation and remaining undo count.
 * POST /api/v1/undo: applies the latest create/edit/delete reversal as one atomic group.
 */
import { NextResponse } from "next/server";

import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  ENTRY_UNDO_HISTORY_LIMIT,
  getAvailableEntryUndoCount,
  getEntryUndoPreview,
  getLatestEntryUndo,
  undoLatestEntryOperation,
} from "@/lib/server/entry-undo";

export async function GET() {
  const ctx = await getHouseholdScope();
  if (!ctx.user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Unauthorized" }, { status: 401 });
  }
  const [operation, undoCount] = await Promise.all([
    getLatestEntryUndo(ctx),
    getAvailableEntryUndoCount(ctx),
  ]);
  const preview = operation ? await getEntryUndoPreview(ctx, operation.id) : null;
  return NextResponse.json({
    ok: true,
    data: operation ? {
      id: operation.id,
      label: operation.label,
      action: operation.action,
      createdAt: operation.createdAt.toISOString(),
      canUndo: true,
      undoCount,
      historyLimit: ENTRY_UNDO_HISTORY_LIMIT,
      preview,
    } : null,
  });
}

export async function POST() {
  try {
    const ctx = await getHouseholdScope();
    if (!ctx.user) {
      return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Unauthorized" }, { status: 401 });
    }
    const result = await undoLatestEntryOperation(ctx);
    if (!result) {
      return NextResponse.json({ ok: false, code: "NOTHING_TO_UNDO", error: "No operations to undo" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      code: "UNDO_FAILED",
      error: error instanceof Error ? error.message : "Undo failed",
    }, { status: 500 });
  }
}
