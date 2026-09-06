"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

export default function DesktopSettingsClient() {
  const { t } = useI18n();
  const [allowLan, setAllowLan] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/desktop/config")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          setAllowLan(Boolean(d.data.allowLan));
          setLoaded(true);
        }
      })
      .catch(() => setLoaded(true));
  }, []);

  async function toggle(next: boolean) {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/desktop/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowLan: next }),
      });
      const d = await res.json();
      if (d.ok) {
        setAllowLan(next);
        setSaved(true);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">{t("settings.desktop.title")}</h1>
        <p className="mt-1 text-xs text-slate-500">{t("settings.desktop.restartHint")}</p>
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-900">{t("settings.desktop.allowLan")}</div>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {t("settings.desktop.allowLanDesc")}
            </p>
            <p className="mt-2 text-xs text-slate-400">
              {t("settings.desktop.currentBind")}：
              {loaded ? (allowLan ? t("settings.desktop.bindLan") : t("settings.desktop.bindLocal")) : "…"}
            </p>
          </div>
          <button
            type="button"
            disabled={saving || !loaded}
            onClick={() => toggle(!allowLan)}
            className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
              allowLan ? "bg-blue-600" : "bg-slate-300"
            } disabled:opacity-50`}
            aria-pressed={allowLan}
          >
            <span
              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                allowLan ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
        {saved && (
          <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">
            {t("settings.desktop.restartHint")}
          </p>
        )}
      </section>
    </div>
  );
}
