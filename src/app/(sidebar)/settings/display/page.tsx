"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import {
  DEFAULT_ACCOUNT_LABEL_FIELDS,
  normalizeAccountLabelFields,
  renderAccountLabel,
  type AccountLabelField,
} from "@/lib/account-display";
import {
  getAccountLabelFieldsPreference,
  getAccountDropdownRestrictTypePreference,
  getDetailDateBackgroundPreference,
  getDateDisplayFormatPreference,
  getDisplayLanguagePreference,
  getSidebarGroupPreference,
  getSidebarHideInitialDataPreference,
  getSidebarHideZeroPreference,
  getSidebarShowFixedAssetsPreference,
  getTimeZoneModePreference,
  getTimeZonePreference,
  DEFAULT_ROW_HEIGHT_MODE,
  ROW_HEIGHT_OPTIONS,
  getRowHeightModePreference,
  normalizeRowHeightMode,
  setAccountLabelFieldsPreference,
  setAccountDropdownRestrictTypePreference,
  setRowHeightModePreference,
  setDetailDateBackgroundPreference,
  setDateDisplayFormatPreference,
  setDisplayLanguagePreference,
  setSidebarGroupPreference,
  setSidebarHideInitialDataPreference,
  setSidebarHideZeroPreference,
  setSidebarShowFixedAssetsPreference,
  setTimeZonePreference,
  type DisplayLanguage,
  type DateDisplayFormat,
  type RowHeightMode,
  type SidebarGroupMode,
  type TimeZoneMode,
} from "@/lib/client/appPreferences";
import { kindLabel } from "@/lib/account-kinds";
import { CurrencySmartSelect } from "@/components/CurrencySmartSelect";
import { useI18n } from "@/lib/i18n";
import { GripVertical, X } from "lucide-react";

type ColorScheme = "red_up_green_down" | "green_up_red_down";

function buildTimeZoneOptions(t: (key: string) => string) {
  return [
    { value: "Asia/Shanghai", label: t("settings.display.timezone.beijing") },
    { value: "Asia/Hong_Kong", label: t("settings.display.timezone.hongKong") },
    { value: "Asia/Tokyo", label: t("settings.display.timezone.tokyo") },
    { value: "Europe/London", label: t("settings.display.timezone.london") },
    { value: "America/New_York", label: t("settings.display.timezone.newYork") },
    { value: "America/Los_Angeles", label: t("settings.display.timezone.losAngeles") },
  ];
}

const DISPLAY_LANGUAGE_OPTIONS: ReadonlyArray<{ value: DisplayLanguage; labelKey: string }> = [
  { value: "zh-CN", labelKey: "settings.display.language.zhCN" },
  { value: "en-US", labelKey: "settings.display.language.enUS" },
  { value: "ja-JP", labelKey: "settings.display.language.jaJP" },
];

const DATE_DISPLAY_FORMAT_OPTIONS: ReadonlyArray<{ value: DateDisplayFormat; labelKey: string }> = [
  { value: "yyyy-mm-dd", labelKey: "settings.display.dateFormat.yyyyMmDd" },
  { value: "yyyy/mm/dd", labelKey: "settings.display.dateFormat.yyyySlashMmSlashDd" },
  { value: "mm/dd/yyyy", labelKey: "settings.display.dateFormat.mmDdYyyy" },
  { value: "dd/mm/yyyy", labelKey: "settings.display.dateFormat.ddMmYyyy" },
];

const ACCOUNT_LABEL_FIELD_OPTIONS: ReadonlyArray<{ value: AccountLabelField; labelKey: string }> = [
  { value: "owner", labelKey: "settings.display.accountFormatField.owner" },
  { value: "institution", labelKey: "settings.display.accountFormatField.institution" },
  { value: "institutionShort", labelKey: "settings.display.accountFormatField.institutionShort" },
  { value: "name", labelKey: "settings.display.accountFormatField.name" },
  { value: "last4", labelKey: "settings.display.accountFormatField.last4" },
  { value: "kind", labelKey: "settings.display.accountFormatField.kind" },
];

const ACCOUNT_FORMAT_PREVIEW_SAMPLES = [
  {
    id: "debit",
    labelKey: "settings.display.accountFormatSampleDebit",
    ownerName: "\u5f20\u56db",
    institution: { name: "\u62db\u5546\u94f6\u884c", shortName: "\u62db\u884c" },
    accountName: "\u4e00\u5361\u901a",
    numberMasked: "8333",
    kind: "bank_debit",
  },
  {
    id: "fund",
    labelKey: "settings.display.accountFormatSampleFund",
    ownerName: "\u5f20\u56db",
    institution: { name: "\u62db\u5546\u94f6\u884c", shortName: "\u62db\u884c" },
    accountName: "\u62db\u5546\u94f6\u884c\u57fa\u91d1\u00b7\u5f00\u653e\u5f0f\u57fa\u91d1",
    numberMasked: "",
    kind: "investment",
  },
] as const;

function getColorSchemePreference(): ColorScheme {
  if (typeof document === "undefined") return "red_up_green_down";
  const match = document.cookie.match(/(?:^|; )colorScheme=([^;]*)/);
  const value = match ? decodeURIComponent(match[1]) : "";
  return value === "green_up_red_down" ? "green_up_red_down" : "red_up_green_down";
}

function setColorSchemePreference(value: ColorScheme) {
  if (typeof document === "undefined") return;
  document.cookie = `colorScheme=${encodeURIComponent(value)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
}

function SettingRow({
  title,
  desc,
  children,
  wide = false,
  hideDesc = false,
}: {
  title: string;
  desc: string;
  children: ReactNode;
  wide?: boolean;
  hideDesc?: boolean;
}) {
  const showDesc = Boolean(desc) && !hideDesc;

  return (
    <div
      className="flex flex-col gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 lg:flex-row lg:items-center lg:justify-between"
      title={hideDesc ? desc : undefined}
    >
      <div className="min-w-0 lg:w-56 lg:shrink-0">
        <div className="text-sm font-medium text-slate-800">{title}</div>
        {showDesc ? <div className="mt-1 text-xs text-slate-500">{desc}</div> : null}
      </div>
      <div className={wide ? "min-w-0 flex-1 lg:max-w-none" : "min-w-0 lg:min-w-[280px] lg:max-w-xl"}>
        {children}
      </div>
    </div>
  );
}

export default function DisplaySettingsPage() {
  const { t, language: currentLanguage } = useI18n();
  const router = useRouter();
  const [scheme, setScheme] = useState<ColorScheme>("red_up_green_down");
  const [displayLanguage, setDisplayLanguage] = useState<DisplayLanguage>(currentLanguage);
  const [dateDisplayFormat, setDateDisplayFormat] = useState<DateDisplayFormat>("yyyy-mm-dd");
  const [baseCurrency, setBaseCurrency] = useState("CNY");
  const [timeZoneMode, setTimeZoneMode] = useState<TimeZoneMode>("system");
  const [timeZone, setTimeZone] = useState("Asia/Shanghai");
  const [accountLabelFields, setAccountLabelFieldsState] = useState<AccountLabelField[]>(DEFAULT_ACCOUNT_LABEL_FIELDS);
  const [sidebarGroupBy, setSidebarGroupBy] = useState<SidebarGroupMode>("kind");
  const [sidebarHideZero, setSidebarHideZero] = useState(false);
  const [sidebarHideInitialData, setSidebarHideInitialData] = useState(false);
  const [sidebarShowFixedAssets, setSidebarShowFixedAssets] = useState(true);
  const [detailDateBackground, setDetailDateBackground] = useState(false);
  const [accountDropdownRestrictType, setAccountDropdownRestrictType] = useState(true);
  const [rowHeightMode, setRowHeightMode] = useState<RowHeightMode>(DEFAULT_ROW_HEIGHT_MODE);
  const [savingScheme, setSavingScheme] = useState(false);
  const [savingBaseCurrency, setSavingBaseCurrency] = useState(false);
  const [savingTimeZone, setSavingTimeZone] = useState(false);
  const [savingDisplayLanguage, setSavingDisplayLanguage] = useState(false);
  const [savingDateDisplayFormat, setSavingDateDisplayFormat] = useState(false);
  const [savingAccountLabelFields, setSavingAccountLabelFields] = useState(false);
  const [draggingAccountLabelField, setDraggingAccountLabelField] = useState<AccountLabelField | null>(null);
  const [dragOverAccountLabelField, setDragOverAccountLabelField] = useState<AccountLabelField | null>(null);

  useEffect(() => {
    const colorScheme = getColorSchemePreference();
    setScheme(colorScheme);
    setSidebarGroupBy(getSidebarGroupPreference());
    setSidebarHideZero(getSidebarHideZeroPreference());
    setSidebarHideInitialData(getSidebarHideInitialDataPreference());
    setSidebarShowFixedAssets(getSidebarShowFixedAssetsPreference());
    setDetailDateBackground(getDetailDateBackgroundPreference());
    setAccountDropdownRestrictType(getAccountDropdownRestrictTypePreference());
    setRowHeightMode(getRowHeightModePreference());
    setDisplayLanguage(getDisplayLanguagePreference());
    setDateDisplayFormat(getDateDisplayFormatPreference());
    setTimeZoneMode(getTimeZoneModePreference());
    setTimeZone(getTimeZonePreference());
    setAccountLabelFieldsState(getAccountLabelFieldsPreference());
  }, []);

  async function loadBaseCurrency() {
    try {
      const res = await fetch("/api/v1/fx-rates", { cache: "no-store" });
      const data = await res.json();
      if (data.baseCurrency) setBaseCurrency(String(data.baseCurrency).toUpperCase());
    } catch {
      // Display settings can still render with the default currency if this read fails.
    }
  }

  useEffect(() => {
    void loadBaseCurrency();
  }, []);

  async function saveScheme(next: ColorScheme) {
    const prev = scheme;
    setScheme(next);
    setColorSchemePreference(next);
    setSavingScheme(true);
    try {
      const res = await fetch("/api/v1/settings/color-scheme", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ colorScheme: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setScheme(prev);
        setColorSchemePreference(prev);
      } else {
        const saved = data.colorScheme === "green_up_red_down" ? "green_up_red_down" : "red_up_green_down";
        setScheme(saved);
        setColorSchemePreference(saved);
        router.refresh();
      }
    } catch {
      setScheme(prev);
      setColorSchemePreference(prev);
    } finally {
      setSavingScheme(false);
    }
  }

  async function saveDisplayLanguage(next: DisplayLanguage) {
    const prev = displayLanguage;
    setDisplayLanguage(next);
    setDisplayLanguagePreference(next);
    setSavingDisplayLanguage(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayLanguage: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setDisplayLanguage(prev);
        setDisplayLanguagePreference(prev);
      } else {
        // Server components render with getServerT() from the cookie, so
        // re-render the current route so server-translated copy catches up to
        // the client text right away.
        router.refresh();
      }
    } catch {
      setDisplayLanguage(prev);
      setDisplayLanguagePreference(prev);
    } finally {
      setSavingDisplayLanguage(false);
    }
  }

  async function saveDateDisplayFormat(next: DateDisplayFormat) {
    const prev = dateDisplayFormat;
    setDateDisplayFormat(next);
    setDateDisplayFormatPreference(next);
    setSavingDateDisplayFormat(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dateDisplayFormat: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setDateDisplayFormat(prev);
        setDateDisplayFormatPreference(prev);
      } else if (data.dateDisplayFormat) {
        setDateDisplayFormat(data.dateDisplayFormat as DateDisplayFormat);
        setDateDisplayFormatPreference(data.dateDisplayFormat as DateDisplayFormat);
        router.refresh();
      }
    } catch {
      setDateDisplayFormat(prev);
      setDateDisplayFormatPreference(prev);
    } finally {
      setSavingDateDisplayFormat(false);
    }
  }

  async function saveBaseCurrency(next: string) {
    const normalized = next.toUpperCase();
    const prev = baseCurrency;
    setBaseCurrency(normalized);
    setSavingBaseCurrency(true);
    try {
      const res = await fetch("/api/v1/fx-rates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseCurrency: normalized }),
      });
      const data = await res.json();
      if (!data?.ok) {
        setBaseCurrency(prev);
      } else if (data.baseCurrency) {
        setBaseCurrency(String(data.baseCurrency).toUpperCase());
      }
    } catch {
      setBaseCurrency(prev);
    } finally {
      setSavingBaseCurrency(false);
    }
  }

  async function saveTimeZone(nextMode: TimeZoneMode, nextTimeZone: string) {
    const prevMode = timeZoneMode;
    const prevTimeZone = timeZone;
    setTimeZoneMode(nextMode);
    setTimeZone(nextTimeZone);
    setTimeZonePreference(nextMode, nextTimeZone);
    setSavingTimeZone(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeZoneMode: nextMode, timeZone: nextTimeZone }),
      });
      const data = await res.json();
      if (!data.ok) {
        setTimeZoneMode(prevMode);
        setTimeZone(prevTimeZone);
        setTimeZonePreference(prevMode, prevTimeZone);
      }
    } catch {
      setTimeZoneMode(prevMode);
      setTimeZone(prevTimeZone);
      setTimeZonePreference(prevMode, prevTimeZone);
    } finally {
      setSavingTimeZone(false);
    }
  }

  async function saveAccountLabelFields(next: AccountLabelField[]) {
    const normalized = normalizeAccountLabelFields(next);
    const prev = accountLabelFields;
    setAccountLabelFieldsState(normalized);
    setAccountLabelFieldsPreference(normalized);
    setSavingAccountLabelFields(true);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountLabelFields: normalized }),
      });
      const data = await res.json();
      if (!data.ok) {
        setAccountLabelFieldsState(prev);
        setAccountLabelFieldsPreference(prev);
      } else if (Array.isArray(data.accountLabelFields)) {
        const saved = normalizeAccountLabelFields(data.accountLabelFields);
        setAccountLabelFieldsState(saved);
        setAccountLabelFieldsPreference(saved);
        // Account labels are rendered on the server from this preference, so
        // re-render the current route to apply the new format everywhere.
        router.refresh();
      }
    } catch {
      setAccountLabelFieldsState(prev);
      setAccountLabelFieldsPreference(prev);
    } finally {
      setSavingAccountLabelFields(false);
    }
  }

  function toggleAccountLabelField(field: AccountLabelField) {
    const next = accountLabelFields.includes(field)
      ? accountLabelFields.filter((item) => item !== field)
      : [...accountLabelFields, field];
    void saveAccountLabelFields(next);
  }

  /**
   * Moves a selected field onto another one's slot. Dropping a field onto its
   * own chip is a no-op, so an accidental short drag cannot reorder anything.
   */
  function reorderAccountLabelFields(from: AccountLabelField, to: AccountLabelField) {
    if (from === to) return;
    const fromIndex = accountLabelFields.indexOf(from);
    const toIndex = accountLabelFields.indexOf(to);
    if (fromIndex < 0 || toIndex < 0) return;
    const next = [...accountLabelFields];
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, from);
    void saveAccountLabelFields(next);
  }

  function clearAccountLabelDragState() {
    setDraggingAccountLabelField(null);
    setDragOverAccountLabelField(null);
  }

  function updateSidebarGroup(next: SidebarGroupMode) {
    setSidebarGroupBy(next);
    setSidebarGroupPreference(next);
  }

  function updateSidebarHideZero(next: boolean) {
    setSidebarHideZero(next);
    setSidebarHideZeroPreference(next);
  }

  async function updateSidebarHideInitialData(next: boolean) {
    const prev = sidebarHideInitialData;
    setSidebarHideInitialData(next);
    setSidebarHideInitialDataPreference(next);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sidebarHideInitialData: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSidebarHideInitialData(prev);
        setSidebarHideInitialDataPreference(prev);
      }
    } catch {
      setSidebarHideInitialData(prev);
      setSidebarHideInitialDataPreference(prev);
    }
  }

  async function updateSidebarShowFixedAssets(next: boolean) {
    const prev = sidebarShowFixedAssets;
    setSidebarShowFixedAssets(next);
    setSidebarShowFixedAssetsPreference(next);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sidebarShowFixedAssets: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSidebarShowFixedAssets(prev);
        setSidebarShowFixedAssetsPreference(prev);
      }
    } catch {
      setSidebarShowFixedAssets(prev);
      setSidebarShowFixedAssetsPreference(prev);
    }
  }

  async function updateDetailDateBackground(next: boolean) {
    const prev = detailDateBackground;
    setDetailDateBackground(next);
    setDetailDateBackgroundPreference(next);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ detailDateBackground: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setDetailDateBackground(prev);
        setDetailDateBackgroundPreference(prev);
      }
    } catch {
      setDetailDateBackground(prev);
      setDetailDateBackgroundPreference(prev);
    }
  }

  async function updateAccountDropdownRestrictType(next: boolean) {
    const prev = accountDropdownRestrictType;
    setAccountDropdownRestrictType(next);
    setAccountDropdownRestrictTypePreference(next);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountDropdownRestrictType: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setAccountDropdownRestrictType(prev);
        setAccountDropdownRestrictTypePreference(prev);
      }
    } catch {
      setAccountDropdownRestrictType(prev);
      setAccountDropdownRestrictTypePreference(prev);
    }
  }

  async function updateRowHeightMode(next: RowHeightMode) {
    const prev = rowHeightMode;
    setRowHeightMode(next);
    setRowHeightModePreference(next);
    try {
      const res = await fetch("/api/v1/settings/app-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowHeightMode: next }),
      });
      const data = await res.json();
      if (!data.ok) {
        setRowHeightMode(prev);
        setRowHeightModePreference(prev);
      } else {
        const saved = normalizeRowHeightMode(data.rowHeightMode);
        setRowHeightMode(saved);
        setRowHeightModePreference(saved);
      }
    } catch {
      setRowHeightMode(prev);
      setRowHeightModePreference(prev);
    }
  }

  const accountFormatPreviews = useMemo(
    () =>
      ACCOUNT_FORMAT_PREVIEW_SAMPLES.map((sample) => ({
        id: sample.id,
        label: t(sample.labelKey),
        text: renderAccountLabel({
          accountName: sample.accountName,
          institution: sample.institution,
          numberMasked: sample.numberMasked,
          ownerName: sample.ownerName,
          kindLabelText: kindLabel(sample.kind, t),
          fields: accountLabelFields,
        }),
      })),
    [t, accountLabelFields]
  );
  const unselectedAccountLabelFields = useMemo(
    () => ACCOUNT_LABEL_FIELD_OPTIONS.filter((option) => !accountLabelFields.includes(option.value)),
    [accountLabelFields]
  );
  const timeZoneOptions = useMemo(() => buildTimeZoneOptions(t), [t]);
  const hideSettingDescriptions = sidebarHideInitialData;

  const colorOptions: { value: ColorScheme; label: string; preview: { up: string; down: string } }[] = [
    {
      value: "red_up_green_down",
      label: t("settings.display.colorRedUp"),
      preview: { up: "text-red-600", down: "text-emerald-700" },
    },
    {
      value: "green_up_red_down",
      label: t("settings.display.colorGreenUp"),
      preview: { up: "text-emerald-700", down: "text-red-600" },
    },
  ];
  const selectedColorOption = colorOptions.find((opt) => opt.value === scheme) ?? colorOptions[0];
  const rowHeightSliderIndex = Math.max(0, ROW_HEIGHT_OPTIONS.indexOf(rowHeightMode));

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-800">{t("settings.display.title")}</h2>
        <p className="mt-1 text-xs text-slate-500">{t("settings.display.description")}</p>
      </div>

      <section className="panel-surface overflow-hidden">
        <div>
          <SettingRow title={t("settings.display.sidebarGroup")} desc={t("settings.display.sidebarGroupDesc")} hideDesc={hideSettingDescriptions}>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => updateSidebarGroup("kind")}
                className={`segment-button h-9 px-4 ${sidebarGroupBy === "kind" ? "segment-button-active font-medium" : ""}`}
              >
                {t("settings.display.groupByKind")}
              </button>
              <button
                type="button"
                onClick={() => updateSidebarGroup("institution")}
                className={`segment-button h-9 px-4 ${sidebarGroupBy === "institution" ? "segment-button-active font-medium" : ""}`}
              >
                {t("settings.display.groupByInstitution")}
              </button>
            </div>
          </SettingRow>
          <SettingRow title={t("settings.display.hideZero")} desc={t("settings.display.hideZeroDesc")} hideDesc={hideSettingDescriptions}>
            <input
              type="checkbox"
              checked={sidebarHideZero}
              onChange={(e) => updateSidebarHideZero(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
            />
          </SettingRow>
          <SettingRow title={t("settings.display.showFixedAssets")} desc={t("settings.display.showFixedAssetsDesc")} hideDesc={hideSettingDescriptions}>
            <input
              type="checkbox"
              checked={sidebarShowFixedAssets}
              onChange={(e) => void updateSidebarShowFixedAssets(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
            />
          </SettingRow>
          <SettingRow title={t("settings.display.accountDropdownRestrictType")} desc={t("settings.display.accountDropdownRestrictTypeDesc")} hideDesc={hideSettingDescriptions}>
            <input
              type="checkbox"
              checked={accountDropdownRestrictType}
              onChange={(e) => void updateAccountDropdownRestrictType(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
            />
          </SettingRow>
          <SettingRow
            title={t("settings.display.hideInitialData")}
            desc={t("settings.display.hideInitialDataDesc")}
            hideDesc={hideSettingDescriptions}
          >
            <input
              type="checkbox"
              checked={sidebarHideInitialData}
              onChange={(e) => void updateSidebarHideInitialData(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
            />
          </SettingRow>
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <SettingRow title={t("settings.display.colorScheme")} desc={t("settings.display.colorSchemeDesc")} hideDesc={hideSettingDescriptions}>
          <div className="space-y-2">
            <select
              value={scheme}
              onChange={(e) => void saveScheme(e.target.value as ColorScheme)}
              disabled={savingScheme}
              className="form-input"
            >
              {colorOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-1 text-xs text-slate-500" aria-live="polite">
              <span className={`font-medium ${selectedColorOption.preview.up}`}>+1.23%</span>
              <span className="text-slate-400">/</span>
              <span className={`font-medium ${selectedColorOption.preview.down}`}>-0.56%</span>
              {savingScheme ? <span className="ml-2 text-slate-400">{t("settings.display.applying")}</span> : null}
            </div>
          </div>
        </SettingRow>
        <SettingRow title={t("settings.display.detailDateBackground")} desc={t("settings.display.detailDateBackgroundDesc")} hideDesc={hideSettingDescriptions}>
          <input
            type="checkbox"
            checked={detailDateBackground}
            onChange={(e) => void updateDetailDateBackground(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-200"
          />
        </SettingRow>
        <SettingRow title={t("settings.display.rowHeight")} desc={t("settings.display.rowHeightDesc")} hideDesc={hideSettingDescriptions}>
          <div className="w-full max-w-md space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-slate-700">{rowHeightMode}px</span>
              <span className="text-slate-400">{ROW_HEIGHT_OPTIONS[0]}px / {ROW_HEIGHT_OPTIONS[ROW_HEIGHT_OPTIONS.length - 1]}px</span>
            </div>
            <input
              type="range"
              min={0}
              max={ROW_HEIGHT_OPTIONS.length - 1}
              step={1}
              value={rowHeightSliderIndex}
              onChange={(event) => {
                const index = Number(event.currentTarget.value);
                const next = ROW_HEIGHT_OPTIONS[index] ?? DEFAULT_ROW_HEIGHT_MODE;
                void updateRowHeightMode(next);
              }}
              className="h-2 w-full cursor-pointer accent-blue-600"
              aria-label={t("settings.display.rowHeight")}
            />
            <div className="flex justify-between text-[11px] tabular-nums text-slate-400">
              {ROW_HEIGHT_OPTIONS.map((height) => (
                <span key={height}>{height}</span>
              ))}
            </div>
          </div>
        </SettingRow>
      </section>

      <section className="panel-surface overflow-hidden">
        <div>
          <SettingRow title={t("settings.display.baseCurrency")} desc={t("settings.display.baseCurrencyDesc")} hideDesc={hideSettingDescriptions}>
            <div className="w-full sm:max-w-xs">
              <CurrencySmartSelect
                value={baseCurrency}
                onChange={(code) => void saveBaseCurrency(code)}
                labelSystem={(code) => t(`entityForm.currency.${code.toLowerCase()}`, { defaultValue: code })}
                placeholder={t("settings.display.baseCurrencyPlaceholder")}
              />
              {savingBaseCurrency ? (
                <p className="mt-1 text-[11px] text-slate-400">{t("common.loading")}</p>
              ) : null}
            </div>
          </SettingRow>
          <SettingRow title={t("settings.display.language")} desc={t("settings.display.languageDesc")} hideDesc={hideSettingDescriptions}>
            <select
              value={displayLanguage}
              onChange={(e) => saveDisplayLanguage(e.target.value as DisplayLanguage)}
              disabled={savingDisplayLanguage}
              className="form-input"
            >
              {DISPLAY_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title={t("settings.display.timeZone")} desc={t("settings.display.timeZoneDesc")} hideDesc={hideSettingDescriptions}>
            <select
              value={timeZoneMode === "system" ? "system" : timeZone}
              onChange={(e) => {
                const value = e.target.value;
                void (value === "system" ? saveTimeZone("system", timeZone) : saveTimeZone("specified", value));
              }}
              disabled={savingTimeZone}
              className="form-input"
            >
              <option value="system">{t("settings.display.timeZoneSystem")}</option>
              {timeZoneOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title={t("settings.display.dateFormat")} desc={t("settings.display.dateFormatDesc")} hideDesc={hideSettingDescriptions}>
            <select
              value={dateDisplayFormat}
              onChange={(e) => void saveDateDisplayFormat(e.target.value as DateDisplayFormat)}
              disabled={savingDateDisplayFormat}
              className="form-input"
            >
              {DATE_DISPLAY_FORMAT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </SettingRow>
        </div>
      </section>

      <section className="panel-surface overflow-hidden">
        <div>
          <SettingRow title={t("settings.display.accountFormat")} desc={t("settings.display.accountFormatDesc")} hideDesc={hideSettingDescriptions} wide>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-4 xl:gap-6">
              <div className="min-w-0 flex-1">
                <div className="flex min-h-8 flex-nowrap items-center gap-2 overflow-x-auto pb-1">
                  {accountLabelFields.length === 0 ? (
                    <span className="text-xs text-slate-400">{t("settings.display.accountFormatEmpty")}</span>
                  ) : (
                    accountLabelFields.map((field, index) => {
                      const option = ACCOUNT_LABEL_FIELD_OPTIONS.find((item) => item.value === field);
                      if (!option) return null;
                      const isDragging = draggingAccountLabelField === field;
                      const isDropTarget = dragOverAccountLabelField === field && !isDragging;
                      return (
                        <div
                          key={field}
                          draggable
                          onDragStart={(event) => {
                            setDraggingAccountLabelField(field);
                            event.dataTransfer.effectAllowed = "move";
                            // Firefox only starts a drag when payload data is set.
                            event.dataTransfer.setData("text/plain", field);
                          }}
                          onDragOver={(event) => {
                            if (!draggingAccountLabelField || draggingAccountLabelField === field) return;
                            event.preventDefault();
                            event.dataTransfer.dropEffect = "move";
                            setDragOverAccountLabelField(field);
                          }}
                          onDragLeave={() => {
                            if (dragOverAccountLabelField === field) setDragOverAccountLabelField(null);
                          }}
                          onDrop={(event) => {
                            event.preventDefault();
                            if (draggingAccountLabelField) {
                              reorderAccountLabelFields(draggingAccountLabelField, field);
                            }
                            clearAccountLabelDragState();
                          }}
                          onDragEnd={clearAccountLabelDragState}
                          title={t("settings.display.accountFormatDragHint")}
                          className={`flex h-8 shrink-0 cursor-grab items-center gap-1 rounded-[8px] border px-2 text-xs shadow-sm active:cursor-grabbing ${
                            isDropTarget
                              ? "border-blue-400 bg-blue-100 text-blue-800 ring-1 ring-inset ring-blue-300"
                              : "border-blue-200 bg-blue-50/70 text-blue-700"
                          } ${isDragging ? "opacity-50" : ""}`}
                        >
                          <GripVertical className="h-3.5 w-3.5 shrink-0 text-blue-300" aria-hidden="true" />
                          <span className="shrink-0 tabular-nums text-blue-400">{index + 1}.</span>
                          <span className="whitespace-nowrap font-medium">{t(option.labelKey)}</span>
                          <button
                            type="button"
                            onClick={() => toggleAccountLabelField(field)}
                            title={t("settings.display.accountFormatRemove")}
                            aria-label={t("settings.display.accountFormatRemove")}
                            className="ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-blue-400 hover:bg-blue-100 hover:text-blue-700"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
                {unselectedAccountLabelFields.length > 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-400">{t("settings.display.accountFormatAdd")}</span>
                    {unselectedAccountLabelFields.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => toggleAccountLabelField(option.value)}
                        className="segment-button h-7 px-2 text-xs"
                      >
                        + {t(option.labelKey)}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                  <span>{t("settings.display.accountFormatHint")}</span>
                  <button
                    type="button"
                    onClick={() => void saveAccountLabelFields(DEFAULT_ACCOUNT_LABEL_FIELDS)}
                    className="text-blue-600 hover:underline"
                  >
                    {t("settings.display.accountFormatReset")}
                  </button>
                  {savingAccountLabelFields ? <span className="text-slate-400">{t("settings.display.applying")}</span> : null}
                </div>
              </div>
              <div className="w-full shrink-0 rounded-[10px] border border-slate-200 bg-slate-50/70 px-3 py-2 lg:w-64 xl:w-72">
                <div className="text-xs text-slate-500">{t("settings.display.preview")}</div>
                <div className="mt-1 space-y-1">
                  {accountFormatPreviews.map((preview) => (
                    <div key={preview.id} className="flex items-baseline justify-between gap-3">
                      <span className="shrink-0 text-xs text-slate-400">{preview.label}</span>
                      <span className="truncate text-sm text-slate-800" title={preview.text}>{preview.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </SettingRow>
        </div>
      </section>
    </div>
  );
}
