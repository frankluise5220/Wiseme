import { prisma } from "@/lib/db/prisma";
import { cookies } from "next/headers";
import { TransactionType } from "@prisma/client";
import { computeInvestBalances } from "@/lib/invest-balance";
import { toNumber } from "@/lib/date-utils";
import { Suspense } from "react";
import { ReportSelector } from "@/components/ReportSelector";
import type { ReportItem } from "@/components/ReportSelector";
import StatisticsCharts from "@/components/StatisticsCharts";
import { StatisticsFilterPanel } from "@/components/StatisticsFilterPanel";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadWealthStatisticSourceEntries } from "@/lib/server/investment-statistic-sources";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import {
  normalizeDefaultCategoryHierarchyForHousehold,
  SYSTEM_INSURANCE_EXPENSE_CATEGORY,
  SYSTEM_INSURANCE_RETURN_CATEGORY,
} from "@/lib/default-categories";
import { addStatisticCategoryBucket, buildStatisticCategoryItemsFromBuckets, createStatisticCategoryResolver, getBusinessResultStatisticItems, getIncomeExpenseStatisticAmount, getInvestmentStatisticItems } from "@/lib/transaction-statistics";
import { isCreditCardRepaymentTransfer, isDebtPrincipalTransfer } from "@/lib/transaction-semantics";
import { getServerT } from "@/lib/server/i18n";
import { categoryOrderBy } from "@/lib/category-order";

export const dynamic = "force-dynamic";

type MonthData = {
  month: string;
  income: number;
  expense: number;
  investPnL: number;
  netTotal: number;
  cumNet: number;
};

type CategoryItem = { id: string | null; name: string; value: number; pct: number };
type TagGroupData = { id: string; name: string; color: string; value: number; pct: number };

type PnLItem = {
  id: string;
  date: string;
  fundCode: string;
  fundName: string;
  subtype: string;
  amount: number;
  profit: number;
  profitRate: number;
};

function buildStatisticsReportHref(year: number) {
  const query = new URLSearchParams();
  query.set("year", String(year));
  return `/statistics?${query.toString()}`;
}

function buildStatisticsReportMenuItems(year: number, t: (key: string) => string): ReportItem[] {
  const investmentQuery = new URLSearchParams();
  investmentQuery.set("report", "investment-profit");
  investmentQuery.set("profitPeriod", "day");
  investmentQuery.set("profitYear", String(year));

  const stockQuery = new URLSearchParams();
  stockQuery.set("report", "stock-holdings");

  const fundQuery = new URLSearchParams();
  fundQuery.set("report", "fund-holdings");

  return [
    { value: "income-expense", label: t("reports.menu.incomeExpense"), href: "/reports" },
    { value: "investment-profit", label: t("reports.menu.investmentProfit"), href: `/reports?${investmentQuery.toString()}` },
    { value: "stock-holdings", label: t("reports.menu.stockHoldings"), href: `/reports?${stockQuery.toString()}` },
    { value: "fund-holdings", label: t("reports.menu.fundHoldings"), href: `/reports?${fundQuery.toString()}` },
    { value: "cash-statistics", label: t("reports.menu.cashStatisticsCharts"), href: buildStatisticsReportHref(year) },
  ];
}

export default async function StatisticsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const t = await getServerT();
  const ctx = await getHouseholdScope();
  const { hidFilter } = ctx;
  const cookieStore = await cookies();
  const colorScheme = cookieStore.get("colorScheme")?.value ?? "red_up_green_down";
  const isRedUp = colorScheme === "red_up_green_down";

  const now = new Date();
  const thisYear = now.getFullYear();
  const selectedYear = typeof params?.year === "string" ? parseInt(params.year, 10) : thisYear;
  const year = Number.isFinite(selectedYear) && selectedYear >= 2000 && selectedYear <= 2100 ? selectedYear : thisYear;
  const level = params?.level === "month" ? "month" : "year";
  const selectedMonth = typeof params?.month === "string" ? parseInt(params.month, 10) : 1;
  const month = Number.isFinite(selectedMonth) && selectedMonth >= 1 && selectedMonth <= 12 ? selectedMonth : 1;

  const selectedAccountIds = typeof params?.accounts === "string" && params.accounts.trim()
    ? params.accounts.split(",").map(s => s.trim()).filter(Boolean)
    : null;
  const selectedInstitutionIds = typeof params?.institutionIds === "string" && params.institutionIds.trim() ? params.institutionIds.split(",").filter(Boolean) : typeof params?.institutionId === "string" && params.institutionId.trim() ? [params.institutionId] : null;
  const selectedUserIds = typeof params?.userIds === "string" && params.userIds.trim()
    ? params.userIds.split(",").map((id) => id.trim()).filter(Boolean)
    : typeof params?.userId === "string" && params.userId.trim() ? [params.userId] : null;

  const selectedTagIds = typeof params?.tags === "string" && params.tags.trim()
    ? params.tags.split(",").map(s => s.trim()).filter(Boolean)
    : null;

  await normalizeDefaultCategoryHierarchyForHousehold(prisma, ctx.householdId);

  const [allAccounts, categories, allInstitutions, allUsers] = await Promise.all([
    prisma.account.findMany({
      where: { ...hidFilter, isActive: true, counterpartyId: null, kind: { not: "insurance" } },
      select: { id: true, name: true, kind: true, userId: true, groupId: true, counterpartyId: true, numberMasked: true, Institution: { select: { id: true, name: true, type: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.category.findMany({
      where: { ...hidFilter, type: { in: ["income", "expense"] } },
      select: { id: true, name: true, type: true },
      orderBy: categoryOrderBy(),
    }),
    prisma.institution.findMany({ where: { householdId: ctx.householdId, Account: { some: { ...hidFilter, isActive: true, counterpartyId: null, kind: { not: "insurance" } } } }, select: { id: true, name: true, type: true }, orderBy: { name: "asc" } }),
    prisma.accountGroup.findMany({ where: { householdId: ctx.householdId, Account: { some: { ...hidFilter, isActive: true, counterpartyId: null, kind: { not: "insurance" } } } }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const nonInvestAccountIds = allAccounts.filter((a) => !isPureInvestmentAccount(a)).map(a => a.id);
  const accountKindById = new Map(allAccounts.map((account) => [account.id, account.kind]));

  const institutionAccountIds = selectedInstitutionIds
    ? allAccounts.filter((account) => selectedInstitutionIds.includes(account.Institution?.id ?? "")).map((account) => account.id)
    : null;
  const userAccountIds = selectedUserIds
    ? allAccounts.filter((account) => account.groupId && selectedUserIds.includes(account.groupId)).map((account) => account.id)
    : null;
  const accountScopes = [selectedAccountIds, institutionAccountIds, userAccountIds].filter((ids): ids is string[] => Boolean(ids));
  const scopedAccountIds = accountScopes.length > 0
    ? allAccounts.map((account) => account.id).filter((id) => accountScopes.every((ids) => ids.includes(id)))
    : null;
  const accountFilter = scopedAccountIds
    ? { OR: [{ accountId: { in: scopedAccountIds } }, { toAccountId: { in: scopedAccountIds } }] }
      : {};

  const periodStart = level === "month" ? new Date(Date.UTC(year, month - 1, 1)) : new Date(Date.UTC(year, 0, 1));
  const periodEnd = level === "month" ? new Date(Date.UTC(year, month, 1)) : new Date(Date.UTC(year + 1, 0, 1));
  const scopeAccountIds = scopedAccountIds ?? nonInvestAccountIds;

  // Fetch transactions for the selected period (with EntryTag)
  const allEntries = await prisma.txRecord.findMany({
    where: {
      deletedAt: null,
      ...hidFilter,
      date: { gte: periodStart, lt: periodEnd },
      ...accountFilter,
    },
    select: {
      id: true,
      date: true,
      type: true,
      amount: true,
      source: true,
      insuranceAction: true,
      fundSubtype: true,
      fundProductType: true,
      fundCode: true,
      fundName: true,
      realizedProfit: true,
      debtInterestAmount: true,
      depositInterest: true,
      fundFee: true,
      fundUnits: true,
      fundNav: true,
      categoryId: true,
      categoryName: true,
      accountId: true,
      toAccountId: true,
      EntryTag: { select: { tagId: true, Tag: { select: { id: true, name: true, color: true } } } },
    },
    orderBy: { date: "asc" },
  });
  const representedInvestmentEntryIds = new Set(
    allEntries
      .filter((entry) => entry.type === TransactionType.investment && getInvestmentStatisticItems(entry).length > 0)
      .map((entry) => entry.id),
  );
  const wealthStatisticEntries = await loadWealthStatisticSourceEntries(ctx, {
    start: periodStart,
    endExclusive: periodEnd,
    accountIds: scopedAccountIds,
    tagIds: selectedTagIds,
    excludeEntryIds: representedInvestmentEntryIds,
  });

  // ── Tag filter ──
  const filteredEntries = selectedTagIds
    ? allEntries.filter(e => e.EntryTag.some(et => selectedTagIds.includes(et.tagId)))
    : allEntries;

  // ── Monthly aggregation ──
  const monthMap = new Map<string, { income: number; expense: number; investPnL: number; investCost: number }>();
  const incomeByCat = new Map<string, { id: string | null; name: string; type: "income"; value: number }>();
  const expenseByCat = new Map<string, { id: string | null; name: string; type: "expense"; value: number }>();
  const incomeByTag = new Map<string, { id: string; name: string; color: string; value: number }>();
  const expenseByTag = new Map<string, { id: string; name: string; color: string; value: number }>();
  const pnlItems: PnLItem[] = [];

  const resolveCategory = createStatisticCategoryResolver(categories);

  for (const e of filteredEntries) {
    const d = e.date;
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    if (!monthMap.has(m)) monthMap.set(m, { income: 0, expense: 0, investPnL: 0, investCost: 0 });
    const row = monthMap.get(m)!;
    const amount = toNumber(e.amount);

    const isToSelf = e.toAccountId && scopeAccountIds.includes(e.toAccountId);
    const isFromSelf = e.accountId && scopeAccountIds.includes(e.accountId);

    if (e.type === TransactionType.income) {
      const effectiveAmount = getIncomeExpenseStatisticAmount(e.type, amount);
      row.income += effectiveAmount;
      addStatisticCategoryBucket(incomeByCat, resolveCategory({ type: "income", categoryId: e.categoryId, categoryName: e.categoryName }), effectiveAmount);
      // Tag aggregation
      for (const et of e.EntryTag) {
        const existing = incomeByTag.get(et.tagId);
        incomeByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + effectiveAmount });
      }
    } else if (e.type === TransactionType.expense) {
      const effectiveAmount = getIncomeExpenseStatisticAmount(e.type, amount);
      row.expense += effectiveAmount;
      addStatisticCategoryBucket(expenseByCat, resolveCategory({ type: "expense", categoryId: e.categoryId, categoryName: e.categoryName }), effectiveAmount);
      // Tag aggregation
      for (const et of e.EntryTag) {
        const existing = expenseByTag.get(et.tagId);
        expenseByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + effectiveAmount });
      }
      } else if (e.type === TransactionType.transfer) {
        if (isCreditCardRepaymentTransfer({
          type: e.type,
          accountKind: accountKindById.get(e.accountId),
          toAccountKind: accountKindById.get(e.toAccountId ?? ""),
      })) continue;
      // Borrow / lend / repay / collect / scheduled repayments: the principal
      // itself is a balance-sheet move, not income/expense.  Skip the principal
      // here; the interest portion is still reported via
      // getBusinessResultStatisticItems below.
      const isDebtPrincipal = isDebtPrincipalTransfer(e);
      if (isToSelf && !isFromSelf) {
        if (!isDebtPrincipal) {
          row.income += Math.abs(amount);
          addStatisticCategoryBucket(incomeByCat, resolveCategory({ type: "income", categoryId: e.categoryId, categoryName: e.categoryName }), Math.abs(amount));
          for (const et of e.EntryTag) {
            const existing = incomeByTag.get(et.tagId);
            incomeByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + Math.abs(amount) });
          }
        }
      } else if (isFromSelf && !isToSelf) {
        if (!isDebtPrincipal) {
          row.expense += Math.abs(amount);
          addStatisticCategoryBucket(expenseByCat, resolveCategory({ type: "expense", categoryId: e.categoryId, categoryName: e.categoryName }), Math.abs(amount));
          for (const et of e.EntryTag) {
            const existing = expenseByTag.get(et.tagId);
            expenseByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + Math.abs(amount) });
          }
        }
      }
        for (const item of getBusinessResultStatisticItems(e)) {
          if (item.type === "income") {
            row.income += item.amount;
            addStatisticCategoryBucket(incomeByCat, resolveCategory({ type: "income", candidates: item.categoryCandidates, fallbackName: item.categoryName }), item.amount);
            for (const et of e.EntryTag) {
              const existing = incomeByTag.get(et.tagId);
              incomeByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + item.amount });
            }
          } else {
            row.expense += item.amount;
            addStatisticCategoryBucket(expenseByCat, resolveCategory({ type: "expense", candidates: item.categoryCandidates, fallbackName: item.categoryName }), item.amount);
            for (const et of e.EntryTag) {
              const existing = expenseByTag.get(et.tagId);
              expenseByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + item.amount });
            }
          }
        }
      } else if (e.type === TransactionType.investment) {
      if (e.source === "insurance") {
        const effectiveAmount = Math.abs(amount);
        const isRefund = e.insuranceAction === "refund" || e.fundSubtype === "redeem" || e.fundSubtype === "switch_out";
        if (isRefund) {
          row.income += effectiveAmount;
          addStatisticCategoryBucket(incomeByCat, resolveCategory({ type: "income", fallbackName: SYSTEM_INSURANCE_RETURN_CATEGORY }), effectiveAmount);
          for (const et of e.EntryTag) {
            const existing = incomeByTag.get(et.tagId);
            incomeByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + effectiveAmount });
          }
        } else {
          row.expense += effectiveAmount;
          addStatisticCategoryBucket(expenseByCat, resolveCategory({ type: "expense", fallbackName: SYSTEM_INSURANCE_EXPENSE_CATEGORY }), effectiveAmount);
          for (const et of e.EntryTag) {
            const existing = expenseByTag.get(et.tagId);
            expenseByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + effectiveAmount });
          }
        }
        continue;
      }
      for (const item of getInvestmentStatisticItems(e)) {
        const signedProfit = item.type === "income" ? item.amount : -item.amount;
        if (item.type === "income") {
          addStatisticCategoryBucket(incomeByCat, resolveCategory({ type: "income", candidates: item.categoryCandidates, fallbackName: item.categoryName }), item.amount);
        } else {
          addStatisticCategoryBucket(expenseByCat, resolveCategory({ type: "expense", candidates: item.categoryCandidates, fallbackName: item.categoryName }), item.amount);
        }
        if (item.productKind === "deposit") continue;
        row.investPnL += signedProfit;
        const costBase = Math.abs(amount);
        const rate = costBase > 0 ? signedProfit / costBase : 0;
        pnlItems.push({
          id: e.id, date: d.toISOString().slice(0, 10), fundCode: e.fundCode ?? "", fundName: e.fundName ?? "",
          subtype: item.label, amount: item.amount, profit: signedProfit, profitRate: rate,
        });
      }
    }
  }

  for (const e of wealthStatisticEntries) {
    const d = e.date;
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    if (!monthMap.has(m)) monthMap.set(m, { income: 0, expense: 0, investPnL: 0, investCost: 0 });
    const row = monthMap.get(m)!;
    const amount = toNumber(e.amount);

    for (const item of getInvestmentStatisticItems(e)) {
      const signedProfit = item.type === "income" ? item.amount : -item.amount;
      if (item.type === "income") {
        addStatisticCategoryBucket(incomeByCat, resolveCategory({ type: "income", candidates: item.categoryCandidates, fallbackName: item.categoryName }), item.amount);
      } else {
        addStatisticCategoryBucket(expenseByCat, resolveCategory({ type: "expense", candidates: item.categoryCandidates, fallbackName: item.categoryName }), item.amount);
      }
      if (item.productKind === "deposit") continue;
      row.investPnL += signedProfit;
      const costBase = Math.abs(amount);
      const rate = costBase > 0 ? signedProfit / costBase : 0;
      pnlItems.push({
        id: e.id,
        date: d.toISOString().slice(0, 10),
        fundCode: e.fundCode ?? "",
        fundName: e.fundName ?? "",
        subtype: item.label,
        amount: item.amount,
        profit: signedProfit,
        profitRate: rate,
      });
    }
  }

  // ── Build month + cumulative data ──
  const monthData: MonthData[] = [];
  let cumNet = 0;
  for (let i = 1; i <= 12; i++) {
    const m = String(i).padStart(2, "0");
    const row = monthMap.get(m);
    if (!row) continue;
    const netTotal = row.income - row.expense + row.investPnL;
    cumNet += netTotal;
    monthData.push({ month: m, income: row.income, expense: row.expense, investPnL: row.investPnL, netTotal, cumNet });
  }

  // ── Category pie data ──
  const totalIncome = Array.from(incomeByCat.values()).reduce((sum, bucket) => sum + bucket.value, 0);
  const totalExpense = Array.from(expenseByCat.values()).reduce((sum, bucket) => sum + bucket.value, 0);
  const incomeCats: CategoryItem[] = buildStatisticCategoryItemsFromBuckets(incomeByCat, totalIncome);
  const expenseCats: CategoryItem[] = buildStatisticCategoryItemsFromBuckets(expenseByCat, totalExpense);

  // ── Tag group data ──
  const incomeTagGroups: TagGroupData[] = Array.from(incomeByTag.values())
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)
    .map(t => ({ ...t, pct: totalIncome > 0 ? (t.value / totalIncome) * 100 : 0 }));
  const expenseTagGroups: TagGroupData[] = Array.from(expenseByTag.values())
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)
    .map(t => ({ ...t, pct: totalExpense > 0 ? (t.value / totalExpense) * 100 : 0 }));

  // ── Investment floating P&L ──
  const investAccountIds = allAccounts.filter(isPureInvestmentAccount).map(a => a.id);
  const selectedInvestIds = selectedAccountIds
    ? selectedAccountIds.filter(id => investAccountIds.includes(id))
    : investAccountIds;
  const investBalances = selectedInvestIds.length > 0 ? await computeInvestBalances(ctx) : new Map();
  let totalFloatingPnL = 0;
  for (const [id, detail] of investBalances) {
    if (selectedInvestIds.includes(id)) totalFloatingPnL += detail.floatingPnL;
  }

  // ── P&L list sorted by date descending ──
  pnlItems.sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <header className="page-header flex items-center justify-between gap-3 px-6 py-3">
        <h1 className="text-lg page-title">{t("statistics.title")}</h1>
        <ReportSelector
          currentType="cash-statistics"
          items={buildStatisticsReportMenuItems(year, t)}
        />
      </header>

      <div className="shrink-0 px-6 pt-3">
        <div className="flex min-h-10 items-center overflow-visible border-b border-slate-200 bg-white px-1">
          <Suspense fallback={<div className="text-xs text-slate-400">{t("statistics.loadingFilter")}</div>}>
            <StatisticsFilterPanel
              allAccounts={allAccounts}
              allInstitutions={allInstitutions}
              allUsers={allUsers}
              year={year}
            />
          </Suspense>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-6">
        <StatisticsCharts
          monthData={monthData}
          incomeCats={incomeCats}
          expenseCats={expenseCats}
          incomeTagGroups={incomeTagGroups}
          expenseTagGroups={expenseTagGroups}
          pnlList={pnlItems}
          isRedUp={isRedUp}
        />
        {totalFloatingPnL !== 0 && (
          <div className="mt-3 text-xs text-slate-500 text-right">
            {t("statistics.floatingPnlNote", { amount: `${totalFloatingPnL >= 0 ? "+" : ""}${totalFloatingPnL.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}` })}
          </div>
        )}
      </div>
    </div>
  );
}
