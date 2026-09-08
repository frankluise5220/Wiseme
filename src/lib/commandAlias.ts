/**
 * Command alias library — unified lookup module.
 *
 * Category notes:
 * - "fundSubtype": canonical values such as buy, redeem, dividend_cash, ...
 * - "updateTarget": canonical values such as cashAccount, account, ...
 * - "transactionType": canonical values such as expense, income, ...
 *
 * All command parsing functions must use this module to look up aliases;
 * hardcoding mappings is forbidden.
 */
import { prisma } from "@/lib/db/prisma";

let cache: Map<string, Map<string, string>> | null = null;
let cacheTs = 0;
const CACHE_TTL = 60_000; // 1 minute

async function loadCache(): Promise<Map<string, Map<string, string>>> {
  const now = Date.now();
  if (cache && now - cacheTs < CACHE_TTL) return cache;

  const rows = await prisma.commandAlias.findMany({ orderBy: { key: "asc" } });
  cache = new Map();
  for (const r of rows) {
    if (!cache.has(r.category)) cache.set(r.category, new Map());
    cache.get(r.category)!.set(r.key, r.value);
  }
  cacheTs = now;
  return cache;
}

/** Look up the canonical value by alias (cached). */
export async function resolveAlias(category: string, key: string): Promise<string | null> {
  const c = await loadCache();
  return c.get(category)?.get(key) ?? null;
}

/** Reverse lookup: find all aliases for a canonical value. */
export async function resolveAliasReverse(category: string, value: string): Promise<string[]> {
  const c = await loadCache();
  const keys: string[] = [];
  for (const [k, v] of c.get(category) ?? []) {
    if (v === value) keys.push(k);
  }
  return keys;
}

/** Set an alias. */
export async function setAlias(category: string, key: string, value: string): Promise<void> {
  await prisma.commandAlias.upsert({
    where: { category_key: { category, key } },
    create: { category, key, value },
    update: { value },
  });
  cache = null; // invalidate
}

/** Delete an alias. */
export async function deleteAlias(category: string, key: string): Promise<boolean> {
  try {
    await prisma.commandAlias.delete({ where: { category_key: { category, key } } });
    cache = null;
    return true;
  } catch {
    return false;
  }
}

/** List all aliases for a category. */
export async function listAliases(category?: string): Promise<Array<{ key: string; value: string; category: string }>> {
  const c = await loadCache();
  const result: Array<{ key: string; value: string; category: string }> = [];
  for (const [cat, map] of c) {
    if (category && cat !== category) continue;
    for (const [k, v] of map) {
      result.push({ category: cat, key: k, value: v });
    }
  }
  return result;
}
