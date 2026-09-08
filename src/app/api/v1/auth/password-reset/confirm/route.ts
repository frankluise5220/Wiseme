import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/lib/db/prisma";
import { hashPassword } from "@/lib/auth/password";
import { getHouseholdDisplayName } from "@/lib/household-display";

export const runtime = "nodejs";

// Brute-force protection for the code verification endpoint: limit attempts per IP (the code is valid for 15 minutes; use the same window).
const RESET_ATTEMPT_LIMIT = 10;
const RESET_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

declare global {
  var __passwordResetConfirmAttempts: Map<string, number[]> | undefined;
}

const resetConfirmAttempts = globalThis.__passwordResetConfirmAttempts ??= new Map<string, number[]>();

function getClientIp(req: NextRequest) {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() || null;
  const xr = req.headers.get("x-real-ip");
  if (xr) return xr.trim() || null;
  return null;
}

function isResetAttemptLimited(ip: string): boolean {
  const now = Date.now();
  const windowStart = now - RESET_ATTEMPT_WINDOW_MS;
  const recent = (resetConfirmAttempts.get(ip) ?? []).filter((ts) => ts > windowStart);
  resetConfirmAttempts.set(ip, recent);
  return recent.length >= RESET_ATTEMPT_LIMIT;
}

function recordResetAttempt(ip: string) {
  const now = Date.now();
  const windowStart = now - RESET_ATTEMPT_WINDOW_MS;
  const recent = (resetConfirmAttempts.get(ip) ?? []).filter((ts) => ts > windowStart);
  recent.push(now);
  resetConfirmAttempts.set(ip, recent);
}

const BodySchema = z.object({
  username: z.string().min(1).max(80),
  code: z.string().min(4).max(20),
  newPassword: z.string().min(6).max(200),
  householdId: z.string().min(1).optional(),
});

type ResetUser = {
  id: string;
  name: string;
  householdId: string | null;
  Household: { id: string; name: string } | null;
};

function householdChoicesForUsers(users: ResetUser[]) {
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

async function findCandidateUsers(params: { username: string; householdId?: string | null }) {
  const username = params.username.trim();
  if (!username) return [];

  const users = await prisma.user.findMany({
    where: { name: username },
    select: { id: true, name: true, householdId: true, Household: { select: { id: true, name: true } } },
  });

  if (users.length === 0) return [];

  const byCookie = params.householdId
    ? users.find((u) => u.householdId === params.householdId) ?? null
    : null;
  if (byCookie) return [byCookie];

  if (users.length === 1) return users;

  return users;
}

function hashCode(params: { userId: string; code: string }) {
  const secret = (process.env.PASSWORD_RESET_SECRET ?? "").trim();
  if (!secret) return null;
  return crypto.createHash("sha256").update(`${secret}:${params.userId}:${params.code}`).digest("hex");
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (ip && isResetAttemptLimited(ip)) {
    return NextResponse.json({ ok: false, code: "RATE_LIMITED", error: "尝试次数过多，请稍后再试" }, { status: 429 });
  }
  recordResetAttempt(ip ?? "unknown");

  const body = (await req.json().catch(() => null)) as unknown;
  const parse = BodySchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "INVALID_PARAMS", error: "参数不正确" }, { status: 400 });
  }

  const secret = (process.env.PASSWORD_RESET_SECRET ?? "").trim();
  if (!secret) {
    return NextResponse.json({ ok: false, code: "PASSWORD_RESET_NOT_CONFIGURED", error: "未配置密码找回功能" }, { status: 500 });
  }

  const { username, code, newPassword, householdId } = parse.data;
  const cookieHouseholdId = householdId ?? req.cookies.get("householdId")?.value ?? null;
  const users = await findCandidateUsers({ username, householdId: cookieHouseholdId });
  if (users.length === 0) {
    return NextResponse.json({ ok: false, code: "INVALID_OR_EXPIRED_CODE", error: "验证码无效或已过期" }, { status: 400 });
  }

  const tokenMatches: Array<{ user: ResetUser; tokenId: string }> = [];
  for (const user of users) {
    const tokenHash = hashCode({ userId: user.id, code: code.trim() });
    if (!tokenHash) {
      return NextResponse.json({ ok: false, code: "PASSWORD_RESET_NOT_CONFIGURED", error: "未配置密码找回功能" }, { status: 500 });
    }
    const token = await prisma.passwordResetToken.findFirst({
      where: {
        userId: user.id,
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (token) tokenMatches.push({ user, tokenId: token.id });
  }

  if (tokenMatches.length === 0) {
    return NextResponse.json({ ok: false, code: "INVALID_OR_EXPIRED_CODE", error: "验证码无效或已过期" }, { status: 400 });
  }
  if (tokenMatches.length > 1 && !cookieHouseholdId) {
    return NextResponse.json(
      {
        ok: false,
        code: "AMBIGUOUS_USER",
        error: "该验证码匹配多个账簿，请选择要重置的账簿",
        households: householdChoicesForUsers(tokenMatches.map((match) => match.user)),
      },
      { status: 409 },
    );
  }

  const passwordHash = await hashPassword(newPassword.trim());
  const { user, tokenId } = tokenMatches[0];

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash },
    });
    await tx.passwordResetToken.update({
      where: { id: tokenId },
      data: { usedAt: new Date() },
    });
  });

  return NextResponse.json({ ok: true });
}
