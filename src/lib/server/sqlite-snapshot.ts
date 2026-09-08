import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { prisma } from "@/lib/db/prisma";

export type RestoreSqliteSnapshotProgress = {
  stage: "restoring" | "done";
  percent: number;
  label: string;
  detail?: string;
};

function snapshotError(message: string): never {
  throw new Error(message);
}

export function isSqliteFileDatabase(): boolean {
  const url = String(process.env.DATABASE_URL ?? "");
  return url.startsWith("file:") && url !== "file::memory:";
}

function sqliteDatabasePath(): string {
  const url = String(process.env.DATABASE_URL ?? "");
  const filePath = url.replace(/^file:/, "");
  if (!filePath) {
    snapshotError("当前数据库路径无法解析，无法执行整库备份");
  }
  return filePath;
}

function sidecarPaths(dbPath: string): string[] {
  return ["-journal", "-wal", "-shm"].map((suffix) => `${dbPath}${suffix}`);
}

export async function createSqliteSnapshotBuffer(): Promise<Buffer> {
  const dbPath = sqliteDatabasePath();
  const db = new Database(dbPath, { fileMustExist: true });
  const tmpPath = path.join(os.tmpdir(), `mmh-snapshot-${crypto.randomUUID()}.db`);
  try {
    await db.backup(tmpPath);
    const bytes = fs.readFileSync(tmpPath);
    return bytes;
  } finally {
    db.close();
    fs.rmSync(tmpPath, { force: true });
  }
}

export function validateSqliteSnapshotFile(filePath: string): void {
  let db: Database | null = null;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    const integrity = db.pragma("integrity_check", { simple: true });
    if (typeof integrity !== "string" || integrity.toLowerCase() !== "ok") {
      snapshotError("备份数据库文件完整性校验失败，文件可能已损坏");
    }
    const householdTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) = 'household'")
      .get();
    if (!householdTable) {
      snapshotError("备份数据库文件不是有效的 MMH 账簿数据");
    }
  } finally {
    db?.close();
  }
}

export async function restoreSqliteSnapshotBuffer(
  bytes: Buffer,
  onProgress?: (progress: RestoreSqliteSnapshotProgress) => void,
): Promise<{ transactionCount: number }> {
  const livePath = sqliteDatabasePath();
  const liveDir = path.dirname(livePath);
  fs.mkdirSync(liveDir, { recursive: true });

  const tmpPath = path.join(liveDir, `.mmh-restore-${crypto.randomUUID()}.db`);
  const preRestorePath = path.join(liveDir, `.mmh-pre-restore-${Date.now()}.db`);
  let swapped = false;

  fs.writeFileSync(tmpPath, bytes, { mode: 0o600 });
  onProgress?.({
    stage: "restoring",
    percent: 52,
    label: "校验备份",
    detail: "正在校验备份数据库文件完整性",
  });

  try {
    validateSqliteSnapshotFile(tmpPath);
    onProgress?.({
      stage: "restoring",
      percent: 60,
      label: "替换数据库",
      detail: "正在切换到备份时点的数据库文件",
    });

    await prisma.$disconnect();

    try {
      if (fs.existsSync(livePath)) {
        fs.copyFileSync(livePath, preRestorePath);
      }
      for (const sidecar of sidecarPaths(livePath)) {
        fs.rmSync(sidecar, { force: true });
      }
      fs.rmSync(livePath, { force: true });
      fs.renameSync(tmpPath, livePath);
      swapped = true;
    } finally {
      await prisma.$connect();
      fs.rmSync(tmpPath, { force: true });
    }
  } catch (error) {
    if (!swapped && fs.existsSync(preRestorePath) && !fs.existsSync(livePath)) {
      fs.copyFileSync(preRestorePath, livePath);
    }
    throw error;
  } finally {
    fs.rmSync(preRestorePath, { force: true });
  }

  onProgress?.({
    stage: "restoring",
    percent: 88,
    label: "读取恢复结果",
    detail: "正在确认恢复后的账簿数据",
  });

  let transactionCount = 0;
  try {
    transactionCount = await prisma.txRecord.count();
  } catch {
    transactionCount = 0;
  }

  onProgress?.({
    stage: "done",
    percent: 100,
    label: "恢复完成",
    detail: "整库数据已恢复到备份时点",
  });

  return { transactionCount };
}
