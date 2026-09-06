#!/usr/bin/env node

const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const rawVersion = process.env.SYNOLOGY_PACKAGE_VERSION || process.env.SYNOPKG_PACKAGE_VERSION || pkg.version || "0.1.0";
const verifyVersion = normalizeVersion(rawVersion);
const verifyTarget = normalizeTarget(process.env.SYNOLOGY_TARGET_ARCH || process.env.SYNOPKG_TARGET_ARCH || "x86_64");
const expectedDsmMinVersion = "7.0-40000";

function normalizeVersion(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^refs\/tags\//, "")
    .replace(/^v(?=\d)/, "")
    .replace(/-synology(?:$|[.-].*)?$/, "");
  if (!/^0\.1\.\d+$/.test(normalized)) {
    fail(`SYNOLOGY_PACKAGE_VERSION must use 0.1.x format, got ${normalized || "(empty)"}.`);
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
      stageDirName: "mmh-spk",
      nodeArch: "x64",
    };
  }
  if (["arm", "arm64", "aarch64", "armv8"].includes(raw)) {
    return {
      id: "arm64",
      assetSuffix: "arm64",
      infoArch: "aarch64",
      stageDirName: "mmh-arm64-spk",
      nodeArch: "arm64",
    };
  }
  fail(`SYNOLOGY_TARGET_ARCH must be x86_64 or arm64, got ${value || "(empty)"}.`);
}

function fail(message) {
  console.error(`Synology package check failed: ${message}`);
  process.exit(1);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function readJson(file) {
  try {
    return JSON.parse(read(file));
  } catch (error) {
    fail(`Unable to parse JSON ${path.relative(root, file)}: ${error.message}`);
  }
}

function hashFileMd5(file) {
  const hash = crypto.createHash("md5");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: options.stdio || "pipe",
    shell: false,
    encoding: "utf8",
  });
}

function spkAssetName() {
  return `mmh-synology-v${verifyVersion}-${verifyTarget.assetSuffix}.spk`;
}

function builtSpkPath() {
  return process.env.SYNOLOGY_VERIFY_SPK_PATH
    ? path.resolve(root, process.env.SYNOLOGY_VERIFY_SPK_PATH)
    : path.join(root, "release-artifacts", "synology", spkAssetName());
}

function isGzipFile(file) {
  const header = Buffer.alloc(2);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, header, 0, 2, 0);
  } finally {
    fs.closeSync(fd);
  }
  return header[0] === 0x1f && header[1] === 0x8b;
}

function tarList(file, options = {}) {
  const result = run("tar", [options.gzip ? "-tzf" : "-tf", file]);
  expect(result.status === 0, `Unable to inspect tar archive ${path.relative(root, file)}.`);
  return (result.stdout || "").split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/^\.\//, ""));
}

function tarHas(entries, entry) {
  return entries.includes(entry) || entries.includes(`./${entry}`);
}

function parseInfo(text) {
  const info = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([^=\s]+)="(.*)"$/);
    if (match) info[match[1]] = match[2];
  }
  return info;
}

function parseTarOctal(buffer, start, length) {
  const raw = buffer.subarray(start, start + length).toString("ascii").replace(/\0.*$/, "").trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

function parseTarHeaders(file, options = {}) {
  const source = fs.readFileSync(file);
  const buffer = options.gzip ? zlib.gunzipSync(source) : source;
  const entries = new Map();
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const fullName = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, "");
    const size = parseTarOctal(header, 124, 12);
    entries.set(fullName, {
      name: fullName,
      mode: parseTarOctal(header, 100, 8),
      uid: parseTarOctal(header, 108, 8),
      gid: parseTarOctal(header, 116, 8),
      size,
      type: header.subarray(156, 157).toString("ascii") || "0",
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function verifyExecutableTarEntry(entries, name, context) {
  const entry = entries.get(name);
  expect(entry, `${context} tar must contain ${name}.`);
  expect((entry.mode & 0o111) !== 0, `${context} ${name} must be executable in the SPK tar header.`);
}

function verifyRootOwnedTarEntry(entries, name, context) {
  const entry = entries.get(name);
  expect(entry, `${context} tar must contain ${name}.`);
  expect(entry.uid === 0 && entry.gid === 0, `${context} ${name} must be archived as root:root.`);
}

function verifyPrivilegeConfig(config, context) {
  const defaults = config && typeof config.defaults === "object" ? config.defaults : {};
  expect(defaults["run-as"] === "package", `${context} conf/privilege must run as the package user, not root.`);
  expect(!Object.prototype.hasOwnProperty.call(defaults, "run_as"), `${context} conf/privilege must use Synology's run-as key, not run_as.`);
  expect(config.username === "mmh", `${context} conf/privilege must create/use the mmh package user.`);
  expect(config.groupname === "mmh", `${context} conf/privilege must create/use the mmh package group.`);
}

function verifySourceFiles() {
  const packageJson = read(path.join(root, "package.json"));
  const nativeSchema = read(path.join(root, "prisma", "schema.native.prisma"));
  const currencyMigration = read(path.join(root, "prisma", "migrations", "20260903_add_currency_request_tables", "migration.sql"));
  const appBuildScript = read(path.join(root, "scripts", "build-synology-app.cjs"));
  const packageScript = read(path.join(root, "scripts", "build-synology-package.cjs"));
  const releaseWorkflow = read(path.join(root, ".github", "workflows", "synology-release.yml"));
  const sqliteInitIndex = packageScript.indexOf('"$NODE_BIN" "$SERVER_DIR/scripts/init-sqlite.cjs"');
  const pidCheckIndex = packageScript.indexOf('if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")"');

  expect(/build:synology:app/.test(packageJson), "package.json must expose build:synology:app.");
  expect(/build:synology/.test(packageJson), "package.json must expose build:synology.");
  expect(/check:synology/.test(packageJson), "package.json must expose check:synology.");
  expect(/MMH_DEPLOY_TARGET:\s*"synology"/.test(appBuildScript), "Synology app build must mark the deployment target.");
  expect(/MMH_DEPLOY_TARGET=synology/.test(packageScript), "Synology start script must mark runtime deployment as synology.");
  expect(/DATABASE_URL="file:\$DATA_DIR\/mmh\.db"/.test(packageScript), "Synology start script must store SQLite data under the package data directory.");
  expect(/VAR_DIR="\\\$\{SYNOPKG_PKGVAR:-\/var\/packages\/\$PACKAGE\/var\}"/.test(packageScript), "Synology runtime data must use SYNOPKG_PKGVAR, not the package target directory.");
  expect(!/^VAR_DIR="\$APP_DIR\/var"/m.test(packageScript), "Synology runtime data must not be written under SYNOPKG_PKGDEST/target.");
  expect(/package="\$\{appName\}"/.test(packageScript) && /const appName = "mmh"/.test(packageScript), "Synology INFO must keep the stable package id mmh.");
  expect(/const dsmMinVersion = "7\.0-40000"/.test(packageScript), "Synology INFO must keep the DSM compatibility floor at 7.0-40000.");
  expect(/checksumLine/.test(packageScript) && /extractSizeLine/.test(packageScript), "Synology INFO must write checksum and extractsize for DSM package validation.");
  expect(/hashFileMd5/.test(packageScript) && /directorySizeKb/.test(packageScript), "Synology package build must calculate checksum and extractsize.");
  expect(/tarOwnerArgs/.test(packageScript), "Synology package build must archive release tarballs with stable numeric root ownership.");
  expect(/"run-as":\s*"package"/.test(packageScript), "Synology privilege config must use run-as=package.");
  expect(/MMH_SESSION_SECRET/.test(packageScript) && /mmh-session-secret\.txt/.test(packageScript), "Synology start script must persist a strong session secret for signed login cookies.");
  expect(/chmod -R go-rwx/.test(packageScript), "Synology uninstall backups must remove group and other permissions from copied app data.");
  expect(!/run_as:\s*"package"/.test(packageScript), "Synology privilege config must not use the invalid run_as key.");
  expect(/\$\{appName\}-synology-v\$\{version\}-\$\{target\.assetSuffix\}\.spk/.test(packageScript), "Synology SPK asset names must include version and architecture.");
  expect(!/"-czf",\s*spkPath/.test(packageScript), "Synology SPK outer archive must be uncompressed tar; only package.tgz should be gzip-compressed.");
  expect(sqliteInitIndex !== -1 && pidCheckIndex !== -1 && sqliteInitIndex < pidCheckIndex, "Synology start script must run SQLite init before returning for an already-running process.");
  expect(/release-artifacts\/synology\/\*\.spk/.test(releaseWorkflow), "Synology release workflow must upload SPK assets.");
  expect(/target_arch/.test(releaseWorkflow) && /arm64/.test(releaseWorkflow), "Synology release workflow must build x86_64 and arm64 packages.");
  expect(/model ApprovedCurrency \{/.test(nativeSchema) && /model CustomCurrencyRequest \{/.test(nativeSchema) && /enum CustomCurrencyRequestStatus \{/.test(nativeSchema), "Synology native schema must contain the currency request models.");
  expect(/CREATE TABLE IF NOT EXISTS "ApprovedCurrency"/.test(currencyMigration) && /CREATE TABLE IF NOT EXISTS "CustomCurrencyRequest"/.test(currencyMigration), "Synology source must keep the PostgreSQL currency migration alongside the native schema.");
}

function verifyStagedSource() {
  const stageDir = path.join(root, "release-artifacts", "synology", verifyTarget.stageDirName);
  if (!fs.existsSync(stageDir)) return;
  if (!fs.existsSync(path.join(stageDir, "INFO"))) return;
  const info = read(path.join(stageDir, "INFO"));
  const startScript = read(path.join(stageDir, "scripts", "start-stop-status"));
  const privilege = readJson(path.join(stageDir, "conf", "privilege"));
  expect(new RegExp(`version="${verifyVersion}"`).test(info), "Staged INFO must contain the package version.");
  expect(new RegExp(`arch="${verifyTarget.infoArch}"`).test(info), "Staged INFO must contain the target architecture.");
  expect(new RegExp(`os_min_ver="${expectedDsmMinVersion}"`).test(info), "Staged INFO must keep the DSM compatibility floor at 7.0-40000.");
  verifyPrivilegeConfig(privilege, "Staged");
  expect(/MMH_DEPLOY_TARGET=synology/.test(startScript), "Staged start-stop-status must mark runtime deployment as synology.");
  expect(fs.existsSync(path.join(stageDir, "package", "app", "server", "server.js")), "Staged package must contain the Next standalone server.");
  expect(fs.existsSync(path.join(stageDir, "package", "app", "bin", "node")), `Staged package must contain a Linux ${verifyTarget.nodeArch} Node runtime.`);
}

function verifyBuiltSpk() {
  const spkPath = builtSpkPath();
  expect(fs.existsSync(spkPath), `Built Synology ${verifyTarget.id} SPK must exist before upload.`);
  expect(!isGzipFile(spkPath), "Built SPK must be an uncompressed tar archive; only package.tgz should be gzip-compressed.");
  const tarHeaders = parseTarHeaders(spkPath);
  const entries = tarList(spkPath);
  for (const required of [
    "INFO",
    "PACKAGE_ICON.PNG",
    "PACKAGE_ICON_256.PNG",
    "conf/privilege",
    "scripts/start-stop-status",
    "scripts/preupgrade",
    "scripts/postupgrade",
    "package.tgz",
  ]) {
    expect(tarHas(entries, required), `Built SPK must contain ${required}.`);
  }
  for (const executable of [
    "scripts/start-stop-status",
    "scripts/postinst",
    "scripts/preuninst",
    "scripts/preupgrade",
    "scripts/postupgrade",
  ]) {
    verifyExecutableTarEntry(tarHeaders, executable, "Built SPK");
  }
  for (const rootOwned of ["INFO", "conf/privilege", "package.tgz"]) {
    verifyRootOwnedTarEntry(tarHeaders, rootOwned, "Built SPK");
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmh-synology-spk-"));
  try {
    const extract = run("tar", ["-xf", spkPath, "-C", tmpDir, "package.tgz"]);
    expect(extract.status === 0, "Unable to extract package.tgz from built SPK.");
    const metadataExtract = run("tar", ["-xf", spkPath, "-C", tmpDir, "INFO", "conf/privilege"]);
    expect(metadataExtract.status === 0, "Unable to extract INFO and conf/privilege from built SPK.");
    const builtInfo = read(path.join(tmpDir, "INFO"));
    const parsedInfo = parseInfo(builtInfo);
    expect(parsedInfo.version === verifyVersion, "Built INFO must contain the package version.");
    expect(new RegExp(`os_min_ver="${expectedDsmMinVersion}"`).test(builtInfo), "Built INFO must keep the DSM compatibility floor at 7.0-40000.");
    expect(/^[a-f0-9]{32}$/.test(parsedInfo.checksum || ""), "Built INFO must contain a package.tgz MD5 checksum.");
    expect(parsedInfo.checksum === hashFileMd5(path.join(tmpDir, "package.tgz")), "Built INFO checksum must match package.tgz.");
    expect(Number(parsedInfo.extractsize) > 0, "Built INFO must contain a positive extractsize value.");
    verifyPrivilegeConfig(readJson(path.join(tmpDir, "conf", "privilege")), "Built");
    const packageTgzPath = path.join(tmpDir, "package.tgz");
    expect(isGzipFile(packageTgzPath), "Built package.tgz must remain gzip-compressed.");
    const startScript = run("tar", ["-xf", spkPath, "-O", "scripts/start-stop-status"]);
    expect(startScript.status === 0, "Unable to read scripts/start-stop-status from built SPK.");
    expect(/SYNOPKG_PKGVAR/.test(startScript.stdout || ""), "Built start-stop-status must use SYNOPKG_PKGVAR for writable runtime data.");
    expect(!/^VAR_DIR="\$APP_DIR\/var"/m.test(startScript.stdout || ""), "Built start-stop-status must not write runtime data under SYNOPKG_PKGDEST/target.");
    expect(/MMH_SESSION_SECRET/.test(startScript.stdout || "") && /mmh-session-secret\.txt/.test(startScript.stdout || ""), "Built start-stop-status must persist the signed-session secret.");
    const packageEntries = tarList(packageTgzPath, { gzip: true });
    for (const required of [
      "app/bin/node",
      "app/server/server.js",
      "app/server/scripts/init-sqlite.cjs",
      "app/server/prisma/schema.native.prisma",
    ]) {
      expect(tarHas(packageEntries, required), `Built package.tgz must contain ${required}.`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

verifySourceFiles();
verifyStagedSource();
if (process.env.SYNOLOGY_VERIFY_BUILT_SPK === "1") verifyBuiltSpk();
console.log(`Synology package checks passed for ${verifyTarget.id}.`);
