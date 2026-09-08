import { prisma } from "@/lib/db/prisma";
import { AccountKind, TransactionType } from "@prisma/client";
import { computeInvestBalances } from "@/lib/invest-balance";
import { InvestHeaderSync } from "@/components/InvestHeaderSync";
import { buildAccountDisplayOption, normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { toNumber } from "@/lib/date-utils";
import { formatMoneyYuan, formatPercent } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { getInvestmentAccountView } from "@/lib/account-kind-utils";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { ACCOUNT_LABEL_FIELDS_COOKIE, accountLabelFieldsFromCookieValue } from "@/lib/server/account-label-fields";
import { getServerT } from "@/lib/server/i18n";
import { getInvestmentStatisticItems } from "@/lib/transaction-statistics";
import { cookies } from "next/headers";
import Link from "next/link";
import StatisticsCharts from "@/components/StatisticsCharts";
import FundPortfolioTrendChart from "@/components/FundPortfolioTrendChart";
import { DailyPnlCalendar } from "@/components/DailyPnlCalendar";
import { InvestAccountSummaryTable, type InvestAccountSummaryRow } from "@/components/InvestAccountSummaryTable";
import { loadFundPortfolioTrendData } from "@/lib/server/fund-portfolio-trend";

export const dynamic = "force-dynamic";

const fmt = formatMoneyYuan;

const fmtRate = (n: number) => formatPercent(n);

const investProductTypeLabel = (type: string | null, t: (key: string) => string) => {
  if (type === "fund") return t("investment.product.fund");
  if (type === "money") return t("investment.product.money");
  if (type === "wealth") return t("investment.product.wealth");
  if (type === "metal") return t("investment.product.metal");
  if (type === "stock") return t("investment.product.stock");
  return t("invest.productTypeDefault");
};

  export default async function InvestPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const t = await getServerT();
  const tab = typeof params?.tab === "string" ? params.tab : "overview";
  const filter = typeof params?.filter === "string" ? params.filter : "all"; // holding | cleared | all
  const pageParam = typeof params?.page === "string" ? parseInt(params.page, 10) : 1;
  const pageSizeParam = typeof params?.pageSize === "string" ? parseInt(params.pageSize, 10) : 10;
  const pageSize = [10, 20, 40].includes(pageSizeParam) ? pageSizeParam : 10;
  const cookieStore = await cookies();
  const accountLabelFields = accountLabelFieldsFromCookieValue(cookieStore.get(ACCOUNT_LABEL_FIELDS_COOKIE)?.value);
  const colorScheme = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") as "red_up_green_down" | "green_up_red_down";
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_label_template")?.value,
    creditCardLabelMode,
  );
  const isRedUp = colorScheme === "red_up_green_down";
  const pnlClass = (n: number) => pnlClassFromRedUp(n, isRedUp);
  const ctx = await getHouseholdScope();
  const { hidFilter } = ctx;

  const accounts = await prisma.account.findMany({
    where: { kind: AccountKind.investment, isActive: true, ...hidFilter },
    include: { AccountGroup: true, Institution: true },
    orderBy: [{ name: "asc" }],
  });

  if (accounts.length === 0) {
    return (
      <div className="flex-1 flex flex-col min-w-0">
        <header className="page-header">
          <div className="h-12 flex items-center px-4">
            <div className="text-sm page-title">{t("invest.overview")}</div>
          </div>
        </header>
        <div className="flex-1 flex items-center justify-center text-sm text-slate-500">
          {t("invest.noAccounts")}
        </div>
      </div>
    );
  }

  const accountIds = accounts.map((a) => a.id);

  const [allEntries, investBalByAccountId] = await Promise.all([
    prisma.txRecord.findMany({
      where: {
        OR: [
          { accountId: { in: accountIds } },
          { toAccountId: { in: accountIds } },
        ],
        deletedAt: null,
        type: TransactionType.investment,
      },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      take: 10000,
    }),
    computeInvestBalances(ctx),
  ]);

  // Earnings statistics: monthly aggregates
  const earningsData = (() => {
    type MonthRow = { income: number; expense: number; investPnL: number };
    const monthMap = new Map<string, MonthRow>();
    const incomeByCat = new Map<string, number>();
    const expenseByCat = new Map<string, number>();
    const profitItems: Array<{ id: string; date: string; fundCode: string; fundName: string; subtype: string; amount: number; profit: number; profitRate: number }> = [];

    for (const e of allEntries) {
      const d = e.date;
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      if (!monthMap.has(m)) monthMap.set(m, { income: 0, expense: 0, investPnL: 0 });
      const row = monthMap.get(m)!;
      const amt = toNumber(e.amount);

      for (const item of getInvestmentStatisticItems(e)) {
        const signedProfit = item.type === "income" ? item.amount : -item.amount;
        if (item.type === "income") {
          incomeByCat.set(item.categoryName, (incomeByCat.get(item.categoryName) ?? 0) + item.amount);
        } else {
          expenseByCat.set(item.categoryName, (expenseByCat.get(item.categoryName) ?? 0) + item.amount);
        }
        if (item.productKind === "deposit") continue;
        row.investPnL += signedProfit;
        const costBase = Math.abs(amt);
        profitItems.push({
          id: e.id,
          date: d.toISOString().slice(0, 10),
          fundCode: e.fundCode ?? "",
          fundName: e.fundName ?? "",
          subtype: item.label,
          amount: item.amount,
          profit: signedProfit,
          profitRate: costBase > 0 ? signedProfit / costBase : 0,
        });
      }
    }

    const monthData: Array<{ month: string; income: number; expense: number; investPnL: number; netTotal: number; cumNet: number }> = [];
    let cumNet = 0;
    for (let i = 1; i <= 12; i++) {
      const m = String(i).padStart(2, "0");
      const row = monthMap.get(m);
      if (!row) continue;
      const netTotal = row.income - row.expense + row.investPnL;
      cumNet += netTotal;
      monthData.push({ month: m, income: row.income, expense: row.expense, investPnL: row.investPnL, netTotal, cumNet });
    }

    const totalInc = monthData.reduce((s,m)=>s+m.income,0);
    const totalExp = monthData.reduce((s,m)=>s+m.expense,0);
    const incCats = Array.from(incomeByCat.entries()).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([n,v])=>({name:n,value:v,pct:totalInc>0?(v/totalInc)*100:0}));
    const expCats = Array.from(expenseByCat.entries()).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([n,v])=>({name:n,value:v,pct:totalExp>0?(v/totalExp)*100:0}));
    profitItems.sort((a,b) => b.date.localeCompare(a.date));

    return { monthData, incCats, expCats, profitItems };
  })();

  type AccountRow = InvestAccountSummaryRow;

  const accountRows: AccountRow[] = accounts.map((a) => {
    const entries = allEntries.filter((e) => e.accountId === a.id || e.toAccountId === a.id);
    const investDetail = investBalByAccountId.get(a.id);

    let totalBuy = 0;
    let totalSell = 0;
    let totalDividend = 0;
    let totalFee = 0;
    let buyCount = 0;
    let sellCount = 0;

    for (const e of entries) {
      const amt = toNumber(e.amount);
      const fee = toNumber(e.fundFee);
      const subtype = e.fundSubtype;
      const isDividend = e.source === "dividend" || subtype === "dividend_cash";
      totalFee += fee;
      if (amt < 0) {
        totalBuy += Math.abs(amt) - fee;
        buyCount++;
      } else if (isDividend) {
        totalDividend += amt;
      } else if (amt > 0) {
        totalSell += amt - fee;
        sellCount++;
      }
    }

    const marketValue = investDetail?.marketValue ?? 0;
    const totalCost = investDetail?.totalCost ?? 0;
    const floatingPnL = investDetail?.floatingPnL ?? 0;
    const floatingPnLRate = totalCost > 0 ? floatingPnL / totalCost : 0;
    const realizedPnL = totalSell + totalDividend - (totalBuy - totalCost);
    const totalReturn = floatingPnL + realizedPnL;
    const totalReturnRate = totalBuy > 0 ? totalReturn / totalBuy : 0;

    const display = buildAccountDisplayOption({
      id: a.id,
      name: a.name,
      kind: a.kind,
      numberMasked: a.numberMasked,
      groupId: a.groupId,
      investProductType: a.investProductType,
      Institution: a.Institution,
      AccountGroup: a.AccountGroup,
    }, creditCardLabelTemplate, { fields: accountLabelFields });
    const label = display.label;
    const groupName = a.AccountGroup?.name?.trim() || t("invest.noOwner");
    const productTypeLabel = investProductTypeLabel(a.investProductType, t);

    return {
      id: a.id,
      label,
      hoverTitle: display.hoverTitle,
      groupName,
      investProductType: a.investProductType,
      productTypeLabel,
      balance: toNumber(a.balance),
      marketValue,
      totalCost,
      floatingPnL,
      floatingPnLRate,
      totalBuy,
      totalSell,
      totalDividend,
      totalFee,
      realizedPnL,
      totalReturn,
      totalReturnRate,
      txCount: entries.length,
      buyCount,
      sellCount,
      detailHref: `/?accountId=${encodeURIComponent(a.id)}&view=${getInvestmentAccountView({ investProductType: a.investProductType })}`,
    };
  });

  // Filter + pagination
  const filteredRows = accountRows.filter((r) => {
    if (filter === "holding") return r.marketValue > 0.01;
    if (filter === "cleared") return r.marketValue <= 0.01 && r.txCount > 0;
    return true;
  });
  const totalPageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const page = Math.min(pageParam, totalPageCount);
  const pagedRows = filteredRows.slice((page - 1) * pageSize, page * pageSize);

  const totalMarketValue = accountRows.reduce((s, r) => s + r.marketValue, 0);
  const totalCostAll = accountRows.reduce((s, r) => s + r.totalCost, 0);
  const totalFloatingPnL = accountRows.reduce((s, r) => s + r.floatingPnL, 0);
  const totalRealizedPnL = accountRows.reduce((s, r) => s + r.realizedPnL, 0);
  const totalFeeAll = accountRows.reduce((s, r) => s + r.totalFee, 0);
  const totalReturn = totalFloatingPnL + totalRealizedPnL;
  const totalBuyAll = accountRows.reduce((s, r) => s + r.totalBuy, 0);
  const totalReturnRate = totalBuyAll > 0 ? totalReturn / totalBuyAll : 0;
  const totalFloatingRate = totalCostAll > 0 ? totalFloatingPnL / totalCostAll : 0;

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <header className="page-header">
        <div className="h-12 flex items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <div className="text-sm page-title">{t("invest.title")}</div>
            <div className="flex items-center gap-1">
              <Link href="/invest?tab=overview" className={`h-7 px-3 rounded text-xs flex items-center ${tab === "overview" ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>{t("invest.overview")}</Link>
              <Link href="/invest?tab=stats" className={`h-7 px-3 rounded text-xs flex items-center ${tab === "stats" ? "bg-blue-50 text-blue-700 font-medium" : "text-slate-500 hover:text-slate-700"}`}>{t("invest.stats")}</Link>
            </div>
          </div>
          <InvestHeaderSync />
        </div>
      </header>

      {tab === "stats" ? (
        <div className="flex-1 overflow-auto p-4">
          <StatisticsCharts
            monthData={earningsData.monthData}
            incomeCats={earningsData.incCats}
            expenseCats={earningsData.expCats}
            incomeTagGroups={[]}
            expenseTagGroups={[]}
            pnlList={earningsData.profitItems}
            isRedUp={isRedUp}
          />
        </div>
      ) : (
      <div className="flex-1 overflow-auto p-4 space-y-4">
        <DailyPnlCalendar accountIds={accountIds} />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: t("invest.totalMarketValue"), value: fmt(totalMarketValue), sub: null, color: pnlClass(totalMarketValue) },
            { label: t("invest.totalCost"), value: fmt(totalCostAll), sub: null, color: "text-slate-600" },
            { label: t("invest.floatingPnL"), value: fmt(totalFloatingPnL), sub: fmtRate(totalFloatingRate), color: pnlClass(totalFloatingPnL) },
            { label: t("invest.historicalReturn"), value: fmt(totalRealizedPnL), sub: null, color: pnlClass(totalRealizedPnL) },
            { label: t("invest.totalReturn"), value: fmt(totalReturn), sub: fmtRate(totalReturnRate), color: pnlClass(totalReturn) },
            { label: t("invest.totalBuy"), value: fmt(totalBuyAll), sub: null, color: "text-slate-600" },
            { label: t("invest.totalFee"), value: fmt(totalFeeAll), sub: null, color: "text-slate-600" },
          ].map((item) => (
            <div key={item.label} className="bg-white border border-slate-200 rounded-xl px-4 py-3">
              <div className="text-xs text-slate-500 mb-1">{item.label}</div>
              <div className={`text-sm font-semibold tabular-nums ${item.color}`}>{item.value}</div>
              {item.sub && <div className={`text-xs tabular-nums mt-0.5 ${item.color}`}>{item.sub}</div>}
            </div>
          ))}
        </div>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="text-sm font-semibold text-slate-800">{t("invest.accountSummary")}</div>
              <div className="flex items-center bg-slate-100 rounded-lg p-0.5 gap-0.5">
                {[
                  { key: "all", label: t("invest.filterAll") },
                  { key: "holding", label: t("invest.filterHolding") },
                  { key: "cleared", label: t("invest.filterCleared") },
                ].map((f) => {
                  const q = new URLSearchParams();
                  q.set("tab", "overview");
                  if (f.key !== "all") q.set("filter", f.key);
                  return <Link key={f.key} href={`/invest?${q.toString()}`} className={`h-7 px-4 rounded-md text-xs flex items-center transition-all duration-200 ${filter === f.key ? "bg-white text-blue-700 font-semibold shadow-sm border border-blue-200" : "text-slate-600 hover:text-slate-800 hover:bg-white/60"}`}>{f.label}</Link>;
                })}
              </div>
            </div>
            <span className="text-xs text-slate-400">{t("invest.accountCount", { count: filteredRows.length })}</span>
          </div>
          <InvestAccountSummaryTable
            rows={pagedRows}
            totals={{
              totalCost: totalCostAll,
              marketValue: totalMarketValue,
              floatingPnL: totalFloatingPnL,
              floatingRate: totalFloatingRate,
              realizedPnL: totalRealizedPnL,
              totalBuy: totalBuyAll,
              totalFee: totalFeeAll,
            }}
            isRedUp={isRedUp}
          />
          {/* Pagination */}
          {totalPageCount > 1 && (
            <div className="px-4 py-2 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-1 text-xs shrink-0">
              {[10, 20, 40].map((n) => {
                const q = new URLSearchParams();
                q.set("tab", "overview");
                if (filter !== "all") q.set("filter", filter);
                q.set("pageSize", String(n));
                q.set("page", "1");
                return <Link key={n} href={`/invest?${q.toString()}`} className={`h-6 px-1.5 rounded border flex items-center ${pageSize === n ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}>{n}</Link>;
              })}
              <span className="text-slate-300">|</span>
              {page > 1 && (
                <>
                  <Link href={(() => { const q = new URLSearchParams(); q.set("tab", "overview"); if (filter !== "all") q.set("filter", filter); q.set("pageSize", String(pageSize)); q.set("page", "1"); return `/invest?${q.toString()}`; })()} className="h-6 w-6 rounded border border-slate-200 bg-white text-slate-400 hover:bg-slate-50 flex items-center justify-center">&laquo;</Link>
                  <Link href={(() => { const q = new URLSearchParams(); q.set("tab", "overview"); if (filter !== "all") q.set("filter", filter); q.set("pageSize", String(pageSize)); q.set("page", String(page - 1)); return `/invest?${q.toString()}`; })()} className="h-6 w-6 rounded border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 flex items-center justify-center">&lsaquo;</Link>
                </>
              )}
              <span className="text-slate-500">{page}/{totalPageCount}</span>
              {page < totalPageCount && (
                <>
                  <Link href={(() => { const q = new URLSearchParams(); q.set("tab", "overview"); if (filter !== "all") q.set("filter", filter); q.set("pageSize", String(pageSize)); q.set("page", String(page + 1)); return `/invest?${q.toString()}`; })()} className="h-6 w-6 rounded border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 flex items-center justify-center">&rsaquo;</Link>
                  <Link href={(() => { const q = new URLSearchParams(); q.set("tab", "overview"); if (filter !== "all") q.set("filter", filter); q.set("pageSize", String(pageSize)); q.set("page", String(totalPageCount)); return `/invest?${q.toString()}`; })()} className="h-6 w-6 rounded border border-slate-200 bg-white text-slate-400 hover:bg-slate-50 flex items-center justify-center">&raquo;</Link>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
