"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

export function InvestHeaderSync() {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const { t } = useI18n();

  async function handleSync() {
    if (loading) return;
    setLoading(true);
    setMessage(null);

    try {
      const res = await fetch("/api/v1/fund/sync-position", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: "all" }),
      });
      const data = await res.json();

      if (data.ok) {
        setMessage(data.message ?? t("investSync.synced", { count: data.synced }));
        dispatchFinanceDataChanged({ reason: "invest-header-sync" });
      } else {
        setMessage(t("investSync.failed", { reason: data.error }));
      }
    } catch (e) {
      setMessage(t("investSync.failed", { reason: e instanceof Error ? e.message : t("investSync.networkError") }));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleSync}
        disabled={loading}
        className="h-8 px-3 rounded-md bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
        {loading ? t("investSync.syncing") : t("investSync.syncHoldings")}
      </button>
      {message && (
        <span className="text-xs text-slate-500">{message}</span>
      )}
    </div>
  );
}
