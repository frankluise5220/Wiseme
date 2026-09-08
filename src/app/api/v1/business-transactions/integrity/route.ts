/**
 * API: /api/v1/business-transactions/integrity
 *
 * GET
 *   Checks consistency between the legacy TxRecord investment/insurance/wealth/deposit/precious-metals
 *   business fields and the standalone business transaction tables plus EntryBusinessLink.
 *
 * POST JSON body { limit?: number }
 *   Uses the existing sync logic to backfill missing standalone business transactions and links.
 *
 * Responses:
 *   GET  { ok: true, data: { ok, summary, issueCount, issues } }
 *   POST { ok: true, data: { attempted, before, after } }
 */
import { NextResponse } from "next/server";

import {
  auditBusinessTransactionIntegrity,
  repairBusinessTransactionIntegrity,
} from "@/lib/server/business-transaction-integrity";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

function normalizeLimit(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 5000;
  return Math.min(Math.round(n), 20_000);
}

export async function GET() {
  try {
    const { householdId } = await getHouseholdScope();
    const data = await auditBusinessTransactionIntegrity(householdId);
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error("GET /api/v1/business-transactions/integrity error:", error);
    return NextResponse.json(
      { ok: false, code: "INTEGRITY_CHECK_FAILED", error: error instanceof Error ? error.message : "检查失败" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const data = await repairBusinessTransactionIntegrity(householdId, normalizeLimit(body?.limit));
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    console.error("POST /api/v1/business-transactions/integrity error:", error);
    return NextResponse.json(
      { ok: false, code: "INTEGRITY_REPAIR_FAILED", error: error instanceof Error ? error.message : "修复失败" },
      { status: 500 },
    );
  }
}
