import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { loadFundStatisticSourceEntries, loadWealthStatisticSourceEntries } from "@/lib/server/investment-statistic-sources";
import { TransactionType } from "@prisma/client";
import { toNumber } from "@/lib/date-utils";
import { isPureInvestmentAccount } from "@/lib/account-kind-utils";
import {
  normalizeDefaultCategoryHierarchyForHousehold,
  SYSTEM_INSURANCE_EXPENSE_CATEGORY,
  SYSTEM_INSURANCE_RETURN_CATEGORY,
} from "@/lib/default-categories";
import { addStatisticCategoryBucket, buildStatisticCategoryItemsFromBuckets, createStatisticCategoryResolver, getBusinessResultStatisticItems, getIncomeExpenseStatisticAmount, getInvestmentStatisticItems } from "@/lib/transaction-statistics";
import { isCreditCardRepaymentTransfer, isDebtPrincipalTransfer } from "@/lib/transaction-semantics";
import { buildStatisticsFundDisplayResolver } from "@/lib/server/statistics-fund-display";
import { buildStatisticsCurrencyConverter } from "@/lib/server/statistics-currency";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/statistics?year=YYYY&accounts=id1,id2&tags=id1,id2
 *
 * Yearly financial statistics for the authenticated household.
 * Mirrors the web `/statistics` page computation as a JSON API.
 *
 * Query params:
 *   year     – year to query (default: current year)
 *   accounts – comma-separated account IDs to filter (optional)
 *   tags     – comma-separated tag IDs to filter (optional)
 *
 * Expense totals preserve category offsets: a stored positive expense cash flow
 * is returned as a negative expense statistic instead of being made absolute.
 * Fund names are resolved from cached fund profiles/NAV metadata when legacy
 * transaction rows only stored a fund code.
 * Monetary statistics use the household baseCurrency and latest stored FX rates,
 * including historical periods. Missing-rate currencies are excluded and listed
 * in missingFxCurrencies. Original transaction amounts are never modified.
 *
 * Response 200:
 * {
 *   ok: true,
 *   data: {
 *     year: number,
 *     baseCurrency: string,
 *     missingFxCurrencies: string[],
 *     totalIncome: number,
 *     totalExpense: number,
 *     totalInvestPnL: number,
 *     totalNet: number,
 *     monthData: [{ month, income, expense, investPnL, netTotal, cumNet }],
 *     incomeCategories: [{ id, name, value, pct }],
 *     expenseCategories: [{ id, name, value, pct }],
 *     incomeTagGroups: [{ id, name, color, value, pct }],
 *     expenseTagGroups: [{ id, name, color, value, pct }],
 *     pnlList: [{ id, date, fundCode, fundName, subtype, amount, profit, profitRate }]
 *   }
 * }
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const { hidFilter, householdId } = ctx;

    const url = req.nextUrl;
    const now = new Date();
    const thisYear = now.getFullYear();
    const rawYear = url.searchParams.get("year");
    const selectedYear = rawYear ? parseInt(rawYear, 10) : thisYear;
    const year = Number.isFinite(selectedYear) && selectedYear >= 2000 && selectedYear <= 2100 ? selectedYear : thisYear;

    const rawAccounts = url.searchParams.get("accounts");
    const selectedAccountIds = rawAccounts?.trim()
      ? rawAccounts.split(",").map(s => s.trim()).filter(Boolean)
      : null;

    const rawTags = url.searchParams.get("tags");
    const selectedTagIds = rawTags?.trim()
      ? rawTags.split(",").map(s => s.trim()).filter(Boolean)
      : null;

    await normalizeDefaultCategoryHierarchyForHousehold(prisma, householdId);

    const [allAccounts, categories] = await Promise.all([
      prisma.account.findMany({
        where: { ...hidFilter, isActive: true },
        select: { id: true, name: true, kind: true },
        orderBy: { name: "asc" },
      }),
      prisma.category.findMany({
        where: { ...hidFilter, type: { in: ["income", "expense"] } },
        select: { id: true, name: true, type: true },
      }),
    ]);

    const nonInvestAccountIds = allAccounts.filter((a) => !isPureInvestmentAccount(a)).map(a => a.id);
    const accountKindById = new Map(allAccounts.map((account) => [account.id, account.kind]));

    const accountFilter = selectedAccountIds
      ? { OR: [{ accountId: { in: selectedAccountIds } }, { toAccountId: { in: selectedAccountIds } }] }
      : {};

    // Fetch all entries for the year
    const allEntries = await prisma.txRecord.findMany({
      where: {
        deletedAt: null,
        ...hidFilter,
        date: { gte: new Date(Date.UTC(year, 0, 1)), lt: new Date(Date.UTC(year + 1, 0, 1)) },
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
    const [fundStatisticEntries, wealthStatisticEntries] = await Promise.all([
      loadFundStatisticSourceEntries(ctx, {
        start: new Date(Date.UTC(year, 0, 1)),
        endExclusive: new Date(Date.UTC(year + 1, 0, 1)),
        accountIds: selectedAccountIds,
        tagIds: selectedTagIds,
      }),
      loadWealthStatisticSourceEntries(ctx, {
        start: new Date(Date.UTC(year, 0, 1)),
        endExclusive: new Date(Date.UTC(year + 1, 0, 1)),
        accountIds: selectedAccountIds,
        tagIds: selectedTagIds,
      }),
    ]);
    const independentStatisticEntryIds = new Set([
      ...fundStatisticEntries.flatMap((entry) => [entry.id, entry.entryId]),
      ...wealthStatisticEntries.flatMap((entry) => [entry.id, entry.entryId]),
    ]);
    // Tag filter
    const filteredEntries = selectedTagIds
      ? allEntries.filter(e => e.EntryTag.some(et => selectedTagIds.includes(et.tagId)))
      : allEntries;
    const fx = await buildStatisticsCurrencyConverter(ctx.householdId, [
      ...filteredEntries, ...fundStatisticEntries, ...wealthStatisticEntries,
    ]);
    const resolvePnlFundDisplay = await buildStatisticsFundDisplayResolver(
      [...filteredEntries, ...fundStatisticEntries, ...wealthStatisticEntries],
      householdId,
    );

    // Aggregation maps
    const monthMap = new Map<string, { income: number; expense: number; investPnL: number }>();
    const incomeByCat = new Map<string, { id: string | null; name: string; type: "income"; value: number }>();
    const expenseByCat = new Map<string, { id: string | null; name: string; type: "expense"; value: number }>();
    const incomeByTag = new Map<string, { id: string; name: string; color: string; value: number }>();
    const expenseByTag = new Map<string, { id: string; name: string; color: string; value: number }>();
    const pnlItems: { id: string; date: string; fundCode: string; fundName: string; subtype: string; amount: number; profit: number; profitRate: number }[] = [];

    const scopeAccountIds = selectedAccountIds ?? nonInvestAccountIds;
    const resolveCategory = createStatisticCategoryResolver(categories);

    for (const e of filteredEntries) {
      const d = e.date;
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      if (!monthMap.has(m)) monthMap.set(m, { income: 0, expense: 0, investPnL: 0 });
      const row = monthMap.get(m)!;
      const amount = fx.convert(e, toNumber(e.amount));
      if (amount == null) continue;

      const isToSelf = e.toAccountId && scopeAccountIds.includes(e.toAccountId);
      const isFromSelf = e.accountId && scopeAccountIds.includes(e.accountId);

      if (e.type === TransactionType.income) {
        const effectiveAmount = getIncomeExpenseStatisticAmount(e.type, amount);
        row.income += effectiveAmount;
        addStatisticCategoryBucket(incomeByCat, resolveCategory({ type: "income", categoryId: e.categoryId, categoryName: e.categoryName }), effectiveAmount);
        for (const et of e.EntryTag) {
          const existing = incomeByTag.get(et.tagId);
          incomeByTag.set(et.tagId, { id: et.Tag.id, name: et.Tag.name, color: et.Tag.color ?? "#3B82F6", value: (existing?.value ?? 0) + effectiveAmount });
        }
      } else if (e.type === TransactionType.expense) {
        const effectiveAmount = getIncomeExpenseStatisticAmount(e.type, amount);
        row.expense += effectiveAmount;
        addStatisticCategoryBucket(expenseByCat, resolveCategory({ type: "expense", categoryId: e.categoryId, categoryName: e.categoryName }), effectiveAmount);
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
        for (const item of fx.convertItems(e, getBusinessResultStatisticItems(e))) {
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
        if (independentStatisticEntryIds.has(e.id)) continue;
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
        for (const item of fx.convertItems(e, getInvestmentStatisticItems(e))) {
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
          const fundDisplay = resolvePnlFundDisplay(e);
          pnlItems.push({
            id: e.id, date: d.toISOString().slice(0, 10), fundCode: fundDisplay.fundCode, fundName: fundDisplay.fundName,
            subtype: item.label, amount: item.amount, profit: signedProfit, profitRate: rate,
          });
        }
      }
    }

    for (const e of fundStatisticEntries) {
      const d = e.date;
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      if (!monthMap.has(m)) monthMap.set(m, { income: 0, expense: 0, investPnL: 0 });
      const row = monthMap.get(m)!;
      const amount = fx.convert(e, toNumber(e.amount));
      if (amount == null) continue;

      for (const item of fx.convertItems(e, getInvestmentStatisticItems(e))) {
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
        const fundDisplay = resolvePnlFundDisplay(e);
        pnlItems.push({
          id: e.id,
          date: d.toISOString().slice(0, 10),
          fundCode: fundDisplay.fundCode,
          fundName: fundDisplay.fundName,
          subtype: item.label,
          amount: item.amount,
          profit: signedProfit,
          profitRate: rate,
        });
      }
    }

    for (const e of wealthStatisticEntries) {
      const d = e.date;
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      if (!monthMap.has(m)) monthMap.set(m, { income: 0, expense: 0, investPnL: 0 });
      const row = monthMap.get(m)!;
      const amount = fx.convert(e, toNumber(e.amount));
      if (amount == null) continue;

      for (const item of fx.convertItems(e, getInvestmentStatisticItems(e))) {
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
        const fundDisplay = resolvePnlFundDisplay(e);
        pnlItems.push({
          id: e.id,
          date: d.toISOString().slice(0, 10),
          fundCode: fundDisplay.fundCode,
          fundName: fundDisplay.fundName,
          subtype: item.label,
          amount: item.amount,
          profit: signedProfit,
          profitRate: rate,
        });
      }
    }

    // Build month data with cumulative net
    const monthData: { month: string; income: number; expense: number; investPnL: number; netTotal: number; cumNet: number }[] = [];
    let cumNet = 0;
    for (let i = 1; i <= 12; i++) {
      const m = String(i).padStart(2, "0");
      const row = monthMap.get(m);
      if (!row) continue;
      const netTotal = row.income - row.expense + row.investPnL;
      cumNet += netTotal;
      monthData.push({ month: m, income: row.income, expense: row.expense, investPnL: row.investPnL, netTotal, cumNet });
    }

    // Totals
    const totalIncome = monthData.reduce((s, m) => s + m.income, 0);
    const totalExpense = monthData.reduce((s, m) => s + m.expense, 0);
    const totalInvestPnL = monthData.reduce((s, m) => s + m.investPnL, 0);
    const totalNet = totalIncome - totalExpense + totalInvestPnL;

    // Category breakdown (top 8)
    const incomeCategories = buildStatisticCategoryItemsFromBuckets(incomeByCat, totalIncome);
    const expenseCategories = buildStatisticCategoryItemsFromBuckets(expenseByCat, totalExpense);

    // Tag breakdown (top 8)
    const incomeTagGroups = Array.from(incomeByTag.values())
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
      .map(t => ({ ...t, pct: totalIncome > 0 ? (t.value / totalIncome) * 100 : 0 }));

    const expenseTagGroups = Array.from(expenseByTag.values())
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
      .map(t => ({ ...t, pct: totalExpense > 0 ? (t.value / totalExpense) * 100 : 0 }));

    // PnL list sorted by date descending
    pnlItems.sort((a, b) => b.date.localeCompare(a.date));

    return NextResponse.json({
      ok: true,
      data: {
        year,
        baseCurrency: fx.baseCurrency,
        missingFxCurrencies: fx.missingFxCurrencies,
        totalIncome,
        totalExpense,
        totalInvestPnL,
        totalNet,
        monthData,
        incomeCategories,
        expenseCategories,
        incomeTagGroups,
        expenseTagGroups,
        pnlList: pnlItems,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch statistics data";
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: message }, { status: 500 });
  }
}
