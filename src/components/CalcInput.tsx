"use client";

import { forwardRef, useEffect, useRef, useState, useCallback } from "react";
import { Calculator } from "lucide-react";
import { createPortal } from "react-dom";
import { evaluateArithmeticExpression } from "@/lib/arithmetic-expression";
import { useI18n } from "@/lib/i18n";

export function sanitizeCalcInputValue(raw: string) {
  return raw.replace(/[^\d+\-*/().\s]/g, "");
}

export function evaluateCalcInputExpression(expression: string, currentValue = 0) {
  let full = sanitizeCalcInputValue(expression).trim();
  if (!full) return null;
  if (/^[+\-*/]/.test(full)) full = `${Number(currentValue) || 0}${full}`;
  if (!/^[\d+\-*/().\s]+$/.test(full)) return null;
  const computed = evaluateArithmeticExpression(full);
  return typeof computed === "number" && Number.isFinite(computed) ? computed : null;
}

export type CalcInputProps = {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  className?: string;
  label?: string;
  precision?: number;
  disabled?: boolean;
};

export const CalcInput = forwardRef<HTMLInputElement, CalcInputProps>(function CalcInput(
  {
    value,
    onChange,
    onBlur,
    placeholder,
  className,
  label,
  precision = 2,
  disabled = false,
  },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [dialogPos, setDialogPos] = useState<{ top: number; left: number } | null>(null);
  const [expr, setExpr] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const numVal = parseFloat(value) || 0;
  const { t } = useI18n();

  const formatValue = useCallback((num: number) => num.toFixed(precision), [precision]);

  const doEval = useCallback((expression: string) => {
    const computed = evaluateCalcInputExpression(expression, numVal);
    if (computed != null) onChange(formatValue(computed));
  }, [formatValue, numVal, onChange]);

  useEffect(() => {
    if (!open) return;
    setExpr("");
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const width = 272;
    const height = 248;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const top = rect.bottom + height > window.innerHeight
      ? Math.max(8, rect.top - height - 8)
      : Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8));
    setDialogPos({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (/^[\d+\-*/().]$/.test(e.key)) {
        e.preventDefault();
        setExpr((prev) => prev + e.key);
      } else if (e.key === "Enter" || e.key === "=") {
        e.preventDefault();
        doEval(expr);
        setOpen(false);
      } else if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        setExpr((prev) => prev.slice(0, -1));
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, expr, doEval]);

  function press(key: string) {
    if (key === "=") {
      doEval(expr);
      setOpen(false);
      return;
    }
    if (key === "C") {
      setExpr("");
      return;
    }
    if (key === "1/4") {
      onChange(formatValue(numVal * 0.25));
      return;
    }
    if (key === "1/3") {
      onChange(formatValue(numVal * 0.333333));
      return;
    }
    if (key === "1/2") {
      onChange(formatValue(numVal * 0.5));
      return;
    }
    setExpr((prev) => prev + key);
  }

  function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    const raw = sanitizeCalcInputValue(value).trim();
    if (!/[+\-*/()]/.test(raw)) return;
    e.preventDefault();
    e.stopPropagation();
    doEval(raw);
  }

  function handleInputBlur() {
    const raw = sanitizeCalcInputValue(value).trim();
    if (raw && !/[+\-*/()]/.test(raw)) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        onChange(formatValue(parsed));
      }
    }
    onBlur?.();
  }

  const keyRows = [
    ["7", "8", "9", "/"],
    ["4", "5", "6", "*"],
    ["1", "2", "3", "-"],
    ["C", "0", ".", "+"],
  ];

  const fractionBtns = [
    { label: "1/4", val: "1/4" },
    { label: "1/3", val: "1/3" },
    { label: "1/2", val: "1/2" },
  ];

  return (
    <div className={`relative ${className ?? ""}`}>
      <input
        ref={ref}
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(sanitizeCalcInputValue(e.target.value))}
        onKeyDown={handleInputKeyDown}
        onBlur={handleInputBlur}
        placeholder={placeholder}
        style={{ caretColor: "var(--foreground)" }}
        className={`form-input pr-10 font-mono placeholder:text-slate-300 caret-slate-800 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500`}
      />

      <div className="absolute right-0 top-0">
        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          onClick={() => setOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-r-[10px] border border-l-0 border-slate-200 bg-white text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 disabled:hover:bg-white"
          title={label ? t("calcInput.titleWithLabel").replace("{label}", label) : t("calcInput.title")}
        >
          <Calculator className="h-4 w-4" />
        </button>
      </div>

      {open && dialogPos ? createPortal(
        <div className="fixed inset-0 z-[9999] flex items-start justify-start" style={{ pointerEvents: "none" }}>
          <div className="absolute inset-0" style={{ pointerEvents: "auto" }} onClick={() => setOpen(false)} />
          <div
            ref={dialogRef}
            style={{
              position: "fixed",
              top: dialogPos.top,
              left: dialogPos.left,
              pointerEvents: "auto",
            }}
            className="viewport-floater w-[272px] select-none rounded-xl border bg-surface-white shadow-elevated"
          >
            <div className="border-b border-slate-100 bg-slate-50 px-3 pb-2 pt-2.5">
              <div className="tabular-nums text-[11px] text-slate-400">{t("calcInput.currentValue")} {formatValue(numVal)}</div>
              <div className="mt-0.5 h-5 text-right font-mono text-sm tabular-nums text-slate-800">
                {expr || <span className="text-xs text-slate-300">{t("calcInput.expressionPlaceholder")}</span>}
              </div>
            </div>

            <div className="flex gap-2 px-3 py-2">
              {fractionBtns.map((item) => (
                <button
                  key={item.val}
                  type="button"
                  onClick={() => press(item.val)}
                  className="h-7 flex-1 rounded-[10px] border border-amber-200 bg-amber-50 text-xs font-medium text-amber-700 hover:bg-amber-100 active:bg-amber-200"
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-4 gap-1 px-3 pb-3">
              {keyRows.flat().map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => press(key)}
                  className={`h-9 rounded-[10px] text-sm font-medium transition-transform active:scale-95 ${
                    /[+\-*/]/.test(key)
                      ? "bg-blue-50 text-base text-blue-600 hover:bg-blue-100"
                      : key === "C"
                        ? "bg-red-50 text-red-500 hover:bg-red-100"
                        : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                  }`}
                >
                  {key}
                </button>
              ))}
            </div>

            <div className="px-3 pb-3">
              <button
                type="button"
                onClick={() => press("=")}
                className="primary-button h-9 w-full rounded-[10px] text-sm font-semibold active:bg-blue-800"
              >
                = {t("calcInput.calculate")}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
});

CalcInput.displayName = "CalcInput";
