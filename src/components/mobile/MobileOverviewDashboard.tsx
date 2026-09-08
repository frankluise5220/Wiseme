"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ChevronRight,
  CreditCard,
  Eye,
  EyeOff,
  Wallet,
} from "lucide-react";

import type { OverviewDashboardProps } from "@/components/OverviewDashboard";
import { formatMoneyYuan, formatPercent } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { useI18n } from "@/lib/i18n";

function daysUntil(dateText: string | null | undefined) {
  if (!dateText) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!match) return null;
  const due = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.ceil((due.getTime() - today.getTime()) / 86400000);
}

const ZERO_TOTALS = {
  cash: 0,
  bankDebit: 0,
  ewallet: 0,
  deposit: 0,
  investmentMarketValue: 0,
  investmentCost: 0,
  investmentFloatingPnL: 0,
  fixedAssetMarketValue: 0,
  fixedAssetCost: 0,
  insuranceAsset: 0,
  creditUsed: 0,
  creditLimit: 0,
  creditAvailable: 0,
  creditCurrentBill: 0,
  loan: 0,
  loanReceivable: 0,
  other: 0,
  liquidAssets: 0,
  liabilities: 0,
  dailyNetWorth: 0,
  totalNetWorth: 0,
};

export function MobileOverviewDashboard({
  netWorth,
  accountTypeTotals,
  monthIncome,
  monthExpense,
  creditAccountList,
  topPositions = [],
  investmentAccountCount,
  insuranceAccountCount,
  investmentMarketValue,
  investmentCost,
  investmentFloatingPnL,
  investmentFloatingPnLRate,
  fixedAssetAccountList = [],
  fixedAssetCount,
  fixedAssetMarketValue,
  fixedAssetCost,
  fixedAssetFloatingPnL,
  fixedAssetFloatingPnLRate,
  missingFxCurrencies = [],
  isRedUp,
}: OverviewDashboardProps) {
  const { t } = useI18n();
  const [showAmounts, setShowAmounts] = useState(true);
  const totals = { ...ZERO_TOTALS, ...(accountTypeTotals ?? {}) };
  const investMarketValue = investmentMarketValue ?? totals.investmentMarketValue;
  const investCost = investmentCost ?? totals.investmentCost;
  const investFloatingPnL = investmentFloatingPnL ?? totals.investmentFloatingPnL;
  const investFloatingRate = investmentFloatingPnLRate ?? (investCost > 0 ? investFloatingPnL / investCost : 0);
  const fixedValue = fixedAssetMarketValue ?? totals.fixedAssetMarketValue;
  const fixedCostValue = fixedAssetCost ?? totals.fixedAssetCost;
  const fixedPnL = fixedAssetFloatingPnL ?? fixedValue - fixedCostValue;
  const fixedRate = fixedAssetFloatingPnLRate ?? (fixedCostValue > 0 ? fixedPnL / fixedCostValue : 0);
  const monthNet = monthIncome - monthExpense;
  const netLiabilities = totals.liabilities - totals.loanReceivable;
  const netDebtLabel = netLiabilities >= 0 ? t("overview.netDebt") : t("overview.netCredit");
  const netDebtAmount = Math.abs(netLiabilities);
  const creditUsed = creditAccountList.reduce((sum, account) => sum + Math.max(0, account.convertedBalance ?? account.balance), 0);
  const creditAvailable = creditAccountList.reduce((sum, account) => sum + Math.max(0, account.availableLimit), 0);
  const creditBill = creditAccountList.reduce((sum, account) => sum + Math.max(0, account.convertedCurrentBill ?? account.currentBill), 0);
  const creditCardsWithBills = creditAccountList
    .filter((account) => account.currentBill > 0 && daysUntil(account.dueDate) != null && daysUntil(account.dueDate)! >= 0 && daysUntil(account.dueDate)! <= 10)
    .sort((a, b) => (daysUntil(a.dueDate) ?? 999) - (daysUntil(b.dueDate) ?? 999))
    .slice(0, 3);
  const showInvestmentOverview = investmentAccountCount == null
    ? topPositions.length > 0 || investMarketValue !== 0
    : investmentAccountCount > 0;
  const showInsuranceOverview = insuranceAccountCount == null
    ? totals.insuranceAsset !== 0
    : insuranceAccountCount > 0;
  const showFixedAssetOverview = fixedAssetCount == null
    ? fixedAssetAccountList.length > 0 || fixedValue !== 0 || fixedCostValue !== 0
    : fixedAssetCount > 0;

  const amount = (value: number) => showAmounts ? formatMoneyYuan(value) : "****";
  const percent = (value: number) => showAmounts ? formatPercent(value) : "****";
  const valueClass = (value: number) => pnlClassFromRedUp(value, isRedUp, "softDark");
  const liabilityValueClass = (value: number) => pnlClassFromRedUp(value, isRedUp, "softDark", true);

  return (
    <div className="h-full overflow-y-auto bg-[#f4f7fb]">
      <div className="space-y-3 px-3 pb-5 pt-2">
        <section className="overflow-hidden rounded-[1.6rem] bg-gradient-to-br from-slate-950 via-indigo-950 to-indigo-700 text-white shadow-[0_18px_44px_rgba(30,41,59,0.24)]">
          <div className="px-4 pb-4 pt-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs font-medium text-indigo-200">{t("overview.netWorth")}</div>
                <div className="mt-1 break-all text-[30px] font-bold leading-tight text-white tabular-nums">{amount(netWorth)}</div>
              </div>
              <button
                type="button"
                onClick={() => setShowAmounts((visible) => !visible)}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/12 text-indigo-100 ring-1 ring-white/10 backdrop-blur active:bg-white/18"
                aria-label={t(showAmounts ? "mobileOverview.hideAmounts" : "mobileOverview.showAmounts")}
              >
                {showAmounts ? <Eye size={19} /> : <EyeOff size={19} />}
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <HeroMetric label={t("overview.liquidAssets")} value={amount(totals.liquidAssets)} />
              <HeroMetric label={netDebtLabel} value={amount(netDebtAmount)} />
              {showInvestmentOverview ? <HeroMetric label={t("overview.investMarketValue")} value={amount(investMarketValue)} /> : null}
              {showFixedAssetOverview ? <HeroMetric label={t("overview.fixedAssetValue")} value={amount(fixedValue)} /> : null}
              {showInsuranceOverview ? <HeroMetric label={t("account.kind.insurance")} value={amount(totals.insuranceAsset)} /> : null}
            </div>
          </div>
          <div className="grid grid-cols-3 border-t border-white/10 bg-white/[0.06] px-1 py-2">
            <HeroFlowMetric label={t("overview.thisMonthIncome")} value={amount(Math.abs(monthIncome))} />
            <HeroFlowMetric label={t("overview.thisMonthExpense")} value={amount(Math.abs(monthExpense))} />
            <HeroFlowMetric label={t("mobileOverview.balance")} value={amount(monthNet)} />
          </div>
        </section>

        {missingFxCurrencies.length > 0 ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
            {t("overview.missingFxRateDetail", { currencies: missingFxCurrencies.join("、") })}
          </div>
        ) : null}

        <section className="grid grid-cols-2 gap-2">
          <Link href="/accounts" className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200 active:bg-slate-50">
            <MiniTile icon={Wallet} label={t("overview.dailyAccounts")} value={amount(totals.dailyNetWorth)} tone="blue" valueClass={valueClass(totals.dailyNetWorth)} />
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3">
              <TinyMetric label={t("overview.cash")} value={amount(totals.cash)} valueClass={valueClass(totals.cash)} />
              <TinyMetric label={t("overview.deposit")} value={amount(totals.deposit)} valueClass={valueClass(totals.deposit)} align="right" />
            </div>
          </Link>
          <Link href="/accounts?tab=credit" className="rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200 active:bg-slate-50">
            <MiniTile icon={CreditCard} label={t("overview.creditCards")} value={amount(creditBill || creditUsed)} tone="rose" valueClass={liabilityValueClass(creditBill || creditUsed)} />
            <div className="mt-3 grid grid-cols-2 gap-2 border-t border-slate-100 pt-3">
              <TinyMetric label={t("accountsPage.availableLimit")} value={amount(creditAvailable)} valueClass={valueClass(creditAvailable)} />
              <TinyMetric label={t("overview.currentBill")} value={amount(creditBill)} valueClass={liabilityValueClass(creditBill)} align="right" />
            </div>
          </Link>
        </section>

        {showInvestmentOverview ? (
          <section className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
            <MobileSectionHeader label={t("overview.investmentOverview")} href="/investments" t={t} />
            <div className="px-3 pb-3">
              <div className="grid grid-cols-2 gap-2">
                <TinyPanel label={t("overview.investMarketValue")} value={amount(investMarketValue)} />
                <TinyPanel label={t("overview.floatingPnL")} value={amount(investFloatingPnL)} valueClass={valueClass(investFloatingPnL)} align="right" />
                <TinyPanel label={t("overview.holdingCost")} value={amount(investCost)} />
                <TinyPanel label={t("overview.floatingRate")} value={percent(investFloatingRate)} valueClass={valueClass(investFloatingRate)} align="right" />
              </div>

            </div>
          </section>
        ) : null}

        {showFixedAssetOverview ? (
          <section className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
            <MobileSectionHeader label={t("overview.fixedAssets")} href="/?view=investproperty" t={t} />
            <div className="px-3 pb-3">
              <div className="grid grid-cols-2 gap-2">
                <TinyPanel label={t("overview.fixedAssetValue")} value={amount(fixedValue)} />
                <TinyPanel label={t("overview.fixedAssetPnL")} value={amount(fixedPnL)} valueClass={valueClass(fixedPnL)} align="right" />
                <TinyPanel label={t("overview.fixedAssetCost")} value={amount(fixedCostValue)} />
                <TinyPanel label={t("overview.fixedAssetRate")} value={percent(fixedRate)} valueClass={valueClass(fixedRate)} align="right" />
              </div>
              {fixedAssetAccountList.length > 0 ? (
                <div className="mt-2 space-y-1">
                  {fixedAssetAccountList.slice(0, 3).map((item) => (
                    <Link
                      key={item.accountId}
                      href={`/?accountId=${item.accountId}&view=investproperty`}
                      className="flex items-center justify-between gap-2 rounded-xl bg-slate-50 px-2.5 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-900">{item.name}</span>
                      <span className={`shrink-0 text-xs font-semibold tabular-nums ${valueClass(item.convertedMarketValue ?? item.marketValue)}`}>{amount(item.convertedMarketValue ?? item.marketValue)}</span>
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {creditCardsWithBills.length > 0 ? (
          <section className="rounded-2xl bg-white px-3 py-2 shadow-sm ring-1 ring-slate-200">
            <div className="flex items-center justify-between gap-2">
              <h2 className="shrink-0 text-sm font-semibold text-slate-950">{t("mobileOverview.creditSnapshot")}</h2>
              <Link href="/accounts?tab=credit" className="shrink-0 text-xs font-medium text-indigo-600">{t("overview.viewAll")}</Link>
            </div>
            <div className="mt-1.5 space-y-1">
              {creditCardsWithBills.map((account) => (
                <Link key={account.id} href={`/accounts/${encodeURIComponent(account.id)}`} className="flex min-h-9 items-center gap-2 rounded-xl bg-rose-50/55 px-2.5 py-1.5 active:bg-rose-50">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-900">{account.name}</span>
                  <span className={`shrink-0 text-xs font-semibold tabular-nums ${liabilityValueClass(account.currentBill)}`}>{amount(account.currentBill)}</span>
                  <span className="shrink-0 text-xs font-medium text-rose-600">{account.dueDate}</span>
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function HeroMetric({ label, value, className = "text-white" }: { label: string; value: string; className?: string }) {
  return (
    <div className="min-w-0 rounded-2xl bg-white/[0.08] px-3 py-2 ring-1 ring-white/10">
      <div className="text-[11px] text-indigo-200">{label}</div>
      <div className={`mt-1 truncate text-sm font-semibold tabular-nums ${className}`}>{value}</div>
    </div>
  );
}

function HeroFlowMetric({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="min-w-0 px-2 py-1.5 text-center">
      <div className="truncate text-[10px] text-indigo-200">{label}</div>
      <div className={`mt-1 truncate text-xs font-semibold tabular-nums ${className ?? "text-white"}`}>{value}</div>
    </div>
  );
}


function MiniTile({ icon: Icon, label, value, tone, valueClass = "text-slate-950" }: { icon: typeof Wallet; label: string; value: string; tone: "blue" | "rose"; valueClass?: string }) {
  const toneClass = tone === "rose" ? "bg-rose-50 text-rose-700" : "bg-blue-50 text-blue-700";
  return (
    <div className="flex items-start gap-2.5">
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${toneClass}`}>
        <Icon size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-slate-500">{label}</span>
        <span className={`mt-1 block truncate text-sm font-semibold tabular-nums ${valueClass}`}>{value}</span>
      </span>
    </div>
  );
}

function TinyMetric({ label, value, valueClass = "text-slate-700", align = "left" }: { label: string; value: string; valueClass?: string; align?: "left" | "right" }) {
  return (
    <div className={`min-w-0 ${align === "right" ? "text-right" : "text-left"}`}>
      <div className="truncate text-[10px] text-slate-400">{label}</div>
      <div className={`mt-0.5 truncate text-[11px] font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}

function TinyPanel({ label, value, valueClass = "text-slate-950", align = "left" }: { label: string; value: string; valueClass?: string; align?: "left" | "right" }) {
  return (
    <div className={`min-w-0 rounded-xl bg-slate-50 px-3 py-2 ${align === "right" ? "text-right" : "text-left"}`}>
      <div className="truncate text-[11px] text-slate-500">{label}</div>
      <div className={`mt-1 truncate text-sm font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}

function MobileSectionHeader({ label, href, t }: { label: string; href: string; t: (key: string, params?: Record<string, string | number>) => string }) {
  return (
    <div className="flex h-11 items-center justify-between px-3">
      <h2 className="text-sm font-semibold text-slate-950">{label}</h2>
      <Link href={href} className="flex h-9 items-center gap-0.5 text-xs font-medium text-indigo-600">
        {t("overview.viewAll")} <ChevronRight size={15} />
      </Link>
    </div>
  );
}

