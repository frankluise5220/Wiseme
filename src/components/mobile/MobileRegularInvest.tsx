"use client";

import { useMemo, useState } from "react";
import { CalendarClock, ChevronRight, Pause, Play, Repeat2 } from "lucide-react";
import { formatMoneyYuan } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import type { ScheduledTaskType } from "@/lib/scheduled-task";

type MobilePlan = {
  id: string;
  taskType?: ScheduledTaskType;
  taskTypeLabel?: string | null;
  taskTitle?: string | null;
  planName?: string | null;
  targetName?: string | null;
  taskCategoryName?: string | null;
  fundName?: string | null;
  fundCode: string;
  accountLabel?: string | null;
  cashAccountLabel?: string | null;
  amount: number;
  intervalUnit: string;
  intervalValue: number;
  executionDay?: number | null;
  secondaryExecutionDay?: number | null;
  totalRuns?: number | null;
  nextRunDate?: string | null;
  executedCount?: number;
  status: string;
  /** Mortgage "bill" plans are system-generated and read-only. */
  isSystemTask?: boolean;
};

type Filter = "active" | "paused" | "all";

type TFunc = (key: string, params?: Record<string, string | number>) => string;

export function MobileRegularInvest({ plans }: { plans: MobilePlan[] }) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<Filter>("active");
  const [busyId, setBusyId] = useState<string | null>(null);

  const visiblePlans = useMemo(
    () => plans.filter((plan) => filter === "all" || plan.status === filter),
    [filter, plans],
  );

  async function updateStatus(plan: MobilePlan) {
    const action = plan.status === "active" ? "pause" : "resume";
    setBusyId(plan.id);
    try {
      const response = await fetch("/api/v1/regular-invest", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: plan.id, action }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.ok) throw new Error(result?.error ?? t("mobileRegularInvest.updateFailed"));
      window.location.reload();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("mobileRegularInvest.updateFailed"));
      setBusyId(null);
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-slate-100">
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50/95 px-3 py-2 backdrop-blur">
        <div className="flex items-center justify-between px-1">
          <h1 className="text-sm font-semibold text-slate-900">{t("nav.scheduledTasks")}</h1>
          <span className="text-xs tabular-nums text-slate-500">{t("mobileRegularInvest.planCount", { count: plans.length })}</span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-slate-200 p-1">
          {(["active", "paused", "all"] as const).map((value) => (
            <button key={value} type="button" onClick={() => setFilter(value)} className={`h-9 rounded-md text-xs font-semibold ${filter === value ? "bg-white text-indigo-700 shadow-sm" : "text-slate-600"}`}>
              {value === "active" ? t("regularInvest.client.status.active") : value === "paused" ? t("regularInvest.client.status.paused") : t("common.all")}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2 px-3 py-3 pb-6">
        {visiblePlans.map((plan) => {
          const active = plan.status === "active";
          return (
            <article key={plan.id} className="rounded-lg border border-slate-200 bg-white px-3 py-3 shadow-sm">
              <div className="flex items-start gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${active ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-500"}`}>
                  <Repeat2 size={19} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-semibold text-slate-900">{plan.planName || plan.taskTitle || plan.targetName || plan.taskCategoryName || plan.fundName || plan.fundCode}</h2>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{active ? t("regularInvest.client.status.active") : statusLabel(plan.status, t)}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-slate-500">{taskTypeLabel(plan, t)} · {plan.accountLabel || t("mobileRegularInvest.noTargetAccount")}</p>
                </div>
                <button type="button" disabled={busyId === plan.id || plan.isSystemTask === true || (plan.status !== "active" && plan.status !== "paused")} onClick={() => updateStatus(plan)} title={plan.isSystemTask ? t("regularInvest.client.systemTask.title") : undefined} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-600 disabled:opacity-40" aria-label={t(active ? "mobileRegularInvest.pausePlan" : "mobileRegularInvest.resumePlan")}>
                  {active ? <Pause size={18} /> : <Play size={18} />}
                </button>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3">
                <Metric label={t("initModal.ri.amountPerPeriod")} value={formatMoneyYuan(plan.amount)} />
                <Metric label={t("mobileRegularInvest.executionCycle")} value={formatInterval(plan, t)} />
                <Metric label={t("regularInvest.client.recordsCol.executed")} value={t("mobileRegularInvest.executedCount", { count: plan.executedCount ?? 0 })} alignRight />
              </div>
              {plan.status === "paused" ? (
                plan.cashAccountLabel ? (
                  <div className="mt-3 flex min-w-0 items-center gap-1.5 text-xs text-slate-500">
                    <span className="truncate">{plan.cashAccountLabel}</span>
                    <ChevronRight size={15} className="ml-auto shrink-0 text-slate-400" />
                  </div>
                ) : null
              ) : (
                <div className="mt-3 flex min-w-0 items-center gap-1.5 text-xs text-slate-500">
                  <CalendarClock size={14} className="shrink-0" />
                  <span className="truncate">{t("mobileRegularInvest.nextRun", { date: formatDate(plan.nextRunDate, t) })}</span>
                  {plan.cashAccountLabel ? <><span className="text-slate-300">·</span><span className="truncate">{plan.cashAccountLabel}</span></> : null}
                  <ChevronRight size={15} className="ml-auto shrink-0 text-slate-400" />
                </div>
              )}
            </article>
          );
        })}
        {visiblePlans.length === 0 ? <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-12 text-center text-sm text-slate-500">{t("mobileRegularInvest.noMatchingPlans")}</div> : null}
      </div>
    </div>
  );
}

function Metric({ label, value, alignRight = false }: { label: string; value: string; alignRight?: boolean }) {
  return <div className={`min-w-0 ${alignRight ? "text-right" : ""}`}><div className="text-[11px] text-slate-500">{label}</div><div className="mt-1 truncate text-xs font-semibold tabular-nums text-slate-900">{value}</div></div>;
}

function formatInterval(plan: MobilePlan, t: TFunc) {
  if (plan.totalRuns === 1) return t("regularInvest.interval.once");
  const unitKey = plan.intervalUnit === "day"
    ? "mobileRegularInvest.unit.day"
    : plan.intervalUnit === "week"
      ? "mobileRegularInvest.unit.week"
      : plan.intervalUnit === "year"
        ? "mobileRegularInvest.unit.year"
        : "mobileRegularInvest.unit.month";
  if (
    (plan.intervalUnit === "week" || plan.intervalUnit === "biweek") &&
    plan.intervalValue === 1 &&
    plan.executionDay != null &&
    plan.secondaryExecutionDay != null
  ) {
    const weekdayKey = (value: number) => `regularInvest.client.weekdayShort.${Math.min(7, Math.max(1, value))}` as const;
    const primary = t(weekdayKey(plan.executionDay));
    const secondary = t(weekdayKey(plan.secondaryExecutionDay));
    if (primary && secondary) return `${primary} / ${secondary}`;
  }
  if (
    (plan.intervalUnit === "month" || plan.intervalUnit === "year") &&
    plan.intervalValue === 1 &&
    plan.executionDay != null &&
    plan.secondaryExecutionDay != null
  ) {
    const primary = plan.intervalUnit === "month"
      ? t("regularInvest.daySuffix", { day: plan.executionDay })
      : t("regularInvest.client.everyYearDate", {
          month: Math.floor(plan.executionDay / 100),
          day: plan.executionDay % 100,
        });
    const secondary = plan.intervalUnit === "month"
      ? t("regularInvest.daySuffix", { day: plan.secondaryExecutionDay })
      : t("regularInvest.client.everyYearDate", {
          month: Math.floor(plan.secondaryExecutionDay / 100),
          day: plan.secondaryExecutionDay % 100,
        });
    return `${primary} / ${secondary}`;
  }
  return t("mobileRegularInvest.intervalFormat", { value: plan.intervalValue || 1, unit: t(unitKey) });
}

function formatDate(value: string | null | undefined, t: TFunc) {
  if (!value) return t("mobileRegularInvest.notScheduled");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function statusLabel(status: string, t: TFunc) {
  if (status === "completed") return t("regularInvest.client.status.completed");
  if (status === "stopped") return t("regularInvest.client.status.stopped");
  return status || t("mobileRegularInvest.status.unknown");
}

function taskTypeLabel(plan: MobilePlan, t: TFunc) {
  if (plan.taskType === "fund_regular_invest") return t("detailView.fundRegularInvest");
  if (plan.taskType === "transfer") return t("transaction.type.transfer");
  if (plan.taskType === "insurance_premium") return t("regularInvest.taskType.insurancePremium");
  if (plan.taskType === "income") return t("transaction.type.income");
  if (plan.taskType === "expense") return t("transaction.type.expense");
  return plan.taskTypeLabel || t("batchImport.fundSource.regularInvest");
}
