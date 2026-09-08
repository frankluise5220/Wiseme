import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { toNumber } from "@/lib/date-utils";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

/** Debug export endpoint; admin only. */
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

  const caches = await prisma.fundNavCache.findMany({
    orderBy: [{ fundCode: "asc" }, { navDate: "asc" }],
  });
  return NextResponse.json({
    count: caches.length,
    records: caches.map(c => ({
      fundCode: c.fundCode,
      navDate: c.navDate.toISOString(),
      nav: toNumber(c.nav),
    })),
  });
}