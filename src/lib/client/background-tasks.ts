"use client";

export const BACKGROUND_TASK_PROGRESS_EVENT = "mmh:background-task:progress";

export type BackgroundTaskStatus = "running" | "done" | "error";

export type BackgroundTaskProgressDetail = {
  id: string;
  title: string;
  status: BackgroundTaskStatus;
  current?: number;
  total?: number;
  currentLabel?: string;
  ok?: number;
  fail?: number;
  messages?: string[];
  updatedAt?: number;
  autoCloseMs?: number | null;
};

export type BackgroundTaskProgressEventDetail =
  | (BackgroundTaskProgressDetail & { action?: "upsert" })
  | { action: "clear"; id: string };

export function dispatchBackgroundTaskProgress(detail: BackgroundTaskProgressDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<BackgroundTaskProgressEventDetail>(BACKGROUND_TASK_PROGRESS_EVENT, {
    detail: { ...detail, action: "upsert", updatedAt: Date.now() },
  }));
}

export function clearBackgroundTaskProgress(id: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<BackgroundTaskProgressEventDetail>(BACKGROUND_TASK_PROGRESS_EVENT, {
    detail: { action: "clear", id },
  }));
}
