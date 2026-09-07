"use client";

import { useEffect, useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import {
  AccountScopeFilter,
  type AccountScopeValue,
  type StatisticsAccountItem,
  type StatisticsInstitutionItem,
  type StatisticsUserItem,
} from "@/components/AccountScopeFilter";

export function InvestmentProfitFilterSelect({
  selectedUserIds,
  selectedInstitutionIds,
  selectedAccountIds,
  allUsers,
  allInstitutions,
  allAccounts,
  fundCompanies,
  clearedOnlyFundCompanies,
  baseParams,
}: {
  selectedUserIds: string[];
  selectedInstitutionIds: string[];
  selectedAccountIds: string[];
  allUsers: StatisticsUserItem[];
  allInstitutions: StatisticsInstitutionItem[];
  allAccounts: StatisticsAccountItem[];
  fundCompanies?: string[];
  /** Subset of `fundCompanies` without any current holding; rendered as a separate group. */
  clearedOnlyFundCompanies?: string[];
  baseParams: Record<string, string>;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const [isPending, startTransition] = useTransition();
  const [scope, setScope] = useState<AccountScopeValue>({
    userIds: selectedUserIds,
    institutionIds: selectedInstitutionIds,
    accountIds: selectedAccountIds,
  });

  // Keep the local draft in sync when URL-derived selections change (e.g.
  // switching period via the links above drops unapplied drafts).
  useEffect(() => {
    setScope({
      userIds: selectedUserIds,
      institutionIds: selectedInstitutionIds,
      accountIds: selectedAccountIds,
    });
  }, [selectedUserIds, selectedInstitutionIds, selectedAccountIds]);

  function buildHref(next: AccountScopeValue) {
    const query = new URLSearchParams();
    Object.entries(baseParams).forEach(([key, value]) => query.set(key, value));
    // The scope selection is owned by the local draft. baseParams may carry the
    // scope keys from the current URL (e.g. the picker base params), so drop
    // them before applying the draft — otherwise clearing a selection would
    // immediately re-apply the stale URL value on refresh.
    query.delete("userIds");
    query.delete("institutionIds");
    query.delete("investmentAccounts");
    if (next.userIds.length) query.set("userIds", next.userIds.join(","));
    if (next.institutionIds.length) query.set("institutionIds", next.institutionIds.join(","));
    if (next.accountIds.length) query.set("investmentAccounts", next.accountIds.join(","));
    return `/reports${query.toString() ? `?${query.toString()}` : ""}`;
  }

  function handleChange(next: AccountScopeValue) {
    // Only update the local draft here. The cascading option lists inside
    // AccountScopeFilter follow these values; the report itself recomputes
    // only when the user clicks the refresh button (applyFilters).
    setScope(next);
  }

  function applyFilters() {
    if (isPending) return;
    startTransition(async () => {
      // Best-effort cache bust for server-side cached reports (same as
      // ReportRefreshButton, which this button replaces on these views).
      await fetch("/api/v1/settings/revalidate", { method: "POST" }).catch(() => null);
      const href = buildHref(scope);
      if (href === `${window.location.pathname}${window.location.search}`) {
        router.refresh();
      } else {
        router.push(href, { scroll: false });
      }
    });
  }

  return (
    <>
      <AccountScopeFilter
        allAccounts={allAccounts}
        allInstitutions={allInstitutions}
        allUsers={allUsers}
        fundCompanies={fundCompanies}
        clearedOnlyFundCompanies={clearedOnlyFundCompanies}
        value={scope}
        onChange={handleChange}
      />
      <button
        type="button"
        onClick={applyFilters}
        disabled={isPending}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 hover:bg-blue-50 hover:text-blue-700 disabled:opacity-60"
        title={t("reports.refresh")}
      >
        <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
        {t("reports.refresh")}
      </button>
    </>
  );
}
