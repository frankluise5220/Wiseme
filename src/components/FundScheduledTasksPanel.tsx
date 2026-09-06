"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Pause, Pencil, Play } from "lucide-react";

import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

export type RelatedScheduledTask = {
  id: string;
  taskType?: string | null;
  taskTitle?: string | null;
  planName?: string | null;
  targetName?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  accountInstitutionName?: string | null;
  cashAccountId?: string | null;
  cashAccountName?: string | null;
  fundCode?: string | null;
  fundName?: string | null;
  amount?: number | string | null;
  intervalUnit?: string | null;
  intervalValue?: number | string | null;
  executionDay?: number | string | null;
  secondaryExecutionDay?: number | string | null;
  startDate?: string | null;
  endDate?: string | null;
  nextRunDate?: string | null;
  lastRunDate?: string | null;
  totalRuns?: number | string | null;
  executedRuns?: number | string | null;
  feeRate?: number | string | null;
  confirmDays?: number | string | null;
  arrivalDays?: number | string | null;
  skipPendingPreceding?: boolean | null;
  status?: string | null;
  isSystemTask?: boolean | null;
};

type ScheduledTaskListResponse = {
  ok?: boolean;
  plans?: RelatedScheduledTask[];
  error?: string;
};

const WEEKDAY_LABELS: Record<number, string> = {
  1: "regularInvest.client.weekdayShort.1",
  2: "regularInvest.client.weekdayShort.2",
  3: "regularInvest.client.weekdayShort.3",
  4: "regularInvest.client.weekdayShort.4",
  5: "regularInvest.client.weekdayShort.5",
  6: "regularInvest.client.weekdayShort.6",
  7: "regularInvest.client.weekdayShort.7",
};

const STATUS_MAP: Record<string, { labelKey: string; cls: string }> = {
  active: { labelKey: "regularInvest.client.status.active", cls: "text-emerald-600" },
  paused: { labelKey: "regularInvest.client.status.paused", cls: "text-amber-600" },
  stopped: { labelKey: "regularInvest.client.status.stopped", cls: "text-rose-600" },
  completed: { labelKey: "regularInvest.client.status.completed", cls: "text-blue-600" },
};

function toNumber(value: unknown, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalNumber(value: unknown) {
  const parsed = toNumber(value, NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "-";
}

function statusLabel(status: string | null | undefined, t: (key: string, params?: Record<string, string | number>) => string) {
  const key = status ? STATUS_MAP[status]?.labelKey : null;
  return key ? t(key) : status || "-";
}

function taskLabel(plan: RelatedScheduledTask) {
  return plan.planName?.trim() || plan.taskTitle || plan.targetName || plan.fundName || plan.fundCode || "-";
}

function formatInterval(plan: RelatedScheduledTask, t: (key: string, params?: Record<string, string | number>) => string) {
  if (toOptionalNumber(plan.totalRuns) === 1) return t("regularInvest.interval.once");
  const rawUnit = plan.intervalUnit || "month";
  const intervalUnit = rawUnit === "biweek" ? "week" : rawUnit;
  const intervalValue = rawUnit === "biweek"
    ? Math.max(1, toNumber(plan.intervalValue, 1)) * 2
    : Math.max(1, toNumber(plan.intervalValue, 1));
  const executionDay = toOptionalNumber(plan.executionDay);

  if (intervalUnit === "week" && executionDay) {
    const weekday = t(WEEKDAY_LABELS[executionDay] ?? "");
    if (weekday) {
      return intervalValue > 1
        ? t("regularInvest.client.weekLabelN", { count: intervalValue, weekday })
        : t("regularInvest.client.weekLabel", { weekday });
    }
  }
  if (intervalUnit === "month" && executionDay) {
    return intervalValue > 1
      ? t("regularInvest.client.everyNMonthDay", { count: intervalValue, day: executionDay })
      : t("regularInvest.client.everyMonthDay", { day: executionDay });
  }
  if (intervalUnit === "year" && executionDay) {
    const month = Math.floor(executionDay / 100);
    const day = executionDay % 100;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return intervalValue > 1
        ? t("regularInvest.client.everyNYearDate", { count: intervalValue, month, day })
        : t("regularInvest.client.everyYearDate", { month, day });
    }
  }
  if (intervalValue > 1) {
    if (intervalUnit === "day") return t("regularInvest.client.everyNDay", { count: intervalValue });
    if (intervalUnit === "week") return t("regularInvest.client.everyNWeek", { count: intervalValue });
    if (intervalUnit === "month") return t("regularInvest.client.everyNMonth", { count: intervalValue });
    if (intervalUnit === "year") return t("regularInvest.client.everyNYear", { count: intervalValue });
  }
  return t(`regularInvest.interval.${intervalUnit}`);
}

function compareTasks(a: RelatedScheduledTask, b: RelatedScheduledTask) {
  const statusRank: Record<string, number> = { active: 0, paused: 1, stopped: 2, completed: 3 };
  const rankA = statusRank[a.status || ""] ?? 4;
  const rankB = statusRank[b.status || ""] ?? 4;
  if (rankA !== rankB) return rankA - rankB;
  const timeA = a.nextRunDate ? new Date(a.nextRunDate).getTime() : Number.POSITIVE_INFINITY;
  const timeB = b.nextRunDate ? new Date(b.nextRunDate).getTime() : Number.POSITIVE_INFINITY;
  if (timeA !== timeB) return timeA - timeB;
  return taskLabel(a).localeCompare(taskLabel(b), undefined, { numeric: true });
}

function isVisibleRelatedFundTask(plan: RelatedScheduledTask, fundCode: string) {
  return (plan.taskType || "fund_regular_invest") === "fund_regular_invest"
    && plan.fundCode === fundCode
    && String(plan.status ?? "").toLowerCase() !== "completed";
}

function relatedFundTasks(plans: RelatedScheduledTask[], fundCode: string) {
  return plans
    .filter((plan) => isVisibleRelatedFundTask(plan, fundCode))
    .sort(compareTasks);
}

export function FundScheduledTasksPanel({
  accountId,
  fundCode,
  preloadedPlans,
  onEdit,
  reloadToken,
}: {
  accountId: string;
  fundCode: string;
  preloadedPlans?: RelatedScheduledTask[];
  onEdit?: (plan: RelatedScheduledTask) => void;
  reloadToken?: number;
}) {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<RelatedScheduledTask[]>(() =>
    relatedFundTasks(preloadedPlans ?? [], fundCode),
  );
  const [loading, setLoading] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const loadSequence = useRef(0);

  const loadTasks = useCallback(async () => {
    if (!accountId || !fundCode) return;
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/regular-invest?accountId=${encodeURIComponent(accountId)}`, { cache: "no-store" });
      const data = (await response.json().catch(() => null)) as ScheduledTaskListResponse | null;
      if (!response.ok || !data?.ok || !Array.isArray(data.plans)) {
        throw new Error(data?.error || t("fundSettings.scheduledTaskLoadFailed"));
      }
      if (sequence !== loadSequence.current) return;
      setTasks(relatedFundTasks(data.plans, fundCode));
    } catch (e) {
      if (sequence === loadSequence.current) {
        setError(e instanceof Error ? e.message : t("fundSettings.scheduledTaskLoadFailed"));
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [accountId, fundCode, t]);

  useEffect(() => {
    setTasks(relatedFundTasks(preloadedPlans ?? [], fundCode));
  }, [fundCode, preloadedPlans]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    if (reloadToken) void loadTasks();
  }, [reloadToken, loadTasks]);

  const updateStatus = useCallback(async (planId: string, action: "pause" | "resume") => {
    setBusyTaskId(planId);
    setError("");
    try {
      const response = await fetch("/api/v1/regular-invest", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: planId, action }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; plan?: Partial<RelatedScheduledTask>; error?: string } | null;
      if (!response.ok || !data?.ok) throw new Error(data?.error || t("fundSettings.scheduledTaskActionFailed"));
      const fallbackStatus = action === "pause" ? "paused" : "active";
      setTasks((current) => current
        .map((plan) => plan.id === planId
          ? {
              ...plan,
              status: data.plan?.status ?? fallbackStatus,
              nextRunDate: data.plan?.nextRunDate ?? plan.nextRunDate,
            }
          : plan)
        .filter((plan) => isVisibleRelatedFundTask(plan, fundCode))
        .sort(compareTasks));
      dispatchFinanceDataChanged({ reason: "fund-profile-scheduled-task-status", accountIds: [accountId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fundSettings.scheduledTaskActionFailed"));
    } finally {
      setBusyTaskId(null);
    }
  }, [accountId, fundCode, t]);

  if (loading && tasks.length === 0) {
    return (
      <div className="flex h-20 items-center justify-center rounded-md border border-slate-200 bg-white text-sm text-slate-400">
        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-slate-200 bg-slate-50/60 px-3 py-3 text-xs text-slate-400">
        {error || t("fundSettings.scheduledTaskEmpty")}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="max-h-[160px] overflow-auto rounded-md border border-slate-200">
        <table className="w-full border-collapse text-xs">
          <thead className="bg-slate-50">
            <tr>
              <th className="border-b border-slate-200 px-1.5 py-1.5 text-left font-semibold text-slate-600">{t("viewImport.fundAccount")}</th>
              <th className="border-b border-slate-200 px-1.5 py-1.5 text-right font-semibold text-slate-600">{t("stats.amount")}</th>
              <th className="border-b border-slate-200 px-1.5 py-1.5 text-left font-semibold text-slate-600">{t("creditBill.period")}</th>
              <th className="border-b border-slate-200 px-1.5 py-1.5 text-left font-semibold text-slate-600">{t("regularInvest.client.column.nextRun")}</th>
              <th className="border-b border-slate-200 px-1.5 py-1.5 text-left font-semibold text-slate-600">{t("depositShell.colStatus")}</th>
              <th className="w-20 border-b border-slate-200 px-1.5 py-1.5 text-right font-semibold text-slate-600">{t("detail.column.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((plan) => {
              const status = plan.status || "";
              const busy = busyTaskId === plan.id;
              return (
                <tr key={plan.id} className="hover:bg-slate-50">
                  <td className="border-b border-slate-100 px-1.5 py-1.5 font-medium text-slate-800" title={plan.accountName || ""}>
                    <div className="max-w-[150px] truncate">{plan.accountName || "-"}</div>
                    {plan.accountInstitutionName ? (
                      <div className="mt-0.5 max-w-[150px] truncate text-[11px] text-slate-400" title={plan.accountInstitutionName}>{plan.accountInstitutionName}</div>
                    ) : null}
                  </td>
                  <td className="border-b border-slate-100 px-1.5 py-1.5 text-right tabular-nums text-slate-700">{toNumber(plan.amount).toFixed(2)}</td>
                  <td className="border-b border-slate-100 px-1.5 py-1.5 text-slate-500">{formatInterval(plan, t)}</td>
                  <td className="border-b border-slate-100 px-1.5 py-1.5 tabular-nums text-slate-500">{status === "paused" ? "-" : formatDate(plan.nextRunDate)}</td>
                  <td className="border-b border-slate-100 px-1.5 py-1.5">
                    <span className={STATUS_MAP[status]?.cls || "text-slate-600"}>{statusLabel(status, t)}</span>
                  </td>
                  <td className="border-b border-slate-100 px-1.5 py-1.5">
                    <div className="flex items-center justify-end gap-1">
                      {status === "active" ? (
                        <button
                          type="button"
                          onClick={() => void updateStatus(plan.id, "pause")}
                          disabled={busy}
                          className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-amber-600 hover:border-amber-200 hover:bg-amber-50 disabled:opacity-50"
                          title={t("fundShell.plan.pause")}
                          aria-label={t("fundShell.plan.pause")}
                        >
                          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pause className="h-3.5 w-3.5" />}
                        </button>
                      ) : status === "paused" ? (
                        <button
                          type="button"
                          onClick={() => void updateStatus(plan.id, "resume")}
                          disabled={busy}
                          className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-emerald-600 hover:border-emerald-200 hover:bg-emerald-50 disabled:opacity-50"
                          title={t("fundShell.plan.resume")}
                          aria-label={t("fundShell.plan.resume")}
                        >
                          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                        </button>
                      ) : (
                        <span className="text-slate-300">-</span>
                      )}
                      {onEdit ? (
                        <button
                          type="button"
                          onClick={() => onEdit(plan)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-blue-600 hover:border-blue-200 hover:bg-blue-50"
                          title={t("regularInvest.client.action.edit")}
                          aria-label={t("regularInvest.client.action.edit")}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {error ? <div className="text-xs text-rose-600">{error}</div> : null}
    </div>
  );
}
