"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useI18n } from "@/lib/i18n";
import { useOutsideClose } from "@/lib/client/useOutsideClose";

type TableColumnFilterProps = {
  label: string;
  options: string[];
  optionCounts?: Record<string, number | undefined>;
  optionTitles?: Record<string, string | undefined>;
  optionSearchText?: Record<string, string | undefined>;
  selectedValues: string[];
  open: boolean;
  filtered?: boolean;
  showLabel?: boolean;
  showTrigger?: boolean;
  labelClassName?: string;
  onToggleOpen: () => void;
  onClose: () => void;
  onChange: (values: string[] | undefined) => void;
};

type DateRangeColumnFilterProps = {
  label: string;
  from: string;
  to: string;
  open: boolean;
  labelClassName?: string;
  showTrigger?: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
  onChange: (next: { from: string; to: string }) => void;
};

function FilterPopover({
  open,
  anchorRef,
  children,
  className,
  width = 256,
  maxHeight = 384,
  height,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  className: string;
  width?: number;
  maxHeight?: number;
  height?: number;
}) {
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const horizontalPadding = 8;
      const popupWidth = Math.min(width, Math.max(160, viewportWidth - horizontalPadding * 2));
      const belowSpace = viewportHeight - rect.bottom - horizontalPadding;
      const aboveSpace = rect.top - horizontalPadding;
      const shouldOpenAbove = belowSpace < Math.min(maxHeight, 220) && aboveSpace > belowSpace;
      const availableHeight = Math.max(160, shouldOpenAbove ? aboveSpace : belowSpace);
      const popupHeight = Math.min(height ?? maxHeight, availableHeight);
      const left = Math.min(
        Math.max(horizontalPadding, rect.left),
        Math.max(horizontalPadding, viewportWidth - popupWidth - horizontalPadding),
      );
      const top = shouldOpenAbove
        ? Math.max(horizontalPadding, rect.top - popupHeight - 4)
        : Math.min(viewportHeight - popupHeight - horizontalPadding, rect.bottom + 4);
      setStyle({
        position: "fixed",
        top,
        left,
        width: popupWidth,
        maxWidth: `calc(100vw - ${horizontalPadding * 2}px)`,
        maxHeight: availableHeight,
        ...(height ? { height: popupHeight } : {}),
        zIndex: 30000,
        visibility: "visible",
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef, height, maxHeight, open, width]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      className={className}
      style={style}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

export function TableColumnFilter({
  label,
  options,
  optionCounts = {},
  optionTitles = {},
  optionSearchText = {},
  selectedValues,
  open,
  filtered = selectedValues.length > 0,
  showLabel = true,
  showTrigger = true,
  labelClassName = "",
  onToggleOpen,
  onClose,
  onChange,
}: TableColumnFilterProps) {
  const { t } = useI18n();
  const filterTitle = t("table.filterTitle").replaceAll("{label}", label);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [keyword, setKeyword] = useState("");

  useEffect(() => {
    if (open) setKeyword("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useOutsideClose(rootRef, open, onClose);

  const filterOptionsByKeyword = useCallback((rawKeyword: string) => {
    const query = rawKeyword.trim().toLowerCase();
    if (!query) return options;
    return options.filter((value) => {
      const haystack = [
        value,
        optionTitles[value] ?? "",
        optionSearchText[value] ?? "",
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    });
  }, [optionSearchText, optionTitles, options]);

  const visibleOptions = useMemo(() => {
    return filterOptionsByKeyword(keyword);
  }, [filterOptionsByKeyword, keyword]);

  function applyKeywordFilter() {
    const query = (inputRef.current?.value ?? keyword).trim();
    if (!query) {
      onChange([]);
      onClose();
      return;
    }
    const matchedOptions = filterOptionsByKeyword(query);
    onChange(matchedOptions.length > 0 ? matchedOptions : ["__NO_MATCH__"]);
    onClose();
  }

  const keywordActive = keyword.trim().length > 0;
  const keywordMatchedCount = visibleOptions.length;

  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-1">
      {showLabel ? <span className={labelClassName}>{label}</span> : null}
      {showTrigger ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleOpen();
          }}
          className={`h-5 w-4 text-[10px] leading-none ${filtered ? "text-blue-600" : "text-slate-900"} hover:text-blue-600`}
          title={filterTitle}
        >
          ▼
        </button>
      ) : null}
      <FilterPopover open={open} anchorRef={rootRef} className="h-96 min-h-52 min-w-56 max-w-[min(640px,90vw)] resize overflow-auto rounded-lg border border-slate-200 bg-white p-2 shadow-xl" height={384}>
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
            <span className="text-xs font-medium text-slate-700">{filterTitle}</span>
            <button type="button" onClick={onClose} className="text-xs text-slate-400 hover:text-slate-700">
              {t("table.close")}
            </button>
          </div>
          <div className="mb-2 flex items-center gap-2">
            <button type="button" onClick={() => onChange([])} className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
              {t("table.selectAllValues")}
            </button>
            <button type="button" onClick={() => onChange(["__NO_MATCH__"])} className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
              {t("table.selectNoValues")}
            </button>
            <button type="button" onClick={() => onChange(undefined)} className="ml-auto text-xs text-blue-600 hover:text-blue-700">
              {t("table.clear")}
            </button>
          </div>
          <div className="mb-2 flex items-center gap-2">
            <input
              ref={inputRef}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key !== "Enter") return;
                event.preventDefault();
                applyKeywordFilter();
              }}
              placeholder={t("table.filterSearchPlaceholder")}
              className="h-8 min-w-0 flex-1 rounded border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-400"
            />
            <button
              type="button"
              onClick={applyKeywordFilter}
              className="h-8 shrink-0 rounded border border-blue-200 bg-blue-50 px-3 text-xs text-blue-700 hover:bg-blue-100"
            >
              {keywordActive ? `${t("table.confirm")} (${keywordMatchedCount})` : t("table.confirm")}
            </button>
          </div>
          {keywordActive ? (
            <div className="mb-2 rounded-md bg-blue-50 px-2 py-1 text-[11px] text-blue-700">
              {t("tableFilter.applyHint", { count: keywordMatchedCount })}
            </div>
          ) : null}
          <div className="max-h-[calc(100%-116px)] space-y-1 overflow-auto pr-1">
            {visibleOptions.map((value) => {
              const checked = keywordActive ? true : selectedValues.length > 0 ? selectedValues.includes(value) : true;
              const title = optionTitles[value] || value;
              const count = optionCounts[value];
              return (
                <div
                  key={value}
                  title={title}
                  className={`flex w-full items-center gap-2 rounded px-1 py-1 text-left text-xs ${
                    checked ? "bg-blue-50 text-blue-700" : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      const nextValues = selectedValues.length > 0 ? selectedValues : options;
                      const next = nextValues.includes(value)
                        ? nextValues.filter((item) => item !== value)
                        : Array.from(new Set([...nextValues, value]));
                      onChange(next.length === options.length ? [] : next);
                    }}
                    className={`flex h-3.5 w-3.5 items-center justify-center rounded border text-[10px] ${
                      checked ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white text-transparent"
                    }`}
                    aria-label={t("tableFilter.checkRow", { value })}
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onChange([value]);
                      onClose();
                    }}
                    className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
                    title={title}
                  >
                    <span className="min-w-0 truncate" title={title}>{value}</span>
                    {count != null ? (
                      <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-500">
                        {count}
                      </span>
                    ) : null}
                  </button>
                </div>
              );
            })}
            {visibleOptions.length === 0 ? (
              <div className="px-1 py-3 text-center text-xs text-slate-400">{t("table.noFilterOptions")}</div>
            ) : null}
          </div>
      </FilterPopover>
    </div>
  );
}

export function DateRangeColumnFilter({
  label,
  from,
  to,
  open,
  labelClassName = "",
  showTrigger = true,
  onToggleOpen,
  onClose,
  onChange,
}: DateRangeColumnFilterProps) {
  const { t } = useI18n();
  const filterTitle = t("table.filterTitle").replaceAll("{label}", label);
  const rootRef = useRef<HTMLDivElement>(null);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);

  useEffect(() => {
    setDraftFrom(from);
    setDraftTo(to);
  }, [from, to, open]);

  useOutsideClose(rootRef, open, onClose);

  const active = !!from || !!to;

  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-1">
      <span className={labelClassName}>{label}</span>
      {showTrigger ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleOpen();
          }}
          className={`h-5 w-4 text-[10px] leading-none ${active ? "text-blue-600" : "text-slate-900"} hover:text-blue-600`}
          title={filterTitle}
        >
          ▼
        </button>
      ) : null}
      <FilterPopover open={open} anchorRef={rootRef} className="rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
            <span className="text-xs font-medium text-slate-700">{filterTitle}</span>
            <button type="button" onClick={onClose} className="text-xs text-slate-400 hover:text-slate-700">
              {t("table.close")}
            </button>
          </div>
          <div className="space-y-2">
            <label className="grid grid-cols-[52px_minmax(0,1fr)] items-center gap-2">
              <span className="text-right text-[11px] font-medium text-slate-500">{t("table.from")}</span>
              <input
                type="date"
                value={draftFrom}
                onChange={(event) => setDraftFrom(event.target.value)}
                className="h-8 w-full rounded border border-slate-200 bg-white px-2 text-right text-xs outline-none focus:border-blue-400"
              />
            </label>
            <label className="grid grid-cols-[52px_minmax(0,1fr)] items-center gap-2">
              <span className="text-right text-[11px] font-medium text-slate-500">{t("table.to")}</span>
              <input
                type="date"
                value={draftTo}
                onChange={(event) => setDraftTo(event.target.value)}
                className="h-8 w-full rounded border border-slate-200 bg-white px-2 text-right text-xs outline-none focus:border-blue-400"
              />
            </label>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setDraftFrom("");
                setDraftTo("");
                onChange({ from: "", to: "" });
                onClose();
              }}
              className="text-xs text-blue-600 hover:text-blue-700"
            >
              {t("table.clear")}
            </button>
            <button
              type="button"
              onClick={() => {
                onChange({ from: draftFrom, to: draftTo });
                onClose();
              }}
              className="h-8 rounded border border-blue-200 bg-blue-50 px-3 text-xs text-blue-700 hover:bg-blue-100"
            >
              {t("table.confirm")}
            </button>
          </div>
      </FilterPopover>
    </div>
  );
}

export function NumberRangeColumnFilter({
  label,
  from,
  to,
  open,
  labelClassName = "",
  showTrigger = true,
  onToggleOpen,
  onClose,
  onChange,
}: DateRangeColumnFilterProps) {
  const { t } = useI18n();
  const filterTitle = t("table.filterTitle").replaceAll("{label}", label);
  const rootRef = useRef<HTMLDivElement>(null);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState(to);

  useEffect(() => {
    setDraftFrom(from);
    setDraftTo(to);
  }, [from, to, open]);

  useOutsideClose(rootRef, open, onClose);

  const active = !!from || !!to;

  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-1">
      <span className={labelClassName}>{label}</span>
      {showTrigger ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleOpen();
          }}
          className={`h-5 w-4 text-[10px] leading-none ${active ? "text-blue-600" : "text-slate-900"} hover:text-blue-600`}
          title={filterTitle}
        >
          ▼
        </button>
      ) : null}
      <FilterPopover open={open} anchorRef={rootRef} className="rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
            <span className="text-xs font-medium text-slate-700">{filterTitle}</span>
            <button type="button" onClick={onClose} className="text-xs text-slate-400 hover:text-slate-700">
              {t("table.close")}
            </button>
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <input
              inputMode="decimal"
              value={draftFrom}
              onChange={(event) => setDraftFrom(event.target.value)}
              className="h-8 w-full rounded border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-400"
            />
            <span className="text-[11px] font-medium text-slate-400">to</span>
            <input
              inputMode="decimal"
              value={draftTo}
              onChange={(event) => setDraftTo(event.target.value)}
              className="h-8 w-full rounded border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-400"
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setDraftFrom("");
                setDraftTo("");
                onChange({ from: "", to: "" });
                onClose();
              }}
              className="text-xs text-blue-600 hover:text-blue-700"
            >
              {t("table.clear")}
            </button>
            <button
              type="button"
              onClick={() => {
                onChange({ from: draftFrom.trim(), to: draftTo.trim() });
                onClose();
              }}
              className="h-8 rounded border border-blue-200 bg-blue-50 px-3 text-xs text-blue-700 hover:bg-blue-100"
            >
              {t("table.confirm")}
            </button>
          </div>
      </FilterPopover>
    </div>
  );
}

export function TextColumnFilter({
  label,
  value,
  open,
  labelClassName = "",
  showTrigger = true,
  onToggleOpen,
  onClose,
  onChange,
}: {
  label: string;
  value: string;
  open: boolean;
  labelClassName?: string;
  showTrigger?: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const filterTitle = t("table.filterTitle").replaceAll("{label}", label);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true });
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useOutsideClose(rootRef, open, onClose);

  const active = value.trim().length > 0;

  function apply() {
    onChange(draft.trim());
    onClose();
  }

  return (
    <div ref={rootRef} className="relative inline-flex items-center gap-1">
      <span className={labelClassName}>{label}</span>
      {showTrigger ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleOpen();
          }}
          className={`h-5 w-4 text-[10px] leading-none ${active ? "text-blue-600" : "text-slate-900"} hover:text-blue-600`}
          title={filterTitle}
        >
          ▼
        </button>
      ) : null}
      <FilterPopover open={open} anchorRef={rootRef} className="rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
          <div className="mb-2 flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
            <span className="text-xs font-medium text-slate-700">{filterTitle}</span>
            <button type="button" onClick={onClose} className="text-xs text-slate-400 hover:text-slate-700">
              {t("table.close")}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key !== "Enter") return;
                event.preventDefault();
                apply();
              }}
              placeholder={t("table.filterSearchPlaceholder")}
              className="h-8 min-w-0 flex-1 rounded border border-slate-200 bg-white px-2 text-xs outline-none focus:border-blue-400"
            />
            <button
              type="button"
              onClick={apply}
              className="h-8 shrink-0 rounded border border-blue-200 bg-blue-50 px-3 text-xs text-blue-700 hover:bg-blue-100"
            >
              {t("table.confirm")}
            </button>
          </div>
          <button
            type="button"
            onClick={() => {
              setDraft("");
              onChange("");
              onClose();
            }}
            className="mt-2 text-xs text-blue-600 hover:text-blue-700"
          >
            {t("table.clear")}
          </button>
      </FilterPopover>
    </div>
  );
}
