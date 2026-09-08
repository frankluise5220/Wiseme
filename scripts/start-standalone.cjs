const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const nextDir = path.join(rootDir, ".next");
const standaloneDir = path.join(nextDir, "standalone");
const standaloneNextDir = path.join(standaloneDir, ".next");
const serverFile = path.join(standaloneDir, "server.js");
const buildIdFile = path.join(nextDir, "BUILD_ID");
const markerFile = path.join(standaloneNextDir, "runtime-sync.json");

function ensureBuildArtifacts() {
  if (!fs.existsSync(serverFile) || !fs.existsSync(buildIdFile)) {
    console.error("[mmh] Missing standalone build output. Run `npm run build` first.");
    process.exit(1);
  }
}

function readBuildId() {
  return fs.readFileSync(buildIdFile, "utf8").trim();
}

function readMarker() {
  if (!fs.existsSync(markerFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(markerFile, "utf8"));
  } catch {
    return null;
  }
}

function syncDirectory(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

function syncRuntimeAssets() {
  const buildId = readBuildId();
  const marker = readMarker();
  const staticSrc = path.join(nextDir, "static");
  const staticDest = path.join(standaloneNextDir, "static");
  const publicSrc = path.join(rootDir, "public");
  const publicDest = path.join(standaloneDir, "public");
  const publicExists = fs.existsSync(publicSrc);

  const alreadySynced =
    marker?.buildId === buildId &&
    fs.existsSync(staticDest) &&
    (!publicExists || fs.existsSync(publicDest));

  if (alreadySynced) {
    return;
  }

  syncDirectory(staticSrc, staticDest);
  if (publicExists) {
    syncDirectory(publicSrc, publicDest);
  }

  fs.mkdirSync(standaloneNextDir, { recursive: true });
  fs.writeFileSync(
    markerFile,
    JSON.stringify(
      {
        buildId,
        syncedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function startStandaloneServer() {
  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: process.env.PORT || "7777",
    HOSTNAME: process.env.HOSTNAME || "0.0.0.0",
  };

  const child = spawn(process.execPath, ["server.js"], {
    cwd: standaloneDir,
    env,
    stdio: "inherit",
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

ensureBuildArtifacts();
syncRuntimeAssets();
startStandaloneServer();
