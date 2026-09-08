import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadInsuranceTransactionDetailLike } from "@/lib/server/business-transaction-entries";

/**
 * GET /api/v1/business-transactions/insurance?accountId=...
 *
 * Reads independent insurance transaction rows for one insurance account.
 * Response:
 * - success: { ok: true, data: { entries } }
 * - failure: { ok: false, error }
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const accountId = req.nextUrl.searchParams.get("accountId")?.trim() ?? "";
    if (!accountId) {
      return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "缺少保险账户ID" }, { status: 400 });
    }

    const account = await prisma.account.findFirst({
      where: { id: accountId, kind: "insurance", ...ctx.hidFilter },
      select: { id: true },
    });
    if (!account) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "保险账户不存在" }, { status: 404 });
    }

    const entries = await loadInsuranceTransactionDetailLike({
      householdId: ctx.householdId,
      accountId,
    });
    return NextResponse.json({ ok: true, data: { entries } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取保险交易失败";
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: message }, { status: 500 });
  }
}
