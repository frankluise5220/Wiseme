export type ApiKeyPolicyDecision = {
  ok: boolean;
  code?: string;
  error?: string;
};

const SENSITIVE_API_PREFIXES = [
  "/api/v1/ai",
  "/api/v1/auth",
  "/api/v1/cleanup",
  "/api/v1/db",
  "/api/v1/debug",
  "/api/v1/email",
  "/api/v1/households",
  "/api/v1/init",
  "/api/v1/onboarding",
  "/api/v1/settings",
  "/api/v1/test",
  "/api/v1/test-prompt",
  "/api/test-route",
];

const SENSITIVE_API_EXACT_PATHS = new Set([
  "/api/v1/entries/purge",
  "/api/v1/mobile/sync",
]);

function normalizePath(pathname: string) {
  return pathname.replace(/\/+$/, "") || "/";
}

function pathMatchesPrefix(pathname: string, prefix: string) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Access Keys are for external business-data clients, not administrator or
 * maintenance APIs. Browser sessions still use route-level authorization.
 */
export function getApiKeyPolicyDecision(pathname: string, method = "GET"): ApiKeyPolicyDecision {
  const path = normalizePath(pathname);
  if (method.toUpperCase() === "OPTIONS") return { ok: true };
  if (SENSITIVE_API_EXACT_PATHS.has(path)) {
    return {
      ok: false,
      code: "API_KEY_SCOPE_DENIED",
      error: "API keys cannot access this endpoint.",
    };
  }
  if (SENSITIVE_API_PREFIXES.some((prefix) => pathMatchesPrefix(path, prefix))) {
    return {
      ok: false,
      code: "API_KEY_SCOPE_DENIED",
      error: "API keys cannot access administrator or maintenance endpoints.",
    };
  }
  return { ok: true };
}
