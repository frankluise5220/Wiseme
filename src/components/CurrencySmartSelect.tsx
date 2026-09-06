"use client";

/**
 * CurrencySmartSelect - system and user-added currency selector.
 *
 * Users can enter a country name in the inline form and receive suggestions
 * for the currency code and both currency names.
 *
 * Data source: /api/v1/currencies (system + user-added currencies)
 * Create: /api/v1/currency-requests (POST = create an immediately usable currency)
 * Refresh: SETTINGS_DATA_CHANGED_EVENT (scope="all", reason starts with "currency:")
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { translate, useI18n } from "@/lib/i18n";
import {
  SETTINGS_DATA_CHANGED_EVENT,
  notifySettingsDataChanged,
} from "@/lib/client/settingsCache";
import { SmartSelect, type SmartSelectOption } from "@/components/SmartSelect";
import { COUNTRY_TO_CURRENCY, CURRENCY_OPTIONS } from "@/lib/currency";

export type CurrencyEntry = {
  code: string;
  nameZh: string;
  nameEn: string;
  countryZh: string | null;
  countryEn: string | null;
  source: "system" | "approved";
};

type CurrencyRequestResponse = {
  ok: boolean;
  currency?: CurrencyEntry;
  error?: string;
  code?: string;
};

const CACHE: { list: CurrencyEntry[] | null; promise: Promise<CurrencyEntry[]> | null; updatedAt: number } = {
  list: null,
  promise: null,
  updatedAt: 0,
};
const TTL_MS = 60_000;

function mergeSystemAndApproved(payload: {
  currencies?: Array<Omit<CurrencyEntry, "source">>;
  approvedCurrencies?: Array<Omit<CurrencyEntry, "source">>;
}): CurrencyEntry[] {
  const merged: CurrencyEntry[] = [];
  const seen = new Set<string>();
  const push = (entries: Array<Omit<CurrencyEntry, "source">> | undefined, source: "system" | "approved") => {
    if (!entries) return;
    for (const e of entries) {
      const key = e.code.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...e, code: key, source });
    }
  };
  // Keep system currencies first, followed by user-added currencies.
  push(payload.currencies, "system");
  push(payload.approvedCurrencies, "approved");
  return merged;
}

function upsertCurrencyEntry(list: CurrencyEntry[] | null, entry: CurrencyEntry): CurrencyEntry[] {
  const normalized: CurrencyEntry = {
    ...entry,
    code: entry.code.toUpperCase(),
    source: entry.source === "system" ? "system" : "approved",
  };
  const next = (list ?? []).filter((item) => item.code.toUpperCase() !== normalized.code);
  return normalized.source === "system" ? [normalized, ...next] : [...next, normalized];
}

async function fetchCurrencies(force = false): Promise<CurrencyEntry[]> {
  const now = Date.now();
  if (!force && CACHE.list && now - CACHE.updatedAt < TTL_MS) return CACHE.list;
  if (!force && CACHE.promise) return CACHE.promise;

  const promise = fetch("/api/v1/currencies?includeSystem=true", { cache: "no-store" })
    .then((res) => res.json())
    .then((data) => {
      if (!data?.ok) throw new Error(data?.error || "Failed to load currencies");
      const merged = mergeSystemAndApproved({
        currencies: data.currencies,
        approvedCurrencies: data.approvedCurrencies,
      });
      CACHE.list = merged;
      CACHE.updatedAt = Date.now();
      return merged;
    })
    .catch(() => {
      // Preserve a usable system list when the API is temporarily unavailable.
      const fallback: CurrencyEntry[] = CURRENCY_OPTIONS.map(({ value: code }) => ({
        code,
        nameZh: "",
        nameEn: "",
        countryZh: null,
        countryEn: null,
        source: "system" as const,
      }));
      CACHE.list = fallback;
      CACHE.updatedAt = Date.now();
      return fallback;
    });

  CACHE.promise = promise;
  try {
    return await promise;
  } finally {
    CACHE.promise = null;
  }
}

export function invalidateCurrencyCache() {
  CACHE.list = null;
  CACHE.updatedAt = 0;
}

type Props = {
  value: string;
  onChange: (code: string) => void;
  /** Localized label resolver for built-in currencies. */
  labelSystem: (code: string) => string;
  /** Called after a user-added currency is saved. */
  onSubmitted?: (code: string) => void;
  /** Selector placeholder. */
  placeholder?: string;
  /** Whether to show the add-currency action. */
  showRequestButton?: boolean;
  /** Currency codes that should not be selectable in this field. */
  excludeCodes?: string[];
  /** SmartSelect density */
  density?: "regular" | "compact" | "dense" | "micro";
};

export function CurrencySmartSelect({
  value,
  onChange,
  labelSystem,
  onSubmitted,
  placeholder,
  showRequestButton = true,
  excludeCodes = [],
  density = "compact",
}: Props) {
  const { t, language } = useI18n();
  const [currencies, setCurrencies] = useState<CurrencyEntry[]>(CACHE.list ?? []);
  const [showForm, setShowForm] = useState(false);

  const reload = useCallback(async () => {
    try {
      const list = await fetchCurrencies(true);
      setCurrencies(list);
    } catch {
      /* keep previous */
    }
  }, []);

  useEffect(() => {
    if (CACHE.list) {
      setCurrencies(CACHE.list);
    } else {
      void reload();
    }
  }, [reload]);

  // Refresh when settings data changes elsewhere.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ scope?: string; reason?: string }>).detail;
      if (!detail || detail.scope === "all" || detail.reason?.startsWith?.("currency:")) {
        void reload();
      }
    };
    window.addEventListener(SETTINGS_DATA_CHANGED_EVENT, handler);
    return () => window.removeEventListener(SETTINGS_DATA_CHANGED_EVENT, handler);
  }, [reload]);

  const options: SmartSelectOption[] = useMemo(() => {
    const excluded = new Set(excludeCodes.map((code) => code.toUpperCase()));
    return currencies.filter((c) => !excluded.has(c.code.toUpperCase())).map((c) => {
      const isSystem = c.source === "system";
      // System currencies use i18n labels; user-added currencies use saved names.
      const label = isSystem
        ? labelSystem(c.code)
        : (language === "zh-CN" ? c.nameZh : c.nameEn) || c.nameZh || c.nameEn || c.code;
      const alternateLabel = language === "zh-CN" ? c.nameEn : c.nameZh;
      const subLabel = isSystem
        ? c.code
        : [alternateLabel, c.countryZh].filter(Boolean).join(" · ") || c.code;
      return {
        id: c.code,
        label,
        subLabel,
        currency: c.code,
        kind: c.source,
      };
    });
  }, [currencies, excludeCodes, labelSystem, language]);

  return (
    <>
      <SmartSelect
        mode="single"
        value={value}
        onChange={(id) => onChange(id)}
        options={options}
        placeholder={placeholder ?? t("entityForm.ledgerDefaultCurrency")}
        behavior={{
          search: true,
          density,
          clearable: false,
          create: showRequestButton
            ? {
                type: "button",
                onClick: () => setShowForm(true),
                label: t("settings.currency.requestCurrency"),
              }
            : undefined,
        }}
        createLabel={t("settings.currency.requestCurrency")}
        searchable
      />
      {showForm ? (
        <CurrencyRequestModal
          onClose={() => setShowForm(false)}
          onSubmitted={(currency) => {
            const code = currency.code.toUpperCase();
            setShowForm(false);
            setCurrencies((current) => upsertCurrencyEntry(current, currency));
            CACHE.list = upsertCurrencyEntry(CACHE.list, currency);
            CACHE.updatedAt = Date.now();
            onChange(code);
            onSubmitted?.(code);
            void notifySettingsDataChanged({ scope: "all", reason: "currency:requested", prefetch: false });
          }}
        />
      ) : null}
    </>
  );
}

/* ---------- Inline add-currency modal ---------- */

type RequestState = {
  code: string;
  nameZh: string;
  nameEn: string;
  countryZh: string;
};

const EMPTY_REQUEST: RequestState = {
  code: "",
  nameZh: "",
  nameEn: "",
  countryZh: "",
};

function catalogCurrencyName(language: "zh-CN" | "en-US", code: string) {
  const labelKey = `entityForm.currency.${code.toLowerCase()}`;
  const label = translate(language, labelKey);
  if (!label || label === labelKey) return "";
  const suffix = ` ${code}`;
  return label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
}

function catalogCurrencyNames(code: string) {
  const normalized = code.toUpperCase();
  return {
    nameZh: catalogCurrencyName("zh-CN", normalized),
    nameEn: catalogCurrencyName("en-US", normalized),
  };
}

function shouldReplaceSuggestion(current: string, previousSuggestion: string | undefined) {
  const trimmed = current.trim();
  return !trimmed || (!!previousSuggestion && trimmed === previousSuggestion);
}

function CurrencyRequestModal({
  onClose,
  onSubmitted,
}: {
  onClose: () => void;
  onSubmitted: (currency: CurrencyEntry) => void;
}) {
  const { t } = useI18n();
  const [form, setForm] = useState<RequestState>(EMPTY_REQUEST);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof RequestState>(key: K, value: RequestState[K]) {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      // Suggest the code and both names when the entered country is known.
      if (key === "countryZh" && typeof value === "string") {
        const trimmed = value.trim();
        const suggested = COUNTRY_TO_CURRENCY[trimmed];
        if (suggested) {
          const previousCode = COUNTRY_TO_CURRENCY[prev.countryZh.trim()];
          const previousNames = previousCode ? catalogCurrencyNames(previousCode) : undefined;
          const nextNames = catalogCurrencyNames(suggested);
          if (!prev.code.trim() || (previousCode && prev.code.trim().toUpperCase() === previousCode)) {
            next.code = suggested;
          }
          if (nextNames.nameZh && shouldReplaceSuggestion(prev.nameZh, previousNames?.nameZh)) {
            next.nameZh = nextNames.nameZh;
          }
          if (nextNames.nameEn && shouldReplaceSuggestion(prev.nameEn, previousNames?.nameEn)) {
            next.nameEn = nextNames.nameEn;
          }
        }
      }
      return next;
    });
  }

  async function submit() {
    if (submitting) return;
    setError(null);

    if (!/^[A-Za-z]{2,10}$/.test(form.code)) {
      setError(t("settings.currency.codeInvalid"));
      return;
    }
    if (!form.nameZh.trim()) {
      setError(t("settings.currency.nameZhRequired"));
      return;
    }
    if (!form.nameEn.trim()) {
      setError(t("settings.currency.nameEnRequired"));
      return;
    }
    if (!form.countryZh.trim()) {
      setError(t("settings.currency.countryZhRequired"));
      return;
    }

    setSubmitting(true);
    const normalizedCode = form.code.toUpperCase().trim();
    const nameZh = form.nameZh.trim();
    const nameEn = form.nameEn.trim();
    const countryZh = form.countryZh.trim();
    try {
      const res = await fetch("/api/v1/currency-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: normalizedCode,
          nameZh,
          nameEn,
          countryZh,
        }),
      });
      const data: CurrencyRequestResponse = await res.json();
      if (!data.ok) {
        if (data.code === "SYSTEM_CURRENCY") setError(t("settings.currency.systemCodeError"));
        else if (data.code === "DUPLICATE_REQUEST") setError(t("settings.currency.duplicateError"));
        else setError(data.error || t("settings.currency.requestFailed"));
        return;
      }
      onSubmitted({
        code: data.currency?.code?.toUpperCase() || normalizedCode,
        nameZh: data.currency?.nameZh || nameZh,
        nameEn: data.currency?.nameEn || nameEn,
        countryZh: data.currency?.countryZh ?? countryZh,
        countryEn: data.currency?.countryEn ?? null,
        source: data.currency?.source === "system" ? "system" : "approved",
      });
    } catch {
      setError(t("settings.currency.requestFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-4 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <div>
            <div className="text-sm font-medium text-slate-800">{t("settings.currency.formTitle")}</div>
          </div>
          <button
            type="button"
            className="text-slate-400 hover:text-slate-600"
            onClick={onClose}
            aria-label={t("common.cancel")}
          >
            ×
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("settings.currency.countryZh")} hint={t("settings.currency.countryHint")}>
            <input
              className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              value={form.countryZh}
              onChange={(e) => update("countryZh", e.target.value)}
              autoFocus
            />
          </Field>
          <Field label={t("settings.currency.code")} hint={t("settings.currency.codeHint")}>
            <input
              className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-sm uppercase outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              value={form.code}
              onChange={(e) => update("code", e.target.value.toUpperCase())}
              maxLength={10}
            />
          </Field>
          <Field label={t("settings.currency.nameZh")}>
            <input
              className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              value={form.nameZh}
              onChange={(e) => update("nameZh", e.target.value)}
            />
          </Field>
          <Field label={t("settings.currency.nameEn")}>
            <input
              className="h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-sm outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100"
              value={form.nameEn}
              onChange={(e) => update("nameEn", e.target.value)}
            />
          </Field>
        </div>

        {error ? <p className="mt-2 text-xs text-rose-600">{error}</p> : null}

        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-slate-200 px-3 text-xs text-slate-600"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting}
            className="h-8 rounded-md bg-blue-600 px-3 text-xs text-white disabled:opacity-50"
          >
            {submitting ? t("common.loading") : t("settings.currency.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-600">{label}</span>
      {hint ? <span className="ml-1 text-[11px] text-slate-400">({hint})</span> : null}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
