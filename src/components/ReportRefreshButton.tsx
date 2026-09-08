"use client";

import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";

/**
 * Manual refresh control for server-rendered report views.
 *
 * Re-fetches the current route's server components so cached report loaders
 * (e.g. the stock holdings report via unstable_cache) recompute from the
 * database. The admin-only revalidate endpoint is best-effort: non-admin users
 * receive a 403 that we intentionally ignore, and the page still re-renders.
 */
export function ReportRefreshButton() {
  const router = useRouter();
  const { t } = useI18n();
  const [isPending, startTransition] = useTransition();

  function refresh() {
    if (isPending) return;
    startTransition(async () => {
      // Best-effort cache bust for server-side cached reports.
      await fetch("/api/v1/settings/revalidate", { method: "POST" }).catch(() => null);
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={refresh}
      disabled={isPending}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-60"
      title={t("reports.refresh")}
    >
      <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
      {t("reports.refresh")}
    </button>
  );
}
