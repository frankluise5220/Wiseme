import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * Recalculates and writes back balances for all active accounts in the current household.
 * POST /api/v1/accounts/recalc-balances
 */
export async function POST() {
  try {
    const { hidFilter } = await getHouseholdScope();
    const accounts = await prisma.account.findMany({
      where: { ...hidFilter, isActive: true },
      select: { id: true, name: true, kind: true, balance: true },
    });

    for (const a of accounts) {
      await recalcAndSaveAccountBalance(a.id);
    }

    // Return updated balances for verification
    const updated = await prisma.account.findMany({
      where: { ...hidFilter, isActive: true },
      select: { id: true, name: true, kind: true, balance: true },
    });

    return NextResponse.json({ ok: true, updated });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "INTERNAL_ERROR", error: e instanceof Error ? e.message : "重算失败" },
      { status: 500 },
    );
  }
}