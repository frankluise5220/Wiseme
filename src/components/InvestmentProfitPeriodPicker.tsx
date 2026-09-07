"use client";

import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";

type PickerPeriod = "day" | "month" | "year";

type Props = {
  period: PickerPeriod;
  year: number;
  month: number;
  /** Current start year for the yearly view; null falls back to the first data year. */
  startYear: number | null;
  availableYears: number[];
  baseParams: Record<string, string>;
};

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => index + 1);

const SELECT_CLASS = "h-7 rounded-md border border-slate-200 bg-white px-1.5 text-xs font-medium text-slate-600 hover:border-slate-300";

export function InvestmentProfitPeriodPicker({
  period,
  year,
  month,
  startYear,
  availableYears,
  baseParams,
}: Props) {
  const router = useRouter();
  const { t } = useI18n();
  const years = availableYears.length > 0 ? availableYears : [year];

  function navigate(overrides: Record<string, string>) {
    const query = new URLSearchParams();
    Object.entries(baseParams).forEach(([key, value]) => query.set(key, value));
    Object.entries(overrides).forEach(([key, value]) => {
      if (value) query.set(key, value);
      else query.delete(key);
    });
    router.push(`/reports${query.toString() ? `?${query.toString()}` : ""}`, { scroll: false });
  }

  function yearSelect(value: number, onChange: (next: string) => void, ariaLabel: string) {
    return (
      <select
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
        className={SELECT_CLASS}
        aria-label={ariaLabel}
      >
        {years.map((item) => (
          <option key={item} value={item}>{t("reports.rangeLabelMonth", { year: item })}</option>
        ))}
      </select>
    );
  }

  // Yearly view: pick the year the report starts from ("从哪一年起").
  if (period === "year") {
    return (
      <label className="flex items-center gap-1 text-xs text-slate-500">
        {t("reports.startYear")}
        {yearSelect(startYear ?? years[0], (next) => navigate({ profitStartYear: next }), t("reports.startYear"))}
      </label>
    );
  }

  // Monthly view: pick the year.
  if (period === "month") {
    return yearSelect(year, (next) => navigate({ profitYear: next }), t("reports.year"));
  }

  // Daily view: pick the month within a year (e.g. 2026年9月).
  return (
    <div className="flex items-center gap-1">
      {yearSelect(year, (next) => navigate({ profitYear: next }), t("reports.year"))}
      <select
        value={month}
        onChange={(event) => navigate({ profitMonth: event.target.value })}
        className={SELECT_CLASS}
        aria-label={t("reports.month")}
      >
        {MONTH_OPTIONS.map((item) => (
          <option key={item} value={item}>{t("investmentProfitReport.monthLabel", { month: item })}</option>
        ))}
      </select>
    </div>
  );
}
