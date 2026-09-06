"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownLeft, ArrowUpRight, Landmark, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";

import { AdvancedDataTable, type AdvancedDataTableColumn, type AdvancedDataTableSummaryRow } from "./AdvancedDataTable";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig } from "./BatchReplacePopoverButton";
import { BusinessLinkActionButton } from "./BusinessLinkActionButton";
import { EntryRowActions } from "./EntryRowActions";
import { ResizableVerticalSplit } from "./ResizableVerticalSplit";
import { deleteEntriesWithLinkedPrompt, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { dispatchFinanceDataChanged, FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";
import { amountToneClass as amountClass } from "@/lib/client/colors";
import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

type DepositEntry = {
  id: string;
  date: string;
  typeLabel: string;
  fundName: string;
  maturityDate?: string | null;
  cashAccountLabel: string;
  note: string;
  amount: number;
  businessTransactionId?: string | null;
  businessLinkCount?: number;
  businessLinkLabels?: string[];
  edit?: {
    type: "investment" | "expense" | "income" | "transfer";
    date: string;
    amount: number;
    note: string;
    accountId?: string;
    cashAccountId?: string;
    fundName?: string;
    fundArrivalDate?: string | null;
    fundProductType?: string;
    fundSubtype?: string;
    categoryId?: string;
    categoryName?: string;
    toAccountId?: string;
    toAccountName?: string;
    source?: string | null;
  };
};

type DepositLot = {
  id: string;
  label: string;
  fundName: string;
  subLabel?: string;
  startDate?: string | null;
  maturityDate?: string | null;
  originalAmount: number;
  remainingAmount: number;
  annualRate?: number | null;
  expectedInterest?: number | null;
  status: "open" | "closed";
  depositAccountId?: string;
  depositAccountLabel?: string;
  relatedEntryIds?: string[];
};

type DepositBatchField = "cashAccountId" | "amount" | "fundArrivalDate" | "remark";

type LotTab = "held" | "expired";

export function DepositShell({
  accountLabel,
  institutionName,
  entries,
  lots,
  cashAccounts = [],
}: {
  accountLabel: string;
  institutionName?: string;
  entries: DepositEntry[];
  lots: DepositLot[];
  cashAccounts?: Array<{ id: string; label: string }>;
}) {
  const [selectedLotId, setSelectedLotId] = useState<string | null>(null);
  const [lotTab, setLotTab] = useState<LotTab>("held");
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
  const [linkingIds, setLinkingIds] = useState<Set<string>>(new Set());
  const [entryPage, setEntryPage] = useState(1);
  const [entryPageSize, setEntryPageSize] = useState(20);
  const [entryRowCount, setEntryRowCount] = useState(0);

  const { t } = useI18n();
  const router = useRouter();
  const formatText = useCallback((key: string, values?: Record<string, string | number>) => {
    let text = t(key) as string;
    if (!values) return text;
    for (const [name, value] of Object.entries(values)) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  }, [t]);

  const selectedLot = useMemo(
    () => lots.find((lot) => lot.id === selectedLotId) ?? null,
    [lots, selectedLotId],
  );

  const heldLots = useMemo(() => lots.filter((lot) => lot.status === "open"), [lots]);
  const expiredLots = useMemo(() => lots.filter((lot) => lot.status === "closed"), [lots]);
  const visibleLots = lotTab === "held" ? heldLots : expiredLots;

  function switchLotTab(tab: LotTab) {
    setLotTab(tab);
    setSelectedLotId(null);
  }

  const visibleEntries = useMemo(() => {
    if (!selectedLot) return entries;
    const relatedIds = new Set(selectedLot.relatedEntryIds ?? [selectedLot.id]);
    return entries.filter((entry) => relatedIds.has(entry.id));
  }, [entries, selectedLot]);

  useEffect(() => {
    setEntryPage(1);
  }, [selectedLotId]);

  // Prune selections that no longer exist after data refreshes.
  useEffect(() => {
    setSelectedEntryIds((prev) => {
      if (prev.size === 0) return prev;
      const validIds = new Set(visibleEntries.map((entry) => entry.id));
      const next = new Set(Array.from(prev).filter((id) => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [visibleEntries]);

  // Refresh the server-rendered deposit view after any finance data change
  // (edits via EntryRowActions, batch operations, deposits created elsewhere).
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ balanceChanged?: boolean }>).detail;
      if (detail?.balanceChanged === false) return;
      router.refresh();
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
    return () => window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
  }, [router]);

  const totalPages = Math.max(1, Math.ceil(entryRowCount / entryPageSize));
  const safePage = Math.min(entryPage, totalPages);
  const pagedEntries = visibleEntries.slice((safePage - 1) * entryPageSize, safePage * entryPageSize);

  const batchFields = useMemo<BatchReplaceFieldConfig<DepositBatchField>[]>(() => [
    {
      value: "cashAccountId",
      label: t("txForm.cashAccount"),
      kind: "select",
      options: [{ value: "", label: t("fundShell.selectAccount") }, ...cashAccounts.map((account) => ({ value: account.id, label: account.label }))],
    },
    { value: "amount", label: t("txForm.amount"), kind: "number", placeholder: t("fundShell.batch.amountPlaceholder") },
    { value: "fundArrivalDate", label: t("fundShell.col.arrivalDate"), kind: "date", allowEmpty: true },
    { value: "remark", label: t("detail.column.remark"), kind: "text", placeholder: t("stockPanel.batchNotePlaceholder"), allowEmpty: true },
  ], [cashAccounts, t]);

  async function applyBatch(field: DepositBatchField, value: string) {
    const ids = Array.from(selectedEntryIds);
    if (ids.length === 0) throw new Error(t("stockPanel.error.selectRowsFirst"));
    const updates = ids.map((id) => {
      if (field === "remark") return { id, remark: value };
      if (field === "fundArrivalDate") return { id, fundArrivalDate: value };
      if (field === "cashAccountId") return { id, cashAccountId: value };
      return { id, amount: value };
    });
    const res = await fetch("/api/v1/entries/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: t("stockPanel.error.batchUpdateFailed") }));
    if (!res.ok || !data.ok) throw new Error(data.error ?? t("stockPanel.error.batchUpdateFailed"));
    setSelectedEntryIds(new Set());
    dispatchFinanceDataChanged({ reason: "deposit-batch-update" });
    return t("stockPanel.updatedCount", { count: data.updatedCount ?? 0 });
  }

  async function batchDeleteEntries() {
    if (selectedEntryIds.size === 0) return;
    const entryIds = Array.from(selectedEntryIds);
    const data = await deleteEntriesWithLinkedPrompt({
      entryIds,
      confirmMessage: formatText("depositShell.batchDeleteConfirm", { count: selectedEntryIds.size }),
      t,
    });
    if (!data.ok) {
      if (data.code === "DELETE_CANCELLED" || data.error === "已取消删除") return;
      window.alert(data?.error || t("depositShell.error.batchDeleteFailed"));
      return;
    }
    setSelectedEntryIds(new Set());
    const refreshEntryIds = getDeleteRefreshEntryIds(data, entryIds);
    dispatchFinanceDataChanged({ reason: "entry-batch-delete", accountIds: getDeleteRefreshAccountIds(data), deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });
  }

  async function linkDepositCashFlow(entry: DepositEntry) {
    const id = String(entry.id ?? "").trim();
    if (!id || linkingIds.has(id)) return;
    const businessTransactionId = String(entry.businessTransactionId ?? "").trim();
    if (!businessTransactionId) {
      window.alert(t("depositShell.error.missingBusinessId"));
      return;
    }
    setLinkingIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch("/api/v1/business-transactions/link-cash-flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessType: "deposit", businessTransactionId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("depositShell.error.linkFailed"));
      dispatchFinanceDataChanged({ reason: "deposit-link-cash-flow", entryIds: [data.data?.cashEntryId, id].filter(Boolean) });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("depositShell.error.linkFailed"));
    } finally {
      setLinkingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  const heldLotColumns = useMemo<AdvancedDataTableColumn<DepositLot>[]>(() => [
    {
      key: "product",
      label: t("depositShell.colProduct"),
      width: 260,
      minWidth: 160,
      filterText: (lot) => `${lot.fundName} ${lot.label} ${lot.subLabel ?? ""}`,
      filterSearchText: (lot) => `${lot.fundName} ${lot.label} ${lot.subLabel ?? ""}`,
      sortValue: (lot) => lot.fundName,
      render: (lot) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-slate-700" title={lot.fundName}>{lot.fundName}</span>
          <span className="shrink-0 text-[11px] text-slate-400">{t("investment.product.deposit")}</span>
        </div>
      ),
    },
    { key: "startDate", label: t("depositShell.colStartDate"), width: 110, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.startDate ?? "", sortValue: (lot) => lot.startDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.startDate || "-"}</span> },
    { key: "maturityDate", label: t("depositShell.colMaturityDate"), width: 110, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.maturityDate ?? "", sortValue: (lot) => lot.maturityDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.maturityDate || "-"}</span> },
    { key: "originalAmount", label: t("depositShell.colOriginalAmount"), width: 120, minWidth: 86, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.originalAmount), filterNumber: (lot) => lot.originalAmount, sortValue: (lot) => lot.originalAmount, render: (lot) => <span className="font-semibold tabular-nums text-slate-700">{formatMoney(lot.originalAmount)}</span> },
    { key: "expectedInterest", label: t("depositShell.colExpectedInterest"), width: 110, minWidth: 80, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => lot.expectedInterest != null ? String(lot.expectedInterest) : null, filterNumber: (lot) => lot.expectedInterest ?? null, sortValue: (lot) => lot.expectedInterest ?? 0, render: (lot) => lot.expectedInterest != null ? <span className="font-semibold tabular-nums text-emerald-700">{formatMoney(lot.expectedInterest)}</span> : <span className="tabular-nums text-slate-400">-</span> },
    { key: "annualRate", label: t("depositShell.colAnnualRate"), width: 100, minWidth: 72, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => lot.annualRate != null ? String(lot.annualRate) : null, filterNumber: (lot) => lot.annualRate ?? null, sortValue: (lot) => lot.annualRate ?? 0, render: (lot) => <span className="tabular-nums text-slate-600">{lot.annualRate != null ? `${lot.annualRate}%` : "-"}</span> },
  ], [t]);

  const expiredLotColumns = useMemo<AdvancedDataTableColumn<DepositLot>[]>(() => [
    {
      key: "product",
      label: t("depositShell.colProduct"),
      width: 260,
      minWidth: 160,
      filterText: (lot) => `${lot.fundName} ${lot.label} ${lot.subLabel ?? ""}`,
      filterSearchText: (lot) => `${lot.fundName} ${lot.label} ${lot.subLabel ?? ""}`,
      sortValue: (lot) => lot.fundName,
      render: (lot) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-slate-700" title={lot.fundName}>{lot.fundName}</span>
          <span className="shrink-0 text-[11px] text-slate-400">{t("investment.product.deposit")}</span>
        </div>
      ),
    },
    { key: "startDate", label: t("depositShell.colStartDate"), width: 110, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.startDate ?? "", sortValue: (lot) => lot.startDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.startDate || "-"}</span> },
    { key: "maturityDate", label: t("depositShell.colMaturityDate"), width: 110, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (lot) => lot.maturityDate ?? "", sortValue: (lot) => lot.maturityDate ?? "", render: (lot) => <span className="tabular-nums text-slate-600">{lot.maturityDate || "-"}</span> },
    { key: "originalAmount", label: t("depositShell.colOriginalAmount"), width: 120, minWidth: 86, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => String(lot.originalAmount), filterNumber: (lot) => lot.originalAmount, sortValue: (lot) => lot.originalAmount, render: (lot) => <span className="font-semibold tabular-nums text-slate-700">{formatMoney(lot.originalAmount)}</span> },
    { key: "annualRate", label: t("depositShell.colAnnualRate"), width: 100, minWidth: 72, align: "right", hideable: true, filterKind: "numberRange", filterText: (lot) => lot.annualRate != null ? String(lot.annualRate) : null, filterNumber: (lot) => lot.annualRate ?? null, sortValue: (lot) => lot.annualRate ?? 0, render: (lot) => <span className="tabular-nums text-slate-600">{lot.annualRate != null ? `${lot.annualRate}%` : "-"}</span> },
  ], [t]);

  const lotColumns = lotTab === "held" ? heldLotColumns : expiredLotColumns;

  const lotsSummaryRow = useMemo<AdvancedDataTableSummaryRow | undefined>(() => {
    if (visibleLots.length === 0) return undefined;
    const totalOriginalAmount = visibleLots.reduce((sum, lot) => sum + lot.originalAmount, 0);
    const cells: Record<string, ReactNode> = {
      product: <span className="font-semibold text-slate-800">{t("debtShell.summaryRow")}</span>,
      originalAmount: <span className="font-semibold tabular-nums text-slate-800">{formatMoney(totalOriginalAmount)}</span>,
    };
    if (lotTab === "held") {
      const totalExpectedInterest = visibleLots.reduce((sum, lot) => sum + (lot.expectedInterest ?? 0), 0);
      if (totalExpectedInterest > 0) {
        cells.expectedInterest = <span className="font-semibold tabular-nums text-emerald-700">{formatMoney(totalExpectedInterest)}</span>;
      }
    }
    return { cells, rowClassName: "bg-slate-50/80" };
  }, [lotTab, t, visibleLots]);

  const entryColumns = useMemo<AdvancedDataTableColumn<DepositEntry>[]>(() => [
    { key: "date", label: t("detail.column.date"), width: 100, minWidth: 80, filterKind: "dateRange", filterText: (entry) => entry.date, sortValue: (entry) => entry.date, render: (entry) => <span className="tabular-nums text-slate-700">{entry.date}</span> },
    { key: "action", label: t("depositShell.colAction"), width: 90, minWidth: 70, filterText: (entry) => entry.typeLabel, sortValue: (entry) => entry.typeLabel, render: (entry) => <span className="text-slate-700">{entry.typeLabel}</span> },
    { key: "product", label: t("depositShell.colProduct"), width: 190, minWidth: 120, filterText: (entry) => entry.fundName, filterSearchText: (entry) => entry.fundName, sortValue: (entry) => entry.fundName, render: (entry) => <span className="truncate text-slate-700" title={entry.fundName}>{entry.fundName || "-"}</span> },
    { key: "maturityDate", label: t("depositShell.colMaturityDate"), width: 110, minWidth: 84, hideable: true, filterKind: "dateRange", filterText: (entry) => entry.maturityDate ?? "", sortValue: (entry) => entry.maturityDate ?? "", render: (entry) => <span className="tabular-nums text-slate-600">{entry.maturityDate || "-"}</span> },
    { key: "cashAccount", label: t("depositShell.colCashAccount"), width: 150, minWidth: 100, hideable: true, filterText: (entry) => entry.cashAccountLabel, filterSearchText: (entry) => entry.cashAccountLabel, sortValue: (entry) => entry.cashAccountLabel, render: (entry) => <span className="truncate text-slate-600" title={entry.cashAccountLabel}>{entry.cashAccountLabel || "-"}</span> },
    { key: "note", label: t("detail.column.remark"), width: 240, minWidth: 120, hideable: true, filterText: (entry) => entry.note, filterSearchText: (entry) => entry.note, sortValue: (entry) => entry.note, render: (entry) => <span className="block truncate text-slate-600" title={entry.note}>{entry.note || "-"}</span> },
    {
      key: "amount",
      label: t("depositShell.colAmount"),
      width: 120,
      minWidth: 86,
      align: "right",
      filterKind: "numberRange",
      filterText: (entry) => String(entry.amount),
      filterNumber: (entry) => Math.abs(entry.amount),
      sortValue: (entry) => entry.amount,
      render: (entry) => (
        <span className={`inline-flex items-center justify-end gap-1 font-semibold tabular-nums ${amountClass(entry.amount)}`}>
          {entry.amount >= 0 ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
          {formatMoney(entry.amount)}
        </span>
      ),
    },
  ], [t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent p-4 md:p-5">
      <ResizableVerticalSplit
        storageKey="mmh:deposit:split-height"
        hasLowerPane={!!selectedLot}
        defaultUpperHeight={360}
        separatorLabel={t("depositShell.resizeLabel")}
        separatorTitle={t("depositShell.resizeTitle")}
      >
        <section className="panel-surface flex min-h-0 flex-col overflow-hidden">
          <div className="panel-header">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <Landmark className="h-4 w-4 text-cyan-600" />
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => switchLotTab("held")}
                  className={`h-6 rounded px-2 text-xs font-medium ${lotTab === "held" ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:text-slate-700"}`}
                >
                  {t("depositShell.holdingsTitle")}
                </button>
                <button
                  type="button"
                  onClick={() => switchLotTab("expired")}
                  className={`h-6 rounded px-2 text-xs font-medium ${lotTab === "expired" ? "bg-blue-50 text-blue-700" : "text-slate-500 hover:text-slate-700"}`}
                >
                  {t("depositShell.expiredTitle")}
                </button>
              </div>
            </div>
            <div className="text-xs text-slate-400">
              {selectedLot
                ? formatText("depositShell.lotSelectedHint", { name: selectedLot.fundName })
                : lotTab === "held"
                  ? formatText("depositShell.allHoldingsHint", { scope: institutionName || accountLabel })
                  : formatText("depositShell.allExpiredHint", { scope: institutionName || accountLabel })}
            </div>
          </div>
          <AdvancedDataTable
            storageKey="mmh_deposit_lots_table_v1"
            columns={lotColumns}
            rows={visibleLots}
            rowKey={(lot) => lot.id}
            minTableWidth={820}
            emptyText={lotTab === "held" ? t("depositShell.emptyHoldings") : t("depositShell.emptyExpired")}
            showFilters
            fillHeight
            toolbarMode="none"
            defaultSort={{ key: "originalAmount", direction: "desc" }}
            summaryRow={lotsSummaryRow}
            onRowClick={(lot) => setSelectedLotId((current) => current === lot.id ? null : lot.id)}
            rowClassName={(lot) => `cursor-pointer ${selectedLotId === lot.id ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-slate-50"}`}
          />
        </section>

        <section className="panel-surface flex min-h-0 flex-col overflow-hidden">
          <div className="panel-header">
            <div className="flex min-w-0 items-center gap-1 text-left text-sm font-semibold text-slate-800">
              {selectedEntryIds.size > 0 ? (
                <div className="flex shrink-0 items-center gap-1">
                  <BatchReplacePopoverButton
                    fields={batchFields}
                    targetCount={selectedEntryIds.size}
                    targetLabel={t("stockPanel.selected")}
                    buttonTitle={t("common.edit")}
                    buttonClassName="h-6 w-6 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center [&_svg]:h-3.5 [&_svg]:w-3.5"
                    onApply={applyBatch}
                  />
                  <button
                    type="button"
                    onClick={batchDeleteEntries}
                    disabled={selectedEntryIds.size === 0}
                    className="flex h-6 w-6 items-center justify-center rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
                    title={t("depositShell.deleteButton")}
                    aria-label={t("depositShell.deleteButton")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  <span
                    className="h-6 rounded border border-blue-200 bg-blue-50 px-2 text-xs font-medium leading-6 tabular-nums text-blue-700"
                    title={t("fundShell.selectedTitle", { count: selectedEntryIds.size })}
                  >
                    {t("table.selectedCount", { count: selectedEntryIds.size })}
                  </span>
                  <span className="mx-1 h-4 w-px bg-slate-200" />
                </div>
              ) : null}
              <span className="flex h-6 shrink-0 items-center">{t("depositShell.entriesTitle")}</span>
            </div>
            <div className="text-xs text-slate-400">
              {selectedLot ? formatText("depositShell.entryCountHint", { count: visibleEntries.length }) : formatText("depositShell.allEntryCountHint", { count: visibleEntries.length })}
            </div>
          </div>
          <AdvancedDataTable
            storageKey="mmh_deposit_entries_table_v1"
            columns={entryColumns}
            rows={pagedEntries}
            rowKey={(entry) => entry.id}
            minTableWidth={1020}
            emptyText={selectedLot ? t("depositShell.emptyRelatedEntries") : t("depositShell.emptyAllEntries")}
            fillHeight
            toolbarMode="none"
            showColumnVisibilityButton={false}
            showFilters
            selectable
            selectOnRowClick
            selectAllScope="renderedRows"
            selectedKeys={selectedEntryIds}
            onSelectionChange={setSelectedEntryIds}
            rowActions={(entry) => {
              const hasBusinessLink = (entry.businessLinkCount ?? 0) > 0;
              const labels = entry.businessLinkLabels ?? [];
              const title = hasBusinessLink
                ? formatText("depositShell.linkedTitle", { labels: labels.join("、") || t("depositShell.businessRecord") })
                : t("depositShell.unlinkedTitle");
              return (
                <>
                  <BusinessLinkActionButton
                    active={hasBusinessLink}
                    title={title}
                    busy={linkingIds.has(entry.id)}
                    onClick={() => linkDepositCashFlow(entry)}
                  />
                  <EntryRowActions entryId={entry.id} edit={entry.edit} />
                </>
              );
            }}
            rowActionsWidth={112}
            rowActionsMinWidth={92}
            pagination={{
              page: safePage,
              pageSize: entryPageSize,
              onPageChange: setEntryPage,
              onRowCountChange: setEntryRowCount,
            }}
          />
        </section>
      </ResizableVerticalSplit>
    </div>
  );
}
