"use client";

import { useMemo, useRef, useState } from "react";
import { Scale } from "lucide-react";
import { DateStepper } from "./DateStepper";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { formatFundUnitsValue, normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision-core";
import { useI18n } from "@/lib/i18n";

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
}

function parseUnitsInput(value: string) {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function FundUnitsReconcileButton({
  accountId,
  fundCode,
  fundName,
  currentUnits,
  fundUnitsDecimals,
  disabled = false,
  onSaved,
}: {
  accountId: string;
  fundCode: string;
  fundName?: string | null;
  currentUnits: number;
  fundUnitsDecimals?: number | null;
  disabled?: boolean;
  onSaved?: () => void;
}) {
  const { t } = useI18n();
  const decimals = normalizeFundUnitsDecimals(fundUnitsDecimals, 2);
  const currentRoundedUnits = roundFundUnits(currentUnits, decimals);
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(todayYmd);
  const [actualUnits, setActualUnits] = useState(() => formatFundUnitsValue(currentRoundedUnits, decimals));
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const parsedActualUnits = parseUnitsInput(actualUnits);
  const deltaUnits = useMemo(() => {
    if (parsedActualUnits == null) return null;
    return roundFundUnits(parsedActualUnits - currentRoundedUnits, decimals);
  }, [currentRoundedUnits, decimals, parsedActualUnits]);
  const displayFund = [fundName, fundCode].filter(Boolean).join(" · ");

  function openModal() {
    setDate(todayYmd());
    setActualUnits(formatFundUnitsValue(currentRoundedUnits, decimals));
    setNote("");
    setError("");
    setInfo("");
    setOpen(true);
  }

  async function submit() {
    if (submittingRef.current) return;
    if (parsedActualUnits == null) {
      setError(t("fundUnitsReconcile.enterValidUnits"));
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/v1/fund/units-reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          fundCode,
          fundName,
          date,
          actualUnits: parsedActualUnits,
          note,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError(t(data?.code === "FUND_UNITS_RECONCILE_BUSY"
          ? "fundUnitsReconcile.busy"
          : "fundUnitsReconcile.failed"));
        return;
      }
      const payload = data.data ?? {};
      setInfo(payload.noChange ? t("fundUnitsReconcile.successNoChange") : t("fundUnitsReconcile.successCreated", {
        units: formatFundUnitsValue(Math.abs(Number(payload.deltaUnits ?? deltaUnits ?? 0)), decimals),
      }));
      dispatchFinanceDataChanged({
        reason: "fund-units-reconcile",
        accountIds: [accountId],
        entryIds: payload.entryId ? [String(payload.entryId)] : undefined,
      });
      onSaved?.();
      window.setTimeout(() => setOpen(false), 450);
    } catch {
      setError(t("fundUnitsReconcile.failed"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        disabled={disabled || !accountId || !fundCode}
        className="flex h-6 items-center gap-1 rounded border border-slate-200 bg-white px-2 text-xs text-slate-600 hover:bg-sky-50 hover:text-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
        title={t("fundUnitsReconcile.buttonTitle")}
      >
        <Scale className="h-3 w-3" />
        {t("fundUnitsReconcile.button")}
      </button>

      {open ? (
        <div className="fixed inset-0 z-[95] flex items-center justify-center bg-slate-900/25 px-4 py-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="text-sm font-semibold text-slate-800">{t("fundUnitsReconcile.title")}</div>
              <div className="mt-1 text-xs text-slate-500">{t("fundUnitsReconcile.desc")}</div>
            </div>

            <div className="space-y-3 px-4 py-4 text-sm">
              <div className="rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-xs text-sky-800">
                {t("fundUnitsReconcile.hint")}
              </div>

              <label className="block">
                <span className="mb-1 block text-xs text-slate-500">{t("fundUnitsReconcile.labelFund")}</span>
                <div className="flex h-9 w-full items-center truncate rounded-md border border-slate-200 bg-slate-50 px-2 text-sm text-slate-700" title={displayFund}>
                  {displayFund}
                </div>
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-xs text-slate-500">{t("fundUnitsReconcile.labelDate")}</span>
                  <DateStepper value={date} onChange={setDate} className="h-9 w-full rounded-md border border-slate-200 px-2 text-sm" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-slate-500">{t("fundUnitsReconcile.labelActualUnits")}</span>
                  <input
                    value={actualUnits}
                    onChange={(event) => setActualUnits(event.target.value)}
                    inputMode="decimal"
                    autoFocus
                    className="h-9 w-full rounded-md border border-slate-300 px-2 text-right tabular-nums focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-100"
                    placeholder="0.00"
                  />
                </label>
              </div>

              <label className="block">
                <span className="mb-1 block text-xs text-slate-500">{t("fundUnitsReconcile.labelNote")}</span>
                <input
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  className="h-9 w-full rounded-md border border-slate-200 px-2 text-sm focus:border-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-100"
                />
              </label>

              <div className="space-y-1 text-[11px] text-slate-500">
                <div>{t("fundUnitsReconcile.currentInfo", { units: formatFundUnitsValue(currentRoundedUnits, decimals) })}</div>
                <div className={deltaUnits == null ? "text-rose-600" : deltaUnits === 0 ? "text-slate-400" : deltaUnits > 0 ? "text-emerald-700" : "text-amber-700"}>
                  {deltaUnits == null
                    ? t("fundUnitsReconcile.enterValidUnits")
                    : deltaUnits === 0
                      ? t("fundUnitsReconcile.zeroDelta")
                      : t("fundUnitsReconcile.deltaInfo", {
                          sign: deltaUnits > 0 ? "+" : "-",
                          units: formatFundUnitsValue(Math.abs(deltaUnits), decimals),
                        })}
                </div>
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
                disabled={submitting || parsedActualUnits == null}
              >
                {submitting ? t("fundUnitsReconcile.saving") : t("fundUnitsReconcile.confirm")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
