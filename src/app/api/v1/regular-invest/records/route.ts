import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export async function GET(req: NextRequest) {
  const { hidFilter } = await getHouseholdScope();
  const planId = req.nextUrl.searchParams.get("planId");
  if (!planId) return NextResponse.json({ ok: false, code: "MISSING_PLAN_ID", error: "缺少 planId" }, { status: 400 });

  const records = await prisma.txRecord.findMany({
    where: {
      ...hidFilter,
      regularInvestPlanId: planId,
      deletedAt: null,
    },
    select: {
      id: true,
      type: true,
      source: true,
      date: true,
      amount: true,
      accountId: true,
      accountName: true,
      toAccountId: true,
      toAccountName: true,
      note: true,
      toNote: true,
      categoryId: true,
      fundProductType: true,
      insuranceProductId: true,
      fundUnits: true,
      fundConfirmDate: true,
    },
    orderBy: { date: "asc" },
  });

  return NextResponse.json({ ok: true, records });
}
