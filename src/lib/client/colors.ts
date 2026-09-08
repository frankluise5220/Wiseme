/**
 * Gain/loss color scheme.
 *
 * red_up_green_down: red for gains, green for losses (China convention) — gain (positive) = red, loss (negative) = green
 * green_up_red_down: green for gains, red for losses (international convention) — gain (positive) = green, loss (negative) = red
 */
export type ColorScheme = "red_up_green_down" | "green_up_red_down";

/**
 * Gain/loss palette.
 *
 * Pages/components historically each implemented their own "positive red, negative green"
 * three-tone mapping, with slightly drifting shades (600/700) and neutral colors
 * (slate-500/600/700/900). Unified here; components only pick a palette name:
 * - default: standard (gain red text-red-600 / loss green text-emerald-700 / neutral slate-600)
 * - soft: lighter loss green (emerald-600)
 * - softMuted / softDark: soft with neutral slate-500 / slate-700
 * - strong: darker (red-700 / emerald-700), neutral slate-900
 * - muted: default colors but neutral slate-500
 * - strongMuted: strong colors but neutral slate-500
 */
export const PNL_PALETTES = {
  default: { up: "text-red-600", down: "text-emerald-700", neutral: "text-slate-600" },
  soft: { up: "text-red-600", down: "text-emerald-600", neutral: "text-slate-600" },
  softMuted: { up: "text-red-600", down: "text-emerald-600", neutral: "text-slate-500" },
  softDark: { up: "text-red-600", down: "text-emerald-600", neutral: "text-slate-700" },
  strong: { up: "text-red-700", down: "text-emerald-700", neutral: "text-slate-900" },
  muted: { up: "text-red-600", down: "text-emerald-700", neutral: "text-slate-500" },
  strongMuted: { up: "text-red-700", down: "text-emerald-700", neutral: "text-slate-500" },
} as const;

export type PnlPaletteName = keyof typeof PNL_PALETTES;

/** Return the color class for a value and scheme. */
export function pnlColor(n: number, scheme: ColorScheme, palette: PnlPaletteName = "default"): string {
  const p = PNL_PALETTES[palette] ?? PNL_PALETTES.default;
  const positive = scheme === "red_up_green_down" ? p.up : p.down;
  const negative = scheme === "red_up_green_down" ? p.down : p.up;
  if (n > 0) return positive;
  if (n < 0) return negative;
  return p.neutral;
}

/**
 * Resolve gain/loss colors from an isRedUp boolean (legacy components commonly use
 * isRedUp instead of a scheme string). invert=true reverses the direction (used for
 * liability-style amounts where a positive value means "paid off/available").
 */
export function pnlClassFromRedUp(
  n: number,
  isRedUp: boolean,
  palette: PnlPaletteName = "default",
  invert = false,
): string {
  const scheme: ColorScheme = isRedUp ? "red_up_green_down" : "green_up_red_down";
  const p = PNL_PALETTES[palette] ?? PNL_PALETTES.default;
  const positive = scheme === "red_up_green_down" ? p.up : p.down;
  const negative = scheme === "red_up_green_down" ? p.down : p.up;
  if (n > 0) return invert ? negative : positive;
  if (n < 0) return invert ? positive : negative;
  return p.neutral;
}

/**
 * Fund amount sign colors (positive = green, negative = red, zero = gray),
 * for balances/amounts outside gain-loss contexts. Use pnlColor(n, scheme) for P&L.
 */
export function amountToneClass(value: number): string {
  if (value > 0) return "text-emerald-700";
  if (value < 0) return "text-rose-700";
  return "text-slate-500";
}

export type ImportPreviewAmountKind = "income" | "expense" | "transfer" | "investment" | string;
export type ImportPreviewFlowItem = {
  type?: ImportPreviewAmountKind | null;
  amount?: number | null;
  inflow?: number | null;
  outflow?: number | null;
  transferDirection?: string | null;
};

/**
 * The bill import preview shows fund direction, not whether a category is good or bad.
 * Income = inflow, expense = outflow; under red-up/green-down settings, expenses render green.
 */
export function importPreviewAmountColor(type: ImportPreviewAmountKind, scheme: ColorScheme): string {
  if (type === "income") return pnlColor(1, scheme);
  if (type === "expense") return pnlColor(-1, scheme);
  return pnlColor(0, scheme);
}

function positiveAmount(value: unknown) {
  const amount = Math.abs(Number(value ?? 0));
  return Number.isFinite(amount) ? amount : 0;
}

export function importPreviewFlowAmountKind(item: ImportPreviewFlowItem): ImportPreviewAmountKind {
  const inflow = positiveAmount(item.inflow);
  const outflow = positiveAmount(item.outflow);
  if (inflow > 0 && outflow <= 0) return "income";
  if (outflow > 0 && inflow <= 0) return "expense";
  if (item.transferDirection === "in") return "income";
  if (item.transferDirection === "out") return "expense";
  return item.type ?? "";
}

export function importPreviewFlowAmountTextFor(item: ImportPreviewFlowItem, direction: "inflow" | "outflow"): string {
  const directAmount = positiveAmount(direction === "inflow" ? item.inflow : item.outflow);
  if (directAmount > 0) return directAmount.toFixed(2);

  const kind = importPreviewFlowAmountKind(item);
  if ((direction === "inflow" && kind === "income") || (direction === "outflow" && kind === "expense")) {
    return positiveAmount(item.amount).toFixed(2);
  }
  return "-";
}

export function importPreviewFlowAmountColorFor(
  item: ImportPreviewFlowItem,
  direction: "inflow" | "outflow",
  scheme: ColorScheme,
): string {
  return importPreviewFlowAmountTextFor(item, direction) === "-"
    ? "text-slate-400"
    : importPreviewAmountColor(direction === "inflow" ? "income" : "expense", scheme);
}

/** Read the color scheme preference from the cookie header. */
export function getColorSchemeFromCookie(cookieHeader: string | null): ColorScheme {
  if (!cookieHeader) return "red_up_green_down";
  const match = cookieHeader.match(/colorScheme=([^;]+)/);
  if (match && (match[1] === "red_up_green_down" || match[1] === "green_up_red_down")) {
    return match[1] as ColorScheme;
  }
  return "red_up_green_down";
}
