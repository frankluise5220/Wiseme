#!/usr/bin/env node

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const appName = "mmh";
const rawVersion = process.env.SYNOLOGY_PACKAGE_VERSION || process.env.SYNOPKG_PACKAGE_VERSION || pkg.version || "0.1.0";
const version = normalizeVersion(rawVersion);
const target = normalizeTarget(process.env.SYNOLOGY_TARGET_ARCH || process.env.SYNOPKG_TARGET_ARCH || "x86_64");
const outDir = path.join(root, "release-artifacts", "synology");
const stageDir = path.join(outDir, target.stageDirName);
const packageRoot = path.join(stageDir, "package");
const stageOnly = process.argv.includes("--stage-only");
const nodeTarball = process.env.SYNOLOGY_NODE_TARBALL || process.env.SYNOPKG_NODE_TARBALL || process.env.FNOS_NODE_TARBALL || "";
const packageReleaseNotes = typeof pkg.mmhReleaseNotes === "string" ? pkg.mmhReleaseNotes.trim() : "";
const dsmMinVersion = "7.0-40000";

function normalizeVersion(value) {
  const raw = String(value || "").trim();
  const normalized = raw.replace(/^refs\/tags\//, "").replace(/^v(?=\d)/, "").replace(/-synology(?:$|[.-].*)?$/, "");
  if (!/^0\.1\.\d+$/.test(normalized)) {
    throw new Error(`SYNOLOGY_PACKAGE_VERSION must use 0.1.x format, got ${normalized || "(empty)"}.`);
  }
  return normalized;
}

function normalizeTarget(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (["", "x86", "x86-64", "x64", "amd64"].includes(raw)) {
    return {
      id: "x86_64",
      assetSuffix: "x86_64",
      infoArch: "x86_64",
      nodeArch: "x64",
      processArch: "x64",
      fnosTarget: "x86",
      fnosStageDirName: "mmh-fpk",
      stageDirName: "mmh-spk",
    };
  }
  if (["arm", "arm64", "aarch64", "armv8"].includes(raw)) {
    return {
      id: "arm64",
      assetSuffix: "arm64",
      infoArch: "aarch64",
      nodeArch: "arm64",
      processArch: "arm64",
      fnosTarget: "arm64",
      fnosStageDirName: "mmh-arm64-fpk",
      stageDirName: "mmh-arm64-spk",
    };
  }
  throw new Error(`SYNOLOGY_TARGET_ARCH must be x86_64 or arm64, got ${value || "(empty)"}.`);
}

function mkdirp(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function write(file, content, mode) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, content.replace(/\r\n/g, "\n"), "utf8");
  if (mode) fs.chmodSync(file, mode);
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.cpSync(src, dest, { recursive: true });
  return true;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: options.stdio || "pipe",
    shell: false,
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : process.env,
  });
}

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function requirePath(targetPath, message) {
  if (!fs.existsSync(targetPath)) throw new Error(message);
}

function hashFileMd5(file) {
  const hash = crypto.createHash("md5");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function directorySizeKb(dir) {
  let bytes = 0;
  const walk = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) walk(path.join(current, entry));
      return;
    }
    if (stat.isFile()) bytes += stat.size;
  };
  walk(dir);
  return Math.max(1, Math.ceil(bytes / 1024));
}

function tarOwnerArgs() {
  return process.platform === "win32" ? [] : ["--owner=0", "--group=0", "--numeric-owner"];
}

function makeReadable(dir) {
  if (!fs.existsSync(dir)) return;
  const walk = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      fs.chmodSync(current, 0o755);
      for (const entry of fs.readdirSync(current)) walk(path.join(current, entry));
      return;
    }
    if (!stat.isFile()) return;
    const relative = path.relative(stageDir, current).replace(/\\/g, "/");
    const executable =
      relative.startsWith("scripts/") ||
      relative === "package/app/bin/node" ||
      relative.startsWith("package/app/bin/bin/");
    fs.chmodSync(current, executable ? 0o755 : 0o644);
  };
  walk(dir);
}

function findNodeHeadersDir() {
  const candidates = [
    path.dirname(path.dirname(process.execPath)),
    "/usr/local",
    "/usr",
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "include", "node", "node.h"))) || "";
}

function spkAssetName() {
  return `${appName}-synology-v${version}-${target.assetSuffix}.spk`;
}

function runFnosStage() {
  if (!nodeTarball) {
    throw new Error(`Provide a Linux ${target.nodeArch} Node runtime tarball with SYNOLOGY_NODE_TARBALL before building ${spkAssetName()}.`);
  }
  if (!path.basename(nodeTarball).includes(`linux-${target.nodeArch}`)) {
    throw new Error(`SYNOLOGY_NODE_TARBALL must match ${target.id}: expected a linux-${target.nodeArch} tarball.`);
  }
  const result = run(process.execPath, [path.join(root, "scripts", "build-fnos-package.cjs"), "--stage-only"], {
    stdio: "inherit",
    env: {
      FNOS_TARGET_ARCH: target.fnosTarget,
      FNOS_NODE_TARBALL: nodeTarball,
      FNOS_PACKAGE_VERSION: version,
    },
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

function writeInfoFile(options = {}) {
  const checksumLine = options.checksum ? `checksum="${options.checksum}"\n` : "";
  const extractSizeLine = options.extractSizeKb ? `extractsize="${options.extractSizeKb}"\n` : "";
  write(path.join(stageDir, "INFO"), `package="${appName}"
version="${version}"
displayname="MMH"
description="Local-first household finance workspace with SQLite storage for Synology DSM."
maintainer="frankluise5220"
support_url="https://github.com/frankluise5220/MMH"
arch="${target.infoArch}"
os_min_ver="${dsmMinVersion}"
${checksumLine}${extractSizeLine}thirdparty="yes"
startable="yes"
ctl_stop="yes"
silent_install="no"
silent_upgrade="yes"
silent_uninstall="no"
adminport="7777"
adminurl="/"
`);
}

function writeStartStopStatus() {
  write(path.join(stageDir, "scripts", "start-stop-status"), `#!/bin/sh

PACKAGE="mmh"
APP_DIR="\${SYNOPKG_PKGDEST:-/var/packages/$PACKAGE/target}"
SERVER_DIR="$APP_DIR/app/server"
NODE_BIN="$APP_DIR/app/bin/node"
VAR_DIR="\${SYNOPKG_PKGVAR:-/var/packages/$PACKAGE/var}"
LEGACY_VAR_DIR="$APP_DIR/var"
DATA_DIR="$VAR_DIR/data"
ENV_FILE="$VAR_DIR/mmh.env"
SYSTEM_PASSWORD_FILE="$VAR_DIR/mmh-system-password.txt"
SESSION_SECRET_FILE="$VAR_DIR/mmh-session-secret.txt"
PID_FILE="$VAR_DIR/mmh.pid"
LOG_FILE="$VAR_DIR/mmh.log"
DSM_LOG_FILE="\${SYNOPKG_TEMP_LOGFILE:-$VAR_DIR/synopkg-start.log}"

read_env_value() {
  key="$1"
  [ -f "$ENV_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key="*)
        val="\${line#*=}"
        val="\${val#\\'}"
        val="\${val%\\'}"
        printf '%s' "$val"
        return 0
        ;;
    esac
  done < "$ENV_FILE"
}

generate_system_password() {
  generated=""
  if command -v openssl >/dev/null 2>&1; then
    generated="$(openssl rand -base64 24 2>/dev/null | tr -dc 'A-Za-z0-9' | head -c 16 || true)"
  fi
  if [ -z "$generated" ] && command -v sha256sum >/dev/null 2>&1; then
    generated="$(date +%s%N | sha256sum | tr -dc 'A-Za-z0-9' | head -c 16 || true)"
  fi
  if [ -z "$generated" ]; then
    generated="mmh$(date +%s | tail -c 11)"
  fi
  printf '%s' "$generated"
}

generate_session_secret() {
  generated=""
  if command -v openssl >/dev/null 2>&1; then
    generated="$(openssl rand -base64 48 2>/dev/null | tr -d '[:space:]' || true)"
  fi
  if [ -z "$generated" ] && [ -x "$NODE_BIN" ]; then
    generated="$("$NODE_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))' 2>/dev/null || true)"
  fi
  if [ -n "$generated" ] && [ "\${#generated}" -ge 32 ]; then
    printf '%s' "$generated"
    return 0
  fi
  return 1
}

append_log() {
  mkdir -p "$VAR_DIR" 2>/dev/null || true
  message="$(date '+%Y-%m-%d %H:%M:%S') $*"
  echo "$message" >>"$LOG_FILE" 2>/dev/null || true
  if [ "$DSM_LOG_FILE" != "$LOG_FILE" ]; then
    echo "$message" >>"$DSM_LOG_FILE" 2>/dev/null || true
  fi
}

copy_log_tail_to_dsm() {
  if [ -f "$LOG_FILE" ] && [ "$DSM_LOG_FILE" != "$LOG_FILE" ]; then
    echo "---- MMH log tail ----" >>"$DSM_LOG_FILE" 2>/dev/null || true
    tail -n 100 "$LOG_FILE" >>"$DSM_LOG_FILE" 2>/dev/null || true
  fi
}

fail_start() {
  append_log "ERROR: $*"
  copy_log_tail_to_dsm
  tail -n 100 "$LOG_FILE" >&2 2>/dev/null || true
  exit 1
}

ensure_runtime_settings() {
  mkdir -p "$DATA_DIR"
  env_port="$(read_env_value PORT 2>/dev/null || true)"
  export PORT="\${PORT:-\${env_port:-7777}}"

  env_password="$(read_env_value MMH_SYSTEM_PASSWORD 2>/dev/null || true)"
  system_password="\${MMH_SYSTEM_PASSWORD:-$env_password}"
  if [ -z "$system_password" ] && [ -f "$SYSTEM_PASSWORD_FILE" ]; then
    system_password="$(tr -d '[:space:]' < "$SYSTEM_PASSWORD_FILE")"
  fi
  if [ -z "$system_password" ]; then
    system_password="$(generate_system_password)"
    append_log "Generated MMH system password at $SYSTEM_PASSWORD_FILE"
  fi
  export MMH_SYSTEM_PASSWORD="$system_password"

  env_session_secret="$(read_env_value MMH_SESSION_SECRET 2>/dev/null || true)"
  session_secret="\${MMH_SESSION_SECRET:-$env_session_secret}"
  if [ -z "$session_secret" ] && [ -f "$SESSION_SECRET_FILE" ]; then
    session_secret="$(tr -d '[:space:]' < "$SESSION_SECRET_FILE")"
  fi
  if [ -z "$session_secret" ] || [ "\${#session_secret}" -lt 32 ]; then
    session_secret="$(generate_session_secret)" || {
      append_log "ERROR: Unable to generate a strong MMH session secret."
      return 1
    }
  fi
  export MMH_SESSION_SECRET="$session_secret"

  cat > "$ENV_FILE" <<EOF
PORT=\${PORT}
TZ=Asia/Shanghai
MMH_SYSTEM_PASSWORD=\${MMH_SYSTEM_PASSWORD}
MMH_SESSION_SECRET=\${MMH_SESSION_SECRET}
EOF
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  printf '%s\\n' "$MMH_SYSTEM_PASSWORD" > "$SYSTEM_PASSWORD_FILE"
  chmod 600 "$SYSTEM_PASSWORD_FILE" 2>/dev/null || true
  printf '%s\\n' "$MMH_SESSION_SECRET" > "$SESSION_SECRET_FILE"
  chmod 600 "$SESSION_SECRET_FILE" 2>/dev/null || true
}

migrate_legacy_var_dir() {
  if [ "$LEGACY_VAR_DIR" != "$VAR_DIR" ] && [ -d "$LEGACY_VAR_DIR" ] && [ ! -f "$DATA_DIR/mmh.db" ]; then
    mkdir -p "$VAR_DIR" "$DATA_DIR"
    cp -a "$LEGACY_VAR_DIR/." "$VAR_DIR/" 2>/dev/null || true
  fi
}

start_app() {
  mkdir -p "$VAR_DIR" "$DATA_DIR"
  migrate_legacy_var_dir
  ensure_runtime_settings
  append_log "MMH start requested: app=$APP_DIR var=$VAR_DIR data=$DATA_DIR user=$(id -u 2>/dev/null || echo unknown):$(id -g 2>/dev/null || echo unknown) port=\${PORT:-7777}"
  if [ ! -x "$NODE_BIN" ]; then
    fail_start "Bundled Linux Node runtime is missing or not executable: $NODE_BIN"
  fi
  if [ ! -f "$SERVER_DIR/server.js" ]; then
    fail_start "Next standalone server is missing: $SERVER_DIR/server.js"
  fi
  export NODE_ENV=production
  export HOSTNAME=0.0.0.0
  export MMH_DEPLOY_TARGET=synology
  export MMH_DATA_DIR="$DATA_DIR"
  export DATABASE_URL="file:$DATA_DIR/mmh.db"
  export PRISMA_SCHEMA_PATH="$SERVER_DIR/prisma/schema.native.prisma"
  append_log "Testing bundled Node runtime: $NODE_BIN"
  if ! "$NODE_BIN" -v >>"$LOG_FILE" 2>&1; then
    append_log "Bundled Node runtime failed to execute; ldd output follows when available."
    if command -v ldd >/dev/null 2>&1; then
      ldd "$NODE_BIN" >>"$LOG_FILE" 2>&1 || true
    fi
    fail_start "Bundled Node runtime failed to execute."
  fi
  append_log "Initializing SQLite database at $DATA_DIR/mmh.db"
  if ! (cd "$SERVER_DIR" && "$NODE_BIN" "$SERVER_DIR/scripts/init-sqlite.cjs") >>"$LOG_FILE" 2>&1; then
    fail_start "SQLite initialization failed."
  fi
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
    append_log "MMH already running with pid $(cat "$PID_FILE")"
    exit 0
  fi
  append_log "Launching Next standalone server."
  nohup "$NODE_BIN" "$SERVER_DIR/server.js" >>"$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"
  sleep 2
  if ! kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
    rm -f "$PID_FILE"
    fail_start "MMH server process exited immediately."
  fi
  append_log "MMH started with pid $(cat "$PID_FILE")"
}

stop_app() {
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" >/dev/null 2>&1 || true
    rm -f "$PID_FILE"
  fi
}

status_app() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
    exit 0
  fi
  exit 3
}

case "\${1:-status}" in
  start)
    start_app
    ;;
  stop)
    stop_app
    ;;
  status)
    status_app
    ;;
  log)
    tail -n "\${2:-100}" "$LOG_FILE"
    ;;
  *)
    exit 1
    ;;
esac
`, 0o755);
}

function writeLifecycleScripts() {
  const noop = "#!/bin/sh\n\nexit 0\n";
  write(path.join(stageDir, "scripts", "postinst"), noop, 0o755);
  write(path.join(stageDir, "scripts", "preuninst"), `#!/bin/sh

PACKAGE="mmh"
APP_DIR="\${SYNOPKG_PKGDEST:-/var/packages/$PACKAGE/target}"
VAR_DIR="\${SYNOPKG_PKGVAR:-/var/packages/$PACKAGE/var}"
if [ -d "$VAR_DIR" ]; then
  BACKUP_ROOT="\${SYNOPKG_PKGDEST_VOL:-/volume1}/mmh-synology-uninstall-backups"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_ROOT" 2>/dev/null || exit 0
  chmod 700 "$BACKUP_ROOT" 2>/dev/null || true
  cp -a "$VAR_DIR" "$BACKUP_ROOT/uninstall-$STAMP" 2>/dev/null || true
  chmod 700 "$BACKUP_ROOT/uninstall-$STAMP" 2>/dev/null || true
  chmod -R go-rwx "$BACKUP_ROOT/uninstall-$STAMP" 2>/dev/null || true
fi
exit 0
`, 0o755);
  write(path.join(stageDir, "scripts", "preupgrade"), `#!/bin/sh

PACKAGE="mmh"
APP_DIR="\${SYNOPKG_PKGDEST:-/var/packages/$PACKAGE/target}"
VAR_DIR="\${SYNOPKG_PKGVAR:-/var/packages/$PACKAGE/var}"
if [ -n "\${SYNOPKG_TEMP_UPGRADE_FOLDER:-}" ] && [ -d "$VAR_DIR" ]; then
  mkdir -p "$SYNOPKG_TEMP_UPGRADE_FOLDER"
  cp -a "$VAR_DIR" "$SYNOPKG_TEMP_UPGRADE_FOLDER/var" 2>/dev/null || true
fi
exit 0
`, 0o755);
  write(path.join(stageDir, "scripts", "postupgrade"), `#!/bin/sh

PACKAGE="mmh"
APP_DIR="\${SYNOPKG_PKGDEST:-/var/packages/$PACKAGE/target}"
VAR_DIR="\${SYNOPKG_PKGVAR:-/var/packages/$PACKAGE/var}"
if [ -n "\${SYNOPKG_TEMP_UPGRADE_FOLDER:-}" ] && [ -d "$SYNOPKG_TEMP_UPGRADE_FOLDER/var" ]; then
  mkdir -p "$VAR_DIR"
  cp -a "$SYNOPKG_TEMP_UPGRADE_FOLDER/var/." "$VAR_DIR/" 2>/dev/null || true
fi
exit 0
`, 0o755);
}

function writePrivilege() {
  write(path.join(stageDir, "conf", "privilege"), JSON.stringify({
    defaults: {
      "run-as": "package",
    },
    username: "mmh",
    groupname: "mmh",
  }, null, 2));
}

function copyIcons() {
  const icon192 = path.join(root, "public", "branding", "mmh-logo-pageflip-192.png");
  const icon512 = path.join(root, "public", "branding", "mmh-logo-pageflip-512.png");
  copyFile(icon192, path.join(stageDir, "PACKAGE_ICON.PNG"));
  copyFile(icon512, path.join(stageDir, "PACKAGE_ICON_256.PNG"));
}

function preparePackageRoot() {
  fs.rmSync(stageDir, { recursive: true, force: true });
  mkdirp(packageRoot);
  runFnosStage();
  const fnosStage = path.join(root, "release-artifacts", "fnos", target.fnosStageDirName);
  requirePath(path.join(fnosStage, "app", "server", "server.js"), "Run the Synology standalone build before packaging: npm run build:synology:app");
  requirePath(path.join(fnosStage, "app", "bin", "node"), `Provide a Linux ${target.nodeArch} Node runtime tarball before building ${spkAssetName()}.`);
  copyDir(path.join(fnosStage, "app"), path.join(packageRoot, "app"));
  writeInfoFile();
  writeStartStopStatus();
  writeLifecycleScripts();
  writePrivilege();
  copyIcons();
  makeReadable(stageDir);
}

function buildSpk() {
  if (process.platform !== "linux") {
    throw new Error("Synology SPK release packages must be built on Linux so native Node modules match DSM.");
  }
  if (process.arch !== target.processArch && process.env.SYNOLOGY_ALLOW_CROSS_ARCH !== "1") {
    throw new Error(`SYNOLOGY_TARGET_ARCH=${target.id} must be built on a Linux ${target.processArch} runner.`);
  }

  const nodeHeadersDir = findNodeHeadersDir();
  const rebuildEnv = nodeHeadersDir ? { npm_config_nodedir: nodeHeadersDir } : {};
  const stagedServerDir = path.join(packageRoot, "app", "server");
  const nativeRebuild = run(commandName("npm"), ["rebuild", "better-sqlite3", "--build-from-source"], {
    cwd: stagedServerDir,
    stdio: "inherit",
    env: rebuildEnv,
  });
  if (nativeRebuild.status !== 0) process.exit(nativeRebuild.status || 1);

  const packageTgz = path.join(stageDir, "package.tgz");
  fs.rmSync(packageTgz, { force: true });
  const packageTar = run("tar", [...tarOwnerArgs(), "-czf", packageTgz, "-C", packageRoot, "."]);
  if (packageTar.status !== 0) {
    console.error(packageTar.stderr || packageTar.stdout || "package.tgz packaging failed");
    process.exit(packageTar.status || 1);
  }
  writeInfoFile({
    checksum: hashFileMd5(packageTgz),
    extractSizeKb: directorySizeKb(packageRoot),
  });
  makeReadable(stageDir);

  const spkPath = path.join(outDir, spkAssetName());
  fs.rmSync(spkPath, { force: true });
  // DSM expects the .spk itself to be a plain tar archive; only package.tgz is gzip-compressed.
  const spkTar = run("tar", [
    ...tarOwnerArgs(),
    "-cf",
    spkPath,
    "-C",
    stageDir,
    "INFO",
    "PACKAGE_ICON.PNG",
    "PACKAGE_ICON_256.PNG",
    "conf",
    "scripts",
    "package.tgz",
  ]);
  if (spkTar.status !== 0) {
    console.error(spkTar.stderr || spkTar.stdout || "SPK packaging failed");
    process.exit(spkTar.status || 1);
  }
  console.log(`Synology DSM ${target.id} SPK built: ${path.relative(root, spkPath)}`);
}

preparePackageRoot();
console.log(`Synology DSM SPK source staged: ${path.relative(root, stageDir)}`);

if (stageOnly) {
  const archive = path.join(outDir, `${appName}-synology-v${version}-${target.assetSuffix}-spk-source.tgz`);
  const tar = run("tar", ["-czf", archive, "-C", stageDir, "."]);
  if (tar.status !== 0) {
    console.error(tar.stderr || tar.stdout || "tar failed");
    process.exit(tar.status || 1);
  }
  console.log(`Synology DSM stage-only archive: ${path.relative(root, archive)}`);
  process.exit(0);
}

try {
  buildSpk();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
