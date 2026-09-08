import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
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

  const investAccounts = await prisma.account.findMany({ where: { kind: "investment" } });
  const investIds = investAccounts.map(a => a.id);
  const entries = await prisma.txRecord.findMany({
    where: { accountId: { in: investIds }, deletedAt: null },
    orderBy: [{ date: "asc" }, { createdAt: "asc" }],
  });
  const codes = [...new Set(entries.map(e => e.fundCode).filter(Boolean))] as string[];

  const allNavCaches = codes.length > 0
    ? await prisma.fundNavCache.findMany({ where: { fundCode: { in: codes } }, orderBy: { navDate: "asc" } })
    : [];
  const latestNavByCode = new Map<string, { date: string; nav: number }>();
  for (const c of allNavCaches) {
    if (!latestNavByCode.has(c.fundCode)) {
      latestNavByCode.set(c.fundCode, { date: c.navDate.toISOString(), nav: toNumber(c.nav) });
    }
  }

  let totalUnits = 0;
  let totalPendingCost = 0;
  for (const e of entries) {
    const amt = toNumber(e.amount);
    const entryUnits = e.fundUnits != null ? toNumber(e.fundUnits) : null;
    const isBuy = amt < 0;
    const isPending = isBuy && (entryUnits == null || entryUnits <= 0);
    if (isBuy) {
      if (isPending) {
        totalPendingCost += Math.abs(amt);
      } else {
        if (entryUnits != null) totalUnits += entryUnits;
      }
    } else {
      if (entryUnits != null) totalUnits -= entryUnits;
    }
  }

  const parts: string[] = [];
  for (const [code, info] of latestNavByCode) {
    const mv = info.nav > 0 && totalUnits > 0 ? (totalUnits * info.nav).toFixed(4) : "n/a";
    parts.push(`${code} | latest_nav=${info.nav} | date=${info.date.slice(0,10)} | total_units=${totalUnits.toFixed(4)} | confirmed_mv=${mv} | pending=${totalPendingCost.toFixed(2)}`);
  }

  const all = allNavCaches.map(c => `${c.fundCode} ${c.navDate.toISOString().slice(0,10)} ${toNumber(c.nav)}`);

  return new NextResponse(
    "=== latest nav per code ===\n" + parts.join("\n") +
    "\n=== all nav records ===\n" + all.join("\n") +
    "\n=== entries summary ===\n" +
    entries.map(e => `${e.fundCode} amt=${e.amount} units=${e.fundUnits} nav=${e.fundNav} confirm=${e.fundConfirmDate}`).join("\n"),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );
}