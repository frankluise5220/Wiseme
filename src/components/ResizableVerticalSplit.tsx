"use client";

import { Children, useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";

const DEFAULT_UPPER_HEIGHT = 440;
const DEFAULT_MIN_PANE_HEIGHT = 104;

function heightBounds(availableHeight: number, minPaneHeight: number) {
  const boundedHeight = Math.max(minPaneHeight, availableHeight);
  const minHeight = Math.min(minPaneHeight, boundedHeight);
  const maxHeight = Math.max(minHeight, boundedHeight - minPaneHeight);
  return { minHeight, maxHeight };
}

function clampHeight(value: number, availableHeight: number, minPaneHeight: number) {
  const { minHeight, maxHeight } = heightBounds(availableHeight, minPaneHeight);
  return Math.min(maxHeight, Math.max(minHeight, Math.round(value)));
}

export function ResizableVerticalSplit({
  storageKey,
  hasLowerPane,
  children,
  defaultUpperHeight = DEFAULT_UPPER_HEIGHT,
  minPaneHeight = DEFAULT_MIN_PANE_HEIGHT,
  separatorLabel,
  separatorTitle,
  stackOnMobile = false,
  stackLowerFirstOnMobile = false,
}: {
  storageKey: string;
  hasLowerPane: boolean;
  children: ReactNode;
  defaultUpperHeight?: number;
  minPaneHeight?: number;
  separatorLabel?: string;
  separatorTitle?: string;
  stackOnMobile?: boolean;
  stackLowerFirstOnMobile?: boolean;
}) {
  const { t } = useI18n();
  const effectiveSeparatorLabel = separatorLabel ?? t("resizableSplit.separatorLabel");
  const effectiveSeparatorTitle = separatorTitle ?? t("resizableSplit.separatorTitle");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [upperHeight, setUpperHeight] = useState(defaultUpperHeight);
  const [minimumUpperHeight, setMinimumUpperHeight] = useState(minPaneHeight);
  const [isMobileStacked, setIsMobileStacked] = useState(false);
  const sections = Children.toArray(children);
  const upper = sections[0] ?? null;
  const lower = sections.length > 1 ? sections[sections.length - 1] : null;
  const floatingChildren = sections.length > 2 ? sections.slice(1, -1) : [];

  useEffect(() => {
    if (!stackOnMobile) {
      setIsMobileStacked(false);
      return;
    }
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobileStacked(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [stackOnMobile]);

  useEffect(() => {
    const stored = Number(window.localStorage.getItem(storageKey));
    const container = containerRef.current;
    if (!container) return;

    function applyBounds(availableHeight: number) {
      setMinimumUpperHeight(heightBounds(availableHeight, minPaneHeight).minHeight);
      setUpperHeight((current) => clampHeight(current, availableHeight, minPaneHeight));
    }

    const initialHeight = container.clientHeight;
    setMinimumUpperHeight(heightBounds(initialHeight, minPaneHeight).minHeight);
    setUpperHeight(clampHeight(Number.isFinite(stored) && stored > 0 ? stored : defaultUpperHeight, initialHeight, minPaneHeight));

    const resizeObserver = new ResizeObserver((entries) => {
      applyBounds(entries[0]?.contentRect.height ?? container.clientHeight);
    });
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      document.body.style.userSelect = "";
    };
  }, [defaultUpperHeight, minPaneHeight, storageKey]);

  function updateHeight(clientY: number) {
    const container = containerRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    setUpperHeight(clampHeight(clientY - containerTop, container.clientHeight, minPaneHeight));
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => updateHeight(moveEvent.clientY);
    const finishResize = (upEvent: globalThis.PointerEvent) => {
      updateHeight(upEvent.clientY);
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      const container = containerRef.current;
      if (!container) return;
      const containerTop = container.getBoundingClientRect().top;
      const nextHeight = clampHeight(upEvent.clientY - containerTop, container.clientHeight, minPaneHeight);
      window.localStorage.setItem(storageKey, String(nextHeight));
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize, { once: true });
    window.addEventListener("pointercancel", finishResize, { once: true });
  }

  function adjustByKeyboard(delta: number) {
    const availableHeight = containerRef.current?.clientHeight ?? minPaneHeight;
    setUpperHeight((current) => {
      const next = clampHeight(current + delta, availableHeight, minPaneHeight);
      window.localStorage.setItem(storageKey, String(next));
      return next;
    });
  }

  if (stackOnMobile && isMobileStacked) {
    const first = stackLowerFirstOnMobile && hasLowerPane ? lower : upper;
    const second = stackLowerFirstOnMobile && hasLowerPane ? upper : lower;
    return (
      <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pb-28 md:pb-4">
        <div className="shrink-0 overflow-visible">{first}</div>
        {hasLowerPane && second ? <div className="shrink-0 overflow-visible">{second}</div> : null}
        {floatingChildren}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        className="min-h-0 shrink-0 overflow-hidden"
        style={{ height: hasLowerPane ? upperHeight : "100%" }}
      >
        {upper}
      </div>
      {hasLowerPane && lower ? (
        <>
          <div
            role="separator"
            aria-label={effectiveSeparatorLabel}
            aria-orientation="horizontal"
            aria-valuemin={minimumUpperHeight}
            aria-valuenow={upperHeight}
            tabIndex={0}
            onPointerDown={handlePointerDown}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp") {
                event.preventDefault();
                adjustByKeyboard(-24);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                adjustByKeyboard(24);
              }
            }}
            className="group flex h-4 shrink-0 cursor-row-resize touch-none items-center justify-center outline-none"
            title={effectiveSeparatorTitle}
          >
            <span className="h-1 w-16 rounded-full bg-slate-300 transition group-hover:bg-blue-400 group-focus:bg-blue-500" />
          </div>
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{lower}</div>
        </>
      ) : null}
      {floatingChildren}
    </div>
  );
}
