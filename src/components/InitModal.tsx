"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, Plus, Trash2, Database, TrendingUp } from "lucide-react";
import { DateStepper } from "./DateStepper";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { NestedAddModal } from "./EntityCreateForm";
import { ModalLayerProvider, getNextModalLayerZIndex, useModalLayerZIndex } from "./ModalLayer";
import { kindLabel } from "@/lib/account-kinds";
import { buildAccountDisplayOption } from "@/lib/account-display";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";
import { getAccountLabelFieldsPreference } from "@/lib/client/appPreferences";
import { restrictAccountsByType } from "@/lib/client/account-dropdown-filter";

/* Types */

type AccountOption = { id: string; label: string; kind: string };
type EntityOption = { id: string; name: string; type?: string };
type CashAccountOption = { id: string; label: string };
type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;

type AccountBalanceRow = {
  tempId: string;
  accountId: string;
  label: string;
  kind: string;
  balance: string;
  date: string;
};

type FundHoldingRow = {
  tempId: string;
  investmentAccountId: string;
  investmentAccountLabel: string;
  fundCode: string;
  lastLookupFundCode: string;
  fundName: string;
  fundNav: string;
  fundNavDate: string;
  units: string;
  avgCost: string;
  lastBuyDate: string;
  arrivalDate: string;
  historicalProfit: string;
  cashAccountId: string;
  hasRegularInvest: boolean;
  riAmount: string;
  riIntervalUnit: string;
  riIntervalValue: string;
  riWeekday: string;
  riCashAccountId: string;
  riTxDate: string;
  riConfirmDate: string;
  riTPlusN: string;
  riArrivalDate: string;
  riFeeRate: string;
};

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function InitModal({
  open,
  onOpenChange,
  initialTab = "balance",
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialTab?: "balance" | "fund";
}) {
  const [tab, setTab] = useState<"balance" | "fund">("balance");
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();
  const parentModalZIndex = useModalLayerZIndex();
  const modalZIndex = getNextModalLayerZIndex(parentModalZIndex);
  const [message, setMessage] = useState<{ ok: boolean; text: string; details?: string[] } | null>(null);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [allAccounts, setAllAccounts] = useState<AccountOption[]>([]);
  const [accountGroups, setAccountGroups] = useState<EntityOption[]>([]);
  const [institutions, setInstitutions] = useState<EntityOption[]>([]);
  const [cashAccountList, setCashAccountList] = useState<CashAccountOption[]>([]);
  const [investmentAccountList, setInvestmentAccountList] = useState<AccountOption[]>([]);
  const [investSSOptions, setInvestSSOptions] = useState<SmartSelectOption[]>([]);
  const [cashSSOptions, setCashSSOptions] = useState<SmartSelectOption[]>([]);
  const [balanceRows, setBalanceRows] = useState<AccountBalanceRow[]>([]);
  const [fundRows, setFundRows] = useState<FundHoldingRow[]>([]);
  const [activeInvestAccountIds, setActiveInvestAccountIds] = useState<string[]>([]);
  const [currentInvestAccountId, setCurrentInvestAccountId] = useState("");
  const [addInvestAccountId, setAddInvestAccountId] = useState("");
  const [investNestedOpen, setInvestNestedOpen] = useState(false);
  const [balanceNestedOpen, setBalanceNestedOpen] = useState(false);
  const pendingInvestCreateFromAccountId = useRef("");
  const pendingBalanceCreateRowId = useRef("");
  const tempIdCounter = useRef(0);

  function rebuildSSOptions(accounts: AccountOption[], investAccounts: AccountOption[]) {
    setCashSSOptions(restrictAccountsByType(accounts, (a) => ["cash", "bank_debit", "ewallet"].includes(a.kind)).map((a) => ({ id: a.id, label: a.label, subLabel: kindLabel(a.kind) })));
    setInvestSSOptions(investAccounts.map((a) => ({ id: a.id, label: a.label, subLabel: kindLabel(a.kind) })));
  }

  async function fetchAccounts() {
    setLoadingAccounts(true);
    try {
      const res = await fetch("/api/v1/accounts/internal?balances=false");
      const data = await res.json();
      if (data.ok && data.accounts) {
        const accounts: AccountOption[] = data.accounts.map((a: any) => {
          const display = buildAccountDisplayOption(a, undefined, { fields: getAccountLabelFieldsPreference() });
          return { id: a.id, label: display.selectorLabel || display.label, kind: a.kind };
        });
        const cashAccounts = restrictAccountsByType(accounts, (a) => ["cash", "bank_debit", "ewallet"].includes(a.kind));
        const investAccounts = restrictAccountsByType(accounts, (a) => a.kind === "investment");
        setAllAccounts(accounts);
        setAccountGroups((data.groups ?? []).map((g: any) => ({ id: g.id, name: g.name })));
        setInstitutions((data.institutions ?? []).map((it: any) => ({ id: it.id, name: it.name, type: it.type ?? undefined })));
        setCashAccountList(cashAccounts.map((a) => ({ id: a.id, label: a.label })));
        setInvestmentAccountList(investAccounts);
        rebuildSSOptions(accounts, investAccounts);
        setBalanceRows((prev) => prev);
        setActiveInvestAccountIds((prev) => prev.length > 0 ? prev : (investAccounts[0]?.id ? [investAccounts[0].id] : []));
        setCurrentInvestAccountId((prev) => prev || investAccounts[0]?.id || "");
      }
      setAccountsLoaded(true);
    } catch {
      setAccountsLoaded(true);
    } finally {
      setLoadingAccounts(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    setBusy(false);
    setTab(initialTab);
    if (!accountsLoaded) {
      fetchAccounts();
    }
  }, [open, accountsLoaded, initialTab]);

  function createEmptyFundRow(defaultAcc?: AccountOption): FundHoldingRow {
    tempIdCounter.current += 1;
    const txDate = todayStr();
    const defaultArrival = new Date(`${txDate}T00:00:00`);
    defaultArrival.setDate(defaultArrival.getDate() + 2);
    const defaultArrivalStr = defaultArrival.toISOString().slice(0, 10);
    return {
      tempId: `new-${tempIdCounter.current}`,
      investmentAccountId: defaultAcc?.id ?? "",
      investmentAccountLabel: defaultAcc?.label ?? "",
      fundCode: "", lastLookupFundCode: "", fundName: "", fundNav: "", fundNavDate: "",
      units: "", avgCost: "", lastBuyDate: "",
      arrivalDate: todayStr(), historicalProfit: "", cashAccountId: "",
      hasRegularInvest: false, riAmount: "", riIntervalUnit: "month", riIntervalValue: "1", riWeekday: "1",
      riCashAccountId: cashAccountList[0]?.id ?? "", riTxDate: txDate,
      riConfirmDate: txDate, riTPlusN: "", riArrivalDate: defaultArrivalStr, riFeeRate: "",
    };
  }

  function addFundRow(investmentAccountId?: string) {
    const defaultAcc = investmentAccountList.find((a) => a.id === investmentAccountId) ?? investmentAccountList[0];
    setFundRows((prev) => [...prev, createEmptyFundRow(defaultAcc)]);
  }

  function createEmptyBalanceRow(): AccountBalanceRow {
    tempIdCounter.current += 1;
    return { tempId: `balance-${tempIdCounter.current}`, accountId: "", label: "", kind: "", balance: "", date: todayStr() };
  }

  function addBalanceRow() {
    setBalanceRows((prev) => [...prev, createEmptyBalanceRow()]);
  }

  function updateBalanceRow(tempId: string, upd: Partial<AccountBalanceRow>) {
    setBalanceRows((prev) => prev.map((row) => (row.tempId === tempId ? { ...row, ...upd } : row)));
  }

  function selectBalanceAccount(tempId: string, accountId: string) {
    if (!accountId) return;
    const target = allAccounts.find((account) => account.id === accountId && account.kind !== "investment");
    if (!target) return;
    setBalanceRows((prev) => prev.map((row) => (
      row.tempId === tempId
        ? { ...row, accountId: target.id, label: target.label, kind: target.kind }
        : row
    )));
  }

  function handleBalanceAccountCreated(id: string, name: string, extra?: { kind?: string }) {
    const kind = extra?.kind || "bank_debit";
    const newAcc: AccountOption = { id, label: name, kind };
    const updatedAllAccounts = [...allAccounts, newAcc];
    const updatedInvest = kind === "investment" ? [...investmentAccountList, newAcc] : investmentAccountList;
    setAllAccounts(updatedAllAccounts);
    setInvestmentAccountList(updatedInvest);
    rebuildSSOptions(updatedAllAccounts, updatedInvest);
    if (kind !== "investment") {
      const pendingRowId = pendingBalanceCreateRowId.current;
      setBalanceRows((prev) => (
        pendingRowId
          ? prev.map((row) => (row.tempId === pendingRowId ? { ...row, accountId: id, label: name, kind } : row))
          : [...prev, { tempId: `balance-created-${id}`, accountId: id, label: name, kind, balance: "", date: todayStr() }]
      ));
    }
    pendingBalanceCreateRowId.current = "";
    setBalanceNestedOpen(false);
  }

  function startInvestAccountInitFlow(account: AccountOption) {
    setActiveInvestAccountIds((prev) => (prev.includes(account.id) ? prev : [...prev, account.id]));
    setCurrentInvestAccountId(account.id);
    setAddInvestAccountId("");
    setFundRows((prev) => {
      if (prev.some((row) => row.investmentAccountId === account.id)) return prev;
      return [...prev, createEmptyFundRow(account)];
    });
  }

  function removeFundRow(tempId: string) {
    setFundRows((prev) => prev.filter((r) => r.tempId !== tempId));
  }

  function removeInvestAccountFromInit(accountId: string) {
    if (activeInvestAccountIds.length <= 1) return;
    const nextIds = activeInvestAccountIds.filter((id) => id !== accountId);
    setActiveInvestAccountIds(nextIds);
    setCurrentInvestAccountId((prev) => (prev === accountId ? nextIds[0] ?? "" : prev));
    setFundRows((prev) => prev.filter((row) => row.investmentAccountId !== accountId));
    setAddInvestAccountId((prev) => (prev === accountId ? "" : prev));
  }

  function updateFundRow(tempId: string, upd: Partial<FundHoldingRow>) {
    setFundRows((prev) => prev.map((r) => (r.tempId === tempId ? { ...r, ...upd } : r)));
  }

  function fundRowHasContent(row: FundHoldingRow) {
    return Boolean(
      row.fundCode.trim() ||
      row.units.trim() ||
      row.avgCost.trim() ||
      row.historicalProfit.trim() ||
      row.hasRegularInvest
    );
  }

  function switchInvestAccountBlock(fromAccountId: string, toAccountId: string) {
    if (!toAccountId || fromAccountId === toAccountId) return;
    const target = investmentAccountList.find((account) => account.id === toAccountId);
    if (!target) return;
    const oldRows = fundRows.filter((row) => row.investmentAccountId === fromAccountId);
    if (oldRows.some(fundRowHasContent)) return;

    setActiveInvestAccountIds((prev) => {
      const next = prev.map((id) => (id === fromAccountId ? toAccountId : id));
      if (!next.includes(toAccountId)) next.push(toAccountId);
      return next.filter((id, index) => next.indexOf(id) === index);
    });
    setCurrentInvestAccountId(toAccountId);
    setFundRows((prev) => prev.map((row) => (
      row.investmentAccountId === fromAccountId
        ? { ...row, investmentAccountId: target.id, investmentAccountLabel: target.label }
        : row
    )));
  }

  function openInvestAccountCreate(fromAccountId?: string) {
    pendingInvestCreateFromAccountId.current = fromAccountId ?? "";
    setInvestNestedOpen(true);
  }

  function handleInvestAccountCreated(id: string, name: string) {
    const newAcc: AccountOption = { id, label: name, kind: "investment" };
    const updatedAllAccounts = [...allAccounts, newAcc];
    const updatedInvest = [...investmentAccountList, newAcc];
    setAllAccounts(updatedAllAccounts);
    setInvestmentAccountList(updatedInvest);
    rebuildSSOptions(updatedAllAccounts, updatedInvest);
    const fromAccountId = pendingInvestCreateFromAccountId.current;
    const oldRows = fromAccountId ? fundRows.filter((row) => row.investmentAccountId === fromAccountId) : [];
    if (fromAccountId && !oldRows.some(fundRowHasContent)) {
      setActiveInvestAccountIds((prev) => {
        const next = prev.map((accountId) => (accountId === fromAccountId ? id : accountId));
        if (!next.includes(id)) next.push(id);
        return next.filter((accountId, index) => next.indexOf(accountId) === index);
      });
      setCurrentInvestAccountId(id);
      setAddInvestAccountId("");
      setFundRows((prev) => {
        const hasRows = prev.some((row) => row.investmentAccountId === fromAccountId);
        if (!hasRows) return [...prev, createEmptyFundRow(newAcc)];
        return prev.map((row) => (
          row.investmentAccountId === fromAccountId
            ? { ...row, investmentAccountId: id, investmentAccountLabel: name }
            : row
        ));
      });
    } else {
      startInvestAccountInitFlow(newAcc);
    }
    pendingInvestCreateFromAccountId.current = "";
    setInvestNestedOpen(false);
  }

  function addInvestAccountToInit(accountId: string) {
    if (!accountId) return;
    const target = investmentAccountList.find((account) => account.id === accountId);
    if (!target) return;
    startInvestAccountInitFlow(target);
  }

  async function handleSubmit() {
    setBusy(true); setMessage(null);
    try {
      const accountBalances = balanceRows.filter((r) => r.accountId && r.balance.trim() && parseFloat(r.balance) !== 0).map((r) => ({ accountId: r.accountId, balance: parseFloat(r.balance), date: r.date || todayStr() }));
      const duplicateFundMap = new Map<string, string[]>();
      for (const row of fundRows) {
        const fundCode = row.fundCode.trim();
        const investmentAccountId = row.investmentAccountId || currentInvestAccountId;
        if (!fundCode || !investmentAccountId) continue;
        const key = `${investmentAccountId}::${fundCode}`;
        const labels = duplicateFundMap.get(key) ?? [];
        labels.push(row.investmentAccountLabel || fundCode);
        duplicateFundMap.set(key, labels);
      }
      const duplicateKeys = [...duplicateFundMap.entries()].filter(([, labels]) => labels.length > 1).map(([key]) => key);
      if (duplicateKeys.length > 0) {
        const duplicateDetails = duplicateKeys.map((key) => {
          const [investmentAccountId, fundCode] = key.split("::");
          const accountLabel = investmentAccountList.find((account) => account.id === investmentAccountId)?.label ?? t("initModal.unnamedInvestAccount");
          return t("initModal.alert.duplicateFundDetail", { account: accountLabel, code: fundCode });
        });
        setMessage({ ok: false, text: t("initModal.alert.duplicateFund"), details: duplicateDetails });
        setBusy(false);
        return;
      }
      const fundHoldings = fundRows.filter((r) => r.fundCode.trim()).map((r) => ({
        fundCode: r.fundCode.trim(),
        units: parseFloat(r.units) || 0,
        avgCost: parseFloat(r.avgCost) || 0,
        lastBuyDate: r.lastBuyDate || undefined,
        arrivalDate: r.arrivalDate || undefined,
        historicalProfit: parseFloat(r.historicalProfit) || 0,
        investmentAccountId: r.investmentAccountId || currentInvestAccountId,
        cashAccountId: r.cashAccountId || undefined,
        regularInvest: r.hasRegularInvest ? {
          amount: parseFloat(r.riAmount) || 0, intervalUnit: r.riIntervalUnit, intervalValue: parseInt(r.riIntervalValue) || 1,
          cashAccountId: r.riCashAccountId, txDate: r.riTxDate || undefined, confirmDate: r.riConfirmDate || undefined,
          tPlusN: r.riConfirmDate && r.riTxDate ? Math.max(0, Math.round((new Date(r.riConfirmDate).getTime() - new Date(r.riTxDate).getTime()) / 86400000)) : undefined,
          arrivalDate: r.riArrivalDate || undefined, feeRate: r.riFeeRate ? parseFloat(r.riFeeRate) : undefined,
        } : undefined,
      })).filter((r) => r.units > 0 && r.avgCost > 0);
      if (accountBalances.length === 0 && fundHoldings.length === 0) {
        setMessage({ ok: false, text: t("initModal.alert.atLeastOne") }); setBusy(false); return;
      }
      const res = await fetch("/api/v1/init", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accountBalances, fundHoldings }) });
      const data = await res.json();
      if (!data.ok) setMessage({ ok: false, text: data.error ?? t("initModal.alert.initFailed") });
      else { setMessage({ ok: true, text: data.message, details: data.details }); dispatchFinanceDataChanged({ reason: "initial-data" }); }
    } catch (e) { setMessage({ ok: false, text: e instanceof Error ? e.message : t("initModal.alert.initFailed") }); }
    finally { setBusy(false); }
  }

  const activeInvestmentAccounts = useMemo(
    () => investmentAccountList.filter((account) => activeInvestAccountIds.includes(account.id)),
    [investmentAccountList, activeInvestAccountIds],
  );
  const accountNestedFieldData = useMemo(() => ({
    groupId: accountGroups
      .filter((group) => group.id && group.name)
      .map((group) => ({ id: group.id, name: group.name })),
    institutionId: institutions
      .filter((institution) => institution.id && institution.name)
      .map((institution) => ({ id: institution.id, name: institution.name, type: institution.type })),
  }), [accountGroups, institutions]);
  // Local copy of nested option data so newly created institutions/groups persist
  // across account-dialog instances within this modal.
  const [localNestedFieldData, setLocalNestedFieldData] = useState<NestedFieldData | undefined>(accountNestedFieldData);

  // Keep local nested option data in sync when the server-provided data changes.
  useEffect(() => {
    if (accountNestedFieldData) setLocalNestedFieldData(accountNestedFieldData);
  }, [accountNestedFieldData]);

  async function fillFundRowFromCode(tempId: string, accountId: string, rawCode: string) {
    const fundCode = rawCode.trim();
    const currentRow = fundRows.find((row) => row.tempId === tempId);
    if (currentRow?.lastLookupFundCode === fundCode) return;
    if (!/^\d{6}$/.test(fundCode)) {
      updateFundRow(tempId, { fundCode: rawCode, lastLookupFundCode: "", fundName: "", fundNav: "", fundNavDate: "" });
      return;
    }

    updateFundRow(tempId, { fundCode: rawCode, fundName: "", fundNav: "", fundNavDate: "" });

    try {
      const [nameRes, positionRes] = await Promise.allSettled([
        fetch(`/api/v1/fund/name?code=${fundCode}`).then((r) => r.json()),
        accountId
          ? fetch(`/api/v1/fund/position?accountId=${encodeURIComponent(accountId)}&fundCode=${encodeURIComponent(fundCode)}`).then((r) => r.json())
          : Promise.resolve({ ok: false, error: t("initModal.alert.missingInvestAccount") }),
      ]);

      const nextPatch: Partial<FundHoldingRow> = {};

      if (nameRes.status === "fulfilled" && nameRes.value?.ok) {
        nextPatch.fundName = nameRes.value.name ?? "";
        nextPatch.fundNav = nameRes.value.nav == null ? "" : String(nameRes.value.nav);
        nextPatch.fundNavDate = nameRes.value.navDate ?? "";
      }

      if (positionRes.status === "fulfilled" && positionRes.value?.ok) {
        nextPatch.fundName = nextPatch.fundName || positionRes.value.fundName || "";
        nextPatch.avgCost = positionRes.value.avgCost == null ? "" : String(positionRes.value.avgCost);
        nextPatch.units = positionRes.value.units == null ? "" : String(positionRes.value.units);
        nextPatch.historicalProfit = positionRes.value.historicalProfit == null ? "" : String(positionRes.value.historicalProfit);
        if (!nextPatch.fundNav && positionRes.value.nav != null && Number(positionRes.value.nav) > 0) {
          nextPatch.fundNav = String(positionRes.value.nav);
        }
      }

      updateFundRow(tempId, { ...nextPatch, lastLookupFundCode: fundCode });
    } catch {
      // ignore lookup failure, keep manual editing available
    }
  }

  const addableInvestSSOptions = useMemo(
    () => investSSOptions.filter((option) => !activeInvestAccountIds.includes(option.id)),
    [investSSOptions, activeInvestAccountIds],
  );

  const balanceAccountSSOptions = useMemo(
    () => restrictAccountsByType(allAccounts, (account) => account.kind !== "investment")
      .map((account) => ({ id: account.id, label: account.label, subLabel: kindLabel(account.kind) })),
    [allAccounts],
  );

  const currentFundRows = useMemo(
    () => fundRows.filter((row) => row.investmentAccountId === currentInvestAccountId),
    [fundRows, currentInvestAccountId],
  );

  const canAddAnotherInvestAccount = useMemo(
    () => currentFundRows.some(fundRowHasContent),
    [currentFundRows],
  );

  function getBalanceAccountSSOptions(row: AccountBalanceRow) {
    return balanceAccountSSOptions.filter((option) => (
      option.id === row.accountId ||
      !balanceRows.some((other) => other.tempId !== row.tempId && other.accountId === option.id)
    ));
  }

  function handleClose() { if (!busy) onOpenChange(false); }

  // Called when a nested institution/group is created inside an account dialog.
  // Keep the shared nested option data fresh so subsequent account dialogs can
  // select the newly created entity.
  function handleNestedOptionCreated(id: string, name: string, extra?: { kind?: string; type?: string }) {
    setLocalNestedFieldData((prev) => {
      const base = prev ?? accountNestedFieldData ?? {};
      if (extra?.type !== undefined) {
        const existing = base.institutionId ?? [];
        if (existing.some((item) => item.id === id)) return base;
        return { ...base, institutionId: [...existing, { id, name, type: extra.type }] };
      }
      const existing = base.groupId ?? [];
      if (existing.some((item) => item.id === id)) return base;
      return { ...base, groupId: [...existing, { id, name }] };
    });
  }

  if (!open) return null;

  return (
    <ModalLayerProvider value={modalZIndex}>
    {typeof document !== "undefined" && createPortal(
    <>
    <style>{`.init-modal-dropdown .smartselect-dropdown { z-index: 9999 !important; }
      .init-modal-number::-webkit-outer-spin-button,
      .init-modal-number::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      .init-modal-number { appearance: textfield; -moz-appearance: textfield; }`}</style>
    <div className="fixed inset-0 flex items-center justify-center bg-black/35 p-4 overflow-auto" style={{ zIndex: modalZIndex }}>
      <div className="w-full max-w-6xl rounded-xl bg-white border border-slate-200 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="shrink-0 px-5 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="text-base font-bold text-slate-800">📦 {t("nav.initialData")}</div>
          <button onClick={handleClose} disabled={busy} className="h-8 w-8 rounded-md border border-slate-200 bg-white flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 disabled:opacity-40"><X className="w-4 h-4" /></button>
        </div>
        <div className="shrink-0 flex border-b border-slate-200 bg-slate-50/50">
          <button onClick={() => { setTab("balance"); setMessage(null); }} className={`flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === "balance" ? "border-blue-600 text-blue-700 bg-white" : "border-transparent text-slate-500 hover:text-slate-700"}`}><Database className="w-4 h-4" />{t("initModal.tab.balance")}</button>
          <button onClick={() => { setTab("fund"); setMessage(null); }} className={`flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${tab === "fund" ? "border-blue-600 text-blue-700 bg-white" : "border-transparent text-slate-500 hover:text-slate-700"}`}><TrendingUp className="w-4 h-4" />{t("initModal.tab.fund")}</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {tab === "balance" && (
            <div className="space-y-3">
              <div className="init-balance-toolbar flex items-center justify-between gap-3">
                <p className="text-xs text-slate-500">{t("initModal.balanceIntro")}</p>
                <button onClick={addBalanceRow} className="inline-flex items-center gap-1 h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 shrink-0"><Plus className="w-4 h-4" />{t("settings.accounts.add")}</button>
              </div>
              {loadingAccounts && !accountsLoaded ? <p className="text-sm text-slate-400 py-6 text-center">{t("initModal.loadingAccounts")}</p> : balanceRows.length === 0 ? <p className="text-sm text-slate-400 py-6 text-center">{t("initModal.emptyAccounts")}</p> : (
                <table className="w-full border-separate border-spacing-0">
                  <thead><tr className="text-xs font-semibold text-slate-600">
                    <th className="text-left px-3 py-2 border-b border-slate-200">{t("common.account")}</th>
                    <th className="text-left px-3 py-2 border-b border-slate-200">{t("settings.accounts.type")}</th>
                    <th className="text-right px-3 py-2 border-b border-slate-200">{t("initModal.col.balance")}</th>
                    <th className="text-left px-3 py-2 border-b border-slate-200">{t("detail.column.date")}</th>
                  </tr></thead>
                  <tbody>{balanceRows.map((row) => {
                    const kl = row.kind ? (row.kind === "bank_debit" ? t("account.kind.bank_debit") : row.kind === "bank_credit" ? t("account.kind.bank_credit") : row.kind === "cash" ? t("account.kind.cash") : row.kind === "loan" ? t("account.kind.loan") : row.kind === "settlement" ? t("account.kind.settlement") : row.kind === "ewallet" ? t("account.kind.ewallet") : row.kind) : "";
                    const accountOptions = getBalanceAccountSSOptions(row);
                    return (<tr key={row.tempId} className="hover:bg-slate-50">
                      <td className="px-3 py-1.5 border-b border-slate-100 text-sm text-slate-700">
                        <div className="init-modal-dropdown min-w-[220px]">
                          <SmartSelect mode="single" value={row.accountId} onChange={(id) => selectBalanceAccount(row.tempId, id)} options={accountOptions} placeholder={accountOptions.length > 0 ? t("initModal.placeholder.selectCashAccount") : t("initModal.placeholder.noAccountCreate")} searchable={true} onCreateClick={() => { pendingBalanceCreateRowId.current = row.tempId; setBalanceNestedOpen(true); }} createLabel={t("initModal.create")} />
                        </div>
                      </td>
                      <td className="px-3 py-1.5 border-b border-slate-100 text-xs text-slate-500">{kl}</td>
                      <td className="px-3 py-1.5 border-b border-slate-100 text-right">
                        <input type="number" step="0.01" placeholder="0" value={row.balance} onChange={(e) => updateBalanceRow(row.tempId, { balance: e.target.value })} className="init-modal-number h-8 w-32 text-right rounded border border-slate-200 bg-white px-2 text-sm outline-none focus:border-blue-400" />
                      </td>
                      <td className="px-3 py-1.5 border-b border-slate-100">
                        <DateStepper value={row.date} onChange={(value) => updateBalanceRow(row.tempId, { date: value })} className="h-8 rounded border border-slate-200 bg-white px-2 text-sm outline-none focus:border-blue-400" />
                      </td>
                    </tr>);
                  })}</tbody>
                </table>
              )}
            </div>
          )}

          {tab === "fund" && (
            <div className="space-y-3">
              <p className="text-xs text-slate-500">{t("initModal.fundIntro")}</p>
              {loadingAccounts && !accountsLoaded && (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500 text-center">{t("initModal.loadingInvestAccounts")}</div>
              )}
              {investmentAccountList.length === 0 && !loadingAccounts && (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-5 space-y-3">
                  <p className="text-sm text-slate-500 text-center">{t("initModal.emptyInvestAccounts")}</p>
                  <div className="init-modal-dropdown max-w-sm mx-auto">
                    <SmartSelect mode="single" value={addInvestAccountId} onChange={(id) => { setAddInvestAccountId(id); addInvestAccountToInit(id); }} options={addableInvestSSOptions} placeholder={t("initModal.placeholder.selectOrCreateInvestAccount")} searchable={true} onCreateClick={() => openInvestAccountCreate()} createLabel={t("initModal.create")} />
                  </div>
                </div>
              )}
              {activeInvestmentAccounts.map((account) => {
                const accountFundRows = fundRows.filter((row) => row.investmentAccountId === account.id);
                const accountHasContent = accountFundRows.some(fundRowHasContent);
                const accountSwitchOptions = investSSOptions.filter((option) => option.id === account.id || !activeInvestAccountIds.includes(option.id));
                return (
              <div key={`invest-panel-${account.id}`} className="space-y-3">
              <div className="rounded-xl border border-slate-200 bg-white px-3 py-3">
              <div className="flex items-center gap-2">
                <label className="text-[10px] font-semibold text-slate-500 uppercase shrink-0">{t("firstUseGuide.step.investment.title")}</label>
                <div className="init-modal-dropdown flex-1 max-w-xs" key={`invest-switch-${account.id}`}>
                  <SmartSelect mode="single" value={account.id} onChange={(id) => accountHasContent ? addInvestAccountToInit(id) : switchInvestAccountBlock(account.id, id)} options={accountSwitchOptions} placeholder={t("initModal.placeholder.selectInvestAccount")} searchable={true} onCreateClick={() => openInvestAccountCreate(account.id)} createLabel={t("initModal.create")} />
                </div>
                <button onClick={() => { setCurrentInvestAccountId(account.id); addFundRow(account.id); }} className="inline-flex items-center gap-1 h-8 px-3 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 shrink-0"><Plus className="w-4 h-4" />{t("initModal.addFund")}</button>
                {activeInvestmentAccounts.length > 1 && (
                  <button onClick={() => removeInvestAccountFromInit(account.id)} className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-red-200 bg-white text-red-500 hover:bg-red-50 shrink-0" title={t("initModal.removeInvestAccount")}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
              </div>
                {!loadingAccounts && accountFundRows.length === 0 && (
                  <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500 text-center">{t("initModal.emptyFundRowsHint")}</div>
                )}
                {accountFundRows.length > 0 && (
                  <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
                  <div className="overflow-auto">
                    <table className="w-full table-fixed border-separate border-spacing-0">
                      <colgroup>
                        <col className="w-[186px]" />
                        <col className="w-[46px]" />
                        <col className="w-[46px]" />
                        <col className="w-[68px]" />
                        <col className="w-[60px]" />
                        <col className="w-[64px]" />
                        <col className="w-[64px]" />
                        <col className="w-[32px]" />
                        <col className="w-[32px]" />
                      </colgroup>
                      <thead className="sticky top-0 z-10 bg-white">
                        <tr>
                          <th className="px-2 py-1 border-b border-r border-slate-200 text-left text-xs font-semibold text-slate-600">{t("txForm.fund")}</th>
                          <th className="px-1.5 py-1 border-b border-r border-slate-200 text-right text-xs font-semibold text-slate-600">{t("wealthForm.avgPrice")}</th>
                          <th className="px-1.5 py-1 border-b border-r border-slate-200 text-right text-xs font-semibold text-slate-600">{t("investForm.units")}</th>
                          <th className="px-1.5 py-1 border-b border-r border-slate-200 text-right text-xs font-semibold text-slate-600">{t("investForm.nav")}</th>
                          <th className="px-1.5 py-1 border-b border-r border-slate-200 text-right text-xs font-semibold text-slate-600">{t("propertyShell.column.marketValue")}</th>
                          <th className="px-1.5 py-1 border-b border-r border-slate-200 text-right text-xs font-semibold text-slate-600">{t("initModal.col.floatingProfit")}</th>
                          <th className="px-1.5 py-1 border-b border-r border-slate-200 text-right text-xs font-semibold text-slate-600">{t("initModal.col.historicalProfit")}</th>
                          <th className="px-0 py-1 border-b border-slate-200 text-center text-xs font-semibold text-slate-600">{t("fund.subtype.regular_invest")}</th>
                          <th className="px-0 py-1 border-b border-slate-200 text-center text-xs font-semibold text-slate-600">{t("detail.column.actions")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {accountFundRows.map((row) => {
                          const n = parseFloat(row.fundNav) || 0;
                          const u = parseFloat(row.units) || 0;
                          const a = parseFloat(row.avgCost) || 0;
                          const tc = u * a;
                          const mv = n > 0 ? u * n : 0;
                          const floatingProfit = n > 0 && u > 0 && a > 0 ? mv - tc : 0;
                          const floatingProfitClass = floatingProfit > 0 ? "text-emerald-600" : floatingProfit < 0 ? "text-red-600" : "text-slate-500";
                          const fundNameFontSize = row.fundName
                            ? Math.max(10, Math.min(13, 112 / Math.max(row.fundName.length, 1)))
                            : 12;

                          return (
                            <>
                              <tr key={row.tempId} className="hover:bg-slate-50 align-top">
                                <td className="px-2 py-1 border-b border-r border-slate-100 align-middle">
                                  <div className="flex items-start gap-1.5">
                                    <input type="text" placeholder={t("regularInvest.codePlaceholder")} maxLength={6} value={row.fundCode}
                                      onChange={(e) => {
                                        const code = e.target.value;
                                        updateFundRow(row.tempId, { fundCode: code });
                                      }}
                                      onBlur={(e) => {
                                        void fillFundRowFromCode(row.tempId, row.investmentAccountId || account.id, e.target.value);
                                      }}
                                      className="h-6 w-[78px] shrink-0 rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[14px] font-medium font-mono text-center text-slate-800 outline-none focus:border-blue-400" />
                                    <div className="min-w-0 flex-1 pt-0.5 text-slate-700">
                                      <div className="truncate leading-5" style={{ fontSize: `${fundNameFontSize}px` }}>{row.fundName || t("initModal.autoFetchFundName")}</div>
                                    </div>
                                  </div>
                                </td>
                                <td className="px-1.5 py-1 border-b border-r border-slate-100 align-middle text-right">
                                  <input type="number" step="0.0001" placeholder="0" value={row.avgCost} onChange={(e) => updateFundRow(row.tempId, { avgCost: e.target.value })} className="init-modal-number ml-auto block h-6 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-right text-[13px] font-medium leading-6 tabular-nums text-slate-800 outline-none focus:border-blue-400" />
                                </td>
                                <td className="px-1.5 py-1 border-b border-r border-slate-100 align-middle text-right">
                                  <input type="number" step="0.01" placeholder="0" value={row.units} onChange={(e) => updateFundRow(row.tempId, { units: e.target.value })} className="init-modal-number ml-auto block h-6 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-right text-[13px] font-medium leading-6 tabular-nums text-slate-800 outline-none focus:border-blue-400" />
                                </td>
                                <td className="px-1 py-1 border-b border-r border-slate-100 align-middle text-right tabular-nums text-slate-700">
                                  {n > 0 ? (
                                    <div className="flex items-baseline justify-end gap-1 leading-6">
                                      <span className="text-[13px] font-medium">{n.toFixed(4)}</span>
                                      {row.fundNavDate && <span className="text-[9px] font-normal leading-none text-slate-400">{row.fundNavDate.slice(5)}</span>}
                                    </div>
                                  ) : "--"}
                                </td>
                                <td className="px-1.5 py-1 border-b border-r border-slate-100 align-middle text-right text-[13px] leading-6 font-medium tabular-nums text-slate-800">
                                  {u > 0 && n > 0 ? mv.toFixed(2) : "--"}
                                </td>
                                <td className={`px-1.5 py-1 border-b border-r border-slate-100 align-middle text-right text-[13px] leading-6 font-medium tabular-nums ${floatingProfitClass}`}>
                                  {u > 0 && n > 0 && a > 0 ? `${floatingProfit >= 0 ? "+" : ""}${floatingProfit.toFixed(2)}` : "--"}
                                </td>
                                <td className="px-1.5 py-1 border-b border-r border-slate-100 align-middle">
                                  <input type="number" step="0.01" placeholder="0" value={row.historicalProfit} onChange={(e) => updateFundRow(row.tempId, { historicalProfit: e.target.value })} className="init-modal-number h-6 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[13px] leading-6 font-medium tabular-nums text-right text-slate-800 outline-none focus:border-blue-400" />
                                </td>
                                <td className="px-0 py-1 border-b border-slate-100 align-top text-center">
                                  <label className="inline-flex h-6.5 w-5 items-center justify-center cursor-pointer">
                                    <input type="checkbox" checked={row.hasRegularInvest} onChange={(e) => updateFundRow(row.tempId, { hasRegularInvest: e.target.checked })} className="h-3.5 w-3.5 accent-blue-600" />
                                  </label>
                                </td>
                                <td className="px-0 py-1 border-b border-slate-100 align-top text-center">
                                  <button onClick={() => removeFundRow(row.tempId)} className="inline-flex h-5.5 w-5.5 items-center justify-center rounded border border-red-200 bg-white text-red-500 hover:bg-red-50" title={t("initModal.remove")}><Trash2 className="w-3 h-3" /></button>
                                </td>
                              </tr>
                              {row.hasRegularInvest && (
                                <tr key={`${row.tempId}-ri`} className="bg-slate-50/70">
                                  <td colSpan={9} className="border-b border-slate-100 px-3 py-2">
                                    <div className="space-y-2">
                                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{t("initModal.ri.latestTxTitle")}</p>
                                      <div className="overflow-x-auto">
                                        <div className="flex min-w-[802px] items-end gap-1.5">
                                          <div className="w-[148px] shrink-0 space-y-1"><label className="text-[11px] font-medium uppercase text-slate-500">{t("initModal.ri.deductAccount")}</label><SmartSelect mode="single" value={row.riCashAccountId} onChange={(id) => updateFundRow(row.tempId, { riCashAccountId: id })} options={cashSSOptions} placeholder={t("regularInvest.unlimited")} /></div>
                                          <div className="w-[78px] shrink-0 space-y-1"><label className="text-[11px] font-medium uppercase text-slate-500">{t("initModal.ri.amountPerPeriod")}</label><input type="number" step="0.01" placeholder={t("txForm.amount")} value={row.riAmount} onChange={(e) => updateFundRow(row.tempId, { riAmount: e.target.value })} className="init-modal-number h-7 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[13px] font-medium text-right text-slate-800 outline-none focus:border-blue-400" /></div>
                                          <div className="w-[148px] shrink-0 space-y-1"><label className="text-[11px] font-medium uppercase text-slate-500">{t("regularInvest.interval")}</label>
                                            <div className="flex gap-1">
                                              <input type="number" min="1" placeholder="1" value={row.riIntervalValue} onChange={(e) => updateFundRow(row.tempId, { riIntervalValue: e.target.value })} className="h-7 w-9 rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[13px] font-medium text-center text-slate-800 outline-none focus:border-blue-400" />
                                              <select value={row.riIntervalUnit} onChange={(e) => updateFundRow(row.tempId, { riIntervalUnit: e.target.value, riWeekday: e.target.value === "week" ? (row.riWeekday || "1") : row.riWeekday })} className="h-7 w-[54px] rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[12px] text-slate-700 outline-none focus:border-blue-400"><option value="day">{t("initModal.ri.unit.day")}</option><option value="week">{t("initModal.ri.unit.week")}</option><option value="biweek">{t("initModal.ri.unit.biweek")}</option><option value="month">{t("initModal.ri.unit.month")}</option><option value="year">{t("initModal.ri.unit.year")}</option></select>
                                              {row.riIntervalUnit === "week" && <select value={row.riWeekday} onChange={(e) => updateFundRow(row.tempId, { riWeekday: e.target.value })} className="h-7 w-[56px] rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[12px] text-slate-700 outline-none focus:border-blue-400"><option value="1">{t("regularInvest.weekday.1")}</option><option value="2">{t("regularInvest.weekday.2")}</option><option value="3">{t("regularInvest.weekday.3")}</option><option value="4">{t("regularInvest.weekday.4")}</option><option value="5">{t("regularInvest.weekday.5")}</option><option value="6">{t("regularInvest.weekday.6")}</option><option value="0">{t("regularInvest.weekday.0")}</option></select>}
                                            </div>
                                          </div>
                                          <div className="w-[96px] shrink-0 space-y-1"><label className="text-[11px] font-medium uppercase text-slate-500">{t("initModal.ri.txDate")}</label>
                                            <DateStepper value={row.riTxDate} onChange={(txDate) => { let tPlusN = ""; let arrivalDate = row.riArrivalDate; if (txDate && row.riConfirmDate) { const diff = Math.round((new Date(row.riConfirmDate).getTime() - new Date(txDate).getTime()) / 86400000); if (diff >= 0) tPlusN = String(diff); } if (txDate && (!row.riArrivalDate || row.riArrivalDate === row.riTxDate)) { const arrival = new Date(`${txDate}T00:00:00`); arrival.setDate(arrival.getDate() + 2); arrivalDate = arrival.toISOString().slice(0, 10); } updateFundRow(row.tempId, { riTxDate: txDate, riTPlusN: tPlusN, riArrivalDate: arrivalDate }); }} className="h-7 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[12px] text-slate-800 outline-none focus:border-blue-400" />
                                          </div>
                                          <div className="w-[96px] shrink-0 space-y-1"><label className="text-[11px] font-medium uppercase text-slate-500">{t("initModal.ri.confirmDate")}</label>
                                            <DateStepper value={row.riConfirmDate} onChange={(confirmDate) => { let tPlusN = ""; if (row.riTxDate && confirmDate) { const diff = Math.round((new Date(confirmDate).getTime() - new Date(row.riTxDate).getTime()) / 86400000); if (diff >= 0) tPlusN = String(diff); } updateFundRow(row.tempId, { riConfirmDate: confirmDate, riTPlusN: tPlusN }); }} className="h-7 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[12px] text-slate-800 outline-none focus:border-blue-400" />
                                          </div>
                                          <div className="w-[96px] shrink-0 space-y-1"><label className="text-[11px] font-medium uppercase text-slate-500">{t("initModal.ri.arrivalDate")}</label><DateStepper value={row.riArrivalDate} onChange={(value) => updateFundRow(row.tempId, { riArrivalDate: value })} className="h-7 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[12px] text-slate-800 outline-none focus:border-blue-400" /></div>
                                          <div className="w-[60px] shrink-0 space-y-1"><label className="text-[11px] font-medium uppercase text-slate-500">{t("initModal.ri.feeRate")}</label><input type="number" step="0.01" placeholder="0" value={row.riFeeRate} onChange={(e) => updateFundRow(row.tempId, { riFeeRate: e.target.value })} className="init-modal-number h-7 w-full rounded-none border-0 border-b border-slate-200 bg-transparent px-0 text-[13px] font-medium text-right text-slate-800 outline-none focus:border-blue-400" /></div>
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  </div>
                )}
              </div>
                );
              })}

              {investmentAccountList.length > 0 && canAddAnotherInvestAccount && (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-3">
                  <p className="mb-2 text-[11px] font-medium text-slate-500">{t("initModal.addInvestAccount")}</p>
                  <div className="init-modal-dropdown">
                    <SmartSelect mode="single" value={addInvestAccountId} onChange={(id) => { setAddInvestAccountId(id); addInvestAccountToInit(id); }} options={addableInvestSSOptions} placeholder={addableInvestSSOptions.length > 0 ? t("initModal.placeholder.selectInvestAccountToInit") : t("initModal.placeholder.noAccountCreate")} searchable={true} onCreateClick={() => openInvestAccountCreate()} createLabel={t("initModal.create")} />
                  </div>
                </div>
              )}
            </div>
          )}

          {message && (
            <div className={`rounded-lg px-4 py-3 text-sm ${message.ok ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
              <p className="font-medium">{message.text}</p>
              {message.details && message.details.length > 0 && <ul className="mt-1 space-y-0.5">{message.details.map((d, i) => <li key={i} className="text-xs opacity-80">{d}</li>)}</ul>}
            </div>
          )}
        </div>

        <div className="shrink-0 px-5 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
          <div className="text-xs text-slate-400">{tab === "balance" ? t("settings.accounts.count", { count: balanceRows.length }) : t("initModal.count.investAccounts", { accounts: new Set(fundRows.map((row) => row.investmentAccountId).filter(Boolean)).size, funds: fundRows.length })}</div>
          <div className="flex items-center gap-2">
            <button onClick={handleClose} disabled={busy} className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40">{t("common.cancel")}</button>
            <button onClick={handleSubmit} disabled={busy} className="h-9 px-5 rounded-md bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
              {busy ? <><span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />{t("initModal.processing")}</> : t("common.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
    </>, document.body
    )}

    {open && investNestedOpen && createPortal(
      <NestedAddModal key="init-invest-account" mode="compact" entityType="account" open={investNestedOpen}
        onClose={() => { pendingInvestCreateFromAccountId.current = ""; setInvestNestedOpen(false); }}
        onCreated={handleInvestAccountCreated}
        nestedFieldData={localNestedFieldData ?? accountNestedFieldData}
        onNestedCreated={handleNestedOptionCreated}
        extraFields={{ kind: "investment", investProductType: "fund" }}
        hiddenFields={["kind", "investProductType"]}
      />, document.body
    )}

    {open && balanceNestedOpen && createPortal(
      <NestedAddModal key="init-balance-account" mode="compact" entityType="account" open={balanceNestedOpen}
        onClose={() => { pendingBalanceCreateRowId.current = ""; setBalanceNestedOpen(false); }}
        onCreated={handleBalanceAccountCreated}
        nestedFieldData={localNestedFieldData ?? accountNestedFieldData}
        onNestedCreated={handleNestedOptionCreated}
      />, document.body
    )}
    </ModalLayerProvider>
  );
}
