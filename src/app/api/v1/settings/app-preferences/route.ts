import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_ACCOUNT_LABEL_FIELDS,
  EMPTY_ACCOUNT_LABEL_FIELDS_VALUE,
  SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE,
  normalizeAccountLabelFields,
  normalizeCreditCardLabelTemplate,
  parseAccountLabelFields,
  serializeAccountLabelFields,
  type AccountLabelField,
} from "@/lib/account-display";
import { normalizeDateDisplayFormat } from "@/lib/date-utils";
import { normalizeRowHeightMode } from "@/lib/row-height";
import {
  HOUSEHOLD_COOKIE as HOUSEHOLD_KEY,
  SESSION_DAYS_COOKIE as SESSION_DAYS_KEY,
  USER_ID_COOKIE as USER_ID_KEY,
  USERNAME_COOKIE as USERNAME_KEY,
  VERIFIED_COOKIE as VERIFIED_KEY,
  createVerifiedSessionValue,
  sessionCookieOptions,
  verifyVerifiedSessionValue,
} from "@/lib/server/session-cookies";

/**
 * GET /api/v1/settings/app-preferences returns browser-scoped display preferences.
 * PUT /api/v1/settings/app-preferences accepts any subset of the returned fields and
 * persists them as cookies without changing ledger data or financial calculations.
 */
const FUND_UNITS_DECIMALS_KEY = "mmh_fund_units_decimals";
const AI_PANEL_ENABLED_KEY = "mmh_ai_panel_enabled";
const TIME_ZONE_MODE_KEY = "mmh_time_zone_mode";
const TIME_ZONE_KEY = "mmh_time_zone";
const CREDIT_CARD_LABEL_MODE_KEY = "mmh_credit_card_label_mode";
const CREDIT_CARD_LABEL_TEMPLATE_KEY = "mmh_credit_card_label_template";
const CREDIT_CARD_SIDEBAR_LABEL_TEMPLATE_KEY = "mmh_credit_card_sidebar_label_template";
const CREDIT_BILL_HIDE_ZERO_KEY = "mmh_credit_hide_zero_bills";
const CREDIT_BILL_HIDE_SETTLED_KEY = "mmh_credit_hide_settled_bills";
const CREDIT_BILL_RECENT_CYCLES_KEY = "mmh_credit_recent_cycles";
const DISPLAY_LANGUAGE_KEY = "mmh_display_language";
const DATE_DISPLAY_FORMAT_KEY = "mmh_date_display_format";
const SIDEBAR_HIDE_INITIAL_DATA_KEY = "sidebar_hide_initial_data";
const SIDEBAR_SHOW_FIXED_ASSETS_KEY = "sidebar_show_fixed_assets";
const DETAIL_DATE_BACKGROUND_KEY = "detail_date_background";
const ROW_HEIGHT_MODE_KEY = "advanced_data_table_row_height_mode";
const ACCOUNT_LABEL_FIELDS_KEY = "mmh_account_label_fields";
const ACCOUNT_DROPDOWN_RESTRICT_TYPE_KEY = "mmh_account_dropdown_restrict_type";

function normalizeSessionDays(input: unknown) {
  const n = Number(input);
  if (!Number.isFinite(n)) return 30;
  return Math.min(Math.max(Math.round(n), 1), 365);
}

function normalizeFundUnitsDecimals(input: unknown) {
  const n = Number(input);
  if (!Number.isFinite(n)) return 2;
  return Math.min(Math.max(Math.round(n), 0), 6);
}

function normalizeBoolean(input: unknown, fallback: boolean) {
  if (typeof input === "boolean") return input;
  if (typeof input === "string") {
    if (input === "true" || input === "1") return true;
    if (input === "false" || input === "0") return false;
  }
  return fallback;
}

function normalizeTimeZoneMode(input: unknown) {
  return input === "specified" ? "specified" : "system";
}

function normalizeTimeZone(input: unknown) {
  const value = String(input ?? "").trim();
  if (!value) return "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: value }).format(new Date());
    return value;
  } catch {
    return "Asia/Shanghai";
  }
}

function normalizeCreditCardLabelMode(input: unknown) {
  return input === "full_name" ? "full_name" : "short_last4";
}

function normalizeDisplayLanguage(input: unknown) {
  return input === "en-US" || input === "ja-JP" || input === "zh-CN" ? input : "zh-CN";
}

function normalizeAccountLabelFieldsPreference(input: unknown): AccountLabelField[] {
  if (Array.isArray(input)) {
    // An explicitly provided value wins even when it is empty: the user may
    // want to strip the label down to the raw account name.
    return normalizeAccountLabelFields(input, []);
  }
  if (typeof input === "string") {
    const value = input.trim();
    if (!value) return [];
    if (value === EMPTY_ACCOUNT_LABEL_FIELDS_VALUE) return [];
    return parseAccountLabelFields(value);
  }
  if (input === null) return [];
  return [...DEFAULT_ACCOUNT_LABEL_FIELDS];
}

function accountLabelFieldsFromPreferenceCookie(value: string | undefined): AccountLabelField[] {
  if (value === undefined) return [...DEFAULT_ACCOUNT_LABEL_FIELDS];
  return parseAccountLabelFields(value);
}

export async function GET(req: NextRequest) {
  const sessionDays = normalizeSessionDays(req.cookies.get(SESSION_DAYS_KEY)?.value ?? 30);
  const fundUnitsDecimals = normalizeFundUnitsDecimals(req.cookies.get(FUND_UNITS_DECIMALS_KEY)?.value ?? 2);
  const aiPanelEnabled = normalizeBoolean(req.cookies.get(AI_PANEL_ENABLED_KEY)?.value, true);
  const timeZoneMode = normalizeTimeZoneMode(req.cookies.get(TIME_ZONE_MODE_KEY)?.value);
  const timeZone = normalizeTimeZone(req.cookies.get(TIME_ZONE_KEY)?.value);
  const creditCardLabelMode = normalizeCreditCardLabelMode(req.cookies.get(CREDIT_CARD_LABEL_MODE_KEY)?.value);
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    req.cookies.get(CREDIT_CARD_LABEL_TEMPLATE_KEY)?.value,
    creditCardLabelMode,
  );
  const creditCardSidebarLabelTemplate = normalizeCreditCardLabelTemplate(
    req.cookies.get(CREDIT_CARD_SIDEBAR_LABEL_TEMPLATE_KEY)?.value || SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE,
    "short_last4",
  );
  const creditBillHideZero = normalizeBoolean(req.cookies.get(CREDIT_BILL_HIDE_ZERO_KEY)?.value, false);
  const creditBillHideSettled = normalizeBoolean(req.cookies.get(CREDIT_BILL_HIDE_SETTLED_KEY)?.value, false);
  const creditBillShowRecentCycles = normalizeBoolean(req.cookies.get(CREDIT_BILL_RECENT_CYCLES_KEY)?.value, true);
  const displayLanguage = normalizeDisplayLanguage(req.cookies.get(DISPLAY_LANGUAGE_KEY)?.value);
  const dateDisplayFormat = normalizeDateDisplayFormat(req.cookies.get(DATE_DISPLAY_FORMAT_KEY)?.value);
  const sidebarHideInitialData = normalizeBoolean(req.cookies.get(SIDEBAR_HIDE_INITIAL_DATA_KEY)?.value, false);
  const sidebarShowFixedAssets = normalizeBoolean(req.cookies.get(SIDEBAR_SHOW_FIXED_ASSETS_KEY)?.value, true);
  const detailDateBackground = normalizeBoolean(req.cookies.get(DETAIL_DATE_BACKGROUND_KEY)?.value, false);
  const rowHeightMode = normalizeRowHeightMode(req.cookies.get(ROW_HEIGHT_MODE_KEY)?.value);
  const accountLabelFields = accountLabelFieldsFromPreferenceCookie(req.cookies.get(ACCOUNT_LABEL_FIELDS_KEY)?.value);
  const accountDropdownRestrictType = normalizeBoolean(req.cookies.get(ACCOUNT_DROPDOWN_RESTRICT_TYPE_KEY)?.value, true);
  return NextResponse.json({
    ok: true,
    sessionDays,
    fundUnitsDecimals,
    aiPanelEnabled,
    timeZoneMode,
    timeZone,
    creditCardLabelMode,
    creditCardLabelTemplate,
    creditCardSidebarLabelTemplate,
    creditBillHideZero,
    creditBillHideSettled,
    creditBillShowRecentCycles,
    displayLanguage,
    dateDisplayFormat,
    sidebarHideInitialData,
    sidebarShowFixedAssets,
    detailDateBackground,
    rowHeightMode,
    accountLabelFields,
    accountDropdownRestrictType,
  });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const prefs = body && typeof body === "object" ? body as {
    sessionDays?: unknown;
    fundUnitsDecimals?: unknown;
    aiPanelEnabled?: unknown;
    timeZoneMode?: unknown;
    timeZone?: unknown;
    creditCardLabelMode?: unknown;
    creditCardLabelTemplate?: unknown;
    creditCardSidebarLabelTemplate?: unknown;
    creditBillHideZero?: unknown;
    creditBillHideSettled?: unknown;
    creditBillShowRecentCycles?: unknown;
    displayLanguage?: unknown;
    dateDisplayFormat?: unknown;
    sidebarHideInitialData?: unknown;
    sidebarShowFixedAssets?: unknown;
    detailDateBackground?: unknown;
    rowHeightMode?: unknown;
    accountLabelFields?: unknown;
    accountDropdownRestrictType?: unknown;
  } : {};
  const hasSessionDays = Object.prototype.hasOwnProperty.call(prefs, "sessionDays");
  const hasFundUnitsDecimals = Object.prototype.hasOwnProperty.call(prefs, "fundUnitsDecimals");
  const hasAiPanelEnabled = Object.prototype.hasOwnProperty.call(prefs, "aiPanelEnabled");
  const hasTimeZoneMode = Object.prototype.hasOwnProperty.call(prefs, "timeZoneMode");
  const hasTimeZone = Object.prototype.hasOwnProperty.call(prefs, "timeZone");
  const hasCreditCardLabelMode = Object.prototype.hasOwnProperty.call(prefs, "creditCardLabelMode");
  const hasCreditCardLabelTemplate = Object.prototype.hasOwnProperty.call(prefs, "creditCardLabelTemplate");
  const hasCreditCardSidebarLabelTemplate = Object.prototype.hasOwnProperty.call(prefs, "creditCardSidebarLabelTemplate");
  const hasCreditBillHideZero = Object.prototype.hasOwnProperty.call(prefs, "creditBillHideZero");
  const hasCreditBillHideSettled = Object.prototype.hasOwnProperty.call(prefs, "creditBillHideSettled");
  const hasCreditBillShowRecentCycles = Object.prototype.hasOwnProperty.call(prefs, "creditBillShowRecentCycles");
  const hasDisplayLanguage = Object.prototype.hasOwnProperty.call(prefs, "displayLanguage");
  const hasDateDisplayFormat = Object.prototype.hasOwnProperty.call(prefs, "dateDisplayFormat");
  const hasSidebarHideInitialData = Object.prototype.hasOwnProperty.call(prefs, "sidebarHideInitialData");
  const hasSidebarShowFixedAssets = Object.prototype.hasOwnProperty.call(prefs, "sidebarShowFixedAssets");
  const hasDetailDateBackground = Object.prototype.hasOwnProperty.call(prefs, "detailDateBackground");
  const hasRowHeightMode = Object.prototype.hasOwnProperty.call(prefs, "rowHeightMode");
  const hasAccountLabelFields = Object.prototype.hasOwnProperty.call(prefs, "accountLabelFields");
  const hasAccountDropdownRestrictType = Object.prototype.hasOwnProperty.call(prefs, "accountDropdownRestrictType");
  const sessionDays = normalizeSessionDays(hasSessionDays ? prefs.sessionDays : req.cookies.get(SESSION_DAYS_KEY)?.value ?? 30);
  const fundUnitsDecimals = normalizeFundUnitsDecimals(hasFundUnitsDecimals ? prefs.fundUnitsDecimals : req.cookies.get(FUND_UNITS_DECIMALS_KEY)?.value ?? 2);
  const aiPanelEnabled = normalizeBoolean(hasAiPanelEnabled ? prefs.aiPanelEnabled : req.cookies.get(AI_PANEL_ENABLED_KEY)?.value, true);
  const timeZoneMode = normalizeTimeZoneMode(hasTimeZoneMode ? prefs.timeZoneMode : req.cookies.get(TIME_ZONE_MODE_KEY)?.value);
  const timeZone = normalizeTimeZone(hasTimeZone ? prefs.timeZone : req.cookies.get(TIME_ZONE_KEY)?.value);
  const creditCardLabelMode = normalizeCreditCardLabelMode(hasCreditCardLabelMode ? prefs.creditCardLabelMode : req.cookies.get(CREDIT_CARD_LABEL_MODE_KEY)?.value);
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    hasCreditCardLabelTemplate ? prefs.creditCardLabelTemplate : req.cookies.get(CREDIT_CARD_LABEL_TEMPLATE_KEY)?.value,
    creditCardLabelMode,
  );
  const creditCardSidebarLabelTemplate = normalizeCreditCardLabelTemplate(
    hasCreditCardSidebarLabelTemplate
      ? prefs.creditCardSidebarLabelTemplate
      : req.cookies.get(CREDIT_CARD_SIDEBAR_LABEL_TEMPLATE_KEY)?.value || SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE,
    "short_last4",
  );
  const creditBillHideZero = normalizeBoolean(
    hasCreditBillHideZero ? prefs.creditBillHideZero : req.cookies.get(CREDIT_BILL_HIDE_ZERO_KEY)?.value,
    false,
  );
  const creditBillHideSettled = normalizeBoolean(
    hasCreditBillHideSettled ? prefs.creditBillHideSettled : req.cookies.get(CREDIT_BILL_HIDE_SETTLED_KEY)?.value,
    false,
  );
  const creditBillShowRecentCycles = normalizeBoolean(
    hasCreditBillShowRecentCycles ? prefs.creditBillShowRecentCycles : req.cookies.get(CREDIT_BILL_RECENT_CYCLES_KEY)?.value,
    true,
  );
  const displayLanguage = normalizeDisplayLanguage(
    hasDisplayLanguage ? prefs.displayLanguage : req.cookies.get(DISPLAY_LANGUAGE_KEY)?.value,
  );
  const dateDisplayFormat = normalizeDateDisplayFormat(
    hasDateDisplayFormat ? prefs.dateDisplayFormat : req.cookies.get(DATE_DISPLAY_FORMAT_KEY)?.value,
  );
  const sidebarHideInitialData = normalizeBoolean(
    hasSidebarHideInitialData ? prefs.sidebarHideInitialData : req.cookies.get(SIDEBAR_HIDE_INITIAL_DATA_KEY)?.value,
    false,
  );
  const sidebarShowFixedAssets = normalizeBoolean(
    hasSidebarShowFixedAssets ? prefs.sidebarShowFixedAssets : req.cookies.get(SIDEBAR_SHOW_FIXED_ASSETS_KEY)?.value,
    true,
  );
  const detailDateBackground = normalizeBoolean(
    hasDetailDateBackground ? prefs.detailDateBackground : req.cookies.get(DETAIL_DATE_BACKGROUND_KEY)?.value,
    false,
  );
  const rowHeightMode = normalizeRowHeightMode(
    hasRowHeightMode ? prefs.rowHeightMode : req.cookies.get(ROW_HEIGHT_MODE_KEY)?.value,
  );
  const accountLabelFields = hasAccountLabelFields
    ? normalizeAccountLabelFieldsPreference(prefs.accountLabelFields)
    : accountLabelFieldsFromPreferenceCookie(req.cookies.get(ACCOUNT_LABEL_FIELDS_KEY)?.value);
  const accountDropdownRestrictType = normalizeBoolean(
    hasAccountDropdownRestrictType
      ? prefs.accountDropdownRestrictType
      : req.cookies.get(ACCOUNT_DROPDOWN_RESTRICT_TYPE_KEY)?.value,
    true,
  );
  const maxAge = sessionDays * 24 * 60 * 60;

  const response = NextResponse.json({
    ok: true,
    sessionDays,
    fundUnitsDecimals,
    aiPanelEnabled,
    timeZoneMode,
    timeZone,
    creditCardLabelMode,
    creditCardLabelTemplate,
    creditCardSidebarLabelTemplate,
    creditBillHideZero,
    creditBillHideSettled,
    creditBillShowRecentCycles,
    displayLanguage,
    dateDisplayFormat,
    sidebarHideInitialData,
    sidebarShowFixedAssets,
    detailDateBackground,
    rowHeightMode,
    accountLabelFields,
    accountDropdownRestrictType,
  });
  response.cookies.set(SESSION_DAYS_KEY, String(sessionDays), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(FUND_UNITS_DECIMALS_KEY, String(fundUnitsDecimals), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(AI_PANEL_ENABLED_KEY, String(aiPanelEnabled), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(TIME_ZONE_MODE_KEY, timeZoneMode, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(TIME_ZONE_KEY, timeZone, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(CREDIT_CARD_LABEL_MODE_KEY, creditCardLabelMode, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(CREDIT_CARD_LABEL_TEMPLATE_KEY, creditCardLabelTemplate, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(CREDIT_CARD_SIDEBAR_LABEL_TEMPLATE_KEY, creditCardSidebarLabelTemplate, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(CREDIT_BILL_HIDE_ZERO_KEY, creditBillHideZero ? "1" : "0", {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(CREDIT_BILL_HIDE_SETTLED_KEY, creditBillHideSettled ? "1" : "0", {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(CREDIT_BILL_RECENT_CYCLES_KEY, creditBillShowRecentCycles ? "1" : "0", {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(DISPLAY_LANGUAGE_KEY, displayLanguage, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(DATE_DISPLAY_FORMAT_KEY, dateDisplayFormat, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(SIDEBAR_HIDE_INITIAL_DATA_KEY, String(sidebarHideInitialData), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(SIDEBAR_SHOW_FIXED_ASSETS_KEY, String(sidebarShowFixedAssets), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(DETAIL_DATE_BACKGROUND_KEY, String(detailDateBackground), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(ROW_HEIGHT_MODE_KEY, String(rowHeightMode), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(ACCOUNT_LABEL_FIELDS_KEY, serializeAccountLabelFields(accountLabelFields), {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });
  response.cookies.set(ACCOUNT_DROPDOWN_RESTRICT_TYPE_KEY, accountDropdownRestrictType ? "1" : "0", {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: false,
    sameSite: "lax",
  });

  const verified = req.cookies.get(VERIFIED_KEY)?.value;
  const userId = req.cookies.get(USER_ID_KEY)?.value;
  const username = req.cookies.get(USERNAME_KEY)?.value;
  const householdId = req.cookies.get(HOUSEHOLD_KEY)?.value;
  const verifiedSession = verifyVerifiedSessionValue(verified, userId);
  const authCookieOptions = sessionCookieOptions(maxAge, req);
  if (verifiedSession.ok) {
    response.cookies.set(VERIFIED_KEY, createVerifiedSessionValue(verifiedSession.userId, maxAge), authCookieOptions);
  }
  if (userId) {
    response.cookies.set(USER_ID_KEY, userId, authCookieOptions);
  }
  if (username) {
    response.cookies.set(USERNAME_KEY, username, authCookieOptions);
  }
  if (householdId) {
    response.cookies.set(HOUSEHOLD_KEY, householdId, authCookieOptions);
  }

  return response;
}
