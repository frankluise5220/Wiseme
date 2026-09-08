"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Reusable multi-select filter dropdown (the same dropdown as the
 * "filter by account type" control on the settings/accounts page).
 *
 * Empty selection = show all; the trigger button summarizes the current
 * selection. Options are plain string values; rendering and labels are fully
 * delegated to the caller so the same component can filter kinds, accounts,
 * or any other enum-like set.
 */
export type MultiSelectFilterDropdownProps = {
  options: string[];
  selectedValues: string[];
  onChange: (next: string[]) => void;
  labelFor: (value: string) => string;
  allLabel: string;
  selectedSummaryLabel?: (first: string, count: number) => string;
  clearLabel?: string;
  emptyLabel?: string;
  renderOptionLeading?: (value: string) => ReactNode;
};

export function MultiSelectFilterDropdown({
  options,
  selectedValues,
  onChange,
  labelFor,
  allLabel,
  selectedSummaryLabel,
  clearLabel,
  emptyLabel,
  renderOptionLeading,
}: MultiSelectFilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (containerRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  const toggleValue = (value: string) => {
    onChange(selectedValues.includes(value)
      ? selectedValues.filter((item) => item !== value)
      : [...selectedValues, value]);
  };

  const summaryLabel = selectedSummaryLabel ?? ((first: string, count: number) => `${first} +${count}`);
  const clearText = clearLabel ?? allLabel;
  const emptyText = emptyLabel ?? allLabel;
  const label = selectedValues.length === 0
    ? allLabel
    : selectedValues.length === 1
      ? labelFor(selectedValues[0])
      : summaryLabel(labelFor(selectedValues[0]), selectedValues.length);

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        title={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="inline-flex h-8 min-w-40 max-w-56 items-center justify-between gap-2 rounded-md border border-slate-300 bg-white px-2.5 text-left text-xs text-slate-700 shadow-sm hover:border-slate-400"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-[100] w-64 overflow-hidden rounded-md border border-slate-200 bg-white p-2 shadow-lg">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-[11px] font-medium text-slate-500">{allLabel}</span>
            <button type="button" className="text-[11px] text-blue-600 hover:text-blue-800" onClick={() => onChange([])}>
              {clearText}
            </button>
          </div>
          {options.length === 0 ? (
            <div className="px-2 py-2 text-xs text-slate-400">{emptyText}</div>
          ) : (
            <div className="space-y-1">
              {options.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="option"
                  aria-selected={selectedValues.includes(value)}
                  className="flex min-h-8 w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-slate-50"
                  onClick={() => toggleValue(value)}
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 shrink-0 accent-blue-600"
                    checked={selectedValues.includes(value)}
                    readOnly
                    tabIndex={-1}
                  />
                  {renderOptionLeading ? renderOptionLeading(value) : null}
                  <span className="min-w-0 flex-1 truncate">{labelFor(value)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
