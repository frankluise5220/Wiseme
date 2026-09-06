export const TRADING_CALENDARS = ["cn_fund", "hk_fund", "jp_fund", "us_fund", "generic_weekday"] as const;

export type TradingCalendarValue = (typeof TRADING_CALENDARS)[number];

export function normalizeTradingCalendar(raw: unknown, fallback: TradingCalendarValue = "cn_fund"): TradingCalendarValue {
  const value = String(raw ?? "").trim();
  return TRADING_CALENDARS.includes(value as TradingCalendarValue) ? (value as TradingCalendarValue) : fallback;
}

export function supportsTradingCalendarForAccount(kind: string | null | undefined, investProductType: string | null | undefined) {
  return kind === "investment" && (investProductType === "fund" || investProductType === "money");
}

export function getDefaultTradingCalendarForAccount(kind: string | null | undefined, investProductType: string | null | undefined) {
  return supportsTradingCalendarForAccount(kind, investProductType) ? "cn_fund" : null;
}

export function resolveTradingCalendarForAccount(
  kind: string | null | undefined,
  investProductType: string | null | undefined,
  raw: unknown,
) {
  const fallback = getDefaultTradingCalendarForAccount(kind, investProductType);
  if (!fallback) return null;
  return normalizeTradingCalendar(raw, fallback);
}
