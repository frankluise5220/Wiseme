"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Unlock } from "lucide-react";

import { formatMoneyYuan as formatMoney } from "@/lib/format";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

export default function EditBillAmount({
  accountId,
  statementMonth,
  currentAmount,
  hasOverride,
  displayMultiplier = 1,
  postOverrideAdjustment = 0,
}: {
  accountId: string;
  statementMonth: string;
  currentAmount: number;
  hasOverride: boolean;
  displayMultiplier?: 1 | -1;
  postOverrideAdjustment?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [committedAmount, setCommittedAmount] = useState(currentAmount);
  const [localHasOverride, setLocalHasOverride] = useState(hasOverride);
  const displayAmount = committedAmount * displayMultiplier;
  const [val, setVal] = useState(String(displayAmount.toFixed(2)));
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    setCommittedAmount(currentAmount);
  }, [currentAmount]);

  useEffect(() => {
    setLocalHasOverride(hasOverride);
  }, [hasOverride]);

  useEffect(() => {
    if (!editing) {
      setVal(String(displayAmount.toFixed(2)));
      setErrMsg("");
    }
  }, [displayAmount, editing]);

  useEffect(() => {
    function handleBillOverrideChanged(event: Event) {
      const detail = (event as CustomEvent<{
        accountId?: string;
        statementMonth?: string;
        amount?: number | null;
        hasOverride?: boolean;
      }>).detail;
      if (!detail?.accountId || !detail?.statementMonth) return;
      if (detail.accountId !== accountId || detail.statementMonth !== statementMonth) return;
      if (typeof detail.amount === "number") setCommittedAmount(detail.amount);
      if (typeof detail.hasOverride === "boolean") setLocalHasOverride(detail.hasOverride);
    }

    window.addEventListener("mmh:bill-override:changed", handleBillOverrideChanged as EventListener);
    return () => window.removeEventListener("mmh:bill-override:changed", handleBillOverrideChanged as EventListener);
  }, [accountId, statementMonth]);

  const cancelEdit = useCallback(() => {
    setVal(String(displayAmount.toFixed(2)));
    setErrMsg("");
    setEditing(false);
  }, [displayAmount]);

  const parseDisplayInput = useCallback((raw: string) => {
    const trimmed = raw.trim().replace(/,/g, "");
    if (!trimmed) return null;
    const explicitPositive = trimmed.startsWith("+");
    const explicitNegative = trimmed.startsWith("-");
    const numericPart = trimmed.replace(/^[+-]/, "");
    if (!numericPart) return null;
    const parsed = Number(numericPart);
    if (!Number.isFinite(parsed)) return null;
    const abs = Math.abs(parsed);
    if (explicitPositive) return abs;
    if (explicitNegative) return -abs;
    return displayMultiplier === -1 ? -abs : abs;
  }, [displayMultiplier]);

  const save = useCallback(async (amount: number) => {
    if (!accountId || !statementMonth) return;
    setSaving(true);
    setErrMsg("");
    try {
      const res = await fetch("/api/v1/bill/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, statementMonth, amount: amount + postOverrideAdjustment }),
      });
      const data = await res.json();
      if (data.ok) {
        setCommittedAmount(amount);
        setLocalHasOverride(true);
        window.dispatchEvent(
          new CustomEvent("mmh:bill-override:changed", {
            detail: {
              accountId,
              statementMonth,
              amount,
              hasOverride: true,
            },
          }),
        );
        dispatchFinanceDataChanged({ reason: "bill-override", accountIds: [accountId], statementMonth, balanceChanged: true });
        setEditing(false);
        setSaving(false);
        return;
      }
      setErrMsg(data.error || t("editBill.saveFailed"));
    } catch {
      setErrMsg(t("editBill.networkError"));
    }
    setSaving(false);
  }, [accountId, postOverrideAdjustment, statementMonth, t]);

  const reset = useCallback(async () => {
    if (!accountId || !statementMonth) return;
    setSaving(true);
    try {
      await fetch(`/api/v1/bill/override?accountId=${accountId}&statementMonth=${statementMonth}`, { method: "DELETE" });
      await new Promise((resolve) => setTimeout(resolve, 60));
      dispatchFinanceDataChanged({ reason: "bill-override-reset", accountIds: [accountId], statementMonth, balanceChanged: true });
    } catch {
      // ignore
    }
    setSaving(false);
  }, [accountId, statementMonth]);

  if (editing) {
    return (
      <div ref={wrapperRef} className="flex items-center gap-1">
        <input
          type="text"
          inputMode="decimal"
          className="h-6 w-20 rounded border border-blue-300 bg-white px-1.5 text-right text-xs tabular-nums text-blue-700 outline-none"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={(e) => {
            const next = e.relatedTarget as Node | null;
            if (next && wrapperRef.current?.contains(next)) return;
            cancelEdit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const displayValue = parseDisplayInput(val);
              if (displayValue != null) save(displayValue / displayMultiplier);
            }
            if (e.key === "Escape") cancelEdit();
          }}
          autoFocus
          disabled={saving}
        />
        <button
          type="button"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-emerald-500 text-white hover:bg-emerald-600"
          onClick={() => {
            const displayValue = parseDisplayInput(val);
            if (displayValue != null) save(displayValue / displayMultiplier);
          }}
          disabled={saving}
          title={t("editBill.confirmLock")}
        >
          <Check className="h-3 w-3" strokeWidth={3} />
        </button>
        {errMsg ? <span className="text-[10px] text-red-500">{errMsg}</span> : null}
      </div>
    );
  }

  return (
    <span
      className="inline-flex cursor-pointer items-center gap-1 tabular-nums hover:text-blue-600"
      onClick={() => {
        setVal(String(displayAmount.toFixed(2)));
        setErrMsg("");
        setEditing(true);
      }}
      title={t("editBill.clickToEdit")}
    >
      {formatMoney(displayAmount)}
      {localHasOverride ? (
        <Unlock
          className="h-3.5 w-3.5 shrink-0 cursor-pointer text-orange-400 hover:text-orange-600"
          onClick={(e) => {
            e.stopPropagation();
            void reset();
          }}
          aria-label={t("editBill.unlockReset")}
        />
      ) : null}
    </span>
  );
}
