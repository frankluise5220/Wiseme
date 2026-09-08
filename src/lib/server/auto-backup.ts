import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import {
  buildBackupFileName,
  buildHouseholdBackupPayload,
  encryptBackupBytes,
  encryptBackupPayload,
} from "@/lib/server/backup";
import { createSqliteSnapshotBuffer, isSqliteFileDatabase } from "@/lib/server/sqlite-snapshot";

/**
 * Server-side automatic backup (NAS / Docker / desktop).
 *
 * Configuration and last-run status are stored in `SystemSetting` so every
 * deployment flavor (SQLite and Postgres) shares the same code path and no
 * schema migration is required. The scheduler lives in `instrumentation-node.ts`
 * and checks `runAutoBackupTick()` on the system-task interval.
 *
 * Encrypted packages are written without a passphrase, so encryption uses the
 * system-level `backup_package_encryption_key` and restore works without user
 * input on the same deployment.
 */
export const AUTO_BACKUP_CONFIG_KEY = "auto_backup_config";
export const AUTO_BACKUP_STATUS_KEY = "auto_backup_status";

export type AutoBackupFrequencyType = "daily" | "weekly" | "interval";

export type AutoBackupConfig = {
  enabled: boolean;
  /** "daily" = every day at `time`; "weekly" = every `weekday` at `time`; "interval" = every `everyHours` hours */
  frequencyType: AutoBackupFrequencyType;
  /** "HH:mm" (24h), used by daily / weekly */
  time: string;
  /** 0 = Sunday .. 6 = Saturday, used by weekly */
  weekday: number;
  /** hours between runs (1..720), used by interval */
  everyHours: number;
  /** "system" = whole-database snapshot (SQLite only); "household" = one encrypted package per household */
  scope: "system" | "household";
  /** target directory on the server; empty string resolves to defaultAutoBackupDir() */
  path: string;
  /** how many most recent backup files to keep (1..100) */
  keepCount: number;
};

export type AutoBackupStatus = {
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastError: string | null;
  nextRunAt: string | null;
};

export type AutoBackupRunResult = {
  scope: AutoBackupConfig["scope"];
  files: string[];
};

const DEFAULT_CONFIG: AutoBackupConfig = {
  enabled: false,
  frequencyType: "daily",
  time: "02:00",
  weekday: 1,
  everyHours: 24,
  scope: "system",
  path: "",
  keepCount: 7,
};
const WINDOWS_STARTUP_BACKUP_STALE_MS = 24 * 3600_000;

function configError(message: string): never {
  throw new Error(message);
}

function parseJsonSetting(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function normalizeAutoBackupConfig(raw: unknown): AutoBackupConfig {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const frequencyType = obj.frequencyType === "weekly" || obj.frequencyType === "interval" ? obj.frequencyType : "daily";
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(obj.time ?? "")) ? String(obj.time) : DEFAULT_CONFIG.time;
  let weekday = Number(obj.weekday ?? DEFAULT_CONFIG.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) weekday = DEFAULT_CONFIG.weekday;
  let everyHours = Number(obj.everyHours ?? DEFAULT_CONFIG.everyHours);
  if (!Number.isInteger(everyHours) || everyHours < 1 || everyHours > 720) everyHours = DEFAULT_CONFIG.everyHours;
  let keepCount = Number(obj.keepCount ?? DEFAULT_CONFIG.keepCount);
  if (!Number.isInteger(keepCount) || keepCount < 1 || keepCount > 100) keepCount = DEFAULT_CONFIG.keepCount;
  return {
    enabled: obj.enabled === true,
    frequencyType,
    time,
    weekday,
    everyHours,
    scope: obj.scope === "system" ? "system" : "household",
    path: String(obj.path ?? "").trim(),
    keepCount,
  };
}

export function defaultAutoBackupDir(): string {
  const dataDir = process.env.MMH_DATA_DIR || path.join(process.cwd(), "data");
  return path.join(dataDir, "backups");
}

export type DiskInfo = {
  freeBytes: number;
  totalBytes: number;
};

function nearestExistingDir(target: string): string {
  let current = path.resolve(target);
  for (let i = 0; i < 64; i++) {
    try {
      if (fs.statSync(current).isDirectory()) return current;
    } catch {
      // keep walking up
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

export async function getPathDiskInfo(target: string): Promise<DiskInfo | null> {
  try {
    const stats = await fs.promises.statfs(nearestExistingDir(target));
    return {
      freeBytes: Number(stats.bavail ?? stats.bfree) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
    };
  } catch {
    return null;
  }
}

export function formatDiskBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Verifies that a backup directory can be created and written to, and returns
 * the free space of the disk it lives on. Used before saving the config so a
 * bad path (unwritable, no such mount) is rejected at save time instead of at
 * 3am during a scheduled run.
 */
export async function probeBackupPath(
  target: string,
): Promise<{ ok: true; dir: string; disk: DiskInfo | null } | { ok: false; error: string }> {
  const dir = target || defaultAutoBackupDir();
  const probeFile = path.join(dir, `.mmh-probe-${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probeFile, "", { mode: 0o600 });
    fs.rmSync(probeFile, { force: true });
    const disk = await getPathDiskInfo(dir);
    return { ok: true, dir, disk };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export async function loadAutoBackupConfig(): Promise<AutoBackupConfig> {
  const row = await prisma.systemSetting.findUnique({ where: { key: AUTO_BACKUP_CONFIG_KEY } });
  return normalizeAutoBackupConfig(parseJsonSetting(row?.value));
}

export async function saveAutoBackupConfig(config: unknown): Promise<AutoBackupConfig> {
  const normalized = normalizeAutoBackupConfig(config);
  const value = JSON.stringify(normalized);
  await prisma.systemSetting.upsert({
    where: { key: AUTO_BACKUP_CONFIG_KEY },
    create: { key: AUTO_BACKUP_CONFIG_KEY, value },
    update: { value },
  });
  return normalized;
}

export async function loadAutoBackupStatus(): Promise<AutoBackupStatus> {
  const row = await prisma.systemSetting.findUnique({ where: { key: AUTO_BACKUP_STATUS_KEY } });
  const obj = (parseJsonSetting(row?.value) ?? {}) as Record<string, unknown>;
  return {
    lastRunAt: typeof obj.lastRunAt === "string" ? obj.lastRunAt : null,
    lastRunOk: typeof obj.lastRunOk === "boolean" ? obj.lastRunOk : null,
    lastError: typeof obj.lastError === "string" ? obj.lastError : null,
    nextRunAt: typeof obj.nextRunAt === "string" ? obj.nextRunAt : null,
  };
}

export async function saveAutoBackupStatus(status: AutoBackupStatus): Promise<void> {
  const value = JSON.stringify(status);
  await prisma.systemSetting.upsert({
    where: { key: AUTO_BACKUP_STATUS_KEY },
    create: { key: AUTO_BACKUP_STATUS_KEY, value },
    update: { value },
  });
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Computes the next scheduled run strictly after `now`. `lastRunAt` is only
 * relevant for the interval frequency (next = lastRun + everyHours).
 */
export function computeNextRunAt(config: AutoBackupConfig, now: Date, lastRunAt: Date | null = null): Date {
  if (config.frequencyType === "interval") {
    const base = lastRunAt && lastRunAt.getTime() > 0 ? lastRunAt : now;
    return new Date(base.getTime() + config.everyHours * 3600_000);
  }

  const [hour, minute] = config.time.split(":").map(Number);
  if (config.frequencyType === "weekly") {
    const candidate = startOfDay(now);
    candidate.setHours(hour, minute, 0, 0);
    const daysAhead = (config.weekday - candidate.getDay() + 7) % 7;
    candidate.setDate(candidate.getDate() + daysAhead);
    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 7);
    }
    return candidate;
  }

  const candidate = startOfDay(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate;
}

export function isAutoBackupDue(config: AutoBackupConfig, status: AutoBackupStatus, now: Date): boolean {
  if (!config.enabled) return false;
  if (!status.nextRunAt) return false;
  const nextRunAt = new Date(status.nextRunAt).getTime();
  if (!Number.isFinite(nextRunAt)) return false;
  return nextRunAt <= now.getTime();
}

function backupFileName(name: string, exportedAt: Date): string {
  return buildBackupFileName(name, exportedAt, "mmhbackup");
}

export function cleanupOldBackups(targetDir: string, keepCount: number): void {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return;
  }
  const backups = entries
    .filter((entry) => entry.isFile() && /^.+\.mmhbackup$/.test(entry.name))
    .map((entry) => {
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(targetDir, entry.name)).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { name: entry.name, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const stale of backups.slice(keepCount)) {
    try {
      fs.rmSync(path.join(targetDir, stale.name));
      logger.info(`auto backup pruned stale file: ${stale.name}`, "auto-backup");
    } catch {
      // Best-effort cleanup; a locked file must not break the backup run.
    }
  }
}

export function getLatestAutoBackupFileMtime(targetDir: string): Date | null {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return null;
  }

  let latest = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/^.+\.mmhbackup$/.test(entry.name)) continue;
    try {
      const mtime = fs.statSync(path.join(targetDir, entry.name)).mtimeMs;
      if (Number.isFinite(mtime) && mtime > latest) latest = mtime;
    } catch {
      // Ignore files that disappear while scanning the backup directory.
    }
  }
  return latest > 0 ? new Date(latest) : null;
}

export function isAutoBackupFileStale(targetDir: string, now: Date, staleMs = WINDOWS_STARTUP_BACKUP_STALE_MS): boolean {
  const latest = getLatestAutoBackupFileMtime(targetDir);
  if (!latest) return true;
  return now.getTime() - latest.getTime() >= staleMs;
}

/**
 * Runs one automatic backup now: resolves the target directory, writes
 * encrypted packages (whole-db snapshot for scope=system on SQLite, otherwise
 * one package per household), then prunes files beyond keepCount.
 *
 * Pass `{ force: true }` to run even when the config is disabled (used by the
 * "run now" action).
 */
export async function runAutoBackupNow(
  config?: AutoBackupConfig,
  options: { force?: boolean } = {},
): Promise<AutoBackupRunResult> {
  const resolved = config ?? (await loadAutoBackupConfig());
  if (!resolved.enabled && !options.force) {
    return { scope: resolved.scope, files: [] };
  }

  const targetDir = resolved.path || defaultAutoBackupDir();
  fs.mkdirSync(targetDir, { recursive: true });
  const exportedAt = new Date();
  const files: string[] = [];

  if (resolved.scope === "system") {
    if (!isSqliteFileDatabase()) {
      configError("current database does not support whole-db snapshot backup; use per-household scope instead");
    }
    const snapshot = await createSqliteSnapshotBuffer();
    const firstHousehold = await prisma.household.findFirst({ orderBy: { createdAt: "asc" } });
    const packageObject = await encryptBackupBytes(
      snapshot,
      {
        householdId: firstHousehold?.id ?? "system",
        householdName: firstHousehold?.name ?? "system",
        backupScope: "system",
      },
      exportedAt,
      {},
    );
    const fileName = backupFileName("system", exportedAt);
    fs.writeFileSync(path.join(targetDir, fileName), JSON.stringify(packageObject, null, 2), { mode: 0o600 });
    files.push(fileName);
  } else {
    const households = await prisma.household.findMany({ orderBy: { createdAt: "asc" } });
    if (households.length === 0) {
      configError("no household found; automatic backup has nothing to back up");
    }
    for (const household of households) {
      const payload = await buildHouseholdBackupPayload(household.id, null, { backupScope: "household" });
      const packageObject = await encryptBackupPayload(payload, {});
      const fileName = backupFileName(household.name, exportedAt);
      fs.writeFileSync(path.join(targetDir, fileName), JSON.stringify(packageObject, null, 2), { mode: 0o600 });
      files.push(fileName);
    }
  }

  cleanupOldBackups(targetDir, resolved.keepCount);
  return { scope: resolved.scope, files };
}

/**
 * Scheduler entry called from the system-task tick. Returns the run result
 * when a run happened, or null when disabled / not due. Never throws.
 */
export async function runAutoBackupTick(): Promise<AutoBackupRunResult | null> {
  let config: AutoBackupConfig | null = null;
  try {
    config = await loadAutoBackupConfig();
    if (!config.enabled) return null;
    const status = await loadAutoBackupStatus();
    const now = new Date();
    if (!isAutoBackupDue(config, status, now)) return null;

    const result = await runAutoBackupNow(config);
    await saveAutoBackupStatus({
      lastRunAt: now.toISOString(),
      lastRunOk: true,
      lastError: null,
      nextRunAt: computeNextRunAt(config, now, now).toISOString(),
    });
    logger.info(`auto backup completed: ${result.files.join(", ")}`, "auto-backup");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`auto backup failed: ${message}`, "auto-backup");
    try {
      const now = new Date();
      const fallbackConfig = config ?? (await loadAutoBackupConfig());
      await saveAutoBackupStatus({
        lastRunAt: now.toISOString(),
        lastRunOk: false,
        lastError: message,
        nextRunAt: fallbackConfig.enabled ? computeNextRunAt(fallbackConfig, now, now).toISOString() : null,
      });
    } catch {
      // Never let status persistence failures escape the tick.
    }
    return null;
  }
}

/**
 * Windows desktop does not keep the server alive after the app is closed, so
 * a scheduled backup may be missed. On startup, catch up in the background when
 * automatic backup is enabled and the newest backup file is at least 24h old.
 */
export async function runWindowsStartupAutoBackupIfStale(): Promise<AutoBackupRunResult | null> {
  if (String(process.env.MMH_DEPLOY_TARGET ?? "").trim().toLowerCase() !== "windows") return null;

  let config: AutoBackupConfig | null = null;
  const now = new Date();
  try {
    config = await loadAutoBackupConfig();
    if (!config.enabled) return null;

    const targetDir = config.path || defaultAutoBackupDir();
    if (!isAutoBackupFileStale(targetDir, now)) return null;

    const result = await runAutoBackupNow(config, { force: true });
    await saveAutoBackupStatus({
      lastRunAt: now.toISOString(),
      lastRunOk: true,
      lastError: null,
      nextRunAt: computeNextRunAt(config, now, now).toISOString(),
    });
    logger.info(`windows startup auto backup completed: ${result.files.join(", ")}`, "auto-backup");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`windows startup auto backup failed: ${message}`, "auto-backup");
    try {
      const fallbackConfig = config ?? (await loadAutoBackupConfig());
      await saveAutoBackupStatus({
        lastRunAt: now.toISOString(),
        lastRunOk: false,
        lastError: message,
        nextRunAt: fallbackConfig.enabled ? computeNextRunAt(fallbackConfig, now, now).toISOString() : null,
      });
    } catch {
      // Keep startup non-blocking even if status persistence fails.
    }
    return null;
  }
}
