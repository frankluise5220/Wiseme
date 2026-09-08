import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import {
  extractAccessHostnames,
  getExplicitAccessHostnames,
  isAccessHostnameAllowed,
  normalizeAllowedAccessList,
  parseAllowedAccessList,
} from "@/lib/access-whitelist";

const PUBLIC_SETTING_KEYS = new Set(["allowed_dev_origins", "origin_check_enabled"]);
const ACCESS_WHITELIST_KEY = "allowed_dev_origins";
const ORIGIN_CHECK_KEY = "origin_check_enabled";

function parseNextAllowedAccessValue(value: unknown) {
  if (Array.isArray(value)) return normalizeAllowedAccessList(value);
  return parseAllowedAccessList(String(value ?? ""));
}

function validateCurrentAccessHost(req: NextRequest, allowedList: string[]) {
  const explicitHostnames = getExplicitAccessHostnames(extractAccessHostnames(req.headers, req.nextUrl.hostname));
  const missing = explicitHostnames.filter((hostname) => !isAccessHostnameAllowed(hostname, allowedList));
  if (missing.length === 0) return null;
  return `当前访问的域名或 IP（${missing.join("、")}）不在访问白名单内，不能保存会把自己排除在外的白名单设置。`;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const keysParam = searchParams.get("keys")?.trim();
  if (keysParam) {
    const keys = Array.from(new Set(keysParam.split(",").map((key) => key.trim()).filter(Boolean)));
    if (keys.length === 0) return NextResponse.json({ ok: false, code: "MISSING_KEY", error: "缺少 key" }, { status: 400 });
    const needsAdmin = keys.some((key) => !PUBLIC_SETTING_KEYS.has(key));
    if (needsAdmin) {
      const user = await getCurrentUser();
      if (!isAdmin(user)) {
        return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "仅管理员可读取该设置" }, { status: 403 });
      }
    }
    const rows = await prisma.systemSetting.findMany({ where: { key: { in: keys } } });
    const values = Object.fromEntries(keys.map((key) => [key, rows.find((row) => row.key === key)?.value ?? null]));
    return NextResponse.json({ ok: true, values });
  }

  const key = searchParams.get("key")?.trim();
  if (!key) return NextResponse.json({ ok: false, code: "MISSING_KEY", error: "缺少 key" }, { status: 400 });
  const isPublicKey = PUBLIC_SETTING_KEYS.has(key);
  if (!isPublicKey) {
    const user = await getCurrentUser();
    if (!isAdmin(user)) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "仅管理员可读取该设置" }, { status: 403 });
    }
  }
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  return NextResponse.json({ ok: true, value: row?.value ?? null });
}

export async function POST(req: NextRequest) {
  const { key, value } = await req.json();
  if (!key) return NextResponse.json({ ok: false, code: "MISSING_KEY", error: "缺少 key" }, { status: 400 });
  const user = await getCurrentUser();
  if (!isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "仅管理员可修改系统设置" }, { status: 403 });
  }
  let nextValue = String(value ?? "");
  if (key === ACCESS_WHITELIST_KEY) {
    const nextAllowedList = parseNextAllowedAccessValue(value);
    nextValue = JSON.stringify(nextAllowedList);
    const enabledRow = await prisma.systemSetting.findUnique({ where: { key: ORIGIN_CHECK_KEY } });
    if (enabledRow?.value === "true") {
      if (nextAllowedList.length === 0) {
        return NextResponse.json(
          { ok: false, code: "EMPTY_ACCESS_WHITELIST", error: "访问白名单开启时，至少需要保留一个非本机访问域名或 IP。" },
          { status: 400 },
        );
      }
      const selfLockError = validateCurrentAccessHost(req, nextAllowedList);
      if (selfLockError) return NextResponse.json({ ok: false, code: "SELF_LOCK_OUT", error: selfLockError }, { status: 400 });
    }
  }
  if (key === ORIGIN_CHECK_KEY && nextValue === "true") {
    const allowedRow = await prisma.systemSetting.findUnique({ where: { key: ACCESS_WHITELIST_KEY } });
    const allowedList = parseAllowedAccessList(allowedRow?.value);
    if (allowedList.length === 0) {
      return NextResponse.json(
        { ok: false, code: "EMPTY_ACCESS_WHITELIST", error: "请先添加至少一个非本机访问域名或 IP，再开启访问白名单。" },
        { status: 400 },
      );
    }
    const selfLockError = validateCurrentAccessHost(req, allowedList);
    if (selfLockError) return NextResponse.json({ ok: false, code: "SELF_LOCK_OUT", error: selfLockError }, { status: 400 });
  }
  await prisma.systemSetting.upsert({
    where: { key },
    create: { key, value: nextValue },
    update: { value: nextValue },
  });
  return NextResponse.json({ ok: true });
}
