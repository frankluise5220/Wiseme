"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, Check, Loader2, Percent, Trash2, X } from "lucide-react";

import { FundFeeRatePanel } from "@/components/FundFeeRatePanel";
import { useI18n } from "@/lib/i18n";

export type ConfirmDayRow = {
  fundCode: string;
  fundName: string | null;
  days: number;
  arrivalDays: number;
  redeemCostDays: number;
  effectiveDate: string | null;
};

type ConfirmDaysListResponse = {
  ok?: boolean;
  rows?: ConfirmDayRow[];
  error?: string;
};

type MutationResponse = {
  ok?: boolean;
  error?: string;
};

type ConfirmDayPayloadRow = {
  fundCode: string;
  days: number;
  arrivalDays: number;
  redeemCostDays: number;
  effectiveDate?: string | null;
};

function normalizeDaysValue(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function defaultConfirmDayRow(fundCode: string, fundName: string | null | undefined): ConfirmDayRow {
  return {
    fundCode,
    fundName: fundName ?? null,
    days: 1,
    arrivalDays: 2,
    redeemCostDays: 1,
    effectiveDate: null,
  };
}

function normalizeRow(row: ConfirmDayRow, fallbackFundName?: string | null): ConfirmDayRow {
  return {
    ...row,
    fundName: row.fundName ?? fallbackFundName ?? null,
    days: normalizeDaysValue(String(row.days)),
    arrivalDays: normalizeDaysValue(String(row.arrivalDays)),
    redeemCostDays: normalizeDaysValue(String(row.redeemCostDays)),
    effectiveDate: row.effectiveDate || null,
  };
}

function draftDaysValue(value: string, fallback: number) {
  return value.trim() === "" ? fallback : normalizeDaysValue(value);
}

/**
 * Editable fund confirm-day rule list. Renders the table body only (no modal
 * overlay), so it can be embedded into an account edit dialog or shown inside
 * the FundConfirmDaysModal shell.
 */
export function FundConfirmDaysPanel({
  accountId,
  initialFundCode,
  fundName,
  onSaved,
  preloadedRows,
  compact = false,
  hideFundColumn = false,
}: {
  accountId: string;
  /** When set, the panel edits only this fund's rule (row-action entry point). */
  initialFundCode?: string | null;
  /** Display name for the single-fund mode. */
  fundName?: string | null;
  onSaved?: (result: { fundCode: string; rows: ConfirmDayRow[] }) => void;
  /** Preloaded account rules used by the fund profile dialog to avoid refetching on navigation. */
  preloadedRows?: ConfirmDayRow[];
  /** Compact variant for embedding inside a dialog. */
  compact?: boolean;
  /** Hide repeated fund identity columns when the surrounding card already identifies the fund. */
  hideFundColumn?: boolean;
}) {
  const { t } = useI18n();
  const singleFundMode = Boolean(initialFundCode);
  const [rows, setRows] = useState<ConfirmDayRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [savingRowKey, setSavingRowKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [draftFundCode, setDraftFundCode] = useState(initialFundCode ?? "");
  const [draftDays, setDraftDays] = useState("");
  const [draftArrivalDays, setDraftArrivalDays] = useState("");
  const [draftRedeemCostDays, setDraftRedeemCostDays] = useState("");
  const [draftEffectiveDate, setDraftEffectiveDate] = useState("");

  const applyRows = useCallback((list: ConfirmDayRow[]) => {
    let selected = initialFundCode
      ? list.filter((row) => row.fundCode === initialFundCode)
      : list;
    selected = selected.map((row) => normalizeRow(row, row.fundCode === initialFundCode ? fundName : null));
    if (initialFundCode && selected.length === 0) {
      selected = [defaultConfirmDayRow(initialFundCode, fundName)];
    }
    setRows(selected);
    return selected;
  }, [fundName, initialFundCode]);

  const fetchRowsFromServer = useCallback(async () => {
    const url = `/api/v1/fund/confirm-days?accountId=${encodeURIComponent(accountId)}&list=1`;
    const response = await fetch(url, { cache: "no-store" });
    const data = (await response.json().catch(() => null)) as ConfirmDaysListResponse | null;
    if (!response.ok || !data?.ok || !Array.isArray(data.rows)) {
      throw new Error(data?.error || t("fundConfirmDays.loadFailed"));
    }
    return data.rows;
  }, [accountId, t]);

  const loadRows = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setError("");
    try {
      if (singleFundMode && initialFundCode) {
        if (preloadedRows) {
          applyRows(preloadedRows);
          return;
        }
        const url = `/api/v1/fund/confirm-days?accountId=${encodeURIComponent(accountId)}&fundCode=${encodeURIComponent(initialFundCode)}`;
        const response = await fetch(url, { cache: "no-store" });
        const data = (await response.json().catch(() => null)) as {
          ok?: boolean;
          days?: number;
          arrivalDays?: number;
          redeemCostDays?: number;
          effectiveDate?: string | null;
          error?: string;
        } | null;
        if (!data?.ok) {
          setError(data?.error || t("fundConfirmDays.loadFailed"));
          return;
        }
        setRows([normalizeRow({
          fundCode: initialFundCode,
          fundName: fundName ?? null,
          days: data.days ?? 1,
          arrivalDays: data.arrivalDays ?? 2,
          redeemCostDays: data.redeemCostDays ?? 1,
          effectiveDate: data.effectiveDate ?? null,
        }, fundName)]);
        return;
      }
      if (preloadedRows) {
        applyRows(preloadedRows);
        return;
      }
      applyRows(await fetchRowsFromServer());
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fundConfirmDays.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [accountId, applyRows, fetchRowsFromServer, initialFundCode, singleFundMode, fundName, preloadedRows, t]);

  useEffect(() => {
    setDraftFundCode(initialFundCode ?? "");
    setDraftDays("");
    setDraftArrivalDays("");
    setDraftRedeemCostDays("");
    setDraftEffectiveDate("");
    void loadRows();
  }, [initialFundCode, loadRows]);

  const displayRows = useMemo(() => rows.map((row, index) => ({ row, index })), [rows]);

  const updateRow = useCallback((index: number, patch: Partial<ConfirmDayRow>) => {
    setRows((current) => current.map((row, rowIndex) => (
      rowIndex === index ? normalizeRow({ ...row, ...patch }, row.fundCode === initialFundCode ? fundName : null) : row
    )));
    setError("");
  }, [fundName, initialFundCode]);

  const buildPayloadRow = useCallback((row: ConfirmDayRow, fundCodeOverride?: string | null): ConfirmDayPayloadRow => ({
    fundCode: (fundCodeOverride ?? row.fundCode).trim(),
    days: normalizeDaysValue(String(row.days)),
    arrivalDays: normalizeDaysValue(String(row.arrivalDays)),
    redeemCostDays: normalizeDaysValue(String(row.redeemCostDays)),
    effectiveDate: row.effectiveDate || null,
  }), []);

  const saveRule = useCallback(async (nextRows: ConfirmDayRow[], row: ConfirmDayRow, rowKey: string) => {
    const payloadRow = buildPayloadRow(row, initialFundCode ?? row.fundCode);
    if (!accountId || !payloadRow.fundCode) return false;

    setSavingRowKey(rowKey);
    setError("");
    try {
      const response = await fetch("/api/v1/fund/confirm-days", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, rows: [payloadRow] }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!data?.ok) throw new Error(data?.error || t("fundConfirmDays.saveFailed"));

      let selectedRows: ConfirmDayRow[];
      try {
        selectedRows = applyRows(await fetchRowsFromServer());
      } catch {
        selectedRows = applyRows(nextRows);
      }
      onSaved?.({ fundCode: payloadRow.fundCode, rows: selectedRows.filter((item) => item.fundCode === payloadRow.fundCode) });
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fundConfirmDays.saveFailed"));
      return false;
    } finally {
      setSavingRowKey(null);
    }
  }, [accountId, applyRows, buildPayloadRow, fetchRowsFromServer, initialFundCode, onSaved, t]);

  const deleteRule = useCallback(async (index: number) => {
    const row = rows[index];
    if (!row?.fundCode.trim()) return;
    if (rows.length <= 1) {
      setError(t("fundConfirmDays.keepOneRecord"));
      return;
    }
    setSavingRowKey(`delete:${index}`);
    setError("");
    try {
      const response = await fetch(`/api/v1/fund/confirm-days?accountId=${encodeURIComponent(accountId)}&fundCode=${encodeURIComponent(row.fundCode)}`, {
        method: "DELETE",
      });
      const data = (await response.json().catch(() => null)) as MutationResponse | null;
      if (!response.ok || !data?.ok) throw new Error(data?.error || t("fundConfirmDays.deleteFailed"));
      let selectedRows: ConfirmDayRow[];
      try {
        selectedRows = applyRows(await fetchRowsFromServer());
      } catch {
        selectedRows = applyRows(rows.filter((_, rowIndex) => rowIndex !== index));
      }
      onSaved?.({ fundCode: row.fundCode, rows: selectedRows.filter((item) => item.fundCode === row.fundCode) });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("fundConfirmDays.deleteFailed"));
    } finally {
      setSavingRowKey(null);
    }
  }, [accountId, applyRows, fetchRowsFromServer, onSaved, rows, t]);

  const saveExistingRow = useCallback((index: number) => {
    const row = rows[index];
    if (!row?.fundCode.trim()) return;
    void saveRule(rows, row, `row:${index}`);
  }, [rows, saveRule]);

  const saveDraftRow = useCallback(() => {
    const code = (initialFundCode ?? draftFundCode).trim();
    if (!code) return;
    if (!initialFundCode && rows.some((row) => row.fundCode === code)) {
      setError(t("fundConfirmDays.duplicateFund", { code }));
      return;
    }
    if (!draftDays.trim() && !draftArrivalDays.trim() && !draftRedeemCostDays.trim() && !draftEffectiveDate.trim()) return;

    const draftRow = normalizeRow({
      fundCode: code,
      fundName: initialFundCode ? fundName ?? null : null,
      days: draftDaysValue(draftDays, 1),
      arrivalDays: draftDaysValue(draftArrivalDays, 2),
      redeemCostDays: draftDaysValue(draftRedeemCostDays, 1),
      effectiveDate: draftEffectiveDate.trim() || null,
    }, fundName);
    const nextRows = [...rows.filter((row) => row.fundCode !== code), draftRow];
    void (async () => {
      const saved = await saveRule(nextRows, draftRow, "draft");
      if (!saved) return;
      setDraftFundCode(initialFundCode ?? "");
      setDraftDays("");
      setDraftArrivalDays("");
      setDraftRedeemCostDays("");
      setDraftEffectiveDate("");
    })();
  }, [draftArrivalDays, draftDays, draftEffectiveDate, draftFundCode, draftRedeemCostDays, fundName, initialFundCode, rows, saveRule, t]);

  const draftCanSave = Boolean(
    (initialFundCode ?? draftFundCode).trim()
    && (draftDays.trim() || draftArrivalDays.trim() || draftRedeemCostDays.trim() || draftEffectiveDate.trim()),
  );
  const anySaving = savingRowKey !== null;

  return (
    <div className={compact ? "flex h-full min-h-0 flex-col" : "flex h-full min-h-0 flex-1 flex-col"}>
      <div className={`min-h-0 overflow-auto rounded-md border border-slate-200 ${compact ? "max-h-[170px]" : "flex-1"}`} style={{ scrollbarGutter: "stable" }}>
        {loading ? (
          <div className="flex h-24 items-center justify-center text-sm text-slate-400">{t("fundConfirmDays.loading")}</div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50">
              <tr>
                {!hideFundColumn ? (
                  <th className="border-b border-slate-200 px-2 py-1.5 text-left text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.fund")}</th>
                ) : null}
                <th className="border-b border-slate-200 px-2 py-1.5 text-right text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.confirmDays")}</th>
                <th className="border-b border-slate-200 px-2 py-1.5 text-right text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.arrivalDays")}</th>
                <th className="border-b border-slate-200 px-2 py-1.5 text-right text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.redeemCostDays")}</th>
                <th className="border-b border-slate-200 px-2 py-1.5 text-right text-xs font-semibold text-slate-600">{t("fundConfirmDays.col.effectiveDate")}</th>
                <th className="w-40 border-b border-slate-200 px-2 py-1.5 text-right text-xs font-semibold text-slate-600">{t("detail.column.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {displayRows.map(({ row, index }) => {
                const rowKey = `row:${index}`;
                const saving = savingRowKey === rowKey;
                const canDelete = rows.length > 1;
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
                      <input
                        type="number"
                        min={0}
                        value={row.days}
                        onChange={(e) => updateRow(index, { days: normalizeDaysValue(e.target.value) })}
                        className="h-6 w-12 rounded border border-slate-200 px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                      />
                    </td>
                    <td className="border-b border-slate-100 px-2 py-1 text-right">
                      <input
                        type="number"
                        min={0}
                        value={row.arrivalDays}
                        onChange={(e) => updateRow(index, { arrivalDays: normalizeDaysValue(e.target.value) })}
                        className="h-6 w-12 rounded border border-slate-200 px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                      />
                    </td>
                    <td className="border-b border-slate-100 px-2 py-1 text-right">
                      <input
                        type="number"
                        min={0}
                        value={row.redeemCostDays}
                        onChange={(e) => updateRow(index, { redeemCostDays: normalizeDaysValue(e.target.value) })}
                        className="h-6 w-12 rounded border border-slate-200 px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                      />
                    </td>
                    <td className="border-b border-slate-100 px-2 py-1 text-right">
                      <input
                        type="date"
                        value={row.effectiveDate ?? ""}
                        onChange={(e) => updateRow(index, { effectiveDate: e.target.value || null })}
                        className="h-6 rounded border border-slate-200 px-1.5 text-xs tabular-nums outline-none focus:border-blue-400"
                      />
                    </td>
                    <td className="border-b border-slate-100 px-2 py-1 text-right">
                      <div className="inline-flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => saveExistingRow(index)}
                          disabled={anySaving || !row.fundCode.trim()}
                          className="inline-flex h-6 items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                        >
                          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                          {t("common.save")}
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteRule(index)}
                          disabled={anySaving || !canDelete}
                          className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                          title={canDelete ? t("common.delete") : t("fundConfirmDays.keepOneRecord")}
                          aria-label={canDelete ? t("common.delete") : t("fundConfirmDays.keepOneRecord")}
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
                      placeholder={t("fundConfirmDays.newFundCodePlaceholder")}
                      className="h-6 w-24 rounded border border-slate-200 bg-white px-1.5 text-xs outline-none focus:border-blue-400"
                    />
                  </td>
                ) : null}
                <td className="border-b border-slate-100 px-2 py-1 text-right">
                  <input
                    type="number"
                    min={0}
                    value={draftDays}
                    onChange={(e) => setDraftDays(e.target.value)}
                    className="h-6 w-12 rounded border border-slate-200 bg-white px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                  />
                </td>
                <td className="border-b border-slate-100 px-2 py-1 text-right">
                  <input
                    type="number"
                    min={0}
                    value={draftArrivalDays}
                    onChange={(e) => setDraftArrivalDays(e.target.value)}
                    className="h-6 w-12 rounded border border-slate-200 bg-white px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                  />
                </td>
                <td className="border-b border-slate-100 px-2 py-1 text-right">
                  <input
                    type="number"
                    min={0}
                    value={draftRedeemCostDays}
                    onChange={(e) => setDraftRedeemCostDays(e.target.value)}
                    className="h-6 w-12 rounded border border-slate-200 bg-white px-1.5 text-right text-xs tabular-nums outline-none focus:border-blue-400"
                  />
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

/**
 * Full-screen dialog with two tabs (T+N rules and fee rates). Used from the
 * fund account page (row action / toolbar entry).
 */
export function FundConfirmDaysModal({
  accountId,
  open,
  onClose,
  onSaved,
  initialFundCode,
  fundName,
  initialTab = "confirm",
}: {
  accountId: string;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  /** When set, the modal edits only this fund's rule (row-action entry point). */
  initialFundCode?: string | null;
  /** Display name for the single-fund mode. */
  fundName?: string | null;
  initialTab?: "confirm" | "fee";
}) {
  const { t } = useI18n();
  const singleFundMode = Boolean(initialFundCode);
  const [activeTab, setActiveTab] = useState<"confirm" | "fee">("confirm");

  useEffect(() => {
    if (!open) return;
    setActiveTab(initialTab);
  }, [initialTab, open]);

  if (!open) return null;

  const modalTitle = singleFundMode
    ? `${fundName || initialFundCode} · ${t("fundRules.title")}`
    : t("fundRules.title");

  const tabClass = (active: boolean) =>
    active
      ? "border-blue-300 bg-blue-50 text-blue-700"
      : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50";

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-900/40 p-4">
      <div className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-800">
            <CalendarDays className="h-4 w-4 shrink-0 text-slate-500" />
            <span className="truncate">{modalTitle}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              aria-label={t("table.close")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 border-b border-slate-200 bg-white px-4 pt-2.5">
          <button
            type="button"
            onClick={() => setActiveTab("confirm")}
            className={`inline-flex h-8 items-center rounded-t-md border border-b-0 px-3 text-xs font-medium ${tabClass(activeTab === "confirm")}`}
          >
            <CalendarDays className="mr-1.5 h-3.5 w-3.5" />
            {t("fundRules.tab.confirm")}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("fee")}
            className={`inline-flex h-8 items-center rounded-t-md border border-b-0 px-3 text-xs font-medium ${tabClass(activeTab === "fee")}`}
          >
            <Percent className="mr-1.5 h-3.5 w-3.5" />
            {t("fundRules.tab.fee")}
          </button>
        </div>
        <div className="min-h-0 flex-1 p-4">
          {/* Both panels stay mounted so switching tabs never re-fetches or
              resizes the dialog; only visibility changes. */}
          <div className={activeTab === "confirm" ? "h-full" : "hidden"}>
            <FundConfirmDaysPanel
              accountId={accountId}
              initialFundCode={initialFundCode}
              fundName={fundName}
              onSaved={onSaved}
            />
          </div>
          <div className={activeTab === "fee" ? "h-full" : "hidden"}>
            <FundFeeRatePanel
              accountId={accountId}
              initialFundCode={initialFundCode}
              onSaved={onSaved}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
