import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { AccountKind } from "@prisma/client";
import { toNumber } from "@/lib/date-utils";
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

  const accounts = await prisma.account.findMany({
    where: { kind: AccountKind.investment },
    select: { id: true, name: true },
  });

  const investIds = accounts.map(a => a.id);
  if (investIds.length === 0) return NextResponse.json({ accounts: [], entries: [] });

  const entries = await prisma.txRecord.findMany({
    where: { accountId: { in: investIds }, deletedAt: null },
  });

  const debug = accounts.map(a => {
    const acctEntries = entries.filter(e => e.accountId === a.id);
    let balance = 0;
    const txList: string[] = [];
    for (const e of acctEntries) {
      const amt = toNumber(e.amount);
      const isBuy = amt < 0;
      const units = e.fundUnits != null ? toNumber(e.fundUnits) : 0;
      const isPending = isBuy && units <= 0;
      const isConfirmed = isBuy && !isPending;
      if (isConfirmed) {
        const nav = e.fundNav != null ? toNumber(e.fundNav) : 0;
        const mv = units > 0 && nav > 0 ? units * nav : Math.abs(amt);
        balance += mv;
        txList.push(`CONFIRMED amt=${amt} units=${units} nav=${nav} => mv=${mv.toFixed(2)}`);
      } else if (isPending) {
        balance += Math.abs(amt);
        txList.push(`PENDING amt=${amt} => cost=${Math.abs(amt)}`);
      }
    }
    return { accountId: a.id, accountName: a.name, balance: balance.toFixed(2), txCount: acctEntries.length, txs: txList };
  });

  return NextResponse.json({ debug });
}