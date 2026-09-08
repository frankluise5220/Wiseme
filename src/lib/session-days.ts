export const DEFAULT_SESSION_DAYS = 30;

export const SESSION_DAY_OPTIONS = [
  { value: 1, label: "1 天" },
  { value: 7, label: "7 天" },
  { value: 30, label: "30 天" },
  { value: 90, label: "90 天" },
  { value: 180, label: "180 天" },
  { value: 365, label: "365 天" },
] as const;

export function normalizeSessionDays(input: unknown, fallback = DEFAULT_SESSION_DAYS) {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), 1), 365);
}

export function sessionDaysToMaxAge(input: unknown) {
  return normalizeSessionDays(input) * 24 * 60 * 60;
}
