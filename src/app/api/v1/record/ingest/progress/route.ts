import { NextResponse } from "next/server";
import { getImportProgress } from "@/lib/server/import-progress";

/**
 * GET /api/v1/record/ingest/progress?traceId=...
 * Returns the in-process progress snapshot for a long-running batch import:
 * { ok: true, progress: { phase, processed, total, created, done, ok, error, failedRow } | null }.
 */
export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
    "Cache-Control": "no-store",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const traceId = url.searchParams.get("traceId");
  if (!traceId) {
    return NextResponse.json({ ok: false, error: "缺少 traceId" }, { status: 400, headers: corsHeaders() });
  }
  return NextResponse.json(
    { ok: true, progress: getImportProgress(traceId) },
    { headers: corsHeaders() },
  );
}
