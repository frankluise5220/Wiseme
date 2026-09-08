import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { TransactionType, AccountKind } from "@prisma/client";
import { NextResponse } from "next/server";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

/** Debug export endpoint returning raw investment data across households; admin only. */
async function requireAdmin(): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 }) };
  }
  if (!isAdmin(user)) {
    return { ok: false, response: NextResponse.json({ ok: false, code: "FORBIDDEN", error: "仅管理员可操作" }, { status: 403 }) };
  }
  return { ok: true };
}

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const investAccounts = await prisma.account.findMany({
    where: { kind: AccountKind.investment },
  });

  const investIds = investAccounts.map(a => a.id);
  const entries = await prisma.txRecord.findMany({
    where: {
      accountId: { in: investIds },
      type: TransactionType.investment, deletedAt: null,
    },
    include: { account: true },
    orderBy: [{ date: "asc" }],
  });

  const detail = investAccounts.map(a => {
    const acctEntries = entries.filter(e => e.accountId === a.id);
    let balance = 0;
    const lines: string[] = [];
    for (const e of acctEntries) {
      const amt = toNumber(e.amount);
      const isBuy = amt < 0;
      const units = e.fundUnits != null ? toNumber(e.fundUnits) : 0;
      const isPending = isBuy && units <= 0;
      const isConfirmed = isBuy && !isPending;
      if (isConfirmed) {
        const nav = e.fundNav != null ? toNumber(e.fundNav) : null;
        const mv = units > 0 && nav !== null && nav > 0
          ? units * nav
          : Math.abs(amt);
        balance += mv;
        lines.push(`CONFIRMED amt=${amt} units=${units} nav=${nav} => mv=${mv.toFixed(2)}, balance=${balance.toFixed(2)}`);
      } else if (isPending) {
        balance += Math.abs(amt);
        lines.push(`PENDING amt=${amt} => +${Math.abs(amt)}, balance=${balance.toFixed(2)}`);
      } else {
        lines.push(`OTHER amt=${amt} (ignored in balance)`);
      }
    }
    return { accountId: a.id, accountName: a.name, balance: balance.toFixed(2), lines };
  });

  return NextResponse.json({ detail });
}