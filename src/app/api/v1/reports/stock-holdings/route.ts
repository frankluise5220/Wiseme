import { NextRequest, NextResponse } from "next/server";

import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { loadCachedStockHoldingReport } from "@/lib/server/cached-data";

export const runtime = "nodejs";

/**
 * GET /api/v1/reports/stock-holdings
 *
 * Query:
 * - accountId?: Account.id of one stock account
 *
 * Returns:
 * - { ok: true, data: { rows, totals } }
 * - { ok: false, error }
 *
 * Rows come from StockHolding for current stock accounts. Floating P&L is
 * marketValue - cost; historicalProfit is the realized profit already stored
 * by recalcStockPositions. Do not infer stock values from fund fields.
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await getApiHouseholdScope(req);
    const accountId = req.nextUrl.searchParams.get("accountId")?.trim() || "";
    const report = await loadCachedStockHoldingReport(
      JSON.stringify(ctx.hidFilter),
      JSON.stringify(accountId ? [accountId] : []),
    );
    return NextResponse.json({ ok: true, data: report });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "查询股票持仓报表失败" },
      { status: 500 },
    );
  }
}
