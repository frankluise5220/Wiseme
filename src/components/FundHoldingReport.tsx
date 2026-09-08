"use client";

import { useCallback, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { formatCurrencyMoney, formatMoney, formatPercent } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import {
  AdvancedDataTable,
  type AdvancedDataTableColumn,
  type AdvancedDataTableSortState,
  type AdvancedDataTableSummaryRow,
} from "@/components/AdvancedDataTable";
import type {
  FundHoldingReportRow,
  FundClearedReportRow,
  FundHoldingReportTotals,
} from "@/lib/server/fund-holding-report";
import { useI18n } from "@/lib/i18n";

/** How the summary list is aggregated: one row per account, or one row per fund company. */
export type FundGroupMode = "account" | "company";

type Props = {
  rows: FundHoldingReportRow[];
  clearedRows: FundClearedReportRow[];
  totals: FundHoldingReportTotals;
  isRedUp: boolean;
  groupMode: FundGroupMode;
};

/**
 * One rendered table row. `isGroup` rows are the aggregated summary lines; the
 * rows that follow with the same `groupId` are their per-fund detail lines.
 * Per-fund attributes (NAV, average cost) only exist on detail rows.
 */
type GroupedRow = {
  id: string;
  groupId: string;
  /** 0 for the group header, 1..n for its detail rows. */
  order: number;
  isGroup: boolean;
};

type HoldingRow = GroupedRow & {
  label: string;
  subLabel: string;
  title: string;
  accountLabel: string;
  units: number;
  avgCost: number | null;
  nav: number | null;
  navDate: string;
  cost: number;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
  historicalProfit: number;
  totalProfit: number;
  currency: string;
};

type ClearedRow = GroupedRow & {
  label: string;
  subLabel: string;
  title: string;
  accountLabel: string;
  firstBuyDate: string;
  clearedDate: string;
  totalInvested: number;
  totalBuyAmount: number;
  totalRedeemAmount: number;
  historicalProfit: number;
  returnRate: number;
  currency: string;
};

type GroupBucket<T> = { key: string; label: string; accountLabel: string; items: T[] };
type RowGroup<T> = { header: T; details: T[] };

function valueClass(value: number, isRedUp: boolean) {
  return pnlClassFromRedUp(value, isRedUp, "muted");
}

function signedMoney(value: number, currency = "CNY") {
  return `${value > 0 ? "+" : ""}${formatCurrencyMoney(value, currency)}`;
}

function compactDate(value: string | null) {
  const date = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date.slice(5, 7)}.${date.slice(8, 10)}` : String(value ?? "");
}

function accountText(row: { institutionName: string; accountName: string }) {
  return row.institutionName ? `${row.institutionName}·${row.accountName}` : row.accountName;
}

function sumBy<T>(items: T[], read: (item: T) => number) {
  return items.reduce((sum, item) => sum + read(item), 0);
}

/**
 * Sorting for a grouped (tree) table: detail rows always stay attached to their
 * group, and groups are ordered by the group header's own value for the column.
 */
function makeGroupedSort<T extends GroupedRow>() {
  return (
    rows: T[],
    sortState: AdvancedDataTableSortState | null,
    columns: AdvancedDataTableColumn<T>[],
  ): T[] => {
    if (!sortState) return rows;
    const readValue = columns.find((column) => column.key === sortState.key)?.sortValue;
    if (!readValue) return rows;
    const direction = sortState.direction === "asc" ? 1 : -1;
    const groupValue = new Map<string, string | number | null | undefined>();
    const groupIndex = new Map<string, number>();
    rows.forEach((row, index) => {
      if (row.isGroup) {
        groupValue.set(row.groupId, readValue(row));
        groupIndex.set(row.groupId, index);
      }
    });
    return [...rows].sort((left, right) => {
      if (left.groupId === right.groupId) return left.order - right.order;
      const leftValue = groupValue.get(left.groupId);
      const rightValue = groupValue.get(right.groupId);
      const leftEmpty = leftValue == null || leftValue === "";
      const rightEmpty = rightValue == null || rightValue === "";
      if (leftEmpty || rightEmpty) {
        if (leftEmpty && rightEmpty) return (groupIndex.get(left.groupId) ?? 0) - (groupIndex.get(right.groupId) ?? 0);
        return leftEmpty ? 1 : -1;
      }
      const compared = typeof leftValue === "number" && typeof rightValue === "number"
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue), "zh-CN", { numeric: true });
      if (compared !== 0) return compared * direction;
      return (groupIndex.get(left.groupId) ?? 0) - (groupIndex.get(right.groupId) ?? 0);
    });
  };
}

function groupRows<T>(rows: T[], readKey: (row: T) => string, readLabel: (row: T) => string, readAccount: (row: T) => string) {
  const buckets = new Map<string, GroupBucket<T>>();
  for (const row of rows) {
    const key = readKey(row);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, label: readLabel(row), accountLabel: readAccount(row), items: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push(row);
  }
  return Array.from(buckets.values());
}

function useExpandableGroups<T extends GroupedRow>(groups: RowGroup<T>[]) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const flatRows = useMemo(() => {
    const out: T[] = [];
    for (const group of groups) {
      out.push(group.header);
      if (expanded.has(group.header.groupId)) out.push(...group.details);
    }
    return out;
  }, [groups, expanded]);

  const toggle = useCallback((groupId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const allExpanded = groups.length > 0 && groups.every((group) => expanded.has(group.header.groupId));
  const toggleAll = useCallback(() => {
    setExpanded((current) => {
      if (groups.length > 0 && groups.every((group) => current.has(group.header.groupId))) return new Set();
      return new Set(groups.map((group) => group.header.groupId));
    });
  }, [groups]);

  return { flatRows, expanded, toggle, toggleAll, allExpanded };
}

export function FundHoldingReport({ rows, clearedRows, totals, isRedUp, groupMode }: Props) {
  const currency = rows[0]?.currency || clearedRows[0]?.currency || "CNY";
  const { t } = useI18n();

  const groupByCompany = groupMode === "company";
  const unclassified = t("fundHoldingReport.unclassifiedCompany");
  const fundCountLabel = useCallback(
    (count: number) => t("fundHoldingReport.fundCount", { count }),
    [t],
  );
  const accountCountLabel = useCallback(
    (count: number) => t("fundHoldingReport.accountCount", { count }),
    [t],
  );

  const holdingGroups = useMemo<RowGroup<HoldingRow>[]>(() => {
    const buckets = groupRows(
      rows,
      (row) => (groupByCompany ? (row.fundCompany || unclassified) : row.accountId),
      (row) => (groupByCompany ? (row.fundCompany || unclassified) : accountText(row)),
      (row) => accountText(row),
    );
    return buckets.map((bucket) => {
      const items = [...bucket.items].sort((left, right) => right.marketValue - left.marketValue);
      const groupId = `h::${bucket.key}`;
      const units = sumBy(items, (row) => row.units);
      const cost = sumBy(items, (row) => row.cost);
      const marketValue = sumBy(items, (row) => row.marketValue);
      const floatingPnL = sumBy(items, (row) => row.floatingPnL);
      const fundCount = new Set(items.map((row) => row.fundCode)).size;
      const accountCount = new Set(items.map((row) => row.accountId)).size;
      const header: HoldingRow = {
        id: groupId,
        groupId,
        order: 0,
        isGroup: true,
        label: groupByCompany ? bucket.label : fundCountLabel(fundCount),
        subLabel: groupByCompany ? fundCountLabel(fundCount) : "",
        title: groupByCompany ? `${bucket.label} · ${fundCountLabel(fundCount)}` : bucket.accountLabel,
        accountLabel: groupByCompany ? accountCountLabel(accountCount) : bucket.accountLabel,
        units,
        // Per-fund attributes are meaningless on an aggregated line.
        avgCost: null,
        nav: null,
        navDate: "",
        cost,
        marketValue,
        floatingPnL,
        floatingPnLRate: cost > 0 ? floatingPnL / cost : 0,
        historicalProfit: sumBy(items, (row) => row.historicalProfit),
        totalProfit: sumBy(items, (row) => row.totalProfit),
        currency: items[0]?.currency ?? "CNY",
      };
      const details: HoldingRow[] = items.map((row, index) => ({
        id: `${groupId}::${row.id}`,
        groupId,
        order: index + 1,
        isGroup: false,
        label: row.fundName,
        subLabel: row.fundCode && row.fundCode !== row.fundName ? row.fundCode : "",
        title: `${row.fundName}${row.fundCode ? ` ${row.fundCode}` : ""}`,
        accountLabel: groupByCompany ? accountText(row) : "",
        units: row.units,
        avgCost: row.avgCost,
        nav: row.nav,
        navDate: row.navDate,
        cost: row.cost,
        marketValue: row.marketValue,
        floatingPnL: row.floatingPnL,
        floatingPnLRate: row.floatingPnLRate,
        historicalProfit: row.historicalProfit,
        totalProfit: row.totalProfit,
        currency: row.currency,
      }));
      return { header, details };
    });
  }, [rows, groupByCompany, unclassified, fundCountLabel, accountCountLabel]);

  const clearedGroups = useMemo<RowGroup<ClearedRow>[]>(() => {
    const buckets = groupRows(
      clearedRows,
      (row) => (groupByCompany ? (row.fundCompany || unclassified) : row.accountId),
      (row) => (groupByCompany ? (row.fundCompany || unclassified) : accountText(row)),
      (row) => accountText(row),
    );
    return buckets.map((bucket) => {
      const items = [...bucket.items].sort((left, right) => right.historicalProfit - left.historicalProfit);
      const groupId = `c::${bucket.key}`;
      const totalInvested = sumBy(items, (row) => row.totalInvested);
      const historicalProfit = sumBy(items, (row) => row.historicalProfit);
      const fundCount = new Set(items.map((row) => row.fundCode)).size;
      const accountCount = new Set(items.map((row) => row.accountId)).size;
      const firstBuys = items.map((row) => row.firstBuyDate).filter(Boolean).sort();
      const clearedDates = items.map((row) => row.clearedDate).filter(Boolean).sort();
      const header: ClearedRow = {
        id: groupId,
        groupId,
        order: 0,
        isGroup: true,
        label: groupByCompany ? bucket.label : fundCountLabel(fundCount),
        subLabel: groupByCompany ? fundCountLabel(fundCount) : "",
        title: groupByCompany ? `${bucket.label} · ${fundCountLabel(fundCount)}` : bucket.accountLabel,
        accountLabel: groupByCompany ? accountCountLabel(accountCount) : bucket.accountLabel,
        firstBuyDate: firstBuys[0] ?? "",
        clearedDate: clearedDates[clearedDates.length - 1] ?? "",
        totalInvested,
        totalBuyAmount: sumBy(items, (row) => row.totalBuyAmount),
        totalRedeemAmount: sumBy(items, (row) => row.totalRedeemAmount),
        historicalProfit,
        returnRate: totalInvested > 0 ? historicalProfit / totalInvested : 0,
        currency: items[0]?.currency ?? "CNY",
      };
      const details: ClearedRow[] = items.map((row, index) => ({
        id: `${groupId}::${row.id}`,
        groupId,
        order: index + 1,
        isGroup: false,
        label: row.fundName,
        subLabel: row.fundCode && row.fundCode !== row.fundName ? row.fundCode : "",
        title: `${row.fundName}${row.fundCode ? ` ${row.fundCode}` : ""}`,
        accountLabel: groupByCompany ? accountText(row) : "",
        firstBuyDate: row.firstBuyDate,
        clearedDate: row.clearedDate,
        totalInvested: row.totalInvested,
        totalBuyAmount: row.totalBuyAmount,
        totalRedeemAmount: row.totalRedeemAmount,
        historicalProfit: row.historicalProfit,
        returnRate: row.returnRate,
        currency: row.currency,
      }));
      return { header, details };
    });
  }, [clearedRows, groupByCompany, unclassified, fundCountLabel, accountCountLabel]);

  const holdings = useExpandableGroups(holdingGroups);
  const cleared = useExpandableGroups(clearedGroups);

  const expandToggle = (isOpen: boolean, groupId: string, onToggle: (groupId: string) => void) => (
    <button
      type="button"
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-200 hover:text-slate-700"
      title={t(isOpen ? "fundHoldingReport.collapseAll" : "fundHoldingReport.expandAll")}
      aria-label={t(isOpen ? "fundHoldingReport.collapseAll" : "fundHoldingReport.expandAll")}
      aria-expanded={isOpen}
      onClick={() => onToggle(groupId)}
    >
      {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
    </button>
  );

  const holdingColumns = useMemo<AdvancedDataTableColumn<HoldingRow>[]>(() => [
    {
      key: "fund",
      label: groupByCompany ? t("fundHoldingReport.colFundCompany") : t("fundHoldingReport.colFund"),
      width: 216,
      align: "left",
      filterText: (row) => `${row.label} ${row.subLabel}`,
      sortValue: (row) => row.label,
      render: (row) => (row.isGroup ? (
        <span className="flex min-w-0 items-center gap-1">
          {expandToggle(holdings.expanded.has(row.groupId), row.groupId, holdings.toggle)}
          <span className="truncate font-medium text-slate-800">{row.label}</span>
          {row.subLabel ? <span className="shrink-0 text-[11px] text-slate-500">{row.subLabel}</span> : null}
        </span>
      ) : (
        <span className="block truncate pl-5 text-xs text-slate-700" title={row.title}>
          {row.label}
          {row.subLabel ? <span className="ml-1 text-[11px] text-slate-500">{row.subLabel}</span> : null}
        </span>
      )),
    },
    {
      key: "account",
      label: t("fundHoldingReport.colAccount"),
      width: 168,
      align: "left",
      filterText: (row) => row.accountLabel,
      sortValue: (row) => row.accountLabel,
      render: (row) => (
        <span className="block truncate text-slate-600" title={row.accountLabel}>{row.accountLabel}</span>
      ),
    },
    {
      key: "units",
      label: t("fundHoldingReport.colUnits"),
      width: 96,
      align: "right",
      filterText: (row) => String(row.units),
      sortValue: (row) => row.units,
      render: (row) => <span className="tabular-nums">{formatMoney(row.units)}</span>,
    },
    {
      key: "avgCost",
      label: t("fundHoldingReport.colAvgCost"),
      width: 88,
      align: "right",
      filterText: (row) => (row.avgCost == null ? "" : String(row.avgCost)),
      sortValue: (row) => row.avgCost,
      render: (row) => <span className="tabular-nums">{row.avgCost == null ? "-" : formatMoney(row.avgCost)}</span>,
    },
    {
      key: "nav",
      label: t("fundHoldingReport.colNav"),
      width: 104,
      align: "right",
      filterText: (row) => (row.nav == null ? "" : String(row.nav)),
      sortValue: (row) => row.nav,
      render: (row) => (
        <span className="tabular-nums">
          {row.nav == null ? "-" : formatMoney(row.nav)}
          {row.navDate ? <span className="ml-1 text-[11px] text-slate-400">({compactDate(row.navDate)})</span> : null}
        </span>
      ),
    },
    {
      key: "cost",
      label: t("fundHoldingReport.colCost"),
      width: 104,
      align: "right",
      filterText: (row) => String(row.cost),
      sortValue: (row) => row.cost,
      render: (row) => <span className="tabular-nums">{formatCurrencyMoney(row.cost, row.currency)}</span>,
    },
    {
      key: "marketValue",
      label: t("fundHoldingReport.colMarketValue"),
      width: 104,
      align: "right",
      filterText: (row) => String(row.marketValue),
      sortValue: (row) => row.marketValue,
      render: (row) => <span className="tabular-nums">{formatCurrencyMoney(row.marketValue, row.currency)}</span>,
    },
    {
      key: "floatingPnL",
      label: t("fundHoldingReport.colFloatingPnL"),
      width: 104,
      align: "right",
      filterText: (row) => String(row.floatingPnL),
      sortValue: (row) => row.floatingPnL,
      render: (row) => (
        <span className={`tabular-nums ${valueClass(row.floatingPnL, isRedUp)}`}>{signedMoney(row.floatingPnL, row.currency)}</span>
      ),
    },
    {
      key: "floatingPnLRate",
      label: t("fundHoldingReport.colFloatingPnLRate"),
      width: 88,
      align: "right",
      filterText: (row) => String(row.floatingPnLRate),
      sortValue: (row) => row.floatingPnLRate,
      render: (row) => (
        <span className={`tabular-nums ${valueClass(row.floatingPnLRate, isRedUp)}`}>{formatPercent(row.floatingPnLRate)}</span>
      ),
    },
    {
      key: "historicalProfit",
      label: t("fundHoldingReport.colRealized"),
      width: 104,
      align: "right",
      filterText: (row) => String(row.historicalProfit),
      sortValue: (row) => row.historicalProfit,
      render: (row) => (
        <span className={`tabular-nums ${valueClass(row.historicalProfit, isRedUp)}`}>{signedMoney(row.historicalProfit, row.currency)}</span>
      ),
    },
    {
      key: "totalProfit",
      label: t("fundHoldingReport.colTotalPnL"),
      width: 104,
      align: "right",
      filterText: (row) => String(row.totalProfit),
      sortValue: (row) => row.totalProfit,
      render: (row) => (
        <span className={`tabular-nums ${valueClass(row.totalProfit, isRedUp)}`}>{signedMoney(row.totalProfit, row.currency)}</span>
      ),
    },
  ], [groupByCompany, isRedUp, t, holdings.expanded, holdings.toggle]);

  const clearedColumns = useMemo<AdvancedDataTableColumn<ClearedRow>[]>(() => [
    {
      key: "fund",
      label: groupByCompany ? t("fundHoldingReport.colFundCompany") : t("fundHoldingReport.colFund"),
      width: 216,
      align: "left",
      filterText: (row) => `${row.label} ${row.subLabel}`,
      sortValue: (row) => row.label,
      render: (row) => (row.isGroup ? (
        <span className="flex min-w-0 items-center gap-1">
          {expandToggle(cleared.expanded.has(row.groupId), row.groupId, cleared.toggle)}
          <span className="truncate font-medium text-slate-800">{row.label}</span>
          {row.subLabel ? <span className="shrink-0 text-[11px] text-slate-500">{row.subLabel}</span> : null}
        </span>
      ) : (
        <span className="block truncate pl-5 text-xs text-slate-700" title={row.title}>
          {row.label}
          {row.subLabel ? <span className="ml-1 text-[11px] text-slate-500">{row.subLabel}</span> : null}
        </span>
      )),
    },
    {
      key: "account",
      label: t("fundHoldingReport.colAccount"),
      width: 168,
      align: "left",
      filterText: (row) => row.accountLabel,
      sortValue: (row) => row.accountLabel,
      render: (row) => (
        <span className="block truncate text-slate-600" title={row.accountLabel}>{row.accountLabel}</span>
      ),
    },
    {
      key: "firstBuyDate",
      label: t("fundHoldingReport.colFirstBuy"),
      width: 96,
      align: "right",
      filterText: (row) => row.firstBuyDate,
      sortValue: (row) => row.firstBuyDate,
      render: (row) => <span className="tabular-nums text-slate-700">{compactDate(row.firstBuyDate) || "-"}</span>,
    },
    {
      key: "clearedDate",
      label: t("fundHoldingReport.colClearedDate"),
      width: 96,
      align: "right",
      filterText: (row) => row.clearedDate,
      sortValue: (row) => row.clearedDate,
      render: (row) => <span className="tabular-nums text-slate-700">{compactDate(row.clearedDate) || "-"}</span>,
    },
    {
      key: "totalInvested",
      label: t("fundHoldingReport.colTotalInvested"),
      width: 104,
      align: "right",
      filterText: (row) => String(row.totalInvested),
      sortValue: (row) => row.totalInvested,
      render: (row) => <span className="tabular-nums">{formatCurrencyMoney(row.totalInvested, row.currency)}</span>,
    },
    {
      key: "totalBuyAmount",
      label: t("fundHoldingReport.colBuyAmount"),
      width: 104,
      align: "right",
      filterText: (row) => String(row.totalBuyAmount),
      sortValue: (row) => row.totalBuyAmount,
      render: (row) => <span className="tabular-nums">{formatCurrencyMoney(row.totalBuyAmount, row.currency)}</span>,
    },
    {
      key: "totalRedeemAmount",
      label: t("fundHoldingReport.colRedeemAmount"),
      width: 104,
      align: "right",
      filterText: (row) => String(row.totalRedeemAmount),
      sortValue: (row) => row.totalRedeemAmount,
      render: (row) => <span className="tabular-nums">{formatCurrencyMoney(row.totalRedeemAmount, row.currency)}</span>,
    },
    {
      key: "historicalProfit",
      label: t("fundHoldingReport.colRealized"),
      width: 104,
      align: "right",
      filterText: (row) => String(row.historicalProfit),
      sortValue: (row) => row.historicalProfit,
      render: (row) => (
        <span className={`tabular-nums ${valueClass(row.historicalProfit, isRedUp)}`}>{signedMoney(row.historicalProfit, row.currency)}</span>
      ),
    },
    {
      key: "returnRate",
      label: t("fundHoldingReport.colReturnRate"),
      width: 88,
      align: "right",
      filterText: (row) => String(row.returnRate),
      sortValue: (row) => row.returnRate,
      render: (row) => (
        <span className={`tabular-nums ${valueClass(row.returnRate, isRedUp)}`}>{formatPercent(row.returnRate)}</span>
      ),
    },
  ], [groupByCompany, isRedUp, t, cleared.expanded, cleared.toggle]);

  const sortHoldings = useMemo(() => makeGroupedSort<HoldingRow>(), []);
  const sortCleared = useMemo(() => makeGroupedSort<ClearedRow>(), []);

  const holdingSummaryRow = useMemo<AdvancedDataTableSummaryRow | undefined>(() => {
    if (holdingGroups.length === 0) return undefined;
    return {
      cells: {
        fund: <span className="text-xs font-medium text-slate-700">{t("common.total")}</span>,
        cost: <span className="tabular-nums text-xs text-slate-700">{formatCurrencyMoney(totals.cost, currency)}</span>,
        marketValue: <span className="tabular-nums text-xs text-slate-700">{formatCurrencyMoney(totals.marketValue, currency)}</span>,
        floatingPnL: (
          <span className={`tabular-nums text-xs ${valueClass(totals.floatingPnL, isRedUp)}`}>{signedMoney(totals.floatingPnL, currency)}</span>
        ),
        floatingPnLRate: (
          <span className={`tabular-nums text-xs ${valueClass(totals.floatingPnLRate, isRedUp)}`}>{formatPercent(totals.floatingPnLRate)}</span>
        ),
        historicalProfit: (
          <span className={`tabular-nums text-xs ${valueClass(totals.historicalProfit, isRedUp)}`}>{signedMoney(totals.historicalProfit, currency)}</span>
        ),
        totalProfit: (
          <span className={`tabular-nums text-xs ${valueClass(totals.totalProfit, isRedUp)}`}>{signedMoney(totals.totalProfit, currency)}</span>
        ),
      },
      rowClassName: "bg-slate-50",
      cellClassName: "text-xs",
    };
  }, [holdingGroups.length, totals, currency, isRedUp, t]);

  const clearedSummaryRow = useMemo<AdvancedDataTableSummaryRow | undefined>(() => {
    if (clearedGroups.length === 0) return undefined;
    return {
      cells: {
        fund: <span className="text-xs font-medium text-slate-700">{t("common.total")}</span>,
        totalInvested: (
          <span className="tabular-nums text-xs text-slate-700">{formatCurrencyMoney(totals.clearedTotalInvested, currency)}</span>
        ),
        historicalProfit: (
          <span className={`tabular-nums text-xs ${valueClass(totals.clearedHistoricalProfit, isRedUp)}`}>{signedMoney(totals.clearedHistoricalProfit, currency)}</span>
        ),
      },
      rowClassName: "bg-slate-50",
      cellClassName: "text-xs",
    };
  }, [clearedGroups.length, totals, currency, isRedUp, t]);

  const best = [...rows].sort((a, b) => b.totalProfit - a.totalProfit)[0] ?? null;
  const worst = [...rows].sort((a, b) => a.totalProfit - b.totalProfit)[0] ?? null;

  const expandAllButton = (allExpanded: boolean, onToggle: () => void) => (
    <button
      type="button"
      className="shrink-0 rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-500 hover:border-slate-300 hover:text-slate-700"
      onClick={onToggle}
    >
      {t(allExpanded ? "fundHoldingReport.collapseAll" : "fundHoldingReport.expandAll")}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="grid shrink-0 grid-cols-2 gap-3 md:grid-cols-6">
        {[
          { key: "marketValue", labelKey: "fundHoldingReport.summary.marketValue", value: formatCurrencyMoney(totals.marketValue, currency), className: "text-slate-800" },
          { key: "cost", labelKey: "fundHoldingReport.summary.cost", value: formatCurrencyMoney(totals.cost, currency), className: "text-slate-800" },
          { key: "floatingPnL", labelKey: "fundHoldingReport.summary.floatingPnL", value: signedMoney(totals.floatingPnL, currency), className: valueClass(totals.floatingPnL, isRedUp) },
          { key: "historicalProfit", labelKey: "fundHoldingReport.summary.historicalProfit", value: signedMoney(totals.historicalProfit, currency), className: valueClass(totals.historicalProfit, isRedUp) },
          { key: "clearedHistoricalProfit", labelKey: "fundHoldingReport.summary.clearedHistoricalProfit", value: signedMoney(totals.clearedHistoricalProfit, currency), className: valueClass(totals.clearedHistoricalProfit, isRedUp) },
          { key: "holdingCount", labelKey: "fundHoldingReport.summary.holdingCount", value: `${totals.holdingCount} / ${totals.clearedCount}`, className: "text-slate-800" },
        ].map((item) => (
          <div key={item.key} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-[11px] text-slate-500">{t(item.labelKey)}</div>
            <div className={`mt-1 text-base font-semibold tabular-nums ${item.className}`}>{item.value}</div>
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-3 py-2">
          <div className="text-sm font-medium text-slate-800">{t("fundHoldingReport.holdingsTitle")}</div>
          <div className="flex min-w-0 items-center gap-3">
            <div className="truncate text-xs text-slate-500">
              {best
                ? t("fundHoldingReport.bestHolding")
                    .replace("{name}", best.fundName)
                    .replace("{amount}", signedMoney(best.totalProfit, best.currency))
                : t("fundHoldingReport.noHoldings")}
              {worst && worst.id !== best?.id
                ? ` · ${t("fundHoldingReport.worstHolding")
                    .replace("{name}", worst.fundName)
                    .replace("{amount}", signedMoney(worst.totalProfit, worst.currency))}`
                : ""}
            </div>
            {holdingGroups.length > 0 ? expandAllButton(holdings.allExpanded, holdings.toggleAll) : null}
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <AdvancedDataTable
            storageKey={`mmh_fund_report_holdings_v2:${groupMode}`}
            columns={holdingColumns}
            rows={holdings.flatRows}
            rowKey={(row) => row.id}
            rowClassName={(row) => (row.isGroup ? "" : "bg-slate-50/60")}
            emptyText={t("fundHoldingReport.empty")}
            minTableWidth={1280}
            showFilters={false}
            fillHeight
            toolbarMode="none"
            draggableRows={false}
            defaultSort={{ key: "marketValue", direction: "desc" }}
            sortRows={sortHoldings}
            summaryRow={holdingSummaryRow}
            resetKey={groupMode}
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-3 py-2">
          <div className="text-sm font-medium text-slate-800">{t("fundHoldingReport.clearedTitle")}</div>
          <div className="flex min-w-0 items-center gap-3">
            <div className="text-xs text-slate-500">{t("fundHoldingReport.clearedCount", { count: totals.clearedCount })}</div>
            {clearedGroups.length > 0 ? expandAllButton(cleared.allExpanded, cleared.toggleAll) : null}
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <AdvancedDataTable
            storageKey={`mmh_fund_report_cleared_v2:${groupMode}`}
            columns={clearedColumns}
            rows={cleared.flatRows}
            rowKey={(row) => row.id}
            rowClassName={(row) => (row.isGroup ? "" : "bg-slate-50/60")}
            emptyText={t("fundHoldingReport.noCleared")}
            minTableWidth={1080}
            showFilters={false}
            fillHeight
            toolbarMode="none"
            draggableRows={false}
            sortRows={sortCleared}
            summaryRow={clearedSummaryRow}
            resetKey={groupMode}
          />
        </div>
      </div>
    </div>
  );
}
