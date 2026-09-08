// MMH Windows desktop shell (Electron main process).
//
// Responsibilities:
//   1. Spawn the bundled Next.js standalone server with the bundled portable
//      Node.js runtime (resources/node/node.exe).
//   2. Initialize the local SQLite database under %APPDATA%\MMH before the
//      server starts (resources/app/scripts/init-sqlite.cjs).
//   3. Wait for the server to become ready, then open the main window at
//      http://127.0.0.1:<port>.
//   4. Keep the server lifecycle tied to the app: quitting the app stops the
//      server; a crashed server shows an error and exits the app.
//
// The Next.js application code is untouched; this shell only hosts it.

const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const { autoUpdater } = require("electron-updater");

const isPackaged = app.isPackaged;

// Resolve the data directory: <installDir>\data when writable (packaged),
// projectRoot\data in dev, falling back to %APPDATA%\MMH otherwise.
function resolveDataDir() {
  const candidates = [];
  if (isPackaged) {
    const installDir = path.dirname(process.resourcesPath);
    candidates.push(path.join(installDir, "data"));
  } else {
    candidates.push(path.join(projectRoot, "data"));
  }
  candidates.push(path.join(app.getPath("appData"), "MMH"));
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, ".write-test");
      fs.writeFileSync(probe, "ok");
      fs.rmSync(probe, { force: true });
      return dir;
    } catch {
      // try the next candidate
    }
  }
  return candidates[candidates.length - 1];
}

const resourcesDir = process.resourcesPath;
const projectRoot = path.join(__dirname, "..");

// Where the standalone server + portable node live.
const appDir = isPackaged
  ? path.join(resourcesDir, "app")
  : path.join(projectRoot, ".next", "standalone");
const nodeExe = isPackaged
  ? path.join(resourcesDir, "node", "node.exe")
  : path.join(
      projectRoot,
      "release-artifacts",
      "win",
      "node22",
      "node-v22.23.2-win-x64",
      "node.exe",
    );
const iconPath = isPackaged
  ? path.join(resourcesDir, "icon.png")
  : path.join(projectRoot, "public", "branding", "mmh-logo-pwa-512.png");

const userDataDir = resolveDataDir();
app.setPath("userData", userDataDir);
const dbFile = path.join(userDataDir, "mmh.db");
const logFile = path.join(userDataDir, "logs", "main.log");

// Desktop-only config (LAN access etc.). Stored next to the database so it
// travels with the user's data and survives reinstalls.
const desktopConfigPath = path.join(userDataDir, "desktop-config.json");
function readDesktopConfig() {
  try {
    const raw = fs.readFileSync(desktopConfigPath, "utf8");
    const parsed = JSON.parse(raw);
    return { allowLan: Boolean(parsed.allowLan) };
  } catch {
    return { allowLan: false };
  }
}
const desktopConfig = readDesktopConfig();
const bindHost = desktopConfig.allowLan ? "0.0.0.0" : "127.0.0.1";
// Desktop app uses its own port (17777) so it never collides with the dev
// server (7777) running on the same machine.
const port = Number(process.env.MMH_PORT || 17777);

let serverProc = null;
let mainWindow = null;
let quitting = false;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line + "\n", "utf8");
  } catch {
    // Logging must never break startup.
  }
  console.log(line);
}

function dbUrl() {
  return "file:" + dbFile.replace(/\\/g, "/");
}

// One-time migration from the legacy %APPDATA%\MMH location when the data
// directory changed (e.g. moving to <installDir>\data).
function migrateLegacyData() {
  const legacyDir = path.join(app.getPath("appData"), "MMH");
  if (legacyDir === userDataDir) return;
  const legacyDb = path.join(legacyDir, "mmh.db");
  if (!fs.existsSync(dbFile) && fs.existsSync(legacyDb)) {
    try {
      fs.copyFileSync(legacyDb, dbFile);
      const legacySecret = path.join(legacyDir, "mmh-session-secret");
      const newSecret = path.join(userDataDir, "mmh-session-secret");
      if (fs.existsSync(legacySecret) && !fs.existsSync(newSecret)) {
        fs.copyFileSync(legacySecret, newSecret);
      }
      log("Migrated database from " + legacyDb + " to " + dbFile);
    } catch (error) {
      log("Database migration failed: " + error.message);
    }
  }
}

function isPortInUse() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

// The standalone server requires MMH_SESSION_SECRET in production. Persist a
// random secret next to the database so sessions survive app restarts.
function ensureSessionSecret() {
  const secretFile = path.join(userDataDir, "mmh-session-secret");
  try {
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, "utf8").trim();
      if (existing.length >= 32) return existing;
    }
    const secret = crypto.randomBytes(32).toString("base64");
    fs.writeFileSync(secretFile, secret, { encoding: "utf8", mode: 0o600 });
    return secret;
  } catch (error) {
    log("Failed to persist session secret, generating in-memory: " + error.message);
    return crypto.randomBytes(32).toString("base64");
  }
}

// Single instance: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function runInitSqlite() {
  return new Promise((resolve, reject) => {
    const initScript = path.join(appDir, "scripts", "init-sqlite.cjs");
    if (!fs.existsSync(initScript)) {
      log("init-sqlite.cjs not found, skipping database init");
      resolve();
      return;
    }
    log("Initializing SQLite database at " + dbFile);
    const child = spawn(nodeExe, [initScript], {
      cwd: appDir,
      env: {
        ...process.env,
        DATABASE_URL: dbUrl(),
        MMH_DATA_DIR: userDataDir,
      },
      windowsHide: true,
    });
    let stderr = "";
    child.stdout.on("data", (d) => log("[init] " + String(d).trim()));
    child.stderr.on("data", (d) => {
      stderr += String(d);
      log("[init] " + String(d).trim());
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error("SQLite init failed with code " + code + ": " + stderr.trim()));
      }
    });
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(nodeExe)) {
      reject(new Error("Bundled Node runtime missing: " + nodeExe));
      return;
    }
    if (!fs.existsSync(path.join(appDir, "server.js"))) {
      reject(new Error("Standalone server missing: " + path.join(appDir, "server.js")));
      return;
    }
    const env = {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: bindHost,
      DATABASE_URL: dbUrl(),
      MMH_DEPLOY_TARGET: "windows",
      MMH_DATA_DIR: userDataDir,
      MMH_SESSION_SECRET: ensureSessionSecret(),
    };
    log("Starting server on " + bindHost + ":" + port + " (allowLan=" + desktopConfig.allowLan + ")");
    serverProc = spawn(nodeExe, ["server.js"], {
      cwd: appDir,
      env,
      windowsHide: true,
    });
    serverProc.stdout.on("data", (d) => log("[server] " + String(d).trim()));
    serverProc.stderr.on("data", (d) => log("[server] " + String(d).trim()));
    serverProc.on("error", reject);
    serverProc.on("exit", (code, signal) => {
      log("Server exited code=" + code + " signal=" + signal);
      if (!quitting) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          dialog.showErrorBox(
            "MMH 服务已停止",
            "本地服务异常退出（code=" + code + "），应用将关闭。请重新打开 MMH 重试。",
          );
        }
        app.quit();
      }
    });
    waitForReady(resolve, reject, 45000);
  });
}

function waitForReady(resolve, reject, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const ping = () => {
    if (Date.now() > deadline) {
      reject(new Error("Server did not become ready within " + timeoutMs + "ms"));
      return;
    }
    const req = http.get(
      { host: "127.0.0.1", port, path: "/", timeout: 1500 },
      (res) => {
        res.resume();
        log("Server ready (HTTP " + res.statusCode + ")");
        resolve();
      },
    );
    req.on("error", () => setTimeout(ping, 400));
    req.on("timeout", () => {
      req.destroy();
    });
  };
  ping();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    autoHideMenuBar: true,
    title: "MMH",
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL("http://127.0.0.1:" + port);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Check for updates in the background and prompt the user when a new version
// is available. Downloads and installs via the NSIS helper installer.
function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (info) => {
    log("Update available: " + info.version);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: "发现新版本",
        message: "MMH " + info.version + " 已发布，是否现在下载？",
        detail: "下载完成后重启应用即可完成更新，记账数据不受影响。",
        buttons: ["下载", "稍后"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.downloadUpdate();
      });
  });
  autoUpdater.on("update-downloaded", (info) => {
    log("Update downloaded: " + info.version);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: "更新已就绪",
        message: "MMH " + info.version + " 已下载完成，重启应用完成更新。",
        buttons: ["立即重启", "稍后"],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });
  autoUpdater.on("error", (err) => {
    log("Auto-update error: " + (err && err.message ? err.message : String(err)));
  });
  // Delay the check so startup is never blocked by a slow update server.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      log("Auto-update check failed: " + (err && err.message ? err.message : String(err)));
    });
  }, 5000);
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    migrateLegacyData();
    if (await isPortInUse()) {
      throw new Error("Port " + port + " is already in use by another process. Close other MMH instances and retry.");
    }
    await runInitSqlite();
    await startServer();
    createWindow();
    if (isPackaged) setupAutoUpdater();
  } catch (error) {
    log("Startup failed: " + (error && error.stack ? error.stack : String(error)));
    dialog.showErrorBox("MMH 启动失败", String((error && error.message) || error));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  if (serverProc && serverProc.pid) {
    try {
      if (process.platform === "win32") {
        // Kill the whole process tree so the standalone server cannot linger
        // as an orphan holding the port after the app exits.
        const { spawnSync } = require("child_process");
        spawnSync("taskkill", ["/pid", String(serverProc.pid), "/T", "/F"], {
          windowsHide: true,
        });
      } else {
        serverProc.kill();
      }
    } catch {
      // ignore
    }
  }
});
