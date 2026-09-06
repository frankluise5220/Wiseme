"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  ArrowLeftRight,
  Banknote,
  ChevronDown,
  ChevronRight,
  Coins,
  CreditCard,
  HandCoins,
  Landmark,
  PiggyBank,
  Shield,
  Wallet,
} from "lucide-react";

import { formatMoneyYuan } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { useI18n } from "@/lib/i18n";

type TFunc = (key: string, params?: Record<string, string | number>) => string;

type AccountRow = {
  id: string;
  name: string;
  hoverTitle?: string;
  kind: string;
  groupName: string;
  balance: number;
};

type CreditRow = AccountRow & {
  creditLimit: number;
  availableLimit: number;
  currentBill: number;
};

type AccountGroup = {
  kind: string;
  label: string;
  accounts: AccountRow[];
};

export function MobileAccounts({
  assetTotal,
  groups,
  creditAccounts,
  activeTab,
  insuranceCount,
  liabilityCount,
  isRedUp,
}: {
  assetTotal: number;
  groups: AccountGroup[];
  creditAccounts: CreditRow[];
  activeTab: "assets" | "other" | "credit";
  insuranceCount: number;
  liabilityCount: number;
  isRedUp: boolean;
}) {
  const { t } = useI18n();
  const [hideZero, setHideZero] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const visibleGroups = useMemo(() => {
    const visibleCredit = hideZero
      ? creditAccounts.filter((account) => Math.abs(account.balance) >= 0.005 || Math.abs(account.currentBill) >= 0.005)
      : creditAccounts;
    if (activeTab === "credit") {
      return visibleCredit.length > 0 ? [{ kind: "bank_credit", label: t("account.kind.bank_credit"), accounts: visibleCredit }] : [];
    }
    if (activeTab === "other") {
      const otherGroup = groups.find((group) => group.kind === "other");
      const accounts = hideZero ? otherGroup?.accounts.filter((account) => Math.abs(account.balance) >= 0.005) : otherGroup?.accounts;
      return accounts && accounts.length > 0 ? [{ kind: "other", label: t("account.kind.other"), accounts }] : [];
    }
    return groups
      .map((group) => ({
        ...group,
        accounts: hideZero ? group.accounts.filter((account) => Math.abs(account.balance) >= 0.005) : group.accounts,
      }))
      .filter((group) => group.accounts.length > 0);
  }, [activeTab, creditAccounts, groups, hideZero, t]);

  const accountCount = visibleGroups.reduce((sum, group) => sum + group.accounts.length, 0);
  const creditTotal = creditAccounts.reduce((sum, account) => sum + Math.max(0, account.balance), 0);

  function toggleGroup(kind: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  return (
    <div className="h-full overflow-y-auto bg-slate-100 px-3 py-2">
      <div className="space-y-2.5 pb-4">
        <section className="rounded-lg bg-indigo-600 px-4 py-4 text-center text-white shadow-sm">
          <div className="text-sm font-medium text-indigo-100">{activeTab === "credit" ? t("accountsPage.creditUsed") : t("mobileAccounts.fundsTotal")}</div>
          <div className="mt-1 break-all text-[26px] font-bold text-white tabular-nums">{formatMoneyYuan(activeTab === "credit" ? creditTotal : assetTotal)}</div>
          <div className="mt-3 flex items-center justify-center gap-5 text-xs text-indigo-100">
            <span>{t("mobileAccounts.groupCount", { count: visibleGroups.length })}</span>
            <span>{t("mobileAccounts.accountCount", { count: accountCount })}</span>
          </div>
        </section>

        <div className="grid grid-cols-5 gap-2">
          <ModuleLink href="/accounts" label={t("mobileAccounts.funds")} value={formatModuleCount(groups.reduce((sum, group) => sum + group.accounts.length, 0), t)} icon="wallet" active={activeTab === "assets"} />
          <ModuleLink href="/accounts?tab=other" label={t("account.kind.other")} value={formatModuleCount(groups.find((group) => group.kind === "other")?.accounts.length ?? 0, t)} icon="other" active={activeTab === "other"} />
          <ModuleLink href="/accounts?tab=credit" label={t("account.kind.bank_credit")} value={formatModuleCount(creditAccounts.length, t)} icon="credit" active={activeTab === "credit"} />
          <ModuleLink href="/insurance" label={t("account.kind.insurance")} value={formatModuleCount(insuranceCount, t)} icon="insurance" />
          <ModuleLink href="/liabilities" label={t("nav.liabilities")} value={formatModuleCount(liabilityCount, t)} icon="liability" />
        </div>

        <label className="flex min-h-14 items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-sm">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-slate-900">{t("settings.display.hideZero")}</span>
            <span className="mt-0.5 block text-xs text-slate-500">{t("mobileAccounts.hideZeroHint")}</span>
          </span>
          <input
            type="checkbox"
            checked={hideZero}
            onChange={(event) => setHideZero(event.target.checked)}
            className="h-5 w-5 accent-indigo-600"
          />
        </label>

        {visibleGroups.length > 0 ? visibleGroups.map((group) => {
          const total = group.accounts.reduce((sum, account) => sum + account.balance, 0);
          const isCollapsed = collapsed.has(group.kind);
          return (
            <section key={group.kind} className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
              <button
                type="button"
                onClick={() => toggleGroup(group.kind)}
                className="flex min-h-16 w-full items-center gap-3 bg-slate-50 px-3 py-2 text-left"
              >
                <AccountKindIcon kind={group.kind} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-900">{group.label}</span>
                  <span className="mt-0.5 block text-xs text-slate-500">{t("mobileAccounts.accountCount", { count: group.accounts.length })}</span>
                </span>
                <span className={`shrink-0 text-sm font-semibold tabular-nums ${moneyClass(group.kind, total, isRedUp)}`}>{formatMoneyYuan(total)}</span>
                <ChevronDown size={19} className={`shrink-0 text-slate-400 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
              </button>
              {!isCollapsed ? (
                <div className="divide-y divide-slate-100">
                  {group.accounts.map((account) => {
                    return (
                      <Link
                        key={account.id}
                        href={`/accounts/${encodeURIComponent(account.id)}`}
                        title={account.hoverTitle}
                        className="flex min-h-16 items-center gap-3 px-3 py-2.5"
                      >
                        <AccountKindIcon kind={account.kind} compact />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-slate-900">{account.name}</span>
                          <span className="mt-0.5 block truncate text-xs text-slate-500">{account.groupName}</span>
                        </span>
                        <span className={`shrink-0 text-sm font-semibold tabular-nums ${moneyClass(account.kind, account.balance, isRedUp)}`}>{formatMoneyYuan(account.balance)}</span>
                        <ChevronRight size={18} className="shrink-0 text-slate-400" />
                      </Link>
                    );
                  })}
                </div>
              ) : null}
            </section>
          );
        }) : (
          <div className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-10 text-center text-sm text-slate-500">
            {t("mobileAccounts.noNonZeroAccounts")}
          </div>
        )}
      </div>
    </div>
  );
}

function ModuleLink({
  href,
  label,
  value,
  icon,
  active = false,
}: {
  href: string;
  label: string;
  value: string;
  icon: "wallet" | "other" | "credit" | "insurance" | "liability";
  active?: boolean;
}) {
  const Icon =
    icon === "credit"
      ? CreditCard
      : icon === "insurance"
        ? Shield
        : icon === "liability"
          ? ArrowLeftRight
          : icon === "other"
            ? Coins
            : Wallet;
  return (
    <Link
      href={href}
      className={`flex min-h-[72px] flex-col items-center justify-center gap-1 rounded-lg border px-1.5 text-center shadow-sm ${
        active ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 bg-white text-slate-600"
      }`}
    >
      <Icon size={19} />
      <span className="text-xs font-semibold leading-4">{label}</span>
      <span className="text-[10px] leading-3 text-slate-500">{value}</span>
    </Link>
  );
}

function formatModuleCount(value: number, t: TFunc) {
  return value > 0 ? t("overview.accountCountValue", { count: value }) : t("mobileAccounts.none");
}

function AccountKindIcon({ kind, compact = false }: { kind: string; compact?: boolean }) {
  const config = kind === "bank_debit"
    ? { icon: Landmark, className: "bg-blue-50 text-blue-700" }
    : kind === "bank_credit"
      ? { icon: CreditCard, className: "bg-rose-50 text-rose-700" }
      : kind === "ewallet"
        ? { icon: Coins, className: "bg-cyan-50 text-cyan-700" }
        : kind === "cash"
          ? { icon: Banknote, className: "bg-emerald-50 text-emerald-700" }
          : kind === "deposit"
            ? { icon: PiggyBank, className: "bg-amber-50 text-amber-700" }
            : kind === "loan" || kind === "settlement"
              ? { icon: HandCoins, className: "bg-red-50 text-red-700" }
              : { icon: Wallet, className: "bg-slate-100 text-slate-700" };
  const Icon = config.icon;
  return (
    <span className={`flex shrink-0 items-center justify-center rounded-lg ${compact ? "h-9 w-9" : "h-10 w-10"} ${config.className}`}>
      <Icon size={compact ? 18 : 20} />
    </span>
  );
}

function moneyClass(kind: string, value: number, isRedUp: boolean) {
  if (kind === "bank_credit" || ((kind === "loan" || kind === "settlement") && value < 0)) return pnlClassFromRedUp(Math.abs(value), isRedUp, "strong", true);
  return pnlClassFromRedUp(value, isRedUp, "strong");
}
