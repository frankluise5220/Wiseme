"use client";

import { formatMoney } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import type {
  InvestmentProfitPeriod,
  InvestmentProfitReportRow,
} from "@/lib/server/investment-profit-report";
import { useI18n } from "@/lib/i18n";

const WEEKDAY_LABEL_KEYS = [
  "investmentProfitReport.weekday.sun",
  "investmentProfitReport.weekday.mon",
  "investmentProfitReport.weekday.tue",
  "investmentProfitReport.weekday.wed",
  "investmentProfitReport.weekday.thu",
  "investmentProfitReport.weekday.fri",
  "investmentProfitReport.weekday.sat",
];

type Props = {
  period: InvestmentProfitPeriod;
  year: number;
  month: number;
  rows: InvestmentProfitReportRow[];
  totals: {
    fundProfit: number;
    stockProfit: number;
    wealthProfit: number;
    fixedAssetProfit: number;
    totalProfit: number;
    count: number;
  };
  isRedUp: boolean;
};

function valueClass(value: number, isRedUp: boolean) {
  return pnlClassFromRedUp(value, isRedUp, "muted");
}

function signedMoney(value: number) {
  return `${value > 0 ? "+" : ""}${formatMoney(value)}`;
}

// Row labels (day cells, month/year rows, best/worst names) are derived
// client-side from the ISO row key so they update instantly when the display
// language changes, instead of waiting for a server re-render.
function rowLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  period: InvestmentProfitPeriod,
  key: string,
) {
  if (period === "day") return t("investmentProfitReport.dayLabel", { day: Number(key.slice(-2)) });
  if (period === "month") return t("investmentProfitReport.monthLabel", { month: Number(key.slice(-2)) });
  return t("investmentProfitReport.yearLabel", { year: key });
}

function periodTitle(t: (key: string) => string, period: InvestmentProfitPeriod, year: number, month: number) {
  if (period === "day") {
    return t("investmentProfitReport.title.day")
      .replace("{year}", String(year))
      .replace("{month}", String(month));
  }
  if (period === "month") return t("investmentProfitReport.title.month").replace("{year}", String(year));
  return t("investmentProfitReport.title.year");
}

function totalLabel(t: (key: string) => string, period: InvestmentProfitPeriod) {
  if (period === "day") return t("investmentProfitReport.total.day");
  if (period === "month") return t("investmentProfitReport.total.month");
  return t("investmentProfitReport.total.year");

}

function dailyCells(rows: InvestmentProfitReportRow[]) {
  const first = rows[0]?.key;
  if (!first) return rows.map((row) => ({ row, pad: false }));
  const [year, month] = first.split("-").map((item) => Number(item));
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return [
    ...Array.from({ length: firstDow }, (_, index) => ({ row: null, pad: true, key: `pad-${index}` })),
    ...rows.map((row) => ({ row, pad: false, key: row.key })),
  ];
}

function ProfitNumber({ value, isRedUp }: { value: number; isRedUp: boolean }) {
  return (
    <span className={`tabular-nums font-medium ${valueClass(value, isRedUp)}`}>
      {signedMoney(value)}
    </span>
  );
}

export function InvestmentProfitReport({ period, year, month, rows, totals, isRedUp }: Props) {
  const { t } = useI18n();
  const activeRows = rows.filter((row) => row.count > 0);
  const best = [...activeRows].sort((a, b) => b.totalProfit - a.totalProfit)[0] ?? null;
  const worst = [...activeRows].sort((a, b) => a.totalProfit - b.totalProfit)[0] ?? null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {[
          { key: "total", label: totalLabel(t, period), value: totals.totalProfit },
          { key: "fund", label: t("investmentProfitReport.summary.fundProfit"), value: totals.fundProfit },
          { key: "stock", label: t("investmentProfitReport.summary.stockProfit"), value: totals.stockProfit },
          { key: "wealth", label: t("investmentProfitReport.summary.wealthProfit"), value: totals.wealthProfit },
          { key: "fixedAsset", label: t("investmentProfitReport.summary.fixedAssetProfit"), value: totals.fixedAssetProfit },
        ].map((item) => (
          <div key={item.key} className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-[11px] text-slate-500">{item.label}</div>
            <div className={`mt-1 text-base font-semibold tabular-nums ${valueClass(item.value, isRedUp)}`}>
              {signedMoney(item.value)}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-slate-800">{periodTitle(t, period, year, month)}</div>
            <div className="mt-0.5 text-xs text-slate-500">
              {best
                ? t("investmentProfitReport.bestPeriod")
                    .replace("{name}", rowLabel(t, period, best.key))
                    .replace("{amount}", signedMoney(best.totalProfit))
                : t("investmentProfitReport.noProfitRecords")}
              {worst && worst.key !== best?.key
                ? ` · ${t("investmentProfitReport.worstPeriod")
                    .replace("{name}", rowLabel(t, period, worst.key))
                    .replace("{amount}", signedMoney(worst.totalProfit))}`
                : ""}
            </div>
          </div>
          <div className={`text-sm font-semibold tabular-nums ${valueClass(totals.totalProfit, isRedUp)}`}>
            {signedMoney(totals.totalProfit)}
          </div>
        </div>

        {period === "day" ? (
          <div className="p-3">
            <div className="grid grid-cols-7 gap-1 border-b border-slate-100 pb-1">
              {WEEKDAY_LABEL_KEYS.map((key) => (
                <div key={key} className="text-center text-[11px] text-slate-400">{t(key)}</div>
              ))}
            </div>
            <div className="mt-1 grid grid-cols-7 gap-1">
              {dailyCells(rows).map((cell) => {
                if (!cell.row) return <div key={cell.key} className="min-h-[76px] rounded-md bg-slate-50/30" />;
                const row = cell.row;
                const hasProfit = row.count > 0;
                return (
                  <div
                    key={row.key}
                    className={`flex min-h-[76px] flex-col rounded-md border px-2 py-1.5 ${
                      hasProfit ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50/50"
                    }`}
                    title={`${row.subLabel} ${signedMoney(row.totalProfit)}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-slate-600">{rowLabel(t, period, row.key)}</span>
                      <span className={`text-sm font-bold tabular-nums ${valueClass(row.totalProfit, isRedUp)}`}>
                        {hasProfit ? signedMoney(row.totalProfit) : "-"}
                      </span>
                    </div>
                    {hasProfit ? (
                      <div className="mt-auto space-y-0.5 text-[10px] tabular-nums text-slate-400">
                        {row.fundProfit !== 0 ? <div>{t("investmentProfitReport.daily.fund")} {signedMoney(row.fundProfit)}</div> : null}
                        {row.stockProfit !== 0 ? <div>{t("investmentProfitReport.daily.stock")} {signedMoney(row.stockProfit)}</div> : null}
                        {row.wealthProfit !== 0 ? <div>{t("investmentProfitReport.daily.wealth")} {signedMoney(row.wealthProfit)}</div> : null}
                        {row.fixedAssetProfit !== 0 ? <div>{t("investmentProfitReport.daily.fixedAsset")} {signedMoney(row.fixedAssetProfit)}</div> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="p-3">
            <div className={`grid gap-2 ${period === "month" ? "grid-cols-2 md:grid-cols-3 xl:grid-cols-4" : "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"}`}>
              {rows.map((row) => {
                const hasProfit = row.count > 0;
                return (
                  <div
                    key={row.key}
                    className={`min-h-[116px] rounded-md border p-3 ${
                      hasProfit ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50/50"
                    }`}
                    title={`${row.subLabel || rowLabel(t, period, row.key)} ${signedMoney(row.totalProfit)}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-semibold text-slate-700">{rowLabel(t, period, row.key)}</div>
                        {row.subLabel ? <div className="mt-0.5 truncate text-[10px] text-slate-400">{row.subLabel}</div> : null}
                      </div>
                      {hasProfit ? (
                        <div className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] tabular-nums text-slate-500">
                          {t("investmentProfitReport.colSourceCount")} {row.count}
                        </div>
                      ) : null}
                    </div>
                    <div className={`mt-3 text-base font-semibold tabular-nums ${valueClass(row.totalProfit, isRedUp)}`}>
                      {hasProfit ? signedMoney(row.totalProfit) : "-"}
                    </div>
                    {hasProfit ? (
                      <div className="mt-2 grid grid-cols-1 gap-1 text-[11px] tabular-nums text-slate-500">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate">{t("investmentProfitReport.summary.fundProfit")}</span>
                          <ProfitNumber value={row.fundProfit} isRedUp={isRedUp} />
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate">{t("investmentProfitReport.summary.wealthProfit")}</span>
                          <ProfitNumber value={row.wealthProfit} isRedUp={isRedUp} />
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate">{t("investmentProfitReport.summary.stockProfit")}</span>
                          <ProfitNumber value={row.stockProfit} isRedUp={isRedUp} />
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate">{t("investmentProfitReport.summary.fixedAssetProfit")}</span>
                          <ProfitNumber value={row.fixedAssetProfit} isRedUp={isRedUp} />
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
