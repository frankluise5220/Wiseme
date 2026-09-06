"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

import { BasicDetailBatchDeleteMessage, BasicDetailSelectionProvider, type BasicDetailBatchCategoryOption } from "@/components/BasicDetailSelection";
import { DetailTablePaginationControls } from "@/components/DetailTablePaginationControls";
import { DetailViewClient, type DetailEntry } from "@/components/DetailViewClient";
import type { BatchReplaceField } from "@/lib/client/batchReplaceEntries";
import { CREDIT_BILL_DETAIL_SELECTION_EVENT, type CreditBillDetailSelectionDetail } from "@/lib/client/creditBillDetailSelection";
import { useI18n } from "@/lib/i18n";
import { FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";
import {
  DETAIL_PAGE_SIZE_OPTIONS,
  clampDetailPage as clampPage,
  normalizeDetailPageSize,
  readStoredDetailPreference,
  writeStoredDetailPreference,
} from "@/lib/detail-pagination-preference";

type CreditBillDetailPanelProps = {
  accountId: string;
  reorderAccountIds?: string[];
  showCardColumn?: boolean;
  entries: DetailEntry[];
  initialPage: number;
  initialPageSize: number;
  initialDetailAll: boolean;
  resetKey: string;
  selectedBillMonth: string;
  title: ReactNode;
  accountOptions: Array<{ id: string; label: string; fullLabel?: string | null; title?: string | null; kind?: string | null; debtDirection?: string | null; numberMasked?: string | null }>;
  categoryOptions?: BasicDetailBatchCategoryOption[];
  tagOptions?: BasicDetailBatchCategoryOption[];
  investmentProductTypeByAccountId: Record<string, string | undefined | null>;
};

const CREDIT_BILL_BATCH_REPLACE_FIELDS: BatchReplaceField[] = [
  "date",
  "postedAt",
  "type",
  "outflow",
  "inflow",
  "amount",
  "viewAccount",
  "toAccount",
  "categoryId",
  "institution",
  "tagId",
  "remark",
];

type CreditBillDetailPayload = {
  ok?: boolean;
  error?: string;
  data?: {
    billMonth?: string;
    showAllDetails?: boolean;
    totalCount?: number;
    entries?: DetailEntry[];
    cycle?: {
      statementMonth?: string;
      periodLabel?: string;
      isCurrentCycle?: boolean;
    } | null;
  };
};

export function CreditBillDetailPanel({
  accountId,
  reorderAccountIds,
  showCardColumn = false,
  entries,
  initialPage,
  initialPageSize,
  initialDetailAll,
  resetKey,
  selectedBillMonth,
  title,
  accountOptions,
  categoryOptions = [],
  tagOptions = [],
  investmentProductTypeByAccountId,
}: CreditBillDetailPanelProps) {
  const router = useRouter();
  const { t } = useI18n();
  const normalizedInitialPageSize = normalizeDetailPageSize(initialPageSize);
  const [localEntries, setLocalEntries] = useState(entries);
  const [pageSize, setPageSize] = useState(normalizedInitialPageSize);
  const [detailAll, setDetailAll] = useState(initialDetailAll);
  const [isSwitchLoading, setIsSwitchLoading] = useState(false);
  const [clientTitle, setClientTitle] = useState(title);
  const [clientScopeKey, setClientScopeKey] = useState(resetKey || `${accountId}:credit-bill-detail`);
  const totalPages = Math.max(1, Math.ceil(localEntries.length / pageSize));
  const [page, setPage] = useState(() => initialDetailAll ? 1 : clampPage(initialPage, totalPages));
  const safePage = detailAll ? 1 : clampPage(page, totalPages);
  const propScopeKey = resetKey || `${accountId}:credit-bill-detail`;
  const scopeKey = clientScopeKey;
  const lastScopeKeyRef = useRef(scopeKey);
  const selectionFetchSeqRef = useRef(0);

  useEffect(() => {
    setLocalEntries(entries);
    setClientTitle(title);
    setClientScopeKey(propScopeKey);
    if (lastScopeKeyRef.current !== propScopeKey) {
      lastScopeKeyRef.current = propScopeKey;
      const storedPreference = readStoredDetailPreference(accountId);
      const nextPageSize = storedPreference?.pageSize ?? normalizedInitialPageSize;
      // When the scope is a specific bill month (not "all"), show that
      // month's details rather than the persisted "show all" preference.
      const isAllScope = /:all:credit-bill-detail$/.test(propScopeKey);
      const nextDetailAll = isAllScope ? (storedPreference?.detailAll ?? initialDetailAll) : false;
      const nextTotalPages = Math.max(1, Math.ceil(entries.length / nextPageSize));
      setPageSize(nextPageSize);
      setDetailAll(nextDetailAll);
      setPage(nextDetailAll ? 1 : clampPage(storedPreference?.detailPage ?? initialPage, nextTotalPages));
    }
  }, [accountId, entries, initialDetailAll, initialPage, normalizedInitialPageSize, propScopeKey, selectedBillMonth, title]);

  useEffect(() => {
    const handleSelection = (event: Event) => {
      const detail = (event as CustomEvent<CreditBillDetailSelectionDetail>).detail;
      if (!detail?.accountId || detail.accountId !== accountId) return;
      const billMonth = detail.billMonth || "all";
      const seq = ++selectionFetchSeqRef.current;
      const params = new URLSearchParams({ accountId, billMonth });
      setIsSwitchLoading(true);
      fetch(`/api/v1/bill/details?${params.toString()}`, { cache: "no-store" })
        .then(async (response) => {
          const payload = await response.json().catch(() => null) as CreditBillDetailPayload | null;
          if (!response.ok || !payload?.ok) {
            throw new Error(payload?.error ?? t("basicDetail.loadFailed"));
          }
          if (seq !== selectionFetchSeqRef.current) return;
          const nextEntries = Array.isArray(payload.data?.entries) ? payload.data.entries : [];
          const storedPreference = readStoredDetailPreference(accountId);
          const nextPageSize = storedPreference?.pageSize ?? pageSize;
          // Switching to a specific bill month should show that month's
          // details, not the persisted "show all" preference. Only the page
          // size preference carries over; detailAll resets to false so the
          // user sees the selected period's transactions.
          const nextDetailAll = false;
          const nextTotalPages = Math.max(1, Math.ceil(nextEntries.length / nextPageSize));
          setLocalEntries(nextEntries);
          setPageSize(nextPageSize);
          setDetailAll(nextDetailAll);
          setPage(nextDetailAll ? 1 : clampPage(storedPreference?.detailPage ?? 1, nextTotalPages));
          setClientScopeKey(`${accountId}:${billMonth}:credit-bill-detail`);
          if (payload.data?.showAllDetails) {
            setClientTitle(t("creditBill.allDetails"));
          } else {
            const cycle = payload.data?.cycle;
            const statementMonth = cycle?.statementMonth || billMonth;
            setClientTitle(t("creditBill.detailTitleWithMonth", { month: statementMonth }));
          }
        })
        .catch((error) => {
          console.error("Load credit bill details failed:", error);
          router.replace(detail.href, { scroll: false });
        })
        .finally(() => {
          if (seq === selectionFetchSeqRef.current) setIsSwitchLoading(false);
        });
    };
    window.addEventListener(CREDIT_BILL_DETAIL_SELECTION_EVENT, handleSelection as EventListener);
    return () => window.removeEventListener(CREDIT_BILL_DETAIL_SELECTION_EVENT, handleSelection as EventListener);
  }, [accountId, detailAll, pageSize, router, t]);

  useEffect(() => {
    const handleFinanceChange = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: string; accountIds?: string[]; deletedEntryIds?: string[] }>).detail;
      if (detail?.reason === "bill-override" || detail?.reason === "bill-override-reset") return;
      const accountIds = detail?.accountIds ?? [];
      if (accountIds.length > 0 && !accountIds.includes(accountId)) return;
      // The bill-month selector uses the browser history API for a lightweight
      // client-side switch. Refreshing through the router alone can therefore
      // use an older router URL and fall back to an empty/current bill scope.
      // Re-submit the URL currently visible in the address bar so the selected
      // bill month remains part of the server-render request.
      const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      router.replace(currentHref, { scroll: false });
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handleFinanceChange);
    return () => window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handleFinanceChange);
  }, [accountId, router]);

  useEffect(() => {
    if (detailAll || page === safePage) return;
    setPage(safePage);
  }, [detailAll, page, safePage]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", "bill");
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
    if (nextHref !== currentHref) window.history.replaceState(window.history.state, "", nextHref);
  }, [accountId, detailAll, pageSize, safePage]);

  const pageEntries = useMemo(
    () => detailAll ? localEntries : localEntries.slice((safePage - 1) * pageSize, safePage * pageSize),
    [detailAll, localEntries, pageSize, safePage],
  );

  const setPagedSize = (nextPageSize: number) => {
    setDetailAll(false);
    setPageSize(nextPageSize);
    setPage(1);
  };

  const showAll = () => {
    setDetailAll(true);
    setPage(1);
  };

  const showAllBillDetails = () => {
    if (!selectedBillMonth) return;
    const url = new URL(window.location.href);
    url.searchParams.set("view", "bill");
    url.searchParams.set("billMonth", "all");
    router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false });
  };

  const goPage = (nextPage: number) => {
    if (detailAll) return;
    setPage(clampPage(nextPage, totalPages));
  };

  const canPrev = !detailAll && safePage > 1;
  const canNext = !detailAll && safePage < totalPages;
  const tableResetKey = `${scopeKey}:${detailAll ? "all" : safePage}:${pageSize}`;

  return (
    <BasicDetailSelectionProvider resetKey={scopeKey}>
      <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
        <BasicDetailBatchDeleteMessage />
        <DetailViewClient
          accountId={accountId}
          isInvestAccount={false}
          initialEntries={pageEntries}
          accountOptions={accountOptions}
          categoryOptions={categoryOptions}
          tagOptions={tagOptions}
          investmentProductTypeByAccountId={investmentProductTypeByAccountId}
          showAccountColumn={showCardColumn}
          accountColumnLabel={t("creditBillDetail.accountNo")}
          accountColumnMode="cardLast4"
          accountColumnDefaultHidden
          relatedAccountDefaultHidden
          showRunningBalance={false}
          reorderAccountIds={reorderAccountIds}
          storageKey="mmh_credit_bill_detail_table_v1"
          resetKey={tableResetKey}
          refreshOnGlobalEvent={false}
          toolbarMode="custom"
          batchReplaceFields={CREDIT_BILL_BATCH_REPLACE_FIELDS}
          toolbarTitle={clientTitle}
          toolbarRightContent={
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-xs text-slate-500 tabular-nums">
              <button
                type="button"
                onClick={showAllBillDetails}
                disabled={!selectedBillMonth}
                className={`inline-flex h-7 items-center rounded-md border px-2 text-xs ${
                  selectedBillMonth
                    ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                    : "border-blue-300 bg-blue-50 text-blue-700"
                }`}
              >
                {t("creditBill.showAllDetails")}
              </button>
              <span className="whitespace-nowrap text-slate-600">
                {t("creditBillDetail.recordCount", { count: localEntries.length })}
                {isSwitchLoading ? t("basicDetail.loadingSuffix") : ""}
              </span>
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
            </div>
          }
          emptyText={t("detail.empty")}
        />
      </div>
    </BasicDetailSelectionProvider>
  );
}
