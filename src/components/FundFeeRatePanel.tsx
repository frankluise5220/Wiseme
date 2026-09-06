"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Loader2, Percent, Trash2 } from "lucide-react";

import { useI18n } from "@/lib/i18n";

export type FeeRateRecord = {
  fundCode: string;
  fundName: string | null;
  buyRate: number | null;
  redeemRate: number | null;
  buyEffectiveDate: string | null;
  redeemEffectiveDate: string | null;
  effectiveDate: string | null;
  placeholder?: boolean;
};

type FeeRateListResponse = {
  ok?: boolean;
  rows?: FeeRateRecord[];
  error?: string;
};

type FeeRatePayloadRow = {
  fundCode: string;
  feeType: "buy" | "redeem";
  rate: number;
  effectiveDate?: string;
};

function normalizeRateValue(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

function hasAnyRate(row: Pick<FeeRateRecord, "buyRate" | "redeemRate">) {
  return row.buyRate != null || row.redeemRate != null;
}

function effectiveDateFor(row: FeeRateRecord) {
  return row.effectiveDate ?? row.buyEffectiveDate ?? row.redeemEffectiveDate ?? undefined;
}

/**
 * Editable fund fee-rate history. The bottom blank row is the add-record row;
 * each row persists by replacing only that fund's scoped fee-rate records.
 */
export function FundFeeRatePanel({
  accountId,
  initialFundCode,
  onSaved,
  preloadedRows,
  compact = false,
  hideFundColumn = false,
}: {
  accountId: string;
  /** When set, the panel scopes the history and new-record row to one fund. */
  initialFundCode?: string | null;
  onSaved?: (result: { fundCode: string; rows: FeeRateRecord[] }) => void;
  /** Preloaded account fee rates used by the fund profile dialog to avoid refetching on navigation. */
  preloadedRows?: FeeRateRecord[];
  /** Compact variant for embedding inside a dialog. */
  compact?: boolean;
  /** Hide repeated fund identity columns when the surrounding card already identifies the fund. */
  hideFundColumn?: boolean;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<FeeRateRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingRowKey, setSavingRowKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [draftFundCode, setDraftFundCode] = useState(initialFundCode ?? "");
  const [draftBuyRate, setDraftBuyRate] = useState("");
  const [draftRedeemRate, setDraftRedeemRate] = useState("");
  const [draftEffectiveDate, setDraftEffectiveDate] = useState("");

  const applyRows = useCallback((list: FeeRateRecord[]) => {
    const selected = initialFundCode
      ? list.filter((row) => row.fundCode === initialFundCode)
      : list;
    setRows(selected);
    return selected;
  }, [initialFundCode]);

  const fetchRowsFromServer = useCallback(async () => {
    const url = `/api/v1/fund/fee-rate?accountId=${encodeURIComponent(accountId)}&list=1`;
    const response = await fetch(url, { cache: "no-store" });
    const data = (await response.json().catch(() => null)) as FeeRateListResponse | null;
    if (!response.ok || !data?.ok || !Array.isArray(data.rows)) {
      throw new Error(data?.error || t("fundFeeRates.loadFailed"));
    }
    return data.rows;
  }, [accountId, t]);

  const loadRows = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError("");
    try {
      if (preloadedRows) {
        applyRows(preloadedRows);
        return;
      }
      applyRows(await fetchRowsFromServer());
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fundFeeRates.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [accountId, applyRows, fetchRowsFromServer, preloadedRows, t]);

  useEffect(() => {
    setDraftFundCode(initialFundCode ?? "");
    setDraftBuyRate("");
    setDraftRedeemRate("");
    setDraftEffectiveDate("");
    void loadRows();
  }, [initialFundCode, loadRows]);

  const displayRows = useMemo(
    () => rows.map((row, index) => ({ row, index })).filter(({ row }) => !row.placeholder),
    [rows],
  );

  const updateRow = useCallback((index: number, patch: Partial<FeeRateRecord>) => {
    setRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch, placeholder: false } : row));
    setError("");
  }, []);

  const buildPayloadRows = useCallback((sourceRows: FeeRateRecord[]) => {
    const payloadRows: FeeRatePayloadRow[] = [];
    for (const row of sourceRows) {
      const fundCode = row.fundCode.trim();
      const effectiveDate = effectiveDateFor(row);
      if (!fundCode || !hasAnyRate(row)) continue;
      if (row.buyRate != null) payloadRows.push({ fundCode, feeType: "buy", rate: row.buyRate, effectiveDate });
      if (row.redeemRate != null) payloadRows.push({ fundCode, feeType: "redeem", rate: row.redeemRate, effectiveDate });
    }
    return payloadRows;
  }, []);

  const saveScopedRows = useCallback(async (nextRows: FeeRateRecord[], fundCode: string, rowKey: string) => {
    const scopedFundCode = (initialFundCode ?? fundCode).trim();
    const scopedRows = nextRows
      .filter((row) => !row.placeholder && row.fundCode === scopedFundCode)
      .map((row) => ({ ...row, fundCode: scopedFundCode }));
    const payloadRows = buildPayloadRows(scopedRows);
    if (!scopedFundCode || payloadRows.length === 0) return false;

    setSavingRowKey(rowKey);
    setError("");
    try {
      const response = await fetch("/api/v1/fund/fee-rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          replace: true,
          fundCode: scopedFundCode,
          rows: payloadRows,
        }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !data?.ok) throw new Error(data?.error || t("fundFeeRates.saveFailed"));

      let selectedRows: FeeRateRecord[];
      try {
        selectedRows = applyRows(await fetchRowsFromServer());
      } catch {
        selectedRows = applyRows(nextRows);
      }
      onSaved?.({ fundCode: scopedFundCode, rows: selectedRows.filter((row) => row.fundCode === scopedFundCode) });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fundFeeRates.saveFailed"));
      return false;
    } finally {
      setSavingRowKey(null);
    }
  }, [accountId, applyRows, buildPayloadRows, fetchRowsFromServer, initialFundCode, onSaved, t]);

  const saveExistingRow = useCallback((index: number) => {
    const row = rows[index];
    if (!row || row.placeholder || !hasAnyRate(row)) return;
    void saveScopedRows(rows, row.fundCode, `row:${index}`);
  }, [rows, saveScopedRows]);

  const canDeleteRow = useCallback((index: number) => {
    const row = rows[index];
    if (!row || row.placeholder) return false;
    const scopedFundCode = (initialFundCode ?? row.fundCode).trim();
    return rows.some((candidate, rowIndex) =>
      rowIndex !== index
      && !candidate.placeholder
      && candidate.fundCode === scopedFundCode
      && hasAnyRate(candidate));
  }, [initialFundCode, rows]);

  const deleteRow = useCallback((index: number) => {
    const row = rows[index];
    if (!row || row.placeholder) return;
    if (!canDeleteRow(index)) {
      setError(t("fundFeeRates.keepOneRecord"));
      return;
    }
    const nextRows = rows.filter((_, rowIndex) => rowIndex !== index);
    void saveScopedRows(nextRows, row.fundCode, `delete:${index}`);
  }, [canDeleteRow, rows, saveScopedRows, t]);

  const saveDraftRow = useCallback(() => {
    const code = (initialFundCode ?? draftFundCode).trim();
    if (!code) return;
    const hasBuyRate = draftBuyRate.trim() !== "";
    const hasRedeemRate = draftRedeemRate.trim() !== "";
    if (!hasBuyRate && !hasRedeemRate) return;
    const draftRow: FeeRateRecord = {
      fundCode: code,
      fundName: null,
      buyRate: hasBuyRate ? normalizeRateValue(draftBuyRate) : null,
      redeemRate: hasRedeemRate ? normalizeRateValue(draftRedeemRate) : null,
      buyEffectiveDate: hasBuyRate ? draftEffectiveDate.trim() || null : null,
      redeemEffectiveDate: hasRedeemRate ? draftEffectiveDate.trim() || null : null,
      effectiveDate: draftEffectiveDate.trim() || null,
    };
    const nextRows = [...rows.filter((row) => !(row.placeholder && row.fundCode === code)), draftRow];
    void (async () => {
      const saved = await saveScopedRows(nextRows, code, "draft");
      if (!saved) return;
      setDraftFundCode(initialFundCode ?? "");
      setDraftBuyRate("");
      setDraftRedeemRate("");
      setDraftEffectiveDate("");
    })();
  }, [draftBuyRate, draftEffectiveDate, draftFundCode, draftRedeemRate, initialFundCode, rows, saveScopedRows]);

  const draftCanSave = Boolean((initialFundCode ?? draftFundCode).trim() && (draftBuyRate.trim() || draftRedeemRate.trim()));
  const anySaving = savingRowKey !== null;

  return (
    <div className={compact ? "flex h-full min-h-0 flex-col" : "flex h-full min-h-0 flex-1 flex-col"}>
      <div className={`min-h-0 overflow-auto rounded-md border border-slate-200 ${compact ? "max-h-[170px]" : "flex-1"}`} style={{ scrollbarGutter: "stable" }}>
        {loading ? (
          <div className="flex h-24 items-center justify-center text-sm text-slate-400">{t("fundFeeRates.loading")}</div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50">
              <tr>
                {!hideFundColumn ? (
                  <th className="border-b border-slate-200 px-2 py-1.5 text-left text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.fund")}</th>
                ) : null}
                <th className="border-b border-slate-200 px-2 py-1.5 text-right text-xs font-semibold text-slate-600">{t("fundFeeRates.col.buyRate")}</th>
                <th className="border-b border-slate-200 px-2 py-1.5 text-right text-xs font-semibold text-slate-600">{t("fundFeeRates.col.redeemRate")}</th>
                <th className="border-b border-slate-200 px-2 py-1.5 text-right text-xs font-semibold text-slate-600">{t("fundFeeRates.col.effectiveDate")}</th>
                <th className="w-32 border-b border-slate-200 px-2 py-1.5 text-right text-xs font-semibold text-slate-600">{t("detail.column.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map(({ row, index }) => {
                const rowKey = `row:${index}`;
                const saving = savingRowKey === rowKey;
                return (
                  <tr key={`${row.fundCode}-${row.effectiveDate ?? "latest"}-${index}`} className="hover:bg-slate-50">
                    {!hideFundColumn ? (
                      <td className="border-b border-slate-100 px-2 py-1">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-slate-800" title={row.fundName ?? undefined}>
                            {row.fundName || "-"}
                          </div>
                          <div className="text-[11px] tabular-nums text-slate-400">{row.fundCode}</div>
                        </div>
                      </td>
                    ) : null}
                    <td className="border-b border-slate-100 px-2 py-1 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={row.buyRate ?? ""}
                          onChange={(e) => updateRow(index, { buyRate: e.target.value === "" ? null : normalizeRateValue(e.target.value), buyEffectiveDate: row.effectiveDate })}
                          className="h-6 w-[4.5rem] rounded border border-slate-200 px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                        />
                        <Percent className="h-3 w-3 shrink-0 text-slate-400" />
                      </div>
                    </td>
                    <td className="border-b border-slate-100 px-2 py-1 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          value={row.redeemRate ?? ""}
                          onChange={(e) => updateRow(index, { redeemRate: e.target.value === "" ? null : normalizeRateValue(e.target.value), redeemEffectiveDate: row.effectiveDate })}
                          className="h-6 w-[4.5rem] rounded border border-slate-200 px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                        />
                        <Percent className="h-3 w-3 shrink-0 text-slate-400" />
                      </div>
                    </td>
                    <td className="border-b border-slate-100 px-2 py-1 text-right">
                      <input
                        type="date"
                        value={row.effectiveDate ?? ""}
                        onChange={(e) => {
                          const effectiveDate = e.target.value || null;
                          updateRow(index, {
                            effectiveDate,
                            buyEffectiveDate: row.buyRate != null ? effectiveDate : null,
                            redeemEffectiveDate: row.redeemRate != null ? effectiveDate : null,
                          });
                        }}
                        className="h-6 rounded border border-slate-200 px-1.5 text-xs tabular-nums outline-none focus:border-blue-400"
                      />
                    </td>
                    <td className="border-b border-slate-100 px-2 py-1 text-right">
                      <div className="inline-flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => saveExistingRow(index)}
                          disabled={anySaving || !hasAnyRate(row)}
                          className="inline-flex h-6 items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                        >
                          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                          {t("common.save")}
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteRow(index)}
                          disabled={anySaving || !canDeleteRow(index)}
                          className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                          title={canDeleteRow(index) ? t("common.delete") : t("fundFeeRates.keepOneRecord")}
                          aria-label={canDeleteRow(index) ? t("common.delete") : t("fundFeeRates.keepOneRecord")}
                        >
                          {savingRowKey === `delete:${index}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              <tr className="bg-slate-50/60">
                {!hideFundColumn ? (
                  <td className="border-b border-slate-100 px-2 py-1">
                    <input
                      type="text"
                      value={draftFundCode}
                      onChange={(e) => setDraftFundCode(e.target.value)}
                      placeholder={t("fundFeeRates.newFundCodePlaceholder")}
                      className="h-6 w-24 rounded border border-slate-200 bg-white px-1.5 text-xs outline-none focus:border-blue-400"
                    />
                  </td>
                ) : null}
                <td className="border-b border-slate-100 px-2 py-1 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={draftBuyRate}
                      onChange={(e) => setDraftBuyRate(e.target.value)}
                      placeholder={t("fundFeeRates.buyRatePlaceholder")}
                      className="h-6 w-[4.5rem] rounded border border-slate-200 bg-white px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                    />
                    <Percent className="h-3 w-3 shrink-0 text-slate-400" />
                  </div>
                </td>
                <td className="border-b border-slate-100 px-2 py-1 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={draftRedeemRate}
                      onChange={(e) => setDraftRedeemRate(e.target.value)}
                      placeholder={t("fundFeeRates.redeemRatePlaceholder")}
                      className="h-6 w-[4.5rem] rounded border border-slate-200 bg-white px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                    />
                    <Percent className="h-3 w-3 shrink-0 text-slate-400" />
                  </div>
                </td>
                <td className="border-b border-slate-100 px-2 py-1 text-right">
                  <input
                    type="date"
                    value={draftEffectiveDate}
                    onChange={(e) => setDraftEffectiveDate(e.target.value)}
                    className="h-6 rounded border border-slate-200 bg-white px-1.5 text-xs tabular-nums outline-none focus:border-blue-400"
                  />
                </td>
                <td className="border-b border-slate-100 px-2 py-1 text-right">
                  <div className="inline-flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={saveDraftRow}
                      disabled={anySaving || !draftCanSave}
                      className="inline-flex h-6 items-center gap-1 rounded border border-blue-200 bg-white px-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                    >
                      {savingRowKey === "draft" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      {t("common.save")}
                    </button>
                    <span className="h-6 w-6" aria-hidden="true" />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
      {error ? <div className="mt-2 text-right text-xs text-rose-600">{error}</div> : null}
    </div>
  );
}
