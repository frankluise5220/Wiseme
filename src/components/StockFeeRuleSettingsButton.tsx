"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Settings2, X } from "lucide-react";

import { formatMoneyWithCurrencyCode as formatMoney } from "@/lib/format";
import { todayDateLocalYmd as todayDateInputValue } from "@/lib/date-utils";
import { useI18n } from "@/lib/i18n";

type FeeRule = {
  id: string;
  feeType: string;
  direction: string;
  market?: string | null;
  stockCode?: string | null;
  rate?: number | null;
  amount?: number | null;
  minAmount?: number | null;
  currency?: string | null;
  effectiveDate?: string | null;
};

type FeeRuleListResponse = {
  ok?: boolean;
  error?: string;
  data?: { rules?: FeeRule[] };
};

type FeeRuleSaveResponse = {
  ok?: boolean;
  error?: string;
  data?: { rule?: FeeRule };
};

const FEE_TYPE_OPTIONS = [
  { value: "commission", labelKey: "stockFee.feeType.commission" },
  { value: "stamp_tax", labelKey: "stockFee.feeType.stamp_tax" },
  { value: "transfer_fee", labelKey: "stockFee.feeType.transfer_fee" },
  { value: "exchange_fee", labelKey: "stockFee.feeType.exchange_fee" },
  { value: "regulatory_fee", labelKey: "stockFee.feeType.regulatory_fee" },
  { value: "platform_fee", labelKey: "stockFee.feeType.platform_fee" },
  { value: "other", labelKey: "stockFee.feeType.other" },
] as const;

const DIRECTION_OPTIONS = [
  { value: "both", labelKey: "stockFee.direction.both" },
  { value: "buy", labelKey: "stockFee.direction.buy" },
  { value: "sell", labelKey: "stockFee.direction.sell" },
] as const;

const SCOPE_OPTIONS = [
  { value: "account", labelKey: "stockFee.scope.account" },
  { value: "CN", labelKey: "stockFee.scope.CN" },
  { value: "CN_SH", labelKey: "stockFee.scope.CN_SH" },
  { value: "CN_SZ", labelKey: "stockFee.scope.CN_SZ" },
  { value: "CN_BJ", labelKey: "stockFee.scope.CN_BJ" },
  { value: "HK", labelKey: "stockFee.scope.HK" },
  { value: "US", labelKey: "stockFee.scope.US" },
] as const;

function formatPercentRate(rate?: number | null, locale = "zh-CN") {
  if (rate == null || !Number.isFinite(Number(rate))) return "-";
  return `${(Number(rate) * 100).toLocaleString(locale, { maximumFractionDigits: 4 })}%`;
}

function optionLabel(
  t: (key: string) => string,
  options: readonly { value: string; labelKey: string }[],
  value?: string | null,
) {
  const item = options.find((entry) => entry.value === value);
  return item ? t(item.labelKey) : value ?? "-";
}

export function StockFeeRuleSettingsButton({
  accountId,
  accountLabel,
  currency = "CNY",
}: {
  accountId: string;
  accountLabel: string;
  currency?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<FeeRule[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [feeType, setFeeType] = useState("commission");
  const [direction, setDirection] = useState("both");
  const [scope, setScope] = useState("account");
  const [ratePercent, setRatePercent] = useState("");
  const [amount, setAmount] = useState("");
  const [minAmount, setMinAmount] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayDateInputValue);
  const [note, setNote] = useState("");
  const { t, language } = useI18n();

  const displayCurrency = useMemo(() => (currency?.trim() || "CNY").toUpperCase(), [currency]);

  const loadRules = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ accountId, list: "1", limit: "60" });
      const res = await fetch(`/api/v1/stocks/fee-rules?${params.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as FeeRuleListResponse | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("stockFee.error.loadFailed"));
      setRules(data.data?.rules ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stockFee.error.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    if (open) void loadRules();
  }, [open, loadRules]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const rate = Number(ratePercent);
    const fixedAmount = Number(amount);
    if (!ratePercent.trim() && !amount.trim()) {
      setError(t("stockFee.error.rateOrAmountRequired"));
      return;
    }
    if (ratePercent.trim() && (!Number.isFinite(rate) || rate < 0)) {
      setError(t("stockFee.error.invalidRate"));
      return;
    }
    if (amount.trim() && (!Number.isFinite(fixedAmount) || fixedAmount < 0)) {
      setError(t("stockFee.error.invalidAmount"));
      return;
    }
    setSaving(true);
    setError("");
    try {
      const payload = {
        accountId,
        feeType,
        direction,
        market: scope === "account" ? undefined : scope,
        rate: ratePercent.trim() ? rate / 100 : undefined,
        amount: amount.trim() ? fixedAmount : undefined,
        minAmount: minAmount.trim() ? Number(minAmount) : undefined,
        effectiveDate,
        currency: displayCurrency,
        note: note.trim() || undefined,
      };
      const res = await fetch("/api/v1/stocks/fee-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null) as FeeRuleSaveResponse | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("stockFee.error.saveFailed"));
      setRatePercent("");
      setAmount("");
      setMinAmount("");
      setNote("");
      await loadRules();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("stockFee.error.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-500 transition-colors hover:bg-blue-50 hover:text-blue-600"
        title={t("stockFee.openTitle")}
        aria-label={t("stockFee.openTitle")}
      >
        <Settings2 className="h-3.5 w-3.5" />
      </button>
      {open && typeof document !== "undefined" ? createPortal(
        <div className="app-modal-backdrop z-[1000]">
          <div className="app-modal-panel max-w-[min(42rem,calc(100vw-1rem))]">
            <div className="modal-header">
              <div>
                <div className="text-sm font-semibold text-slate-800">{t("stockFee.title")}</div>
                <div className="mt-0.5 text-xs text-slate-500">{accountLabel}</div>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="secondary-button h-8 px-2" title={t("stockFee.close")}>
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <form onSubmit={submit} className="rounded-[12px] border border-slate-200 bg-slate-50/70 p-3">
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <div className="space-y-1">
                    <div className="form-label">{t("stockFee.feeTypeLabel")}</div>
                    <select value={feeType} onChange={(event) => setFeeType(event.target.value)} className="form-input">
                      {FEE_TYPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{t(item.labelKey)}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("stockFee.directionLabel")}</div>
                    <select value={direction} onChange={(event) => setDirection(event.target.value)} className="form-input">
                      {DIRECTION_OPTIONS.map((item) => <option key={item.value} value={item.value}>{t(item.labelKey)}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("stockFee.scopeLabel")}</div>
                    <select value={scope} onChange={(event) => setScope(event.target.value)} className="form-input">
                      {SCOPE_OPTIONS.map((item) => <option key={item.value} value={item.value}>{t(item.labelKey)}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("stockFee.effectiveDateLabel")}</div>
                    <input type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} className="form-input" />
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <div className="space-y-1">
                    <div className="form-label">{t("stockFee.rateLabel")}</div>
                    <input value={ratePercent} onChange={(event) => setRatePercent(event.target.value)} className="form-input" inputMode="decimal" placeholder={t("stockFee.ratePlaceholder")} />
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("stockFee.amountLabel")}</div>
                    <input value={amount} onChange={(event) => setAmount(event.target.value)} className="form-input" inputMode="decimal" placeholder={t("stockFee.optional")} />
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("stockFee.minAmountLabel")}</div>
                    <input value={minAmount} onChange={(event) => setMinAmount(event.target.value)} className="form-input" inputMode="decimal" placeholder={t("stockFee.optional")} />
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("stockFee.noteLabel")}</div>
                    <input value={note} onChange={(event) => setNote(event.target.value)} className="form-input" placeholder={t("stockFee.optional")} />
                  </div>
                </div>
                {error ? <div className="mt-2 text-xs text-rose-600">{error}</div> : null}
                <div className="mt-3 flex justify-end">
                  <button type="submit" disabled={saving} className="primary-button h-8 px-3 text-xs disabled:opacity-50">
                    {saving ? t("stockFee.saving") : t("stockFee.save")}
                  </button>
                </div>
              </form>

              <div>
                <div className="mb-2 text-xs font-medium text-slate-600">{t("stockFee.currentRules")}</div>
                <div className="overflow-hidden rounded-[12px] border border-slate-200 bg-white">
                  {loading ? (
                    <div className="px-4 py-6 text-center text-sm text-slate-400">{t("stockFee.loading")}</div>
                  ) : rules.length > 0 ? (
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-xs text-slate-500">
                        <tr className="border-b border-slate-200">
                          <th className="px-3 py-2 text-left font-medium">{t("stockFee.colType")}</th>
                          <th className="px-3 py-2 text-left font-medium">{t("stockFee.colScope")}</th>
                          <th className="px-3 py-2 text-left font-medium">{t("stockFee.colDirection")}</th>
                          <th className="px-3 py-2 text-right font-medium">{t("stockFee.colRate")}</th>
                          <th className="px-3 py-2 text-right font-medium">{t("stockFee.colFixedMin")}</th>
                          <th className="px-3 py-2 text-right font-medium">{t("stockFee.colEffective")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rules.map((rule) => (
                          <tr key={rule.id} className="border-b border-slate-100 last:border-b-0">
                            <td className="px-3 py-2">{optionLabel(t, FEE_TYPE_OPTIONS, rule.feeType)}</td>
                            <td className="px-3 py-2">{optionLabel(t, SCOPE_OPTIONS, rule.market ?? "account")}</td>
                            <td className="px-3 py-2">{optionLabel(t, DIRECTION_OPTIONS, rule.direction)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{formatPercentRate(rule.rate, language)}</td>
                            <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-500">
                              {formatMoney(rule.amount, rule.currency ?? displayCurrency)} / {formatMoney(rule.minAmount, rule.currency ?? displayCurrency)}
                            </td>
                            <td className="px-3 py-2 text-right text-xs tabular-nums text-slate-500">{rule.effectiveDate ?? "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="px-4 py-6 text-center text-sm text-slate-400">{t("stockFee.noRules")}</div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
