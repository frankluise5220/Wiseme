"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";

export type HoldingItem = {
  fundCode: string;
  name: string;
  units?: number;
};

type Props = {
  holdings: HoldingItem[];
  fundCode: string;
  fundName: string;
  onSelect: (item: HoldingItem) => void;
  searchText: string;
  onSearchChange: (text: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  showUnits?: boolean;
};

export function HoldingPicker({
  holdings,
  fundCode,
  fundName,
  onSelect,
  searchText,
  onSearchChange,
  onBlur,
  placeholder,
  showUnits = false,
}: Props) {
  const [show, setShow] = useState(false);
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const isUserSearching = searchText !== "" && searchText !== `${fundCode} ${fundName}`;

  const filtered = useMemo(() => {
    const base = holdings ?? [];
    const f = isUserSearching
      ? base.filter(h => h.fundCode.includes(searchText) || h.name.includes(searchText))
      : base;
    return [...f].sort((a, b) => a.fundCode.localeCompare(b.fundCode));
  }, [holdings, searchText, isUserSearching]);

  function updatePos() {
    if (!inputRef.current) return;
    const rect = inputRef.current.getBoundingClientRect();
    setDropdownPos({ top: rect.bottom + 2, left: rect.left, width: rect.width });
  }

  function open() {
    updatePos();
    setShow(true);
  }

  function close() {
    setShow(false);
    if (isUserSearching) onSearchChange(`${fundCode} ${fundName}`);
  }

  useEffect(() => {
    if (!show) return;
    function onOutside(e: MouseEvent) {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current && !inputRef.current.contains(e.target as Node)
      ) {
        close();
      }
    }
    document.addEventListener("mousedown", onOutside);
    window.addEventListener("resize", updatePos);
    window.addEventListener("scroll", updatePos, true);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      window.removeEventListener("resize", updatePos);
      window.removeEventListener("scroll", updatePos, true);
    };
  }, [show, isUserSearching, fundCode, fundName]);

  function select(h: HoldingItem) {
    onSelect(h);
    onSearchChange(`${h.fundCode} ${h.name}`);
    setShow(false);
  }

  function handleInputChange(val: string) {
    onSearchChange(val);
    if (!show) open();
    if (/^\d{6}$/.test(val)) {
      const h = holdings.find(p => p.fundCode === val);
      if (h) onSelect(h);
      else onSelect({ fundCode: val, name: "" });
    } else {
      onSelect({ fundCode: "", name: "" });
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") { close(); inputRef.current?.blur(); }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && filtered.length > 0) {
      e.preventDefault();
      // simple: focus first item in dropdown
      const items = dropdownRef.current?.querySelectorAll("button");
      if (items && items.length > 0) (items[0] as HTMLElement).focus();
    }
  }

  const dropdown = show && filtered.length > 0 && dropdownPos && typeof document !== "undefined" ? createPortal(
    <div ref={dropdownRef}
      className="fixed z-[9999] max-h-48 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg"
      style={{ top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width }}>
      {filtered.map(h => (
        <button key={h.fundCode} type="button"
          className="w-full text-left px-3 py-1.5 text-sm hover:bg-blue-50 border-b border-slate-100 last:border-b-0"
          onClick={() => select(h)}>
          <span className="font-medium">{h.fundCode}</span>{" "}
          <span className="text-slate-600">{h.name}</span>
          {showUnits && h.units != null && (
            <span className="text-slate-400 ml-1">{t("holdingPicker.unitsSuffix", { units: Number(h.units).toFixed(2) })}</span>
          )}
        </button>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <div className="relative space-y-1">
      <div className="text-xs font-medium text-slate-600">{t("holdingPicker.holdingFunds")}</div>
      <div className="flex gap-1">
        <input
          ref={inputRef}
          value={searchText}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={open}
          onBlur={onBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? t("holdingPicker.searchPlaceholder")}
          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
        />
        <button type="button" onClick={() => show ? close() : open()}
          className="h-9 w-9 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 shrink-0">
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
      {dropdown}
    </div>
  );
}
