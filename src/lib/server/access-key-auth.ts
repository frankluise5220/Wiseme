import { prisma } from "@/lib/db/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

export const ACCESS_KEY_HASH_PREFIX = "bcrypt-sha256-v1:";

type AccessKeyRow = {
  id: string;
  name: string;
  key: string;
};

export type AccessKeyAuthResult = {
  id: string;
  name: string;
};

function plainTextEquals(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function accessKeyPreview(plain: string) {
  const normalized = plain.trim();
  if (!normalized) return "****";
  const suffix = normalized.slice(-4);
  return `${"*".repeat(Math.max(8, Math.min(normalized.length, 12)))}${suffix}`;
}

function parseStoredAccessKey(stored: string): { hashed: true; preview: string; hash: string } | { hashed: false; plain: string } {
  if (!stored.startsWith(ACCESS_KEY_HASH_PREFIX)) {
    return { hashed: false, plain: stored };
  }
  const rest = stored.slice(ACCESS_KEY_HASH_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) {
    return { hashed: true, preview: "****", hash: rest };
  }
  return {
    hashed: true,
    preview: rest.slice(0, separator),
    hash: rest.slice(separator + 1),
  };
}

export function storedAccessKeyPreview(stored: string) {
  const parsed = parseStoredAccessKey(stored);
  return parsed.hashed ? parsed.preview : accessKeyPreview(parsed.plain);
}

export async function hashAccessKey(plain: string) {
  const normalized = plain.trim();
  if (!normalized) {
    throw new Error("Access key is required.");
  }
  const hash = await hashPassword(normalized);
  return `${ACCESS_KEY_HASH_PREFIX}${accessKeyPreview(normalized)}:${hash}`;
}

async function verifyStoredAccessKey(provided: string, row: AccessKeyRow) {
  const stored = parseStoredAccessKey(row.key);
  if (stored.hashed) {
    if (!stored.hash) return false;
    return verifyPassword(provided, stored.hash).catch(() => false);
  }
  if (!plainTextEquals(provided, stored.plain)) return false;
  const nextHash = await hashAccessKey(provided);
  await prisma.accessKey.update({
    where: { id: row.id },
    data: { key: nextHash },
  }).catch(() => null);
  return true;
}

export async function verifyAccessKey(providedKey: string | null | undefined): Promise<AccessKeyAuthResult | null> {
  const key = providedKey?.trim();
  if (!key || key.length < 4) return null;

  const rows = await prisma.accessKey.findMany({
    select: { id: true, name: true, key: true },
    orderBy: { createdAt: "desc" },
  });

  for (const row of rows) {
    if (await verifyStoredAccessKey(key, row)) {
      return { id: row.id, name: row.name };
    }
  }

  return null;
}
