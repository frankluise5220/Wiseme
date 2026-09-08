/**
 * Shared helpers for the import templates exported by the app.
 *
 * Every exported template shares the same shape (see AccountBatchImportButton):
 * a header row, sample rows flagged in the 样板行 / Sample Row column, then a
 * field guide block that starts with a guide title row. Importers must skip the
 * flagged sample rows and everything from the guide title row downwards.
 */

const TEMPLATE_SAMPLE_HEADER_ALIASES = [
  "样板行",
  "樣板行",
  "samplerow",
  "sample row",
  "sample",
  "サンプル行",
];

const TEMPLATE_SAMPLE_ROW_VALUES = new Set([
  "yes",
  "y",
  "true",
  "1",
  "sample",
  "是",
  "はい",
  "樣板",
  "样板",
]);

function normalizeTemplateText(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeTemplateHeaderText(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, "").toLowerCase();
}

export function isTemplateSampleRowValue(value: unknown) {
  return TEMPLATE_SAMPLE_ROW_VALUES.has(normalizeTemplateText(value));
}

/** Column index of the 样板行 / Sample Row column, or -1 when absent. */
export function findTemplateSampleColumnIndex(headers: readonly unknown[]) {
  return headers.findIndex((header) =>
    TEMPLATE_SAMPLE_HEADER_ALIASES.includes(normalizeTemplateHeaderText(header)),
  );
}

export function isTemplateGuideTitleCell(value: unknown, guideTitle: string) {
  const title = normalizeTemplateText(guideTitle);
  if (!title) return false;
  return normalizeTemplateText(value).startsWith(title);
}

/** Row index of the guide title row, or -1 when the sheet has no guide block. */
export function findTemplateGuideTitleRowIndex(
  rows: ReadonlyArray<readonly unknown[]>,
  guideTitle: string,
) {
  if (!normalizeTemplateText(guideTitle)) return -1;
  return rows.findIndex((row) => row.some((cell) => isTemplateGuideTitleCell(cell, guideTitle)));
}

/** Drops rows flagged in the 样板行 column. Expects data rows (header excluded). */
export function dropTemplateSampleRows<T extends readonly unknown[]>(rows: T[], sampleColumnIndex: number) {
  if (sampleColumnIndex < 0) return rows;
  return rows.filter((row) => !isTemplateSampleRowValue(row[sampleColumnIndex]));
}

/** Keeps only the rows above the guide title row (the guide block is not data). */
export function rowsBeforeTemplateGuide<T>(rows: T[], guideTitleRowIndex: number) {
  return guideTitleRowIndex >= 0 ? rows.slice(0, guideTitleRowIndex) : rows;
}
