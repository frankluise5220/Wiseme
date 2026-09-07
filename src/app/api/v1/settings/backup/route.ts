import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { verifyPassword } from "@/lib/auth/password";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getCurrentUser, isAdmin, type CurrentUser } from "@/lib/server/auth";
import {
  buildBackupFileName,
  buildHouseholdBackupPayload,
  buildHouseholdTableExportWorkbook,
  buildTableExportFileName,
  decryptBackupBytes,
  decryptBackupPackage,
  encryptBackupBytes,
  encryptBackupPayload,
  ensureSqliteRestoreCompatibilitySchema,
  restoreHouseholdBackup,
  type RestoreHouseholdBackupProgress,
} from "@/lib/server/backup";
import {
  createSqliteSnapshotBuffer,
  isSqliteFileDatabase,
  restoreSqliteSnapshotBuffer,
} from "@/lib/server/sqlite-snapshot";

export const runtime = "nodejs";
const RESTORE_UPLOAD_LIMIT_BYTES = 128 * 1024 * 1024;
const RESTORE_TASK_TTL_MS = 60 * 60 * 1000;

type RestoreTaskState = "queued" | "running" | "success" | "error";
type RestoreFallbackAdmin = {
  name: string;
  role: string;
  isSystem: boolean;
  email?: string | null;
  passwordHash?: string | null;
} | null;
type RestoreTask = {
  id: string;
  householdId: string;
  userId: string;
  status: RestoreTaskState;
  progress: RestoreHouseholdBackupProgress;
  summary?: {
    householdName: string;
    counts: { transactions: number };
  };
  error?: string;
  createdAt: number;
  updatedAt: number;
};

declare global {
  var __mmhRestoreTasks: Map<string, RestoreTask> | undefined;
  var __mmhActiveRestoreHouseholds: Set<string> | undefined;
}

const restoreTasks = globalThis.__mmhRestoreTasks ??= new Map<string, RestoreTask>();
const activeRestoreHouseholds = globalThis.__mmhActiveRestoreHouseholds ??= new Set<string>();

function restoreProgress(
  progress: RestoreHouseholdBackupProgress,
): RestoreHouseholdBackupProgress {
  return {
    stage: progress.stage,
    percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
    label: progress.label,
    detail: progress.detail,
  };
}

function cleanupRestoreTasks() {
  const cutoff = Date.now() - RESTORE_TASK_TTL_MS;
  for (const [id, task] of restoreTasks) {
    if (task.updatedAt < cutoff && task.status !== "running" && task.status !== "queued") {
      restoreTasks.delete(id);
    }
  }
}

function updateRestoreTask(task: RestoreTask, patch: Partial<Omit<RestoreTask, "id" | "createdAt">>) {
  Object.assign(task, patch, { updatedAt: Date.now() });
}

function publicRestoreTask(task: RestoreTask) {
  return {
    id: task.id,
    status: task.status,
    progress: task.progress,
    summary: task.summary,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function runRestoreTask(
  task: RestoreTask,
  encryptedText: string,
  passphrase: string,
  fallbackAdmin: RestoreFallbackAdmin,
) {
  let rawText: string | null = encryptedText;
  let rawPayload: unknown = null;
  let payload: unknown = null;
  let packagePassphrase = passphrase;

  try {
    updateRestoreTask(task, {
      status: "running",
      progress: restoreProgress({
        stage: "preparing",
        percent: 36,
        label: "解析备份",
        detail: "备份文件已上传，正在读取加密包",
      }),
    });

    rawPayload = JSON.parse(rawText ?? "");
    rawText = null;

    const rawObject = rawPayload as Record<string, unknown> | null;
    const packageType = String(rawObject?.packageType ?? "");
    const scopeName = String(
      (rawObject?.scope as Record<string, unknown> | undefined)?.householdName ?? "当前账簿",
    );

    if (packageType === "encrypted-sqlite-backup") {
      updateRestoreTask(task, {
        progress: restoreProgress({
          stage: "preparing",
          percent: 44,
          label: "解密整库备份",
          detail: "正在验证口令并解密数据库文件",
        }),
      });

      const bytes = await decryptBackupBytes(rawPayload, { passphrase: packagePassphrase });
      rawPayload = null;
      packagePassphrase = "";

      const result = await restoreSqliteSnapshotBuffer(bytes, (progress) => {
        updateRestoreTask(task, { progress: restoreProgress(progress) });
      });

      // The snapshot carries the schema of the system that created it. An
      // older backup (for example from 0.1.31) lacks columns added by newer
      // releases, so backfill the live schema in-process right after the file
      // swap; otherwise the running app queries fail until the next restart.
      await ensureSqliteRestoreCompatibilitySchema();

      updateRestoreTask(task, {
        status: "success",
        summary: {
          householdName: scopeName,
          counts: { transactions: result.transactionCount },
        },
        progress: restoreProgress({
          stage: "done",
          percent: 100,
          label: "恢复完成",
          detail: "数据已恢复到备份时点，页面即将刷新",
        }),
      });
      return;
    }

    updateRestoreTask(task, {
      progress: restoreProgress({
        stage: "preparing",
        percent: 42,
        label: "解密备份",
        detail: "正在验证口令并解密备份内容",
      }),
    });

    payload = await decryptBackupPackage(rawPayload, { passphrase: packagePassphrase });
    rawPayload = null;
    packagePassphrase = "";

    const summary = await restoreHouseholdBackup(payload, {
      householdId: task.householdId,
      fallbackAdmin,
      onProgress: (progress) => {
        updateRestoreTask(task, { progress: restoreProgress(progress) });
      },
    });
    payload = null;

    updateRestoreTask(task, {
      status: "success",
      summary,
      progress: restoreProgress({
        stage: "done",
        percent: 100,
        label: "恢复完成",
        detail: "数据已恢复，页面即将刷新",
      }),
    });
  } catch (error) {
    console.error("Backup restore failed", error);
    updateRestoreTask(task, {
      status: "error",
      error: restoreFailureMessage(error),
      progress: restoreProgress({
        stage: "done",
        percent: task.progress.percent,
        label: "恢复失败",
        detail: restoreFailureMessage(error),
      }),
    });
  } finally {
    rawText = null;
    rawPayload = null;
    payload = null;
    packagePassphrase = "";
    activeRestoreHouseholds.delete(task.householdId);
  }
}

function requireAdmin(user: Awaited<ReturnType<typeof getCurrentUser>>) {
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "ADMIN_REQUIRED", error: "仅管理员可执行备份或恢复" }, { status: 403 });
  }
  return null;
}

function requireSignedIn(user: Awaited<ReturnType<typeof getCurrentUser>>) {
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }
  return null;
}

function encodeRfc5987Value(value: string) {
  return encodeURIComponent(value).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function asciiHeaderFileName(fileName: string) {
  const fallback = fileName
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]+/g, "-")
    .replace(/["\\;]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (fallback && /[A-Za-z0-9]/.test(fallback)) return fallback;
  return "mmh-backup.mmhbackup";
}

function attachmentDisposition(fileName: string) {
  return `attachment; filename="${asciiHeaderFileName(fileName)}"; filename*=UTF-8''${encodeRfc5987Value(fileName)}`;
}

async function verifySensitiveOperationPassword(currentUser: CurrentUser, userPassword: string) {
  const password = userPassword.trim();
  if (!password) {
    return NextResponse.json({ ok: false, code: "MISSING_PASSWORD", error: "请输入用户密码" }, { status: 400 });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: currentUser.id },
    select: { passwordHash: true },
  });
  if (!dbUser) {
    return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "当前用户不存在，请重新登录" }, { status: 401 });
  }

  if (dbUser.passwordHash) {
    const matched = await verifyPassword(password, dbUser.passwordHash);
    if (!matched) {
      return NextResponse.json({ ok: false, code: "INVALID_PASSWORD", error: "用户密码错误" }, { status: 401 });
    }
    return null;
  }

  return NextResponse.json({ ok: false, code: "PASSWORD_NOT_SET", error: "请先设置用户密码" }, { status: 400 });
}

function getCredentialsFromJson(value: unknown): {
  userPassword: string;
  backupScope: "system" | "household";
  backupPassphrase: string;
} {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    userPassword: String(body.userPassword ?? body.password ?? ""),
    backupScope: String(body.backupScope ?? body.scope ?? "household") === "system" ? "system" : "household",
    backupPassphrase: String(
      body.backupPassphrase ??
      body.backupPassword ??
      body.encryptionPassphrase ??
      body.encryptionInfo ??
      "",
    ),
  };
}

function restoreFailureMessage(error: unknown) {
  if (error instanceof SyntaxError) {
    return "备份文件不是有效的 MMH 加密备份，请重新选择 .mmhbackup 文件";
  }
  return error instanceof Error ? error.message : "恢复失败";
}

/**
 * GET /api/v1/settings/backup
 *
 * Response:
 * - `?mode=restore-status&id=<restoreId>` returns `{ ok: true, task }`
 * - `{ ok: false, error }`
 *
 * Use `POST ?mode=export` to export an encrypted restore package.
 * Use `POST ?mode=table-export` to export a non-restorable Excel workbook.
 */
export async function GET(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }
  cleanupRestoreTasks();
  const mode = req.nextUrl.searchParams.get("mode");
  if (mode === "restore-status") {
    const id = String(req.nextUrl.searchParams.get("id") ?? "");
    const task = restoreTasks.get(id);
    if (!task) {
      return NextResponse.json({ ok: false, code: "RESTORE_TASK_NOT_FOUND", error: "恢复任务不存在或已过期" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, task: publicRestoreTask(task) });
  }
  return NextResponse.json({ ok: false, code: "METHOD_NOT_ALLOWED", error: "请使用 POST 导出备份、导出表格或恢复备份" }, { status: 405 });
}

async function exportBackupPackage(req: NextRequest) {
  try {
    const currentUser = await getCurrentUser();
    const denied = requireSignedIn(currentUser);
    if (denied) return denied;
    if (!currentUser) {
      return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
    }

    const credentials = getCredentialsFromJson(await req.json().catch(() => null));
    const credentialDenied = await verifySensitiveOperationPassword(currentUser, credentials.userPassword);
    if (credentialDenied) return credentialDenied;

    const { householdId, user } = await getHouseholdScope();
    const household = await prisma.household.findUnique({ where: { id: householdId } });
    const householdName = household?.name ?? "默认";
    const exportedAt = new Date();
    const passphrase = credentials.backupPassphrase.trim() || credentials.userPassword;
    const backupScope = credentials.backupScope;
    if (backupScope === "system" && !isAdmin(currentUser)) {
      return NextResponse.json(
        { ok: false, code: "SYSTEM_BACKUP_ADMIN_REQUIRED", error: "Only administrators can create a system backup." },
        { status: 403 },
      );
    }

    if (isSqliteFileDatabase() && backupScope === "system") {
      const snapshotBytes = await createSqliteSnapshotBuffer();
      const encryptedPayload = await encryptBackupBytes(
        snapshotBytes,
        { householdId, householdName, backupScope: "system" },
        exportedAt,
        { passphrase },
      );
      const fileName = buildBackupFileName(householdName, exportedAt, "mmhbackup");
      return new Response(JSON.stringify(encryptedPayload, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": attachmentDisposition(fileName),
          "Cache-Control": "no-store",
        },
      });
    }

    const payload = await buildHouseholdBackupPayload(
      householdId,
      user ? { id: user.id, name: user.name, role: user.role } : null,
      { backupScope },
    );
    const encryptedPayload = await encryptBackupPayload(payload, { passphrase });
    const fileName = buildBackupFileName(payload.scope.householdName, payload.exportedAt, "mmhbackup");
    return new Response(JSON.stringify(encryptedPayload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": attachmentDisposition(fileName),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Backup export failed", error);
    const message = error instanceof Error ? error.message : "备份失败";
    return NextResponse.json({ ok: false, code: "EXPORT_FAILED", error: message }, { status: 500 });
  }
}

async function exportTableWorkbook() {
  try {
    const currentUser = await getCurrentUser();
    const denied = requireSignedIn(currentUser);
    if (denied) return denied;

    const { householdId, user } = await getHouseholdScope();
    const payload = await buildHouseholdBackupPayload(
      householdId,
      user ? { id: user.id, name: user.name, role: user.role } : null,
      { ensureBackupPackageKey: false, backupScope: isAdmin(currentUser) ? "system" : "household" },
    );

    const workbook = await buildHouseholdTableExportWorkbook(payload);
    const fileName = buildTableExportFileName(payload.scope.householdName, payload.exportedAt);
    return new Response(new Uint8Array(workbook), {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": attachmentDisposition(fileName),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Table export failed", error);
    const message = error instanceof Error ? error.message : "导出表格失败";
    return NextResponse.json({ ok: false, code: "EXPORT_FAILED", error: message }, { status: 500 });
  }
}

/**
 * POST /api/v1/settings/backup
 *
 * Export or restore the current household backup package.
 *
 * Export:
 * - `POST /api/v1/settings/backup?mode=export`
 * - JSON body: `{ userPassword, backupPassphrase?, backupScope?: "system" | "household" }`
 * - `userPassword` verifies the current logged-in user before exporting
 * - `backupScope: "system"` requires an administrator; other authenticated users are limited to `"household"`
 * - `backupPassphrase` optionally encrypts the backup package; when omitted, `userPassword` is used
 * - returns an encrypted `.mmhbackup` package.
 *
 * Table export:
 * - `POST /api/v1/settings/backup?mode=table-export`
 * - no request body
 * - returns a non-restorable `.xlsx` workbook for manual data processing.
 *
 * Restore:
 * - `POST /api/v1/settings/backup`
 * - multipart/form-data
 *   - `file`: the `.mmhbackup` encrypted package exported by this endpoint
 *   - `userPassword`: current user's password, verified before destructive restore
 *   - `backupPassphrase`: optional backup package encryption passphrase; when omitted, `userPassword` is used
 * - starts a background restore task and returns `{ ok: true, restoreId, task }`
 * - poll `GET /api/v1/settings/backup?mode=restore-status&id=<restoreId>` until `task.status` is `success` or `error`
 *
 * Response:
 * - `{ ok: true, restoreId, task }`
 * - `{ ok: false, error }`
 */
export async function POST(req: NextRequest) {
  cleanupRestoreTasks();
  const mode = req.nextUrl.searchParams.get("mode");
  if (mode === "export") {
    return exportBackupPackage(req);
  }
  if (mode === "table-export") {
    return exportTableWorkbook();
  }

  const currentUser = await getCurrentUser();
  const denied = requireAdmin(currentUser);
  if (denied) return denied;
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }

  const { householdId, user } = await getHouseholdScope();

  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > RESTORE_UPLOAD_LIMIT_BYTES) {
    return NextResponse.json(
      { ok: false, code: "FILE_TOO_LARGE", error: "备份文件超过 128MB，请拆分或清理过大的导入原文后重新备份" },
      { status: 413 },
    );
  }

  const form = await req.formData().catch(() => null);
  if (!form) {
    return NextResponse.json(
      { ok: false, code: "INVALID_UPLOAD", error: "备份文件上传不完整或超过恢复上传限制，请重新选择备份文件后再恢复" },
      { status: 400 },
    );
  }
  const file = form.get("file");
  const userPassword = String(form.get("userPassword") ?? form.get("password") ?? "");
  const backupPassphrase = String(
    form.get("backupPassphrase") ??
    form.get("backupPassword") ??
    form.get("encryptionPassphrase") ??
    form.get("encryptionInfo") ??
    "",
  );
  if (!(file instanceof File)) {
    return NextResponse.json({ ok: false, code: "MISSING_FILE", error: "请选择备份文件" }, { status: 400 });
  }
  const credentialDenied = await verifySensitiveOperationPassword(currentUser, userPassword);
  if (credentialDenied) return credentialDenied;

  const lowerFileName = file.name.toLowerCase();
  // Accept both the current `.mmhbackup` and the legacy `.mmh-backup` suffix
  // so previously exported backups can still be restored.
  if (!lowerFileName.endsWith(".mmhbackup") && !lowerFileName.endsWith(".mmh-backup")) {
    return NextResponse.json({ ok: false, code: "INVALID_FILE_TYPE", error: "恢复仅支持 MMH 加密备份（.mmhbackup）" }, { status: 400 });
  }

  if (activeRestoreHouseholds.has(householdId)) {
    return NextResponse.json({ ok: false, code: "RESTORE_ALREADY_RUNNING", error: "当前账簿已有恢复任务在执行，请等待完成后再重试" }, { status: 409 });
  }

  let encryptedText: string;
  try {
    encryptedText = await file.text();
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "INVALID_BACKUP_FILE", error: restoreFailureMessage(error) },
      { status: 400 },
    );
  }

  const dbUser = user
    ? await prisma.user.findUnique({
        where: { id: user.id },
        select: {
          name: true,
          role: true,
          isSystem: true,
          email: true,
          passwordHash: true,
        },
      })
    : null;

  const task: RestoreTask = {
    id: crypto.randomUUID(),
    householdId,
    userId: currentUser.id,
    status: "queued",
    progress: restoreProgress({
      stage: "preparing",
      percent: 35,
      label: "等待恢复",
      detail: "备份文件已上传，正在排队启动恢复任务",
    }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  restoreTasks.set(task.id, task);
  activeRestoreHouseholds.add(householdId);
  void runRestoreTask(task, encryptedText, backupPassphrase.trim() || userPassword, dbUser);
  encryptedText = "";

  return NextResponse.json(
    {
      ok: true,
      restoreId: task.id,
      task: publicRestoreTask(task),
      message: "恢复任务已开始",
    },
    { status: 202 },
  );
}
