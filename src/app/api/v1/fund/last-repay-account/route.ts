import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export async function GET(req: NextRequest) {
  const { hidFilter } = await getHouseholdScope();
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId")?.trim();

  if (!accountId) return NextResponse.json({ ok: false });

  const lastRepay = await prisma.txRecord.findFirst({
    where: {
      accountId,
      amount: { gt: 0 },
      type: "transfer",
      deletedAt: null,
    },
    orderBy: { date: "desc" },
    select: { toAccountId: true },
  });

  if (lastRepay?.toAccountId) {
    return NextResponse.json({ ok: true, repayAccountId: lastRepay.toAccountId, source: "last_used" });
  }

  const creditCard = await prisma.account.findUnique({
    where: { id: accountId },
    select: { institutionId: true },
  });

  if (creditCard?.institutionId) {
    const sameDebit = await prisma.account.findFirst({
      where: {
        institutionId: creditCard.institutionId,
        kind: { in: ["bank_debit", "cash", "ewallet"] },
        isActive: true,
        ...hidFilter,
      },
      orderBy: [
        { kind: "asc" },
        { name: "asc" },
      ],
      select: { id: true },
    });
    if (sameDebit) {
      return NextResponse.json({ ok: true, repayAccountId: sameDebit.id, source: "same_institution" });
    }
  }

  const anyDebit = await prisma.account.findFirst({
    where: {
      kind: { in: ["bank_debit", "cash", "ewallet"] },
      isActive: true,
      ...hidFilter,
    },
    orderBy: { name: "asc" },
    select: { id: true },
  });

  if (anyDebit) {
    return NextResponse.json({ ok: true, repayAccountId: anyDebit.id, source: "first_available" });
  }

  return NextResponse.json({ ok: true, repayAccountId: null, source: "none" });
}