"use client";

import { useContext, useEffect, useMemo, useState } from "react";
import {
  APP_PREFS_EVENT,
  getDisplayLanguagePreference,
  type DisplayLanguage,
} from "@/lib/client/appPreferences";
import { translate } from "@/lib/i18n-core";
import { I18nContext } from "@/components/I18nProvider";

export { translate };
export type { I18nKey } from "@/lib/i18n-core";

export function useI18n() {
  const context = useContext(I18nContext);

  // Fallback path when no I18nProvider is present (standalone usage): keep the
  // previous self-contained behavior that reads the preference after mount.
  const [fallbackLanguage, setFallbackLanguage] = useState<DisplayLanguage>("zh-CN");

  useEffect(() => {
    if (context) return;
    function syncLanguage() {
      setFallbackLanguage(getDisplayLanguagePreference());
    }
    syncLanguage();
    window.addEventListener(APP_PREFS_EVENT, syncLanguage);
    return () => window.removeEventListener(APP_PREFS_EVENT, syncLanguage);
  }, [context]);

  const language = context ? context.language : fallbackLanguage;

  return useMemo(
    () => ({
      language,
      t: (key: string, params?: Record<string, string | number>) => translate(language, key, params),
    }),
    [language],
  );
}
