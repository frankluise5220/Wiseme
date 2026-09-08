import { NextResponse } from "next/server";

import { getSettingsCatalogForSurface, settingsCatalog, type SettingsSurface } from "@/lib/settings/catalog";

/**
 * GET /api/v1/settings/catalog?surface=web|android
 *
 * Returns the shared settings catalog used by Web and Android.
 *
 * Success: { ok: true, data: SettingsCatalog }
 * Failure: { ok: false, error: string }
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const surface = url.searchParams.get("surface");

  if (!surface) {
    return NextResponse.json({ ok: true, data: settingsCatalog });
  }

  if (surface !== "web" && surface !== "android") {
    return NextResponse.json({ ok: false, code: "INVALID_SURFACE", error: "surface must be web or android" }, { status: 400 });
  }

  return NextResponse.json({ ok: true, data: getSettingsCatalogForSurface(surface as SettingsSurface) });
}
