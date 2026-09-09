/**
 * GET /api/v1/accounts/credit-card-defaults?institutionId=...
 *
 * Returns `{ ok: true, data: { billingDay, repaymentDay, creditLimit, creditBillMode, billingDayTxPeriod } | null }`.
 * Values come from the most complete active credit card in the current household and institution.
 */
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getCreditCardInstitutionDefaults } from "@/lib/server/credit-card-institution-settings";
import { getHouseholdScope } from "@/lib/server/household-scope";

export async function GET(request: Request) {
  const institutionId = new URL(request.url).searchParams.get("institutionId")?.trim() ?? "";
  if (!institutionId) {
    return NextResponse.json({ ok: false, code: "MISSING_INSTITUTION_ID", error: "缺少机构 ID" }, { status: 400 });
  }
  const { householdId } = await getHouseholdScope();
  const data = await getCreditCardInstitutionDefaults(prisma, householdId, institutionId);
  return NextResponse.json({ ok: true, data });
}
