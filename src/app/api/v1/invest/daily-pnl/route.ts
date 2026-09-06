import { NextRequest, NextResponse } from "next/server";
import { AccountKind } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadInvestmentProfitReport } from "@/lib/server/investment-profit-report";

/**
 * GET /api/v1/invest/daily-pnl
 *
 * Query parameters:
 * - accountId: optional investment account ID. Omit or pass "all" for all investment accounts.
 * - accountIds: optional comma-separated investment account IDs.
 * - year: required four-digit year.
 * - month: required month for month mode.
 * - mode: "month" for daily rows, "year" for monthly rows.
 *
 * PnL uses the same investment-profit result as the report, including fund
 * NAV movement, stock close-price movement plus sell/dividend/fee cash-flow
 * corrections, fixed asset sale realized profit, wealth product results, and
 * deposit interest/fees.
 *
 * Success:
 * - month mode: { ok: true, days: [{ date, mv, pnl }] }
 * - year mode: { ok: true, months: [{ month, mv, pnl }] }
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId")?.trim();
  const accountIds = searchParams.get("accountIds")?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
  const year = Number(searchParams.get("year")?.trim());
  const month = Number(searchParams.get("month")?.trim());
  const mode = searchParams.get("mode") === "year" ? "year" : "month";

  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    return NextResponse.json({ ok: false, code: "INVALID_YEAR", error: "Invalid year." }, { status: 400 });
  }
  if (mode === "month" && (!Number.isInteger(month) || month < 1 || month > 12)) {
    return NextResponse.json({ ok: false, code: "INVALID_MONTH", error: "Invalid month." }, { status: 400 });
  }

  const ctx = await getHouseholdScope();
  if (!ctx.user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Please sign in first." }, { status: 401 });
  }

  const requestedAccountIds = Array.from(new Set([
    ...accountIds,
    ...(accountId && accountId !== "all" ? [accountId] : []),
  ]));
  if (requestedAccountIds.length > 0) {
    const count = await prisma.account.count({
      where: {
        ...ctx.hidFilter,
        id: { in: requestedAccountIds },
        kind: AccountKind.investment,
      },
    });
    if (count !== requestedAccountIds.length) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Investment account not found." }, { status: 404 });
    }
  }

  try {
    const report = await loadInvestmentProfitReport(ctx, {
      period: mode === "year" ? "month" : "day",
      year,
      month: mode === "year" ? 1 : month,
      accountIds: requestedAccountIds.length ? requestedAccountIds : null,
      fundValuationMode: "daily_nav_delta",
    });

    if (mode === "year") {
      return NextResponse.json({
        ok: true,
        months: report.rows.map((row) => ({
          month: Number(row.key.slice(5, 7)),
          mv: null,
          pnl: row.count > 0 ? row.totalProfit : null,
        })),
      });
    }

    return NextResponse.json({
      ok: true,
      days: report.rows.map((row) => ({
        date: row.key,
        mv: 0,
        pnl: row.count > 0 ? row.totalProfit : null,
      })),
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      code: "FETCH_FAILED",
      error: error instanceof Error ? error.message : "Failed to fetch investment profit.",
    }, { status: 500 });
  }
}
