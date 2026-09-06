import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { DEFAULT_SESSION_DAYS, normalizeSessionDays } from "@/lib/session-days";

export const runtime = "nodejs";

function cors() {
  return {
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors() });
}

function requireAdmin(user: Awaited<ReturnType<typeof getCurrentUser>>) {
  if (!user) return { ok: false as const, code: "UNAUTHORIZED" as const, error: "未登录", status: 401 };
  if (!isAdmin(user)) return { ok: false as const, code: "FORBIDDEN" as const, error: "需要管理员权限", status: 403 };
  return { ok: true as const };
}

function requireSignedIn(user: Awaited<ReturnType<typeof getCurrentUser>>) {
  if (!user) return { ok: false as const, code: "UNAUTHORIZED" as const, error: "未登录", status: 401 };
  return { ok: true as const };
}

/** GET /api/v1/settings/users — Returns all users within the current household. */
export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    const auth = requireSignedIn(currentUser);
    if (!auth.ok) return NextResponse.json({ ok: false, code: auth.code, error: auth.error }, { status: auth.status, headers: cors() });

    const { householdId, user } = await getHouseholdScope();
    const orFilters: Array<Record<string, unknown>> = [
      { householdId },
      { isSystem: true },
    ];
    if (isAdmin(user)) {
      orFilters.push({ householdId: null });
    }
    const where = { OR: orFilters };

    let users: Array<{
      id: string;
      name: string;
      email: string | null;
      role: string;
      isSystem: boolean;
      passwordHash: string | null;
      createdAt: Date;
      updatedAt: Date;
    }>;
    try {
      users = await prisma.user.findMany({
        where,
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isSystem: true,
          passwordHash: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const looksLikeMissingEmailColumn = msg.toLowerCase().includes("email") && (msg.toLowerCase().includes("does not exist") || msg.toLowerCase().includes("unknown column") || msg.toLowerCase().includes("column"));
      if (looksLikeMissingEmailColumn) {
        const fallback = await prisma.user.findMany({
          where,
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            role: true,
            isSystem: true,
            passwordHash: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        users = fallback.map((u) => ({ ...u, email: null }));
      } else {
        throw error;
      }
    }

    const sessionDaysByUserId = new Map<string, number>();
    try {
      const settings = await prisma.userSettings.findMany({
        where: { userId: { in: users.map((u) => u.id) } },
        select: { userId: true, sessionDays: true },
      });
      for (const setting of settings) {
        sessionDaysByUserId.set(setting.userId, normalizeSessionDays(setting.sessionDays, DEFAULT_SESSION_DAYS));
      }
    } catch {
      // Missing older preference columns should not prevent the user list from loading.
    }

    return NextResponse.json({
      ok: true,
      users: users.map(u => ({
        ...u,
        sessionDays: sessionDaysByUserId.get(u.id) ?? DEFAULT_SESSION_DAYS,
        hasPassword: !!u.passwordHash,
        passwordHash: undefined,
      })),
      canManageUsers: isAdmin(currentUser),
    }, { headers: cors() });
  } catch {
    return NextResponse.json({ ok: false, code: "SERVER_ERROR", error: "服务器错误" }, { status: 500, headers: cors() });
  }
}

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.union([z.string().email(), z.literal("")]).optional(),
  role: z.enum(["admin", "user", "viewer"]).default("user"),
  password: z.string().optional(),
  sessionDays: z.number().optional(),
});

/** POST /api/v1/settings/users — Creates a user within the current household. */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  const auth = requireAdmin(currentUser);
  if (!auth.ok) return NextResponse.json({ ok: false, code: auth.code, error: auth.error }, { status: auth.status, headers: cors() });

  const { householdId } = await getHouseholdScope();
  const body = await req.json().catch(() => null);
  const parse = CreateSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "MISSING_NAME", error: "缺少必填字段（name）" }, { status: 400, headers: cors() });
  }

  const { name, role, password, email, sessionDays } = parse.data;

  // Check whether a user with the same name already exists in the current household
  const existing = await prisma.user.findFirst({ where: { name, householdId } });
  if (existing) {
    return NextResponse.json({ ok: false, code: "DUPLICATE_USERNAME", error: "用户名已存在" }, { status: 409, headers: cors() });
  }

  const data: { name: string; role: string; householdId: string; email?: string; passwordHash?: string } = { name, role, householdId };
  if (email != null) data.email = email.trim() ? email.trim() : undefined;
  if (password && password.trim()) {
    data.passwordHash = await hashPassword(password.trim());
  }

  const user = await prisma.user.create({
    data,
    select: { id: true, name: true, email: true, role: true, isSystem: true, createdAt: true, updatedAt: true },
  });
  await prisma.userSettings.create({
    data: {
      userId: user.id,
      sessionDays: normalizeSessionDays(sessionDays, DEFAULT_SESSION_DAYS),
    },
  });

  return NextResponse.json({
    ok: true,
    user: { ...user, sessionDays: normalizeSessionDays(sessionDays, DEFAULT_SESSION_DAYS) },
  }, { headers: cors() });
}

const UpdateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
  email: z.union([z.string().email(), z.literal("")]).optional(),
  role: z.enum(["admin", "user", "viewer"]).optional(),
  password: z.string().optional(),
  sessionDays: z.number().optional(),
});

/** PUT /api/v1/settings/users — Updates a user within the current household. */
export async function PUT(req: NextRequest) {
  const currentUser = await getCurrentUser();
  const auth = requireAdmin(currentUser);
  if (!auth.ok) return NextResponse.json({ ok: false, code: auth.code, error: auth.error }, { status: auth.status, headers: cors() });

  const { householdId } = await getHouseholdScope();
  const body = await req.json().catch(() => null);
  const parse = UpdateSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "MISSING_USER_ID", error: "缺少必填字段（id）" }, { status: 400, headers: cors() });
  }

  const { id, name, role, password, email, sessionDays } = parse.data;

  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "用户不存在" }, { status: 404, headers: cors() });
  }

  // Permission check: system users can only be modified by the system admin (prevents a household admin from resetting the system admin password)
  if (existing.isSystem && !(currentUser?.isSystem === true)) {
    return NextResponse.json({ ok: false, code: "SYSTEM_ADMIN_RESTRICTED", error: "仅系统管理员可管理系统管理员" }, { status: 403, headers: cors() });
  }
  // Permission check: the user does not belong to the current household
  if (existing.householdId !== householdId && !existing.isSystem) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403, headers: cors() });
  }

  // The last admin cannot be changed to a non-admin role.
  if (role !== undefined && role !== "admin" && existing.role === "admin" && !existing.isSystem) {
    const adminCount = await prisma.user.count({ where: { householdId, role: "admin" } });
    if (adminCount <= 1) {
      return NextResponse.json({ ok: false, code: "LAST_ADMIN_DEMOTE_BLOCKED", error: "不能将最后一个管理员改为非管理员角色" }, { status: 409, headers: cors() });
    }
  }

  const data: { name?: string; email?: string | null; role?: string; passwordHash?: string | null } = {};
  if (name) data.name = name;
  if (email != null) data.email = email.trim() ? email.trim() : null;
  if (role) data.role = role;
  if (password && password.trim()) {
    data.passwordHash = await hashPassword(password.trim());
  }

  const hasSessionDays = sessionDays !== undefined;
  if (Object.keys(data).length === 0 && !hasSessionDays) {
    return NextResponse.json({ ok: false, code: "NO_FIELDS_TO_UPDATE", error: "没有需要更新的字段" }, { status: 400, headers: cors() });
  }

  const user = Object.keys(data).length > 0
    ? await prisma.user.update({
        where: { id },
        data,
        select: { id: true, name: true, email: true, role: true, isSystem: true, createdAt: true, updatedAt: true },
      })
    : await prisma.user.findUnique({
        where: { id },
        select: { id: true, name: true, email: true, role: true, isSystem: true, createdAt: true, updatedAt: true },
      });
  if (!user) {
    return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "用户不存在" }, { status: 404, headers: cors() });
  }

  const normalizedSessionDays = normalizeSessionDays(sessionDays, DEFAULT_SESSION_DAYS);
  if (hasSessionDays) {
    await prisma.userSettings.upsert({
      where: { userId: id },
      update: { sessionDays: normalizedSessionDays },
      create: { userId: id, sessionDays: normalizedSessionDays },
    });
  }

  return NextResponse.json({
    ok: true,
    user: { ...user, sessionDays: hasSessionDays ? normalizedSessionDays : DEFAULT_SESSION_DAYS },
  }, { headers: cors() });
}

const DeleteSchema = z.object({
  password: z.string().min(1),
});

/** DELETE /api/v1/settings/users?id=xxx — Deletes a user within the current household; requires the current user's password for confirmation. */
export async function DELETE(req: NextRequest) {
  const currentUser = await getCurrentUser();
  const auth = requireAdmin(currentUser);
  if (!auth.ok) return NextResponse.json({ ok: false, code: auth.code, error: auth.error }, { status: auth.status, headers: cors() });

  const { householdId } = await getHouseholdScope();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";
  const body = await req.json().catch(() => null);
  const parse = DeleteSchema.safeParse(body);

  if (!id) {
    return NextResponse.json({ ok: false, code: "MISSING_USER_ID", error: "缺少 id" }, { status: 400, headers: cors() });
  }
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "PASSWORD_REQUIRED", error: "请输入当前用户密码" }, { status: 400, headers: cors() });
  }

  const operator = await prisma.user.findUnique({ where: { id: currentUser!.id } });
  if (!operator?.passwordHash) {
    return NextResponse.json({ ok: false, code: "OPERATOR_NO_PASSWORD", error: "当前用户未设置密码，不能执行删除用户操作" }, { status: 403, headers: cors() });
  }
  const passwordMatched = await verifyPassword(parse.data.password, operator.passwordHash);
  if (!passwordMatched) {
    return NextResponse.json({ ok: false, code: "INVALID_PASSWORD", error: "当前用户密码不正确" }, { status: 403, headers: cors() });
  }

  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "用户不存在" }, { status: 404, headers: cors() });
  }

  // Permission check: the user does not belong to the current household
  if (existing.householdId !== householdId && !existing.isSystem) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403, headers: cors() });
  }

  // System users cannot be deleted
  if (existing.isSystem) {
    return NextResponse.json({ ok: false, code: "SYSTEM_USER_IMMUTABLE", error: "系统用户不可删除" }, { status: 403, headers: cors() });
  }

  // The last admin of the current household cannot be deleted
  const adminCount = await prisma.user.count({ where: { householdId, role: "admin" } });
  if (existing.role === "admin" && adminCount <= 1) {
    return NextResponse.json({ ok: false, code: "LAST_ADMIN_DELETE_BLOCKED", error: "不能删除最后一个管理员" }, { status: 409, headers: cors() });
  }

  await prisma.user.delete({ where: { id } });

  return NextResponse.json({ ok: true }, { headers: cors() });
}
