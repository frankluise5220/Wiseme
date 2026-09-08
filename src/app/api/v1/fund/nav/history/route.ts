import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser } from "@/lib/server/auth";

export const runtime = "nodejs";

/**
 * GET /api/v1/fund/nav/history
 *
 * Queries historical NAV data for a fund within a date range, used to draw trend charts.
 * Requires login (prevents unauthenticated reads/probing of the global NAV cache).
 *
 * Query params:
 *   code      (required) — fund code
 *   start     (optional) — start date YYYY-MM-DD, defaults to 180 days ago
 *   end       (optional) — end date YYYY-MM-DD, defaults to today
 *
 * Response:
 *   { ok: true, data: [{ date, nav, cumNav }] }
 */
export async function GET(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }

  const code = req.nextUrl.searchParams.get("code")?.trim();
  if (!code) {
    return NextResponse.json({ ok: false, code: "MISSING_FUND_CODE", error: "缺少基金代码" }, { status: 400 });
  }

  const endRaw = req.nextUrl.searchParams.get("end")?.trim();
  const startRaw = req.nextUrl.searchParams.get("start")?.trim();

  const endDate = endRaw ? new Date(endRaw) : new Date();
  // Default to 180 days of data, covering roughly the last 6 months of trends
  const defaultStart = new Date(endDate);
  defaultStart.setDate(defaultStart.getDate() - 180);
  const startDate = startRaw ? new Date(startRaw) : defaultStart;

  try {
    const rows = await prisma.fundNavCache.findMany({
      where: {
        fundCode: code,
        navDate: { gte: startDate, lte: endDate },
      },
      orderBy: { navDate: "asc" },
      select: { navDate: true, nav: true, cumNav: true },
    });

    const data = rows.map((r) => ({
      date: r.navDate.toISOString().substring(0, 10),
      nav: r.nav,
      cumNav: r.cumNav ?? null,
    }));

    return NextResponse.json({ ok: true, data });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: e instanceof Error ? e.message : "查询失败" },
      { status: 500 }
    );
  }
}
