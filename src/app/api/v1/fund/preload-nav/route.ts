import { NextRequest, NextResponse } from "next/server";
import { fetchHistoricalNavList, preloadNavListToCache } from "@/lib/fund/navCache";

/**
 * NAV library expansion API
 * POST /api/v1/fund/preload-nav
 * Body: { fundCode: string, startDate: string, endDate: string }
 *
 * Only writes historical NAV for the given period into the FundNavCache table.
 * Does not return NAV data; only returns success/failure status and the written count.
 *
 * When to call: before batch-generating regular investment details, call this API to
 * prefill the NAV library so batch generation reads from cache without hitting the
 * external API again, saving time.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { fundCode, startDate, endDate } = body;

    if (!fundCode || !startDate || !endDate) {
      return NextResponse.json(
        { ok: false, code: "MISSING_NAV_RANGE_PARAMS", error: "缺少 fundCode、startDate 或 endDate" },
        { status: 400 }
      );
    }

    // Fetch the historical NAV list from Eastmoney
    const navList = await fetchHistoricalNavList(fundCode, startDate, endDate);

    if (navList.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "该时间段内无净值数据",
        count: 0,
      });
    }

    // Write the NAV list into the cache table
    const written = await preloadNavListToCache(fundCode, navList);

    return NextResponse.json({
      ok: true,
      message: `已扩充净值库 ${written} 条`,
      count: written,
      total: navList.length,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "PRELOAD_NAV_FAILED", error: e instanceof Error ? e.message : "扩充净值库失败" },
      { status: 500 }
    );
  }
}