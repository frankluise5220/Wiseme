"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  APP_PREFS_EVENT,
  getDisplayLanguagePreference,
  setDisplayLanguagePreference,
  type DisplayLanguage,
} from "@/lib/client/appPreferences";
import { useI18n } from "@/lib/i18n";

const LANGUAGE_OPTIONS: Array<{ value: DisplayLanguage; iconKey: string; labelKey: string }> = [
  { value: "zh-CN", iconKey: "languageSwitcher.icon.zhCN", labelKey: "languageSwitcher.name.zhCN" },
  { value: "en-US", iconKey: "languageSwitcher.icon.enUS", labelKey: "languageSwitcher.name.enUS" },
  { value: "ja-JP", iconKey: "languageSwitcher.icon.jaJP", labelKey: "languageSwitcher.name.jaJP" },
];

function nextLanguage(current: DisplayLanguage) {
  const currentIndex = LANGUAGE_OPTIONS.findIndex((option) => option.value === current);
  return LANGUAGE_OPTIONS[(currentIndex + 1 + LANGUAGE_OPTIONS.length) % LANGUAGE_OPTIONS.length] ?? LANGUAGE_OPTIONS[0];
}

export function LanguageSwitcher() {
  const { t, language: currentLanguage } = useI18n();
  const router = useRouter();
  const [language, setLanguage] = useState<DisplayLanguage>(currentLanguage);

  useEffect(() => {
    function syncLanguage() {
      const next = getDisplayLanguagePreference();
      setLanguage(next);
      document.documentElement.lang = next;
    }
    syncLanguage();
    window.addEventListener(APP_PREFS_EVENT, syncLanguage);
    return () => window.removeEventListener(APP_PREFS_EVENT, syncLanguage);
  }, []);

  function switchLanguage(next: DisplayLanguage) {
    setLanguage(next);
    setDisplayLanguagePreference(next);
    document.documentElement.lang = next;
    // Server components render with getServerT() from the cookie, so re-render
    // the current route so server-translated copy (pills, titles, options)
    // catches up to the client text right away.
    router.refresh();
    void fetch("/api/v1/settings/app-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayLanguage: next }),
    }).catch(() => {});
  }

  const current = LANGUAGE_OPTIONS.find((option) => option.value === language) ?? LANGUAGE_OPTIONS[0];
  const next = nextLanguage(language);
  const title = t("languageSwitcher.switchTitle", {
    current: t(current.labelKey),
    next: t(next.labelKey),
  });

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        switchLanguage(next.value);
      }}
      title={title}
      aria-label={title}
      className="inline-flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-[11px] font-semibold text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
    >
      {t(current.iconKey)}
    </button>
  );
}
