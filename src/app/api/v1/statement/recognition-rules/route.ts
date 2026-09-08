/**
 * GET /api/v1/statement/recognition-rules
 *
 * Returns table-backed statement recognition samples for the current household.
 * The sample list includes generic keyword rules for categories/institutions,
 * exact source-header aliases for import fields, plus learned category
 * corrections from saved transaction edits.
 *
 * Response:
 *   { ok: true, samples: Array<{ targetType, fieldName, type, categoryName, institutionName, matchText, normalizedText, priority, weight, source, note }> }
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadStatementRecognitionRuleSamples } from "@/lib/statement/recognition-rules";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { householdId } = await getHouseholdScope();
    const samples = await loadStatementRecognitionRuleSamples(prisma, householdId);
    return NextResponse.json({ ok: true, samples });
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取账单识别规则失败";
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: message }, { status: 500 });
  }
}
