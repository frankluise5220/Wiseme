import Link from "next/link";
import { cookies } from "next/headers";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { TransactionType } from "@prisma/client";

import { InvestmentProfitReport } from "@/components/InvestmentProfitReport";
import { InvestmentProfitFilterSelect } from "@/components/InvestmentProfitFilterSelect";
import { MissingFundNavPrompt } from "@/components/MissingFundNavPrompt";
import { IncomeExpenseReportClient } from "@/components/IncomeExpenseReportClient";
import { buildCategorySmartSelectOptions } from "@/components/categorySmartSelect";
import { ReportTransactionEditHost } from "@/components/ReportTransactionEditHost";
import { ReportSelector } from "@/components/ReportSelector";
import { StatisticsFilterPanel } from "@/components/StatisticsFilterPanel";
import { CASH_INSTITUTION_ID } from "@/components/AccountScopeFilter";
import { splitInstitutionSelection } from "@/lib/fund-company-filter";
import type { ReportItem } from "@/components/ReportSelector";
import { StockHoldingReport } from "@/components/StockHoldingReport";
import { FundHoldingReport, type FundGroupMode } from "@/components/FundHoldingReport";
import { FundGroupModeFilter } from "@/components/FundGroupModeFilter";
import { buildAccountDisplayOption, buildGroupedAccountOptions, normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { ACCOUNT_LABEL_FIELDS_COOKIE, accountLabelFieldsFromCookieValue } from "@/lib/server/account-label-fields";
import {
  ACCOUNT_DROPDOWN_RESTRICT_TYPE_COOKIE,
  accountDropdownRestrictTypeFromCookieValue,
} from "@/lib/server/account-dropdown-restrict";
import { kindLabel } from "@/lib/account-kinds";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { prisma } from "@/lib/db/prisma";
import { formatDateUtc } from "@/lib/date-utils";
import type { ColorScheme } from "@/lib/client/colors";
import {
  getIncomeExpenseReport,
  type IncomeExpenseGroupBy,
  type IncomeExpenseReportDetailType,
  type IncomeExpenseReportRow,
} from "@/lib/server/income-expense-report";
import { loadInvestmentProfitReport, type InvestmentProfitPeriod } from "@/lib/server/investment-profit-report";
import { loadCommonData, loadCachedStockHoldingReport, loadCachedFundHoldingReport } from "@/lib/server/cached-data";
import { stockMarketLabel } from "@/lib/stock/market";
import { systemCategoryLabel } from "@/lib/system-category-labels";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadReportDetailEntries } from "@/lib/server/report-detail-entries";
import { getServerDisplayLanguage, getServerT } from "@/lib/server/i18n";

export const dynamic = "force-dynamic";

function escapeCsvCell(value: string) {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function buildCsvDataUri(rows: string[][]) {
  const csv = rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
  return `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${csv}`)}`;
}

function parseMonthUtc(value: string | undefined, fallback: Date) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return fallback;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12) return fallback;
  return new Date(Date.UTC(year, month - 1, 1));
}

function endOfMonthUtc(value: Date) {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0));
}

function parseYear(value: string | undefined) {
  const year = Number(String(value ?? "").trim());
  return Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null;
}

const PROFIT_SCOPE_ALL = "all";
function normalizeProfitScope(value: string | undefined) {
  const raw = String(value ?? "").trim();
  return raw || PROFIT_SCOPE_ALL;
}

function rowCsv(section: "income" | "expense", row: IncomeExpenseReportRow, t: (key: string) => string) {
  return [
    section === "income" ? t("reports.income") : t("reports.expense"),
    `${"  ".repeat(row.depth)}${systemCategoryLabel(row.name, t)}`,
    ...row.values.map((value) => value.toFixed(2)),
    row.total.toFixed(2),
  ];
}

type ReportType = "income-expense" | "investment-profit" | "stock-holdings" | "fund-holdings";

function reportMenuItems(
  currentType: ReportType,
  investmentHref: string,
  stockHref: string,
  fundHref: string,
  statisticsHref: string,
  t: (key: string) => string,
): ReportItem[] {
  return [
    { value: "income-expense", label: t("reports.menu.incomeExpense"), href: "/reports" },
    { value: "investment-profit", label: t("reports.menu.investmentProfit"), href: investmentHref },
    { value: "stock-holdings", label: t("reports.menu.stockHoldings"), href: stockHref },
    { value: "fund-holdings", label: t("reports.menu.fundHoldings"), href: fundHref },
    { value: "cash-statistics", label: t("reports.menu.cashStatisticsCharts"), href: statisticsHref },
  ];
}

function buildReportHref(
  reportType: ReportType,
  profitPeriod?: InvestmentProfitPeriod,
  profitYear?: number,
  profitMonth?: number,
  profitScope?: string,
) {
  const query = new URLSearchParams();
  if (reportType === "investment-profit") {
    query.set("report", reportType);
    query.set("profitPeriod", profitPeriod ?? "day");
    if (profitYear) query.set("profitYear", String(profitYear));
    if (profitMonth) query.set("profitMonth", String(profitMonth));
    const normalizedScope = normalizeProfitScope(profitScope);
    if (normalizedScope !== PROFIT_SCOPE_ALL) query.set("profitScope", normalizedScope);
  }
  if (reportType === "stock-holdings" || reportType === "fund-holdings") {
    query.set("report", reportType);
    const normalizedScope = normalizeProfitScope(profitScope);
    if (normalizedScope !== PROFIT_SCOPE_ALL) query.set("profitScope", normalizedScope);
  }
  return `/reports${query.toString() ? `?${query.toString()}` : ""}`;
}

function buildInvestmentFilterHref(
  profitPeriod: InvestmentProfitPeriod,
  profitYear: number,
  profitMonth: number,
  filters: { userIds: string[]; institutionIds: string[]; accountIds: string[] },
) {
  const query = new URLSearchParams();
  query.set("report", "investment-profit");
  query.set("profitPeriod", profitPeriod);
  query.set("profitYear", String(profitYear));
  query.set("profitMonth", String(profitMonth));
  if (filters.userIds.length) query.set("userIds", filters.userIds.join(","));
  if (filters.institutionIds.length) query.set("institutionIds", filters.institutionIds.join(","));
  if (filters.accountIds.length) query.set("investmentAccounts", filters.accountIds.join(","));
  return `/reports${query.toString() ? `?${query.toString()}` : ""}`;
}
function buildStatisticsHref() {
  // 资金统计默认展示"按月、最近 12 期"（/statistics 无参数即命中该默认）。
  // 不携带 ?year=xxx，避免 level 被判定为年模式而回退到单年/全历史。
  return `/statistics`;
}

function parseMonthNumber(value: string | undefined, fallback: number) {
  const month = Number(String(value ?? "").trim());
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month : fallback;
}

function shiftProfitWindow(period: InvestmentProfitPeriod, year: number, month: number, delta: number) {
  if (period === "day") {
    const shifted = new Date(Date.UTC(year, month - 1 + delta, 1));
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
  }
  if (period === "month") return { year: year + delta, month };
  return { year, month };
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const t = await getServerT();
  const language = await getServerDisplayLanguage();
  const now = new Date();
  const reportType: ReportType =
    params.report === "investment-profit" || params.report === "stock-holdings" || params.report === "fund-holdings"
      ? params.report
      : "income-expense";
  const profitPeriod: InvestmentProfitPeriod =
    params.profitPeriod === "month" || params.profitPeriod === "year" ? params.profitPeriod : "day";
  const defaultStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const groupBy = params.groupBy === "year" ? "year" : "month";
  const rawStartMonth = typeof params.startMonth === "string"
    ? params.startMonth
    : typeof params.start === "string"
      ? params.start.slice(0, 7)
      : undefined;
  const rawEndMonth = typeof params.endMonth === "string"
    ? params.endMonth
    : typeof params.end === "string"
      ? params.end.slice(0, 7)
      : undefined;
  const requestedStartMonth = parseMonthUtc(rawStartMonth, defaultStart);
  const requestedEndMonth = parseMonthUtc(rawEndMonth, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  let requestedStart = requestedStartMonth;
  let requestedEnd = endOfMonthUtc(requestedEndMonth);
  const rawStartYear = typeof params.startYear === "string"
    ? params.startYear
    : typeof params.start === "string"
      ? params.start.slice(0, 4)
      : undefined;
  const rawEndYear = typeof params.endYear === "string"
    ? params.endYear
    : typeof params.end === "string"
      ? params.end.slice(0, 4)
      : undefined;
  const selectedAccountId = typeof params.accountId === "string" ? params.accountId.trim() : "";
  const rawDetailType = typeof params.detailType === "string" ? params.detailType : "";
  const detailType: IncomeExpenseReportDetailType | null =
    rawDetailType === "income" || rawDetailType === "expense" || rawDetailType === "net"
      ? rawDetailType
      : null;
  const detailCategoryKey =
    typeof params.detailCategoryKey === "string" ? params.detailCategoryKey.trim() : "";
  const detailColumnKey =
    typeof params.detailColumnKey === "string" ? params.detailColumnKey.trim() : "";
  const cookieStore = await cookies();
  const accountLabelFields = accountLabelFieldsFromCookieValue(cookieStore.get(ACCOUNT_LABEL_FIELDS_COOKIE)?.value);
  const restrictAccountDropdownTypes = accountDropdownRestrictTypeFromCookieValue(
    cookieStore.get(ACCOUNT_DROPDOWN_RESTRICT_TYPE_COOKIE)?.value,
  );
  const restrictAccountList = <T extends { kind?: string | null }>(items: T[], predicate: (a: T) => boolean) =>
    restrictAccountDropdownTypes ? items.filter(predicate) : items;
  const colorScheme = (cookieStore.get("colorScheme")?.value === "green_up_red_down"
    ? "green_up_red_down"
    : "red_up_green_down") satisfies ColorScheme;
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_label_template")?.value,
    creditCardLabelMode,
  );
  const ctx = await getHouseholdScope();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const profitYear = parseYear(typeof params.profitYear === "string" ? params.profitYear : undefined) ?? currentYear;
  const profitMonth = parseMonthNumber(
    typeof params.profitMonth === "string" ? params.profitMonth : undefined,
    currentMonth,
  );


  const commonData = await loadCommonData(ctx.hidFilter);
  const allAccountRecords = commonData.accounts.filter((account) =>
    account.isActive && account.isPlaceholder !== true && account.name !== "未指定账户",
  );
  const groupsWithAccounts = commonData.groups.filter((group) =>
    allAccountRecords.some((account) => account.groupId === group.id),
  );
  const accountRecords = restrictAccountList(allAccountRecords, (account) => !isPureInvestmentAccount(account));
  const allAccountDisplayOptions = allAccountRecords.map((account) =>
    buildAccountDisplayOption({
      id: account.id,
      name: account.name,
      kind: account.kind,
      numberMasked: account.numberMasked,
      groupId: account.groupId,
      investProductType: account.investProductType,
      Institution: account.Institution,
      AccountGroup: account.AccountGroup,
    }, creditCardLabelTemplate, { fields: accountLabelFields }),
  );
  const allAccountDisplayById = new Map(allAccountDisplayOptions.map((account) => [account.id, account]));
  const accountDisplayOptions = accountRecords.map((account) => allAccountDisplayById.get(account.id)!).filter(Boolean);
  const accountDisplayById = new Map(accountDisplayOptions.map((account) => [account.id, account]));
  const accounts = accountRecords.map((account) => ({
    id: account.id,
    label: accountDisplayById.get(account.id)?.label ?? account.name,
    title: accountDisplayById.get(account.id)?.hoverTitle,
    subLabel: kindLabel(account.kind),
    kind: account.kind,
    investProductType: account.investProductType,
    debtDirection: account.debtDirection,
    institutionId: account.institutionId,
    currency: account.currency,
  }));
  const accountSSOptions = buildGroupedAccountOptions(accountDisplayOptions);
  const incomeFilterAccounts = accountRecords.map((account) => ({
    id: account.id,
    name: account.name,
    kind: account.kind,
    label: allAccountDisplayById.get(account.id)?.fullLabel ?? allAccountDisplayById.get(account.id)?.label ?? account.name,
    groupId: account.groupId,
    Institution: account.Institution ? { id: account.Institution.id, name: account.Institution.name } : null,
  }));
  const incomeFilterInstitutions = commonData.institutions
    .filter((institution) => incomeFilterAccounts.some((account) => account.Institution?.id === institution.id))
    .map((institution) => ({ id: institution.id, name: institution.name, type: institution.type ?? null }));
  const incomeFilterUsers = groupsWithAccounts.map((group) => ({ id: group.id, name: group.name }));
  const selectedIncomeUserIds = typeof params.userIds === "string"
    ? params.userIds.split(",").map((id) => id.trim()).filter(Boolean)
    : [];
  const selectedIncomeInstitutionIds = typeof params.institutionIds === "string"
    ? params.institutionIds.split(",").map((id) => id.trim()).filter(Boolean)
    : [];
  const selectedIncomeAccountIds = typeof params.accountId === "string"
    ? params.accountId.split(",").map((id) => id.trim()).filter(Boolean)
    : [];
  const scopedIncomeAccountIds = (() => {
    const scopes: Array<string[]> = [];
    if (selectedIncomeAccountIds.length) scopes.push(selectedIncomeAccountIds);
    if (selectedIncomeInstitutionIds.length) {
      scopes.push(accountRecords
        .filter((account) => account.institutionId && selectedIncomeInstitutionIds.includes(account.institutionId))
        .map((account) => account.id));
    }
    if (selectedIncomeUserIds.length) {
      scopes.push(accountRecords
        .filter((account) => account.groupId && selectedIncomeUserIds.includes(account.groupId))
        .map((account) => account.id));
    }
    if (scopes.length === 0) return null;
    return accountRecords.map((account) => account.id).filter((id) => scopes.every((ids) => ids.includes(id)));
  })();
  const cashAccounts = restrictAccountList(accounts, (account) => ["cash", "bank_debit", "ewallet"].includes(account.kind));
  const cashAccountIds = new Set(cashAccounts.map((account) => account.id));
  const investmentAccountRecords = restrictAccountList(allAccountRecords, isPureInvestmentAccount);
  const stockAccountRecords = restrictAccountList(investmentAccountRecords, (account) => account.investProductType === "stock");
  const investmentAccounts = investmentAccountRecords.map((account) => ({
    id: account.id,
    label: allAccountDisplayById.get(account.id)?.label ?? account.name,
    title: allAccountDisplayById.get(account.id)?.hoverTitle,
    subLabel: kindLabel(account.kind),
    kind: account.kind,
    investProductType: account.investProductType,
    debtDirection: account.debtDirection,
    institutionId: account.institutionId,
    currency: account.currency,
  }));
  const investmentAccountIds = new Set(investmentAccounts.map((account) => account.id));
  const cashAccountSSOptions = buildGroupedAccountOptions(
    allAccountDisplayOptions.filter((account) => cashAccountIds.has(account.id)),
  );
  const investmentAccountSSOptions = buildGroupedAccountOptions(
    allAccountDisplayOptions.filter((account) => investmentAccountIds.has(account.id)),
  );
  const selectedUserIds = typeof params.userIds === "string"
    ? params.userIds.split(",").map((id) => id.trim()).filter(Boolean)
    : [];
  const selectedInstitutionIds = typeof params.institutionIds === "string"
    ? params.institutionIds.split(",").map((id) => id.trim()).filter(Boolean)
    : [];
  const selectedInvestmentAccountIds = typeof params.investmentAccounts === "string"
    ? params.investmentAccounts.split(",").map((id) => id.trim()).filter(Boolean)
    : [];
  // Fund companies ride inside `institutionIds` under the `__fundcompany__:` prefix
  // (they are FundProfile names, not Institution rows). Split them out so the
  // account scoping below only sees real institutions.
  const { fundCompanies: selectedFundCompanies, institutionIds: selectedRealInstitutionIds } =
    splitInstitutionSelection(selectedInstitutionIds);
  const fundGroupMode: FundGroupMode = params.fundGroup === "company" ? "company" : "account";
  const scopedInvestmentAccountIds = (() => {
    const scopes: Array<string[]> = [];
    if (selectedInvestmentAccountIds.length) scopes.push(selectedInvestmentAccountIds);
    if (selectedInstitutionIds.length) {
      scopes.push(investmentAccountRecords
        .filter((account) => selectedInstitutionIds.includes(account.institutionId ?? CASH_INSTITUTION_ID))
        .map((account) => account.id));
    }
    if (selectedUserIds.length) {
      scopes.push(investmentAccountRecords
        .filter((account) => account.groupId && selectedUserIds.includes(account.groupId))
        .map((account) => account.id));
    }
    if (scopes.length === 0) return null;
    return investmentAccountRecords.map((account) => account.id).filter((id) => scopes.every((ids) => ids.includes(id)));
  })();
  const currentInvestmentHref = buildInvestmentFilterHref(profitPeriod, profitYear, profitMonth, {
    userIds: selectedUserIds,
    institutionIds: selectedInstitutionIds,
    accountIds: selectedInvestmentAccountIds,
  });
  const currentStockHref = buildReportHref("stock-holdings", undefined, undefined, undefined, PROFIT_SCOPE_ALL);
  const currentFundHref = buildReportHref("fund-holdings", undefined, undefined, undefined, PROFIT_SCOPE_ALL);
  const currentStatisticsHref = buildStatisticsHref();
  const investmentFilterUsers = commonData.groups
    .filter((group) => investmentAccountRecords.some((account) => account.groupId === group.id))
    .map((group) => ({ id: group.id, name: group.name }));
  const investmentFilterInstitutions = commonData.institutions
    .filter((institution) => investmentAccountRecords.some((account) => account.institutionId === institution.id))
    .map((institution) => ({ id: institution.id, name: institution.name, type: institution.type ?? null }));
  const investmentFilterAccounts = investmentAccountRecords.map((account) => ({
    id: account.id,
    name: account.name,
    kind: account.kind,
    investProductType: account.investProductType,
    label: allAccountDisplayById.get(account.id)?.fullLabel ?? allAccountDisplayById.get(account.id)?.label ?? account.name,
    groupId: account.groupId,
    Institution: account.Institution ? { id: account.Institution.id, name: account.Institution.name } : null,
  }));
  if (reportType === "investment-profit") {
    const investmentReport = await loadInvestmentProfitReport(ctx, {
      period: profitPeriod,
      year: profitYear,
      month: profitMonth,
      accountIds: scopedInvestmentAccountIds,
      fundValuationMode: "daily_nav_delta",
    }, language);
    const periodHref = (period: InvestmentProfitPeriod) =>
      buildInvestmentFilterHref(period, profitYear, profitMonth, {
        userIds: selectedUserIds,
        institutionIds: selectedInstitutionIds,
        accountIds: selectedInvestmentAccountIds,
      });
    const previousWindow = shiftProfitWindow(profitPeriod, profitYear, profitMonth, -1);
    const nextWindow = shiftProfitWindow(profitPeriod, profitYear, profitMonth, 1);
    const previousHref = buildInvestmentFilterHref(profitPeriod, previousWindow.year, previousWindow.month, {
      userIds: selectedUserIds,
      institutionIds: selectedInstitutionIds,
      accountIds: selectedInvestmentAccountIds,
    });
    const nextHref = buildInvestmentFilterHref(profitPeriod, nextWindow.year, nextWindow.month, {
      userIds: selectedUserIds,
      institutionIds: selectedInstitutionIds,
      accountIds: selectedInvestmentAccountIds,
    });
    const rangeLabel = profitPeriod === "day"
      ? t("reports.rangeLabelDay", { year: profitYear, month: profitMonth })
      : profitPeriod === "month"
        ? t("reports.rangeLabelMonth", { year: profitYear })
        : t("reports.rangeLabelYear", { year: currentYear });
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="page-header">
          <div className="flex h-12 items-center justify-between px-4">
            <div className="text-sm page-title">{t("reports.page.title")}</div>
            <div className="flex items-center gap-2">
              <ReportSelector
                currentType="investment-profit"
                items={reportMenuItems("investment-profit", currentInvestmentHref, currentStockHref, currentFundHref, currentStatisticsHref, t)}
              />
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden p-4 md:p-5">
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-1 pb-2">
              <div className="flex shrink-0 items-center gap-1">
                <div className="flex items-center gap-1">
                  {(["day", "month", "year"] as InvestmentProfitPeriod[]).map((period) => (
                    <Link
                      key={period}
                      href={periodHref(period)}
                      scroll={false}
                      className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-medium transition ${
                        profitPeriod === period
                          ? "bg-slate-900 text-white shadow-sm"
                          : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      {period === "day" ? t("reports.period.day") : period === "month" ? t("reports.period.month") : t("reports.period.year")}
                    </Link>
                  ))}
                </div>
                {profitPeriod !== "year" ? (
                  <Link
                    href={previousHref}
                    scroll={false}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                    title={profitPeriod === "day" ? t("reports.prevMonth") : t("reports.prevYear")}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Link>
                ) : null}
                <span className="min-w-24 text-center text-xs font-medium text-slate-500">{rangeLabel}</span>
                {profitPeriod !== "year" ? (
                  <Link
                    href={nextHref}
                    scroll={false}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-800"
                    title={profitPeriod === "day" ? t("reports.nextMonth") : t("reports.nextYear")}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Link>
                ) : null}
              </div>
              <InvestmentProfitFilterSelect
                selectedUserIds={selectedUserIds}
                selectedInstitutionIds={selectedInstitutionIds}
                selectedAccountIds={selectedInvestmentAccountIds}
                allUsers={investmentFilterUsers}
                allInstitutions={investmentFilterInstitutions}
                allAccounts={investmentFilterAccounts}
                baseParams={{ report: "investment-profit", profitPeriod, profitYear: String(profitYear), profitMonth: String(profitMonth) }}
              />
              <MissingFundNavPrompt items={investmentReport.missingNavs} className="ml-auto" />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <InvestmentProfitReport
                period={profitPeriod}
                year={profitYear}
                month={profitMonth}
                rows={investmentReport.rows}
                totals={investmentReport.totals}
                isRedUp={colorScheme === "red_up_green_down"}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (reportType === "stock-holdings") {
    const stockScopedAccountIds = (() => {
      const scopes: Array<string[]> = [];
      if (selectedInvestmentAccountIds.length) scopes.push(selectedInvestmentAccountIds);
      if (selectedInstitutionIds.length) {
        scopes.push(stockAccountRecords
          .filter((account) => selectedInstitutionIds.includes(account.institutionId ?? CASH_INSTITUTION_ID))
          .map((account) => account.id));
      }
      if (selectedUserIds.length) {
        scopes.push(stockAccountRecords
          .filter((account) => account.groupId && selectedUserIds.includes(account.groupId))
          .map((account) => account.id));
      }
      if (scopes.length === 0) return null;
      return stockAccountRecords.map((account) => account.id).filter((id) => scopes.every((ids) => ids.includes(id)));
    })();
    const stockReport = await loadCachedStockHoldingReport(
      JSON.stringify(ctx.hidFilter),
      JSON.stringify(stockScopedAccountIds ?? []),
    );
    const stockFilterUsers = commonData.groups
      .filter((group) => stockAccountRecords.some((account) => account.groupId === group.id))
      .map((group) => ({ id: group.id, name: group.name }));
    const stockFilterInstitutions = commonData.institutions
      .filter((institution) => stockAccountRecords.some((account) => account.institutionId === institution.id))
      .map((institution) => ({ id: institution.id, name: institution.name, type: institution.type ?? null }));
    const stockFilterAccounts = stockAccountRecords.map((account) => ({
      id: account.id,
      name: account.name,
      kind: account.kind,
      investProductType: account.investProductType,
      label: allAccountDisplayById.get(account.id)?.fullLabel ?? allAccountDisplayById.get(account.id)?.label ?? account.name,
      groupId: account.groupId,
      Institution: account.Institution ? { id: account.Institution.id, name: account.Institution.name } : null,
    }));
    const stockExportHref = buildCsvDataUri([
      [
        t("reports.stock.market"),
        t("reports.stock.code"),
        t("reports.stock.name"),
        t("reports.account"),
        t("reports.stock.quantity"),
        t("reports.stock.avgCost"),
        t("reports.stock.cost"),
        t("reports.stock.closePrice"),
        t("reports.stock.marketValue"),
        t("reports.stock.floatingPnL"),
        t("reports.stock.floatingPnLRate"),
        t("reports.stock.realizedProfit"),
        t("reports.stock.totalProfit"),
      ],
      ...stockReport.rows.map((row) => [
        stockMarketLabel(row.market),
        row.stockCode,
        row.stockName,
        row.accountName,
        String(row.quantity),
        row.avgCost.toFixed(4),
        row.cost.toFixed(2),
        row.latestPrice == null ? "" : row.latestPrice.toFixed(4),
        row.marketValue.toFixed(2),
        row.floatingPnL.toFixed(2),
        (row.floatingPnLRate * 100).toFixed(2),
        row.historicalProfit.toFixed(2),
        row.totalProfit.toFixed(2),
      ]),
      [
        t("reports.total"),
        "",
        "",
        "",
        String(stockReport.totals.quantity),
        "",
        stockReport.totals.cost.toFixed(2),
        "",
        stockReport.totals.marketValue.toFixed(2),
        stockReport.totals.floatingPnL.toFixed(2),
        (stockReport.totals.floatingPnLRate * 100).toFixed(2),
        stockReport.totals.historicalProfit.toFixed(2),
        stockReport.totals.totalProfit.toFixed(2),
      ],
    ]);

    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="page-header">
          <div className="flex h-12 items-center justify-between px-4">
            <div className="text-sm page-title">{t("reports.menu.stockHoldings")}</div>
            <div className="flex items-center gap-2">
              <ReportSelector
                currentType="stock-holdings"
                items={reportMenuItems("stock-holdings", currentInvestmentHref, currentStockHref, currentFundHref, currentStatisticsHref, t)}
              />
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden p-4 md:p-5">
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-1 pb-2">
              <InvestmentProfitFilterSelect
                selectedUserIds={selectedUserIds}
                selectedInstitutionIds={selectedInstitutionIds}
                selectedAccountIds={selectedInvestmentAccountIds}
                allUsers={stockFilterUsers}
                allInstitutions={stockFilterInstitutions}
                allAccounts={stockFilterAccounts}
                baseParams={{ report: "stock-holdings" }}
              />
              <a
                href={stockExportHref}
                download={`${t("reports.filename.stockHoldings")}.csv`}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-700"
                title={t("reports.exportStockTitle")}
              >
                <Download className="h-3.5 w-3.5" />
                {t("reports.export")}
              </a>
            </div>
            <StockHoldingReport
              rows={stockReport.rows}
              totals={stockReport.totals}
              isRedUp={colorScheme === "red_up_green_down"}
            />
          </div>
        </div>
      </div>
    );
  }

  if (reportType === "fund-holdings") {
    const fundAccountRecords = investmentAccountRecords.filter(
      (account) => account.investProductType === "fund" || account.investProductType === "money",
    );
    const fundScopedAccountIds = (() => {
      const scopes: Array<string[]> = [];
      if (selectedInvestmentAccountIds.length) scopes.push(selectedInvestmentAccountIds);
      // Fund-company selections filter report rows, not accounts; they are applied
      // by loadFundHoldingReport via `fundCompanies`.
      if (selectedRealInstitutionIds.length) {
        scopes.push(fundAccountRecords
          .filter((account) => selectedRealInstitutionIds.includes(account.institutionId ?? CASH_INSTITUTION_ID))
          .map((account) => account.id));
      }
      if (selectedUserIds.length) {
        scopes.push(fundAccountRecords
          .filter((account) => account.groupId && selectedUserIds.includes(account.groupId))
          .map((account) => account.id));
      }
      if (scopes.length === 0) return null;
      return fundAccountRecords.map((account) => account.id).filter((id) => scopes.every((ids) => ids.includes(id)));
    })();
    const fundReport = await loadCachedFundHoldingReport(
      JSON.stringify(ctx.hidFilter),
      JSON.stringify(fundScopedAccountIds ?? []),
      JSON.stringify(selectedFundCompanies),
    );
    const fundFilterUsers = commonData.groups
      .filter((group) => fundAccountRecords.some((account) => account.groupId === group.id))
      .map((group) => ({ id: group.id, name: group.name }));
    const fundFilterInstitutions = commonData.institutions
      .filter((institution) => fundAccountRecords.some((account) => account.institutionId === institution.id))
      .map((institution) => ({ id: institution.id, name: institution.name, type: institution.type ?? null }));
    const fundFilterAccounts = fundAccountRecords.map((account) => ({
      id: account.id,
      name: account.name,
      kind: account.kind,
      investProductType: account.investProductType,
      label: allAccountDisplayById.get(account.id)?.fullLabel ?? allAccountDisplayById.get(account.id)?.label ?? account.name,
      groupId: account.groupId,
      Institution: account.Institution ? { id: account.Institution.id, name: account.Institution.name } : null,
    }));
    // Shared across the fund-holdings filter controls so switching one filter
    // does not silently drop the others.
    const fundBaseParams: Record<string, string> = { report: "fund-holdings", fundGroup: fundGroupMode };
    for (const key of ["userIds", "institutionIds", "investmentAccounts"] as const) {
      const value = params[key];
      if (typeof value === "string" && value.trim()) fundBaseParams[key] = value.trim();
    }
    const fundExportHref = buildCsvDataUri([
      [
        t("reports.fund.code"),
        t("reports.fund.name"),
        t("reports.fund.account"),
        t("reports.fund.institution"),
        t("reports.fund.units"),
        t("reports.fund.avgCost"),
        t("reports.fund.nav"),
        t("reports.fund.cost"),
        t("reports.fund.marketValue"),
        t("reports.fund.floatingPnL"),
        t("reports.fund.floatingPnLRate"),
        t("reports.fund.realizedProfit"),
        t("reports.fund.totalProfit"),
      ],
      ...fundReport.rows.map((row) => [
        row.fundCode,
        row.fundName,
        row.accountName,
        row.institutionName,
        String(row.units),
        row.avgCost.toFixed(4),
        row.nav == null ? "" : row.nav.toFixed(4),
        row.cost.toFixed(2),
        row.marketValue.toFixed(2),
        row.floatingPnL.toFixed(2),
        (row.floatingPnLRate * 100).toFixed(2),
        row.historicalProfit.toFixed(2),
        row.totalProfit.toFixed(2),
      ]),
      [],
      [
        t("reports.fund.code"),
        t("reports.fund.name"),
        t("reports.fund.account"),
        t("reports.fund.institution"),
        t("reports.fund.firstBuy"),
        t("reports.fund.clearedDate"),
        t("reports.fund.totalInvested"),
        t("reports.fund.buyAmount"),
        t("reports.fund.redeemAmount"),
        t("reports.fund.realizedProfit"),
        t("reports.fund.returnRate"),
      ],
      ...fundReport.clearedRows.map((row) => [
        row.fundCode,
        row.fundName,
        row.accountName,
        row.institutionName,
        row.firstBuyDate,
        row.clearedDate,
        row.totalInvested.toFixed(2),
        row.totalBuyAmount.toFixed(2),
        row.totalRedeemAmount.toFixed(2),
        row.historicalProfit.toFixed(2),
        (row.returnRate * 100).toFixed(2),
      ]),
    ]);

    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="page-header">
          <div className="flex h-12 items-center justify-between px-4">
            <div className="text-sm page-title">{t("reports.menu.fundHoldings")}</div>
            <div className="flex items-center gap-2">
              <ReportSelector
                currentType="fund-holdings"
                items={reportMenuItems("fund-holdings", currentInvestmentHref, currentStockHref, currentFundHref, currentStatisticsHref, t)}
              />
            </div>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-hidden p-4 md:p-5">
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-1 pb-2">
              <FundGroupModeFilter
                groupMode={fundGroupMode}
                baseParams={fundBaseParams}
              />
              <InvestmentProfitFilterSelect
                selectedUserIds={selectedUserIds}
                selectedInstitutionIds={selectedInstitutionIds}
                selectedAccountIds={selectedInvestmentAccountIds}
                allUsers={fundFilterUsers}
                allInstitutions={fundFilterInstitutions}
                allAccounts={fundFilterAccounts}
                fundCompanies={fundReport.fundCompanies}
                clearedOnlyFundCompanies={fundReport.clearedOnlyFundCompanies}
                baseParams={fundBaseParams}
              />
              <a
                href={fundExportHref}
                download={`${t("reports.filename.fundHoldings")}.csv`}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-700"
                title={t("reports.exportFundTitle")}
              >
                <Download className="h-3.5 w-3.5" />
                {t("reports.export")}
              </a>
            </div>
            <FundHoldingReport
              rows={fundReport.rows}
              clearedRows={fundReport.clearedRows}
              totals={fundReport.totals}
              isRedUp={colorScheme === "red_up_green_down"}
              groupMode={fundGroupMode}
            />
          </div>
        </div>
      </div>
    );
  }

  const editCategories = commonData.categories.filter((category) =>
    category.type === "income" || category.type === "expense",
  );
  const editTags = commonData.tags;
  const editGroups = commonData.groups;
  const editInstitutions = commonData.institutions;
  const editCounterparties = commonData.counterparties;
  const expenseCategories = editCategories
    .filter((category) => category.type === "expense")
    .map((category) => ({
      id: category.id,
      label: category.name,
      parentId: category.parentId,
      type: category.type,
      sortOrder: category.sortOrder,
      isSystem: category.isSystem,
    }));
  const incomeCategories = editCategories
    .filter((category) => category.type === "income")
    .map((category) => ({
      id: category.id,
      label: category.name,
      parentId: category.parentId,
      type: category.type,
      sortOrder: category.sortOrder,
      isSystem: category.isSystem,
    }));
  const nestedFieldData = {
    groupId: editGroups.map((group) => ({ id: group.id, name: group.name })),
    institutionId: editInstitutions.map((institution) => ({ id: institution.id, name: institution.name, type: institution.type ?? "" })),
    counterpartyId: editCounterparties.map((counterparty) => ({
      id: counterparty.id,
      name: counterparty.shortName?.trim() || counterparty.name,
      type: counterparty.type,
    })),
  };

  const selectedAccount = accounts.find((account) => account.id === selectedAccountId) ?? null;
  // 可用年份无条件取自交易记录的实际年份范围：年份下拉在"年/月"两种粒度下
  // 都应展示全部历史年份。不能只在 groupBy==="year" 时才计算，否则 URL 无
  // groupBy 参数时 availableYears 落空，会被下方回退成 [currentYear]，
  // 年下拉只剩当年（例如只显示 2026），用户无法选择其他年份。
  const yearBounds = await prisma.txRecord.aggregate({
    where: {
      ...ctx.hidFilter,
      deletedAt: null,
      type: { in: [TransactionType.income, TransactionType.expense, TransactionType.investment] },
      ...(scopedIncomeAccountIds && scopedIncomeAccountIds.length
        ? { OR: [{ accountId: { in: scopedIncomeAccountIds } }, { toAccountId: { in: scopedIncomeAccountIds } }] }
        : {}),
    },
    _min: { date: true },
    _max: { date: true },
  });
  const firstYear = yearBounds._min.date?.getUTCFullYear() ?? now.getUTCFullYear();
  const lastYear = yearBounds._max.date?.getUTCFullYear() ?? firstYear;
  const availableYears = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index);
  if (groupBy === "year") {
    const selectedStartYear = Math.min(lastYear, Math.max(firstYear, parseYear(rawStartYear) ?? firstYear));
    const selectedEndYear = Math.min(lastYear, Math.max(firstYear, parseYear(rawEndYear) ?? lastYear));
    const rangeStartYear = Math.min(selectedStartYear, selectedEndYear);
    const rangeEndYear = Math.max(selectedStartYear, selectedEndYear);
    requestedStart = new Date(Date.UTC(rangeStartYear, 0, 1));
    requestedEnd = new Date(Date.UTC(rangeEndYear, 11, 31));
  }
  const report = await getIncomeExpenseReport(ctx, {
    start: formatDateUtc(requestedStart),
    end: formatDateUtc(requestedEnd),
    groupBy,
    accountIds: scopedIncomeAccountIds ?? undefined,
    detail: detailType
      ? {
          type: detailType,
          categoryKey: detailCategoryKey || undefined,
          columnKey: detailColumnKey || undefined,
        }
      : undefined,
  });

  const detailEntryIds = report.details
    ? [...new Set(report.details.rows.map((row) => row.entryId))]
    : [];
  const detailEntries = await loadReportDetailEntries(ctx, detailEntryIds);
  const investmentProductTypeByAccountId = Object.fromEntries(
    allAccountRecords.map((account) => [account.id, account.investProductType]),
  );

  const exportRows = [
    [t("reports.scope"), `${report.start} ~ ${report.end}`],
    [t("reports.account"), scopedIncomeAccountIds && scopedIncomeAccountIds.length
      ? scopedIncomeAccountIds.map((id) => accounts.find((account) => account.id === id)?.label ?? id).join(", ")
      : t("reports.allAccounts")],
    [t("reports.granularity"), report.groupBy === "year" ? t("reports.period.year") : t("reports.period.month")],
    [],
    [t("reports.type"), t("reports.category"), ...report.columns.map((column) => column.label), t("reports.total")],
    [t("reports.income"), t("reports.incomeTotal"), ...report.income.periodTotals.map((value) => value.toFixed(2)), report.income.total.toFixed(2)],
    ...report.income.rows.map((row) => rowCsv("income", row, t)),
    [t("reports.expense"), t("reports.expenseTotal"), ...report.expense.periodTotals.map((value) => value.toFixed(2)), report.expense.total.toFixed(2)],
    ...report.expense.rows.map((row) => rowCsv("expense", row, t)),
    [t("reports.net"), t("reports.net"), ...report.netPeriodTotals.map((value) => value.toFixed(2)), report.netTotal.toFixed(2)],
  ];
  const exportHref = buildCsvDataUri(exportRows);
  const exportFilename = `${t("reports.filename.incomeExpense")}-${report.start}-${report.end}${scopedIncomeAccountIds && scopedIncomeAccountIds.length ? `-${scopedIncomeAccountIds.length}accounts` : ""}.csv`;
  const currentReportQuery = {
    start: report.start,
    end: report.end,
    accountId: scopedIncomeAccountIds?.join(",") ?? "",
    groupBy: report.groupBy,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="page-header">
        <div className="flex h-12 items-center justify-between px-4">
          <div className="text-sm page-title">{t("reports.page.title")}</div>
          <div className="flex items-center gap-2">
            <ReportSelector
              currentType="income-expense"
              items={reportMenuItems(
                "income-expense",
                buildReportHref("investment-profit", "day", currentYear, currentMonth),
                buildReportHref("stock-holdings"),
                buildReportHref("fund-holdings"),
                buildStatisticsHref(),
                t,
              )}
            />
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden p-4 md:p-5">
        <div className="flex h-full min-h-0 flex-col gap-3">
          <StatisticsFilterPanel
            allAccounts={incomeFilterAccounts}
            allInstitutions={incomeFilterInstitutions}
            allUsers={incomeFilterUsers}
            year={currentYear}
            reportPath="/reports"
            accountParam="accountId"
            start={report.start}
            end={report.end}
            availableYears={availableYears.length > 0 ? availableYears : [currentYear]}
            exportHref={exportHref}
            exportFilename={exportFilename}
            baseParams={{ report: "income-expense" }}
            periodParam="groupBy"
          />

          <IncomeExpenseReportClient
            report={report}
            initialDetailEntries={detailEntries}
            currentReportQuery={currentReportQuery}
            colorScheme={colorScheme}
            accountId={scopedIncomeAccountIds?.join(",") ?? ""}
            accountOptions={accounts}
            categoryOptions={buildCategorySmartSelectOptions({
              categories: editCategories,
              types: ["expense", "income"],
              typeLabels: {
                expense: t("stats.expenseCategories"),
                income: t("categoryType.income"),
              },
              typeHeaderPrefix: "category-type",
              includeTypeHeaders: true,
              t,
            }).map((option) => ({ ...option, value: option.id }))}
            tagOptions={editTags.map((tag) => ({ value: tag.id, label: tag.name, color: tag.color }))}
            investmentProductTypeByAccountId={investmentProductTypeByAccountId}
          />
          <ReportTransactionEditHost
            accounts={accounts}
            accountSSOptions={accountSSOptions}
            cashAccounts={cashAccounts}
            investmentAccounts={investmentAccounts}
            cashAccountSSOptions={cashAccountSSOptions}
            investmentAccountSSOptions={investmentAccountSSOptions}
            expenseCategories={expenseCategories}
            incomeCategories={incomeCategories}
            tags={editTags}
            nestedFieldData={nestedFieldData}
          />
        </div>
      </div>
    </div>
  );
}
