/**
 * Public formatting utility functions.
 *
 * Display-layer rule: all amount formatting must go through this module;
 * do not redefine it in pages/components.
 * Single data source → single formatting.
 *
 * Naming conventions:
 * - Display-layer types use a Display suffix (e.g. PositionDisplayRow)
 * - Display-layer variables use a display prefix in ambiguous contexts
 * - Edit-dialog props use a current/initial prefix to indicate origin (e.g. currentAmount)
 * - useState inside edit dialogs needs no prefix (scope is already clear)
 */

export function roundDisplayNumber(amount: number, fractionDigits = 2): number {
  if (!Number.isFinite(amount)) return amount;
  const factor = 10 ** fractionDigits;
  const sign = amount < 0 ? -1 : 1;
  const roundedAbs = Math.round((Math.abs(amount) + Number.EPSILON) * factor) / factor;
  const rounded = roundedAbs === 0 ? 0 : sign * roundedAbs;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function isDisplayZeroMoney(amount: number, fractionDigits = 2): boolean {
  return roundDisplayNumber(amount, fractionDigits) === 0;
}

/** Format a signed amount with 2 decimal places using the zh-CN locale (no ¥ prefix). */
export function formatMoney(amount: number): string {
  const rounded = roundDisplayNumber(amount, 2);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  return `${sign}${abs.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Format an amount with a ¥ prefix and 2 decimal places. */
export function formatMoneyYuan(amount: number): string {
  return `¥${formatMoney(amount)}`;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: "¥",
  JPY: "¥",
  USD: "$",
  EUR: "€",
  GBP: "£",
  HKD: "HK$",
};

/** Format an amount in the given currency; unknown currencies display a currency-code prefix. */
export function formatCurrencyMoney(amount: number, currency = "CNY"): string {
  const code = String(currency || "CNY").trim().toUpperCase() || "CNY";
  const prefix = CURRENCY_SYMBOLS[code] ?? `${code} `;
  const digits = code === "JPY" ? 0 : 2;
  const rounded = roundDisplayNumber(amount, digits);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded);
  return `${sign}${prefix}${abs.toLocaleString("zh-CN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Format an amount accepting string | number input (e.g. Prisma Decimal); non-finite numbers return "-". */
export function formatMoneyLoose(v: string | number): string {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) ? formatMoney(n) : "-";
}

/**
 * Format an amount with a trailing currency-code suffix (e.g. "1,234.56 CNY").
 * Used for stock/securities tables and dialogs that show both amount and
 * currency; invalid input returns "-".
 */
export function formatMoneyWithCurrencyCode(value: number | null | undefined, currency = "CNY"): string {
  if (value == null || !Number.isFinite(Number(value))) return "-";
  const code = String(currency || "CNY");
  return `${Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${code}`;
}

/**
 * Format a rate/percentage: signed, fixed decimal digits, "%" suffix;
 * non-finite numbers return "-".
 * For example 0.0435 → "+4.35%", -0.01 → "-1.00%".
 */
export function formatPercent(value: number | null | undefined, digits = 2): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "-";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(digits)}%`;
}
