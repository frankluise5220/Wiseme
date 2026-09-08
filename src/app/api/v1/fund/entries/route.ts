import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { signedFundAmount } from "@/lib/fund/transactions";

export async function GET(req: NextRequest) {
  const { hidFilter } = await getHouseholdScope();
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId")?.trim();
  const fundCode = searchParams.get("fundCode")?.trim();
  const subtype = searchParams.get("subtype")?.trim();

  if (!accountId || !fundCode) {
    return NextResponse.json({ ok: false, code: "MISSING_PARAMS", error: "缺少参数" }, { status: 400 });
  }

  try {
    const entries = await prisma.fundTransaction.findMany({
      where: {
        ...hidFilter,
        fundAccountId: accountId,
        fundCode,
        source: subtype || "regular_invest",
        deletedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });

    const result = entries.map((e) => {
      return {
        id: e.id,
        date: e.applyDate.toISOString().slice(0, 10),
        fundCode: e.fundCode,
        fundName: e.fundName,
        amount: String(signedFundAmount(e)),
        fundNav: e.nav ? String(e.nav) : null,
        fundUnits: e.units ? String(e.units) : null,
        fundConfirmDate: e.confirmDate ? e.confirmDate.toISOString().slice(0, 10) : null,
      };
    });

    return NextResponse.json({ ok: true, entries: result });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: e instanceof Error ? e.message : "查询失败" }, { status: 500 });
  }
}
