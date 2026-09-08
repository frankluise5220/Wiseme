import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { AccountKind } from "@prisma/client";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { getHouseholdScope } from "@/lib/server/household-scope";

export async function POST(req: NextRequest) {
  try {
    const { hidFilter } = await getHouseholdScope();
    const body = await req.json();
    const accountIdParam = String(body.accountId ?? "all").trim();

    let accountIds: string[] = [];

    if (accountIdParam === "all") {
      const accounts = await prisma.account.findMany({
        where: { kind: AccountKind.investment, isActive: true, ...hidFilter },
        select: { id: true },
      });
      accountIds = accounts.map(a => a.id);
    } else {
      accountIds = [accountIdParam];
    }

    if (accountIds.length === 0) {
      return NextResponse.json({ ok: true, synced: 0, message: "没有投资账户" });
    }

    let syncedCount = 0;

    for (const accountId of accountIds) {
      const entries = await prisma.txRecord.count({
        where: { OR: [{ toAccountId: accountId }, { accountId: accountId }], fundProductType: { not: null }, deletedAt: null },
      });
      if (entries === 0) continue;

      await recalcFundPositions(accountId);

      const holdings = await prisma.fundHolding.count({ where: { accountId } });
      syncedCount += holdings;
    }

    // Client-side handles page refresh
    return NextResponse.json({
      ok: true,
      synced: syncedCount,
      message: `已重新汇总 ${syncedCount} 支基金`,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "同步失败";
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}