"use client";

import {
  DEFAULT_ACCOUNT_LABEL_FIELDS,
  DEFAULT_CREDIT_CARD_LABEL_TEMPLATE,
  FULL_NAME_CREDIT_CARD_LABEL_TEMPLATE,
  SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE,
  normalizeAccountLabelFields,
  normalizeCreditCardLabelTemplate,
  parseAccountLabelFields,
  serializeAccountLabelFields,
  type AccountLabelField,
} from "@/lib/account-display";
import {
  normalizeDateDisplayFormat,
  type DateDisplayFormat,
} from "@/lib/date-utils";
import {
  normalizeRowHeightMode,
  type RowHeightMode,
} from "@/lib/row-height";

export type { DateDisplayFormat } from "@/lib/date-utils";
export {
  DEFAULT_ROW_HEIGHT_MODE,
  ROW_HEIGHT_OPTIONS,
  ROW_HEIGHT_PRESETS,
  normalizeRowHeightMode,
} from "@/lib/row-height";
export type { RowHeightMode } from "@/lib/row-height";

export const SESSION_DAYS_COOKIE = "mmh_session_days";
export const FUND_UNITS_DECIMALS_COOKIE = "mmh_fund_units_decimals";
export const AI_PANEL_ENABLED_COOKIE = "mmh_ai_panel_enabled";
export const TIME_ZONE_MODE_COOKIE = "mmh_time_zone_mode";
export const TIME_ZONE_COOKIE = "mmh_time_zone";
export const CREDIT_CARD_LABEL_MODE_COOKIE = "mmh_credit_card_label_mode";
export const CREDIT_CARD_LABEL_TEMPLATE_COOKIE = "mmh_credit_card_label_template";
export const CREDIT_CARD_SIDEBAR_LABEL_TEMPLATE_COOKIE = "mmh_credit_card_sidebar_label_template";
export const CREDIT_BILL_HIDE_ZERO_COOKIE = "mmh_credit_hide_zero_bills";
export const CREDIT_BILL_HIDE_SETTLED_COOKIE = "mmh_credit_hide_settled_bills";
export const CREDIT_BILL_RECENT_CYCLES_COOKIE = "mmh_credit_recent_cycles";
export const DISPLAY_LANGUAGE_COOKIE = "mmh_display_language";
export const DATE_DISPLAY_FORMAT_COOKIE = "mmh_date_display_format";
export const SIDEBAR_GROUP_BY_KEY = "sidebar_group_by";
export const SIDEBAR_HIDE_ZERO_KEY = "sidebar_hide_zero";
export const SIDEBAR_HIDE_INITIAL_DATA_KEY = "sidebar_hide_initial_data";
export const SIDEBAR_SHOW_FIXED_ASSETS_KEY = "sidebar_show_fixed_assets";
export const DETAIL_DATE_BACKGROUND_KEY = "detail_date_background";
export const ROW_HEIGHT_MODE_KEY = "advanced_data_table_row_height_mode";
export const ACCOUNT_LABEL_FIELDS_COOKIE = "mmh_account_label_fields";
export const ACCOUNT_DROPDOWN_RESTRICT_TYPE_COOKIE = "mmh_account_dropdown_restrict_type";
export const SIDEBAR_COLLAPSED_KEY = "sidebar_collapsed";
export const SIDEBAR_OWNER_FILTER_KEY = "sidebar_owner_filter";
export const AI_PANEL_COLLAPSED_KEY = "mmh_ai_panel_collapsed";
export const APP_PREFS_EVENT = "mmh:app-preferences";

export type SidebarGroupMode = "kind" | "institution";
export type TimeZoneMode = "system" | "specified";
export type CreditCardLabelMode = "short_last4" | "full_name";
export type DisplayLanguage = "zh-CN" | "en-US" | "ja-JP";

export type AppPreferencesSnapshot = {
  sessionDays: number;
  fundUnitsDecimals: number;
  aiPanelEnabled: boolean;
  timeZoneMode: TimeZoneMode;
  timeZone: string;
  creditCardLabelMode: CreditCardLabelMode;
  creditCardLabelTemplate: string;
  creditCardSidebarLabelTemplate: string;
  creditBillHideZero: boolean;
  creditBillHideSettled: boolean;
  creditBillShowRecentCycles: boolean;
  displayLanguage: DisplayLanguage;
  dateDisplayFormat: DateDisplayFormat;
  sidebarGroupBy: SidebarGroupMode;
  sidebarOwnerFilter: string;
  sidebarHideZero: boolean;
  sidebarHideInitialData: boolean;
  sidebarShowFixedAssets: boolean;
  detailDateBackground: boolean;
  rowHeightMode: RowHeightMode;
  sidebarCollapsed: boolean;
  accountLabelFields: AccountLabelField[];
  accountDropdownRestrictType: boolean;
};

const DEFAULT_SESSION_DAYS = 30;
const DEFAULT_FUND_UNITS_DECIMALS = 2;
const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const DEFAULT_CREDIT_CARD_LABEL_MODE: CreditCardLabelMode = "short_last4";
const DEFAULT_DISPLAY_LANGUAGE: DisplayLanguage = "zh-CN";

function parseCookieValue(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookieValue(name: string, value: string) {
  if (typeof document === "undefined") return;
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

function emitPreferencesChanged() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(APP_PREFS_EVENT, { detail: getAppPreferences() }));
}

export function getSessionDaysPreference(): number {
  const raw = parseCookieValue(SESSION_DAYS_COOKIE);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SESSION_DAYS;
  return Math.min(Math.round(n), 365);
}

export function setSessionDaysPreference(days: number) {
  if (typeof document === "undefined") return;
  const normalized = Math.min(Math.max(Math.round(days), 1), 365);
  document.cookie = `${SESSION_DAYS_COOKIE}=${encodeURIComponent(String(normalized))}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  emitPreferencesChanged();
}

export function getFundUnitsDecimalsPreference(): number {
  const raw = parseCookieValue(FUND_UNITS_DECIMALS_COOKIE);
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_FUND_UNITS_DECIMALS;
  return Math.min(Math.max(Math.round(n), 0), 6);
}

export function setFundUnitsDecimalsPreference(decimals: number) {
  if (typeof document === "undefined") return;
  const normalized = Math.min(Math.max(Math.round(decimals), 0), 6);
  document.cookie = `${FUND_UNITS_DECIMALS_COOKIE}=${encodeURIComponent(String(normalized))}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  emitPreferencesChanged();
}

export function getAiPanelEnabledPreference(): boolean {
  const raw = parseCookieValue(AI_PANEL_ENABLED_COOKIE);
  return raw === null ? true : raw === "true" || raw === "1";
}

export function setAiPanelEnabledPreference(enabled: boolean) {
  if (typeof document === "undefined") return;
  document.cookie = `${AI_PANEL_ENABLED_COOKIE}=${encodeURIComponent(String(enabled))}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  emitPreferencesChanged();
}

export function getTimeZoneModePreference(): TimeZoneMode {
  return parseCookieValue(TIME_ZONE_MODE_COOKIE) === "specified" ? "specified" : "system";
}

export function getTimeZonePreference(): string {
  return parseCookieValue(TIME_ZONE_COOKIE) || DEFAULT_TIME_ZONE;
}

export function setTimeZonePreference(mode: TimeZoneMode, timeZone: string) {
  if (typeof document === "undefined") return;
  const normalizedMode = mode === "specified" ? "specified" : "system";
  const normalizedTimeZone = timeZone.trim() || DEFAULT_TIME_ZONE;
  document.cookie = `${TIME_ZONE_MODE_COOKIE}=${encodeURIComponent(normalizedMode)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(normalizedTimeZone)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  emitPreferencesChanged();
}

export function getCreditCardLabelModePreference(): CreditCardLabelMode {
  return parseCookieValue(CREDIT_CARD_LABEL_MODE_COOKIE) === "full_name" ? "full_name" : DEFAULT_CREDIT_CARD_LABEL_MODE;
}

export function setCreditCardLabelModePreference(mode: CreditCardLabelMode) {
  if (typeof document === "undefined") return;
  const normalized = mode === "full_name" ? "full_name" : DEFAULT_CREDIT_CARD_LABEL_MODE;
  document.cookie = `${CREDIT_CARD_LABEL_MODE_COOKIE}=${encodeURIComponent(normalized)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  document.cookie = `${CREDIT_CARD_LABEL_TEMPLATE_COOKIE}=${encodeURIComponent(
    normalized === "full_name" ? FULL_NAME_CREDIT_CARD_LABEL_TEMPLATE : DEFAULT_CREDIT_CARD_LABEL_TEMPLATE,
  )}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  emitPreferencesChanged();
}

export function getCreditCardLabelTemplatePreference(): string {
  const mode = getCreditCardLabelModePreference();
  return normalizeCreditCardLabelTemplate(parseCookieValue(CREDIT_CARD_LABEL_TEMPLATE_COOKIE), mode);
}

export function getCreditCardSidebarLabelTemplatePreference(): string {
  const value = parseCookieValue(CREDIT_CARD_SIDEBAR_LABEL_TEMPLATE_COOKIE);
  return value ? normalizeCreditCardLabelTemplate(value, "short_last4") : SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE;
}

export function setCreditCardLabelTemplatePreference(template: string) {
  if (typeof document === "undefined") return;
  const mode = getCreditCardLabelModePreference();
  const normalized = normalizeCreditCardLabelTemplate(template, mode);
  document.cookie = `${CREDIT_CARD_LABEL_TEMPLATE_COOKIE}=${encodeURIComponent(normalized)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  emitPreferencesChanged();
}

export function setCreditCardSidebarLabelTemplatePreference(template: string) {
  if (typeof document === "undefined") return;
  const normalized = normalizeCreditCardLabelTemplate(template || SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE, "short_last4");
  document.cookie = `${CREDIT_CARD_SIDEBAR_LABEL_TEMPLATE_COOKIE}=${encodeURIComponent(normalized)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  emitPreferencesChanged();
}

export function getCreditBillHideZeroPreference(): boolean {
  const raw = parseCookieValue(CREDIT_BILL_HIDE_ZERO_COOKIE);
  return raw === "1" || raw === "true";
}

export function setCreditBillHideZeroPreference(value: boolean) {
  if (typeof document === "undefined") return;
  setCookieValue(CREDIT_BILL_HIDE_ZERO_COOKIE, value ? "1" : "0");
  emitPreferencesChanged();
}

export function getCreditBillHideSettledPreference(): boolean {
  const raw = parseCookieValue(CREDIT_BILL_HIDE_SETTLED_COOKIE);
  return raw === "1" || raw === "true";
}

export function setCreditBillHideSettledPreference(value: boolean) {
  if (typeof document === "undefined") return;
  setCookieValue(CREDIT_BILL_HIDE_SETTLED_COOKIE, value ? "1" : "0");
  emitPreferencesChanged();
}

export function getCreditBillShowRecentCyclesPreference(): boolean {
  const raw = parseCookieValue(CREDIT_BILL_RECENT_CYCLES_COOKIE);
  if (raw == null) return true;
  return raw === "1" || raw === "true";
}

export function setCreditBillShowRecentCyclesPreference(value: boolean) {
  if (typeof document === "undefined") return;
  setCookieValue(CREDIT_BILL_RECENT_CYCLES_COOKIE, value ? "1" : "0");
  emitPreferencesChanged();
}

export function normalizeDisplayLanguage(value: unknown): DisplayLanguage {
  if (value === "en-US" || value === "ja-JP" || value === "zh-CN") return value;
  return DEFAULT_DISPLAY_LANGUAGE;
}

export function getDisplayLanguagePreference(): DisplayLanguage {
  return normalizeDisplayLanguage(parseCookieValue(DISPLAY_LANGUAGE_COOKIE));
}

export function getDateDisplayFormatPreference(): DateDisplayFormat {
  return normalizeDateDisplayFormat(parseCookieValue(DATE_DISPLAY_FORMAT_COOKIE));
}

export function setDateDisplayFormatPreference(value: DateDisplayFormat) {
  if (typeof document === "undefined") return;
  setCookieValue(DATE_DISPLAY_FORMAT_COOKIE, normalizeDateDisplayFormat(value));
  emitPreferencesChanged();
}

export function setDisplayLanguagePreference(value: DisplayLanguage) {
  if (typeof document === "undefined") return;
  setCookieValue(DISPLAY_LANGUAGE_COOKIE, normalizeDisplayLanguage(value));
  emitPreferencesChanged();
}

export function getSidebarGroupPreference(): SidebarGroupMode {
  try {
    const value = localStorage.getItem(SIDEBAR_GROUP_BY_KEY) ?? parseCookieValue(SIDEBAR_GROUP_BY_KEY);
    if (value === "institution") return "institution";
    return "kind";
  } catch {
    return parseCookieValue(SIDEBAR_GROUP_BY_KEY) === "institution" ? "institution" : "kind";
  }
}

export function setSidebarGroupPreference(mode: SidebarGroupMode) {
  try {
    localStorage.setItem(SIDEBAR_GROUP_BY_KEY, mode);
  } catch {}
  setCookieValue(SIDEBAR_GROUP_BY_KEY, mode);
  emitPreferencesChanged();
}

export function getSidebarOwnerFilterPreference(): string {
  try {
    return localStorage.getItem(SIDEBAR_OWNER_FILTER_KEY) ?? parseCookieValue(SIDEBAR_OWNER_FILTER_KEY) ?? "";
  } catch {
    return parseCookieValue(SIDEBAR_OWNER_FILTER_KEY) ?? "";
  }
}

export function setSidebarOwnerFilterPreference(value: string) {
  try {
    localStorage.setItem(SIDEBAR_OWNER_FILTER_KEY, value);
  } catch {}
  setCookieValue(SIDEBAR_OWNER_FILTER_KEY, value);
  emitPreferencesChanged();
}

export function getSidebarHideZeroPreference(): boolean {
  try {
    const value = localStorage.getItem(SIDEBAR_HIDE_ZERO_KEY) ?? parseCookieValue(SIDEBAR_HIDE_ZERO_KEY);
    return value === "true";
  } catch {
    return parseCookieValue(SIDEBAR_HIDE_ZERO_KEY) === "true";
  }
}

export function setSidebarHideZeroPreference(value: boolean) {
  try {
    localStorage.setItem(SIDEBAR_HIDE_ZERO_KEY, String(value));
  } catch {}
  setCookieValue(SIDEBAR_HIDE_ZERO_KEY, String(value));
  emitPreferencesChanged();
}

export function getSidebarHideInitialDataPreference(): boolean {
  try {
    const value = localStorage.getItem(SIDEBAR_HIDE_INITIAL_DATA_KEY) ?? parseCookieValue(SIDEBAR_HIDE_INITIAL_DATA_KEY);
    return value === "true";
  } catch {
    return parseCookieValue(SIDEBAR_HIDE_INITIAL_DATA_KEY) === "true";
  }
}

export function setSidebarHideInitialDataPreference(value: boolean) {
  try {
    localStorage.setItem(SIDEBAR_HIDE_INITIAL_DATA_KEY, String(value));
  } catch {}
  setCookieValue(SIDEBAR_HIDE_INITIAL_DATA_KEY, String(value));
  emitPreferencesChanged();
}

export function getSidebarShowFixedAssetsPreference(): boolean {
  try {
    const value = localStorage.getItem(SIDEBAR_SHOW_FIXED_ASSETS_KEY) ?? parseCookieValue(SIDEBAR_SHOW_FIXED_ASSETS_KEY);
    if (value == null) return true;
    return value === "true" || value === "1";
  } catch {
    const value = parseCookieValue(SIDEBAR_SHOW_FIXED_ASSETS_KEY);
    if (value == null) return true;
    return value === "true" || value === "1";
  }
}

export function setSidebarShowFixedAssetsPreference(value: boolean) {
  try {
    localStorage.setItem(SIDEBAR_SHOW_FIXED_ASSETS_KEY, String(value));
  } catch {}
  setCookieValue(SIDEBAR_SHOW_FIXED_ASSETS_KEY, String(value));
  emitPreferencesChanged();
}

export function getDetailDateBackgroundPreference(): boolean {
  try {
    const value = localStorage.getItem(DETAIL_DATE_BACKGROUND_KEY) ?? parseCookieValue(DETAIL_DATE_BACKGROUND_KEY);
    return value === "true" || value === "1";
  } catch {
    const value = parseCookieValue(DETAIL_DATE_BACKGROUND_KEY);
    return value === "true" || value === "1";
  }
}

export function setDetailDateBackgroundPreference(value: boolean) {
  try {
    localStorage.setItem(DETAIL_DATE_BACKGROUND_KEY, String(value));
  } catch {}
  setCookieValue(DETAIL_DATE_BACKGROUND_KEY, String(value));
  emitPreferencesChanged();
}

export function getRowHeightModePreference(): RowHeightMode {
  try {
    return normalizeRowHeightMode(
      localStorage.getItem(ROW_HEIGHT_MODE_KEY) ?? parseCookieValue(ROW_HEIGHT_MODE_KEY),
    );
  } catch {
    return normalizeRowHeightMode(parseCookieValue(ROW_HEIGHT_MODE_KEY));
  }
}

export function setRowHeightModePreference(value: RowHeightMode) {
  const normalized = normalizeRowHeightMode(value);
  try {
    localStorage.setItem(ROW_HEIGHT_MODE_KEY, String(normalized));
  } catch {}
  setCookieValue(ROW_HEIGHT_MODE_KEY, String(normalized));
  emitPreferencesChanged();
}

export function getSidebarCollapsedPreference(): boolean {
  try {
    const value = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) ?? parseCookieValue(SIDEBAR_COLLAPSED_KEY);
    return value === "true";
  } catch {
    return parseCookieValue(SIDEBAR_COLLAPSED_KEY) === "true";
  }
}

export function setSidebarCollapsedPreference(value: boolean) {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(value));
  } catch {}
  setCookieValue(SIDEBAR_COLLAPSED_KEY, String(value));
  emitPreferencesChanged();
}

export function getAiPanelCollapsedPreference(): boolean {
  try {
    const value = localStorage.getItem(AI_PANEL_COLLAPSED_KEY) ?? parseCookieValue(AI_PANEL_COLLAPSED_KEY);
    return value === "1" || value === "true";
  } catch {
    const value = parseCookieValue(AI_PANEL_COLLAPSED_KEY);
    return value === "1" || value === "true";
  }
}

export function setAiPanelCollapsedPreference(value: boolean) {
  try {
    localStorage.setItem(AI_PANEL_COLLAPSED_KEY, value ? "1" : "0");
  } catch {}
  setCookieValue(AI_PANEL_COLLAPSED_KEY, value ? "1" : "0");
}

export function getAccountLabelFieldsPreference(): AccountLabelField[] {
  const raw = parseCookieValue(ACCOUNT_LABEL_FIELDS_COOKIE);
  if (raw == null) return [...DEFAULT_ACCOUNT_LABEL_FIELDS];
  return parseAccountLabelFields(raw);
}

export function setAccountLabelFieldsPreference(fields: AccountLabelField[]) {
  const normalized = normalizeAccountLabelFields(fields);
  setCookieValue(ACCOUNT_LABEL_FIELDS_COOKIE, serializeAccountLabelFields(normalized));
  emitPreferencesChanged();
}

export function getAppPreferences(): AppPreferencesSnapshot {
  return {
    sessionDays: getSessionDaysPreference(),
    fundUnitsDecimals: getFundUnitsDecimalsPreference(),
    aiPanelEnabled: getAiPanelEnabledPreference(),
    timeZoneMode: getTimeZoneModePreference(),
    timeZone: getTimeZonePreference(),
    creditCardLabelMode: getCreditCardLabelModePreference(),
    creditCardLabelTemplate: getCreditCardLabelTemplatePreference(),
    creditCardSidebarLabelTemplate: getCreditCardSidebarLabelTemplatePreference(),
    creditBillHideZero: getCreditBillHideZeroPreference(),
    creditBillHideSettled: getCreditBillHideSettledPreference(),
    creditBillShowRecentCycles: getCreditBillShowRecentCyclesPreference(),
    displayLanguage: getDisplayLanguagePreference(),
    dateDisplayFormat: getDateDisplayFormatPreference(),
    sidebarGroupBy: getSidebarGroupPreference(),
    sidebarOwnerFilter: getSidebarOwnerFilterPreference(),
    sidebarHideZero: getSidebarHideZeroPreference(),
    sidebarHideInitialData: getSidebarHideInitialDataPreference(),
    sidebarShowFixedAssets: getSidebarShowFixedAssetsPreference(),
    detailDateBackground: getDetailDateBackgroundPreference(),
    rowHeightMode: getRowHeightModePreference(),
    sidebarCollapsed: getSidebarCollapsedPreference(),
    accountLabelFields: getAccountLabelFieldsPreference(),
    accountDropdownRestrictType: getAccountDropdownRestrictTypePreference(),
  };
}

const DEFAULT_ACCOUNT_DROPDOWN_RESTRICT_TYPE = true;

export function getAccountDropdownRestrictTypePreference(): boolean {
  try {
    const value = localStorage.getItem(ACCOUNT_DROPDOWN_RESTRICT_TYPE_COOKIE) ?? parseCookieValue(ACCOUNT_DROPDOWN_RESTRICT_TYPE_COOKIE);
    return value === "false" ? false : DEFAULT_ACCOUNT_DROPDOWN_RESTRICT_TYPE;
  } catch {
    return parseCookieValue(ACCOUNT_DROPDOWN_RESTRICT_TYPE_COOKIE) === "false" ? false : DEFAULT_ACCOUNT_DROPDOWN_RESTRICT_TYPE;
  }
}

export function setAccountDropdownRestrictTypePreference(value: boolean) {
  try {
    localStorage.setItem(ACCOUNT_DROPDOWN_RESTRICT_TYPE_COOKIE, String(value));
  } catch {}
  setCookieValue(ACCOUNT_DROPDOWN_RESTRICT_TYPE_COOKIE, String(value));
  emitPreferencesChanged();
}
