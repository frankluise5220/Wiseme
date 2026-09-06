import { AccountKind, FundProductType } from "@prisma/client";
import { ArrowLeft } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";

import { buildAccountDisplayOption, normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { getInvestmentAccountView } from "@/lib/account-kind-utils";
import { prisma } from "@/lib/db/prisma";
import { formatDateUtc } from "@/lib/date-utils";
import { signedFundAmount } from "@/lib/fund/transactions";
import { formatMoney, formatPercent } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import type { InvestBalanceDetail } from "@/lib/invest-balance";
import { loadInvestBalances } from "@/lib/server/cached-data";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { ACCOUNT_LABEL_FIELDS_COOKIE, accountLabelFieldsFromCookieValue } from "@/lib/server/account-label-fields";
import { getServerT } from "@/lib/server/i18n";
import { MobileInvestments, type MobileInvestmentAccountDetail } from "@/components/mobile/MobileInvestments";

export const dynamic = "force-dynamic";

const INVEST_KINDS = [AccountKind.investment];
const FUND_LIKE_PRODUCT_TYPES: FundProductType[] = [FundProductType.fund, FundProductType.money];
const GROUP_MODES = [
  { key: "group", labelKey: "investments.groupByOwner" },
  { key: "institution", labelKey: "investments.groupByInstitution" },
  { key: "owner", labelKey: "investments.groupByOwner" },
  { key: "none", labelKey: "investments.groupByNone" },
] as const;

type GroupMode = typeof GROUP_MODES[number]["key"];

function investProductTypeLabel(type: string | null, t: (key: string) => string) {
  if (type === "fund") return t("investment.product.fund");
  if (type === "money") return t("investment.product.money");
  if (type === "wealth") return t("investment.product.wealth");
  if (type === "metal") return t("investment.product.metal");
  if (type === "stock") return t("investment.product.stock");
  if (type === "property") return t("investment.product.property");
  return t("invest.productTypeDefault");
}

function toNumber(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function startDateForMobileChart() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 180);
  return date;
}

export default async function InvestmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const t = await getServerT();
  const groupByParam = typeof params.groupBy === "string" ? params.groupBy : "group";
  const groupBy = GROUP_MODES.some((mode) => mode.key === groupByParam) ? (groupByParam as GroupMode) : "group";
  const ctx = await getHouseholdScope();
  const { hidFilter } = ctx;
  const cookieStore = await cookies();
  const accountLabelFields = accountLabelFieldsFromCookieValue(cookieStore.get(ACCOUNT_LABEL_FIELDS_COOKIE)?.value);
  const isRedUp = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") === "red_up_green_down";
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_label_template")?.value,
    creditCardLabelMode,
  );
  const pnlCls = (n: number) => pnlClassFromRedUp(n, isRedUp);

  const [accounts, investBalById] = await Promise.all([
    prisma.account.findMany({
      where: { isActive: true, isPlaceholder: { not: true }, kind: { in: INVEST_KINDS }, ...hidFilter },
      select: {
        id: true,
        name: true,
        kind: true,
        investProductType: true,
        AccountGroup: { select: { id: true, name: true, sortOrder: true } },
        Institution: { select: { id: true, name: true } },
        User: { select: { id: true, name: true } },
      },
      orderBy: [{ AccountGroup: { sortOrder: "asc" } }, { name: "asc" }],
    }),
    loadInvestBalances(JSON.stringify(hidFilter)),
  ]);

  const balanceMap = new Map(Object.entries(investBalById) as [string, InvestBalanceDetail][]);
  const rows = accounts.map((account) => {
    const detail = balanceMap.get(account.id);
    const marketValue = detail?.marketValue ?? 0;
    const totalCost = detail?.totalCost ?? 0;
    const floatingPnL = detail?.floatingPnL ?? 0;
    const display = buildAccountDisplayOption({
      id: account.id,
      name: account.name,
      kind: account.kind,
      groupId: account.AccountGroup?.id,
      investProductType: account.investProductType,
      Institution: account.Institution,
      AccountGroup: account.AccountGroup,
    }, creditCardLabelTemplate, { fields: accountLabelFields });
    const accountLabel = display.label;
    const groupName = account.AccountGroup?.name?.trim() || t("investments.noOwner");
    const institutionName = display.institutionName || t("investments.noInstitution");
    const ownerName = account.User?.name?.trim() || t("investments.unspecified");
    const productType = investProductTypeLabel(account.investProductType, t);

    return {
      id: account.id,
      label: accountLabel,
      hoverTitle: display.hoverTitle,
      groupName,
      groupSort: account.AccountGroup?.sortOrder ?? 9999,
      institutionName,
      ownerName,
      productType,
      marketValue,
      totalCost,
      floatingPnL,
      floatingRate: totalCost > 0 ? floatingPnL / totalCost : 0,
      href: `/?accountId=${account.id}&view=${getInvestmentAccountView(account)}`,
    };
  });

  const fundLikeAccountIds = accounts
    .filter((account) => FUND_LIKE_PRODUCT_TYPES.includes(account.investProductType as FundProductType))
    .map((account) => account.id);
  const chartStartDate = startDateForMobileChart();

  const [fundHoldings, fundTransactions] = await Promise.all([
    fundLikeAccountIds.length > 0 ? prisma.fundHolding.findMany({
      where: { accountId: { in: fundLikeAccountIds } },
      orderBy: [{ accountId: "asc" }, { fundName: "asc" }, { fundCode: "asc" }],
    }) : Promise.resolve([]),
    fundLikeAccountIds.length > 0 ? prisma.fundTransaction.findMany({
      where: {
        ...hidFilter,
        fundAccountId: { in: fundLikeAccountIds },
        deletedAt: null,
      },
      orderBy: [{ applyDate: "desc" }, { createdAt: "desc" }],
    }) : Promise.resolve([]),
  ]);

  const fundCodes = Array.from(new Set([
    ...fundHoldings.map((holding) => holding.fundCode),
    ...fundTransactions.map((entry) => entry.fundCode),
  ])).filter(Boolean);
  const navRows = fundCodes.length > 0 ? await prisma.fundNavCache.findMany({
    where: { fundCode: { in: fundCodes }, navDate: { gte: chartStartDate } },
    orderBy: [{ fundCode: "asc" }, { navDate: "asc" }],
    select: { fundCode: true, navDate: true, nav: true, cumNav: true },
  }) : [];

  const navByFundCode = new Map<string, { date: string; nav: number; cumNav: number | null }[]>();
  for (const nav of navRows) {
    const list = navByFundCode.get(nav.fundCode) ?? [];
    list.push({ date: formatDateUtc(nav.navDate), nav: toNumber(nav.nav), cumNav: nav.cumNav == null ? null : toNumber(nav.cumNav) });
    navByFundCode.set(nav.fundCode, list);
  }

  const entriesByAccountFund = new Map<string, typeof fundTransactions>();
  for (const entry of fundTransactions) {
    const key = `${entry.fundAccountId}\u001f${entry.fundCode}`;
    const list = entriesByAccountFund.get(key) ?? [];
    list.push(entry);
    entriesByAccountFund.set(key, list);
  }

  const mobileDetails: MobileInvestmentAccountDetail[] = fundLikeAccountIds.map((accountId) => {
    const accountHoldings = fundHoldings.filter((holding) => holding.accountId === accountId);
    const holdingKeys = new Set(accountHoldings.map((holding) => holding.fundCode));
    const holdings = accountHoldings
      .filter((holding) => toNumber(holding.units) > 0 || toNumber(holding.pendingCost) > 0 || toNumber(holding.cost) > 0)
      .map((holding) => {
        const nav = holding.nav == null ? null : toNumber(holding.nav);
        const units = toNumber(holding.units);
        const cost = toNumber(holding.cost);
        const marketValue = nav == null ? cost : units * nav;
        const floatingPnL = marketValue - cost;
        const key = `${accountId}\u001f${holding.fundCode}`;
        return {
          fundCode: holding.fundCode,
          fundName: holding.fundName ?? "",
          units,
          avgCost: toNumber(holding.avgCost),
          cost,
          pendingCost: toNumber(holding.pendingCost),
          nav,
          marketValue,
          floatingPnL,
          floatingRate: cost > 0 ? floatingPnL / cost : 0,
          historicalProfit: toNumber(holding.historicalProfit),
          entries: (entriesByAccountFund.get(key) ?? []).slice(0, 30).map((entry) => ({
            id: entry.id,
            date: formatDateUtc(entry.applyDate),
            subtype: entry.fundSubtype,
            source: entry.source ?? "",
            amount: signedFundAmount(entry),
            nav: entry.nav == null ? null : toNumber(entry.nav),
            units: entry.units == null ? null : toNumber(entry.units),
            fee: entry.fee == null ? 0 : toNumber(entry.fee),
            realizedProfit: entry.realizedProfit == null ? null : toNumber(entry.realizedProfit),
          })),
          chart: navByFundCode.get(holding.fundCode) ?? [],
        };
      });

    const cleared = Array.from(entriesByAccountFund.entries())
      .filter(([key]) => key.startsWith(`${accountId}\u001f`))
      .map(([key, entries]) => ({ fundCode: key.split("\u001f")[1] ?? "", entries }))
      .filter((item) => item.fundCode && !holdingKeys.has(item.fundCode))
      .map((item) => {
        const sorted = [...item.entries].sort((a, b) => a.applyDate.getTime() - b.applyDate.getTime() || a.id.localeCompare(b.id));
        const buyAmount = sorted.reduce((sum, entry) => (entry.fundSubtype === "buy" || entry.fundSubtype === "regular_invest" || entry.fundSubtype === "switch_in" || entry.fundSubtype === "dividend_reinvest") ? sum + Math.abs(toNumber(entry.grossAmount)) : sum, 0);
        const redeemAmount = sorted.reduce((sum, entry) => (entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out" || entry.fundSubtype === "dividend_cash") ? sum + Math.abs(toNumber(entry.arrivalAmount ?? entry.grossAmount)) : sum, 0);
        const historicalProfit = sorted.reduce((sum, entry) => sum + toNumber(entry.realizedProfit), 0);
        const firstDate = sorted[0]?.applyDate ? formatDateUtc(sorted[0].applyDate) : "";
        const clearedDate = sorted.at(-1)?.applyDate ? formatDateUtc(sorted.at(-1)!.applyDate) : "";
        return {
          fundCode: item.fundCode,
          fundName: sorted.find((entry) => entry.fundName)?.fundName ?? "",
          buyAmount,
          redeemAmount,
          historicalProfit,
          returnRate: buyAmount > 0 ? historicalProfit / buyAmount : 0,
          firstDate,
          clearedDate,
          entries: [...sorted].reverse().slice(0, 30).map((entry) => ({
            id: entry.id,
            date: formatDateUtc(entry.applyDate),
            subtype: entry.fundSubtype,
            source: entry.source ?? "",
            amount: signedFundAmount(entry),
            nav: entry.nav == null ? null : toNumber(entry.nav),
            units: entry.units == null ? null : toNumber(entry.units),
            fee: entry.fee == null ? 0 : toNumber(entry.fee),
            realizedProfit: entry.realizedProfit == null ? null : toNumber(entry.realizedProfit),
          })),
          chart: navByFundCode.get(item.fundCode) ?? [],
        };
      })
      .filter((item) => item.buyAmount > 0 || item.redeemAmount > 0 || item.entries.length > 0)
      .sort((a, b) => b.clearedDate.localeCompare(a.clearedDate));

    return { accountId, holdings, cleared };
  });

  const total = rows.reduce((sum, row) => sum + row.marketValue, 0);
  const totalFloatingPnL = rows.reduce((sum, row) => sum + row.floatingPnL, 0);
  const totalCost = rows.reduce((sum, row) => sum + row.totalCost, 0);
  const totalFloatingRate = totalCost > 0 ? totalFloatingPnL / totalCost : 0;

  const grouped = new Map<string, { label: string; sort: number; rows: typeof rows }>();
  for (const row of rows) {
    const label =
      groupBy === "institution" ? row.institutionName :
      groupBy === "owner" ? row.ownerName :
      groupBy === "none" ? t("investments.allAccounts") :
      row.groupName;
    const sort = groupBy === "group" ? row.groupSort : label === t("investments.unspecified") || label === t("investments.noInstitution") || label === t("investments.noOwner") ? 9999 : 0;
    const current = grouped.get(label);
    if (current) current.rows.push(row);
    else grouped.set(label, { label, sort, rows: [row] });
  }

  const groups = Array.from(grouped.values()).sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label, "zh-Hans-CN"));
  for (const group of groups) {
    group.rows.sort((a, b) => b.marketValue - a.marketValue || a.label.localeCompare(b.label, "zh-Hans-CN"));
  }

  function modeHref(mode: GroupMode) {
    const q = new URLSearchParams();
    q.set("groupBy", mode);
    return `/investments?${q.toString()}`;
  }

  function groupTotal(groupRows: typeof rows) {
    const marketValue = groupRows.reduce((sum, row) => sum + row.marketValue, 0);
    const totalCost = groupRows.reduce((sum, row) => sum + row.totalCost, 0);
    const floatingPnL = groupRows.reduce((sum, row) => sum + row.floatingPnL, 0);
    const floatingRate = totalCost > 0 ? floatingPnL / totalCost : 0;
    return { marketValue, totalCost, floatingPnL, floatingRate };
  }

  function fmtRate(value: number) {
    return formatPercent(value);
  }

  return (
    <>
    <div className="h-full md:hidden">
      <MobileInvestments
        rows={rows}
        details={mobileDetails}
        total={total}
        totalCost={totalCost}
        totalFloatingPnL={totalFloatingPnL}
        isRedUp={isRedUp}
      />
    </div>
    <div className="hidden h-full md:block">
    <div className="flex-1 min-h-0 overflow-auto bg-transparent p-4 md:p-5">
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link href="/" className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50">
              <ArrowLeft size={17} />
            </Link>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-slate-900">{t("investments.title")}</h1>
              <p className="mt-0.5 text-xs text-slate-500">{t("investments.summary", { count: rows.length, groupCount: groups.length })}</p>
            </div>
          </div>
          <div className="flex items-center rounded-lg bg-slate-100 p-0.5">
            {GROUP_MODES.map((mode) => (
              <Link
                key={mode.key}
                href={modeHref(mode.key)}
                className={`h-7 rounded-md px-3 text-xs leading-7 transition-colors ${groupBy === mode.key ? "bg-white font-medium text-blue-700 shadow-sm" : "text-slate-600 hover:text-slate-900"}`}
              >
                {t(mode.labelKey)}
              </Link>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
            <div className="text-xs text-slate-500">{t("investments.totalLabel")}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{formatMoney(total)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
            <div className="text-xs text-slate-500">{t("invest.floatingPnL")}</div>
            <div className={`mt-1 text-lg font-semibold tabular-nums ${pnlCls(totalFloatingPnL)}`}>{formatMoney(totalFloatingPnL)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
            <div className="text-xs text-slate-500">{t("invest.floatingRate")}</div>
            <div className={`mt-1 text-lg font-semibold tabular-nums ${pnlCls(totalFloatingRate)}`}>{fmtRate(totalFloatingRate)}</div>
          </div>
        </div>

        <div className="space-y-3">
          {groups.map((group) => {
            const gt = groupTotal(group.rows);
            return (
              <section key={group.label} className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-800">{group.label}</div>
                    <div className="mt-0.5 text-xs text-slate-400">{t("invest.accountCount", { count: group.rows.length })}</div>
                  </div>
                  <div className="grid grid-cols-3 gap-5 text-right text-xs">
                    <div>
                      <div className="text-slate-400">{t("investments.marketValue")}</div>
                      <div className="mt-0.5 font-semibold tabular-nums text-slate-800">{formatMoney(gt.marketValue)}</div>
                    </div>
                    <div>
                      <div className="text-slate-400">{t("investments.floatingProfit")}</div>
                      <div className={`mt-0.5 font-semibold tabular-nums ${pnlCls(gt.floatingPnL)}`}>{formatMoney(gt.floatingPnL)}</div>
                    </div>
                    <div>
                      <div className="text-slate-400">{t("invest.floatingRate")}</div>
                      <div className={`mt-0.5 font-semibold tabular-nums ${pnlCls(gt.floatingRate)}`}>{fmtRate(gt.floatingRate)}</div>
                    </div>
                  </div>
                </div>
                <div className="divide-y divide-slate-100">
                  {group.rows.map((row) => (
                    <Link key={row.id} href={row.href} title={row.hoverTitle} className="grid grid-cols-[minmax(0,1fr)_120px_120px_86px] items-center gap-3 px-4 py-3 hover:bg-blue-50/40">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-slate-800" title={row.hoverTitle}>{row.label}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
                          {groupBy !== "group" ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-500">{row.groupName}</span> : null}
                          {groupBy !== "institution" ? <span>{row.institutionName}</span> : null}
                          {groupBy !== "owner" ? <span>{row.ownerName}</span> : null}
                          <span>{row.productType}</span>
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[11px] text-slate-400">{t("investments.marketValue")}</div>
                        <div className="text-xs font-semibold tabular-nums text-slate-800">{formatMoney(row.marketValue)}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-[11px] text-slate-400">{t("investments.floatingProfit")}</div>
                        <div className={`text-xs font-semibold tabular-nums ${pnlCls(row.floatingPnL)}`}>{formatMoney(row.floatingPnL)}</div>
                      </div>
                      <div className={`text-right text-xs font-semibold tabular-nums ${pnlCls(row.floatingRate)}`}>
                        {fmtRate(row.floatingRate)}
                      </div>
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
          {rows.length === 0 && <div className="rounded-lg border border-slate-200 bg-white py-8 text-center text-sm text-slate-400">{t("invest.noAccounts")}</div>}
        </div>
      </div>
    </div>
    </div>
    </>
  );
}
