import { NextRequest, NextResponse } from "next/server";

import { computeMonthlyFloatingPnl } from "@/lib/invest/monthlyFloatingPnl";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const dynamic = "force-dynamic";

function parseTargetMonth(req: NextRequest) {
  const rawMonth = req.nextUrl.searchParams.get("month")?.trim();
  const rawYear = req.nextUrl.searchParams.get("year")?.trim();
  const rawMonthNumber = req.nextUrl.searchParams.get("monthNumber")?.trim();
  const normalizedMonth = rawMonth?.match(/^(\d{4})-(\d{2})$/);
  const year = normalizedMonth ? Number(normalizedMonth[1]) : Number(rawYear);
  const month = normalizedMonth ? Number(normalizedMonth[2]) : Number(rawMonthNumber ?? rawMonth);
  if (!Number.isInteger(year) || !Number.isInteger(month) || year < 2000 || year > 2100 || month < 1 || month > 12) {
    return null;
  }
  return { year, month };
}

/**
 * GET /api/v1/invest/monthly-floating-pnl?month=YYYY-MM&accounts=id1,id2
 *
 * Returns the canonical monthly fund floating PnL view. The route only parses
 * request context and delegates source-data reads plus calculation to
 * computeMonthlyFloatingPnl.
 */
export async function GET(req: NextRequest) {
  try {
    const parsed = parseTargetMonth(req);
    if (!parsed) {
      return NextResponse.json({ ok: false, error: "请提供 month=YYYY-MM，或 year=YYYY&monthNumber=M" }, { status: 400 });
    }

    const ctx = await getHouseholdScope();
    const accountIds = req.nextUrl.searchParams.get("accounts")?.trim()
      ? req.nextUrl.searchParams.get("accounts")!.split(",").map((item) => item.trim()).filter(Boolean)
      : null;

    const data = await computeMonthlyFloatingPnl({
      ctx,
      year: parsed.year,
      month: parsed.month,
      accountIds,
    });

    return NextResponse.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "月度浮盈计算失败";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
