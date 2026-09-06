import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { logger } from "@/lib/logger";
import { getHouseholdDisplayName } from "@/lib/household-display";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import {
  HOUSEHOLD_COOKIE,
  SESSION_DAYS_COOKIE,
  USER_ID_COOKIE,
  USERNAME_COOKIE,
  VERIFIED_COOKIE,
  createVerifiedSessionValue,
  sessionCookieOptions,
} from "@/lib/server/session-cookies";
import { normalizeSessionDays, sessionDaysToMaxAge } from "@/lib/session-days";

const LEGACY_PASSWORD_KEY = "access_password";
const AUTH_LOOKUP_TIMEOUT_MS = 1500;

/**
 * Password verification for sensitive operations (system initialization,
 * ledger deletion, etc.).
 *
 * Requires the current signed-in user to be an admin and verifies that
 * user's own password; deployment-level database/system passwords
 * (MMH_SYSTEM_PASSWORD, POSTGRES_PASSWORD, etc.) are no longer accepted.
 */
async function verifySensitiveOperationPassword(
  password: string,
): Promise<{ ok: boolean; code?: string; error?: string; status?: number }> {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return { ok: false, code: "UNAUTHORIZED", error: "请先登录", status: 401 };
  }
  if (!isAdmin(currentUser)) {
    return { ok: false, code: "FORBIDDEN", error: "仅管理员可执行此操作", status: 403 };
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: currentUser.id },
    select: { passwordHash: true },
  });
  if (dbUser?.passwordHash) {
    const matched = await verifyPassword(password, dbUser.passwordHash);
    if (matched) return { ok: true };
    return { ok: false, code: "INVALID_PASSWORD", error: "当前用户密码错误", status: 401 };
  }

  // The legacy global password remains a login migration bridge only. It must
  // never authorize a sensitive operation after the user session is established.
  return { ok: false, code: "PASSWORD_NOT_SET", error: "当前用户尚未设置密码", status: 400 };
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return await Promise.race([operation.catch(() => null), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

const userSelect = {
  id: true,
  name: true,
  role: true,
  isSystem: true,
  passwordHash: true,
  householdId: true,
  Household: { select: { id: true, name: true } },
} as const;

type LoginUser = {
  id: string;
  name: string;
  role: string;
  isSystem: boolean;
  passwordHash: string | null;
  householdId: string | null;
  Household: { id: string; name: string } | null;
};

async function getUserSessionDays(userId: string) {
  try {
    const settings = await prisma.userSettings.findUnique({
      where: { userId },
      select: { sessionDays: true },
    });
    return normalizeSessionDays(settings?.sessionDays);
  } catch {
    // If a deployment has not applied this preference column yet, keep login working.
    return normalizeSessionDays(undefined);
  }
}

function householdChoicesForUsers(users: LoginUser[]) {
  const seen = new Set<string>();
  return users
    .map((user) => ({
      id: user.householdId,
      name: getHouseholdDisplayName({ id: user.householdId, name: user.Household?.name }, "未命名账簿"),
    }))
    .filter((household): household is { id: string; name: string } => {
      if (!household.id || seen.has(household.id)) return false;
      seen.add(household.id);
      return true;
    });
}

function ambiguousUsernameResponse(users: LoginUser[]) {
  return NextResponse.json(
    {
      ok: false,
      code: "AMBIGUOUS_USER",
      error: "该用户名和密码匹配多个账簿，请选择要进入的账簿",
      households: householdChoicesForUsers(users),
    },
    { status: 409 },
  );
}

async function resolveLoginCandidates(username: string, householdId: string, userId: string): Promise<LoginUser[]> {
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: userSelect,
    });
    if (!user) return [];
    if (householdId && user.householdId !== householdId) return [];
    return [user];
  }

  if (username && householdId) {
    const user = await prisma.user.findFirst({
      where: { name: username, householdId },
      select: userSelect,
    });
    return user ? [user] : [];
  }

  if (username) {
    return prisma.user.findMany({
      where: { name: username },
      select: userSelect,
      orderBy: { createdAt: "asc" },
    });
  }

  if (householdId) {
    const user = await prisma.user.findFirst({
      where: { role: "admin", householdId },
      select: userSelect,
    });
    return user ? [user] : [];
  }

  const user = await prisma.user.findFirst({
    where: { name: "admin", isSystem: true },
    select: userSelect,
  });
  return user ? [user] : [];
}

async function findPasswordMatches(users: LoginUser[], password: string) {
  const legacySetting = users.some((user) => !user.passwordHash)
    ? await withTimeout(prisma.systemSetting.findUnique({ where: { key: LEGACY_PASSWORD_KEY } }), AUTH_LOOKUP_TIMEOUT_MS)
    : null;
  const legacyPassword = legacySetting?.value ?? "";
  const matches: Array<{ user: LoginUser; migrateLegacyPassword: boolean }> = [];

  for (const user of users) {
    if (user.passwordHash) {
      const match = await verifyPassword(password, user.passwordHash);
      if (match) matches.push({ user, migrateLegacyPassword: false });
      continue;
    }
    if (legacyPassword.length > 0 && password === legacyPassword) {
      matches.push({ user, migrateLegacyPassword: true });
    }
  }

  return matches;
}

/**
 * POST /api/v1/auth/verify
 * Verify a password for login or privileged system actions.
 *
 * Body: { password: string, userId?: string, username?: string, householdId?: string, verifySystem?: boolean }
 * - verifySystem=true verifies that the current session user is an admin and that
 *   `password` matches that user's own password. It is used for sensitive
 *   operations such as system initialization and deleting ledgers, and does not
 *   create a user session. Deployment-level database/system passwords are not
 *   accepted for this verification.
 * - userId verifies that exact user. This is preferred for Web login when
 *   multiple ledgers contain same-name users such as admin.
 * - username + householdId verifies that exact user inside the target household.
 * - username only verifies all same-name users first. If exactly one household's
 *   password matches, that user logs in directly. If multiple households match
 *   the same username/password, the API returns
 *   { ok:false, code:"AMBIGUOUS_USER", error, households }.
 */
export async function POST(req: NextRequest) {
  const body = await req.json() as { password?: string; userId?: string; username?: string; householdId?: string; verifySystem?: boolean };
  const password = (body.password ?? "").trim();
  const userId = (body.userId ?? "").trim();
  const username = (body.username ?? "").trim();
  const householdId = (body.householdId ?? "").trim();

  if (!password) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "请输入密码" }, { status: 400 });
  }

  if (body.verifySystem) {
    try {
      const verified = await verifySensitiveOperationPassword(password);
      if (!verified.ok) {
        return NextResponse.json({ ok: false, code: "AUTH_VERIFICATION_FAILED", error: verified.error }, { status: verified.status });
      }
      return NextResponse.json({ ok: true, systemVerified: true });
    } catch {
      return NextResponse.json({ ok: false, code: "SYSTEM_CONFIG_ERROR", error: "系统配置错误" }, { status: 500 });
    }
  }

  const candidates = await withTimeout(resolveLoginCandidates(username, householdId, userId), AUTH_LOOKUP_TIMEOUT_MS);
  if (!candidates) {
    return NextResponse.json({ ok: false, code: "AUTH_SERVICE_UNAVAILABLE", error: "认证服务暂时不可用，请稍后重试" }, { status: 503 });
  }

  if (candidates.length === 0) {
    const anyUser = await prisma.user.findFirst({ select: { id: true } });
    if (!anyUser) {
      return NextResponse.json({ ok: false, code: "ADMIN_PASSWORD_NOT_SET", error: "请先设置管理员密码" }, { status: 400 });
    }
    return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "用户不存在" }, { status: 401 });
  }

  const matches = await findPasswordMatches(candidates, password);
  if (matches.length === 0) {
    if (candidates.some((user) => !user.passwordHash)) {
      const hasAnyPassword = candidates.some((user) => user.passwordHash);
      if (!hasAnyPassword) return NextResponse.json({ ok: false, code: "PASSWORD_NOT_SET", error: "请先设置密码" }, { status: 400 });
    }
    return NextResponse.json({ ok: false, code: "INVALID_PASSWORD", error: "密码错误" }, { status: 401 });
  }
  if (matches.length > 1 && !householdId) {
    return ambiguousUsernameResponse(matches.map((match) => match.user));
  }

  const { user, migrateLegacyPassword } = matches[0];
  if (migrateLegacyPassword) {
    const hashed = await hashPassword(password);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: hashed },
    });
    await prisma.systemSetting.delete({ where: { key: LEGACY_PASSWORD_KEY } }).catch(logger.catchLog("删除旧密码失败", "route.ts"));
  }

  const response = NextResponse.json({ ok: true, username: user.name, householdId: user.householdId });
  const sessionDays = await getUserSessionDays(user.id);
  const maxAge = sessionDaysToMaxAge(sessionDays);
  const cookieOptions = sessionCookieOptions(maxAge, req);
  response.cookies.set(VERIFIED_COOKIE, createVerifiedSessionValue(user.id, maxAge), cookieOptions);
  response.cookies.set(USER_ID_COOKIE, user.id, cookieOptions);
  response.cookies.set(USERNAME_COOKIE, user.name, cookieOptions);
  response.cookies.set(SESSION_DAYS_COOKIE, String(sessionDays), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  if (user.householdId) {
    response.cookies.set(HOUSEHOLD_COOKIE, user.householdId, cookieOptions);
  }
  return response;
}
