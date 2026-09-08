"use client";

import { useEffect, useState } from "react";

export const RECENT_ACCOUNTS_KEY = "mmh_recent_accounts";
export const ACCOUNT_USAGE_KEY = "mmh_account_usage";
export const RECENT_ACCOUNTS_EVENT = "mmh:recent-account-changed";

export type AccountUsageStat = {
  count: number;
  lastUsedAt: number;
};

export type AccountUsageMap = Record<string, AccountUsageStat>;

function normalizeAccountUsage(raw: unknown): AccountUsageMap {
  if (!raw || typeof raw !== "object") return {};
  const next: AccountUsageMap = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!id || !value || typeof value !== "object") continue;
    const item = value as { count?: unknown; lastUsedAt?: unknown };
    const count = Number(item.count);
    const lastUsedAt = Number(item.lastUsedAt);
    if (!Number.isFinite(count) || count <= 0) continue;
    next[id] = {
      count,
      lastUsedAt: Number.isFinite(lastUsedAt) ? lastUsedAt : 0,
    };
  }
  return next;
}

export function readRecentAccountIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_ACCOUNTS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function readAccountUsage(): AccountUsageMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(ACCOUNT_USAGE_KEY);
    const parsed = raw ? normalizeAccountUsage(JSON.parse(raw)) : {};
    if (Object.keys(parsed).length > 0) return parsed;
    const now = Date.now();
    return Object.fromEntries(
      readRecentAccountIds().map((id, index) => [
        id,
        {
          count: 1,
          lastUsedAt: now - index,
        },
      ]),
    );
  } catch {
    return {};
  }
}

export function recordRecentAccount(accountId: string) {
  if (typeof window === "undefined" || !accountId) return;
  try {
    const list = readRecentAccountIds().filter((id) => id && id !== accountId);
    const next = [accountId, ...list].slice(0, 20);
    const usage = readAccountUsage();
    const prev = usage[accountId];
    const nextUsage = {
      ...usage,
      [accountId]: {
        count: (prev?.count ?? 0) + 1,
        lastUsedAt: Date.now(),
      },
    };
    window.localStorage.setItem(RECENT_ACCOUNTS_KEY, JSON.stringify(next));
    window.localStorage.setItem(ACCOUNT_USAGE_KEY, JSON.stringify(nextUsage));
    window.dispatchEvent(
      new CustomEvent(RECENT_ACCOUNTS_EVENT, {
        detail: { accountId, ids: next, usage: nextUsage },
      }),
    );
  } catch {
    // ignore local preference write failures
  }
}

export function useRecentAccountIds() {
  const [recentIds, setRecentIds] = useState<string[]>([]);

  useEffect(() => {
    const sync = () => setRecentIds(readRecentAccountIds());
    sync();
    window.addEventListener(RECENT_ACCOUNTS_EVENT, sync as EventListener);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(RECENT_ACCOUNTS_EVENT, sync as EventListener);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return recentIds;
}

export function useAccountUsage() {
  const [usage, setUsage] = useState<AccountUsageMap>({});

  useEffect(() => {
    const sync = () => setUsage(readAccountUsage());
    sync();
    window.addEventListener(RECENT_ACCOUNTS_EVENT, sync as EventListener);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(RECENT_ACCOUNTS_EVENT, sync as EventListener);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return usage;
}

export function sortOptionsByRecent<T extends { id: string }>(options: T[], recentIds: string[]) {
  if (!options.length || !recentIds.length) return options;

  const rank = new Map<string, number>();
  recentIds.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index);
  });

  return options
    .map((option, index) => ({
      option,
      index,
      rank: rank.get(option.id) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => {
      const aRecent = Number.isFinite(a.rank);
      const bRecent = Number.isFinite(b.rank);
      if (aRecent && bRecent) return a.rank - b.rank;
      if (aRecent) return -1;
      if (bRecent) return 1;
      return a.index - b.index;
    })
    .map((item) => item.option);
}

export function sortByAccountUsage<T extends { id?: string | null }>(items: T[], usage: AccountUsageMap) {
  if (!items.length) return items;
  return items
    .map((item, index) => {
      const stat = item.id ? usage[item.id] : undefined;
      return {
        item,
        index,
        count: stat?.count ?? 0,
        lastUsedAt: stat?.lastUsedAt ?? 0,
      };
    })
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      if (a.lastUsedAt !== b.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}
