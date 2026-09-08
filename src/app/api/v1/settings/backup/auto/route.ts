import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { isSqliteFileDatabase } from "@/lib/server/sqlite-snapshot";
import {
  computeNextRunAt,
  defaultAutoBackupDir,
  formatDiskBytes,
  getPathDiskInfo,
  loadAutoBackupConfig,
  loadAutoBackupStatus,
  probeBackupPath,
  runAutoBackupNow,
  saveAutoBackupConfig,
  saveAutoBackupStatus,
} from "@/lib/server/auto-backup";

/**
 * GET /api/v1/settings/backup/auto
 *
 * Returns the automatic-backup configuration, last-run status, and platform
 * capabilities. Admin only (the config exposes a server-side path).
 *
 * POST /api/v1/settings/backup/auto
 *
 * Saves the configuration (body: `{ config }`). When the config is enabled the
 * next-run time is recomputed from now, keeping the existing last-run history.
 *
 * POST /api/v1/settings/backup/auto?action=run-now
 *
 * Runs one backup immediately using the currently saved config (even when
 * disabled) and refreshes the last-run status.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Sign in required" }, { status: 401 });
  }
  if (!isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Admin only" }, { status: 403 });
  }

  const [config, status] = await Promise.all([loadAutoBackupConfig(), loadAutoBackupStatus()]);
  const defaultDir = defaultAutoBackupDir();
  const defaultDisk = await getPathDiskInfo(defaultDir);
  return NextResponse.json({
    ok: true,
    data: {
      config,
      status,
      capabilities: {
        systemBackup: isSqliteFileDatabase(),
        defaultDir,
        defaultDisk: defaultDisk ? { ...defaultDisk, free: formatDiskBytes(defaultDisk.freeBytes) } : null,
      },
    },
  });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Sign in required" }, { status: 401 });
  }
  if (!isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Admin only" }, { status: 403 });
  }

  const action = req.nextUrl.searchParams.get("action");
  if (action === "run-now") {
    return handleRunNow();
  }

  let body: { config?: unknown };
  try {
    body = (await req.json()) as { config?: unknown };
  } catch {
    return NextResponse.json({ ok: false, code: "INVALID_BODY", error: "Invalid JSON body" }, { status: 400 });
  }

  const rawConfig = body?.config;
  const probeTarget =
    rawConfig && typeof rawConfig === "object" && typeof (rawConfig as Record<string, unknown>).path === "string"
      ? String((rawConfig as Record<string, unknown>).path)
      : "";
  const probe = await probeBackupPath(probeTarget);
  if (!probe.ok) {
    return NextResponse.json(
      { ok: false, code: "BACKUP_PATH_NOT_WRITABLE", error: probe.error },
      { status: 400 },
    );
  }

  const config = await saveAutoBackupConfig(body?.config);
  const now = new Date();
  const status = await loadAutoBackupStatus();
  await saveAutoBackupStatus({
    lastRunAt: status.lastRunAt,
    lastRunOk: status.lastRunOk,
    lastError: status.lastError,
    nextRunAt: config.enabled ? computeNextRunAt(config, now, now).toISOString() : null,
  });
  const nextStatus = await loadAutoBackupStatus();
  return NextResponse.json({
    ok: true,
    data: {
      config,
      status: nextStatus,
      disk: probe.disk ? { ...probe.disk, free: formatDiskBytes(probe.disk.freeBytes) } : null,
    },
  });
}

async function handleRunNow() {
  try {
    const result = await runAutoBackupNow(undefined, { force: true });
    const now = new Date();
    const config = await loadAutoBackupConfig();
    await saveAutoBackupStatus({
      lastRunAt: now.toISOString(),
      lastRunOk: true,
      lastError: null,
      nextRunAt: config.enabled ? computeNextRunAt(config, now, now).toISOString() : null,
    });
    const status = await loadAutoBackupStatus();
    return NextResponse.json({ ok: true, data: { result, status } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date();
    const config = await loadAutoBackupConfig();
    await saveAutoBackupStatus({
      lastRunAt: now.toISOString(),
      lastRunOk: false,
      lastError: message,
      nextRunAt: config.enabled ? computeNextRunAt(config, now, now).toISOString() : null,
    });
    return NextResponse.json(
      { ok: false, code: "AUTO_BACKUP_FAILED", error: message, data: { status: await loadAutoBackupStatus() } },
      { status: 500 },
    );
  }
}
