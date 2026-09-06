import { NextResponse } from "next/server";

import {
  getIncomeExpenseReport,
  type IncomeExpenseGroupBy,
  type IncomeExpenseReportDetailType,
} from "@/lib/server/income-expense-report";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadReportDetailEntries } from "@/lib/server/report-detail-entries";

export const runtime = "nodejs";

/**
 * GET /api/v1/reports/income-expense/detail
 *
 * Query params:
 * - start: YYYY-MM-DD
 * - end: YYYY-MM-DD
 * - groupBy?: "month" | "year"
 * - accountId?: Account.id (comma-separated for multiple)
 * - detailType: "income" | "expense" | "net"
 * - detailCategoryKey?: Category.id or report uncategorized key
 * - detailColumnKey?: report column key, such as YYYY-MM
 *
 * Returns:
 * - details amounts use the household base currency at the latest stored rates;
 *   entries retain their original transaction currency and amounts for editing.
 * - Missing-rate currencies are excluded from details and its totals.
 * - { ok: true, data: { details, entries, baseCurrency, missingFxCurrencies } }
 * - { ok: false, error }
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const start = url.searchParams.get("start") ?? "";
    const end = url.searchParams.get("end") ?? "";
    const groupByRaw = url.searchParams.get("groupBy") ?? "";
    const groupBy: IncomeExpenseGroupBy = groupByRaw === "year" ? "year" : "month";
    const accountId = url.searchParams.get("accountId")?.trim() || "";
    const accountIds = accountId ? accountId.split(",").map((id) => id.trim()).filter(Boolean) : [];
    const institutionId = url.searchParams.get("institutionId")?.trim() || "";
    const institutionIds = (url.searchParams.get("institutionIds") ?? institutionId)
      .split(",").map((id) => id.trim()).filter(Boolean);
    const userIds = url.searchParams.get("userIds")?.split(",").map((id) => id.trim()).filter(Boolean) ?? [];
    const detailTypeRaw = url.searchParams.get("detailType") ?? "";
    const detailType: IncomeExpenseReportDetailType | null =
      detailTypeRaw === "income" || detailTypeRaw === "expense" || detailTypeRaw === "net"
        ? detailTypeRaw
        : null;

    if (!detailType) {
      return NextResponse.json({ ok: false, code: "INVALID_DETAIL_TYPE", error: "Invalid detail type" }, { status: 400 });
    }

    const ctx = await getHouseholdScope();
    const report = await getIncomeExpenseReport(ctx, {
      start,
      end,
      groupBy,
      accountIds: accountIds.length > 0 ? accountIds : undefined,
      institutionId: institutionId || undefined,
      institutionIds: institutionIds.length > 0 ? institutionIds : undefined,
      userIds: userIds.length > 0 ? userIds : undefined,
      detail: {
        type: detailType,
        categoryKey: url.searchParams.get("detailCategoryKey")?.trim() || undefined,
        columnKey: url.searchParams.get("detailColumnKey")?.trim() || undefined,
      },
    });

    const detailEntryIds = report.details
      ? [...new Set(report.details.rows.map((row) => row.entryId))]
      : [];
    const entries = await loadReportDetailEntries(ctx, detailEntryIds);

    return NextResponse.json({
      ok: true,
      data: {
        details: report.details,
        entries,
        baseCurrency: report.baseCurrency,
        missingFxCurrencies: report.missingFxCurrencies,
      },
    });
  } catch (error) {
    console.error("GET /api/v1/reports/income-expense/detail error:", error);
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: "Failed to fetch report details" }, { status: 500 });
  }
}
