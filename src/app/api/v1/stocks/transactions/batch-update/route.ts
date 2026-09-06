import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { recalcStockPositions } from "@/lib/stock/recalcPosition";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

/**
 * POST /api/v1/stocks/transactions/batch-update
 * Batch-updates safe metadata fields on stock transactions in one pass,
 * then recalculates affected stock holdings and balances once.
 *
 * Body:
 * - updates: Array<{ id, note?, brokerTradeId? }>
 *   note: full replacement of the transaction note (empty string clears it)
 *   brokerTradeId: full replacement of the broker trade id (empty string clears it)
 *
 * Only metadata fields are accepted here. Quantity/price/amount/date/action
 * changes must go through the single PATCH endpoint because they rebuild the
 * cash flow and holdings; running that repeatedly in a loop would recalculate
 * positions once per row.
 *
 * Response:
 * - { ok: true, data: { updatedCount, accountIds } }
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as { updates?: Array<Record<string, unknown>> } | null;
    const updates = Array.isArray(body?.updates) ? body.updates : [];
    if (updates.length === 0) {
      return NextResponse.json({ ok: false, code: "MISSING_UPDATES", error: "缺少要修改的记录" }, { status: 400, headers: corsHeaders() });
    }
    if (updates.length > 500) {
      return NextResponse.json({ ok: false, code: "TOO_MANY_UPDATES", error: "单次最多修改 500 条" }, { status: 400, headers: corsHeaders() });
    }

    const ids = Array.from(new Set(updates.map((item) => String(item.id ?? "").trim()).filter(Boolean)));
    if (ids.length === 0) {
      return NextResponse.json({ ok: false, code: "MISSING_TRANSACTION_IDS", error: "缺少交易 id" }, { status: 400, headers: corsHeaders() });
    }

    const existing = await prisma.stockTransaction.findMany({
      where: { householdId, deletedAt: null, id: { in: ids } },
      select: { id: true, stockAccountId: true, securityId: true, cashAccountId: true },
    });
    if (existing.length === 0) {
      return NextResponse.json({ ok: false, code: "RECORD_NOT_FOUND", error: "股票交易不存在" }, { status: 404, headers: corsHeaders() });
    }
    const existingById = new Map(existing.map((row) => [row.id, row]));

    const changed: Array<{ id: string; stockAccountId: string; securityId: string | null; cashAccountId: string | null }> = [];
    await prisma.$transaction(async (tx) => {
      for (const item of updates) {
        const id = String(item.id ?? "").trim();
        const row = existingById.get(id);
        if (!row) continue;

        const data: Record<string, string | null> = {};
        if (item.note !== undefined) data.note = String(item.note ?? "").trim() || null;
        if (item.brokerTradeId !== undefined) data.brokerTradeId = String(item.brokerTradeId ?? "").trim() || null;
        if (Object.keys(data).length === 0) continue;

        await tx.stockTransaction.update({ where: { id }, data });
        changed.push({ id, stockAccountId: row.stockAccountId, securityId: row.securityId, cashAccountId: row.cashAccountId });
      }
    });

    if (changed.length === 0) {
      return NextResponse.json({ ok: true, data: { updatedCount: 0, accountIds: [] } }, { headers: corsHeaders() });
    }

    const accountIds = new Set<string>();
    const securityIdsByAccount = new Map<string, Set<string>>();
    for (const row of changed) {
      accountIds.add(row.stockAccountId);
      if (row.cashAccountId) accountIds.add(row.cashAccountId);
      if (row.securityId) {
        const set = securityIdsByAccount.get(row.stockAccountId) ?? new Set<string>();
        set.add(row.securityId);
        securityIdsByAccount.set(row.stockAccountId, set);
      }
    }
    for (const [stockAccountId, securityIds] of securityIdsByAccount) {
      await recalcStockPositions(stockAccountId, Array.from(securityIds));
    }
    for (const accountId of accountIds) {
      await recalcAndSaveAccountBalance(accountId).catch(() => undefined);
    }
    await invalidateCreditCardCycleCacheForAccountIds(accountIds).catch(() => undefined);
    revalidateAfterInvestChange();

    return NextResponse.json({
      ok: true,
      data: {
        updatedCount: changed.length,
        accountIds: Array.from(accountIds),
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "BATCH_UPDATE_FAILED", error: error instanceof Error ? error.message : "批量修改失败" },
      { status: 500, headers: corsHeaders() },
    );
  }
}
