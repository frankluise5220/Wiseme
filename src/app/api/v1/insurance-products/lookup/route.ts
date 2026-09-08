import { NextRequest, NextResponse } from "next/server";

import { lookupInsuranceProductByName } from "@/lib/insurance/productLookup";

/**
 * GET /api/v1/insurance-products/lookup?name=...&institutionName=...
 *
 * Looks up public reference information for an insurance product name.
 * Query:
 * - name: insurance product name, preferably the exact official product name.
 * - institutionName: optional insurer/institution name used to narrow lookup.
 *
 * Success:
 * { ok: true, data: { query, institutionName, candidates, officialSources, suggestion, searchedAt, ...debugReferences } }
 *
 * Error:
 * { ok: false, error }
 *
 * Notes:
 * - Client UI should present candidates as selectable product rows, not raw search/crawl snippets.
 * - This endpoint tries the public industry product list first, then crawls public result pages as fallback.
 * - It does not bypass CAPTCHA, login gates, robots protections, or non-public data controls.
 * - Raw webResults/crawledPages are retained only as reference/debug material.
 * - It does not sell insurance, verify eligibility, or treat external snippets as source-of-truth.
 */
export async function GET(req: NextRequest) {
  try {
    const name = String(req.nextUrl.searchParams.get("name") ?? "").trim();
    if (!name) {
      return NextResponse.json({ ok: false, code: "MISSING_PRODUCT_NAME", error: "请提供保险产品名称" }, { status: 400 });
    }
    if (name.length > 120) {
      return NextResponse.json({ ok: false, code: "PRODUCT_NAME_TOO_LONG", error: "保险产品名称过长" }, { status: 400 });
    }

    const institutionName = String(req.nextUrl.searchParams.get("institutionName") ?? "").trim() || null;
    const data = await lookupInsuranceProductByName(name, { institutionName });
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "查询保险产品资料失败";
    return NextResponse.json({ ok: false, code: "LOOKUP_FAILED", error: message }, { status: 500 });
  }
}
