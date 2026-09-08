import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";

/**
 * Query / update fund holdings.
 *
 * GET ?accountId=string&fundCode=string
 *   accountId and fundCode are the unique key of the `fundHolding` table
 *   Returns { ok: true, exists, units, avgCost, cost, historicalProfit, nav, fundName }
 *   When the record is not found, returns { ok: false, error }
 *
 * POST { accountId: string, fundCode: string, nav: number }
 *   accountId and fundCode are the unique key of the `fundHolding` table
 *   Returns { ok: true, ... } or { ok: false, error }
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const accountId = String(searchParams.get("accountId") ?? "").trim();
    const fundCode = String(searchParams.get("fundCode") ?? "").trim();

    if (!accountId || !fundCode) {
      return NextResponse.json({ ok: false, code: "MISSING_PARAMS", error: "缺少 accountId 或 fundCode" }, { status: 400 });
    }

    const holding = await prisma.fundHolding.findUnique({
      where: { accountId_fundCode: { accountId, fundCode } },
    });

    if (!holding) {
      return NextResponse.json({ ok: false, code: "HOLDING_NOT_FOUND", error: "持仓记录不存在" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      exists: true,
      fundName: holding.fundName ?? "",
      nav: Number(holding.nav ?? 0),
      units: Number(holding.units ?? 0),
      avgCost: Number(holding.avgCost ?? 0),
      cost: Number(holding.cost ?? 0),
      historicalProfit: Number(holding.historicalProfit ?? 0),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "QUERY_FAILED", error: e instanceof Error ? e.message : "查询失败" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const accountId = String(body.accountId ?? "").trim();
    const fundCode = String(body.fundCode ?? "").trim();
    const nav = parseFloat(body.nav);

    if (!accountId || !fundCode || !Number.isFinite(nav) || nav <= 0) {
      return NextResponse.json({ ok: false, code: "INVALID_PARAMS", error: "参数不正确" }, { status: 400 });
    }

    const existing = await prisma.fundHolding.findUnique({
      where: { accountId_fundCode: { accountId, fundCode } },
    });
    if (!existing) {
      return NextResponse.json({ ok: false, code: "HOLDING_NOT_FOUND", error: "持仓记录不存在" }, { status: 404 });
    }

    await prisma.fundHolding.update({
      where: { accountId_fundCode: { accountId, fundCode } },
      data: { nav },
    });

    await recalcFundPositions(accountId, [fundCode]);

    const holding = await prisma.fundHolding.findUnique({
      where: { accountId_fundCode: { accountId, fundCode } },
    });

    // Client-side handles page refresh
    return NextResponse.json({
      ok: true,
      nav,
      units: holding ? Number(holding.units) : 0,
      avgCost: holding ? Number(holding.avgCost) : 0,
      cost: holding ? Number(holding.cost) : 0,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "UPDATE_FAILED", error: e instanceof Error ? e.message : "更新失败" },
      { status: 500 }
    );
  }
}