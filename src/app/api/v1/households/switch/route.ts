import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { verifyPassword } from "@/lib/auth/password";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { HOUSEHOLD_COOKIE, USER_ID_COOKIE } from "@/lib/server/session-cookies";

/**
 * POST /api/v1/households/switch
 * Switches the active household (sets the householdId cookie).
 *
 * Body: { householdId: string, username?: string, password?: string }
 * The current system admin may switch to any household; a regular user switching to
 * another household must provide the target household admin username and password.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "未登录" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const householdId = String(body.householdId ?? "").trim();
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  if (!householdId) {
    return NextResponse.json({ ok: false, code: "MISSING_HOUSEHOLD_ID", error: "缺少 householdId" }, { status: 400 });
  }

  const exists = await prisma.household.findUnique({ where: { id: householdId } });
  if (!exists) {
    return NextResponse.json({ ok: false, code: "HOUSEHOLD_NOT_FOUND", error: "账簿不存在" }, { status: 404 });
  }

  // Permission check: the current admin can switch directly; a regular user switching to a different household must verify the target household admin credentials.
  if (!isAdmin(user) && user.householdId !== householdId) {
    if (!username || !password) {
      return NextResponse.json({ ok: false, code: "ADMIN_CREDENTIALS_REQUIRED", error: "请先输入目标账簿管理员用户名和密码" }, { status: 403 });
    }
    const namedTargetUser = await prisma.user.findFirst({
      where: { name: username, householdId, role: "admin" },
      select: { passwordHash: true },
    });
    const targetUser = namedTargetUser ?? await prisma.user.findFirst({
      where: { householdId, role: "admin" },
      select: { passwordHash: true },
    });
    if (!targetUser?.passwordHash) {
      return NextResponse.json({ ok: false, code: "TARGET_ADMIN_NOT_FOUND", error: "目标账簿管理员不存在或未设置密码" }, { status: 401 });
    }
    const matched = await verifyPassword(password, targetUser.passwordHash);
    if (!matched) {
      return NextResponse.json({ ok: false, code: "INVALID_ADMIN_PASSWORD", error: "目标账簿管理员密码错误" }, { status: 401 });
    }
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(USER_ID_COOKIE, user.id, {
    path: "/",
    maxAge: 31536000,
    httpOnly: true,
    sameSite: "lax",
  });
  res.cookies.set(HOUSEHOLD_COOKIE, householdId, {
    path: "/",
    maxAge: 31536000,
    sameSite: "lax",
  });
  return res;
}
