import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * POST /api/v1/cleanup/dividend-cash
 * Cleans up legacy duplicate cash-dividend records:
 * 1. Deletes duplicate type=income records whose note starts with the cash-dividend text
 * 2. Fixes legacy investment records with fundSubtype=dividend_cash and amount<0 (rewrites them to the new direction)
 */
export async function POST() {
  const { hidFilter } = await getHouseholdScope();
  const results = { deletedIncome: 0, fixedInvestment: 0, errors: [] as string[] };

  try {
    // 1. Delete duplicate income records
    const incomeRecords = await prisma.txRecord.findMany({
      where: {
        type: "income",
        note: { startsWith: "现金红利" },
        deletedAt: null,
        ...hidFilter,
      },
      select: { id: true },
    });

    if (incomeRecords.length > 0) {
      await prisma.txRecord.deleteMany({
        where: { id: { in: incomeRecords.map(r => r.id) } },
      });
      results.deletedIncome = incomeRecords.length;
    }

    // 2. Fix legacy dividend_cash investment records: amount<0 means the old direction (accountId=cash)
    const oldRecords = await prisma.txRecord.findMany({
      where: {
        fundSubtype: "dividend_cash",
        amount: { lt: 0 },
        deletedAt: null,
        ...hidFilter,
      },
      select: { id: true, accountId: true, toAccountId: true, amount: true },
    });

    for (const rec of oldRecords) {
      const oldAmount = toNumber(rec.amount);
      const newAmount = Math.abs(oldAmount);
      // Old record: accountId=cash account, toAccountId=investment account, negative amount
      // New record: accountId=investment account, toAccountId=cash account, positive amount
      await prisma.txRecord.update({
        where: { id: rec.id },
        data: {
          accountId: rec.toAccountId!,  // swap: investment account becomes accountId
          toAccountId: rec.accountId,   // cash account becomes toAccountId
          amount: newAmount,
        },
      });
      results.fixedInvestment++;
    }

    return NextResponse.json({ ok: true, ...results });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "清理失败" }, { status: 500 });
  }
}
