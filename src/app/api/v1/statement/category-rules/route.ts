/**
 * GET /api/v1/statement/category-rules
 *
 * Returns system-default and learned statement category samples for the current household.
 * Response: { ok: true, samples: Array<{ type, categoryName, counterpartyInstitutionName, paymentChannelName, normalizedText, weight, source, matchText, note }> }
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadStatementCategoryRuleSamples } from "@/lib/statement/category-rules";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { householdId } = await getHouseholdScope();
    const samples = await loadStatementCategoryRuleSamples(prisma, householdId);
    return NextResponse.json({ ok: true, samples });
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取分类学习规则失败";
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: message }, { status: 500 });
  }
}
