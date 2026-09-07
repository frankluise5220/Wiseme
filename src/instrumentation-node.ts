import { runDueSystemTasks } from "@/lib/server/system-tasks";
import { runAutoBackupTick } from "@/lib/server/auto-backup";

/**
 * System-level scheduled task runner.
 *
 * Runs at server start and then on an interval (MMH_SYSTEM_TASK_INTERVAL_MS,
 * default 10 minutes). The interval is unref()'d so it never keeps the server
 * process alive on shutdown, and a module-level flag prevents overlapping runs.
 * Set MMH_SYSTEM_TASKS_DISABLED=1 to turn this off (e.g. during maintenance).
 */
const SYSTEM_TASK_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.MMH_SYSTEM_TASK_INTERVAL_MS ?? 10 * 60 * 1000) || 10 * 60 * 1000,
);

let systemTaskRunning = false;
let systemTaskInterval: ReturnType<typeof setInterval> | null = null;

async function runSystemTaskTick() {
  if (systemTaskRunning) return;
  systemTaskRunning = true;
  try {
    await runDueSystemTasks();
  } catch (error) {
    console.error("[system-task] tick failed:", error);
  } finally {
    systemTaskRunning = false;
  }
}

// Automatic backup runs on the same tick but independently: a failure there
// must never prevent due installments (or vice versa) from being processed.
let autoBackupRunning = false;

async function runAutoBackupTickGuarded() {
  if (autoBackupRunning) return;
  autoBackupRunning = true;
  try {
    await runAutoBackupTick();
  } catch (error) {
    console.error("[auto-backup] tick failed:", error);
  } finally {
    autoBackupRunning = false;
  }
}

export function registerNodeRuntime() {
  if (systemTaskInterval) return;
  if (String(process.env.MMH_SYSTEM_TASKS_DISABLED ?? "") === "1") return;

  const firstRun = setTimeout(() => {
    void runSystemTaskTick();
    void runAutoBackupTickGuarded();
  }, 30_000);
  firstRun.unref?.();

  systemTaskInterval = setInterval(() => {
    void runSystemTaskTick();
    void runAutoBackupTickGuarded();
  }, SYSTEM_TASK_INTERVAL_MS);
  systemTaskInterval.unref?.();
}

registerNodeRuntime();
