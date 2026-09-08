"use client";

import Link from "next/link";
import type { ElementType } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Building2,
  CreditCard,
  HandCoins,
  PiggyBank,
  Wallet,
} from "lucide-react";

import { formatCurrencyMoney, formatMoney, formatMoneyYuan, formatPercent } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { InsuranceOverviewCard, type InsuranceOverview } from "@/components/InsuranceOverviewCard";
import { getInvestmentAccountView } from "@/lib/account-kind-utils";
import { MobileOverviewDashboard } from "@/components/mobile/MobileOverviewDashboard";
import { useI18n } from "@/lib/i18n";

export type AssetDistItem = {
  kind: string;
  label: string;
  value: number;
  pct: number;
};

export type AccountItem = {
  id: string;
  name: string;
  kind: string;
  /** Balance in the account's own currency. */
  balance: number;
  currency?: string;
  /** Same balance restated in the household base currency; null when no rate is available. */
  convertedBalance?: number | null;
  fxRateMissing?: boolean;
};

/** Prefer the base-currency amount; fall back to the raw amount only when no rate exists. */
function baseAmount(item: { balance: number; convertedBalance?: number | null }) {
  return item.convertedBalance ?? item.balance;
}

export type CreditAccountItem = AccountItem & {
  creditLimit: number;
  availableLimit: number;
  currentBill: number;
  paid: number;
  dueDate?: string | null;
  /** Base-currency mirrors; null when the card's currency has no rate. */
  convertedCreditLimit?: number | null;
  convertedCurrentBill?: number | null;
  convertedPaid?: number | null;
  convertedCurrentAmount?: number | null;
};

export type FixedAssetItem = {
  accountId: string;
  name: string;
  assetType?: string | null;
  marketValue: number;
  cost: number;
  floatingPnL: number;
  floatingPnLRate: number;
  currency?: string;
  convertedMarketValue?: number | null;
  fxRateMissing?: boolean;
};

export type AccountTypeTotals = {
  cash: number;
  bankDebit: number;
  ewallet: number;
  deposit: number;
  investmentMarketValue: number;
  investmentCost: number;
  investmentFloatingPnL: number;
  fixedAssetMarketValue: number;
  fixedAssetCost: number;
  insuranceAsset: number;
  creditUsed: number;
  creditLimit: number;
  creditAvailable: number;
  creditCurrentBill: number;
  loan: number;
  loanReceivable: number;
  other: number;
  liquidAssets: number;
  liabilities: number;
  dailyNetWorth: number;
  totalNetWorth: number;
};

export type InvestmentOverviewItem = {
  accountId?: string;
  investProductType?: string | null;
  fundCode: string;
  name: string;
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
  currency?: string;
  convertedMarketValue?: number | null;
  convertedFloatingPnL?: number | null;
  fxRateMissing?: boolean;
};

export type OverviewDashboardProps = {
  netWorth: number;
  accountTypeTotals?: Partial<AccountTypeTotals> | null;
  assetDistribution: AssetDistItem[];
  monthIncome: number;
  monthExpense: number;
  accountList: AccountItem[];
  creditAccountList: CreditAccountItem[];
  debtAccountList?: AccountItem[];
  topPositions?: InvestmentOverviewItem[];
  investmentAccountCount?: number;
  insuranceAccountCount?: number;
  investmentMarketValue?: number;
  investmentCost?: number;
  investmentFloatingPnL?: number;
  investmentFloatingPnLRate?: number;
  fixedAssetAccountList?: FixedAssetItem[];
  fixedAssetCount?: number;
  fixedAssetMarketValue?: number;
  fixedAssetCost?: number;
  fixedAssetFloatingPnL?: number;
  fixedAssetFloatingPnLRate?: number;
  insuranceOverview?: InsuranceOverview | null;
  baseCurrency?: string;
  missingFxCurrencies?: string[];
  isRedUp: boolean;
};

const ZERO_TOTALS: AccountTypeTotals = {
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

/** True when the row is denominated in a currency other than the household base currency. */
function isForeign(item: { currency?: string; fxMissing?: boolean }, baseCurrency: string) {
  const currency = String(item.currency ?? baseCurrency).trim().toUpperCase() || baseCurrency;
  return currency !== baseCurrency;
}

function directionalClass(value: number, isRedUp: boolean) {
  return pnlClassFromRedUp(value, isRedUp, "softMuted");
}

function liabilityClass(value: number, isRedUp: boolean) {
  return pnlClassFromRedUp(value, isRedUp, "softMuted", true);
}

function distributionBarClass(index: number) {
  const palette = ["bg-blue-500", "bg-cyan-500", "bg-emerald-500", "bg-amber-500", "bg-slate-400"];
  return palette[index % palette.length];
}

function formatRate(value: number) {
  return formatPercent(value);
}

export function OverviewDashboard({
  netWorth,
  accountTypeTotals,
  assetDistribution,
  monthIncome,
  monthExpense,
  accountList,
  creditAccountList,
  debtAccountList = [],
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
  insuranceOverview,
  baseCurrency = "CNY",
  missingFxCurrencies = [],
  isRedUp,
}: OverviewDashboardProps) {
  const totals: AccountTypeTotals = { ...ZERO_TOTALS, ...(accountTypeTotals ?? {}) };
  const { t } = useI18n();
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
  const netDebtClass = netLiabilities >= 0
    ? liabilityClass(netDebtAmount, isRedUp)
    : directionalClass(netDebtAmount, isRedUp);
  const hasForeignCurrency =
    accountList.some((account) => isForeign(account, baseCurrency)) ||
    debtAccountList.some((account) => isForeign(account, baseCurrency)) ||
    fixedAssetAccountList.some((item) => isForeign(item, baseCurrency));
  const topAccounts = accountList
    .slice()
    .sort((a, b) => Math.abs(baseAmount(b)) - Math.abs(baseAmount(a)))
    .slice(0, 5);
  const creditBillOf = (account: CreditAccountItem) => account.convertedCurrentBill ?? account.currentBill;
  const paidOf = (account: CreditAccountItem) => account.convertedPaid ?? account.paid;
  const creditCards = creditAccountList
    .filter((account) => creditBillOf(account) > 0)
    .sort((a, b) => creditBillOf(b) - creditBillOf(a))
    .slice(0, 10);
  const creditBillTotal = creditCards.reduce((sum, account) => sum + Math.max(0, creditBillOf(account)), 0);
  const creditPaidTotal = creditCards.reduce(
    (sum, account) => sum + Math.max(0, Math.min(paidOf(account), Math.max(0, creditBillOf(account)))),
    0,
  );
  const debtAccounts = debtAccountList.filter((account) => account.balance !== 0);
  const showInvestmentOverview = investmentAccountCount == null
    ? topPositions.length > 0 || investMarketValue !== 0 || investCost !== 0
    : investmentAccountCount > 0;
  const showInsuranceOverview = insuranceAccountCount == null
    ? (insuranceOverview?.productCount ?? 0) > 0 || totals.insuranceAsset !== 0
    : insuranceAccountCount > 0;
  const showFixedAssetOverview = fixedAssetCount == null
    ? fixedAssetAccountList.length > 0 || fixedValue !== 0 || fixedCostValue !== 0
    : fixedAssetCount > 0;
  const overviewModuleCount =
    1 +
    (showInvestmentOverview ? 1 : 0) +
    (showFixedAssetOverview ? 1 : 0) +
    (showInsuranceOverview ? 1 : 0) +
    (creditCards.length > 0 ? 1 : 0) +
    (debtAccounts.length > 0 ? 1 : 0);
  const investmentModuleIndex = showInvestmentOverview ? 0 : -1;
  const dailyModuleIndex = showInvestmentOverview ? 1 : 0;
  const fixedAssetModuleIndex = dailyModuleIndex + 1;
  const insuranceModuleIndex = fixedAssetModuleIndex + (showFixedAssetOverview ? 1 : 0);
  const creditModuleIndex = insuranceModuleIndex + (showInsuranceOverview ? 1 : 0);
  const debtModuleIndex = creditModuleIndex + (creditCards.length > 0 ? 1 : 0);
  const moduleClass = (index: number) =>
    `panel-surface ${overviewModuleCount === 3 && index === 0 ? "xl:col-span-2" : ""}`;

  return (
    <>
    <div className="h-full md:hidden">
      <MobileOverviewDashboard
        netWorth={netWorth}
        accountTypeTotals={accountTypeTotals}
        assetDistribution={assetDistribution}
        monthIncome={monthIncome}
        monthExpense={monthExpense}
        accountList={accountList}
        creditAccountList={creditAccountList}
        debtAccountList={debtAccountList}
        topPositions={topPositions}
        investmentAccountCount={investmentAccountCount}
        insuranceAccountCount={insuranceAccountCount}
        investmentMarketValue={investmentMarketValue}
        investmentCost={investmentCost}
        investmentFloatingPnL={investmentFloatingPnL}
        investmentFloatingPnLRate={investmentFloatingPnLRate}
        fixedAssetAccountList={fixedAssetAccountList}
        fixedAssetCount={fixedAssetCount}
        fixedAssetMarketValue={fixedAssetMarketValue}
        fixedAssetCost={fixedAssetCost}
        fixedAssetFloatingPnL={fixedAssetFloatingPnL}
        fixedAssetFloatingPnLRate={fixedAssetFloatingPnLRate}
        insuranceOverview={insuranceOverview}
        baseCurrency={baseCurrency}
        missingFxCurrencies={missingFxCurrencies}
        isRedUp={isRedUp}
      />
    </div>
    <div className="hidden h-full md:flex md:flex-col">
    <div className="page-body bg-transparent">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 md:px-5 md:py-5">
        <section className="panel-surface overflow-hidden">
          <div className="grid gap-4 px-5 py-4 md:grid-cols-[minmax(220px,1fr)_2.2fr] md:items-center md:px-6">
            <div>
              <div className="text-xs font-medium tracking-[0.18em] text-slate-400 uppercase">Overview</div>
              <div className="mt-1 text-sm text-slate-500">{t("overview.netWorth")}</div>
              <div className={`mt-1 break-all text-3xl font-semibold md:text-4xl ${directionalClass(netWorth, isRedUp)}`}>
                {formatMoneyYuan(netWorth)}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <MetricCard label={t("overview.liquidAssets")} value={formatMoneyYuan(totals.liquidAssets)} valueClass={directionalClass(totals.liquidAssets, isRedUp)} />
              <MetricCard label={netDebtLabel} value={formatMoneyYuan(netDebtAmount)} valueClass={netDebtClass} />
              {showInvestmentOverview ? (
                <MetricCard label={t("overview.investMarketValue")} value={formatMoneyYuan(investMarketValue)} valueClass={directionalClass(investMarketValue, isRedUp)} />
              ) : null}
              {showFixedAssetOverview ? (
                <MetricCard label={t("overview.fixedAssetValue")} value={formatMoneyYuan(fixedValue)} valueClass={directionalClass(fixedValue, isRedUp)} />
              ) : null}
              {showInsuranceOverview ? (
                <MetricCard label={t("overview.insuranceCashValue")} value={formatMoneyYuan(totals.insuranceAsset)} valueClass={directionalClass(totals.insuranceAsset, isRedUp)} />
              ) : null}
            </div>
            {missingFxCurrencies.length > 0 ? (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
                {t("overview.missingFxRateDetail", { currencies: missingFxCurrencies.join("、") })}
              </div>
            ) : hasForeignCurrency ? (
              <div className="mt-3 text-[11px] text-slate-400">
                {t("overview.convertedToBase", { currency: baseCurrency })}
              </div>
            ) : null}
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {showInvestmentOverview ? (
            <div className={moduleClass(investmentModuleIndex)}>
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <PiggyBank className="h-4 w-4 text-emerald-500" />
                  {t("overview.investmentOverview")}
                </div>
              </div>
              <div className="space-y-4 px-4 py-4">
                <InvestmentCostProfitBar
                  cost={investCost}
                  floatingPnL={investFloatingPnL}
                />
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <MetricCard label={t("overview.investMarketValue")} value={formatMoneyYuan(investMarketValue)} valueClass={directionalClass(investMarketValue, isRedUp)} />
                  <MetricCard label={t("overview.holdingCost")} value={formatMoneyYuan(investCost)} />
                  <MetricCard label={t("overview.floatingPnL")} value={formatMoneyYuan(investFloatingPnL)} valueClass={directionalClass(investFloatingPnL, isRedUp)} />
                  <MetricCard label={t("overview.floatingRate")} value={formatRate(investFloatingRate)} valueClass={directionalClass(investFloatingRate, isRedUp)} />
                </div>
              </div>
              <div className="divide-y divide-slate-100 border-t border-slate-100">
                {topPositions.length > 0 ? (
                  topPositions.slice(0, 5).map((item) => (
                    <Link
                      key={item.accountId ?? item.fundCode}
                      href={item.accountId ? `/?accountId=${item.accountId}&view=${getInvestmentAccountView(item)}` : "/investments"}
                      scroll={false}
                      className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-3 px-4 py-3 hover:bg-slate-50 sm:grid-cols-[minmax(0,1fr)_96px_96px_72px]"
                    >
                      <div className="truncate text-sm font-semibold text-slate-800">{item.name}</div>
                      <div className={`text-right text-xs font-semibold tabular-nums ${directionalClass(item.convertedMarketValue ?? item.marketValue, isRedUp)}`}>{formatMoney(item.convertedMarketValue ?? item.marketValue)}</div>
                      <div className={`hidden text-right text-xs font-semibold tabular-nums sm:block ${directionalClass(item.convertedFloatingPnL ?? item.floatingPnL, isRedUp)}`}>{formatMoney(item.convertedFloatingPnL ?? item.floatingPnL)}</div>
                      <div className={`hidden text-right text-xs font-semibold tabular-nums sm:block ${directionalClass(item.floatingPnLRate, isRedUp)}`}>{formatRate(item.floatingPnLRate)}</div>
                    </Link>
                  ))
                ) : (
                  <div className="px-4 py-8 text-center text-sm text-slate-400">{t("overview.noInvestmentPositions")}</div>
                )}
              </div>
            </div>
          ) : null}

          <div className={moduleClass(dailyModuleIndex)}>
            <div className="panel-header">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Wallet className="h-4 w-4 text-blue-500" />
                {t("overview.dailyAccounts")}
              </div>
            </div>
            <div className="space-y-4 px-4 py-4">
              <DailyAccountDistributionBar items={assetDistribution} />
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <MetricCard label={t("overview.cash")} value={formatMoneyYuan(totals.cash)} valueClass={directionalClass(totals.cash, isRedUp)} />
                <MetricCard label={t("overview.debitCard")} value={formatMoneyYuan(totals.bankDebit)} valueClass={directionalClass(totals.bankDebit, isRedUp)} />
                <MetricCard label={t("overview.ewallet")} value={formatMoneyYuan(totals.ewallet)} valueClass={directionalClass(totals.ewallet, isRedUp)} />
                <MetricCard label={t("overview.deposit")} value={formatMoneyYuan(totals.deposit)} valueClass={directionalClass(totals.deposit, isRedUp)} />
              </div>
            </div>
            <div className="divide-y divide-slate-100 border-t border-slate-100">
              {topAccounts.length > 0 ? (
                topAccounts.slice(0, 4).map((account) => (
                  <Link key={account.id} href={`/?accountId=${account.id}&view=detail`} scroll={false} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-800">{account.name}</div>
                      <div className="mt-1 truncate text-[11px] text-slate-400">
                        {account.kind}
                        {isForeign(account, baseCurrency) ? ` · ${t("overview.originalAmount", { amount: formatCurrencyMoney(account.balance, account.currency) })}` : ""}
                      </div>
                    </div>
                    <div className={`shrink-0 text-sm font-semibold tabular-nums ${directionalClass(baseAmount(account), isRedUp)}`}>{formatMoney(baseAmount(account))}</div>
                  </Link>
                ))
              ) : (
                <div className="px-4 py-10 text-center text-sm text-slate-400">{t("overview.noDailyAccounts")}</div>
              )}
            </div>
          </div>

          {showFixedAssetOverview ? (
            <div className={moduleClass(fixedAssetModuleIndex)}>
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <Building2 className="h-4 w-4 text-slate-500" />
                  {t("overview.fixedAssets")}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 px-4 py-4 md:grid-cols-4">
                <MetricCard label={t("overview.fixedAssetValue")} value={formatMoneyYuan(fixedValue)} valueClass={directionalClass(fixedValue, isRedUp)} />
                <MetricCard label={t("overview.fixedAssetCost")} value={formatMoneyYuan(fixedCostValue)} />
                <MetricCard label={t("overview.fixedAssetPnL")} value={formatMoneyYuan(fixedPnL)} valueClass={directionalClass(fixedPnL, isRedUp)} />
                <MetricCard label={t("overview.fixedAssetRate")} value={formatRate(fixedRate)} valueClass={directionalClass(fixedRate, isRedUp)} />
              </div>
              <div className="divide-y divide-slate-100 border-t border-slate-100">
                {fixedAssetAccountList.length > 0 ? (
                  fixedAssetAccountList.slice(0, 5).map((item) => (
                    <Link
                      key={item.accountId}
                      href={`/?accountId=${item.accountId}&view=investproperty`}
                      scroll={false}
                      className="grid grid-cols-[minmax(0,1fr)_96px] items-center gap-3 px-4 py-3 hover:bg-slate-50 sm:grid-cols-[minmax(0,1fr)_96px_96px_72px]"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-800">{item.name}</div>
                        <div className="mt-1 truncate text-[11px] text-slate-400">
                          {item.assetType ? t(`fixedAsset.type.${item.assetType}`) : t("account.kind.fixed_asset")}
                          {isForeign(item, baseCurrency) ? ` · ${t("overview.originalAmount", { amount: formatCurrencyMoney(item.marketValue, item.currency) })}` : ""}
                        </div>
                      </div>
                      <div className={`text-right text-xs font-semibold tabular-nums ${directionalClass(item.convertedMarketValue ?? item.marketValue, isRedUp)}`}>{formatMoney(item.convertedMarketValue ?? item.marketValue)}</div>
                      <div className={`hidden text-right text-xs font-semibold tabular-nums sm:block ${directionalClass(item.floatingPnL, isRedUp)}`}>{formatMoney(item.floatingPnL)}</div>
                      <div className={`hidden text-right text-xs font-semibold tabular-nums sm:block ${directionalClass(item.floatingPnLRate, isRedUp)}`}>{formatRate(item.floatingPnLRate)}</div>
                    </Link>
                  ))
                ) : (
                  <div className="px-4 py-8 text-center text-sm text-slate-400">{t("overview.noFixedAssets")}</div>
                )}
              </div>
            </div>
          ) : null}

          {showInsuranceOverview ? (
            <InsuranceOverviewCard className={moduleClass(insuranceModuleIndex)} insuranceOverview={insuranceOverview} isRedUp={isRedUp} />
          ) : null}

          {creditCards.length > 0 && (
            <div className={moduleClass(creditModuleIndex)}>
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <CreditCard className="h-4 w-4 text-amber-500" />
                  {t("overview.creditCards")}
                </div>
              </div>
              <div className="space-y-4 px-4 py-4">
                <CreditBillProgressBar bill={creditBillTotal} paid={creditPaidTotal} />
              </div>
              <div className="divide-y divide-slate-100 border-t border-slate-100">
                {creditCards.map((account) => (
                  <Link
                    key={account.id}
                    href={`/?accountId=${account.id}&view=bill`}
                    scroll={false}
                    className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-800">{account.name}</div>
                    </div>
                    <div className={`shrink-0 text-sm font-semibold tabular-nums ${liabilityClass(creditBillOf(account), isRedUp)}`}>{formatMoney(creditBillOf(account))}</div>
                  </Link>
                ))}
                {creditCards.length === 0 && (
                  <div className="px-4 py-10 text-center text-sm text-slate-400">{t("overview.noCreditBills")}</div>
                )}
              </div>
            </div>
          )}

          {debtAccounts.length > 0 && (
            <div className={moduleClass(debtModuleIndex)}>
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <HandCoins className="h-4 w-4 text-rose-500" />
                  {t("overview.debtCredit")}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 px-4 py-4 sm:grid-cols-3">
                <MetricCard label={t("overview.iOwe")} value={formatMoneyYuan(-totals.loan)} valueClass={directionalClass(-totals.loan, isRedUp)} />
                <MetricCard label={t("overview.owedToMe")} value={formatMoneyYuan(totals.loanReceivable)} valueClass={directionalClass(totals.loanReceivable, isRedUp)} />
                <MetricCard label={t("overview.accountCount")} value={t("overview.accountCountValue", { count: debtAccounts.length })} />
              </div>
              <div className="grid grid-cols-1 gap-3 px-4 pb-4 sm:grid-cols-2">
                {debtAccounts.slice(0, 4).map((account) => (
                  <Link
                    key={account.id}
                    href={`/?accountId=${account.id}&view=detail`}
                    scroll={false}
                    className="rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-3 transition-colors hover:border-rose-200 hover:bg-rose-50/30"
                  >
                    <div className="line-clamp-2 min-h-[40px] text-sm font-semibold leading-5 text-slate-800">{account.name}</div>
                    <div className="mt-3 truncate text-[11px] text-slate-400">
                      {baseAmount(account) >= 0 ? t("overview.owedToMe") : t("overview.iOwe")}
                      {isForeign(account, baseCurrency) ? ` · ${t("overview.originalAmount", { amount: formatCurrencyMoney(account.balance, account.currency) })}` : ""}
                    </div>
                    <div className={`mt-0.5 text-base font-semibold tabular-nums ${directionalClass(baseAmount(account), isRedUp)}`}>{formatMoney(baseAmount(account))}</div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <CashFlowCard
            label={t("overview.thisMonthIncome")}
            value={formatMoneyYuan(monthIncome)}
            icon={ArrowUpRight}
            className={isRedUp ? "text-red-600" : "text-emerald-600"}
          />
          <CashFlowCard
            label={t("overview.thisMonthExpense")}
            value={formatMoneyYuan(-monthExpense)}
            icon={ArrowDownRight}
            className={isRedUp ? "text-emerald-600" : "text-red-600"}
          />
          <CashFlowCard
            label={t("overview.thisMonthNet")}
            value={formatMoneyYuan(monthNet)}
            icon={Wallet}
            className={directionalClass(monthNet, isRedUp)}
          />
        </section>
      </div>
    </div>
    </div>
    </>
  );
}

function MetricCard({ label, value, valueClass = "text-slate-900" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-100 bg-slate-50/80 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 truncate text-sm font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}

function InvestmentCostProfitBar({
  cost,
  floatingPnL,
}: {
  cost: number;
  floatingPnL: number;
}) {
  const pnlAbs = Math.abs(floatingPnL);
  const total = cost + pnlAbs;
  const costPct = total > 0 ? Math.max(0, Math.min(100, (cost / total) * 100)) : 0;
  const pnlPct = total > 0 ? 100 - costPct : 0;
  const { t } = useI18n();
  const isLoss = floatingPnL < 0;
  const pnlLabel = isLoss ? t("overview.loss") : t("overview.profit");
  const pnlClass = isLoss ? "bg-emerald-500" : "bg-red-500";

  if (total <= 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-3 text-sm text-slate-400">
        {t("overview.noInvestmentDistribution")}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
        <div
          className="bg-slate-900 transition-all"
          style={{ width: `${Math.max(costPct, cost > 0 ? 2 : 0)}%` }}
          title={t("overview.costTitle", { amount: formatMoneyYuan(cost) })}
        />
        <div
          className={`${pnlClass} transition-all`}
          style={{ width: `${Math.max(pnlPct, pnlAbs > 0 ? 2 : 0)}%` }}
          title={t("overview.pnlTitle", { label: pnlLabel, amount: formatMoneyYuan(floatingPnL) })}
        />
      </div>
      <div className="flex items-center gap-4 text-[11px] text-slate-500">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-slate-900" />
          {t("overview.holdingCost")}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className={`h-2 w-2 rounded-full ${pnlClass}`} />
          {pnlLabel}
        </span>
      </div>
    </div>
  );
}

function DailyAccountDistributionBar({ items }: { items: AssetDistItem[] }) {
  const { t } = useI18n();
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-3 text-sm text-slate-400">
        {t("overview.noDailyDistribution")}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
        {items.map((item, index) => (
          <div
            key={item.kind}
            className={`${distributionBarClass(index)} transition-all`}
            style={{ width: `${Math.max(item.pct, 2)}%` }}
            title={`${item.label}: ${formatMoneyYuan(item.value)} (${item.pct.toFixed(1)}%)`}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
        {items.map((item, index) => (
          <span key={item.kind} className="inline-flex items-center gap-1">
            <span className={`h-2 w-2 rounded-full ${distributionBarClass(index)}`} />
            <span>{item.label}</span>
            <span className="tabular-nums text-slate-400">{item.pct.toFixed(1)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function CreditBillProgressBar({
  bill,
  paid,
  compact = false,
}: {
  bill: number;
  paid: number;
  compact?: boolean;
}) {
  const safeBill = Math.max(0, bill);
  const safePaid = Math.max(0, Math.min(paid, safeBill));
  const remain = Math.max(0, safeBill - safePaid);
  const paidPct = safeBill > 0 ? (safePaid / safeBill) * 100 : 0;
  const remainPct = safeBill > 0 ? (remain / safeBill) * 100 : 0;
  const { t } = useI18n();

  if (safeBill <= 0) {
    return (
      <div className={`rounded-lg border border-dashed border-slate-200 bg-slate-50/80 text-slate-400 ${compact ? "px-3 py-2 text-xs" : "px-4 py-3 text-sm"}`}>
        {t("overview.noBillProgress")}
      </div>
    );
  }

  return (
    <div className={compact ? "space-y-1.5" : "space-y-2"}>
      <div className="flex h-3 overflow-hidden rounded-full bg-slate-100">
        <div
          className="bg-emerald-500 transition-all"
          style={{ width: `${Math.max(paidPct, safePaid > 0 ? 2 : 0)}%` }}
          title={t("overview.paidTitle", { amount: formatMoneyYuan(safePaid) })}
        />
        <div
          className="bg-amber-500 transition-all"
          style={{ width: `${Math.max(remainPct, remain > 0 ? 2 : 0)}%` }}
          title={t("overview.remainTitle", { amount: formatMoneyYuan(remain) })}
        />
      </div>
      {!compact && (
        <div className="flex items-center gap-4 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            {t("overview.currentBill")}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            {t("overview.paidAmount")}
          </span>
        </div>
      )}
    </div>
  );
}

function CashFlowCard({
  label,
  value,
  icon: Icon,
  className,
}: {
  label: string;
  value: string;
  icon: ElementType;
  className: string;
}) {
  return (
    <div className="panel-surface px-4 py-3">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{label}</span>
        <Icon className={`h-4 w-4 ${className}`} />
      </div>
      <div className={`mt-2 text-lg font-semibold tabular-nums ${className}`}>{value}</div>
    </div>
  );
}
