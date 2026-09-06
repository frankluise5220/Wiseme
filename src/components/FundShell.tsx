"use client";



import { useState, useMemo, useRef, useEffect, useCallback } from "react";

import { startTransition } from "react";

import { CartesianGrid, Line, LineChart as RechartsLineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatMoney, formatPercent } from "@/lib/format";
import { formatDateLocal } from "@/lib/date-utils";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { useOutsideClose } from "@/lib/client/useOutsideClose";
import { toNumber } from "@/lib/date-utils";
import { deleteEntriesWithLinkedPrompt, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { dispatchFinanceDataChanged, FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";

import { ChartLine, Download, Pencil, Settings2, SlidersHorizontal, Trash2, X } from "lucide-react";

import { FundProfileSettingsModal } from "@/components/FundProfileSettingsModal";
import type { FundProfileNavigationItem } from "@/components/FundProfileSettingsClient";
import { InvestmentFormModal } from "@/components/InvestmentFormModal";
import { allocateBuyFailedRefunds, findLinkedEntries, getConfirmedBuyAmount, getEffectiveBuyUnitsByRefunds, type RefundLinkableEntry } from "@/lib/fund/refund-link";

import { WealthFormModal } from "@/components/WealthFormModal";

import { DepositFormModal } from "@/components/DepositFormModal";

import { FillNavButton } from "@/components/FillNavButton";
import { FundUnitsReconcileButton } from "@/components/FundUnitsReconcileButton";

import { BatchReplacePopoverButton, type BatchReplaceFieldConfig } from "@/components/BatchReplacePopoverButton";

import { ResizableVerticalSplit } from "@/components/ResizableVerticalSplit";

import { RefreshNavButton } from "@/components/RefreshNavButton";

import { AddNavButton } from "@/components/AddNavButton";

import { AdvancedDataTable, type AdvancedDataTableColumn, type AdvancedDataTableSummaryRow } from "@/components/AdvancedDataTable";
import { DetailTablePaginationControls } from "@/components/DetailTablePaginationControls";
import { ViewExcelImportMenuButton, exportRowsToXlsx } from "@/components/ViewExcelImportMenuButton";



import { subtypeDisplay } from "@/lib/investment-config";
import { isFundLikeInvestmentAccount } from "@/lib/account-kind-utils";
import { TRANSACTION_SOURCE_FUND_UNITS_RECONCILE, isFundUnitsReconcileEntry } from "@/lib/transaction-semantics";
import { useI18n } from "@/lib/i18n";
 

function fundSubtypeLabel(t: (key: string) => string, subtype: string | null | undefined, source: string | null | undefined) {
  if (source === TRANSACTION_SOURCE_FUND_UNITS_RECONCILE) return t("fundShell.subtype.unitsReconcile");
  if (subtype === "buy" && source === "regular_invest") return t("fundShell.subtype.buyRegularInvest");
  if (subtype === "buy" && source === "dividend") return t("fund.subtype.dividend");
  if (subtype === "buy_failed" && source === "regular_invest_refund") return t("fundShell.subtype.buyRefund");
  if (subtype === "buy_failed") return t("fundShell.subtype.buyFailed");
  if (subtype === "buy") return t("fund.subtype.buy");
  if (subtype === "redeem") return t("fund.subtype.redeem");
  if (subtype === "dividend_reinvest") return t("fundShell.subtype.dividendReinvest");
  if (subtype === "dividend_cash") return t("fundShell.subtype.dividendCash");
  return t("fundShell.subtype.unknown");
}

function fl(t: (key: string) => string, subtype: string | null | undefined, source: string | null | undefined) {

  const info = subtypeDisplay(subtype, source);
  return { label: fundSubtypeLabel(t, subtype, source), cls: info.cls, textCls: info.textCls };

}

function fmtDate(v: any) { if (!v) return ""; const s = typeof v === "string" ? v : v?.toISOString?.(); return s ? s.slice(0, 10) : ""; }

function compactNavDate(value: string | null | undefined) {
  const date = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date.slice(5, 7)}.${date.slice(8, 10)}` : String(value ?? "");
}

function isGenericFundName(name: string, code: string) {
  const value = name.trim();
  if (!value || value === code) return true;
  return ["红利转投", "红利再投", "红利再投资", "现金红利", "分红", "买入", "申购", "赎回", "定投"].includes(value);
}

function LinkStatusIcon({ active, title }: { active: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={[
        "inline-flex h-4 w-4 items-center justify-center rounded-full border",
        active
          ? "border-sky-300 bg-sky-100 text-sky-700 shadow-[0_0_0_2px_rgba(14,165,233,0.08)]"
          : "border-slate-200 bg-transparent text-slate-300",
      ].join(" ")}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" className="h-2.5 w-2.5">
        <path
          d="M9.5 7.5h-2a4.5 4.5 0 0 0 0 9h2m5-9h2a4.5 4.5 0 0 1 0 9h-2M8 12h8"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </svg>
    </span>
  );
}

function FundMobileDetailItem({
  label,
  value,
  alignRight = false,
  wide = false,
  valueClassName = "text-slate-700",
}: {
  label: string;
  value: string;
  alignRight?: boolean;
  wide?: boolean;
  valueClassName?: string;
}) {
  return (
    <div className={wide ? "col-span-2 min-w-0" : "min-w-0"}>
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`mt-0.5 min-w-0 ${alignRight ? "text-right" : ""} break-words text-xs tabular-nums ${valueClassName}`}>
        {value}
      </div>
    </div>
  );
}



type Props = any;

type FundTableKey = "positions" | "cleared" | "details";
type FundColumnSpec = readonly [string, number];

const FUND_TABLE_WIDTHS_KEY = "mmh_fund_shell_column_widths_v1";
const FUND_POSITION_HIDDEN_COLUMNS_KEY = "mmh_fund_shell_position_hidden_columns_v1";
const FUND_DETAIL_HIDDEN_COLUMNS_KEY = "mmh_fund_shell_detail_hidden_columns_v1";

const POSITION_COLS: readonly FundColumnSpec[] = [
  ["fund", 260],
  ["units", 92],
  ["avgCost", 84],
  ["nav", 136],
  ["cost", 112],
  ["marketValue", 112],
  ["pending", 78],
  ["floatingPnL", 104],
  ["floatingRate", 84],
  ["historical", 108],
  ["actions", 112],
] as const;

const WEALTH_POSITION_COLS: readonly FundColumnSpec[] = [
  ["fund", 260],
  ["holdingDate", 96],
  ["units", 92],
  ["avgCost", 84],
  ["nav", 136],
  ["cost", 112],
  ["marketValue", 112],
  ["pending", 78],
  ["floatingPnL", 104],
  ["floatingRate", 84],
  ["historical", 108],
  ["actions", 112],
] as const;

type PositionColumnKey = typeof WEALTH_POSITION_COLS[number][0];

const FIXED_POSITION_COLUMNS = new Set<PositionColumnKey>(["fund", "actions"]);

const CLEARED_COLS = [
  ["fund", 220],
  ["firstBuy", 108],
  ["clearedDate", 108],
  ["buyAmount", 112],
  ["redeemAmount", 112],
  ["historical", 112],
  ["returnRate", 80],
] as const;

const DETAIL_COLS = [
  ["select", 44],
  ["date", 92],
  ["confirmDate", 92],
  ["arrivalDate", 92],
  ["cashAccount", 132],
  ["fund", 156],
  ["nav", 86],
  ["units", 84],
  ["remainingUnits", 92],
  ["subtype", 88],
  ["amount", 76],
  ["profit", 76],
  ["status", 72],
  ["tags", 110],
  ["note", 160],
  ["actions", 112],
] as const;

type DetailColumnKey = typeof DETAIL_COLS[number][0];

const FIXED_DETAIL_COLUMNS = new Set<DetailColumnKey>(["select", "actions"]);
const DEFAULT_HIDDEN_DETAIL_COLUMNS = new Set<DetailColumnKey>(["confirmDate", "note", "tags"]);
const FUND_DETAIL_HIDDEN_COLUMNS_DEFAULTS_KEY = `${FUND_DETAIL_HIDDEN_COLUMNS_KEY}:defaults_v3`;
const DETAIL_COLUMN_LABEL_KEYS: Record<DetailColumnKey, string> = {
  select: "",
  date: "fundShell.col.applyDate",
  confirmDate: "fundShell.col.confirmDate",
  arrivalDate: "fundShell.col.arrivalDate",
  cashAccount: "txForm.cashAccount",
  fund: "txForm.fund",
  nav: "viewImport.nav",
  units: "viewImport.units",
  remainingUnits: "fundShell.col.remainingUnits",
  subtype: "fundShell.col.subtype",
  amount: "txForm.amount",
  profit: "overview.profit",
  status: "fundShell.col.status",
  tags: "detail.column.tags",
  note: "detail.column.remark",
  actions: "",
};

const FUND_COL_MIN_WIDTHS: Record<FundTableKey, Record<string, number>> = {
  positions: {
    fund: 160,
    holdingDate: 78,
    units: 64,
    avgCost: 76,
    nav: 118,
    cost: 78,
    marketValue: 78,
    pending: 58,
    floatingPnL: 76,
    floatingRate: 64,
    historical: 78,
    actions: 88,
  },
  cleared: {
    fund: 150,
    firstBuy: 78,
    clearedDate: 78,
    buyAmount: 82,
    redeemAmount: 82,
    historical: 82,
    returnRate: 62,
  },
  details: {
    nav: 76,
  },
};

function minFundColWidth(table: FundTableKey, key: string) {
  return FUND_COL_MIN_WIDTHS[table]?.[key] ?? 44;
}

function minFundTableWidth(table: FundTableKey, cols: readonly (readonly [string, number])[]) {
  return cols.reduce((sum, [key]) => sum + minFundColWidth(table, key), 0);
}

type FundChartMode = "profit" | "nav" | "cumNav";
type FundChartRange = "month" | "quarter" | "halfYear" | "oneYear" | "sinceBuy";

type FundNavHistoryPoint = {
  date: string;
  nav: number;
  cumNav: number | null;
};

type FundChartEntry = {
  id: string;
  date: string;
  fundConfirmDate: string;
  fundSubtype: string;
  source: string;
  amount: number;
  units: number | null;
  fee: number;
};

type FundChartPoint = {
  date: string;
  value: number;
  nav: number;
  cumNav: number | null;
  units: number;
  cost: number;
  marketValue: number;
  hasPosition: boolean;
};

const FUND_CHART_RANGE_LABEL_KEYS: Record<FundChartRange, string> = {
  month: "fundShell.chartRange.month",
  quarter: "fundShell.chartRange.quarter",
  halfYear: "fundShell.chartRange.halfYear",
  oneYear: "fundShell.chartRange.oneYear",
  sinceBuy: "fundShell.chartRange.sinceBuy",
};

const localYmd = (date?: Date) => formatDateLocal(date ?? new Date());

function parseYmdDay(value: string | null | undefined) {
  const raw = String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [year, month, day] = raw.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function ymdFromDay(day: number) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function addDaysYmd(value: string, days: number) {
  const base = parseYmdDay(value);
  if (base == null) return "";
  return ymdFromDay(base + days);
}

function monthStartYmd(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value.slice(0, 8)}01` : value;
}

function formatChartMonthDay(value: string) {
  const date = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date.slice(5, 7)}-${date.slice(8, 10)}` : date;
}

function chartValueText(value: number, mode: FundChartMode) {
  if (mode === "profit") return formatMoney(value);
  return Math.abs(value) >= 100 ? value.toFixed(2) : value.toFixed(4);
}

function isFundBuyLikeEntry(entry: FundChartEntry) {
  return !entry.fundSubtype || entry.fundSubtype === "buy" || entry.fundSubtype === "regular_invest" || entry.fundSubtype === "dividend_reinvest" || entry.fundSubtype === "switch_in";
}

function firstFundBuyDate(entries: FundChartEntry[]) {
  return entries
    .filter(isFundBuyLikeEntry)
    .map((entry) => String(entry.date ?? "").slice(0, 10))
    .filter(Boolean)
    .sort()[0] ?? "";
}

function effectiveFundEntryDate(entry: FundChartEntry, confirmDays: number) {
  if (entry.fundConfirmDate) return entry.fundConfirmDate;
  const baseDate = String(entry.date ?? "").slice(0, 10);
  if (!baseDate) return "";
  return isFundBuyLikeEntry(entry) ? addDaysYmd(baseDate, Math.max(0, confirmDays)) : baseDate;
}

function availableFundChartRanges(history: FundNavHistoryPoint[], firstBuyDate: string): FundChartRange[] {
  const latest = history.at(-1)?.date ?? localYmd();
  const earliest = history[0]?.date ?? "";
  const canShow = (start: string) => !earliest || earliest <= start;
  const ranges: FundChartRange[] = ["month"];
  if (canShow(addDaysYmd(latest, -90))) ranges.push("quarter");
  if (canShow(addDaysYmd(latest, -180))) ranges.push("halfYear");
  if (canShow(addDaysYmd(latest, -365))) ranges.push("oneYear");
  if (firstBuyDate) ranges.push("sinceBuy");
  return Array.from(new Set(ranges));
}

function filterFundHistoryByRange(history: FundNavHistoryPoint[], range: FundChartRange, firstBuyDate: string) {
  if (history.length === 0) return history;
  const latest = history.at(-1)?.date ?? localYmd();
  const start = range === "month"
    ? monthStartYmd(latest)
    : range === "quarter"
      ? addDaysYmd(latest, -90)
      : range === "halfYear"
        ? addDaysYmd(latest, -180)
        : range === "oneYear"
          ? addDaysYmd(latest, -365)
          : firstBuyDate || history[0]!.date;
  return history.filter((point) => point.date >= start);
}

function buildFundProfitChartPoints(history: FundNavHistoryPoint[], entries: FundChartEntry[], confirmDays: number): FundChartPoint[] {
  const effectiveEntries = entries
    .map((entry) => ({ entry, day: parseYmdDay(effectiveFundEntryDate(entry, confirmDays)) }))
    .filter((item): item is { entry: FundChartEntry; day: number } => item.day != null)
    .sort((a, b) => a.day - b.day || String(a.entry.id).localeCompare(String(b.entry.id)));

  let entryIndex = 0;
  let units = 0;
  let cost = 0;

  return history.map((item) => {
    const navDay = parseYmdDay(item.date);
    if (navDay != null) {
      while (entryIndex < effectiveEntries.length && effectiveEntries[entryIndex]!.day <= navDay) {
        const entry = effectiveEntries[entryIndex]!.entry;
        const entryUnits = entry.units ?? 0;
        const entryAmount = Math.abs(entry.amount);
        if (entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out") {
          const reducingUnits = entryUnits > 0 ? entryUnits : 0;
          const avgCost = units > 0 ? cost / units : 0;
          units = Math.max(0, units - reducingUnits);
          cost = Math.max(0, cost - avgCost * reducingUnits);
        } else if (entry.fundSubtype === "dividend_cash" || entry.fundSubtype === "buy_failed") {
          // No share position is created by cash dividends or failed buys.
        } else if (entryUnits > 0) {
          units += entryUnits;
          cost += entryAmount + entry.fee;
        }
        entryIndex += 1;
      }
    }
    const hasPosition = units > 0;
    const marketValue = hasPosition ? item.nav * units : 0;
    return {
      date: item.date,
      value: hasPosition ? marketValue - cost : 0,
      nav: item.nav,
      cumNav: item.cumNav,
      units: hasPosition ? units : 0,
      cost: hasPosition ? cost : 0,
      marketValue,
      hasPosition,
    };
  });
}

function compactFundSubtypeLabel(t: (key: string) => string, entry: any, fallback: string) {
  const subtype = String(entry?.fundSubtype ?? "");
  const source = String(entry?.source ?? "");
  if (source === TRANSACTION_SOURCE_FUND_UNITS_RECONCILE) return t("fundShell.subtypeCompact.unitsReconcile");
  if (subtype === "buy_failed" && source === "regular_invest_refund") return t("fundShell.subtypeCompact.refund");
  if (subtype === "buy_failed") return t("fundShell.subtypeCompact.failed");
  if (subtype === "buy" && source === "regular_invest") return t("fund.subtype.regular_invest");
  if (subtype === "buy" && source === "dividend") return t("fund.subtype.dividend_reinvest");
  if (subtype === "buy") return t("fundShell.subtypeCompact.buy");
  if (subtype === "redeem") return t("fund.subtype.redeem");
  if (subtype === "dividend_cash") return t("fundShell.subtype.dividendCash");
  if (subtype === "dividend_reinvest" || source === "dividend") return t("fund.subtype.dividend_reinvest");
  if (subtype === "switch_in") return t("fund.subtype.switch");
  if (subtype === "switch_out") return t("fund.subtype.switch_out");
  return fallback;
}

function FundTrendChart({
  fundName,
  fundCode,
  history,
  entries,
  confirmDays,
  loading,
  error,
  mode,
  range,
  upClassName,
  downClassName,
  onModeChange,
  onRangeChange,
  embedded = false,
}: {
  fundName: string;
  fundCode: string;
  history: FundNavHistoryPoint[];
  entries: FundChartEntry[];
  confirmDays: number;
  loading: boolean;
  error: string;
  mode: FundChartMode;
  range: FundChartRange;
  upClassName: string;
  downClassName: string;
  onModeChange: (mode: FundChartMode) => void;
  onRangeChange: (range: FundChartRange) => void;
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const firstBuyDate = firstFundBuyDate(entries);
  const ranges = availableFundChartRanges(history, firstBuyDate);
  const activeRange = ranges.includes(range) ? range : ranges[0] ?? "month";
  const filteredHistory = filterFundHistoryByRange(history, activeRange, firstBuyDate);
  const profitPoints = buildFundProfitChartPoints(filteredHistory, entries, confirmDays);
  const hasCumNav = filteredHistory.some((point) => point.cumNav != null);
  const activeMode = mode === "cumNav" && !hasCumNav ? "nav" : mode;
  const points = activeMode === "profit"
    ? profitPoints
    : filteredHistory.map((item) => ({
        date: item.date,
        value: activeMode === "cumNav" ? item.cumNav ?? item.nav : item.nav,
        nav: item.nav,
        cumNav: item.cumNav,
        units: 0,
        cost: 0,
        marketValue: 0,
        hasPosition: false,
      }));
  const lineClass = activeMode === "profit" && (points.at(-1)?.value ?? 0) < 0 ? downClassName : activeMode === "profit" ? upClassName : "text-blue-600";
  const stroke = lineClass.includes("red") ? "#dc2626" : lineClass.includes("emerald") ? "#047857" : "#2563eb";
  const latestPoint = points.at(-1);

  useEffect(() => {
    if (activeRange !== range) onRangeChange(activeRange);
  }, [activeRange, onRangeChange, range]);

  useEffect(() => {
    if (activeMode !== mode) onModeChange(activeMode);
  }, [activeMode, mode, onModeChange]);

  return (
    <section
      className={embedded ? "mt-3 overflow-hidden border-t border-slate-100 pt-3" : "panel-surface shrink-0 overflow-hidden"}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className={embedded ? "flex flex-wrap items-start justify-between gap-2" : "flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 bg-white px-4 py-3"}>
        <div className={embedded ? "hidden" : "min-w-0"}>
          <div className="truncate text-sm font-semibold text-slate-800">{fundName || fundCode}</div>
          <div className="text-xs tabular-nums text-slate-400">{fundCode}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-md bg-slate-100 p-0.5 text-xs">
          {([
            ["profit", "fundShell.chart.profit"],
            ["nav", "fundShell.chart.nav"],
            ...(hasCumNav ? [["cumNav", "fundShell.chart.cumNav"] as const] : []),
          ] as const).map(([key, labelKey]) => (
            <button
              key={key}
              type="button"
              onClick={() => onModeChange(key)}
              className={`h-7 rounded px-2 ${activeMode === key ? "bg-white font-medium text-blue-700 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className={embedded ? "space-y-2 pt-2" : "space-y-2 px-4 py-3"}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {ranges.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onRangeChange(item)}
                className={`h-6 rounded border px-2 text-xs ${activeRange === item ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}
              >
                {t(FUND_CHART_RANGE_LABEL_KEYS[item])}
              </button>
            ))}
          </div>
          {latestPoint ? (
            <div className={`text-xs tabular-nums ${activeMode === "profit" ? lineClass : "text-slate-600"}`}>
              {chartValueText(latestPoint.value, activeMode)}
            </div>
          ) : null}
        </div>

        <div className={`${embedded ? "h-[180px]" : "h-[210px]"} w-full`}>
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-slate-400">{t("fundShell.chart.loading")}</div>
          ) : error ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-rose-500">{error}</div>
          ) : points.length < 2 ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-slate-400">{t("fundShell.chart.notEnoughPoints")}</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <RechartsLineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  tickLine={false}
                  axisLine={{ stroke: "#e2e8f0" }}
                  minTickGap={28}
                  tickFormatter={formatChartMonthDay}
                />
                <YAxis
                  width={58}
                  tick={{ fontSize: 11, fill: "#64748b" }}
                  tickLine={false}
                  axisLine={false}
                  domain={["auto", "auto"]}
                  tickFormatter={(value) => chartValueText(Number(value), activeMode)}
                />
                <Tooltip
                  cursor={{ stroke: "#94a3b8", strokeWidth: 1 }}
                  content={({ active, payload }: any) => {
                    const point = payload?.[0]?.payload as FundChartPoint | undefined;
                    if (!active || !point) return null;
                    return (
                      <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
                        <div className="mb-1 font-medium text-slate-700">{point.date}</div>
                        <div className="tabular-nums text-slate-600">
                          {activeMode === "profit" ? t("overview.profit") : activeMode === "cumNav" ? t("fundShell.chart.cumNav") : t("viewImport.nav")} {chartValueText(point.value, activeMode)}
                        </div>
                        <div className="tabular-nums text-slate-400">{t("fundShell.chart.unitNav", { nav: point.nav.toFixed(4) })}</div>
                        {activeMode === "profit" ? (
                          point.hasPosition ? (
                            <>
                              <div className="tabular-nums text-slate-400">{t("fundShell.chart.units", { units: point.units.toFixed(2) })}</div>
                              <div className="tabular-nums text-slate-400">{t("fundShell.chart.costMarketValue", { cost: formatMoney(point.cost), value: formatMoney(point.marketValue) })}</div>
                            </>
                          ) : (
                            <div className="text-slate-400">{t("fundShell.chart.unconfirmedPosition")}</div>
                          )
                        ) : null}
                      </div>
                    );
                  }}
                />
                <Line type="monotone" dataKey="value" stroke={stroke} strokeWidth={2} dot={false} activeDot={{ r: 3 }} isAnimationActive={false} />
              </RechartsLineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </section>
  );
}



export function FundShell(props: Props) {

  const {

    view, initialFundCode, positions, clearedPositions, allEntries,

    totalMarketValue, totalCost, totalHistoricalProfit,

    confirmDaysMap, feeRateMap, initialShowCleared, baseQuery,

    accountId, selectedAccount, accountOptions,

    cashAccounts, investmentAccounts, cashAccountSSOptions, investmentAccountSSOptions, metalTypes, metalUnits, nestedFieldData, createAction, editAction,

    fillNavAction, isRedUp,
    fundUnitsDecimals: fundUnitsDecimalsProp,

  } = props;

  const fundUnitsDecimals = Number.isFinite(Number(fundUnitsDecimalsProp)) ? Math.min(Math.max(Math.round(Number(fundUnitsDecimalsProp)), 0), 6) : 2;

  const { t } = useI18n();

  const formatFundUnits = useCallback((value: number) => value.toFixed(fundUnitsDecimals), [fundUnitsDecimals]);
  const accountProductType = selectedAccount?.investProductType ?? null;
  const isMetalAccount = accountProductType === "metal";
  const isWealthAccount = accountProductType === "wealth";
  const positionCols = isWealthAccount ? WEALTH_POSITION_COLS : POSITION_COLS;
  const assetNameLabel = isMetalAccount ? t("fundShell.col.species") : isWealthAccount ? t("fundShell.wealthProduct") : t("txForm.fund");
  const holdingTabLabel = isMetalAccount ? t("fundShell.tab.holdings.metal") : isWealthAccount ? t("fundShell.tab.holdings.wealth") : t("fundShell.tab.holdings.fund");
  const clearedTabLabel = isWealthAccount ? t("fundShell.tab.cleared.wealth") : t("fundShell.tab.cleared.fund");
  const noClearedText = isWealthAccount ? t("fundShell.empty.cleared.wealth") : t("fundShell.empty.cleared.fund");
  const chooseHoldingText = isWealthAccount ? t("fundShell.selectHoldingFirst.wealth") : t("fundShell.selectHoldingFirst.fund");
  const investmentAccountLabel = isWealthAccount ? t("fundShell.account.wealth") : t("viewImport.fundAccount");
  const fundAccountOptions = useMemo(() => investmentAccounts.filter((account: any) => isFundLikeInvestmentAccount(account)), [investmentAccounts]);
  const detailNameLabel = isWealthAccount ? t("fundShell.wealthProduct") : t("txForm.fund");
  const navColumnLabel = isMetalAccount ? t("fundShell.nav.unitPrice") : isWealthAccount ? t("fundShell.nav.wealth") : t("viewImport.nav");
  const detailAmountColumnLabel = isWealthAccount ? t("fundShell.amount.wealth") : t("txForm.amount");
  const entryAssetKey = useCallback((entry: any) => String(
    isWealthAccount
      ? entry?.wealthProductId ?? ""
      : isMetalAccount
        ? entry?.metalTypeId ?? ""
        : entry?.fundCode ?? "",
  ).trim(), [isMetalAccount, isWealthAccount]);
  const positionAssetKey = useCallback((position: any) => String(
    isWealthAccount
      ? position?.wealthProductId ?? ""
      : position?.fundCode ?? "",
  ).trim(), [isWealthAccount]);



  const [fundCode, setFundCode] = useState(initialFundCode);
  const [fundChartOpen, setFundChartOpen] = useState(false);
  const showAllRecords = false;
  const [fundSettingsCode, setFundSettingsCode] = useState<string | null>(null);
  const [fundSettingsName, setFundSettingsName] = useState<string | null>(null);
  const [positionDisplayRows, setPositionDisplayRows] = useState<any[]>([]);
  const handlePositionDisplayRowsChange = useCallback((rows: any[]) => setPositionDisplayRows(rows), []);
  const openFundSettings = useCallback((code: string | null | undefined, name?: string | null) => {
    const normalizedCode = String(code ?? "").trim();
    if (!/^\d{6}$/.test(normalizedCode)) return;
    setFundSettingsCode(normalizedCode);
    setFundSettingsName(name?.trim() || null);
  }, []);
  const handleFundSettingsChange = useCallback((item: FundProfileNavigationItem) => {
    setFundSettingsCode(item.fundCode);
    setFundSettingsName(item.fundName?.trim() || null);
  }, []);

  const [showCleared, setShowCleared] = useState(initialShowCleared);

  const [fundPage, setFundPage] = useState(1);

  const [fundPageSize, setFundPageSize] = useState(20);
  const [fundDetailAll, setFundDetailAll] = useState(false);
  const [detailTableRowCount, setDetailTableRowCount] = useState(0);

  const [showExportMenu, setShowExportMenu] = useState(false);

  const exportRef = useRef<HTMLDivElement>(null);

  const [adjustedNavByCode, setAdjustedNavByCode] = useState<Record<string, { nav: number; date: string }>>({});

  const [localData, setLocalData] = useState({
    positions,
    clearedPositions,
    allEntries,
    totalMarketValue,
    totalCost,
    positionHistoricalProfit: positions.reduce((sum: number, row: any) => sum + toNumber(row.historicalProfit ?? 0), 0),
    clearedHistoricalProfit: clearedPositions.reduce((sum: number, row: any) => sum + toNumber(row.historicalProfit ?? 0), 0),
    totalHistoricalProfit,
    confirmDaysMap,
    feeRateMap,
  });
  const [fetchedFundNames, setFetchedFundNames] = useState<Record<string, string>>({});
  const [positionEntryDefaults, setPositionEntryDefaults] = useState<any | null>(null);
  const positionEntryDefaultsRef = useRef<any | null>(null);
  const [positionEntryOpenSignal, setPositionEntryOpenSignal] = useState(0);
  const [detailEditSignal, setDetailEditSignal] = useState<{ id: string; value: number } | null>(null);
  const openDetailEdit = useCallback((entryId: string) => {
    setDetailEditSignal({ id: entryId, value: Date.now() });
  }, []);
  const [columnWidths, setColumnWidths] = useState<Record<string, Record<string, number>>>({});
  const positionColumnMenuRef = useRef<HTMLDivElement>(null);
  const detailColumnMenuRef = useRef<HTMLDivElement>(null);
  const [positionColumnMenuOpen, setPositionColumnMenuOpen] = useState(false);
  const [hiddenPositionColumns, setHiddenPositionColumns] = useState<Set<PositionColumnKey>>(new Set());
  const [detailColumnMenuOpen, setDetailColumnMenuOpen] = useState(false);
  const [hiddenDetailColumns, setHiddenDetailColumns] = useState<Set<DetailColumnKey>>(() => new Set(DEFAULT_HIDDEN_DETAIL_COLUMNS));
  const [fundChartMode, setFundChartMode] = useState<FundChartMode>("profit");
  const [fundChartRange, setFundChartRange] = useState<FundChartRange>("month");
  const closePositionColumnMenu = useCallback(() => setPositionColumnMenuOpen(false), []);
  const closeDetailColumnMenu = useCallback(() => setDetailColumnMenuOpen(false), []);
  const closeExportMenu = useCallback(() => setShowExportMenu(false), []);
  useOutsideClose(positionColumnMenuRef, positionColumnMenuOpen, closePositionColumnMenu);
  useOutsideClose(detailColumnMenuRef, detailColumnMenuOpen, closeDetailColumnMenu);
  useOutsideClose(exportRef, showExportMenu, closeExportMenu);
  const [fundNavHistoryState, setFundNavHistoryState] = useState<{
    code: string;
    loading: boolean;
    error: string;
    data: FundNavHistoryPoint[];
  }>({ code: "", loading: false, error: "", data: [] });

  // Shadow props with reactive local state
  const d = localData;

  useEffect(() => {
    if (!detailEditSignal) return;
    const timer = window.setTimeout(() => {
      setDetailEditSignal((current) => (current?.value === detailEditSignal.value ? null : current));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [detailEditSignal]);
  const refundLinkAllocation = useMemo(() => {
    return allocateBuyFailedRefunds((d.allEntries || []).map((entry: any) => ({
      id: String(entry.id ?? ""),
      date: entry.date,
      createdAt: entry.createdAt,
      fundConfirmDate: entry.fundConfirmDate,
      fundArrivalDate: entry.fundArrivalDate,
      accountId: entry.accountId ?? null,
      toAccountId: entry.toAccountId ?? null,
      fundCode: entryAssetKey(entry),
      fundName: entry.fundName ?? entry.productName ?? null,
      fundSubtype: entry.fundSubtype ?? null,
      source: entry.source ?? null,
      fundSourceEntryId: entry.fundSourceEntryId ?? null,
      amount: toNumber(entry.amount),
    })));
  }, [d.allEntries, entryAssetKey]);
  const refundAmountByBuyId = refundLinkAllocation.refundAmountByBuyId;
  const displayUnitsOfPlain = useCallback((entry: any) => {
    if (isMetalAccount) return entry.metalQuantity != null ? toNumber(entry.metalQuantity) : null;
    const storedUnits = entry.fundUnits != null ? toNumber(entry.fundUnits) : null;
    if (entry.fundSubtype === "buy" && storedUnits != null) {
      return getEffectiveBuyUnitsByRefunds(
        { id: String(entry.id ?? ""), amount: toNumber(entry.amount), fundUnits: storedUnits },
        refundAmountByBuyId,
      );
    }
    return storedUnits;
  }, [isMetalAccount, refundAmountByBuyId]);
  const displayUnitsOf = displayUnitsOfPlain;
  const detailAmountOf = useCallback((entry: any) => {
    const rawAmount = toNumber(entry?.amount);
    if (!isWealthAccount) {
      if (entry?.fundSubtype === "buy_failed") {
        return entry?.source === "regular_invest_refund" ? -Math.abs(rawAmount) : Math.abs(rawAmount);
      }
      if (entry?.fundSubtype !== "buy") return rawAmount;
      return Math.abs(rawAmount);
    }
    const isCashIn =
      entry?.fundSubtype === "redeem" ||
      entry?.fundSubtype === "switch_out" ||
      entry?.fundSubtype === "dividend_cash";
    if (!isCashIn) return rawAmount;
    const arrivalAmount = entry?.fundArrivalAmount != null ? toNumber(entry.fundArrivalAmount) : null;
    return arrivalAmount != null ? Math.abs(arrivalAmount) : Math.abs(rawAmount);
  }, [isWealthAccount]);
  const refundAmountOf = useCallback((entry: any) => {
    const linkedRefundAmount = refundAmountByBuyId.get(String(entry?.id ?? "")) ?? 0;
    const rowRefundAmount = Math.max(0, Math.abs(toNumber(entry?.refundAmount ?? 0)));
    return Math.max(linkedRefundAmount, rowRefundAmount);
  }, [refundAmountByBuyId]);
  const linkedCandidateEntries = useMemo(() => {
    return (d.allEntries || []).map((entry: any) => ({
      id: String(entry.id ?? ""),
      date: fmtDate(entry.date),
      createdAt: entry.createdAt,
      fundConfirmDate: fmtDate(entry.fundConfirmDate),
      fundArrivalDate: fmtDate(entry.fundArrivalDate),
      accountId: entry.accountId ?? null,
      toAccountId: entry.toAccountId ?? null,
      fundCode: entryAssetKey(entry),
      fundSubtype: entry.fundSubtype ?? null,
      fundUnits: displayUnitsOfPlain(entry),
      source: entry.source ?? null,
      fundSourceEntryId: entry.fundSourceEntryId ?? null,
      amount: toNumber(entry.amount),
    }));
  }, [d.allEntries, entryAssetKey, displayUnitsOfPlain]);





  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [singleDeletingIds, setSingleDeletingIds] = useState<Set<string>>(new Set());
  const [linkingIds, setLinkingIds] = useState<Set<string>>(new Set());

  const [batchDeleteMessage, setBatchDeleteMessage] = useState("");

  const [batchDeleting, setBatchDeleting] = useState(false);

  useEffect(() => {
    setLocalData({
      positions,
      clearedPositions,
      allEntries,
      totalMarketValue,
      totalCost,
      positionHistoricalProfit: positions.reduce((sum: number, row: any) => sum + toNumber(row.historicalProfit ?? 0), 0),
      clearedHistoricalProfit: clearedPositions.reduce((sum: number, row: any) => sum + toNumber(row.historicalProfit ?? 0), 0),
      totalHistoricalProfit,
      confirmDaysMap,
      feeRateMap,
    });
    setFundCode(initialFundCode || "");
    setShowCleared(initialShowCleared);
    setFundPage(1);
    setFundChartOpen(false);
    setSelectedIds(new Set());
    setDetailTableRowCount(0);
  }, [accountId, allEntries, clearedPositions, confirmDaysMap, feeRateMap, initialFundCode, initialShowCleared, positions, totalCost, totalHistoricalProfit, totalMarketValue, view]);



  type FundBatchField = "cashAccountId" | "fundAccountId" | "amount" | "fundFee" | "feeRate" | "fundConfirmDate" | "fundArrivalDate" | "remark";



  const upCls = pnlClassFromRedUp(1, isRedUp);

  const downCls = pnlClassFromRedUp(-1, isRedUp);

  const pnl = useCallback((n: number) => pnlClassFromRedUp(n, isRedUp), [isRedUp]);
  const positionDefaultSort = useMemo(() => ({ key: "marketValue", direction: "desc" as const }), []);
  const clearedDefaultSort = useMemo(() => ({ key: "clearedDate", direction: "desc" as const }), []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(FUND_TABLE_WIDTHS_KEY);
      if (raw) setColumnWidths(JSON.parse(raw));
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const allowed = new Set(WEALTH_POSITION_COLS.map(([key]) => key).filter((key) => !FIXED_POSITION_COLUMNS.has(key)));
      const raw = window.localStorage.getItem(FUND_POSITION_HIDDEN_COLUMNS_KEY);
      const next = new Set<PositionColumnKey>();
      if (raw) {
        const saved = JSON.parse(raw);
        if (Array.isArray(saved)) {
          for (const key of saved) {
            if (typeof key === "string" && allowed.has(key as PositionColumnKey)) next.add(key as PositionColumnKey);
          }
        }
      }
      setHiddenPositionColumns(next);
    } catch {}
  }, []);

  useEffect(() => {
    try {
      const allowed = new Set(DETAIL_COLS.map(([key]) => key).filter((key) => !FIXED_DETAIL_COLUMNS.has(key)));
      const raw = window.localStorage.getItem(FUND_DETAIL_HIDDEN_COLUMNS_KEY);
      const defaultsApplied = window.localStorage.getItem(FUND_DETAIL_HIDDEN_COLUMNS_DEFAULTS_KEY) === "1";
      const next = new Set<DetailColumnKey>();
      if (raw) {
        const saved = JSON.parse(raw);
        if (Array.isArray(saved)) {
          for (const key of saved) {
            if (typeof key === "string" && allowed.has(key as DetailColumnKey)) next.add(key as DetailColumnKey);
          }
        }
      }
      if (!defaultsApplied) {
        for (const key of DEFAULT_HIDDEN_DETAIL_COLUMNS) {
          if (allowed.has(key)) next.add(key);
        }
        window.localStorage.setItem(FUND_DETAIL_HIDDEN_COLUMNS_DEFAULTS_KEY, "1");
        window.localStorage.setItem(FUND_DETAIL_HIDDEN_COLUMNS_KEY, JSON.stringify(Array.from(next)));
      }
      setHiddenDetailColumns(next);
    } catch {}
  }, []);

  const colWidth = useCallback((table: FundTableKey, key: string, fallback: number) => {
    const width = columnWidths[table]?.[key];
    const minWidth = minFundColWidth(table, key);
    return Math.max(minWidth, Number.isFinite(width) ? Number(width) : fallback);
  }, [columnWidths]);

  const isSingleNormalFundScope = Boolean(fundCode && !isMetalAccount && !isWealthAccount);
  const isAllWealthDetailScope = Boolean(isWealthAccount && !fundCode);
  const hideRemainingUnitsDetailColumn = !isWealthAccount || isAllWealthDetailScope;
  const visiblePositionCols = useMemo(
    () => positionCols.filter(([key]) => !hiddenPositionColumns.has(key as PositionColumnKey)),
    [hiddenPositionColumns, positionCols],
  );

  const visibleDetailCols = useMemo(
    () => DETAIL_COLS.filter(([key]) =>
      !(isWealthAccount && key === "status") &&
      !(hideRemainingUnitsDetailColumn && key === "remainingUnits") &&
      !(isSingleNormalFundScope && key === "fund") &&
      !hiddenDetailColumns.has(key)
    ),
    [hiddenDetailColumns, hideRemainingUnitsDetailColumn, isSingleNormalFundScope, isWealthAccount],
  );
  const visibleDetailDataCols = useMemo(
    () => visibleDetailCols.filter(([key]) => !FIXED_DETAIL_COLUMNS.has(key)),
    [visibleDetailCols],
  );
  const visibleOptionalDetailColumnCount = visibleDetailCols.filter(([key]) => !FIXED_DETAIL_COLUMNS.has(key)).length;
  const detailMinTableWidth = useMemo(
    () => Math.min(1100, visibleDetailDataCols.reduce((sum, [, fallback]) => sum + fallback, 0)),
    [visibleDetailDataCols],
  );
  const isDetailColumnVisible = useCallback(
    (key: DetailColumnKey) =>
      !(isWealthAccount && key === "status") &&
      !(hideRemainingUnitsDetailColumn && key === "remainingUnits") &&
      !(isSingleNormalFundScope && key === "fund") &&
      !hiddenDetailColumns.has(key),
    [hiddenDetailColumns, hideRemainingUnitsDetailColumn, isSingleNormalFundScope, isWealthAccount],
  );

  const toggleDetailColumnVisibility = useCallback((key: DetailColumnKey) => {
    if (isWealthAccount && key === "status") return;
    if (hideRemainingUnitsDetailColumn && key === "remainingUnits") return;
    if (FIXED_DETAIL_COLUMNS.has(key)) return;
    setHiddenDetailColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else {
        const visibleOptionalCount = DETAIL_COLS.filter(([colKey]) =>
          !(isWealthAccount && colKey === "status") &&
          !(hideRemainingUnitsDetailColumn && colKey === "remainingUnits") &&
          !FIXED_DETAIL_COLUMNS.has(colKey) &&
          !next.has(colKey)
        ).length;
        if (visibleOptionalCount <= 1) return prev;
        next.add(key);
      }
      try {
        window.localStorage.setItem(FUND_DETAIL_HIDDEN_COLUMNS_KEY, JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  }, [hideRemainingUnitsDetailColumn, isWealthAccount]);

  const fundNameByCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of [...(d.positions || []), ...(d.clearedPositions || [])] as any[]) {
      const code = String(p?.fundCode ?? "").trim();
      const name = String(p?.name ?? "").trim();
      if (code && name && name !== code) map.set(code, name);
    }
    return map;
  }, [d.positions, d.clearedPositions]);

  const displayFundName = useCallback((entry: any) => {
    if (isMetalAccount) {
      const typeName = String(entry?.metalTypeName ?? "").trim();
      const unitName = String(entry?.metalUnitName ?? "").trim();
      return [typeName, unitName].filter(Boolean).join(" · ") || String(entry?.metalTypeId ?? "").trim() || "-";
    }
    if (isWealthAccount) {
      return String(entry?.fundName ?? entry?.productName ?? "").trim() || "-";
    }
    const code = String(entry?.fundCode ?? "").trim();
    const fetched = code ? fetchedFundNames[code] : "";
    if (fetched && !isGenericFundName(fetched, code)) return fetched;
    const mapped = code ? fundNameByCode.get(code) : "";
    if (mapped && !isGenericFundName(mapped, code)) return mapped;
    const stored = String(entry?.fundName ?? "").trim();
    if (stored && !isGenericFundName(stored, code)) return stored;
    return code || "-";
  }, [fetchedFundNames, fundNameByCode, isMetalAccount, isWealthAccount]);

  const entryBusinessLinkInfo = useCallback((entry: any) => {
    const countFromSummary = Number(entry?.businessLinkCount ?? 0);
    const cashLinks = Array.isArray(entry?.EntryBusinessLinkCash) ? entry.EntryBusinessLinkCash : [];
    const businessLinks = Array.isArray(entry?.EntryBusinessLinkBusiness) ? entry.EntryBusinessLinkBusiness : [];
    const fundLinks = Array.isArray(entry?.EntryBusinessLink) ? entry.EntryBusinessLink : [];
    const count = countFromSummary || cashLinks.length + businessLinks.length + fundLinks.length;
    const labels = Array.isArray(entry?.businessLinkLabels) ? entry.businessLinkLabels.filter(Boolean) : [];
    return { active: count > 0, labels };
  }, []);



  async function exportXlsx(scope?: "current" | "all") {

    const rows = (scope === "current" ? filtered : (allEntries || [])) as any[];

    const label = scope === "current" ? fundCode || "current" : "all";

    const header = [
      t("fundShell.col.applyDate"),
      t("fundShell.col.confirmDate"),
      t("fundShell.col.arrivalDate"),
      t("txForm.cashAccount"),
      isWealthAccount ? t("fundShell.export.wealthProductId") : t("viewImport.fundCode"),
      isWealthAccount ? t("fundShell.export.wealthName") : t("viewImport.fundName"),
      navColumnLabel,
      isMetalAccount ? t("fundShell.col.quantity") : t("viewImport.units"),
      ...(isWealthAccount ? [t("fundShell.col.remainingUnits")] : []),
      t("fundShell.col.subtype"),
      detailAmountColumnLabel,
      t("overview.profit"),
      ...(isWealthAccount ? [] : [t("fundShell.col.status")]),
    ];

    const accountLabelByIdLocal = new Map<string, string>();

    for (const a of accountOptions as any[]) {

      if (a?.id) accountLabelByIdLocal.set(String(a.id), String(a.label ?? ""));

    }

    const exportRows: Array<Array<string | number>> = [header];

    for (const e of rows) {

      const nav = e.fundNav != null ? e.fundNav : "";

      const units = displayUnitsOf(e) != null ? displayUnitsOf(e) : "";

      const amt = e.amount != null ? detailAmountOf(e) : "";

      const profit = e.realizedProfit != null ? e.realizedProfit : "";

      const subtype = fl(t, e.fundSubtype, e.source).label;

      // redeem/dividend_cash: the cash receiver is toAccountId

      const isR = e.fundSubtype === "redeem" || e.fundSubtype === "dividend_cash";

      const cashAccLabel = accountLabelByIdLocal.get(String(isR ? e.toAccountId : e.accountId)) ?? "";

      const cashAccName = cashAccLabel || "-";

      // buy_failed has no actual confirmDate/units — show "-"

      const isBuyFailed = e.fundSubtype === "buy_failed";

      const confirmDate = isBuyFailed ? "-"

        : e.fundSubtype === "dividend_cash" ? fmtDate(e.fundArrivalDate)

        : (displayUnitsOf(e) != null && Number(displayUnitsOf(e)) > 0) ? fmtDate(e.fundConfirmDate) : t("fundShell.status.pending");

      const status = isBuyFailed
        ? (e.source === "regular_invest_refund" ? t("fundShell.status.buyRefund") : t("fundShell.status.buyFailed"))
        : e.fundSubtype === "dividend_cash" ? t("fundShell.status.confirmed")
        : (e.fundSubtype === "buy" && (refundAmountByBuyId.get(String(e.id ?? "")) ?? 0) > 0) ? t("fundShell.status.partial") : (e.fundUnits == null || Number(e.fundUnits) === 0) ? t("fundShell.status.pending") : t("fundShell.status.confirmed");



      exportRows.push([

        fundApplyDateOf(e),

        confirmDate || "",

        e.fundArrivalDate ? fmtDate(e.fundArrivalDate) : "",

        cashAccName,

        isWealthAccount ? e.wealthProductId || "" : e.fundCode || "",

        displayFundName(e),

        nav === "" ? "" : Number(nav),

        units === "" ? "" : Number(units),

        ...(isWealthAccount ? [e.wealthRemainingUnits != null ? Number(e.wealthRemainingUnits) : ""] : []),

        subtype,

        amt === "" ? "" : Number(amt),

        profit === "" ? "" : Number(profit),

        ...(isWealthAccount ? [] : [status]),

      ]);

    }

    await exportRowsToXlsx(
      exportRows,
      `${t("fundShell.entriesTitle")}_${label}_${new Date().toISOString().slice(0, 10)}.xlsx`,
      t("fundShell.entriesTitle"),
    );

  }



  const sortedPositions = useMemo(() => {

    return [...d.positions].sort((a: any, b: any) => {

      const marketValueDiff = toNumber(b.marketValue) - toNumber(a.marketValue);
      if (marketValueDiff !== 0) return marketValueDiff;
      return String(a.fundCode ?? a.name ?? "").localeCompare(String(b.fundCode ?? b.name ?? ""));

    });

  }, [d.positions]);



  const sortedClearedPositions = useMemo(() => {

    return [...d.clearedPositions].sort((a: any, b: any) => {

      const clearedDateDiff = String(b.clearedDate ?? "").localeCompare(String(a.clearedDate ?? ""));
      if (clearedDateDiff !== 0) return clearedDateDiff;
      return String(a.fundCode ?? a.name ?? "").localeCompare(String(b.fundCode ?? b.name ?? ""));

    });

  }, [d.clearedPositions]);

  const fundSettingsFunds = useMemo<FundProfileNavigationItem[]>(() => {
    const activeFundCodes = new Set(
      (d.positions || [])
        .map((position: any) => String(position?.fundCode ?? "").trim())
        .filter((code: string) => /^\d{6}$/.test(code)),
    );
    const displayedRows = (positionDisplayRows.length > 0 ? positionDisplayRows : sortedPositions)
      .filter((position: any) => activeFundCodes.has(String(position?.fundCode ?? "").trim()));
    const sourceRows = displayedRows.length > 0 ? displayedRows : sortedPositions;
    const map = new Map<string, FundProfileNavigationItem>();
    for (const position of sourceRows as any[]) {
      const code = String(position?.fundCode ?? "").trim();
      if (!/^\d{6}$/.test(code) || map.has(code)) continue;
      const name = String(position?.name ?? position?.fundName ?? "").trim();
      map.set(code, { fundCode: code, fundName: name && name !== code ? name : null });
    }
    if (fundSettingsCode && !map.has(fundSettingsCode)) {
      map.set(fundSettingsCode, { fundCode: fundSettingsCode, fundName: fundSettingsName });
    }
    return Array.from(map.values());
  }, [d.positions, fundSettingsCode, fundSettingsName, positionDisplayRows, sortedPositions]);



  const switchFund = useCallback((code: string) => {
    if (!code) return;

    setFundCode(code);
    setFundPage(1);

    const q = new URLSearchParams(baseQuery);

    q.set("view", view);
    if (isWealthAccount) {
      q.set("wealthProductId", code);
      q.delete("fundCode");
    } else {
      q.set("fundCode", code);
      q.delete("wealthProductId");
    }

    if (showCleared) q.set("showCleared", "1");

    window.history.replaceState(null, "", `/?${q.toString()}`);

  }, [baseQuery, isWealthAccount, showCleared, view]);

  function toggleCleared(on: boolean) {

    setShowCleared(on);
    setFundChartOpen(false);

    const q = new URLSearchParams(baseQuery); q.set("view", view);

    if (on) { q.set("showCleared", "1"); q.delete("fundCode"); q.delete("wealthProductId"); }

    else { q.delete("showCleared"); q.delete("fundCode"); q.delete("wealthProductId"); }

    window.history.replaceState(null, "", `/?${q.toString()}`);

    setFundCode("");

    setFundPage(1);

  }



  // Listen for fund data refresh event from modals (stable handler with debounce)
  const refreshBusy = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const shellDataRequestSeq = useRef(0);
  const fundCodeRef = useRef(fundCode);
  const showClearedRef = useRef(showCleared);
  const accountIdRef = useRef(accountId);
  const isWealthAccountRef = useRef(isWealthAccount);

  useEffect(() => {
    fundCodeRef.current = fundCode;
    showClearedRef.current = showCleared;
    accountIdRef.current = accountId;
    isWealthAccountRef.current = isWealthAccount;
  }, [fundCode, showCleared, accountId, isWealthAccount]);

  const loadFundShellData = useCallback(async (code: string, cleared: boolean) => {
    const seq = ++shellDataRequestSeq.current;
    try {
      const sc = cleared ? "1" : "0";
      const selectedParam = code
        ? isWealthAccount
          ? `&wealthProductId=${encodeURIComponent(code)}`
          : `&fundCode=${encodeURIComponent(code)}`
        : "";
      const res = await fetch(`/api/v1/fund/shell-data?accountId=${encodeURIComponent(accountId)}${selectedParam}&showCleared=${sc}&entryScope=account`);
      const json = await res.json();
      if (json.ok && seq === shellDataRequestSeq.current) {
        startTransition(() => {
          setLocalData((prev) => {
            const refreshedEntries = Array.isArray(json.allEntries) ? json.allEntries : [];
            const refreshedIds = new Set(refreshedEntries.map((entry: any) => entry.id));
            const nextAllEntries = json.entryScope === "account"
              ? refreshedEntries
              : code
              ? [
                  ...prev.allEntries.filter((entry: any) => entryAssetKey(entry) !== code && !refreshedIds.has(entry.id)),
                  ...refreshedEntries,
                ]
              : refreshedEntries;

            return {
              positions: json.positions,
              clearedPositions: json.clearedPositions,
              allEntries: nextAllEntries,
              totalMarketValue: json.totalMarketValue,
              totalCost: json.totalCost,
              positionHistoricalProfit: json.positionHistoricalProfit ?? 0,
              clearedHistoricalProfit: json.clearedHistoricalProfit ?? 0,
              totalHistoricalProfit: json.totalHistoricalProfit,
              confirmDaysMap: json.confirmDaysMap,
              feeRateMap: json.feeRateMap,
            };
          });
        });
      }
    } catch {}
  }, [accountId, entryAssetKey, isWealthAccount]);

  const handleEntryNavFilled = useCallback((entry: any, data: { nav: number; confirmDate: string; units: number; arrivalDate?: string }) => {
    const code = entry.fundCode || fundCodeRef.current;

    if (code) {
      setAdjustedNavByCode((prev) => {
        if (!(code in prev)) return prev;
        const next = { ...prev };
        delete next[code];
        return next;
      });
    }

    setLocalData(prev => ({
      ...prev,
      allEntries: prev.allEntries.map((en: any) => en.id === entry.id ? {
        ...en,
        fundNav: data.nav,
        fundConfirmDate: data.confirmDate ? new Date(data.confirmDate) : en.fundConfirmDate,
        fundUnits: data.units,
        fundArrivalDate: data.arrivalDate ? new Date(data.arrivalDate) : en.fundArrivalDate,
      } : en),
    }));

    if (code) void loadFundShellData(code, showClearedRef.current);
  }, [loadFundShellData]);

  function openPositionEntryModal(position: any) {
    const code = String(position?.fundCode ?? "").trim();
    if (!code) return;
    const nextDefaults = {
      fundCode: code,
      fundName: String(position?.name ?? code),
      fundUnits: position?.units != null ? toNumber(position.units) : null,
      confirmDays: d.confirmDaysMap[code] ?? selectedAccount?.defaultConfirmDays ?? undefined,
      feeRate: d.feeRateMap[`${code}:buy`] ?? null,
    };
    positionEntryDefaultsRef.current = nextDefaults;
    setPositionEntryDefaults(nextDefaults);
    setPositionEntryOpenSignal((value) => value + 1);
  }

  const shellRefreshHandler = useCallback(async () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(async () => {
      if (refreshBusy.current) return;
      refreshBusy.current = true;
      try {
        const fc = fundCodeRef.current;
        if (!fc && !isWealthAccountRef.current) return;
        const sc = showClearedRef.current ? "1" : "0";
        const aid = accountIdRef.current;
        const seq = ++shellDataRequestSeq.current;
        const selectedParam = fc
          ? isWealthAccountRef.current
            ? `&wealthProductId=${encodeURIComponent(fc)}`
            : `&fundCode=${encodeURIComponent(fc)}`
          : "";
        const res = await fetch(`/api/v1/fund/shell-data?accountId=${encodeURIComponent(aid)}${selectedParam}&showCleared=${sc}&entryScope=account`);
        const json = await res.json();
        if (json.ok && seq === shellDataRequestSeq.current) {
          startTransition(() => {
            setLocalData((prev) => {
              const refreshedEntries = Array.isArray(json.allEntries) ? json.allEntries : [];
              const refreshedIds = new Set(refreshedEntries.map((entry: any) => entry.id));
              const nextAllEntries = json.entryScope === "account"
                ? refreshedEntries
                : fc
                ? [
                    ...prev.allEntries.filter((entry: any) => entryAssetKey(entry) !== fc && !refreshedIds.has(entry.id)),
                    ...refreshedEntries,
                  ]
                : refreshedEntries;

              return {
                positions: json.positions,
                clearedPositions: json.clearedPositions,
                allEntries: nextAllEntries,
                totalMarketValue: json.totalMarketValue,
                totalCost: json.totalCost,
                positionHistoricalProfit: json.positionHistoricalProfit ?? 0,
                clearedHistoricalProfit: json.clearedHistoricalProfit ?? 0,
                totalHistoricalProfit: json.totalHistoricalProfit,
                confirmDaysMap: json.confirmDaysMap,
                feeRateMap: json.feeRateMap,
              };
            });
          });
        }
      } catch {} finally {
        refreshBusy.current = false;
      }
    }, 80);
  }, [entryAssetKey]);

  useEffect(() => {
    const onFundChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ balanceChanged?: boolean }>).detail;
      // Remark-only edits do not change holdings: skip the shell refresh.
      if (detail?.balanceChanged === false) return;
      shellRefreshHandler();
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, onFundChanged);
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, onFundChanged);
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [shellRefreshHandler]);







  const fundApplyDateOf = useCallback((entry: any) => {
    if (entry?.fundSubtype === "buy_failed" && entry?.source === "regular_invest_refund") {
      const linkedBuyId = String(entry.fundSourceEntryId ?? "").trim()
        || Array.from(refundLinkAllocation.buyIdsByRefundId.get(String(entry?.id ?? "")) ?? [])[0]
        || "";
      if (linkedBuyId) {
        const linkedBuy = (d.allEntries || []).find((item: any) => String(item?.id ?? "") === linkedBuyId);
        const linkedDate = fmtDate(linkedBuy?.date);
        if (linkedDate) return linkedDate;
      }
    }
    return fmtDate(entry?.date);
  }, [d.allEntries, refundLinkAllocation]);

  const filtered = useMemo(() => {
    const source = fundCode
      ? d.allEntries.filter((e: any) => entryAssetKey(e) === fundCode)
      : showAllRecords || isWealthAccount ? d.allEntries ?? [] : [];
    return [...source]
      .sort((a: any, b: any) => {
        const byApplyDate = fundApplyDateOf(b).localeCompare(fundApplyDateOf(a));
        if (byApplyDate !== 0) return byApplyDate;
        const byCreatedAt = fmtDate(b.createdAt).localeCompare(fmtDate(a.createdAt));
        if (byCreatedAt !== 0) return byCreatedAt;
        return String(b.id ?? "").localeCompare(String(a.id ?? ""));
      });
  }, [d.allEntries, entryAssetKey, fundApplyDateOf, fundCode, isWealthAccount, showAllRecords]);
  const selectedPosition = useMemo(
    () => (d.positions || []).find((p: any) => positionAssetKey(p) === fundCode) ?? null,
    [d.positions, fundCode, positionAssetKey],
  );
  const selectedAnyPosition = useMemo(
    () => ([...(d.positions || []), ...(d.clearedPositions || [])] as any[]).find((p: any) => positionAssetKey(p) === fundCode) ?? null,
    [d.positions, d.clearedPositions, fundCode, positionAssetKey],
  );
  const selectedFundDisplayName = useMemo(() => {
    if (!fundCode) return "";
    if (isWealthAccount) return String(selectedPosition?.name ?? "").trim();
    const candidates = [
      selectedAnyPosition?.name,
      selectedPosition?.name,
      fundNameByCode.get(fundCode),
      fetchedFundNames[fundCode],
    ];
    for (const candidate of candidates) {
      const name = String(candidate ?? "").trim();
      if (name && !isGenericFundName(name, fundCode)) return name;
    }
    return fundCode;
  }, [fetchedFundNames, fundCode, fundNameByCode, isWealthAccount, selectedAnyPosition?.name, selectedPosition?.name]);
  const selectedFundCodeCls = selectedPosition ? pnl(toNumber(selectedPosition.historicalProfit ?? selectedPosition.floatingPnL ?? 0)) : "text-slate-500";
  const selectedFundChartEntries = useMemo<FundChartEntry[]>(() => {
    if (!fundCode || isMetalAccount || isWealthAccount) return [];
    return filtered.map((entry: any) => ({
      id: String(entry?.id ?? ""),
      date: fundApplyDateOf(entry),
      fundConfirmDate: fmtDate(entry?.fundConfirmDate),
      fundSubtype: String(entry?.fundSubtype ?? ""),
      source: String(entry?.source ?? ""),
      amount: toNumber(entry?.amount),
      units: displayUnitsOfPlain(entry),
      fee: toNumber(entry?.fundFee ?? entry?.fee ?? 0),
    }));
  }, [displayUnitsOfPlain, filtered, fundApplyDateOf, fundCode, isMetalAccount, isWealthAccount]);
  const selectedFundFirstBuyDate = useMemo(() => firstFundBuyDate(selectedFundChartEntries), [selectedFundChartEntries]);
  const selectedFundChartStartDate = useMemo(() => {
    const oneYearAgo = addDaysYmd(localYmd(), -365);
    return selectedFundFirstBuyDate && selectedFundFirstBuyDate < oneYearAgo ? selectedFundFirstBuyDate : oneYearAgo;
  }, [selectedFundFirstBuyDate]);
  const showSelectedFundChart = Boolean(fundChartOpen && fundCode && !isMetalAccount && !isWealthAccount);
  const selectedFundNameForChart = selectedFundDisplayName || fundCode;
  const selectedFundConfirmDays = Number(d.confirmDaysMap?.[fundCode] ?? selectedAccount?.defaultConfirmDays ?? 0) || 0;

  useEffect(() => {
    if (!showSelectedFundChart) {
      setFundNavHistoryState({ code: "", loading: false, error: "", data: [] });
      return;
    }
    const controller = new AbortController();
    setFundNavHistoryState((prev) => ({
      code: fundCode,
      loading: true,
      error: "",
      data: prev.code === fundCode ? prev.data : [],
    }));
    const params = new URLSearchParams({
      code: fundCode,
      start: selectedFundChartStartDate,
      end: localYmd(),
    });
    fetch(`/api/v1/fund/nav/history?${params.toString()}`, { cache: "no-store", signal: controller.signal })
      .then((res) => res.json())
      .then((json) => {
        if (controller.signal.aborted) return;
        if (!json?.ok || !Array.isArray(json.data)) {
          setFundNavHistoryState({ code: fundCode, loading: false, error: String(json?.error ?? t("fundShell.chart.loadFailed")), data: [] });
          return;
        }
        const data = json.data
          .map((item: any) => ({
            date: String(item?.date ?? "").slice(0, 10),
            nav: toNumber(item?.nav),
            cumNav: item?.cumNav == null ? null : toNumber(item.cumNav),
          }))
          .filter((item: FundNavHistoryPoint) => item.date && Number.isFinite(item.nav) && item.nav > 0)
          .sort((a: FundNavHistoryPoint, b: FundNavHistoryPoint) => a.date.localeCompare(b.date));
        setFundNavHistoryState({ code: fundCode, loading: false, error: "", data });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setFundNavHistoryState({ code: fundCode, loading: false, error: error instanceof Error ? error.message : t("fundShell.chart.loadFailed"), data: [] });
      });
    return () => controller.abort();
  }, [fundCode, selectedFundChartStartDate, showSelectedFundChart, t]);

  useEffect(() => {
    const candidates = new Map<string, string>();
    for (const e of filtered as any[]) {
      const code = String(e?.fundCode ?? "").trim();
      if (!code || code.length !== 6 || fetchedFundNames[code]) continue;
      const mapped = fundNameByCode.get(code) ?? "";
      const stored = String(e?.fundName ?? "").trim();
      if (!isGenericFundName(mapped || stored, code)) continue;
      candidates.set(code, code);
    }
    for (const code of Array.from(candidates.keys()).slice(0, 5)) {
      fetch(`/api/v1/fund/name?code=${encodeURIComponent(code)}`)
        .then((res) => res.ok ? res.json() : null)
        .then((json) => {
          const name = String(json?.name ?? "").trim();
          if (!name || isGenericFundName(name, code)) return;
          setFetchedFundNames((prev) => prev[code] ? prev : { ...prev, [code]: name });
        })
        .catch(() => {});
    }
  }, [filtered, fetchedFundNames, fundNameByCode]);



  useEffect(() => {

    const list = showCleared ? sortedClearedPositions : sortedPositions;

    const available = (list || []).map((p: any) => positionAssetKey(p)).filter(Boolean);



    const q = new URLSearchParams(baseQuery);

    q.set("view", view);

    if (showCleared) q.set("showCleared", "1");

    else q.delete("showCleared");



    if (available.length === 0) {

      if (fundCode) setFundCode("");
      if (fundChartOpen) setFundChartOpen(false);

      q.delete("fundCode");
      q.delete("wealthProductId");

      window.history.replaceState(null, "", `/?${q.toString()}`);

      return;

    }



    if (isWealthAccount) {
      if (fundCode && !available.includes(fundCode)) {
        setFundCode("");
        setFundPage(1);
        q.delete("wealthProductId");
      } else if (fundCode) {
        q.set("wealthProductId", fundCode);
      }
      q.delete("fundCode");
      window.history.replaceState(null, "", `/?${q.toString()}`);
      return;
    }

    if (!fundCode) {
      if (fundChartOpen) setFundChartOpen(false);
      q.delete("fundCode");
      q.delete("wealthProductId");
      window.history.replaceState(null, "", `/?${q.toString()}`);
      return;
    }

    if (!available.includes(fundCode)) {

      setFundCode("");
      setFundChartOpen(false);

      setFundPage(1);

      q.delete("fundCode");
      q.delete("wealthProductId");

      window.history.replaceState(null, "", `/?${q.toString()}`);

      return;

    }

    q.set("fundCode", fundCode);
    q.delete("wealthProductId");
    window.history.replaceState(null, "", `/?${q.toString()}`);

  }, [baseQuery, view, showCleared, fundCode, fundChartOpen, sortedPositions, sortedClearedPositions, isWealthAccount, positionAssetKey]);


  const positionDisplayMetrics = useCallback((p: any) => {
    const adj = adjustedNavByCode[p.fundCode];
    const displayNav = adj ? adj.nav : p.nav;
    const displayNavDate = adj ? adj.date : p.navDate;
    const displayMV = adj && p.units > 0 ? p.units * adj.nav : p.marketValue;
    const displayPnL = adj ? displayMV - p.cost : p.floatingPnL;
    const displayPnLRate = p.cost > 0 ? (displayPnL / p.cost) * 100 : 0;
    return { displayNav, displayNavDate, displayMV, displayPnL, displayPnLRate };
  }, [adjustedNavByCode]);

  const renderPositionActions = useCallback((p: any) => {
    const positionKey = positionAssetKey(p);
    const active = positionKey === fundCode;
    return (
      <div
        data-row-double-click-ignore
        className="flex items-center justify-end gap-0.5"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {!isMetalAccount ? (
          <>
            <AddNavButton accountId={accountId} positions={[p]} defaultFundCode={p.fundCode} trigger="icon" wealthMode={isWealthAccount} />
            {!isWealthAccount ? <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openFundSettings(p.fundCode || positionKey, p.name);
              }}
              className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 transition-colors hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
              title={t("fundSettings.title")}
              aria-label={t("fundSettings.title")}
              >
              <Settings2 className="h-3.5 w-3.5" />
            </button> : null}
            {!isWealthAccount ? (
              <button
                type="button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  switchFund(positionKey || p.fundCode);
                  setFundChartOpen(true);
                }}
                className={`inline-flex h-6 w-6 items-center justify-center rounded-md border transition-colors ${
                  active && fundChartOpen
                    ? "border-blue-300 bg-blue-50 text-blue-700"
                    : "border-slate-200 bg-white text-slate-500 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                }`}
                title={t("fundShell.chart.viewTitle")}
                aria-label={t("fundShell.chart.viewTitle")}
              >
                <ChartLine className="h-3 w-3" />
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    );
  }, [
    accountId,
    fundChartOpen,
    fundCode,
    isMetalAccount,
    isWealthAccount,
    openFundSettings,
    positionAssetKey,
    switchFund,
    t,
  ]);

  const allPositionAdvancedColumns = useMemo<AdvancedDataTableColumn<any>[]>(() => {
    const columns: AdvancedDataTableColumn<any>[] = [
      {
        key: "fund",
        label: assetNameLabel,
        width: colWidth("positions", "fund", 260),
        minWidth: minFundColWidth("positions", "fund"),
        headerClassName: "text-left",
        className: "px-4",
        sortValue: (p) => String(isWealthAccount ? p.name ?? "" : p.fundCode ?? p.name ?? ""),
        render: (p) => {
          const positionKey = positionAssetKey(p);
          const active = positionKey === fundCode;
          const { displayPnL } = positionDisplayMetrics(p);
          return (
            <span
              className={`block truncate font-medium ${active ? "text-blue-700" : "text-slate-700"}`}
              title={isWealthAccount ? p.name : `${p.name} ${p.fundCode}`}
            >
              {p.name}
              {!isWealthAccount && p.fundCode !== p.name ? <span className={`ml-1 ${pnl(displayPnL)}`}>{p.fundCode}</span> : null}
            </span>
          );
        },
      },
      ...(isWealthAccount ? [{
        key: "holdingDate",
        label: t("fundShell.col.holdingDate"),
        width: colWidth("positions", "holdingDate", 96),
        minWidth: minFundColWidth("positions", "holdingDate"),
        headerClassName: "text-left",
        className: "text-left tabular-nums text-slate-600",
        sortValue: (p: any) => String(p.holdingDate ?? ""),
        render: (p: any) => p.holdingDate || "-",
      } satisfies AdvancedDataTableColumn<any>] : []),
      {
        key: "units",
        label: isMetalAccount ? t("fundShell.col.quantity") : t("viewImport.units"),
        width: colWidth("positions", "units", 92),
        minWidth: minFundColWidth("positions", "units"),
        align: "right",
        className: "tabular-nums",
        sortValue: (p) => isWealthAccount && !p.hasUnits ? null : toNumber(p.units),
        render: (p) => isWealthAccount && !p.hasUnits ? <span className="text-slate-300">-</span> : formatFundUnits(p.units),
      },
      {
        key: "avgCost",
        label: t("fundShell.col.avgCost"),
        width: colWidth("positions", "avgCost", 84),
        minWidth: minFundColWidth("positions", "avgCost"),
        align: "right",
        className: "tabular-nums",
        sortValue: (p) => isWealthAccount && !p.hasUnits ? null : toNumber(p.avgCost),
        render: (p) => isWealthAccount && !p.hasUnits ? <span className="text-slate-300">-</span> : toNumber(p.avgCost).toFixed(4),
      },
      {
        key: "nav",
        label: navColumnLabel,
        width: colWidth("positions", "nav", 136),
        minWidth: minFundColWidth("positions", "nav"),
        align: "right",
        className: "overflow-hidden tabular-nums",
        sortValue: (p) => positionDisplayMetrics(p).displayNav,
        render: (p) => {
          const { displayNav, displayNavDate } = positionDisplayMetrics(p);
          return (
            <div className="flex min-w-0 items-center justify-end gap-0.5">
              <span className="min-w-0 truncate">
                {displayNav != null ? toNumber(displayNav).toFixed(4) : "-"}
                {displayNavDate ? <span className="ml-0.5 text-slate-400">({compactNavDate(displayNavDate)})</span> : null}
              </span>
            </div>
          );
        },
      },
      {
        key: "cost",
        label: t("overview.holdingCost"),
        width: colWidth("positions", "cost", 112),
        minWidth: minFundColWidth("positions", "cost"),
        align: "right",
        className: "tabular-nums",
        sortValue: (p) => toNumber(p.cost),
        render: (p) => formatMoney(p.cost),
      },
      {
        key: "marketValue",
        label: t("propertyShell.column.marketValue"),
        width: colWidth("positions", "marketValue", 112),
        minWidth: minFundColWidth("positions", "marketValue"),
        align: "right",
        className: "tabular-nums",
        sortValue: (p) => positionDisplayMetrics(p).displayMV,
        render: (p) => {
          const { displayMV } = positionDisplayMetrics(p);
          return <span className={pnl(displayMV)}>{formatMoney(displayMV)}</span>;
        },
      },
      {
        key: "pending",
        label: t("fundShell.col.pending"),
        width: colWidth("positions", "pending", 78),
        minWidth: minFundColWidth("positions", "pending"),
        align: "right",
        className: "text-[11px] tabular-nums",
        sortValue: (p) => toNumber(p.pendingCost),
        render: (p) => toNumber(p.pendingCost) > 0 ? <span className="font-medium text-amber-600">{formatMoney(p.pendingCost)}</span> : <span className="text-slate-300">-</span>,
      },
      {
        key: "floatingPnL",
        label: t("fundShell.col.floatingPnL"),
        width: colWidth("positions", "floatingPnL", 104),
        minWidth: minFundColWidth("positions", "floatingPnL"),
        align: "right",
        className: "tabular-nums",
        sortValue: (p) => positionDisplayMetrics(p).displayPnL,
        render: (p) => {
          const { displayPnL } = positionDisplayMetrics(p);
          return <span className={pnl(displayPnL)}>{formatMoney(displayPnL)}</span>;
        },
      },
      {
        key: "floatingRate",
        label: t("overview.floatingRate"),
        width: colWidth("positions", "floatingRate", 84),
        minWidth: minFundColWidth("positions", "floatingRate"),
        align: "right",
        className: "tabular-nums",
        sortValue: (p) => positionDisplayMetrics(p).displayPnLRate,
        render: (p) => {
          const { displayPnLRate } = positionDisplayMetrics(p);
          return <span className={pnl(displayPnLRate)}>{displayPnLRate.toFixed(2)}%</span>;
        },
      },
      {
        key: "historical",
        label: t("stockPanel.colHistoricalProfit"),
        width: colWidth("positions", "historical", 108),
        minWidth: minFundColWidth("positions", "historical"),
        align: "right",
        className: "tabular-nums",
        sortValue: (p) => toNumber(p.historicalProfit),
        render: (p) => <span className={pnl(toNumber(p.historicalProfit))}>{formatMoney(p.historicalProfit)}</span>,
      },
      {
        key: "actions",
        label: "",
        width: colWidth("positions", "actions", 112),
        minWidth: minFundColWidth("positions", "actions"),
        align: "right",
        render: renderPositionActions,
      },
    ];
    return columns;
  }, [
    assetNameLabel,
    colWidth,
    formatFundUnits,
    fundCode,
    isMetalAccount,
    isWealthAccount,
    navColumnLabel,
    pnl,
    positionAssetKey,
    positionDisplayMetrics,
    renderPositionActions,
    t,
  ]);

  const positionColumnOptions = useMemo(
    () => allPositionAdvancedColumns.filter((column) => !FIXED_POSITION_COLUMNS.has(column.key as PositionColumnKey)),
    [allPositionAdvancedColumns],
  );

  const positionAdvancedColumns = useMemo(
    () => allPositionAdvancedColumns.filter((column) => !hiddenPositionColumns.has(column.key as PositionColumnKey)),
    [allPositionAdvancedColumns, hiddenPositionColumns],
  );

  function togglePositionColumnVisibility(key: string) {
    if (FIXED_POSITION_COLUMNS.has(key as PositionColumnKey)) return;
    setHiddenPositionColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key as PositionColumnKey)) next.delete(key as PositionColumnKey);
      else next.add(key as PositionColumnKey);
      try {
        window.localStorage.setItem(FUND_POSITION_HIDDEN_COLUMNS_KEY, JSON.stringify(Array.from(next)));
      } catch {}
      return next;
    });
  }

  const positionSummaryRow = useMemo(() => {
    if (d.positions.length === 0) return undefined;
    const floatingProfit = d.totalMarketValue - d.totalCost;
    return {
      cells: {
        fund: t("debtShell.summaryRow"),
        cost: <span className="tabular-nums text-slate-800">{formatMoney(d.totalCost)}</span>,
        marketValue: <span className={`tabular-nums ${pnl(d.totalMarketValue)}`}>{formatMoney(d.totalMarketValue)}</span>,
        floatingPnL: <span className={`tabular-nums ${pnl(floatingProfit)}`}>{formatMoney(floatingProfit)}</span>,
        floatingRate: <span className={`tabular-nums ${pnl(floatingProfit)}`}>{d.totalCost !== 0 ? formatPercent(floatingProfit / d.totalCost) : "-"}</span>,
        historical: <span className={`tabular-nums ${pnl(d.positionHistoricalProfit)}`}>{formatMoney(d.positionHistoricalProfit)}</span>,
      },
    };
  }, [d.positions.length, d.totalCost, d.totalMarketValue, d.positionHistoricalProfit, pnl, t]);

  const clearedAdvancedColumns = useMemo<AdvancedDataTableColumn<any>[]>(() => [
    {
      key: "fund",
      label: t("fundShell.clearedNameHeader", { label: assetNameLabel }),
      width: colWidth("cleared", "fund", 220),
      minWidth: minFundColWidth("cleared", "fund"),
      headerClassName: "text-left",
      className: "px-4",
      filterText: (c) => [c.name, c.fundCode].filter(Boolean).join(" "),
      sortValue: (c) => String(isWealthAccount ? c.name ?? "" : c.fundCode ?? c.name ?? ""),
      render: (c) => {
        const clearedKey = positionAssetKey(c);
        const active = clearedKey === fundCode;
        return (
          <span
            className={`block truncate font-medium ${active ? "text-blue-700" : "text-slate-700"}`}
            title={isWealthAccount ? c.name : `${c.name} ${c.fundCode}`}
          >
            {c.name}
            {!isWealthAccount && c.fundCode ? <span className="ml-1 text-slate-400">{c.fundCode}</span> : null}
          </span>
        );
      },
    },
    {
      key: "firstBuy",
      label: t("fundShell.col.firstBuy"),
      width: colWidth("cleared", "firstBuy", 108),
      minWidth: minFundColWidth("cleared", "firstBuy"),
      headerClassName: "text-left",
      className: "tabular-nums text-slate-600",
      filterText: (c) => String(c.firstBuyDate ?? ""),
      sortValue: (c) => String(c.firstBuyDate ?? ""),
      render: (c) => c.firstBuyDate || "-",
    },
    {
      key: "clearedDate",
      label: t("fundShell.col.clearedDate"),
      width: colWidth("cleared", "clearedDate", 108),
      minWidth: minFundColWidth("cleared", "clearedDate"),
      headerClassName: "text-left",
      className: "tabular-nums text-slate-600",
      filterText: (c) => String(c.clearedDate ?? ""),
      sortValue: (c) => String(c.clearedDate ?? ""),
      render: (c) => c.clearedDate || "-",
    },
    {
      key: "buyAmount",
      label: t("fundShell.col.buyAmount"),
      width: colWidth("cleared", "buyAmount", 112),
      minWidth: minFundColWidth("cleared", "buyAmount"),
      align: "right",
      className: "tabular-nums",
      filterText: (c) => String(c.totalBuyAmount ?? 0),
      sortValue: (c) => toNumber(c.totalBuyAmount),
      render: (c) => formatMoney(c.totalBuyAmount),
    },
    {
      key: "redeemAmount",
      label: t("fundShell.col.redeemAmount"),
      width: colWidth("cleared", "redeemAmount", 112),
      minWidth: minFundColWidth("cleared", "redeemAmount"),
      align: "right",
      className: "tabular-nums",
      filterText: (c) => String(c.totalRedeemAmount ?? 0),
      sortValue: (c) => toNumber(c.totalRedeemAmount),
      render: (c) => formatMoney(c.totalRedeemAmount),
    },
    {
      key: "historical",
      label: t("fundShell.col.clearedProfit"),
      width: colWidth("cleared", "historical", 112),
      minWidth: minFundColWidth("cleared", "historical"),
      align: "right",
      className: "tabular-nums",
      filterText: (c) => String(c.historicalProfit ?? 0),
      sortValue: (c) => toNumber(c.historicalProfit),
      render: (c) => <span className={pnl(toNumber(c.historicalProfit))}>{formatMoney(c.historicalProfit)}</span>,
    },
    {
      key: "returnRate",
      label: t("stats.rate"),
      width: colWidth("cleared", "returnRate", 80),
      minWidth: minFundColWidth("cleared", "returnRate"),
      align: "right",
      className: "tabular-nums",
      filterText: (c) => String(c.returnRate ?? 0),
      sortValue: (c) => toNumber(c.returnRate),
      render: (c) => {
        const value = toNumber(c.returnRate);
        return <span className={pnl(value)}>{Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "-"}</span>;
      },
    },
  ], [assetNameLabel, colWidth, fundCode, isWealthAccount, pnl, positionAssetKey, t]);

  const clearedSummaryRow = useMemo<AdvancedDataTableSummaryRow | undefined>(() => {
    if (d.clearedPositions.length === 0) return undefined;
    const totalBuyAmt = d.clearedPositions.reduce((sum: number, c: any) => sum + toNumber(c.totalBuyAmount), 0);
    const totalRedeemAmt = d.clearedPositions.reduce((sum: number, c: any) => sum + toNumber(c.totalRedeemAmount), 0);
    const totalReturnRate = totalBuyAmt > 0 ? d.clearedHistoricalProfit / totalBuyAmt : 0;
    return {
      cells: {
        fund: <span className="text-xs font-semibold text-slate-700">{t("debtShell.summaryRow")}</span>,
        buyAmount: <span className="tabular-nums text-xs text-slate-800">{formatMoney(totalBuyAmt)}</span>,
        redeemAmount: <span className="tabular-nums text-xs text-slate-800">{formatMoney(totalRedeemAmt)}</span>,
        historical: <span className={`tabular-nums text-xs ${pnl(d.clearedHistoricalProfit)}`}>{formatMoney(d.clearedHistoricalProfit)}</span>,
        returnRate: <span className={`tabular-nums text-xs ${pnl(totalReturnRate)}`}>{totalBuyAmt > 0 ? formatPercent(totalReturnRate) : "-"}</span>,
      },
      rowClassName: "bg-slate-50/95",
      cellClassName: "text-xs",
    };
  }, [d.clearedHistoricalProfit, d.clearedPositions, pnl, t]);


  const cashAccountInfoOf = useCallback((e: any) => {

    const isR = e.fundSubtype === "redeem" || e.fundSubtype === "dividend_cash" || (e.fundSubtype === "buy_failed" && e.source === "regular_invest_refund");

    const ca = isR ? e.toAccountId : e.accountId;

    if (!ca || ca === (isR ? e.accountId : e.toAccountId)) return null;

    const o = accountOptions.find((a: any) => a.id === ca);

    const label = String(o?.label ?? "").trim();

    return {
      label,
      groupName: String(o?.groupName ?? "").trim(),
    };

  }, [accountOptions]);

  const statusOf = useCallback((e: any): "confirmed" | "pending" | "buy_failed" | "buy_refund" | "partial" => {
    if (isFundUnitsReconcileEntry(e)) return "confirmed";
    if (e.fundSubtype === "buy_failed") {
      const amount = Math.abs(detailAmountOf(e));
      if (e.source === "regular_invest_refund") {
        return "buy_refund";
      }
      const refundAmount = Math.min(amount, refundAmountOf(e));
      const confirmedAmount = Math.max(0, amount - refundAmount);
      return refundAmount > 0 && confirmedAmount > 0 ? "partial" : "buy_failed";
    }
    if (e.fundSubtype === "buy") {
      const refundAmount = refundAmountOf(e);
      if (refundAmount > 0) {
        const confirmedAmount = getConfirmedBuyAmount(Math.abs(toNumber(e.amount)), refundAmount);
        const units = displayUnitsOf(e);
        if (confirmedAmount <= 0) return "buy_failed";
        return units != null && units > 0 ? "partial" : "pending";
      }
    }
    if (e.fundSubtype === "dividend_cash") return "confirmed";
    const units = displayUnitsOf(e);
    return units != null && units > 0 ? "confirmed" : "pending";
  }, [detailAmountOf, displayUnitsOf, refundAmountOf]);

  const entryTagsOf = useCallback((e: any): Array<{ tagId?: string; Tag?: { name?: string | null; color?: string | null } | null; name?: string; color?: string | null }> => {
    if (Array.isArray(e?.entryTags)) return e.entryTags;
    if (Array.isArray(e?.tags)) return e.tags;
    return [];
  }, []);

  const filteredByColumns = filtered;



  const filteredByColumnsIdSet = useMemo(() => new Set(filteredByColumns.map((e: any) => e.id)), [filteredByColumns]);

  const batchTargetIds = useMemo(() => Array.from(selectedIds).filter((id) => filteredByColumnsIdSet.has(id)), [selectedIds, filteredByColumnsIdSet]);


  useEffect(() => {
    setDetailTableRowCount(filteredByColumns.length);
  }, [filteredByColumns.length]);

  const effectiveFundRowCount = detailTableRowCount || filteredByColumns.length;

  const effectiveFundPageSize = fundDetailAll ? Math.max(1, effectiveFundRowCount) : fundPageSize;

  const totalPages = Math.max(1, Math.ceil(effectiveFundRowCount / effectiveFundPageSize));

  const safePage = Math.min(fundPage, totalPages);

  const paged = fundDetailAll ? filteredByColumns : filteredByColumns.slice((safePage - 1) * effectiveFundPageSize, safePage * effectiveFundPageSize);

  const setPagedFundPageSize = useCallback((nextPageSize: number) => {
    setFundDetailAll(false);
    setFundPageSize(nextPageSize);
    setFundPage(1);
  }, []);

  const showAllFundDetailRows = useCallback(() => {
    setFundDetailAll(true);
    setFundPage(1);
  }, []);

  const goFundPage = useCallback((nextPage: number) => {
    if (fundDetailAll) return;
    setFundPage(Math.min(Math.max(1, nextPage), totalPages));
  }, [fundDetailAll, totalPages]);

  const canPrevFundPage = !fundDetailAll && safePage > 1;

  const canNextFundPage = !fundDetailAll && safePage < totalPages;



  useEffect(() => {

    setSelectedIds((prev) => {

      if (prev.size === 0) return prev;

      const next = new Set(prev);

      for (const id of next) {

        if (!filteredByColumnsIdSet.has(id)) next.delete(id);

      }

      return next;

    });

  }, [filteredByColumnsIdSet]);



  const batchFields = useMemo<BatchReplaceFieldConfig<FundBatchField>[]>(() => [

    {

      value: "cashAccountId",

      label: t("txForm.cashAccount"),

      kind: "select",

      options: [{ value: "", label: t("fundShell.selectAccount") }, ...cashAccounts.map((a: any) => ({ value: a.id, label: a.label }))],

    },

    {

      value: "fundAccountId",

      label: investmentAccountLabel,

      kind: "select",

      options: [{ value: "", label: t("fundShell.selectAccount") }, ...fundAccountOptions.map((a: any) => ({ value: a.id, label: a.label }))],

    },

    { value: "amount", label: t("txForm.amount"), kind: "number", placeholder: t("fundShell.batch.amountPlaceholder") },

    { value: "fundFee", label: t("investForm.feeAmount"), kind: "number", placeholder: "0.00", allowEmpty: true },

    { value: "feeRate", label: t("investForm.feeRatePercent"), kind: "number", placeholder: "0" },

    {
      value: "fundConfirmDate",
      label: t("batchImport.fundPreview.confirmDateOffset"),
      kind: "number",
      placeholder: t("batchImport.fundPreview.dateOffsetPlaceholder"),
      allowEmpty: true,
      precision: 0,
    },

    {
      value: "fundArrivalDate",
      label: t("batchImport.fundPreview.arrivalDateOffset"),
      kind: "number",
      placeholder: t("batchImport.fundPreview.dateOffsetPlaceholder"),
      allowEmpty: true,
      precision: 0,
    },

    { value: "remark", label: t("detail.column.remark"), kind: "text", placeholder: t("stockPanel.batchNotePlaceholder"), allowEmpty: true },

  ], [cashAccounts, fundAccountOptions, investmentAccountLabel, t]);



  async function applyBatch(field: FundBatchField, value: string) {

    const ids = batchTargetIds;

    if (ids.length === 0) throw new Error(t("stockPanel.error.selectRowsFirst"));



    const updates = ids.map((id) => {

      if (field === "remark") return { id, remark: value };

      if (field === "fundConfirmDate") return { id, fundConfirmDate: value };

      if (field === "fundArrivalDate") return { id, fundArrivalDate: value };

      if (field === "fundFee") return { id, fundFee: value };

      if (field === "feeRate") return { id, feeRate: value };

      if (field === "cashAccountId") return { id, cashAccountId: value };

      if (field === "fundAccountId") return { id, fundAccountId: value };

      return { id, amount: value };

    });



    const res = await fetch("/api/v1/entries/batch-update", {

      method: "POST",

      headers: { "Content-Type": "application/json" },

      body: JSON.stringify({ updates }),

    });

    const data = await res.json().catch(() => ({ ok: false, error: t("stockPanel.error.batchUpdateFailed") }));

    if (!res.ok || !data.ok) throw new Error(data.error ?? t("stockPanel.error.batchUpdateFailed"));



    setSelectedIds((prev) => {

      const next = new Set(prev);

      ids.forEach((id) => next.delete(id));

      return next;

    });

    dispatchFinanceDataChanged({ reason: "fund-batch-update" });
    return t("stockPanel.updatedCount", { count: data.updatedCount ?? 0 });

  }



  async function applyBatchDelete() {

    const ids = batchTargetIds;

    if (ids.length === 0 || batchDeleting) return;

    setBatchDeleting(true);

    setBatchDeleteMessage("");

    try {

      const data = await deleteEntriesWithLinkedPrompt({
        entryIds: ids,
        confirmMessage: t("fundShell.deleteConfirm.batch", { count: ids.length, kind: isWealthAccount ? t("fundShell.kind.wealth") : t("txForm.fund") }),
        selectedRecordLabel: isWealthAccount ? t("fundShell.record.wealth") : t("fundShell.record.fund"),
        counterpartRecordLabel: t("fundShell.counterpartRecord"),
        t,
      });

      if (!data.ok) {

        if (data.code === "DELETE_CANCELLED" || data.error === "已取消删除") return;
        setBatchDeleteMessage(data.error ?? t("stockPanel.error.batchDeleteFailed"));

        return;

      }

      setBatchDeleteMessage(data.message ?? t("fundShell.deletedCount", { count: ids.length }));

      setSelectedIds((prev) => {

        const next = new Set(prev);

        ids.forEach((id) => next.delete(id));

        return next;

      });

      const refreshEntryIds = getDeleteRefreshEntryIds(data, ids);
      dispatchFinanceDataChanged({ reason: "entry-batch-delete", accountIds: getDeleteRefreshAccountIds(data), deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });

    } catch {

      setBatchDeleteMessage(t("stockPanel.error.batchDeleteFailed"));

    } finally {

      setBatchDeleting(false);

    }

  }

  const deleteDetailEntry = useCallback(async (entry: any) => {
    const id = String(entry?.id ?? "");
    if (!id || singleDeletingIds.has(id)) return;
    setSingleDeletingIds((prev) => new Set(prev).add(id));
    setBatchDeleteMessage("");
    try {
      const data = await deleteEntriesWithLinkedPrompt({
        entryIds: [id],
        confirmMessage: t("fundShell.deleteConfirm.single", { kind: isWealthAccount ? t("fundShell.kind.wealth") : t("txForm.fund") }),
        selectedRecordLabel: isWealthAccount ? t("fundShell.record.wealth") : t("fundShell.record.fund"),
        counterpartRecordLabel: t("fundShell.counterpartRecord"),
        t,
      });
      if (!data.ok) {
        if (data.code === "DELETE_CANCELLED" || data.error === "已取消删除") return;
        setBatchDeleteMessage(data.error ?? t("fundShell.deleteFailed"));
        return;
      }
      const refreshEntryIds = getDeleteRefreshEntryIds(data, [id]);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      dispatchFinanceDataChanged({ reason: "entry-delete", accountIds: getDeleteRefreshAccountIds(data), deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });
    } catch {
      setBatchDeleteMessage(t("fundShell.deleteFailed"));
    } finally {
      setSingleDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [isWealthAccount, singleDeletingIds, t]);

  const linkDetailCashFlow = useCallback(async (entry: any) => {
    const id = String(entry?.id ?? "");
    const businessType =
      entry?.fundProductType === "wealth" || isWealthAccount
        ? "wealth"
        : entry?.fundProductType === "deposit"
          ? "deposit"
          : entry?.fundProductType === "metal"
            ? "metal"
            : "fund";
    const businessTransactionId = String(
      businessType === "fund" ? entry?.fundTransactionId ?? entry?.businessTransactionId ?? "" : entry?.businessTransactionId ?? "",
    ).trim();
    if (!id || linkingIds.has(id)) return;
    if (!businessTransactionId) {
      window.alert(t("fundShell.alert.missingBusinessId", { kind: businessType === "wealth" ? t("fundShell.kind.wealth") : t("txForm.fund") }));
      return;
    }

    setLinkingIds((prev) => new Set(prev).add(id));
    setBatchDeleteMessage("");
    try {
      const res = await fetch("/api/v1/business-transactions/link-cash-flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessType, businessTransactionId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? t("fundShell.error.linkFailed"));
      }
      setBatchDeleteMessage(t("fundShell.linkEstablished"));
      dispatchFinanceDataChanged({
        reason: "business-link-cash-flow",
        accountIds: [entry.accountId, entry.toAccountId].filter(Boolean),
        entryIds: [data.data?.cashEntryId, id].filter(Boolean),
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("fundShell.error.linkFailed"));
    } finally {
      setLinkingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [isWealthAccount, linkingIds, t]);



  const detailAdvancedColumns = useMemo<AdvancedDataTableColumn<any>[]>(() => {
    const numberFilterText = (value: number | null | undefined) =>
      value == null || !Number.isFinite(value) ? null : String(value);
    const navValueOf = (entry: any) => entry.fundNav != null ? toNumber(entry.fundNav) : null;
    const remainingUnitsValueOf = (entry: any) => entry.wealthRemainingUnits != null ? toNumber(entry.wealthRemainingUnits) : null;
    const detailSubtypeLabelOf = (entry: any) => {
      const info = fl(t, entry.fundSubtype, entry.source);
      return isSingleNormalFundScope ? compactFundSubtypeLabel(t, entry, info.label) : info.label;
    };
    const fundLabelOf = (entry: any) => displayFundName(entry);
    const fundSearchTextOf = (entry: any) =>
      [displayFundName(entry), entry.fundCode, entry.wealthProductId].filter(Boolean).join(" ");

    return visibleDetailDataCols.map(([key, fallback]) => {
      const baseWidth = colWidth("details", key, fallback);
      const minWidth = minFundColWidth("details", key);
      const common = { width: baseWidth, minWidth };

      if (key === "date") {
        return {
          key,
          label: t(DETAIL_COLUMN_LABEL_KEYS[key]),
          ...common,
          filterKind: "dateRange",
          filterText: (e: any) => fundApplyDateOf(e) || "",
          sortValue: (e: any) => fundApplyDateOf(e) || null,
          render: (e: any) => <span className="tabular-nums text-slate-600">{fundApplyDateOf(e)}</span>,
        } satisfies AdvancedDataTableColumn<any>;
      }

      if (key === "confirmDate") {
        return {
          key,
          label: t(DETAIL_COLUMN_LABEL_KEYS[key]),
          ...common,
          filterKind: "dateRange",
          filterText: (e: any) => fmtDate(e.fundConfirmDate) || "",
          sortValue: (e: any) => fmtDate(e.fundConfirmDate) || null,
          render: (e: any) => (
            <span className="tabular-nums text-slate-500">
              {e.fundConfirmDate ? fmtDate(e.fundConfirmDate) : <span className="text-slate-300">-</span>}
            </span>
          ),
        } satisfies AdvancedDataTableColumn<any>;
      }

      if (key === "arrivalDate") {
        return {
          key,
          label: t(DETAIL_COLUMN_LABEL_KEYS[key]),
          ...common,
          filterKind: "dateRange",
          filterText: (e: any) => fmtDate(e.fundArrivalDate) || "",
          sortValue: (e: any) => fmtDate(e.fundArrivalDate) || null,
          render: (e: any) => (
            <span className="tabular-nums text-slate-500">
              {e.fundArrivalDate ? fmtDate(e.fundArrivalDate) : <span className="text-slate-300">-</span>}
            </span>
          ),
        } satisfies AdvancedDataTableColumn<any>;
      }

      if (key === "cashAccount") {
        return {
          key,
          label: t(DETAIL_COLUMN_LABEL_KEYS[key]),
          ...common,
          filterText: (e: any) => cashAccountInfoOf(e)?.label ?? "",
          filterSearchText: (e: any) => {
            const info = cashAccountInfoOf(e);
            return [info?.label, info?.groupName].filter(Boolean).join(" ");
          },
          sortValue: (e: any) => cashAccountInfoOf(e)?.label ?? null,
          render: (e: any) => {
            const info = cashAccountInfoOf(e);
            if (!info || !info.label) return <span className="text-slate-300">-</span>;
            return (
              <div className="min-w-0">
                <div className="truncate text-slate-600" title={info.label}>{info.label}</div>
              </div>
            );
          },
        } satisfies AdvancedDataTableColumn<any>;
      }

      if (key === "fund") {
        return {
          key,
          label: detailNameLabel,
          ...common,
          filterText: fundLabelOf,
          filterSearchText: fundSearchTextOf,
          filterTitle: fundSearchTextOf,
          sortValue: fundLabelOf,
          render: (e: any) => (
            <div className="truncate text-slate-700" title={isWealthAccount ? displayFundName(e) : `${displayFundName(e)} ${e.fundCode || ""}`}>
              {displayFundName(e)}
              {!isWealthAccount && e.fundCode && displayFundName(e) !== e.fundCode && <span className="ml-1 text-slate-400">{e.fundCode}</span>}
            </div>
          ),
        } satisfies AdvancedDataTableColumn<any>;
      }

      if (key === "nav") {
        return {
          key,
          label: navColumnLabel,
          ...common,
          align: "right",
          filterKind: "numberRange",
          filterText: (e: any) => numberFilterText(navValueOf(e)),
          filterNumber: navValueOf,
          sortValue: navValueOf,
          render: (e: any) => {
            const nav = navValueOf(e);
            return <span className="whitespace-nowrap tabular-nums text-slate-700">{nav != null ? nav.toFixed(4) : <span className="text-slate-300">-</span>}</span>;
          },
        } satisfies AdvancedDataTableColumn<any>;
      }

      if (key === "units") {
        return {
          key,
          label: t(DETAIL_COLUMN_LABEL_KEYS[key]),
          ...common,
          align: "right",
          filterKind: "numberRange",
          filterText: (e: any) => numberFilterText(displayUnitsOf(e)),
          filterNumber: displayUnitsOf,
          sortValue: displayUnitsOf,
          render: (e: any) => {
            const units = displayUnitsOf(e);
            return <span className="whitespace-nowrap tabular-nums text-slate-700">{units != null ? formatFundUnits(units) : <span className="text-slate-300">-</span>}</span>;
          },
        } satisfies AdvancedDataTableColumn<any>;
      }

      if (key === "remainingUnits") {
        return {
          key,
          label: t(DETAIL_COLUMN_LABEL_KEYS[key]),
          ...common,
          align: "right",
          filterKind: "numberRange",
          filterText: (e: any) => numberFilterText(remainingUnitsValueOf(e)),
          filterNumber: remainingUnitsValueOf,
          sortValue: remainingUnitsValueOf,
          render: (e: any) => (
            <span className="whitespace-nowrap tabular-nums text-slate-600">
              {remainingUnitsValueOf(e) != null ? formatFundUnits(remainingUnitsValueOf(e) ?? 0) : <span className="text-slate-300">-</span>}
            </span>
          ),
        } satisfies AdvancedDataTableColumn<any>;
      }

      if (key === "subtype") {
        return {
          key,
          label: t(DETAIL_COLUMN_LABEL_KEYS[key]),
          ...common,
          filterText: detailSubtypeLabelOf,
          sortValue: detailSubtypeLabelOf,
          render: (e: any) => {
            const info = fl(t, e.fundSubtype, e.source);
            const detailSubtypeLabel = detailSubtypeLabelOf(e);
            return (
              <span className={`rounded px-1 py-0.5 text-[10px] font-medium ${e.source === "dividend" || e.fundSubtype === "dividend_cash" ? `bg-emerald-50 ${upCls}` : info.cls}`}>
                {detailSubtypeLabel}
              </span>
            );
          },
        } satisfies AdvancedDataTableColumn<any>;
      }

      if (key === "amount") {
        return {
          key,
          label: detailAmountColumnLabel,
          ...common,
          align: "right",
          filterKind: "numberRange",
          filterText: (e: any) => isFundUnitsReconcileEntry(e) ? null : numberFilterText(Math.abs(detailAmountOf(e))),
          filterNumber: (e: any) => isFundUnitsReconcileEntry(e) ? null : Math.abs(detailAmountOf(e)),
          sortValue: (e: any) => isFundUnitsReconcileEntry(e) ? null : Math.abs(detailAmountOf(e)),
          render: (e: any) => {
            if (isFundUnitsReconcileEntry(e)) return <span className="text-slate-300">-</span>;
            const amount = detailAmountOf(e);
            const displayAmount = e.fundSubtype === "buy_failed" && e.source !== "regular_invest_refund"
              ? Math.abs(amount)
              : e.fundSubtype === "buy_failed" && e.source === "regular_invest_refund"
                ? -Math.abs(amount)
                : Math.abs(amount);
            const displayText = formatMoney(displayAmount);
            if (e.source === "dividend" || e.fundSubtype === "dividend_cash") return <span className={`font-medium ${upCls}`}>+{formatMoney(Math.abs(displayAmount))}</span>;
            const entryStatus = statusOf(e);
            const amountClass = entryStatus === "buy_failed"
              ? "text-rose-600"
              : entryStatus === "buy_refund"
                ? "text-emerald-700"
              : displayAmount < 0 ? downCls : "text-slate-700";
            return <span className={`tabular-nums ${amountClass}`}>{displayText}</span>;
          },
        } satisfies AdvancedDataTableColumn<any>;
      }

      if (key === "profit") {
        return {
          key,
          label: t(DETAIL_COLUMN_LABEL_KEYS[key]),
          ...common,
          align: "right",
          filterKind: "numberRange",
          filterText: (e: any) => {
            const profit = e.realizedProfit != null ? toNumber(e.realizedProfit) : null;
            return e.fundSubtype === "redeem" || e.fundSubtype === "dividend_cash" ? numberFilterText(profit) : null;
          },
          filterNumber: (e: any) => {
            const profit = e.realizedProfit != null ? toNumber(e.realizedProfit) : null;
            return e.fundSubtype === "redeem" || e.fundSubtype === "dividend_cash" ? profit : null;
          },
          sortValue: (e: any) => {
            const profit = e.realizedProfit != null ? toNumber(e.realizedProfit) : null;
            return e.fundSubtype === "redeem" || e.fundSubtype === "dividend_cash" ? profit : null;
          },
          render: (e: any) => {
            const profit = e.realizedProfit != null ? toNumber(e.realizedProfit) : null;
            return (
              <span className={`tabular-nums ${pnl(profit ?? 0)}`}>
                {profit != null && (e.fundSubtype === "redeem" || e.fundSubtype === "dividend_cash") ? formatMoney(profit) : <span className="text-slate-300">-</span>}
              </span>
            );
          },
        } satisfies AdvancedDataTableColumn<any>;
      }

      if (key === "status") {
        return {
          key,
          label: t(DETAIL_COLUMN_LABEL_KEYS[key]),
          ...common,
          filterText: statusOf,
          sortValue: statusOf,
          render: (e: any) => {
            const s = statusOf(e);
            if (s === "pending") return <span className="text-amber-600">{t("fundShell.status.pending")}</span>;
            if (s === "buy_failed") return <span className="text-rose-600">{t("fundShell.status.buyFailed")}</span>;
            if (s === "buy_refund") return <span className="text-emerald-700">{t("fundShell.status.buyRefund")}</span>;
            if (s === "partial") return <span className="text-amber-600">{t("fundShell.status.partial")}</span>;
            return <span className="text-emerald-700">{t("fundShell.status.confirmed")}</span>;
          },
        } satisfies AdvancedDataTableColumn<any>;
      }

      if (key === "tags") {
        return {
          key,
          label: t(DETAIL_COLUMN_LABEL_KEYS[key]),
          ...common,
          filterText: (e: any) => entryTagsOf(e).map((et: any) => et.Tag?.name ?? et.name ?? "").join(" "),
          render: (e: any) => {
            const tags = entryTagsOf(e);
            if (tags.length === 0) return <span className="text-slate-300">-</span>;
            return (
              <span className="inline-flex flex-wrap gap-0.5">
                {tags.map((et: any, idx: number) => {
                  const c = et.Tag?.color || et.color || "#3B82F6";
                  const name = et.Tag?.name || et.name || "";
                  return (
                    <span
                      key={et.tagId ?? `${idx}-${name}`}
                      className="rounded-full border px-1 py-0.5 text-[10px] leading-none"
                      style={{ backgroundColor: c + "18", color: c, borderColor: c + "60" }}
                    >
                      {name}
                    </span>
                  );
                })}
              </span>
            );
          },
        } satisfies AdvancedDataTableColumn<any>;
      }

      if (key === "note") {
        return {
          key,
          label: t(DETAIL_COLUMN_LABEL_KEYS[key]),
          ...common,
          filterText: (e: any) => String(e.note ?? "").trim(),
          sortValue: (e: any) => String(e.note ?? "").trim() || null,
          truncate: true,
          cellTitle: (e: any) => String(e.note ?? "").trim(),
          render: (e: any) => {
            const note = String(e.note ?? "").trim();
            return note ? <span className="text-slate-600">{note}</span> : <span className="text-slate-300">-</span>;
          },
        } satisfies AdvancedDataTableColumn<any>;
      }

      return {
        key,
        label: DETAIL_COLUMN_LABEL_KEYS[key] ? t(DETAIL_COLUMN_LABEL_KEYS[key]) : key,
        ...common,
        render: () => null,
      } satisfies AdvancedDataTableColumn<any>;
    });
  }, [
    colWidth,
    cashAccountInfoOf,
    detailAmountColumnLabel,
    detailAmountOf,
    detailNameLabel,
    displayFundName,
    displayUnitsOf,
    entryTagsOf,
    formatFundUnits,
    fundApplyDateOf,
    isSingleNormalFundScope,
    isWealthAccount,
    navColumnLabel,
    pnl,
    statusOf,
    upCls,
    downCls,
    visibleDetailDataCols,
    t,
  ]);

  const detailRowActions = useCallback((e: any) => {
    const businessLinkInfo = entryBusinessLinkInfo(e);
    const isLinked = businessLinkInfo.active;
    const linkTitle = isLinked
      ? (businessLinkInfo.labels.length > 0
          ? t("detailView.linkedLabel", { labels: businessLinkInfo.labels.join("、") })
          : t("fundShell.linkedCashFlow"))
      : linkingIds.has(String(e.id ?? ""))
        ? t("fundShell.linking")
        : t("detailView.notLinked");
    const isRegularInvestRefund = e.fundSubtype === "buy_failed" && e.source === "regular_invest_refund";
    const linkedBuyForRefund = isRegularInvestRefund
      ? (() => {
          const target: RefundLinkableEntry = {
            id: String(e.id ?? ""),
            date: fmtDate(e.date),
            createdAt: e.createdAt,
            fundConfirmDate: fmtDate(e.fundConfirmDate),
            fundArrivalDate: fmtDate(e.fundArrivalDate),
            accountId: e.accountId ?? null,
            toAccountId: e.toAccountId ?? null,
            fundCode: entryAssetKey(e),
            fundSubtype: e.fundSubtype ?? null,
            fundUnits: displayUnitsOfPlain(e),
            source: e.source ?? null,
            fundSourceEntryId: e.fundSourceEntryId ?? null,
            amount: toNumber(e.amount),
          };
          const linked = findLinkedEntries(target, linkedCandidateEntries);
          const linkedBuyId = linked.linkedBuys[0]?.id;
          return linkedBuyId ? d.allEntries.find((item: any) => String(item.id ?? "") === linkedBuyId) ?? null : null;
        })()
      : null;
    const editableInvestmentEntry = linkedBuyForRefund ?? e;
    const isUnitsReconcile = isFundUnitsReconcileEntry(e);

    return (
      <div className="flex items-center justify-end gap-1">
        {!isUnitsReconcile && !isWealthAccount && e.fundCode && e.fundSubtype === "buy" && statusOf(e) !== "buy_failed" && (e.fundUnits == null || Number(e.fundUnits) === 0) ? <FillNavButton entryId={e.id} fundCode={e.fundCode} action={fillNavAction} onFilled={(data) => handleEntryNavFilled(e, data)} /> : null}
        {!isUnitsReconcile ? (
          e.fundProductType === "wealth" ? (
            <WealthFormModal
            mode="edit"
            accountId={selectedAccount?.id ?? ""}
            entry={{
              id: e.id,
              transactionId: e.id,
              cashEntryId: e.cashEntryId ?? null,
              businessTransactionId: e.businessTransactionId ?? null,
              date: fmtDate(e.date),
              amount: toNumber(e.amount),
              note: e.note ?? null,
              fundName: displayFundName(e) === "-" ? null : displayFundName(e),
              fundProductType: e.fundProductType ?? null,
              fundSubtype: e.fundSubtype ?? null,
              wealthProductId: e.wealthProductId ?? null,
              fundUnits: displayUnitsOf(e) ?? (e.fundUnits != null ? toNumber(e.fundUnits) : null),
              fundNav: e.fundNav != null ? toNumber(e.fundNav) : null,
              fundArrivalDate: fmtDate(e.fundArrivalDate) || null,
              fundArrivalAmount: e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null,
              depositInterest: e.depositInterest != null ? toNumber(e.depositInterest) : null,
              accountId: e.accountId ?? null,
              toAccountId: e.toAccountId ?? null,
              toAccountName: e.toAccountName ?? null,
            }}
            openSignal={detailEditSignal && detailEditSignal.id === e.id ? detailEditSignal.value : undefined}
            cashAccounts={cashAccounts}
            investmentAccounts={investmentAccounts}
            cashAccountSSOptions={cashAccountSSOptions}
            investmentAccountSSOptions={investmentAccountSSOptions}
            wealthHoldingOptions={props.wealthHoldingOptions ?? []}
            nestedFieldData={nestedFieldData}
            createAction={createAction}
            editAction={editAction}
          />
          ) : e.fundProductType === "deposit" ? (
            <DepositFormModal
            mode="edit"
            accountId={selectedAccount?.id ?? ""}
            entry={{
              id: e.id,
              transactionId: e.id,
              date: fmtDate(e.date),
              amount: toNumber(e.amount),
              note: e.note ?? null,
              fundName: displayFundName(e) === "-" ? null : displayFundName(e),
              fundProductType: e.fundProductType ?? null,
              fundSubtype: e.fundSubtype ?? null,
              accountId: e.accountId ?? null,
              toAccountId: e.toAccountId ?? null,
              toAccountName: e.toAccountName ?? null,
            }}
            openSignal={detailEditSignal && detailEditSignal.id === e.id ? detailEditSignal.value : undefined}
            cashAccounts={cashAccounts}
            investmentAccounts={investmentAccounts}
            cashAccountSSOptions={cashAccountSSOptions}
            investmentAccountSSOptions={investmentAccountSSOptions}
            createAction={createAction}
            editAction={editAction}
          />
          ) : (
            <InvestmentFormModal
            mode="edit"
            entry={{
              id: editableInvestmentEntry.id,
              transactionId: editableInvestmentEntry.id,
              date: fmtDate(editableInvestmentEntry.date),
              confirmDate: fmtDate(editableInvestmentEntry.fundConfirmDate) || undefined,
              amount: toNumber(editableInvestmentEntry.amount),
              note: editableInvestmentEntry.note ?? null,
              memo: editableInvestmentEntry.note ?? null,
              fundCode: editableInvestmentEntry.fundCode ?? null,
              fundName: displayFundName(editableInvestmentEntry) === "-" ? (editableInvestmentEntry.fundCode ?? null) : displayFundName(editableInvestmentEntry),
              fundUnits: editableInvestmentEntry.fundUnits != null ? toNumber(editableInvestmentEntry.fundUnits) : null,
              displayFundUnits: displayUnitsOf(editableInvestmentEntry),
              fundNav: editableInvestmentEntry.fundNav != null ? toNumber(editableInvestmentEntry.fundNav) : null,
              fundFee: editableInvestmentEntry.fundFee != null ? toNumber(editableInvestmentEntry.fundFee) : null,
              fundProductType: editableInvestmentEntry.fundProductType ?? null,
              fundSubtype: editableInvestmentEntry.fundSubtype ?? null,
              metalTypeId: editableInvestmentEntry.metalTypeId ?? null,
              metalTypeName: editableInvestmentEntry.metalTypeName ?? null,
              metalUnitId: editableInvestmentEntry.metalUnitId ?? null,
              metalUnitName: editableInvestmentEntry.metalUnitName ?? null,
              metalQuantity: editableInvestmentEntry.metalQuantity != null ? toNumber(editableInvestmentEntry.metalQuantity) : null,
              metalUnitPrice: editableInvestmentEntry.metalUnitPrice != null ? toNumber(editableInvestmentEntry.metalUnitPrice) : null,
              metalFee: editableInvestmentEntry.metalFee != null ? toNumber(editableInvestmentEntry.metalFee) : null,
              source: editableInvestmentEntry.source ?? null,
              accountId: editableInvestmentEntry.accountId ?? null,
              toAccountId: editableInvestmentEntry.toAccountId ?? null,
              toAccountName: editableInvestmentEntry.toAccountName ?? null,
              fundArrivalDate: fmtDate(editableInvestmentEntry.fundArrivalDate) || null,
              fundArrivalAmount: editableInvestmentEntry.fundArrivalAmount != null ? toNumber(editableInvestmentEntry.fundArrivalAmount) : null,
              refundAmount: editableInvestmentEntry.refundAmount != null ? toNumber(editableInvestmentEntry.refundAmount) : null,
              realizedProfit: editableInvestmentEntry.realizedProfit != null ? toNumber(editableInvestmentEntry.realizedProfit) : null,
            }}
            openSignal={detailEditSignal && detailEditSignal.id === e.id ? detailEditSignal.value : undefined}
            accountId={selectedAccount?.id ?? ""}
            accountProductType={selectedAccount?.investProductType ?? null}
            defaults={{
              confirmDays: d.confirmDaysMap[editableInvestmentEntry.fundCode ?? ""] ?? selectedAccount?.defaultConfirmDays ?? undefined,
              feeRate: d.feeRateMap[`${editableInvestmentEntry.fundCode ?? ""}:${editableInvestmentEntry.fundSubtype === "redeem" ? "redeem" : "buy"}`] ?? null,
            }}
            cashAccounts={cashAccounts}
            investmentAccounts={investmentAccounts}
            cashAccountSSOptions={cashAccountSSOptions}
            investmentAccountSSOptions={investmentAccountSSOptions}
            metalTypes={metalTypes}
            metalUnits={metalUnits}
            nestedFieldData={nestedFieldData}
            holdings={d.positions.map((p: any) => ({ fundCode: p.fundCode, name: p.name, units: p.units }))}
            allEntries={linkedCandidateEntries}
            createAction={createAction}
            editAction={editAction}
            fundUnitsDecimals={fundUnitsDecimals}
            hideTrigger
          />
          )
        ) : null}
        {!isUnitsReconcile ? (
          <>
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                if (!isLinked) void linkDetailCashFlow(e);
              }}
              disabled={isLinked || linkingIds.has(String(e.id ?? ""))}
              className={[
                "flex h-6 w-6 items-center justify-center rounded border bg-white transition-colors disabled:cursor-default",
                isLinked
                  ? "border-slate-200 text-slate-500"
                  : "border-amber-200 text-amber-700 hover:bg-amber-50 disabled:opacity-60",
              ].join(" ")}
              title={linkTitle}
              aria-label={isLinked ? t("fundShell.linkedCashFlow") : t("detailView.notLinked")}
            >
              <LinkStatusIcon active={isLinked} title={linkTitle} />
            </button>
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                openDetailEdit(e.id);
              }}
              className="flex h-6 w-6 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50"
              title={t("common.edit")}
              aria-label={t("common.edit")}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </>
        ) : null}
        <button
          type="button"
          onClick={() => { void deleteDetailEntry(e); }}
          disabled={singleDeletingIds.has(String(e.id ?? ""))}
          className="flex h-6 w-6 items-center justify-center rounded border border-red-200 bg-white text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
          title={singleDeletingIds.has(String(e.id ?? "")) ? t("stockPanel.deleting") : t("common.delete")}
          aria-label={singleDeletingIds.has(String(e.id ?? "")) ? t("stockPanel.deleting") : t("common.delete")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }, [
    cashAccountSSOptions,
    cashAccounts,
    createAction,
    d.allEntries,
    d.confirmDaysMap,
    d.feeRateMap,
    d.positions,
    deleteDetailEntry,
    detailEditSignal,
    displayFundName,
    displayUnitsOf,
    displayUnitsOfPlain,
    editAction,
    entryAssetKey,
    entryBusinessLinkInfo,
    fillNavAction,
    fundUnitsDecimals,
    handleEntryNavFilled,
    isWealthAccount,
    investmentAccountSSOptions,
    investmentAccounts,
    linkedCandidateEntries,
    linkingIds,
    metalTypes,
    metalUnits,
    nestedFieldData,
    openDetailEdit,
    props.wealthHoldingOptions,
    selectedAccount?.defaultConfirmDays,
    selectedAccount?.id,
    selectedAccount?.investProductType,
    singleDeletingIds,
    linkDetailCashFlow,
    statusOf,
    t,
  ]);
  const showDetailPane = Boolean(fundCode || showAllRecords || isWealthAccount);

  return (

    <div className="flex-1 min-h-0 flex flex-col bg-transparent p-4 md:p-5">

      <ResizableVerticalSplit
        storageKey={`mmh:fund-shell:${accountId}:split-height`}
        hasLowerPane={showDetailPane}
        defaultUpperHeight={360}
        separatorLabel={t("fundShell.resizeLabel", { kind: isWealthAccount ? t("fundShell.kind.wealth") : t("txForm.fund") })}
        separatorTitle={t("fundShell.resizeTitle", { kind: isWealthAccount ? t("fundShell.kind.wealth") : t("txForm.fund") })}
        stackOnMobile
        stackLowerFirstOnMobile={false}
      >

      <div className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">

        <div className="panel-header shrink-0">

          <div className="flex items-center gap-2">
            <InvestmentFormModal
              mode="create"
              accountId={accountId}
              accountProductType={selectedAccount?.investProductType ?? null}
              defaults={positionEntryDefaults ?? undefined}
              cashAccounts={cashAccounts}
              investmentAccounts={investmentAccounts}
              cashAccountSSOptions={cashAccountSSOptions}
              investmentAccountSSOptions={investmentAccountSSOptions}
              metalTypes={metalTypes}
              metalUnits={metalUnits}
              nestedFieldData={nestedFieldData}
              holdings={d.positions.map((p: any) => ({ fundCode: p.fundCode, name: p.name, units: p.units }))}
              allEntries={d.allEntries.map((e: any) => ({ id: e.id, date: fmtDate(e.date), createdAt: e.createdAt, fundConfirmDate: fmtDate(e.fundConfirmDate), fundArrivalDate: fmtDate(e.fundArrivalDate), fundSourceEntryId: e.fundSourceEntryId ?? null, fundCode: entryAssetKey(e), fundName: e.fundName ?? e.productName ?? null, fundSubtype: e.fundSubtype, fundUnits: displayUnitsOf(e), source: e.source ?? null, accountId: e.accountId ?? null, toAccountId: e.toAccountId ?? null, amount: toNumber(e.amount) }))}
              createAction={createAction}
              openSignal={positionEntryOpenSignal}
              hideTrigger
              listenCreateEvents={false}
              fundUnitsDecimals={fundUnitsDecimals}
            />

            <div className="flex items-center gap-0.5">

              <button onClick={() => toggleCleared(false)} className={`h-6 px-2 rounded text-xs ${!showCleared ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>{holdingTabLabel}</button>

              {!isMetalAccount ? <button onClick={() => toggleCleared(true)} className={`h-6 px-2 rounded text-xs ${showCleared ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>{clearedTabLabel}</button> : null}

            </div>

          </div>

          <div className="flex items-center gap-2 text-xs text-slate-500 min-h-[24px]">

            {!showCleared && !isMetalAccount && !isWealthAccount && d.positions.length > 0 ? (
              <RefreshNavButton accountId={accountId} symbols={d.positions.map((p: any) => p.fundCode).filter(Boolean)} />
            ) : null}

            {!isMetalAccount && !isWealthAccount ? (
              <ViewExcelImportMenuButton
                kind="fund"
                accountId={accountId}
                fundAccountName={selectedAccount?.name ?? t("viewImport.fundAccount")}
                exportItems={[{
                  label: t("fundShell.export.all"),
                  onClick: () => void exportXlsx("all"),
                }]}
              />
            ) : null}

            {!showCleared ? (
              <div className="relative hidden md:block order-last" ref={positionColumnMenuRef}>
                <button
                  type="button"
                  onClick={() => setPositionColumnMenuOpen((open) => !open)}
                  className="secondary-button h-7 px-2 text-xs"
                  title={t("table.columnSettings")}
                  aria-label={t("table.columnSettings")}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                </button>

                {positionColumnMenuOpen ? (
                  <div className="absolute right-0 top-8 z-50 w-44 rounded-lg border border-slate-200 bg-white p-2 shadow-soft">
                    <div className="mb-1 px-1 text-[11px] font-semibold text-slate-500">{t("table.visibleColumns")}</div>
                    <div className="max-h-56 space-y-1 overflow-y-auto">
                      {positionColumnOptions.map((column) => {
                        const checked = !hiddenPositionColumns.has(column.key as PositionColumnKey);
                        return (
                          <label
                            key={column.key}
                            className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => togglePositionColumnVisibility(column.key)}
                              className="h-3.5 w-3.5 rounded border-slate-300"
                            />
                            <span className="truncate">{column.label}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

          </div>

        </div>

        <div className="flex-1 min-h-0 overflow-hidden">
          <div className="block h-full overflow-y-auto overscroll-contain px-3 pb-4 pt-2 md:hidden">
            {!showCleared ? (
              sortedPositions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">{t("fundShell.empty.positions")}</div>
              ) : (
                <div className="space-y-2.5">
                  {sortedPositions.map((p: any) => {
                    const positionKey = positionAssetKey(p);
                    const active = positionKey === fundCode;
                    const adj = adjustedNavByCode[p.fundCode];
                    const displayMV = adj && p.units > 0 ? p.units * adj.nav : p.marketValue;
                    const displayPnL = adj ? displayMV - p.cost : p.floatingPnL;
                    const displayPnLRate = p.cost > 0 ? (displayPnL / p.cost) * 100 : 0;
                    return (
                      <article
                        key={positionKey || p.fundCode}
                        className={`rounded-lg border bg-white px-3 py-3 shadow-sm ${
                          active ? "border-blue-200 bg-blue-50/70" : "border-slate-200"
                        }`}
                        onClick={() => switchFund(positionKey)}
                        onDoubleClick={() => {
                          if (!isWealthAccount) openPositionEntryModal(p);
                        }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className={`truncate text-sm font-semibold ${active ? "text-blue-700" : "text-slate-900"}`} title={isWealthAccount ? p.name : `${p.name} ${p.fundCode}`}>
                              {p.name}
                            </div>
                            {!isWealthAccount && p.fundCode !== p.name ? (
                              <div className={`mt-1 text-[11px] tabular-nums ${pnl(displayPnL)}`}>{p.fundCode}</div>
                            ) : null}
                            {isWealthAccount ? <div className="mt-1 text-[11px] text-slate-400">{p.holdingDate || `${t("fundShell.col.holdingDate")} -`}</div> : null}
                          </div>
                          <div className="shrink-0 text-right">
                            <div className={`text-base font-semibold tabular-nums ${pnl(displayMV)}`}>{formatMoney(displayMV)}</div>
                            <div className={`mt-0.5 text-[11px] tabular-nums ${pnl(displayPnLRate)}`}>{displayPnLRate.toFixed(2)}%</div>
                          </div>
                        </div>

                        <div className="mt-2 grid grid-cols-4 gap-x-2">
                          <FundMobileDetailItem label={isMetalAccount ? t("fundShell.col.quantity") : t("viewImport.units")} value={isWealthAccount && !p.hasUnits ? "-" : formatFundUnits(p.units)} alignRight />
                          <FundMobileDetailItem label={t("fundShell.col.avgCost")} value={isWealthAccount && !p.hasUnits ? "-" : p.avgCost.toFixed(4)} alignRight />
                          <FundMobileDetailItem label={t("fundShell.col.cost")} value={formatMoney(p.cost)} alignRight />
                          <FundMobileDetailItem label={t("overview.profit")} value={formatMoney(displayPnL)} valueClassName={pnl(displayPnL)} alignRight />
                        </div>

                      </article>
                    );
                  })}
                </div>
              )
            ) : (
              sortedClearedPositions.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">{noClearedText}</div>
              ) : (
                <div className="space-y-2.5">
                  {sortedClearedPositions.map((c: any) => {
                    const clearedKey = positionAssetKey(c);
                    const active = clearedKey === fundCode;
                    return (
                      <article
                        key={clearedKey || c.fundCode}
                        className={`rounded-lg border bg-white px-3 py-3 shadow-sm ${
                          active ? "border-blue-200 bg-blue-50/70" : "border-slate-200"
                        }`}
                        onClick={() => switchFund(clearedKey)}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className={`truncate text-sm font-semibold ${active ? "text-blue-700" : "text-slate-900"}`} title={isWealthAccount ? c.name : `${c.name} ${c.fundCode}`}>
                              {c.name}
                            </div>
                            {!isWealthAccount && c.fundCode ? <div className="mt-1 text-[11px] tabular-nums text-slate-400">{c.fundCode}</div> : null}
                          </div>
                          <div className="shrink-0 text-right">
                            <div className={`text-base font-semibold tabular-nums ${pnl(c.historicalProfit)}`}>{formatMoney(c.historicalProfit)}</div>
                            <div className={`mt-0.5 text-[11px] tabular-nums ${pnl(c.returnRate)}`}>{(c.returnRate * 100).toFixed(2)}%</div>
                          </div>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
                          <FundMobileDetailItem label={t("fundShell.col.firstBuy")} value={c.firstBuyDate || "-"} />
                          <FundMobileDetailItem label={t("fundShell.col.clearedDate")} value={c.clearedDate || "-"} />
                          <FundMobileDetailItem label={t("fundShell.col.buyAmount")} value={formatMoney(c.totalBuyAmount)} alignRight />
                          <FundMobileDetailItem label={t("fundShell.col.redeemAmount")} value={formatMoney(c.totalRedeemAmount)} alignRight />
                        </div>
                      </article>
                    );
                  })}
                </div>
              )
            )}
          </div>

          <div className="hidden h-full md:block">

          {!showCleared ? (

            <AdvancedDataTable
              storageKey={`mmh_fund_shell_positions_advanced_v1:${isWealthAccount ? "wealth" : isMetalAccount ? "metal" : "fund"}`}
              columns={positionAdvancedColumns}
              rows={d.positions}
              rowKey={(p, index) => positionAssetKey(p) || p.fundCode || String(index)}
              emptyText={t("fundShell.empty.positions")}
              minTableWidth={minFundTableWidth("positions", visiblePositionCols)}
              rowClassName={(p) => {
                const positionKey = positionAssetKey(p);
                const active = positionKey === fundCode;
                return `cursor-pointer ${active ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-blue-50/40"}`;
              }}
              onRowClick={(p) => switchFund(positionAssetKey(p))}
              onRowDoubleClick={(p) => {
                if (!isWealthAccount) openPositionEntryModal(p);
              }}
              showFilters={false}
              fillHeight
              toolbarMode="none"
              draggableRows={false}
              defaultSort={positionDefaultSort}
              onDisplayRowsChange={handlePositionDisplayRowsChange}
              summaryRow={positionSummaryRow}
            />


          ) : (

            <AdvancedDataTable
              storageKey={`mmh_fund_shell_cleared_advanced_v1:${isWealthAccount ? "wealth" : isMetalAccount ? "metal" : "fund"}`}
              columns={clearedAdvancedColumns}
              rows={d.clearedPositions}
              rowKey={(c, index) => positionAssetKey(c) || c.fundCode || String(index)}
              emptyText={noClearedText}
              minTableWidth={Math.max(820, minFundTableWidth("cleared", CLEARED_COLS))}
              rowClassName={(c) => {
                const clearedKey = positionAssetKey(c);
                const active = clearedKey === fundCode;
                return `cursor-pointer ${active ? "bg-blue-50 hover:bg-blue-50" : "hover:bg-blue-50/40"}`;
              }}
              onRowClick={(c) => switchFund(positionAssetKey(c))}
              showFilters={false}
              fillHeight
              toolbarMode="none"
              draggableRows={false}
              defaultSort={clearedDefaultSort}
              summaryRow={clearedSummaryRow}
            />

          )}

          </div>
        </div>

      </div>

      {showSelectedFundChart ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/10 p-4"
          onClick={() => setFundChartOpen(false)}
        >
          <div
            className="w-[min(720px,calc(100vw-2rem))] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl"
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-white px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-slate-800">{selectedFundNameForChart || fundCode}</div>
                <div className="text-xs tabular-nums text-slate-400">{fundCode}</div>
              </div>
              <button
                type="button"
                onClick={() => setFundChartOpen(false)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-400 hover:bg-slate-50 hover:text-slate-700"
                title={t("fundShell.chart.collapse")}
                aria-label={t("fundShell.chart.collapse")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <FundTrendChart
              fundName={selectedFundNameForChart}
              fundCode={fundCode}
              history={fundNavHistoryState.code === fundCode ? fundNavHistoryState.data : []}
              entries={selectedFundChartEntries}
              confirmDays={selectedFundConfirmDays}
              loading={fundNavHistoryState.code === fundCode && fundNavHistoryState.loading}
              error={fundNavHistoryState.code === fundCode ? fundNavHistoryState.error : ""}
              mode={fundChartMode}
              range={fundChartRange}
              upClassName={upCls}
              downClassName={downCls}
              onModeChange={setFundChartMode}
              onRangeChange={setFundChartRange}
              embedded
            />
          </div>
        </div>
      ) : null}

      <FundProfileSettingsModal
        open={fundSettingsCode !== null}
        account={{
          id: accountId,
          name: selectedAccount?.name ?? t("viewImport.fundAccount"),
          institutionName: selectedAccount?.Institution?.shortName?.trim() || selectedAccount?.Institution?.name?.trim() || null,
        }}
        fundCode={fundSettingsCode ?? ""}
        fallbackFundName={fundSettingsName}
        funds={fundSettingsFunds}
        onFundChange={handleFundSettingsChange}
        investmentAccounts={investmentAccounts}
        cashAccounts={cashAccounts}
        investmentAccountSSOptions={investmentAccountSSOptions}
        cashAccountSSOptions={cashAccountSSOptions}
        onClose={() => {
          setFundSettingsCode(null);
          setFundSettingsName(null);
        }}
      />

      <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">

      {/* Transaction details */}

      <div className="panel-surface flex min-h-0 flex-1 flex-col overflow-hidden">

        <div className="panel-header shrink-0">

          <div className="flex min-w-0 items-center gap-1 text-left text-sm font-semibold text-slate-800">
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
                  onClick={applyBatchDelete}
                  disabled={batchTargetIds.length === 0 || batchDeleting}
                  className="flex h-6 w-6 items-center justify-center rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-40"
                  title={t("common.delete")}
                  aria-label={t("common.delete")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>

                <span
                  className="h-6 rounded border border-blue-200 bg-blue-50 px-2 text-xs font-medium leading-6 tabular-nums text-blue-700"
                  title={t("fundShell.selectedTitle", { count: batchTargetIds.length })}
                >
                  {t("table.selectedCount", { count: batchTargetIds.length })}
                </span>
                <span className="mx-1 h-4 w-px bg-slate-200" />
              </div>
            ) : null}

            <span className="flex h-6 shrink-0 items-center">{t("fundShell.entriesTitle")}</span>

            {fundCode && (
              <span className={`ml-2 text-xs font-normal ${selectedFundCodeCls}`}>
                {isWealthAccount ? selectedPosition?.name ?? "" : selectedFundDisplayName}
              </span>
            )}

            <span className="ml-2 text-xs text-slate-400 font-normal">{fundCode || showAllRecords || isWealthAccount ? `${detailTableRowCount}/${filtered.length}` : chooseHoldingText}</span>

          </div>

          <div className="flex min-w-0 max-w-[62vw] items-center gap-1 overflow-x-auto whitespace-nowrap pb-0.5 text-xs md:max-w-none md:overflow-visible [&>*]:shrink-0">

            {!isMetalAccount && !isWealthAccount && fundCode ? (
              <FundUnitsReconcileButton
                accountId={accountId}
                fundCode={fundCode}
                fundName={selectedFundDisplayName || null}
                currentUnits={toNumber(selectedPosition?.units ?? 0)}
                fundUnitsDecimals={fundUnitsDecimals}
              />
            ) : null}

            {batchDeleteMessage ? <span className="px-1 text-[10px] text-rose-500">{batchDeleteMessage}</span> : null}

            <div className="relative order-last" ref={detailColumnMenuRef}>

              <button
                type="button"
                onClick={() => setDetailColumnMenuOpen((open) => !open)}
                className="secondary-button h-7 px-2 text-xs"
                title={t("table.columnSettings")}
                aria-label={t("table.columnSettings")}
              >

                <SlidersHorizontal className="h-3.5 w-3.5" />

              </button>

              {detailColumnMenuOpen ? (

                <div className="absolute right-0 top-8 z-50 w-44 rounded-lg border border-slate-200 bg-white p-2 shadow-soft">

                  <div className="mb-1 px-1 text-[11px] font-semibold text-slate-500">{t("table.visibleColumns")}</div>

                  <div className="max-h-56 space-y-1 overflow-y-auto">

                    {DETAIL_COLS.filter(([key]) =>
                      !(isWealthAccount && key === "status") &&
                      !(hideRemainingUnitsDetailColumn && key === "remainingUnits") &&
                      !(isSingleNormalFundScope && key === "fund") &&
                      !FIXED_DETAIL_COLUMNS.has(key)
                    ).map(([key]) => {
                      const checked = isDetailColumnVisible(key);
                      const disabled = checked && visibleOptionalDetailColumnCount <= 1;
                      return (
                        <label
                          key={key}
                          className={`flex items-center gap-2 rounded px-1.5 py-1 text-xs ${
                            disabled ? "text-slate-400" : "cursor-pointer text-slate-700 hover:bg-slate-50"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => toggleDetailColumnVisibility(key)}
                            className="h-3.5 w-3.5 rounded border-slate-300"
                          />
                          <span className="truncate">
                            {key === "fund"
                              ? detailNameLabel
                              : key === "nav"
                                ? navColumnLabel
                                : key === "amount"
                                  ? detailAmountColumnLabel
                                  : t(DETAIL_COLUMN_LABEL_KEYS[key])}
                          </span>
                        </label>
                      );
                    })}

                  </div>

                </div>

              ) : null}

            </div>

            {isMetalAccount || isWealthAccount ? (
            <div className="relative" ref={exportRef}>

              <button onClick={() => setShowExportMenu(!showExportMenu)} className="h-6 px-2 rounded border border-slate-200 bg-white text-slate-500 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-1" title={t("viewImport.exportExcel")}>

                <Download className="w-3 h-3" />{t("viewImport.export")}

              </button>

              {showExportMenu && (

                <div className="absolute right-0 top-7 z-50 min-w-[160px] rounded-lg border border-slate-200 bg-white py-1 shadow-soft">

                  {fundCode && (

                    <button onClick={() => { setShowExportMenu(false); void exportXlsx("current"); }}

                      className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-blue-50">

                      {t("fundShell.export.currentDetail", { kind: isWealthAccount ? t("fundShell.kind.wealth") : t("txForm.fund") })}

                    </button>

                  )}

                  <button onClick={() => { setShowExportMenu(false); void exportXlsx("all"); }}

                    className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-blue-50">

                    {t("fundShell.export.allDetail", { kind: isWealthAccount ? t("fundShell.kind.wealth") : t("txForm.fund") })}

                  </button>

                </div>

              )}

            </div>
            ) : null}

            <div className="flex items-center gap-1">

              <span className="text-slate-300">|</span>

              <DetailTablePaginationControls
                pageSize={fundPageSize}
                detailAll={fundDetailAll}
                safePage={safePage}
                totalPages={totalPages}
                canPrev={canPrevFundPage}
                canNext={canNextFundPage}
                onPageSizeChange={setPagedFundPageSize}
                onShowAll={showAllFundDetailRows}
                onPageChange={goFundPage}
              />

            </div>

          </div>

        </div>

        <div className="block flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 pb-28 pt-2 md:hidden">
          {paged.length > 0 ? (
            <div className="space-y-2.5">
              {paged.map((e: any) => {
                const units = displayUnitsOf(e);
                const nav = e.fundNav != null ? toNumber(e.fundNav) : null;
                const amount = detailAmountOf(e);
                const info = fl(t, e.fundSubtype, e.source);
                const detailSubtypeLabel = isSingleNormalFundScope ? (info as { shortLabel?: string }).shortLabel ?? info.label : info.label;
                const cashInfo = cashAccountInfoOf(e);
                const status = statusOf(e);
                const profit = e.realizedProfit != null && (e.fundSubtype === "redeem" || e.fundSubtype === "dividend_cash")
                  ? toNumber(e.realizedProfit)
                  : null;
                const selected = selectedIds.has(e.id);
                const businessLinkInfo = entryBusinessLinkInfo(e);
                const businessLinkTitle = businessLinkInfo.active
                  ? (businessLinkInfo.labels.length > 0 ? businessLinkInfo.labels.join("；") : t("fundShell.linkedCashFlow"))
                  : t("fundShell.notLinked");
                const isUnitsReconcile = isFundUnitsReconcileEntry(e);
                const unitsReconcileDeltaText = units != null
                  ? `${e.fundSubtype === "redeem" ? "-" : "+"}${formatFundUnits(Math.abs(toNumber(units)))}`
                  : "-";
                const unitsReconcileDeltaClass = e.fundSubtype === "redeem" ? downCls : upCls;

                return (
                  <article
                    key={e.id}
                    className={`rounded-lg border bg-white shadow-sm transition-colors ${
                      selected ? "border-blue-200 bg-blue-50/70" : "border-slate-200"
                    }`}
                    onClick={() => setSelectedIds((prev) => {
                      const next = new Set(prev);
                      if (next.has(e.id)) next.delete(e.id);
                      else next.add(e.id);
                      return next;
                    })}
                    onDoubleClick={() => {
                      if (!isUnitsReconcile) openDetailEdit(e.id);
                    }}
                  >
                    <div className="flex items-start justify-between gap-3 px-3 pt-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${
                            e.source === "dividend" || e.fundSubtype === "dividend_cash" ? `bg-emerald-50 ${upCls}` : info.cls
                          }`}>
                            {detailSubtypeLabel}
                          </span>
                          <span className="truncate text-sm font-semibold text-slate-900" title={displayFundName(e)}>
                            {displayFundName(e)}
                          </span>
                        </div>
                        {!isWealthAccount && e.fundCode && !isSingleNormalFundScope ? (
                          <div className="mt-1 truncate text-[11px] tabular-nums text-slate-400">{e.fundCode}</div>
                        ) : null}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className={`text-base font-semibold tabular-nums ${
                          status === "buy_failed" ? "text-rose-600" : status === "buy_refund" ? "text-emerald-700" : "text-slate-900"
                        }`}>
                          {isUnitsReconcile ? (
                            <span className={unitsReconcileDeltaClass}>{unitsReconcileDeltaText}</span>
                          ) : e.source === "dividend" || e.fundSubtype === "dividend_cash" ? (
                            <span className={upCls}>+{formatMoney(Math.abs(amount))}</span>
                          ) : formatMoney(amount < 0 ? amount : Math.abs(amount))}
                        </div>
                        <div className={`mt-0.5 text-[11px] ${status === "confirmed" || status === "buy_refund" ? "text-emerald-700" : status === "buy_failed" ? "text-rose-600" : "text-amber-600"}`}>
                          {status === "confirmed" ? t("fundShell.status.confirmed") : status === "pending" ? t("fundShell.status.pending") : status === "buy_failed" ? t("fundShell.status.buyFailed") : status === "buy_refund" ? t("fundShell.status.buyRefund") : t("fundShell.status.partial")}
                        </div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 px-3 text-xs">
                      <FundMobileDetailItem label={t("fundShell.col.applyDate")} value={fundApplyDateOf(e) || "-"} />
                      <FundMobileDetailItem label={t("fundShell.col.arrivalDate")} value={e.fundArrivalDate ? fmtDate(e.fundArrivalDate) : "-"} />
                      <FundMobileDetailItem label={navColumnLabel} value={nav != null ? nav.toFixed(4) : "-"} alignRight />
                      <FundMobileDetailItem label={isMetalAccount ? t("fundShell.col.quantity") : t("viewImport.units")} value={units != null ? formatFundUnits(units) : "-"} alignRight />
                      {!hideRemainingUnitsDetailColumn ? (
                        <FundMobileDetailItem
                          label={t("fundShell.col.remainingUnits")}
                          value={e.wealthRemainingUnits != null ? formatFundUnits(toNumber(e.wealthRemainingUnits)) : "-"}
                          alignRight
                        />
                      ) : null}
                      {profit != null ? (
                        <FundMobileDetailItem label={t("overview.profit")} value={formatMoney(profit)} valueClassName={pnl(profit)} alignRight />
                      ) : null}
                      <FundMobileDetailItem label={t("txForm.cashAccount")} value={cashInfo?.label ? cashInfo.label : "-"} wide />
                    </div>

                    <div
                      className="mt-3 flex items-center justify-between border-t border-slate-100 px-3 py-2"
                      onClick={(ev) => ev.stopPropagation()}
                      onDoubleClick={(ev) => ev.stopPropagation()}
                    >
                      <label className="flex h-8 items-center gap-2 text-xs text-slate-500">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(e.id)) next.delete(e.id);
                            else next.add(e.id);
                            return next;
                          })}
                          className="h-4 w-4 accent-blue-600"
                          aria-label={t("fundShell.selectDetailAria", { kind: isWealthAccount ? t("fundShell.kind.wealth") : t("txForm.fund") })}
                        />
                        {t("fundShell.select")}
                      </label>
                      <div className="flex items-center gap-1.5">
                        {!isUnitsReconcile && !isWealthAccount && e.fundCode && e.fundSubtype === "buy" && (e.fundUnits == null || Number(e.fundUnits) === 0) ? (
                          <FillNavButton entryId={e.id} fundCode={e.fundCode} action={fillNavAction} onFilled={(data) => handleEntryNavFilled(e, data)} />
                        ) : null}
                        {!isUnitsReconcile ? (
                          <>
                            <button
                              type="button"
                              onClick={() => {
                                if (!businessLinkInfo.active) void linkDetailCashFlow(e);
                              }}
                              disabled={businessLinkInfo.active || linkingIds.has(String(e.id ?? ""))}
                              className={[
                                "flex h-8 w-8 items-center justify-center rounded border bg-white transition-colors disabled:cursor-default",
                                businessLinkInfo.active
                                  ? "border-slate-200 text-slate-500"
                                  : "border-amber-200 text-amber-700 hover:bg-amber-50 disabled:opacity-60",
                              ].join(" ")}
                              title={businessLinkInfo.active ? businessLinkTitle : linkingIds.has(String(e.id ?? "")) ? t("fundShell.linking") : t("detailView.notLinked")}
                              aria-label={businessLinkInfo.active ? businessLinkTitle : t("detailView.notLinked")}
                            >
                              <LinkStatusIcon active={businessLinkInfo.active} title={businessLinkTitle} />
                            </button>
                            <button
                              type="button"
                              onClick={() => openDetailEdit(e.id)}
                              className="flex h-8 w-8 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50"
                              title={t("insuranceShell.editButton")}
                              aria-label={t("insuranceShell.editButton")}
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                          </>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => { void deleteDetailEntry(e); }}
                          disabled={singleDeletingIds.has(String(e.id ?? ""))}
                          className="flex h-8 w-8 items-center justify-center rounded border border-red-200 bg-white text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50"
                          title={singleDeletingIds.has(String(e.id ?? "")) ? t("stockPanel.deleting") : t("depositShell.deleteButton")}
                          aria-label={singleDeletingIds.has(String(e.id ?? "")) ? t("stockPanel.deleting") : t("depositShell.deleteButton")}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
              {fundCode || showAllRecords || isWealthAccount ? t("fundShell.empty.entries") : chooseHoldingText}
            </div>
          )}
        </div>
        <div className="hidden flex-1 min-h-0 pb-10 md:block">

          <AdvancedDataTable
            storageKey="mmh_fund_shell_detail_advanced_table_v1"
            resetKey={`${accountId}:${fundCode || (showAllRecords ? "all" : "none")}:${showCleared ? "cleared" : "detail"}`}
            columns={detailAdvancedColumns}
            rows={filteredByColumns}
            rowKey={(entry) => String(entry.id)}
            minTableWidth={detailMinTableWidth}
            emptyText={fundCode || showAllRecords || isWealthAccount ? t("fundShell.empty.entries") : chooseHoldingText}
            selectable
            selectOnRowClick
            selectAllScope="renderedRows"
            selectedKeys={selectedIds}
            onSelectionChange={setSelectedIds}
            onRowDoubleClick={(entry) => {
              if (!isFundUnitsReconcileEntry(entry)) openDetailEdit(entry.id);
            }}
            rowActions={detailRowActions}
            rowActionsWidth={112}
            rowActionsMinWidth={92}
            rowClassName={(entry) => (selectedIds.has(entry.id) ? "bg-blue-50/70 hover:bg-blue-50/70" : "hover:bg-blue-50/40")}
            fillHeight
            toolbarMode="none"
            showFilters
            showColumnVisibilityButton={false}
            sortable
            pagination={{
              page: safePage,
              pageSize: fundPageSize,
              all: fundDetailAll,
              onPageChange: goFundPage,
              onRowCountChange: setDetailTableRowCount,
            }}
          />

        </div>

      </div>

      </div>

      </ResizableVerticalSplit>

    </div>

  );

}
