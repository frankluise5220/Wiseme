import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/auth";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  loadFundPortfolioTrendData,
  refreshBenchmarkCache,
} from "@/lib/server/fund-portfolio-trend";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/statistics/fund-trend
 *
 * Aggregates monthly fund portfolio data across all investment accounts in the
 * household: cost basis, market value, floating P/L, and net invested flow per month.
 * Optionally overlays 沪深300 normalised NAV as a benchmark.
 *
 * Query params:
 *   start: YYYY-MM (optional, default = earliest transaction)
 *   end:   YYYY-MM (optional, default = current month)
 *   accountIds: comma-separated account IDs (optional, default = all investment accounts)
 *   benchmark:  "1" to include 沪深300 baseline (default off; auto-fetches if cache is empty)
 */
export async function GET(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json(
      { ok: false, code: "UNAUTHORIZED", error: "请先登录" },
      { status: 401 },
    );
  }

  const ctx = await getHouseholdScope();
  const { searchParams } = new URL(req.url);
  const startMonth = (searchParams.get("start") ?? "").trim() || undefined;
  const endMonth = (searchParams.get("end") ?? "").trim() || undefined;
  const accountIdsRaw = (searchParams.get("accountIds") ?? "").trim();
  const accountIds = accountIdsRaw ? accountIdsRaw.split(",").filter(Boolean) : undefined;
  const includeBenchmark = searchParams.get("benchmark") === "1";

  try {
    // If benchmark requested but cache is empty, try a refresh (best-effort).
    if (includeBenchmark && startMonth && endMonth) {
      const [sy, sm] = startMonth.split("-").map(Number);
      const [ey, em] = endMonth.split("-").map(Number);
      const startDate = new Date(Date.UTC(sy, sm - 1, 1));
      const endDate = new Date(Date.UTC(ey, em, 0));
      const formattedStart = startDate.toISOString().slice(0, 10);
      const formattedEnd = endDate.toISOString().slice(0, 10);
      // Only refresh if we don't already have data covering the requested range
      // (the loader will skip on empty cache; safe to call repeatedly).
      await refreshBenchmarkCache(formattedStart, formattedEnd);
    }

    const data = await loadFundPortfolioTrendData(ctx, {
      startMonth,
      endMonth,
      accountIds,
      includeBenchmark,
    });

    return NextResponse.json({
      ok: true,
      points: data.points,
      emptyMonths: data.emptyMonths,
      benchmark: data.benchmark,
      rangeStart: data.rangeStart,
      rangeEnd: data.rangeEnd,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        code: "LOAD_FAILED",
        error: e instanceof Error ? e.message : "加载失败",
      },
      { status: 500 },
    );
  }
}