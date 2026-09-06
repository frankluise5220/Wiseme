import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const port = Number(process.env.MMH_UPDATER_PORT || 7788);
const token = String(process.env.MMH_UPDATE_TOKEN || "").trim();
const workdir = process.env.MMH_WORKDIR || "/workspace";
const composeProject = process.env.MMH_COMPOSE_PROJECT || "mmh";
const composeFile = process.env.MMH_COMPOSE_FILE || `${workdir}/docker-compose.yml`;
const taskStateFile = `${workdir}/.mmh-update-task.json`;
const ghcrImage = "ghcr.io/frankluise5220/mmh:latest";
const daocloudImage = "ghcr.m.daocloud.io/frankluise5220/mmh:latest";
const dockerproxyImage = "ghcr.dockerproxy.net/frankluise5220/mmh:latest";
const njuImage = "ghcr.nju.edu.cn/frankluise5220/mmh:latest";
const fnvpsImage = "fnapp.floatingice.win:5000/frankluise5220/mmh:latest";
const ghcrUpdaterImage = "ghcr.io/frankluise5220/mmh-updater:latest";
const daocloudUpdaterImage = "ghcr.m.daocloud.io/frankluise5220/mmh-updater:latest";
const dockerproxyUpdaterImage = "ghcr.dockerproxy.net/frankluise5220/mmh-updater:latest";
const njuUpdaterImage = "ghcr.nju.edu.cn/frankluise5220/mmh-updater:latest";
const fnvpsUpdaterImage = "fnapp.floatingice.win:5000/frankluise5220/mmh-updater:latest";
const quotedWorkdir = JSON.stringify(workdir);

const imageSources = {
  ghcr: { name: "GHCR", app: ghcrImage, updater: ghcrUpdaterImage },
  dockerproxy: { name: "dockerproxy", app: dockerproxyImage, updater: dockerproxyUpdaterImage },
  nju: { name: "NJU", app: njuImage, updater: njuUpdaterImage },
  daocloud: { name: "DaoCloud", app: daocloudImage, updater: daocloudUpdaterImage },
  fnvps: { name: "FN VPS", app: fnvpsImage, updater: fnvpsUpdaterImage },
};

const autoImageSourceOrder = ["dockerproxy", "nju", "ghcr", "daocloud"];

let task = {
  running: false,
  status: "idle",
  currentStep: "",
  logs: [],
  error: "",
  startedAt: null,
  updatedAt: null,
};

// Host-side workdir of the updater container, resolved at startup so compose
// relative bind mounts (e.g. ./data) are evaluated against real host paths.
// currentUpdaterImage is the image the updater container itself runs, used as
// the helper container image for host-path compose execution.
let hostWorkdir = "";
let currentUpdaterImage = "";

async function resolveHostWorkdir() {
  try {
    const source = await captureDocker([
      "inspect",
      "mmh-updater",
      "--format",
      "{{range .Mounts}}{{if eq .Destination \"/workspace\"}}{{.Source}}{{end}}{{end}}",
    ]);
    if (source && source.startsWith("/")) hostWorkdir = source;
  } catch {
    hostWorkdir = "";
  }
  try {
    const image = await captureDocker(["inspect", "mmh-updater", "--format", "{{.Config.Image}}"]);
    if (image) currentUpdaterImage = image;
  } catch {
    currentUpdaterImage = "";
  }
}

async function persistTask() {
  await writeFile(taskStateFile, JSON.stringify(task), "utf8");
}

async function readRecentPersistedTask() {
  try {
    const saved = JSON.parse(await readFile(taskStateFile, "utf8"));
    const updatedAt = Date.parse(String(saved?.updatedAt || ""));
    const isRecent = Number.isFinite(updatedAt) && Date.now() - updatedAt < 60 * 60 * 1000;
    if (!isRecent || !["completed", "failed"].includes(saved?.status)) return null;
    return { ...saved, running: false };
  } catch {
    return null;
  }
}

function now() {
  return new Date().toISOString();
}

function pushLog(line) {
  task.logs.push(`[${now()}] ${line}`);
  if (task.logs.length > 300) task.logs = task.logs.slice(-300);
  task.updatedAt = now();
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function authorized(req) {
  if (!token) return false;
  return req.headers.authorization === `Bearer ${token}`;
}

function run(command, step, options = {}) {
  return new Promise((resolve, reject) => {
    task.currentStep = step;
    pushLog(`开始：${step}`);
    const child = spawn("sh", ["-lc", `git config --global --add safe.directory ${quotedWorkdir} >/dev/null 2>&1 || true; ${command}`], { cwd: workdir });
    child.stdout.on("data", (chunk) => pushLog(chunk.toString().trim()));
    child.stderr.on("data", (chunk) => pushLog(chunk.toString().trim()));
    child.on("close", (code) => {
      if (code === 0) {
        pushLog(`完成：${step}`);
        resolve();
      } else {
        const message = `${step}失败，退出码 ${code}`;
        if (options.allowFailure) {
          pushLog(`${message}，继续执行`);
          resolve();
          return;
        }
        reject(new Error(message));
      }
    });
    child.on("error", reject);
  });
}

function composeCommand(args) {
  // The updater container resolves compose relative paths (e.g. ./data) against
  // its own working dir. When the container runs in /workspace mode, that yields
  // /workspace/data, which does not exist on the host, so bind mounts fail.
  // Detect the host workdir and run compose through a helper container mounted
  // at the host path instead, so relative bind mounts resolve to real host paths.
  if (hostWorkdir && currentUpdaterImage && composeFile.startsWith(`${workdir}/`)) {
    const relativeCompose = composeFile.slice(workdir.length + 1) || "docker-compose.yml";
    const hostComposeFile = `${hostWorkdir}/${relativeCompose}`;
    const inner = [
      `mkdir -p ${JSON.stringify(`${hostWorkdir}/data`)};`,
      "docker compose",
      `-p ${composeProject}`,
      `-f ${JSON.stringify(hostComposeFile)}`,
      args,
    ].join(" ");
    return [
      "docker run",
      "--rm",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-v",
      `${JSON.stringify(hostWorkdir)}:${JSON.stringify(hostWorkdir)}`,
      "-w",
      JSON.stringify(hostWorkdir),
      "--entrypoint",
      "sh",
      currentUpdaterImage,
      "-lc",
      JSON.stringify(inner),
    ].join(" ");
  }
  return `docker compose -p ${composeProject} -f "${composeFile}" ${args}`;
}

function syncDeployFilesCommand() {
  return [
    `if [ -d ${quotedWorkdir}/.git ]; then`,
    `git config --global --add safe.directory ${quotedWorkdir} >/dev/null 2>&1 || true;`,
    `git -C ${quotedWorkdir} pull --ff-only;`,
    `elif [ -f /updater/deploy/docker-compose.yml ]; then`,
    `cp /updater/deploy/docker-compose.yml ${quotedWorkdir}/docker-compose.yml;`,
    `cp /updater/deploy/postgres-entrypoint.sh ${quotedWorkdir}/postgres-entrypoint.sh;`,
    `chmod +x ${quotedWorkdir}/postgres-entrypoint.sh;`,
    `echo "已从更新器镜像同步部署文件";`,
    `else echo "未发现 Git 仓库或内置部署文件，跳过部署文件同步"; fi`,
  ].join(" ");
}

async function updateEnvImageSource(appImage, updaterImage) {
  await updateEnvValues({
    MMH_APP_IMAGE: appImage,
    MMH_UPDATER_IMAGE: updaterImage,
  });
}

// The updater image lives in the same registry as the app image with the repo
// name `mmh-updater`, so the custom source only needs the app image address.
function deriveUpdaterImage(appImage) {
  const value = String(appImage || "").trim();
  if (!value) return "";
  return value.replace(/\/(mmh)(?=[:@]|$)/, "/mmh-updater");
}

async function readEnvValues() {
  const envPath = `${workdir}/.env`;
  let text = "";
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    return {};
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return values;
}

async function updateEnvValues(values) {
  const envPath = `${workdir}/.env`;
  let text = "";
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    text = "";
  }

  const setLine = (source, key, value) => {
    const line = `${key}="${value}"`;
    if (source.match(new RegExp(`^${key}=`, "m"))) {
      return source.replace(new RegExp(`^${key}=.*$`, "m"), line);
    }
    return `${source.trimEnd()}\n${line}\n`;
  };

  for (const [key, value] of Object.entries(values)) {
    text = setLine(text, key, String(value ?? ""));
  }
  await writeFile(envPath, text);
}

async function getImageSourceConfig() {
  const env = await readEnvValues();
  const source = env.MMH_IMAGE_SOURCE || "auto";
  const customAppImage = env.CUSTOM_MMH_APP_IMAGE || "";
  const customUpdaterImage = env.CUSTOM_MMH_UPDATER_IMAGE || "";
  return {
    source,
    appImage: env.MMH_APP_IMAGE || "",
    updaterImage: env.MMH_UPDATER_IMAGE || "",
    customAppImage,
    customUpdaterImage,
    options: [
      { value: "auto", label: "自动选择", appImage: "", updaterImage: "" },
      ...Object.entries(imageSources).map(([value, sourceConfig]) => ({
        value,
        label: sourceConfig.name,
        appImage: sourceConfig.app,
        updaterImage: sourceConfig.updater,
      })),
      { value: "custom", label: "自定义", appImage: customAppImage, updaterImage: customUpdaterImage },
    ],
  };
}

async function saveImageSourceConfig(input) {
  const source = String(input?.source || "auto").trim();
  const customAppImage = String(input?.customAppImage || "").trim();
  const customUpdaterImage = String(input?.customUpdaterImage || "").trim();
  const values = { MMH_IMAGE_SOURCE: source };

  if (source === "custom") {
    if (!customAppImage) {
      throw new Error("自定义镜像源需要填写应用镜像地址");
    }
    const updaterImage = customUpdaterImage || deriveUpdaterImage(customAppImage);
    values.CUSTOM_MMH_APP_IMAGE = customAppImage;
    values.CUSTOM_MMH_UPDATER_IMAGE = updaterImage;
    values.MMH_APP_IMAGE = customAppImage;
    values.MMH_UPDATER_IMAGE = updaterImage;
  } else if (source !== "auto") {
    const selected = imageSources[source];
    if (!selected) throw new Error(`未知镜像源: ${source}`);
    values.MMH_APP_IMAGE = selected.app;
    values.MMH_UPDATER_IMAGE = selected.updater;
  }

  await updateEnvValues(values);
  return getImageSourceConfig();
}

function getImageForSpeedTest(source, env, customAppImage) {
  if (source === "custom") return customAppImage || env.CUSTOM_MMH_APP_IMAGE || "";
  return imageSources[source]?.app || "";
}

function shortDigest(digest) {
  return String(digest || "").replace(/^sha256:/, "").slice(0, 12);
}

function captureDocker(args, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("docker", args, { cwd: workdir });
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `docker 退出码 ${code}`));
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function getLocalAppImageVersion() {
  try {
    const inspectText = await captureDocker([
      "inspect",
      "mmh-app",
      "--format",
      "{{json .Config.Labels}}|{{.Image}}",
    ]);
    const separator = inspectText.lastIndexOf("|");
    const labels = separator >= 0 ? JSON.parse(inspectText.slice(0, separator) || "{}") : {};
    const imageId = separator >= 0 ? inspectText.slice(separator + 1).trim() : "";
    const repoDigestsText = imageId
      ? await captureDocker(["image", "inspect", imageId, "--format", "{{json .RepoDigests}}"])
      : "[]";
    const repoDigests = JSON.parse(repoDigestsText || "[]");
    const digest = String(repoDigests.find((value) => String(value).includes("@sha256:")) || "").split("@")[1] || "";
    const revision = String(labels?.["org.opencontainers.image.revision"] || "");
    return {
      digest,
      digestShort: shortDigest(digest),
      revision,
      commit: revision.slice(0, 7),
      created: String(labels?.["org.opencontainers.image.created"] || ""),
      message: String(labels?.["org.opencontainers.image.description"] || "").split("\n")[0] || "",
      version: String(labels?.["org.opencontainers.image.version"] || ""),
    };
  } catch {
    return { digest: "", digestShort: "", revision: "", commit: "", created: "", message: "", version: "" };
  }
}

function extractImageVersion(manifestText) {
  try {
    const data = JSON.parse(manifestText);
    const descriptor = Array.isArray(data) ? data[0] : data;
    const labels = descriptor?.image?.config?.Labels
      ?? descriptor?.Image?.config?.Labels
      ?? descriptor?.Descriptor?.annotations
      ?? descriptor?.OCIManifest?.annotations
      ?? descriptor?.OCIv1Manifest?.annotations
      ?? descriptor?.SchemaV2Manifest?.config?.Labels
      ?? descriptor?.Config?.Labels
      ?? {};
    const digest = descriptor?.manifest?.digest
      ?? descriptor?.Manifest?.digest
      ?? descriptor?.Descriptor?.digest
      ?? descriptor?.Descriptor?.Digest
      ?? descriptor?.OCIManifest?.config?.digest
      ?? descriptor?.OCIv1Manifest?.config?.digest
      ?? descriptor?.SchemaV2Manifest?.config?.digest
      ?? descriptor?.Ref;
    const revision = labels["org.opencontainers.image.revision"] || "";
    const created = labels["org.opencontainers.image.created"] || descriptor?.image?.created || "";
    const message = labels["org.opencontainers.image.description"] || "";
    const version = labels["org.opencontainers.image.version"] || "";
    return {
      digest: String(digest || ""),
      digestShort: shortDigest(digest),
      revision: String(revision || ""),
      commit: String(revision || "").slice(0, 7),
      created: String(created || ""),
      message: String(message || "").split("\n")[0] || "",
      version: String(version || ""),
    };
  } catch {
    return { digest: "", digestShort: "", revision: "", commit: "", created: "", message: "", version: "" };
  }
}

function normalizeTimeoutMs(input, fallback = 12000) {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), 3000), 15000);
}

function testImageManifest(source, image, timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (!image) {
      resolve({ source, ok: false, error: "未填写镜像地址" });
      return;
    }

    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn("docker", [
      "buildx",
      "imagetools",
      "inspect",
      image,
      "--format",
      "{{json .}}",
    ], { cwd: workdir });
    const timer = setTimeout(() => {
      if (!settled) child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timer);
      const ms = Date.now() - startedAt;
      resolve({
        source,
        image,
        ok: code === 0,
        ms,
        version: code === 0 ? extractImageVersion(stdout) : undefined,
        error: code === 0 ? "" : (stderr.trim().split(/\r?\n/).slice(-1)[0] || `退出码 ${code}`),
      });
    });
    child.on("error", (error) => {
      settled = true;
      clearTimeout(timer);
      resolve({ source, image, ok: false, ms: Date.now() - startedAt, error: error.message });
    });
  });
}

async function testImageSourceSpeed(input) {
  const env = await readEnvValues();
  const requestedSource = String(input?.source || "").trim();
  const customAppImage = String(input?.customAppImage || "").trim();
  const timeoutMs = normalizeTimeoutMs(input?.timeoutMs);
  const sources = requestedSource
    ? [requestedSource]
    : [...Object.keys(imageSources), "custom"];

  const [results, localVersion] = await Promise.all([
    Promise.all(sources.map((source) => {
      const image = getImageForSpeedTest(source, env, customAppImage);
      return testImageManifest(source, image, timeoutMs);
    })),
    getLocalAppImageVersion(),
  ]);
  return { results, localVersion };
}

async function chooseImageSource() {
  const config = await getImageSourceConfig();

  if (config.source === "custom") {
    if (!config.customAppImage) {
      throw new Error("自定义镜像源需要填写应用镜像地址");
    }
    const updaterImage = config.customUpdaterImage || deriveUpdaterImage(config.customAppImage);
    pushLog("使用自定义镜像源");
    await updateEnvImageSource(config.customAppImage, updaterImage);
    return { appImage: config.customAppImage, updaterImage };
  }

  const selected = config.source !== "auto" ? imageSources[config.source] : null;
  if (config.source !== "auto" && !selected) {
    throw new Error(`未知镜像源: ${config.source}`);
  }
  const candidates = config.source === "auto"
    ? autoImageSourceOrder.map((key) => imageSources[key])
    : [
        selected,
        ...autoImageSourceOrder
          .filter((key) => key !== config.source)
          .map((key) => imageSources[key]),
      ].filter(Boolean);

  task.currentStep = "检测镜像源";
  pushLog("检测镜像源");
  for (const source of candidates) {
    pushLog(`检测 ${source.name} 镜像源`);
    const ok = await inspectImageSource(source);
    if (ok) {
      pushLog(`使用 ${source.name} 镜像源`);
      await updateEnvImageSource(source.app, source.updater);
      return { appImage: source.app, updaterImage: source.updater };
    }
    pushLog(`${source.name} 镜像源不可用，尝试下一个`);
  }

  pushLog("镜像源检测失败，保留当前 .env 配置");
  return { appImage: config.appImage, updaterImage: config.updaterImage };
}

function inspectImageSource(source, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn("docker", ["manifest", "inspect", source.app], { cwd: workdir, stdio: "ignore" });
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(false);
    }, timeoutMs);

    child.on("close", (code) => finish(code === 0));
    child.on("error", () => finish(false));
  });
}

async function scheduleUpdaterRecreate(updaterImage) {
  const workspaceSource = await captureDocker([
    "inspect",
    "mmh-updater",
    "--format",
    "{{range .Mounts}}{{if eq .Destination \"/workspace\"}}{{.Source}}{{end}}{{end}}",
  ]);
  // The updater may run in host-path mode (no /workspace mount). Fall back to
  // a mount whose destination equals the configured workdir.
  const hostWorkdirForRecreate =
    workspaceSource && workspaceSource.startsWith("/")
      ? workspaceSource
      : await captureDocker([
          "inspect",
          "mmh-updater",
          "--format",
          `{{range .Mounts}}{{if eq .Destination ${JSON.stringify(workdir)}}}{{.Source}}{{end}}{{end}}`,
        ]).catch(() => "");
  if (!hostWorkdirForRecreate || !hostWorkdirForRecreate.startsWith("/")) {
    throw new Error("无法确定更新目录在宿主机上的路径");
  }
  const composeRelativePath = composeFile.startsWith(`${workdir}/`)
    ? composeFile.slice(workdir.length + 1)
    : "docker-compose.yml";
  const hostComposeFile = `${hostWorkdirForRecreate}/${composeRelativePath}`;

  return new Promise((resolve, reject) => {
    if (!updaterImage) {
      reject(new Error("未找到更新执行器镜像地址"));
      return;
    }
    const helperName = `mmh-updater-reloader-${Date.now()}`;
    const recreateCommand = [
      "sleep 3;",
      `docker compose -p ${composeProject}`,
      `-f ${JSON.stringify(hostComposeFile)}`,
      "up -d --no-deps --force-recreate updater",
      "docker image prune -af >/dev/null 2>&1 || true",
    ].join(" ");
    const child = spawn("docker", [
      "run",
      "--rm",
      "-d",
      "--name",
      helperName,
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-v",
      `${hostWorkdirForRecreate}:${hostWorkdirForRecreate}`,
      "-w",
      hostWorkdirForRecreate,
      "--entrypoint",
      "sh",
      updaterImage,
      "-lc",
      recreateCommand,
    ], { cwd: workdir });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `启动更新执行器重建任务失败，退出码 ${code}`));
    });
    child.on("error", reject);
  });
}

async function waitForAppReady(timeoutMs = 6 * 60 * 1000) {
  const appUrl = "http://app:7777/";
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(appUrl, { signal: controller.signal, cache: "no-store" });
      clearTimeout(timer);
      // 任意 <500 的响应都说明应用已开始对外服务（首页、登录页、未授权提示等都算）。
      if (res.status < 500) return;
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `应用在 ${Math.round(timeoutMs / 60000)} 分钟内未能启动完成（最后状态：${lastError || "无响应"}）。` +
      "镜像可能已经拉取成功，请在宿主机执行 sudo docker compose logs --tail 50 app 查看原因。",
  );
}

async function startUpdate() {
  if (task.running) return false;
  task = {
    running: true,
    status: "running",
    currentStep: "准备更新",
    logs: [],
    error: "",
    startedAt: now(),
    updatedAt: now(),
  };

  void (async () => {
    try {
      await resolveHostWorkdir();
      await run(syncDeployFilesCommand(), "同步部署文件", { allowFailure: true });
      const selectedImages = await chooseImageSource();
      await run(composeCommand("pull updater app"), "拉取应用镜像");
      task.status = "restarting";
      task.currentStep = "重启服务";
      pushLog("即将重启服务");
      setTimeout(() => {
        void (async () => {
          try {
            await run(composeCommand("up -d --no-deps --force-recreate app"), "重启服务");
            pushLog("等待应用启动完成...");
            await waitForAppReady();
            task.status = "completed";
            task.running = false;
            task.currentStep = "完成";
            pushLog("更新完成");
            await persistTask();
            await scheduleUpdaterRecreate(selectedImages.updaterImage);
            pushLog("更新执行器将切换到所选镜像源");
          } catch (error) {
            task.status = "failed";
            task.running = false;
            task.error = error instanceof Error ? error.message : String(error);
            pushLog(task.error);
            await persistTask().catch(() => {});
          }
        })();
      }, 5000);
    } catch (error) {
      task.status = "failed";
      task.running = false;
      task.error = error instanceof Error ? error.message : String(error);
      pushLog(task.error);
      await persistTask().catch(() => {});
    }
  })();

  return true;
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!authorized(req)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  if (req.method === "POST" && req.url === "/update") {
    startUpdate().then((started) => {
      sendJson(res, started ? 202 : 409, { ok: started, task });
    });
    return;
  }

  if (req.method === "GET" && req.url === "/config") {
    getImageSourceConfig()
      .then((config) => sendJson(res, 200, { ok: true, config }))
      .catch((error) => sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }));
    return;
  }

  if (req.method === "POST" && req.url === "/config") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      let input = {};
      try {
        input = body ? JSON.parse(body) : {};
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid json" });
        return;
      }
      saveImageSourceConfig(input)
        .then((config) => sendJson(res, 200, { ok: true, config }))
        .catch((error) => sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }));
    });
    return;
  }

  if (req.method === "POST" && req.url === "/speed") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      let input = {};
      try {
        input = body ? JSON.parse(body) : {};
      } catch {
        sendJson(res, 400, { ok: false, error: "invalid json" });
        return;
      }
      testImageSourceSpeed(input)
        .then(({ results, localVersion }) => sendJson(res, 200, { ok: true, results, localVersion }))
        .catch((error) => sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) }));
    });
    return;
  }

  if (req.method === "GET" && req.url === "/status") {
    if (task.status !== "idle") {
      sendJson(res, 200, { ok: true, task });
      return;
    }
    readRecentPersistedTask()
      .then((savedTask) => sendJson(res, 200, { ok: true, task: savedTask || task }))
      .catch(() => sendJson(res, 200, { ok: true, task }));
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[mmh-updater] listening on ${port}`);
});
