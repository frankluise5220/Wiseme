import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

/**
 * GET /api/v1/fund/confirm-days/institution-accounts
 *
 * Query params:
 * - accountId: required. The source investment account.
 *
 * Returns investment accounts sharing the same institution as the source
 * account (plus the source account itself). Each entry includes the fund codes
 * seen in transactions for that account, so the client-side "apply to
 * institution funds" picker can show what would be affected.
 *
 * Success: { ok: true, accounts: [{ id, name, institutionId, institutionName, fundCodes }] }
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId")?.trim();

  if (!accountId) {
    return NextResponse.json({ ok: false, code: "MISSING_ACCOUNT_ID", error: "accountId is required." }, { status: 400 });
  }

  try {
    const ctx = await getHouseholdScope();
    const source = await prisma.account.findUnique({
      where: { id: accountId, ...ctx.hidFilter },
      select: { id: true, institutionId: true },
    });
    if (!source) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Investment account not found." }, { status: 404 });
    }

    // Same-institution investment accounts. Accounts without an institution
    // only match themselves.
    const where: Record<string, unknown> = { ...ctx.hidFilter, kind: "investment" };
    if (source.institutionId) {
      where.institutionId = source.institutionId;
    } else {
      where.id = source.id;
    }
    const accounts = await prisma.account.findMany({
      where,
      select: { id: true, name: true, institutionId: true, Institution: { select: { name: true } } },
      orderBy: { name: "asc" },
    });

    const fundCodesByAccountId = new Map<string, string[]>();
    if (accounts.length > 0) {
      const txRows = await prisma.fundTransaction.findMany({
        where: { householdId: ctx.householdId, fundAccountId: { in: accounts.map((account) => account.id) }, deletedAt: null, fundCode: { not: undefined } },
        select: { fundAccountId: true, fundCode: true },
        distinct: ["fundAccountId", "fundCode"],
        take: 50000,
      });
      for (const row of txRows) {
        const list = fundCodesByAccountId.get(row.fundAccountId) ?? [];
        list.push(row.fundCode as string);
        fundCodesByAccountId.set(row.fundAccountId, list);
      }
    }

    return NextResponse.json({
      ok: true,
      accounts: accounts.map((account) => ({
        id: account.id,
        name: account.name,
        institutionId: account.institutionId,
        institutionName: account.Institution?.name ?? null,
        fundCodes: (fundCodesByAccountId.get(account.id) ?? []).sort(),
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: e instanceof Error ? e.message : "Failed to fetch institution accounts." },
      { status: 500 }
    );
  }
}
