export const DEFAULT_EMAIL_IMPORT_KEYWORD = "\u8d26\u5355";
export const EMAIL_IMPORT_KEYWORD_SETTING_PREFIX = "email_import_keyword:";

export function emailImportKeywordSettingKey(householdId: string) {
  return `${EMAIL_IMPORT_KEYWORD_SETTING_PREFIX}${householdId}`;
}

export function normalizeEmailImportKeyword(value: unknown, options?: { fallbackToDefault?: boolean }) {
  const keyword = String(value ?? "").trim().replace(/\s+/g, " ");
  const normalized = keyword.slice(0, 40);
  return normalized || (options?.fallbackToDefault ? DEFAULT_EMAIL_IMPORT_KEYWORD : "");
}
