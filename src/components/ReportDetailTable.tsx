"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { BasicDetailBatchDeleteMessage, BasicDetailSelectionProvider } from "@/components/BasicDetailSelection";
import type { BasicDetailBatchCategoryOption } from "@/components/BasicDetailSelection";
import type { BatchReplaceField } from "@/lib/client/batchReplaceEntries";
import { DetailTablePaginationControls } from "@/components/DetailTablePaginationControls";
import { DetailViewClient, type DetailEntry } from "@/components/DetailViewClient";
import { formatMoney } from "@/lib/format";
import { FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";
import { getColorSchemeFromCookie, pnlColor } from "@/lib/client/colors";
import { useI18n } from "@/lib/i18n";

type AccountOption = {
  id: string;
  label: string;
  kind?: string | null;
  debtDirection?: string | null;
};

const PAGE_SIZE_OPTIONS = [10, 20, 40] as const;
const REPORT_BATCH_REPLACE_FIELDS: BatchReplaceField[] = [
  "date",
  "postedAt",
  "type",
  "outflow",
  "inflow",
  "account",
  "toAccount",
  "categoryId",
  "institution",
  "tagId",
  "remark",
];

function clampPage(page: number, totalPages: number) {
  return Math.min(Math.max(1, page), totalPages);
}

export function ReportDetailTable({
  accountId,
  entries,
  accountOptions,
  categoryOptions,
  tagOptions = [],
  investmentProductTypeByAccountId,
  title,
  total,
  colorValue,
  clearHref,
  onClear,
  onRefresh,
  resetKey,
}: {
  accountId: string;
  entries: DetailEntry[];
  accountOptions: AccountOption[];
  categoryOptions: BasicDetailBatchCategoryOption[];
  tagOptions?: BasicDetailBatchCategoryOption[];
  investmentProductTypeByAccountId: Record<string, string | null | undefined>;
  title: string;
  total: number;
  colorValue: number;
  clearHref?: string;
  onClear?: () => void;
  onRefresh?: () => void | DetailEntry[] | Promise<void | DetailEntry[]>;
  resetKey: string;
}) {
  const colorScheme = typeof document === "undefined"
    ? "red_up_green_down"
    : getColorSchemeFromCookie(document.cookie ?? null);
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const [showAll, setShowAll] = useState(false);
  const [displayEntries, setDisplayEntries] = useState(entries);
  const { t } = useI18n();
  const totalPages = Math.max(1, Math.ceil(displayEntries.length / pageSize));
  const safePage = showAll ? 1 : clampPage(page, totalPages);
  const pageEntries = useMemo(
    () => showAll ? displayEntries : displayEntries.slice((safePage - 1) * pageSize, safePage * pageSize),
    [displayEntries, pageSize, safePage, showAll],
  );

  useEffect(() => {
    setDisplayEntries(entries);
  }, [entries]);

  useEffect(() => {
    setPage(1);
    setShowAll(false);
  }, [resetKey]);

  useEffect(() => {
    if (!showAll && page !== safePage) setPage(safePage);
  }, [page, safePage, showAll]);

  useEffect(() => {
    let timer: number | null = null;
    let refreshSeq = 0;
    const refresh = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        const seq = ++refreshSeq;
        try {
          const refreshedEntries = await onRefresh?.();
        if (Array.isArray(refreshedEntries) && seq === refreshSeq) {
          setDisplayEntries(refreshedEntries);
        }
      } catch {
          // Keep the current view stable; the user can refresh the page manually if needed.
        }
      }, 100);
    };
    const editSuccessEvents = [
      "mmh:transaction:edit:success",
      "mmh:investment:edit:success",
      "mmh:wealth:edit:success",
      "mmh:deposit:edit:success",
      "mmh:insurance:edit:success",
    ];
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
    editSuccessEvents.forEach((eventName) => window.addEventListener(eventName, refresh));
    return () => {
      if (timer != null) window.clearTimeout(timer);
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
      editSuccessEvents.forEach((eventName) => window.removeEventListener(eventName, refresh));
    };
  }, [onRefresh]);

  return (
    <BasicDetailSelectionProvider resetKey={resetKey}>
      <BasicDetailBatchDeleteMessage />
      <div className="min-h-0 flex-1 overflow-hidden">
        <DetailViewClient
          accountId={accountId}
          isInvestAccount={false}
          initialEntries={pageEntries}
          accountOptions={accountOptions}
          categoryOptions={categoryOptions}
          tagOptions={tagOptions}
          investmentProductTypeByAccountId={investmentProductTypeByAccountId}
          storageKey="mmh_report_detail_table_v1"
          refreshOnGlobalEvent={false}
          toolbarMode="custom"
          batchReplaceFields={REPORT_BATCH_REPLACE_FIELDS}
          toolbarTitle={(
            <span className="flex min-w-0 items-center">
              <span className="truncate text-xs font-normal text-slate-600" title={title}>{title}</span>
            </span>
          )}
          toolbarRightContent={(
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span>{t("reportDetail.entryCountTotal", { count: displayEntries.length })} <strong className={`tabular-nums ${pnlColor(colorValue, colorScheme)}`}>{formatMoney(total)}</strong></span>
              {onClear ? (
                <button type="button" onClick={onClear} className="text-blue-600 hover:text-blue-800 hover:underline">{t("reportDetail.clearDetails")}</button>
              ) : clearHref ? (
                <Link href={clearHref} className="text-blue-600 hover:text-blue-800 hover:underline">{t("reportDetail.clearDetails")}</Link>
              ) : null}
              <span className="text-slate-300">|</span>
              <DetailTablePaginationControls
                pageSize={pageSize}
                pageSizeOptions={PAGE_SIZE_OPTIONS}
                detailAll={showAll}
                safePage={safePage}
                totalPages={totalPages}
                canPrev={!showAll && safePage > 1}
                canNext={!showAll && safePage < totalPages}
                onPageSizeChange={(nextPageSize) => {
                  setPageSize(nextPageSize);
                  setPage(1);
                  setShowAll(false);
                }}
                onShowAll={() => {
                  setShowAll(true);
                  setPage(1);
                }}
                onPageChange={(nextPage) => {
                  if (showAll) return;
                  setPage(clampPage(nextPage, totalPages));
                }}
              />
            </div>
          )}
          resetKey={resetKey}
          draggableRows={false}
          showAccountColumn
          showRunningBalance={false}
          enableAccountNavigation
        />
      </div>
    </BasicDetailSelectionProvider>
  );
}
