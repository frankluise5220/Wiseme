"use client";

import { Boxes, Paperclip, Pencil, RefreshCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { FixedAssetEditModal, type FixedAssetEditMeta, type FixedAssetEditValue } from "@/components/FixedAssetEditModal";
import { ResizableVerticalSplit } from "@/components/ResizableVerticalSplit";
import { EntryAttachmentWindow } from "@/components/EntryAttachmentWindow";
import { EntryRowActions } from "@/components/EntryRowActions";
import { DetailTablePaginationControls } from "@/components/DetailTablePaginationControls";
import {
  BasicDetailBatchDeleteButton,
  BasicDetailBatchDeleteMessage,
  BasicDetailBatchReplaceButton,
  BasicDetailSelectionProvider,
  type BasicDetailBatchCategoryOption,
  useBasicDetailSelection,
  usePruneBasicDetailSelection,
} from "@/components/BasicDetailSelection";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { formatDateDisplay } from "@/lib/date-utils";
import { formatCurrencyMoney, formatPercent } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { useI18n } from "@/lib/i18n";
import { normalizeFixedAssetType } from "@/lib/fixed-asset";
import { formatAccountTableLabel, formatAccountTableTitle, type AccountTableDisplaySource } from "@/lib/account-display";
import { systemCategoryLabel } from "@/lib/system-category-labels";
import { getAccountLabelFieldsPreference } from "@/lib/client/appPreferences";

type PropertyPosition = {
  fundCode: string;
  accountId?: string | null;
  propertyAssetId?: string | null;
  mortgageLoanAccountId?: string | null;
  assetType?: string | null;
  propertyType?: string | null;
  address?: string | null;
  attributes?: Record<string, unknown> | null;
  status?: string | null;
  purchasePrice?: number | null;
  note?: string | null;
  name: string;
  holdingDate: string;
  cost: number;
  marketValue: number;
  navDate: string;
  floatingPnL: number;
  floatingPnLRate: number;
};

type FixedAssetTransaction = {
  id: string;
  cashEntryId?: string | null;
  accountId?: string | null;
  toAccountId?: string | null;
  date: string;
  amount?: number | null;
  accountName?: string | null;
  cashAccountId?: string | null;
  toAccountName?: string | null;
  propertyAssetId?: string | null;
  assetType?: string | null;
  type?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  postedAt?: string | null;
  currency?: string | null;
  counterpartyInstitutionId?: string | null;
  counterpartyInstitutionName?: string | null;
  entryTags?: Array<{ tagId: string; Tag?: { name?: string | null; color?: string | null } | null }>;
  propertyAction?: string | null;
  propertySettlementDate?: string | null;
  settlementDate?: string | null;
  propertyTax?: number | null;
  tax?: number | null;
  fundFee?: number | null;
  fee?: number | null;
  realizedProfit?: number | null;
  note?: string | null;
  attachments?: Array<{ id: string; name: string; mimeType?: string | null; url?: string | null }>;
};

type Props = {
  accountId: string;
  currency: string;
  baseCurrency: string;
  positions: PropertyPosition[];
  entries: FixedAssetTransaction[];
  totalMarketValue: number;
  totalCost: number;
  isRedUp: boolean;
  assetType?: string | null;
  accountOptions?: Array<AccountTableDisplaySource & { id: string }>;
  categoryOptions?: BasicDetailBatchCategoryOption[];
  tagOptions?: BasicDetailBatchCategoryOption[];
};

function rate(value: number) {
  return formatPercent(value);
}

function transactionTypeLabel(t: (key: string) => string, entry: FixedAssetTransaction) {
  if (entry.type === "income" || entry.type === "expense") {
    return t(entry.type === "income" ? "transaction.type.income" : "transaction.type.expense");
  }
  const amount = Number(entry.amount ?? 0);
  if (amount > 0) return t("transaction.type.income");
  if (amount < 0) return t("transaction.type.expense");
  return "-";
}

function transactionCategoryLabel(t: (key: string) => string, categoryName: string | null | undefined) {
  return systemCategoryLabel(categoryName, t) || t("txForm.uncategorized");
}

function assetTypeLabel(t: (key: string) => string, assetType: string | null | undefined) {
  const type = assetType || "property";
  return t(`fixedAsset.type.${type}`);
}

function propertyStatusText(t: (key: string) => string, status: string | null | undefined) {
  if (status === "mortgaged") return t("fixedAssetEdit.status.mortgaged");
  if (status === "sold") return t("fixedAssetEdit.status.sold");
  if (status === "disposed") return t("fixedAssetEdit.status.disposed");
  return t("fixedAssetEdit.status.normal");
}

function assetDetailText(position: PropertyPosition) {
  const type = position.assetType || "property";
  const attrs = position.attributes ?? {};
  if (type === "property") {
    const parts = [position.address, position.propertyType].filter((v) => v && String(v).trim());
    return parts.join(" · ") || "-";
  }
  if (type === "vehicle") {
    const parts = [attrs.plateNo, attrs.brandModel].filter((v) => v != null && String(v).trim());
    return parts.join(" · ") || "-";
  }
  if (type === "equipment" || type === "furniture") {
    const parts = [attrs.brand, attrs.model].filter((v) => v != null && String(v).trim());
    return parts.join(" · ") || "-";
  }
  if (type === "collectible") {
    const parts = [attrs.category, attrs.origin].filter((v) => v != null && String(v).trim());
    return parts.join(" · ") || "-";
  }
  return "-";
}

function attrText(attrs: Record<string, unknown> | null | undefined, key: string) {
  const value = attrs?.[key];
  return value != null && String(value).trim() ? String(value).trim() : "-";
}

// Data columns that are specific to each fixed-asset subtype. The first entry is
// the sortable/filterable "detail" column, followed by any extra typed columns.
type TypedDetailColumns = Array<{
  key: string;
  labelKey: string;
  text: (position: PropertyPosition) => string;
}>;

function typedDetailColumnsFor(assetType: string | null | undefined): TypedDetailColumns {
  switch (assetType || "") {
    case "property":
      return [
        { key: "address", labelKey: "propertyForm.address", text: (p) => p.address && String(p.address).trim() ? String(p.address) : "-" },
        { key: "propertyType", labelKey: "propertyForm.propertyType", text: (p) => p.propertyType && String(p.propertyType).trim() ? String(p.propertyType) : "-" },
      ];
    case "vehicle":
      return [
        { key: "plateNo", labelKey: "fixedAssetEdit.attr.plateNo", text: (p) => attrText(p.attributes as Record<string, unknown>, "plateNo") },
        { key: "brandModel", labelKey: "fixedAssetEdit.attr.brandModel", text: (p) => attrText(p.attributes as Record<string, unknown>, "brandModel") },
      ];
    case "equipment":
    case "furniture":
      return [
        { key: "brand", labelKey: "fixedAssetEdit.attr.brand", text: (p) => attrText(p.attributes as Record<string, unknown>, "brand") },
        { key: "model", labelKey: "fixedAssetEdit.attr.model", text: (p) => attrText(p.attributes as Record<string, unknown>, "model") },
      ];
    case "collectible":
      return [
        { key: "category", labelKey: "fixedAssetEdit.attr.category", text: (p) => attrText(p.attributes as Record<string, unknown>, "category") },
        { key: "origin", labelKey: "fixedAssetEdit.attr.origin", text: (p) => attrText(p.attributes as Record<string, unknown>, "origin") },
      ];
    default:
      return [{ key: "assetDetail", labelKey: "propertyShell.column.detail", text: (p) => assetDetailText(p) }];
  }
}

type FixedAssetTransactionTableProps = {
  accountId: string;
  selectedAssetId: string;
  selectedPosition: PropertyPosition;
  selectedEntries: FixedAssetTransaction[];
  transactionColumns: AdvancedDataTableColumn<FixedAssetTransaction>[];
  accountOptions: Array<AccountTableDisplaySource & { id: string }>;
  categoryOptions: BasicDetailBatchCategoryOption[];
  tagOptions: BasicDetailBatchCategoryOption[];
  transactionPage: number;
  transactionPageSize: number;
  transactionPageAll: boolean;
  transactionSafePage: number;
  transactionTotalPages: number;
  setTransactionPage: (page: number) => void;
  setTransactionPageSize: (pageSize: number) => void;
  setTransactionPageAll: (all: boolean) => void;
  setTransactionRowCount: (count: number) => void;
  onAttachmentView: (entryId: string) => void;
  buildPropertyEditEvent: (entry: FixedAssetTransaction) => { name: string; detail: Record<string, unknown> };
};

function FixedAssetTransactionTable({
  accountId,
  selectedAssetId,
  selectedPosition,
  selectedEntries,
  transactionColumns,
  accountOptions,
  categoryOptions,
  tagOptions,
  transactionPage,
  transactionPageSize,
  transactionPageAll,
  transactionSafePage,
  transactionTotalPages,
  setTransactionPage,
  setTransactionPageSize,
  setTransactionPageAll,
  setTransactionRowCount,
  onAttachmentView,
  buildPropertyEditEvent,
}: FixedAssetTransactionTableProps) {
  const { t } = useI18n();
  const { selectedIds, setSelection } = useBasicDetailSelection();
  const currentEntryIds = useMemo(() => selectedEntries.map((entry) => entry.id), [selectedEntries]);
  usePruneBasicDetailSelection(currentEntryIds);
  const normalizedAccountOptions = useMemo(
    () => accountOptions.map((account) => {
      const label = formatAccountTableLabel(account, account.name ?? "", getAccountLabelFieldsPreference());
      return {
        id: account.id,
        label: label || account.name?.trim() || account.id,
        title: formatAccountTableTitle(account, label, getAccountLabelFieldsPreference()),
      };
    }),
    [accountOptions],
  );
  const categoryTypes = useMemo(() => {
    const types = new Set<string>();
    for (const entry of selectedEntries) {
      if (entry.type === "income" || entry.type === "expense") {
        types.add(entry.type);
      } else {
        types.add(Number(entry.amount ?? 0) >= 0 ? "income" : "expense");
      }
    }
    return Array.from(types);
  }, [selectedEntries]);

  return (
    <AdvancedDataTable
      storageKey="mmh_fixed_asset_transaction_details_v1"
      resetKey={`${accountId}:${selectedAssetId}`}
      columns={transactionColumns}
      rows={selectedEntries}
      rowKey={(entry) => entry.id}
      selectable
      selectOnRowClick
      selectAllScope="renderedRows"
      // Generic batch edit/delete APIs operate on TxRecord ids. Keep legacy
      // business-only property rows visible and editable by double-click, but
      // do not let them enter a batch operation that cannot address them.
      rowSelectable={(entry) => Boolean(entry.cashEntryId)}
      selectedKeys={selectedIds}
      onSelectionChange={setSelection}
      emptyText={t("propertyShell.emptyTransactions")}
      minTableWidth={980}
      fillHeight
      toolbarMode="default"
      toolbarTitle={(
        <div className="flex min-w-0 items-center gap-2">
          <span>{t("propertyShell.transactionDetails")}</span>
          <span className="truncate text-xs font-normal text-slate-500">{selectedPosition.name}</span>
          <span className="text-xs font-normal text-slate-400">{t("propertyShell.transactionCount", { count: selectedEntries.length })}</span>
        </div>
      )}
      toolbarRightContent={(
        <DetailTablePaginationControls
          pageSize={transactionPageSize}
          detailAll={transactionPageAll}
          safePage={transactionSafePage}
          totalPages={transactionTotalPages}
          canPrev={!transactionPageAll && transactionSafePage > 1}
          canNext={!transactionPageAll && transactionSafePage < transactionTotalPages}
          onPageSizeChange={(pageSize) => {
            setTransactionPageSize(pageSize);
            setTransactionPageAll(false);
            setTransactionPage(1);
          }}
          onShowAll={() => {
            setTransactionPageAll(true);
            setTransactionPage(1);
          }}
          onPageChange={(page) => {
            setTransactionPageAll(false);
            setTransactionPage(page);
          }}
        />
      )}
      batchActionSlot={(
        <>
          <BasicDetailBatchReplaceButton
            accountOptions={normalizedAccountOptions}
            categoryOptions={categoryOptions}
            tagOptions={tagOptions}
            categoryTypes={categoryTypes}
            targetLabel={t("propertyShell.transactionDetails")}
            contextAccountId={accountId}
          />
          <BasicDetailBatchDeleteButton />
        </>
      )}
      showFilters
      onRowDoubleClick={(entry) => {
        if (!entry.cashEntryId) return;
        const event = buildPropertyEditEvent(entry);
        window.dispatchEvent(new CustomEvent(event.name, { detail: event.detail }));
      }}
      rowActions={(entry) => (
        <>
          {entry.attachments && entry.attachments.length > 0 ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onAttachmentView(entry.id);
              }}
              title={entry.attachments.map((attachment) => attachment.name).join(", ") || t("attachments.title")}
              aria-label={t("attachments.title")}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-amber-200 bg-white text-amber-600 transition-colors hover:border-amber-300 hover:bg-amber-50"
            >
              <Paperclip className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {entry.cashEntryId ? <EntryRowActions entryId={entry.id} customEditEvent={buildPropertyEditEvent(entry)} /> : null}
        </>
      )}
      rowActionsWidth={112}
      rowActionsMinWidth={92}
      pagination={{
        page: transactionPage,
        pageSize: transactionPageSize,
        all: transactionPageAll,
        onPageChange: setTransactionPage,
        onRowCountChange: setTransactionRowCount,
      }}
      sortable
      defaultSort={{ key: "date", direction: "desc" }}
    />
  );
}

export function PropertyShell({
  accountId,
  currency,
  baseCurrency,
  positions,
  entries,
  totalMarketValue,
  totalCost,
  isRedUp,
  assetType,
  accountOptions = [],
  categoryOptions = [],
  tagOptions = [],
}: Props) {
  const { t } = useI18n();
  const displayCurrency = currency || baseCurrency || "CNY";
  const floatingPnL = totalMarketValue - totalCost;
  const floatingRate = totalCost > 0 ? floatingPnL / totalCost : 0;
  const pnlCls = useCallback((value: number) => pnlClassFromRedUp(value, isRedUp), [isRedUp]);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [editValue, setEditValue] = useState<FixedAssetEditValue | null>(null);
  const [editMeta, setEditMeta] = useState<FixedAssetEditMeta | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [attachmentViewEntryId, setAttachmentViewEntryId] = useState<string | null>(null);
  const [transactionPage, setTransactionPage] = useState(1);
  const [transactionPageSize, setTransactionPageSize] = useState(20);
  const [transactionPageAll, setTransactionPageAll] = useState(false);
  const [transactionRowCount, setTransactionRowCount] = useState(entries.length);
  const accountOptionById = useMemo(
    () => new Map((accountOptions ?? []).map((account) => [account.id, account])),
    [accountOptions],
  );

  const typedDetailColumns = useMemo(
    () => typedDetailColumnsFor(assetType),
    [assetType],
  );

  const selectedPosition = useMemo(
    () => positions.find((position) => (position.propertyAssetId ?? position.fundCode) === selectedAssetId) ?? null,
    [positions, selectedAssetId],
  );
  const selectedEntries = useMemo(
    () => selectedAssetId
      ? entries.filter((entry) => (entry.propertyAssetId ?? "") === selectedAssetId)
      : [],
    [entries, selectedAssetId],
  );

  useEffect(() => {
    setTransactionPage(1);
    setTransactionPageAll(false);
    setTransactionRowCount(selectedEntries.length);
  }, [selectedAssetId, selectedEntries.length]);

  const transactionTotalPages = Math.max(1, Math.ceil(transactionRowCount / transactionPageSize));
  const transactionSafePage = transactionPageAll
    ? 1
    : Math.min(Math.max(1, transactionPage), transactionTotalPages);

  function selectPosition(position: PropertyPosition) {
    const assetId = position.propertyAssetId ?? position.fundCode;
    setSelectedAssetId((current) => (current === assetId ? "" : assetId));
  }

  function buildPropertyEditEvent(entry: FixedAssetTransaction) {
    const amount = Number(entry.amount ?? 0);
    const isCashIn = entry.type ? entry.type === "income" : amount >= 0;
    const accountId = entry.accountId ?? "";
    const accountName = entry.accountName ?? "";
    return {
      name: "mmh:transaction:edit",
      detail: {
        requestId: "property-edit-" + Date.now(),
        entryId: entry.id,
        type: isCashIn ? "income" : "expense",
        date: entry.date?.slice(0, 10) ?? "",
        postedAt: entry.postedAt ?? entry.date ?? "",
        amount,
        note: entry.note ?? "",
        accountId,
        accountName,
        accountLabel: accountName,
        categoryId: entry.categoryId ?? "",
        categoryName: entry.categoryName ?? "",
        counterpartyInstitutionId: entry.counterpartyInstitutionId ?? "",
        tagIds: entry.entryTags?.map((tag) => tag.tagId) ?? [],
        tags: entry.entryTags?.map((tag) => ({
          id: tag.tagId,
          name: tag.Tag?.name ?? "",
          color: tag.Tag?.color ?? null,
        })) ?? [],
        hasFundDetail: false,
        fixedAssetLinked: !isCashIn,
        fixedAssetAccountId: isCashIn ? "" : (entry.toAccountId ?? ""),
        fixedAssetAssetId: isCashIn ? "" : (entry.propertyAssetId ?? ""),
      },
    };
  }

  function openFixedAssetEdit(position: PropertyPosition) {
    const assetId = position.propertyAssetId ?? position.fundCode;
    setEditValue({
      id: assetId,
      name: position.name,
      assetType: normalizeFixedAssetType(position.assetType),
      propertyType: position.propertyType ?? "",
      address: position.address ?? "",
      attributes: (position.attributes ?? {}) as Record<string, unknown>,
      purchaseDate: position.holdingDate || "",
      purchasePrice: position.purchasePrice != null ? String(position.purchasePrice) : "",
      note: position.note ?? "",
      status: position.status ?? "active",
    });
    setEditMeta({
      accountName: position.name,
      marketValue: position.marketValue,
      cost: position.cost,
    });
  }

  async function saveFixedAssetEdit(next: FixedAssetEditValue) {
    setSavingEdit(true);
    try {
      const response = await fetch("/api/v1/properties", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyAssetId: next.id,
          name: next.name.trim(),
          assetType: next.assetType,
          propertyType: next.propertyType.trim() || undefined,
          address: next.address.trim() || undefined,
          attributes: next.attributes ?? undefined,
          purchaseDate: next.purchaseDate.trim() || undefined,
          purchasePrice: next.purchasePrice.trim() || undefined,
          note: next.note.trim() || undefined,
          status: next.status || "active",
        }),
      });
      const data = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || t("fixedAssetEdit.saveFailed"));
      }
      setEditValue(null);
      setEditMeta(null);
      dispatchFinanceDataChanged({ reason: "fixed-asset-save", accountIds: [accountId] });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("fixedAssetEdit.saveFailed"));
    } finally {
      setSavingEdit(false);
    }
  }

  const positionColumns = useMemo<AdvancedDataTableColumn<PropertyPosition>[]>(() => [
    {
      key: "asset",
      label: t("settings.accounts.name"),
      width: 240,
      minWidth: 160,
      headerClassName: "text-left",
      className: "px-4",
      sortValue: (position) => position.name,
      filterText: (position) => position.name,
      render: (position) => {
        const assetId = position.propertyAssetId ?? position.fundCode;
        const selected = assetId === selectedAssetId;
        return (
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
              <Boxes className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <div className={`truncate font-medium ${selected ? "text-blue-700" : "text-slate-700"}`} title={position.name}>
                {position.name}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      key: "status",
      label: t("propertyShell.column.status"),
      width: 92,
      minWidth: 72,
      sortValue: (position) => propertyStatusText(t, position.status),
      filterText: (position) => propertyStatusText(t, position.status),
      render: (position) => {
        const text = propertyStatusText(t, position.status);
        if (position.status === "mortgaged") {
          return <span className="inline-flex items-center rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">{text}</span>;
        }
        if (position.status === "sold" || position.status === "disposed") {
          return <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">{text}</span>;
        }
        return <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{text}</span>;
      },
    },
    ...(assetType
      ? []
      : [{
          key: "assetType",
          label: t("fixedAssetEdit.assetType"),
          width: 96,
          minWidth: 80,
          sortValue: (position) => assetTypeLabel(t, position.assetType),
          filterText: (position) => assetTypeLabel(t, position.assetType),
          render: (position) => <span className="text-slate-600">{assetTypeLabel(t, position.assetType)}</span>,
        }]),
    ...typedDetailColumns.map((column): AdvancedDataTableColumn<PropertyPosition> => ({
      key: column.key,
      label: t(column.labelKey),
      width: 160,
      minWidth: 120,
      sortValue: (position) => column.text(position),
      filterText: (position) => column.text(position),
      truncate: true,
      cellTitle: (position) => column.text(position),
      render: (position) => <span className="text-slate-600">{column.text(position)}</span>,
    })),
    {
      key: "holdingDate",
      label: t("propertyShell.column.purchaseDate"),
      width: 112,
      minWidth: 88,
      className: "tabular-nums text-slate-600",
      sortValue: (position) => position.holdingDate,
      filterKind: "dateRange",
      filterText: (position) => position.holdingDate,
      render: (position) => position.holdingDate || "-",
    },
    {
      key: "cost",
      label: t("propertyShell.column.cost"),
      width: 124,
      minWidth: 92,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (position) => String(position.cost),
      filterNumber: (position) => position.cost,
      sortValue: (position) => position.cost,
      render: (position) => formatCurrencyMoney(position.cost, displayCurrency),
    },
    {
      key: "marketValue",
      label: t("propertyShell.column.marketValue"),
      width: 124,
      minWidth: 92,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (position) => String(position.marketValue),
      filterNumber: (position) => position.marketValue,
      sortValue: (position) => position.marketValue,
      render: (position) => <span className={pnlCls(position.marketValue)}>{formatCurrencyMoney(position.marketValue, displayCurrency)}</span>,
    },
    {
      key: "valuationDate",
      label: t("propertyShell.column.valuationDate"),
      width: 112,
      minWidth: 88,
      className: "tabular-nums text-slate-600",
      sortValue: (position) => position.navDate,
      filterKind: "dateRange",
      filterText: (position) => position.navDate,
      render: (position) => position.navDate || "-",
    },
    {
      key: "floatingPnL",
      label: t("propertyShell.floatingPnL"),
      width: 124,
      minWidth: 92,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (position) => String(position.floatingPnL),
      filterNumber: (position) => position.floatingPnL,
      sortValue: (position) => position.floatingPnL,
      render: (position) => <span className={pnlCls(position.floatingPnL)}>{formatCurrencyMoney(position.floatingPnL, displayCurrency)}</span>,
    },
    {
      key: "floatingRate",
      label: t("stockHoldingReport.colFloatingPnLRate"),
      width: 96,
      minWidth: 76,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (position) => String(position.floatingPnLRate),
      filterNumber: (position) => position.floatingPnLRate,
      sortValue: (position) => position.floatingPnLRate,
      render: (position) => <span className={pnlCls(position.floatingPnLRate)}>{rate(position.floatingPnLRate)}</span>,
    },
    {
      key: "actions",
      label: t("detail.column.actions"),
      width: 76,
      minWidth: 64,
      align: "right",
      render: (position) => {
        const assetId = position.propertyAssetId ?? position.fundCode;
        return (
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                openFixedAssetEdit(position);
              }}
              title={t("fixedAssetEdit.editButton")}
              aria-label={t("fixedAssetEdit.editButton")}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-700 transition-colors hover:bg-slate-50 hover:text-blue-600"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                window.dispatchEvent(new CustomEvent("mmh:property:valuation", {
                  detail: {
                    defaultPropertyAccountId: position.accountId ?? accountId,
                    propertyAssetId: assetId,
                    propertyName: position.name,
                    currentMarketValue: position.marketValue,
                  },
                }));
              }}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-700 transition-colors hover:bg-slate-50 hover:text-blue-600"
              title={t("propertyShell.updateValuation")}
              aria-label={t("propertyShell.updateValuation")}
            >
              <RefreshCcw className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      },
    },
  ], [accountId, displayCurrency, pnlCls, selectedAssetId, t, typedDetailColumns, assetType]);

  const positionSummaryRow = useMemo(() => {
    if (positions.length === 0) return undefined;
    return {
      cells: {
        asset: t("debtShell.summaryRow"),
        cost: <span className="tabular-nums text-slate-800">{formatCurrencyMoney(totalCost, displayCurrency)}</span>,
        marketValue: <span className={`tabular-nums ${pnlCls(totalMarketValue)}`}>{formatCurrencyMoney(totalMarketValue, displayCurrency)}</span>,
        floatingPnL: <span className={`tabular-nums ${pnlCls(floatingPnL)}`}>{formatCurrencyMoney(floatingPnL, displayCurrency)}</span>,
        floatingRate: <span className={`tabular-nums ${pnlCls(floatingRate)}`}>{rate(floatingRate)}</span>,
      },
    };
  }, [displayCurrency, floatingPnL, floatingRate, pnlCls, positions.length, t, totalCost, totalMarketValue]);

  const transactionColumns = useMemo<AdvancedDataTableColumn<FixedAssetTransaction>[]>(() => {
    const accountDisplay = (id: string | null | undefined, fallback: string | null | undefined) => {
      const source = id ? accountOptionById.get(id) : undefined;
      const label = source ? formatAccountTableLabel(source, fallback ?? "", getAccountLabelFieldsPreference()) : (fallback ?? "").trim();
      return { label: label || "-", title: source ? formatAccountTableTitle(source, label, getAccountLabelFieldsPreference()) : label };
    };
    const currencyFor = (entry: FixedAssetTransaction) => entry.currency || displayCurrency;
    const flowAmount = (entry: FixedAssetTransaction) => Number(entry.amount ?? 0);
    const renderAmount = (value: number | null, currency: string, className: string) => (
      <span className={`whitespace-nowrap text-xs tabular-nums ${className}`}>{value == null ? "" : formatCurrencyMoney(value, currency)}</span>
    );
    return [
      {
        key: "date",
        label: t("detail.column.date"),
        width: 96,
        minWidth: 78,
        filterKind: "dateRange",
        filterText: (entry) => entry.date,
        sortValue: (entry) => entry.date,
        render: (entry) => <span className="whitespace-nowrap tabular-nums text-slate-600">{formatDateDisplay(entry.date)}</span>,
      },
      {
        key: "postedAt",
        label: t("detail.column.postedAt"),
        width: 132,
        minWidth: 110,
        hideable: true,
        filterKind: "dateRange",
        filterText: (entry) => (entry.postedAt ?? "").slice(0, 10),
        render: (entry) => <span className="whitespace-nowrap tabular-nums text-slate-500">{entry.postedAt ? formatDateDisplay(entry.postedAt) : ""}</span>,
      },
      {
        key: "account",
        label: t("detail.column.account"),
        width: 190,
        minWidth: 110,
        filterText: (entry) => accountDisplay(entry.accountId, entry.accountName).label,
        filterTitle: (entry) => accountDisplay(entry.accountId, entry.accountName).title,
        filterSearchText: (entry) => {
          const display = accountDisplay(entry.accountId, entry.accountName);
          return [display.label, display.title, entry.accountName].filter(Boolean).join(" ");
        },
        truncate: true,
        cellTitle: (entry) => accountDisplay(entry.accountId, entry.accountName).title,
        render: (entry) => {
          const display = accountDisplay(entry.accountId, entry.accountName);
          return <span className="block truncate text-slate-600" title={display.title}>{display.label}</span>;
        },
      },
      {
        key: "inflow",
        label: t("detail.column.inflow"),
        width: 96,
        minWidth: 76,
        align: "right",
        filterKind: "numberRange",
        filterText: (entry) => flowAmount(entry) > 0 ? String(flowAmount(entry)) : "",
        filterNumber: (entry) => flowAmount(entry) > 0 ? flowAmount(entry) : null,
        sortValue: (entry) => flowAmount(entry) > 0 ? flowAmount(entry) : null,
        render: (entry) => {
          const amount = flowAmount(entry);
          return renderAmount(amount > 0 ? amount : null, currencyFor(entry), amount > 0 ? pnlCls(1) : "text-slate-700");
        },
      },
      {
        key: "outflow",
        label: t("detail.column.outflow"),
        width: 96,
        minWidth: 76,
        align: "right",
        filterKind: "numberRange",
        filterText: (entry) => flowAmount(entry) < 0 ? String(-flowAmount(entry)) : "",
        filterNumber: (entry) => flowAmount(entry) < 0 ? -flowAmount(entry) : null,
        sortValue: (entry) => flowAmount(entry) < 0 ? -flowAmount(entry) : null,
        render: (entry) => {
          const amount = flowAmount(entry);
          return renderAmount(amount < 0 ? -amount : null, currencyFor(entry), amount < 0 ? pnlCls(-1) : "text-slate-700");
        },
      },
      {
        key: "currency",
        label: t("detail.column.currency"),
        width: 68,
        minWidth: 54,
        hideable: true,
        filterText: (entry) => currencyFor(entry),
        render: (entry) => <span className="block truncate text-center font-medium tabular-nums text-slate-500">{currencyFor(entry)}</span>,
      },
      {
        key: "type",
        label: t("detail.column.activityType"),
        width: 96,
        minWidth: 80,
        filterText: (entry) => transactionTypeLabel(t, entry),
        sortValue: (entry) => transactionTypeLabel(t, entry),
        render: (entry) => <span className="text-slate-700">{transactionTypeLabel(t, entry)}</span>,
      },
      {
        key: "category",
        label: t("detail.column.category"),
        width: 160,
        minWidth: 100,
        filterText: (entry) => transactionCategoryLabel(t, entry.categoryName),
        sortValue: (entry) => transactionCategoryLabel(t, entry.categoryName),
        truncate: true,
        cellTitle: (entry) => transactionCategoryLabel(t, entry.categoryName),
        render: (entry) => <span className="block truncate text-slate-500" title={transactionCategoryLabel(t, entry.categoryName)}>{transactionCategoryLabel(t, entry.categoryName)}</span>,
      },
      {
        key: "counterpartyInstitution",
        label: t("detail.column.counterparty"),
        width: 140,
        minWidth: 96,
        hideable: true,
        defaultHidden: true,
        filterText: (entry) => entry.counterpartyInstitutionName ?? "",
        render: (entry) => <span className="block truncate text-slate-500" title={entry.counterpartyInstitutionName ?? ""}>{entry.counterpartyInstitutionName || <span className="text-slate-300">-</span>}</span>,
      },
      {
        key: "related",
        label: t("detail.column.relatedAccount"),
        width: 190,
        minWidth: 110,
        hideable: true,
        filterText: (entry) => accountDisplay(entry.toAccountId, entry.toAccountName).label,
        filterTitle: (entry) => accountDisplay(entry.toAccountId, entry.toAccountName).title,
        filterSearchText: (entry) => {
          const display = accountDisplay(entry.toAccountId, entry.toAccountName);
          return [display.label, display.title, entry.toAccountName].filter(Boolean).join(" ");
        },
        truncate: true,
        cellTitle: (entry) => accountDisplay(entry.toAccountId, entry.toAccountName).title,
        render: (entry) => {
          const display = accountDisplay(entry.toAccountId, entry.toAccountName);
          return <span className="block truncate text-slate-500" title={display.title}>{display.label}</span>;
        },
      },
      {
        key: "tags",
        label: t("detail.column.tags"),
        width: 150,
        minWidth: 90,
        hideable: true,
        filterText: (entry) => entry.entryTags?.map((tag) => tag.Tag?.name ?? "").join(" ") ?? "",
        render: (entry) => entry.entryTags && entry.entryTags.length > 0 ? (
          <span className="inline-flex flex-wrap gap-0.5">
            {entry.entryTags.map((tag) => {
              const color = tag.Tag?.color || "#3B82F6";
              return <span key={tag.tagId} className="rounded-full border px-1 py-0.5 text-[10px] leading-none" style={{ backgroundColor: color + "18", color, borderColor: color + "60" }}>{tag.Tag?.name}</span>;
            })}
          </span>
        ) : null,
      },
      {
        key: "remark",
        label: t("detail.column.remark"),
        width: 220,
        minWidth: 120,
        hideable: true,
        filterText: (entry) => entry.note ?? "",
        render: (entry) => <span className="block truncate text-slate-500" title={entry.note ?? ""}>{entry.note || ""}</span>,
      },
    ];
  }, [accountOptionById, displayCurrency, pnlCls, t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent p-4 md:p-5">
      <ResizableVerticalSplit
        storageKey={`mmh:fixed-asset-shell:${accountId || "all"}:split-height`}
        hasLowerPane={Boolean(selectedPosition)}
        defaultUpperHeight={360}
        separatorLabel={t("propertyShell.resizeLabel")}
        separatorTitle={t("propertyShell.resizeTitle")}
        stackOnMobile
      >
        <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
          <div className="flex shrink-0 justify-end border-b border-slate-200 px-4 py-3">
            <div className="grid grid-cols-3 gap-6 text-right text-xs">
              <div>
                <div className="text-slate-500">{t("propertyShell.marketValue")}</div>
                <div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">
                  {formatCurrencyMoney(totalMarketValue, displayCurrency)}
                </div>
              </div>
              <div>
                <div className="text-slate-500">{t("propertyShell.totalCost")}</div>
                <div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">
                  {formatCurrencyMoney(totalCost, displayCurrency)}
                </div>
              </div>
              <div>
                <div className="text-slate-500">{t("propertyShell.floatingPnL")}</div>
                <div className={`mt-1 text-sm font-semibold tabular-nums ${pnlCls(floatingPnL)}`}>
                  {formatCurrencyMoney(floatingPnL, displayCurrency)} · {rate(floatingRate)}
                </div>
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <AdvancedDataTable
              storageKey="mmh_fixed_asset_positions_advanced_v1"
              columns={positionColumns}
              rows={positions}
              rowKey={(position, index) => position.propertyAssetId ?? position.fundCode ?? String(index)}
              emptyText={t("propertyShell.emptyTitle")}
              minTableWidth={1332}
              rowClassName={(position) => {
                const assetId = position.propertyAssetId ?? position.fundCode;
                const selected = assetId === selectedAssetId;
                return `cursor-pointer ${selected ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-blue-50/40"}`;
              }}
              onRowClick={selectPosition}
              onRowDoubleClick={openFixedAssetEdit}
              showFilters={false}
              fillHeight
              toolbarMode="none"
              draggableRows={false}
              sortable
              defaultSort={{ key: "marketValue", direction: "desc" }}
              summaryRow={positionSummaryRow}
            />
          </div>
        </div>

        {selectedPosition ? (
          <BasicDetailSelectionProvider resetKey={`${accountId}:${selectedAssetId}`}>
            <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
              <BasicDetailBatchDeleteMessage />
              <div className="min-h-0 flex-1">
                <FixedAssetTransactionTable
                  accountId={accountId}
                  selectedAssetId={selectedAssetId}
                  selectedPosition={selectedPosition}
                  selectedEntries={selectedEntries}
                  transactionColumns={transactionColumns}
                  accountOptions={accountOptions}
                  categoryOptions={categoryOptions}
                  tagOptions={tagOptions}
                  transactionPage={transactionPage}
                  transactionPageSize={transactionPageSize}
                  transactionPageAll={transactionPageAll}
                  transactionSafePage={transactionSafePage}
                  transactionTotalPages={transactionTotalPages}
                  setTransactionPage={setTransactionPage}
                  setTransactionPageSize={setTransactionPageSize}
                  setTransactionPageAll={setTransactionPageAll}
                  setTransactionRowCount={setTransactionRowCount}
                  onAttachmentView={setAttachmentViewEntryId}
                  buildPropertyEditEvent={buildPropertyEditEvent}
                />
              </div>
            </div>
          </BasicDetailSelectionProvider>
        ) : null}
      </ResizableVerticalSplit>

      <FixedAssetEditModal
        open={!!editValue}
        saving={savingEdit}
        value={editValue}
        meta={editMeta}
        onClose={() => {
          if (savingEdit) return;
          setEditValue(null);
          setEditMeta(null);
        }}
        onChange={setEditValue}
        onSaved={saveFixedAssetEdit}
      />

      <EntryAttachmentWindow
        open={attachmentViewEntryId != null}
        entryId={attachmentViewEntryId}
        onClose={() => setAttachmentViewEntryId(null)}
      />
    </div>
  );
}
