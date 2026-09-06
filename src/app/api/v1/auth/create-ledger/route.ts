import { NextRequest, NextResponse } from "next/server";
import {
  HOUSEHOLD_COOKIE,
  SESSION_DAYS_COOKIE,
  USER_ID_COOKIE,
  USERNAME_COOKIE,
  VERIFIED_COOKIE,
  createVerifiedSessionValue,
  sessionCookieOptions,
} from "@/lib/server/session-cookies";
import { prisma } from "@/lib/db/prisma";
import {
  createLedgerWithDefaults,
  LEDGER_CREATION_INVITE_CODE_KEY,
} from "@/lib/households/create-ledger";
import {
  activeLedgerInviteCodes,
  findLedgerInviteCodeRecord,
  markLedgerInviteCodeUsed,
  parseLedgerInviteCodeRecords,
  serializeLedgerInviteCodeRecords,
} from "@/lib/ledger-invite-codes";

const LEGACY_PASSWORD_KEY = "access_password";

class CreateLedgerError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function resolveSessionMaxAge(req: NextRequest) {
  const raw = req.cookies.get(SESSION_DAYS_COOKIE)?.value ?? "30";
  const days = Number(raw);
  const normalizedDays = Number.isFinite(days) ? Math.min(Math.max(Math.round(days), 1), 365) : 30;
  return normalizedDays * 24 * 60 * 60;
}

/**
 * POST /api/v1/auth/create-ledger
 * Public entry: creates a new ledger and logs in directly as the new ledger's admin.
 * - Initializing the first ledger on an empty deployment does not require an invite code.
 * - Non-first-time creation must validate the ledger creation invite code from system settings.
 * - Invite codes are single-use; after a successful creation, the created ledger and usage time are recorded and the code is invalidated.
 *
 * Body:
 * {
 *   inviteCode?: string,
 *   name: string,
 *   adminName: string,
 *   adminPassword: string,
 *   adminEmail?: string
 * }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const inviteCode = String(body.inviteCode ?? "").trim();
  const name = String(body.name ?? "").trim();
  const adminName = String(body.adminName ?? "").trim();
  const adminPassword = String(body.adminPassword ?? "").trim();
  const adminEmail = String(body.adminEmail ?? "").trim();

  if (!name || name.length > 50) {
    return NextResponse.json({ ok: false, code: "INVALID_LEDGER_NAME", error: "账簿名称不合法（1-50字）" }, { status: 400 });
  }
  if (!adminName || adminName.length > 50) {
    return NextResponse.json({ ok: false, code: "INVALID_ADMIN_NAME", error: "请填写管理员用户名（1-50字）" }, { status: 400 });
  }
  if (!adminPassword) {
    return NextResponse.json({ ok: false, code: "ADMIN_PASSWORD_REQUIRED", error: "请设置管理员密码" }, { status: 400 });
  }

  const [householdCount, userCount, legacy] = await prisma.$transaction([
    prisma.household.count(),
    prisma.user.count(),
    prisma.systemSetting.findUnique({
      where: { key: LEGACY_PASSWORD_KEY },
      select: { value: true },
    }),
  ]);
  const isInitialLedgerSetup = householdCount === 0 && userCount === 0 && !(legacy?.value?.length);

  if (!isInitialLedgerSetup) {
    if (!inviteCode) {
      return NextResponse.json({ ok: false, code: "INVITE_CODE_REQUIRED", error: "请输入邀请码" }, { status: 400 });
    }
    if (!adminEmail) {
      return NextResponse.json({ ok: false, code: "EMAIL_REQUIRED", error: "请输入邮箱" }, { status: 400 });
    }

  }

  let created: Awaited<ReturnType<typeof createLedgerWithDefaults>>;
  try {
    created = await prisma.$transaction(async (tx) => {
      if (isInitialLedgerSetup) {
        return createLedgerWithDefaults(tx, {
          name,
          adminName,
          adminPassword,
          adminEmail,
        });
      }

      const inviteSetting = await tx.systemSetting.findUnique({
        where: { key: LEDGER_CREATION_INVITE_CODE_KEY },
      });
      const inviteRecords = parseLedgerInviteCodeRecords(inviteSetting?.value);
      const inviteRecord = findLedgerInviteCodeRecord(inviteRecords, inviteCode);
      if (!inviteRecord) {
        if (activeLedgerInviteCodes(inviteRecords).length === 0) {
          throw new CreateLedgerError("当前未开放新建账簿，请联系管理员", 403);
        }
        throw new CreateLedgerError("邀请码不正确", 403);
      }
      if (inviteRecord.usedAt) {
        throw new CreateLedgerError("邀请码已被使用", 403);
      }

      const result = await createLedgerWithDefaults(tx, {
        name,
        adminName,
        adminPassword,
        adminEmail,
      });
      const usedInviteRecords = markLedgerInviteCodeUsed(inviteRecords, inviteCode, {
        householdId: result.household.id,
        householdName: result.household.name,
      });
      await tx.systemSetting.upsert({
        where: { key: LEDGER_CREATION_INVITE_CODE_KEY },
        create: {
          key: LEDGER_CREATION_INVITE_CODE_KEY,
          value: serializeLedgerInviteCodeRecords(usedInviteRecords),
        },
        update: { value: serializeLedgerInviteCodeRecords(usedInviteRecords) },
      });
      return result;
    });
  } catch (error) {
    if (error instanceof CreateLedgerError) {
      return NextResponse.json({ ok: false, code: "LEDGER_CREATION_REJECTED", error: error.message }, { status: error.status });
    }
    throw error;
  }

  const response = NextResponse.json({
    ok: true,
    initialSetup: isInitialLedgerSetup,
    household: { id: created.household.id, name: created.household.name },
  });
  const maxAge = resolveSessionMaxAge(req);
  const cookieOptions = sessionCookieOptions(maxAge, req);
  response.cookies.set(VERIFIED_COOKIE, createVerifiedSessionValue(created.adminUser.id, maxAge), cookieOptions);
  response.cookies.set(USER_ID_COOKIE, created.adminUser.id, cookieOptions);
  response.cookies.set(USERNAME_COOKIE, created.adminUser.name, cookieOptions);
  response.cookies.set(HOUSEHOLD_COOKIE, created.household.id, cookieOptions);
  return response;
}
