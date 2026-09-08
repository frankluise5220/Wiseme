"use client";

export type SettingsAccountGroup = { id: string; name: string; sortOrder?: number };
export type SettingsInstitution = { id: string; name: string; shortName?: string | null; type?: string | null; accountCount?: number };
export type SettingsCounterparty = { id: string; name: string; shortName?: string | null; type?: string | null; accountCount?: number };
export type SettingsUser = { id: string; name: string };
export type SettingsCategory = { id: string; name: string; type: string; parentId?: string | null; sortOrder?: number; isSystem?: boolean };
export type SettingsAccountData = {
  baseCurrency?: string;
  accounts: unknown[];
  groups: SettingsAccountGroup[];
  institutions: SettingsInstitution[];
  counterparties?: SettingsCounterparty[];
  users?: SettingsUser[];
};
export type SettingsTag = { id: string; name: string; color: string | null };
export type SettingsBootstrapData = SettingsAccountData & {
  users: SettingsUser[];
  categories: SettingsCategory[];
  tags: SettingsTag[];
};
export type SettingsDataScope = "accounts" | "categories" | "tags" | "all";
export type SettingsDataChangedDetail = {
  scope: SettingsDataScope;
  reason?: string;
};
export type SettingsDataChangeOptions = {
  scope?: SettingsDataScope;
  reason?: string;
  prefetch?: boolean;
  invalidate?: boolean;
};

const ACCOUNT_DATA_KEY = "accounts-basic";
const BOOTSTRAP_KEY = "settings-bootstrap";
const CATEGORIES_KEY = "categories";
const TAGS_KEY = "tags";
const TTL_MS = 60_000;
export const SETTINGS_DATA_CHANGED_EVENT = "mmh:settings:data-changed";

type CacheEntry<T> = {
  value?: T;
  promise?: Promise<T>;
  updatedAt: number;
};

const cache = new Map<string, CacheEntry<unknown>>();

function isFresh(entry: CacheEntry<unknown> | undefined) {
  return Boolean(entry?.value) && Date.now() - entry!.updatedAt < TTL_MS;
}

export function getCachedSettingsAccountData() {
  const entry = cache.get(ACCOUNT_DATA_KEY) as CacheEntry<SettingsAccountData> | undefined;
  return isFresh(entry) ? entry?.value ?? null : entry?.value ?? null;
}

function setCacheValue<T>(key: string, value: T) {
  cache.set(key, { value, updatedAt: Date.now() });
}

function seedBootstrapCaches(value: SettingsBootstrapData) {
  setCacheValue(BOOTSTRAP_KEY, value);
  setCacheValue(ACCOUNT_DATA_KEY, {
    baseCurrency: value.baseCurrency,
    accounts: value.accounts,
    groups: value.groups,
    institutions: value.institutions,
    counterparties: value.counterparties,
    users: value.users,
  });
  setCacheValue(CATEGORIES_KEY, value.categories);
  setCacheValue(TAGS_KEY, value.tags);
}

function getSharedSettingsBootstrap(options?: { force?: boolean }) {
  if (options?.force) return null;
  const entry = cache.get(BOOTSTRAP_KEY) as CacheEntry<SettingsBootstrapData> | undefined;
  // Page-specific settings fetches must not wait for the broader bootstrap request.
  if (entry?.value) return entry.value;
  return null;
}

export async function fetchSettingsBootstrap(options?: { force?: boolean }) {
  const entry = cache.get(BOOTSTRAP_KEY) as CacheEntry<SettingsBootstrapData> | undefined;
  if (!options?.force && isFresh(entry) && entry?.value) return entry.value;
  if (!options?.force && entry?.promise) return entry.promise;

  const promise = fetch("/api/v1/settings/bootstrap", { cache: "no-store" })
    .then((res) => res.json())
    .then((data) => {
      if (!data?.ok) throw new Error(data?.error || "读取设置基础资料失败");
      const value: SettingsBootstrapData = {
        baseCurrency: data.baseCurrency || "CNY",
        accounts: data.accounts || [],
        groups: data.groups || [],
        institutions: data.institutions || [],
        counterparties: data.counterparties || [],
        users: data.users || [],
        categories: data.categories || [],
        tags: data.tags || [],
      };
      seedBootstrapCaches(value);
      return value;
    })
    .catch((error) => {
      const prev = cache.get(BOOTSTRAP_KEY) as CacheEntry<SettingsBootstrapData> | undefined;
      if (prev?.value) seedBootstrapCaches(prev.value);
      else cache.delete(BOOTSTRAP_KEY);
      throw error;
    });

  cache.set(BOOTSTRAP_KEY, { value: entry?.value, promise, updatedAt: entry?.updatedAt ?? 0 });
  return promise;
}

export function warmSettingsBootstrap(options?: { force?: boolean }) {
  void fetchSettingsBootstrap(options).catch(() => null);
}

function scopeTouchesAccounts(scope: SettingsDataScope) {
  return scope === "accounts" || scope === "all";
}

function scopeTouchesCategories(scope: SettingsDataScope) {
  return scope === "categories" || scope === "all";
}

function scopeTouchesTags(scope: SettingsDataScope) {
  return scope === "tags" || scope === "all";
}

export function invalidateSettingsData(scope: SettingsDataScope = "all") {
  if (scopeTouchesAccounts(scope)) cache.delete(ACCOUNT_DATA_KEY);
  if (scopeTouchesCategories(scope)) cache.delete(CATEGORIES_KEY);
  if (scopeTouchesTags(scope)) cache.delete(TAGS_KEY);
  cache.delete(BOOTSTRAP_KEY);
}

async function prefetchSettingsData(scope: SettingsDataScope) {
  if (scope === "all") {
    await fetchSettingsBootstrap({ force: true });
    return;
  }
  if (scope === "accounts") await fetchSettingsAccountData({ force: true });
  if (scope === "categories") await fetchSettingsCategories({ force: true });
  if (scope === "tags") await fetchSettingsTags({ force: true });
}

export async function notifySettingsDataChanged(options?: SettingsDataChangeOptions) {
  const scope = options?.scope ?? "all";
  if (options?.invalidate !== false) invalidateSettingsData(scope);
  const detail: SettingsDataChangedDetail = { scope, reason: options?.reason };
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SETTINGS_DATA_CHANGED_EVENT, { detail }));
  }
  if (options?.prefetch) await prefetchSettingsData(scope);
}

export async function fetchSettingsAccountData(options?: { force?: boolean }) {
  const bootstrap = await getSharedSettingsBootstrap(options);
  if (bootstrap) {
    return {
      accounts: bootstrap.accounts,
      baseCurrency: bootstrap.baseCurrency,
      groups: bootstrap.groups,
      institutions: bootstrap.institutions,
      counterparties: bootstrap.counterparties,
      users: bootstrap.users,
    };
  }
  const entry = cache.get(ACCOUNT_DATA_KEY) as CacheEntry<SettingsAccountData> | undefined;
  if (!options?.force && isFresh(entry) && entry?.value) return entry.value;
  if (!options?.force && entry?.promise) return entry.promise;

  const promise = fetch("/api/v1/accounts/internal?balances=false", { cache: "no-store" })
    .then((res) => res.json())
    .then((data) => {
      if (!data?.ok) throw new Error(data?.error || "读取账户资料失败");
      const value: SettingsAccountData = {
        baseCurrency: data.baseCurrency || "CNY",
        accounts: data.accounts || [],
        groups: data.groups || [],
        institutions: data.institutions || [],
        counterparties: data.counterparties || [],
        users: data.users || [],
      };
      cache.set(ACCOUNT_DATA_KEY, { value, updatedAt: Date.now() });
      return value;
    })
    .catch((error) => {
      const prev = cache.get(ACCOUNT_DATA_KEY) as CacheEntry<SettingsAccountData> | undefined;
      if (prev?.value) cache.set(ACCOUNT_DATA_KEY, { value: prev.value, updatedAt: prev.updatedAt });
      else cache.delete(ACCOUNT_DATA_KEY);
      throw error;
    });

  cache.set(ACCOUNT_DATA_KEY, { value: entry?.value, promise, updatedAt: entry?.updatedAt ?? 0 });
  return promise;
}

export function getCachedSettingsCategories() {
  const entry = cache.get(CATEGORIES_KEY) as CacheEntry<SettingsCategory[]> | undefined;
  return isFresh(entry) ? entry?.value ?? null : entry?.value ?? null;
}

export async function fetchSettingsCategories(options?: { force?: boolean }) {
  const bootstrap = await getSharedSettingsBootstrap(options);
  if (bootstrap) return bootstrap.categories;
  const entry = cache.get(CATEGORIES_KEY) as CacheEntry<SettingsCategory[]> | undefined;
  if (!options?.force && isFresh(entry) && entry?.value) return entry.value;
  if (!options?.force && entry?.promise) return entry.promise;

  const promise = fetchSettingsBootstrap(options)
    .then((data) => {
      const value = data.categories || [];
      setCacheValue(CATEGORIES_KEY, value);
      return value as SettingsCategory[];
    })
    .catch((error) => {
      const prev = cache.get(CATEGORIES_KEY) as CacheEntry<SettingsCategory[]> | undefined;
      if (prev?.value) setCacheValue(CATEGORIES_KEY, prev.value);
      else cache.delete(CATEGORIES_KEY);
      throw error;
    });

  cache.set(CATEGORIES_KEY, { value: entry?.value, promise, updatedAt: entry?.updatedAt ?? 0 });
  return promise;
}

export function setSettingsCategories(next: SettingsCategory[]) {
  setCacheValue(CATEGORIES_KEY, next);
  cache.delete(BOOTSTRAP_KEY);
}

export function getCachedSettingsTags() {
  const entry = cache.get(TAGS_KEY) as CacheEntry<SettingsTag[]> | undefined;
  return isFresh(entry) ? entry?.value ?? null : entry?.value ?? null;
}

export async function fetchSettingsTags(options?: { force?: boolean }) {
  const bootstrap = await getSharedSettingsBootstrap(options);
  if (bootstrap) return bootstrap.tags;
  const entry = cache.get(TAGS_KEY) as CacheEntry<SettingsTag[]> | undefined;
  if (!options?.force && isFresh(entry) && entry?.value) return entry.value;
  if (!options?.force && entry?.promise) return entry.promise;

  const promise = fetchSettingsBootstrap(options)
    .then((data) => {
      const value = data.tags || [];
      cache.set(TAGS_KEY, { value, updatedAt: Date.now() });
      return value as SettingsTag[];
    })
    .catch((error) => {
      const prev = cache.get(TAGS_KEY) as CacheEntry<SettingsTag[]> | undefined;
      if (prev?.value) cache.set(TAGS_KEY, { value: prev.value, updatedAt: prev.updatedAt });
      else cache.delete(TAGS_KEY);
      throw error;
    });

  cache.set(TAGS_KEY, { value: entry?.value, promise, updatedAt: entry?.updatedAt ?? 0 });
  return promise;
}

export function setSettingsTags(next: SettingsTag[]) {
  cache.set(TAGS_KEY, { value: next, updatedAt: Date.now() });
  cache.delete(BOOTSTRAP_KEY);
}
