import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getApiKeyPolicyDecision } from "@/lib/api-key-policy";
import { verifyAccessKey } from "@/lib/server/access-key-auth";
import {
  extractAccessHostnames,
  isAccessHostnameAllowed,
  normalizeAccessHostname,
  parseAllowedAccessList,
} from "@/lib/access-whitelist";
import {
  HOUSEHOLD_COOKIE,
  USER_ID_COOKIE,
  USERNAME_COOKIE,
  VERIFIED_COOKIE,
  verifyVerifiedSessionValue,
} from "@/lib/server/session-cookies";

const CACHE_TTL = 5_000;
const LOOKUP_TIMEOUT_MS = 1_200;

const PUBLIC_PATHS = [
  "/login",
  "/api/v1/auth",
  "/api/v1/settings/catalog",
  "/api/v1/settings/system",
  "/_next",
  "/favicon",
  "/manifest",
  "/sw.js",
  "/branding",
];

const READ_ONLY_PREVIEW_PATHS = [
  "/api/v1/statement/parse",
  "/api/v1/fund/import",
  "/api/v1/stocks/import",
];

function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

let allowedOriginsCache: string[] | null = null;
let allowedOriginsCacheTime = 0;
let originCheckEnabledCache: boolean | null = null;
let originCheckEnabledCacheTime = 0;

type SettingState<T> = { ok: true; value: T } | { ok: false };

async function lookupSystemSetting(key: string): Promise<{ ok: true; value: string | null } | { ok: false }> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ ok: false }), LOOKUP_TIMEOUT_MS);
  });

  try {
    return await Promise.race([
      prisma.systemSetting
        .findUnique({ where: { key }, select: { value: true } })
        .then((row) => ({ ok: true as const, value: row?.value ?? null }))
        .catch(() => ({ ok: false as const })),
      timeout,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return await Promise.race([operation.catch(() => null), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function getOriginCheckEnabledState(): Promise<SettingState<boolean>> {
  if (originCheckEnabledCache !== null && Date.now() - originCheckEnabledCacheTime < CACHE_TTL) {
    return { ok: true, value: originCheckEnabledCache };
  }

  const row = await lookupSystemSetting("origin_check_enabled");
  if (!row.ok) {
    if (originCheckEnabledCache !== null) return { ok: true, value: originCheckEnabledCache };
    return { ok: false };
  }
  originCheckEnabledCache = row.value === "true";
  originCheckEnabledCacheTime = Date.now();
  return { ok: true, value: originCheckEnabledCache };
}

async function getAllowedOriginsState(): Promise<SettingState<string[]>> {
  if (allowedOriginsCache && Date.now() - allowedOriginsCacheTime < CACHE_TTL) {
    return { ok: true, value: allowedOriginsCache };
  }

  const row = await lookupSystemSetting("allowed_dev_origins");
  if (!row.ok) {
    if (allowedOriginsCache) return { ok: true, value: allowedOriginsCache };
    return { ok: false };
  }

  allowedOriginsCache = parseAllowedAccessList(row.value);

  allowedOriginsCacheTime = Date.now();
  return { ok: true, value: allowedOriginsCache };
}

async function getAllowedOrigins(): Promise<string[]> {
  const state = await getAllowedOriginsState();
  return state.ok ? state.value : [];
}

function splitHeaderValues(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractForwardedHostnames(value: string | null): string[] {
  return splitHeaderValues(value)
    .flatMap((entry) => entry.split(";").map((part) => part.trim()))
    .filter((part) => part.toLowerCase().startsWith("host="))
    .map((part) => part.slice("host=".length).replace(/^"|"$/g, ""));
}

function extractRequestHostnames(req: NextRequest): string[] {
  const candidates = [
    ...extractForwardedHostnames(req.headers.get("forwarded")),
    ...splitHeaderValues(req.headers.get("x-forwarded-host")),
  ];
  const host = req.headers.get("host");
  if (host) candidates.push(host);
  candidates.push(req.nextUrl.hostname);
  return Array.from(new Set(candidates.map(normalizeAccessHostname).filter(Boolean)));
}

async function isBrowserApiOriginAllowed(req: NextRequest): Promise<boolean> {
  if (!req.nextUrl.pathname.startsWith("/api/")) return true;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const originHostname = normalizeAccessHostname(origin);
  if (!originHostname) return false;
  if (extractRequestHostnames(req).includes(originHostname)) return true;
  return isAccessHostnameAllowed(originHostname, await getAllowedOrigins());
}

function getProvidedApiKey(req: NextRequest): string | null {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-api-key")?.trim() || null;
}

async function isValidApiKey(key: string): Promise<boolean> {
  return Boolean(await withTimeout(verifyAccessKey(key), LOOKUP_TIMEOUT_MS));
}

async function getSessionWriteRole(req: NextRequest): Promise<"readOnly" | "writeable" | "unknown"> {
  const userId = req.cookies.get(USER_ID_COOKIE)?.value?.trim();
  const username = req.cookies.get(USERNAME_COOKIE)?.value?.trim();
  const householdId = req.cookies.get(HOUSEHOLD_COOKIE)?.value?.trim();

  const user = userId
    ? await withTimeout(
        prisma.user.findUnique({
          where: { id: userId },
          select: { role: true, isSystem: true },
        }),
        LOOKUP_TIMEOUT_MS,
      )
    : username
      ? await withTimeout(
          prisma.user.findFirst({
            where: {
              name: username,
              ...(householdId ? { householdId } : {}),
            },
            select: { role: true, isSystem: true },
            orderBy: { createdAt: "asc" },
          }),
          LOOKUP_TIMEOUT_MS,
      )
    : null;

  if (!user) return "unknown";
  return user.role === "viewer" && user.isSystem !== true ? "readOnly" : "writeable";
}

function isAllowedReadOnlyMutation(req: NextRequest): boolean {
  const { pathname, searchParams } = req.nextUrl;
  if (
    pathname === "/api/v1/auth/logout" ||
    pathname === "/api/v1/auth/verify" ||
    pathname === "/api/v1/auth/password-reset/request" ||
    pathname === "/api/v1/auth/password-reset/confirm"
  ) {
    return true;
  }
  if (pathname === "/api/v1/households/switch") return true;
  if (pathname === "/api/v1/settings/backup") {
    const mode = searchParams.get("mode");
    return mode === "export" || mode === "table-export";
  }
  return READ_ONLY_PREVIEW_PATHS.includes(pathname);
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (!(await isBrowserApiOriginAllowed(req))) {
    return NextResponse.json(
      { ok: false, code: "CROSS_ORIGIN_DENIED", error: "Cross-origin browser API requests are not allowed." },
      { status: 403 },
    );
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const originCheck = await getOriginCheckEnabledState();
  if (!originCheck.ok && pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, code: "ACCESS_SETTINGS_UNAVAILABLE", error: "Access-control settings are temporarily unavailable." },
      { status: 503 },
    );
  }
  if (originCheck.ok && originCheck.value) {
    const allowedState = await getAllowedOriginsState();
    if (!allowedState.ok) {
      return NextResponse.json(
        { ok: false, code: "ACCESS_SETTINGS_UNAVAILABLE", error: "Access allowlist settings are temporarily unavailable." },
        { status: 503 },
      );
    }
    const allowed = allowedState.value;
    const hostnames = extractAccessHostnames(req.headers, req.nextUrl.hostname);
    const hasDisallowedHost =
      hostnames.length === 0 || hostnames.some((hostname) => !isAccessHostnameAllowed(hostname, allowed));
    if (hasDisallowedHost) {
      console.error("[proxy] Access denied - hostnames:", hostnames, "allowed:", allowed);
      return NextResponse.json(
        { ok: false, code: "ACCESS_HOST_DENIED", error: "Access host is not on the allowlist." },
        { status: 403 },
      );
    }
  }

  const cookieUserId = req.cookies.get(USER_ID_COOKIE)?.value?.trim();
  const verified = verifyVerifiedSessionValue(req.cookies.get(VERIFIED_COOKIE)?.value, cookieUserId);
  if (verified.ok) {
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && !isAllowedReadOnlyMutation(req)) {
      const role = await getSessionWriteRole(req);
      if (role === "unknown") {
        return NextResponse.json(
          { ok: false, code: "SESSION_ROLE_UNAVAILABLE", error: "Unable to verify the current user's write permission." },
          { status: 503 },
        );
      }
      if (role === "readOnly") {
        return NextResponse.json(
          { ok: false, code: "READ_ONLY", error: "Read-only users cannot modify data." },
          { status: 403 },
        );
      }
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    const apiKey = getProvidedApiKey(req);
    if (apiKey && (await isValidApiKey(apiKey))) {
      const policy = getApiKeyPolicyDecision(pathname, req.method);
      if (!policy.ok) {
        return NextResponse.json(
          { ok: false, code: policy.code ?? "API_KEY_SCOPE_DENIED", error: policy.error ?? "API key access is not allowed for this endpoint." },
          { status: 403 },
        );
      }
      return NextResponse.next();
    }
    return NextResponse.json(
      {
        ok: false,
        code: apiKey ? "INVALID_API_KEY" : "UNAUTHORIZED",
        error: apiKey ? "Invalid API key." : "Sign in first.",
      },
      { status: 401 },
    );
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.delete("error");
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
