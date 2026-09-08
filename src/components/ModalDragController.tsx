"use client";

import { useEffect } from "react";

const DRAG_MARGIN = 8;

function isInteractiveTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return !!target.closest("button, input, textarea, select, a, [role='button'], [data-modal-drag-ignore='true']");
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function ModalDragController() {
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (event.button !== 0 || isInteractiveTarget(event.target)) return;
      const header = (event.target as HTMLElement | null)?.closest(".modal-header");
      const panel = header?.closest(".app-modal-panel, .modal-surface") as HTMLElement | null;
      const fallbackPanel = header?.parentElement ?? null;
      const dragPanel = panel ?? fallbackPanel;
      if (!header || !dragPanel) return;
      const activePanel = dragPanel;

      const rect = activePanel.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = rect.left;
      const startTop = rect.top;
      const maxLeft = Math.max(DRAG_MARGIN, window.innerWidth - rect.width - DRAG_MARGIN);
      const maxTop = Math.max(DRAG_MARGIN, window.innerHeight - rect.height - DRAG_MARGIN);

      activePanel.style.position = "fixed";
      activePanel.style.left = `${startLeft}px`;
      activePanel.style.top = `${startTop}px`;
      activePanel.style.width = `${rect.width}px`;
      activePanel.style.margin = "0";
      activePanel.classList.add("app-modal-panel-dragging");
      document.body.classList.add("modal-dragging");
      event.preventDefault();

      function onPointerMove(moveEvent: PointerEvent) {
        const nextLeft = clamp(startLeft + moveEvent.clientX - startX, DRAG_MARGIN, maxLeft);
        const nextTop = clamp(startTop + moveEvent.clientY - startY, DRAG_MARGIN, maxTop);
        activePanel.style.left = `${nextLeft}px`;
        activePanel.style.top = `${nextTop}px`;
      }

      function onPointerUp() {
        activePanel.classList.remove("app-modal-panel-dragging");
        document.body.classList.remove("modal-dragging");
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
      }

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    }

    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  return null;
}
