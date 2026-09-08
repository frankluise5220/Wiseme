/**
 * System update API.
 *
 * GET: returns the current version, deployment target, remote version, and whether an update is needed.
 * POST ?mode=update: runs git fetch + fast-forward merge, then installs dependencies, generates Prisma, syncs the database, and builds.
 * POST ?mode=rebuild: does not pull code; only reinstalls dependencies, generates Prisma, syncs the database, and builds.
 *
 * Response format:
 * - GET: { ok, deploymentTarget, isDocker, isFnos, isSynology, updateMode, localVersion, localReleaseNotes, localCommit, localCommitMsg, localCommitDate, remoteVersion, remoteCommit, remoteCommitMsg, needsUpdate, canCheckUpdate }
 * - POST: text/event-stream; each data is { step, status, output? }, ending with { type: "done", ok, error?, restartRequired }
 */
import { NextRequest, NextResponse } from "next/server";
import { exec, execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

/** System update runs git pull, dependency install, database changes, and builds; only admins may trigger it. */
async function requireAdmin(): Promise<NextResponse | null> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }
  if (!isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "仅管理员可操作" }, { status: 403 });
  }
  return null;
}

type VersionInfo = {
  localCommit: string;
  localCommitFull: string;
  localCommitMsg: string;
  localCommitDate: string;
  remoteName: string;
  remoteBranch: string;
  remoteUrl: string;
  remoteVersion: string;
  remoteCommit: string;
  remoteCommitMsg: string;
  remoteCommitDate: string;
  needsUpdate: boolean;
  canCheckUpdate: boolean;
  githubUrl: string;
  githubVersion: string;
  githubCommit: string;
  githubCommitMsg: string;
  githubCommitDate: string;
  githubCanCheck: boolean;
  githubFetchError?: string;
  fetchError?: string;
  versionSource: "git" | "env";
};

type GitHubVersionInfo = Pick<
  VersionInfo,
  "githubUrl" | "githubVersion" | "githubCommit" | "githubCommitMsg" | "githubCommitDate" | "githubCanCheck" | "githubFetchError"
>;

type ImageSourceConfig = {
  source: string;
  appImage: string;
  updaterImage: string;
  customAppImage: string;
  customUpdaterImage: string;
  options: Array<{ value: string; label: string; appImage?: string; updaterImage?: string }>;
};

let updateRunning = false;
const DEFAULT_GITHUB_REPO_URL = "https://github.com/frankluise5220/MMH.git";
const GITHUB_REPO_API_URL = "https://api.github.com/repos/frankluise5220/MMH";
const IMAGE_FALLBACK_ORDER = ["fnvps", "dockerproxy", "nju", "ghcr", "daocloud", "custom"];
const STANDARD_IMAGE_SOURCE_ORDER = IMAGE_FALLBACK_ORDER.filter((source) => source !== "custom");
const UPDATER_DEFAULT_TIMEOUT_MS = 5_000;
const VERSION_CHECK_TIMEOUT_MS = 5_000;
const IMAGE_VERSION_CHECK_TIMEOUT_MS = 6_000;

function getUpdaterConfig() {
  const url = String(process.env.MMH_UPDATER_URL ?? "").trim();
  const token = String(process.env.MMH_UPDATE_TOKEN ?? "").trim();
  return { url, token, enabled: Boolean(url && token) };
}

async function callUpdater(path: string, init?: RequestInit, timeoutMs = UPDATER_DEFAULT_TIMEOUT_MS) {
  const { url, token } = getUpdaterConfig();
  if (!url || !token) {
    throw new Error("未配置宿主机更新执行器");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null) as any;
    if (!res.ok) {
      throw new Error(data?.error ?? `更新执行器请求失败：${res.status}`);
    }
    return data;
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") {
      throw new Error("更新执行器响应超时");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isDockerEnvironment(): boolean {
  if (existsSync("/.dockerenv")) return true;
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf-8");
    if (cgroup.includes("docker") || cgroup.includes("kubepods")) return true;
  } catch {
    // /proc is unavailable on non-Linux hosts.
  }
  return process.env.DOCKER_CONTAINER === "true";
}

function getDeploymentTarget(): "docker" | "fnos" | "synology" | "standalone" {
  if (isDockerEnvironment()) return "docker";
  const target = String(process.env.MMH_DEPLOY_TARGET ?? "").trim().toLowerCase();
  if (target === "fnos") return "fnos";
  if (target === "synology") return "synology";
  return "standalone";
}

function getPackageReleaseNotes(pkg: { mmhReleaseNotes?: unknown; releaseNotes?: unknown }) {
  const value = typeof pkg.mmhReleaseNotes === "string" ? pkg.mmhReleaseNotes : pkg.releaseNotes;
  return typeof value === "string" ? value.trim() : "";
}

function safeGitName(value: string | undefined, fallback: string) {
  const v = String(value ?? "").trim();
  if (!v || v.startsWith("-")) return fallback;
  return /^[A-Za-z0-9._/-]+$/.test(v) ? v : fallback;
}

function getGitTarget() {
  const remote = safeGitName(process.env.MMH_GIT_REMOTE, "origin");
  const branch = safeGitName(process.env.MMH_GIT_BRANCH, "main");
  return { remote, branch, ref: `${remote}/${branch}` };
}

function getLocalGitInfo(projectRoot: string) {
  const envCommit = String(process.env.APP_COMMIT ?? "").trim();
  const envCommitMsg = String(process.env.APP_COMMIT_MESSAGE ?? "").trim();
  const envCommitDate = String(process.env.APP_COMMIT_DATE ?? "").trim();
  if (envCommit) {
    return {
      localCommit: envCommit.slice(0, 7),
      localCommitFull: envCommit,
      localCommitMsg: envCommitMsg,
      localCommitDate: envCommitDate,
      versionSource: "env" as const,
    };
  }
  try {
    return {
      localCommit: execSync("git rev-parse --short HEAD", { cwd: projectRoot, encoding: "utf-8" }).trim(),
      localCommitFull: execSync("git rev-parse HEAD", { cwd: projectRoot, encoding: "utf-8" }).trim(),
      localCommitMsg: execSync("git log -1 --format=%s", { cwd: projectRoot, encoding: "utf-8" }).trim(),
      localCommitDate: execSync("git log -1 --format=%ci", { cwd: projectRoot, encoding: "utf-8" }).trim(),
      versionSource: "git" as const,
    };
  } catch {
    return { localCommit: "unknown", localCommitFull: "unknown", localCommitMsg: "", localCommitDate: "", versionSource: "git" as const };
  }
}

function readCommand(projectRoot: string, cmd: string) {
  return execSync(cmd, { cwd: projectRoot, encoding: "utf-8" }).trim();
}

function readCommandWithTimeout(projectRoot: string, cmd: string, timeout: number) {
  return execSync(cmd, { cwd: projectRoot, encoding: "utf-8", timeout }).trim();
}

function commandErrorMessage(error: unknown) {
  const e = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString();
  const stdout = typeof e.stdout === "string" ? e.stdout : e.stdout?.toString();
  return (stderr || stdout || e.message || "未知错误").trim();
}

async function fetchGitHubJson<T>(path: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERSION_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_REPO_API_URL}${path}`, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`GitHub request failed: ${res.status}`);
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

function versionFromReleaseTag(tagName: string) {
  return tagName.trim().replace(/^v/i, "");
}

function parseReleaseVersion(value: string) {
  const version = versionFromReleaseTag(value);
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((part) => !Number.isSafeInteger(part))) return null;
  // Ignore old calendar/test tags such as v2026.08.05 when the GitHub API is
  // unreachable and we have to fall back to raw tag listing.
  if (parts[0]! > 99) return null;
  return { version, parts };
}

function compareReleaseVersions(
  a: { parts: number[] },
  b: { parts: number[] },
) {
  for (let index = 0; index < 3; index += 1) {
    const diff = (a.parts[index] ?? 0) - (b.parts[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function latestReleaseTagFromLsRemote(output: string) {
  const tags = new Map<string, { tagName: string; version: string; parts: number[]; commit: string }>();
  for (const line of output.split(/\r?\n/)) {
    const [commit = "", ref = ""] = line.trim().split(/\s+/);
    const peeled = ref.endsWith("^{}");
    const tagName = ref.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");
    const parsed = parseReleaseVersion(tagName);
    if (!commit || !parsed) continue;
    const current = tags.get(tagName);
    if (!current || peeled) {
      tags.set(tagName, { tagName, version: parsed.version, parts: parsed.parts, commit });
    }
  }
  return [...tags.values()].sort((a, b) => compareReleaseVersions(b, a))[0] ?? null;
}

function githubVersionInfoFromRelease(params: {
  version: string;
  commit: string;
  commitMsg?: string;
  commitDate?: string;
}): GitHubVersionInfo {
  return {
    githubUrl: DEFAULT_GITHUB_REPO_URL,
    githubVersion: params.version,
    githubCommit: params.commit ? params.commit.slice(0, 7) : "unknown",
    githubCommitMsg: params.commitMsg ?? "",
    githubCommitDate: params.commitDate ?? "",
    githubCanCheck: Boolean(params.commit),
  };
}

async function getGitHubVersionInfo(projectRoot: string): Promise<GitHubVersionInfo> {
  let releaseFetchError: unknown = null;
  try {
    const release = await fetchGitHubJson<{
      tag_name?: string;
      target_commitish?: string;
      published_at?: string;
    }>("/releases/latest");
    const tagName = String(release.tag_name ?? "").trim();
    if (!tagName) throw new Error("Latest GitHub release has no tag");

    let commit = "";
    let commitMsg = "";
    let commitDate = String(release.published_at ?? "");
    try {
      const data = await fetchGitHubJson<{
        sha?: string;
        commit?: { message?: string; committer?: { date?: string } };
      }>(`/commits/${encodeURIComponent(tagName)}`);
      commit = String(data.sha ?? "").trim();
      commitMsg = String(data.commit?.message ?? "").split("\n")[0] ?? "";
      commitDate = String(data.commit?.committer?.date ?? commitDate);
    } catch {
      const target = String(release.target_commitish ?? "").trim();
      commit = /^[a-f0-9]{40}$/i.test(target) ? target : "";
    }

    return githubVersionInfoFromRelease({
      version: versionFromReleaseTag(tagName),
      commit,
      commitMsg,
      commitDate,
    });
  } catch (error) {
    releaseFetchError = error;
  }

  try {
    const refs = readCommandWithTimeout(
      projectRoot,
      `git ls-remote --tags ${DEFAULT_GITHUB_REPO_URL} "refs/tags/v*"`,
      VERSION_CHECK_TIMEOUT_MS,
    );
    const latest = latestReleaseTagFromLsRemote(refs);
    if (latest) {
      return githubVersionInfoFromRelease({
        version: latest.version,
        commit: latest.commit,
      });
    }
    throw new Error("No formal release tags found");
  } catch (tagError) {
    return {
      githubUrl: DEFAULT_GITHUB_REPO_URL,
      githubVersion: "",
      githubCommit: "unknown",
      githubCommitMsg: "",
      githubCommitDate: "",
      githubCanCheck: false,
      githubFetchError: [releaseFetchError, tagError]
        .map(commandErrorMessage)
        .filter(Boolean)
        .join("; "),
    };
  }
}

function getPackageVersionAtRef(projectRoot: string, ref: string) {
  try {
    const pkg = JSON.parse(readCommand(projectRoot, `git show ${ref}:package.json`)) as { version?: string };
    return String(pkg.version || "").trim();
  } catch {
    return "";
  }
}

async function getGitVersionInfo(projectRoot: string): Promise<VersionInfo> {
  const { remote, branch, ref } = getGitTarget();
  const local = getLocalGitInfo(projectRoot);
  const github = await getGitHubVersionInfo(projectRoot);
  let remoteUrl = String(process.env.MMH_UPDATE_SOURCE_URL ?? "").trim();

  if (isDockerEnvironment() || local.versionSource === "env") {
    remoteUrl = remoteUrl || DEFAULT_GITHUB_REPO_URL;
    const githubCommit = github.githubCommit;
    const canCheck = github.githubCanCheck && githubCommit !== "unknown" && local.localCommit !== "unknown";
    const localComparable = local.localCommitFull !== "unknown" ? local.localCommitFull.slice(0, 7) : local.localCommit;

    return {
      ...local,
      ...github,
      remoteName: "github",
      remoteBranch: "latest",
      remoteUrl,
      remoteVersion: github.githubVersion,
      remoteCommit: githubCommit,
      remoteCommitMsg: github.githubCommitMsg,
      remoteCommitDate: github.githubCommitDate,
      needsUpdate: canCheck ? localComparable !== githubCommit : false,
      canCheckUpdate: canCheck,
      fetchError: undefined,
    };
  }

  try {
    if (!remoteUrl) {
      remoteUrl = readCommand(projectRoot, `git remote get-url ${remote}`);
    }
  } catch {
    remoteUrl = remoteUrl || "";
  }

  try {
    execSync(`git fetch ${remote} ${branch}`, { cwd: projectRoot, encoding: "utf-8", timeout: 15000 });
    const remoteCommit = readCommand(projectRoot, `git rev-parse --short ${ref}`);
    const remoteVersion = getPackageVersionAtRef(projectRoot, ref) || github.githubVersion;
    const remoteCommitMsg = readCommand(projectRoot, `git log -1 --format=%s ${ref}`);
    const remoteCommitDate = readCommand(projectRoot, `git log -1 --format=%ci ${ref}`);
    const localFull = readCommand(projectRoot, "git rev-parse HEAD");
    const remoteFull = readCommand(projectRoot, `git rev-parse ${ref}`);

    return {
      ...local,
      ...github,
      remoteName: remote,
      remoteBranch: branch,
      remoteUrl,
      remoteVersion,
      remoteCommit,
      remoteCommitMsg,
      remoteCommitDate,
      needsUpdate: localFull !== remoteFull,
      canCheckUpdate: true,
    };
  } catch (error) {
    return {
      ...local,
      ...github,
      remoteName: remote,
      remoteBranch: branch,
      remoteUrl,
      remoteVersion: github.githubVersion,
      remoteCommit: "unknown",
      remoteCommitMsg: "",
      remoteCommitDate: "",
      needsUpdate: false,
      canCheckUpdate: false,
      fetchError: commandErrorMessage(error),
    };
  }
}

function getComparableShortCommit(value: string | undefined) {
  const commit = String(value ?? "").trim();
  if (!commit || commit === "unknown") return "";
  return commit.slice(0, 7);
}

type ImageVersionSpeedResult = {
  source?: string;
  image?: string;
  ok?: boolean;
  error?: string;
  version?: {
    digest?: string;
    digestShort?: string;
    revision?: string;
    commit?: string;
    created?: string;
    message?: string;
    version?: string;
  };
};

function getImageVersionSourceOrder(imageSourceConfig: ImageSourceConfig | null) {
  const configuredSource = imageSourceConfig?.source || "auto";
  const customAppImage = imageSourceConfig?.customAppImage || "";
  if (configuredSource === "custom") return ["custom"];
  if (configuredSource && configuredSource !== "auto") {
    return [configuredSource, ...STANDARD_IMAGE_SOURCE_ORDER.filter((source) => source !== configuredSource)];
  }
  return customAppImage ? [...STANDARD_IMAGE_SOURCE_ORDER, "custom"] : STANDARD_IMAGE_SOURCE_ORDER;
}

function getImageVersionCheckBody(imageSourceConfig: ImageSourceConfig | null) {
  const configuredSource = imageSourceConfig?.source || "auto";
  const customAppImage = imageSourceConfig?.customAppImage || "";
  if (configuredSource === "custom") {
    return { source: "custom", customAppImage, timeoutMs: IMAGE_VERSION_CHECK_TIMEOUT_MS };
  }
  if (configuredSource && configuredSource !== "auto") {
    return { customAppImage, timeoutMs: IMAGE_VERSION_CHECK_TIMEOUT_MS };
  }
  return { customAppImage, timeoutMs: IMAGE_VERSION_CHECK_TIMEOUT_MS };
}

function getImageVersionFetchError(imageSourceConfig: ImageSourceConfig | null) {
  const sourceText = getImageVersionSourceOrder(imageSourceConfig).join("、");
  return `镜像版本检查失败或超时，已按顺序尝试：${sourceText}`;
}

async function getImageVersionFallback(
  base: VersionInfo,
  imageSourceConfig: ImageSourceConfig | null,
): Promise<Partial<VersionInfo> | null> {
  if (!getUpdaterConfig().enabled) return null;
  const configuredSource = imageSourceConfig?.source || "auto";
  const sourceOrder = getImageVersionSourceOrder(imageSourceConfig);

  try {
    const data = await callUpdater("/speed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(getImageVersionCheckBody(imageSourceConfig)),
    }, IMAGE_VERSION_CHECK_TIMEOUT_MS + 2_000);
    const results = Array.isArray(data?.results) ? data.results as ImageVersionSpeedResult[] : [];

    const resultBySource = new Map(results.map((result) => [String(result.source || ""), result]));
    const selected = sourceOrder
      .map((source) => resultBySource.get(source))
      .find((result) => result?.ok && (result.version?.revision || result.version?.commit || result.version?.digest));
    if (!selected) return null;

    const revision = String(selected.version?.revision || selected.version?.commit || "").trim();
    const remoteDigest = String(selected.version?.digest || "").trim();
    const remoteDigestShort = String(
      selected.version?.digestShort || remoteDigest.replace(/^sha256:/, "").slice(0, 12),
    ).trim();
    const localImageVersion = data?.localVersion as ImageVersionSpeedResult["version"] | undefined;
    const localDigest = String(localImageVersion?.digest || "").trim();
    const remoteCommit = getComparableShortCommit(revision) || remoteDigestShort;
    const localCommit = getComparableShortCommit(base.localCommitFull || base.localCommit);
    if (!remoteCommit || (!localCommit && !localDigest)) return null;
    const needsUpdate = remoteDigest && localDigest
      ? remoteDigest !== localDigest
      : localCommit !== remoteCommit;

    return {
      remoteName: `image:${selected.source || configuredSource}`,
      remoteBranch: "latest",
      remoteUrl: selected.image || imageSourceConfig?.appImage || "",
      remoteVersion: String(selected.version?.version || "").trim(),
      remoteCommit,
      remoteCommitMsg: String(selected.version?.message || (revision ? "镜像版本" : "镜像摘要")).split("\n")[0],
      remoteCommitDate: String(selected.version?.created || ""),
      needsUpdate,
      canCheckUpdate: true,
      fetchError: undefined,
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if (auth) return auth;
  try {
    const { searchParams } = new URL(req.url);
    const checkRemote = searchParams.get("check") === "1";
    const projectRoot = process.cwd();
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
    const localVersion = pkg.version || "unknown";
    const localReleaseNotes = getPackageReleaseNotes(pkg);
    let imageSourceConfig: ImageSourceConfig | null = null;
    const deploymentTarget = getDeploymentTarget();
    const dockerEnvironment = deploymentTarget === "docker";
    const fnosEnvironment = deploymentTarget === "fnos";
    const synologyEnvironment = deploymentTarget === "synology";
    const managedPackageEnvironment = fnosEnvironment || synologyEnvironment;
    const updaterEnabled = getUpdaterConfig().enabled;
    // The image source config comes from the local updater; load it whenever the
    // updater is reachable so the settings panel is available on first load,
    // not only after a remote version check.
    if (dockerEnvironment && updaterEnabled) {
      try {
        const data = await callUpdater("/config", undefined, 3_000);
        imageSourceConfig = data.config ?? null;
      } catch {
        imageSourceConfig = null;
      }
    }
    const local = getLocalGitInfo(projectRoot);
    const localOnlyVersionInfo: VersionInfo = {
      ...local,
      remoteName: "",
      remoteBranch: "",
      remoteUrl: "",
      remoteVersion: "",
      remoteCommit: "unknown",
      remoteCommitMsg: "",
      remoteCommitDate: "",
      needsUpdate: false,
      canCheckUpdate: false,
      githubUrl: DEFAULT_GITHUB_REPO_URL,
      githubVersion: "",
      githubCommit: "unknown",
      githubCommitMsg: "",
      githubCommitDate: "",
      githubCanCheck: false,
      fetchError: undefined,
    };

    let versionInfo = localOnlyVersionInfo;
    if (checkRemote && dockerEnvironment) {
      const imageFallback = updaterEnabled
        ? await getImageVersionFallback(localOnlyVersionInfo, imageSourceConfig)
        : null;
      if (imageFallback) {
        versionInfo = {
          ...localOnlyVersionInfo,
          ...imageFallback,
        };
      } else if (updaterEnabled) {
        versionInfo = {
          ...localOnlyVersionInfo,
          fetchError: getImageVersionFetchError(imageSourceConfig),
        };
      } else {
        const github = await getGitHubVersionInfo(projectRoot);
        const githubCommit = github.githubCommit;
        const localComparable = local.localCommitFull !== "unknown" ? local.localCommitFull.slice(0, 7) : local.localCommit;
        const canCheck = github.githubCanCheck && githubCommit !== "unknown" && localComparable !== "unknown";
        // Without the host updater the web update flow cannot run at all. When
        // the direct GitHub fallback also fails, lead with an actionable hint
        // instead of the raw spawnSync error so users know how to fix it.
        const updaterDisabledHint =
          "未配置宿主机更新执行器（部署目录 .env 中 MMH_UPDATE_TOKEN 为空），网页检查与更新均不可用。" +
          "可在 .env 设置后执行 docker compose up -d app updater 启用，或用 docker compose pull 手动更新。GitHub 直连检查结果：";
        versionInfo = {
          ...localOnlyVersionInfo,
          ...github,
          remoteName: "github",
          remoteBranch: "latest",
          remoteUrl: DEFAULT_GITHUB_REPO_URL,
          remoteVersion: github.githubVersion,
          remoteCommit: githubCommit,
          remoteCommitMsg: github.githubCommitMsg,
          remoteCommitDate: github.githubCommitDate,
          needsUpdate: canCheck ? localComparable !== githubCommit : false,
          canCheckUpdate: canCheck,
          fetchError: canCheck ? undefined : `${updaterDisabledHint}${github.githubFetchError || "未知错误"}`,
        };
      }
    } else if (checkRemote && !managedPackageEnvironment) {
      versionInfo = await getGitVersionInfo(projectRoot);
    }

    return NextResponse.json({
      ok: true,
      deploymentTarget,
      isDocker: dockerEnvironment,
      isFnos: fnosEnvironment,
      isSynology: synologyEnvironment,
      updateMode: managedPackageEnvironment ? deploymentTarget : "git",
      updaterEnabled,
      imageSourceConfig,
      localVersion,
      localReleaseNotes,
      ...versionInfo,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: e instanceof Error ? e.message : "查询失败" }, { status: 500 });
  }
}

function sseEvent(encoder: TextEncoder, data: Record<string, unknown>) {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

function runStep(projectRoot: string, cmd: string, timeout: number): Promise<{ ok: boolean; code?: string; output: string }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd: projectRoot, encoding: "utf-8", timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, code: "STEP_FAILED", output: stderr?.trim() || err.message });
      else resolve({ ok: true, output: stdout?.trim() || "完成" });
    });
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if (auth) return auth;

  const { searchParams } = new URL(req.url);
  const deploymentTarget = getDeploymentTarget();
  if (deploymentTarget === "fnos") {
    return NextResponse.json(
      { ok: false, code: "FNOS_UPDATE_NOT_SUPPORTED", error: "飞牛版请通过飞牛应用中心更新 MMH 应用包" },
      { status: 409 },
    );
  }
  if (deploymentTarget === "synology") {
    return NextResponse.json(
      { ok: false, code: "SYNOLOGY_UPDATE_NOT_SUPPORTED", error: "Synology DSM package builds must be updated through Package Center or by installing a newer SPK." },
      { status: 409 },
    );
  }

  if (updateRunning) {
    return NextResponse.json({ ok: false, code: "UPDATE_ALREADY_RUNNING", error: "系统更新正在执行，请稍后再试" }, { status: 409 });
  }

  if (searchParams.get("status") === "1") {
    try {
      return NextResponse.json(await callUpdater("/status"));
    } catch (e) {
      return NextResponse.json({ ok: false, code: "UPDATE_STATUS_QUERY_FAILED", error: e instanceof Error ? e.message : "查询更新状态失败" }, { status: 500 });
    }
  }

  if (searchParams.get("config") === "1") {
    if (req.method !== "POST") {
      return NextResponse.json({ ok: false, code: "METHOD_NOT_ALLOWED", error: "method not allowed" }, { status: 405 });
    }
    try {
      const body = await req.json().catch(() => ({}));
      return NextResponse.json(await callUpdater("/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
    } catch (e) {
      return NextResponse.json({ ok: false, code: "IMAGE_SOURCE_SAVE_FAILED", error: e instanceof Error ? e.message : "保存镜像源失败" }, { status: 500 });
    }
  }

  if (searchParams.get("speed") === "1") {
    try {
      const body = await req.json().catch(() => ({}));
      return NextResponse.json(await callUpdater("/speed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
    } catch (e) {
      return NextResponse.json({ ok: false, code: "SPEED_TEST_FAILED", error: e instanceof Error ? e.message : "测速失败" }, { status: 500 });
    }
  }

  const mode = searchParams.get("mode") === "rebuild" ? "rebuild" : "update";
  const projectRoot = process.cwd();
  const dockerMode = isDockerEnvironment();
  if (dockerMode) {
    try {
      return NextResponse.json(await callUpdater("/update", { method: "POST" }), { status: 202 });
    } catch (e) {
      return NextResponse.json({ ok: false, code: "UPDATE_START_FAILED", error: e instanceof Error ? e.message : "启动更新失败" }, { status: 500 });
    }
  }
  const { remote, branch, ref } = getGitTarget();

  const allSteps: { step: string; cmd: string; timeout: number }[] = [
    { step: "拉取代码", cmd: `git fetch ${remote} ${branch} && git merge --ff-only ${ref}`, timeout: 60000 },
    { step: "安装依赖", cmd: "npm install --include=dev", timeout: 120000 },
    { step: "生成 Prisma Client", cmd: "npx prisma generate", timeout: 30000 },
    { step: "同步数据库", cmd: "npx prisma db push", timeout: 30000 },
    { step: "构建项目", cmd: "npm run build", timeout: 180000 },
  ];
  const steps = mode === "rebuild" ? allSteps.slice(1) : allSteps;
  const encoder = new TextEncoder();

  updateRunning = true;
  const stream = new ReadableStream({
    async start(controller) {
      let hasError = false;
      let errorMsg = "";

      try {
        for (const s of steps) {
          if (hasError) break;
          controller.enqueue(sseEvent(encoder, { step: s.step, status: "running" }));
          const result = await runStep(projectRoot, s.cmd, s.timeout);
          if (result.ok) {
            controller.enqueue(sseEvent(encoder, { step: s.step, status: "completed", output: result.output }));
          } else {
            controller.enqueue(sseEvent(encoder, { step: s.step, status: "failed", output: result.output }));
            hasError = true;
            errorMsg = `${s.step} 失败: ${result.output}`;
          }
        }

        controller.enqueue(sseEvent(encoder, { type: "done", ok: !hasError, error: errorMsg, restartRequired: dockerMode && !hasError }));
        controller.close();

        if (dockerMode && !hasError) {
          setTimeout(() => process.exit(0), 1500);
        }
      } finally {
        updateRunning = false;
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
