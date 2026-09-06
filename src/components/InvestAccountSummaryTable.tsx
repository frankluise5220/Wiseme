"use client";

import { useCallback, useMemo } from "react";
import Link from "next/link";

import { AdvancedDataTable, type AdvancedDataTableColumn, type AdvancedDataTableSummaryRow } from "@/components/AdvancedDataTable";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { formatMoneyYuan, formatPercent } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

export type InvestAccountSummaryRow = {
  id: string;
  label: string;
  hoverTitle: string;
  groupName: string;
  investProductType: string | null;
  productTypeLabel: string;
  balance: number;
  marketValue: number;
  totalCost: number;
  floatingPnL: number;
  floatingPnLRate: number;
  totalBuy: number;
  totalSell: number;
  totalDividend: number;
  totalFee: number;
  realizedPnL: number;
  totalReturn: number;
  totalReturnRate: number;
  txCount: number;
  buyCount: number;
  sellCount: number;
  detailHref: string;
};

export type InvestAccountSummaryTotals = {
  totalCost: number;
  marketValue: number;
  floatingPnL: number;
  floatingRate: number;
  realizedPnL: number;
  totalBuy: number;
  totalFee: number;
};

type Props = {
  rows: InvestAccountSummaryRow[];
  totals: InvestAccountSummaryTotals;
  isRedUp: boolean;
};

const fmt = formatMoneyYuan;
const fmtRate = (value: number) => formatPercent(value);
const dash = <span className="text-slate-300">-</span>;

export function InvestAccountSummaryTable({ rows, totals, isRedUp }: Props) {
  const { t } = useI18n();
  const pnlClass = useCallback((value: number) => pnlClassFromRedUp(value, isRedUp), [isRedUp]);
  const columns = useMemo<AdvancedDataTableColumn<InvestAccountSummaryRow>[]>(() => [
    {
      key: "account",
      label: t("invest.colAccount"),
      width: 270,
      minWidth: 190,
      headerClassName: "text-left",
      className: "px-4",
      filterText: (row) => row.label,
      filterSearchText: (row) => `${row.hoverTitle} ${row.groupName} ${row.productTypeLabel}`,
      sortValue: (row) => row.label,
      render: (row) => (
        <div className="flex min-w-0 items-center gap-1.5" title={row.hoverTitle}>
          <span className="min-w-0 truncate font-semibold text-slate-800">{row.label}</span>
          <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] leading-none text-slate-500">{row.groupName}</span>
          <span className="shrink-0 text-[11px] text-slate-400">{row.productTypeLabel}</span>
        </div>
      ),
    },
    {
      key: "totalCost",
      label: t("invest.totalCost"),
      width: 112,
      minWidth: 88,
      align: "right",
      className: "tabular-nums text-slate-600",
      filterText: (row) => String(row.totalCost),
      sortValue: (row) => row.totalCost,
      render: (row) => row.totalCost > 0 ? fmt(row.totalCost) : dash,
    },
    {
      key: "marketValue",
      label: t("invest.colMarketValue"),
      width: 112,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterText: (row) => String(row.marketValue),
      sortValue: (row) => row.marketValue,
      render: (row) => <span className={pnlClass(row.marketValue)}>{row.marketValue > 0 ? fmt(row.marketValue) : dash}</span>,
    },
    {
      key: "floatingPnL",
      label: t("invest.floatingPnL"),
      width: 112,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterText: (row) => String(row.floatingPnL),
      sortValue: (row) => row.floatingPnL,
      render: (row) => <span className={pnlClass(row.floatingPnL)}>{row.marketValue > 0 ? fmt(row.floatingPnL) : dash}</span>,
    },
    {
      key: "floatingRate",
      label: t("invest.colFloatingRate"),
      width: 92,
      minWidth: 76,
      align: "right",
      className: "tabular-nums",
      filterText: (row) => String(row.floatingPnLRate),
      sortValue: (row) => row.floatingPnLRate,
      render: (row) => <span className={pnlClass(row.floatingPnLRate)}>{row.marketValue > 0 ? fmtRate(row.floatingPnLRate) : dash}</span>,
    },
    {
      key: "realizedPnL",
      label: t("invest.historicalReturn"),
      width: 112,
      minWidth: 88,
      align: "right",
      className: "tabular-nums",
      filterText: (row) => String(row.realizedPnL),
      sortValue: (row) => row.realizedPnL,
      render: (row) => <span className={pnlClass(row.realizedPnL)}>{row.realizedPnL !== 0 ? fmt(row.realizedPnL) : dash}</span>,
    },
    {
      key: "totalBuy",
      label: t("invest.totalBuy"),
      width: 112,
      minWidth: 88,
      align: "right",
      className: "tabular-nums text-slate-600",
      filterText: (row) => String(row.totalBuy),
      sortValue: (row) => row.totalBuy,
      render: (row) => row.totalBuy > 0 ? fmt(row.totalBuy) : dash,
    },
    {
      key: "totalFee",
      label: t("invest.totalFee"),
      width: 92,
      minWidth: 76,
      align: "right",
      className: "tabular-nums text-slate-500",
      filterText: (row) => String(row.totalFee),
      sortValue: (row) => row.totalFee,
      render: (row) => row.totalFee > 0 ? fmt(row.totalFee) : dash,
    },
    {
      key: "txCount",
      label: t("invest.colTransactions"),
      width: 76,
      minWidth: 64,
      align: "center",
      className: "text-slate-500",
      filterText: (row) => String(row.txCount),
      sortValue: (row) => row.txCount,
      render: (row) => row.txCount > 0 ? row.txCount : dash,
    },
    {
      key: "actions",
      label: t("invest.colActions"),
      width: 80,
      minWidth: 72,
      headerClassName: "text-left",
      render: (row) => (
        <Link href={row.detailHref} className="text-xs text-blue-600 hover:text-blue-800">
          {t("invest.detail")}
        </Link>
      ),
    },
  ], [pnlClass, t]);
  const summaryRow = useMemo<AdvancedDataTableSummaryRow | undefined>(() => {
    if (rows.length === 0) return undefined;
    return {
      cells: {
        account: <span className="text-xs font-semibold text-slate-700">{t("invest.totalLabel")}</span>,
        totalCost: <span className="tabular-nums text-xs text-slate-600">{fmt(totals.totalCost)}</span>,
        marketValue: <span className={`tabular-nums text-xs font-semibold ${pnlClass(totals.marketValue)}`}>{fmt(totals.marketValue)}</span>,
        floatingPnL: <span className={`tabular-nums text-xs font-semibold ${pnlClass(totals.floatingPnL)}`}>{fmt(totals.floatingPnL)}</span>,
        floatingRate: <span className={`tabular-nums text-xs ${pnlClass(totals.floatingRate)}`}>{fmtRate(totals.floatingRate)}</span>,
        realizedPnL: <span className={`tabular-nums text-xs font-semibold ${pnlClass(totals.realizedPnL)}`}>{fmt(totals.realizedPnL)}</span>,
        totalBuy: <span className="tabular-nums text-xs text-slate-600">{fmt(totals.totalBuy)}</span>,
        totalFee: <span className="tabular-nums text-xs text-slate-500">{fmt(totals.totalFee)}</span>,
      },
      rowClassName: "bg-slate-50",
      cellClassName: "text-xs",
    };
  }, [pnlClass, rows.length, t, totals]);

  return (
    <AdvancedDataTable
      storageKey="mmh_invest_account_summary_v1"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      emptyText={t("invest.noData")}
      minTableWidth={1160}
      rowClassName={() => "hover:bg-slate-50"}
      showFilters={false}
      toolbarMode="none"
      draggableRows={false}
      summaryRow={summaryRow}
    />
  );
}
