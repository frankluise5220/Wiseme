"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Pencil, RefreshCcw, SlidersHorizontal, Trash2 } from "lucide-react";

import { formatCurrencyMoney, formatMoney, formatPercent } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { showBlockingLoading } from "@/lib/client/blocking-loading";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";
import { ResizableVerticalSplit } from "@/components/ResizableVerticalSplit";
import { StockFeeRuleSettingsButton } from "@/components/StockFeeRuleSettingsButton";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig } from "@/components/BatchReplacePopoverButton";
import { BusinessLinkActionButton } from "@/components/BusinessLinkActionButton";
import { ViewExcelImportMenuButton, exportRowsToXlsx } from "@/components/ViewExcelImportMenuButton";

type StockPosition = {
  stockCode: string;
  market?: string | null;
  securityId?: string | null;
  name: string;
  units: number;
  avgCost: number;
  cost: number;
  nav: number | null;
  navDate?: string | null;
  /** Last date the position was fully sold (cleared). Supplied only by stock holdings responses that compute it. */
  clearedDate?: string | null;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
  historicalProfit?: number;
};

const STOCK_DETAIL_COLUMN_SETTINGS_EVENT = "mmh:stock-detail:column-settings";
const STOCK_POSITION_EPSILON = 0.000001;

type StockTransaction = {
  id: string;
  linkId?: string | null;
  linkIds?: string[] | null;
  cashEntryId?: string | null;
  stockAccountId?: string;
  stockAccountName?: string | null;
  cashAccountId?: string | null;
  cashAccountName?: string | null;
  securityId?: string | null;
  market?: string | null;
  stockCode: string;
  stockName?: string | null;
  tradeDate: string;
  settleDate?: string | null;
  action: string;
  quantity?: number | null;
  price?: number | null;
  grossAmount?: number | null;
  netAmount?: number | null;
  fee?: number | null;
  commission?: number | null;
  stampTax?: number | null;
  transferFee?: number | null;
  exchangeFee?: number | null;
  regulatoryFee?: number | null;
  otherFee?: number | null;
  realizedProfit?: number | null;
  note?: string | null;
};

type RefreshPriceHolding = {
  securityId?: string | null;
  market: string;
  stockCode: string;
  stockName?: string | null;
  quantity: number;
  avgCost: number;
  cost: number;
  latestPrice?: number | null;
  latestPriceDate?: string | null;
  clearedDate?: string | null;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
  historicalProfit?: number;
};

type RefreshPriceResponse = {
  ok?: boolean;
  error?: string;
  data?: {
    refreshed?: number;
    failed?: Array<{ stockCode?: string; error?: string }>;
    holdings?: RefreshPriceHolding[];
    totalMarketValue?: number;
    totalCost?: number;
  };
};

type StockTransactionsResponse = {
  ok?: boolean;
  error?: string;
  data?: { transactions?: StockTransaction[] };
};

type StockHoldingsResponse = {
  ok?: boolean;
  error?: string;
  data?: {
    holdings?: RefreshPriceHolding[];
    totalMarketValue?: number;
    totalCost?: number;
  };
};

function pnlClass(value: number, isRedUp: boolean) {
  return pnlClassFromRedUp(value, isRedUp, "soft");
}

function positionKey(position: StockPosition) {
  return position.securityId || `${position.market ?? ""}:${position.stockCode}`;
}

function compactNavDate(value: string | null | undefined) {
  const date = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date.slice(5, 7)}.${date.slice(8, 10)}` : String(value ?? "");
}

const ACTION_LABEL_KEYS: Record<string, string> = {
  buy: "stockPanel.action.buy",
  sell: "stockPanel.action.sell",
  dividend: "stockPanel.action.dividend",
  bonus_share: "stockPanel.action.bonus_share",
  split_share: "stockPanel.action.split_share",
  merge_share: "stockPanel.action.merge_share",
  fee_adjustment: "stockPanel.action.fee_adjustment",
  tax_adjustment: "stockPanel.action.tax_adjustment",
};

function actionLabel(t: (key: string) => string, action: string) {
  const key = ACTION_LABEL_KEYS[action];
  return key ? t(key) : action || "-";
}

function renderStockNameCode(name: string | null | undefined, stockCode: string | null | undefined, active = false) {
  const displayName = String(name || stockCode || "-").trim() || "-";
  const code = String(stockCode ?? "").trim();
  return (
    <div className="flex min-w-0 items-center gap-1.5" title={[displayName, code].filter(Boolean).join(" ")}>
      <span className={`min-w-0 truncate font-medium ${active ? "text-blue-700" : "text-slate-700"}`}>
        {displayName}
      </span>
      {code ? (
        <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] leading-none text-slate-500">
          {code}
        </span>
      ) : null}
    </div>
  );
}

function totalFee(tx: StockTransaction) {
  return (
    Number(tx.fee ?? 0) +
    Number(tx.commission ?? 0) +
    Number(tx.stampTax ?? 0) +
    Number(tx.transferFee ?? 0) +
    Number(tx.exchangeFee ?? 0) +
    Number(tx.regulatoryFee ?? 0) +
    Number(tx.otherFee ?? 0)
  );
}

function cashAmount(tx: StockTransaction) {
  const gross = Math.abs(Number(tx.grossAmount ?? 0));
  const net = tx.netAmount == null ? null : Math.abs(Number(tx.netAmount));
  const fees = totalFee(tx);
  if (tx.action === "buy") return -(gross + fees);
  if (tx.action === "sell" || tx.action === "dividend") return net ?? Math.max(0, gross - fees);
  if (tx.action === "fee_adjustment" || tx.action === "tax_adjustment") return -(net ?? gross);
  return 0;
}

function mapApiHolding(item: RefreshPriceHolding): StockPosition {
  return {
    stockCode: item.stockCode,
    market: item.market,
    securityId: item.securityId ?? undefined,
    name: item.stockName || item.stockCode,
    units: Number(item.quantity ?? 0),
    avgCost: Number(item.avgCost ?? 0),
    cost: Number(item.cost ?? 0),
    nav: item.latestPrice == null ? null : Number(item.latestPrice),
    navDate: item.latestPriceDate ?? null,
    clearedDate: item.clearedDate ?? null,
    marketValue: Number(item.marketValue ?? 0),
    floatingPnL: Number(item.floatingPnL ?? 0),
    floatingPnLRate: Number(item.floatingPnLRate ?? 0),
    historicalProfit: Number(item.historicalProfit ?? 0),
  };
}

export function StockHoldingsPanel({
  accountId,
  accountLabel,
  currency,
  positions: initialPositions,
  clearedPositions: initialClearedPositions = [],
  initialShowCleared = false,
  cashBalance,
  totalMarketValue,
  totalCost,
  isRedUp,
  stockCashAccountId,
  stockCashAccountName,
}: {
  accountId: string;
  accountLabel: string;
  currency: string;
  positions: StockPosition[];
  clearedPositions?: StockPosition[];
  initialShowCleared?: boolean;
  cashBalance: number;
  totalMarketValue: number;
  totalCost: number;
  isRedUp: boolean;
  stockCashAccountId?: string;
  stockCashAccountName?: string | null;
}) {
  const { t } = useI18n();
  const [positions, setPositions] = useState<StockPosition[]>(initialPositions);
  const [clearedPositions, setClearedPositions] = useState<StockPosition[]>(initialClearedPositions);
  const [showCleared, setShowCleared] = useState(initialShowCleared);
  const [marketValue, setMarketValue] = useState(totalMarketValue);
  const [cost, setCost] = useState(totalCost);
  const [selectedKey, setSelectedKey] = useState("");
  const [transactions, setTransactions] = useState<StockTransaction[]>([]);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [transactionsError, setTransactionsError] = useState("");
  const [refreshingPrice, setRefreshingPrice] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState("");
  const [detailPage, setDetailPage] = useState(1);
  const [detailPageSize, setDetailPageSize] = useState(20);
  const [detailTableRowCount, setDetailTableRowCount] = useState(0);
  const transactionCacheRef = useRef(new Map<string, StockTransaction[]>());

  useEffect(() => {
    setPositions(initialPositions);
    setClearedPositions(initialClearedPositions);
    setShowCleared((current) => initialShowCleared || (current && initialClearedPositions.length > 0));
    setMarketValue(totalMarketValue);
    setCost(totalCost);
  }, [initialClearedPositions, initialPositions, initialShowCleared, totalCost, totalMarketValue]);

  const displayPositions = showCleared ? clearedPositions : positions;
  const allPositionRows = useMemo(() => [...positions, ...clearedPositions], [clearedPositions, positions]);

  const selectedPosition = useMemo(
    () => allPositionRows.find((position) => positionKey(position) === selectedKey) ?? null,
    [allPositionRows, selectedKey],
  );

  useEffect(() => {
    if (selectedKey && !selectedPosition) {
      setSelectedKey("");
      setTransactions([]);
      setSelectedIds(new Set());
    }
  }, [selectedKey, selectedPosition]);

  const loadTransactions = useCallback(async (position: StockPosition, force = false) => {
    const market = position.market ?? "";
    const stockCode = position.stockCode;
    if (!stockCode) return;
    const cacheKey = `${accountId}:${position.securityId ?? `${market}:${stockCode}`}`;
    setSelectedKey(positionKey(position));
    const cached = force ? null : transactionCacheRef.current.get(cacheKey);
    if (cached) {
      setTransactions(cached);
      setTransactionsLoading(false);
      setTransactionsError("");
      setSelectedIds(new Set());
      setDetailPage(1);
      return;
    }
    setTransactionsLoading(true);
    setTransactionsError("");
    setSelectedIds(new Set());
    setDetailPage(1);
    try {
      const params = new URLSearchParams({
        accountId,
        stockCode,
        limit: "200",
      });
      if (market) params.set("market", market);
      if (position.securityId) params.set("securityId", position.securityId);
      const res = await fetch(`/api/v1/stocks/transactions?${params.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as StockTransactionsResponse | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("stockPanel.error.transactionsLoadFailed"));
      const nextTransactions = data.data?.transactions ?? [];
      transactionCacheRef.current.set(cacheKey, nextTransactions);
      setTransactions(nextTransactions);
    } catch (error) {
      setTransactions([]);
      setTransactionsError(error instanceof Error ? error.message : t("stockPanel.error.transactionsLoadFailed"));
    } finally {
      setTransactionsLoading(false);
    }
  }, [accountId, t]);

  const reloadHoldings = useCallback(async () => {
    const params = new URLSearchParams({ accountId, includeZero: "1" });
    const res = await fetch(`/api/v1/stocks/holdings?${params.toString()}`, { cache: "no-store" });
    const data = await res.json().catch(() => null) as StockHoldingsResponse | null;
    if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("stockPanel.error.refreshPriceFailed"));
    const holdings = (data.data?.holdings ?? []).map(mapApiHolding);
    const nextPositions = holdings.filter((item) => item.units > STOCK_POSITION_EPSILON);
    const nextClearedPositions = holdings.filter((item) => item.units <= STOCK_POSITION_EPSILON);
    setPositions(nextPositions);
    setClearedPositions(nextClearedPositions);
    setMarketValue(nextPositions.reduce((sum, item) => sum + item.marketValue, 0));
    setCost(nextPositions.reduce((sum, item) => sum + item.cost, 0));
    if (showCleared && nextClearedPositions.length === 0 && nextPositions.length > 0) {
      setShowCleared(false);
    }
  }, [accountId, showCleared, t]);

  useEffect(() => {
    function onEditSaved() {
      void reloadHoldings().catch(() => undefined);
      if (selectedPosition) void loadTransactions(selectedPosition, true);
    }
    window.addEventListener("mmh:stock:edit:success", onEditSaved);
    return () => window.removeEventListener("mmh:stock:edit:success", onEditSaved);
  }, [loadTransactions, reloadHoldings, selectedPosition]);

  async function refreshClosingPrices() {
    if (positions.length === 0 || refreshingPrice) return;
    setRefreshingPrice(true);
    setRefreshMessage("");
    try {
      const res = await fetch("/api/v1/stocks/prices/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId }),
      });
      const data = await res.json().catch(() => null) as RefreshPriceResponse | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("stockPanel.error.refreshPriceFailed"));
      if (Array.isArray(data.data?.holdings)) {
        setPositions(data.data.holdings.map(mapApiHolding).filter((item) => item.units > STOCK_POSITION_EPSILON));
        setMarketValue(Number(data.data.totalMarketValue ?? 0));
        setCost(Number(data.data.totalCost ?? 0));
      }
      const refreshed = Number(data.data?.refreshed ?? 0);
      const failedCount = data.data?.failed?.length ?? 0;
      if (refreshed > 0) {
        dispatchFinanceDataChanged({ reason: "stock-price-refresh", accountIds: [accountId] });
      }
      setRefreshMessage(failedCount > 0 ? t("stockPanel.refreshedWithFailures", { success: refreshed, failed: failedCount }) : t("stockPanel.refreshedCount", { count: refreshed }));
    } catch (error) {
      setRefreshMessage(error instanceof Error ? error.message : t("stockPanel.error.refreshPriceFailed"));
    } finally {
      setRefreshingPrice(false);
    }
  }

  const deleteTransaction = useCallback(async (id: string) => {
    if (!id || deletingIds.has(id)) return;
    setDeletingIds((prev) => new Set(prev).add(id));
    setDeleteMessage("");
    try {
      const res = await fetch(`/api/v1/stocks/transactions?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        cache: "no-store",
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("stockPanel.error.deleteFailed"));
      setTransactions((prev) => prev.filter((tx) => tx.id !== id));
      setDeleteMessage(t("stockPanel.deletedSingle"));
      dispatchFinanceDataChanged({ reason: "stock-transaction-delete", accountIds: [accountId] });
      void reloadHoldings().catch(() => undefined);
      if (selectedPosition) void loadTransactions(selectedPosition, true);
    } catch (error) {
      setDeleteMessage(error instanceof Error ? error.message : t("stockPanel.error.deleteFailed"));
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [accountId, deletingIds, loadTransactions, reloadHoldings, selectedPosition, t]);

  async function applyBatchDelete() {
    const ids = batchTargetIds;
    if (ids.length === 0 || batchDeleting) return;
    const ok = await showConfirmDialog({
      title: t("stockPanel.batchDeleteTitle"),
      message: t("stockPanel.batchDeleteConfirm", { count: ids.length }),
      tone: "danger",
    });
    if (!ok) return;
    setBatchDeleting(true);
    setDeleteMessage(t("stockPanel.deleting"));
    const closeBlocking = showBlockingLoading(t("common.batchDeleting"));
    try {
      const res = await fetch(`/api/v1/stocks/transactions?${new URLSearchParams({ ids: ids.join(",") }).toString()}`, {
        method: "DELETE",
        cache: "no-store",
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; data?: { deletedIds?: string[]; count?: number } } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("stockPanel.error.batchDeleteFailed"));
      const deletedIds = data.data?.deletedIds ?? ids;
      const deletedIdSet = new Set(deletedIds);
      setTransactions((prev) => prev.filter((tx) => !deletedIdSet.has(tx.id)));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        deletedIdSet.forEach((id) => next.delete(id));
        return next;
      });
      const deletedCount = data.data?.count ?? deletedIds.length;
      setDeleteMessage(t("stockPanel.deletedCount", { count: deletedCount }));
      dispatchFinanceDataChanged({ reason: "stock-transaction-batch-delete", accountIds: [accountId] });
      void reloadHoldings().catch(() => undefined);
      if (selectedPosition) void loadTransactions(selectedPosition, true);
    } catch {
      setDeleteMessage(t("stockPanel.error.batchDeleteFailed"));
    } finally {
      closeBlocking();
      setBatchDeleting(false);
    }
  }

  const batchTargetIds = useMemo(
    () => Array.from(selectedIds).filter((id) => transactions.some((tx) => tx.id === id)),
    [selectedIds, transactions],
  );

  const batchFields = useMemo<BatchReplaceFieldConfig<"note">[]>(() => [
    { value: "note", label: t("detail.column.remark"), kind: "text", placeholder: t("stockPanel.batchNotePlaceholder"), allowEmpty: true },
  ], [t]);

  async function applyBatch(field: "note", value: string) {
    const ids = batchTargetIds;
    if (ids.length === 0) throw new Error(t("stockPanel.error.selectRowsFirst"));
    const updates = ids.map((id) => ({ id, [field]: value }));
    const res = await fetch("/api/v1/stocks/transactions/batch-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: t("stockPanel.error.batchUpdateFailed") })) as { ok?: boolean; error?: string; data?: { updatedCount?: number } } | null;
    if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("stockPanel.error.batchUpdateFailed"));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    dispatchFinanceDataChanged({ reason: "stock-transaction-batch-update", accountIds: [accountId] });
    void reloadHoldings().catch(() => undefined);
    if (selectedPosition) void loadTransactions(selectedPosition, true);
    return t("stockPanel.updatedCount", { count: data.data?.updatedCount ?? ids.length });
  }

  async function exportStockTransactions() {
    setRefreshMessage(t("viewImport.exporting"));
    try {
      const res = await fetch(`/api/v1/stocks/transactions?accountId=${encodeURIComponent(accountId)}&limit=500`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as StockTransactionsResponse | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("stockPanel.error.transactionsLoadFailed"));
      const rows = data.data?.transactions ?? [];
      if (rows.length === 0) throw new Error(t("viewImport.noRowsInRange"));
      await exportRowsToXlsx([
        [
          t("detail.column.date"),
          t("stockTx.settleDateLabel"),
          t("depositShell.colAction"),
          t("viewImport.stockAccount"),
          t("viewImport.cashAccount"),
          t("reports.stock.market"),
          t("stockTx.stockCodeLabel"),
          t("stockTx.stockNameLabel"),
          t("stockHoldingReport.colQuantity"),
          t("stockPanel.colPrice"),
          t("stockPanel.colGrossAmount"),
          t("stockTx.netAmountLabel"),
          t("stockPanel.colFee"),
          t("stockFee.feeType.commission"),
          t("stockFee.feeType.stamp_tax"),
          t("stockFee.feeType.transfer_fee"),
          t("stockFee.feeType.exchange_fee"),
          t("stockFee.feeType.regulatory_fee"),
          t("stockFee.feeType.other"),
          t("detail.column.remark"),
        ],
        ...rows.map((tx) => [
          tx.tradeDate,
          tx.settleDate ?? "",
          actionLabel(t, tx.action),
          tx.stockAccountName ?? accountLabel,
          tx.cashAccountName ?? "",
          tx.market ?? "",
          tx.stockCode,
          tx.stockName ?? "",
          tx.quantity ?? "",
          tx.price ?? "",
          tx.grossAmount ?? "",
          tx.netAmount ?? "",
          totalFee(tx),
          tx.commission ?? "",
          tx.stampTax ?? "",
          tx.transferFee ?? "",
          tx.exchangeFee ?? "",
          tx.regulatoryFee ?? "",
          tx.otherFee ?? "",
          tx.note ?? "",
        ]),
      ], `${t("viewImport.sheetStockTransactions")}_${accountLabel}_${new Date().toISOString().slice(0, 10)}.xlsx`, t("viewImport.sheetStockTransactions"));
      setRefreshMessage(t("viewImport.exportedCount", { count: rows.length }));
    } catch (error) {
      setRefreshMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const detailTotalPages = Math.max(1, Math.ceil(detailTableRowCount / detailPageSize));
  const detailSafePage = Math.min(detailPage, detailTotalPages);
  const allDetailPageSize = Math.max(1, detailTableRowCount);

  function switchPositionTab(nextShowCleared: boolean) {
    setShowCleared(nextShowCleared);
    setSelectedKey("");
    setTransactions([]);
    setTransactionsError("");
    setSelectedIds(new Set());
    setDetailPage(1);
    const url = new URL(window.location.href);
    if (nextShowCleared) url.searchParams.set("showCleared", "1");
    else url.searchParams.delete("showCleared");
    window.history.replaceState(null, "", url.toString());
  }

  const positionColumns = useMemo<AdvancedDataTableColumn<StockPosition>[]>(() => [
    {
      key: "stock",
      label: t("stockHoldingReport.colStock"),
      width: 220,
      minWidth: 140,
      headerClassName: "text-left",
      className: "px-4",
      sortValue: (p) => `${p.stockCode} ${p.name}`,
      render: (p) => {
        const active = positionKey(p) === selectedKey;
        return renderStockNameCode(p.name, p.stockCode, active);
      },
    },
    {
      key: "units",
      label: t("stockHoldingReport.colQuantity"),
      width: 100,
      minWidth: 72,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => String(p.units),
      filterNumber: (p) => p.units,
      sortValue: (p) => p.units,
      render: (p) => <span className="text-slate-700">{formatMoney(p.units)}</span>,
    },
    {
      key: "avgCost",
      label: t("stockHoldingReport.colAvgCost"),
      width: 100,
      minWidth: 72,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => String(p.avgCost),
      filterNumber: (p) => p.avgCost,
      sortValue: (p) => p.avgCost,
      render: (p) => <span className="text-slate-700">{p.avgCost.toFixed(4)}</span>,
    },
    {
      key: "cost",
      label: t("stockHoldingReport.colCost"),
      width: 120,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => String(p.cost),
      filterNumber: (p) => p.cost,
      sortValue: (p) => p.cost,
      render: (p) => <span className="text-slate-700">{formatCurrencyMoney(p.cost, currency)}</span>,
    },
    {
      key: "nav",
      label: t("stockHoldingReport.colClosePrice"),
      width: 160,
      minWidth: 140,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => (p.nav == null ? null : String(p.nav)),
      filterNumber: (p) => p.nav ?? null,
      sortValue: (p) => p.nav ?? null,
      render: (p) => (
        <span className="text-slate-700">
          {p.nav == null ? <span className="text-slate-300">-</span> : p.nav.toFixed(4)}
          {p.navDate ? <span className="ml-0.5 whitespace-nowrap text-slate-400">({compactNavDate(p.navDate)})</span> : null}
        </span>
      ),
    },
    {
      key: "marketValue",
      label: t("stockHoldingReport.colMarketValue"),
      width: 120,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => String(p.marketValue),
      filterNumber: (p) => p.marketValue,
      sortValue: (p) => p.marketValue,
      render: (p) => <span className={pnlClass(p.marketValue, isRedUp)}>{formatCurrencyMoney(p.marketValue, currency)}</span>,
    },
    {
      key: "floatingPnL",
      label: t("stockHoldingReport.colFloatingPnL"),
      width: 120,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => String(p.floatingPnL),
      filterNumber: (p) => p.floatingPnL,
      sortValue: (p) => p.floatingPnL,
      render: (p) => <span className={pnlClass(p.floatingPnL, isRedUp)}>{formatCurrencyMoney(p.floatingPnL, currency)}</span>,
    },
    {
      key: "floatingRate",
      label: t("stockHoldingReport.colFloatingPnLRate"),
      width: 88,
      minWidth: 64,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => String(p.floatingPnLRate),
      filterNumber: (p) => p.floatingPnLRate,
      sortValue: (p) => p.floatingPnLRate,
      render: (p) => <span className={pnlClass(p.floatingPnLRate, isRedUp)}>{(p.floatingPnLRate * 100).toFixed(2)}%</span>,
    },
    {
      key: "historical",
      label: t("stockPanel.colHistoricalProfit"),
      width: 120,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (p) => String(p.historicalProfit ?? 0),
      filterNumber: (p) => p.historicalProfit ?? 0,
      sortValue: (p) => p.historicalProfit ?? 0,
      render: (p) => (
        <span className={pnlClass(p.historicalProfit ?? 0, isRedUp)}>
          {formatCurrencyMoney(p.historicalProfit ?? 0, currency)}
        </span>
      ),
    },
  ], [currency, isRedUp, selectedKey, t]);

  const positionSummaryRow = useMemo(() => {
    if (displayPositions.length === 0) return undefined;
    const displayMarketValue = showCleared ? 0 : marketValue;
    const displayCost = showCleared ? 0 : cost;
    const totalFloating = displayMarketValue - displayCost;
    const totalHistorical = displayPositions.reduce((sum, p) => sum + (p.historicalProfit ?? 0), 0);
    return {
      cells: {
        stock: t("debtShell.summaryRow"),
        units: <span className="tabular-nums text-slate-800">{t(showCleared ? "stockPanel.clearedCount" : "stockPanel.holdingCount", { count: displayPositions.length })}</span>,
        cost: <span className="tabular-nums text-slate-800">{formatCurrencyMoney(displayCost, currency)}</span>,
        marketValue: <span className={`tabular-nums ${pnlClass(displayMarketValue, isRedUp)}`}>{formatCurrencyMoney(displayMarketValue, currency)}</span>,
        floatingPnL: <span className={`tabular-nums ${pnlClass(totalFloating, isRedUp)}`}>{formatCurrencyMoney(totalFloating, currency)}</span>,
        floatingRate: <span className={`tabular-nums ${pnlClass(displayCost !== 0 ? totalFloating / displayCost : 0, isRedUp)}`}>{displayCost !== 0 ? formatPercent(totalFloating / displayCost) : "-"}</span>,
        historical: <span className={`tabular-nums ${pnlClass(totalHistorical, isRedUp)}`}>{formatCurrencyMoney(totalHistorical, currency)}</span>,
      },
    };
  }, [cost, currency, displayPositions, isRedUp, marketValue, showCleared, t]);

  const transactionColumns = useMemo<AdvancedDataTableColumn<StockTransaction>[]>(() => {
    const numberFilterText = (value: number | null | undefined) =>
      value == null || !Number.isFinite(value) ? null : String(value);
    const optionalNumber = (value: number | null | undefined) =>
      value == null || !Number.isFinite(Number(value)) ? null : Number(value);
    const renderOptionalCurrency = (value: number | null | undefined) => {
      const amount = optionalNumber(value);
      return (
        <span className="tabular-nums text-xs text-slate-600">
          {amount == null ? <span className="text-slate-300">-</span> : formatCurrencyMoney(amount, currency)}
        </span>
      );
    };
    const feeComponentColumn = (
      key: keyof Pick<StockTransaction, "commission" | "stampTax" | "transferFee" | "exchangeFee" | "regulatoryFee" | "otherFee">,
      label: string,
    ): AdvancedDataTableColumn<StockTransaction> => ({
      key,
      label,
      width: 96,
      minWidth: 76,
      hideable: true,
      defaultHidden: true,
      align: "right",
      className: "tabular-nums",
      filterKind: "numberRange",
      filterText: (tx) => numberFilterText(optionalNumber(tx[key])),
      filterNumber: (tx) => optionalNumber(tx[key]),
      sortValue: (tx) => optionalNumber(tx[key]),
      render: (tx) => renderOptionalCurrency(tx[key]),
    });
    return [
      {
        key: "stock",
        label: t("stockHoldingReport.colStock"),
        width: 200,
        minWidth: 140,
        hideable: true,
        defaultHidden: true,
        filterText: (tx) => [tx.stockName, tx.stockCode].filter(Boolean).join(" "),
        sortValue: (tx) => `${tx.stockName ?? ""} ${tx.stockCode}`,
        render: (tx) => renderStockNameCode(tx.stockName, tx.stockCode),
      },
      {
        key: "tradeDate",
        label: t("detail.column.date"),
        width: 112,
        minWidth: 96,
        filterKind: "dateRange",
        filterText: (tx) => tx.tradeDate || "",
        sortValue: (tx) => tx.tradeDate || null,
        render: (tx) => <span className="tabular-nums text-slate-600">{tx.tradeDate}</span>,
      },
      {
        key: "settleDate",
        label: t("stockTx.settleDateLabel"),
        width: 112,
        minWidth: 96,
        hideable: true,
        defaultHidden: true,
        filterKind: "dateRange",
        filterText: (tx) => tx.settleDate || "",
        sortValue: (tx) => tx.settleDate || null,
        render: (tx) => <span className="tabular-nums text-slate-600">{tx.settleDate || <span className="text-slate-300">-</span>}</span>,
      },
      {
        key: "stockAccount",
        label: t("viewImport.stockAccount"),
        width: 160,
        minWidth: 118,
        hideable: true,
        defaultHidden: true,
        filterText: (tx) => tx.stockAccountName || "",
        sortValue: (tx) => tx.stockAccountName || null,
        truncate: true,
        cellTitle: (tx) => tx.stockAccountName || "",
        render: (tx) => tx.stockAccountName ? <span className="text-slate-600">{tx.stockAccountName}</span> : <span className="text-slate-300">-</span>,
      },
      {
        key: "cashAccount",
        label: t("viewImport.cashAccount"),
        width: 160,
        minWidth: 118,
        hideable: true,
        defaultHidden: true,
        filterText: (tx) => tx.cashAccountName || "",
        sortValue: (tx) => tx.cashAccountName || null,
        truncate: true,
        cellTitle: (tx) => tx.cashAccountName || "",
        render: (tx) => tx.cashAccountName ? <span className="text-slate-600">{tx.cashAccountName}</span> : <span className="text-slate-300">-</span>,
      },
      {
        key: "action",
        label: t("depositShell.colAction"),
        width: 88,
        minWidth: 72,
        filterText: (tx) => actionLabel(t, tx.action),
        sortValue: (tx) => actionLabel(t, tx.action),
        render: (tx) => <span className="text-slate-700">{actionLabel(t, tx.action)}</span>,
      },
      {
        key: "market",
        label: t("reports.stock.market"),
        width: 76,
        minWidth: 64,
        hideable: true,
        defaultHidden: true,
        filterText: (tx) => tx.market || "",
        sortValue: (tx) => tx.market || null,
        render: (tx) => tx.market ? <span className="text-slate-600">{tx.market}</span> : <span className="text-slate-300">-</span>,
      },
      {
        key: "quantity",
        label: t("stockHoldingReport.colQuantity"),
        width: 104,
        minWidth: 84,
        align: "right",
        className: "tabular-nums",
        filterKind: "numberRange",
        filterText: (tx) => numberFilterText(tx.quantity == null ? null : Number(tx.quantity)),
        filterNumber: (tx) => (tx.quantity == null ? null : Number(tx.quantity)),
        sortValue: (tx) => (tx.quantity == null ? null : Number(tx.quantity)),
        render: (tx) => (
          <span className="whitespace-nowrap tabular-nums text-slate-700">
            {tx.quantity == null ? <span className="text-slate-300">-</span> : formatMoney(Number(tx.quantity))}
          </span>
        ),
      },
      {
        key: "price",
        label: t("stockPanel.colPrice"),
        width: 100,
        minWidth: 80,
        align: "right",
        className: "tabular-nums",
        filterKind: "numberRange",
        filterText: (tx) => numberFilterText(tx.price == null ? null : Number(tx.price)),
        filterNumber: (tx) => (tx.price == null ? null : Number(tx.price)),
        sortValue: (tx) => (tx.price == null ? null : Number(tx.price)),
        render: (tx) => (
          <span className="whitespace-nowrap tabular-nums text-slate-700">
            {tx.price == null ? <span className="text-slate-300">-</span> : Number(tx.price).toFixed(4)}
          </span>
        ),
      },
      {
        key: "grossAmount",
        label: t("stockPanel.colGrossAmount"),
        width: 120,
        minWidth: 92,
        align: "right",
        className: "tabular-nums",
        filterKind: "numberRange",
        filterText: (tx) => numberFilterText(Math.abs(Number(tx.grossAmount ?? 0))),
        filterNumber: (tx) => Math.abs(Number(tx.grossAmount ?? 0)),
        sortValue: (tx) => Math.abs(Number(tx.grossAmount ?? 0)),
        render: (tx) => <span className="tabular-nums text-slate-700">{formatCurrencyMoney(Number(tx.grossAmount ?? 0), currency)}</span>,
      },
      {
        key: "netAmount",
        label: t("stockTx.netAmountLabel"),
        width: 120,
        minWidth: 92,
        hideable: true,
        defaultHidden: true,
        align: "right",
        className: "tabular-nums",
        filterKind: "numberRange",
        filterText: (tx) => numberFilterText(optionalNumber(tx.netAmount)),
        filterNumber: (tx) => optionalNumber(tx.netAmount),
        sortValue: (tx) => optionalNumber(tx.netAmount),
        render: (tx) => renderOptionalCurrency(tx.netAmount),
      },
      {
        key: "fee",
        label: t("stockPanel.colFee"),
        width: 96,
        minWidth: 76,
        align: "right",
        className: "tabular-nums",
        filterKind: "numberRange",
        filterText: (tx) => numberFilterText(totalFee(tx)),
        filterNumber: (tx) => totalFee(tx),
        sortValue: (tx) => totalFee(tx),
        render: (tx) => <span className="tabular-nums text-slate-600">{formatCurrencyMoney(totalFee(tx), currency)}</span>,
      },
      feeComponentColumn("commission", t("stockFee.feeType.commission")),
      feeComponentColumn("stampTax", t("stockFee.feeType.stamp_tax")),
      feeComponentColumn("transferFee", t("stockFee.feeType.transfer_fee")),
      feeComponentColumn("exchangeFee", t("stockFee.feeType.exchange_fee")),
      feeComponentColumn("regulatoryFee", t("stockFee.feeType.regulatory_fee")),
      feeComponentColumn("otherFee", t("stockFee.feeType.other")),
      {
        key: "cash",
        label: t("stockPanel.colCashFlow"),
        width: 120,
        minWidth: 92,
        align: "right",
        className: "tabular-nums",
        filterKind: "numberRange",
        filterText: (tx) => numberFilterText(cashAmount(tx)),
        filterNumber: (tx) => cashAmount(tx),
        sortValue: (tx) => cashAmount(tx),
        render: (tx) => (
          <span className={`tabular-nums ${pnlClass(cashAmount(tx), isRedUp)}`}>{formatCurrencyMoney(cashAmount(tx), currency)}</span>
        ),
      },
      {
        key: "realized",
        label: t("stockHoldingReport.colRealized"),
        width: 110,
        minWidth: 84,
        align: "right",
        className: "tabular-nums",
        filterKind: "numberRange",
        filterText: (tx) => numberFilterText(tx.realizedProfit == null ? null : Number(tx.realizedProfit)),
        filterNumber: (tx) => (tx.realizedProfit == null ? null : Number(tx.realizedProfit)),
        sortValue: (tx) => (tx.realizedProfit == null ? null : Number(tx.realizedProfit)),
        render: (tx) => (
          <span className={`tabular-nums ${pnlClass(Number(tx.realizedProfit ?? 0), isRedUp)}`}>
            {tx.realizedProfit == null ? <span className="text-slate-300">-</span> : formatCurrencyMoney(Number(tx.realizedProfit), currency)}
          </span>
        ),
      },
      {
        key: "note",
        label: t("detail.column.remark"),
        width: 180,
        minWidth: 110,
        hideable: true,
        filterText: (tx) => String(tx.note ?? "").trim(),
        sortValue: (tx) => String(tx.note ?? "").trim() || null,
        truncate: true,
        cellTitle: (tx) => String(tx.note ?? "").trim(),
        render: (tx) => {
          const note = String(tx.note ?? "").trim();
          return note ? <span className="text-slate-600">{note}</span> : <span className="text-slate-300">-</span>;
        },
      },
    ];
  }, [currency, isRedUp, t]);

  const openEditTransaction = useCallback((tx: StockTransaction) => {
    window.dispatchEvent(new CustomEvent("mmh:stock:edit", {
      detail: {
        requestId: `edit-${tx.id}`,
        transaction: {
          id: tx.id,
          stockAccountId: tx.stockAccountId ?? accountId,
          cashAccountId: tx.cashAccountId ?? null,
          securityId: tx.securityId ?? null,
          market: tx.market ?? "",
          stockCode: tx.stockCode,
          stockName: tx.stockName ?? null,
          action: tx.action,
          tradeDate: tx.tradeDate,
          settleDate: tx.settleDate ?? null,
          grossAmount: tx.grossAmount == null ? null : Number(tx.grossAmount),
          netAmount: tx.netAmount == null ? null : Number(tx.netAmount),
          quantity: tx.quantity == null ? null : Number(tx.quantity),
          price: tx.price == null ? null : Number(tx.price),
          note: tx.note ?? null,
        },
      },
    }));
  }, [accountId]);

  const transactionRowActions = useCallback((tx: StockTransaction) => {
    const deleting = deletingIds.has(tx.id);
    const hasBusinessLink = (tx.linkIds?.length ?? 0) > 0;
    const linkLabels = hasBusinessLink ? (tx.cashAccountName ? [tx.cashAccountName] : []) : [];
    const linkTitle = hasBusinessLink
      ? t("stockPanel.linkedTitle", { labels: linkLabels.join("、") || t("stockPanel.businessCashFlow") })
      : t("stockPanel.unlinkedTitle");
    return (
      <div className="flex items-center justify-end gap-1">
        <BusinessLinkActionButton
          active={hasBusinessLink}
          title={linkTitle}
          onClick={() => undefined}
        />
        <button
          type="button"
          onClick={() => openEditTransaction(tx)}
          className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50"
          title={t("stockPanel.editTransaction")}
          aria-label={t("stockPanel.editTransaction")}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => { void deleteTransaction(tx.id); }}
          disabled={deleting}
          className="flex h-7 w-7 items-center justify-center rounded border border-red-200 bg-white text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
          title={deleting ? t("stockPanel.deleting") : t("stockPanel.deleteTransaction")}
          aria-label={deleting ? t("stockPanel.deleting") : t("stockPanel.deleteTransaction")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }, [deleteTransaction, deletingIds, openEditTransaction, t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-transparent p-4 md:p-5">
      <ResizableVerticalSplit
        storageKey={`mmh:stock-shell:${accountId}:split-height`}
        hasLowerPane={Boolean(selectedPosition)}
        defaultUpperHeight={360}
        separatorLabel={t("stockPanel.resizeLabel")}
        separatorTitle={t("stockPanel.resizeTitle")}
        stackOnMobile
      >
      <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
        <div className="panel-header shrink-0 gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-left">
            <div className="flex min-w-0 items-center gap-1 text-sm font-semibold text-slate-800">
              <span className="flex h-6 min-w-0 shrink items-center truncate">{t("stockTx.holdingStock")}</span>
              <div className="ml-2 flex items-center gap-0.5 rounded bg-slate-100 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => switchPositionTab(false)}
                  className={`h-6 rounded px-2 ${!showCleared ? "bg-white font-medium text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                >
                  {t("invest.filterHolding")}
                </button>
                <button
                  type="button"
                  onClick={() => switchPositionTab(true)}
                  className={`h-6 rounded px-2 ${showCleared ? "bg-white font-medium text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                >
                  {t("invest.filterCleared")}
                </button>
              </div>
              <span className="flex h-6 shrink-0 items-center text-xs text-slate-500">
                <span className="ml-2">{t("stockPanel.cashBalanceLabel")}</span>
                <span className="ml-2 font-semibold tabular-nums text-slate-800">{formatCurrencyMoney(cashBalance, currency)}</span>
              </span>
            </div>
          </div>
          <div className="flex min-w-0 max-w-[66vw] items-center gap-1 overflow-x-auto whitespace-nowrap pb-0.5 text-xs md:max-w-none md:overflow-visible [&>*]:shrink-0">
            <ViewExcelImportMenuButton
              kind="stock"
              accountId={accountId}
              stockAccountName={accountLabel}
              exportItems={[{
                label: t("viewImport.exportExcel"),
                onClick: () => void exportStockTransactions(),
              }]}
            />
            <StockFeeRuleSettingsButton accountId={accountId} accountLabel={accountLabel} currency={currency} />
            <button
              type="button"
              onClick={() => void refreshClosingPrices()}
              disabled={refreshingPrice || positions.length === 0}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-500 transition-colors hover:bg-blue-50 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
              title={t("stockPanel.refreshPriceTitle")}
              aria-label={t("stockPanel.refreshPriceTitle")}
            >
              <RefreshCcw className={`h-3.5 w-3.5 ${refreshingPrice ? "animate-spin" : ""}`} />
            </button>
            <button
              type="button"
              onClick={() => {
                window.dispatchEvent(new CustomEvent("mmh:create-transaction:open", {
                  detail: {
                    requestId: `stock-transfer-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                    source: "launcher",
                    item: { type: "transfer", remark: t("stockPanel.transfer") },
                    lockedType: "transfer",
                    stockTransferMode: true,
                    stockCashAccountId: stockCashAccountId ?? "",
                    stockCashAccountName: stockCashAccountName || "",
                    defaultFromAccountId: "",
                    defaultToAccountId: stockCashAccountId ?? "",
                  },
                }));
              }}
              className="h-7 rounded border border-slate-200 bg-white px-2.5 text-xs text-slate-500 hover:bg-blue-50 hover:text-blue-600"
              title={t("stockPanel.transferTitle")}
            >
              {t("stockPanel.transfer")}
            </button>
            {refreshMessage ? <span className="px-1 text-[10px] text-slate-500">{refreshMessage}</span> : null}
          </div>
        </div>

        <div className="min-h-0 flex-1">
          <AdvancedDataTable
            storageKey="mmh_stock_shell_positions_advanced_v1"
            columns={positionColumns}
            resetKey={showCleared ? "cleared" : "holding"}
            rows={displayPositions}
            rowKey={(p) => positionKey(p)}
            emptyText={showCleared ? t("stockPanel.noCleared") : t("stockHoldingReport.empty")}
            minTableWidth={900}
            rowClassName={(p) => {
              const active = positionKey(p) === selectedKey;
              return `cursor-pointer ${active ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-blue-50/40"}`;
            }}
            onRowClick={(p) => void loadTransactions(p)}
            showFilters={false}
            fillHeight
            toolbarMode="none"
            draggableRows={false}
            defaultSort={showCleared ? { key: "historical", direction: "desc" } : { key: "marketValue", direction: "desc" }}
            summaryRow={positionSummaryRow}
          />
        </div>
      </div>

      {selectedPosition ? (
        <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
            <div className="panel-header h-12 shrink-0">
              <div className="flex min-w-0 items-center gap-1 text-sm font-semibold text-slate-800">
                {batchTargetIds.length > 0 ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <BatchReplacePopoverButton
                      fields={batchFields}
                      targetCount={batchTargetIds.length}
                      targetLabel={t("stockPanel.selected")}
                      buttonTitle={t("common.edit")}
                      buttonClassName="h-6 w-6 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center [&_svg]:h-3.5 [&_svg]:w-3.5"
                      onApply={applyBatch}
                    />
                    <button
                      type="button"
                      onClick={() => void applyBatchDelete()}
                      disabled={batchDeleting}
                      className="flex h-6 w-6 items-center justify-center rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
                      title={t("stockPanel.deleteSelected")}
                      aria-label={t("stockPanel.deleteSelected")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                    <span className="shrink-0 text-xs font-medium tabular-nums text-blue-700">
                      {t("detail.selectedCount", { count: batchTargetIds.length })}
                    </span>
                    <span className="mx-1 h-4 w-px bg-slate-200" />
                  </div>
                ) : null}
                <span className="shrink-0">{t("debtShell.tabEntries")}</span>
                <div className="ml-2 min-w-0 max-w-[16rem]">{renderStockNameCode(selectedPosition.name, selectedPosition.stockCode)}</div>
                <span className="ml-2 text-xs font-normal text-slate-400">{t("stockPanel.entryCount", { count: transactions.length })}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs text-slate-400">
                {deleteMessage ? <span className="text-[11px] text-slate-500">{deleteMessage}</span> : null}
                <div className="flex items-center gap-1">
                  <span className="text-slate-300">|</span>
                  {[10, 20, 40].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => { setDetailPageSize(n); setDetailPage(1); }}
                      className={`h-6 px-1.5 rounded border ${detailPageSize === n ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}
                    >
                      {n}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => { setDetailPageSize(allDetailPageSize); setDetailPage(1); }}
                    className={`h-6 px-1.5 rounded border ${detailPageSize === allDetailPageSize ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}
                  >
                    {t("stockPanel.all")}
                  </button>
                  <span className="text-slate-300">|</span>
                  {detailSafePage > 1 ? (<>
                    <button
                      type="button"
                      onClick={() => setDetailPage(1)}
                      className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-400 hover:bg-slate-50"
                    >
                      <ChevronsLeft className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDetailPage(detailSafePage - 1)}
                      className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-500 hover:bg-slate-50"
                    >
                      <ChevronLeft className="h-3 w-3" />
                    </button>
                  </>) : (<>
                    <span className="h-6 w-6 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300"><ChevronsLeft className="h-3 w-3" /></span>
                    <span className="h-6 w-6 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300"><ChevronLeft className="h-3 w-3" /></span>
                  </>)}
                  <span className="text-slate-500 px-0.5">{detailSafePage}/{detailTotalPages}</span>
                  {detailSafePage < detailTotalPages ? (<>
                    <button
                      type="button"
                      onClick={() => setDetailPage(detailSafePage + 1)}
                      className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-500 hover:bg-slate-50"
                    >
                      <ChevronRight className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDetailPage(detailTotalPages)}
                      className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-400 hover:bg-slate-50"
                    >
                      <ChevronsRight className="h-3 w-3" />
                    </button>
                  </>) : (<>
                    <span className="h-6 w-6 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300"><ChevronRight className="h-3 w-3" /></span>
                    <span className="h-6 w-6 rounded border border-slate-100 bg-slate-50 inline-flex items-center justify-center text-slate-300"><ChevronsRight className="h-3 w-3" /></span>
                  </>)}
                  <span className="text-slate-300">|</span>
                  <button
                    type="button"
                    data-advanced-table-column-settings
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      window.dispatchEvent(new CustomEvent(STOCK_DETAIL_COLUMN_SETTINGS_EVENT, {
                        detail: { anchorRect: { right: rect.right, bottom: rect.bottom } },
                      }));
                    }}
                    className="h-6 w-6 rounded border border-slate-200 bg-white inline-flex items-center justify-center text-slate-500 hover:bg-slate-50"
                    title={t("table.columnSettings")}
                    aria-label={t("table.columnSettings")}
                  >
                    <SlidersHorizontal className="h-3 w-3" />
                  </button>
                </div>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              {transactionsLoading ? (
                <div className="flex h-full min-h-[160px] items-center justify-center text-xs text-slate-500">{t("stockPanel.detailLoading")}</div>
              ) : transactionsError ? (
                <div className="flex h-full min-h-[160px] items-center justify-center text-xs text-rose-600">{transactionsError}</div>
              ) : (
                <AdvancedDataTable
                  storageKey="mmh_stock_shell_detail_advanced_table_v2"
                  resetKey={`${accountId}:${selectedPosition.stockCode}`}
                  columns={transactionColumns}
                  rows={transactions}
                  rowKey={(tx) => tx.id}
                  minTableWidth={1120}
                  emptyText={t("stockPanel.noTransactions")}
                  selectable
                  selectOnRowClick
                  selectAllScope="renderedRows"
                  selectedKeys={selectedIds}
                  onSelectionChange={setSelectedIds}
                  onRowDoubleClick={(tx) => openEditTransaction(tx)}
                  rowActions={transactionRowActions}
                  rowActionsWidth={116}
                  rowActionsMinWidth={100}
                  rowClassName={(tx) => (selectedIds.has(tx.id) ? "bg-blue-50/70 hover:bg-blue-50/70" : "hover:bg-blue-50/40")}
                  fillHeight
                  toolbarMode="none"
                  showFilters
                  showColumnVisibilityButton={false}
                  columnVisibilityTriggerId={STOCK_DETAIL_COLUMN_SETTINGS_EVENT}
                  sortable
                  defaultSort={{ key: "tradeDate", direction: "desc" }}
                  pagination={{
                    page: detailSafePage,
                    pageSize: detailPageSize,
                    onPageChange: setDetailPage,
                    onRowCountChange: setDetailTableRowCount,
                  }}
                />
              )}
            </div>
        </div>
      ) : null}
      </ResizableVerticalSplit>
    </div>
  );
}
