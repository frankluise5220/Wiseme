"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { ReportDetailTable } from "@/components/ReportDetailTable";
import { ReportResizableSplit } from "@/components/ReportResizableSplit";
import type { BasicDetailBatchCategoryOption } from "@/components/BasicDetailSelection";
import type { DetailEntry } from "@/components/DetailViewClient";
import { formatMoney } from "@/lib/format";
import { pnlColor, type ColorScheme } from "@/lib/client/colors";
import { useI18n } from "@/lib/i18n";
import type {
  IncomeExpenseGroupBy,
  IncomeExpenseReport,
  IncomeExpenseReportDetails,
  IncomeExpenseReportDetailType,
  IncomeExpenseReportRow,
} from "@/lib/server/income-expense-report";

type AccountOption = {
  id: string;
  label: string;
  kind?: string | null;
  debtDirection?: string | null;
};

type ReportQuery = {
  start: string;
  end: string;
  accountId: string;
  groupBy: IncomeExpenseGroupBy;
  institutionId?: string;
  userIds?: string[];
};

type DetailSelection = {
  type: IncomeExpenseReportDetailType;
  categoryKey?: string;
  columnKey?: string;
};

type DetailResponse = {
  ok?: boolean;
  data?: {
    details: IncomeExpenseReportDetails | null;
    entries: DetailEntry[];
  };
  error?: string;
};

function buildDetailSearch(query: ReportQuery, detail: DetailSelection) {
  const params = new URLSearchParams();
  params.set("start", query.start);
  params.set("end", query.end);
  params.set("groupBy", query.groupBy);
  if (query.accountId) params.set("accountId", query.accountId);
  if (query.institutionId) params.set("institutionId", query.institutionId);
  if (query.userIds?.length) params.set("userIds", query.userIds.join(","));
  params.set("detailType", detail.type);
  if (detail.categoryKey) params.set("detailCategoryKey", detail.categoryKey);
  if (detail.columnKey) params.set("detailColumnKey", detail.columnKey);
  return params;
}

function buildClearUrl(query: ReportQuery) {
  const params = new URLSearchParams();
  params.set("groupBy", query.groupBy);
  if (query.accountId) params.set("accountId", query.accountId);
  if (query.institutionId) params.set("institutionId", query.institutionId);
  if (query.userIds?.length) params.set("userIds", query.userIds.join(","));
  if (query.groupBy === "month") {
    params.set("startMonth", query.start.slice(0, 7));
    params.set("endMonth", query.end.slice(0, 7));
  } else {
    params.set("startYear", query.start.slice(0, 4));
    params.set("endYear", query.end.slice(0, 4));
  }
  return `/reports?${params.toString()}`;
}

function detailKey(detail: DetailSelection) {
  return `${detail.type}:${detail.categoryKey ?? "all"}:${detail.columnKey ?? "all"}`;
}

function activeDetailKey(details: IncomeExpenseReportDetails | null) {
  if (!details) return "";
  return `${details.type}:${details.categoryKey ?? "all"}:${details.columnKey ?? "all"}`;
}

function rowHasChildren(rows: IncomeExpenseReportRow[], index: number) {
  return (rows[index + 1]?.depth ?? -1) > rows[index].depth;
}

function createVisibleReportRows(rows: IncomeExpenseReportRow[], expandedRows: Set<string>) {
  const ancestors: IncomeExpenseReportRow[] = [];
  return rows
    .map((row, index) => {
      while (ancestors.length > 0 && ancestors[ancestors.length - 1].depth >= row.depth) {
        ancestors.pop();
      }
      const visible = row.depth === 0 || ancestors.every((ancestor) => expandedRows.has(ancestor.key));
      const item = {
        row,
        visible,
        canToggle: rowHasChildren(rows, index),
        expanded: expandedRows.has(row.key),
      };
      ancestors.push(row);
      return item;
    })
    .filter((item) => item.visible);
}

const REPORT_SECTION_STYLES = {
  red: {
    row: "bg-red-50/70",
    label: "sticky left-0 z-10 border-b border-r border-red-100 bg-red-50/70 px-4 py-2 text-sm font-semibold text-red-700",
    cell: "border-b border-r border-red-100 px-3 py-2 text-right text-xs font-semibold tabular-nums text-red-700",
  },
  emerald: {
    row: "bg-emerald-50/70",
    label: "sticky left-0 z-10 border-b border-r border-emerald-100 bg-emerald-50/70 px-4 py-2 text-sm font-semibold text-emerald-700",
    cell: "border-b border-r border-emerald-100 px-3 py-2 text-right text-xs font-semibold tabular-nums text-emerald-700",
  },
} as const;

function AmountButton({
  value,
  count,
  detail,
  className = "",
  loadingKey,
  onSelect,
}: {
  value: number;
  count: number;
  detail: DetailSelection;
  className?: string;
  loadingKey: string | null;
  onSelect: (detail: DetailSelection) => void;
}) {
  const { t } = useI18n();
  if (count === 0) return <span className={className}>{formatMoney(value)}</span>;
  const key = detailKey(detail);
  const loading = loadingKey === key;
  return (
    <button
      type="button"
      onClick={() => onSelect(detail)}
      disabled={loading}
      className={`${className} inline appearance-none border-0 bg-transparent p-0 text-inherit font-[inherit] cursor-pointer decoration-dotted underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:cursor-wait disabled:opacity-60`}
      title={t("incomeExpense.detailCount", { count })}
    >
      {formatMoney(value)}
    </button>
  );
}

export function IncomeExpenseReportClient({
  report,
  initialDetailEntries,
  currentReportQuery,
  colorScheme,
  accountId,
  accountOptions,
  categoryOptions,
  tagOptions = [],
  investmentProductTypeByAccountId,
}: {
  report: IncomeExpenseReport;
  initialDetailEntries: DetailEntry[];
  currentReportQuery: ReportQuery;
  colorScheme: ColorScheme;
  accountId: string;
  accountOptions: AccountOption[];
  categoryOptions: BasicDetailBatchCategoryOption[];
  tagOptions?: BasicDetailBatchCategoryOption[];
  investmentProductTypeByAccountId: Record<string, string | null | undefined>;
}) {
  const [activeDetails, setActiveDetails] = useState<IncomeExpenseReportDetails | null>(report.details);
  const [detailEntries, setDetailEntries] = useState<DetailEntry[]>(initialDetailEntries);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [expandedCategoryRows, setExpandedCategoryRows] = useState<Set<string>>(() => new Set());
  const { t } = useI18n();
  const reportContextKey = useMemo(
    () => `${report.start}:${report.end}:${report.groupBy}:${accountId}`,
    [accountId, report.end, report.groupBy, report.start],
  );
  const reportContextRef = useRef(reportContextKey);
  const hasClientDetailSelectionRef = useRef(false);
  const clientDetailKeyRef = useRef<string | null>(null);
  const detailRequestSequenceRef = useRef(0);

  useEffect(() => {
    const contextChanged = reportContextRef.current !== reportContextKey;
    if (contextChanged) {
      reportContextRef.current = reportContextKey;
      hasClientDetailSelectionRef.current = false;
      clientDetailKeyRef.current = null;
      setActiveDetails(report.details);
      setDetailEntries(initialDetailEntries);
      setLoadingKey(null);
      setExpandedCategoryRows(new Set());
      return;
    }

    if (hasClientDetailSelectionRef.current) {
      if (!report.details || activeDetailKey(report.details) !== clientDetailKeyRef.current) return;
      hasClientDetailSelectionRef.current = false;
      clientDetailKeyRef.current = null;
    }
    setActiveDetails(report.details);
    setDetailEntries(initialDetailEntries);
    setLoadingKey(null);
  }, [initialDetailEntries, report.details, reportContextKey]);

  const visibleIncomeRows = useMemo(
    () => createVisibleReportRows(report.income.rows, expandedCategoryRows),
    [expandedCategoryRows, report.income.rows],
  );
  const visibleExpenseRows = useMemo(
    () => createVisibleReportRows(report.expense.rows, expandedCategoryRows),
    [expandedCategoryRows, report.expense.rows],
  );

  function toggleCategoryRow(rowKey: string) {
    setExpandedCategoryRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }

  async function selectDetail(detail: DetailSelection) {
    const key = detailKey(detail);
    const requestSequence = ++detailRequestSequenceRef.current;
    setLoadingKey(key);
    try {
      const params = buildDetailSearch(currentReportQuery, detail);
      const res = await fetch(`/api/v1/reports/income-expense/detail?${params.toString()}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as DetailResponse | null;
      if (!res.ok || !data?.ok || !data.data) {
        throw new Error(data?.error ?? t("incomeExpense.queryFailed"));
      }
      if (requestSequence !== detailRequestSequenceRef.current) return;
      if (!data.data.details) throw new Error(t("incomeExpense.noDetailsForFilter"));
      hasClientDetailSelectionRef.current = true;
      clientDetailKeyRef.current = activeDetailKey(data.data.details);
      setActiveDetails(data.data.details);
      setDetailEntries(data.data.entries ?? []);
      window.history.replaceState(window.history.state, "", `/reports?${params.toString()}`);
      window.requestAnimationFrame(() => {
        document.getElementById("report-details")?.scrollIntoView({ block: "nearest" });
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("incomeExpense.queryFailed"));
    } finally {
      if (requestSequence === detailRequestSequenceRef.current) setLoadingKey(null);
    }
  }

  const refreshActiveDetails = useCallback(async () => {
    if (!activeDetails) return;
    const detail: DetailSelection = {
      type: activeDetails.type,
      categoryKey: activeDetails.categoryKey ?? undefined,
      columnKey: activeDetails.columnKey ?? undefined,
    };
    const requestSequence = ++detailRequestSequenceRef.current;
    const key = detailKey(detail);
    setLoadingKey(key);
    try {
      const params = buildDetailSearch(currentReportQuery, detail);
      const res = await fetch(`/api/v1/reports/income-expense/detail?${params.toString()}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as DetailResponse | null;
      if (!res.ok || !data?.ok || !data.data) return;
      if (requestSequence !== detailRequestSequenceRef.current) return;
      if (!data.data.details) {
        hasClientDetailSelectionRef.current = false;
        clientDetailKeyRef.current = null;
        setActiveDetails(null);
        setDetailEntries([]);
        window.history.replaceState(window.history.state, "", buildClearUrl(currentReportQuery));
        return [];
      }
      hasClientDetailSelectionRef.current = true;
      clientDetailKeyRef.current = activeDetailKey(data.data.details);
      setActiveDetails(data.data.details);
      setDetailEntries(data.data.entries ?? []);
      return data.data.entries ?? [];
    } finally {
      if (requestSequence === detailRequestSequenceRef.current) setLoadingKey(null);
    }
  }, [activeDetails, currentReportQuery]);

  function clearDetails() {
    detailRequestSequenceRef.current += 1;
    hasClientDetailSelectionRef.current = false;
    clientDetailKeyRef.current = null;
    setActiveDetails(null);
    setDetailEntries([]);
    window.history.pushState(null, "", buildClearUrl(currentReportQuery));
  }

  const hasDetails = Boolean(activeDetails);
  const tableMinWidth = 240 + report.columns.length * 128 + 140;
  const incomeSectionStyle = colorScheme === "red_up_green_down"
    ? REPORT_SECTION_STYLES.red
    : REPORT_SECTION_STYLES.emerald;
  const expenseSectionStyle = colorScheme === "red_up_green_down"
    ? REPORT_SECTION_STYLES.emerald
    : REPORT_SECTION_STYLES.red;

  return (
    <ReportResizableSplit hasDetails={hasDetails}>
      <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-2 text-xs text-slate-500">
          <span>{t("settings.display.baseCurrency")}: {report.baseCurrency}</span>
          {report.missingFxCurrencies.length > 0 && <span className="text-amber-700" role="status">{t("overview.missingFxRateDetail", { currencies: report.missingFxCurrencies.join(", ") })}</span>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <table
            className="w-full table-fixed border-separate border-spacing-0"
          >
            <colgroup>
              <col style={{ width: `${(240 / tableMinWidth) * 100}%` }} />
              {report.columns.map((column) => (
                <col key={column.key} style={{ width: `${(128 / tableMinWidth) * 100}%` }} />
              ))}
              <col style={{ width: `${(140 / tableMinWidth) * 100}%` }} />
            </colgroup>
            <thead className="bg-white">
              <tr>
                <th className="sticky left-0 top-0 z-30 border-b border-r border-slate-200 bg-white px-4 py-2 text-left text-xs font-semibold text-slate-600">{t("incomeExpense.colCategory")}</th>
                {report.columns.map((column) => (
                  <th
                    key={column.key}
                    className="sticky top-0 z-20 border-b border-r border-slate-200 bg-white px-3 py-2 text-right text-xs font-semibold text-slate-600"
                  >
                    {column.label}
                  </th>
                ))}
                <th className="sticky top-0 z-20 border-b border-r border-slate-200 bg-white px-3 py-2 text-right text-xs font-semibold text-slate-700">{t("common.total")}</th>
              </tr>
            </thead>
            <tbody>
              <tr className={incomeSectionStyle.row}>
                <td className={incomeSectionStyle.label}>
                  {t("incomeExpense.incomeTotal")}
                </td>
                {report.income.periodTotals.map((value, index) => (
                  <td key={`income-total-${index}`} className={incomeSectionStyle.cell}>
                    <AmountButton
                      value={value}
                      count={report.income.periodCounts[index]}
                      className={pnlColor(value, colorScheme)}
                      detail={{ type: "income", columnKey: report.columns[index].key }}
                      loadingKey={loadingKey}
                      onSelect={selectDetail}
                    />
                  </td>
                ))}
                <td className={incomeSectionStyle.cell}>
                  <AmountButton
                    value={report.income.total}
                    count={report.income.count}
                    className={pnlColor(report.income.total, colorScheme)}
                    detail={{ type: "income" }}
                    loadingKey={loadingKey}
                    onSelect={selectDetail}
                  />
                </td>
              </tr>
              {visibleIncomeRows.map(({ row, canToggle, expanded }) => (
                <tr key={row.key} className="hover:bg-slate-50">
                  <td
                    className={`sticky left-0 border-b border-r border-slate-100 bg-white py-2 pr-3 text-xs text-slate-700 ${canToggle ? "cursor-pointer select-none hover:bg-slate-50" : ""}`}
                    style={{ paddingLeft: `${16 + row.depth * 20}px` }}
                    onClick={canToggle ? () => toggleCategoryRow(row.key) : undefined}
                    onKeyDown={canToggle ? (event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      toggleCategoryRow(row.key);
                    } : undefined}
                    role={canToggle ? "button" : undefined}
                    tabIndex={canToggle ? 0 : undefined}
                    title={canToggle ? (expanded ? t("incomeExpense.collapseCategory") : t("incomeExpense.expandCategory")) : undefined}
                  >
                    <span className="flex min-w-0 items-center gap-1">
                      {canToggle ? <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${expanded ? "" : "-rotate-90"}`} /> : <span className="h-3.5 w-3.5 shrink-0" />}
                      <span className={`block truncate ${row.depth === 0 ? "font-semibold text-slate-800" : ""}`}>{row.name}</span>
                    </span>
                  </td>
                  {row.values.map((value, index) => (
                    <td key={`${row.key}-${index}`} className="border-b border-r border-slate-100 px-3 py-2 text-right text-xs tabular-nums text-slate-600">
                      <AmountButton
                        value={value}
                        count={row.counts[index]}
                        className={pnlColor(value, colorScheme)}
                        detail={{ type: "income", categoryKey: row.key, columnKey: report.columns[index].key }}
                        loadingKey={loadingKey}
                        onSelect={selectDetail}
                      />
                    </td>
                  ))}
                  <td className="border-b border-r border-slate-100 px-3 py-2 text-right text-xs font-medium tabular-nums text-slate-700">
                    <AmountButton
                      value={row.total}
                      count={row.count}
                      className={pnlColor(row.total, colorScheme)}
                      detail={{ type: "income", categoryKey: row.key }}
                      loadingKey={loadingKey}
                      onSelect={selectDetail}
                    />
                  </td>
                </tr>
              ))}

              <tr className={expenseSectionStyle.row}>
                <td className={expenseSectionStyle.label}>
                  {t("incomeExpense.expenseTotal")}
                </td>
                {report.expense.periodTotals.map((value, index) => (
                  <td key={`expense-total-${index}`} className={expenseSectionStyle.cell}>
                    <AmountButton
                      value={value}
                      count={report.expense.periodCounts[index]}
                      className={pnlColor(-value, colorScheme)}
                      detail={{ type: "expense", columnKey: report.columns[index].key }}
                      loadingKey={loadingKey}
                      onSelect={selectDetail}
                    />
                  </td>
                ))}
                <td className={expenseSectionStyle.cell}>
                  <AmountButton
                    value={report.expense.total}
                    count={report.expense.count}
                    className={pnlColor(-report.expense.total, colorScheme)}
                    detail={{ type: "expense" }}
                    loadingKey={loadingKey}
                    onSelect={selectDetail}
                  />
                </td>
              </tr>
              {visibleExpenseRows.map(({ row, canToggle, expanded }) => (
                <tr key={row.key} className="hover:bg-slate-50">
                  <td
                    className={`sticky left-0 border-b border-r border-slate-100 bg-white py-2 pr-3 text-xs text-slate-700 ${canToggle ? "cursor-pointer select-none hover:bg-slate-50" : ""}`}
                    style={{ paddingLeft: `${16 + row.depth * 20}px` }}
                    onClick={canToggle ? () => toggleCategoryRow(row.key) : undefined}
                    onKeyDown={canToggle ? (event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      toggleCategoryRow(row.key);
                    } : undefined}
                    role={canToggle ? "button" : undefined}
                    tabIndex={canToggle ? 0 : undefined}
                    title={canToggle ? (expanded ? t("incomeExpense.collapseCategory") : t("incomeExpense.expandCategory")) : undefined}
                  >
                    <span className="flex min-w-0 items-center gap-1">
                      {canToggle ? <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${expanded ? "" : "-rotate-90"}`} /> : <span className="h-3.5 w-3.5 shrink-0" />}
                      <span className={`block truncate ${row.depth === 0 ? "font-semibold text-slate-800" : ""}`}>{row.name}</span>
                    </span>
                  </td>
                  {row.values.map((value, index) => (
                    <td key={`${row.key}-${index}`} className="border-b border-r border-slate-100 px-3 py-2 text-right text-xs tabular-nums text-slate-600">
                      <AmountButton
                        value={value}
                        count={row.counts[index]}
                        className={pnlColor(-value, colorScheme)}
                        detail={{ type: "expense", categoryKey: row.key, columnKey: report.columns[index].key }}
                        loadingKey={loadingKey}
                        onSelect={selectDetail}
                      />
                    </td>
                  ))}
                  <td className="border-b border-r border-slate-100 px-3 py-2 text-right text-xs font-medium tabular-nums text-slate-700">
                    <AmountButton
                      value={row.total}
                      count={row.count}
                      className={pnlColor(-row.total, colorScheme)}
                      detail={{ type: "expense", categoryKey: row.key }}
                      loadingKey={loadingKey}
                      onSelect={selectDetail}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="sticky bottom-0 bg-slate-50">
              <tr>
                <td className="sticky left-0 border-t border-r border-slate-200 bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-700">
                  {t("stats.netIncome")}
                </td>
                {report.netPeriodTotals.map((value, index) => (
                  <td
                    key={`net-${index}`}
                    className={`border-t border-r border-slate-200 px-3 py-2 text-right text-xs font-semibold tabular-nums ${pnlColor(value, colorScheme)}`}
                  >
                    <AmountButton
                      value={value}
                      count={report.income.periodCounts[index] + report.expense.periodCounts[index]}
                      detail={{ type: "net", columnKey: report.columns[index].key }}
                      loadingKey={loadingKey}
                      onSelect={selectDetail}
                      className={value > 0 ? "before:content-['+']" : ""}
                    />
                  </td>
                ))}
                <td className={`border-t border-r border-slate-200 px-3 py-2 text-right text-xs font-semibold tabular-nums ${pnlColor(report.netTotal, colorScheme)}`}>
                  <AmountButton
                    value={report.netTotal}
                    count={report.income.count + report.expense.count}
                    detail={{ type: "net" }}
                    loadingKey={loadingKey}
                    onSelect={selectDetail}
                    className={report.netTotal > 0 ? "before:content-['+']" : ""}
                  />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {report.income.rows.length === 0 && report.expense.rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-400">
            {t("incomeExpense.emptyRange")}
          </div>
        ) : null}
      </div>

      {activeDetails ? (
        <div id="report-details" className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
          <ReportDetailTable
            accountId={accountId}
            entries={detailEntries}
            accountOptions={accountOptions}
            categoryOptions={categoryOptions}
            tagOptions={tagOptions}
            investmentProductTypeByAccountId={investmentProductTypeByAccountId}
            title={t("incomeExpense.detailTitle", {
              typeLabel: t("incomeExpense.receiptDetailLabel"),
              categorySuffix: activeDetails.categoryName ? ` · ${activeDetails.categoryName}` : "",
              columnLabel: activeDetails.columnLabel,
            })}
            total={activeDetails.total}
            colorValue={activeDetails.type === "expense" ? -activeDetails.total : activeDetails.total}
            onClear={clearDetails}
            onRefresh={refreshActiveDetails}
            resetKey={activeDetailKey(activeDetails)}
          />
        </div>
      ) : null}
    </ReportResizableSplit>
  );
}
