#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const rawVersion = process.env.FNOS_PACKAGE_VERSION || pkg.version || "0.1.0";
const version = normalizeFnosVersion(rawVersion);
const osMinVersion = process.env.FNOS_OS_MIN_VERSION || "0.9.0";
const packageReleaseNotes = typeof pkg.mmhReleaseNotes === "string" ? pkg.mmhReleaseNotes.trim() : "";
const changelog = process.env.FNOS_PACKAGE_CHANGELOG || packageReleaseNotes || "更新 MMH 飞牛 SQLite 原生包，优化本地安装、启动和更新验证流程。";
const manifestChangelog = toSingleLineText(changelog);
const appDescription = toSingleLineText(readFnosAppDescription());
const appName = "mmh";
const target = normalizeFnosTarget(process.env.FNOS_TARGET_ARCH || process.env.FNOS_TARGET || "x86");
const outDir = path.join(root, "release-artifacts", "fnos");
const stageDir = path.join(outDir, target.stageDirName);
const stageOnly = process.argv.includes("--stage-only");
const nodeTarball = process.env.FNOS_NODE_TARBALL || "";
const isLinux = process.platform === "linux";
const manualFpk = process.env.FNOS_MANUAL_FPK === "1";
const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");

function mkdirp(target) {
  fs.mkdirSync(target, { recursive: true });
}

function write(file, content, mode) {
  mkdirp(path.dirname(file));
  fs.writeFileSync(file, content.replace(/\r\n/g, "\n"), "utf8");
  if (mode) fs.chmodSync(file, mode);
}

function toSingleLineText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function readFnosAppDescription() {
  const fnpackPath = path.join(root, "deploy", "fnos", "repository", "fnpack.json");
  try {
    const source = JSON.parse(fs.readFileSync(fnpackPath, "utf8"));
    const description = source?.apps?.mmh?.desc;
    if (typeof description === "string" && description.trim()) return description;
  } catch (error) {
    console.warn(`Could not read fnOS app description from ${path.relative(root, fnpackPath)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return "一套本地部署、致力于化繁为简的家庭账务管理系统。";
}

function makeFnosPackageEntriesReadable(dir) {
  if (!fs.existsSync(dir)) return;
  const walk = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isDirectory()) {
      fs.chmodSync(current, 0o755);
      for (const entry of fs.readdirSync(current)) {
        walk(path.join(current, entry));
      }
      return;
    }
    if (!stat.isFile()) return;
    const relative = path.relative(stageDir, current).replace(/\\/g, "/");
    const executable =
      relative.startsWith("cmd/") ||
      relative === "app/bin/node" ||
      relative.startsWith("app/bin/bin/");
    fs.chmodSync(current, executable ? 0o755 : 0o644);
  };
  walk(dir);
}

function normalizeFnosVersion(value) {
  const raw = String(value || "").trim();
  if (!raw) return "0.1.0";
  const normalized = raw
    .replace(/^refs\/tags\//, "")
    .replace(/^v(?=\d)/, "")
    .replace(/-fnos(?:$|[.-].*)?$/, "");
  if (!/^0\.1\.\d+$/.test(normalized)) {
    throw new Error(`FNOS_PACKAGE_VERSION must use 0.1.x format, got ${normalized}.`);
  }
  return normalized;
}

function normalizeFnosTarget(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (["", "x86", "x86-64", "x64", "amd64"].includes(raw)) {
    return {
      id: "x86",
      manifestArch: "x86_64",
      manifestPlatform: "x86",
      nodeArch: "x64",
      processArch: "x64",
      fnpackArch: "amd64",
      assetSuffix: "x86_64",
      stageDirName: `${appName}-fpk`,
    };
  }
  if (["arm", "arm64", "aarch64"].includes(raw)) {
    return {
      id: "arm64",
      manifestArch: "aarch64",
      manifestPlatform: "arm",
      nodeArch: "arm64",
      processArch: "arm64",
      fnpackArch: "arm64",
      assetSuffix: "arm64",
      stageDirName: `${appName}-arm64-fpk`,
    };
  }
  throw new Error(`FNOS_TARGET_ARCH must be x86 or arm64, got ${value || "(empty)"}.`);
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function writeSolidPng(file, size) {
  mkdirp(path.dirname(file));
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const row = Buffer.alloc(1 + size * 4);
  row[0] = 0;
  for (let offset = 1; offset < row.length; offset += 4) {
    row[offset] = 0x1d;
    row[offset + 1] = 0x23;
    row[offset + 2] = 0x30;
    row[offset + 3] = 0xff;
  }
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  fs.writeFileSync(file, Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

function readPngRgba(file) {
  const input = fs.readFileSync(file);
  if (input.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error(`${path.relative(root, file)} is not a PNG file.`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];

  while (offset < input.length) {
    const length = input.readUInt32BE(offset);
    const type = input.subarray(offset + 4, offset + 8).toString("ascii");
    const data = input.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`${path.relative(root, file)} must be an 8-bit RGB or RGBA PNG.`);
  }

  const sourceBpp = colorType === 6 ? 4 : 3;
  const rowLength = width * sourceBpp;
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const rgba = Buffer.alloc(width * height * 4);
  let readOffset = 0;
  let previous = Buffer.alloc(rowLength);

  const paeth = (left, up, upLeft) => {
    const p = left + up - upLeft;
    const pa = Math.abs(p - left);
    const pb = Math.abs(p - up);
    const pc = Math.abs(p - upLeft);
    if (pa <= pb && pa <= pc) return left;
    return pb <= pc ? up : upLeft;
  };

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[readOffset];
    readOffset += 1;
    const row = Buffer.from(inflated.subarray(readOffset, readOffset + rowLength));
    readOffset += rowLength;

    for (let x = 0; x < rowLength; x += 1) {
      const left = x >= sourceBpp ? row[x - sourceBpp] : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= sourceBpp ? previous[x - sourceBpp] : 0;
      if (filter === 1) row[x] = (row[x] + left) & 0xff;
      else if (filter === 2) row[x] = (row[x] + up) & 0xff;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) row[x] = (row[x] + paeth(left, up, upLeft)) & 0xff;
      else if (filter !== 0) throw new Error(`${path.relative(root, file)} uses unsupported PNG filter ${filter}.`);
    }

    for (let x = 0; x < width; x += 1) {
      const sourceOffset = x * sourceBpp;
      const targetOffset = (y * width + x) * 4;
      rgba[targetOffset] = row[sourceOffset];
      rgba[targetOffset + 1] = row[sourceOffset + 1];
      rgba[targetOffset + 2] = row[sourceOffset + 2];
      rgba[targetOffset + 3] = sourceBpp === 4 ? row[sourceOffset + 3] : 0xff;
    }
    previous = row;
  }

  return { width, height, rgba };
}

function resizeRgbaNearestBox(image, size) {
  const output = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const yStart = Math.floor((y * image.height) / size);
    const yEnd = Math.max(yStart + 1, Math.floor(((y + 1) * image.height) / size));
    for (let x = 0; x < size; x += 1) {
      const xStart = Math.floor((x * image.width) / size);
      const xEnd = Math.max(xStart + 1, Math.floor(((x + 1) * image.width) / size));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sourceY = yStart; sourceY < yEnd; sourceY += 1) {
        for (let sourceX = xStart; sourceX < xEnd; sourceX += 1) {
          const sourceOffset = (sourceY * image.width + sourceX) * 4;
          r += image.rgba[sourceOffset];
          g += image.rgba[sourceOffset + 1];
          b += image.rgba[sourceOffset + 2];
          a += image.rgba[sourceOffset + 3];
          count += 1;
        }
      }
      const targetOffset = (y * size + x) * 4;
      output[targetOffset] = Math.round(r / count);
      output[targetOffset + 1] = Math.round(g / count);
      output[targetOffset + 2] = Math.round(b / count);
      output[targetOffset + 3] = Math.round(a / count);
    }
  }
  return output;
}

function writeRgbaPng(file, size, rgba) {
  mkdirp(path.dirname(file));
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    rows.push(Buffer.from([0]));
    rows.push(rgba.subarray(y * size * 4, (y + 1) * size * 4));
  }
  fs.writeFileSync(file, Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]));
}

function copyIcon(src, dest, size) {
  if (fs.existsSync(src)) {
    const icon = readPngRgba(src);
    writeRgbaPng(dest, size, resizeRgbaNearestBox(icon, size));
    return;
  }
  writeSolidPng(dest, size);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.cpSync(src, dest, { recursive: true });
  return true;
}

function copyFnosPublicAssets(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  for (const file of [
    "apple-touch-icon.png",
    "favicon.ico",
    "sw.js",
  ]) {
    copyFile(path.join(src, file), path.join(dest, file));
  }

  for (const file of [
    "mmh-logo-pageflip.square.png",
    "mmh-logo-pageflip-192.png",
    "mmh-logo-pageflip-512.png",
  ]) {
    copyFile(path.join(src, "branding", file), path.join(dest, "branding", file));
  }
}

function pruneStagedServer(serverDir) {
  if (!fs.existsSync(serverDir)) return;
  const keepTopLevel = new Set([
    ".next",
    "node_modules",
    "prisma",
    "public",
    "server.js",
    "package.json",
    "prisma.config.ts",
  ]);
  for (const entry of fs.readdirSync(serverDir, { withFileTypes: true })) {
    if (keepTopLevel.has(entry.name)) continue;
    fs.rmSync(path.join(serverDir, entry.name), { recursive: true, force: true });
  }
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

function hasCommand(command) {
  const probe = process.platform === "win32"
    ? run("where.exe", [command])
    : run("sh", ["-lc", `command -v ${command}`]);
  return probe.status === 0;
}

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function requirePath(target, message) {
  if (!fs.existsSync(target)) {
    throw new Error(message);
  }
}

function hashFileMd5(file) {
  const crypto = require("node:crypto");
  const hash = crypto.createHash("md5");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function copyFileIfDifferent(src, dest) {
  if (path.resolve(src) === path.resolve(dest)) return;
  copyFile(src, dest);
}

function fpkAssetName() {
  return `${appName}-fnos-v${version}-${target.assetSuffix}.fpk`;
}

function materializeFpkOutputs(source) {
  const archPath = path.join(outDir, fpkAssetName());
  copyFileIfDifferent(source, archPath);

  return archPath;
}

function findNodeHeadersDir() {
  const candidates = [
    path.dirname(path.dirname(process.execPath)),
    "/usr/local",
    "/usr",
  ];
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "include", "node", "node.h"))) || "";
}

function assertCompatibleGlibc() {
  const ldd = run("ldd", ["--version"]);
  const text = `${ldd.stdout || ""}\n${ldd.stderr || ""}`;
  const match = text.match(/GLIBC\s+(\d+)\.(\d+)/i);
  if (!match) return;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > 2 || (major === 2 && minor > 36)) {
    throw new Error(`fnOS .fpk must be built on glibc <= 2.36. Current build environment reports GLIBC ${major}.${minor}.`);
  }
}

const copiedRuntimePackages = new Set();
let standaloneAppDir = null;
const excludedRuntimePackages = new Set([
  "@electric-sql/pglite",
  "@electric-sql/pglite-socket",
  "@electric-sql/pglite-tools",
  "@hono/node-server",
  "chart.js",
  "mysql2",
  "node-abi",
  "prebuild-install",
  "postgres",
]);

function copyRuntimeDependency(name) {
  return copyDir(path.join(root, "node_modules", name), path.join(stageDir, "app", "server", "node_modules", name));
}

function copyRuntimeDependencyClosure(name) {
  if (excludedRuntimePackages.has(name)) return;
  if (copiedRuntimePackages.has(name)) return;
  copiedRuntimePackages.add(name);
  if (!copyRuntimeDependency(name)) return;

  const packageJson = path.join(root, "node_modules", name, "package.json");
  if (!fs.existsSync(packageJson)) return;

  const manifest = JSON.parse(fs.readFileSync(packageJson, "utf8"));
  const dependencies = manifest.dependencies || {};
  for (const dependencyName of Object.keys(dependencies)) {
    copyRuntimeDependencyClosure(dependencyName);
  }
}

function materializeStandaloneSymlinks(baseDir) {
  if (!fs.existsSync(baseDir)) return;
  for (const name of fs.readdirSync(baseDir)) {
    const item = path.join(baseDir, name);
    const stat = fs.lstatSync(item);
    if (stat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(item);
      const absoluteTarget = path.isAbsolute(linkTarget)
        ? linkTarget
        : path.resolve(path.dirname(item), linkTarget);
      const relativeFromStandaloneModules = path.relative(path.join(standaloneAppDir || standaloneDir, "node_modules"), absoluteTarget);
      const localTarget = path.join(stageDir, "app", "server", "node_modules", relativeFromStandaloneModules);
      fs.rmSync(item, { force: true });
      if (fs.existsSync(localTarget)) {
        const targetStat = fs.lstatSync(localTarget);
        if (targetStat.isDirectory()) {
          copyDir(localTarget, item);
        } else {
          copyFile(localTarget, item);
        }
      }
      continue;
    }
    if (stat.isDirectory()) {
      materializeStandaloneSymlinks(item);
    }
  }
}

function removeRuntimeDependency(name) {
  fs.rmSync(path.join(stageDir, "app", "server", "node_modules", ...name.split("/")), {
    recursive: true,
    force: true,
  });
}

function findStandaloneAppDir(baseDir) {
  const directServer = path.join(baseDir, "server.js");
  if (fs.existsSync(directServer)) return baseDir;

  const queue = [baseDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || !fs.existsSync(current)) continue;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules") continue;
      const child = path.join(current, entry.name);
      if (fs.existsSync(path.join(child, "server.js"))) return child;
      queue.push(child);
    }
  }
  return baseDir;
}

fs.rmSync(stageDir, { recursive: true, force: true });
// The package must NOT ship `wizard/install`.
// The FN soft-store client parses only `wizard/install`: when that file exists it
// renders the wizard and waits for user input before installing, so shipping it
// makes every update ask for the service port again. Without it the client
// installs silently and the port is resolved from persisted state.
// `wizard/config` is safe: the soft-store client never reads it, and the fnOS
// App Center only shows it when the user opens the app's settings, which is how
// the service port stays editable after a silent install.
for (const dir of [
  "app/bin",
  "app/data",
  "app/server",
  "app/ui/images",
  "cmd",
  "config",
  "wizard",
]) {
  mkdirp(path.join(stageDir, dir));
}

const generatedSchema = run(process.execPath, [path.join(root, "scripts", "generate-native-sqlite-schema.cjs")], {
  stdio: "inherit",
});
if (generatedSchema.status !== 0) process.exit(generatedSchema.status || 1);

write(path.join(stageDir, "manifest"), `
appname=${appName}
version=${version}
desc=${appDescription}
display_name=MMH
arch=${target.manifestArch}
platform=${target.manifestPlatform}
source=thirdparty
os_min_version=${osMinVersion}
maintainer=frankluise5220
maintainer_url=https://github.com/frankluise5220/MMH
distributor=frankluise5220
distributor_url=https://github.com/frankluise5220/MMH
helpurl=https://github.com/frankluise5220/MMH
desktop_uidir=ui
desktop_applaunchname=mmh.Application
service_port=7777
checkport=true
changelog=${manifestChangelog}
`);

write(path.join(stageDir, "config", "privilege"), JSON.stringify({
  username: "mmh",
  groupname: "mmh",
}, null, 2));

write(path.join(stageDir, "config", "resource"), JSON.stringify({
  "data-share": {
    shares: [
      {
        name: "mmh",
        permission: {
          rw: ["mmh"],
        },
      },
      {
        name: "mmh/data",
        permission: {
          rw: ["mmh"],
        },
      },
    ],
  },
}, null, 2));

// Settings wizard: lets users change the service port after install.
// Deliberately not `wizard/install`, which the FN soft-store client would show
// on every update.
write(path.join(stageDir, "wizard", "config"), JSON.stringify([
  {
    stepTitle: "服务端口",
    items: [
      {
        type: "text",
        field: "wizard_port",
        label: "服务端口",
        initValue: "7777",
        rules: [
          { required: true, message: "请输入服务端口" },
          {
            pattern: "^([1-9][0-9]{3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$",
            message: "请输入 1000-65535 之间的端口",
          },
        ],
        helpText: "保存后会重启 MMH 服务。端口会写入应用数据目录，后续更新会继续沿用，不会被包内默认值覆盖。默认值固定为 7777，不一定是当前在用的端口。",
      },
    ],
  },
], null, 2));
write(path.join(stageDir, "app", "ui", "config"), JSON.stringify({
  ".url": {
    "mmh.Application": {
      title: "MMH",
      icon: "images/icon_{0}.png",
      type: "url",
      protocol: "http",
      port: "7777",
      url: "/",
      allUsers: false,
    },
  },
}, null, 2));

const markIcon = path.join(root, "public", "branding", "mmh-logo-pageflip-512.png");
copyIcon(markIcon, path.join(stageDir, "ICON.PNG"), 64);
copyIcon(markIcon, path.join(stageDir, "ICON_256.PNG"), 256);
copyIcon(markIcon, path.join(stageDir, "app", "ui", "images", "icon_64.png"), 64);
copyIcon(markIcon, path.join(stageDir, "app", "ui", "images", "icon_256.png"), 256);

write(path.join(stageDir, "cmd", "app-layout"), `#!/bin/bash

list_vol_app_dirs() {
    local kind="$1"
    local d
    for d in /vol*/@"$kind"/"$TRIM_APPNAME" /usr/local/apps/@"$kind"/"$TRIM_APPNAME"; do
        [ -d "$d" ] && echo "$d"
    done
}

resolve_pkgvar() {
    if [ -n "\${TRIM_PKGVAR:-}" ]; then
        echo "\${TRIM_PKGVAR}"
        return 0
    fi
    local d first=""
    if [ -n "$TRIM_APPNAME" ]; then
        while IFS= read -r d; do
            [ -n "$d" ] || continue
            if [ -z "$first" ]; then
                first="$d"
            fi
            if [ -f "$d/data/mmh.db" ]; then
                echo "$d"
                return 0
            fi
        done <<EOF
$(list_vol_app_dirs appdata)
EOF
        if [ -n "$first" ]; then
            echo "$first"
            return 0
        fi
        echo "/vol1/@appdata/$TRIM_APPNAME"
        return 0
    fi
    echo ""
}

resolve_runtime_paths() {
    local pkgvar
    pkgvar="$(resolve_pkgvar)"
    ENV_FILE="\${pkgvar}/mmh.env"
    PID_FILE="\${pkgvar}/mmh.pid"
    LOG_FILE="\${pkgvar}/mmh.log"
    DATA_DIR="\${pkgvar}/data"
}

resolve_app_dest() {
    local d
    if [ -n "\${TRIM_APPDEST:-}" ] && [ -d "\${TRIM_APPDEST}" ]; then
        echo "\${TRIM_APPDEST}"
        return 0
    fi
    if [ -n "$TRIM_APPNAME" ]; then
        while IFS= read -r d; do
            [ -n "$d" ] || continue
            echo "$d"
            return 0
        done <<EOF
$(list_vol_app_dirs appcenter)
EOF
        if [ -d "/var/apps/$TRIM_APPNAME" ]; then
            echo "/var/apps/$TRIM_APPNAME"
            return 0
        fi
    fi
    echo "/var/apps/$TRIM_APPNAME"
}

ensure_app_ready() {
    local dest tgz
    dest="$(resolve_app_dest)"
    tgz="\${dest}/app.tgz"

    if [ -x "\${dest}/bin/node" ] && [ -f "\${dest}/server/server.js" ]; then
        APP_ROOT="\${dest}"
        APP_BIN="\${dest}/bin/node"
        APP_SERVER="\${dest}/server/server.js"
        return 0
    fi

    if [ -x "\${dest}/app/bin/node" ] && [ -f "\${dest}/app/server/server.js" ]; then
        APP_ROOT="\${dest}/app"
        APP_BIN="\${dest}/app/bin/node"
        APP_SERVER="\${dest}/app/server/server.js"
        return 0
    fi

    if [ ! -f "$tgz" ]; then
        return 1
    fi

    mkdir -p "\${dest}/app"
    tar -xzf "$tgz" -C "\${dest}/app"
    if [ -x "\${dest}/app/bin/node" ] && [ -f "\${dest}/app/server/server.js" ]; then
        APP_ROOT="\${dest}/app"
        APP_BIN="\${dest}/app/bin/node"
        APP_SERVER="\${dest}/app/server/server.js"
        return 0
    fi

    tar -xzf "$tgz" -C "$dest"
    if [ -x "\${dest}/bin/node" ] && [ -f "\${dest}/server/server.js" ]; then
        APP_ROOT="\${dest}"
        APP_BIN="\${dest}/bin/node"
        APP_SERVER="\${dest}/server/server.js"
        return 0
    fi

    return 1
}

app_ui_config() {
    local dest root
    dest="$(resolve_app_dest)"
    for root in "\${dest}/app/ui/config" "\${dest}/ui/config"; do
        if [ -f "$root" ]; then
            echo "$root"
            return 0
        fi
    done
    echo "\${dest}/ui/config"
}
`, 0o755);

write(path.join(stageDir, "cmd", "apply-settings"), `#!/bin/bash

read_env_value() {
    local key="$1"
    local env_file pkgvar line val
    pkgvar="$(resolve_pkgvar)"
    env_file="\${pkgvar}/mmh.env"
    [ -f "$env_file" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            "\${key}="*)
                val="\${line#\${key}=}"
                val="\${val#\'}"
                val="\${val%\'}"
                printf '%s' "$val"
                return 0
                ;;
        esac
    done < "$env_file"
}

generate_system_password() {
    local generated=""
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

resolve_system_password() {
    local pkgvar password_file env_password
    pkgvar="$(resolve_pkgvar)"
    password_file="\${pkgvar}/mmh-system-password.txt"

    env_password="$(read_env_value MMH_SYSTEM_PASSWORD 2>/dev/null || true)"
    if [ -n "$env_password" ]; then
        printf '%s' "$env_password"
        return 0
    fi
    if [ -f "$password_file" ]; then
        tr -d '[:space:]' < "$password_file"
        return 0
    fi
    generate_system_password
}

generate_session_secret() {
    local generated=""
    if command -v openssl >/dev/null 2>&1; then
        generated="$(openssl rand -base64 48 2>/dev/null | tr -d '[:space:]' || true)"
    fi
    if [ -z "$generated" ] && [ -n "\${APP_BIN:-}" ] && [ -x "$APP_BIN" ]; then
        generated="$("$APP_BIN" -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))' 2>/dev/null || true)"
    fi
    if [ -n "$generated" ] && [ "\${#generated}" -ge 32 ]; then
        printf '%s' "$generated"
        return 0
    fi
    return 1
}

resolve_session_secret() {
    local pkgvar secret_file env_secret
    pkgvar="$(resolve_pkgvar)"
    secret_file="\${pkgvar}/mmh-session-secret.txt"

    env_secret="$(read_env_value MMH_SESSION_SECRET 2>/dev/null || true)"
    case "$env_secret" in
        CHANGE_ME*) env_secret="" ;;
    esac
    if [ -n "$env_secret" ] && [ "\${#env_secret}" -ge 32 ]; then
        printf '%s' "$env_secret"
        return 0
    fi
    if [ -f "$secret_file" ]; then
        env_secret="$(tr -d '[:space:]' < "$secret_file")"
        case "$env_secret" in
            CHANGE_ME*) env_secret="" ;;
        esac
        if [ -n "$env_secret" ] && [ "\${#env_secret}" -ge 32 ]; then
            printf '%s' "$env_secret"
            return 0
        fi
    fi
    generate_session_secret
}

port_in_use() {
    local p="$1"
    case "$p" in
        ''|*[!0-9]*) return 1 ;;
    esac
    (exec 3<>"/dev/tcp/127.0.0.1/$p") >/dev/null 2>&1
}

probe_free_port() {
    local start="$1"
    local p i
    case "$start" in
        ''|*[!0-9]*) start=7777 ;;
    esac
    p="$start"
    i=0
    while [ "$i" -lt 200 ]; do
        if ! port_in_use "$p"; then
            echo "$p"
            return 0
        fi
        p=$((p + 1))
        i=$((i + 1))
    done
    echo "$start"
}

resolve_port() {
    local pkgvar port_file env_port start_port
    pkgvar="$(resolve_pkgvar)"
    port_file="\${pkgvar}/.port"

    if [ -f "$port_file" ]; then
        tr -d '[:space:]' < "$port_file"
        return 0
    fi
    env_port="$(read_env_value PORT 2>/dev/null || true)"
    if [ -n "$env_port" ]; then
        echo "$env_port"
        return 0
    fi
    # No install wizard ships with this package: fresh installs never ask for a
    # port, so probe for a free one instead of deadlocking on a taken 7777.
    # Reinstalls and updates reuse .port above and never reach this probe.
    start_port="\${TRIM_SERVICE_PORT:-7777}"
    probe_free_port "$start_port"
}

write_env_file() {
    local requested_port="$1"
    local port pkgvar system_password session_secret password_file session_secret_file port_file
    if [ -n "$requested_port" ]; then
        port="$(printf '%s' "$requested_port" | tr -d '[:space:]')"
    else
        port="$(resolve_port)"
    fi
    pkgvar="$(resolve_pkgvar)"
    system_password="$(resolve_system_password)"
    session_secret="$(resolve_session_secret)"
    password_file="\${pkgvar}/mmh-system-password.txt"
    session_secret_file="\${pkgvar}/mmh-session-secret.txt"
    port_file="\${pkgvar}/.port"
    [ -n "$pkgvar" ] || return 1
    mkdir -p "\${pkgvar}/data" 2>/dev/null || true

    cat > "\${pkgvar}/mmh.env" <<EOF
PORT=\${port}
TZ=Asia/Shanghai
MMH_SYSTEM_PASSWORD=\${system_password}
MMH_SESSION_SECRET=\${session_secret}
EOF
    chmod 600 "\${pkgvar}/mmh.env" 2>/dev/null || true
    printf '%s\\n' "$port" > "$port_file"
    chmod 600 "$port_file" 2>/dev/null || true
    printf '%s\\n' "$system_password" > "$password_file"
    chmod 600 "$password_file" 2>/dev/null || true
    printf '%s\\n' "$session_secret" > "$session_secret_file"
    chmod 600 "$session_secret_file" 2>/dev/null || true

    if [ -n "\${APP_ROOT:-}" ] && [ -f "\${APP_ROOT}/ui/config" ]; then
        sed -i 's/"port": "[0-9]*"/"port": "'"\${port}"'"/' "\${APP_ROOT}/ui/config"
    fi

    if [ -n "\${APP_ROOT:-}" ] && [ -f "\${APP_ROOT}/manifest" ]; then
        sed -i "s/^service_port[[:space:]]*=.*/service_port          = \${port}/" "\${APP_ROOT}/manifest"
    fi

    if id mmh >/dev/null 2>&1; then
        chown -R mmh:mmh "$pkgvar" 2>/dev/null || true
    fi
    chmod 770 "$pkgvar" 2>/dev/null || true
    chmod 700 "\${pkgvar}/data" 2>/dev/null || true

    printf '%s' "$port"
}
`, 0o755);

write(path.join(stageDir, "cmd", "main"), `#!/bin/bash

resolve_app_dest () {
  if [ -n "\${TRIM_APPDEST:-}" ] && [ -d "\${TRIM_APPDEST}" ]; then
    echo "\${TRIM_APPDEST}"
    return 0
  fi

  local appname="\${TRIM_APPNAME:-mmh}"
  local d
  for d in /vol*/@appcenter/"$appname" /usr/local/apps/@appcenter/"$appname" /var/apps/"$appname"; do
    if [ -d "$d" ] && [ -f "$d/server/server.js" ]; then
      echo "$d"
      return 0
    fi
    if [ -d "$d" ] && [ -f "$d/app/server/server.js" ]; then
      echo "$d/app"
      return 0
    fi
  done

  cd "$(dirname "$0")/.." && pwd
}

APP_DEST="$(resolve_app_dest)"

resolve_data_dest () {
  if [ -n "\${TRIM_DATADEST:-}" ]; then
    echo "\${TRIM_DATADEST}"
    return 0
  fi
  if [ -n "\${TRIM_PKGVAR:-}" ]; then
    echo "$TRIM_PKGVAR/data"
    return 0
  fi

  local appname="\${TRIM_APPNAME:-mmh}"
  local d
  for d in /vol*/@appdata/"$appname" /usr/local/apps/@appdata/"$appname"; do
    if [ -d "$d" ]; then
      echo "$d/data"
      return 0
    fi
  done

  echo "/vol1/@appdata/$appname/data"
}

DATA_DEST="$(resolve_data_dest)"
if [ -n "\${TRIM_PKGVAR:-}" ]; then
  DATA_ROOT="$TRIM_PKGVAR"
else
  DATA_ROOT="$(dirname "$DATA_DEST")"
fi
ENV_FILE="$DATA_ROOT/mmh.env"
SYSTEM_PASSWORD_FILE="$DATA_ROOT/mmh-system-password.txt"
SESSION_SECRET_FILE="$DATA_ROOT/mmh-session-secret.txt"
SERVER_DIR="$APP_DEST/server"
NODE_BIN="$APP_DEST/bin/node"
PID_FILE="$DATA_DEST/mmh.pid"
LOG_FILE="$DATA_DEST/mmh.log"

read_env_value () {
  local key="$1"
  local line val
  [ -f "$ENV_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "\${key}="*)
        val="\${line#\${key}=}"
        val="\${val#\'}"
        val="\${val%\'}"
        printf '%s' "$val"
        return 0
        ;;
    esac
  done < "$ENV_FILE"
}

generate_system_password () {
  local generated=""
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

generate_session_secret () {
  local generated=""
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

ensure_runtime_settings () {
  local env_port env_password system_password env_session_secret session_secret
  mkdir -p "$DATA_DEST" "$DATA_ROOT"

  env_port="$(read_env_value PORT 2>/dev/null || true)"
  export PORT="\${PORT:-\${env_port:-7777}}"

  env_password="$(read_env_value MMH_SYSTEM_PASSWORD 2>/dev/null || true)"
  system_password="\${MMH_SYSTEM_PASSWORD:-$env_password}"
  if [ -z "$system_password" ] && [ -f "$SYSTEM_PASSWORD_FILE" ]; then
    system_password="$(tr -d '[:space:]' < "$SYSTEM_PASSWORD_FILE")"
  fi
  if [ -z "$system_password" ]; then
    system_password="$(generate_system_password)"
    echo "Generated MMH system password at $SYSTEM_PASSWORD_FILE" >>"$LOG_FILE" 2>/dev/null || true
  fi
  export MMH_SYSTEM_PASSWORD="$system_password"

  env_session_secret="$(read_env_value MMH_SESSION_SECRET 2>/dev/null || true)"
  session_secret="\${MMH_SESSION_SECRET:-$env_session_secret}"
  if [ -z "$session_secret" ] && [ -f "$SESSION_SECRET_FILE" ]; then
    session_secret="$(tr -d '[:space:]' < "$SESSION_SECRET_FILE")"
  fi
  if [ -z "$session_secret" ] || [ "\${#session_secret}" -lt 32 ]; then
    session_secret="$(generate_session_secret)" || {
      echo "Unable to generate a strong MMH session secret." >&2
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

ensure_runtime_owner () {
  mkdir -p "$DATA_DEST" "$DATA_ROOT"
  if id mmh >/dev/null 2>&1; then
    chown -R mmh:mmh "$DATA_ROOT" 2>/dev/null || true
  fi
  chmod 770 "$DATA_ROOT" 2>/dev/null || true
  chmod 700 "$DATA_DEST" 2>/dev/null || true
}

restart_start_as_package_user () {
  if [ "$(id -u)" = "0" ] && id mmh >/dev/null 2>&1; then
    ensure_runtime_owner
    if command -v runuser >/dev/null 2>&1; then
      exec env \
        TRIM_APPDEST="\${TRIM_APPDEST:-}" \
        TRIM_DATADEST="\${TRIM_DATADEST:-}" \
        TRIM_PKGVAR="\${TRIM_PKGVAR:-}" \
        TRIM_APPNAME="\${TRIM_APPNAME:-mmh}" \
        PORT="\${PORT:-}" \
        runuser -u mmh -- "$0" start
    fi
    if command -v su >/dev/null 2>&1; then
      exec env \
        TRIM_APPDEST="\${TRIM_APPDEST:-}" \
        TRIM_DATADEST="\${TRIM_DATADEST:-}" \
        TRIM_PKGVAR="\${TRIM_PKGVAR:-}" \
        TRIM_APPNAME="\${TRIM_APPNAME:-mmh}" \
        PORT="\${PORT:-}" \
        su mmh -s /bin/bash -c "'$0' start"
    fi
  fi
}

start_app () {
  mkdir -p "$DATA_DEST"
  restart_start_as_package_user
  ensure_runtime_settings
  if [ ! -x "$NODE_BIN" ]; then
    echo "Bundled Linux Node runtime is missing: $NODE_BIN" >&2
    exit 1
  fi
  if [ ! -f "$SERVER_DIR/server.js" ]; then
    echo "Next standalone server is missing: $SERVER_DIR/server.js" >&2
    exit 1
  fi
  export NODE_ENV=production
  export HOSTNAME=0.0.0.0
  export MMH_DEPLOY_TARGET=fnos
  export MMH_DATA_DIR="$DATA_DEST"
  export DATABASE_URL="file:$DATA_DEST/mmh.db"
  export PRISMA_SCHEMA_PATH="$SERVER_DIR/prisma/schema.native.prisma"
  (cd "$SERVER_DIR" && "$NODE_BIN" "$SERVER_DIR/scripts/init-sqlite.cjs") >>"$LOG_FILE" 2>&1 || exit 1
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
    exit 0
  fi
  nohup "$NODE_BIN" "$SERVER_DIR/server.js" >>"$LOG_FILE" 2>&1 &
  echo "$!" > "$PID_FILE"
}

stop_app () {
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" >/dev/null 2>&1 || true
    rm -f "$PID_FILE"
  fi
}

status_app () {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
    exit 0
  fi
  exit 3
}

log_app () {
  if [ -f "$LOG_FILE" ]; then
    tail -n "\${2:-100}" "$LOG_FILE"
    exit $?
  fi
  echo "log not found: $LOG_FILE" >&2
  exit 1
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
  log_app "\${2:-100}"
  ;;
*)
  exit 1
  ;;
esac
`, 0o755);

const noopLifecycle = `#!/bin/bash

exit 0
`;

const settingsLifecycle = `#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "\${TRIM_APPNAME:-}" ]; then
    TRIM_APPNAME=mmh
fi
if [ -f "$SCRIPT_DIR/app-layout" ]; then
    . "$SCRIPT_DIR/app-layout"
    ensure_app_ready >/dev/null 2>&1 || true
fi
if [ -f "$SCRIPT_DIR/apply-settings" ]; then
    . "$SCRIPT_DIR/apply-settings"
    write_env_file >/dev/null
fi

exit 0
`;

// Changing the port goes through the settings wizard, not an install wizard.
// resolve_port() prefers the persisted .port, so the new value must be applied
// explicitly here, then the service is restarted to pick it up.
const configCallbackLifecycle = `#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -z "\${TRIM_APPNAME:-}" ]; then
    TRIM_APPNAME=mmh
fi
if [ -f "$SCRIPT_DIR/app-layout" ]; then
    . "$SCRIPT_DIR/app-layout"
    ensure_app_ready >/dev/null 2>&1 || true
    # cmd/main locates the bundled Node runtime through TRIM_APPDEST. App Center
    # normally exports it, but resolve it ourselves: otherwise a config change
    # would stop the service and then fail to start it again.
    if [ -z "\${TRIM_APPDEST:-}" ] || [ ! -d "\${TRIM_APPDEST}" ]; then
        TRIM_APPDEST="$(resolve_app_dest)"
        export TRIM_APPDEST
    fi
fi
if [ ! -f "$SCRIPT_DIR/apply-settings" ]; then
    exit 0
fi
. "$SCRIPT_DIR/apply-settings"

LOG_TARGET="\${TRIM_TEMP_LOGFILE:-/dev/null}"
NEW_PORT="$(printf '%s' "\${wizard_port:-}" | tr -d '[:space:]')"
[ -n "$NEW_PORT" ] || exit 0

case "$NEW_PORT" in
    *[!0-9]*)
        echo "服务端口必须是数字：$NEW_PORT" > "$LOG_TARGET" 2>/dev/null || true
        exit 1
        ;;
esac
if [ "$NEW_PORT" -lt 1000 ] || [ "$NEW_PORT" -gt 65535 ]; then
    echo "服务端口必须在 1000-65535 之间：$NEW_PORT" > "$LOG_TARGET" 2>/dev/null || true
    exit 1
fi

"$SCRIPT_DIR/main" stop >/dev/null 2>&1 || true
write_env_file "$NEW_PORT" >/dev/null
"$SCRIPT_DIR/main" start

exit 0
`;

const backupLifecycle = (reason) => `#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/app-layout" ]; then
    . "$SCRIPT_DIR/app-layout"
fi

if [ -z "\${TRIM_APPNAME:-}" ]; then
    TRIM_APPNAME=mmh
fi

resolve_data_root() {
    if [ -n "\${TRIM_PKGVAR:-}" ]; then
        echo "$TRIM_PKGVAR"
        return 0
    fi
    if [ -n "\${TRIM_DATADEST:-}" ]; then
        dirname "$TRIM_DATADEST"
        return 0
    fi
    if command -v resolve_pkgvar >/dev/null 2>&1; then
        resolve_pkgvar
        return 0
    fi

    local d
    for d in /vol*/@appdata/"$TRIM_APPNAME" /usr/local/apps/@appdata/"$TRIM_APPNAME"; do
        [ -d "$d" ] && echo "$d" && return 0
    done
    return 1
}

data_root="$(resolve_data_root 2>/dev/null || true)"
[ -n "$data_root" ] || exit 0
[ -d "$data_root" ] || exit 0
[ -f "$data_root/data/mmh.db" ] || exit 0

parent_dir="$(dirname "$data_root")"
backup_root=""
for candidate in "$parent_dir/$TRIM_APPNAME-upgrade-backups" "$data_root/upgrade-backups"; do
    if mkdir -p "$candidate" 2>/dev/null && [ -w "$candidate" ]; then
        chmod 700 "$candidate" 2>/dev/null || true
        backup_root="$candidate"
        break
    fi
done
[ -n "$backup_root" ] || exit 0
stamp="$(date +%Y%m%d-%H%M%S)"
target="$backup_root/${reason}-$stamp"

mkdir -p "$target/appdata"
chmod 700 "$backup_root" "$target" "$target/appdata" 2>/dev/null || true
cp -a "$data_root/data" "$target/appdata/data"
for file in "$data_root/mmh.env" "$data_root/.port" "$data_root/mmh-system-password.txt" "$data_root/mmh-session-secret.txt"; do
    if [ -f "$file" ]; then
        cp -a "$file" "$target/appdata/"
    fi
done
chmod -R go-rwx "$target/appdata" 2>/dev/null || true
if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$data_root/data/mmh.db" > "$target/mmh.db.sha256"
    chmod 600 "$target/mmh.db.sha256" 2>/dev/null || true
fi

echo "MMH app data backed up to $target"
exit 0
`;

for (const name of [
  "install_init",
  "uninstall_callback",
  "config_init",
]) {
  write(path.join(stageDir, "cmd", name), noopLifecycle, 0o755);
}
for (const name of [
  "install_callback",
  "upgrade_callback",
]) {
  write(path.join(stageDir, "cmd", name), settingsLifecycle, 0o755);
}
write(path.join(stageDir, "cmd", "config_callback"), configCallbackLifecycle, 0o755);
write(path.join(stageDir, "cmd", "upgrade_init"), backupLifecycle("upgrade"), 0o755);
write(path.join(stageDir, "cmd", "uninstall_init"), backupLifecycle("uninstall"), 0o755);

const standaloneDir = path.join(root, ".next", "standalone");
const staticDir = path.join(root, ".next", "static");
const publicDir = path.join(root, "public");

if (fs.existsSync(standaloneDir)) {
  standaloneAppDir = findStandaloneAppDir(standaloneDir);
  copyDir(standaloneAppDir, path.join(stageDir, "app", "server"));
  const runtimePackageJson = path.join(stageDir, "app", "server", "package.json");
  if (fs.existsSync(runtimePackageJson)) {
    const runtimePkg = JSON.parse(fs.readFileSync(runtimePackageJson, "utf8"));
    runtimePkg.version = version;
    runtimePkg.mmhReleaseNotes = changelog;
    write(runtimePackageJson, JSON.stringify(runtimePkg, null, 2));
  }
  for (const envFile of [".env", ".env.local", ".env.production", ".env.development"]) {
    fs.rmSync(path.join(stageDir, "app", "server", envFile), { force: true });
  }
  copyDir(staticDir, path.join(stageDir, "app", "server", ".next", "static"));
  copyFnosPublicAssets(publicDir, path.join(stageDir, "app", "server", "public"));
  copyDir(path.join(root, "prisma"), path.join(stageDir, "app", "server", "prisma"));
  copyFile(path.join(root, "prisma.config.ts"), path.join(stageDir, "app", "server", "prisma.config.ts"));
  pruneStagedServer(path.join(stageDir, "app", "server"));
  const initSql = path.join(stageDir, "app", "server", "prisma", "native-init.sql");
  const diff = run(process.execPath, [
    prismaCli,
    "migrate",
    "diff",
    "--from-empty",
    "--to-schema",
    path.join(root, "prisma", "schema.native.prisma"),
    "--script",
    "--output",
    initSql,
  ], { stdio: "inherit" });
  if (diff.status !== 0) {
    if (diff.error) console.error(diff.error.message);
    process.exit(diff.status || 1);
  }
  write(path.join(stageDir, "app", "server", "scripts", "init-sqlite.cjs"), `const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const MIGRATIONS = [
  {
    version: "20260905_add_account_loan_type",
    description: "Add Account.loanType to classify loan accounts",
    apply(db) {
      addColumnIfMissing(db, "Account", "loanType", "TEXT");
      db.prepare(
        "UPDATE \\"Account\\" SET \\"loanType\\" = CASE WHEN \\"isConsumerLoan\\" = 1 THEN 'consumer' ELSE 'home' END WHERE \\"kind\\" = 'loan'",
      ).run();
    },
  },
  {
    version: "20260905_split_settlement_account_kind",
    description: "Split counterparty settlement accounts from institution loans",
    apply(db) {
      db.prepare("UPDATE Account SET kind = 'settlement', loanType = NULL, isConsumerLoan = 0 WHERE kind = 'loan' AND counterpartyId IS NOT NULL AND institutionId IS NULL").run();
      db.prepare("UPDATE Account SET loanType = NULL, isConsumerLoan = 0 WHERE kind = 'settlement'").run();
    },
  },
  {
    version: "20260906_restore_counterparty_settlement_kind",
    description: "Restore counterparty-owned settlement accounts after loan split",
    apply(db) {
      db.prepare("UPDATE Account SET kind = 'settlement', loanType = NULL, isConsumerLoan = 0 WHERE kind = 'loan' AND counterpartyId IS NOT NULL AND institutionId IS NULL").run();
      db.prepare("UPDATE Account SET loanType = NULL, isConsumerLoan = 0 WHERE kind = 'settlement'").run();
    },
  },
  {
    version: "20260907_normalize_counterparty_settlement_accounts",
    description: "Normalize all legacy counterparty-owned loan accounts to settlement",
    apply(db) {
      db.prepare("UPDATE Account SET kind = 'settlement', institutionId = NULL, loanType = NULL, isConsumerLoan = 0 WHERE kind = 'loan' AND counterpartyId IS NOT NULL").run();
      db.prepare("UPDATE Account SET institutionId = NULL, loanType = NULL, isConsumerLoan = 0 WHERE kind = 'settlement'").run();
    },
  },
  {
    version: "20260812_account_note",
    description: "Add Account.note freeform remark",
    apply(db) {
      addColumnIfMissing(db, "Account", "note", "TEXT");
    },
  },
  {
    version: "20260812_user_session_days",
    description: "Add UserSettings.sessionDays login retention setting",
    apply(db) {
      addColumnIfMissing(db, "UserSettings", "sessionDays", "INTEGER NOT NULL DEFAULT 30");
    },
  },
  {
    version: "20260811_stock_domain",
    description: "Add stock core tables",
    apply(db) {
      createStockDomainTables(db);
    },
  },
  {
    version: "20260812_stock_reference_tables",
    description: "Add stock market fee rules and brokerage catalog",
    apply(db) {
      createStockReferenceTables(db);
    },
  },
  {
    version: "20260812_statement_recognition_rules",
    description: "Add unified statement recognition rules",
    apply(db) {
      createStatementRecognitionRulesTable(db);
    },
  },
  {
    version: "20260813_zz_unify_statement_learning_rules",
    description: "Move legacy statement category rules into recognition rules",
    apply(db) {
      migrateLegacyStatementCategoryRules(db);
    },
  },
  {
    version: "20260814_fix_property_cash_entry_fk",
    description: "Point property_transactions.cashEntryId at transactions instead of TxRecord",
    apply(db) {
      rebuildPropertyTransactionsCashEntryFk(db);
    },
  },
  {
    version: "20260819_add_category_sort_order",
    description: "Add Category.sortOrder for stable category ordering",
    apply(db) {
      addCategorySortOrder(db);
    },
  },
  {
    version: "20260820_add_ai_model_api_mode",
    description: "Add AiModel.apiMode provider mode",
    apply(db) {
      if (tableExists(db, "AiModel")) {
        addColumnIfMissing(db, "AiModel", "apiMode", "TEXT NOT NULL DEFAULT 'chat'");
      }
    },
  },
  {
    version: "20260823_add_entry_origin",
    description: "Add transaction entry origin fields",
    apply(db) {
      for (const tableName of [
        "transactions",
        "fund_transactions",
        "stock_transactions",
        "insurance_transactions",
        "wealth_transactions",
        "deposit_transactions",
        "precious_metal_transactions",
        "property_transactions",
      ]) {
        if (tableExists(db, tableName)) {
          addColumnIfMissing(db, tableName, "entryOrigin", "TEXT NOT NULL DEFAULT 'manual'");
        }
      }
    },
  },
  {
    version: "20260825_add_secondary_scheduled_execution_day",
    description: "Add RegularInvestPlan.secondaryExecutionDay for dual-date schedules",
    apply(db) {
      if (tableExists(db, "RegularInvestPlan")) {
        addColumnIfMissing(db, "RegularInvestPlan", "secondaryExecutionDay", "INTEGER");
      }
    },
  },
  {
    version: "20260902_add_regular_invest_plan_name",
    description: "Add RegularInvestPlan.planName for editable scheduled task names",
    apply(db) {
      if (tableExists(db, "RegularInvestPlan")) {
        addColumnIfMissing(db, "RegularInvestPlan", "planName", "TEXT");
      }
    },
  },
  {
    version: "20260903_normalize_ewallet_institution_type",
    description: "Normalize legacy wallet institutions to the payment-platform type",
    apply(db) {
      if (tableExists(db, "Institution")) {
        db.prepare("UPDATE \\"Institution\\" SET \\"type\\" = 'payment' WHERE \\"type\\" = 'ewallet'").run();
      }
    },
  },
  {
    version: "20260903_add_fund_profile_trading_calendar",
    description: "Add fund-level NAV trading calendar to fund profiles",
    apply(db) {
      if (!tableExists(db, "FundProfile")) return;
      addColumnIfMissing(db, "FundProfile", "tradingCalendar", "TEXT");
      db.prepare(
        "UPDATE \\"FundProfile\\" SET \\"tradingCalendar\\" = CASE " +
          "WHEN \\"fundName\\" LIKE '%\\u9999\\u6E2F%' OR \\"fundName\\" LIKE '%\\u6E2F\\u80A1%' OR \\"fundName\\" LIKE '%Hang Seng%' OR \\"fundName\\" LIKE '%Hong Kong%' THEN 'hk_fund' " +
          "WHEN \\"fundName\\" LIKE '%\\u65E5\\u672C%' OR \\"fundName\\" LIKE '%Nikkei%' OR \\"fundName\\" LIKE '%TOPIX%' OR \\"fundName\\" LIKE '%Japan%' THEN 'jp_fund' " +
          "WHEN \\"fundName\\" LIKE '%QDII%' OR \\"fundName\\" LIKE '%\\u7F8E\\u56FD%' OR \\"fundName\\" LIKE '%\\u5168\\u7403%' OR \\"fundName\\" LIKE '%NASDAQ%' OR \\"fundName\\" LIKE '%USA%' THEN 'us_fund' " +
          "ELSE 'cn_fund' END WHERE \\"tradingCalendar\\" IS NULL",
      ).run();
    },
  },
  {
    version: "20260903_restore_fund_profile_company_code",
    description: "Restore FundProfile.fundCompanyCode for schema convergence",
    apply(db) {
      if (tableExists(db, "FundProfile")) {
        addColumnIfMissing(db, "FundProfile", "fundCompanyCode", "TEXT");
      }
    },
  },
  {
    version: "20260903_z_repair_investment_business_sources",
    description: "Repair split fund and wealth business sources",
    apply(db) {
      repairInvestmentBusinessSources(db);
    },
  },
  {
    version: "20260826_add_stock_latest_price_date",
    description: "Add StockHolding.latestPriceDate for latest stock valuation timestamps",
    apply(db) {
      if (tableExists(db, "stock_holdings")) {
        addColumnIfMissing(db, "stock_holdings", "latestPriceDate", "DATETIME");
      }
    },
  },
  {
    version: "20260828_add_fixed_asset_type",
    description: "Add fixed asset subtype fields to accounts and property assets",
    apply(db) {
      if (tableExists(db, "Account")) {
        addColumnIfMissing(db, "Account", "fixedAssetType", "TEXT");
      }
      if (tableExists(db, "property_assets")) {
        addColumnIfMissing(db, "property_assets", "assetType", "TEXT NOT NULL DEFAULT 'property'");
        addColumnIfMissing(db, "property_assets", "attributes", "TEXT");
      }
    },
  },
  {
    version: "20260905_add_property_mortgage_loan_account",
    description: "Add mortgage loan linkage to property assets",
    apply(db) {
      if (tableExists(db, "property_assets")) {
        addColumnIfMissing(db, "property_assets", "mortgageLoanAccountId", "TEXT");
        db.exec("CREATE INDEX IF NOT EXISTS \\"property_assets_householdId_mortgageLoanAccountId_idx\\" ON \\"property_assets\\"(\\"householdId\\", \\"mortgageLoanAccountId\\")");
      }
    },
  },
  {
    version: "20260829_add_credit_card_billing_day",
    description: "Add credit-card billing-day history table",
    apply(db) {
      createCreditCardBillingDayTable(db);
    },
  },
];

function databasePathFromUrl(value) {
  if (!value || !value.startsWith("file:")) {
    throw new Error("DATABASE_URL must be a SQLite file: URL.");
  }
  const rawPath = value.slice("file:".length);
  return path.resolve(decodeURIComponent(rawPath));
}

function quoteIdent(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error("Unsafe SQLite identifier: " + value);
  }
  return '"' + value + '"';
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function columnExists(db, tableName, columnName) {
  return db.prepare("PRAGMA table_info(" + quoteIdent(tableName) + ")").all().some((column) => column.name === columnName);
}

function addColumnIfMissing(db, tableName, columnName, definition) {
  if (!tableExists(db, tableName)) {
    throw new Error("SQLite migration target table is missing: " + tableName);
  }
  if (columnExists(db, tableName, columnName)) return;
  db.exec("ALTER TABLE " + quoteIdent(tableName) + " ADD COLUMN " + quoteIdent(columnName) + " " + definition);
}

function addCategorySortOrder(db) {
  if (!tableExists(db, "Category")) return;
  addColumnIfMissing(db, "Category", "sortOrder", "INTEGER NOT NULL DEFAULT 0");

  const rows = db.prepare(
    "SELECT \\\"id\\\", \\\"householdId\\\", \\\"type\\\", \\\"parentId\\\", \\\"name\\\" FROM \\\"Category\\\" ORDER BY \\\"householdId\\\" ASC, \\\"type\\\" ASC, \\\"parentId\\\" ASC, \\\"name\\\" ASC, \\\"id\\\" ASC",
  ).all();
  const nextOrderByBucket = new Map();
  const update = db.prepare("UPDATE \\\"Category\\\" SET \\\"sortOrder\\\" = ? WHERE \\\"id\\\" = ?");
  for (const row of rows) {
    const bucketKey = [row.householdId ?? "", row.type ?? "", row.parentId ?? ""].join("\u001f");
    const nextOrder = nextOrderByBucket.get(bucketKey) ?? 0;
    update.run(nextOrder, row.id);
    nextOrderByBucket.set(bucketKey, nextOrder + 1);
  }

  db.exec("CREATE INDEX IF NOT EXISTS \\\"Category_householdId_type_parentId_sortOrder_idx\\\" ON \\\"Category\\\"(\\\"householdId\\\", \\\"type\\\", \\\"parentId\\\", \\\"sortOrder\\\")");
}

function createCreditCardBillingDayTable(db) {
  db.exec([
    "CREATE TABLE IF NOT EXISTS \\\"CreditCardBillingDay\\\" (\\\"id\\\" TEXT NOT NULL PRIMARY KEY, \\\"accountId\\\" TEXT NOT NULL, \\\"effectiveDate\\\" DATETIME NOT NULL, \\\"billingDay\\\" INTEGER NOT NULL, \\\"createdAt\\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \\\"updatedAt\\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \\\"CreditCardBillingDay_accountId_fkey\\\" FOREIGN KEY (\\\"accountId\\\") REFERENCES \\\"Account\\\"(\\\"id\\\") ON DELETE CASCADE ON UPDATE CASCADE)",
    "CREATE INDEX IF NOT EXISTS \\\"CreditCardBillingDay_accountId_idx\\\" ON \\\"CreditCardBillingDay\\\"(\\\"accountId\\\")",
    "CREATE UNIQUE INDEX IF NOT EXISTS \\\"CreditCardBillingDay_accountId_effectiveDate_key\\\" ON \\\"CreditCardBillingDay\\\"(\\\"accountId\\\", \\\"effectiveDate\\\")",
  ].join(";"));
  addColumnIfMissing(db, "CreditCardBillingDay", "updatedAt", "DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00'");
  if (!tableExists(db, "Account")) return;
  db.exec("INSERT OR IGNORE INTO \\\"CreditCardBillingDay\\\" (\\\"id\\\", \\\"accountId\\\", \\\"effectiveDate\\\", \\\"billingDay\\\") SELECT 'ccbd_' || \\\"id\\\" || '_19000101', \\\"id\\\", '1900-01-01 00:00:00', \\\"billingDay\\\" FROM \\\"Account\\\" WHERE \\\"kind\\\" = 'bank_credit' AND \\\"billingDay\\\" IS NOT NULL");
}

function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    current += char;
    if (quote) {
      if (char === quote) {
        if (next === quote) {
          current += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ";") {
      const statement = current.slice(0, -1).trim();
      if (statement) statements.push(statement);
      current = "";
    }
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

function stripLeadingSqlComments(statement) {
  let value = statement.trim();
  while (value.startsWith("--")) {
    const newline = value.indexOf("\\n");
    if (newline < 0) return "";
    value = value.slice(newline + 1).trim();
  }
  return value;
}

function createTableNameFromStatement(statement) {
  const match = /^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?([^"\\s(]+)"?/i.exec(statement.trim());
  return match ? match[1] : "";
}

function createIndexTableNameFromStatement(statement) {
  const match = /^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?[^"\\s(]+"?\\s+ON\\s+"?([^"\\s(]+)"?/i.exec(statement.trim());
  return match ? match[1] : "";
}

function createIndexStatementIfMissing(statement) {
  const trimmed = statement.trim();
  if (/^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+/i.test(trimmed)) return trimmed;
  if (/^CREATE\\s+UNIQUE\\s+INDEX\\s+/i.test(trimmed)) {
    return trimmed.replace(/^CREATE\\s+UNIQUE\\s+INDEX\\s+/i, "CREATE UNIQUE INDEX IF NOT EXISTS ");
  }
  return trimmed.replace(/^CREATE\\s+INDEX\\s+/i, "CREATE INDEX IF NOT EXISTS ");
}

function splitSqlListItems(value) {
  const items = [];
  let current = "";
  let quote = null;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const next = value[i + 1];
    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      const item = current.trim();
      if (item) items.push(item);
      current = "";
      continue;
    }
    current += char;
  }
  const tail = current.trim();
  if (tail) items.push(tail);
  return items;
}

function createTableBodyFromStatement(statement) {
  const trimmed = statement.trim();
  const start = trimmed.indexOf("(");
  if (start < 0) return "";
  let body = "";
  let quote = null;
  let depth = 1;
  for (let i = start + 1; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    const next = trimmed[i + 1];
    if (quote) {
      body += char;
      if (char === quote) {
        if (next === quote) {
          body += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      body += char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      body += char;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return body;
      body += char;
      continue;
    }
    body += char;
  }
  return "";
}

function createTableColumnDefinitionsFromStatement(statement) {
  const columns = [];
  for (const item of splitSqlListItems(createTableBodyFromStatement(statement))) {
    const trimmed = item.trim();
    if (!trimmed || /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\\b/i.test(trimmed)) continue;
    const quoted = /^"([^"]+)"\\s+([\\s\\S]+)$/.exec(trimmed);
    if (quoted) {
      columns.push({ name: quoted[1], definition: quoted[2].trim() });
      continue;
    }
    const bare = /^([A-Za-z_][A-Za-z0-9_]*)\\s+([\\s\\S]+)$/.exec(trimmed);
    if (bare) columns.push({ name: bare[1], definition: bare[2].trim() });
  }
  return columns;
}

function canAddColumnFromCreateTableDefinition(definition) {
  const upper = definition.toUpperCase();
  if (/\\bPRIMARY\\s+KEY\\b|\\bUNIQUE\\b/.test(upper)) return false;
  if (/\\bGENERATED\\b|\\bAS\\s*\\(/.test(upper)) return false;
  if (/\\bNOT\\s+NULL\\b/.test(upper) && !/\\bDEFAULT\\b/.test(upper)) return false;
  if (/\\bDEFAULT\\s+(?:CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP)\\b/.test(upper)) return false;
  if (/\\bDEFAULT\\s*\\(/.test(upper)) return false;
  return true;
}

function applyMissingColumnsFromCreateTableStatement(db, statement) {
  const tableName = createTableNameFromStatement(statement);
  if (!tableName || !tableExists(db, tableName)) return;
  for (const column of createTableColumnDefinitionsFromStatement(statement)) {
    if (columnExists(db, tableName, column.name)) continue;
    if (!canAddColumnFromCreateTableDefinition(column.definition)) {
      console.warn("SQLite schema column skipped from native-init.sql because it cannot be safely added: " + tableName + "." + column.name);
      continue;
    }
    try {
      addColumnIfMissing(db, tableName, column.name, column.definition);
      console.log("SQLite schema column added from native-init.sql: " + tableName + "." + column.name);
    } catch (error) {
      console.warn("SQLite schema column skipped from native-init.sql for " + tableName + "." + column.name + ": " + (error && error.message ? error.message : String(error)));
    }
  }
}

function createIndexColumnNamesFromStatement(statement) {
  const match = /\\(([^()]*)\\)\\s*(?:WHERE\\s+.*)?$/i.exec(statement.trim());
  if (!match) return [];
  const names = [];
  for (const item of splitSqlListItems(match[1])) {
    const normalized = item.trim().replace(/\\s+(?:ASC|DESC)\\s*$/i, "");
    const quoted = /^"([^"]+)"$/.exec(normalized);
    if (quoted) {
      names.push(quoted[1]);
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
      names.push(normalized);
      continue;
    }
    return [];
  }
  return names;
}

function indexColumnsExist(db, tableName, columnNames) {
  if (!columnNames.length) return true;
  const existingColumns = new Set(db.prepare("PRAGMA table_info(" + quoteIdent(tableName) + ")").all().map((column) => column.name));
  return columnNames.every((columnName) => existingColumns.has(columnName));
}

function applyMissingSchemaObjectsFromInitSql(db, sqlPath) {
  const statements = splitSqlStatements(fs.readFileSync(sqlPath, "utf8"));
  for (const rawStatement of statements) {
    const statement = stripLeadingSqlComments(rawStatement);
    if (!/^CREATE\\s+TABLE\\s+/i.test(statement)) continue;
    const tableName = createTableNameFromStatement(statement);
    if (!tableName || tableExists(db, tableName)) continue;
    db.exec(statement);
    console.log("SQLite schema table added from native-init.sql: " + tableName);
  }
  for (const rawStatement of statements) {
    const statement = stripLeadingSqlComments(rawStatement);
    if (!/^CREATE\\s+TABLE\\s+/i.test(statement)) continue;
    applyMissingColumnsFromCreateTableStatement(db, statement);
  }
  for (const rawStatement of statements) {
    const statement = stripLeadingSqlComments(rawStatement);
    if (!/^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+/i.test(statement)) continue;
    const tableName = createIndexTableNameFromStatement(statement);
    if (!tableName || !tableExists(db, tableName)) continue;
    const columnNames = createIndexColumnNamesFromStatement(statement);
    if (!indexColumnsExist(db, tableName, columnNames)) {
      console.warn("SQLite schema index skipped from native-init.sql because columns are missing on " + tableName);
      continue;
    }
    try {
      db.exec(createIndexStatementIfMissing(statement));
    } catch (error) {
      console.warn("SQLite schema index skipped from native-init.sql for " + tableName + ": " + (error && error.message ? error.message : String(error)));
    }
  }
}

function createStockDomainTables(db) {
  db.exec([
    "CREATE TABLE IF NOT EXISTS \\"stock_securities\\" (\\"id\\" TEXT NOT NULL PRIMARY KEY, \\"householdId\\" TEXT NOT NULL, \\"market\\" TEXT NOT NULL, \\"stockCode\\" TEXT NOT NULL, \\"stockName\\" TEXT NOT NULL, \\"currency\\" TEXT NOT NULL DEFAULT 'CNY', \\"exchange\\" TEXT, \\"isActive\\" BOOLEAN NOT NULL DEFAULT true, \\"createdAt\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \\"updatedAt\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \\"stock_securities_householdId_fkey\\" FOREIGN KEY (\\"householdId\\") REFERENCES \\"Household\\"(\\"id\\") ON DELETE CASCADE ON UPDATE CASCADE)",
    "CREATE TABLE IF NOT EXISTS \\"stock_holdings\\" (\\"id\\" TEXT NOT NULL PRIMARY KEY, \\"householdId\\" TEXT NOT NULL, \\"accountId\\" TEXT NOT NULL, \\"securityId\\" TEXT NOT NULL, \\"market\\" TEXT NOT NULL, \\"stockCode\\" TEXT NOT NULL, \\"stockName\\" TEXT, \\"quantity\\" DECIMAL NOT NULL DEFAULT 0, \\"avgCost\\" DECIMAL NOT NULL DEFAULT 0, \\"cost\\" DECIMAL NOT NULL DEFAULT 0, \\"latestPrice\\" DECIMAL, \\"marketValue\\" DECIMAL NOT NULL DEFAULT 0, \\"historicalProfit\\" DECIMAL NOT NULL DEFAULT 0, \\"updatedAt\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \\"stock_holdings_householdId_fkey\\" FOREIGN KEY (\\"householdId\\") REFERENCES \\"Household\\"(\\"id\\") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT \\"stock_holdings_accountId_fkey\\" FOREIGN KEY (\\"accountId\\") REFERENCES \\"Account\\"(\\"id\\") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT \\"stock_holdings_securityId_fkey\\" FOREIGN KEY (\\"securityId\\") REFERENCES \\"stock_securities\\"(\\"id\\") ON DELETE CASCADE ON UPDATE CASCADE)",
    "CREATE TABLE IF NOT EXISTS \\"stock_transactions\\" (\\"id\\" TEXT NOT NULL PRIMARY KEY, \\"householdId\\" TEXT NOT NULL, \\"stockAccountId\\" TEXT NOT NULL, \\"cashAccountId\\" TEXT, \\"cashEntryId\\" TEXT, \\"securityId\\" TEXT, \\"market\\" TEXT NOT NULL, \\"stockCode\\" TEXT NOT NULL, \\"stockName\\" TEXT, \\"action\\" TEXT NOT NULL, \\"source\\" TEXT DEFAULT 'manual', \\"tradeDate\\" DATETIME NOT NULL, \\"settleDate\\" DATETIME, \\"grossAmount\\" DECIMAL NOT NULL, \\"netAmount\\" DECIMAL, \\"quantity\\" DECIMAL, \\"price\\" DECIMAL, \\"fee\\" DECIMAL, \\"commission\\" DECIMAL, \\"stampTax\\" DECIMAL, \\"transferFee\\" DECIMAL, \\"exchangeFee\\" DECIMAL, \\"regulatoryFee\\" DECIMAL, \\"otherFee\\" DECIMAL, \\"realizedProfit\\" DECIMAL, \\"externalLinkId\\" TEXT, \\"brokerTradeId\\" TEXT, \\"note\\" TEXT, \\"deletedAt\\" DATETIME, \\"createdAt\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \\"updatedAt\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \\"stock_transactions_householdId_fkey\\" FOREIGN KEY (\\"householdId\\") REFERENCES \\"Household\\"(\\"id\\") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT \\"stock_transactions_stockAccountId_fkey\\" FOREIGN KEY (\\"stockAccountId\\") REFERENCES \\"Account\\"(\\"id\\") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT \\"stock_transactions_cashAccountId_fkey\\" FOREIGN KEY (\\"cashAccountId\\") REFERENCES \\"Account\\"(\\"id\\") ON DELETE SET NULL ON UPDATE CASCADE, CONSTRAINT \\"stock_transactions_securityId_fkey\\" FOREIGN KEY (\\"securityId\\") REFERENCES \\"stock_securities\\"(\\"id\\") ON DELETE SET NULL ON UPDATE CASCADE)",
    "CREATE TABLE IF NOT EXISTS \\"stock_price_cache\\" (\\"id\\" TEXT NOT NULL PRIMARY KEY, \\"securityId\\" TEXT, \\"market\\" TEXT NOT NULL, \\"stockCode\\" TEXT NOT NULL, \\"priceDate\\" DATETIME NOT NULL, \\"closePrice\\" DECIMAL NOT NULL, \\"currency\\" TEXT NOT NULL DEFAULT 'CNY', \\"source\\" TEXT NOT NULL DEFAULT 'manual', \\"createdAt\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \\"updatedAt\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \\"stock_price_cache_securityId_fkey\\" FOREIGN KEY (\\"securityId\\") REFERENCES \\"stock_securities\\"(\\"id\\") ON DELETE SET NULL ON UPDATE CASCADE)",
    "CREATE TABLE IF NOT EXISTS \\"stock_fee_rules\\" (\\"id\\" TEXT NOT NULL PRIMARY KEY, \\"accountId\\" TEXT NOT NULL, \\"securityId\\" TEXT, \\"market\\" TEXT, \\"stockCode\\" TEXT, \\"feeType\\" TEXT NOT NULL, \\"direction\\" TEXT NOT NULL DEFAULT 'both', \\"rate\\" DECIMAL, \\"amount\\" DECIMAL, \\"minAmount\\" DECIMAL, \\"currency\\" TEXT NOT NULL DEFAULT 'CNY', \\"effectiveDate\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \\"source\\" TEXT NOT NULL DEFAULT 'manual', \\"note\\" TEXT, \\"createdAt\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \\"updatedAt\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \\"stock_fee_rules_accountId_fkey\\" FOREIGN KEY (\\"accountId\\") REFERENCES \\"Account\\"(\\"id\\") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT \\"stock_fee_rules_securityId_fkey\\" FOREIGN KEY (\\"securityId\\") REFERENCES \\"stock_securities\\"(\\"id\\") ON DELETE SET NULL ON UPDATE CASCADE)",
    "CREATE UNIQUE INDEX IF NOT EXISTS \\"stock_securities_householdId_market_stockCode_key\\" ON \\"stock_securities\\"(\\"householdId\\", \\"market\\", \\"stockCode\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_securities_householdId_stockName_idx\\" ON \\"stock_securities\\"(\\"householdId\\", \\"stockName\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_securities_market_stockCode_idx\\" ON \\"stock_securities\\"(\\"market\\", \\"stockCode\\")",
    "CREATE UNIQUE INDEX IF NOT EXISTS \\"stock_holdings_accountId_securityId_key\\" ON \\"stock_holdings\\"(\\"accountId\\", \\"securityId\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_holdings_householdId_accountId_idx\\" ON \\"stock_holdings\\"(\\"householdId\\", \\"accountId\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_holdings_accountId_idx\\" ON \\"stock_holdings\\"(\\"accountId\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_holdings_securityId_idx\\" ON \\"stock_holdings\\"(\\"securityId\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_holdings_market_stockCode_idx\\" ON \\"stock_holdings\\"(\\"market\\", \\"stockCode\\")",
    "CREATE UNIQUE INDEX IF NOT EXISTS \\"stock_transactions_cashEntryId_key\\" ON \\"stock_transactions\\"(\\"cashEntryId\\")",
    "CREATE UNIQUE INDEX IF NOT EXISTS \\"stock_transactions_householdId_stockAccountId_externalLinkId_key\\" ON \\"stock_transactions\\"(\\"householdId\\", \\"stockAccountId\\", \\"externalLinkId\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_transactions_householdId_stockAccountId_tradeDate_idx\\" ON \\"stock_transactions\\"(\\"householdId\\", \\"stockAccountId\\", \\"tradeDate\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_transactions_cashAccountId_tradeDate_idx\\" ON \\"stock_transactions\\"(\\"cashAccountId\\", \\"tradeDate\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_transactions_securityId_tradeDate_idx\\" ON \\"stock_transactions\\"(\\"securityId\\", \\"tradeDate\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_transactions_market_stockCode_tradeDate_idx\\" ON \\"stock_transactions\\"(\\"market\\", \\"stockCode\\", \\"tradeDate\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_transactions_brokerTradeId_idx\\" ON \\"stock_transactions\\"(\\"brokerTradeId\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_transactions_deletedAt_idx\\" ON \\"stock_transactions\\"(\\"deletedAt\\")",
    "CREATE UNIQUE INDEX IF NOT EXISTS \\"stock_price_cache_market_stockCode_priceDate_key\\" ON \\"stock_price_cache\\"(\\"market\\", \\"stockCode\\", \\"priceDate\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_price_cache_securityId_priceDate_idx\\" ON \\"stock_price_cache\\"(\\"securityId\\", \\"priceDate\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_price_cache_priceDate_idx\\" ON \\"stock_price_cache\\"(\\"priceDate\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_fee_rules_accountId_feeType_direction_idx\\" ON \\"stock_fee_rules\\"(\\"accountId\\", \\"feeType\\", \\"direction\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_fee_rules_accountId_securityId_feeType_direction_idx\\" ON \\"stock_fee_rules\\"(\\"accountId\\", \\"securityId\\", \\"feeType\\", \\"direction\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_fee_rules_accountId_market_stockCode_feeType_direction_idx\\" ON \\"stock_fee_rules\\"(\\"accountId\\", \\"market\\", \\"stockCode\\", \\"feeType\\", \\"direction\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_fee_rules_effectiveDate_idx\\" ON \\"stock_fee_rules\\"(\\"effectiveDate\\")",
  ].join(";"));
  addColumnIfMissing(db, "entry_business_links", "stockTransactionId", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS \\"entry_business_links_stockTransactionId_idx\\" ON \\"entry_business_links\\"(\\"stockTransactionId\\")");
}

function createStockReferenceTables(db) {
  db.exec([
    "CREATE TABLE IF NOT EXISTS \\"stock_market_fee_rules\\" (\\"id\\" TEXT NOT NULL PRIMARY KEY, \\"householdId\\" TEXT, \\"market\\" TEXT NOT NULL, \\"stockCode\\" TEXT, \\"feeType\\" TEXT NOT NULL, \\"direction\\" TEXT NOT NULL DEFAULT 'both', \\"rate\\" DECIMAL, \\"amount\\" DECIMAL, \\"minAmount\\" DECIMAL, \\"currency\\" TEXT NOT NULL DEFAULT 'CNY', \\"effectiveDate\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \\"source\\" TEXT NOT NULL DEFAULT 'system', \\"sourceUrl\\" TEXT, \\"note\\" TEXT, \\"createdAt\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \\"updatedAt\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \\"stock_market_fee_rules_householdId_fkey\\" FOREIGN KEY (\\"householdId\\") REFERENCES \\"Household\\"(\\"id\\") ON DELETE CASCADE ON UPDATE CASCADE)",
    "CREATE TABLE IF NOT EXISTS \\"stock_brokerage_catalog\\" (\\"id\\" TEXT NOT NULL PRIMARY KEY, \\"name\\" TEXT NOT NULL, \\"shortName\\" TEXT, \\"aliases\\" TEXT, \\"registryCode\\" TEXT, \\"officialWebsite\\" TEXT, \\"source\\" TEXT NOT NULL DEFAULT 'manual', \\"sourceUrl\\" TEXT, \\"sourceUpdatedAt\\" DATETIME, \\"isActive\\" BOOLEAN NOT NULL DEFAULT true, \\"createdAt\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \\"updatedAt\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    "CREATE INDEX IF NOT EXISTS \\"stock_market_fee_rules_householdId_market_stockCode_feeType_direction_idx\\" ON \\"stock_market_fee_rules\\"(\\"householdId\\", \\"market\\", \\"stockCode\\", \\"feeType\\", \\"direction\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_market_fee_rules_market_stockCode_feeType_direction_idx\\" ON \\"stock_market_fee_rules\\"(\\"market\\", \\"stockCode\\", \\"feeType\\", \\"direction\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_market_fee_rules_effectiveDate_idx\\" ON \\"stock_market_fee_rules\\"(\\"effectiveDate\\")",
    "CREATE UNIQUE INDEX IF NOT EXISTS \\"stock_brokerage_catalog_name_key\\" ON \\"stock_brokerage_catalog\\"(\\"name\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_brokerage_catalog_shortName_idx\\" ON \\"stock_brokerage_catalog\\"(\\"shortName\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_brokerage_catalog_registryCode_idx\\" ON \\"stock_brokerage_catalog\\"(\\"registryCode\\")",
    "CREATE INDEX IF NOT EXISTS \\"stock_brokerage_catalog_isActive_idx\\" ON \\"stock_brokerage_catalog\\"(\\"isActive\\")",
  ].join(";"));
}

function createStatementRecognitionRulesTable(db) {
  db.exec([
    "CREATE TABLE IF NOT EXISTS \\"statement_recognition_rules\\" (\\"id\\" TEXT NOT NULL PRIMARY KEY, \\"householdId\\" TEXT NOT NULL, \\"targetType\\" TEXT NOT NULL, \\"transactionType\\" TEXT NOT NULL DEFAULT 'any', \\"keyword\\" TEXT NOT NULL, \\"normalizedKeyword\\" TEXT NOT NULL, \\"categoryId\\" TEXT, \\"categoryName\\" TEXT, \\"institutionId\\" TEXT, \\"institutionName\\" TEXT, \\"fieldName\\" TEXT, \\"source\\" TEXT NOT NULL DEFAULT 'system_default', \\"priority\\" INTEGER NOT NULL DEFAULT 100, \\"isActive\\" BOOLEAN NOT NULL DEFAULT true, \\"hitCount\\" INTEGER NOT NULL DEFAULT 0, \\"lastSeenAt\\" DATETIME, \\"createdAt\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, \\"updatedAt\\" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT \\"statement_recognition_rules_householdId_fkey\\" FOREIGN KEY (\\"householdId\\") REFERENCES \\"Household\\"(\\"id\\") ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT \\"statement_recognition_rules_categoryId_fkey\\" FOREIGN KEY (\\"categoryId\\") REFERENCES \\"Category\\"(\\"id\\") ON DELETE SET NULL ON UPDATE CASCADE, CONSTRAINT \\"statement_recognition_rules_institutionId_fkey\\" FOREIGN KEY (\\"institutionId\\") REFERENCES \\"Institution\\"(\\"id\\") ON DELETE SET NULL ON UPDATE CASCADE)",
    "CREATE UNIQUE INDEX IF NOT EXISTS \\"statement_recognition_rules_householdId_targetType_transactionType_normalizedKeyword_key\\" ON \\"statement_recognition_rules\\"(\\"householdId\\", \\"targetType\\", \\"transactionType\\", \\"normalizedKeyword\\")",
    "CREATE INDEX IF NOT EXISTS \\"statement_recognition_rules_householdId_targetType_idx\\" ON \\"statement_recognition_rules\\"(\\"householdId\\", \\"targetType\\")",
    "CREATE INDEX IF NOT EXISTS \\"statement_recognition_rules_categoryId_idx\\" ON \\"statement_recognition_rules\\"(\\"categoryId\\")",
    "CREATE INDEX IF NOT EXISTS \\"statement_recognition_rules_institutionId_idx\\" ON \\"statement_recognition_rules\\"(\\"institutionId\\")",
    "CREATE INDEX IF NOT EXISTS \\"statement_recognition_rules_isActive_idx\\" ON \\"statement_recognition_rules\\"(\\"isActive\\")",
  ].join(";"));
  addColumnIfMissing(db, "statement_recognition_rules", "fieldName", "TEXT");
}

function stripCompanySuffixValue(value) {
  const text = String(value || "").trim();
  for (const suffix of ["有限责任公司", "股份有限公司", "集团有限公司", "有限公司"]) {
    const index = text.indexOf(suffix);
    if (index > 0) return text.slice(0, index).trim();
  }
  return text;
}

function migrateLegacyStatementCategoryRules(db) {
  createStatementRecognitionRulesTable(db);
  if (tableExists(db, "statement_category_rules")) {
    const rows = db.prepare("SELECT * FROM \\"statement_category_rules\\" WHERE \\"type\\" IN ('income', 'expense') AND \\"categoryName\\" IS NOT NULL AND \\"matchText\\" IS NOT NULL AND \\"normalizedText\\" IS NOT NULL").all();
    const upsert = db.prepare(
      "INSERT INTO \\"statement_recognition_rules\\" (" +
        "\\"id\\", \\"householdId\\", \\"targetType\\", \\"transactionType\\", \\"keyword\\", \\"normalizedKeyword\\", " +
        "\\"categoryId\\", \\"categoryName\\", \\"institutionId\\", \\"institutionName\\", \\"fieldName\\", \\"source\\", \\"priority\\", " +
        "\\"isActive\\", \\"hitCount\\", \\"lastSeenAt\\", \\"createdAt\\", \\"updatedAt\\") " +
      "VALUES (@id, @householdId, 'category', @transactionType, @keyword, @normalizedKeyword, @categoryId, @categoryName, NULL, NULL, NULL, @source, @priority, true, @hitCount, @lastSeenAt, @createdAt, @updatedAt) " +
      "ON CONFLICT(\\"householdId\\", \\"targetType\\", \\"transactionType\\", \\"normalizedKeyword\\") DO UPDATE SET " +
        "\\"categoryId\\" = excluded.\\"categoryId\\", " +
        "\\"categoryName\\" = excluded.\\"categoryName\\", " +
        "\\"source\\" = excluded.\\"source\\", " +
        "\\"priority\\" = CASE WHEN \\"statement_recognition_rules\\".\\"priority\\" > excluded.\\"priority\\" THEN \\"statement_recognition_rules\\".\\"priority\\" ELSE excluded.\\"priority\\" END, " +
        "\\"isActive\\" = true, " +
        "\\"hitCount\\" = \\"statement_recognition_rules\\".\\"hitCount\\" + excluded.\\"hitCount\\", " +
        "\\"lastSeenAt\\" = COALESCE(excluded.\\"lastSeenAt\\", \\"statement_recognition_rules\\".\\"lastSeenAt\\"), " +
        "\\"updatedAt\\" = CURRENT_TIMESTAMP, " +
        "\\"keyword\\" = excluded.\\"keyword\\""
    );
    for (const row of rows) {
      const keyword = stripCompanySuffixValue(row.matchText);
      const normalizedKeyword = stripCompanySuffixValue(row.normalizedText);
      if (!keyword || !normalizedKeyword) continue;
      upsert.run({
        id: "recog_legacy_" + row.id,
        householdId: row.householdId,
        transactionType: row.type,
        keyword,
        normalizedKeyword,
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        source: row.source,
        priority: row.source === "system_default" ? 100 : 230,
        hitCount: Number(row.hitCount || 0),
        lastSeenAt: row.lastSeenAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      });
    }
    db.exec("DROP TABLE IF EXISTS \\"statement_category_rules\\"");
  }
  cleanupStatementRecognitionRuleKeywords(db);
}

function rebuildPropertyTransactionsCashEntryFk(db) {
  if (!tableExists(db, "property_transactions")) return;
  const sqlRow = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'property_transactions'").get();
  const sql = String(sqlRow && sqlRow.sql ? sqlRow.sql : "");
  if (!/REFERENCES\\s+"TxRecord"\\s*\\(\\s*"id"\\s*\\)/i.test(sql)) return;
  const columns = db.prepare("PRAGMA table_info(\\"property_transactions\\")").all().map((column) => column.name);
  if (!columns.length) return;
  const quotedColumns = columns.map((column) => quoteIdent(column)).join(", ");
  db.exec("DROP TABLE IF EXISTS \\"property_transactions__txrecord_fk_fix\\"");
  db.exec("ALTER TABLE \\"property_transactions\\" RENAME TO \\"property_transactions__txrecord_fk_fix\\"");
  db.exec(\`CREATE TABLE "property_transactions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "cashAccountId" TEXT,
    "cashEntryId" TEXT,
    "propertyAssetId" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'purchase',
    "source" TEXT DEFAULT 'manual',
    "tradeDate" DATETIME NOT NULL,
    "settlementDate" DATETIME,
    "amount" DECIMAL NOT NULL,
    "fee" DECIMAL,
    "tax" DECIMAL,
    "realizedProfit" DECIMAL,
    "note" TEXT,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "property_transactions_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "property_transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "property_transactions_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "property_transactions_propertyAssetId_fkey" FOREIGN KEY ("propertyAssetId") REFERENCES "property_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "property_transactions_cashEntryId_fkey" FOREIGN KEY ("cashEntryId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE
  )\`);
  db.exec("INSERT INTO \\"property_transactions\\" (" + quotedColumns + ") SELECT " + quotedColumns + " FROM \\"property_transactions__txrecord_fk_fix\\"");
  db.exec("DROP TABLE \\"property_transactions__txrecord_fk_fix\\"");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS \\"property_transactions_cashEntryId_key\\" ON \\"property_transactions\\"(\\"cashEntryId\\") WHERE \\"cashEntryId\\" IS NOT NULL");
  db.exec("CREATE INDEX IF NOT EXISTS \\"property_transactions_householdId_accountId_tradeDate_idx\\" ON \\"property_transactions\\"(\\"householdId\\", \\"accountId\\", \\"tradeDate\\")");
  db.exec("CREATE INDEX IF NOT EXISTS \\"property_transactions_cashAccountId_tradeDate_idx\\" ON \\"property_transactions\\"(\\"cashAccountId\\", \\"tradeDate\\")");
  db.exec("CREATE INDEX IF NOT EXISTS \\"property_transactions_propertyAssetId_tradeDate_idx\\" ON \\"property_transactions\\"(\\"propertyAssetId\\", \\"tradeDate\\")");
  db.exec("CREATE INDEX IF NOT EXISTS \\"property_transactions_deletedAt_idx\\" ON \\"property_transactions\\"(\\"deletedAt\\")");
}

function cleanupStatementRecognitionRuleKeywords(db) {
  if (!tableExists(db, "statement_recognition_rules")) return;
  const rows = db.prepare("SELECT \\"id\\", \\"householdId\\", \\"targetType\\", \\"transactionType\\", \\"keyword\\", \\"normalizedKeyword\\", \\"hitCount\\" FROM \\"statement_recognition_rules\\" WHERE \\"keyword\\" LIKE '%有限公司%' OR \\"normalizedKeyword\\" LIKE '%有限公司%'").all();
  const findDuplicate = db.prepare("SELECT \\"id\\" FROM \\"statement_recognition_rules\\" WHERE \\"householdId\\" = ? AND \\"targetType\\" = ? AND \\"transactionType\\" = ? AND \\"normalizedKeyword\\" = ? AND \\"id\\" <> ? LIMIT 1");
  const mergeDuplicate = db.prepare("UPDATE \\"statement_recognition_rules\\" SET \\"hitCount\\" = \\"hitCount\\" + ?, \\"updatedAt\\" = CURRENT_TIMESTAMP WHERE \\"id\\" = ?");
  const deleteRule = db.prepare("DELETE FROM \\"statement_recognition_rules\\" WHERE \\"id\\" = ?");
  const updateRule = db.prepare("UPDATE \\"statement_recognition_rules\\" SET \\"keyword\\" = ?, \\"normalizedKeyword\\" = ?, \\"updatedAt\\" = CURRENT_TIMESTAMP WHERE \\"id\\" = ?");
  for (const row of rows) {
    const keyword = stripCompanySuffixValue(row.keyword);
    const normalizedKeyword = stripCompanySuffixValue(row.normalizedKeyword);
    if (!keyword || !normalizedKeyword) continue;
    const duplicate = findDuplicate.get(row.householdId, row.targetType, row.transactionType, normalizedKeyword, row.id);
    if (duplicate) {
      mergeDuplicate.run(Number(row.hitCount || 0), duplicate.id);
      deleteRule.run(row.id);
    } else {
      updateRule.run(keyword, normalizedKeyword, row.id);
    }
  }
}

function repairInvestmentBusinessSources(db) {
  if (!tableExists(db, "transactions") || !tableExists(db, "entry_business_links")) return;

  if (tableExists(db, "fund_transactions") && tableExists(db, "FundProfile")) {
    db.exec(
      "UPDATE fund_transactions " +
        "SET fundName = (SELECT fp.fundName FROM FundProfile fp WHERE fp.fundCode = fund_transactions.fundCode) " +
        "WHERE (fundName IS NULL OR TRIM(fundName) = '' OR fundName = fundCode) " +
        "AND EXISTS (SELECT 1 FROM FundProfile fp WHERE fp.fundCode = fund_transactions.fundCode AND fp.fundName IS NOT NULL AND TRIM(fp.fundName) <> '')",
    );
  }

  if (tableExists(db, "fund_transactions") && tableExists(db, "fund_transaction_cash_flows")) {
    db.exec(
      "INSERT INTO entry_business_links " +
        "(id, householdId, cashEntryId, businessEntryId, fundTransactionId, businessType, linkType, cashFlowDirection, source, note, metadata, deletedAt, createdAt, updatedAt) " +
        "SELECT " +
          "'ebl_' || cf.txRecordId || '_fund_' || cf.fundTransactionId, " +
          "ft.householdId, cf.txRecordId, NULL, cf.fundTransactionId, 'fund', 'cash_flow', " +
          "CASE WHEN cf.kind IN ('buy_out', 'switch_in') THEN 'outflow' " +
            "WHEN cf.kind IN ('refund_in', 'redeem_in', 'dividend_in') THEN 'inflow' ELSE 'none' END, " +
          "COALESCE(ft.source, 'manual'), 'Repaired link to fund transaction', " +
          "'{\\\"splitRecord\\\":true,\\\"independentBusinessTransaction\\\":true,\\\"repairedBy\\\":\\\"20260903_z_repair_investment_business_sources\\\"}', " +
          "NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP " +
        "FROM fund_transaction_cash_flows cf " +
        "JOIN fund_transactions ft ON ft.id = cf.fundTransactionId " +
        "JOIN transactions cash ON cash.id = cf.txRecordId " +
        "WHERE ft.deletedAt IS NULL AND cash.deletedAt IS NULL " +
        "ON CONFLICT(id) DO UPDATE SET " +
          "cashEntryId = excluded.cashEntryId, businessEntryId = NULL, fundTransactionId = excluded.fundTransactionId, " +
          "businessType = excluded.businessType, linkType = excluded.linkType, cashFlowDirection = excluded.cashFlowDirection, " +
          "source = excluded.source, note = excluded.note, metadata = excluded.metadata, deletedAt = NULL, updatedAt = CURRENT_TIMESTAMP",
    );
  }

  if (tableExists(db, "fund_transactions")) {
    db.exec(
      "INSERT INTO entry_business_links " +
        "(id, householdId, cashEntryId, businessEntryId, fundTransactionId, businessType, linkType, cashFlowDirection, source, note, metadata, deletedAt, createdAt, updatedAt) " +
        "SELECT " +
          "'ebl_' || ft.cashEntryId || '_fund_' || ft.id, ft.householdId, ft.cashEntryId, NULL, ft.id, 'fund', 'cash_flow', " +
          "CASE WHEN cash.amount < 0 THEN 'outflow' WHEN cash.amount > 0 THEN 'inflow' ELSE 'none' END, " +
          "COALESCE(ft.source, 'manual'), 'Repaired link to fund transaction', " +
          "'{\\\"splitRecord\\\":true,\\\"independentBusinessTransaction\\\":true,\\\"repairedBy\\\":\\\"20260903_z_repair_investment_business_sources\\\"}', " +
          "NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP " +
        "FROM fund_transactions ft " +
        "JOIN transactions cash ON cash.id = ft.cashEntryId " +
        "WHERE ft.deletedAt IS NULL AND ft.cashEntryId IS NOT NULL AND cash.deletedAt IS NULL " +
          "AND NOT EXISTS (SELECT 1 FROM fund_transaction_cash_flows cf WHERE cf.fundTransactionId = ft.id) " +
        "ON CONFLICT(id) DO UPDATE SET " +
          "cashEntryId = excluded.cashEntryId, businessEntryId = NULL, fundTransactionId = excluded.fundTransactionId, " +
          "businessType = excluded.businessType, linkType = excluded.linkType, cashFlowDirection = excluded.cashFlowDirection, " +
          "source = excluded.source, note = excluded.note, metadata = excluded.metadata, deletedAt = NULL, updatedAt = CURRENT_TIMESTAMP",
    );
  }

  if (!tableExists(db, "wealth_transactions")) return;
  const candidates = db.prepare(
    "SELECT t.id, t.householdId, t.accountId, t.toAccountId, t.amount, t.fundName, t.fundSubtype, " +
      "t.source, t.entryOrigin, t.date, t.fundConfirmDate, t.fundArrivalDate, t.fundArrivalAmount, " +
      "t.fundUnits, t.fundNav, t.fundFee, t.depositAnnualRate, t.depositInterest, t.realizedProfit, t.note, " +
      "a.investProductType AS accountProductType, ta.investProductType AS toAccountProductType " +
      "FROM transactions t " +
      "LEFT JOIN Account a ON a.id = t.accountId " +
      "LEFT JOIN Account ta ON ta.id = t.toAccountId " +
      "WHERE t.householdId IS NOT NULL AND t.type = 'investment' AND t.deletedAt IS NULL " +
        "AND (a.investProductType = 'wealth' OR ta.investProductType = 'wealth')",
  ).all();
  const existing = db.prepare(
    "SELECT id FROM wealth_transactions WHERE id = ? OR cashEntryId = ? LIMIT 1",
  );
  const insertWealth = db.prepare(
    "INSERT OR IGNORE INTO wealth_transactions " +
      "(id, householdId, accountId, cashAccountId, cashEntryId, wealthProductId, productName, action, source, entryOrigin, " +
      "tradeDate, confirmDate, arrivalDate, grossAmount, arrivalAmount, units, nav, interest, fee, annualRate, realizedProfit, note, deletedAt, createdAt, updatedAt) " +
      "VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP)",
  );
  const upsertWealthLink = db.prepare(
    "INSERT INTO entry_business_links " +
      "(id, householdId, cashEntryId, businessEntryId, wealthTransactionId, businessType, linkType, cashFlowDirection, source, note, metadata, deletedAt, createdAt, updatedAt) " +
      "VALUES (?, ?, ?, NULL, ?, 'wealth', 'cash_flow', ?, ?, 'Repaired link to wealth transaction', ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(id) DO UPDATE SET cashEntryId = excluded.cashEntryId, businessEntryId = NULL, wealthTransactionId = excluded.wealthTransactionId, " +
        "businessType = excluded.businessType, linkType = excluded.linkType, cashFlowDirection = excluded.cashFlowDirection, source = excluded.source, " +
        "note = excluded.note, metadata = excluded.metadata, deletedAt = NULL, updatedAt = CURRENT_TIMESTAMP",
  );
  for (const row of candidates) {
    if (existing.get(row.id, row.id)) continue;
    const action = row.fundSubtype || (Number(row.amount) < 0 ? "buy" : "redeem");
    const businessAccountId = row.accountProductType === "wealth" ? row.accountId : row.toAccountId;
    const cashAccountId = row.accountProductType === "wealth" ? row.toAccountId : row.accountId;
    if (!businessAccountId) continue;
    const rawProfit = row.realizedProfit != null
      ? Number(row.realizedProfit)
      : Number(row.depositInterest || 0) - Number(row.fundFee || 0);
    const grossAmount = action === "redeem" || action === "switch_out"
      ? Math.max(0, Math.abs(Number(row.amount)) - (Number.isFinite(rawProfit) ? rawProfit : 0))
      : Math.abs(Number(row.amount));
    insertWealth.run(
      row.id,
      row.householdId,
      businessAccountId,
      cashAccountId || null,
      row.id,
      row.fundName || null,
      action,
      row.source || "manual",
      row.entryOrigin || "manual",
      row.date,
      row.fundConfirmDate || row.date,
      row.fundArrivalDate || null,
      grossAmount,
      row.fundArrivalAmount == null ? null : Math.abs(Number(row.fundArrivalAmount)),
      row.fundUnits == null ? null : row.fundUnits,
      row.fundNav == null ? null : row.fundNav,
      row.depositInterest == null ? null : row.depositInterest,
      row.fundFee == null ? null : row.fundFee,
      row.depositAnnualRate == null ? null : row.depositAnnualRate,
      row.realizedProfit == null ? null : row.realizedProfit,
      row.note || null,
      row.createdAt || new Date().toISOString(),
    );
    upsertWealthLink.run(
      "ebl_" + row.id + "_wealth_" + row.id,
      row.householdId,
      row.id,
      row.id,
      Number(row.amount) < 0 ? "outflow" : Number(row.amount) > 0 ? "inflow" : "none",
      row.source || "manual",
      "{\\\"splitRecord\\\":true,\\\"independentBusinessTransaction\\\":true,\\\"repairedBy\\\":\\\"20260903_z_repair_investment_business_sources\\\"}",
    );
  }
}

function ensureMigrationTable(db) {
  db.exec("CREATE TABLE IF NOT EXISTS _mmh_native_schema (version TEXT NOT NULL PRIMARY KEY, appliedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)");
}

function migrationApplied(db, version) {
  return Boolean(db.prepare("SELECT version FROM _mmh_native_schema WHERE version = ?").get(version));
}

function markMigrationApplied(db, version) {
  db.prepare("INSERT OR IGNORE INTO _mmh_native_schema (version) VALUES (?)").run(version);
}

function applyRuntimeMigrations(db) {
  ensureMigrationTable(db);
  for (const migration of MIGRATIONS) {
    if (migrationApplied(db, migration.version)) continue;
    db.transaction(() => {
      migration.apply(db);
      markMigrationApplied(db, migration.version);
    })();
    console.log("SQLite migration applied: " + migration.version + " - " + migration.description);
  }
}

const dbPath = databasePathFromUrl(process.env.DATABASE_URL);
const sqlPath = path.join(__dirname, "..", "prisma", "native-init.sql");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
try {
  db.pragma("busy_timeout = 10000");
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
  if (!existing) {
    db.exec(fs.readFileSync(sqlPath, "utf8"));
    ensureMigrationTable(db);
    db.prepare("INSERT OR IGNORE INTO _mmh_native_schema (version) VALUES (?)").run("0.1.0");
    applyRuntimeMigrations(db);
    applyMissingSchemaObjectsFromInitSql(db, sqlPath);
    console.log(\`SQLite database initialized at \${dbPath}\`);
  } else {
    applyRuntimeMigrations(db);
    applyMissingSchemaObjectsFromInitSql(db, sqlPath);
    console.log(\`SQLite database already initialized and migrated at \${dbPath}\`);
  }
} finally {
  db.close();
}
`);
  for (const dependency of [
    "@prisma/client",
    "@prisma/adapter-better-sqlite3",
    "better-sqlite3",
    "bindings",
  ]) {
    copyRuntimeDependencyClosure(dependency);
  }
  materializeStandaloneSymlinks(path.join(stageDir, "app", "server", ".next", "node_modules"));
  for (const dependency of [
    "@img",
    "detect-libc",
    "node-abi",
    "prebuild-install",
    "semver",
    "sharp",
  ]) {
    removeRuntimeDependency(dependency);
  }
}

if (nodeTarball) {
  requirePath(nodeTarball, `FNOS_NODE_TARBALL does not exist: ${nodeTarball}`);
  if (!path.basename(nodeTarball).includes(`linux-${target.nodeArch}`)) {
    throw new Error(`FNOS_NODE_TARBALL must match ${target.id}: expected a linux-${target.nodeArch} tarball.`);
  }
  const extract = run("tar", ["-xzf", nodeTarball, "-C", path.join(stageDir, "app", "bin"), "--strip-components=1"]);
  if (extract.status !== 0) {
    console.error(extract.stderr || extract.stdout || "Failed to extract FNOS_NODE_TARBALL.");
    process.exit(extract.status || 1);
  }
}

const hasNode = fs.existsSync(path.join(stageDir, "app", "bin", "bin", "node"));
if (hasNode) {
  fs.renameSync(path.join(stageDir, "app", "bin", "bin", "node"), path.join(stageDir, "app", "bin", "node"));
  for (const entry of fs.readdirSync(path.join(stageDir, "app", "bin"))) {
    if (entry === "node") continue;
    fs.rmSync(path.join(stageDir, "app", "bin", entry), { recursive: true, force: true });
  }
}

makeFnosPackageEntriesReadable(stageDir);

console.log(`FNOS SQLite FPK source staged: ${path.relative(root, stageDir)}`);

if (stageOnly) {
  const archive = path.join(outDir, `${appName}-fnos-v${version}-${target.assetSuffix}-fpk-source.tgz`);
  const tar = run("tar", ["-czf", archive, "-C", stageDir, "."]);
  if (tar.status !== 0) {
    console.error(tar.stderr || tar.stdout || "tar failed");
    process.exit(tar.status || 1);
  }
  console.log(`FNOS SQLite stage-only archive: ${path.relative(root, archive)}`);
  process.exit(0);
}

try {
  if (!isLinux) {
    throw new Error("fnOS release packages must be built on Linux/fnOS so native Node modules match the target platform.");
  }
  if (process.arch !== target.processArch && process.env.FNOS_ALLOW_CROSS_ARCH !== "1") {
    throw new Error(`FNOS_TARGET_ARCH=${target.id} must be built on a Linux ${target.processArch} runner so native modules match the package architecture.`);
  }
  if (process.env.FNOS_SKIP_GLIBC_CHECK !== "1") {
    assertCompatibleGlibc();
  }
  requirePath(path.join(stageDir, "app", "server", "server.js"), "Run the fnOS standalone build before packaging: npm run build:fnos:app");
  requirePath(path.join(stageDir, "app", "bin", "node"), `Provide a Linux ${target.nodeArch} Node runtime tarball via FNOS_NODE_TARBALL before building ${fpkAssetName()}.`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const rebuildEnv = {};
const nodeHeadersDir = findNodeHeadersDir();
if (nodeHeadersDir) rebuildEnv.npm_config_nodedir = nodeHeadersDir;
const stagedServerDir = path.join(stageDir, "app", "server");
if (process.env.FNOS_SKIP_NATIVE_REBUILD === "1") {
  const verifyNative = run(process.execPath, [
    "-e",
    "const Database=require('better-sqlite3'); const db=new Database(':memory:'); if (db.prepare('select 1 as ok').get().ok !== 1) process.exit(1); db.close();",
  ], {
    cwd: stagedServerDir,
    stdio: "inherit",
  });
  if (verifyNative.status !== 0) {
    console.error("FNOS_SKIP_NATIVE_REBUILD was set, but staged better-sqlite3 could not be loaded.");
    process.exit(verifyNative.status || 1);
  }
} else {
  const nativeRebuild = run(commandName("npm"), ["rebuild", "better-sqlite3", "--build-from-source"], {
    cwd: stagedServerDir,
    stdio: "inherit",
    env: rebuildEnv,
  });
  if (nativeRebuild.status !== 0) process.exit(nativeRebuild.status || 1);
}

if (manualFpk) {
  const appArchive = path.join(stageDir, "app.tgz");
  fs.rmSync(appArchive, { force: true });
  const appTar = run("tar", ["-czf", appArchive, "-C", path.join(stageDir, "app"), "."]);
  if (appTar.status !== 0) {
    console.error(appTar.stderr || appTar.stdout || "app.tgz packaging failed");
    process.exit(appTar.status || 1);
  }
  fs.rmSync(path.join(stageDir, "app"), { recursive: true, force: true });
  fs.appendFileSync(path.join(stageDir, "manifest"), `checksum=${hashFileMd5(appArchive)}\n`, "utf8");
  makeFnosPackageEntriesReadable(stageDir);
  const fpkPath = path.join(outDir, fpkAssetName());
  const fpkEntries = [
    "app.tgz",
    "cmd",
    "config",
    "wizard",
    "ICON.PNG",
    "ICON_256.PNG",
    "manifest",
  ];
  const fpkTar = run("tar", ["-czf", fpkPath, "-C", stageDir, ...fpkEntries]);
  if (fpkTar.status !== 0) {
    console.error(fpkTar.stderr || fpkTar.stdout || "manual .fpk packaging failed");
    process.exit(fpkTar.status || 1);
  }
  const primaryOutput = materializeFpkOutputs(fpkPath);
  console.log(`FNOS manual test FPK built: ${path.relative(root, primaryOutput)}`);
  process.exit(0);
}

if (!hasCommand("fnpack")) {
  console.error("fnpack was not found. Build the release .fpk on a fnOS packaging environment.");
  process.exit(1);
}

const build = run("fnpack", ["build"], { cwd: stageDir, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status || 1);

const produced = path.join(stageDir, `${appName}.fpk`);
if (!fs.existsSync(produced)) {
  console.error(`fnpack completed but did not produce ${appName}.fpk.`);
  process.exit(1);
}

const primaryOutput = materializeFpkOutputs(produced);
console.log(`FNOS SQLite ${target.id} FPK built: ${path.relative(root, primaryOutput)}`);
