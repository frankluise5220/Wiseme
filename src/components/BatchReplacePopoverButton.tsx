"use client";

import { Pencil } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CalcInput } from "@/components/CalcInput";
import { SmartSelect, type SmartSelectOption, type SmartSelectProps } from "@/components/SmartSelect";
import { useI18n } from "@/lib/i18n";

export type BatchReplaceInputKind = "date" | "text" | "number" | "select" | "smartSelect";

export type BatchReplaceOption = {
  value: string;
  label: string;
  subLabel?: string;
  title?: string;
  color?: string | null;
  isHeader?: boolean;
  isGroup?: boolean;
  parentId?: string;
  kind?: string | null;
  investProductType?: string | null;
  debtDirection?: string | null;
  institutionId?: string | null;
  currency?: string | null;
  categoryType?: string | null;
};

type BatchReplaceSmartSelectBehavior = Extract<SmartSelectProps, { mode: "single" }>["behavior"];

export type BatchReplaceFieldConfig<Field extends string> = {
  value: Field;
  label: string;
  kind: BatchReplaceInputKind;
  options?: BatchReplaceOption[];
  placeholder?: string;
  allowEmpty?: boolean;
  precision?: number;
  smartSelectBehavior?: BatchReplaceSmartSelectBehavior;
};

type Props<Field extends string> = {
  fields: BatchReplaceFieldConfig<Field>[];
  targetCount: number;
  targetLabel?: string;
  disabledTitle?: string;
  buttonTitle?: string;
  panelAlign?: "left" | "right";
  buttonClassName?: string;
  messageClassName?: string;
  children?: ReactNode;
  onApply: (field: Field, value: string) => Promise<string | void> | string | void;
};

export function BatchReplacePopoverButton<Field extends string>({
  fields,
  targetCount,
  targetLabel,
  disabledTitle,
  buttonTitle,
  panelAlign = "right",
  buttonClassName,
  messageClassName = "text-xs text-slate-500",
  children,
  onApply,
}: Props<Field>) {
  const { t } = useI18n();
  const effectiveTargetLabel = targetLabel ?? t("stockPanel.selected");
  const effectiveDisabledTitle = disabledTitle ?? t("stockPanel.error.selectRowsFirst");
  const firstField = fields[0]?.value;
  const triggerRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<Field | undefined>(firstField);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null);

  const fieldConfig = useMemo(() => fields.find((item) => item.value === field) ?? fields[0], [field, fields]);
  const disabled = targetCount === 0 || fields.length === 0;
  const canApply = Boolean(fieldConfig) && !submitting && targetCount > 0 && (fieldConfig.allowEmpty || value.trim().length > 0);
  const preferredPanelWidth = useMemo(() => {
    if (fieldConfig?.kind !== "smartSelect") return 360;
    const behavior = fieldConfig.smartSelectBehavior;
    const dropdownWidth = behavior?.minDropdownWidth ?? 360;
    const hasExpandedGrid = Number(behavior?.expandedGroupColumns ?? 0) >= 2;
    return Math.max(360, dropdownWidth + (hasExpandedGrid ? 56 : 0));
  }, [fieldConfig]);

  useEffect(() => {
    if (!open) {
      setPanelStyle(null);
      return;
    }
    if (typeof window === "undefined") return;

    const viewportPadding = 12;
    const panelGap = 8;
    const boundaryPadding = 8;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;

      const triggerRect = trigger.getBoundingClientRect();
      const boundary = trigger.closest("[data-batch-popover-boundary]");
      const boundaryRect =
        boundary instanceof HTMLElement ? boundary.getBoundingClientRect() : null;
      const horizontalMin = Math.max(
        viewportPadding,
        (boundaryRect?.left ?? viewportPadding) + boundaryPadding,
      );
      const horizontalMax = Math.min(
        window.innerWidth - viewportPadding,
        (boundaryRect?.right ?? window.innerWidth - viewportPadding) - boundaryPadding,
      );
      const availableWidth = Math.max(240, horizontalMax - horizontalMin);
      const nextWidth = Math.min(preferredPanelWidth, availableWidth);
      const panelHeight = panel.offsetHeight || 220;
      const leftBase = panelAlign === "right" ? triggerRect.right - nextWidth : triggerRect.left;
      const left = Math.min(Math.max(leftBase, horizontalMin), horizontalMax - nextWidth);
      const maxTop = window.innerHeight - viewportPadding - panelHeight;
      const topBelow = triggerRect.bottom + panelGap;
      const topAbove = triggerRect.top - panelHeight - panelGap;
      const shouldPlaceAbove = topBelow > maxTop && topAbove >= viewportPadding;
      const top = shouldPlaceAbove
        ? Math.max(viewportPadding, topAbove)
        : Math.max(viewportPadding, Math.min(topBelow, maxTop));

      setPanelStyle({
        position: "fixed",
        top,
        left,
        width: nextWidth,
        maxHeight: `min(24rem, calc(100vh - ${viewportPadding * 2}px))`,
      });
    };

    const rafId = window.requestAnimationFrame(updatePosition);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-smart-select-dropdown]")) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);

    return () => {
      window.cancelAnimationFrame(rafId);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, panelAlign, preferredPanelWidth]);

  async function applyReplace() {
    if (!fieldConfig || !canApply) return;
    setSubmitting(true);
    setMessage("");
    try {
      const resultMessage = await onApply(fieldConfig.value, value);
      if (resultMessage) setMessage(resultMessage);
      setOpen(false);
      setValue("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("stockPanel.error.batchUpdateFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div ref={triggerRef} className="flex items-center gap-2">
      {message ? <span className={messageClassName}>{message}</span> : null}
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        className={buttonClassName ?? "flex h-8 w-8 items-center justify-center rounded-md border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-40"}
        title={disabled ? effectiveDisabledTitle : (buttonTitle ?? t("batchReplace.title", { label: effectiveTargetLabel, count: targetCount }))}
        aria-label={disabled ? effectiveDisabledTitle : (buttonTitle ?? t("batchReplace.title", { label: effectiveTargetLabel, count: targetCount }))}
      >
        <Pencil className="h-4 w-4" />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              style={panelStyle ?? { position: "fixed", top: -9999, left: -9999, width: 320 }}
              className="z-[120] overflow-y-auto rounded-lg border border-blue-100 bg-white p-3 text-xs shadow-lg"
            >
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="font-medium text-slate-700">{t("batchReplace.panelTitle", { label: effectiveTargetLabel, count: targetCount })}</span>
                <button type="button" onClick={() => setOpen(false)} className="shrink-0 text-slate-400 hover:text-slate-600">{t("table.close")}</button>
              </div>
              {children ? <div className="mb-2 text-xs text-slate-500">{children}</div> : null}
              <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-2">
                <select
                  value={fieldConfig?.value ?? ""}
                  onChange={(event) => {
                    setField(event.target.value as Field);
                    setValue("");
                  }}
                  className="h-8 rounded border border-slate-200 bg-white px-2 outline-none focus:border-blue-400"
                >
                  {fields.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
                {fieldConfig?.kind === "select" ? (
                  <select value={value} onChange={(event) => setValue(event.target.value)} className="h-8 rounded border border-slate-200 bg-white px-2 outline-none focus:border-blue-400">
                    {(fieldConfig.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                ) : fieldConfig?.kind === "smartSelect" ? (
                  <SmartSelect
                    mode="single"
                    value={value}
                    onChange={setValue}
                    options={(fieldConfig.options ?? []).map((option) => ({
                      id: option.value,
                      label: option.label,
                      subLabel: option.subLabel,
                      title: option.title,
                      color: option.color,
                      isHeader: option.isHeader,
                      isGroup: option.isGroup,
                      parentId: option.parentId,
                      kind: option.kind,
                      investProductType: option.investProductType,
                      debtDirection: option.debtDirection,
                      institutionId: option.institutionId,
                      currency: option.currency,
                    } satisfies SmartSelectOption))}
                    placeholder={fieldConfig.placeholder ?? t("txForm.selectPlaceholder")}
                    searchable
                    behavior={fieldConfig.smartSelectBehavior ?? { search: true }}
                  />
                ) : fieldConfig?.kind === "number" ? (
                  <CalcInput value={value} onChange={setValue} placeholder={fieldConfig?.placeholder ?? t("batchReplace.numberPlaceholder")} precision={fieldConfig?.precision ?? 2} />
                ) : (
                  <input
                    type={fieldConfig?.kind === "date" ? "date" : "text"}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    placeholder={fieldConfig?.placeholder ?? t("batchReplace.valuePlaceholder")}
                    className="h-8 rounded border border-slate-200 bg-white px-2 outline-none focus:border-blue-400"
                  />
                )}
              </div>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={() => { setOpen(false); setValue(""); }} className="h-8 rounded border border-slate-200 bg-white px-3 text-slate-600 hover:bg-slate-50">{t("common.cancel")}</button>
                <button type="button" onClick={applyReplace} disabled={!canApply} className="h-8 rounded bg-blue-600 px-3 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                  {submitting ? t("batchReplace.applying") : t("batchReplace.apply")}
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
