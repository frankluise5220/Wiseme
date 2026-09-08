import { NextResponse } from "next/server";
import { z } from "zod";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { writeImportDebugLog } from "@/lib/server/import-debug-log";

/**
 * POST /api/v1/debug/import-log
 * Development-only authenticated diagnostics for the browser-side import flow.
 * Body: { traceId, event, details } with scalar, non-sensitive details only.
 */
const BodySchema = z.object({
  traceId: z.string().trim().min(1).max(80),
  event: z.string().trim().min(1).max(80),
  details: z.record(
    z.string().trim().min(1).max(80),
    z.union([z.string().max(160), z.number().finite(), z.boolean(), z.null()]),
  ).default({}),
});

export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return new NextResponse(null, { status: 404 });
  }

  try {
    const scope = await getHouseholdScope();
    const parsed = BodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ ok: false, code: "INVALID_LOG_PARAMS", error: "日志参数不正确" }, { status: 400 });
    }

    await writeImportDebugLog({
      traceId: parsed.data.traceId,
      event: parsed.data.event,
      householdId: scope.householdId,
      userId: scope.user?.id ?? null,
      details: parsed.data.details,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "日志写入失败";
    return NextResponse.json({ ok: false, code: "LOG_WRITE_FAILED", error: message }, { status: 500 });
  }
}
