import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { prisma } from "@/lib/db/prisma";
import { sendPasswordResetEmail } from "@/lib/mail/passwordReset";
import { logger } from "@/lib/logger";
import { getHouseholdDisplayName } from "@/lib/household-display";

export const runtime = "nodejs";

const BodySchema = z.object({
  username: z.string().min(1).max(80),
  email: z.string().email().optional(),
  householdId: z.string().min(1).optional(),
  preview: z.boolean().optional(),
});

function getClientIp(req: NextRequest) {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0]?.trim() || null;
  const xr = req.headers.get("x-real-ip");
  if (xr) return xr.trim() || null;
  return null;
}

function normalizeEmail(v: string) {
  return v.trim().toLowerCase();
}

function maskEmail(email: string) {
  const normalized = normalizeEmail(email);
  const [localPart, domain = ""] = normalized.split("@");
  if (!localPart || !domain) return normalized;
  const visibleLocal = localPart.length <= 2 ? localPart.slice(0, 1) : localPart.slice(0, 2);
  return `${visibleLocal}***@${domain}`;
}

type ResetUser = {
  id: string;
  name: string;
  email: string | null;
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

function ambiguousHouseholdResponse(users: ResetUser[], error: string) {
  return NextResponse.json(
    {
      ok: false,
      code: "AMBIGUOUS_USER",
      error,
      households: householdChoicesForUsers(users),
    },
    { status: 409 },
  );
}

async function findTargetUser(params: { username: string; email?: string | null; householdId?: string | null }) {
  const username = params.username.trim();
  if (!username) return null;
  const providedEmail = params.email ? normalizeEmail(params.email) : null;

  const users = await prisma.user.findMany({
    where: { name: username },
    select: { id: true, name: true, email: true, householdId: true, Household: { select: { id: true, name: true } } },
  });

  if (users.length === 0) return null;

  const byCookie = params.householdId
    ? users.find((u) => u.householdId === params.householdId) ?? null
    : null;
  if (byCookie) return byCookie;

  if (!providedEmail && users.length > 1) {
    return ambiguousHouseholdResponse(users, "该用户名存在于多个账簿，请先选择账簿");
  }

  const emailMatches = providedEmail
    ? users.filter((u) => u.email && normalizeEmail(u.email) === providedEmail)
    : users;

  if (emailMatches.length === 0) return null;
  if (emailMatches.length === 1) return emailMatches[0]!;

  return ambiguousHouseholdResponse(emailMatches, "该用户名和邮箱匹配多个账簿，请选择要找回的账簿");
}

function hashCode(params: { userId: string; code: string }) {
  const secret = (process.env.PASSWORD_RESET_SECRET ?? "").trim();
  if (!secret) return null;
  return crypto.createHash("sha256").update(`${secret}:${params.userId}:${params.code}`).digest("hex");
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as unknown;
  const parse = BodySchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "INVALID_PARAMS", error: "参数不正确" }, { status: 400 });
  }

  const secret = (process.env.PASSWORD_RESET_SECRET ?? "").trim();
  if (!secret) {
    return NextResponse.json({ ok: false, code: "PASSWORD_RESET_NOT_CONFIGURED", error: "未配置密码找回功能" }, { status: 500 });
  }

  const { username, email, householdId, preview } = parse.data;
  const cookieHouseholdId = householdId ?? req.cookies.get("householdId")?.value ?? null;
  const user = await findTargetUser({ username, email, householdId: cookieHouseholdId });
  if (user instanceof NextResponse) {
    return user;
  }

  const userEmail = user?.email ? normalizeEmail(user.email) : null;

  if (preview) {
    return NextResponse.json({
      ok: true,
      householdId: user?.householdId ?? cookieHouseholdId,
      maskedEmailHint: userEmail ? maskEmail(userEmail) : null,
      message: userEmail
        ? `请输入绑定邮箱并补全这部分：${maskEmail(userEmail)}`
        : "如果该用户已绑定邮箱，请继续补全绑定邮箱后发送验证码。",
    });
  }

  const ip = getClientIp(req);
  const userAgent = req.headers.get("user-agent") ?? null;

  const response = NextResponse.json({
    ok: true,
    message: "如果该用户已绑定邮箱，将收到一封验证码邮件。",
  });

  const providedEmail = email ? normalizeEmail(email) : null;
  if (providedEmail && user && userEmail && providedEmail !== userEmail) {
    return NextResponse.json({ ok: false, code: "USER_EMAIL_MISMATCH", error: "用户名和绑定邮箱不匹配" }, { status: 400 });
  }
  if (!user || !userEmail || (providedEmail && userEmail !== providedEmail)) {
    return response;
  }

  const now = Date.now();
  const windowStart = new Date(now - 60 * 60 * 1000);
  const [userRecent, ipRecent] = await Promise.all([
    prisma.passwordResetToken.count({ where: { userId: user.id, createdAt: { gt: windowStart } } }),
    ip ? prisma.passwordResetToken.count({ where: { ip, createdAt: { gt: windowStart } } }) : Promise.resolve(0),
  ]);
  if (userRecent >= 3 || ipRecent >= 10) {
    return response;
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const tokenHash = hashCode({ userId: user.id, code });
  if (!tokenHash) {
    return NextResponse.json({ ok: false, code: "PASSWORD_RESET_NOT_CONFIGURED", error: "未配置密码找回功能" }, { status: 500 });
  }

  const expiresMinutes = 15;
  const expiresAt = new Date(now + expiresMinutes * 60 * 1000);

  const created = await prisma.passwordResetToken.create({
    data: { userId: user.id, tokenHash, expiresAt, ip: ip ?? undefined, userAgent: userAgent ?? undefined },
    select: { id: true },
  });

  try {
    const mailRes = await sendPasswordResetEmail({
      to: userEmail,
      username: user.name,
      code,
      expiresMinutes,
      householdId: user.householdId ?? cookieHouseholdId ?? undefined,
    });
    if (!mailRes.ok) {
      await prisma.passwordResetToken.delete({ where: { id: created.id } }).catch(logger.catchSilent("删除未发送验证码", "password-reset"));
      logger.warn(mailRes.error || "验证码发送失败", "password-reset");
      return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: mailRes.error }, { status: 500 });
    }
  } catch (error) {
    await prisma.passwordResetToken.delete({ where: { id: created.id } }).catch(logger.catchSilent("删除发送失败验证码", "password-reset"));
    logger.error("验证码邮件发送失败", "password-reset", error);
    return NextResponse.json({ ok: false, code: "EMAIL_SEND_FAILED", error: error instanceof Error ? error.message : "验证码邮件发送失败" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    message: "验证码邮件已发送，请检查邮箱收件箱或垃圾邮件。",
    householdId: user.householdId,
  });
}
