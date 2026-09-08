export type ImportDebugDetails = Record<string, string | number | boolean | null | undefined>;

export function createImportTraceId(prefix = "import") {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeImportDebugDetails(details: ImportDebugDetails) {
  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!key || value === undefined) continue;
    sanitized[key.slice(0, 80)] = typeof value === "string" ? value.slice(0, 160) : value;
  }
  return sanitized;
}

export function postImportDebugLog(traceId: string, event: string, details: ImportDebugDetails = {}) {
  if (process.env.NODE_ENV !== "development") return;
  void fetch("/api/v1/debug/import-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ traceId, event, details: sanitizeImportDebugDetails(details) }),
    keepalive: true,
  }).catch((error) => {
    console.warn("[import-debug] 调试日志上报失败", error);
  });
}
