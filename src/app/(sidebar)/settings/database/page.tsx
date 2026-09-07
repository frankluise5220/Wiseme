"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, RotateCcw, Shield, Upload, RefreshCw } from "lucide-react";
import {
  SettingsActionButton,
  SettingsEmptyRow,
  SettingsRowActions,
  SettingsTable,
  SettingsTd,
  SettingsTh,
} from "@/components/settings/SettingsPageScaffold";
import { generateRandomKey } from "@/lib/client/randomKey";
import {
  createLedgerInviteCodeRecord,
  parseLedgerInviteCodeRecords,
  serializeLedgerInviteCodeRecords,
  type LedgerInviteCodeRecord,
} from "@/lib/ledger-invite-codes";
import {
  isAccessHostnameAllowed,
  isDefaultAllowedAccessHostname,
  normalizeAccessHostname,
  normalizeAllowedAccessList,
  parseAllowedAccessList,
} from "@/lib/access-whitelist";
import { useI18n } from "@/lib/i18n";

type I18nT = (key: string, params?: Record<string, string | number>) => string;

const LEDGER_INVITE_CODE_KEY = "ledger_creation_invite_code";

type SaveFilePickerHandle = {
  name?: string;
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

type OpenFilePickerHandle = {
  getFile: () => Promise<File>;
};

const RESTORE_FILE_PICKER_TYPES = (t: I18nT) => [
  {
    description: t("settings.database.backupFilePickerDesc"),
    accept: {
      "application/json": [".mmhbackup"],
    },
  },
];

type WindowWithFilePickers = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<SaveFilePickerHandle>;
  showOpenFilePicker?: (options: {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<OpenFilePickerHandle[]>;
};

type BackupSaveResult = {
  fileName: string;
  pickedLocation: boolean;
};

type SensitiveOperationCredentials = {
  userPassword: string;
  backupPassphrase?: string;
  backupScope?: "system" | "household";
};

type SettingsValuesResult = {
  ok?: boolean;
  values?: Record<string, string | null>;
  error?: string;
};

type RestoreResponse = {
  ok?: boolean;
  error?: string;
  message?: string;
  restoreId?: string;
  task?: RestoreTask;
  summary?: { counts?: Record<string, number> };
};

type RestoreProgressStage = "idle" | "uploading" | "preparing" | "clearing" | "importing" | "restoring" | "finalizing" | "done";

type RestoreProgressState = {
  stage: RestoreProgressStage;
  percent: number;
  label: string;
  detail?: string;
};

type AutoBackupFrequencyType = "daily" | "weekly" | "interval";

type AutoBackupConfig = {
  enabled: boolean;
  frequencyType: AutoBackupFrequencyType;
  time: string;
  weekday: number;
  everyHours: number;
  scope: "system" | "household";
  path: string;
  keepCount: number;
};

type AutoBackupStatus = {
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastError: string | null;
  nextRunAt: string | null;
};

type AutoBackupDiskInfo = {
  freeBytes?: number;
  totalBytes?: number;
  free?: string;
};

type AutoBackupResponse = {
  ok?: boolean;
  error?: string;
  data?: {
    config?: AutoBackupConfig;
    status?: AutoBackupStatus;
    capabilities?: {
      systemBackup?: boolean;
      defaultDir?: string;
      defaultDisk?: AutoBackupDiskInfo | null;
    };
    disk?: AutoBackupDiskInfo | null;
    result?: { files?: string[] };
  };
};

function formatAutoBackupTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type RestoreTask = {
  id: string;
  status: "queued" | "running" | "success" | "error";
  progress?: RestoreProgressState;
  summary?: { counts?: Record<string, number> };
  error?: string;
};

const RESTORE_PROGRESS_IDLE: RestoreProgressState = {
  stage: "idle",
  percent: 0,
  label: "",
};

const RESTORE_STAGE_ORDER: Record<RestoreProgressStage, number> = {
  idle: -1,
  uploading: 0,
  preparing: 1,
  clearing: 2,
  importing: 3,
  restoring: 4,
  finalizing: 5,
  done: 6,
};

async function fetchJsonWithTimeout<T>(url: string, options: RequestInit & { timeoutMs?: number; t: I18nT }): Promise<T> {
  const { timeoutMs = 8000, t, ...fetchOptions } = options ?? {};
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null) as T | null;
    if (!res.ok || !data) {
      const maybeError = data as { error?: string } | null;
      throw new Error(maybeError?.error ?? t("settings.database.readFailedHttp", { status: res.status }));
    }
    return data;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(t("settings.database.readTimeout"));
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function filenameFromDisposition(value: string | null) {
  if (!value) return "";
  const encodedMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch?.[1]) {
    try {
      return decodeURIComponent(encodedMatch[1]);
    } catch {
      return encodedMatch[1];
    }
  }
  const match = value.match(/filename="([^"]+)"/i);
  return match?.[1] ?? "";
}

function parseOriginList(value: string | null | undefined) {
  return parseAllowedAccessList(value);
}

function getCurrentAccessHost() {
  if (typeof window === "undefined") return "";
  return normalizeAccessHostname(window.location.hostname);
}

function formatInviteDateTime(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function saveDataBackup(credentials: SensitiveOperationCredentials, t: I18nT): Promise<BackupSaveResult | null> {
  const res = await fetch("/api/v1/settings/backup?mode=export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userPassword: credentials.userPassword,
      backupPassphrase: credentials.backupPassphrase ?? "",
      backupScope: credentials.backupScope ?? "household",
    }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || t("settings.database.backupFailedHttp", { status: res.status }));
  }
  const blob = await res.blob();
  const fileName =
    filenameFromDisposition(res.headers.get("content-disposition")) ||
    `mmh-backup-${Date.now()}.mmhbackup`;
  const savePicker = (window as WindowWithFilePickers).showSaveFilePicker;
  if (savePicker) {
    try {
      const handle = await savePicker({
        suggestedName: fileName,
        types: [{ description: t("settings.database.backupFileDesc"), accept: { "application/json": [".mmhbackup"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { fileName: handle.name || fileName, pickedLocation: true };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      throw error;
    }
  }

  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
  return { fileName, pickedLocation: false };
}

async function saveDataTableExport(t: I18nT): Promise<BackupSaveResult | null> {
  const res = await fetch("/api/v1/settings/backup?mode=table-export", {
    method: "POST",
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error || t("settings.database.exportFailedHttp", { status: res.status }));
  }
  const blob = await res.blob();
  const fileName =
    filenameFromDisposition(res.headers.get("content-disposition")) ||
    `mmh-table-export-${Date.now()}.xlsx`;
  const savePicker = (window as WindowWithFilePickers).showSaveFilePicker;
  if (savePicker) {
    try {
      const handle = await savePicker({
        suggestedName: fileName,
        types: [
          {
            description: t("settings.database.tableExportDesc"),
            accept: {
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
            },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { fileName: handle.name || fileName, pickedLocation: true };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return null;
      throw error;
    }
  }

  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
  return { fileName, pickedLocation: false };
}

function parseRestoreResponseText(value: string) {
  try {
    return JSON.parse(value) as RestoreResponse;
  } catch {
    return null;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function normalizeRestoreProgress(progress: RestoreProgressState | undefined, fallback: RestoreProgressState) {
  if (!progress) return fallback;
  return {
    stage: progress.stage,
    percent: Math.max(fallback.percent, Math.max(0, Math.min(100, Math.round(progress.percent)))),
    label: progress.label || fallback.label,
    detail: progress.detail,
  };
}

async function pollRestoreTask(
  restoreId: string,
  onProgress: (progress: RestoreProgressState) => void,
  t: I18nT,
): Promise<RestoreResponse> {
  const deadline = Date.now() + 30 * 60 * 1000;
  let failedPolls = 0;
  let lastProgress: RestoreProgressState = {
    stage: "preparing",
    percent: 35,
    label: t("settings.database.waitingRestore"),
    detail: t("settings.database.waitingRestoreDetail"),
  };

  while (Date.now() < deadline) {
    await delay(1000);
    try {
      const res = await fetch(
        `/api/v1/settings/backup?mode=restore-status&id=${encodeURIComponent(restoreId)}`,
        { cache: "no-store" },
      );
      const data = (await res.json().catch(() => null)) as RestoreResponse | null;
      if (!res.ok || !data?.ok || !data.task) {
        throw new Error(data?.error || t("settings.database.restoreStatusFailedHttp", { status: res.status }));
      }
      failedPolls = 0;
      lastProgress = normalizeRestoreProgress(data.task.progress, lastProgress);
      onProgress(lastProgress);

      if (data.task.status === "success") {
        return {
          ok: true,
          message: t("settings.database.restoreComplete"),
          summary: data.task.summary,
          task: data.task,
          restoreId,
        };
      }
      if (data.task.status === "error") {
        throw new Error(data.task.error || data.task.progress?.detail || t("settings.database.restoreFailed"));
      }
    } catch (error) {
      failedPolls += 1;
      if (failedPolls >= 5) {
        throw error instanceof Error ? error : new Error(t("settings.database.restoreQueryFailed"));
      }
      onProgress({
        ...lastProgress,
        detail: t("settings.database.waitingServerDetail"),
      });
    }
  }

  throw new Error(t("settings.database.restoreTimeout"));
}

function restoreDataBackup(
  form: FormData,
  onProgress: (progress: RestoreProgressState) => void,
  t: I18nT,
): Promise<RestoreResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        const uploadPercent = Math.max(3, Math.min(35, Math.round((event.loaded / event.total) * 35)));
        onProgress({
          stage: "uploading",
          percent: uploadPercent,
          label: t("settings.database.uploadingPercent", { percent: Math.round((event.loaded / event.total) * 100) }),
          detail: t("settings.database.uploadingDetail"),
        });
        return;
      }
      onProgress({
        stage: "uploading",
        percent: 8,
        label: t("settings.database.uploading"),
        detail: t("settings.database.uploadingDetail"),
      });
    };

    xhr.upload.onload = () => {
      onProgress({
        stage: "preparing",
        percent: 35,
        label: t("settings.database.waitingServer"),
        detail: t("settings.database.creatingRestoreTask"),
      });
    };

    xhr.onload = async () => {
      const data = parseRestoreResponseText(xhr.responseText);
      if (xhr.status < 200 || xhr.status >= 300 || !data?.ok) {
        reject(new Error(data?.error || t("settings.database.restoreFailedHttp", { status: xhr.status })));
        return;
      }
      const restoreId = data.restoreId || data.task?.id;
      if (!restoreId) {
        reject(new Error(t("settings.database.noRestoreId")));
        return;
      }
      if (data.task?.progress) {
        onProgress(normalizeRestoreProgress(data.task.progress, {
          stage: "preparing",
          percent: 35,
          label: t("settings.database.waitingRestore"),
        }));
      }
      try {
        resolve(await pollRestoreTask(restoreId, onProgress, t));
      } catch (error) {
        reject(error);
      }
    };

    xhr.onerror = () => {
      reject(new Error(t("settings.database.networkErrorRetry")));
    };
    xhr.onabort = () => {
      reject(new Error(t("settings.database.restoreCancelled")));
    };

    onProgress({
      stage: "uploading",
      percent: 3,
      label: t("settings.database.uploading"),
      detail: t("settings.database.preparingUpload"),
    });
    xhr.open("POST", "/api/v1/settings/backup");
    xhr.send(form);
  });
}

function RestoreProgressView({ progress }: { progress: RestoreProgressState }) {
  const { t } = useI18n();
  if (progress.stage === "idle") return null;

  const activeIndex = RESTORE_STAGE_ORDER[progress.stage];
  const steps: Array<{ stage: RestoreProgressStage; label: string }> = [
    { stage: "uploading", label: t("settings.database.stageUpload") },
    { stage: "preparing", label: t("settings.database.stagePrepare") },
    { stage: "clearing", label: t("settings.database.stageClear") },
    { stage: "importing", label: t("settings.database.stageImport") },
    { stage: "restoring", label: t("settings.database.stageRestore") },
    { stage: "finalizing", label: t("settings.database.stageFinalize") },
  ];

  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <div className="min-w-0 font-medium text-slate-700">{progress.label}</div>
        <div className="shrink-0 tabular-nums text-slate-500">{progress.percent}%</div>
      </div>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-label={progress.label}
      >
        <div
          className="h-full rounded-full bg-blue-500 transition-all duration-300"
          style={{ width: `${progress.percent}%` }}
        />
      </div>
      <div className="mt-2 grid grid-cols-6 gap-1 text-[11px]">
        {steps.map((step) => {
          const stepIndex = RESTORE_STAGE_ORDER[step.stage];
          const active = activeIndex === stepIndex;
          const passed = activeIndex > stepIndex;
          return (
            <div
              key={step.stage}
              className={
                active || passed
                  ? "truncate rounded bg-blue-50 px-2 py-1 text-center font-medium text-blue-700"
                  : "truncate rounded bg-white px-2 py-1 text-center text-slate-400"
              }
            >
              {step.label}
            </div>
          );
        })}
      </div>
      {progress.detail ? <div className="mt-2 text-[11px] text-slate-500">{progress.detail}</div> : null}
    </div>
  );
}

export default function DatabaseSettingsPage() {
  const { t } = useI18n();
  const restoreFileInputRef = useRef<HTMLInputElement | null>(null);
  const [origins, setOrigins] = useState<string[]>([]);
  const [originsLoading, setOriginsLoading] = useState(false);
  const [newOrigin, setNewOrigin] = useState("");
  const [originCheckEnabled, setOriginCheckEnabled] = useState(false);
  const [originMessage, setOriginMessage] = useState("");
  const [originError, setOriginError] = useState("");
  const [ledgerInviteCode, setLedgerInviteCode] = useState("");
  const [ledgerInviteRecords, setLedgerInviteRecords] = useState<LedgerInviteCodeRecord[]>([]);
  const [ledgerInviteLoading, setLedgerInviteLoading] = useState(false);
  const [ledgerInviteSaving, setLedgerInviteSaving] = useState(false);
  const [ledgerInviteMessage, setLedgerInviteMessage] = useState("");
  const [ledgerInviteError, setLedgerInviteError] = useState("");

  const [backuping, setBackuping] = useState(false);
  const [tableExporting, setTableExporting] = useState(false);
  const [backupMessage, setBackupMessage] = useState("");
  const [backupError, setBackupError] = useState("");
  const [backupUserPassword, setBackupUserPassword] = useState("");
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupCrossEnvironment, setBackupCrossEnvironment] = useState(false);
  const [backupScope, setBackupScope] = useState<"system" | "household">("household");
  const [canBackupSystem, setCanBackupSystem] = useState(false);
  const [backupPasswordDialogOpen, setBackupPasswordDialogOpen] = useState(false);

  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreUserPassword, setRestoreUserPassword] = useState("");
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [restoreBackupScope, setRestoreBackupScope] = useState<"system" | "household" | null>(null);
  const [restoreConfirmSystemOverwrite, setRestoreConfirmSystemOverwrite] = useState(false);
  const [restorePasswordDialogOpen, setRestorePasswordDialogOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState("");
  const [restoreError, setRestoreError] = useState("");
  const [restoreProgress, setRestoreProgress] = useState<RestoreProgressState>(RESTORE_PROGRESS_IDLE);

  const [resetDbPassword, setResetDbPassword] = useState("");
  const [resetPasswordDialogOpen, setResetPasswordDialogOpen] = useState(false);
  const [resetError, setResetError] = useState("");
  const [resetting, setResetting] = useState(false);

  const [cacheRefreshing, setCacheRefreshing] = useState(false);
  const [cacheRefreshMessage, setCacheRefreshMessage] = useState("");
  const [cacheRefreshError, setCacheRefreshError] = useState("");

  const [autoBackup, setAutoBackup] = useState<AutoBackupConfig | null>(null);
  const [autoBackupStatus, setAutoBackupStatus] = useState<AutoBackupStatus | null>(null);
  const [autoBackupSystemSupported, setAutoBackupSystemSupported] = useState(true);
  const [autoBackupDefaultDir, setAutoBackupDefaultDir] = useState("");
  const [autoBackupDisk, setAutoBackupDisk] = useState<AutoBackupDiskInfo | null>(null);
  const [autoBackupLoading, setAutoBackupLoading] = useState(true);
  const [autoBackupSaving, setAutoBackupSaving] = useState(false);
  const [autoBackupRunning, setAutoBackupRunning] = useState(false);
  const [autoBackupMessage, setAutoBackupMessage] = useState("");
  const [autoBackupError, setAutoBackupError] = useState("");

  const canBackup = !backuping && !tableExporting && !restoring;
  const canTableExport = !backuping && !tableExporting && !restoring;
  const canRestore = useMemo(
    () => Boolean(restoreFile) && !restoring,
    [restoreFile, restoring],
  );
  const sortedLedgerInviteRecords = useMemo(
    () => [...ledgerInviteRecords].sort((a, b) => {
      if (Boolean(a.usedAt) !== Boolean(b.usedAt)) return a.usedAt ? 1 : -1;
      return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
    }),
    [ledgerInviteRecords],
  );

  useEffect(() => {
    void loadDatabaseSettings();
  }, []);

  useEffect(() => {
    void loadAutoBackupSettings();
  }, []);

  async function loadAutoBackupSettings() {
    setAutoBackupLoading(true);
    setAutoBackupError("");
    setAutoBackupMessage("");
    try {
      const res = await fetch("/api/v1/settings/backup/auto", { cache: "no-store" });
      const data = await res.json().catch(() => null) as AutoBackupResponse | null;
      if (!res.ok || !data?.ok || !data.data) {
        throw new Error(data?.error ?? t("settings.autoBackup.loadFailed", { error: String(res.status) }));
      }
      const capabilities = data.data.capabilities;
      const systemSupported = capabilities?.systemBackup !== false;
      setAutoBackupSystemSupported(systemSupported);
      setAutoBackupDefaultDir(capabilities?.defaultDir ?? "");
      setAutoBackupDisk(capabilities?.defaultDisk ?? null);
      const config = data.data.config;
      if (config) {
        setAutoBackup({
          enabled: config.enabled,
          frequencyType: config.frequencyType,
          time: config.time,
          weekday: config.weekday,
          everyHours: config.everyHours,
          scope: systemSupported ? config.scope : "household",
          path: config.path,
          keepCount: config.keepCount,
        });
      } else {
        setAutoBackup({
          enabled: false,
          frequencyType: "daily",
          time: "02:00",
          weekday: 1,
          everyHours: 24,
          scope: systemSupported ? "system" : "household",
          path: "",
          keepCount: 7,
        });
      }
      setAutoBackupStatus(data.data.status ?? null);
    } catch (error) {
      setAutoBackupError(error instanceof Error ? error.message : t("settings.autoBackup.loadFailed", { error: "" }));
    } finally {
      setAutoBackupLoading(false);
    }
  }

  async function saveAutoBackupSettings() {
    if (!autoBackup) return;
    setAutoBackupSaving(true);
    setAutoBackupError("");
    setAutoBackupMessage("");
    try {
      const res = await fetch("/api/v1/settings/backup/auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: autoBackup }),
      });
      const data = await res.json().catch(() => null) as AutoBackupResponse | null;
      if (!res.ok || !data?.ok || !data.data) {
        throw new Error(data?.error ?? t("settings.autoBackup.saveFailed", { error: String(res.status) }));
      }
      const saved = data.data.config;
      if (saved) {
        setAutoBackup({ ...autoBackup, ...saved, scope: autoBackupSystemSupported ? saved.scope : "household" });
      }
      setAutoBackupStatus(data.data.status ?? null);
      setAutoBackupDisk(data.data.disk ?? null);
      setAutoBackupMessage(t("settings.autoBackup.saved"));
    } catch (error) {
      setAutoBackupError(error instanceof Error ? error.message : t("settings.autoBackup.saveFailed", { error: "" }));
    } finally {
      setAutoBackupSaving(false);
    }
  }

  async function runAutoBackupNow() {
    setAutoBackupRunning(true);
    setAutoBackupError("");
    setAutoBackupMessage("");
    try {
      const res = await fetch("/api/v1/settings/backup/auto?action=run-now", { method: "POST" });
      const data = await res.json().catch(() => null) as AutoBackupResponse | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? t("settings.autoBackup.runNowFailed", { error: String(res.status) }));
      }
      setAutoBackupStatus(data.data?.status ?? null);
      const files = data.data?.result?.files;
      if (files && files.length > 0) {
        setAutoBackupMessage(t("settings.autoBackup.runNowResult", { files: files.join(", ") }));
      } else {
        setAutoBackupMessage(t("settings.autoBackup.runNowResult", { files: t("settings.autoBackup.lastRunNone") }));
      }
    } catch (error) {
      setAutoBackupError(error instanceof Error ? error.message : t("settings.autoBackup.runNowFailed", { error: "" }));
    } finally {
      setAutoBackupRunning(false);
    }
  }

  async function loadDatabaseSettings() {
    setOriginsLoading(true);
    setLedgerInviteLoading(true);
    setLedgerInviteError("");
    setOriginMessage("");
    setOriginError("");
    try {
      const permissionResponse = await fetch("/api/v1/households", { cache: "no-store" });
      const permissionData = await permissionResponse.json().catch(() => null) as { canBackupSystem?: boolean } | null;
      setCanBackupSystem(permissionData?.canBackupSystem === true);
    } catch {
      setCanBackupSystem(false);
    }
    try {
      const keys = ["allowed_dev_origins", "origin_check_enabled"].join(",");
      const data = await fetchJsonWithTimeout<SettingsValuesResult>(
        `/api/v1/settings/system?keys=${encodeURIComponent(keys)}`,
        { cache: "no-store", t },
      );
      if (!data.ok) {
        throw new Error(data.error ?? t("settings.database.readWhitelistFailed"));
      }
      const values = data.values ?? {};
      const parsedOrigins = parseOriginList(values.allowed_dev_origins);
      setOrigins(parsedOrigins);
      setOriginCheckEnabled(values.origin_check_enabled === "true" && parsedOrigins.length > 0);
    } catch (error) {
      setOrigins([]);
      setOriginCheckEnabled(false);
      setOriginError(error instanceof Error ? error.message : t("settings.database.readWhitelistFailed"));
    } finally {
      setOriginsLoading(false);
    }

    try {
      const data = await fetchJsonWithTimeout<SettingsValuesResult>(
        `/api/v1/settings/system?keys=${encodeURIComponent(LEDGER_INVITE_CODE_KEY)}`,
        { cache: "no-store", timeoutMs: 12_000, t },
      );
      if (!data.ok) {
        throw new Error(data.error ?? t("settings.database.readInviteFailed"));
      }
      const values = data.values ?? {};
      setLedgerInviteRecords(parseLedgerInviteCodeRecords(values[LEDGER_INVITE_CODE_KEY]));
      setLedgerInviteCode("");
    } catch (error) {
      setLedgerInviteRecords([]);
      setLedgerInviteError(error instanceof Error ? error.message : t("settings.database.readInviteFailed"));
    } finally {
      setLedgerInviteLoading(false);
    }
  }

  async function saveLedgerInviteRecords(nextRecords: LedgerInviteCodeRecord[], successMessage: string) {
    setLedgerInviteSaving(true);
    setLedgerInviteError("");
    setLedgerInviteMessage("");
    try {
      const res = await fetch("/api/v1/settings/system", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: LEDGER_INVITE_CODE_KEY, value: serializeLedgerInviteCodeRecords(nextRecords) }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? t("settings.database.saveInviteFailed"));
      }
      const normalized = parseLedgerInviteCodeRecords(serializeLedgerInviteCodeRecords(nextRecords));
      setLedgerInviteRecords(normalized);
      setLedgerInviteCode("");
      setLedgerInviteMessage(normalized.length > 0 ? successMessage : t("settings.database.inviteDisabled"));
    } catch (error) {
      setLedgerInviteError(error instanceof Error ? error.message : t("settings.database.saveInviteFailed"));
    } finally {
      setLedgerInviteSaving(false);
    }
  }

  async function addLedgerInviteCode() {
    const code = ledgerInviteCode.trim();
    if (!code) {
      setLedgerInviteError(t("settings.database.enterInviteCode"));
      return;
    }
    if (ledgerInviteRecords.some((record) => record.code === code)) {
      setLedgerInviteError(t("settings.database.inviteExists"));
      return;
    }
    await saveLedgerInviteRecords([...ledgerInviteRecords, createLedgerInviteCodeRecord(code)], t("settings.database.inviteAdded"));
  }

  async function removeLedgerInviteCode(code: string) {
    const nextRecords = ledgerInviteRecords.filter((item) => item.code !== code);
    await saveLedgerInviteRecords(nextRecords, t("settings.database.inviteDeleted"));
  }

  async function saveSystemSetting(key: string, value: string) {
    const res = await fetch("/api/v1/settings/system", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, value }),
    });
    const raw = await res.text().catch(() => "");
    let data: { ok?: boolean; error?: string } | null = null;
    try {
      data = raw ? JSON.parse(raw) as { ok?: boolean; error?: string } : null;
    } catch {
      data = null;
    }
    if (!res.ok || !data?.ok) {
      if (res.status === 403 && raw.includes("Access Denied")) {
        throw new Error(t("settings.database.whitelistAccessDenied"));
      }
      throw new Error(data?.error ?? t("settings.accounts.saveFailed"));
    }
  }

  async function saveOrigins(list: string[]) {
    const normalized = normalizeAllowedAccessList(list);
    try {
      await saveSystemSetting("allowed_dev_origins", JSON.stringify(normalized));
      setOriginError("");
      return true;
    } catch (error) {
      setOriginError(error instanceof Error ? error.message : t("settings.database.saveWhitelistFailed"));
      return false;
    }
  }

  async function toggleOriginCheck(enabled: boolean) {
    setOriginMessage("");
    setOriginError("");
    const previous = originCheckEnabled;
    const previousOrigins = origins;
    let nextOrigins = origins;
    let autoAddedHost = "";
    if (enabled) {
      const currentHost = getCurrentAccessHost();
      if (
        currentHost &&
        !isDefaultAllowedAccessHostname(currentHost) &&
        !isAccessHostnameAllowed(currentHost, nextOrigins)
      ) {
        autoAddedHost = currentHost;
        nextOrigins = [...nextOrigins, currentHost];
        setOrigins(nextOrigins);
        const saved = await saveOrigins(nextOrigins);
        if (!saved) {
          setOrigins(previousOrigins);
          setOriginCheckEnabled(previous);
          return;
        }
      }
      if (nextOrigins.length === 0) {
        setOriginCheckEnabled(false);
        setOriginError(t("settings.database.whitelistNeedOrigin"));
        return;
      }
    }
    setOriginCheckEnabled(enabled);
    try {
      await saveSystemSetting("origin_check_enabled", String(enabled));
      setOriginMessage(
        enabled
          ? autoAddedHost
            ? t("settings.database.whitelistAutoAdded", { host: autoAddedHost })
            : t("settings.database.whitelistEnabled")
          : t("settings.database.whitelistDisabled"),
      );
    } catch (error) {
      setOriginCheckEnabled(previous);
      setOrigins(previousOrigins);
      setOriginError(error instanceof Error ? error.message : t("settings.database.saveWhitelistToggleFailed"));
    }
  }

  async function addOrigin() {
    setOriginMessage("");
    setOriginError("");
    const value = normalizeAccessHostname(newOrigin);
    if (!value) return;
    if (isDefaultAllowedAccessHostname(value)) {
      setNewOrigin("");
      setOriginMessage(t("settings.database.localhostDefault"));
      return;
    }
    if (origins.includes(value)) {
      setNewOrigin("");
      setOriginMessage(t("settings.database.originAlreadyListed"));
      return;
    }
    const previous = origins;
    const next = [...origins, value];
    setOrigins(next);
    setNewOrigin("");
    const saved = await saveOrigins(next);
    if (!saved) {
      setOrigins(previous);
      return;
    }
    setOriginMessage(originCheckEnabled ? t("settings.database.whitelistUpdated") : t("settings.database.whitelistUpdatedOnEnable"));
  }

  async function removeOrigin(index: number) {
    setOriginMessage("");
    setOriginError("");
    const previousOrigins = origins;
    const previousEnabled = originCheckEnabled;
    const next = origins.filter((_, i) => i !== index);
    if (next.length === 0 && originCheckEnabled) {
      setOrigins(next);
      setOriginCheckEnabled(false);
      try {
        await saveSystemSetting("origin_check_enabled", "false");
        const saved = await saveOrigins(next);
        if (!saved) {
          setOrigins(previousOrigins);
          return;
        }
        setOriginMessage(t("settings.database.whitelistCleared"));
      } catch (error) {
        setOrigins(previousOrigins);
        setOriginCheckEnabled(previousEnabled);
        setOriginError(error instanceof Error ? error.message : t("settings.database.closeWhitelistFailed"));
      }
      return;
    }
    const currentHost = getCurrentAccessHost();
    if (
      originCheckEnabled &&
      currentHost &&
      !isDefaultAllowedAccessHostname(currentHost) &&
      !isAccessHostnameAllowed(currentHost, next)
    ) {
      setOriginError(t("settings.database.cannotDeleteCurrentOrigin"));
      return;
    }
    setOrigins(next);
    const saved = await saveOrigins(next);
    if (!saved) {
      setOrigins(previousOrigins);
      setOriginCheckEnabled(previousEnabled);
      return;
    }
    setOriginMessage(t("settings.database.whitelistUpdated"));
  }

  function openBackupPasswordDialog() {
    setBackupUserPassword("");
    setBackupPassphrase("");
    setBackupCrossEnvironment(false);
    setBackupScope("household");
    setBackupError("");
    setBackupPasswordDialogOpen(true);
  }

  async function handleBackup() {
    const password = backupUserPassword.trim();
    if (!password) {
      setBackupError(t("settings.database.enterUserPassword"));
      return;
    }

    const passphrase = backupPassphrase.trim();
    if (backupCrossEnvironment && !passphrase) {
      setBackupError(t("settings.database.passphraseRequired"));
      return;
    }

    setBackuping(true);
    setBackupMessage("");
    setBackupError("");
    try {
      const result = await saveDataBackup({
        userPassword: password,
        backupPassphrase: passphrase,
        backupScope: canBackupSystem ? backupScope : "household",
      }, t);
      if (!result) return;
      setBackupPasswordDialogOpen(false);
      setBackupUserPassword("");
      setBackupPassphrase("");
      setBackupCrossEnvironment(false);
      setBackupScope("household");
      setBackupMessage(
        result.pickedLocation
          ? t("settings.database.backupSaved", { name: result.fileName })
          : t("settings.database.backupDownloading", { name: result.fileName }),
      );
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : t("settings.database.backupFailed"));
    } finally {
      setBackuping(false);
    }
  }

  async function handleTableExport() {
    setTableExporting(true);
    setBackupMessage("");
    setBackupError("");
    try {
      const result = await saveDataTableExport(t);
      if (!result) return;
      setBackupMessage(
        result.pickedLocation
          ? t("settings.database.exportSaved", { name: result.fileName })
          : t("settings.database.exportDownloading", { name: result.fileName }),
      );
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : t("settings.database.exportFailed"));
    } finally {
      setTableExporting(false);
    }
  }

  async function inspectBackupScope(file: File): Promise<"system" | "household"> {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { scope?: { backupScope?: unknown } };
      return parsed?.scope?.backupScope === "household" ? "household" : "system";
    } catch {
      return "system";
    }
  }

  async function applyRestoreFile(nextFile: File | null) {
    setRestoreFile(nextFile);
    setRestoreUserPassword("");
    setRestorePassphrase("");
    setRestoreBackupScope(nextFile ? await inspectBackupScope(nextFile) : null);
    setRestoreConfirmSystemOverwrite(false);
    setRestorePasswordDialogOpen(false);
    setRestoreError("");
    setRestoreMessage("");
    setRestoreProgress(RESTORE_PROGRESS_IDLE);
  }

  async function pickRestoreFile() {
    const openPicker = (window as WindowWithFilePickers).showOpenFilePicker;
    if (!openPicker) {
      restoreFileInputRef.current?.click();
      return;
    }

    try {
      const [handle] = await openPicker({
        multiple: false,
        types: RESTORE_FILE_PICKER_TYPES(t),
      });
      if (!handle) return;
      void applyRestoreFile(await handle.getFile());
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setRestoreError(error instanceof Error ? error.message : t("settings.database.selectBackupFailed"));
    }
  }

  function openRestorePasswordDialog() {
    if (!restoreFile) {
      setRestoreError(t("settings.database.selectBackupFile"));
      return;
    }
    setRestoreUserPassword("");
    setRestorePassphrase("");
    setRestoreConfirmSystemOverwrite(false);
    setRestoreError("");
    setRestoreProgress(RESTORE_PROGRESS_IDLE);
    setRestorePasswordDialogOpen(true);
  }

  async function handleRestore() {
    if (!restoreFile) {
      setRestoreError(t("settings.database.selectBackupFile"));
      return;
    }
    const password = restoreUserPassword.trim();
    if (!password) {
      setRestoreError(t("settings.database.enterCurrentPassword"));
      return;
    }
    if (restoreBackupScope === "system" && !restoreConfirmSystemOverwrite) {
      setRestoreError(t("settings.database.systemBackupConfirm"));
      return;
    }

    setRestoring(true);
    setRestoreError("");
    setRestoreMessage("");
    setRestoreProgress(RESTORE_PROGRESS_IDLE);
    try {
      const form = new FormData();
      form.append("file", restoreFile);
      form.append("userPassword", password);
      form.append("backupPassphrase", restorePassphrase.trim());
      const data = await restoreDataBackup(form, setRestoreProgress, t);
      const counts = data.summary?.counts;
      const summaryText = counts
        ? t("settings.database.restoreSummary", { accounts: counts.accounts ?? 0, transactions: counts.transactions ?? 0, categories: counts.categories ?? 0, institutions: counts.institutions ?? 0 })
        : t("settings.database.restoreDone");
      setRestoreMessage(`${summaryText} ${t("settings.database.pageWillRefresh")}`);
      setRestorePasswordDialogOpen(false);
      setRestoreUserPassword("");
      setRestorePassphrase("");
      setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      setRestoreProgress(RESTORE_PROGRESS_IDLE);
      setRestoreError(error instanceof Error ? error.message : t("settings.database.restoreFailed"));
    } finally {
      setRestoring(false);
    }
  }

  function openFactoryResetDialog() {
    setResetDbPassword("");
    setResetError("");
    setResetPasswordDialogOpen(true);
  }

  async function handleFactoryReset() {
    if (!resetDbPassword.trim()) {
      setResetError(t("settings.database.enterCurrentPassword"));
      return;
    }
    setResetting(true);
    setResetError("");
    try {
      const verifyRes = await fetch("/api/v1/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetDbPassword, verifySystem: true }),
      });
      const verifyData = await verifyRes.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!verifyRes.ok || !verifyData?.ok) {
        setResetError(verifyData?.error ?? t("settings.database.currentPasswordWrong"));
        return;
      }

      const res = await fetch("/api/v1/settings/factory-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetDbPassword }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (res.ok && data?.ok) {
        setResetPasswordDialogOpen(false);
        setResetDbPassword("");
        window.location.href = "/login";
      } else {
        setResetError(data?.error ?? t("settings.database.operationFailed"));
      }
    } catch {
      setResetError(t("settings.database.networkErrorRetry"));
    } finally {
      setResetting(false);
    }
  }

  async function handleCacheRefresh() {
    setCacheRefreshing(true);
    setCacheRefreshMessage("");
    setCacheRefreshError("");
    try {
      const res = await fetch("/api/v1/settings/revalidate", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || t("settings.database.refreshFailed"));
      }
      setCacheRefreshMessage(t("settings.database.cacheRefreshed"));
      setTimeout(() => window.location.href = "/", 800);
    } catch (e) {
      setCacheRefreshError(e instanceof Error ? e.message : t("settings.database.refreshFailed"));
    } finally {
      setCacheRefreshing(false);
    }
  }

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-800">{t("settings.database")}</h2>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-800">{t("settings.database.backupRestore")}</div>
            <div className="mt-1 text-xs text-slate-500">
              {t("settings.database.backupRestoreDesc")}
            </div>
            {restoreFile ? <div className="mt-2 truncate text-xs text-slate-500" title={restoreFile.name}>{t("settings.database.fileSelected", { name: restoreFile.name })}</div> : null}
            {backupMessage ? <div className="mt-2 text-xs text-emerald-600">{backupMessage}</div> : null}
            {backupError ? <div className="mt-2 text-xs text-red-600">{backupError}</div> : null}
            {restoreMessage ? <div className="mt-2 text-xs text-emerald-600">{restoreMessage}</div> : null}
            {restoreError ? <div className="mt-2 text-xs text-red-600">{restoreError}</div> : null}
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-2">
            <button
              type="button"
              onClick={openBackupPasswordDialog}
              disabled={!canBackup}
              className="inline-flex h-9 w-32 items-center justify-center gap-2 rounded-md border border-blue-200 bg-white px-3 text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {backuping ? t("settings.database.backuping") : t("settings.database.backup")}
            </button>
            <button
              type="button"
              onClick={() => void handleTableExport()}
              disabled={!canTableExport}
              className="inline-flex h-9 w-32 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {tableExporting ? t("settings.database.exporting") : t("settings.database.exportTable")}
            </button>
            <button
              type="button"
              onClick={() => void pickRestoreFile()}
              disabled={restoring}
              className="inline-flex h-9 w-32 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              <Upload className="h-4 w-4 shrink-0" />
              {t("settings.database.selectBackup")}
            </button>
            <input
              ref={restoreFileInputRef}
              type="file"
              accept=".mmhbackup"
              className="hidden"
              onChange={(event) => {
                void applyRestoreFile(event.target.files?.[0] ?? null);
              }}
            />
            <button
              type="button"
              onClick={openRestorePasswordDialog}
              disabled={!canRestore}
              className="inline-flex h-9 w-32 items-center justify-center gap-2 rounded-md bg-red-600 px-3 text-sm text-white hover:bg-red-700 disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" />
              {restoring ? t("settings.database.restoring") : t("settings.database.startRestore")}
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-800">{t("settings.autoBackup.title")}</div>
            <div className="mt-1 text-xs text-slate-500">
              {t("settings.autoBackup.desc")}
            </div>
          </div>
          <label className="inline-flex shrink-0 cursor-pointer items-center gap-2 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={autoBackup?.enabled ?? false}
              disabled={autoBackupLoading}
              onChange={(event) => {
                setAutoBackup((prev) => (prev ? { ...prev, enabled: event.target.checked } : prev));
                setAutoBackupMessage("");
                setAutoBackupError("");
              }}
              className="h-4 w-4 accent-blue-600"
            />
            {t("settings.autoBackup.enabled")}
          </label>
        </div>

        {autoBackupMessage ? <div className="mt-2 text-xs text-emerald-600">{autoBackupMessage}</div> : null}
        {autoBackupError ? <div className="mt-2 text-xs text-red-600">{autoBackupError}</div> : null}

        {autoBackup && !autoBackupLoading ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-xs font-medium text-slate-600">{t("settings.autoBackup.frequency")}</div>
              <select
                value={autoBackup.frequencyType}
                onChange={(event) => {
                  const frequencyType = event.target.value as AutoBackupFrequencyType;
                  setAutoBackup((prev) => (prev ? { ...prev, frequencyType } : prev));
                }}
                className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700"
              >
                <option value="daily">{t("settings.autoBackup.frequency.daily")}</option>
                <option value="weekly">{t("settings.autoBackup.frequency.weekly")}</option>
                <option value="interval">{t("settings.autoBackup.frequency.interval")}</option>
              </select>
            </div>

            {autoBackup.frequencyType === "daily" || autoBackup.frequencyType === "weekly" ? (
              <div>
                <div className="text-xs font-medium text-slate-600">{t("settings.autoBackup.time")}</div>
                <input
                  type="time"
                  value={autoBackup.time}
                  onChange={(event) => {
                    setAutoBackup((prev) => (prev ? { ...prev, time: event.target.value || "02:00" } : prev));
                  }}
                  className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700"
                />
              </div>
            ) : (
              <div>
                <div className="text-xs font-medium text-slate-600">{t("settings.autoBackup.everyHours")}</div>
                <input
                  type="number"
                  min={1}
                  max={720}
                  value={autoBackup.everyHours}
                  onChange={(event) => {
                    const everyHours = Number(event.target.value);
                    setAutoBackup((prev) => (prev ? { ...prev, everyHours } : prev));
                  }}
                  className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700"
                />
              </div>
            )}

            {autoBackup.frequencyType === "weekly" ? (
              <div>
                <div className="text-xs font-medium text-slate-600">{t("settings.autoBackup.weekday")}</div>
                <select
                  value={autoBackup.weekday}
                  onChange={(event) => {
                    setAutoBackup((prev) => (prev ? { ...prev, weekday: Number(event.target.value) } : prev));
                  }}
                  className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700"
                >
                  {[0, 1, 2, 3, 4, 5, 6].map((day) => (
                    <option key={day} value={day}>
                      {t(`settings.autoBackup.weekday.${day}`)}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div>
              <div className="text-xs font-medium text-slate-600">{t("settings.autoBackup.scope")}</div>
              <div className="mt-1 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAutoBackup((prev) => (prev ? { ...prev, scope: "system" } : prev));
                  }}
                  disabled={!autoBackupSystemSupported}
                  className={`h-9 rounded-md border px-3 text-xs font-medium disabled:opacity-40 ${
                    autoBackup.scope === "system"
                      ? "border-blue-300 bg-blue-50 text-blue-700"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {t("settings.autoBackup.scope.system")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAutoBackup((prev) => (prev ? { ...prev, scope: "household" } : prev));
                  }}
                  className={`h-9 rounded-md border px-3 text-xs font-medium ${
                    autoBackup.scope === "household"
                      ? "border-blue-300 bg-blue-50 text-blue-700"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {t("settings.autoBackup.scope.household")}
                </button>
              </div>
              {autoBackup.scope === "system" && !autoBackupSystemSupported ? (
                <div className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                  {t("settings.autoBackup.scopeSystemUnsupported")}
                </div>
              ) : null}
            </div>

            <div>
              <div className="text-xs font-medium text-slate-600">{t("settings.autoBackup.path")}</div>
              <input
                type="text"
                value={autoBackup.path}
                placeholder={t("settings.autoBackup.pathPlaceholder")}
                onChange={(event) => {
                  setAutoBackup((prev) => (prev ? { ...prev, path: event.target.value } : prev));
                  setAutoBackupDisk(null);
                }}
                className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700"
              />
              <div className="mt-1 truncate text-[11px] text-slate-400" title={autoBackupDefaultDir}>
                {t("settings.autoBackup.defaultDir", { path: autoBackupDefaultDir || "…" })}
              </div>
              <div className="mt-1 text-[11px] text-amber-700">{t("settings.autoBackup.pathHint")}</div>
              {autoBackupDisk?.free ? (
                <div className="mt-1 text-[11px] text-slate-500">
                  {t("settings.autoBackup.diskSpace", { free: autoBackupDisk.free })}
                </div>
              ) : null}
              {autoBackupDisk?.freeBytes !== undefined && autoBackupDisk.freeBytes < 2 * 1024 * 1024 * 1024 ? (
                <div className="mt-1 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                  {t("settings.autoBackup.diskSpaceLow", { free: autoBackupDisk.free ?? "" })}
                </div>
              ) : null}
            </div>

            <div>
              <div className="text-xs font-medium text-slate-600">{t("settings.autoBackup.keepCount")}</div>
              <input
                type="number"
                min={1}
                max={100}
                value={autoBackup.keepCount}
                onChange={(event) => {
                  const keepCount = Number(event.target.value);
                  setAutoBackup((prev) => (prev ? { ...prev, keepCount } : prev));
                }}
                className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700"
              />
              <div className="mt-1 text-[11px] text-slate-400">{t("settings.autoBackup.keepCountHint")}</div>
            </div>
          </div>
        ) : null}

        {autoBackupStatus ? (
          <div className="mt-3 space-y-1 text-[11px] text-slate-500">
            {autoBackupStatus.lastRunAt ? (
              autoBackupStatus.lastRunOk ? (
                <div>{t("settings.autoBackup.lastRunOk", { time: formatAutoBackupTime(autoBackupStatus.lastRunAt) })}</div>
              ) : (
                <div>
                  {t("settings.autoBackup.lastRunFailed", {
                    time: formatAutoBackupTime(autoBackupStatus.lastRunAt),
                    error: autoBackupStatus.lastError ?? "",
                  })}
                </div>
              )
            ) : (
              <div>{t("settings.autoBackup.lastRunNone")}</div>
            )}
            {autoBackupStatus.nextRunAt ? (
              <div>{t("settings.autoBackup.nextRun", { time: formatAutoBackupTime(autoBackupStatus.nextRunAt) })}</div>
            ) : autoBackup?.enabled ? (
              <div>{t("settings.autoBackup.nextRunNone")}</div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void saveAutoBackupSettings()}
            disabled={autoBackupSaving || autoBackupRunning || !autoBackup}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {autoBackupSaving ? t("settings.autoBackup.saving") : t("settings.autoBackup.save")}
          </button>
          <button
            type="button"
            onClick={() => void runAutoBackupNow()}
            disabled={autoBackupRunning || autoBackupSaving || !autoBackup}
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-4 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {autoBackupRunning ? t("settings.autoBackup.running") : t("settings.autoBackup.runNow")}
          </button>
        </div>
      </section>

      {backupPasswordDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 px-4">
          <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-4 shadow-xl">
            <div className="text-sm font-semibold text-slate-800">{t("settings.database.verifyUser")}</div>
            <div className="mt-1 text-xs text-slate-500">
              {t("settings.database.verifyUserDesc")}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setBackupScope("household");
                  setBackupError("");
                }}
                className={`h-9 rounded-md border px-2 text-xs font-medium ${
                  backupScope === "household"
                    ? "border-blue-300 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {t("settings.database.householdBackup")}
              </button>
              {canBackupSystem ? (
                <button
                  type="button"
                  onClick={() => {
                    setBackupScope("system");
                    setBackupError("");
                  }}
                  className={`h-9 rounded-md border px-2 text-xs font-medium ${
                    backupScope === "system"
                      ? "border-red-300 bg-red-50 text-red-700"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {t("settings.database.systemBackup")}
                </button>
              ) : null}
            </div>
            {backupScope === "system" ? (
              <div className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                {t("settings.database.systemBackupWarning")}
              </div>
            ) : (
              <div className="mt-2 rounded-md bg-slate-50 px-2 py-1 text-[11px] text-slate-500">
                {t("settings.database.householdBackupNote")}
              </div>
            )}
            <input
              type="password"
              value={backupUserPassword}
              onChange={(event) => {
                setBackupUserPassword(event.target.value);
                setBackupError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleBackup();
              }}
              placeholder={t("settings.database.currentPasswordPlaceholder")}
              autoComplete="current-password"
              autoFocus
              className="mt-3 h-10 w-full rounded-md border border-slate-200 px-3 text-sm text-slate-700 outline-none focus:border-blue-400"
            />
            <label className="mt-3 flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={backupCrossEnvironment}
                onChange={(event) => {
                  setBackupCrossEnvironment(event.target.checked);
                  setBackupError("");
                }}
                className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-400"
              />
              {t("settings.database.crossEnvironment")}
            </label>
            <input
              type="text"
              value={backupPassphrase}
              onChange={(event) => {
                setBackupPassphrase(event.target.value);
                setBackupError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleBackup();
              }}
              placeholder={backupCrossEnvironment ? t("settings.database.passphraseRequiredPlaceholder") : t("settings.database.passphraseOptionalPlaceholder")}
              autoComplete="off"
              className="mt-2 h-10 w-full rounded-md border border-slate-200 px-3 text-sm text-slate-700 outline-none focus:border-blue-400"
            />
            <div className="mt-1 text-[11px] text-slate-400">
              {t("settings.database.passphraseHint")}
            </div>
            {backupError ? <div className="mt-2 text-xs text-red-600">{backupError}</div> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (backuping) return;
                  setBackupPasswordDialogOpen(false);
                  setBackupUserPassword("");
                  setBackupPassphrase("");
                  setBackupCrossEnvironment(false);
                  setBackupScope("household");
                  setBackupError("");
                }}
                disabled={backuping}
                className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void handleBackup()}
                disabled={backuping || backupUserPassword.trim().length === 0}
                className="h-9 rounded-md bg-blue-600 px-3 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {backuping ? t("settings.database.backuping") : t("settings.database.confirmBackup")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {restorePasswordDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 px-4">
          <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-4 shadow-xl">
            <div className="text-sm font-semibold text-slate-800">{t("settings.database.verifyUser")}</div>
            <div className="mt-1 text-xs text-slate-500">
              {t("settings.database.restoreDesc")}
            </div>
            <div className="mt-3 rounded-md bg-slate-50 px-2 py-1 text-[11px] text-slate-500">
              {restoreBackupScope === "system"
                ? t("settings.database.systemBackupDetected")
                : t("settings.database.householdBackupDetected")}
            </div>
            {restoreBackupScope === "system" ? (
              <label className="mt-2 flex items-center gap-2 text-xs text-red-700">
                <input
                  type="checkbox"
                  checked={restoreConfirmSystemOverwrite}
                  onChange={(event) => {
                    setRestoreConfirmSystemOverwrite(event.target.checked);
                    setRestoreError("");
                  }}
                  className="h-4 w-4 rounded border-slate-300 text-red-600 focus:ring-red-400"
                />
                {t("settings.database.confirmSystemOverwrite")}
              </label>
            ) : null}
            <input
              type="password"
              value={restoreUserPassword}
              onChange={(event) => {
                setRestoreUserPassword(event.target.value);
                setRestoreError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleRestore();
              }}
              placeholder={t("settings.database.currentPasswordPlaceholder")}
              autoComplete="current-password"
              autoFocus
              className="mt-3 h-10 w-full rounded-md border border-slate-200 px-3 text-sm text-slate-700 outline-none focus:border-blue-400"
            />
            <input
              type="password"
              value={restorePassphrase}
              onChange={(event) => {
                setRestorePassphrase(event.target.value);
                setRestoreError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleRestore();
              }}
              placeholder={t("settings.database.passphrasePlaceholder")}
              autoComplete="off"
              className="mt-2 h-10 w-full rounded-md border border-slate-200 px-3 text-sm text-slate-700 outline-none focus:border-blue-400"
            />
            <div className="mt-1 text-[11px] text-slate-400">{t("settings.database.restorePassphraseHint")}</div>
            <RestoreProgressView progress={restoreProgress} />
            {restoreError ? <div className="mt-2 text-xs text-red-600">{restoreError}</div> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (restoring) return;
                  setRestorePasswordDialogOpen(false);
                  setRestoreUserPassword("");
                  setRestorePassphrase("");
                  setRestoreConfirmSystemOverwrite(false);
                  setRestoreError("");
                }}
                disabled={restoring}
                className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void handleRestore()}
                disabled={
                  restoring ||
                  restoreUserPassword.trim().length === 0 ||
                  (restoreBackupScope === "system" && !restoreConfirmSystemOverwrite)
                }
                className="h-9 rounded-md bg-red-600 px-3 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                {restoring ? t("settings.database.restoring") : t("settings.database.confirmRestore")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {resetPasswordDialogOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 px-4">
          <div className="w-full max-w-sm rounded-lg border border-red-100 bg-white p-4 shadow-xl">
            <div className="flex items-center gap-2 text-sm font-semibold text-red-800">
              <Shield className="h-4 w-4 shrink-0 text-amber-500" />
              {t("settings.database.resetTitle")}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {t("settings.database.resetDesc")}
            </div>
            <input
              type="password"
              value={resetDbPassword}
              onChange={(event) => {
                setResetDbPassword(event.target.value);
                setResetError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleFactoryReset();
              }}
              placeholder={t("settings.database.resetPlaceholder")}
              autoComplete="off"
              autoFocus
              className="mt-3 h-10 w-full rounded-md border border-red-100 px-3 text-sm text-slate-700 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-50"
            />
            {resetError ? <div className="mt-2 text-xs text-red-600">{resetError}</div> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (resetting) return;
                  setResetPasswordDialogOpen(false);
                  setResetDbPassword("");
                  setResetError("");
                }}
                disabled={resetting}
                className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void handleFactoryReset()}
                disabled={resetting || resetDbPassword.trim().length === 0}
                className="h-9 rounded-md bg-red-600 px-3 text-sm text-white hover:bg-red-700 disabled:opacity-50"
              >
                {resetting ? t("settings.database.executing") : t("settings.database.confirmInit")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-slate-800">{t("settings.database.whitelist")}</div>
            <div className="mt-0.5 text-xs text-slate-500">{t("settings.database.whitelistHint")}</div>
          </div>
          <label className="relative inline-flex cursor-pointer items-center">
            <input
              type="checkbox"
              className="peer sr-only"
              checked={originCheckEnabled}
              onChange={(event) => void toggleOriginCheck(event.target.checked)}
            />
            <div className="h-5 w-9 rounded-full bg-slate-200 transition-colors after:absolute after:start-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-all after:content-[''] peer-checked:bg-blue-600 peer-checked:after:translate-x-4" />
          </label>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded px-2 py-0.5 ${originCheckEnabled ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
            {originCheckEnabled ? t("settings.database.whitelistOn") : t("settings.database.whitelistOff")}
          </span>
          <span className="text-slate-500">
            {origins.length > 0 ? t("settings.database.configuredOrigins", { count: origins.length }) : t("settings.database.noWhitelistEntries")}
          </span>
        </div>
        {originMessage ? <div className="mt-2 text-xs text-emerald-600">{originMessage}</div> : null}
        {originError ? <div className="mt-2 text-xs text-red-600">{originError}</div> : null}

        <SettingsTable minWidth={620} maxWidth="full" className="mt-3">
          <colgroup>
            <col />
            <col style={{ width: "88px" }} />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <SettingsTh>{t("settings.database.allowedOrigin")}</SettingsTh>
              <SettingsTh align="right">{t("detail.column.actions")}</SettingsTh>
            </tr>
          </thead>
          <tbody>
            {originsLoading ? (
              <SettingsEmptyRow colSpan={2}>{t("settings.database.loadingWhitelist")}</SettingsEmptyRow>
            ) : origins.length > 0 ? (
              origins.map((origin, index) => (
                <tr key={origin} className="hover:bg-slate-50">
                  <SettingsTd className="truncate font-mono text-[11px]" title={origin}>{origin}</SettingsTd>
                  <SettingsTd align="right">
                    <SettingsRowActions>
                      <SettingsActionButton label={t("settings.database.deleteWhitelist")} variant="delete" onClick={() => void removeOrigin(index)} />
                    </SettingsRowActions>
                  </SettingsTd>
                </tr>
              ))
            ) : (
              <SettingsEmptyRow colSpan={2}>{t("settings.database.emptyWhitelist")}</SettingsEmptyRow>
            )}
            <tr className="bg-slate-50/60">
              <SettingsTd>
                <input
                  type="text"
                  value={newOrigin}
                  onChange={(event) => setNewOrigin(event.target.value)}
                  placeholder={t("settings.database.originPlaceholder")}
                  disabled={originsLoading}
                  className="h-8 w-full min-w-0 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 focus:border-blue-300 focus:outline-none disabled:bg-slate-50"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void addOrigin();
                  }}
                />
              </SettingsTd>
              <SettingsTd align="right">
                <SettingsRowActions>
                  <SettingsActionButton label={t("settings.database.addWhitelist")} variant="add" onClick={() => void addOrigin()} disabled={originsLoading} />
                </SettingsRowActions>
              </SettingsTd>
            </tr>
          </tbody>
        </SettingsTable>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-800">{t("settings.database.inviteTitle")}</div>
            <div className="mt-1 text-xs text-slate-500">
              {t("settings.database.inviteDesc")}
            </div>
            {ledgerInviteMessage ? <div className="mt-2 text-xs text-emerald-600">{ledgerInviteMessage}</div> : null}
            {ledgerInviteError ? <div className="mt-2 text-xs text-red-600">{ledgerInviteError}</div> : null}
          </div>
        </div>
        <SettingsTable minWidth={900} maxWidth="full" className="mt-4">
          <colgroup>
            <col style={{ width: "42%" }} />
            <col style={{ width: "72px" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "160px" }} />
            <col style={{ width: "88px" }} />
          </colgroup>
          <thead className="sticky top-0 z-10">
            <tr>
              <SettingsTh>{t("settings.database.inviteCode")}</SettingsTh>
              <SettingsTh>{t("settings.database.inviteStatus")}</SettingsTh>
              <SettingsTh>{t("settings.database.createdBook")}</SettingsTh>
              <SettingsTh>{t("settings.database.usedTime")}</SettingsTh>
              <SettingsTh align="right">{t("detail.column.actions")}</SettingsTh>
            </tr>
          </thead>
          <tbody>
            {ledgerInviteLoading ? (
              <SettingsEmptyRow colSpan={5}>{t("settings.database.loadingInvites")}</SettingsEmptyRow>
            ) : sortedLedgerInviteRecords.length > 0 ? (
              sortedLedgerInviteRecords.map((record) => (
                <tr key={record.code} className="hover:bg-slate-50">
                  <SettingsTd>
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[11px] text-slate-700" title={record.code}>{record.code}</div>
                      <div className="mt-0.5 text-[10px] text-slate-400">{t("settings.database.createdPrefix", { time: formatInviteDateTime(record.createdAt) })}</div>
                    </div>
                  </SettingsTd>
                  <SettingsTd>
                    {record.usedAt ? (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">{t("settings.database.used")}</span>
                    ) : (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700">{t("settings.database.available")}</span>
                    )}
                  </SettingsTd>
                  <SettingsTd className="max-w-[16rem] truncate" title={record.usedHouseholdName || ""}>
                    {record.usedHouseholdName || "-"}
                  </SettingsTd>
                  <SettingsTd>{formatInviteDateTime(record.usedAt)}</SettingsTd>
                  <SettingsTd align="right">
                    <SettingsRowActions>
                      <SettingsActionButton label={t("settings.database.deleteInvite")} variant="delete" onClick={() => void removeLedgerInviteCode(record.code)} disabled={ledgerInviteSaving} />
                    </SettingsRowActions>
                  </SettingsTd>
                </tr>
              ))
            ) : ledgerInviteError ? (
              <SettingsEmptyRow colSpan={5}>{t("settings.database.inviteLoadFailed", { error: ledgerInviteError })}</SettingsEmptyRow>
            ) : (
              <SettingsEmptyRow colSpan={5}>{t("settings.database.noInvites")}</SettingsEmptyRow>
            )}
            <tr className="bg-slate-50/60">
              <SettingsTd>
                <div className="flex min-w-0 items-center gap-2">
                  <input
                    type="text"
                    value={ledgerInviteCode}
                    onChange={(event) => {
                      setLedgerInviteCode(event.target.value);
                      setLedgerInviteError("");
                      setLedgerInviteMessage("");
                    }}
                    placeholder={ledgerInviteLoading ? t("settings.database.reading") : t("settings.database.invitePlaceholder")}
                    disabled={ledgerInviteLoading || ledgerInviteSaving}
                    className="h-8 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700 focus:border-blue-300 focus:outline-none disabled:bg-slate-50"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void addLedgerInviteCode();
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      setLedgerInviteCode(generateRandomKey());
                      setLedgerInviteError("");
                      setLedgerInviteMessage("");
                    }}
                    disabled={ledgerInviteLoading || ledgerInviteSaving}
                    className="secondary-button h-8 px-2 text-xs disabled:opacity-50"
                  >
                    {t("settings.database.randomFill")}
                  </button>
                </div>
              </SettingsTd>
              <SettingsTd><span className="text-xs text-slate-400">{t("settings.database.add")}</span></SettingsTd>
              <SettingsTd><span className="text-xs text-slate-400">-</span></SettingsTd>
              <SettingsTd><span className="text-xs text-slate-400">-</span></SettingsTd>
              <SettingsTd align="right">
                <SettingsRowActions>
                  <SettingsActionButton label={ledgerInviteSaving ? t("settings.database.saving") : t("settings.database.addInvite")} variant="add" onClick={() => void addLedgerInviteCode()} disabled={ledgerInviteLoading || ledgerInviteSaving} />
                </SettingsRowActions>
              </SettingsTd>
            </tr>
          </tbody>
        </SettingsTable>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-800">{t("settings.database.cacheRefreshTitle")}</div>
            <div className="mt-1 text-xs text-slate-500">
              {t("settings.database.cacheRefreshDesc")}
            </div>
            {cacheRefreshMessage ? <div className="mt-2 text-xs text-emerald-600">{cacheRefreshMessage}</div> : null}
            {cacheRefreshError ? <div className="mt-2 text-xs text-red-600">{cacheRefreshError}</div> : null}
          </div>
          <button
            type="button"
            onClick={() => void handleCacheRefresh()}
            disabled={cacheRefreshing}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${cacheRefreshing ? "animate-spin" : ""}`} />
            {cacheRefreshing ? t("settings.database.refreshing") : t("settings.database.refreshCache")}
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-red-200 bg-red-50 p-4">
        <div className="text-sm font-medium text-red-800">{t("settings.database.factoryReset")}</div>
        <div className="mt-0.5 text-xs text-red-600">
          {t("settings.database.factoryResetDesc")}
        </div>

        <button
          type="button"
          onClick={openFactoryResetDialog}
          disabled={resetting}
          className="mt-3 h-9 rounded-md bg-red-600 px-4 text-sm text-white hover:bg-red-700 disabled:opacity-50"
        >
          {resetting ? t("settings.database.executing") : t("settings.database.factoryReset")}
        </button>
      </section>
    </div>
  );
}
