import { cache } from "react";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db/prisma";
import {
  HOUSEHOLD_COOKIE,
  USER_ID_COOKIE,
  USERNAME_COOKIE,
  VERIFIED_COOKIE,
  verifyVerifiedSessionValue,
} from "@/lib/server/session-cookies";

export type CurrentUser = {
  id: string;
  name: string;
  role: string;
  isSystem: boolean;
  householdId: string | null;
};

export const USER_ROLE_ADMIN = "admin";
export const USER_ROLE_USER = "user";
export const USER_ROLE_VIEWER = "viewer";

const currentUserSelect = {
  id: true,
  name: true,
  role: true,
  isSystem: true,
  householdId: true,
} as const;

const USER_LOOKUP_TIMEOUT_MS = 8000;

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

/**
 * Read the verified login cookies and resolve the current database user.
 *
 * Cached per request (React.cache) so multiple modules in the same request
 * share one lookup instead of running repeated DB queries.
 *
 * If householdId is present, username is resolved inside that household.
 * Without householdId, legacy username-only lookup prefers an explicitly marked
 * system user, then falls back to unique username lookup; otherwise the session
 * is treated as ambiguous.
 */
export const getCurrentUser = cache(async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies();
  const cookieUserId = cookieStore.get(USER_ID_COOKIE)?.value?.trim();
  const verified = verifyVerifiedSessionValue(cookieStore.get(VERIFIED_COOKIE)?.value, cookieUserId);
  const userId = verified.ok ? verified.userId : cookieUserId;
  const username = cookieStore.get(USERNAME_COOKIE)?.value?.trim();
  const householdId = cookieStore.get(HOUSEHOLD_COOKIE)?.value?.trim();

  if (!verified.ok) return null;

  const deadline = Date.now() + USER_LOOKUP_TIMEOUT_MS;
  const lookup = async <T>(operation: Promise<T>): Promise<T | null> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    return withTimeout(operation, remaining);
  };

  if (userId) {
    const user = await lookup(prisma.user.findUnique({
      where: { id: userId },
      select: currentUserSelect,
    }));
    if (user) return user;
  }

  if (username && householdId) {
    const scopedUser = await lookup(prisma.user.findFirst({
      where: { name: username, householdId },
      select: currentUserSelect,
    }));
    if (scopedUser) return scopedUser;

    const systemUser = await lookup(prisma.user.findFirst({
      where: { name: username, isSystem: true },
      select: currentUserSelect,
      orderBy: { createdAt: "asc" },
    }));
    if (systemUser) return systemUser;

    const users = await lookup(prisma.user.findMany({
      where: { name: username },
      select: currentUserSelect,
      take: 2,
      orderBy: { createdAt: "asc" },
    }));
    if (!users) return null;
    return users.length === 1 ? users[0] : null;
  }

  if (!username && householdId) {
    const householdAdmin = await lookup(prisma.user.findFirst({
      where: { householdId, OR: [{ role: "admin" }, { isSystem: true }] },
      select: currentUserSelect,
      orderBy: { createdAt: "asc" },
    }));
    if (householdAdmin) return householdAdmin;

    return await lookup(prisma.user.findFirst({
      where: { householdId },
      select: currentUserSelect,
      orderBy: { createdAt: "asc" },
    }));
  }

  if (!username) {
    const systemUser = await lookup(prisma.user.findFirst({
      where: { isSystem: true },
      select: currentUserSelect,
      orderBy: { createdAt: "asc" },
    }));
    if (systemUser) return systemUser;

    const users = await lookup(prisma.user.findMany({
      select: currentUserSelect,
      take: 2,
      orderBy: { createdAt: "asc" },
    }));
    if (!users) return null;
    return users.length === 1 ? users[0] : null;
  }

  const systemUser = await lookup(prisma.user.findFirst({
    where: { name: username, isSystem: true },
    select: currentUserSelect,
    orderBy: { createdAt: "asc" },
  }));
  if (systemUser) return systemUser;

  const users = await lookup(prisma.user.findMany({
    where: { name: username },
    select: currentUserSelect,
    take: 2,
    orderBy: { createdAt: "asc" },
  }));
  if (!users) return null;

  return users.length === 1 ? users[0] : null;
});

/**
 * Checks whether the user is an administrator (admin role or isSystem flag).
 * Administrators can access data of all households (books).
 */
export function isAdmin(user: CurrentUser | null): boolean {
  if (!user) return false;
  return user.role === USER_ROLE_ADMIN || user.isSystem === true;
}

export function isReadOnly(user: CurrentUser | null): boolean {
  return Boolean(user && !isAdmin(user) && user.role === USER_ROLE_VIEWER);
}

export function canWrite(user: CurrentUser | null): boolean {
  return Boolean(user) && !isReadOnly(user);
}
