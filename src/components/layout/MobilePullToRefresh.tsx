"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";

const REFRESH_THRESHOLD = 72;
const MAX_PULL = 104;

function findScrollableElement(target: EventTarget | null): Element | Document {
  if (!(target instanceof Element)) return document;
  let current: Element | null = target;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    const canScroll = /(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight;
    if (canScroll) return current;
    current = current.parentElement;
  }
  return document;
}

function getScrollTop(target: Element | Document) {
  if (target === document) return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
  return (target as Element).scrollTop;
}

export function MobilePullToRefresh() {
  const router = useRouter();
  const { t } = useI18n();
  const startYRef = useRef(0);
  const scrollTargetRef = useRef<Element | Document | null>(null);
  const draggingRef = useRef(false);
  const pullRef = useRef(0);
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const updatePull = useCallback((value: number) => {
    pullRef.current = value;
    setPull(value);
  }, []);

  useEffect(() => {
    function resetPull() {
      draggingRef.current = false;
      scrollTargetRef.current = null;
      updatePull(0);
    }

    function onTouchStart(event: TouchEvent) {
      if (window.innerWidth >= 768 || refreshing || event.touches.length !== 1) return;
      const scrollTarget = findScrollableElement(event.target);
      if (getScrollTop(scrollTarget) > 0) return;
      startYRef.current = event.touches[0].clientY;
      scrollTargetRef.current = scrollTarget;
      draggingRef.current = true;
    }

    function onTouchMove(event: TouchEvent) {
      if (!draggingRef.current || refreshing || event.touches.length !== 1) return;
      const scrollTarget = scrollTargetRef.current;
      if (!scrollTarget || getScrollTop(scrollTarget) > 0) {
        resetPull();
        return;
      }
      const delta = event.touches[0].clientY - startYRef.current;
      if (delta <= 0) {
        updatePull(0);
        return;
      }
      const dampedPull = Math.min(MAX_PULL, Math.round(delta * 0.55));
      if (dampedPull > 8) event.preventDefault();
      updatePull(dampedPull);
    }

    function onTouchEnd() {
      if (!draggingRef.current) return;
      const shouldRefresh = pullRef.current >= REFRESH_THRESHOLD;
      resetPull();
      if (!shouldRefresh || refreshing) return;
      setRefreshing(true);
      router.refresh();
      window.setTimeout(() => setRefreshing(false), 900);
    }

    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", resetPull, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", resetPull);
    };
  }, [refreshing, router, updatePull]);

  const visible = refreshing || pull > 0;
  const ready = pull >= REFRESH_THRESHOLD;
  const translate = refreshing ? 16 : Math.min(20, Math.round(pull / 5));

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.35rem)] z-[70] flex justify-center transition-opacity duration-150 md:hidden ${visible ? "opacity-100" : "opacity-0"}`}
      style={{ transform: `translateY(${translate}px)` }}
      aria-hidden={!visible}
    >
      <div className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white/95 px-3 text-xs font-medium text-slate-600 shadow-[0_10px_24px_rgba(15,23,42,0.16)] backdrop-blur">
        <RefreshCw size={15} className={refreshing ? "animate-spin text-indigo-600" : ready ? "text-indigo-600" : "text-slate-400"} />
        <span>{refreshing ? t("mobileRefresh.refreshing") : ready ? t("mobileRefresh.release") : t("mobileRefresh.pull")}</span>
      </div>
    </div>
  );
}
