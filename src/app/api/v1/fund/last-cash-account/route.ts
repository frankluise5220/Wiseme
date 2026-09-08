import { NextRequest, NextResponse } from "next/server";
import { FundSubtype } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * GET /api/v1/fund/last-cash-account
 * Query params: accountId=<investment account id>&fundCode=<optional fund code>
 * Returns the preferred cash account for a new fund transaction, prioritizing
 * recent buy-side cash accounts for the same fund before generic last-used fallbacks.
 */
export async function GET(req: NextRequest) {
  const { hidFilter } = await getHouseholdScope();
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId")?.trim();
  const fundCode = searchParams.get("fundCode")?.trim();

  if (!accountId) return NextResponse.json({ ok: false });

  const baseWhere = {
    OR: [{ toAccountId: accountId }, { accountId: accountId }],
    fundProductType: { not: null },
    deletedAt: null,
  };
  const where = fundCode
    ? { ...baseWhere, fundCode }
    : baseWhere;

  const preferredBuy = await prisma.txRecord.findFirst({
    where: {
      ...hidFilter,
      AND: [
        where,
        {
          OR: [
            { fundSubtype: FundSubtype.buy },
            { fundSubtype: FundSubtype.buy_failed, source: { not: "regular_invest_refund" } },
            { fundSubtype: FundSubtype.switch_in },
          ],
        },
      ],
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    select: { accountId: true },
  });

  if (preferredBuy?.accountId) {
    return NextResponse.json({ ok: true, cashAccountId: preferredBuy.accountId, source: "recent_buy" });
  }

  const last = await prisma.txRecord.findFirst({
    where: { ...where, ...hidFilter },
    orderBy: { createdAt: "desc" },
    select: { accountId: true, toAccountId: true, fundSubtype: true },
  });

  // For buy records: accountId = cashAccount, toAccountId = investAccount
  // For redeem/switch_out records: accountId = investAccount, toAccountId = cashAccount
  // Determine cashAccountId based on fundSubtype
  let cashAccountId: string | null = null;
  if (last) {
    if (last.fundSubtype === "redeem" || last.fundSubtype === "switch_out") {
      cashAccountId = last.toAccountId;
    } else {
      cashAccountId = last.accountId;
    }
  }

  if (cashAccountId) {
    return NextResponse.json({ ok: true, cashAccountId, source: "last_used" });
  }

  const investAccount = await prisma.account.findUnique({
    where: { id: accountId },
    select: { institutionId: true },
  });

  if (investAccount?.institutionId) {
    const sameDebit = await prisma.account.findFirst({
      where: {
        institutionId: investAccount.institutionId,
        kind: "bank_debit",
        isActive: true,
        ...hidFilter,
      },
      orderBy: { name: "asc" },
      select: { id: true },
    });
    if (sameDebit) {
      return NextResponse.json({ ok: true, cashAccountId: sameDebit.id, source: "same_institution" });
    }

    const sameCash = await prisma.account.findFirst({
      where: {
        institutionId: investAccount.institutionId,
        kind: { in: ["cash", "ewallet"] },
        isActive: true,
        ...hidFilter,
      },
      orderBy: { name: "asc" },
      select: { id: true },
    });
    if (sameCash) {
      return NextResponse.json({ ok: true, cashAccountId: sameCash.id, source: "same_institution" });
    }
  }

  return NextResponse.json({ ok: true, cashAccountId: null, source: "none" });
}
