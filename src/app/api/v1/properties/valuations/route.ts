/**
 * API: /api/v1/properties/valuations
 *
 * POST
 *   Body: { propertyAssetId, valuationDate, marketValue, note? }
 *   Response: { ok: true, data: { valuation, asset } }
 *
 * Manual property valuation updates affect asset value only. They do not create
 * income, expense, transfer, or investment cash-flow TxRecord rows.
 */
import { NextRequest, NextResponse } from "next/server";

import { formatDateUtc, toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { revalidateAfterInvestChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

function parseDateOnly(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T00:00:00.000Z`)
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseNonNegativeNumber(value: unknown) {
  if (value == null || value === "") return null;
  const num = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(num) && num >= 0 ? num : null;
}

export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getApiHouseholdScope(req);
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "请求体无效" }, { status: 400, headers: corsHeaders() });

    const propertyAssetId = String(body.propertyAssetId ?? "").trim();
    if (!propertyAssetId) return NextResponse.json({ ok: false, code: "MISSING_PROPERTY_ASSET", error: "缺少房产" }, { status: 400, headers: corsHeaders() });
    const valuationDate = parseDateOnly(body.valuationDate) ?? new Date();
    const marketValue = parseNonNegativeNumber(body.marketValue);
    if (marketValue == null) return NextResponse.json({ ok: false, code: "INVALID_MARKET_VALUE", error: "市值必须是不小于 0 的数字" }, { status: 400, headers: corsHeaders() });

    const result = await prisma.$transaction(async (tx) => {
      const asset = await tx.propertyAsset.findFirst({
        where: { id: propertyAssetId, householdId, deletedAt: null },
      });
      if (!asset) throw new Error("房产不存在或不属于当前账簿");
      const valuation = await tx.propertyValuation.create({
        data: {
          householdId,
          propertyAssetId,
          valuationDate,
          marketValue: String(marketValue),
          source: "manual",
          note: String(body.note ?? "").trim() || null,
        },
      });
      const updatedAsset = await tx.propertyAsset.update({
        where: { id: asset.id },
        data: {
          marketValue: String(marketValue),
          latestValuationDate: valuationDate,
        },
      });
      return { valuation, asset: updatedAsset };
    });

    revalidateAfterInvestChange();

    return NextResponse.json({
      ok: true,
      data: {
        valuation: {
          id: result.valuation.id,
          propertyAssetId: result.valuation.propertyAssetId,
          valuationDate: formatDateUtc(result.valuation.valuationDate),
          marketValue: toNumber(result.valuation.marketValue),
          note: result.valuation.note,
        },
        asset: {
          id: result.asset.id,
          accountId: result.asset.accountId,
          name: result.asset.name,
          marketValue: toNumber(result.asset.marketValue),
          latestValuationDate: result.asset.latestValuationDate ? formatDateUtc(result.asset.latestValuationDate) : null,
        },
      },
    }, { headers: corsHeaders() });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "UPDATE_FAILED", error: error instanceof Error ? error.message : "更新失败" },
      { status: 500, headers: corsHeaders() },
    );
  }
}
