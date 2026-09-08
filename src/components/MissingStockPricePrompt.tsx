"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { AlertTriangle, DatabaseZap } from "lucide-react";
import { useRouter } from "next/navigation";

import type { InvestmentProfitMissingStockPrice } from "@/lib/server/investment-profit-report";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { useI18n } from "@/lib/i18n";

function uniqueMissingPrices(items: InvestmentProfitMissingStockPrice[]) {
  const byKey = new Map<string, InvestmentProfitMissingStockPrice>();
  for (const item of items) {
    const market = (item.market || "CN").trim().toUpperCase();
    const stockCode = item.stockCode.trim().toUpperCase();
    if (!stockCode || !item.date) continue;
    const key = `${market}|${stockCode}|${item.date}`;
    if (!byKey.has(key)) byKey.set(key, { ...item, market, stockCode });
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.date.localeCompare(b.date) || a.stockCode.localeCompare(b.stockCode, "zh-Hans-CN"),
  );
}

function priceKey(item: Pick<InvestmentProfitMissingStockPrice, "market" | "stockCode" | "date">) {
  return `${item.market.trim().toUpperCase()}|${item.stockCode.trim().toUpperCase()}|${item.date}`;
}

export function MissingStockPricePrompt({
  items,
  className = "",
}: {
  items: InvestmentProfitMissingStockPrice[];
  className?: string;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState("");
  const incoming = useMemo(() => {
    const values = uniqueMissingPrices(items);
    return { signature: values.map(priceKey).join(","), values };
  }, [items]);
  const [missingItems, setMissingItems] = useState(incoming.values);
  const lastAppliedSignatureRef = useRef(incoming.signature);
  const stockCount = useMemo(() => new Set(missingItems.map((item) => `${item.market}|${item.stockCode}`)).size, [missingItems]);
  const rangeLabel = useMemo(() => {
    const dates = missingItems.map((item) => item.date).sort();
    if (dates.length === 0) return "";
    const first = dates[0]!;
    const last = dates[dates.length - 1]!;
    return first === last ? first : `${first}${t("missingStock.dateRangeSep")}${last}`;
  }, [missingItems, t]);

  useEffect(() => {
    if (lastAppliedSignatureRef.current === incoming.signature) return;
    lastAppliedSignatureRef.current = incoming.signature;
    setMissingItems(incoming.values);
    setMessage("");
  }, [incoming.signature, incoming.values]);

  if (missingItems.length === 0) return null;

  async function refreshMissingPrices() {
    const ok = await showConfirmDialog({
      title: t("missingStock.confirmTitle"),
      message: t("missingStock.confirmMessage")
        .replace("{stockCount}", String(stockCount))
        .replace("{count}", String(missingItems.length)),
    });
    if (!ok) return;
    setMessage("");
    startTransition(async () => {
      try {
        // Close prices come back as one contiguous kline range per stock, so a
        // single request is enough even for many missing dates.
        const res = await fetch("/api/v1/stocks/prices/missing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: missingItems.map((item) => ({
              market: item.market,
              stockCode: item.stockCode,
              date: item.date,
              accountId: item.accountId,
            })),
          }),
        });
        const contentType = res.headers.get("content-type") ?? "";
        const data = contentType.toLowerCase().includes("application/json")
          ? await res.json().catch(() => null)
          : { ok: false, error: `${t("missingStock.fetchFailed")} (HTTP ${res.status})` };
        if (!data || !res.ok || !data.ok) {
          window.alert(data?.error ?? t("missingStock.fetchFailed"));
          return;
        }

        const unresolvedItems = Array.isArray(data.unresolvedItems) ? data.unresolvedItems.length : 0;
        const resolvedItems = Array.isArray(data.resolvedItems) ? data.resolvedItems.length : 0;
        setMissingItems([]);
        window.dispatchEvent(new CustomEvent("mmh:stock:price-cache-updated", { detail: data }));
        router.refresh();
        if (unresolvedItems > 0 && resolvedItems === 0 && (data.written ?? 0) === 0) {
          window.alert(t("missingStock.unresolvedAlert").replace("{count}", String(unresolvedItems)));
        }
      } catch (error) {
        window.alert(error instanceof Error ? error.message : t("missingStock.fetchFailed"));
      }
    });
  }

  return (
    <div
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-2.5 text-xs text-amber-900 ${className}`}
      title={`${t("missingStock.titleAttr")
        .replace("{count}", String(missingItems.length))
        .replace("{range}", rangeLabel)
        .replace("{stockCount}", String(stockCount))}${message ? ` ${message}` : ""}`}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
      <span className="font-medium tabular-nums">{t("missingStock.badge").replace("{count}", String(missingItems.length))}</span>
      <span className="hidden max-w-48 truncate text-amber-700 xl:inline">
        {t("missingStock.summary").replace("{stockCount}", String(stockCount)).replace("{range}", rangeLabel)}
      </span>
      <button
        type="button"
        onClick={refreshMissingPrices}
        disabled={isPending}
        className="ml-1 inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-amber-300 bg-white px-2 font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-60"
      >
        <DatabaseZap className={`h-3 w-3 ${isPending ? "animate-pulse" : ""}`} />
        {isPending ? t("missingStock.fetching") : t("missingStock.fetch")}
      </button>
    </div>
  );
}
