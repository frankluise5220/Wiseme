/**
 * Client-side log collection for user feedback.
 *
 * Keeps a small in-memory ring buffer of recent client-side errors/warnings
 * (console.error/console.warn, uncaught exceptions, unhandled promise
 * rejections) so the feedback form can attach them for troubleshooting.
 * Nothing is persisted and nothing leaves the browser until the user
 * submits the feedback form.
 */

type ClientLogLevel = "error" | "warn";

interface ClientLogEntry {
  time: string;
  level: ClientLogLevel;
  text: string;
}

const MAX_ENTRIES = 60;
const MAX_ENTRY_TEXT_LENGTH = 300;
const MAX_PAYLOAD_LENGTH = 4000;

let entries: ClientLogEntry[] = [];
let installed = false;

function truncateText(value: string): string {
  const text = value.trim();
  if (text.length <= MAX_ENTRY_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_ENTRY_TEXT_LENGTH)}…`;
}

function describeErrorArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack ? truncateText(arg.stack) : truncateText(arg.message);
  }
  if (typeof arg === "string") return truncateText(arg);
  try {
    return truncateText(JSON.stringify(arg));
  } catch {
    return truncateText(String(arg));
  }
}

function pushEntry(level: ClientLogLevel, text: string) {
  entries.push({ time: formatLocalTime(), level, text });
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(entries.length - MAX_ENTRIES);
  }
}

function formatLocalTime(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** Idempotently installs global capture handlers. Safe to call on every mount. */
export function installClientLogCollector(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const originalConsoleError = console.error.bind(console);
  const originalConsoleWarn = console.warn.bind(console);
  let capturing = false;

  const capture = (level: ClientLogLevel, original: (...args: unknown[]) => void) => {
    return (...args: unknown[]) => {
      if (!capturing) {
        capturing = true;
        try {
          pushEntry(level, args.map(describeErrorArg).join(" "));
        } catch {
          // Never let the collector break the app.
        } finally {
          capturing = false;
        }
      }
      original(...args);
    };
  };

  console.error = capture("error", originalConsoleError as (...args: unknown[]) => void);
  console.warn = capture("warn", originalConsoleWarn as (...args: unknown[]) => void);

  window.addEventListener("error", (event) => {
    pushEntry("error", `${event.message} (${event.filename}:${event.lineno})`);
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    pushEntry("error", `Unhandled rejection: ${describeErrorArg(reason)}`);
  });
}

function buildEnvironmentLines(): string[] {
  const lines: string[] = [];
  try {
    lines.push(`URL: ${window.location.href}`);
    lines.push(`UA: ${navigator.userAgent}`);
    lines.push(`Language: ${navigator.language}`);
    lines.push(`Viewport: ${window.innerWidth}x${window.innerHeight}`);
    try {
      lines.push(`Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    } catch {
      // Timezone is optional.
    }
  } catch {
    // Environment info is best-effort only.
  }
  return lines;
}

/**
 * Builds the log payload attached to feedback submissions:
 * an environment header plus the most recent log entries (tail-first cap).
 */
export function buildFeedbackLogsPayload(): string {
  const lines: string[] = ["---- Environment ----", ...buildEnvironmentLines()];
  const recent = entries.slice(-20);
  if (recent.length > 0) {
    lines.push(`---- Recent logs (${recent.length}) ----`);
    for (const entry of recent) {
      lines.push(`[${entry.time}] [${entry.level.toUpperCase()}] ${entry.text}`);
    }
  } else {
    lines.push("---- Recent logs: none ----");
  }
  const payload = lines.join("\n");
  if (payload.length <= MAX_PAYLOAD_LENGTH) return payload;
  return payload.slice(payload.length - MAX_PAYLOAD_LENGTH);
}
