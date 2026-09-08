"use client";

import { type KeyboardEvent, useRef, useState } from "react";
import { todayDateLocalYmd as todayDateInputValue } from "@/lib/date-utils";
import { useI18n } from "@/lib/i18n";

function splitDateInputValue(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return { year: match[1]!, month: match[2]!, day: match[3]! };
}

function addDays(value: string, delta: number) {
  const base = splitDateInputValue(value) ? value : todayDateInputValue();
  const [year, month, day] = base.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + delta);
  const nextYear = date.getFullYear();
  const nextMonth = String(date.getMonth() + 1).padStart(2, "0");
  const nextDay = String(date.getDate()).padStart(2, "0");
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

export function DateStepper({ value, onChange, onBlur, onKeyDown, min = "1900-01-01", max = "2999-12-31", className, disabled, name, autoFocus, compact = false }: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  min?: string;
  max?: string;
  className?: string;
  disabled?: boolean;
  name?: string;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { t } = useI18n();

  const changeByDays = (delta: number) => {
    if (disabled) return;
    const next = addDays(value, delta);
    if (min && next < min) return;
    if (max && next > max) return;
    onChange(next);
  };

  const togglePicker = () => {
    if (disabled) return;
    const input = inputRef.current;
    if (!input) return;
    if (pickerOpen) {
      input.blur();
      setPickerOpen(false);
      return;
    }
    input.focus();
    setPickerOpen(true);
    input.showPicker?.();
  };

  return (
    <div className="relative min-w-0">
      <input
        ref={inputRef}
        name={name}
        type="date"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setPickerOpen(false);
          onBlur?.();
        }}
        className={`form-input date-stepper-input min-w-0 ${compact ? "pr-1" : "pr-12"} disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500 invalid:border-rose-400 invalid:text-rose-700 invalid:focus:border-rose-400 ${className ?? ""}`}
      />
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={togglePicker}
        disabled={disabled}
        className={`absolute bottom-px ${compact ? "right-1" : "right-5"} top-px flex w-7 items-center justify-center text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40`}
        title={t("dateStepper.pickDate")}
        aria-label={t("dateStepper.pickDate")}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" className="h-[1.1rem] w-[1.1rem]">
          <path d="M7 3v3M17 3v3M4.5 9h15M6.5 5h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
        </svg>
      </button>
      {!compact && (
      <div className="absolute bottom-px right-px top-px flex w-5 flex-col overflow-hidden rounded-r bg-white/95">
        <button
          type="button"
          onClick={() => changeByDays(1)}
          disabled={disabled || Boolean(max && addDays(value, 1) > max)}
          className="flex flex-1 items-center justify-center text-[9px] leading-none text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          title={t("dateStepper.nextDay")}
          aria-label={t("dateStepper.nextDay")}
        >
          <span className="rotate-90 text-[13px] leading-none">‹</span>
        </button>
        <button
          type="button"
          onClick={() => changeByDays(-1)}
          disabled={disabled || Boolean(min && addDays(value, -1) < min)}
          className="flex flex-1 items-center justify-center border-t border-slate-200 text-[9px] leading-none text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          title={t("dateStepper.prevDay")}
          aria-label={t("dateStepper.prevDay")}
        >
          <span className="rotate-90 text-[13px] leading-none">›</span>
        </button>
      </div>
      )}
    </div>
  );
}
