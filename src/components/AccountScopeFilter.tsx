"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";
import { investProductTypeLabel } from "@/lib/account-kinds";
import {
  FUND_COMPANY_INSTITUTION_PREFIX,
  fundCompanyInstitutionId,
  parseFundCompanyInstitutionId,
} from "@/lib/fund-company-filter";

export type StatisticsAccountItem = {
  id: string;
  name: string;
  kind?: string | null;
  investProductType?: string | null;
  label?: string;
  isPlaceholder?: boolean | null;
  groupId?: string;
  userId?: string | null;
  Institution?: { id?: string; name: string } | null;
};

export type StatisticsInstitutionItem = { id: string; name: string; type?: string | null };
export type StatisticsUserItem = { id: string; name: string };
export const CASH_INSTITUTION_ID = "__cash__";
// NOTE: `FUND_COMPANY_INSTITUTION_PREFIX` / `fundCompanyInstitutionId` /
// `parseFundCompanyInstitutionId` / `splitInstitutionSelection` are deliberately
// NOT re-exported here. Re-exporting a function from a `"use client"` module turns
// it into a client reference, so a server component importing it from here fails at
// runtime with "Attempted to call ... from the server". Import them directly from
// `@/lib/fund-company-filter` instead.

export type AccountScopeValue = {
  userIds: string[];
  institutionIds: string[];
  accountIds: string[];
};

type Props = {
  allAccounts: StatisticsAccountItem[];
  allInstitutions?: StatisticsInstitutionItem[];
  allUsers?: StatisticsUserItem[];
  showAccountFilter?: boolean;
  /** Fund company names shown as an extra group inside the institution menu. */
  fundCompanies?: string[];
  /** Subset of `fundCompanies` that no longer holds a position. Rendered as its own sub-group so the union list is not mistaken for a miscount. */
  clearedOnlyFundCompanies?: string[];
  value: AccountScopeValue;
  onChange: (next: AccountScopeValue) => void;
};

export function AccountScopeFilter({
  allAccounts,
  allInstitutions = [],
  allUsers = [],
  showAccountFilter = true,
  fundCompanies = [],
  clearedOnlyFundCompanies = [],
  value,
  onChange,
}: Props) {
  const { t } = useI18n();
  const [openMenu, setOpenMenu] = useState<"users" | "institutions" | "accounts" | null>(null);
  const menuAnchorRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const [draftUserIds, setDraftUserIds] = useState<string[]>(value.userIds);
  const [draftInstitutionIds, setDraftInstitutionIds] = useState<string[]>(value.institutionIds);
  const [draftAccountIds, setDraftAccountIds] = useState<string[]>(value.accountIds);
  const draftUserIdsRef = useRef(draftUserIds);
  const draftInstitutionIdsRef = useRef(draftInstitutionIds);
  const draftAccountIdsRef = useRef(draftAccountIds);

  const userIds = value.userIds;
  const institutionIds = value.institutionIds;
  const accountIds = value.accountIds;

  useEffect(() => {
    setDraftUserIds(value.userIds);
    setDraftInstitutionIds(value.institutionIds);
    setDraftAccountIds(value.accountIds);
  }, [value.userIds, value.institutionIds, value.accountIds]);

  // Keep refs in sync with drafts after commit so the pointerdown handler
  // (which closes the open menu) reads the latest selection. Writing refs
  // during render is not allowed by react-hooks/refs.
  useEffect(() => {
    draftUserIdsRef.current = draftUserIds;
    draftInstitutionIdsRef.current = draftInstitutionIds;
    draftAccountIdsRef.current = draftAccountIds;
  }, [draftUserIds, draftInstitutionIds, draftAccountIds]);

  const validAccounts = useMemo(() => allAccounts.filter((account) => account.name.trim() && account.isPlaceholder !== true), [allAccounts]);
  const userFilteredAccounts = useMemo(() => validAccounts.filter((account) =>
    userIds.length === 0 || (account.groupId && userIds.includes(account.groupId)),
  ), [validAccounts, userIds]);
  const fundCompanyOptions = useMemo(() => Array.from(new Set(
    fundCompanies.map((name) => name.trim()).filter((name) => name.length > 0),
  )).sort((left, right) => left.localeCompare(right, "zh-Hans-CN")).map((name) => ({
    id: fundCompanyInstitutionId(name),
    name,
    type: "fund_company" as const,
  })), [fundCompanies]);
  // Fund managers split by whether they still hold anything. A cleared-only
  // manager produces an empty holdings table, so it must be visibly separated.
  const fundCompanyGroups = useMemo(() => {
    const clearedNames = new Set(clearedOnlyFundCompanies.map((name) => name.trim()).filter(Boolean));
    const holding: typeof fundCompanyOptions = [];
    const cleared: typeof fundCompanyOptions = [];
    for (const item of fundCompanyOptions) {
      (clearedNames.has(item.name) ? cleared : holding).push(item);
    }
    return [
      { key: "holding", title: t("statistics.fundCompanyHolding"), items: holding },
      { key: "cleared", title: t("statistics.fundCompanyClearedOnly"), items: cleared },
    ].filter((group) => group.items.length > 0);
  }, [fundCompanyOptions, clearedOnlyFundCompanies, t]);
  const institutionOptions = useMemo(() => {
    const ids = new Set(userFilteredAccounts.map((account) => account.Institution?.id).filter(Boolean));
    const dedupeNames = new Set(fundCompanyOptions.map((item) => item.name));
    const options = (allInstitutions.length > 0 ? allInstitutions : Array.from(new Map(validAccounts.filter((a) => a.Institution?.id).map((a) => [a.Institution!.id!, { id: a.Institution!.id!, name: a.Institution!.name, type: null }])).values())).filter((institution) => ids.has(institution.id)
      // Names shown in the dedicated fund-company group are hidden here to avoid duplicates.
      && !(institution.type === "fund_company" && dedupeNames.has(institution.name.trim())));
    if (userFilteredAccounts.some((account) => !account.Institution?.id)) options.push({ id: CASH_INSTITUTION_ID, name: t("statistics.cashInstitution"), type: "cash" });
    return options;
  }, [validAccounts, allInstitutions, userFilteredAccounts, fundCompanyOptions, t]);
  // Fund-company selections carry no accounts of their own (they filter the
  // report rows instead), so they must not shrink the account option list.
  const realInstitutionIds = useMemo(
    () => institutionIds.filter((id) => !id.startsWith(FUND_COMPANY_INSTITUTION_PREFIX)),
    [institutionIds],
  );
  const accountOptions = useMemo(() => [...userFilteredAccounts.filter((account) =>
    realInstitutionIds.length === 0 || realInstitutionIds.some((id) => id === (account.Institution?.id ?? CASH_INSTITUTION_ID)),
  )].sort((left, right) => {
    const institutionCompare = (left.Institution?.name ?? "").localeCompare(right.Institution?.name ?? "", "zh-CN");
    if (institutionCompare !== 0) return institutionCompare;
    return (left.label ?? left.name).localeCompare(right.label ?? right.name, "zh-CN");
  }), [userFilteredAccounts, realInstitutionIds]);
  const userOptions = allUsers;

  useEffect(() => {
    if (!openMenu) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || menuAnchorRef.current?.contains(target)) return;
      const currentMenu = openMenu;
      const nextUserIds = draftUserIdsRef.current;
      const nextInstitutionIds = draftInstitutionIdsRef.current;
      const nextAccountIds = draftAccountIdsRef.current;
      if (currentMenu === "users") onChange({ userIds: nextUserIds, institutionIds, accountIds });
      if (currentMenu === "institutions") onChange({ userIds, institutionIds: nextInstitutionIds, accountIds });
      if (currentMenu === "accounts") onChange({ userIds, institutionIds, accountIds: nextAccountIds });
      setOpenMenu(null);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  // The handler intentionally reads the current draft selection when the menu closes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openMenu]);

  // The menu is rendered via createPortal to <body>, so `position: fixed` coordinates
  // are relative to the viewport. Keep them in sync with the trigger button on scroll
  // and resize (e.g. inside a sticky header that moves as the page scrolls).
  useEffect(() => {
    if (!openMenu) return;
    const activeKind = openMenu;
    function reposition() {
      positionMenu(activeKind);
    }
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [openMenu]);

  function selectSingle(kind: "users" | "institutions" | "accounts", id: string) {
    if (kind === "users") {
      const validAccountIds = accountIds.filter((accountIdValue) => allAccounts.some((account) => account.id === accountIdValue && account.groupId === id));
      setDraftUserIds([id]);
      setDraftAccountIds(validAccountIds);
      setOpenMenu(null);
      onChange({ userIds: [id], institutionIds, accountIds: validAccountIds });
    }
    if (kind === "institutions") {
      if (id.startsWith(FUND_COMPANY_INSTITUTION_PREFIX)) {
        setDraftInstitutionIds([id]);
        setOpenMenu(null);
        onChange({ userIds, institutionIds: [id], accountIds });
        return;
      }
      const validAccountIds = accountIds.filter((accountIdValue) => validAccounts.some((account) => account.id === accountIdValue && account.Institution?.id === id));
      setDraftInstitutionIds([id]);
      setDraftAccountIds(validAccountIds);
      setOpenMenu(null);
      onChange({ userIds, institutionIds: [id], accountIds: validAccountIds });
    }
    if (kind === "accounts") {
      setDraftAccountIds([id]);
      setOpenMenu(null);
      onChange({ userIds, institutionIds, accountIds: [id] });
    }
  }

  function confirm(kind: "users" | "institutions" | "accounts") {
    if (kind === "users") {
      const valid = draftAccountIds.filter((id) => allAccounts.some((account) => account.id === id && (draftUserIds.length === 0 || (account.groupId && draftUserIds.includes(account.groupId))) && (institutionIds.length === 0 || institutionIds.includes(account.Institution?.id ?? ""))));
      setDraftAccountIds(valid);
      setOpenMenu(null);
      onChange({ userIds: draftUserIds, institutionIds, accountIds: valid });
    }
    if (kind === "institutions") {
      const next = draftInstitutionIds;
      const realIds = next.filter((id) => !id.startsWith(FUND_COMPANY_INSTITUTION_PREFIX));
      const nextAccount = draftAccountIds.filter((id) => allAccounts.some((account) =>
        account.id === id && (realIds.length === 0 || realIds.includes(account.Institution?.id ?? "")) && (userIds.length === 0 || (account.groupId && userIds.includes(account.groupId))),
      ));
      setDraftAccountIds(nextAccount);
      setOpenMenu(null);
      onChange({ userIds, institutionIds: next, accountIds: nextAccount });
    }
    if (kind === "accounts") {
      setOpenMenu(null);
      onChange({ userIds, institutionIds, accountIds: draftAccountIds });
    }
  }

  function toggleDraft(kind: "users" | "institutions" | "accounts", id: string) {
    const setter = kind === "users" ? setDraftUserIds : kind === "institutions" ? setDraftInstitutionIds : setDraftAccountIds;
    setter((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  function toggleInstitutionType(type: string) {
    const ids = institutionOptions.filter((institution) => institutionGroupKey(institution.type) === type).map((institution) => institution.id);
    setDraftInstitutionIds((current) => ids.every((id) => current.includes(id))
      ? current.filter((id) => !ids.includes(id))
      : [...new Set([...current, ...ids])]);
  }

  function toggleFundCompanyGroup() {
    const ids = fundCompanyOptions.map((item) => item.id);
    setDraftInstitutionIds((current) => ids.every((id) => current.includes(id))
      ? current.filter((id) => !ids.includes(id))
      : [...new Set([...current, ...ids])]);
  }

  /** Grouping key for the account menu: investment accounts group by product
   *  category (fund/wealth/stock/property/...), everything else by account kind. */
  function accountGroupKey(account: StatisticsAccountItem) {
    if (account.kind === "investment" && account.investProductType) return `__ipt__${account.investProductType}`;
    return account.kind ?? "other";
  }

  function accountGroupLabel(type: string) {
    if (type.startsWith("__ipt__")) return investProductTypeLabel(type.slice("__ipt__".length), t);
    return t(`account.kind.${type}`);
  }

  function toggleAccountType(type: string) {
    const ids = accountOptions.filter((account) => accountGroupKey(account) === type).map((account) => account.id);
    setDraftAccountIds((current) => ids.every((id) => current.includes(id)) ? current.filter((id) => !ids.includes(id)) : [...new Set([...current, ...ids])]);
  }

  function clearSelection(kind: "users" | "institutions" | "accounts") {
    if (kind === "users") { setDraftUserIds([]); setOpenMenu(null); onChange({ userIds: [], institutionIds, accountIds }); }
    if (kind === "institutions") { setDraftInstitutionIds([]); setOpenMenu(null); onChange({ userIds, institutionIds: [], accountIds }); }
    if (kind === "accounts") { setDraftAccountIds([]); setOpenMenu(null); onChange({ userIds, institutionIds, accountIds: [] }); }
  }

  function institutionGroupKey(type: string | null | undefined) {
    if (type === "cash") return "cash";
    if (type === "bank") return "bank";
    if (type === "payment") return "payment";
    if (type === "brokerage" || type === "fund_company" || type === "investment") return "investment";
    return "other";
  }

  function institutionGroupLabel(type: string) {
    if (type === "cash") return t("statistics.cashInstitution");
    if (type === "bank") return t("institution.type.bank");
    if (type === "payment") return t("institution.type.payment");
    if (type === "investment") return t("statistics.investmentInstitutions");
    return t("institution.type.other");
  }

  function positionMenu(kind: "users" | "institutions" | "accounts") {
    const button = menuAnchorRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const menuWidth = kind === "users" ? 224 : 620;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - menuWidth - 8));
    const menuHeight = Math.min(window.innerHeight * 0.7, 520);
    const openUpward = rect.bottom + 4 + menuHeight > window.innerHeight - 8 && rect.top - 4 - menuHeight > 8;
    const top = openUpward ? rect.top - menuHeight - 4 : rect.bottom + 4;
    setMenuPosition({ left, top });
  }

  function toggleMenu(kind: "users" | "institutions" | "accounts", button: HTMLButtonElement) {
    if (openMenu === kind) {
      confirm(kind);
      return;
    }
    menuAnchorRef.current = button;
    // 在挂载弹层前先同步计算好位置，避免弹层以初始 {left:0, top:0} 闪现一帧
    // 再被 setMenuPosition 跳到正确位置。
    const rect = button.getBoundingClientRect();
    const menuWidth = kind === "users" ? 224 : 620;
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - menuWidth - 8));
    const menuHeight = Math.min(window.innerHeight * 0.7, 520);
    const openUpward = rect.bottom + 4 + menuHeight > window.innerHeight - 8 && rect.top - 4 - menuHeight > 8;
    const top = openUpward ? rect.top - menuHeight - 4 : rect.bottom + 4;
    setMenuPosition({ left, top });
    setOpenMenu(kind);
  }

  function selectionLabel(kind: "users" | "institutions" | "accounts", selected: string[]) {
    if (selected.length === 0) {
      return kind === "users" ? t("statistics.allPeople") : kind === "institutions" ? t("statistics.allInstitutions") : t("reports.allAccounts");
    }
    const labels = selected.map((id) => {
      if (kind === "users") return allUsers.find((user) => user.id === id)?.name ?? id;
      if (kind === "institutions") return institutionOptions.find((institution) => institution.id === id)?.name
        ?? fundCompanyOptions.find((item) => item.id === id)?.name
        ?? parseFundCompanyInstitutionId(id)
        ?? id;
      const account = allAccounts.find((item) => item.id === id);
      return accountLabel(account);
    });
    if ((kind === "institutions" || kind === "accounts") && labels.length > 1) {
      const key = kind === "institutions" ? "statistics.selectedInstitutionsSummary" : "statistics.selectedAccountsSummary";
      return t(key, { first: labels[0], count: labels.length });
    }
    return labels.join(", ");
  }

  function accountLabel(account: StatisticsAccountItem | StatisticsUserItem | undefined) {
    if (!account) return "";
    if (!('Institution' in account)) return account.name;
    return account.Institution?.name ? `${account.Institution.name}·${account.name}` : account.name;
  }

  const filterKinds = showAccountFilter
    ? (["users", "institutions", "accounts"] as const)
    : (["users", "institutions"] as const);

  const fundCompanyGroupBlock = fundCompanyOptions.length === 0 ? null : (
    <div className="grid grid-cols-[96px_1fr] items-start gap-2 border-b border-slate-200 py-2 last:border-b-0">
      <label className="flex min-h-7 items-center gap-1.5 px-2 text-xs font-medium text-slate-600">
        <input
          type="checkbox"
          checked={fundCompanyOptions.every((item) => draftInstitutionIds.includes(item.id))}
          onChange={toggleFundCompanyGroup}
        />
        {t("statistics.fundCompanies")}
      </label>
      <div className="space-y-1.5">
        {fundCompanyGroups.map((group) => (
          <div key={group.key}>
            <div className="px-1 pb-0.5 text-[11px] font-medium text-slate-400">
              {group.title}（{group.items.length}）
            </div>
            <div className="grid grid-cols-3 items-start gap-x-2 gap-y-1">
              {group.items.map((item) => (
                <div key={item.id} className="flex min-h-7 min-w-0 items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-slate-50">
                  <input
                    type="checkbox"
                    className="shrink-0"
                    checked={draftInstitutionIds.includes(item.id)}
                    onChange={() => toggleDraft("institutions", item.id)}
                  />
                  <button
                    type="button"
                    className={`min-w-0 flex-1 truncate text-left ${group.key === "cleared" ? "text-slate-500" : ""}`}
                    title={item.name}
                    onClick={() => selectSingle("institutions", item.id)}
                  >{item.name}</button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="flex min-w-max items-center gap-3">
      {filterKinds.map((kind) => {
        const isUsers = kind === "users";
        const isInstitutions = kind === "institutions";
        const selected = isUsers ? userIds : isInstitutions ? institutionIds : accountIds;
        const draft = isUsers ? draftUserIds : isInstitutions ? draftInstitutionIds : draftAccountIds;
        const items = isUsers ? userOptions : isInstitutions ? institutionOptions : accountOptions;
        return <div key={kind} className="relative shrink-0">
          <button type="button" title={selectionLabel(kind, selected)} aria-haspopup="listbox" aria-expanded={openMenu === kind} className="inline-flex h-8 min-w-40 max-w-56 items-center justify-between gap-2 rounded-md border border-slate-300 bg-white px-2.5 text-left text-xs text-slate-700 shadow-sm hover:border-slate-400" onClick={(event) => toggleMenu(kind, event.currentTarget)}>
            <span className="truncate">{selectionLabel(kind, selected)}</span>
            <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${openMenu === kind ? "rotate-180" : ""}`} />
          </button>
          {openMenu === kind && createPortal(<div ref={menuRef} style={{ left: menuPosition.left, top: menuPosition.top }} className={`fixed z-[100] max-h-[min(70vh,520px)] overflow-y-auto rounded-md ${isInstitutions || !isUsers ? "w-[620px]" : "w-56"} border border-slate-200 bg-white p-2 shadow-lg`}>
            <div className="mb-1 px-2 text-[11px] font-medium text-slate-500">{isUsers ? t("statistics.allPeople") : isInstitutions ? t("statistics.allInstitutions") : t("reports.allAccounts")}</div>
            <button type="button" className="absolute right-2 top-2 text-[11px] text-blue-600 hover:text-blue-800" onClick={() => clearSelection(kind)}>{t("statistics.clearSelection")}</button>
            {items.length === 0 && <div className="px-2 py-2 text-xs text-slate-400">{t("table.empty")}</div>}
            {isInstitutions ? Array.from(new Set(institutionOptions.map((institution) => institutionGroupKey(institution.type)))).map((type) => { const groupedItems = institutionOptions.filter((institution) => institutionGroupKey(institution.type) === type); return <div key={type} className="grid grid-cols-[96px_1fr] items-start gap-2 border-b border-slate-200 py-2 last:border-b-0"><label className="flex min-h-7 items-center gap-1.5 px-2 text-xs font-medium text-slate-600"><input type="checkbox" checked={groupedItems.every((institution) => draftInstitutionIds.includes(institution.id))} onChange={() => toggleInstitutionType(type)} />{institutionGroupLabel(type)}</label><div className="grid grid-cols-3 items-start gap-x-2 gap-y-1">{groupedItems.map((item) => <div key={item.id} className="flex min-h-7 min-w-0 items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-slate-50"><input type="checkbox" className="shrink-0" checked={draftInstitutionIds.includes(item.id)} onChange={() => toggleDraft("institutions", item.id)} /><button type="button" className="min-w-0 flex-1 truncate text-left" title={item.name} onClick={() => selectSingle("institutions", item.id)}>{item.name}</button></div>)}</div></div>; }) : !isUsers ? Array.from(new Set(accountOptions.map((account) => accountGroupKey(account)))).map((type) => { const groupedItems = accountOptions.filter((account) => accountGroupKey(account) === type); return <div key={type} className="grid grid-cols-[96px_1fr] items-start gap-2 border-b border-slate-200 py-2 last:border-b-0"><label className="flex min-h-7 items-center gap-1.5 px-2 text-xs font-medium text-slate-600"><input type="checkbox" checked={groupedItems.every((account) => draftAccountIds.includes(account.id))} onChange={() => toggleAccountType(type)} />{accountGroupLabel(type)}</label><div className="grid grid-cols-3 items-start gap-x-2 gap-y-1">{groupedItems.map((item) => <div key={item.id} className="flex min-h-7 min-w-0 items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-slate-50"><input type="checkbox" className="shrink-0" checked={draftAccountIds.includes(item.id)} onChange={() => toggleDraft("accounts", item.id)} /><button type="button" className="min-w-0 flex-1 truncate text-left" title={accountLabel(item)} onClick={() => selectSingle("accounts", item.id)}>{accountLabel(item)}</button></div>)}</div></div>; }) : items.map((item) => <div key={item.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50">
              <input type="checkbox" checked={draft.includes(item.id)} onChange={() => toggleDraft(kind, item.id)} />
              <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => selectSingle(kind, item.id)}>{isUsers ? (allUsers.find((user) => user.id === item.id)?.name ?? item.id) : isInstitutions ? (institutionOptions.find((institution) => institution.id === item.id)?.name ?? item.id) : accountLabel(accountOptions.find((account) => account.id === item.id))}</button>
            </div>)}
            {isInstitutions ? fundCompanyGroupBlock : null}
            <div className="sticky bottom-0 mt-1 border-t border-slate-200 bg-white pt-1.5">
              <button type="button" className="h-7 w-full rounded bg-slate-900 px-3 text-xs font-medium text-white hover:bg-slate-700" onClick={() => confirm(kind)}>{t("table.confirm")}</button>
            </div>
          </div>, document.body)}
        </div>;
      })}
    </div>
  );
}
