import { AccountKind } from "@prisma/client";
import { Banknote, Coins, CreditCard, HandCoins, Landmark, PiggyBank, Wallet } from "lucide-react";
import type { Prisma } from "@prisma/client";
import { cookies } from "next/headers";
import Link from "next/link";

import { buildAccountDisplayOption, normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { TopEntryLauncher } from "@/components/TopEntryLauncher";
import { toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { formatMoney, formatMoneyYuan } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";
import { computeAccountDisplayBalances } from "@/lib/server/account-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { ACCOUNT_LABEL_FIELDS_COOKIE, accountLabelFieldsFromCookieValue } from "@/lib/server/account-label-fields";
import { getServerT } from "@/lib/server/i18n";
import { MobileAccounts } from "@/components/mobile/MobileAccounts";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

type CurrentCreditCycle = {
  accountId: string;
  expenseAbs: Prisma.Decimal | number | string | null;
  income: Prisma.Decimal | number | string | null;
  effectiveBill: Prisma.Decimal | number | string | null;
  paid: Prisma.Decimal | number | string | null;
  cumulativeRemain: Prisma.Decimal | number | string | null;
  cumulativeOverpaid: Prisma.Decimal | number | string | null;
  dueDate: Date | null;
};

const MONEY_KINDS: AccountKind[] = [
  AccountKind.bank_debit,
  AccountKind.ewallet,
  AccountKind.cash,
  "deposit" as AccountKind,
  AccountKind.settlement,
  AccountKind.loan,
  AccountKind.other,
];
const CREDIT_KINDS: AccountKind[] = [AccountKind.bank_credit];
const KIND_ICON = {
  bank_debit: Landmark,
  ewallet: Coins,
  cash: Banknote,
  deposit: PiggyBank,
  bank_credit: CreditCard,
  settlement: HandCoins,
  loan: HandCoins,
  other: Wallet,
};

type T = (key: string, params?: Record<string, string | number>) => string;

function kindLabel(t: T, kind: string) {
  const labels: Record<string, string> = {
    bank_debit: t("account.kind.bank_debit"),
    ewallet: t("account.kind.ewallet"),
    cash: t("account.kind.cash"),
    deposit: t("account.kind.deposit"),
    bank_credit: t("account.kind.bank_credit"),
    settlement: t("account.kind.settlement"),
    loan: t("account.kind.loan"),
    other: t("account.kind.other"),
  };
  return labels[kind] ?? kind;
}

function dateLabel(t: T, date: Date | null | undefined) {
  return date ? date.toISOString().slice(0, 10) : t("accountsPage.notGenerated");
}

function neutralMoneyClass(value: number) {
  return value < 0 ? "text-slate-700" : "text-slate-900";
}

function debtMoneyClass(value: number, isRedUp: boolean) {
  return pnlClassFromRedUp(value, isRedUp, "strong");
}

function liabilityMoneyClass(value: number, isRedUp: boolean) {
  return pnlClassFromRedUp(value, isRedUp, "strong", true);
}

export default async function AccountsPage({ searchParams }: { searchParams: SearchParams }) {
  const t = await getServerT();
  const params = await searchParams;
  const tab = typeof params.tab === "string" && params.tab === "credit"
    ? "credit"
    : typeof params.tab === "string" && params.tab === "other"
      ? "other"
      : "assets";
  const ctx = await getHouseholdScope();
  const { hidFilter } = ctx;
  const cookieStore = await cookies();
  const accountLabelFields = accountLabelFieldsFromCookieValue(cookieStore.get(ACCOUNT_LABEL_FIELDS_COOKIE)?.value);
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_label_template")?.value,
    creditCardLabelMode,
  );
  const colorScheme = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") as "red_up_green_down" | "green_up_red_down";
  const isRedUp = colorScheme === "red_up_green_down";

  const [accounts, insuranceProductCount] = await Promise.all([
    prisma.account.findMany({
      where: { isActive: true, isPlaceholder: { not: true }, kind: { in: [...MONEY_KINDS, ...CREDIT_KINDS] }, ...hidFilter },
      include: { AccountGroup: true, Institution: true },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    }),
    prisma.insuranceProduct.count({ where: hidFilter }),
  ]);

  const creditIds = accounts.filter((account) => account.kind === AccountKind.bank_credit).map((account) => account.id);
  const currentCyclesPromise: Promise<CurrentCreditCycle[]> =
    creditIds.length > 0
      ? prisma.creditCardCycle.findMany({
          where: { accountId: { in: creditIds }, isCurrentCycle: true },
          select: {
            accountId: true,
            expenseAbs: true,
            income: true,
            effectiveBill: true,
            paid: true,
            cumulativeRemain: true,
            cumulativeOverpaid: true,
            dueDate: true,
          },
        })
      : Promise.resolve([]);
  const [displayBalanceByAccountId, currentCycles] = await Promise.all([
    computeAccountDisplayBalances(
      accounts
        .filter((account) => account.kind !== AccountKind.bank_credit)
        .map((account) => ({
          id: account.id,
          kind: account.kind,
          investProductType: account.investProductType,
          billingDay: account.billingDay,
        })),
      hidFilter,
    ),
    currentCyclesPromise,
  ]);
  const cycleByAccountId = new Map<string, CurrentCreditCycle>(currentCycles.map((cycle) => [cycle.accountId, cycle]));

  const moneyAccounts = accounts
    .filter((account) => MONEY_KINDS.includes(account.kind))
    .map((account) => {
      const display = buildAccountDisplayOption({
        id: account.id,
        name: account.name,
        kind: account.kind,
        numberMasked: account.numberMasked,
        groupId: account.groupId,
        investProductType: account.investProductType,
        Institution: account.Institution,
        AccountGroup: account.AccountGroup,
      }, creditCardLabelTemplate, { fields: accountLabelFields });
      return {
        id: account.id,
        name: display.label,
        hoverTitle: display.hoverTitle,
        kind: account.kind,
        groupName: account.AccountGroup?.name?.trim() || t("batchImport.ownerUnset"),
        balance: displayBalanceByAccountId.get(account.id) ?? toNumber(account.balance),
      };
    });

  const creditAccounts = accounts
    .filter((account) => account.kind === AccountKind.bank_credit)
    .map((account) => {
      const display = buildAccountDisplayOption({
        id: account.id,
        name: account.name,
        kind: account.kind,
        numberMasked: account.numberMasked,
        groupId: account.groupId,
        investProductType: account.investProductType,
        Institution: account.Institution,
        AccountGroup: account.AccountGroup,
      }, creditCardLabelTemplate, { fields: accountLabelFields });
      const cycle = cycleByAccountId.get(account.id);
      const balance = cycle
        ? creditCardDisplayBalanceFromCurrentCycle(cycle)
        : toNumber(account.balance);
      const creditLimit = toNumber(account.creditLimit);
      const currentAmount = toNumber(cycle?.expenseAbs) - toNumber(cycle?.income);
      return {
        id: account.id,
        name: display.label,
        hoverTitle: display.hoverTitle,
        kind: account.kind,
        groupName: account.AccountGroup?.name?.trim() || t("batchImport.ownerUnset"),
        balance,
        creditLimit,
        availableLimit: Math.max(0, creditLimit - Math.max(0, balance)),
        currentAmount,
        billingDay: account.billingDay,
        repaymentDay: account.repaymentDay,
        currentBill: toNumber(cycle?.effectiveBill),
        paid: toNumber(cycle?.paid),
        remain: toNumber(cycle?.cumulativeRemain),
        dueDate: cycle?.dueDate ?? null,
      };
    });

  const assetTotal = moneyAccounts
    .filter((account) => account.kind !== AccountKind.loan && account.kind !== AccountKind.settlement)
    .reduce((sum, account) => sum + account.balance, 0);
  const loanTotal = moneyAccounts
    .filter((account) => account.kind === AccountKind.loan || account.kind === AccountKind.settlement)
    .reduce((sum, account) => sum + Math.abs(Math.min(0, account.balance)), 0);
  const creditUsedTotal = creditAccounts.reduce((sum, account) => sum + Math.max(0, account.balance), 0);
  const creditLimitTotal = creditAccounts.reduce((sum, account) => sum + account.creditLimit, 0);
  const creditAvailableTotal = Math.max(0, creditLimitTotal - creditUsedTotal);
  const creditCurrentAmountTotal = creditAccounts.reduce((sum, account) => sum + account.currentAmount, 0);
  const creditBillTotal = creditAccounts.reduce((sum, account) => sum + account.currentBill, 0);

  const groupedMoneyAccounts = MONEY_KINDS.map((kind) => ({
    kind,
    label: kindLabel(t, kind),
    accounts: moneyAccounts.filter((account) => account.kind === kind),
  })).filter((group) => group.accounts.length > 0);

  return (
    <>
    <div className="h-full md:hidden">
      <MobileAccounts
        assetTotal={assetTotal}
        groups={groupedMoneyAccounts.map((group) => ({
          kind: String(group.kind),
          label: group.label,
          accounts: group.accounts.map((account) => ({ ...account, kind: String(account.kind) })),
        }))}
        creditAccounts={creditAccounts.map((account) => ({ ...account, kind: String(account.kind) }))}
        activeTab={tab}
        insuranceCount={insuranceProductCount}
        liabilityCount={moneyAccounts.filter((account) => account.kind === AccountKind.loan || account.kind === AccountKind.settlement).length}
        isRedUp={isRedUp}
      />
    </div>
    <div className="hidden h-full md:flex md:flex-col">
    <div className="flex-1 min-h-0 overflow-auto bg-slate-50">
      <header className="page-header">
        <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-2 md:px-5">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900">{t("accountsPage.title")}</div>
            <div className="text-xs text-slate-500">{t("accountsPage.subtitle")}</div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <TopEntryLauncher defaultAction="transaction" />
          </div>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 md:px-5 md:py-5">
        <section className="panel-surface overflow-hidden">
          <div className="flex flex-col gap-5 px-5 py-5 md:flex-row md:items-end md:justify-between md:px-6">
            <div className="space-y-2">
              <div className="text-xs font-medium tracking-[0.18em] text-slate-400 uppercase">{t("accountsPage.eyebrow")}</div>
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{t("accountsPage.title")}</h1>
              <p className="text-sm text-slate-500">{t("accountsPage.description")}</p>
            </div>
            <div className="grid grid-cols-2 gap-3 md:min-w-[420px]">
              <SummaryCard label={t("accountsPage.availableAssets")} value={formatMoneyYuan(assetTotal)} />
              <SummaryCard label={t("accountsPage.creditUsed")} value={formatMoneyYuan(creditUsedTotal)} />
              <SummaryCard label={t("accountsPage.creditAvailable")} value={formatMoneyYuan(creditAvailableTotal)} />
              <SummaryCard label={t("overview.debtCredit")} value={formatMoneyYuan(loanTotal)} />
            </div>
          </div>
          <div className="border-t border-slate-100 bg-slate-50/70 px-4 py-3">
            <div className="flex items-center gap-2">
              <TabLink href="/accounts" active={tab === "assets"} label={t("accountsPage.tab.assets")} />
              <TabLink href="/accounts?tab=credit" active={tab === "credit"} label={t("nav.creditCards")} />
            </div>
          </div>
        </section>

        {tab === "credit" ? (
          <section className="grid grid-cols-1 gap-4 xl:grid-cols-[0.9fr_1.2fr]">
            <div className="panel-surface">
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <CreditCard className="h-4 w-4 text-amber-500" />
                  {t("accountsPage.creditSummaryTitle")}
                </div>
                <div className="text-xs text-slate-400">{t("accountsPage.creditCardCount", { count: creditAccounts.length })}</div>
              </div>
              <div className="grid grid-cols-2 gap-3 px-4 py-4 md:grid-cols-3">
                <SummaryCard label={t("accountsPage.limitTotal")} value={formatMoneyYuan(creditLimitTotal)} compact />
                <SummaryCard label={t("accountsPage.usedLimit")} value={formatMoneyYuan(creditUsedTotal)} compact />
                <SummaryCard label={t("accountsPage.availableLimit")} value={formatMoneyYuan(creditAvailableTotal)} compact />
                <SummaryCard label={t("creditBillSummary.colNetAmount")} value={formatMoneyYuan(creditCurrentAmountTotal)} compact />
                <SummaryCard label={t("creditBill.currentBill")} value={formatMoneyYuan(creditBillTotal)} compact />
              </div>
            </div>

            <div className="panel-surface">
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <Wallet className="h-4 w-4 text-blue-500" />
                  {t("accountsPage.creditDetailTitle")}
                </div>
                <div className="text-xs text-slate-400">{t("accountsPage.creditDetailHint")}</div>
              </div>
              <div className="divide-y divide-slate-100">
                {creditAccounts.length > 0 ? (
                  creditAccounts.map((account) => (
                    <Link key={account.id} href={`/?accountId=${account.id}&view=bill`} title={account.hoverTitle} className="block px-4 py-4 hover:bg-slate-50">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-800" title={account.hoverTitle}>{account.name}</div>
                          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
                            <span className="rounded bg-slate-100 px-1.5 py-0.5">{account.groupName}</span>
                            <span>{account.billingDay ? t("settings.accounts.billingDay", { day: account.billingDay }) : t("liabilities.notSet")}</span>
                            <span>{account.repaymentDay ? t("settings.accounts.repaymentDay", { day: account.repaymentDay }) : t("liabilities.notSet")}</span>
                            <span>{t("depositShell.colMaturityDate")} {dateLabel(t, account.dueDate)}</span>
                          </div>
                        </div>
                        <div className="text-left md:text-right">
                          <div className="text-xs text-slate-400">{t("accountsPage.usedLimit")}</div>
                          <div className={`mt-1 text-sm font-semibold tabular-nums ${liabilityMoneyClass(account.balance, isRedUp)}`}>
                            {formatMoney(account.balance)}
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-5">
                        <MiniMetric label={t("settings.accounts.creditLimitLabel")} value={formatMoney(account.creditLimit)} />
                        <MiniMetric label={t("accountsPage.available")} value={formatMoney(account.availableLimit)} />
                        <MiniMetric label={t("creditBillSummary.colNetAmount")} value={formatMoney(account.currentAmount)} valueClass={liabilityMoneyClass(account.currentAmount, isRedUp)} />
                        <MiniMetric label={t("creditBill.currentBill")} value={formatMoney(account.currentBill)} valueClass={liabilityMoneyClass(account.currentBill, isRedUp)} />
                        <MiniMetric label={t("accountsPage.repayRemain")} value={formatMoney(account.remain)} valueClass={liabilityMoneyClass(account.remain, isRedUp)} />
                      </div>
                    </Link>
                  ))
                ) : (
                  <div className="px-4 py-10 text-center text-sm text-slate-400">{t("accountsPage.noCreditAccounts")}</div>
                )}
              </div>
            </div>
          </section>
        ) : (
          <section className="grid grid-cols-1 gap-4 xl:grid-cols-[0.85fr_1.25fr]">
            <div className="panel-surface">
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <Landmark className="h-4 w-4 text-blue-500" />
                  {t("accountsPage.groupSummaryTitle")}
                </div>
                <div className="text-xs text-slate-400">{t("invest.accountCount", { count: moneyAccounts.length })}</div>
              </div>
              <div className="space-y-3 px-4 py-4">
                {groupedMoneyAccounts.map((group) => {
                  const total = group.accounts.reduce((sum, account) => sum + account.balance, 0);
                  const Icon = KIND_ICON[group.kind] ?? Wallet;
                  return (
                    <div key={group.kind} className="rounded-lg border border-slate-100 bg-slate-50/80 px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white text-slate-500 shadow-sm">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium text-slate-700">{group.label}</div>
                          <div className={`text-base font-semibold tabular-nums ${group.kind === AccountKind.loan || group.kind === AccountKind.settlement ? debtMoneyClass(total, isRedUp) : neutralMoneyClass(total)}`}>{formatMoney(total)}</div>
                        </div>
                        <div className="text-xs text-slate-400">{t("settings.accounts.kindCount", { count: group.accounts.length })}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="panel-surface">
              <div className="panel-header">
                <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                  <Wallet className="h-4 w-4 text-cyan-500" />
                  {t("accountsPage.accountDetailTitle")}
                </div>
                <div className="text-xs text-slate-400">{t("accountsPage.accountDetailHint")}</div>
              </div>
              <div className="divide-y divide-slate-100">
                {moneyAccounts.length > 0 ? (
                  moneyAccounts.map((account) => {
                    const Icon = KIND_ICON[account.kind] ?? Wallet;
                    const detailView =
                      String(account.kind) === "deposit"
                        ? "deposit"
                        : account.kind === "loan" || account.kind === "settlement"
                          ? "debt"
                          : "detail";
                    return (
                      <Link key={account.id} href={`/?accountId=${account.id}&view=${detailView}`} title={account.hoverTitle} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-slate-800" title={account.hoverTitle}>{account.name}</div>
                          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
                            <span>{kindLabel(t, account.kind)}</span>
                            <span className="rounded bg-slate-100 px-1.5 py-0.5">{account.groupName}</span>
                          </div>
                        </div>
                        <div className={`shrink-0 text-sm font-semibold tabular-nums ${account.kind === AccountKind.loan || account.kind === AccountKind.settlement ? debtMoneyClass(account.balance, isRedUp) : neutralMoneyClass(account.balance)}`}>
                          {formatMoney(account.balance)}
                        </div>
                      </Link>
                    );
                  })
                ) : (
                  <div className="px-4 py-10 text-center text-sm text-slate-400">{t("accountsPage.noMoneyAccounts")}</div>
                )}
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
    </div>
    </>
  );
}

function TabLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded-lg px-4 py-2 text-sm transition-colors ${
        active
          ? "bg-white text-blue-700 shadow-sm ring-1 ring-blue-100"
          : "text-slate-500 hover:bg-white/70 hover:text-slate-700"
      }`}
    >
      {label}
    </Link>
  );
}

function SummaryCard({ label, value, compact = false }: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={`rounded-lg border border-slate-100 bg-slate-50/80 ${compact ? "px-3 py-2" : "px-4 py-3"}`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-sm font-semibold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}

function MiniMetric({ label, value, valueClass = "text-slate-800" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`mt-1 font-medium tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
