"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  APP_PREFS_EVENT,
  getDisplayLanguagePreference,
  type DisplayLanguage,
} from "@/lib/client/appPreferences";
import { translate } from "@/lib/i18n-core";

export type I18nValue = {
  language: DisplayLanguage;
  t: (key: string, params?: Record<string, string | number>) => string;
};

export const I18nContext = createContext<I18nValue | null>(null);

// Client provider seeded with the server-resolved display language (read from
// the mmh_display_language cookie by the root layout). Seeding the initial
// state means SSR HTML and the first client render agree on the language, so a
// page refresh does not flash the default language (zh-CN) before the cookie is
// read after mount. The provider keeps listening for preference changes so a
// language switch updates every consumer live and keeps <html lang> in sync.
export function I18nProvider({
  initialLanguage,
  children,
}: {
  initialLanguage: DisplayLanguage;
  children: ReactNode;
}) {
  const [language, setLanguage] = useState<DisplayLanguage>(initialLanguage);

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

  const value = useMemo<I18nValue>(
    () => ({
      language,
      t: (key: string, params?: Record<string, string | number>) => translate(language, key, params),
    }),
    [language],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18nContext() {
  return useContext(I18nContext);
}
