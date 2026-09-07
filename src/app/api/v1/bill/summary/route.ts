/**
 * API: /api/v1/bill/summary
 *
 * GET query parameters:
 *   accountId: Account.id for a credit-card account
 *   billMonth?: YYYY-MM|all, used to preserve the selected bill scope
 *   hideZeroBills?: 1|0
 *   hideSettledBills?: 1|0
 *   billMonthsLimit?: all|positive integer
 *
 * Returns the recalculated credit-card bill summary rows without re-rendering
 * the detail panel or the surrounding page.
 */
import { AccountKind } from "@prisma/client";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getCreditBillAccountIds } from "@/lib/server/credit-card-institution-settings";
import { loadCreditBillPageData } from "@/lib/server/credit-bill-page-data";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

function parseBillMonthsLimit(value: string | null) {
  if (value === "all") return 9999;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 9999) : 10;
}

export async function GET(request: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const searchParams = new URL(request.url).searchParams;
    const accountId = searchParams.get("accountId")?.trim() ?? "";
    if (!accountId) {
      return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "Missing accountId." }, { status: 400 });
    }

    const account = await prisma.account.findFirst({
      where: { id: accountId, householdId, kind: AccountKind.bank_credit },
      select: {
        id: true,
        householdId: true,
        institutionId: true,
        kind: true,
        billingDay: true,
        repaymentDay: true,
        repaymentOffsetDays: true,
        creditBillMode: true,
      },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "CREDIT_ACCOUNT_NOT_FOUND", error: "Credit account not found." }, { status: 404 });
    }

    const billAccountIds = await getCreditBillAccountIds(prisma, account);
    const data = await loadCreditBillPageData({
      householdId,
      selectedAccount: account,
      isBillAccount: true,
      billAccountIds,
      billStorageAccountId: billAccountIds[0] ?? account.id,
      billMonthParam: searchParams.get("billMonth")?.trim() || "",
      billPage: 1,
      billMonthsLimit: parseBillMonthsLimit(searchParams.get("billMonthsLimit")),
      hideZeroBills: searchParams.get("hideZeroBills") === "1",
      hideSettledBills: searchParams.get("hideSettledBills") === "1",
      showRecentBillCycles: searchParams.get("billMonthsLimit") !== "all",
      view: "refresh",
      t: () => "",
      categoryLabels: new Map(),
      isSettlementDebtAccountId: () => false,
      isCreditCardRepaymentForDisplay: () => false,
    });

    return NextResponse.json({
      ok: true,
      data: {
        accountId,
        rows: data.creditBillSummaryRows,
        creditBillBalanceValue: data.creditBillBalanceValue,
      },
    });
  } catch (error) {
    console.error("GET /api/v1/bill/summary error:", error);
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: "Internal server error." }, { status: 500 });
  }
}
