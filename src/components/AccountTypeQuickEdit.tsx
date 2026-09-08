"use client";

import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { PRODUCT_TYPES, supportsCostBasisMethod } from "@/lib/investment-config";
import { fetchSettingsAccountData, notifySettingsDataChanged } from "@/lib/client/settingsCache";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { normalizeCurrency } from "@/lib/currency";
import { supportsTradingCalendarForAccount, TRADING_CALENDARS } from "@/lib/fund/trading-calendar";
import { isDepositAccount } from "@/lib/account-kind-utils";
import {
  accountInstitutionTypeIsAllowed,
  accountRequiresInstitution,
  allowedInstitutionTypesForAccount,
  isConsumerLoanInstitutionType,
  isStockAccountInstitutionType,
  isStockInvestmentAccount,
} from "@/lib/account-institution-rules";
import { FIXED_ASSET_TYPES, isFixedAssetAccountLike } from "@/lib/fixed-asset";
import { EQUAL_PAYMENT_REPAYMENT_METHOD,
  EQUAL_PRINCIPAL_REPAYMENT_METHOD,
  INSTALLMENT_REPAYMENT_METHOD,
  INTEREST_FIRST_REPAYMENT_METHOD,
} from "@/lib/loan-repayment";
import { isCollateralLoanType, isHomeLoanType, LOAN_TYPES, type LoanTypeValue } from "@/lib/loan-type";
import { CurrencySmartSelect } from "@/components/CurrencySmartSelect";

type AccountKindValue = "cash" | "bank_debit" | "bank_credit" | "ewallet" | "deposit" | "investment" | "fixed_asset" | "settlement" | "loan" | "other";
type Institution = { id: string; name: string; shortName?: string | null; type?: string | null };
type Counterparty = { id: string; name: string; shortName?: string | null; type?: string | null };
type Group = { id: string; name: string };
export type AccountQuickEditValue = {
  id: string; name: string; kind: string; currency?: string | null; note?: string | null;
  groupId?: string | null; institutionId?: string | null; billingDay?: number | null;
  repaymentDay?: number | null; repaymentOffsetDays?: number | null; creditLimit?: unknown; creditBillMode?: "separate" | "consolidated" | null;
  numberMasked?: string | null; investProductType?: string | null; costBasisMethod?: string | null;
  fundUnitsDecimals?: number | null; tradingCalendar?: string | null; fixedAssetType?: string | null;
  counterpartyId?: string | null; debtDirection?: string | null; isConsumerLoan?: boolean | null;
  loanType?: string | null;
};

export type LoanQuickEditValue = {
  editEntryId: string;
  mode: "borrow_in";
  defaultDebtAccountId: string;
  defaultDebtAccountName?: string | null;
  defaultCashAccountId: string;
  defaultDate: string;
  defaultPrincipal: number;
  defaultInterest: number;
  defaultNote?: string | null;
  defaultAutoDebitCashAccountId?: string;
  defaultFixedAssetAccountId?: string;
  defaultFixedAssetAssetId?: string;
  defaultTagIds?: string[] | null;
  defaultRepaymentMethod?: string | null;
  defaultAnnualRate?: number | null;
  defaultMortgageLprDiscount?: number | null;
  defaultRepaymentIntervalMonths?: number | null;
  defaultLoanTotalRuns?: number | null;
  defaultFirstBillDate?: string | null;
  defaultFirstRepaymentDate?: string | null;
  defaultAutoDebit?: boolean | null;
  defaultAutoDebitFirstDate?: string | null;
  defaultLoanRateAdjustments?: Array<{ effectiveDate: string; annualRate: number }>;
  defaultLoanFundingMode?: "cash_disbursement" | "financed_purchase";
  dialogType?: "loan";
  loanType: LoanTypeValue;
};

type LoanEditAction = (formData: FormData) => Promise<
  | { ok: true; warning?: string; recalculateAfterSave?: { accountId: string; startDate: string } | null }
  | { ok: false; error: string }
>;

type AccountTypeQuickEditProps = {
  account: AccountQuickEditValue;
  accountLabel?: string;
  openSignal?: number;
  showTrigger?: boolean;
  loanDetails?: LoanQuickEditValue | null;
  loanEditAction?: LoanEditAction;
};

const ACCOUNT_KINDS: AccountKindValue[] = ["cash", "bank_debit", "bank_credit", "ewallet", "deposit", "investment", "fixed_asset", "settlement", "loan", "other"];
const SELECTABLE_ACCOUNT_KINDS = ACCOUNT_KINDS;

function normalizedKind(account: AccountQuickEditValue): AccountKindValue {
  if (isFixedAssetAccountLike(account)) return "fixed_asset";
  return isDepositAccount(account) ? "deposit" : (ACCOUNT_KINDS.includes(account.kind as AccountKindValue) ? account.kind as AccountKindValue : "other");
}

function institutionMatches(kind: AccountKindValue, productType: string, institution: Institution) {
  return accountInstitutionTypeIsAllowed(kind, productType, institution.type);
}

export function AccountTypeQuickEdit({ account, accountLabel, openSignal = 0, showTrigger = true, loanDetails, loanEditAction }: AccountTypeQuickEditProps) {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [institutions, setInstitutions] = useState<Institution[]>([]);
  const [counterparties, setCounterparties] = useState<Counterparty[]>([]);
  const [cashAccounts, setCashAccounts] = useState<Array<{ id: string; name: string }>>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [loanForm, setLoanForm] = useState<Record<string, string>>({});

  const kind = (form.kind || normalizedKind(account)) as AccountKindValue;
  const productType = form.investProductType || "fund";
  const currentKind = normalizedKind(account);
  const selectableAccountKinds = SELECTABLE_ACCOUNT_KINDS;
  const isFixedAssetAccount = kind === "fixed_asset" || isFixedAssetAccountLike({ kind, investProductType: productType });
  const isInvestment = kind === "investment";
  const isCredit = kind === "bank_credit";
  const isLoan = kind === "loan";
  const supportsInstitution = kind !== "settlement" && allowedInstitutionTypesForAccount(kind, productType).length > 0;
  const supportsLastFour = isCredit || kind === "bank_debit";
  const showCostBasis = isInvestment && supportsCostBasisMethod(productType);
  const filteredInstitutions = useMemo(
    () => !supportsInstitution || isFixedAssetAccount ? [] : institutions.filter((institution) => institutionMatches(kind, productType, institution)),
    [institutions, isFixedAssetAccount, kind, productType, supportsInstitution],
  );
  const loanDetailsIsHomeLoan = loanDetails ? isHomeLoanType(loanDetails.loanType) : false;
  const loanDetailsIsCollateralLoan = loanDetails ? isCollateralLoanType(loanDetails.loanType) : false;

  const resetForm = useCallback(() => {
    const nextKind = normalizedKind(account);
    const nextInvestProductType = nextKind === "investment"
      ? account.investProductType ?? "fund"
      : nextKind === "fixed_asset" ? "property" : "";
    const nextSupportsInstitution = nextKind !== "settlement" && allowedInstitutionTypesForAccount(nextKind, nextInvestProductType).length > 0;
    setForm({
      name: account.name, kind: nextKind, note: account.note ?? "", currency: normalizeCurrency(account.currency ?? "CNY"),
      groupId: account.groupId ?? "", institutionId: nextSupportsInstitution ? account.institutionId ?? "" : "", billingDay: account.billingDay == null ? "" : String(account.billingDay),
      repaymentDay: account.repaymentDay == null ? "" : String(account.repaymentDay), creditLimit: account.creditLimit == null ? "" : String(account.creditLimit),
      repaymentOffsetDays: account.repaymentOffsetDays == null ? "" : String(account.repaymentOffsetDays),
      repaymentDayMode: account.repaymentOffsetDays != null ? "offset" : "fixed",
      creditBillMode: account.creditBillMode === "consolidated" ? "consolidated" : "separate",       numberMasked: account.numberMasked ?? "",
      investProductType: nextInvestProductType, costBasisMethod: account.costBasisMethod ?? "moving_avg",
      counterpartyId: nextKind === "settlement" ? account.counterpartyId ?? "" : "",
      loanType: account.loanType || (nextKind === "loan" ? (account.isConsumerLoan === true ? "consumer" : "home") : ""),
      fundUnitsDecimals: String(account.fundUnitsDecimals ?? 2), tradingCalendar: account.tradingCalendar ?? "cn_fund", fixedAssetType: account.fixedAssetType ?? "property",
    });
    setLoanForm(loanDetails ? {
      principal: String(Math.abs(Number(loanDetails.defaultPrincipal) || 0)),
      repaymentMethod: loanDetails.defaultRepaymentMethod || EQUAL_PAYMENT_REPAYMENT_METHOD,
      annualRate: loanDetails.defaultAnnualRate == null ? "0" : String(loanDetails.defaultAnnualRate),
      mortgageLprDiscount: loanDetails.defaultMortgageLprDiscount == null ? "" : String(loanDetails.defaultMortgageLprDiscount),
      repaymentIntervalMonths: String(loanDetails.defaultRepaymentIntervalMonths ?? 1),
      totalRuns: String(loanDetails.defaultLoanTotalRuns ?? 1),
      firstBillDate: loanDetails.defaultFirstBillDate ?? "",
      firstRepaymentDate: loanDetails.defaultFirstRepaymentDate ?? "",
      autoDebit: loanDetailsIsHomeLoan || loanDetails.defaultAutoDebit === true ? "true" : "false",
      autoDebitFirstDate: loanDetails.defaultAutoDebitFirstDate ?? loanDetails.defaultFirstRepaymentDate ?? "",
      cashAccountId: loanDetails.defaultCashAccountId ?? "",
      autoDebitCashAccountId: loanDetails.defaultAutoDebitCashAccountId ?? (loanDetailsIsCollateralLoan ? "" : loanDetails.defaultCashAccountId ?? ""),
    } : {});
    setError("");
  }, [account, loanDetails, loanDetailsIsCollateralLoan, loanDetailsIsHomeLoan]);

  const openEditor = useCallback(async () => {
    resetForm();
    setOpen(true);
    const data = await fetchSettingsAccountData().catch(() => null);
    if (data) {
      setGroups(data.groups as Group[]);
      setInstitutions(data.institutions as Institution[]);
      setCounterparties((data.counterparties ?? []) as Counterparty[]);
      setCashAccounts((data.accounts as Array<{ id: string; name: string; kind?: string; isActive?: boolean; isPlaceholder?: boolean }>)
        .filter((item) => item.isActive !== false && item.isPlaceholder !== true && !["loan", "settlement", "investment", "fixed_asset"].includes(item.kind ?? ""))
        .map((item) => ({ id: item.id, name: item.name })));
    }
  }, [resetForm]);

  useEffect(() => {
    if (openSignal <= 0) return;
    void openEditor();
  }, [openEditor, openSignal]);

  async function save() {
    if (saving) return;
    if (!form.name?.trim()) { setError(t("settings.accounts.nameRequired")); return; }
    if (!form.groupId) { setError(t("settings.accounts.ownerRequired")); return; }
    const selectedInstitution = institutions.find((institution) => institution.id === form.institutionId);
    if (isStockInvestmentAccount(kind, productType) && (!form.institutionId || !isStockAccountInstitutionType(selectedInstitution?.type))) { setError(t("entityForm.error.stockAccountInstitution")); return; }
    if (kind === "settlement" && !form.counterpartyId) { setError(t("debtTx.placeholder.selectCounterparty")); return; }
    if (kind === "loan" && !form.institutionId) { setError(t("settings.accounts.import.institutionRequired")); return; }
    if (accountRequiresInstitution(kind, productType) && !form.institutionId) { setError(t("settings.accounts.import.institutionRequired")); return; }
    if (kind === "loan" && !isConsumerLoanInstitutionType(selectedInstitution?.type)) { setError(t("settings.accounts.import.institutionNotAllowed")); return; }
    if (form.institutionId && !accountInstitutionTypeIsAllowed(kind, productType, selectedInstitution?.type)) { setError(t("settings.accounts.import.institutionNotAllowed")); return; }
    if (loanDetails && loanEditAction) {
      const principal = Number(loanForm.principal);
      const totalRuns = Number(loanForm.totalRuns);
      const annualRate = Number(loanForm.annualRate);
      const intervalMonths = Number(loanForm.repaymentIntervalMonths);
      const autoDebit = loanDetailsIsHomeLoan || loanForm.autoDebit === "true";
      const debitAccountId = loanDetailsIsCollateralLoan ? loanForm.autoDebitCashAccountId : loanForm.cashAccountId;
      if (!Number.isFinite(principal) || principal <= 0) { setError(t("txForm.alert.invalidAmount")); return; }
      if (!Number.isInteger(totalRuns) || totalRuns <= 0) { setError(t("debtTx.alert.totalRunsRequired")); return; }
      if (!Number.isFinite(annualRate) || annualRate < 0) { setError(t("debtTx.alert.annualRateRequired")); return; }
      if (!Number.isInteger(intervalMonths) || intervalMonths <= 0) { setError(t("regularInvest.alert.invalidRepaymentInterval")); return; }
      if (loanDetailsIsCollateralLoan && !loanForm.cashAccountId) { setError(t("debtTx.alert.selectLoanDisbursementAccount")); return; }
      if (autoDebit && !debitAccountId) { setError(t("debtTx.alert.autoDebitAccountRequired")); return; }
      if (autoDebit && !loanForm.autoDebitFirstDate) { setError(t("debtTx.alert.autoDebitDateRequired")); return; }
      if (!autoDebit && !loanForm.firstBillDate) { setError(t("debtTx.alert.firstBillDateRequired")); return; }
      if (!autoDebit && !loanForm.firstRepaymentDate) { setError(t("debtTx.alert.firstRepaymentDateRequired")); return; }
    }
    setSaving(true);
    setError("");
    try {
      const payload = isFixedAssetAccount
        ? { ...form, kind: "investment", investProductType: "property", institutionId: "", counterpartyId: "", fixedAssetType: form.fixedAssetType || "property", loanType: "", isConsumerLoan: "false" }
        : kind === "settlement"
          ? { ...form, institutionId: "", loanType: "", isConsumerLoan: "false" }
          : kind === "loan"
            ? { ...form, counterpartyId: "", loanType: form.loanType || "home", isConsumerLoan: form.loanType === "consumer" ? "true" : "false" }
            : { ...form, counterpartyId: "", loanType: "", isConsumerLoan: "false" };
      const response = await fetch("/api/v1/accounts", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: account.id, ...payload }) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error(data?.error || t("settings.accounts.saveFailed"));
      if (loanDetails && loanEditAction) {
        const autoDebit = loanDetailsIsHomeLoan || loanForm.autoDebit === "true";
        const debitAccountId = loanDetailsIsCollateralLoan ? loanForm.autoDebitCashAccountId : loanForm.cashAccountId;
        const loanData = new FormData();
        loanData.set("editEntryId", loanDetails.editEntryId);
        loanData.set("mode", "borrow_in");
        loanData.set("loanFundingMode", loanDetails.defaultLoanFundingMode ?? (loanDetailsIsCollateralLoan ? "cash_disbursement" : "financed_purchase"));
        loanData.set("date", loanDetails.defaultDate);
        loanData.set("debtAccountId", loanDetails.defaultDebtAccountId);
        loanData.set("debtItemName", form.name.trim());
        loanData.set("loanType", loanDetails.loanType);
        loanData.set("cashAccountId", loanDetailsIsCollateralLoan ? loanForm.cashAccountId : autoDebit ? loanForm.cashAccountId : "");
        loanData.set("autoDebitCashAccountId", autoDebit ? debitAccountId : "");
        loanData.set("principal", loanForm.principal);
        loanData.set("interest", String(loanDetails.defaultInterest ?? 0));
        loanData.set("penalty", "0");
        loanData.set("annualRate", loanForm.annualRate);
        loanData.set("mortgageLprDiscount", loanDetailsIsHomeLoan ? loanForm.mortgageLprDiscount : "");
        loanData.set("repaymentMethod", loanForm.repaymentMethod);
        loanData.set("repaymentIntervalMonths", loanForm.repaymentIntervalMonths);
        loanData.set("loanTotalRuns", loanForm.totalRuns);
        loanData.set("firstBillDate", loanDetailsIsHomeLoan ? "" : loanForm.firstBillDate);
        loanData.set("firstRepaymentDate", autoDebit ? loanForm.autoDebitFirstDate : loanForm.firstRepaymentDate);
        loanData.set("createRepaymentPlan", "true");
        loanData.set("autoDebit", autoDebit ? "true" : "false");
        loanData.set("autoDebitFirstDate", autoDebit ? loanForm.autoDebitFirstDate : "");
        if (loanDetails.defaultFixedAssetAccountId) loanData.set("fixedAssetAccountId", loanDetails.defaultFixedAssetAccountId);
        if (loanDetails.defaultFixedAssetAssetId) loanData.set("fixedAssetAssetId", loanDetails.defaultFixedAssetAssetId);
        loanData.set("createHistoricalRepaymentRecords", "false");
        loanData.set("historicalLoanRates", (loanDetails.defaultLoanRateAdjustments ?? [])
          .map((item) => `${item.effectiveDate} ${item.annualRate}`)
          .join("\n"));
        loanData.set("note", loanDetails.defaultNote ?? "");
        const loanResult = await loanEditAction(loanData);
        if (!loanResult.ok) throw new Error(loanResult.error);
      }
      setOpen(false);
      await notifySettingsDataChanged({ scope: "accounts", reason: "account:quick-edit", prefetch: true });
      dispatchFinanceDataChanged({ reason: "account:quick-edit", accountIds: [account.id] });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.accounts.saveFailed"));
    } finally { setSaving(false); }
  }

  const setField = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }));
  const setLoanField = (key: string, value: string) => setLoanForm((current) => ({ ...current, [key]: value }));
  const inputClass = "h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-800 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:bg-slate-100 disabled:text-slate-400";

  const currentCurrency = normalizeCurrency(form.currency || "CNY");

  return (
    <>
      {showTrigger ? (
        <span className="page-title cursor-pointer" onDoubleClick={() => { void openEditor(); }} title={t("accountTypeQuickEdit.doubleClickTitle")}>{accountLabel || account.name}</span>
      ) : null}
      {open && typeof document !== "undefined" ? createPortal(
        <div className="fixed inset-0 z-[1000] flex items-center justify-center overflow-y-auto bg-slate-950/30 p-4" onMouseDown={() => !saving && setOpen(false)}>
          <div className="max-h-[calc(100dvh-2rem)] w-[720px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-xl" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-800">{t("settings.accounts.editTitle", { name: account.name })}</h2><button type="button" className="h-8 rounded border border-slate-200 px-2 text-sm text-slate-600" onClick={() => setOpen(false)}>{t("table.close")}</button></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
              <Field label={t("settings.accounts.name")}><input value={form.name ?? ""} onChange={(event) => setField("name", event.target.value)} className={inputClass} /></Field>
              <Field label={t("settings.accounts.type")}>{isFixedAssetAccount ? <input value={t("txForm.fixedAssetToggle")} readOnly className={`${inputClass} bg-slate-50 text-slate-500`} /> : <select value={kind} onChange={(event) => {
                const nextKind = event.target.value;
                setForm((current) => {
                  const nextLoanType = nextKind === "loan" ? (current.loanType || "home") : "";
                  return {
                    ...current,
                    kind: nextKind,
                    institutionId: "",
                    counterpartyId: "",
                    loanType: nextLoanType,
                    isConsumerLoan: nextKind === "loan" && nextLoanType === "consumer" ? "true" : "false",
                    investProductType: nextKind === "investment" ? current.investProductType || "fund" : nextKind === "fixed_asset" ? "property" : "",
                  };
                });
              }} className={inputClass}>{selectableAccountKinds.map((value) => <option key={value} value={value}>{t(`account.kind.${value}`)}</option>)}</select>}</Field>
              {isFixedAssetAccount && <Field label={t("fixedAssetEdit.assetType")}><select value={form.fixedAssetType || "property"} onChange={(event) => setField("fixedAssetType", event.target.value)} className={inputClass}>{FIXED_ASSET_TYPES.map((value) => <option key={value} value={value}>{t(`fixedAsset.type.${value}`)}</option>)}</select></Field>}
              <Field label={t("settings.accounts.owner")}><select value={form.groupId ?? ""} onChange={(event) => setField("groupId", event.target.value)} className={inputClass}><option value="">{t("settings.accounts.selectOwner")}</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></Field>
              {supportsInstitution && !isFixedAssetAccount && <Field label={t("settings.accounts.institution")}><select value={form.institutionId ?? ""} onChange={(event) => setField("institutionId", event.target.value)} className={inputClass}><option value="">{t("settings.accounts.selectInstitution")}</option>{filteredInstitutions.map((institution) => <option key={institution.id} value={institution.id}>{institution.shortName?.trim() || institution.name}</option>)}</select></Field>}
              {kind === "settlement" && <Field label={t("txForm.counterparty")}><select value={form.counterpartyId ?? ""} onChange={(event) => setField("counterpartyId", event.target.value)} className={inputClass}><option value="">{t("debtTx.placeholder.selectCounterparty")}</option>{counterparties.map((counterparty) => <option key={counterparty.id} value={counterparty.id}>{counterparty.shortName?.trim() || counterparty.name}</option>)}</select></Field>}
              <Field label={t("settings.accounts.currency")}>
                <CurrencySmartSelect
                  value={currentCurrency}
                  onChange={(val) => setField("currency", val)}
                  labelSystem={(code) => t(`entityForm.currency.${code.toLowerCase()}`, { defaultValue: code })}
                />
              </Field>
              {isInvestment && !isFixedAssetAccount && <Field label={t("settings.accounts.investmentAccountType")}><select value={productType} onChange={(event) => setField("investProductType", event.target.value)} className={inputClass}>{PRODUCT_TYPES.map((value) => <option key={value} value={value}>{t(`investment.product.${value}`)}</option>)}</select></Field>}
              {showCostBasis && <Field label={t("settings.accounts.costBasisMethod")}><select value={form.costBasisMethod || "moving_avg"} onChange={(event) => setField("costBasisMethod", event.target.value)} className={inputClass}><option value="moving_avg">{t("settings.accounts.movingAverage")}</option><option value="fifo">{t("settings.accounts.fifo")}</option><option value="lifo">{t("settings.accounts.lifo")}</option></select></Field>}
              {isInvestment && productType === "fund" && <Field label={t("settings.accounts.fundUnitsDecimals")}><input value={form.fundUnitsDecimals ?? "2"} onChange={(event) => setField("fundUnitsDecimals", event.target.value)} className={inputClass} inputMode="numeric" /></Field>}
              {isInvestment && supportsTradingCalendarForAccount(kind, productType) && <Field label={t("settings.accounts.tradingCalendar")}><select value={form.tradingCalendar || "cn_fund"} onChange={(event) => setField("tradingCalendar", event.target.value)} className={inputClass}>{TRADING_CALENDARS.map((value) => <option key={value} value={value}>{t(`tradingCalendar.${value}`)}</option>)}</select></Field>}
              {isCredit && <Field label={t("settings.accounts.billingDayLabel")}><input value={form.billingDay ?? ""} onChange={(event) => setField("billingDay", event.target.value)} className={inputClass} inputMode="numeric" placeholder="1-31" /></Field>}
              {isCredit && <Field label={t("settings.accounts.repaymentDayModeLabel")}><select value={form.repaymentDayMode || "fixed"} onChange={(event) => setField("repaymentDayMode", event.target.value)} className={inputClass}><option value="fixed">{t("entityForm.repaymentDayMode.fixed")}</option><option value="offset">{t("entityForm.repaymentDayMode.offset")}</option></select></Field>}
              {isCredit && form.repaymentDayMode !== "offset" && <Field label={t("settings.accounts.repaymentDayLabel")}><input value={form.repaymentDay ?? ""} onChange={(event) => setField("repaymentDay", event.target.value)} className={inputClass} inputMode="numeric" placeholder="1-31" /></Field>}
              {isCredit && form.repaymentDayMode === "offset" && <Field label={t("settings.accounts.repaymentOffsetDaysLabel")}><input value={form.repaymentOffsetDays ?? ""} onChange={(event) => setField("repaymentOffsetDays", event.target.value)} className={inputClass} inputMode="numeric" placeholder={t("entityForm.repaymentOffsetDaysPlaceholder")} /></Field>}
              {isCredit && <Field label={t("settings.accounts.creditLimitLabel")}><input value={form.creditLimit ?? ""} onChange={(event) => setField("creditLimit", event.target.value)} className={inputClass} /></Field>}
              {supportsLastFour && <Field label={t("settings.accounts.lastFourLabel")}><input value={form.numberMasked ?? ""} onChange={(event) => setField("numberMasked", event.target.value)} className={inputClass} /></Field>}
              {isCredit && <Field label={t("settings.accounts.billMode")}><select value={form.creditBillMode || "separate"} onChange={(event) => setField("creditBillMode", event.target.value)} className={inputClass}><option value="separate">{t("settings.accounts.separateBill")}</option><option value="consolidated">{t("settings.accounts.consolidatedBill")}</option></select></Field>}
              {isLoan && <Field label={t("settings.accounts.loanType")}><select value={form.loanType || "home"} onChange={(event) => { setField("loanType", event.target.value); setField("isConsumerLoan", event.target.value === "consumer" ? "true" : "false"); }} className={inputClass}>{LOAN_TYPES.map((value) => <option key={value} value={value}>{t(`loan.type.${value}`)}</option>)}</select></Field>}
            </div>
            <Field label={t("settings.accounts.note")}><textarea value={form.note ?? ""} onChange={(event) => setField("note", event.target.value)} className="min-h-20 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-800 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-100 disabled:bg-slate-100 disabled:text-slate-400" /></Field>
            {loanDetails ? (
              <section className="mt-4 border-t border-slate-200 pt-4">
                <h3 className="mb-3 text-sm font-semibold text-slate-800">{t("accountTypeQuickEdit.loanDetails")}</h3>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
                  <Field label={t("txForm.date")}><input type="date" value={loanDetails.defaultDate} readOnly className={`${inputClass} bg-slate-50 text-slate-500`} /></Field>
                  <Field label={t("debtTx.totalBorrowing")}><input value={loanForm.principal ?? ""} onChange={(event) => setLoanField("principal", event.target.value)} className={inputClass} inputMode="decimal" /></Field>
                  <Field label={t("debtTx.repaymentMethod")}><select value={loanForm.repaymentMethod ?? ""} onChange={(event) => setLoanField("repaymentMethod", event.target.value)} className={inputClass}><option value={EQUAL_PAYMENT_REPAYMENT_METHOD}>{t("debtTx.method.equalInstallment")}</option><option value={EQUAL_PRINCIPAL_REPAYMENT_METHOD}>{t("debtTx.method.equalPrincipal")}</option><option value={INSTALLMENT_REPAYMENT_METHOD}>{t("debtTx.method.interestFreeInstallment")}</option><option value={INTEREST_FIRST_REPAYMENT_METHOD}>{t("debtTx.method.interestFirstThenPrincipal")}</option></select></Field>
                  <Field label={t("debtTx.totalRuns")}><input value={loanForm.totalRuns ?? ""} onChange={(event) => setLoanField("totalRuns", event.target.value)} className={inputClass} inputMode="numeric" /></Field>
                  <Field label={t("debtShell.rateAdjust.annualRateLabel")}><input value={loanForm.annualRate ?? ""} onChange={(event) => setLoanField("annualRate", event.target.value)} className={inputClass} inputMode="decimal" /></Field>
                  <Field label={t("regularInvest.repaymentIntervalMonths")}><input value={loanForm.repaymentIntervalMonths ?? ""} onChange={(event) => setLoanField("repaymentIntervalMonths", event.target.value)} className={inputClass} inputMode="numeric" /></Field>
                  {loanDetailsIsHomeLoan ? <Field label={t("debtTx.mortgageLprDiscount")}><input value={loanForm.mortgageLprDiscount ?? ""} onChange={(event) => setLoanField("mortgageLprDiscount", event.target.value)} className={inputClass} inputMode="decimal" /></Field> : null}
                  {loanDetailsIsCollateralLoan ? <Field label={t("debtTx.accountLabel.postingAccount")}><select value={loanForm.cashAccountId ?? ""} onChange={(event) => setLoanField("cashAccountId", event.target.value)} className={inputClass}><option value="">{t("txForm.selectPlaceholder")}</option>{cashAccounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field> : null}
                </div>
                {!loanDetailsIsHomeLoan ? <label className="mt-3 flex items-center gap-2 text-xs text-slate-600"><input type="checkbox" checked={loanForm.autoDebit === "true"} onChange={(event) => setLoanField("autoDebit", event.target.checked ? "true" : "false")} className="h-3.5 w-3.5 accent-blue-600" />{t("debtTx.autoDebitLabel")}</label> : null}
                {loanDetailsIsHomeLoan || loanForm.autoDebit === "true" ? (
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {loanDetailsIsHomeLoan ? null : <Field label={t("debtTx.firstBillDate")}><input type="date" value={loanForm.firstBillDate ?? ""} onChange={(event) => setLoanField("firstBillDate", event.target.value)} className={inputClass} /></Field>}
                    <Field label={t("debtTx.autoDebitDate")}><input type="date" value={loanForm.autoDebitFirstDate ?? ""} onChange={(event) => setLoanField("autoDebitFirstDate", event.target.value)} className={inputClass} /></Field>
                    <Field label={t("debtTx.autoDebitAccount")}><select value={loanDetailsIsCollateralLoan ? loanForm.autoDebitCashAccountId ?? "" : loanForm.cashAccountId ?? ""} onChange={(event) => setLoanField(loanDetailsIsCollateralLoan ? "autoDebitCashAccountId" : "cashAccountId", event.target.value)} className={inputClass}><option value="">{t("txForm.selectPlaceholder")}</option>{cashAccounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
                  </div>
                ) : (
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label={t("debtTx.firstBillDate")}><input type="date" value={loanForm.firstBillDate ?? ""} onChange={(event) => setLoanField("firstBillDate", event.target.value)} className={inputClass} /></Field>
                    <Field label={t("debtTx.firstRepaymentDate")}><input type="date" value={loanForm.firstRepaymentDate ?? ""} onChange={(event) => setLoanField("firstRepaymentDate", event.target.value)} className={inputClass} /></Field>
                  </div>
                )}
              </section>
            ) : null}
            {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
            <div className="mt-4 flex justify-end gap-2"><button type="button" className="rounded border border-slate-200 px-3 py-2 text-sm text-slate-600" onClick={() => setOpen(false)} disabled={saving}>{t("common.cancel")}</button><button type="button" className="rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50" onClick={save} disabled={saving}>{saving ? t("accountTypeQuickEdit.saving") : t("common.save")}</button></div>
          </div>
        </div>, document.body,
      ) : null}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-xs text-slate-500">{label}<span className="mt-1 block">{children}</span></label>;
}
