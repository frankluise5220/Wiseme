/**
 * API: /api/v1/precious-metals/dictionaries
 *
 * Method:
 * - GET: queries the precious-metal types and measurement-unit dictionaries available to the current household.
 *
 * Auth: required
 * Context: server/book/user/role
 *
 * Success:
 * {
 *   ok: true,
 *   data: {
 *     types: [{ id, code, name, shortName }],
 *     units: [{ id, code, name, symbol, decimals }]
 *   }
 * }
 */
import { NextResponse } from "next/server";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { listPreciousMetalDictionaries } from "@/lib/server/precious-metals";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const data = await listPreciousMetalDictionaries(householdId);
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "获取贵金属字典失败";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
