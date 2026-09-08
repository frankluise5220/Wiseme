import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";
import { refreshHeldStockClosePrices } from "@/lib/stock/priceCache";
import { recalcStockPositions } from "@/lib/stock/recalcPosition";

export const runtime = "nodejs";

/**
 * POST /api/v1/stocks/prices/refresh-daily
 *
 * Refreshes daily closing prices for all currently held stocks in the active
 * household, from the last cached price date up to today, then recalculates
 * stock holdings so the latest close and its date are shown.
 *
 * Body: none required (household resolved from session/api key).
 *
 * Response: { ok: true, data: { checked, refreshed, failed, securityIds } }
 */
export async function POST(_req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(_req);
    const result = await refreshHeldStockClosePrices({ householdId });

    if (result.refreshed > 0 && result.securityIds.length > 0) {
      const holdings = await prisma.stockHolding.findMany({
        where: { householdId, securityId: { in: result.securityIds } },
        select: { accountId: true },
        distinct: ["accountId"],
      });
      for (const holding of holdings) {
        await recalcStockPositions(holding.accountId, result.securityIds).catch(() => undefined);
      }
      revalidateAfterInvestChange();
    }

    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Failed to refresh stock closing prices" },
      { status: 500 },
    );
  }
}