export const ROW_HEIGHT_OPTIONS = [41, 39, 37, 35, 33, 31] as const;

export type RowHeightMode = (typeof ROW_HEIGHT_OPTIONS)[number];

export type RowHeightPreset = {
  height: RowHeightMode;
  content: number;
  padding: number;
};

export const DEFAULT_ROW_HEIGHT_MODE: RowHeightMode = 35;

// Row height equals content + vertical padding * 2 + the 1px cell border.
// Compact rows remain fixed inside AdvancedDataTable for import previews.
export const ROW_HEIGHT_PRESETS: Record<RowHeightMode, RowHeightPreset> = {
  41: { height: 41, content: 28, padding: 6 },
  39: { height: 39, content: 27, padding: 5 },
  37: { height: 37, content: 26, padding: 5 },
  35: { height: 35, content: 26, padding: 4 },
  33: { height: 33, content: 24, padding: 4 },
  31: { height: 31, content: 22, padding: 4 },
};

const LEGACY_ROW_HEIGHT_MODE_MAP: Record<string, RowHeightMode> = {
  large: 41,
  medium: 37,
  small: 35,
};

export function normalizeRowHeightMode(value: unknown): RowHeightMode {
  if (typeof value === "string") {
    const trimmed = value.trim();
    const legacy = LEGACY_ROW_HEIGHT_MODE_MAP[trimmed];
    if (legacy) return legacy;
    value = trimmed.toLowerCase().endsWith("px") ? trimmed.slice(0, -2) : trimmed;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return DEFAULT_ROW_HEIGHT_MODE;

  return ROW_HEIGHT_OPTIONS.reduce<RowHeightMode>((best, option) => {
    const bestDistance = Math.abs(best - numericValue);
    const optionDistance = Math.abs(option - numericValue);
    return optionDistance < bestDistance ? option : best;
  }, DEFAULT_ROW_HEIGHT_MODE);
}
