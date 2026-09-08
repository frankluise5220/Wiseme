export type ImportProgressPhase = "preparing" | "writing" | "recalculating" | "done" | "failed";

export type ImportProgressSnapshot = {
  traceId: string;
  total: number;
  processed: number;
  created: number;
  phase: ImportProgressPhase;
  currentRow: number | null;
  startedAt: string;
  updatedAt: string;
  done: boolean;
  ok: boolean | null;
  error: string | null;
  failedRow: number | null;
  cancelled?: boolean;
};

const STORE_KEY = "__mmhImportProgressStore";
const LOCK_STORE_KEY = "__mmhImportActiveLockStore";
const PROGRESS_TTL_MS = 2 * 60 * 60 * 1000;

type ImportProgressStore = Map<string, ImportProgressSnapshot>;
type ActiveImportLock = {
  householdId: string;
  traceId: string;
  itemCount: number;
  startedAt: string;
  updatedAt: string;
};
type ActiveImportLockStore = Map<string, ActiveImportLock>;

function getStore(): ImportProgressStore {
  const globalStore = globalThis as typeof globalThis & { [STORE_KEY]?: ImportProgressStore };
  if (!globalStore[STORE_KEY]) globalStore[STORE_KEY] = new Map();
  return globalStore[STORE_KEY];
}

function getLockStore(): ActiveImportLockStore {
  const globalStore = globalThis as typeof globalThis & { [LOCK_STORE_KEY]?: ActiveImportLockStore };
  if (!globalStore[LOCK_STORE_KEY]) globalStore[LOCK_STORE_KEY] = new Map();
  return globalStore[LOCK_STORE_KEY];
}

function nowIso() {
  return new Date().toISOString();
}

function cleanupStore(store: ImportProgressStore) {
  const now = Date.now();
  for (const [traceId, progress] of store.entries()) {
    const updatedAt = new Date(progress.updatedAt).getTime();
    if (!Number.isFinite(updatedAt) || now - updatedAt > PROGRESS_TTL_MS) {
      store.delete(traceId);
    }
  }
}

function cleanupLockStore(store: ActiveImportLockStore) {
  const now = Date.now();
  for (const [householdId, lock] of store.entries()) {
    const updatedAt = new Date(lock.updatedAt).getTime();
    if (!Number.isFinite(updatedAt) || now - updatedAt > PROGRESS_TTL_MS) {
      store.delete(householdId);
    }
  }
}

function touchActiveImportLock(traceId: string) {
  const store = getLockStore();
  cleanupLockStore(store);
  const timestamp = nowIso();
  for (const [householdId, lock] of store.entries()) {
    if (lock.traceId === traceId) {
      store.set(householdId, { ...lock, updatedAt: timestamp });
    }
  }
}

export function startImportProgress(traceId: string | null | undefined, total: number) {
  const key = String(traceId ?? "").trim();
  if (!key) return;
  const store = getStore();
  cleanupStore(store);
  const timestamp = nowIso();
  store.set(key, {
    traceId: key,
    total,
    processed: 0,
    created: 0,
    phase: "preparing",
    currentRow: null,
    startedAt: timestamp,
    updatedAt: timestamp,
    done: false,
    ok: null,
    error: null,
    failedRow: null,
  });
}

export function updateImportProgress(
  traceId: string | null | undefined,
  patch: Partial<Omit<ImportProgressSnapshot, "traceId" | "startedAt" | "updatedAt">>,
) {
  const key = String(traceId ?? "").trim();
  if (!key) return;
  const store = getStore();
  const current = store.get(key);
  if (!current) return;
  store.set(key, {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  });
  touchActiveImportLock(key);
}

export function cancelImportProgress(traceId: string | null | undefined) {
  const key = String(traceId ?? "").trim();
  if (!key) return;
  const store = getStore();
  const current = store.get(key);
  if (!current) return;
  store.set(key, { ...current, cancelled: true, updatedAt: nowIso() });
}

export function isImportCancelled(traceId: string | null | undefined): boolean {
  const key = String(traceId ?? "").trim();
  if (!key) return false;
  return getStore().get(key)?.cancelled === true;
}

export function finishImportProgress(
  traceId: string | null | undefined,
  patch: Pick<ImportProgressSnapshot, "ok"> & Partial<Omit<ImportProgressSnapshot, "traceId" | "startedAt" | "updatedAt" | "ok">>,
) {
  updateImportProgress(traceId, {
    ...patch,
    done: true,
    phase: patch.ok ? "done" : "failed",
  });
}

export function getImportProgress(traceId: string | null | undefined) {
  const key = String(traceId ?? "").trim();
  if (!key) return null;
  const store = getStore();
  cleanupStore(store);
  return store.get(key) ?? null;
}

export function beginImportRun(householdId: string, traceId: string | null | undefined, itemCount: number) {
  const normalizedHouseholdId = householdId.trim();
  const normalizedTraceId = String(traceId ?? "").trim();
  if (!normalizedHouseholdId || !normalizedTraceId) {
    return { ok: true as const };
  }
  const store = getLockStore();
  cleanupLockStore(store);
  const active = store.get(normalizedHouseholdId);
  if (active) {
    return { ok: false as const, active };
  }
  const timestamp = nowIso();
  store.set(normalizedHouseholdId, {
    householdId: normalizedHouseholdId,
    traceId: normalizedTraceId,
    itemCount,
    startedAt: timestamp,
    updatedAt: timestamp,
  });
  return { ok: true as const };
}

export function finishImportRun(householdId: string, traceId: string | null | undefined) {
  const normalizedHouseholdId = householdId.trim();
  const normalizedTraceId = String(traceId ?? "").trim();
  if (!normalizedHouseholdId || !normalizedTraceId) return;
  const store = getLockStore();
  const active = store.get(normalizedHouseholdId);
  if (active?.traceId === normalizedTraceId) {
    store.delete(normalizedHouseholdId);
  }
}
