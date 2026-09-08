"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";

let startupCheckStarted = false;
let startupCheckCompleted = false;
let startupCheckAttempts = 0;
const MAX_STARTUP_CHECK_ATTEMPTS = 3;

function hasUsefulChange(result: unknown) {
  if (!result || typeof result !== "object") return false;
  const data = result as Record<string, unknown>;
  const executedCount = Number(data.executedCount ?? 0);
  const filled = Number(data.filled ?? data.entryFilled ?? 0);
  const navFilled = Number(data.navFilled ?? data.entryNavFilled ?? 0);
  const holdingNavRefreshed = Number(data.holdingNavRefreshed ?? 0);
  const stockRefreshed = Number(data.refreshed ?? 0);
  const nameFixed = Number(data.nameFixed ?? 0);
  return executedCount > 0 || filled > 0 || navFilled > 0 || holdingNavRefreshed > 0 || nameFixed > 0 || stockRefreshed > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function getEntryIds(result: unknown): string[] | undefined {
  if (!isObject(result) || !Array.isArray(result.entryIds)) return undefined;
  return result.entryIds.filter((id): id is string => typeof id === "string");
}

function assertOkResponse(res: Response, data: unknown, label: string) {
  if (!res.ok) {
    throw new Error(`${label} failed: HTTP ${res.status}`);
  }
  if (!isObject(data)) {
    throw new Error(`${label} failed: empty response data`);
  }
  if (data.ok === false) {
    throw new Error(`${label} failed: ${typeof data.error === "string" ? data.error : "unknown error"}`);
  }
}

export function DailyTaskCheck() {
  const running = useRef(false);
  const pathname = usePathname();

  useEffect(() => {
    if (startupCheckCompleted || startupCheckStarted || running.current || startupCheckAttempts >= MAX_STARTUP_CHECK_ATTEMPTS) return;
    let cancelled = false;
    let retryTimer: number | undefined;

    const run = async () => {
      if (cancelled || startupCheckCompleted || startupCheckStarted || running.current) return;
      startupCheckStarted = true;
      startupCheckAttempts += 1;
      running.current = true;
      try {
        const planRes = await fetch("/api/v1/regular-invest/auto-execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const planData = await planRes.json().catch(() => null);
        assertOkResponse(planRes, planData, "scheduled task auto-execution");

        const pendingRes = await fetch("/api/v1/fund/refresh-pending", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const pendingData = await pendingRes.json().catch(() => null);
        assertOkResponse(pendingRes, pendingData, "fund pending refresh");

        const stockRes = await fetch("/api/v1/stocks/prices/refresh-daily", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const stockData = await stockRes.json().catch(() => null);
        assertOkResponse(stockRes, stockData, "stock close price refresh");

        if (hasUsefulChange(planData) || hasUsefulChange(pendingData) || hasUsefulChange(stockData)) {
          dispatchFinanceDataChanged({ reason: "startup-check", entryIds: getEntryIds(pendingData) });
        }
        startupCheckCompleted = true;
      } catch (error) {
        console.warn("[DailyTaskCheck] startup check failed", error);
        startupCheckStarted = false;
        if (!cancelled && startupCheckAttempts < MAX_STARTUP_CHECK_ATTEMPTS) {
          retryTimer = window.setTimeout(() => void run(), 5000);
        }
      } finally {
        running.current = false;
      }
    };

    const requestIdle = window.requestIdleCallback;
    if (requestIdle) {
      const idleId = requestIdle(() => void run(), { timeout: 3000 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback?.(idleId);
        if (retryTimer != null) window.clearTimeout(retryTimer);
        if (!running.current && !startupCheckCompleted) startupCheckStarted = false;
      };
    }
    const timer = window.setTimeout(() => void run(), 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (retryTimer != null) window.clearTimeout(retryTimer);
      if (!running.current && !startupCheckCompleted) startupCheckStarted = false;
    };
  }, [pathname]);

  return null;
}