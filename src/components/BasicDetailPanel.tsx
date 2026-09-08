"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { BasicDetailBatchDeleteMessage, BasicDetailSelectionProvider } from "@/components/BasicDetailSelection";
import type { BasicDetailBatchCategoryOption } from "@/components/BasicDetailSelection";
import { DebitBalanceReconcileButton } from "@/components/DebitBalanceReconcileButton";
import { DetailTablePaginationControls } from "@/components/DetailTablePaginationControls";
import { DetailViewClient, type DetailEntry } from "@/components/DetailViewClient";
import { ViewExcelImportMenuButton } from "@/components/ViewExcelImportMenuButton";
import { FINANCE_DATA_CHANGED_EVENT, type FinanceDataChangedDetail } from "@/lib/client/refresh";
import {
  DETAIL_ALL_PAGE_SIZE,
  DETAIL_PAGE_SIZE_OPTIONS,
  clampDetailPage as clampPage,
  normalizeDetailPageSize,
  readStoredDetailPreference,
  writeStoredDetailPreference,
} from "@/lib/detail-pagination-preference";
import { useI18n } from "@/lib/i18n";

type BasicDetailPanelProps = {
  accountId: string;
  isInvestAccount: boolean;
  entries: DetailEntry[];
  totalCount: number;
  originalCount: number;
  hasDetailFilters: boolean;
  initialPage: number;
  initialPageSize: number;
  initialDetailAll: boolean;
  normalExportFilename: string;
  normalExportRows?: string[][];
  normalExportRowsByEntryId?: Record<string, string[]>;
  accountOptions: Array<{ id: string; label: string; fullLabel?: string | null; title?: string | null }>;
  categoryOptions?: BasicDetailBatchCategoryOption[];
  tagOptions?: BasicDetailBatchCategoryOption[];
  investmentProductTypeByAccountId: Record<string, string | undefined | null>;
  compactRows?: boolean;
  showBalanceReconcile?: boolean;
  showImportExport?: boolean;
  showAccountColumn?: boolean;
  showRunningBalance?: boolean;
  refreshOnGlobalEvent?: boolean;
  draggableRows?: boolean;
  sortable?: boolean;
  showPagination?: boolean;
  accountKind?: string | null;
  accountName?: string;
  accountLabel?: string;
  currentBalance?: number;
  focusEntryId?: string;
  showGuideOverlay?: boolean;
};

function detailPaginationFetchKey(accountId: string, pageSize: number, detailAll: boolean, detailPage: number) {
  return `${accountId}:${pageSize}:${detailAll ? "all" : detailPage}`;
}

type GuideRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

type GuidePoint = {
  x: number;
  y: number;
};

type GuideMetrics = {
  width: number;
  height: number;
  panel: GuideRect | null;
  toolbar: GuideRect | null;
  toolbarActions: GuideRect | null;
  header: GuideRect | null;
  headerCell: GuideRect | null;
  rowControls: GuideRect | null;
  rowActions: GuideRect | null;
  entryButton: GuideRect | null;
  toolbarTools: GuideRect | null;
  columnSettings: GuideRect | null;
  resizeHandle: GuideRect | null;
  bodyRow: GuideRect | null;
  bodyRowFocus: GuideRect | null;
};

type GuideBoxStyle = CSSProperties & {
  left: number;
  top: number;
  width: number;
  height: number;
};

const GUIDE_TOOLTIP_WIDTH = 268;
const GUIDE_TOOLTIP_GAP = 8;

function visibleGuideRect(element: Element | null, rootRect: DOMRect): GuideRect | null {
  if (!(element instanceof HTMLElement)) return null;
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left - rootRect.left);
  const top = Math.max(0, rect.top - rootRect.top);
  const right = Math.min(rootRect.width, rect.right - rootRect.left);
  const bottom = Math.min(rootRect.height, rect.bottom - rootRect.top);
  const width = right - left;
  const height = bottom - top;
  if (width < 3 || height < 3) return null;
  return { left, top, right, bottom, width, height };
}

function firstVisibleGuideRect(root: HTMLElement, rootRect: DOMRect, selector: string): GuideRect | null {
  for (const element of Array.from(root.querySelectorAll(selector))) {
    const rect = visibleGuideRect(element, rootRect);
    if (rect) return rect;
  }
  return null;
}

function unionGuideRects(rects: Array<GuideRect | null | undefined>): GuideRect | null {
  const visibleRects = rects.filter((rect): rect is GuideRect => !!rect);
  if (visibleRects.length === 0) return null;
  const left = Math.min(...visibleRects.map((rect) => rect.left));
  const top = Math.min(...visibleRects.map((rect) => rect.top));
  const right = Math.max(...visibleRects.map((rect) => rect.right));
  const bottom = Math.max(...visibleRects.map((rect) => rect.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function guideCenteredRect(rect: GuideRect | null, width: number, height: number): GuideRect | null {
  const center = guideCenter(rect);
  if (!center) return null;
  const left = center.x - width / 2;
  const top = center.y - height / 2;
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function guideCenter(rect: GuideRect | null): GuidePoint | null {
  if (!rect) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function expandedGuideRectStyle(rect: GuideRect, padding = 4): GuideBoxStyle {
  const left = Math.max(0, rect.left - padding);
  const top = Math.max(0, rect.top - padding);
  return {
    left,
    top,
    width: rect.width + (rect.left - left) + padding,
    height: rect.height + (rect.top - top) + padding,
  };
}

function clampGuidePosition(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function guideRectFromBoxStyle(style: GuideBoxStyle): GuideRect {
  return {
    left: style.left,
    top: style.top,
    right: style.left + style.width,
    bottom: style.top + style.height,
    width: style.width,
    height: style.height,
  };
}

function guideTooltipOffsetStyle(hotspotRect: GuideRect, guideWidth: number, guideHeight: number): CSSProperties {
  const width = Math.min(GUIDE_TOOLTIP_WIDTH, Math.max(180, guideWidth - 24));
  const absoluteLeft = clampGuidePosition(hotspotRect.left + hotspotRect.width / 2 - width / 2, 12, guideWidth - width - 12);
  const openAbove = hotspotRect.bottom + 120 > guideHeight && hotspotRect.top > 120;
  return openAbove
    ? { left: absoluteLeft - hotspotRect.left, bottom: hotspotRect.height + GUIDE_TOOLTIP_GAP, width }
    : { left: absoluteLeft - hotspotRect.left, top: hotspotRect.height + GUIDE_TOOLTIP_GAP, width };
}

function GuideHotspot({
  rect,
  guideWidth,
  guideHeight,
  style,
  tone = "blue",
  title,
  children,
}: {
  rect: GuideRect | null;
  guideWidth: number;
  guideHeight: number;
  style?: GuideBoxStyle;
  tone?: "blue" | "emerald";
  title: string;
  children: string;
}) {
  const { t } = useI18n();
  if (!rect) return null;
  const hotspotStyle = style ?? expandedGuideRectStyle(rect);
  const hotspotRect = guideRectFromBoxStyle(hotspotStyle);
  const tooltipStyle = guideTooltipOffsetStyle(hotspotRect, guideWidth, guideHeight);
  const hotspotToneClass = tone === "emerald"
    ? "border-emerald-500/55 bg-emerald-200/25 shadow-[0_0_0_1px_rgba(16,185,129,0.24)] hover:bg-emerald-200/35 focus-visible:ring-2 focus-visible:ring-emerald-500/60"
    : "border-blue-500/55 bg-blue-200/25 shadow-[0_0_0_1px_rgba(59,130,246,0.24)] hover:bg-blue-200/35 focus-visible:ring-2 focus-visible:ring-blue-500/60";
  const badgeToneClass = tone === "emerald"
    ? "border-emerald-200/80 bg-white/80 text-emerald-700"
    : "border-blue-200/80 bg-white/80 text-blue-700";
  const tooltipToneClass = tone === "emerald"
    ? "border-emerald-500/45 text-emerald-950"
    : "border-blue-500/45 text-blue-950";

  return (
    <div
      data-basic-detail-guide-hotspot={title}
      tabIndex={0}
      role="note"
      aria-label={`${title}：${children}`}
      title={t("basicDetail.guideHoverHint")}
      className={`group pointer-events-auto absolute z-20 cursor-help rounded-md border transition-colors outline-none ${hotspotToneClass}`}
      style={hotspotStyle}
    >
      {hotspotRect.width >= 40 && hotspotRect.height >= 20 ? (
        <span className={`pointer-events-none absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded border px-1 text-[10px] font-semibold leading-none shadow-sm ${badgeToneClass}`}>
          ?
        </span>
      ) : null}
      <div
        className={`pointer-events-none invisible absolute z-30 box-border rounded-lg border bg-white/90 px-3 py-2 text-xs opacity-0 shadow-lg shadow-slate-900/10 backdrop-blur-sm transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus:visible group-focus:opacity-100 ${tooltipToneClass}`}
        style={tooltipStyle}
      >
        <div className="font-semibold">{title}</div>
        <div className="mt-0.5 whitespace-normal break-words leading-5 text-slate-700">{children}</div>
      </div>
    </div>
  );
}

export function BasicDetailPanel({
  accountId,
  isInvestAccount,
  entries,
  totalCount,
  originalCount,
  hasDetailFilters,
  initialPage,
  initialPageSize,
  initialDetailAll,
  normalExportFilename,
  normalExportRows = [],
  normalExportRowsByEntryId,
  accountOptions,
  categoryOptions = [],
  tagOptions = [],
  investmentProductTypeByAccountId,
  compactRows = false,
  showBalanceReconcile = false,
  showImportExport = true,
  showAccountColumn = false,
  showRunningBalance,
  refreshOnGlobalEvent = true,
  draggableRows = true,
  sortable = true,
  showPagination = true,
  accountKind = null,
  accountName = "",
  accountLabel = "",
  currentBalance = 0,
  focusEntryId,
  showGuideOverlay = false,
}: BasicDetailPanelProps) {
  const router = useRouter();
  const { t } = useI18n();
  const normalizedInitialPageSize = normalizeDetailPageSize(initialPageSize);
  const [localEntries, setLocalEntries] = useState(entries);
  const [localTotalCount, setLocalTotalCount] = useState(totalCount);
  const [localOriginalCount, setLocalOriginalCount] = useState(originalCount);
  const [pageSize, setPageSize] = useState(normalizedInitialPageSize);
  const [detailAll, setDetailAll] = useState(initialDetailAll);
  const [isPageLoading, setIsPageLoading] = useState(false);
  const [displayedEntryIds, setDisplayedEntryIds] = useState<string[] | null>(null);
  const [guideOverlayOpen, setGuideOverlayOpen] = useState(showGuideOverlay);
  const [guideMetrics, setGuideMetrics] = useState<GuideMetrics | null>(null);
  const [guidePortalHost, setGuidePortalHost] = useState<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const totalPages = Math.max(1, Math.ceil(localTotalCount / pageSize));
  const [page, setPage] = useState(() => initialDetailAll ? 1 : clampPage(initialPage, totalPages));
  const safePage = detailAll ? 1 : clampPage(page, totalPages);
  const accountScopeKey = `${accountId}:${isInvestAccount ? "invest" : "detail"}`;
  const lastAccountScopeKeyRef = useRef(accountScopeKey);
  const lastFocusEntryIdRef = useRef(focusEntryId ?? "");
  const paginationFetchSeqRef = useRef(0);
  const lastClientPaginationKeyRef = useRef("");
  // Track latest values without bloating the FINANCE_DATA_CHANGED_EVENT effect dependency array
  const localEntriesRef = useRef(localEntries);
  const localTotalCountRef = useRef(localTotalCount);

  useEffect(() => { localEntriesRef.current = localEntries; }, [localEntries]);
  useEffect(() => { localTotalCountRef.current = localTotalCount; }, [localTotalCount]);

  const clientPaginationEnabled = !hasDetailFilters && !focusEntryId;

  const reloadDetailPage = useCallback((signal?: AbortSignal) => {
    if (!clientPaginationEnabled) return;
    const seq = ++paginationFetchSeqRef.current;
    const params = new URLSearchParams({
      accountId,
      page: detailAll ? "1" : String(safePage),
      pageSize: detailAll ? String(DETAIL_ALL_PAGE_SIZE) : String(pageSize),
    });
    setIsPageLoading(true);
    fetch(`/api/v1/transactions/detail?${params.toString()}`, {
      cache: "no-store",
      signal,
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? t("basicDetail.loadFailed"));
        }
        if (seq !== paginationFetchSeqRef.current) return;
        const nextEntries = Array.isArray(payload.data?.entries) ? payload.data.entries : [];
        const nextTotalCount = Number(payload.data?.totalCount);
        setLocalEntries(nextEntries);
        if (Number.isFinite(nextTotalCount)) {
          setLocalTotalCount(nextTotalCount);
          setLocalOriginalCount(nextTotalCount);
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Load transaction detail page failed:", error);
      })
      .finally(() => {
        if (seq === paginationFetchSeqRef.current) setIsPageLoading(false);
      });
  }, [accountId, clientPaginationEnabled, detailAll, pageSize, safePage]);

  useEffect(() => {
    if (showGuideOverlay) setGuideOverlayOpen(true);
  }, [accountId, showGuideOverlay]);

  useEffect(() => {
    setGuidePortalHost(document.body);
  }, []);

  useEffect(() => {
    if (!guideOverlayOpen) {
      setGuideMetrics(null);
      return;
    }

    const root = panelRef.current;
    if (!root) return;

    let frameId = 0;
    const measureGuideTargets = () => {
      const rootRect = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
      const panel = visibleGuideRect(root, rootRect);
      const toolbar = visibleGuideRect(root.querySelector("[data-advanced-table-toolbar]"), rootRect);
      const toolbarTools = unionGuideRects([
        visibleGuideRect(root.querySelector("[data-basic-detail-import]"), rootRect),
        visibleGuideRect(root.querySelector("[data-basic-detail-reconcile]"), rootRect),
        visibleGuideRect(root.querySelector("[data-basic-detail-export]"), rootRect),
      ]);
      const header = visibleGuideRect(root.querySelector("[data-advanced-table-header-row]"), rootRect);
      const headerCell =
        firstVisibleGuideRect(root, rootRect, '[data-advanced-table-header-cell="type"]') ??
        firstVisibleGuideRect(root, rootRect, "[data-advanced-table-header-cell]");
      const rowControls = firstVisibleGuideRect(root, rootRect, "[data-advanced-table-row-controls]");
      const rowActions = firstVisibleGuideRect(root, rootRect, "[data-advanced-table-row-actions]");
      const columnSettings = visibleGuideRect(root.querySelector("[data-advanced-table-column-settings]"), rootRect);
      const resizeHandle = firstVisibleGuideRect(root, rootRect, "[data-advanced-table-resize-handle]");
      const bodyRow = firstVisibleGuideRect(root, rootRect, "[data-advanced-table-body-row]");
      const bodyRowFocus = bodyRow
        ? guideCenteredRect(bodyRow, Math.min(360, Math.max(180, bodyRow.width * 0.42)), Math.max(24, bodyRow.height))
        : null;
      const entryButton =
        firstVisibleGuideRect(document.body, rootRect, '[data-entry-launcher-primary-action="transaction"]') ??
        firstVisibleGuideRect(document.body, rootRect, "[data-entry-launcher-primary]");
      setGuideMetrics({
        width: rootRect.width,
        height: rootRect.height,
        panel,
        toolbar,
        toolbarActions: toolbarTools,
        header,
        headerCell,
        rowControls,
        rowActions,
        entryButton,
        toolbarTools,
        columnSettings,
        resizeHandle,
        bodyRow,
        bodyRowFocus,
      });
    };
    const requestMeasure = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(measureGuideTargets);
    };

    requestMeasure();
    window.addEventListener("resize", requestMeasure);
    window.addEventListener("scroll", requestMeasure, true);

    const tableViewport = root.querySelector(".advanced-table-viewport");
    tableViewport?.addEventListener("scroll", requestMeasure, { passive: true });

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(requestMeasure);
    resizeObserver?.observe(root);
    if (tableViewport instanceof HTMLElement) resizeObserver?.observe(tableViewport);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", requestMeasure);
      window.removeEventListener("scroll", requestMeasure, true);
      tableViewport?.removeEventListener("scroll", requestMeasure);
      resizeObserver?.disconnect();
    };
  }, [detailAll, guideOverlayOpen, guidePortalHost, localEntries.length, pageSize, safePage]);

  useEffect(() => {
    setLocalEntries(entries);
    setLocalTotalCount(totalCount);
    setLocalOriginalCount(originalCount);
    const nextFocusEntryId = focusEntryId ?? "";
    const accountScopeChanged = lastAccountScopeKeyRef.current !== accountScopeKey;
    const focusEntryChanged = lastFocusEntryIdRef.current !== nextFocusEntryId;
    if (accountScopeChanged || focusEntryChanged) {
      lastAccountScopeKeyRef.current = accountScopeKey;
      lastFocusEntryIdRef.current = nextFocusEntryId;
      const storedPreference = nextFocusEntryId ? null : readStoredDetailPreference(accountId);
      const nextPageSize = nextFocusEntryId ? normalizedInitialPageSize : storedPreference?.pageSize ?? normalizedInitialPageSize;
      const nextDetailAll = nextFocusEntryId ? initialDetailAll : storedPreference?.detailAll ?? initialDetailAll;
      const nextTotalPages = Math.max(1, Math.ceil(totalCount / nextPageSize));
      setPageSize(nextPageSize);
      setDetailAll(nextDetailAll);
      setPage(nextDetailAll ? 1 : clampPage(storedPreference?.detailPage ?? initialPage, nextTotalPages));
    }
  }, [accountId, accountScopeKey, entries, focusEntryId, initialDetailAll, initialPage, normalizedInitialPageSize, originalCount, totalCount]);

  // 当整页被删空时，标记需要从远程补页，详情见 FINANCE_DATA_CHANGED_EVENT handler
  const deletedPageEmptiedRef = useRef(false);

  useEffect(() => {
    const handleFinanceChange = (event: Event) => {
      const detail = (event as CustomEvent<FinanceDataChangedDetail>).detail ?? {};
      const eventAccountIds = detail.accountIds ?? [];
      const isCurrentAccountEvent = eventAccountIds.length === 0 || eventAccountIds.includes(accountId);
      if (
        event.type === FINANCE_DATA_CHANGED_EVENT &&
        detail.reason === "view-normal-excel-import" &&
        isCurrentAccountEvent
      ) {
        reloadDetailPage();
        return;
      }

      const deletedEntryIds = detail.deletedEntryIds ?? [];
      if (deletedEntryIds.length === 0) return;
      const deletedSet = new Set(deletedEntryIds);
      const currentEntries = localEntriesRef.current;
      const currentTotal = localTotalCountRef.current;
      // 同步计算过滤结果，用于决定是否需要触发补页
      let nextTotalCount = currentTotal;
      for (let i = 0; i < currentEntries.length; i++) {
        if (deletedSet.has(currentEntries[i].id)) {
          nextTotalCount = Math.max(0, nextTotalCount - 1);
        }
      }
      const currentPageEntriesCount = currentEntries.reduce(
        (sum, entry) => (deletedSet.has(entry.id) ? sum : sum + 1),
        0,
      );
      const emptiedCurrentPage = currentPageEntriesCount === 0 && currentEntries.length > 0;

      setLocalEntries((current) => current.filter((entry) => !deletedSet.has(entry.id)));
      setLocalTotalCount(nextTotalCount);
      setLocalOriginalCount(nextTotalCount);

      // 整页被清空时，后续记录应顶上来：退回上一页并由补页 effect 拉取数据
      if (emptiedCurrentPage && !detailAll) {
        const nextTotalPages = Math.max(1, Math.ceil(nextTotalCount / pageSize));
        // 如果当前页已超出新范围，退回一页；保持当前页时 safePage 不变也要触发 reload
        if (safePage > nextTotalPages && safePage > 1) {
          setPage((p) => p - 1);
        }
        deletedPageEmptiedRef.current = true;
      }
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handleFinanceChange);
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handleFinanceChange);
    };
  }, [accountId, detailAll, pageSize, reloadDetailPage, safePage]);

  // 配合 deletedPageEmptiedRef：ref 为 true 时触发一次远程补页，然后重置 ref
  useEffect(() => {
    if (!deletedPageEmptiedRef.current) return;
    if (!clientPaginationEnabled) return;
    deletedPageEmptiedRef.current = false;
    reloadDetailPage();
  }, [clientPaginationEnabled, reloadDetailPage, safePage]);

  useEffect(() => {
    if (detailAll || page === safePage) return;
    setPage(safePage);
  }, [detailAll, page, safePage]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "detail");
    url.searchParams.set("pageSize", String(pageSize));
    if (detailAll) {
      url.searchParams.set("detailAll", "1");
      url.searchParams.delete("detailPage");
    } else {
      url.searchParams.delete("detailAll");
      url.searchParams.set("detailPage", String(safePage));
    }
    writeStoredDetailPreference(accountId, pageSize, detailAll, safePage);
    const nextHref = `${url.pathname}${url.search}${url.hash}`;
    const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextHref !== currentHref) {
      if (clientPaginationEnabled) {
        window.history.replaceState(window.history.state, "", nextHref);
      } else {
        router.replace(nextHref, { scroll: false });
      }
    }
  }, [accountId, clientPaginationEnabled, detailAll, pageSize, router, safePage]);

  useEffect(() => {
    if (!clientPaginationEnabled) return;
    const key = detailPaginationFetchKey(accountId, pageSize, detailAll, safePage);
    if (!lastClientPaginationKeyRef.current) {
      lastClientPaginationKeyRef.current = key;
      return;
    }
    if (lastClientPaginationKeyRef.current === key) return;
    lastClientPaginationKeyRef.current = key;

    const controller = new AbortController();
    reloadDetailPage(controller.signal);

    return () => controller.abort();
  }, [accountId, clientPaginationEnabled, detailAll, pageSize, reloadDetailPage, safePage]);

  const pageEntries = useMemo(() => localEntries, [localEntries]);
  const handleDisplayRowsChange = useCallback((rows: DetailEntry[]) => {
    const nextIds = rows.map((entry) => entry.id);
    setDisplayedEntryIds((current) => {
      if (!current) return nextIds;
      if (current.length !== nextIds.length) return nextIds;
      const currentIds = new Set(current);
      if (nextIds.every((id) => currentIds.has(id))) return current;
      return nextIds;
    });
  }, []);
  const visibleNormalExportRows = useMemo(() => {
    if (!normalExportRowsByEntryId || displayedEntryIds === null || displayedEntryIds.length === pageEntries.length) return normalExportRows;
    const [header = []] = normalExportRows;
    const rows = displayedEntryIds
      .map((id) => normalExportRowsByEntryId[id])
      .filter((row): row is string[] => Array.isArray(row));
    return [header, ...rows];
  }, [displayedEntryIds, normalExportRows, normalExportRowsByEntryId, pageEntries.length]);

  const setPagedSize = (nextPageSize: number) => {
    setDetailAll(false);
    setPageSize(nextPageSize);
    setPage(1);
  };

  const showAll = () => {
    setDetailAll(true);
    setPage(1);
  };

  const goPage = (nextPage: number) => {
    if (detailAll) return;
    setPage(clampPage(nextPage, totalPages));
  };

  const canPrev = !detailAll && safePage > 1;
  const canNext = !detailAll && safePage < totalPages;
  const selectionResetKey = accountScopeKey;
  const tableResetKey = `${selectionResetKey}:${detailAll ? "all" : safePage}:${pageSize}`;
  const closeGuideOverlay = () => {
    setGuideOverlayOpen(false);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("guide");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const guideWidth = guideMetrics?.width ?? 1024;
  const guideHeight = guideMetrics?.height ?? 560;
  const headerTargetRect = guideMetrics?.headerCell ?? guideMetrics?.header ?? null;

  return (
    <BasicDetailSelectionProvider resetKey={selectionResetKey}>
      <BasicDetailBatchDeleteMessage />
      <div ref={panelRef} className="relative flex-1 min-h-0 overflow-hidden">
        <div className="flex min-h-12 items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 md:hidden">
          <span className="text-xs text-slate-500">{t("creditBillDetail.recordCount", { count: localTotalCount })}</span>
          {showPagination ? (
            <DetailTablePaginationControls
              pageSize={pageSize}
              pageSizeOptions={DETAIL_PAGE_SIZE_OPTIONS}
              detailAll={detailAll}
              safePage={safePage}
              totalPages={totalPages}
              canPrev={canPrev}
              canNext={canNext}
              onPageSizeChange={setPagedSize}
              onShowAll={showAll}
              onPageChange={goPage}
            />
          ) : null}
        </div>
        <DetailViewClient
          accountId={accountId}
          isInvestAccount={isInvestAccount}
          initialEntries={pageEntries}
          accountOptions={accountOptions}
          categoryOptions={categoryOptions}
          tagOptions={tagOptions}
          investmentProductTypeByAccountId={investmentProductTypeByAccountId}
          compactRows={compactRows}
          resetKey={tableResetKey}
          focusEntryId={focusEntryId}
          showAccountColumn={showAccountColumn}
          toolbarMode="custom"
          toolbarTitle={t("basicDetail.entriesTitle")}
          showRunningBalance={showRunningBalance ?? !isInvestAccount}
          refreshOnGlobalEvent={refreshOnGlobalEvent}
          draggableRows={draggableRows}
          sortable={sortable}
          toolbarRightContent={
            <div className="flex items-center gap-2 text-xs">
              <span className="text-xs text-slate-600">{t("creditBillDetail.recordCount", { count: localTotalCount })}{hasDetailFilters ? t("basicDetail.filteredSuffix", { count: localOriginalCount }) : ""}{isPageLoading ? t("basicDetail.loadingSuffix") : ""}</span>
              {showImportExport ? (
                <>
                  <span className="text-slate-400">|</span>
                  <ViewExcelImportMenuButton
                    kind="normal"
                    accountId={accountId}
                    accountName={accountName || accountLabel || t("basicDetail.currentAccount")}
                    mailImport={{
                      accountId,
                      accountName: accountName || accountLabel || t("basicDetail.currentAccount"),
                    }}
                    excelExport={{
                      rows: visibleNormalExportRows,
                      filename: normalExportFilename,
                      sheetName: t("basicDetail.entriesTitle"),
                      title: t("basicDetail.exportExcelTitle"),
                      description: accountKind === "bank_credit" ? t("basicDetail.exportCreditDesc") : t("basicDetail.exportNormalDesc"),
                      dateColumnIndex: 0,
                    }}
                    dataBasicDetailImport
                  />
                </>
              ) : null}
              {showBalanceReconcile ? (
                <DebitBalanceReconcileButton
                  accountId={accountId}
                  accountLabel={accountLabel}
                  currentBalance={currentBalance}
                />
              ) : null}
              {showPagination ? (
                <>
                  <span className="text-slate-400">|</span>
                  <DetailTablePaginationControls
                    pageSize={pageSize}
                    pageSizeOptions={DETAIL_PAGE_SIZE_OPTIONS}
                    detailAll={detailAll}
                    safePage={safePage}
                    totalPages={totalPages}
                    canPrev={canPrev}
                    canNext={canNext}
                    onPageSizeChange={setPagedSize}
                    onShowAll={showAll}
                    onPageChange={goPage}
                  />
                </>
              ) : null}
            </div>
          }
          onDisplayRowsChange={handleDisplayRowsChange}
        />
        {guideOverlayOpen && guidePortalHost ? createPortal((
          <div className="pointer-events-none fixed inset-0 z-[80] hidden overflow-hidden md:block" aria-live="polite">
            <div className="absolute inset-0 bg-slate-900/[0.02]" />
            <GuideHotspot
              rect={guideMetrics?.entryButton ?? null}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              title={t("basicDetail.guide.entry.title")}
            >
              {t("basicDetail.guide.entry.text")}
            </GuideHotspot>
            <GuideHotspot
              rect={guideMetrics?.toolbarTools ?? null}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              title={t("basicDetail.guide.importExport.title")}
            >
              {t("basicDetail.guide.importExport.text")}
            </GuideHotspot>
            <GuideHotspot
              rect={headerTargetRect}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              title={t("basicDetail.guide.headerSort.title")}
            >
              {t("basicDetail.guide.headerSort.text")}
            </GuideHotspot>
            <GuideHotspot
              rect={guideMetrics?.rowControls ?? null}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              title={t("basicDetail.guide.dragSelect.title")}
            >
              {t("basicDetail.guide.dragSelect.text")}
            </GuideHotspot>
            <GuideHotspot
              rect={guideMetrics?.bodyRowFocus ?? null}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              title={t("basicDetail.guide.doubleClickEdit.title")}
            >
              {t("basicDetail.guide.doubleClickEdit.text")}
            </GuideHotspot>
            <GuideHotspot
              rect={guideMetrics?.rowActions ?? null}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              title={t("basicDetail.guide.rowActions.title")}
            >
              {t("basicDetail.guide.rowActions.text")}
            </GuideHotspot>
            <GuideHotspot
              rect={guideMetrics?.resizeHandle ?? null}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              tone="emerald"
              title={t("basicDetail.guide.resizeColumn.title")}
            >
              {t("basicDetail.guide.resizeColumn.text")}
            </GuideHotspot>
            <GuideHotspot
              rect={guideMetrics?.columnSettings ?? null}
              guideWidth={guideWidth}
              guideHeight={guideHeight}
              tone="emerald"
              title={t("basicDetail.guide.columnSettings.title")}
            >
              {t("basicDetail.guide.columnSettings.text")}
            </GuideHotspot>

            <button
              type="button"
              onClick={closeGuideOverlay}
              className="pointer-events-auto absolute bottom-5 right-5 z-40 flex h-7 items-center gap-1.5 rounded-md border border-slate-200/80 bg-white/[0.74] px-2 text-xs font-medium text-slate-600 shadow-sm backdrop-blur-sm transition-colors hover:bg-white/90 hover:text-slate-900"
              title={t("basicDetail.guide.close")}
            >
              <X className="h-3.5 w-3.5" />
              {t("basicDetail.guide.close")}
            </button>
          </div>
        ), guidePortalHost) : null}
      </div>
    </BasicDetailSelectionProvider>
  );
}
