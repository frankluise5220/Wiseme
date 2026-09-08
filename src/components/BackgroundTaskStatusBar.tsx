"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import {
  BACKGROUND_TASK_PROGRESS_EVENT,
  type BackgroundTaskProgressDetail,
  type BackgroundTaskProgressEventDetail,
} from "@/lib/client/background-tasks";
import { useI18n } from "@/lib/i18n";

type TaskMap = Record<string, BackgroundTaskProgressDetail>;

function progressPercent(task: BackgroundTaskProgressDetail) {
  if (!task.total || task.total <= 0) return task.status === "running" ? 12 : 100;
  return Math.max(0, Math.min(100, Math.round(((task.current ?? 0) / task.total) * 100)));
}

function pickVisibleTask(tasks: BackgroundTaskProgressDetail[]) {
  const running = tasks.filter((task) => task.status === "running");
  const source = running.length > 0 ? running : tasks;
  return [...source].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null;
}

export function BackgroundTaskStatusBar() {
  const [tasks, setTasks] = useState<TaskMap>({});
  const cleanupTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const { t } = useI18n();

  useEffect(() => {
    const onProgress = (event: Event) => {
      const detail = (event as CustomEvent<BackgroundTaskProgressEventDetail>).detail;
      if (!detail?.id) return;

      if (detail.action === "clear") {
        if (cleanupTimersRef.current[detail.id]) {
          clearTimeout(cleanupTimersRef.current[detail.id]);
          delete cleanupTimersRef.current[detail.id];
        }
        setTasks((prev) => {
          const next = { ...prev };
          delete next[detail.id];
          return next;
        });
        return;
      }

      setTasks((prev) => ({
        ...prev,
        [detail.id]: {
          ...prev[detail.id],
          ...detail,
          messages: detail.messages ?? prev[detail.id]?.messages ?? [],
        },
      }));

      if (detail.status !== "running") {
        if (cleanupTimersRef.current[detail.id]) clearTimeout(cleanupTimersRef.current[detail.id]);
        const autoCloseMs = detail.autoCloseMs ?? (detail.status === "done" ? 5000 : 9000);
        if (autoCloseMs != null && autoCloseMs > 0) {
          cleanupTimersRef.current[detail.id] = setTimeout(() => {
            setTasks((prev) => {
              const next = { ...prev };
              delete next[detail.id];
              return next;
            });
            delete cleanupTimersRef.current[detail.id];
          }, autoCloseMs);
        }
      }
    };

    window.addEventListener(BACKGROUND_TASK_PROGRESS_EVENT, onProgress);
    return () => {
      window.removeEventListener(BACKGROUND_TASK_PROGRESS_EVENT, onProgress);
      for (const timer of Object.values(cleanupTimersRef.current)) clearTimeout(timer);
      cleanupTimersRef.current = {};
    };
  }, []);

  const taskList = useMemo(() => Object.values(tasks), [tasks]);
  const visibleTask = pickVisibleTask(taskList);
  if (!visibleTask) return null;

  const percent = progressPercent(visibleTask);
  const runningCount = taskList.filter((task) => task.status === "running").length;
  const statusClass = visibleTask.status === "error"
    ? "border-amber-200 bg-amber-50 text-amber-800"
    : visibleTask.status === "done"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : "border-blue-200 bg-white text-slate-800";
  const barClass = visibleTask.status === "error"
    ? "bg-amber-500"
    : visibleTask.status === "done"
      ? "bg-emerald-500"
      : "bg-blue-600";
  const latestMessage = visibleTask.messages?.[visibleTask.messages.length - 1] ?? "";

  return (
    <div className="pointer-events-none fixed left-1/2 top-3 z-[70] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2">
      <div className={`pointer-events-auto overflow-hidden rounded-xl border shadow-lg shadow-slate-900/10 backdrop-blur ${statusClass}`}>
        <div className="flex items-start gap-3 px-3 py-2.5">
          <div className="mt-0.5 shrink-0">
            {visibleTask.status === "running" ? (
              <Loader2 className="h-4 w-4 animate-spin text-blue-600" />
            ) : visibleTask.status === "done" ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <AlertTriangle className="h-4 w-4 text-amber-600" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="truncate text-sm font-semibold">{visibleTask.title}</div>
              {runningCount > 1 ? (
                <span className="shrink-0 rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium text-blue-700">
                  {t("backgroundTask.runningCount", { count: runningCount })}
                </span>
              ) : null}
              <span className="ml-auto shrink-0 text-xs tabular-nums opacity-70">{percent}%</span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs opacity-80">
              <span className="min-w-0 truncate">{visibleTask.currentLabel || latestMessage || t("backgroundTask.processing")}</span>
              {visibleTask.total ? (
                <span className="shrink-0 tabular-nums">{visibleTask.current ?? 0}/{visibleTask.total}</span>
              ) : null}
              {visibleTask.ok || visibleTask.fail ? (
                <span className="shrink-0 tabular-nums">{t("backgroundTask.okFail", { ok: visibleTask.ok ?? 0, fail: visibleTask.fail ?? 0 })}</span>
              ) : null}
            </div>
          </div>
          {visibleTask.status !== "running" ? (
            <button
              type="button"
              onClick={() => {
                setTasks((prev) => {
                  const next = { ...prev };
                  delete next[visibleTask.id];
                  return next;
                });
              }}
              className="shrink-0 rounded-md p-1 text-slate-400 transition-colors hover:bg-white/70 hover:text-slate-700"
              title={t("table.close")}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
        <div className="h-1 bg-slate-100">
          <div className={`h-full transition-all duration-300 ${barClass}`} style={{ width: `${percent}%` }} />
        </div>
      </div>
    </div>
  );
}
