"use client";

import { useEffect, useState } from "react";
import { Scale } from "lucide-react";
import { DateStepper } from "./DateStepper";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function formatMoneyValue(value: number, language: string) {
  return value.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type EditDetail = {
  entryId?: string;
  accountId?: string | null;
  accountName?: string | null;
  date?: string | null;
  amount?: number | null;
};

export function DebitBalanceReconcileButton({
  accountId,
  accountLabel,
  currentBalance,
}: {
  accountId: string;
  accountLabel: string;
  currentBalance: number;
}) {
  const [open, setOpen] = useState(false);
  const [reconcileAmount, setReconcileAmount] = useState("");
  const [date, setDate] = useState(todayYmd);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const { t, language } = useI18n();

  const parsedReconcileAmount = Number(reconcileAmount);

  function openModal() {
    setOpen(true);
    setEditingEntryId(null);
    setReconcileAmount("");
    setDate(todayYmd());
    setError("");
    setInfo("");
  }

  useEffect(() => {
    function handleEdit(event: Event) {
      const detail = (event as CustomEvent<EditDetail>).detail;
      if (!detail?.entryId || detail.accountId !== accountId) return;
      setOpen(true);
      setEditingEntryId(detail.entryId);
      setDate((detail.date ?? todayYmd()).slice(0, 10));
      setReconcileAmount(detail.amount != null && Number.isFinite(detail.amount) ? String(detail.amount) : "");
      setError("");
      setInfo("");
    }

    window.addEventListener("mmh:balance-reconcile:edit", handleEdit as EventListener);
    return () => window.removeEventListener("mmh:balance-reconcile:edit", handleEdit as EventListener);
  }, [accountId]);

  async function submit() {
    if (!Number.isFinite(parsedReconcileAmount)) {
      setError(t("balanceReconcile.enterValidAmount"));
      return;
    }
    setSubmitting(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/v1/accounts/balance-reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          entryId: editingEntryId ?? undefined,
          actualBalance: parsedReconcileAmount,
          date,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data?.ok) throw new Error(data?.error || t("balanceReconcile.failed"));
      setInfo(t(editingEntryId ? "balanceReconcile.resultUpdated" : "balanceReconcile.resultCreated", {
        amount: formatMoneyValue(Number(data.actualBalance ?? parsedReconcileAmount), language),
      }));
      dispatchFinanceDataChanged({
        reason: "balance-reconcile",
        accountIds: [accountId],
        entryIds: data.entryId ? [String(data.entryId)] : undefined,
      });
      setTimeout(() => setOpen(false), 450);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("balanceReconcile.failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        data-basic-detail-reconcile
        onClick={openModal}
        className="flex h-7 items-center gap-1 rounded border border-slate-200 bg-white px-2 text-xs text-slate-600 hover:bg-amber-50 hover:text-amber-700"
        title={t("balanceReconcile.buttonTitle")}
      >
        <Scale className="h-3 w-3" />
        {t("balanceReconcile.button")}
      </button>

      {open ? (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-900/25 px-4 py-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="text-sm font-semibold text-slate-800">{editingEntryId ? t("balanceReconcile.titleEdit") : t("balanceReconcile.titleCreate")}</div>
              <div className="mt-1 text-xs text-slate-500">{t("balanceReconcile.desc")}</div>
            </div>

            <div className="space-y-3 px-4 py-4 text-sm">
              <div className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                {t("balanceReconcile.hint")}
              </div>

              <label className="block">
                <span className="mb-1 block text-xs text-slate-500">{t("balanceReconcile.labelAccount")}</span>
                <div className="flex h-9 w-full items-center rounded-md border border-slate-200 bg-slate-50 px-2 text-sm text-slate-700">
                  {accountLabel || accountId}
                </div>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs text-slate-500">{t("balanceReconcile.labelDate")}</span>
                  <DateStepper value={date} onChange={setDate} className="h-9 w-full rounded-md border border-slate-200 px-2 text-sm" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-slate-500">{t("balanceReconcile.labelAmount")}</span>
                  <input
                    value={reconcileAmount}
                    onChange={(event) => setReconcileAmount(event.target.value)}
                    inputMode="decimal"
                    autoFocus
                    className="h-9 w-full rounded-md border border-slate-300 px-2 text-right tabular-nums focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-100"
                    placeholder="0.00"
                  />
                </label>
              </div>

              <div className="text-[11px] text-slate-400">
                {t("balanceReconcile.balanceInfo", {
                  balance: formatMoneyValue(currentBalance, language),
                  date: date || t("balanceReconcile.selectedDate"),
                })}
              </div>

              {error ? <div className="text-xs text-red-600">{error}</div> : null}
              {info ? <div className="text-xs text-slate-500">{info}</div> : null}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="secondary-button h-8 px-3 text-xs"
                disabled={submitting}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={submit}
                className="primary-button h-8 px-3 text-xs disabled:opacity-50"
                disabled={submitting || !Number.isFinite(parsedReconcileAmount)}
              >
                {submitting ? t("balanceReconcile.saving") : editingEntryId ? t("balanceReconcile.saveUpdate") : t("balanceReconcile.confirmCreate")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
