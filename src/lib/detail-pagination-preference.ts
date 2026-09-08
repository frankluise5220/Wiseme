export const DETAIL_PAGE_SIZE_OPTIONS = [10, 20, 40] as const;
export const DETAIL_ALL_PAGE_SIZE = 50000;

export type DetailPaginationPreference = {
  pageSize: number;
  detailPage: number;
  detailAll: boolean;
};

export function normalizeDetailPageSize(value: unknown, fallback = 20) {
  const parsed = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return DETAIL_PAGE_SIZE_OPTIONS.includes(parsed as (typeof DETAIL_PAGE_SIZE_OPTIONS)[number])
    ? parsed
    : fallback;
}

export function normalizeDetailPage(value: unknown, fallback = 1) {
  const parsed = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

export function detailPaginationCookieName(accountId: string) {
  const safeAccountId = String(accountId ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
  return `mmh_detail_pagination_${safeAccountId}`;
}

export function encodeDetailPaginationPreference(pref: DetailPaginationPreference) {
  return encodeURIComponent(JSON.stringify({
    pageSize: normalizeDetailPageSize(pref.pageSize),
    detailPage: normalizeDetailPage(pref.detailPage),
    detailAll: pref.detailAll === true,
  }));
}

export function decodeDetailPaginationPreference(value: string | null | undefined): DetailPaginationPreference | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<DetailPaginationPreference>;
    return {
      pageSize: normalizeDetailPageSize(parsed.pageSize),
      detailPage: normalizeDetailPage(parsed.detailPage),
      detailAll: parsed.detailAll === true,
    };
  } catch {
    return null;
  }
}

/** Clamp the page number to the [1, totalPages] range. */
export function clampDetailPage(page: number, totalPages: number) {
  return Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
}

function readCookieValue(name: string) {
  if (typeof document === "undefined") return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return match ? match[1] : null;
}

/** Read the account's detail pagination preference from sessionStorage (falling back to cookie). */
export function readStoredDetailPreference(accountId: string): DetailPaginationPreference | null {
  const key = detailPaginationCookieName(accountId);
  const stored = typeof window === "undefined"
    ? null
    : decodeDetailPaginationPreference(window.sessionStorage.getItem(key));
  return stored ?? decodeDetailPaginationPreference(readCookieValue(key));
}

/** Write the detail pagination preference to sessionStorage + cookie. */
export function writeStoredDetailPreference(
  accountId: string,
  pageSize: number,
  detailAll: boolean,
  detailPage: number,
) {
  if (typeof window === "undefined") return;
  const cookieName = detailPaginationCookieName(accountId);
  const value = encodeDetailPaginationPreference({ pageSize, detailAll, detailPage });
  window.sessionStorage.setItem(cookieName, value);
  document.cookie = `${cookieName}=${value}; path=/; max-age=31536000; SameSite=Lax`;
}
