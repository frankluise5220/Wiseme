"use client";

import { Shield } from "lucide-react";

import { formatMoneyYuan } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { useI18n } from "@/lib/i18n";

export type InsuranceOverviewCategoryRow = {
  key: string;
  label: string;
  premium: number;
  coverage: number;
  productCount: number;
};

export type InsuranceOverviewPersonRow = {
  insuredPersonKey: string;
  insuredPersonId: string | null;
  insuredPersonName: string;
  premium: number;
  coverage: number;
  productCount: number;
  categories: InsuranceOverviewCategoryRow[];
};

export type InsuranceOverview = {
  productCount: number;
  insuredPersonCount: number;
  totalPremium: number;
  totalCoverage: number;
  categoryRows: InsuranceOverviewCategoryRow[];
  personRows: InsuranceOverviewPersonRow[];
};

export function InsuranceOverviewCard({
  className = "panel-surface",
  insuranceOverview,
  isRedUp,
}: {
  className?: string;
  insuranceOverview?: InsuranceOverview | null;
  isRedUp: boolean;
}) {
  const { t } = useI18n();
  const insuranceRows = insuranceOverview?.personRows ?? [];
  const coverageColumns = (insuranceOverview?.categoryRows ?? []).filter((item) => item.key !== "other").slice(0, 4);

  return (
    <div className={`${className} overflow-hidden`}>
      <div className="panel-header">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
          <Shield className="h-4 w-4 text-cyan-500" />
          {t("insuranceOverview.title")}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 px-4 py-4 lg:grid-cols-4">
        <MetricCard label={t("insuranceOverview.insuredPersons")} value={t("insuranceOverview.peopleCountValue").replace("{count}", String(insuranceOverview?.insuredPersonCount ?? 0))} />
        <MetricCard label={t("insuranceOverview.insuranceProducts")} value={t("insuranceOverview.productCountValue").replace("{count}", String(insuranceOverview?.productCount ?? 0))} />
        <MetricCard label={t("insuranceOverview.totalPremium")} value={formatMoneyYuan(insuranceOverview?.totalPremium ?? 0)} valueClass={directionalClass(-(insuranceOverview?.totalPremium ?? 0), isRedUp)} />
        <MetricCard label={t("insuranceOverview.totalCoverage")} value={formatMoneyYuan(insuranceOverview?.totalCoverage ?? 0)} />
      </div>
      <div className="border-t border-slate-100 px-4 pb-4">
        {insuranceRows.length > 0 && coverageColumns.length > 0 ? (
          <>
          <div className="divide-y divide-slate-100 sm:hidden">
            {insuranceRows.slice(0, 8).map((person) => (
              <div key={person.insuredPersonKey} className="py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 truncate text-sm font-semibold text-slate-800">{person.insuredPersonName}</div>
                  <div className="shrink-0 text-sm font-semibold tabular-nums text-slate-900">{formatCompactMoney(person.coverage, t)}</div>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
                  {coverageColumns.map((column) => {
                    const coverage = person.categories.find((category) => category.key === column.key)?.coverage ?? 0;
                    if (coverage <= 0) return null;
                    return (
                      <span key={column.key} className="inline-flex items-center gap-1">
                        <span>{column.label}</span>
                        <span className="font-medium tabular-nums text-slate-700">{formatCompactMoney(coverage, t)}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full table-fixed border-separate border-spacing-0 text-xs">
              <thead>
                <tr className="text-slate-500">
                  <th className="sticky left-0 z-10 bg-white px-0 py-2 pr-3 text-left font-semibold">{t("insuranceOverview.column.person")}</th>
                  {coverageColumns.map((column) => (
                    <th key={column.key} className="px-2 py-2 text-right font-semibold">{column.label}</th>
                  ))}
                  <th className="px-2 py-2 text-right font-semibold">{t("insuranceOverview.column.total")}</th>
                </tr>
              </thead>
              <tbody>
                {insuranceRows.slice(0, 8).map((person) => (
                  <tr key={person.insuredPersonKey} className="group">
                    <td className="sticky left-0 z-10 max-w-[120px] bg-white py-2 pr-3 align-middle group-hover:bg-slate-50">
                      <div className="truncate font-semibold text-slate-800">{person.insuredPersonName}</div>
                    </td>
                    {coverageColumns.map((column) => {
                      const item = person.categories.find((category) => category.key === column.key);
                      const coverage = item?.coverage ?? 0;
                      return (
                        <td key={column.key} className="border-t border-slate-100 px-2 py-2 text-right align-middle tabular-nums group-hover:bg-slate-50">
                          {coverage > 0 ? (
                            <div>
                              <div className="font-semibold text-slate-800">{formatCompactMoney(coverage, t)}</div>
                            </div>
                          ) : (
                            <span className="text-slate-300">-</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="border-t border-slate-100 px-2 py-2 text-right align-middle font-semibold tabular-nums text-slate-900 group-hover:bg-slate-50">
                      {formatCompactMoney(person.coverage, t)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        ) : (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-center text-sm text-slate-400">
            {t("insuranceOverview.empty")}
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCard({ label, value, valueClass = "text-slate-900" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/80 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-sm font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}

function directionalClass(value: number, isRedUp: boolean) {
  return pnlClassFromRedUp(value, isRedUp, "softMuted");
}

function formatCompactMoney(value: number, t: (key: string, params?: Record<string, string | number>) => string) {
  if (!Number.isFinite(value) || value === 0) return "-";
  if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(Math.abs(value) >= 1000000 ? 0 : 1)}${t("common.compactUnit")}`;
  return formatMoneyYuan(value);
}
