"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Power, PowerOff, CreditCard, Wallet, Building2, Landmark, PiggyBank, Banknote, ChevronDown, ChevronRight, X, ArrowUpDown } from "lucide-react";
import type { AccountKind } from "@prisma/client";
import { PRODUCT_TYPES, supportsCostBasisMethod } from "@/lib/investment-config";
import { kindIconName, kindColor, kindOrder } from "@/lib/account-kinds";
import { EntityCreateForm } from "@/components/EntityCreateForm";
import { FundConfirmDaysPanel } from "@/components/FundConfirmDaysModal";
import { MultiSelectFilterDropdown } from "@/components/MultiSelectFilterDropdown";
import { SmartSelect } from "@/components/SmartSelect";
import { CurrencySmartSelect } from "@/components/CurrencySmartSelect";
import {
  AccountScopeFilter,
  CASH_INSTITUTION_ID,
  type AccountScopeValue,
  type StatisticsAccountItem,
  type StatisticsInstitutionItem,
  type StatisticsUserItem,
} from "@/components/AccountScopeFilter";
import { BasicDataImportExport } from "@/components/settings/BasicDataImportExport";
import { SettingsActionButton, SettingsPageHeader, SettingsPrimaryAddButton } from "@/components/settings/SettingsPageScaffold";
import { buildAccountDisplayOption } from "@/lib/account-display";
import { getAccountLabelFieldsPreference, getCreditCardLabelTemplatePreference } from "@/lib/client/appPreferences";
import { fetchSettingsAccountData, getCachedSettingsAccountData, notifySettingsDataChanged } from "@/lib/client/settingsCache";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { getInvestmentAccountView, isDepositAccount } from "@/lib/account-kind-utils";
import { FIXED_ASSET_TYPES, isFixedAssetAccountLike } from "@/lib/fixed-asset";
import { supportsTradingCalendarForAccount, TRADING_CALENDARS } from "@/lib/fund/trading-calendar";
import { useI18n } from "@/lib/i18n";
import { normalizeCurrency } from "@/lib/currency";
import { LOAN_TYPES } from "@/lib/loan-type";
import {
  accountInstitutionTypeIsAllowed,
  accountRequiresInstitution,
  allowedInstitutionTypesForAccount,
  isConsumerLoanInstitutionType,
  isStockAccountInstitutionType,
  isStockInvestmentAccount,
} from "@/lib/account-institution-rules";

/* ---- Render icon from kindIconName ---- */
function kindIcon(k: string) {
  const map: Record<string, React.ReactNode> = {
    "credit-card": <CreditCard className="w-3.5 h-3.5" />,
    "landmark": <Landmark className="w-3.5 h-3.5" />,
    "wallet": <Wallet className="w-3.5 h-3.5" />,
    "banknote": <Banknote className="w-3.5 h-3.5" />,
    "piggy-bank": <PiggyBank className="w-3.5 h-3.5" />,
    "building-2": <Building2 className="w-3.5 h-3.5" />,
  };
  return map[kindIconName(k)] || <Building2 className="w-3.5 h-3.5" />;
}

type Group = { id: string; name: string; sortOrder: number };
type Institution = { id: string; name: string; shortName?: string | null; type?: string };
type Counterparty = { id: string; name: string; shortName?: string | null; type?: string | null };
type Account = {
  id: string; name: string; kind: AccountKind; currency: string; isActive: boolean;
  note: string | null;
  isPlaceholder?: boolean;
  institutionId: string | null; counterpartyId: string | null; groupId: string | null;
  Institution: { id: string; name: string; shortName?: string | null } | null;
  Counterparty?: { id: string; name: string; shortName?: string | null; type?: string | null } | null;
  AccountGroup: { id: string; name: string } | null;
  billingDay: number | null; repaymentDay: number | null;
  creditBillMode?: "separate" | "consolidated";
  creditLimit: string | null; numberMasked: string | null;
  investProductType: string | null; costBasisMethod: string | null;
  fundUnitsDecimals?: number | null;
  tradingCalendar?: string | null;
  fixedAssetType?: string | null;
  isConsumerLoan?: boolean | null;
  loanType?: string | null;
  debtDirection?: string | null;
  usageCount?: number;
};

const investmentProductTypeOptions = PRODUCT_TYPES
  .filter((value) => value !== "deposit")
  .map((value) => ({ value, labelKey: `investment.product.${value}` }));

function normalizedAccountKind(account: Pick<Account, "kind" | "investProductType">): string {
  if (isFixedAssetAccountLike(account)) return "fixed_asset";
  return isDepositAccount(account) ? "deposit" : account.kind;
}

function accountInstitutionTypeMatches(kind: string, investProductType: string | null | undefined, type: string | null | undefined) {
  return accountInstitutionTypeIsAllowed(kind, investProductType, type);
}

function allowedInstitutionTypesForEdit(kind: string | null | undefined, investProductType: string | null | undefined) {
  if (kind === "settlement") return [];
  return allowedInstitutionTypesForAccount(kind, investProductType);
}

const SETTINGS_ACCOUNT_KIND_OPTIONS = kindOrder;

function getAccountDetailHref(account: Account) {
  const query = new URLSearchParams();
  if (account.kind === "loan" || account.kind === "settlement") {
    // Match the sidebar's per-person debt entry instead of selecting a detail account.
    query.set("view", "debt");
    query.set("debtPerson", `account:${account.id}`);
    return `/?${query.toString()}`;
  }
  query.set("accountId", account.id);
  const detailView =
    isDepositAccount(account)
      ? "deposit"
      : account.kind === "investment"
        ? getInvestmentAccountView(account)
        : account.kind === "insurance"
          ? "insurance"
          : account.kind === "bank_credit"
            ? "bill"
            : "detail";
  query.set("view", detailView);
  return `/?${query.toString()}`;
}

export default function SettingsAccountsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const tf = (key: string, values: Record<string, string | number>) => {
    let text: string = t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
  const accountKindLabel = (kind: string) => t(`account.kind.${kind}`);
  const institutionKindLabel = (type: string | null | undefined) => t(`institution.type.${type ?? "other"}`);
  const investmentLabel = (value: string | null | undefined) => t(`investment.product.${value || "fund"}`);
  const fixedAssetTypeLabel = (value: string | null | undefined) => t(`fixedAsset.type.${value || "property"}`);
  const tradingCalendarLabel = (value: string | null | undefined) => value ? t(`tradingCalendar.${value}`) : t("settings.accounts.tradingCalendarDefault");
  type AccountSortBy = "name" | "institution" | "owner" | "lastFour";
  const SORT_OPTIONS: Record<AccountSortBy, string> = {
    name: t("settings.accounts.sortBy.name"),
    institution: t("settings.accounts.sortBy.institution"),
    owner: t("settings.accounts.sortBy.owner"),
    lastFour: t("settings.accounts.sortBy.lastFour"),
  };
  const accountSortByLabel = (key: AccountSortBy) => SORT_OPTIONS[key];
  function sortAccounts(list: Account[], by: AccountSortBy, dir: "asc" | "desc") {
    const sign = dir === "asc" ? 1 : -1;
    const get = (a: Account): string => {
      if (by === "name") return a.name;
      if (by === "institution") return a.Institution?.name || a.Institution?.shortName || "";
      if (by === "owner") return a.AccountGroup?.name || "";
      return a.numberMasked || "";
    };
    return [...list].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      return va.localeCompare(vb, "zh-Hans-CN") * sign;
    });
  }
  const [groups, setGroups] = useState<Group[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [scope, setScope] = useState<AccountScopeValue>({ userIds: [], institutionIds: [], accountIds: [] });
  const [selectedAccountKinds, setSelectedAccountKinds] = useState<string[]>([]);
  const [hideInactiveAccounts, setHideInactiveAccounts] = useState(false);
  const [baseCurrency, setBaseCurrency] = useState("CNY");
  const [accountNameQuery, setAccountNameQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editError, setEditError] = useState("");
  const [collapsedKinds, setCollapsedKinds] = useState<Set<string>>(new Set());
  const [showCreateAccount, setShowCreateAccount] = useState(false);
  const [accountSortBy, setAccountSortBy] = useState<AccountSortBy>("name");
  const [accountSortDir, setAccountSortDir] = useState<"asc" | "desc">("asc");
  const [accountSortMenuOpen, setAccountSortMenuOpen] = useState(false);
  const accountSortMenuRef = useRef<HTMLDivElement>(null);
  const guideAccountSetup = searchParams.get("guide") === "accounts";

  // Delete account with password verification
  const [deleteTarget, setDeleteTarget] = useState<{ account: Account; recordCount: number; toRecordCount: number } | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState("");

  // Merge accounts: checkbox-select 2 accounts of the same type/owner/institution
  const [mergeSelectedIds, setMergeSelectedIds] = useState<string[]>([]);
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [mergeKeepId, setMergeKeepId] = useState("");
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState("");

  // Nested creation from SmartSelect in inline edit
  const [nestedEntityType, setNestedEntityType] = useState<"institution" | "group" | "counterparty" | null>(null);

  useEffect(() => {
    const cached = getCachedSettingsAccountData();
    if (cached) {
      setGroups(cached.groups as Group[]);
      setAccounts(cached.accounts as Account[]);
      setInstitutions(cached.institutions as Institution[]);
      setCounterparties((cached.counterparties ?? []) as Counterparty[]);
      setBaseCurrency(normalizeCurrency(cached.baseCurrency));
      return;
    }
    loadAll();
  }, []);

  // Close sort menu on outside click
  useEffect(() => {
    if (!accountSortMenuOpen) return;
    const handler = (event: MouseEvent) => {
      if (accountSortMenuRef.current && !accountSortMenuRef.current.contains(event.target as Node)) {
        setAccountSortMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [accountSortMenuOpen]);

  async function loadAll(options?: { force?: boolean }) {
    const data = await fetchSettingsAccountData(options).catch(() => null);
    if (!data) return;
    setGroups(data.groups as Group[]);
    setAccounts(data.accounts as Account[]);
    setInstitutions(data.institutions as Institution[]);
    setCounterparties((data.counterparties ?? []) as Counterparty[]);
    setBaseCurrency(normalizeCurrency(data.baseCurrency));
  }

  function notifySidebarChanged() {
    dispatchFinanceDataChanged({ reason: "settings-accounts-change" });
  }

  async function refreshSettingsAccounts(reason: string) {
    void notifySettingsDataChanged({ scope: "accounts", reason, prefetch: true });
    await loadAll({ force: true });
    notifySidebarChanged();
  }

  // ---- Account handlers ----
  function openEdit(a: Account) {
    const normalizedKind = normalizedAccountKind(a);
    const editKind = normalizedKind;
    const editInvestProductType = editKind === "investment" ? (a.investProductType || "fund") : editKind === "fixed_asset" ? "property" : "";
    const supportsInstitution = allowedInstitutionTypesForEdit(editKind, editInvestProductType).length > 0;
    setEditingId(a.id);
    setEditError("");
    setEditForm({
      name: a.name,
      note: a.note || "",
      kind: editKind,
      currency: normalizeCurrency(a.currency || baseCurrency),
      groupId: a.groupId || "",
      institutionId: supportsInstitution ? a.institutionId || "" : "",
      counterpartyId: editKind === "settlement" ? a.counterpartyId || "" : "",
      billingDay: a.billingDay?.toString() || "",
      repaymentDay: a.repaymentDay?.toString() || "",
      creditLimit: a.creditLimit || "",
      creditBillMode: a.creditBillMode === "consolidated" ? "consolidated" : "separate",
      numberMasked: a.numberMasked || "",
      investProductType: editInvestProductType,
      fixedAssetType: editKind === "fixed_asset" ? (a.fixedAssetType || "property") : "",
      costBasisMethod: a.costBasisMethod || "moving_avg",
      fundUnitsDecimals: String(a.fundUnitsDecimals ?? 2),
      tradingCalendar: a.tradingCalendar || "cn_fund",
      isConsumerLoan: a.isConsumerLoan === true ? "true" : "false",
      loanType: a.loanType || (editKind === "loan" ? (a.isConsumerLoan === true ? "consumer" : "home") : ""),
    });
  }

  async function saveEdit() {
    if (!editingId) return;
    setEditError("");
    const savedId = editingId;
    const previousAccount = accounts.find((account) => account.id === savedId) ?? null;
    const nextKind = editForm.kind;
    const nextInvestProductType = editForm.investProductType || "fund";
    const nextInstitution = institutions.find((institution) => institution.id === editForm.institutionId);
    const nextCounterparty = counterparties.find((counterparty) => counterparty.id === editForm.counterpartyId);
    if (isStockInvestmentAccount(nextKind, nextInvestProductType) && (!editForm.institutionId || !isStockAccountInstitutionType(nextInstitution?.type))) {
      setEditError(t("entityForm.error.stockAccountInstitution"));
      return;
    }
    if (nextKind === "settlement" && !nextCounterparty) {
      setEditError(t("debtTx.placeholder.selectCounterparty"));
      return;
    }
    if (nextKind === "loan" && !nextInstitution) {
      setEditError(t("settings.accounts.import.institutionRequired"));
      return;
    }
    if (accountRequiresInstitution(nextKind, nextInvestProductType) && !editForm.institutionId) {
      setEditError(t("settings.accounts.import.institutionRequired"));
      return;
    }
    if (editForm.institutionId && !accountInstitutionTypeMatches(nextKind, nextInvestProductType, nextInstitution?.type)) {
      setEditError(t("settings.accounts.import.institutionNotAllowed"));
      return;
    }
    const isFixedAssetKind = nextKind === "fixed_asset";
    const isConsumerLoan = editForm.isConsumerLoan === "true";
    if (isConsumerLoan && !(nextInstitution && isConsumerLoanInstitutionType(nextInstitution.type))) {
      setEditError(t("settings.accounts.consumerLoanInstitutionRequired"));
      return;
    }
    const payload = isFixedAssetKind
      ? { ...editForm, kind: "investment", investProductType: "property", institutionId: "", counterpartyId: "", fixedAssetType: editForm.fixedAssetType || "property", isConsumerLoan: "false", loanType: "" }
      : nextKind === "settlement"
        ? { ...editForm, institutionId: "", loanType: "", isConsumerLoan: "false" }
        : nextKind === "loan"
          ? { ...editForm, counterpartyId: "", loanType: editForm.loanType || "home", isConsumerLoan: editForm.loanType === "consumer" ? "true" : "false" }
          : { ...editForm, counterpartyId: "", loanType: "", isConsumerLoan: "false" };
    const res = await fetch("/api/v1/accounts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: savedId, ...payload }),
    });
    const data = await res.json().catch(() => null) as {
      ok?: boolean;
      error?: string;
      data?: {
        affectedCreditAccountIds?: string[];
        creditCycleRuleChanged?: boolean;
      };
    } | null;
    if (!res.ok || data?.ok === false) {
      setEditError(data?.error ?? t("settings.accounts.saveFailed"));
      return;
    }
    setEditingId(null);
    const affectedCreditAccountIds = Array.isArray(data?.data?.affectedCreditAccountIds)
      ? data.data.affectedCreditAccountIds.filter((id): id is string => Boolean(id))
      : [];
    const creditRuleChanged = Boolean(data?.data?.creditCycleRuleChanged) || Boolean(
      previousAccount &&
      (
        previousAccount.kind === "bank_credit" ||
        nextKind === "bank_credit"
      ) &&
      (
        previousAccount.kind !== nextKind ||
        String(previousAccount.institutionId ?? "") !== String(editForm.institutionId ?? "") ||
        String(previousAccount.billingDay ?? "") !== String(editForm.billingDay ?? "") ||
        String(previousAccount.repaymentDay ?? "") !== String(editForm.repaymentDay ?? "") ||
        String(previousAccount.creditBillMode ?? "separate") !== String(editForm.creditBillMode ?? "separate")
      ),
    );
    if (creditRuleChanged) {
      dispatchFinanceDataChanged({
        reason: "account-credit-cycle-settings",
        accountIds: affectedCreditAccountIds.length > 0 ? affectedCreditAccountIds : [savedId],
      });
    }
    void refreshSettingsAccounts("account:update");
  }

  async function changeEditInstitution(institutionId: string) {
    setEditForm((current) => ({ ...current, institutionId }));
    if (editForm.kind !== "bank_credit" || !institutionId) return;
    const result = await fetch(`/api/v1/accounts/credit-card-defaults?institutionId=${encodeURIComponent(institutionId)}`, { cache: "no-store" })
      .then((response) => response.json())
      .catch((error) => {
        console.warn("[accounts] failed to load credit-card institution defaults", error);
        return null;
      });
    if (!result?.ok || !result.data) return;
    setEditForm((current) => current.institutionId !== institutionId ? current : ({
      ...current,
      billingDay: result.data.billingDay == null ? "" : String(result.data.billingDay),
      repaymentDay: result.data.repaymentDay == null ? "" : String(result.data.repaymentDay),
      creditBillMode: result.data.creditBillMode === "consolidated" ? "consolidated" : "separate",
    }));
  }

  async function toggleActive(id: string) {
    await fetch("/api/v1/accounts", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    void refreshSettingsAccounts("account:toggle-active");
  }

  const accountDisplayName = (account: Account) => {
    return buildAccountDisplayOption(
      {
        id: account.id,
        name: account.name,
        kind: account.kind,
        numberMasked: account.numberMasked,
        groupId: account.groupId,
        investProductType: account.investProductType,
        Institution: account.Institution,
        AccountGroup: account.AccountGroup,
      },
      getCreditCardLabelTemplatePreference(), { fields: getAccountLabelFieldsPreference() }).label;
  };

  const normalizeSearchText = (value: string | null | undefined) => value?.trim().toLowerCase() ?? "";
  const accountMatchesNameQuery = (account: Account, query: string) => {
    const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return true;
    const haystack = [
      account.name,
      accountDisplayName(account),
      account.note,
      account.numberMasked,
      account.AccountGroup?.name,
      account.Institution?.name,
      account.Institution?.shortName,
      accountKindLabel(normalizedAccountKind(account)),
      investmentLabel(account.investProductType),
      fixedAssetTypeLabel(account.fixedAssetType),
    ].map(normalizeSearchText).join(" ");
    return tokens.every((token) => haystack.includes(token));
  };

  const statisticsAccounts: StatisticsAccountItem[] = accounts.map((account) => ({
    id: account.id,
    name: account.name,
    kind: normalizedAccountKind(account),
    label: accountDisplayName(account),
    isPlaceholder: account.isPlaceholder,
    groupId: account.groupId ?? undefined,
    Institution: account.Institution
      ? {
          id: account.Institution.id || account.institutionId || undefined,
          name: account.Institution.name || account.Institution.shortName || "",
        }
      : null,
  }));
  const statisticsInstitutions: StatisticsInstitutionItem[] = institutions.map((institution) => ({
    id: institution.id,
    name: institution.shortName?.trim() || institution.name,
    type: institution.type,
  }));
  const statisticsUsers: StatisticsUserItem[] = groups.map((group) => ({
    id: group.id,
    name: group.name,
  }));
  const accountKindFilterOptions = useMemo(() => kindOrder.filter((kind) =>
    accounts.some((account) => normalizedAccountKind(account) === kind),
  ), [accounts]);

  // ---- Account merge: allow merging exactly 2 accounts with the same type,
  // same owner, and same institution (currency and, for investment/loan
  // accounts, product type / debt direction must also match). ----
  const toggleMergeSelected = (id: string) => {
    setMergeSelectedIds((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id].slice(-2));
  };

  const mergeCheck = useMemo(() => {
    if (mergeSelectedIds.length < 2) return { ok: false, reason: t("settings.accounts.merge.needTwo") };
    const [first, second] = mergeSelectedIds
      .map((id) => accounts.find((account) => account.id === id))
      .filter((account): account is Account => Boolean(account));
    if (!first || !second) return { ok: false, reason: t("settings.accounts.merge.needTwo") };
    if (normalizedAccountKind(first) !== normalizedAccountKind(second)) {
      return { ok: false, reason: t("settings.accounts.merge.hint.type") };
    }
    if (
      normalizedAccountKind(first) === "investment" &&
      (first.investProductType ?? "") !== (second.investProductType ?? "")
    ) {
      return { ok: false, reason: t("settings.accounts.merge.hint.investType") };
    }
    if ((first.kind === "loan" || first.kind === "settlement") && (first.debtDirection ?? "") !== (second.debtDirection ?? "")) {
      return { ok: false, reason: t("settings.accounts.merge.hint.debtDirection") };
    }
    if ((first.groupId ?? "") !== (second.groupId ?? "")) {
      return { ok: false, reason: t("settings.accounts.merge.hint.owner") };
    }
    if ((first.institutionId ?? "") !== (second.institutionId ?? "")) {
      return { ok: false, reason: t("settings.accounts.merge.hint.institution") };
    }
    if (normalizeCurrency(first.currency || baseCurrency) !== normalizeCurrency(second.currency || baseCurrency)) {
      return { ok: false, reason: t("settings.accounts.merge.hint.currency") };
    }
    return { ok: true, reason: t("settings.accounts.merge.hint.same") };
  }, [accounts, mergeSelectedIds, baseCurrency, t]);

  const mergeSelectedAccounts = mergeSelectedIds
    .map((id) => accounts.find((account) => account.id === id))
    .filter((account): account is Account => Boolean(account));

  async function submitMerge(keepId: string, mergeId: string) {
    setMergeBusy(true);
    setMergeError("");
    try {
      const res = await fetch("/api/v1/accounts/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keepId, mergeId }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || data?.ok === false) {
        setMergeError(data?.error || t("settings.accounts.merge.failed"));
        return;
      }
      setMergeModalOpen(false);
      setMergeSelectedIds([]);
      window.alert(t("settings.accounts.merge.success"));
      void refreshSettingsAccounts("account:merge");
    } finally {
      setMergeBusy(false);
    }
  }

  const filteredAccounts = accounts.filter(a => {
    if (scope.userIds.length > 0 && !scope.userIds.includes(a.groupId ?? "")) return false;
    if (scope.institutionIds.length > 0) {
      const institutionKey = a.Institution?.id ?? a.institutionId ?? CASH_INSTITUTION_ID;
      if (!scope.institutionIds.includes(institutionKey)) return false;
    }
    if (scope.accountIds.length > 0 && !scope.accountIds.includes(a.id)) return false;
    if (selectedAccountKinds.length > 0 && !selectedAccountKinds.includes(normalizedAccountKind(a))) return false;
    if (hideInactiveAccounts && !a.isActive) return false;
    if (!accountMatchesNameQuery(a, accountNameQuery)) return false;
    return true;
  });

  // Group accounts by kind for display
  const grouped = new Map<string, Account[]>();
  for (const a of filteredAccounts) {
    const normalizedKind = normalizedAccountKind(a);
    const list = grouped.get(normalizedKind) || [];
    list.push(a);
    grouped.set(normalizedKind, list);
  }

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        sticky
        title={t("settings.accounts.title")}
        description={guideAccountSetup ? t("settings.accounts.guideDescription") : t("settings.accounts.description")}
        count={filteredAccounts.length}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <BasicDataImportExport
              groups={statisticsUsers}
              institutions={institutions}
              counterparties={counterparties}
              baseCurrency={baseCurrency}
              onImported={() => void refreshSettingsAccounts("account:import")}
            />
            <SettingsPrimaryAddButton onClick={() => setShowCreateAccount(true)}>{t("settings.accounts.add")}</SettingsPrimaryAddButton>
          </div>
        }
        toolbar={
          <>
          <div className="w-64 max-w-full">
            <input
              value={accountNameQuery}
              onChange={(event) => setAccountNameQuery(event.target.value)}
              placeholder={t("settings.accounts.searchPlaceholder")}
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
            />
          </div>
          <AccountScopeFilter
            allAccounts={statisticsAccounts}
            allInstitutions={statisticsInstitutions}
            allUsers={statisticsUsers}
            value={scope}
            onChange={setScope}
            showAccountFilter={false}
          />
          <MultiSelectFilterDropdown
            options={accountKindFilterOptions}
            selectedValues={selectedAccountKinds}
            onChange={setSelectedAccountKinds}
            labelFor={accountKindLabel}
            allLabel={t("settings.accounts.type")}
            selectedSummaryLabel={(first, count) => t("settings.accounts.selectedTypesSummary", { first, count })}
            clearLabel={t("statistics.clearSelection")}
            emptyLabel={t("table.empty")}
            renderOptionLeading={(kind) => (
              <span className={`inline-flex shrink-0 items-center gap-1.5 rounded border px-1.5 py-0.5 font-semibold ${kindColor(kind)}`}>
                {kindIcon(kind)}
              </span>
            )}
          />
          <label className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-600 shadow-sm">
            <input
              type="checkbox"
              checked={hideInactiveAccounts}
              onChange={(event) => setHideInactiveAccounts(event.target.checked)}
              className="h-3.5 w-3.5 accent-blue-600"
            />
            <span>{t("settings.accounts.hideInactiveAccounts")}</span>
          </label>
          <div ref={accountSortMenuRef} className="relative">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setAccountSortMenuOpen(o => !o); }}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs text-slate-600 shadow-sm hover:bg-slate-50"
            >
              <ArrowUpDown className="h-3.5 w-3.5 shrink-0" />
              <span>{accountSortByLabel(accountSortBy)}</span>
            </button>
            {accountSortMenuOpen && (
              <div className="absolute right-0 top-full mt-1 z-30 min-w-[140px] rounded-md border border-slate-200 bg-white shadow-md">
                {(Object.keys(SORT_OPTIONS) as AccountSortBy[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      if (accountSortBy === key) {
                        setAccountSortDir(d => d === "asc" ? "desc" : "asc");
                      } else {
                        setAccountSortBy(key);
                        setAccountSortDir("asc");
                      }
                      setAccountSortMenuOpen(false);
                    }}
                    className={`w-full px-3 py-2 text-left text-xs hover:bg-slate-50 ${accountSortBy === key ? "font-medium text-blue-600" : "text-slate-700"}`}
                  >
                    {accountSortByLabel(key)}
                    {accountSortBy === key && (
                      <span className="ml-1">{accountSortDir === "asc" ? "↑" : "↓"}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          </>
        }
      />

      {/* ===== Account list (grouped by kind, collapsible) ===== */}
      {kindOrder.map(kind => {
        const list = grouped.get(kind);
        if (!list || list.length === 0) return null;
        const collapsed = collapsedKinds.has(kind);
        return (
          <div key={kind} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <button onClick={() => setCollapsedKinds(prev => { const s = new Set(prev); if (s.has(kind)) s.delete(kind); else s.add(kind); return s; })}
              className="w-full px-4 py-3 border-b border-slate-100 flex items-center justify-between cursor-pointer hover:bg-slate-50/50 transition-colors">
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-semibold ${kindColor(kind)}`}>
                  <span className="shrink-0">{kindIcon(kind)}</span>
                  <span>{accountKindLabel(kind)}</span>
                </span>
                <span className="text-xs text-slate-500">{tf("settings.accounts.kindCount", { count: list.length })}</span>
              </div>
              {collapsed ? <ChevronRight className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
            </button>
            {!collapsed && (
            <div className="divide-y divide-slate-100">
              {sortAccounts(list, accountSortBy, accountSortDir).map(a => (
                  /* ---- View mode ---- */
                  <div
                    key={a.id}
                    className={`px-4 py-2.5 flex items-center justify-between transition-colors ${a.isPlaceholder ? "opacity-40 bg-slate-50" : !a.isActive ? "opacity-60" : ""}`}
                  >
                    <label
                      className="flex shrink-0 cursor-pointer items-center self-center pr-2"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }}
                    >
                      <input
                        type="checkbox"
                        checked={mergeSelectedIds.includes(a.id)}
                        onChange={(event) => { event.stopPropagation(); toggleMergeSelected(a.id); }}
                        onClick={(event) => event.stopPropagation()}
                        className="h-3.5 w-3.5 accent-blue-600"
                        aria-label={t("settings.accounts.merge.action")}
                      />
                    </label>
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      {a.isPlaceholder ? (
                        <span className="text-sm font-medium text-slate-800 truncate">{accountDisplayName(a)}</span>
                      ) : (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void router.push(getAccountDetailHref(a));
                          }}
                          className="min-w-0 max-w-full truncate rounded text-left text-sm font-medium text-slate-800 hover:text-blue-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
                        >
                          {accountDisplayName(a)}
                        </button>
                      )}
                      {a.isPlaceholder && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-slate-300 bg-slate-100 text-slate-400">{t("settings.accounts.placeholder")}</span>
                      )}
                      {a.isConsumerLoan && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-700">{t("account.kind.consumer_loan")}</span>
                      )}
                      {a.AccountGroup && (
                        <span className="text-xs px-1.5 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-slate-600">{a.AccountGroup.name}</span>
                      )}
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${a.isActive ? "bg-emerald-50 text-emerald-600 border-emerald-200" : "bg-slate-100 text-slate-400 border-slate-200"}`}>
                        {a.isActive ? t("common.enabled") : t("common.disabled")}
                      </span>
                      {normalizedAccountKind(a) === "investment" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-purple-200 bg-purple-50 text-purple-700">
                          {investmentLabel(a.investProductType)}
                        </span>
                      )}
                      {normalizedAccountKind(a) === "investment" && (a.investProductType ?? "fund") === "fund" && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-slate-600">
                          {tf("settings.accounts.unitsDecimals", { count: a.fundUnitsDecimals ?? 2 })}
                        </span>
                      )}
                      {supportsTradingCalendarForAccount(normalizedAccountKind(a), a.investProductType) && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-slate-600">
                          {tradingCalendarLabel(a.tradingCalendar ?? "cn_fund")}
                        </span>
                      )}
                      {(normalizedAccountKind(a) === "bank_credit" || normalizedAccountKind(a) === "bank_debit") && (
                        <>
                          {normalizedAccountKind(a) === "bank_credit" && a.billingDay && <span className="text-[10px] text-slate-400">{tf("settings.accounts.billingDay", { day: a.billingDay })}</span>}
                          {normalizedAccountKind(a) === "bank_credit" && a.repaymentDay && <span className="text-[10px] text-slate-400">{tf("settings.accounts.repaymentDay", { day: a.repaymentDay })}</span>}
                          {normalizedAccountKind(a) === "bank_credit" && a.creditLimit && <span className="text-[10px] text-slate-400">{tf("settings.accounts.creditLimit", { amount: a.creditLimit })}</span>}
                          {a.numberMasked && <span className="text-[10px] text-slate-400">{tf("settings.accounts.lastFour", { value: a.numberMasked })}</span>}
                          {normalizedAccountKind(a) === "bank_credit" && <span className="text-[10px] text-slate-400">{a.creditBillMode === "consolidated" ? t("settings.accounts.consolidatedBill") : t("settings.accounts.separateBill")}</span>}
                        </>
                      )}
                      {a.note && (
                        <span className="max-w-[260px] truncate text-xs text-slate-400" title={a.note}>{t("settings.accounts.notePrefix")}{a.note}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-3">
                      {!a.isPlaceholder && (
                      <SettingsActionButton
                        label={a.isActive ? t("common.disabled") : t("common.enabled")}
                        icon={a.isActive ? <PowerOff className="w-3.5 h-3.5" /> : <Power className="w-3.5 h-3.5" />}
                        onClick={(event) => { event.stopPropagation(); toggleActive(a.id); }}
                      />
                      )}
                      {!a.isPlaceholder && (
                      <SettingsActionButton
                        label={t("common.edit")}
                        variant="edit"
                        onClick={(event) => { event.stopPropagation(); openEdit(a); }}
                      />
                      )}
                      <SettingsActionButton
                        label={t("common.delete")}
                        variant="delete"
                        onClick={async (event) => {
                          event.stopPropagation();
                          if (!confirm(tf("settings.accounts.deleteConfirm", { name: a.name }))) return;
                          const res = await fetch(`/api/v1/accounts?id=${a.id}`, { method: "DELETE" });
                          const data = await res.json();
                          if (data.ok) {
                            void refreshSettingsAccounts("account:delete");
                            return;
                          }
                          if (data.needPassword) {
                            setDeleteTarget({
                              account: a,
                              recordCount: Number(data.recordCount ?? 0),
                              toRecordCount: Number(data.toRecordCount ?? 0),
                            });
                            setDeletePassword("");
                            setDeleteError("");
                            return;
                          }
                          window.alert(data.error);
                        }}
                      />
                    </div>
                  </div>
              ))}
            </div>
            )}
          </div>
        );
      })}

      {filteredAccounts.length === 0 && (
        <div className="bg-white border border-slate-200 rounded-xl py-12 text-center text-sm text-slate-400">
          {t("settings.accounts.empty")}
        </div>
      )}

      <EntityCreateForm
        mode="full"
        layout="modal"
        entityType="account"
        open={showCreateAccount}
        onClose={() => setShowCreateAccount(false)}
        fieldData={{
          groupId: groups,
          institutionId: institutions.map((institution) => ({
            id: institution.id,
            name: institution.shortName?.trim() || institution.name,
            type: institution.type,
          })),
          counterpartyId: counterparties.map((counterparty) => ({
            id: counterparty.id,
            name: counterparty.shortName?.trim() || counterparty.name,
            type: counterparty.type ?? undefined,
          })),
        }}
        includeInitialBalanceFields={guideAccountSetup}
        defaultCurrency={baseCurrency}
        onCreated={() => {
          setShowCreateAccount(false);
          void refreshSettingsAccounts("account:create");
        }}
        existingNames={accounts.map(a => a.name)}
      />

      {/* Nested creation modals from SmartSelect in inline edit */}
      {nestedEntityType && (
        <EntityCreateForm
          mode="compact"
          entityType={nestedEntityType}
          open={true}
          onClose={() => setNestedEntityType(null)}
          onCreated={(id, name, extra) => {
            if (nestedEntityType === "institution") {
              setInstitutions(prev => [...prev, { id, name, shortName: extra?.institutionShortName ?? null, type: extra?.type }]);
              setEditForm(f => accountInstitutionTypeMatches(f.kind || "other", f.investProductType || "fund", extra?.type) ? { ...f, institutionId: id } : f);
            } else if (nestedEntityType === "counterparty") {
              setCounterparties(prev => [...prev, { id, name, shortName: null, type: extra?.type ?? null }]);
              setEditForm(f => ({ ...f, counterpartyId: id }));
            } else if (nestedEntityType === "group") {
              setGroups(prev => [...prev, { id, name, sortOrder: prev.length }]);
              setEditForm(f => ({ ...f, groupId: id }));
            }
            void refreshSettingsAccounts(
              nestedEntityType === "institution"
                ? "institution:create-nested"
                : nestedEntityType === "counterparty"
                  ? "counterparty:create-nested"
                  : "account-group:create-nested",
            );
            setNestedEntityType(null);
          }}
          defaultType={
            nestedEntityType !== "institution" ? undefined
              : isStockInvestmentAccount(editForm.kind, editForm.investProductType || "fund") ? "brokerage"
              : editForm.kind === "investment" && (["fund", "money"].includes(editForm.investProductType || "fund")) ? "fund_company"
              : editForm.kind === "loan" ? "bank"
              : allowedInstitutionTypesForEdit(editForm.kind, editForm.investProductType || "fund").length === 1 ? allowedInstitutionTypesForEdit(editForm.kind, editForm.investProductType || "fund")[0]
              : undefined
          }
          allowedInstitutionTypes={
            nestedEntityType !== "institution" ? undefined
              : isStockInvestmentAccount(editForm.kind, editForm.investProductType || "fund") ? ["brokerage"]
              : editForm.kind === "loan" ? ["bank", "payment", "other"]
              : allowedInstitutionTypesForEdit(editForm.kind, editForm.investProductType || "fund").length > 0 ? allowedInstitutionTypesForEdit(editForm.kind, editForm.investProductType || "fund")
              : undefined
          }
        />
      )}

      {/* ===== Merge selection bar (bottom floating) ===== */}
      {mergeSelectedIds.length > 0 && (
        <div className="fixed bottom-6 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-full border border-slate-200 bg-white px-4 py-2 shadow-lg">
          <span className="shrink-0 text-xs font-medium text-slate-700">
            {tf("settings.accounts.merge.selected", { count: mergeSelectedIds.length })}
          </span>
          {mergeSelectedIds.length === 2 && (
            <span className={`shrink-0 text-xs ${mergeCheck.ok ? "text-emerald-600" : "text-amber-600"}`}>{mergeCheck.reason}</span>
          )}
          <button
            type="button"
            disabled={!mergeCheck.ok}
            onClick={() => { setMergeKeepId(mergeSelectedIds[0] ?? ""); setMergeError(""); setMergeModalOpen(true); }}
            className="h-7 shrink-0 rounded-full bg-blue-600 px-3 text-xs font-medium text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
          >
            {t("settings.accounts.merge.action")}
          </button>
          <button
            type="button"
            onClick={() => setMergeSelectedIds([])}
            className="h-7 shrink-0 rounded-full border border-slate-200 px-3 text-xs text-slate-600 transition hover:bg-slate-50"
          >
            {t("settings.accounts.merge.clear")}
          </button>
        </div>
      )}

      {/* ===== Merge confirm modal ===== */}
      {mergeModalOpen && mergeSelectedAccounts.length === 2 && (() => {
        const [first, second] = mergeSelectedAccounts;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[1px] p-4"
            onMouseDown={() => { if (!mergeBusy) setMergeModalOpen(false); }}>
            <div className="w-[420px] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white shadow-xl p-4"
              onMouseDown={e => e.stopPropagation()}>
              <div className="text-sm font-semibold text-slate-800 mb-1">{t("settings.accounts.merge.title")}</div>
              <div className="text-xs text-slate-500 mb-3">{t("settings.accounts.merge.desc")}</div>
              <div className="mb-1.5 text-xs font-medium text-slate-600">{t("settings.accounts.merge.chooseName")}</div>
              <div className="space-y-2">
                {[first, second].map((account) => {
                  const isKeep = mergeKeepId === account.id;
                  return (
                    <label key={account.id}
                      className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-colors ${isKeep ? "border-blue-300 bg-blue-50/60" : "border-slate-200 bg-white hover:bg-slate-50"}`}
                      onClick={() => setMergeKeepId(account.id)}
                    >
                      <input
                        type="radio"
                        name="merge-keep-account"
                        checked={isKeep}
                        onChange={() => setMergeKeepId(account.id)}
                        className="h-3.5 w-3.5 accent-blue-600"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{accountDisplayName(account)}</span>
                      <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border ${isKeep ? "border-blue-200 bg-blue-50 text-blue-600" : "border-slate-200 bg-slate-50 text-slate-500"}`}>
                        {isKeep ? t("settings.accounts.merge.keepLabel") : t("settings.accounts.merge.mergedLabel")}
                      </span>
                    </label>
                  );
                })}
              </div>
              {mergeError && <div className="text-xs text-red-500 mt-2">{mergeError}</div>}
              <div className="flex justify-end gap-2 mt-4">
                <button type="button" disabled={mergeBusy}
                  onClick={() => setMergeModalOpen(false)}
                  className="h-8 px-3 rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-60">
                  {t("common.cancel")}
                </button>
                <button type="button" disabled={mergeBusy || !mergeKeepId}
                  onClick={() => {
                    const mergeId = mergeSelectedIds.find((id) => id !== mergeKeepId) ?? "";
                    if (mergeKeepId && mergeId) void submitMerge(mergeKeepId, mergeId);
                  }}
                  className="h-8 px-3 rounded-md bg-blue-600 text-white text-xs font-medium hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60">
                  {mergeBusy ? "..." : t("settings.accounts.merge.confirm")}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Password confirmation dialog for deleting account with records */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[1px] p-4"
          onMouseDown={() => { setDeleteTarget(null); setDeleteError(""); }}>
          <div className="w-[340px] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white shadow-xl p-4"
            onMouseDown={e => e.stopPropagation()}>
            <div className="text-sm font-semibold text-slate-800 mb-1">{t("settings.accounts.passwordTitle")}</div>
            <div className="text-xs text-slate-500 mb-3">
              {tf("settings.accounts.passwordDesc", {
                name: deleteTarget.account.name,
                recordCount: deleteTarget.recordCount,
                linkedCount: deleteTarget.toRecordCount,
              })}
            </div>
            <input
              type="password"
              value={deletePassword}
              onChange={e => { setDeletePassword(e.target.value); setDeleteError(""); }}
              onKeyDown={async e => {
                if (e.key === "Enter") {
                  const res = await fetch(`/api/v1/accounts?id=${deleteTarget.account.id}`, {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ password: deletePassword }),
                  });
                  const data = await res.json();
                  if (data.ok) {
                    setDeleteTarget(null);
                    void refreshSettingsAccounts("account:delete-with-password");
                  }
                  else setDeleteError(data.error);
                }
              }}
              placeholder={t("settings.accounts.passwordPlaceholder")}
              autoFocus
              className="h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-blue-400"
            />
            {deleteError && <div className="text-xs text-red-500 mt-1">{deleteError}</div>}
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => { setDeleteTarget(null); setDeleteError(""); }}
                className="h-8 px-3 rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50">{t("common.cancel")}</button>
              <button onClick={async () => {
                const res = await fetch(`/api/v1/accounts?id=${deleteTarget.account.id}`, {
                  method: "DELETE",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ password: deletePassword }),
                });
                const data = await res.json();
                if (data.ok) {
                  setDeleteTarget(null);
                  void refreshSettingsAccounts("account:delete-with-password");
                }
                else setDeleteError(data.error);
              }}
                className="h-8 px-3 rounded-md bg-red-600 text-white text-xs hover:bg-red-700">{t("settings.accounts.confirmDelete")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Account edit modal */}
      {editingId && (() => {
        const editingAccount = accounts.find((account) => account.id === editingId);
        if (!editingAccount) return null;
        const normalizedKind = normalizedAccountKind(editingAccount);
        const editKind = (editForm.kind || normalizedKind) as AccountKind | "fixed_asset";
        const isFixedAssetKind = editKind === "fixed_asset";
        const isInvestmentKind = editKind === "investment" || isFixedAssetKind;
        const editInvestProductType = editForm.investProductType || (isFixedAssetKind ? "property" : "fund");
        const showCostBasisMethod = isInvestmentKind && supportsCostBasisMethod(editInvestProductType);
        const isBillLikeKind = editKind === "bank_credit";
        const supportsLastFour = editKind === "bank_credit" || editKind === "bank_debit";
        const editKindOptions = SETTINGS_ACCOUNT_KIND_OPTIONS;
        const supportsInstitution = allowedInstitutionTypesForEdit(editKind, editInvestProductType).length > 0;
        const isConsumerLoanEdit = editForm.loanType === "consumer" || editForm.isConsumerLoan === "true";
        const filteredInstitutions = institutions.filter((institution) =>
          isConsumerLoanEdit && editKind === "loan"
            ? isConsumerLoanInstitutionType(institution.type)
            : accountInstitutionTypeMatches(editKind, editInvestProductType, institution.type),
        );
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4 backdrop-blur-[1px]"
            onMouseDown={() => { setEditingId(null); setEditError(""); }}>
            <div className="max-h-[90vh] w-[720px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-xl"
              onMouseDown={e => e.stopPropagation()}>
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm font-semibold text-slate-800">{t("settings.accounts.editTitle", { name: editingAccount.name })}</div>
                <button type="button" onClick={() => { setEditingId(null); setEditError(""); }}
                  className="h-8 w-8 rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-50" aria-label={t("table.close")}>
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.name")}</label>
                  <input value={editForm.name || ""} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                    className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-blue-400" />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.type")}</label>
                  <select
                    value={editKind}
                    onChange={e => {
                      const nextKind = e.target.value;
                      setEditForm(f => {
                        const nextLoanType = nextKind === "loan" ? (f.loanType || "home") : "";
                        return {
                          ...f,
                          kind: nextKind,
                          institutionId: "",
                          counterpartyId: "",
                          loanType: nextLoanType,
                          isConsumerLoan: nextKind === "loan" && nextLoanType === "consumer" ? "true" : "false",
                          investProductType: nextKind === "investment" ? (f.investProductType || "fund") : nextKind === "fixed_asset" ? "property" : "",
                          fixedAssetType: nextKind === "fixed_asset" ? (f.fixedAssetType || "property") : "",
                        };
                      });
                    }}
                    className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none"
                  >
                    {editKindOptions.map((value) => (
                      <option key={value} value={value}>{t(`account.kind.${value}`)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.owner")}</label>
                  <SmartSelect mode="single" value={editForm.groupId || ""}
                    onChange={id => setEditForm(f => ({ ...f, groupId: id }))}
                    options={groups.map(g => ({ id: g.id, label: g.name }))}
                    placeholder={t("settings.accounts.selectOwner")}
                    onCreateClick={() => setNestedEntityType("group")} createLabel={t("settings.accounts.addOwner")} />
                </div>
                {supportsInstitution && (
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.institution")}</label>
                    <SmartSelect mode="single" value={editForm.institutionId || ""}
                      onChange={changeEditInstitution}
                      options={filteredInstitutions.map(i => ({
                        id: i.id,
                        label: i.shortName?.trim() || i.name,
                        subLabel: [i.shortName?.trim() ? i.name : "", institutionKindLabel(i.type)].filter(Boolean).join(" · "),
                      }))}
                      placeholder={t("settings.accounts.selectInstitution")}
                      onCreateClick={() => setNestedEntityType("institution")} createLabel={t("settings.accounts.addInstitution")} />
                  </div>
                )}
                {editKind === "settlement" && (
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("txForm.counterparty")}</label>
                    <SmartSelect mode="single" value={editForm.counterpartyId || ""}
                      onChange={id => setEditForm(f => ({ ...f, counterpartyId: id }))}
                      options={counterparties.map((counterparty) => ({
                        id: counterparty.id,
                        label: counterparty.shortName?.trim() || counterparty.name,
                        subLabel: counterparty.type ? institutionKindLabel(counterparty.type) : undefined,
                      }))}
                      placeholder={t("debtTx.placeholder.selectCounterparty")}
                      onCreateClick={() => setNestedEntityType("counterparty")} createLabel={t("txForm.addCounterparty")} />
                  </div>
                )}
                <div>
                  <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.currency")}</label>
                  <CurrencySmartSelect
                    value={normalizeCurrency(editForm.currency || baseCurrency)}
                    onChange={(code) => setEditForm((f) => ({ ...f, currency: code }))}
                    labelSystem={(code) => t(`entityForm.currency.${code.toLowerCase()}`, { defaultValue: code })}
                  />
                </div>
                {isInvestmentKind && (
                  isFixedAssetKind ? (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("fixedAssetEdit.assetType")}</label>
                      <select
                        value={editForm.fixedAssetType || "property"}
                        onChange={e => setEditForm(f => ({ ...f, fixedAssetType: e.target.value }))}
                        className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none"
                      >
                        {FIXED_ASSET_TYPES.map((value) => (
                          <option key={value} value={value}>{t(`fixedAsset.type.${value}`)}</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.investmentAccountType")}</label>
                      <select value={editInvestProductType} onChange={e => setEditForm(f => {
                        const nextInvestProductType = e.target.value;
                        const selectedInstitution = institutions.find((institution) => institution.id === f.institutionId);
                        return {
                          ...f,
                          investProductType: nextInvestProductType,
                          ...(isStockInvestmentAccount(editKind, nextInvestProductType) && selectedInstitution && !isStockAccountInstitutionType(selectedInstitution.type) ? { institutionId: "" } : {}),
                        };
                      })}
                        className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none">
                        {investmentProductTypeOptions.map((item) => <option key={item.value} value={item.value}>{investmentLabel(item.value)}</option>)}
                      </select>
                    </div>
                  )
                )}
              </div>

              {editKind === "loan" && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.loanType")}</label>
                    <select
                      value={editForm.loanType || "home"}
                      onChange={e => setEditForm(f => ({ ...f, loanType: e.target.value, isConsumerLoan: e.target.value === "consumer" ? "true" : "false" }))}
                      className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none"
                    >
                      {LOAN_TYPES.map((value) => (
                        <option key={value} value={value}>{t(`loan.type.${value}`)}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {isInvestmentKind && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                  {showCostBasisMethod && (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.costBasisMethod")}</label>
                      <select value={editForm.costBasisMethod || "moving_avg"} onChange={e => setEditForm(f => ({ ...f, costBasisMethod: e.target.value }))}
                        className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none">
                        <option value="moving_avg">{t("settings.accounts.movingAverage")}</option>
                        <option value="fifo">{t("settings.accounts.fifo")}</option>
                        <option value="lifo">{t("settings.accounts.lifo")}</option>
                      </select>
                    </div>
                  )}
                  {editInvestProductType === "fund" && (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.fundUnitsDecimals")}</label>
                      <input
                        value={editForm.fundUnitsDecimals || "2"}
                        onChange={e => setEditForm(f => ({ ...f, fundUnitsDecimals: e.target.value }))}
                        className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none"
                        inputMode="numeric"
                        placeholder={t("settings.accounts.defaultUnitsDecimals")}
                      />
                    </div>
                  )}
                  {supportsTradingCalendarForAccount(editKind, editInvestProductType) && (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.tradingCalendar")}</label>
                      <select
                        value={editForm.tradingCalendar || "cn_fund"}
                        onChange={e => setEditForm(f => ({ ...f, tradingCalendar: e.target.value }))}
                        className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none"
                      >
                        {TRADING_CALENDARS.map((calendar) => (
                          <option key={calendar} value={calendar}>{t(`tradingCalendar.${calendar}`)}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

              {supportsLastFour && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
                  {isBillLikeKind && (
                    <>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.billingDayLabel")}</label>
                        <input value={editForm.billingDay || ""} onChange={e => setEditForm(f => ({ ...f, billingDay: e.target.value }))}
                          className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" placeholder="1-31" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.repaymentDayLabel")}</label>
                        <input value={editForm.repaymentDay || ""} onChange={e => setEditForm(f => ({ ...f, repaymentDay: e.target.value }))}
                          className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" placeholder="1-31" />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.creditLimitLabel")}</label>
                        <input value={editForm.creditLimit || ""} onChange={e => setEditForm(f => ({ ...f, creditLimit: e.target.value }))}
                          className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" />
                      </div>
                    </>
                  )}
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.lastFourLabel")}</label>
                    <input value={editForm.numberMasked || ""} onChange={e => setEditForm(f => ({ ...f, numberMasked: e.target.value }))}
                      className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none" />
                  </div>
                  {isBillLikeKind && (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.billMode")}</label>
                      <select
                        value={editForm.creditBillMode || "separate"}
                        onChange={e => setEditForm(f => ({ ...f, creditBillMode: e.target.value }))}
                        className="h-8 w-full rounded-md border border-slate-200 px-2 text-sm outline-none"
                      >
                        <option value="separate">{t("settings.accounts.separateBill")}</option>
                        <option value="consolidated">{t("settings.accounts.consolidatedBill")}</option>
                      </select>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-3">
                <label className="block text-xs text-slate-500 mb-1">{t("settings.accounts.note")}</label>
                <textarea
                  value={editForm.note || ""}
                  onChange={e => setEditForm(f => ({ ...f, note: e.target.value }))}
                  className="min-h-[96px] w-full resize-y rounded-md border border-slate-200 px-2 py-2 text-sm leading-5 outline-none focus:border-blue-400"
                  placeholder={t("settings.accounts.notePlaceholder")}
                  rows={4}
                />
              </div>

              {isInvestmentKind && editInvestProductType === "fund" ? (
                <div className="mt-4">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-xs font-medium text-slate-600">{t("fundRules.title")}</span>
                    <span className="text-[11px] text-slate-400">{t("fundConfirmDays.embeddedHint")}</span>
                  </div>
                  <FundConfirmDaysPanel
                    accountId={editingAccount.id}
                    compact
                    onSaved={() => {
                      dispatchFinanceDataChanged({ reason: "fund-confirm-days:save", accountIds: [editingAccount.id] });
                    }}
                  />
                </div>
              ) : null}

              <div className="mt-4 flex justify-end gap-2 border-t border-slate-100 pt-3">
                {editError && <div className="text-xs text-red-600">{editError}</div>}
                <button onClick={() => { setEditingId(null); setEditError(""); }}
                  className="h-8 px-3 rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-50">{t("common.cancel")}</button>
                <button onClick={saveEdit}
                  className="h-8 px-4 rounded-md bg-blue-600 text-white text-xs hover:bg-blue-700">{t("common.save")}</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
