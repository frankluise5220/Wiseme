"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, ExternalLink, Loader2, RefreshCw, XCircle } from "lucide-react";
import {
  APP_PREFS_EVENT,
  getTimeZoneModePreference,
  getTimeZonePreference,
  type TimeZoneMode,
} from "@/lib/client/appPreferences";
import { useI18n } from "@/lib/i18n";

type VersionInfo = {
  ok: boolean;
  deploymentTarget?: "docker" | "fnos" | "synology" | "standalone";
  isDocker?: boolean;
  isFnos?: boolean;
  isSynology?: boolean;
  updaterEnabled?: boolean;
  updateMode?: "git" | "fnos" | "synology";
  versionSource?: "git" | "env";
  localVersion: string;
  localCommit: string;
  localCommitMsg: string;
  localCommitDate: string;
  githubUrl?: string;
  githubCommit?: string;
  githubCommitMsg?: string;
  githubCommitDate?: string;
  githubCanCheck?: boolean;
  githubFetchError?: string;
  remoteName?: string;
  remoteBranch?: string;
  remoteUrl?: string;
  remoteVersion?: string;
  remoteCommit: string;
  remoteCommitMsg: string;
  remoteCommitDate?: string;
  needsUpdate: boolean;
  canCheckUpdate?: boolean;
  imageSourceConfig?: ImageSourceConfig | null;
  localReleaseNotes?: string;
  fetchError?: string;
  error?: string;
};

type StepStatus = "pending" | "running" | "completed" | "failed";

type StepState = {
  key: string;
  label: string;
  status: StepStatus;
  output: string;
};

type ImageSourceConfig = {
  source: string;
  appImage: string;
  updaterImage: string;
  customAppImage: string;
  customUpdaterImage: string;
  options: Array<{ value: string; label: string; appImage?: string; updaterImage?: string }>;
};

type ImageSourceDraft = {
  source: string;
  customAppImage: string;
  customUpdaterImage: string;
};

type ImageSpeedResult = {
  source: string;
  image?: string;
  ok: boolean;
  ms?: number;
  version?: {
    digest?: string;
    digestShort?: string;
    revision?: string;
    commit?: string;
    created?: string;
    message?: string;
    version?: string;
  };
  error?: string;
};

// Step keys are matched against the step names emitted by the update API (data, not UI copy).
const UPDATE_STEPS = ["拉取代码", "安装依赖", "生成 Prisma Client", "同步数据库", "构建项目"];
const DOCKER_UPDATE_STEPS = ["同步部署文件", "检测镜像源", "拉取应用镜像", "重启服务"];

function updateStepLabel(key: string, t: (key: string) => string) {
  switch (key) {
    case "拉取代码": return t("settings.systemUpdate.step.pullCode");
    case "安装依赖": return t("settings.systemUpdate.step.installDeps");
    case "生成 Prisma Client": return t("settings.systemUpdate.step.generatePrisma");
    case "同步数据库": return t("settings.systemUpdate.step.syncDb");
    case "构建项目": return t("settings.systemUpdate.step.build");
    case "同步部署文件": return t("settings.systemUpdate.step.syncFiles");
    case "检测镜像源": return t("settings.systemUpdate.step.detectMirror");
    case "拉取应用镜像": return t("settings.systemUpdate.step.pullImage");
    case "重启服务": return t("settings.systemUpdate.step.restartService");
    default: return key;
  }
}
const FIXED_IMAGE_SOURCE_OPTIONS = [
  { value: "auto", label: "", appImage: "", updaterImage: "" },
  { value: "ghcr", label: "GHCR", appImage: "ghcr.io/frankluise5220/mmh:latest", updaterImage: "ghcr.io/frankluise5220/mmh-updater:latest" },
  { value: "dockerproxy", label: "dockerproxy", appImage: "ghcr.dockerproxy.net/frankluise5220/mmh:latest", updaterImage: "ghcr.dockerproxy.net/frankluise5220/mmh-updater:latest" },
  { value: "nju", label: "NJU", appImage: "ghcr.nju.edu.cn/frankluise5220/mmh:latest", updaterImage: "ghcr.nju.edu.cn/frankluise5220/mmh-updater:latest" },
  { value: "daocloud", label: "DaoCloud", appImage: "ghcr.m.daocloud.io/frankluise5220/mmh:latest", updaterImage: "ghcr.m.daocloud.io/frankluise5220/mmh-updater:latest" },
  { value: "fnvps", label: "FN VPS", appImage: "fnapp.floatingice.win:5000/frankluise5220/mmh:latest", updaterImage: "fnapp.floatingice.win:5000/frankluise5220/mmh-updater:latest" },
];

function formatVersionDate(value: string | undefined, timeZoneMode: TimeZoneMode, timeZone: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  };
  if (timeZoneMode === "specified") options.timeZone = timeZone;
  return new Intl.DateTimeFormat("zh-CN", options).format(date).replace(/\//g, "-");
}

function cleanVersionPart(value: string | undefined) {
  const text = String(value ?? "").trim();
  return text && text !== "unknown" ? text : "";
}

function formatVersionLine(
  version: string | undefined,
  commit: string | undefined,
  date: string | undefined,
  timeZoneMode: TimeZoneMode,
  timeZone: string,
) {
  const head = [
    cleanVersionPart(version),
    cleanVersionPart(commit),
  ].filter(Boolean).join(" ");
  return [head, formatVersionDate(date, timeZoneMode, timeZone)].filter(Boolean).join(" · ");
}

function formatImageVersion(result: ImageSpeedResult | undefined, timeZoneMode: TimeZoneMode, timeZone: string, t: (key: string) => string) {
  if (!result) return "";
  if (!result.ok) return result.error || t("settings.systemUpdate.failed");
  const version = result.version?.version || "";
  const commit = result.version?.commit || "";
  const digest = result.version?.digestShort || "";
  const date = formatVersionDate(result.version?.created, timeZoneMode, timeZone);
  const versionAndCommit = [version, commit].filter(Boolean).join(" ");
  if (versionAndCommit && date) return `${versionAndCommit} · ${date}`;
  if (versionAndCommit) return versionAndCommit;
  if (digest) return `digest ${digest}`;
  return t("settings.systemUpdate.versionUnread");
}

function imageSourceOptionLabel(option: { value: string; label: string }, t: (key: string) => string) {
  return option.value === "auto" ? t("settings.systemUpdate.autoSelect") : option.label;
}

// The updater image lives in the same registry as the app image with the repo
// name `mmh-updater`, so the custom source only needs the app image address.
function deriveUpdaterImage(appImage: string) {
  const value = appImage.trim();
  if (!value) return "";
  return value.replace(/\/(mmh)(?=[:@]|$)/, "/mmh-updater");
}

export default function SystemUpdatePage() {
  const { t } = useI18n();
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [loadingVersion, setLoadingVersion] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [updateDone, setUpdateDone] = useState(false);
  const [updateOk, setUpdateOk] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [imageSourceDraft, setImageSourceDraft] = useState<ImageSourceDraft>({
    source: "auto",
    customAppImage: "",
    customUpdaterImage: "",
  });
  const [savingImageSource, setSavingImageSource] = useState(false);
  const [imageSourceMessage, setImageSourceMessage] = useState("");
  // Synchronous guard so rapid row clicks cannot start overlapping saves.
  const imageSourceSaveInFlightRef = useRef(false);
  const customImageSourceIncomplete = imageSourceDraft.source === "custom"
    && !imageSourceDraft.customAppImage.trim();
  const [testingImageSource, setTestingImageSource] = useState(false);
  const [imageSpeedResults, setImageSpeedResults] = useState<Record<string, ImageSpeedResult>>({});
  const [timeZoneMode, setTimeZoneMode] = useState<TimeZoneMode>("system");
  const [timeZone, setTimeZone] = useState("Asia/Shanghai");

  const loadVersionInfo = useCallback(async (options?: { checkRemote?: boolean }) => {
    setLoadingVersion(true);
    try {
      const query = options?.checkRemote ? "?check=1" : "";
      const res = await fetch(`/api/v1/settings/system-update${query}`, { cache: "no-store" });
      const data = await res.json();
      setVersionInfo(data);
      if (data?.imageSourceConfig) {
        setImageSourceDraft({
          source: data.imageSourceConfig.source || "auto",
          customAppImage: data.imageSourceConfig.customAppImage || "",
          customUpdaterImage: deriveUpdaterImage(data.imageSourceConfig.customAppImage || ""),
        });
      }
    } catch {
      setVersionInfo(null);
    } finally {
      setLoadingVersion(false);
    }
  }, []);

  useEffect(() => {
    loadVersionInfo();
  }, [loadVersionInfo]);

  useEffect(() => {
    function syncTimeZonePreference() {
      setTimeZoneMode(getTimeZoneModePreference());
      setTimeZone(getTimeZonePreference());
    }
    syncTimeZonePreference();
    window.addEventListener(APP_PREFS_EVENT, syncTimeZonePreference);
    return () => window.removeEventListener(APP_PREFS_EVENT, syncTimeZonePreference);
  }, []);

  function initSteps() {
    return UPDATE_STEPS.map((key) => ({ key, label: updateStepLabel(key, t), status: "pending" as StepStatus, output: "" }));
  }

  async function saveImageSource(draftOverride?: ImageSourceDraft) {
    setSavingImageSource(true);
    setImageSourceMessage("");
    const draft = draftOverride ?? imageSourceDraft;
    try {
      const res = await fetch("/api/v1/settings/system-update?config=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || t("settings.systemUpdate.saveFailed"));
      }
      setVersionInfo((prev) => prev ? { ...prev, imageSourceConfig: data.config } : prev);
      setImageSourceMessage(t("settings.systemUpdate.saved"));
      return true;
    } catch (e) {
      setImageSourceMessage(e instanceof Error ? e.message : t("settings.systemUpdate.saveFailed"));
      return false;
    } finally {
      setSavingImageSource(false);
    }
  }

  async function testImageSourceSpeed(source?: string) {
    setTestingImageSource(true);
    setImageSourceMessage("");
    try {
      const res = await fetch("/api/v1/settings/system-update?speed=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source,
          customAppImage: imageSourceDraft.customAppImage,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || t("settings.systemUpdate.speedTestFailed"));
      }
      const next = { ...imageSpeedResults };
      for (const result of data.results as ImageSpeedResult[]) {
        next[result.source] = result;
      }
      setImageSpeedResults(next);
      setImageSourceMessage(t("settings.systemUpdate.speedTestDone"));
    } catch (e) {
      setImageSourceMessage(e instanceof Error ? e.message : t("settings.systemUpdate.speedTestFailed"));
    } finally {
      setTestingImageSource(false);
    }
  }

  async function startUpdate() {
    setUpdating(true);
    setUpdateDone(false);
    setUpdateOk(false);
    setUpdateError("");
    setSteps(versionInfo?.isDocker ? DOCKER_UPDATE_STEPS.map((key) => ({ key, label: updateStepLabel(key, t), status: "pending" as StepStatus, output: "" })) : initSteps());

    // The image source list is a draft until saved, but the updater only reads
    // the persisted config. Persist the visible selection before updating so
    // the update uses exactly the source the user sees selected.
    const savedConfig = versionInfo?.imageSourceConfig;
    if (savedConfig) {
      const draft = imageSourceDraft;
      const customImageChanged = draft.source === "custom"
        && (savedConfig.customAppImage || "") !== (draft.customAppImage || "");
      if (savedConfig.source !== draft.source || customImageChanged) {
        const saved = await saveImageSource();
        if (!saved) {
          setUpdateDone(true);
          setUpdateOk(false);
          setUpdateError(t("settings.systemUpdate.saveFailed"));
          setUpdating(false);
          return;
        }
      }
    }

    try {
      const res = await fetch("/api/v1/settings/system-update?mode=update", { method: "POST" });
      if (!res.ok || !res.body) {
        const errData = await res.json().catch(() => null);
        setUpdateDone(true);
        setUpdateOk(false);
        setUpdateError(errData?.error || t("settings.systemUpdate.updateUnavailable"));
        setUpdating(false);
        return;
      }

      if (versionInfo?.isDocker) {
        pollDockerUpdate();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const dataLine = line.trim();
          if (!dataLine.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(dataLine.slice(6));
            if (event.type === "done") {
              setUpdateDone(true);
              setUpdateOk(Boolean(event.ok));
              setUpdateError(event.error || "");
              setUpdating(false);
              if (event.ok) loadVersionInfo();
            } else if (event.step) {
              setSteps((prev) =>
                prev.map((s) =>
                  s.key === event.step
                    ? { ...s, status: event.status as StepStatus, output: event.output || s.output }
                    : s,
                ),
              );
            }
          } catch {
            // Ignore malformed stream chunks.
          }
        }
      }
    } catch (e) {
      setUpdateDone(true);
      setUpdateOk(false);
      setUpdateError(e instanceof Error ? e.message : t("settings.systemUpdate.networkError"));
      setUpdating(false);
    }
  }

  async function pollDockerUpdate() {
    let shouldContinue = true;
    let statusFetchFailures = 0;
    let lastCurrentStep = "";
    let restartWaitStartedAt: number | null = null;
    // While the app container restarts, this page cannot reach the app and
    // fetch failures are expected. On low-power NAS devices a cold start
    // (compat migration + Prisma sync + Next.js boot) can take over a minute,
    // so the restart wait budget is measured by total consecutive downtime
    // rather than by the number of failures.
    const RESTART_MAX_WAIT_MS = 8 * 60 * 1000;
    const STATUS_FETCH_TIMEOUT_MS = 20 * 1000;
    const MAX_UPSTREAM_ERRORS = 5;
    while (shouldContinue) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), STATUS_FETCH_TIMEOUT_MS);
        const res = await fetch("/api/v1/settings/system-update?status=1", {
          method: "POST",
          cache: "no-store",
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || t("settings.systemUpdate.statusQueryFailed"));
        statusFetchFailures = 0;
        const task = data.task as { status?: string; currentStep?: string; logs?: string[]; error?: string };
        const current = task.currentStep || "";
        lastCurrentStep = current || lastCurrentStep;
        const logs = (task.logs ?? []).slice(-8).join("\n");
        const currentIndex = DOCKER_UPDATE_STEPS.indexOf(current);
        setSteps((prev) =>
          prev.map((step) => {
            if (step.key === current) return { ...step, status: "running", output: logs };
            if (currentIndex >= 0 && DOCKER_UPDATE_STEPS.indexOf(step.key) < currentIndex) return { ...step, status: "completed", output: step.output || logs };
            return step;
          }),
        );
        // The updater recreates itself after the app is restarted. Older updater
        // images keep task state only in memory, so the first successful status
        // response after reconnect can be `idle` instead of `completed`.
        const updaterRestartedAfterApp = task.status === "idle" && lastCurrentStep === "重启服务";
        if (task.status === "completed" || updaterRestartedAfterApp) {
          const completedOutput = logs || (updaterRestartedAfterApp ? t("settings.systemUpdate.serviceRestored") : "");
          setSteps((prev) => prev.map((step) => ({ ...step, status: "completed", output: step.output || logs })));
          setUpdateDone(true);
          setUpdateOk(true);
          setUpdating(false);
          shouldContinue = false;
          if (updaterRestartedAfterApp) {
            setSteps((prev) => prev.map((step) => (
              step.key === "重启服务" ? { ...step, status: "completed", output: completedOutput } : step
            )));
          }
          setTimeout(() => window.location.reload(), 2500);
        } else if (task.status === "failed") {
          setUpdateDone(true);
          setUpdateOk(false);
          setUpdateError(task.error || t("settings.systemUpdate.updateFailed"));
          setUpdating(false);
          shouldContinue = false;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : t("settings.systemUpdate.statusQueryFailed");
        const isNetworkFailure =
          e instanceof TypeError ||
          (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError");
        if (isNetworkFailure) {
          // The app is unreachable: its container is restarting or has not
          // finished booting. This is normal during the restart phase, so give
          // enough total wait budget instead of reporting a slow restart as a
          // failed update.
          if (restartWaitStartedAt === null) restartWaitStartedAt = Date.now();
          const waitedMs = Date.now() - restartWaitStartedAt;
          if (waitedMs < RESTART_MAX_WAIT_MS) {
            setSteps((prev) =>
              prev.map((step) =>
                step.key === "重启服务"
                  ? { ...step, status: "running", output: t("settings.systemUpdate.reconnecting", { seconds: Math.round(waitedMs / 1000) }) }
                  : step,
              ),
            );
            await new Promise((resolve) => setTimeout(resolve, 1500));
            continue;
          }
          setUpdateDone(true);
          setUpdateOk(false);
          setUpdateError(
            t("settings.systemUpdate.restartTimeout", { seconds: Math.round(waitedMs / 1000) }),
          );
          setUpdating(false);
          shouldContinue = false;
        } else {
          // The app is reachable but the update executor status query failed
          // (for example the executor is rebuilding or crashed).
          statusFetchFailures += 1;
          if (statusFetchFailures >= MAX_UPSTREAM_ERRORS) {
            setUpdateDone(true);
            setUpdateOk(false);
            setUpdateError(
              t("settings.systemUpdate.updaterQueryFailed", { message }),
            );
            setUpdating(false);
            shouldContinue = false;
          } else {
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }
        }
      }
    }
  }

  function StepIcon({ status }: { status: StepStatus }) {
    switch (status) {
      case "completed":
        return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />;
      case "running":
        return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />;
      case "failed":
        return <XCircle className="h-4 w-4 shrink-0 text-red-500" />;
      case "pending":
        return <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-slate-200" />;
    }
  }

  const hasResolvedRemoteCommit = Boolean(
    versionInfo?.remoteCommit && versionInfo.remoteCommit !== "unknown",
  );
  const canCheckUpdate =
    versionInfo?.ok && versionInfo.canCheckUpdate !== false && hasResolvedRemoteCommit;
  const isLatest = versionInfo?.ok && canCheckUpdate && !versionInfo.needsUpdate;
  const needsUpdate = versionInfo?.ok && canCheckUpdate && versionInfo.needsUpdate;
  const dockerManaged = Boolean(versionInfo?.isDocker);
  const synologyManaged = Boolean(versionInfo?.isSynology || versionInfo?.deploymentTarget === "synology");
  const fnosManaged = Boolean(versionInfo?.isFnos || versionInfo?.deploymentTarget === "fnos");
  const packageManaged = fnosManaged || synologyManaged;
  const packageLabel = synologyManaged ? "SPK" : "FNOS";
  const currentVersionText = packageManaged
    ? `${cleanVersionPart(versionInfo?.localVersion) || "unknown"} ${packageLabel}`
    : formatVersionLine(versionInfo?.localVersion, versionInfo?.localCommit, versionInfo?.localCommitDate, timeZoneMode, timeZone);
  const localReleaseNotes = versionInfo?.localReleaseNotes?.trim() || "";
  const availableVersionText = formatVersionLine(
    versionInfo?.remoteVersion,
    versionInfo?.remoteCommit,
    versionInfo?.remoteCommitDate,
    timeZoneMode,
    timeZone,
  );
  const remoteSourceText = [
    versionInfo?.remoteName,
    versionInfo?.remoteUrl,
  ].filter(Boolean).join(" · ");
  const githubProjectUrl = (versionInfo?.githubUrl || "https://github.com/frankluise5220/MMH").replace(/\.git$/, "");
  const githubReleaseUrl = versionInfo?.localVersion && versionInfo.localVersion !== "unknown"
    ? `${githubProjectUrl}/releases/tag/v${versionInfo.localVersion}`
    : `${githubProjectUrl}/releases`;
  const updateStatusText = needsUpdate
    ? t("settings.systemUpdate.updateAvailable")
    : isLatest
      ? t("settings.systemUpdate.isLatest")
      : t("settings.systemUpdate.unconfirmed");
  const canStartUpdate = !packageManaged && needsUpdate && (!dockerManaged || versionInfo.updaterEnabled);
  const updateActionPanel = !updating && !updateDone && versionInfo?.ok && !canStartUpdate ? (
    <div className="border-t border-slate-100 pt-3">
      {isLatest ? (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          {t("settings.systemUpdate.currentIsLatest")}
        </div>
      ) : needsUpdate && !canStartUpdate && dockerManaged ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t("settings.systemUpdate.dockerUpdaterDisabled")}
          <div className="mt-2 rounded bg-white/70 px-3 py-2 font-mono text-xs text-slate-700">
            git pull
            <br />
            sudo docker compose pull app
            <br />
            sudo docker compose up -d
          </div>
        </div>
      ) : !canCheckUpdate ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          {t("settings.systemUpdate.cannotCheckRemote")}
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold text-slate-800">{packageManaged ? t("settings.systemUpdate.versionInfo") : t("settings.systemUpdate.title")}</h2>

      {packageManaged ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <div className="text-sm font-medium text-amber-800">{t("settings.systemUpdate.uninstallNoticeTitle")}</div>
          <div className="mt-1 text-xs leading-5 text-amber-700">{t("settings.systemUpdate.uninstallNotice")}</div>
        </div>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-slate-800">
            {packageManaged ? t("settings.systemUpdate.versionInfo") : dockerManaged ? t("settings.systemUpdate.softwareUpdateImage") : t("settings.systemUpdate.softwareUpdate")}
          </div>
          <button
            onClick={() => loadVersionInfo({ checkRemote: true })}
            disabled={loadingVersion || updating}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loadingVersion ? "animate-spin" : ""}`} />
            {t("settings.systemUpdate.refresh")}
          </button>
        </div>

        {!loadingVersion && !versionInfo ? (
          <div className="rounded-md border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-center text-sm text-slate-500">
            {packageManaged ? t("settings.systemUpdate.readFailedFnos") : t("settings.systemUpdate.readFailed")}
          </div>
        ) : loadingVersion && !versionInfo ? (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t("settings.systemUpdate.readingVersion")}
          </div>
        ) : versionInfo?.ok ? (
          <div className="space-y-3 text-sm">
            <div className="grid gap-2 md:grid-cols-[104px_1fr]">
              <div className="text-slate-500">{t("settings.systemUpdate.currentVersion")}</div>
              <div className="min-w-0">
                <span className="font-semibold text-slate-900">{currentVersionText || "unknown"}</span>
                {packageManaged ? (
                  <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{synologyManaged ? t("settings.systemUpdate.synologyPackage") : t("settings.systemUpdate.fnosPackage")}</span>
                ) : versionInfo.localCommitMsg ? (
                  <span className="ml-2 text-xs text-slate-500">{versionInfo.localCommitMsg}</span>
                ) : null}
              </div>

              {packageManaged && localReleaseNotes ? (
                <>
                  <div className="text-slate-500">{t("settings.systemUpdate.releaseNotes")}</div>
                  <div className="min-w-0 text-slate-700">{localReleaseNotes}</div>
                </>
              ) : null}

              {packageManaged ? (
                <>
                  <div className="text-slate-500">{t("settings.systemUpdate.projectUrl")}</div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                      <a
                        href={githubProjectUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-medium text-blue-600 hover:text-blue-700"
                      >
                        {t("settings.systemUpdate.githubHome")}
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                      <a
                        href={githubReleaseUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-slate-600 hover:text-slate-800"
                      >
                        {t("settings.systemUpdate.currentRelease")}
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  </div>
                </>
              ) : null}

              <div className="text-slate-500">{packageManaged ? t("settings.systemUpdate.updateMethod") : needsUpdate ? t("settings.systemUpdate.availableVersion") : t("settings.systemUpdate.remoteVersion")}</div>
              <div className="min-w-0">
                {packageManaged ? (
                  <span className="text-slate-600">{synologyManaged ? t("settings.systemUpdate.managedBySynology") : t("settings.systemUpdate.managedByFnos")}</span>
                ) : canCheckUpdate ? (
                  <>
                    <span className="font-semibold text-slate-900">{availableVersionText || versionInfo.remoteCommit}</span>
                    {versionInfo.remoteCommitMsg ? (
                      <span className="ml-2 text-xs text-slate-500">{versionInfo.remoteCommitMsg}</span>
                    ) : null}
                  </>
                ) : (
                  <span className="text-amber-600">{t("settings.systemUpdate.notFetched")}</span>
                )}
              </div>

              {canCheckUpdate && remoteSourceText ? (
                <>
                  <div className="text-slate-500">{t("settings.systemUpdate.versionSource")}</div>
                  <div className="min-w-0 truncate text-xs text-slate-500" title={remoteSourceText}>
                    {remoteSourceText}
                  </div>
                </>
              ) : null}
            </div>

            {packageManaged ? (
              <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                {synologyManaged ? t("settings.systemUpdate.synologyManagedInfo") : t("settings.systemUpdate.fnosManagedInfo")}
              </div>
            ) : null}

            {!packageManaged && !isLatest ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs ${
                      needsUpdate
                        ? "bg-amber-50 text-amber-700"
                        : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {updateStatusText}
                  </span>
                  {needsUpdate ? (
                    <span className="text-xs text-slate-500">
                      {dockerManaged ? t("settings.systemUpdate.willPullImage") : t("settings.systemUpdate.willUpdateTo", { version: availableVersionText || versionInfo.remoteCommit })}
                    </span>
                  ) : null}
                </div>
                {canStartUpdate ? (
                  <button
                    onClick={startUpdate}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700"
                  >
                    <Download className="h-3.5 w-3.5" />
                    {t("settings.systemUpdate.update")}
                  </button>
                ) : null}
              </div>
            ) : null}

            {!packageManaged && !canCheckUpdate && (versionInfo.fetchError || versionInfo.githubFetchError) ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                {t("settings.systemUpdate.fetchRemoteFailed", { error: versionInfo.fetchError || versionInfo.githubFetchError || "" })}
              </div>
            ) : null}

            {!packageManaged && canCheckUpdate && versionInfo.remoteName?.startsWith("image:") && versionInfo.githubFetchError ? (
              <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">
                {t("settings.systemUpdate.githubFallback")}
              </div>
            ) : null}

            {!packageManaged ? updateActionPanel : null}

            {!packageManaged && dockerManaged && versionInfo.imageSourceConfig ? (
              <div className="border-t border-slate-100 pt-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-slate-500">{t("settings.systemUpdate.imageSource")}</div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => testImageSourceSpeed()}
                      disabled={testingImageSource || savingImageSource || updating}
                      className="h-8 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {testingImageSource ? t("settings.systemUpdate.speedTesting") : t("settings.systemUpdate.testSpeed")}
                    </button>
                    <button
                      onClick={() => saveImageSource()}
                      disabled={savingImageSource || updating || customImageSourceIncomplete}
                      className="h-8 rounded-md bg-slate-800 px-3 text-xs text-white hover:bg-slate-700 disabled:opacity-50"
                    >
                      {savingImageSource ? t("settings.systemUpdate.saving") : t("common.save")}
                    </button>
                  </div>
                </div>

                <div className="overflow-hidden rounded-md border border-slate-200">
                  {[
                    ...FIXED_IMAGE_SOURCE_OPTIONS,
                    ...(versionInfo.imageSourceConfig.options ?? []).filter((option) => option.value === "custom"),
                  ].map((option) => {
                    const selected = imageSourceDraft.source === option.value;
                    const speed = imageSpeedResults[option.value];
                    const appImage =
                      option.value === "custom"
                        ? imageSourceDraft.customAppImage || option.appImage || t("settings.systemUpdate.notFilled")
                        : option.appImage || "";
                    return (
                      <label
                        key={option.value}
                        onClick={() => {
                          if (imageSourceSaveInFlightRef.current || updating) return;
                          if (imageSourceDraft.source === option.value) return;
                          // Selecting a source takes effect immediately: persist
                          // the new draft instead of waiting for the Save button.
                          const nextDraft = { ...imageSourceDraft, source: option.value };
                          setImageSourceDraft(nextDraft);
                          setImageSourceMessage("");
                          // Custom needs an image address before it can be
                          // saved; it is persisted by Save or on update.
                          if (option.value === "custom") return;
                          imageSourceSaveInFlightRef.current = true;
                          void saveImageSource(nextDraft).finally(() => {
                            imageSourceSaveInFlightRef.current = false;
                          });
                        }}
                        className={`grid cursor-pointer grid-cols-[28px_92px_minmax(0,1fr)_180px] items-center gap-2 border-b border-slate-100 px-3 py-2 text-xs last:border-b-0 hover:bg-slate-50 ${
                          selected ? "bg-blue-50/60" : ""
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selected}
                          readOnly
                          disabled={savingImageSource || updating}
                          className="h-4 w-4 rounded border-slate-300 text-blue-600"
                        />
                        <span className="font-medium text-slate-800">{imageSourceOptionLabel(option, t)}</span>
                        <span className="min-w-0 truncate font-mono text-slate-500">{appImage || t("settings.systemUpdate.autoDetect")}</span>
                        <span
                          className={`min-w-0 text-right ${
                            speed?.ok ? "text-emerald-600" : speed ? "text-red-600" : "text-slate-400"
                          }`}
                          title={speed ? formatImageVersion(speed, timeZoneMode, timeZone, t) : ""}
                        >
                          {speed ? (
                            speed.ok ? (
                              <span className="flex min-w-0 flex-col items-end leading-tight">
                                <span>{speed.ms}ms</span>
                                <span className="max-w-full truncate text-[10px] text-slate-500">
                                  {formatImageVersion(speed, timeZoneMode, timeZone, t)}
                                </span>
                              </span>
                            ) : t("settings.systemUpdate.failed")
                          ) : option.value === "auto" ? t("settings.systemUpdate.auto") : t("settings.systemUpdate.notTested")}
                        </span>
                      </label>
                    );
                  })}
                </div>

                {imageSourceDraft.source === "custom" ? (
                  <div className="mt-2 space-y-2">
                    <div className="grid gap-2 md:grid-cols-[104px_1fr]">
                      <div className="text-xs text-slate-500">{t("settings.systemUpdate.appImage")}</div>
                      <input
                        value={imageSourceDraft.customAppImage}
                        required
                        onChange={(event) => {
                          const value = event.target.value;
                          setImageSourceDraft((draft) => ({
                            ...draft,
                            customAppImage: value,
                            customUpdaterImage: deriveUpdaterImage(value),
                          }));
                        }}
                        disabled={savingImageSource || updating}
                        className="h-8 rounded-md border border-slate-200 px-2 text-sm text-slate-700 outline-none focus:border-blue-400 disabled:opacity-50"
                        placeholder="registry.example.com/frankluise5220/mmh:latest"
                      />
                    </div>
                    <div className="grid gap-2 md:grid-cols-[104px_1fr]">
                      <div className="text-xs text-slate-500">{t("settings.systemUpdate.updaterImage")}</div>
                      <div className="min-w-0 truncate font-mono text-xs text-slate-500">
                        {deriveUpdaterImage(imageSourceDraft.customAppImage) || t("settings.systemUpdate.notFilled")}
                      </div>
                    </div>
                    <div className="text-xs text-slate-400">{t("settings.systemUpdate.updaterDerived")}</div>
                  </div>
                ) : null}

                <div className="mt-1 min-h-4 text-xs text-slate-500">
                  {imageSourceMessage || t("settings.systemUpdate.speedTestHint")}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-xs text-red-600">{t("settings.systemUpdate.fetchInfoFailed")}</div>
        )}
      </section>

      {(updating || updateDone) && steps.length > 0 ? (
        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="mb-3 text-sm font-medium text-slate-800">{t("settings.systemUpdate.updateProgress")}</div>

          <div className="space-y-2">
            {steps.map((s) => (
              <div key={s.label} className="flex items-start gap-2.5">
                <StepIcon status={s.status} />
                <div className="min-w-0 flex-1">
                  <div
                    className={`text-sm ${
                      s.status === "completed"
                        ? "font-medium text-emerald-700"
                        : s.status === "running"
                          ? "font-medium text-blue-700"
                          : s.status === "failed"
                            ? "font-medium text-red-700"
                            : "text-slate-500"
                    }`}
                  >
                    {s.label}
                    {s.status === "running" ? t("settings.systemUpdate.inProgress") : ""}
                  </div>
                  {s.output && s.status !== "pending" ? (
                    <div
                      className={`mt-0.5 break-all text-xs ${
                        s.status === "failed" ? "text-red-600" : "text-slate-500"
                      }`}
                    >
                      {s.output.length > 240 ? `${s.output.slice(0, 240)}...` : s.output}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {updateDone ? (
            <div className="mt-4">
              {updateOk ? (
                <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
                  <div className="text-sm font-medium text-emerald-800">{t("settings.systemUpdate.updateComplete")}</div>
                  <button
                    onClick={() => window.location.reload()}
                    className="ml-auto h-8 rounded-md bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-700"
                  >
                    {t("settings.systemUpdate.reloadPage")}
                  </button>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
                  <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-red-800">{t("settings.systemUpdate.updateFailed")}</div>
                    {updateError ? <div className="mt-1 break-all text-xs text-red-600">{updateError}</div> : null}
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
