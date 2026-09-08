"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";

type DayPnl = { date: string; mv: number; pnl: number | null };
type MonthSummary = { month: number; mv: number | null; pnl: number | null };

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function monthLabel(language: string, month: number) {
  return new Intl.DateTimeFormat(language, { month: "short" }).format(new Date(2000, month - 1, 1));
}

export function DailyPnlCalendar({ accountId, accountIds }: { accountId?: string; accountIds?: string[] }) {
  const { t, language } = useI18n();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [viewMode, setViewMode] = useState<"month" | "year">("month");
  const [days, setDays] = useState<DayPnl[]>([]);
  const [yearMonths, setYearMonths] = useState<MonthSummary[]>([]);
  const [loading, setLoading] = useState(false);

  // Month data fetch
  useEffect(() => {
    if (viewMode !== "month") return;
    const scope = accountIds?.length
      ? `accountIds=${encodeURIComponent(accountIds.join(","))}`
      : `accountId=${encodeURIComponent(accountId ?? "all")}`;
    setLoading(true);
    fetch(`/api/v1/invest/daily-pnl?${scope}&year=${year}&month=${month}`)
      .then(r => r.json())
      .then(d => { if (d.ok) setDays(d.days || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [accountId, accountIds, year, month, viewMode]);

  // Year data fetch
  useEffect(() => {
    if (viewMode !== "year") return;
    const scope = accountIds?.length
      ? `accountIds=${encodeURIComponent(accountIds.join(","))}`
      : `accountId=${encodeURIComponent(accountId ?? "all")}`;
    setLoading(true);
    fetch(`/api/v1/invest/daily-pnl?${scope}&year=${year}&mode=year`)
      .then(r => r.json())
      .then(d => { if (d.ok) setYearMonths(d.months || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [accountId, accountIds, year, viewMode]);

  const pnlByDate = useMemo(() => {
    const m = new Map<string, DayPnl>();
    for (const d of days) m.set(d.date, d);
    return m;
  }, [days]);

  const totalPnl = useMemo(() => {
    let sum = 0;
    for (const d of days) if (d.pnl != null) sum += d.pnl;
    return Math.round(sum * 100) / 100;
  }, [days]);

  const yearTotalPnl = useMemo(() => {
    let sum = 0;
    for (const m of yearMonths) if (m.pnl != null) sum += m.pnl;
    return Math.round(sum * 100) / 100;
  }, [yearMonths]);

  // ── Month view grid ──
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month - 1, 1).getDay();
  const monthCells: Array<{ day: number; date: string } | null> = [];
  for (let i = 0; i < firstDow; i++) monthCells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    monthCells.push({ day: d, date: `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}` });
  }
  const monthGrid = monthCells;

  function prev() { if (month === 1) { setMonth(12); setYear(year - 1); } else setMonth(month - 1); }
  function next() { if (month === 12) { setMonth(1); setYear(year + 1); } else setMonth(month + 1); }
  function prevYear() { setYear(year - 1); }
  function nextYear() { setYear(year + 1); }

  function renderDay(cell: { day: number; date: string } | null, key: string, isToday: boolean) {
    if (!cell) return <div key={key} className="aspect-square rounded-sm" />;
    const info = pnlByDate.get(cell.date);
    const pnl = info?.pnl;
    let bg = "bg-slate-50/50", tc = "text-slate-400";
    if (pnl != null) {
      if (pnl > 0) { bg = "bg-red-50"; tc = "text-red-600"; }
      else if (pnl < 0) { bg = "bg-emerald-50"; tc = "text-emerald-600"; }
      else { bg = "bg-slate-100"; tc = "text-slate-500"; }
    }
    return (
      <div key={cell.date}
        className={`aspect-square rounded-sm flex flex-col items-center justify-center ${bg} ${isToday ? "ring-1 ring-blue-400" : ""}`}
        title={`${cell.date}${pnl != null ? (pnl >= 0 ? " +" : " ") + pnl.toFixed(2) : ""}`}>
        <span className={`text-xs font-semibold ${pnl != null ? tc : "text-slate-400"}`}>{cell.day}</span>
        {pnl != null && (
          <span className={`text-[10px] tabular-nums leading-tight ${tc}`}>
            {pnl >= 0 ? "+" : ""}{Math.abs(pnl) >= 100 ? Math.round(Math.abs(pnl)) : pnl.toFixed(0)}
          </span>
        )}
      </div>
    );
  }

  const prevFn = viewMode === "year" ? prevYear : prev;
  const nextFn = viewMode === "year" ? nextYear : next;
  const title = viewMode === "year"
    ? t("dailyPnlCalendar.title.year", { year })
    : t("dailyPnlCalendar.title.month", { year, month: monthLabel(language, month) });
  const summary = viewMode === "year" ? yearTotalPnl : totalPnl;

  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 bg-slate-50">
        <div className="flex items-center gap-1.5">
          <button onClick={prevFn} className="h-6 w-6 rounded border border-slate-200 bg-white flex items-center justify-center hover:bg-slate-100">
            <ChevronLeft className="w-3 h-3 text-slate-500" />
          </button>
          <span className="text-xs font-semibold text-slate-800 min-w-[90px] text-center">{title}</span>
          <button onClick={nextFn} className="h-6 w-6 rounded border border-slate-200 bg-white flex items-center justify-center hover:bg-slate-100">
            <ChevronRight className="w-3 h-3 text-slate-500" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400 tabular-nums">
            {loading ? "…" : `${summary >= 0 ? "+" : ""}${summary.toFixed(2)}`}
          </span>
          <select value={viewMode} onChange={e => setViewMode(e.target.value as any)}
            className="h-6 rounded border border-slate-200 bg-white px-1.5 text-[11px] outline-none text-slate-600">
            <option value="month">{t("dailyPnlCalendar.viewMonth")}</option>
            <option value="year">{t("dailyPnlCalendar.viewYear")}</option>
          </select>
        </div>
      </div>

      <div className="px-1.5 py-1">
        {viewMode === "month" ? (
          <>
            <div className="grid grid-cols-7 gap-[1px] mb-[1px]">
              {WEEKDAY_KEYS.map(w => <div key={w} className="text-center text-[11px] text-slate-400 py-0.5">{t(`investmentProfitReport.weekday.${w}`)}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-[1px]">
              {monthGrid.map((c, i) => renderDay(c, `md${i}`, c?.date === new Date().toISOString().slice(0, 10)))}
            </div>
          </>
        ) : (
          <div className="grid grid-cols-4 gap-1.5">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => {
              const lbl = monthLabel(language, m);
              const info = yearMonths.find(x => x.month === m);
              const pnl = info?.pnl ?? null;
              let bg = "bg-slate-50/50", tc = "text-slate-400";
              if (info) {
                if (pnl != null && pnl > 0) { bg = "bg-red-50"; tc = "text-red-600"; }
                else if (pnl != null && pnl < 0) { bg = "bg-emerald-50"; tc = "text-emerald-600"; }
                else if (pnl != null) { bg = "bg-slate-100"; tc = "text-slate-500"; }
              }
              const isCurrent = m === now.getMonth() + 1 && year === now.getFullYear();
              return (
                <div key={`ym${m}`}
                  onClick={() => { setMonth(m); setViewMode("month"); }}
                  className={`rounded-sm px-2 py-2 cursor-pointer hover:opacity-80 ${bg} ${isCurrent ? "ring-1 ring-blue-400" : ""}`}>
                  <div className={`text-xs font-semibold ${info ? tc : "text-slate-500"}`}>{lbl}</div>
                  <div className={`text-[11px] tabular-nums mt-1 ${info ? tc : "text-slate-400"}`}>
                    {loading ? "…" : info ? `${pnl != null && pnl >= 0 ? "+" : ""}${pnl != null ? pnl.toFixed(0) : "—"}` : "—"}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
