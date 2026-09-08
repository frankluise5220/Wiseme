import { NextResponse } from "next/server";
import { revalidateAfterTxChange, revalidateAfterInvestChange, revalidateAfterSettingsChange } from "@/lib/server/revalidate";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

/**
 * POST /api/v1/settings/revalidate
 *
 * Force-refreshes server caches (unstable_cache / revalidateTag).
 * Used when the database was modified directly by an external tool so the Web
 * app re-reads the latest data. Admin only.
 *
 * Response:
 *   { ok: true } success
 *   { ok: false, error } failure
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user || !isAdmin(user)) {
    return NextResponse.json(
      { ok: false, code: "ADMIN_ONLY", error: "仅管理员可执行此操作" },
      { status: 403 },
    );
  }

  try {
    revalidateAfterTxChange();
    revalidateAfterInvestChange();
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "REVALIDATE_FAILED", error: e instanceof Error ? e.message : "刷新缓存失败" },
      { status: 500 },
    );
  }
}
