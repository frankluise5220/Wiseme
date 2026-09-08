import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import {
  DEFAULT_EMAIL_IMPORT_KEYWORD,
  emailImportKeywordSettingKey,
  normalizeEmailImportKeyword,
} from "@/lib/mail/email-import-settings";
import { isAdmin } from "@/lib/server/auth";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

/**
 * GET /api/v1/settings/email-import
 * Returns the current household email bill import settings.
 * Response: { ok: true, data: { keyword } }
 */
export async function GET() {
  const { householdId } = await getHouseholdScope();
  const row = await prisma.systemSetting.findUnique({
    where: { key: emailImportKeywordSettingKey(householdId) },
  });
  return NextResponse.json({
    ok: true,
    data: { keyword: row ? normalizeEmailImportKeyword(row.value) : DEFAULT_EMAIL_IMPORT_KEYWORD },
  });
}

/**
 * PUT /api/v1/settings/email-import
 * Updates the current household email bill import settings.
 * Body: { keyword }
 * Response: { ok: true, data: { keyword } }
 */
export async function PUT(req: NextRequest) {
  const { householdId, user } = await getHouseholdScope();
  if (!user || !isAdmin(user)) {
    return NextResponse.json(
      { ok: false, code: "ADMIN_REQUIRED", error: "Administrator permission is required." },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { keyword?: unknown };
  const keyword = normalizeEmailImportKeyword(body.keyword);
  await prisma.systemSetting.upsert({
    where: { key: emailImportKeywordSettingKey(householdId) },
    create: { key: emailImportKeywordSettingKey(householdId), value: keyword },
    update: { value: keyword },
  });
  return NextResponse.json({ ok: true, data: { keyword } });
}
