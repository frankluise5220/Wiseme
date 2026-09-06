"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AlertTriangle, DatabaseZap } from "lucide-react";
import { useRouter } from "next/navigation";

import type { InvestmentProfitMissingNav } from "@/lib/server/investment-profit-report";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { useI18n } from "@/lib/i18n";

function compactDateRange(t: (key: string) => string, items: InvestmentProfitMissingNav[]) {
  const dates = items.map((item) => item.date).sort();
  if (dates.length === 0) return "";
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;
  return first === last ? first : `${first}${t("missingNav.dateRangeSep")}${last}`;
}

function uniqueMissingNavs(items: InvestmentProfitMissingNav[]) {
  const byKey = new Map<string, InvestmentProfitMissingNav>();
  for (const item of items) {
    const fundCode = item.fundCode.trim();
    if (!fundCode || !item.date) continue;
    const key = `${fundCode}|${item.date}`;
    if (!byKey.has(key)) byKey.set(key, { ...item, fundCode });
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.date.localeCompare(b.date) || a.fundCode.localeCompare(b.fundCode, "zh-Hans-CN"),
  );
}

function navKey(item: Pick<InvestmentProfitMissingNav, "fundCode" | "date">) {
  return `${item.fundCode.trim()}|${item.date}`;
}

function navBatchKey(item: InvestmentProfitMissingNav) {
  return `${item.fundCode.trim()}|${item.date.slice(0, 7)}`;
}

function buildMissingNavBatches(items: InvestmentProfitMissingNav[]) {
  const grouped = new Map<string, InvestmentProfitMissingNav[]>();
  for (const item of items) {
    const key = navBatchKey(item);
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);
  }
  return Array.from(grouped.values()).sort((a, b) =>
    a[0]!.date.localeCompare(b[0]!.date) || a[0]!.fundCode.localeCompare(b[0]!.fundCode, "zh-Hans-CN"),
  );
}

type MissingNavResponse = {
  ok?: boolean;
  error?: string;
  unresolvedItems?: InvestmentProfitMissingNav[];
  resolvedItems?: InvestmentProfitMissingNav[];
  fetched?: number;
  written?: number;
  failed?: number;
  skippedClosed?: number;
};

async function readMissingNavResponse(res: Response, fallbackMessage: string): Promise<MissingNavResponse | null> {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    return await res.json().catch(() => null);
  }

  const status = res.status ? ` (HTTP ${res.status})` : "";
  return { ok: false, error: `${fallbackMessage}${status}` };
}

export function MissingFundNavPrompt({
  items,
  className = "",
}: {
  items: InvestmentProfitMissingNav[];
  className?: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const incoming = useMemo(() => {
    const values = uniqueMissingNavs(items);
    return { signature: values.map(navKey).join(","), values };
  }, [items]);
  const [missingItems, setMissingItems] = useState(incoming.values);
  const lastAppliedSignatureRef = useRef(incoming.signature);
  const fundCount = useMemo(() => new Set(missingItems.map((item) => item.fundCode)).size, [missingItems]);
  const rangeLabel = compactDateRange(t, missingItems);

  useEffect(() => {
    if (lastAppliedSignatureRef.current === incoming.signature) return;
    lastAppliedSignatureRef.current = incoming.signature;
    setMissingItems(incoming.values);
    setMessage("");
  }, [incoming.signature, incoming.values]);

  if (missingItems.length === 0) return null;

  async function refreshMissingNavs() {
    const ok = await showConfirmDialog({
      title: t("missingNav.confirmTitle"),
      message: t("missingNav.confirmMessage")
        .replace("{fundCount}", String(fundCount))
        .replace("{count}", String(missingItems.length)),
    });
    if (!ok) return;
    setMessage("");
    startTransition(async () => {
      try {
        const batches = buildMissingNavBatches(missingItems);
        const aggregate: MissingNavResponse = {
          ok: true,
          unresolvedItems: [],
          resolvedItems: [],
          fetched: 0,
          written: 0,
          failed: 0,
          skippedClosed: 0,
        };
        for (const batch of batches) {
          const res = await fetch("/api/v1/fund/nav/missing", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              items: batch.map((item) => ({
                fundCode: item.fundCode,
                date: item.date,
                accountId: item.accountId,
              })),
            }),
          });
          const data = await readMissingNavResponse(res, t("missingNav.fetchFailed"));
          if (!data || !res.ok || !data.ok) {
            window.alert(data?.error ?? t("missingNav.fetchFailed"));
            return;
          }
          aggregate.fetched = (aggregate.fetched ?? 0) + (data.fetched ?? 0);
          aggregate.written = (aggregate.written ?? 0) + (data.written ?? 0);
          aggregate.failed = (aggregate.failed ?? 0) + (data.failed ?? 0);
          aggregate.skippedClosed = (aggregate.skippedClosed ?? 0) + (data.skippedClosed ?? 0);
          if (Array.isArray(data.unresolvedItems)) aggregate.unresolvedItems!.push(...data.unresolvedItems);
          if (Array.isArray(data.resolvedItems)) aggregate.resolvedItems!.push(...data.resolvedItems);
        }
        const unresolvedItems = Array.isArray(aggregate.unresolvedItems)
          ? uniqueMissingNavs(aggregate.unresolvedItems)
          : [];
        const resolvedItems = Array.isArray(aggregate.resolvedItems)
          ? uniqueMissingNavs(aggregate.resolvedItems)
          : [];

        setMissingItems([]);
        window.dispatchEvent(new CustomEvent("mmh:fund:nav-cache-updated", { detail: aggregate }));
        router.refresh();
        if (unresolvedItems.length > 0 && resolvedItems.length === 0 && (aggregate.written ?? 0) === 0) {
          window.alert(t("missingNav.unresolvedAlert").replace("{count}", String(unresolvedItems.length)));
        }
      } catch (error) {
        window.alert(error instanceof Error ? error.message : t("missingNav.fetchFailed"));
      }
    });
  }

  return (
    <div
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 text-xs text-amber-900 ${className}`}
      title={`${t("missingNav.titleAttr")
        .replace("{count}", String(missingItems.length))
        .replace("{range}", rangeLabel)
        .replace("{fundCount}", String(fundCount))}${message ? ` ${message}` : ""}`}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
      <span className="font-medium tabular-nums">{t("missingNav.badge").replace("{count}", String(missingItems.length))}</span>
      <span className="hidden max-w-48 truncate text-amber-700 xl:inline">
        {t("missingNav.summary").replace("{fundCount}", String(fundCount)).replace("{range}", rangeLabel)}
      </span>
      <button
        type="button"
        onClick={refreshMissingNavs}
        disabled={isPending}
        className="ml-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-amber-300 bg-white px-2 font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-60"
      >
        <DatabaseZap className={`h-3 w-3 ${isPending ? "animate-pulse" : ""}`} />
        {isPending ? t("missingNav.fetching") : t("missingNav.fetch")}
      </button>
    </div>
  );
}
