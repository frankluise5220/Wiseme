#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const failures = [];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function readJson(file) {
  return JSON.parse(read(file));
}

function findMmhApp(payload, key) {
  const apps = Array.isArray(key ? payload[key] : payload.data) ? (key ? payload[key] : payload.data) : [];
  return apps.find((app) => app.id === "mmh");
}

function fnosFpkAssetName(version, assetSuffix) {
  return `mmh-fnos-v${version}-${assetSuffix}.fpk`;
}

function fnosDownloadUrls(version) {
  const base = `https://github.com/frankluise5220/MMH/releases/download/v${version}`;
  return {
    x86_64: `${base}/${fnosFpkAssetName(version, "x86_64")}`,
    arm64: `${base}/${fnosFpkAssetName(version, "arm64")}`,
  };
}

function parseVersion(version) {
  const match = /^0\.1\.(\d+)$/.exec(String(version || "").trim());
  if (!match) return null;
  return Number(match[1]);
}

function compareVersions(left, right) {
  const leftPatch = parseVersion(left);
  const rightPatch = parseVersion(right);
  if (leftPatch === null || rightPatch === null) return 0;
  return leftPatch - rightPatch;
}

function getFndepotRelease(payload, version) {
  return payload.apps?.mmh?.releases?.[version];
}

const pkg = readJson("package.json");
const version = String(pkg.version || "").trim();
const releaseNotes = String(pkg.mmhReleaseNotes || "").trim();
const downloadUrls = fnosDownloadUrls(version);

expect(/^0\.1\.\d+$/.test(version), `package.json version must use 0.1.x format, got ${version || "(empty)"}.`);
expect(releaseNotes.length > 0, "package.json must include non-empty mmhReleaseNotes for release/version display.");

const lock = readJson("package-lock.json");
expect(lock.version === version, "package-lock.json top-level version must match package.json.");
expect(lock.packages?.[""]?.version === version, "package-lock.json root package version must match package.json.");

for (const [file, key] of [
  ["deploy/fnos/repository/apps.example.json", "apps"],
  ["deploy/fnos/repository/api/apps", undefined],
]) {
  const app = findMmhApp(readJson(file), key);
  expect(app, `${file} must contain the mmh app entry.`);
  if (!app) continue;
  expect(app.version === version, `${file} version must match package.json.`);
  expect(app.platform === "x86", `${file} platform must keep x86 as the legacy default platform.`);
  expect(Array.isArray(app.platforms), `${file} platforms must list supported fnOS architectures.`);
  expect(app.platforms?.includes("x86"), `${file} platforms must include x86.`);
  expect(app.platforms?.includes("arm"), `${file} platforms must include arm.`);
  expect(app.download_url === downloadUrls.x86_64, `${file} download_url must point to the x86_64 FPK for v${version}.`);
  expect(!("x86" in (app.download_urls || {})), `${file} download_urls must not publish a third x86 alias URL.`);
  expect(app.download_urls?.x86_64 === downloadUrls.x86_64, `${file} download_urls.x86_64 must use the unified v${version} Release tag.`);
  expect(app.download_urls?.arm64 === downloadUrls.arm64, `${file} download_urls.arm64 must use the unified v${version} Release tag.`);
  expect(app.changelog === releaseNotes, `${file} changelog must match package.json mmhReleaseNotes.`);
  expect(app.type === "原生", `${file} type must be 原生 for the FN soft-store native filter.`);
  expect(/^\d{4}-\d{2}-\d{2}$/.test(app.updated_at || ""), `${file} updated_at must use YYYY-MM-DD for the FN soft-store new-apps sort.`);
  expect(Array.isArray(app.screenshots) && app.screenshots.length > 0, `${file} screenshots must list at least one preview image.`);
}

const fndepotFnpack = readJson("deploy/fnos/repository/fnpack.json");
const fndepotApp = fndepotFnpack.apps?.mmh;
expect(fndepotApp, "deploy/fnos/repository/fnpack.json must contain the mmh app entry under apps for FnDepot.");
if (fndepotApp) {
  expect(
    typeof fndepotApp.desc === "string" && fndepotApp.desc.length >= 300 && /MoneyMoneyHome/.test(fndepotApp.desc),
    "deploy/fnos/repository/fnpack.json must keep the full app-center description.",
  );
  const releaseVersions = Object.keys(fndepotApp.releases || {})
    .filter((releaseVersion) => parseVersion(releaseVersion) !== null)
    .sort(compareVersions);
  expect(releaseVersions.length <= 5, "deploy/fnos/repository/fnpack.json must keep at most the latest 5 release versions.");
  expect(releaseVersions.every((releaseVersion, index, list) => index === 0 || compareVersions(list[index - 1], releaseVersion) < 0), "deploy/fnos/repository/fnpack.json release versions must stay in ascending version order.");
  const fndepotRelease = fndepotApp.releases?.[version];
  expect(fndepotRelease, `deploy/fnos/repository/fnpack.json must contain a release entry for v${version}.`);
  if (fndepotRelease) {
    expect(fndepotRelease.changelog === releaseNotes, "deploy/fnos/repository/fnpack.json releases changelog must match package.json mmhReleaseNotes.");
    expect(fndepotRelease.packages?.x86?.download_url === downloadUrls.x86_64, "deploy/fnos/repository/fnpack.json releases x86 download_url must point to the x86_64 FPK for v${version}.");
    expect(fndepotRelease.packages?.arm?.download_url === downloadUrls.arm64, "deploy/fnos/repository/fnpack.json releases arm download_url must point to the arm64 FPK for v${version}.");
  }
}

const legacyAppstore = readJson("fn-appstores.json");
const legacyApp = Array.isArray(legacyAppstore) ? legacyAppstore.find((app) => app.id === "mmh")?._manual : null;
expect(legacyApp, "fn-appstores.json must contain the mmh _manual app entry.");
if (legacyApp) {
  expect(legacyApp.version === version, "fn-appstores.json _manual version must match package.json.");
  expect(legacyApp.platform === "x86", "fn-appstores.json _manual platform must keep x86 as the default platform.");
  expect(Array.isArray(legacyApp.platforms), "fn-appstores.json _manual platforms must list supported fnOS architectures.");
  expect(legacyApp.platforms?.includes("x86"), "fn-appstores.json _manual platforms must include x86.");
  expect(legacyApp.platforms?.includes("arm"), "fn-appstores.json _manual platforms must include arm.");
  expect(legacyApp.download_url === downloadUrls.x86_64, "fn-appstores.json _manual download_url must point to the x86_64 FPK.");
  expect(!("x86" in (legacyApp.download_urls || {})), "fn-appstores.json _manual download_urls must not publish a third x86 alias URL.");
  expect(legacyApp.download_urls?.x86_64 === downloadUrls.x86_64, "fn-appstores.json _manual download_urls.x86_64 must use the unified Release tag.");
  expect(legacyApp.download_urls?.arm64 === downloadUrls.arm64, "fn-appstores.json _manual download_urls.arm64 must use the unified Release tag.");
  expect(legacyApp.changelog === releaseNotes, "fn-appstores.json _manual changelog must match package.json mmhReleaseNotes.");
}

const selfhostedSource = readJson("deploy/fnos/selfhosted-source/data/fn-appstores.json");
const selfhostedApp = Array.isArray(selfhostedSource) ? selfhostedSource.find((app) => app.id === "mmh") : null;
expect(selfhostedApp, "deploy/fnos/selfhosted-source/data/fn-appstores.json must contain the mmh app entry.");
if (selfhostedApp) {
  expect(selfhostedApp.version === version, "deploy/fnos/selfhosted-source/data/fn-appstores.json version must match package.json.");
  expect(selfhostedApp.desc === fndepotApp?.desc, "deploy/fnos/selfhosted-source/data/fn-appstores.json desc must match the FnDepot app description.");
}

const dockerWorkflow = read(".github/workflows/docker-build.yml");
expect(/ghcr\.io\/\$\{\{\s*github\.repository_owner\s*\}\}\/mmh:\$\{\{\s*steps\.package\.outputs\.version\s*\}\}/.test(dockerWorkflow), "Docker workflow must publish the app image with the package version tag.");
expect(/ghcr\.io\/\$\{\{\s*github\.repository_owner\s*\}\}\/mmh-updater:\$\{\{\s*steps\.package\.outputs\.version\s*\}\}/.test(dockerWorkflow), "Docker workflow must publish the updater image with the package version tag.");

for (const file of [".github/workflows/fnos-release.yml", ".github/workflows/fnos-stage.yml"]) {
  const workflow = read(file);
  expect(!/0\.1\.0-fnos/.test(workflow), `${file} must not default to the old 0.1.0-fnos version.`);
  expect(/default:\s*""/.test(workflow), `${file} manual package_version should default to blank so package.json owns the version.`);
}

for (const file of [".github/workflows/synology-release.yml", ".github/workflows/synology-stage.yml"]) {
  const workflow = read(file);
  expect(!/0\.1\.0-synology/.test(workflow), `${file} must not default to an old Synology package version.`);
  expect(/default:\s*""/.test(workflow), `${file} manual package_version should default to blank so package.json owns the version.`);
}

const synologyReleaseWorkflow = read(".github/workflows/synology-release.yml");
expect(/release-artifacts\/synology\/\*\.spk/.test(synologyReleaseWorkflow), "Synology release workflow must upload SPK assets.");
expect(/target_arch/.test(synologyReleaseWorkflow) && /arm64/.test(synologyReleaseWorkflow), "Synology release workflow must build both x86_64 and arm64 packages.");

expect(/org\.opencontainers\.image\.version=\$\{APP_VERSION\}/.test(read("Dockerfile")), "Dockerfile must label images with APP_VERSION.");
expect(/org\.opencontainers\.image\.version=\$\{APP_VERSION\}/.test(read("Dockerfile.updater")), "Dockerfile.updater must label images with APP_VERSION.");

if (failures.length > 0) {
  console.error("Release version check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Release version check passed for ${version}.`);
