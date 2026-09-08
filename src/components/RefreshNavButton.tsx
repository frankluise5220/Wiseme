"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

export function RefreshNavButton({
  accountId,
  symbols,
}: {
  accountId: string;
  symbols: string[];
}) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const { t } = useI18n();

  async function refresh() {
    if (loading || symbols.length === 0) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/v1/fund/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, symbols }),
      });
      const data = await res.json();
      if (data.ok) {
        setResult(data.message);
        await new Promise(resolve => setTimeout(resolve, 100));
        dispatchFinanceDataChanged({ reason: "nav-refresh" });
      } else {
        setResult(data.error ?? t("refreshNav.refreshFailed"));
      }
    } catch (e) {
      setResult(e instanceof Error ? e.message : t("refreshNav.refreshFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={refresh}
        disabled={loading || symbols.length === 0}
        className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        title={result ?? (loading ? t("refreshNav.fetching") : t("refreshNav.fetchLatestNav"))}
        aria-label={loading ? t("refreshNav.fetching") : t("refreshNav.fetchLatestNav")}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
      </button>
    </div>
  );
}
