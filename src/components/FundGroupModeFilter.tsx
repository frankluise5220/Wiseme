"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { useI18n } from "@/lib/i18n";
import type { FundGroupMode } from "@/components/FundHoldingReport";

export function FundGroupModeFilter({
  groupMode,
  baseParams,
}: {
  groupMode: FundGroupMode;
  baseParams: Record<string, string>;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  function select(next: FundGroupMode) {
    setOpen(false);
    if (next === groupMode) return;
    const query = new URLSearchParams();
    Object.entries(baseParams).forEach(([key, value]) => query.set(key, value));
    query.set("fundGroup", next);
    if (isPending) return;
    startTransition(async () => {
      await fetch("/api/v1/settings/revalidate", { method: "POST" }).catch(() => null);
      router.push(`/reports?${query.toString()}`, { scroll: false });
    });
  }

  const options: Array<{ value: FundGroupMode; label: string }> = [
    { value: "account", label: t("fundHoldingReport.groupByAccount") },
    { value: "company", label: t("fundHoldingReport.groupByFundCompany") },
  ];
  const currentLabel = options.find((option) => option.value === groupMode)?.label ?? options[0].label;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={isPending}
        className="inline-flex h-8 min-w-36 max-w-56 items-center justify-between gap-2 rounded-md border border-slate-300 bg-white px-2.5 text-left text-xs text-slate-700 shadow-sm hover:border-slate-400 disabled:opacity-60"
        title={t("fundHoldingReport.groupMode")}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
      </button>
      {open ? (
        <div className="absolute left-0 top-9 z-50 w-48 rounded-md border border-slate-200 bg-white p-1 shadow-lg">
          <div className="px-2 py-1 text-[11px] font-medium text-slate-500">{t("fundHoldingReport.groupMode")}</div>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`flex h-8 w-full items-center justify-between rounded px-2 text-left text-xs hover:bg-slate-50 ${option.value === groupMode ? "font-medium text-blue-700" : "text-slate-700"}`}
              onClick={() => select(option.value)}
            >
              <span className="truncate">{option.label}</span>
              {option.value === groupMode ? <span className="text-[11px] text-blue-600">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
