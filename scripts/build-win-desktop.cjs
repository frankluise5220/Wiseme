#!/usr/bin/env node
// MMH Windows desktop build: assemble the portable Node runtime + Next.js
// standalone app and package it into an NSIS installer with electron-builder.
//
// Usage: node scripts/build-win-desktop.cjs [--skip-build] [--skip-package]
//
// Flow (mirrors scripts/build-fnos-app.cjs + scripts/build-fnos-package.cjs):
//   1. generate-native-sqlite-schema.cjs  -> prisma/schema.native.prisma
//   2. prisma generate --schema native    -> SQLite client (win32 engine)
//   3. next build                         -> .next/standalone
//   4. prisma generate (default pg schema) -> restore dev client
//   5. stage standalone + static + public + prisma into release-artifacts/win/stage/app
//   6. generate prisma/native-init.sql + scripts/init-sqlite.cjs in the stage
//   7. copy portable Node into release-artifacts/win/stage/node
//   8. rebuild better-sqlite3 with the bundled Node 20 (ABI must match)
//   9. verify better-sqlite3 loads under the bundled Node
//  10. electron-builder --win nsis -> release-artifacts/win/dist/MMH-Setup-*.exe

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const artifacts = path.join(root, "release-artifacts", "win");
const stageDir = path.join(artifacts, "stage");
const stageAppDir = path.join(stageDir, "app");
const stageNodeDir = path.join(stageDir, "node");
const buildDir = path.join(artifacts, "build");
const distDir = path.join(artifacts, "dist");
const portableNodeRoot = path.join(artifacts, "node22", "node-v22.23.2-win-x64");
// Update feed URL must match the `publish.url` in electron-builder.yml.
const UPDATE_FEED_URL = "http://fnapp.floatingice.win:5660/mmh/";

const nativeSchema = path.join(root, "prisma", "schema.native.prisma");
const pgSchema = path.join(root, "prisma", "schema.prisma");
const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const skipPackage = args.includes("--skip-package");

function run(command, args, env, cwd) {
  const useShell = process.platform === "win32" && (command === "npm" || command === "npx");
  const result = spawnSync(command, args, {
    cwd: cwd || root,
    stdio: "inherit",
    shell: useShell,
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status || 1);
  }
}

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

// Remove non-runtime junk that leaks from the repo into .next/standalone
// (dev agent logs, dev shared settings, runtime data dir, env files, build
// cache). The desktop app keeps user data under %APPDATA%\MMH instead.
function pruneStagedApp(dir) {  for (const name of [".codex-logs", "data", "shared", ".env", ".env.local", ".env.production", ".env.development"]) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  fs.rmSync(path.join(dir, ".next", "cache"), { recursive: true, force: true });
}

function step(message) {
  console.log("\n=== [win-desktop] " + message + " ===");
}

// ---------------------------------------------------------------- build app
if (!skipBuild) {
  step("1/4 generate native SQLite schema");
  run(process.execPath, [path.join(root, "scripts", "generate-native-sqlite-schema.cjs")], {});

  step("2/4 prisma generate (native sqlite)");
  run(process.execPath, [prismaCli, "generate", "--schema", nativeSchema], {
    DATABASE_URL: "file:./native-build.db",
    PRISMA_SCHEMA_PATH: nativeSchema,
  });

  step("3/4 next build (standalone)");
  run("npm", ["run", "build"], {
    DATABASE_URL: "file:./native-build.db",
    PRISMA_SCHEMA_PATH: nativeSchema,
    MMH_DEPLOY_TARGET: "windows",
  });

  step("4/4 prisma generate (restore pg schema)");
  run(process.execPath, [prismaCli, "generate", "--schema", pgSchema], {});
} else {
  console.log("Skipping build steps (--skip-build).");
}

// ---------------------------------------------------------------- stage app
step("stage standalone app");
const standaloneDir = path.join(root, ".next", "standalone");
if (!fs.existsSync(path.join(standaloneDir, "server.js"))) {
  console.error("Missing standalone build output. Run without --skip-build first.");
  process.exit(1);
}
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageAppDir, { recursive: true });
copyDir(standaloneDir, stageAppDir);

pruneStagedApp(stageAppDir);

step("sync .next/static and public");
copyDir(path.join(root, ".next", "static"), path.join(stageAppDir, ".next", "static"));
if (fs.existsSync(path.join(root, "public"))) {
  copyDir(path.join(root, "public"), path.join(stageAppDir, "public"));
}

step("copy prisma schema + config");
fs.mkdirSync(path.join(stageAppDir, "prisma"), { recursive: true });
fs.cpSync(path.join(root, "prisma", "schema.native.prisma"), path.join(stageAppDir, "prisma", "schema.native.prisma"));
fs.cpSync(path.join(root, "prisma", "schema.prisma"), path.join(stageAppDir, "prisma", "schema.prisma"));
if (fs.existsSync(path.join(root, "prisma.config.ts"))) {
  fs.cpSync(path.join(root, "prisma.config.ts"), path.join(stageAppDir, "prisma.config.ts"));
}

step("generate native-init.sql (full SQLite structure)");
const initSql = path.join(stageAppDir, "prisma", "native-init.sql");
const diff = spawnSync(
  process.execPath,
  [prismaCli, "migrate", "diff", "--from-empty", "--to-schema", nativeSchema, "--script", "--output", initSql],
  { cwd: root, stdio: "inherit" },
);
if (diff.status !== 0) process.exit(diff.status || 1);

step("generate scripts/init-sqlite.cjs");
fs.mkdirSync(path.join(stageAppDir, "scripts"), { recursive: true });
fs.writeFileSync(
  path.join(stageAppDir, "scripts", "init-sqlite.cjs"),
  `// Generated by scripts/build-win-desktop.cjs. Do not edit by hand.
// Creates the SQLite database at MMH_DATA_DIR/mmh.db on first run and applies
// the full structure from prisma/native-init.sql. For existing databases only
// missing tables are created; column/index backfills and data migrations must
// stay in sync with the MIGRATIONS list in scripts/build-fnos-package.cjs.
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const dataDir = process.env.MMH_DATA_DIR || ".";
const dbPath = path.join(dataDir, "mmh.db");
const sqlPath = path.join(__dirname, "..", "prisma", "native-init.sql");

fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(dbPath);
db.pragma("busy_timeout = 10000");
try {
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  if (!existing) {
    db.exec(fs.readFileSync(sqlPath, "utf8"));
    db.exec(
      "CREATE TABLE IF NOT EXISTS _mmh_native_schema (version TEXT NOT NULL PRIMARY KEY, appliedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    console.log("MMH SQLite database initialized at " + dbPath);
  } else {
    // Create missing tables only; backfills/migrations belong to fnOS MIGRATIONS.
    const sql = fs.readFileSync(sqlPath, "utf8");
    const re = /CREATE TABLE (?:IF NOT EXISTS )?\\"?([A-Za-z0-9_]+)\\"?/g;
    let m;
    while ((m = re.exec(sql)) !== null) {
      const table = m[1];
      const exists = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(table);
      if (!exists) {
        const start = m.index;
        const end = sql.indexOf(";", start);
        if (end > start) {
          db.exec(sql.slice(start, end + 1));
          console.log("MMH SQLite table added: " + table);
        }
      }
    }
    console.log("MMH SQLite database already initialized at " + dbPath);
  }
} finally {
  db.close();
}
`,
  "utf8",
);

// ---------------------------------------------------------------- stage node
step("copy portable Node runtime");
copyDir(portableNodeRoot, stageNodeDir);

// ------------------------------------------------- better-sqlite3 ABI rebuild
step("rebuild better-sqlite3 with bundled Node " + require("node:child_process").execFileSync(path.join(stageNodeDir, "node.exe"), ["--version"]).toString().trim());
const portableNode = path.join(stageNodeDir, "node.exe");
const portableNpmCli = path.join(stageNodeDir, "node_modules", "npm", "bin", "npm-cli.js");
const rebuild = spawnSync(portableNode, [portableNpmCli, "rebuild", "better-sqlite3"], {
  cwd: stageAppDir,
  stdio: "inherit",
  env: {
    ...process.env,
    Path: `${stageNodeDir}${path.delimiter}${process.env.Path || process.env.PATH || ""}`,
    PATH: `${stageNodeDir}${path.delimiter}${process.env.Path || process.env.PATH || ""}`,
    npm_config_ignore_scripts: "false",
  },
  shell: false,
});
if (rebuild.status !== 0) {
  console.error("better-sqlite3 rebuild failed. Try setting npm_config_better_sqlite3_binary_host or installing VS Build Tools.");
  process.exit(rebuild.status || 1);
}

// ------------------------------------------------- verify native module load
step("verify better-sqlite3 loads under bundled Node");
const checkScript = path.join(artifacts, "_tmp_check_better_sqlite3.cjs");
fs.writeFileSync(
  checkScript,
  `const path = require("node:path");
const stageAppDir = ${JSON.stringify(stageAppDir)};
const Database = require(path.join(stageAppDir, "node_modules", "better-sqlite3"));
const db = new Database(":memory:");
if (db.prepare("select 1 as ok").get().ok !== 1) process.exit(1);
db.close();
console.log("better-sqlite3 OK under Node " + process.version);
`,
  "utf8",
);
const check = spawnSync(portableNode, [checkScript], {
  cwd: stageAppDir,
  stdio: "inherit",
});
if (check.status !== 0) {
  console.error("better-sqlite3 could not be loaded by the bundled Node. ABI mismatch.");
  process.exit(check.status || 1);
}
fs.rmSync(checkScript, { force: true });

// ---------------------------------------------------------------- packaging
if (skipPackage) {
  console.log("\nStage ready at " + stageDir + ". Run without --skip-package to build the installer.");
  process.exit(0);
}

step("prepare installer icon");
fs.mkdirSync(buildDir, { recursive: true });
fs.cpSync(path.join(root, "public", "branding", "mmh-logo-pwa-512.png"), path.join(buildDir, "icon.png"));

// electron-builder strips node_modules from extraResources during pack
// (dependency dedup). The standalone server needs its own node_modules at
// runtime, so we pack --dir first, restore node_modules into the unpacked
// app, then build the NSIS installer from the prepackaged directory.
step("electron-builder pack (dir, x64)");
run("npx", ["electron-builder", "--win", "--dir", "--x64"], {
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
  ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/",
});

const unpackedDir = path.join(distDir, "win-unpacked");
const unpackedAppDir = path.join(unpackedDir, "resources", "app");
step("restore node_modules into unpacked app");
copyDir(path.join(stageAppDir, "node_modules"), path.join(unpackedAppDir, "node_modules"));

// electron-builder only writes app-update.yml during publish, but the desktop
// app needs it at runtime. Keep it in sync with electron-builder.yml publish.
step("write app-update.yml (update feed)");
fs.writeFileSync(
  path.join(unpackedDir, "resources", "app-update.yml"),
  "provider: generic\nurl: " + UPDATE_FEED_URL + "\n",
  "utf8",
);

step("electron-builder nsis (prepackaged)");
run("npx", ["electron-builder", "--win", "nsis", "--x64", "--prepackaged", unpackedDir], {
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
  ELECTRON_BUILDER_BINARIES_MIRROR: "https://npmmirror.com/mirrors/electron-builder-binaries/",
});

const exeFiles = fs.existsSync(distDir)
  ? fs.readdirSync(distDir).filter((f) => f.toLowerCase().endsWith(".exe"))
  : [];
if (exeFiles.length === 0) {
  console.error("No installer produced under " + distDir);
  process.exit(1);
}
for (const f of exeFiles) {
  const full = path.join(distDir, f);
  const sizeMb = (fs.statSync(full).size / 1024 / 1024).toFixed(1);
  console.log("\nInstaller ready: " + full + " (" + sizeMb + " MB)");
}
