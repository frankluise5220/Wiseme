import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ResponseCookie } from "next/dist/compiled/@edge-runtime/cookies";

export const VERIFIED_COOKIE = "mmh_access_password_verified";
export const USER_ID_COOKIE = "mmh_user_id";
export const USERNAME_COOKIE = "mmh_username";
export const HOUSEHOLD_COOKIE = "householdId";
export const SESSION_DAYS_COOKIE = "mmh_session_days";

export const SESSION_COOKIES = [
  VERIFIED_COOKIE,
  USER_ID_COOKIE,
  USERNAME_COOKIE,
  HOUSEHOLD_COOKIE,
] as const;

type CookieRequestContext = {
  nextUrl?: { protocol?: string };
  headers?: { get(name: string): string | null };
};

type VerifiedSessionPayload = {
  uid: string;
  exp: number;
  nonce: string;
};

const VERIFIED_SESSION_VERSION = "v1";
const MIN_SESSION_SECRET_LENGTH = 32;

function sessionSigningSecret() {
  const explicit = process.env.MMH_SESSION_SECRET?.trim() ?? "";
  if (process.env.NODE_ENV === "production") {
    if (!explicit || explicit.length < MIN_SESSION_SECRET_LENGTH || /^CHANGE_ME/i.test(explicit)) {
      throw new Error("MMH_SESSION_SECRET must be set to a strong random value in production.");
    }
    return explicit;
  }
  return explicit || "mmh-development-session-secret";
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signSessionPayload(encodedPayload: string) {
  return createHmac("sha256", sessionSigningSecret())
    .update(`${VERIFIED_SESSION_VERSION}.${encodedPayload}`)
    .digest("base64url");
}

function timingSafeEqualText(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createVerifiedSessionValue(userId: string, maxAgeSeconds: number, now = new Date()) {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("User id is required to create a verified session.");
  }
  const expiresAt = now.getTime() + Math.max(1, Math.floor(maxAgeSeconds)) * 1000;
  const payload: VerifiedSessionPayload = {
    uid: normalizedUserId,
    exp: expiresAt,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  return `${VERIFIED_SESSION_VERSION}.${encodedPayload}.${signSessionPayload(encodedPayload)}`;
}

export function verifyVerifiedSessionValue(
  value: string | null | undefined,
  expectedUserId?: string | null,
  now = new Date(),
): { ok: true; userId: string; expiresAt: Date } | { ok: false } {
  const raw = value?.trim();
  if (!raw) return { ok: false };
  const [version, encodedPayload, signature, ...extra] = raw.split(".");
  if (version !== VERIFIED_SESSION_VERSION || !encodedPayload || !signature || extra.length > 0) {
    return { ok: false };
  }
  if (!timingSafeEqualText(signature, signSessionPayload(encodedPayload))) {
    return { ok: false };
  }

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload)) as Partial<VerifiedSessionPayload>;
    const userId = typeof payload.uid === "string" ? payload.uid.trim() : "";
    const expiresAt = typeof payload.exp === "number" ? payload.exp : 0;
    const expected = expectedUserId?.trim();
    if (!userId || !expiresAt || expiresAt <= now.getTime()) return { ok: false };
    if (expected && expected !== userId) return { ok: false };
    return { ok: true, userId, expiresAt: new Date(expiresAt) };
  } catch {
    return { ok: false };
  }
}

function normalizeProtocol(protocol: string | null | undefined) {
  const value = protocol?.trim().toLowerCase();
  if (!value) return null;
  return value.endsWith(":") ? value : `${value}:`;
}

function requestProtocol(context?: CookieRequestContext | URL | string) {
  if (!context) return null;
  if (typeof context === "string") {
    try {
      return normalizeProtocol(new URL(context).protocol);
    } catch {
      return null;
    }
  }
  if (context instanceof URL) {
    return normalizeProtocol(context.protocol);
  }

  const forwardedProto = context.headers?.get("x-forwarded-proto")?.split(",")[0];
  return normalizeProtocol(forwardedProto) ?? normalizeProtocol(context.nextUrl?.protocol);
}

export function shouldUseSecureCookies(context?: CookieRequestContext | URL | string) {
  if (process.env.NODE_ENV !== "production") return false;
  if (process.env.MMH_INSECURE_COOKIES === "1") return false;
  const protocol = requestProtocol(context);
  if (protocol === "http:") return false;
  return true;
}

export function sessionCookieOptions(maxAge: number, context?: CookieRequestContext | URL | string): Partial<ResponseCookie> {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookies(context),
    path: "/",
    maxAge,
  };
}

export function expiredSessionCookieOptions(context?: CookieRequestContext | URL | string): Partial<ResponseCookie> {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookies(context),
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  };
}
