"use client";

import { CheckCircle2, ChevronDown, Info, Plus, RefreshCw, Repeat } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { EntryTagsField } from "./EntryTagsField";
import { EntityCreateForm } from "./EntityCreateForm";
import { ModalLayerProvider, getNextModalLayerZIndex, useModalLayerZIndex } from "./ModalLayer";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { buildCategoryTreeOptions, type CategorySource } from "./categorySmartSelect";
import { institutionTypeLabel } from "@/lib/account-kinds";
import { buildAccountDisplayOption } from "@/lib/account-display";
import { recordRecentAccount, sortByAccountUsage, sortOptionsByRecent, useAccountUsage, useRecentAccountIds } from "@/lib/client/recentAccounts";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { formatDateLocal as formatDateInput, parseDateInputToUtc as dateInputToUtcDate } from "@/lib/date-utils";
import {
  fetchSettingsAccountData,
  SETTINGS_DATA_CHANGED_EVENT,
  type SettingsDataChangedDetail,
} from "@/lib/client/settingsCache";
import {
  buildMortgageLprRateAdjustments,
  calcMortgageAnnualRateFromLprDiscount,
  getLatestFiveYearLpr,
  getMortgageBankExecutionRate,
} from "@/lib/loan-lpr";
import {
  EQUAL_PAYMENT_REPAYMENT_METHOD,
  EQUAL_PRINCIPAL_REPAYMENT_METHOD,
  FREE_REPAYMENT_METHOD,
  INSTALLMENT_REPAYMENT_METHOD,
  INTEREST_FIRST_REPAYMENT_METHOD,
  allowsZeroAnnualRateRepaymentMethod,
  buildLoanRepaymentSchedulePreview,
  getEffectiveLoanAnnualRate,
  isInstallmentRepaymentMethod,
  normalizeLoanRateAdjustments,
  normalizeLoanRepaymentMethod,
  type LoanRateAdjustment,
} from "@/lib/loan-repayment";
import { formatLoanRecalculateSuccessMessage } from "@/lib/loan-repayment-recalculate-result";
import { DEFAULT_LOAN_PREPAY_STRATEGY, type LoanPrepayStrategy } from "@/lib/loan-prepay-strategy";
import { isHomeLoanType, LOAN_TYPES, resolveLoanTypeValue, type LoanTypeValue } from "@/lib/loan-type";
import {
  decodeScheduledTaskMemo,
  getLoanScheduledPlanRole,
  shouldPreferLoanAutoDebitPlan,
  shouldPreferLoanScheduledPlan,
} from "@/lib/scheduled-task";
import { useI18n } from "@/lib/i18n";
import { getAccountLabelFieldsPreference } from "@/lib/client/appPreferences";
import { restrictAccountsByType } from "@/lib/client/account-dropdown-filter";

type DebtMode = "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";
type PrepayStrategy = LoanPrepayStrategy;
type LoanFundingMode = "cash_disbursement" | "financed_purchase";
type LoanTab = LoanTypeValue | "repay_out";
type CategoryOption = {
  id: string;
  label: string;
  name?: string;
  parentId: string | null;
  type: string;
  sortOrder?: number;
  isSystem?: boolean;
};

type AccountOption = {
  id: string;
  label: string;
  subLabel?: string;
  kind?: string | null;
  institutionId?: string | null;
  counterpartyId?: string | null;
  institutionType?: string | null;
  isInstitutionLoan?: boolean;
  isConsumerLoan?: boolean;
  loanType?: LoanTypeValue | null;
  debtDirection?: "payable" | "receivable" | null;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;
type SettingsAccountRecord = {
  id: string;
  name: string;
  kind?: string | null;
  isActive?: boolean | null;
  isPlaceholder?: boolean | null;
  institutionId?: string | null;
  counterpartyId?: string | null;
  debtDirection?: "payable" | "receivable" | null;
  Institution?: { name: string | null; shortName?: string | null; type?: string | null } | null;
  Counterparty?: { name: string | null; shortName?: string | null; type?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
  isConsumerLoan?: boolean | null;
  loanType?: string | null;
};
type HistoricalRateRow = { key: string; effectiveDate: string; annualRate: string };
type RepaymentLprCheck = {
  mortgageLprDiscount: number | null;
  currentAnnualRate: number | null;
  loanRateAdjustments: LoanRateAdjustment[];
};
type RepayableLoanAccountRow = {
  accountId: string;
  balance: number;
  currentPlanId?: string | null;
  currentDueDate?: string | null;
  currentPrincipal?: number | null;
  currentInterest?: number | null;
  currentPayment?: number | null;
  currentPaidAmount?: number | null;
  currentUnpaidPeriod?: number | null;
  currentPeriodPaid?: boolean;
  // 消费贷提前还款应计利息预览（服务端按借款日至还款日按日计息）
  prepayInterest?: number | null;
  prepayInterestFromDate?: string | null;
  prepayInterestDays?: number | null;
  prepayAnnualRate?: number | null;
};
type FixedAssetAssetOption = {
  id: string;
  accountId: string;
  mortgageLoanAccountId?: string | null;
  name: string;
  status?: string | null;
};
type FixedAssetLinkedTransaction = {
  accountId: string;
  propertyAssetId: string;
};

const COUNTERPARTY_TYPES = new Set(["person", "organization"]);

const MODE_LABELS: Record<DebtMode, string> = {
  borrow_in: "debtTx.mode.borrowIn",
  repay_out: "debtShell.repayment",
  prepay_out: "debtShell.prepayment",
  lend_out: "debtTx.mode.lendOut",
  collect_in: "debtTx.mode.collectIn",
};

const LOAN_TABS: LoanTab[] = [...LOAN_TYPES, "repay_out"];

const LOAN_TAB_LABELS: Record<LoanTab, string> = {
  home: "loan.type.home",
  mortgage: "loan.type.mortgage",
  consumer: "loan.type.consumer",
  other: "loan.type.other",
  repay_out: "debtTx.loanMode.repayment",
};

const PREPAY_STRATEGY_LABELS: Record<PrepayStrategy, string> = {
  reduce_term: "debtTx.prepayStrategy.reduceTerm",
  reduce_payment: "debtTx.prepayStrategy.reducePayment",
  settle: "debtTx.prepayStrategy.settle",
};

const FIXED_REPAYMENT_METHODS = new Set(["等额本息", "等额本金", INSTALLMENT_REPAYMENT_METHOD, "先还利息一次性还本"]);

function isFixedRepaymentMethodValue(method: string) {
  return FIXED_REPAYMENT_METHODS.has(normalizeLoanRepaymentMethod(method));
}

function addMonthsInput(dateInput: string, months: number) {
  const date = new Date(`${dateInput}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return dateInput;
  date.setMonth(date.getMonth() + months);
  return formatDateInput(date);
}

function dateInputTime(value: string) {
  const time = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(time) ? time : null;
}

function shouldPromptHistoricalRepayments(params: {
  mode: DebtMode;
  isFixedRepaymentMethod: boolean;
  firstRepaymentDate: string;
  today: string;
  repaymentIntervalMonths: string;
}) {
  if (params.mode !== "borrow_in" || !params.isFixedRepaymentMethod || !params.firstRepaymentDate) return false;
  const intervalMonths = Math.max(1, Number(params.repaymentIntervalMonths) || 1);
  const thresholdTime = dateInputTime(addMonthsInput(params.today, -intervalMonths));
  const firstTime = dateInputTime(params.firstRepaymentDate);
  return firstTime != null && thresholdTime != null && firstTime <= thresholdTime;
}

function parseNumberText(value: string) {
  const text = value.replace(/,/g, "").trim();
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

function parsePositiveNumberText(value: string) {
  const num = parseNumberText(value);
  return num != null && num > 0 ? num : null;
}

function parseNonNegativeNumberText(value: string) {
  const num = parseNumberText(value);
  return num != null && num >= 0 ? num : null;
}

function parseMoneyText(value: string) {
  const num = Number(value.replace(/,/g, ""));
  return Number.isFinite(num) ? num : 0;
}

function parseAbsMoneyText(value: string) {
  return Math.abs(parseMoneyText(value));
}

function roundMoneyValue(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatMoneyPreview(value: number, language: string) {
  return value.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isValidDateInput(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
function createHistoricalRateRow(defaultDate = "", defaultRate = ""): HistoricalRateRow {
  return {
    key: `rate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    effectiveDate: defaultDate,
    annualRate: defaultRate,
  };
}

function debtObjectOptionId(id: string, type?: string | null) {
  return `${COUNTERPARTY_TYPES.has(type ?? "") ? "counterparty" : "institution"}:${id}`;
}

function isDebtObjectRef(value: string) {
  return /^(?:counterparty|institution):/.test(value);
}

function canCreateDebtItemForMode(mode: DebtMode) {
  return mode === "borrow_in" || mode === "lend_out";
}

function rawDebtObjectId(value: string) {
  const match = /^(?:counterparty|institution):(.+)$/.exec(value);
  return match?.[1] ?? value;
}

function debtDirectionForMode(mode: DebtMode): "payable" | "receivable" {
  return mode === "borrow_in" || mode === "repay_out" || mode === "prepay_out" ? "payable" : "receivable";
}

function canSwitchDebtEditMode(currentMode: DebtMode, nextMode: DebtMode) {
  if (currentMode === nextMode) return true;
  return canCreateDebtItemForMode(currentMode) && canCreateDebtItemForMode(nextMode);
}

function accountOptionLoanType(account: Pick<AccountOption, "kind" | "isInstitutionLoan" | "isConsumerLoan" | "loanType">): LoanTypeValue | null {
  if (account.kind !== "loan" && account.isInstitutionLoan !== true) return null;
  return resolveLoanTypeValue(account.loanType, account.isConsumerLoan);
}

function accountMatchesLoanType(account: AccountOption, loanType: LoanTypeValue) {
  return accountOptionLoanType(account) === loanType;
}

function settingsAccountToDebtOption(account: SettingsAccountRecord, t: (key: string, params?: Record<string, string | number>) => string): AccountOption {
  const display = buildAccountDisplayOption(account as Parameters<typeof buildAccountDisplayOption>[0], undefined, { fields: getAccountLabelFieldsPreference() });
  const counterpartyName = account.Counterparty?.shortName?.trim() || account.Counterparty?.name?.trim() || "";
  const institutionType = account.Institution?.type ?? null;
  const isInstitutionLoan = Boolean(account.kind === "loan" && !account.counterpartyId);
  return {
    id: account.id,
    label: display.selectorLabel || display.label,
    subLabel: counterpartyName ? t("debtTx.subLabel.settlement", { name: counterpartyName }) : display.subLabel,
    kind: account.kind ?? null,
    institutionId: account.institutionId ?? null,
    counterpartyId: account.counterpartyId ?? null,
    institutionType,
    isInstitutionLoan,
    isConsumerLoan: account.isConsumerLoan === true,
    loanType: isInstitutionLoan ? resolveLoanTypeValue(account.loanType, account.isConsumerLoan) : null,
    debtDirection: account.debtDirection ?? null,
  };
}

function normalizeDebtObjectValue(value: string | undefined, data?: NestedFieldData) {
  const id = String(value ?? "").trim();
  if (!id || isDebtObjectRef(id)) return id;
  if ((data?.counterpartyId ?? []).some((entry) => entry.id === id)) return `counterparty:${id}`;
  const item = (data?.institutionId ?? []).find((entry) => entry.id === id);
  return item ? debtObjectOptionId(item.id, item.type) : id;
}

function serializeHistoricalRateRows(rows: HistoricalRateRow[], t: (key: string, params?: Record<string, string | number>) => string) {
  const filledRows = rows.filter((row) => row.effectiveDate.trim() || row.annualRate.trim());
  if (filledRows.length === 0) {
    return { ok: false as const, error: t("debtTx.historicalRate.minOne") };
  }

  const seenDates = new Set<string>();
  const normalized = filledRows.map((row) => {
    const effectiveDate = row.effectiveDate.trim();
    const annualRate = Number(row.annualRate.trim());
    if (!isValidDateInput(effectiveDate)) {
      return { ok: false as const, error: t("debtTx.historicalRate.invalidDate") };
    }
    if (seenDates.has(effectiveDate)) {
      return { ok: false as const, error: t("debtTx.historicalRate.duplicateDate", { date: effectiveDate }) };
    }
    seenDates.add(effectiveDate);
    if (!Number.isFinite(annualRate) || annualRate < 0) {
      return { ok: false as const, error: t("debtTx.historicalRate.mustBePositive") };
    }
    return { ok: true as const, effectiveDate, annualRate };
  });
  const invalid = normalized.find((row) => !row.ok);
  if (invalid && !invalid.ok) return invalid;

  const text = normalized
    .filter((row): row is { ok: true; effectiveDate: string; annualRate: number } => row.ok)
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
    .map((row) => `${row.effectiveDate} ${row.annualRate}`)
    .join("\n");

  return { ok: true as const, text };
}

export function DebtTransactionModal({
  dialogType = "debt",
  debtAccounts,
  cashAccounts,
  debtObjectOptions,
  cashAccountSSOptions,
  nestedFieldData,
  expenseCategories,
  fixedAssetAccounts,
  fixedAssetAccountSSOptions,
  defaultDebtAccountId,
  defaultDebtInstitutionId,
  defaultCashAccountId,
  action,
  showTriggerButton = true,
  triggerLabel,
}: {
  dialogType?: "debt" | "loan";
  debtAccounts: AccountOption[];
  cashAccounts: AccountOption[];
  debtObjectOptions?: SmartSelectOption[];
  cashAccountSSOptions?: SmartSelectOption[];
  nestedFieldData?: NestedFieldData;
  expenseCategories?: CategoryOption[];
  fixedAssetAccounts?: SmartSelectOption[];
  fixedAssetAccountSSOptions?: SmartSelectOption[];
  defaultDebtAccountId?: string;
  defaultDebtInstitutionId?: string;
  defaultCashAccountId?: string;
  action: (formData: FormData) => Promise<
    | { ok: true; warning?: string; recalculateAfterSave?: { accountId: string; startDate: string } | null }
    | { ok: false; error: string }
  >;
  showTriggerButton?: boolean;
  triggerLabel?: string;
}) {
  const isLoanDialog = dialogType === "loan";
  const today = useMemo(() => formatDateInput(new Date()), []);
  const { t, language } = useI18n();
  const parentModalZIndex = useModalLayerZIndex();
  const modalZIndex = getNextModalLayerZIndex(parentModalZIndex);
  const confirmModalZIndex = getNextModalLayerZIndex(modalZIndex);
  const rateModalZIndex = getNextModalLayerZIndex(confirmModalZIndex);
  const [localDebtAccounts, setLocalDebtAccounts] = useState(debtAccounts);
  const [localDebtObjectOptions, setLocalDebtObjectOptions] = useState(debtObjectOptions);
  const [localNestedFieldData, setLocalNestedFieldData] = useState<NestedFieldData | undefined>(nestedFieldData);
  const [debtObjectNestedOpen, setDebtObjectNestedOpen] = useState(false);
  const fallbackDebtObjectOptions: SmartSelectOption[] = useMemo(() => {
    const counterpartyOptions = isLoanDialog ? [] : (localNestedFieldData?.counterpartyId ?? []).map((item) => ({
      id: `counterparty:${item.id}`,
      label: item.name,
      subLabel: item.type === "person" ? t("debtTx.objectType.person") : t("debtTx.objectType.organization"),
    }));
    const institutionOptions = isLoanDialog
      ? (localNestedFieldData?.institutionId ?? [])
          .filter((item) => item.type === "bank" || item.type === "debt")
          .map((item) => ({
            id: `institution:${item.id}`,
            label: item.name,
            subLabel: institutionTypeLabel(item.type ?? null),
          }))
      : [];

    return [
      ...(counterpartyOptions.length > 0
        ? [{ id: "debt-counterparty-header", label: t("txForm.counterparty"), isHeader: true }, ...counterpartyOptions]
        : []),
      ...(institutionOptions.length > 0
        ? [{ id: "debt-institution-source-header", label: t("debtTx.loanInstitutionHeader"), isHeader: true }, ...institutionOptions]
        : []),
    ];
  }, [isLoanDialog, localNestedFieldData, t]);
  const visibleDebtObjectOptions = useMemo(
    () => mergeSmartSelectOptions(
      mergeSmartSelectOptions(debtObjectOptions, localDebtObjectOptions),
      fallbackDebtObjectOptions,
    ),
    [debtObjectOptions, fallbackDebtObjectOptions, localDebtObjectOptions],
  );
  const cashOptions: SmartSelectOption[] = useMemo(
    () => cashAccounts.map((item) => ({ id: item.id, label: item.label, subLabel: item.subLabel, kind: item.kind })),
    [cashAccounts],
  );
  const {
    ownerFilterLabel: cashOwnerFilterLabel,
    cycleOwnerFilter: cycleCashOwnerFilter,
    filteredOptions: cashAccountSSFiltered,
  } = useAccountSSFilter(cashAccountSSOptions);
  const recentAccountIds = useRecentAccountIds();
  const visibleCashOptions = sortOptionsByRecent(cashAccountSSFiltered ?? cashAccountSSOptions ?? cashOptions, recentAccountIds);
  const cashOwnerCycleButton = cashAccountSSOptions?.some((option) => option.isHeader) ? (
    <button
      type="button"
      onClick={cycleCashOwnerFilter}
      title={t("debtTx.ownerFilterTitle", { label: cashOwnerFilterLabel })}
      aria-label={t("debtTx.ownerFilterAria", { label: cashOwnerFilterLabel })}
      className="secondary-button !px-0 h-7 w-7 shrink-0 text-slate-500"
    >
      <Repeat className="h-3.5 w-3.5" />
    </button>
  ) : undefined;

  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState("");
  // True when the open/edit event already carried repayment-plan defaults
  // (debt-side edit); the plan fetch prefill then stays off.
  const planDefaultsFromEventRef = useRef(false);
  const [debtAccountNestedOpen, setDebtAccountNestedOpen] = useState(false);
  const [mode, setMode] = useState<DebtMode>("borrow_in");
  const [loanFundingMode, setLoanFundingMode] = useState<LoanFundingMode>("cash_disbursement");
  const [loanType, setLoanType] = useState<LoanTypeValue | null>(null);
  const [date, setDate] = useState(today);
  const [debtAccountId, setDebtAccountId] = useState(defaultDebtAccountId ?? debtAccounts[0]?.id ?? "");
  const [debtInstitutionId, setDebtInstitutionId] = useState(normalizeDebtObjectValue(defaultDebtInstitutionId, nestedFieldData));
  const [debtItemName, setDebtItemName] = useState("");
  const [cashAccountId, setCashAccountId] = useState(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
  const [autoDebitCashAccountId, setAutoDebitCashAccountId] = useState(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
  const [principal, setPrincipal] = useState("");
  const [originalPrincipalForEdit, setOriginalPrincipalForEdit] = useState("");
  const [editRecalculateStartDate, setEditRecalculateStartDate] = useState("");
  const [interest, setInterest] = useState("");
  const [penalty, setPenalty] = useState("");
  const [prepayTotal, setPrepayTotal] = useState("");
  const [prepayTotalManual, setPrepayTotalManual] = useState(false);
  const [prepayInterestManual, setPrepayInterestManual] = useState(false);
  const [prepayStrategy, setPrepayStrategy] = useState<PrepayStrategy>(DEFAULT_LOAN_PREPAY_STRATEGY);
  const [annualRate, setAnnualRate] = useState("");
  const [annualRateManuallyEdited, setAnnualRateManuallyEdited] = useState(false);
  const [mortgageLprDiscount, setMortgageLprDiscount] = useState("");
  const [repaymentMethod, setRepaymentMethod] = useState(FREE_REPAYMENT_METHOD);
  // Loan repayment execution mode: auto-debit or bill-only.
  const [autoDebit, setAutoDebit] = useState(true);
  const [autoDebitFirstDate, setAutoDebitFirstDate] = useState(addMonthsInput(today, 1));
  const [repaymentIntervalMonths, setRepaymentIntervalMonths] = useState("1");
  const [loanTotalRuns, setLoanTotalRuns] = useState("300");
  const [firstBillDate, setFirstBillDate] = useState(addMonthsInput(today, 1));
  const [firstRepaymentDate, setFirstRepaymentDate] = useState(addMonthsInput(today, 1));
  const [note, setNote] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [historyConfirmOpen, setHistoryConfirmOpen] = useState(false);
  const [pendingKeepAdding, setPendingKeepAdding] = useState(false);
  const [createHistoricalRepaymentRecords, setCreateHistoricalRepaymentRecords] = useState(false);
  const [showHistoricalRates, setShowHistoricalRates] = useState(false);
  const [historicalRateRows, setHistoricalRateRows] = useState<HistoricalRateRow[]>([]);
  const [historicalRatesOpen, setHistoricalRatesOpen] = useState(false);
  const [repaymentLprCheck, setRepaymentLprCheck] = useState<RepaymentLprCheck | null>(null);
  const [repayableLoanAccountRows, setRepayableLoanAccountRows] = useState<RepayableLoanAccountRow[]>([]);
  const [repayableLoanAccountsLoading, setRepayableLoanAccountsLoading] = useState(false);
  const [activeLoanTab, setActiveLoanTab] = useState<LoanTab>("consumer");
  const [loanPurposeCategoryId, setLoanPurposeCategoryId] = useState("");
  const [fixedAssetLinked, setFixedAssetLinked] = useState(false);
  const [fixedAssetAccountId, setFixedAssetAccountId] = useState("");
  const [fixedAssetAssetId, setFixedAssetAssetId] = useState("");
  const [fixedAssetAccountList, setFixedAssetAccountList] = useState<SmartSelectOption[]>(fixedAssetAccounts ?? []);
  const [localFixedAssetAccountSSOpts, setLocalFixedAssetAccountSSOpts] = useState<SmartSelectOption[] | undefined>(fixedAssetAccountSSOptions);
  const [fixedAssetAssets, setFixedAssetAssets] = useState<FixedAssetAssetOption[]>([]);
  const [fixedAssetAssetsLoading, setFixedAssetAssetsLoading] = useState(false);
  // Linked fixed asset of the edited borrow record; undefined until fetched.
  const [fixedAssetLinkedTx, setFixedAssetLinkedTx] = useState<FixedAssetLinkedTransaction | null | undefined>(undefined);
  const [fixedAssetAccountNestedOpen, setFixedAssetAccountNestedOpen] = useState(false);
  // One-shot guard: prefill the linked fixed asset at most once per edit open,
  // so the user can still unlink it afterwards.
  const fixedAssetLinkPrefilledRef = useRef(false);

  function mergeSmartSelectOptions(base?: SmartSelectOption[], extra?: SmartSelectOption[]) {
    const merged = [...(base ?? [])];
    const seen = new Set(merged.map((option) => option.id));
    for (const option of extra ?? []) {
      if (!seen.has(option.id)) merged.push(option);
    }
    return merged;
  }

  async function openDebtObjectCreate() {
    setDebtObjectNestedOpen(true);
    const res = await fetch("/api/v1/accounts/internal?balances=false", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const data = await res.json().catch(() => null);
    if (!data?.ok) return;
    setLocalNestedFieldData({
      groupId: (data.groups ?? [])
        .filter((group: { name: string }) => group.name !== "未指定")
        .map((group: { id: string; name: string }) => ({ id: group.id, name: group.name })),
      institutionId: (data.institutions ?? []).map((institution: { id: string; name: string; shortName?: string | null; type?: string | null }) => ({
        id: institution.id,
        name: institution.shortName?.trim() || institution.name,
        type: institution.type ?? "",
      })),
      counterpartyId: (data.counterparties ?? []).map((counterparty: { id: string; name: string; shortName?: string | null; type?: string | null }) => ({
        id: counterparty.id,
        name: counterparty.shortName?.trim() || counterparty.name,
        type: counterparty.type ?? "organization",
      })),
    });
  }

  function openDebtAccountCreate() {
    if (!isDebtObjectRef(debtInstitutionId)) return;
    setDebtAccountNestedOpen(true);
  }

  const resetDraft = useCallback(() => {
    const normalizedDefaultObject = normalizeDebtObjectValue(defaultDebtInstitutionId, localNestedFieldData ?? nestedFieldData);
    const defaultDebtAccount = defaultDebtAccountId
      ? localDebtAccounts.find((account) => account.id === defaultDebtAccountId)
      : undefined;
    const defaultAccountObject = debtObjectValueForAccount(defaultDebtAccount);
    const nextDebtObjectId = normalizedDefaultObject || defaultAccountObject;
    setMode("borrow_in");
    setLoanFundingMode(isLoanDialog ? "financed_purchase" : "cash_disbursement");
    setLoanType(null);
    setEditingEntryId("");
    setDate(today);
    setDebtInstitutionId(nextDebtObjectId);
    setDebtAccountId(nextDebtObjectId && defaultDebtAccountId ? defaultDebtAccountId : "");
    setDebtItemName("");
    setCashAccountId(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
    setAutoDebitCashAccountId(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
    setPrincipal("");
    setOriginalPrincipalForEdit("");
    setEditRecalculateStartDate("");
    setInterest("");
    setPenalty("");
    setPrepayTotal("");
    setPrepayTotalManual(false);
    setPrepayStrategy(DEFAULT_LOAN_PREPAY_STRATEGY);
    setAnnualRate("");
    setAnnualRateManuallyEdited(false);
    setMortgageLprDiscount("");
    setRepaymentMethod(FREE_REPAYMENT_METHOD);
    setAutoDebit(isLoanDialog ? false : true);
    setAutoDebitFirstDate(addMonthsInput(today, 1));
    setRepaymentIntervalMonths("1");
    setLoanTotalRuns("300");
    setFirstBillDate(addMonthsInput(today, 1));
    setFirstRepaymentDate(addMonthsInput(today, 1));
    setNote("");
    setSelectedTagIds([]);
    setHistoryConfirmOpen(false);
    setPendingKeepAdding(false);
    setCreateHistoricalRepaymentRecords(false);
    setShowHistoricalRates(false);
    setHistoricalRateRows([]);
    setHistoricalRatesOpen(false);
    setRepaymentLprCheck(null);
    setRepayableLoanAccountRows([]);
    setRepayableLoanAccountsLoading(false);
    setActiveLoanTab("consumer");
    setLoanPurposeCategoryId("");
    setFixedAssetLinked(false);
    setFixedAssetAccountId("");
    setFixedAssetAssetId("");
    setFixedAssetAssets([]);
    setFixedAssetAssetsLoading(false);
    setFixedAssetAccountNestedOpen(false);
  }, [cashAccounts, defaultCashAccountId, defaultDebtAccountId, defaultDebtInstitutionId, isLoanDialog, localDebtAccounts, localNestedFieldData, nestedFieldData, today]);

  useEffect(() => {
    setLocalDebtAccounts(debtAccounts);
  }, [debtAccounts]);

  useEffect(() => {
    setLocalDebtObjectOptions(debtObjectOptions);
  }, [debtObjectOptions]);

  useEffect(() => {
    setLocalNestedFieldData(nestedFieldData);
  }, [nestedFieldData]);

  useEffect(() => {
    setFixedAssetAccountList(fixedAssetAccounts ?? []);
  }, [fixedAssetAccounts]);

  useEffect(() => {
    if (fixedAssetAccountSSOptions) {
      setLocalFixedAssetAccountSSOpts((prev) => mergeSmartSelectOptions(fixedAssetAccountSSOptions, prev));
    }
  }, [fixedAssetAccountSSOptions]);

  useEffect(() => {
    if (!open || !isLoanDialog) {
      setFixedAssetAssets([]);
      setFixedAssetAssetsLoading(false);
      setFixedAssetLinkedTx(undefined);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setFixedAssetAssetsLoading(true);
    // transactions=0: the full transaction list is never used by this dialog.
    // Borrow-edit opens also ask for the single property transaction linked to
    // the edited record (fixed-asset prefill) instead of scanning the list.
    const params = new URLSearchParams({ transactions: "0" });
    if (mode === "borrow_in" && editingEntryId) params.set("linkedCashEntryId", editingEntryId);
    fetch(`/api/v1/properties?${params.toString()}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (cancelled) return;
        const assets = Array.isArray(payload?.data?.assets) ? payload.data.assets : [];
        setFixedAssetAssets(assets.flatMap((asset: { id?: unknown; accountId?: unknown; mortgageLoanAccountId?: unknown; name?: unknown; status?: unknown }) => {
          const id = typeof asset.id === "string" ? asset.id : "";
          const accountId = typeof asset.accountId === "string" ? asset.accountId : "";
          const name = typeof asset.name === "string" ? asset.name : "";
          if (!id || !accountId || !name) return [];
          return [{
            id,
            accountId,
            name,
            mortgageLoanAccountId: typeof asset.mortgageLoanAccountId === "string" ? asset.mortgageLoanAccountId : null,
            status: typeof asset.status === "string" ? asset.status : null,
          }];
        }));
        const linked = payload?.data?.linkedTransaction;
        setFixedAssetLinkedTx(linked && typeof linked === "object"
          ? {
              accountId: typeof linked.accountId === "string" ? linked.accountId : "",
              propertyAssetId: typeof linked.propertyAssetId === "string" ? linked.propertyAssetId : "",
            }
          : null);
      })
      .catch(() => {
        if (!cancelled) {
          setFixedAssetAssets([]);
          setFixedAssetLinkedTx(null);
        }
      })
      .finally(() => {
        if (!cancelled) setFixedAssetAssetsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isLoanDialog, mode, editingEntryId, open]);

  useEffect(() => {
    let cancelled = false;
    async function refreshDebtSettingsData() {
      const data = await fetchSettingsAccountData({ force: true }).catch(() => null);
      if (cancelled || !data) return;
      const debtRows = restrictAccountsByType(
        (data.accounts as SettingsAccountRecord[]).filter(
          (account) => account.isPlaceholder !== true && account.isActive !== false,
        ),
        (account) => account.kind === "loan" || account.kind === "settlement",
      );
      setLocalDebtAccounts(debtRows.map((account) => settingsAccountToDebtOption(account, t)));
      const nextNested: NestedFieldData = {
        groupId: (data.groups ?? []).map((group) => ({ id: group.id, name: group.name })),
        institutionId: (data.institutions ?? []).map((institution) => ({
          id: institution.id,
          name: institution.shortName?.trim() || institution.name,
          type: institution.type ?? "",
        })),
        counterpartyId: (data.counterparties ?? []).map((counterparty) => ({
          id: counterparty.id,
          name: counterparty.shortName?.trim() || counterparty.name,
          type: counterparty.type ?? "organization",
        })),
      };
      setLocalNestedFieldData(nextNested);
      const counterpartyOptions = nextNested.counterpartyId.map((item) => ({
        id: debtObjectOptionId(item.id, item.type),
        label: item.name,
        subLabel: item.type === "person" ? t("debtTx.objectType.person") : t("debtTx.objectType.organization"),
      }));
      const institutionOptions = nextNested.institutionId
        .filter((item) => item.type === "bank" || item.type === "debt")
        .map((item) => ({
          id: debtObjectOptionId(item.id, item.type),
          label: item.name,
          subLabel: institutionTypeLabel(item.type ?? null),
        }));
      setLocalDebtObjectOptions(mergeSmartSelectOptions(debtObjectOptions, isLoanDialog ? institutionOptions : counterpartyOptions));
    }

    function onSettingsChanged(ev: Event) {
      const detail = (ev as CustomEvent<SettingsDataChangedDetail>).detail;
      const scope = detail?.scope ?? "all";
      if (scope === "accounts" || scope === "all") void refreshDebtSettingsData();
    }

    window.addEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    };
  }, [debtObjectOptions, isLoanDialog, t]);

  useEffect(() => {
    function onCreate(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId?: string;
        editEntryId?: string;
        mode?: DebtMode;
        loanType?: LoanTypeValue;
        defaultDebtAccountId?: string;
        defaultDebtAccountName?: string | null;
        defaultLoanPurposeCategoryId?: string | null;
        defaultDebtInstitutionId?: string;
        defaultCashAccountId?: string;
        defaultAutoDebitCashAccountId?: string;
        defaultFixedAssetAccountId?: string;
        defaultFixedAssetAssetId?: string;
        defaultDate?: string;
        defaultPrincipal?: number | string | null;
        defaultInterest?: number | string | null;
        defaultPenalty?: number | string | null;
        defaultRecalculateStartDate?: string | null;
        defaultPrepayStrategy?: PrepayStrategy;
        defaultCurrentAnnualRate?: number | null;
        defaultMortgageLprDiscount?: number | null;
        defaultLoanRateAdjustments?: LoanRateAdjustment[];
        defaultLoanFundingMode?: LoanFundingMode;
        defaultNote?: string | null;
        defaultRepaymentMethod?: string | null;
        defaultAnnualRate?: number | null;
        defaultRepaymentIntervalMonths?: number | null;
        defaultLoanTotalRuns?: number | null;
        defaultFirstBillDate?: string | null;
        defaultFirstRepaymentDate?: string | null;
        defaultAutoDebit?: boolean | null;
        defaultAutoDebitFirstDate?: string | null;
        defaultTagIds?: string[] | null;
      }>).detail;
      const detailLoanType = detail?.loanType ? resolveLoanTypeValue(detail.loanType, detail.loanType === "consumer") : null;
      const isLoanRepaymentEvent = isLoanDialog && (detail?.mode === "repay_out" || detail?.mode === "prepay_out");
      // Edit events opened outside the debt module (e.g. account detail view) may
      // not carry loanType; derive it from the edited loan account so the correct
      // loan tab opens instead of always defaulting to consumer.
      const editEventDebtAccount = isLoanDialog && detail?.editEntryId && detail.mode === "borrow_in" && detail.defaultDebtAccountId
        ? localDebtAccounts.find((account) => account.id === detail.defaultDebtAccountId)
        : undefined;
      const editEventLoanType = editEventDebtAccount ? accountOptionLoanType(editEventDebtAccount) : null;
      const effectiveLoanType = detailLoanType ?? editEventLoanType;
      resetDraft();
      fixedAssetLinkPrefilledRef.current = false;
      planDefaultsFromEventRef.current = !!(
        detail?.defaultRepaymentMethod ||
        detail?.defaultRepaymentIntervalMonths != null ||
        detail?.defaultLoanTotalRuns != null ||
        detail?.defaultFirstRepaymentDate ||
        detail?.defaultAnnualRate != null
      );
      if (detail?.editEntryId) setEditingEntryId(detail.editEntryId);
      if (detail?.mode) setMode(detail.mode);
      if (isLoanRepaymentEvent) {
        setActiveLoanTab("repay_out");
        if (detailLoanType) setLoanType(detailLoanType);
        setLoanFundingMode("cash_disbursement");
      } else if (effectiveLoanType) {
        setLoanType(effectiveLoanType);
        setActiveLoanTab(effectiveLoanType);
        if (effectiveLoanType === "consumer") {
          setLoanFundingMode("financed_purchase");
          setRepaymentMethod(EQUAL_PAYMENT_REPAYMENT_METHOD);
          setLoanTotalRuns("12");
          setAutoDebit(false);
          setAutoDebitFirstDate(addMonthsInput(today, 1));
        } else if (effectiveLoanType === "mortgage") {
          setLoanFundingMode("cash_disbursement");
          setRepaymentMethod(EQUAL_PAYMENT_REPAYMENT_METHOD);
          setLoanTotalRuns("300");
          setAutoDebit(false);
          setAutoDebitFirstDate(addMonthsInput(today, 1));
        } else {
          setLoanFundingMode("financed_purchase");
          setRepaymentMethod(EQUAL_PAYMENT_REPAYMENT_METHOD);
          setLoanTotalRuns("300");
          setAutoDebit(effectiveLoanType === "home");
          setAutoDebitFirstDate(addMonthsInput(today, 1));
        }
      } else if (detail?.mode === "repay_out" || detail?.mode === "prepay_out") {
        setMode(detail.mode);
        setActiveLoanTab("repay_out");
      }
      if (detail?.defaultLoanFundingMode) setLoanFundingMode(detail.defaultLoanFundingMode);
      if (detail?.defaultDate) setDate(detail.defaultDate);
      const eventDebtAccount = detail?.defaultDebtAccountId
        ? localDebtAccounts.find((account) => account.id === detail.defaultDebtAccountId)
        : undefined;
      const eventDebtObject = debtObjectValueForAccount(eventDebtAccount);
      if (detail?.defaultDebtInstitutionId) {
        setDebtInstitutionId(normalizeDebtObjectValue(detail.defaultDebtInstitutionId, localNestedFieldData ?? nestedFieldData));
      } else if (eventDebtObject) {
        setDebtInstitutionId(eventDebtObject);
      }
      if (detail?.defaultDebtAccountId) {
        setDebtAccountId(detail.defaultDebtAccountId);
      } else if (detailLoanType) {
        // When no account is supplied, select the first account matching the loan type.
        const matched = localDebtAccounts.find((account) => accountMatchesLoanType(account, detailLoanType));
        if (matched) {
          setDebtAccountId(matched.id);
          setDebtInstitutionId(debtObjectValueForAccount(matched));
        }
      }
      if (detail?.defaultDebtAccountName) setDebtItemName(detail.defaultDebtAccountName);
      if (
        detail?.defaultLoanPurposeCategoryId &&
        (!effectiveLoanType || effectiveLoanType === "consumer") &&
        expenseCategories?.some((category) => category.id === detail.defaultLoanPurposeCategoryId)
      ) {
        setLoanPurposeCategoryId(detail.defaultLoanPurposeCategoryId);
      }
      if (detail?.defaultCashAccountId) setCashAccountId(detail.defaultCashAccountId);
      if (detail?.defaultAutoDebitCashAccountId) setAutoDebitCashAccountId(detail.defaultAutoDebitCashAccountId);
      else if (detail?.defaultCashAccountId) setAutoDebitCashAccountId(detail.defaultCashAccountId);
      if (detail?.defaultAutoDebit != null) setAutoDebit(detail.defaultAutoDebit);
      if (detail?.defaultPrincipal != null) {
        const nextPrincipal = String(parseAbsMoneyText(String(detail.defaultPrincipal)));
        setPrincipal(nextPrincipal);
        setOriginalPrincipalForEdit(nextPrincipal);
      }
      if (detail?.defaultRecalculateStartDate) setEditRecalculateStartDate(detail.defaultRecalculateStartDate);
      if (detail?.defaultInterest != null) {
        setInterest(String(parseAbsMoneyText(String(detail.defaultInterest))));
        if (detail?.mode === "prepay_out") setPrepayInterestManual(true);
      }
      if (detail?.defaultPenalty != null) {
        const nextPenalty = String(parseAbsMoneyText(String(detail.defaultPenalty)));
        setPenalty(nextPenalty);
        if (detail?.mode === "prepay_out") {
          const editInterest = detail.defaultInterest != null ? parseAbsMoneyText(String(detail.defaultInterest)) : 0;
          setPrepayTotal(roundMoneyValue(parseAbsMoneyText(String(detail.defaultPrincipal ?? "")) + editInterest + parseMoneyText(nextPenalty)).toFixed(2));
          setPrepayTotalManual(false);
        }
      }
      if (detail?.defaultPrepayStrategy) setPrepayStrategy(detail.defaultPrepayStrategy);
      if (detail?.defaultNote != null) setNote(String(detail.defaultNote));
      if (Array.isArray(detail?.defaultTagIds)) setSelectedTagIds(detail.defaultTagIds.filter((id): id is string => typeof id === "string" && id.length > 0));
      if (detail?.defaultRepaymentMethod) setRepaymentMethod(normalizeLoanRepaymentMethod(detail.defaultRepaymentMethod));
      if (detail?.defaultAnnualRate != null && Number.isFinite(detail.defaultAnnualRate)) {
        setAnnualRate(formatRateInput(detail.defaultAnnualRate));
      } else if (detail?.defaultRepaymentMethod && isInstallmentRepaymentMethod(detail.defaultRepaymentMethod)) {
        setAnnualRate("0");
      }
      if (detail?.defaultMortgageLprDiscount != null && Number.isFinite(detail.defaultMortgageLprDiscount)) {
        setMortgageLprDiscount(formatRateInput(detail.defaultMortgageLprDiscount));
      }
      if (detail?.defaultRepaymentIntervalMonths != null && Number.isFinite(detail.defaultRepaymentIntervalMonths)) {
        setRepaymentIntervalMonths(String(detail.defaultRepaymentIntervalMonths));
      }
      if (detail?.defaultLoanTotalRuns != null && Number.isFinite(detail.defaultLoanTotalRuns)) {
        setLoanTotalRuns(String(detail.defaultLoanTotalRuns));
      }
      if (detail?.defaultFirstBillDate) setFirstBillDate(detail.defaultFirstBillDate);
      if (detail?.defaultFirstRepaymentDate) setFirstRepaymentDate(detail.defaultFirstRepaymentDate);
      if (detail?.defaultAutoDebitFirstDate) setAutoDebitFirstDate(detail.defaultAutoDebitFirstDate);
      else if (detail?.defaultFirstRepaymentDate) setAutoDebitFirstDate(detail.defaultFirstRepaymentDate);
      if (detail?.defaultFixedAssetAccountId) setFixedAssetAccountId(detail.defaultFixedAssetAccountId);
      if (detail?.defaultFixedAssetAssetId) setFixedAssetAssetId(detail.defaultFixedAssetAssetId);
      if (detail?.defaultFixedAssetAccountId || detail?.defaultFixedAssetAssetId) setFixedAssetLinked(true);
      if (detail?.defaultLoanRateAdjustments && detail.defaultLoanRateAdjustments.length > 0) {
        setHistoricalRateRows(detail.defaultLoanRateAdjustments.map((item) =>
          createHistoricalRateRow(item.effectiveDate, formatRateInput(item.annualRate)),
        ));
        setShowHistoricalRates(true);
      }
      if (detail?.mode === "repay_out" || detail?.mode === "prepay_out") {
        setRepaymentLprCheck({
          mortgageLprDiscount: detail.defaultMortgageLprDiscount ?? null,
          currentAnnualRate: detail.defaultCurrentAnnualRate ?? null,
          loanRateAdjustments: detail.defaultLoanRateAdjustments ?? [],
        });
      }
      setOpen(true);
    }
    const createEventName = isLoanDialog ? "mmh:loan:create" : "mmh:debt:create";
    window.addEventListener(createEventName, onCreate as EventListener);
    return () => window.removeEventListener(createEventName, onCreate as EventListener);
  }, [defaultCashAccountId, defaultDebtAccountId, expenseCategories, isLoanDialog, localDebtAccounts, localNestedFieldData, nestedFieldData, resetDraft, today]);
  useCloseOnNavigation(open, () => {
    setOpen(false);
    resetDraft();
  });

  const prepayComputedTotal = useMemo(() => {
    if (mode !== "prepay_out") return "";
    if (!principal.trim() && !penalty.trim() && !interest.trim()) return "";
    return roundMoneyValue(parseAbsMoneyText(principal) + parseMoneyText(interest) + parseMoneyText(penalty)).toFixed(2);
  }, [mode, interest, penalty, principal]);

  useEffect(() => {
    if (mode !== "prepay_out" || prepayTotalManual) return;
    setPrepayTotal(prepayComputedTotal);
  }, [mode, prepayComputedTotal, prepayTotalManual]);

  const findDebtAccountForObject = useCallback((objectValue: string, direction: "payable" | "receivable") => {
    if (!isDebtObjectRef(objectValue)) return null;
    const rawId = rawDebtObjectId(objectValue);
    const matchedAccounts = localDebtAccounts.filter((account) => {
      if (objectValue.startsWith("counterparty:")) return account.counterpartyId === rawId;
      return account.institutionId === rawId;
    });
    return matchedAccounts.find((account) => account.debtDirection === direction) ?? matchedAccounts[0] ?? null;
  }, [localDebtAccounts]);

  useEffect(() => {
    if (!!editingEntryId || mode === "prepay_out" || !debtInstitutionId.startsWith("counterparty:")) return;
    const existingAccount = findDebtAccountForObject(debtInstitutionId, debtDirectionForMode(mode));
    setDebtAccountId(existingAccount?.id ?? "");
  }, [debtInstitutionId, editingEntryId, findDebtAccountForObject, mode]);

  function applyPrepayTotalDraft(options?: { alertOnInvalid?: boolean }) {
    if (mode !== "prepay_out" || !prepayTotal.trim()) return penalty;
    const total = roundMoneyValue(parseMoneyText(prepayTotal));
    const principalAmount = roundMoneyValue(parseAbsMoneyText(principal));
    const interestAmount = roundMoneyValue(showPrepayInterest ? parseMoneyText(interest) : 0);
    if (total + 0.005 < principalAmount + interestAmount) {
      if (options?.alertOnInvalid) window.alert(t("debtTx.alert.expenseTotalTooSmall"));
      setPrepayTotal(prepayComputedTotal);
      setPrepayTotalManual(false);
      return penalty;
    }
    const nextPenalty = roundMoneyValue(total - principalAmount - interestAmount).toFixed(2);
    setPenalty(nextPenalty);
    setPrepayTotal(total.toFixed(2));
    setPrepayTotalManual(false);
    return nextPenalty;
  }

  function handlePrincipalChange(value: string) {
    setPrincipal(value);
    if (mode === "prepay_out") setPrepayTotalManual(false);
  }

  function handlePenaltyChange(value: string) {
    setPenalty(value);
    if (mode === "prepay_out") setPrepayTotalManual(false);
  }

  function handlePrepayInterestChange(value: string) {
    setInterest(value);
    setPrepayInterestManual(true);
    if (mode === "prepay_out") setPrepayTotalManual(false);
  }

  function handlePrepayTotalChange(value: string) {
    setPrepayTotal(value);
    setPrepayTotalManual(true);
  }

  function debtObjectValueForAccount(account: AccountOption | undefined) {
    if (!account) return "";
    if (account.counterpartyId) return `counterparty:${account.counterpartyId}`;
    if (account.institutionId) return `institution:${account.institutionId}`;
    return "";
  }

  function applyScheduledLoanRepaymentDraft(id: string) {
    if (!id) return;
    const row = repayableLoanAccountRows.find((item) => item.accountId === id);
    const scheduledPrincipal = row?.currentPrincipal;
    const scheduledInterest = row?.currentInterest;
    if (
      !row?.currentPeriodPaid &&
      scheduledPrincipal != null &&
      scheduledInterest != null &&
      scheduledPrincipal + scheduledInterest > 0
    ) {
      setPrincipal(String(Math.round(scheduledPrincipal * 100) / 100));
      if (repaymentMethod !== FREE_REPAYMENT_METHOD && showInterest) {
        setInterest(Number.isFinite(scheduledInterest)
          ? String(Math.round(scheduledInterest * 100) / 100)
          : "");
      }
    } else if (row?.currentPeriodPaid) {
      setPrincipal("");
      setInterest("");
    }
  }

  function handleDebtAccountChange(id: string) {
    setDebtAccountId(id);
    setDebtItemName("");
    if (!id) return;
    const account = localDebtAccounts.find((item) => item.id === id);
    const objectValue = debtObjectValueForAccount(account);
    if (objectValue) setDebtInstitutionId(objectValue);
    // Selecting a loan is a source-field change, so replace any prior account's defaults.
    if (mode === "repay_out" && !editingEntryId) {
      applyScheduledLoanRepaymentDraft(id);
    }
  }

  function handleDebtItemOrObjectChange(id: string) {
    if (id && !isDebtObjectRef(id)) {
      handleDebtAccountChange(id);
      return;
    }
    const existingAccount = id.startsWith("counterparty:") ? findDebtAccountForObject(id, debtDirectionForMode(mode)) : null;
    setDebtInstitutionId(id);
    setDebtAccountId(existingAccount?.id ?? "");
    setDebtItemName("");
  }

  function handleModeSelect(nextMode: DebtMode) {
    if (editingEntryId && !canSwitchDebtEditMode(mode, nextMode)) return;
    setMode(nextMode);
    if (principal.trim()) setPrincipal(String(parseAbsMoneyText(principal)));
    if (isLoanDialog && (nextMode === "repay_out" || nextMode === "prepay_out")) {
      setActiveLoanTab("repay_out");
      if (nextMode === "repay_out") {
        applyScheduledLoanRepaymentDraft(debtAccountId);
      } else {
        setInterest("");
        setPrepayTotalManual(false);
        setPrepayTotal("");
      }
      return;
    }
    if (nextMode === "prepay_out") {
      setDebtInstitutionId("");
      setDebtAccountId("");
      setDebtItemName("");
      return;
    }
    if (!isDebtObjectRef(debtInstitutionId)) return;
    if (debtInstitutionId.startsWith("counterparty:")) {
      const existingAccount = findDebtAccountForObject(debtInstitutionId, debtDirectionForMode(nextMode));
      setDebtAccountId(existingAccount?.id ?? "");
      return;
    }
    const currentDebtAccount = localDebtAccounts.find((item) => item.id === debtAccountId);
    if (
      currentDebtAccount?.institutionId &&
      currentDebtAccount.debtDirection &&
      currentDebtAccount.debtDirection !== debtDirectionForMode(nextMode)
    ) {
      setDebtAccountId("");
    }
  }

  function handleLoanTabSelect(tab: LoanTab) {
    setActiveLoanTab(tab);
    setLoanPurposeCategoryId("");
    setFixedAssetLinked(false);
    setFixedAssetAccountId("");
    setFixedAssetAssetId("");
    setSelectedTagIds([]);
    setDebtAccountId("");
    setDebtInstitutionId("");
    setDebtItemName("");
    setPrincipal("");
    setAnnualRate("");
    setAnnualRateManuallyEdited(false);
    setMortgageLprDiscount("");
    setShowHistoricalRates(false);
    setHistoricalRateRows([]);
    if (tab === "repay_out") {
      setMode("repay_out");
      setLoanType(null);
      setLoanFundingMode("cash_disbursement");
      return;
    }
    setMode("borrow_in");
    setLoanType(tab);
    if (tab === "consumer") {
      setLoanFundingMode("financed_purchase");
      setRepaymentMethod(EQUAL_PAYMENT_REPAYMENT_METHOD);
      setLoanTotalRuns("12");
      setAutoDebit(false);
      setAutoDebitFirstDate(firstRepaymentDate || addMonthsInput(today, 1));
    } else if (tab === "mortgage") {
      setLoanFundingMode("cash_disbursement");
      setRepaymentMethod(EQUAL_PAYMENT_REPAYMENT_METHOD);
      setLoanTotalRuns("300");
      setAutoDebit(false);
      setAutoDebitFirstDate(firstRepaymentDate || addMonthsInput(today, 1));
    } else {
      setLoanFundingMode("financed_purchase");
      setRepaymentMethod(EQUAL_PAYMENT_REPAYMENT_METHOD);
      setLoanTotalRuns("300");
      setAutoDebit(tab === "home");
      setAutoDebitFirstDate(firstRepaymentDate || addMonthsInput(today, 1));
    }
  }

  function handleLoanPurposeChange(id: string) {
    setLoanPurposeCategoryId(id);
  }

  function handleFixedAssetToggle() {
    setFixedAssetLinked((current) => {
      const next = !current;
      if (!next) {
        setFixedAssetAccountId("");
        setFixedAssetAssetId("");
      }
      return next;
    });
  }

  function handleCollateralFixedAssetChange(id: string) {
    setFixedAssetAssetId(id);
    const asset = fixedAssetAssets.find((item) => item.id === id);
    setFixedAssetAccountId(asset?.accountId ?? "");
    if (asset?.accountId) recordRecentAccount(asset.accountId);
  }

  function getPendingRepaymentLprAdjustment() {
    if (mode !== "repay_out" || editingEntryId || !repaymentLprCheck) return null;
    const discount = repaymentLprCheck.mortgageLprDiscount;
    if (discount == null || !Number.isFinite(discount) || discount <= 0 || !isValidDateInput(date)) return null;
    const lpr = getLatestFiveYearLpr(date);
    if (!lpr) return null;
    const annualRate = calcMortgageAnnualRateFromLprDiscount({ discount, lprRate: lpr.fiveYearRate });
    const currentAnnualRate = getEffectiveLoanAnnualRate({
      baseAnnualRate: repaymentLprCheck.currentAnnualRate,
      adjustments: repaymentLprCheck.loanRateAdjustments,
      date,
    });
    if (currentAnnualRate != null && Math.abs(annualRate - currentAnnualRate) < 0.0005) return null;
    return {
      effectiveDate: date,
      annualRate,
      lprRate: lpr.fiveYearRate,
      currentAnnualRate,
    };
  }

  function getDebtActionErrorMessage(error: string) {
    if (error === "REPAYMENT_REQUIRES_EXISTING_LOAN_ACCOUNT") return t("debtTx.alert.selectRepayableLoanAccount");
    if (error === "LOAN_ACCOUNT_HAS_NO_PAYABLE_BALANCE") return t("debtTx.alert.noPayableLoanAccountOnDate");
    if (error === "COLLATERAL_ASSET_REQUIRED" || error === "COLLATERAL_ASSET_NOT_FOUND" || error === "COLLATERAL_ASSET_NOT_AVAILABLE") return t("debtTx.alert.selectFixedAsset");
    if (error === "COLLATERAL_ASSET_ALREADY_MORTGAGED") return t("debtTx.alert.fixedAssetAlreadyMortgaged");
    if (error === "INVALID_TAG_IDS") return t("debtTx.alert.invalidTags");
    if (error === "Invalid repayment account" || error === "Auto-debit requires a debit account") return t("debtTx.alert.autoDebitAccountRequired");
    return error;
  }

  async function saveDebtTransaction(keepAdding: boolean, options?: { skipHistoryPrompt?: boolean }) {
    if (submitting) return;
    if (isLoanRepaymentMode && !debtAccountId) {
      window.alert(t("debtTx.alert.selectRepayableLoanAccount"));
      return;
    }
    if (isLoanDialog && activeLoanTab === "consumer" && mode === "borrow_in" && !loanPurposeCategoryId) {
      window.alert(t("debtTx.alert.selectLoanPurpose"));
      return;
    }
    const requiresFixedAssetSelection = isCollateralLoanBorrow || fixedAssetLinked;
    if (isCollateralLoanBorrow && !fixedAssetAssetId) {
      window.alert(t("debtTx.alert.selectFixedAsset"));
      return;
    }
    if (isCollateralLoanBorrow && !fixedAssetAccountId) {
      window.alert(t("debtTx.alert.selectFixedAsset"));
      return;
    }
    if (isLoanDialog && mode === "borrow_in" && fixedAssetLinked && !fixedAssetAccountId) {
      window.alert(t("txForm.selectFixedAssetAccount"));
      return;
    }
    if (isCollateralLoanBorrow && !cashAccountId) {
      window.alert(t("debtTx.alert.selectLoanDisbursementAccount"));
      return;
    }
    if (isLoanBorrow && editingEntryId && !debtItemName.trim()) {
      window.alert(t("debtTx.alert.loanNameRequired"));
      return;
    }
    const submittedLoanFundingMode =
      isLoanDialog && mode === "borrow_in"
        ? (isCollateralLoanBorrow ? "cash_disbursement" : "financed_purchase")
        : editingEntryId && loanFundingMode === "financed_purchase"
          ? "financed_purchase"
          : "cash_disbursement";
    const requiresLoanScheduleFields = showBorrowPlan && isFixedRepaymentMethodValue(repaymentMethod);
    if (requiresLoanScheduleFields) {
      const usesAutoDebit = isHomeLoanBorrow || autoDebit;
      const selectedAutoDebitCashAccountId = isCollateralLoanBorrow ? autoDebitCashAccountId : cashAccountId;
      const allowZeroAnnualRate = allowsZeroAnnualRateRepaymentMethod(repaymentMethod);
      const parsedAnnualRate = annualRate.trim()
        ? allowZeroAnnualRate
          ? parseNonNegativeNumberText(annualRate)
          : parsePositiveNumberText(annualRate)
        : allowZeroAnnualRate
          ? 0
          : null;
      if (parsedAnnualRate == null) {
        window.alert(t("debtTx.alert.annualRateRequired"));
        return;
      }
      if (!parsePositiveNumberText(loanTotalRuns)) {
        window.alert(t("debtTx.alert.totalRunsRequired"));
        return;
      }
      if (!usesAutoDebit && (!firstBillDate || !isValidDateInput(firstBillDate))) {
        window.alert(t("debtTx.alert.firstBillDateRequired"));
        return;
      }
      if (!usesAutoDebit && (!firstRepaymentDate || !isValidDateInput(firstRepaymentDate))) {
        window.alert(t("debtTx.alert.firstRepaymentDateRequired"));
        return;
      }
      if (usesAutoDebit) {
        if (!selectedAutoDebitCashAccountId) {
          window.alert(t("debtTx.alert.autoDebitAccountRequired"));
          return;
        }
        if (!autoDebitFirstDate || !isValidDateInput(autoDebitFirstDate)) {
          window.alert(t("debtTx.alert.autoDebitDateRequired"));
          return;
        }
      }
    }
    if (
      !options?.skipHistoryPrompt &&
      showBorrowPlan &&
      submittedLoanFundingMode !== "financed_purchase" &&
      shouldPromptHistoricalRepayments({
        mode,
        isFixedRepaymentMethod,
        firstRepaymentDate: isHomeLoanBorrow || autoDebit ? autoDebitFirstDate : firstRepaymentDate,
        today,
        repaymentIntervalMonths,
      })
    ) {
      setPendingKeepAdding(keepAdding);
      setCreateHistoricalRepaymentRecords(false);
      setShowHistoricalRates(false);
      setHistoricalRateRows([]);
      setHistoricalRatesOpen(false);
      setHistoryConfirmOpen(true);
      return;
    }
    let generatedMortgageRateRows: HistoricalRateRow[] = [];
    if (!showHistoricalRates && showHomeLoanLprFields && mortgageLprDiscount.trim()) {
      const generated = buildCurrentMortgageLprGeneration({ alertOnInvalid: true });
      if (!generated) return;
      generatedMortgageRateRows = generated.rows;
    }
    const historicalRates = showHistoricalRates
      ? serializeHistoricalRateRows(historicalRateRows, t)
      : generatedMortgageRateRows.length > 0
        ? serializeHistoricalRateRows(generatedMortgageRateRows, t)
        : { ok: true as const, text: "" };
    if (!historicalRates.ok) {
      window.alert(historicalRates.error);
      setHistoricalRatesOpen(true);
      return;
    }
    const pendingLprAdjustment = getPendingRepaymentLprAdjustment();
    let acceptedLprAdjustment: typeof pendingLprAdjustment = null;
    if (pendingLprAdjustment) {
      const accepted = await showConfirmDialog({
        title: t("debtTx.lprAdjust.title"),
        message: [
          t("debtTx.lprAdjust.foundLpr", {
            date: pendingLprAdjustment.effectiveDate,
            rate: pendingLprAdjustment.lprRate.toFixed(3).replace(/\.?0+$/, ""),
          }),
          t("debtTx.lprAdjust.newRate", {
            rate: pendingLprAdjustment.annualRate.toFixed(3).replace(/\.?0+$/, ""),
          }),
          pendingLprAdjustment.currentAnnualRate == null
            ? t("debtTx.lprAdjust.noComparableRate")
            : t("debtTx.lprAdjust.currentRate", {
                rate: pendingLprAdjustment.currentAnnualRate.toFixed(3).replace(/\.?0+$/, ""),
              }),
          t("debtTx.lprAdjust.acceptPrompt"),
        ].join("\n"),
      });
      acceptedLprAdjustment = accepted ? pendingLprAdjustment : null;
    }
    const shouldPromptPrincipalRecalculation =
      !!editingEntryId &&
      mode === "repay_out" &&
      !!debtAccountId &&
      !!editRecalculateStartDate &&
      Math.abs(roundMoneyValue(parseAbsMoneyText(principal)) - roundMoneyValue(parseAbsMoneyText(originalPrincipalForEdit))) > 0.005;
    const penaltyForSubmit = mode === "prepay_out" ? applyPrepayTotalDraft({ alertOnInvalid: true }) : penalty;
    const prepayInterestForSubmit = mode === "prepay_out" && selectedRepayableLoanRow?.prepayInterest != null;
    if (mode === "prepay_out" && prepayTotal.trim() && parseMoneyText(prepayTotal) + 0.005 < parseAbsMoneyText(principal) + (prepayInterestForSubmit ? parseMoneyText(interest) : 0)) {
      return;
    }

    const submittedAutoDebit = isHomeLoanBorrow || autoDebit;
    const submittedFirstRepaymentDate = submittedAutoDebit ? autoDebitFirstDate : firstRepaymentDate;
    const submittedAutoDebitCashAccountId = isCollateralLoanBorrow ? autoDebitCashAccountId : cashAccountId;
    const submittedCashAccountId = isLoanBorrow
      ? submittedLoanFundingMode === "cash_disbursement"
        ? cashAccountId
        : submittedAutoDebit
          ? cashAccountId
          : ""
      : cashAccountId;
    const formData = new FormData();
    formData.set("editEntryId", editingEntryId);
    formData.set("mode", mode);
    formData.set("loanFundingMode", submittedLoanFundingMode);
    formData.set("date", date);
    const canResolveDebtObjectWithoutSelectedAccount = canCreateDebtItem || debtInstitutionId.startsWith("counterparty:");
    const shouldUseDebtObject = !editingEntryId && canSelectDebtObject && canResolveDebtObjectWithoutSelectedAccount && !!debtInstitutionId && !debtAccountId;
    formData.set("debtAccountId", shouldUseDebtObject ? "" : debtAccountId);
    if (mode === "repay_out" && selectedRepayableLoanRow?.currentPlanId && selectedRepayableLoanRow.currentUnpaidPeriod) {
      formData.set("loanRepaymentPlanId", selectedRepayableLoanRow.currentPlanId);
      formData.set("loanRepaymentPeriod", String(selectedRepayableLoanRow.currentUnpaidPeriod));
    }
    formData.set("debtObjectId", shouldUseDebtObject ? debtInstitutionId : "");
    formData.set("debtInstitutionId", shouldUseDebtObject ? rawDebtObjectId(debtInstitutionId) : "");
    formData.set("debtItemName", isLoanDialog ? debtItemName : "");
    formData.set("loanType", isLoanDialog && activeLoanTab !== "repay_out" ? activeLoanTab : "");
    formData.set("cashAccountId", submittedCashAccountId);
    formData.set("autoDebitCashAccountId", submittedAutoDebit ? submittedAutoDebitCashAccountId : "");
    formData.set("principal", String(parseAbsMoneyText(principal)));
    formData.set("interest", showInterest || prepayInterestForSubmit ? interest : "0");
    formData.set("penalty", showPrepayment ? penaltyForSubmit : "0");
    formData.set("prepayStrategy", prepayStrategy);
    const allowZeroAnnualRateForSubmit = allowsZeroAnnualRateRepaymentMethod(repaymentMethod);
    formData.set("annualRate", !annualRate.trim() && allowZeroAnnualRateForSubmit ? "0" : annualRate);
    formData.set("mortgageLprDiscount", showHomeLoanLprFields ? mortgageLprDiscount : "");
    formData.set("repaymentMethod", normalizeLoanRepaymentMethod(repaymentMethod));
    formData.set("repaymentIntervalMonths", repaymentIntervalMonths);
    formData.set("loanTotalRuns", loanTotalRuns);
    formData.set("firstBillDate", isHomeLoanBorrow ? "" : firstBillDate);
    formData.set("firstRepaymentDate", submittedFirstRepaymentDate);
    formData.set("createRepaymentPlan", showBorrowPlan && isFixedRepaymentMethod ? "true" : "false");
    formData.set("autoDebit", submittedAutoDebit ? "true" : "false");
    formData.set("autoDebitFirstDate", submittedAutoDebit ? autoDebitFirstDate : "");
    formData.set(
      "createHistoricalRepaymentRecords",
      submittedLoanFundingMode === "financed_purchase" ? "false" : createHistoricalRepaymentRecords ? "true" : "false",
    );
    formData.set("historicalLoanRates", historicalRates.text);
    if (acceptedLprAdjustment) {
      formData.set("acceptedLprRateEffectiveDate", acceptedLprAdjustment.effectiveDate);
      formData.set("acceptedLprAnnualRate", String(acceptedLprAdjustment.annualRate));
    }
    formData.set("note", note);
    if (isLoanDialog && mode === "borrow_in") {
      formData.set("loanPurposeCategoryId", loanPurposeCategoryId);
      // 显式提交固定资产开关态：编辑时关掉开关 = 服务端删除已有资产关联。
      formData.set("fixedAssetLinked", fixedAssetLinked ? "true" : "false");
      if (requiresFixedAssetSelection && fixedAssetAccountId) {
        formData.set("fixedAssetAccountId", fixedAssetAccountId);
        if (fixedAssetAssetId) formData.set("fixedAssetAssetId", fixedAssetAssetId);
      }
      if (isCollateralLoanBorrow) {
        formData.set("tagIds", JSON.stringify(selectedTagIds));
      }
    }

    setSubmitting(true);
    try {
      const res = await action(formData);
      if (!res.ok) {
        window.alert(getDebtActionErrorMessage(res.error));
        return;
      }
      if (res.warning) {
        window.alert(res.warning);
      }
      if (res.recalculateAfterSave) {
        const recalcResponse = await fetch("/api/v1/loan-repayment/recalculate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(res.recalculateAfterSave),
        });
        const recalcData = await recalcResponse.json().catch(() => null);
        if (!recalcResponse.ok || !recalcData?.ok) {
          window.alert(recalcData?.error || t("debtTx.alert.recalcFailedPrepay"));
        } else {
          window.alert(formatLoanRecalculateSuccessMessage(recalcData.data));
        }
      }
      if (shouldPromptPrincipalRecalculation) {
        const accepted = await showConfirmDialog({
          title: t("debtTx.principalEdit.title"),
          message: [
            t("debtTx.principalEdit.message1"),
            t("debtTx.principalEdit.message2", { date: editRecalculateStartDate }),
            t("debtTx.principalEdit.message3"),
          ].join("\n"),
        });
        if (accepted) {
          const recalcResponse = await fetch("/api/v1/loan-repayment/recalculate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              accountId: debtAccountId,
              startDate: editRecalculateStartDate,
            }),
          });
          const recalcData = await recalcResponse.json().catch(() => null);
          if (!recalcResponse.ok || !recalcData?.ok) {
            window.alert(recalcData?.error || t("debtTx.alert.recalcFailedPrincipal"));
          } else {
            window.alert(formatLoanRecalculateSuccessMessage(recalcData.data));
          }
        }
      }
      dispatchFinanceDataChanged({ reason: "debt-save" });
      if (keepAdding) {
        setPrincipal("");
        setInterest("");
        setPenalty("");
        setPrepayTotal("");
        setPrepayTotalManual(false);
        setPrepayStrategy(DEFAULT_LOAN_PREPAY_STRATEGY);
        setAnnualRate("");
        setMortgageLprDiscount("");
        setRepaymentMethod(FREE_REPAYMENT_METHOD);
        setAutoDebitCashAccountId(defaultCashAccountId ?? cashAccounts[0]?.id ?? "");
        setRepaymentIntervalMonths("1");
        setLoanTotalRuns("300");
        setFirstRepaymentDate(addMonthsInput(today, 1));
        setCreateHistoricalRepaymentRecords(false);
        setShowHistoricalRates(false);
        setHistoricalRateRows([]);
        setHistoricalRatesOpen(false);
        setDebtItemName("");
        setNote("");
        setSelectedTagIds([]);
        setLoanPurposeCategoryId("");
        setFixedAssetLinked(false);
        setFixedAssetAccountId("");
        setFixedAssetAssetId("");
      } else {
        setOpen(false);
        setHistoryConfirmOpen(false);
        resetDraft();
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("debtTx.alert.saveFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveDebtTransaction(false);
  }

  async function confirmHistoricalPrompt() {
    setHistoryConfirmOpen(false);
    await saveDebtTransaction(pendingKeepAdding, { skipHistoryPrompt: true });
  }

  const selectedDebtAccount = localDebtAccounts.find((account) => account.id === debtAccountId);
  const selectedDebtObjectIsCounterparty = debtInstitutionId.startsWith("counterparty:") || !!selectedDebtAccount?.counterpartyId;
  const selectedDebtAccountIsBankLoan = !!selectedDebtAccount?.institutionId && selectedDebtAccount.institutionType === "bank";
  const selectedDebtAccountIsConsumerLoan = selectedDebtAccount?.isConsumerLoan === true;
  const showInterest = mode === "repay_out" || mode === "collect_in" || mode === "lend_out";
  const showPrepayment = mode === "prepay_out";
  const isLoanRepaymentMode = isLoanDialog && (mode === "repay_out" || mode === "prepay_out");
  const canCreateDebtItem = canCreateDebtItemForMode(mode);
  const canSelectDebtObject = !isLoanRepaymentMode && (!!editingEntryId || mode !== "prepay_out");
  const isLoanBorrow = isLoanDialog && mode === "borrow_in";
  const isConsumerLoanBorrow = isLoanBorrow && activeLoanTab === "consumer";
  const isHomeLoanBorrow = isLoanBorrow && activeLoanTab === "home";
  const isCollateralLoanBorrow = isLoanBorrow && activeLoanTab === "mortgage";
  const showHomeLoanLprFields = isHomeLoanBorrow;
  // Status of the selected repayable loan account's current scheduled period.
  const selectedRepayableLoanRow = useMemo(
    () => (isLoanRepaymentMode ? repayableLoanAccountRows.find((item) => item.accountId === debtAccountId) : undefined),
    [debtAccountId, isLoanRepaymentMode, repayableLoanAccountRows],
  );
  const selectedRepaymentCurrentPeriodPaid = selectedRepayableLoanRow?.currentPeriodPaid === true;
  const selectedRepaymentUnpaidPeriod = selectedRepayableLoanRow?.currentUnpaidPeriod ?? null;
  // 消费贷提前还款：服务端返回了应计利息预览时才显示「应计利息」栏。
  const showPrepayInterest = isLoanRepaymentMode && mode === "prepay_out" && selectedRepayableLoanRow?.prepayInterest != null;
  // 消费贷提前还款：自动填入「借款日至还款日」应计利息（可手动覆盖）。
  const prepayAutoInterest = mode === "prepay_out" ? selectedRepayableLoanRow?.prepayInterest : undefined;
  useEffect(() => {
    if (!open || mode !== "prepay_out" || editingEntryId || prepayInterestManual) return;
    setInterest(prepayAutoInterest != null && prepayAutoInterest > 0 ? String(Math.round(prepayAutoInterest * 100) / 100) : "");
  }, [open, mode, editingEntryId, prepayAutoInterest, prepayInterestManual]);
  useEffect(() => {
    setPrepayInterestManual(false);
  }, [debtAccountId, date]);
  const showLoanPurpose = isLoanBorrow && activeLoanTab === "consumer";
  const showLoanRateAdjustmentFields = isLoanBorrow && (isConsumerLoanBorrow || isHomeLoanBorrow);
  const showLoanFixedAssetFields = isLoanBorrow && (activeLoanTab === "consumer" || activeLoanTab === "home");
  const showLoanBorrowOptions = isHomeLoanBorrow && !selectedDebtObjectIsCounterparty && (selectedDebtAccountIsBankLoan || selectedDebtAccountIsConsumerLoan);
  const showBorrowPlan = isLoanDialog && mode === "borrow_in";
  const loanPurposeOptions = useMemo(
    () => buildCategoryTreeOptions((expenseCategories ?? []) as CategorySource[], t),
    [expenseCategories, t],
  );

  // Editing a loan borrow record opened outside the debt module (e.g. from an
  // account detail view) carries no schedule defaults. Fetch the loan's existing
  // repayment plan and prefill the schedule fields so saving the edit does not
  // rewrite the plan with create-form defaults. Mirrors what debt-view-data
  // passes as default* props when editing from the debt side.
  useEffect(() => {
    if (!open || !isLoanBorrow || !editingEntryId || !debtAccountId) return;
    if (planDefaultsFromEventRef.current) return;
    let cancelled = false;
    const controller = new AbortController();
    fetch(`/api/v1/regular-invest?accountId=${encodeURIComponent(debtAccountId)}`, { cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload) => {
        if (cancelled || !payload?.ok || !Array.isArray(payload.plans)) return;
        const loanPlans = (payload.plans as Array<{
          memo?: string | null;
          status?: string | null;
          nextRunDate?: string | Date | null;
          startDate?: string | Date | null;
          cashAccountId?: string | null;
        }>).filter((plan) => decodeScheduledTaskMemo(plan.memo).type === "loan_repayment");
        if (loanPlans.length === 0) return;
        let primaryPlan: (typeof loanPlans)[number] | null = null;
        let autoDebitPlan: (typeof loanPlans)[number] | null = null;
        for (const plan of loanPlans) {
          if (shouldPreferLoanScheduledPlan(plan, primaryPlan)) primaryPlan = plan;
          if (shouldPreferLoanAutoDebitPlan(plan, autoDebitPlan)) autoDebitPlan = plan;
        }
        if (!primaryPlan) return;
        const memo = decodeScheduledTaskMemo(primaryPlan.memo);
        const planStart = String(primaryPlan.startDate ?? "").slice(0, 10);
        if (memo.repaymentMethod) setRepaymentMethod(memo.repaymentMethod);
        if (memo.annualRate != null) setAnnualRate(formatRateInput(memo.annualRate));
        setAnnualRateManuallyEdited(false);
        if (isHomeLoanType(activeLoanTab) && memo.mortgageLprDiscount != null) {
          setMortgageLprDiscount(formatRateInput(memo.mortgageLprDiscount));
        }
        if (memo.repaymentIntervalMonths != null) setRepaymentIntervalMonths(String(memo.repaymentIntervalMonths));
        if (memo.originalTotalRuns != null) setLoanTotalRuns(String(memo.originalTotalRuns));
        const nextFirstBillDate = memo.firstBillDate ?? planStart;
        const nextFirstRepaymentDate = memo.firstRepaymentDate ?? planStart;
        if (nextFirstBillDate) setFirstBillDate(nextFirstBillDate);
        if (nextFirstRepaymentDate) setFirstRepaymentDate(nextFirstRepaymentDate);
        setAutoDebit(getLoanScheduledPlanRole(decodeScheduledTaskMemo(autoDebitPlan?.memo)) === "auto_debit");
        const nextAutoDebitFirstDate = autoDebitPlan?.startDate
          ? String(autoDebitPlan.startDate).slice(0, 10)
          : nextFirstRepaymentDate;
        if (nextAutoDebitFirstDate) setAutoDebitFirstDate(nextAutoDebitFirstDate);
        if (autoDebitPlan?.cashAccountId) {
          setAutoDebitCashAccountId(autoDebitPlan.cashAccountId);
          // Financed-purchase borrow records have no cash side of their own; the
          // debit account is submitted through cashAccountId (same as the debt side).
          if (loanFundingMode === "financed_purchase") setCashAccountId(autoDebitPlan.cashAccountId);
        }
        if (memo.loanRateAdjustments && memo.loanRateAdjustments.length > 0) {
          setHistoricalRateRows(memo.loanRateAdjustments.map((item) =>
            createHistoricalRateRow(item.effectiveDate, formatRateInput(item.annualRate)),
          ));
          setShowHistoricalRates(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeLoanTab, debtAccountId, editingEntryId, isLoanBorrow, loanFundingMode, open]);

  // Editing a loan borrow record: restore the linked fixed asset (toggle + account
  // + asset). Direct-purchase loans (consumer/home/other) only have a
  // PropertyTransaction link on the borrow record itself; collateral loans have
  // the asset marked with mortgageLoanAccountId (same source the debt side uses).
  // Strictly after the prefill data arrives — never from an empty first pass.
  useEffect(() => {
    if (!open || !isLoanBorrow || !editingEntryId) return;
    if (fixedAssetLinkPrefilledRef.current) return;
    if (fixedAssetLinkedTx === undefined) return;
    fixedAssetLinkPrefilledRef.current = true;
    if (fixedAssetLinked || fixedAssetAccountId || fixedAssetAssetId) return;
    if (fixedAssetLinkedTx && fixedAssetLinkedTx.accountId) {
      setFixedAssetLinked(true);
      setFixedAssetAccountId(fixedAssetLinkedTx.accountId);
      if (fixedAssetLinkedTx.propertyAssetId) setFixedAssetAssetId(fixedAssetLinkedTx.propertyAssetId);
      return;
    }
    const mortgagedAsset = fixedAssetAssets.find((asset) => asset.mortgageLoanAccountId === debtAccountId);
    if (mortgagedAsset) {
      setFixedAssetLinked(true);
      setFixedAssetAccountId(mortgagedAsset.accountId);
      setFixedAssetAssetId(mortgagedAsset.id);
    }
  }, [
    debtAccountId,
    editingEntryId,
    fixedAssetAccountId,
    fixedAssetAssetId,
    fixedAssetAssets,
    fixedAssetLinked,
    fixedAssetLinkedTx,
    isLoanBorrow,
    open,
  ]);
  const accountUsage = useAccountUsage();
  const {
    filteredOptions: fixedAssetFiltered,
    visibleOptionIds: fixedAssetVisibleOptionIds,
  } = useAccountSSFilter(localFixedAssetAccountSSOpts);
  const fixedAssetAccountOptions = useMemo(() => {
    let base = mergeSmartSelectOptions(fixedAssetFiltered, fixedAssetAccountList);
    const selected = fixedAssetAccountList.find((option) => option.id === fixedAssetAccountId);
    if (fixedAssetVisibleOptionIds) {
      base = base.filter((option) => fixedAssetVisibleOptionIds.has(option.id));
    }
    if (selected && !base.some((option) => option.id === selected.id)) base.push(selected);
    return sortByAccountUsage(base, accountUsage);
  }, [accountUsage, fixedAssetAccountId, fixedAssetAccountList, fixedAssetFiltered, fixedAssetVisibleOptionIds]);
  const fixedAssetAccountLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of mergeSmartSelectOptions(fixedAssetAccountList, localFixedAssetAccountSSOpts)) {
      if (!option.isHeader && !option.isGroup) map.set(option.id, option.label);
    }
    return map;
  }, [fixedAssetAccountList, localFixedAssetAccountSSOpts]);
  const fixedAssetAssetOptions = useMemo<SmartSelectOption[]>(() => {
    return fixedAssetAssets
      .filter((asset) => {
        if (asset.id === fixedAssetAssetId) return true;
        if (asset.status === "sold" || asset.status === "disposed" || asset.status === "deleted") return false;
        return !asset.mortgageLoanAccountId || asset.mortgageLoanAccountId === debtAccountId;
      })
      .map((asset) => ({
        id: asset.id,
        label: asset.name,
        subLabel: [
          fixedAssetAccountLabelById.get(asset.accountId),
          asset.status === "mortgaged" ? t("fixedAssetEdit.status.mortgaged") : "",
        ].filter(Boolean).join(" · ") || undefined,
      }));
  }, [debtAccountId, fixedAssetAccountLabelById, fixedAssetAssetId, fixedAssetAssets, t]);

  useEffect(() => {
    if (!isCollateralLoanBorrow || fixedAssetAssetsLoading || !fixedAssetAssetId) return;
    if (!fixedAssetAssetOptions.some((option) => option.id === fixedAssetAssetId)) {
      setFixedAssetAssetId("");
      setFixedAssetAccountId("");
    }
  }, [fixedAssetAssetId, fixedAssetAssetOptions, fixedAssetAssetsLoading, isCollateralLoanBorrow]);

  useEffect(() => {
    if (!isCollateralLoanBorrow || !fixedAssetAssetId || fixedAssetAccountId) return;
    const asset = fixedAssetAssets.find((item) => item.id === fixedAssetAssetId);
    if (asset?.accountId) setFixedAssetAccountId(asset.accountId);
  }, [fixedAssetAccountId, fixedAssetAssetId, fixedAssetAssets, isCollateralLoanBorrow]);

  useEffect(() => {
    if (selectedDebtObjectIsCounterparty && mode === "prepay_out") {
      setMode("repay_out");
    }
  }, [mode, selectedDebtObjectIsCounterparty]);
  useEffect(() => {
    if (isLoanBorrow) {
      const expectedFundingMode = activeLoanTab === "mortgage" ? "cash_disbursement" : "financed_purchase";
      if (loanFundingMode !== expectedFundingMode) setLoanFundingMode(expectedFundingMode);
      return;
    }
    if (!isLoanBorrow && !editingEntryId && loanFundingMode !== "cash_disbursement") {
      setLoanFundingMode("cash_disbursement");
    }
  }, [activeLoanTab, editingEntryId, isLoanBorrow, loanFundingMode]);
  useEffect(() => {
    if (isHomeLoanType(activeLoanTab) && !autoDebit) setAutoDebit(true);
  }, [activeLoanTab, autoDebit]);
  useEffect(() => {
    if (showHomeLoanLprFields) return;
    if (mortgageLprDiscount) setMortgageLprDiscount("");
  }, [mortgageLprDiscount, showHomeLoanLprFields]);
  useEffect(() => {
    if (!open || !isLoanRepaymentMode || !isValidDateInput(date)) {
      setRepayableLoanAccountRows([]);
      setRepayableLoanAccountsLoading(false);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const params = new URLSearchParams({ date });
    if (editingEntryId) params.set("excludeEntryId", editingEntryId);
    setRepayableLoanAccountsLoading(true);
    fetch(`/api/v1/debt/repayable-loan-accounts?${params.toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (cancelled) return;
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        setRepayableLoanAccountRows(rows.flatMap((row: { accountId?: unknown; balance?: unknown; currentPlanId?: unknown; currentDueDate?: unknown; currentPrincipal?: unknown; currentInterest?: unknown; currentPayment?: unknown; currentPaidAmount?: unknown; currentUnpaidPeriod?: unknown; currentPeriodPaid?: unknown; prepayInterest?: unknown; prepayInterestFromDate?: unknown; prepayInterestDays?: unknown; prepayAnnualRate?: unknown }) => {
          const accountId = typeof row.accountId === "string" ? row.accountId : "";
          const balance = Number(row.balance);
          if (!accountId || !Number.isFinite(balance)) return [];
          const item: RepayableLoanAccountRow = { accountId, balance };
          if (typeof row.currentPlanId === "string") item.currentPlanId = row.currentPlanId;
          if (typeof row.currentDueDate === "string") item.currentDueDate = row.currentDueDate;
          const currentPrincipal = Number(row.currentPrincipal);
          const currentInterest = Number(row.currentInterest);
          if (Number.isFinite(currentPrincipal) && currentPrincipal >= 0) item.currentPrincipal = currentPrincipal;
          if (Number.isFinite(currentInterest) && currentInterest >= 0) item.currentInterest = currentInterest;
          const currentPayment = Number(row.currentPayment);
          const currentPaidAmount = Number(row.currentPaidAmount);
          if (Number.isFinite(currentPayment) && currentPayment >= 0) item.currentPayment = currentPayment;
          if (Number.isFinite(currentPaidAmount) && currentPaidAmount >= 0) item.currentPaidAmount = currentPaidAmount;
          const currentUnpaidPeriod = Number(row.currentUnpaidPeriod);
          if (Number.isFinite(currentUnpaidPeriod) && currentUnpaidPeriod > 0) item.currentUnpaidPeriod = currentUnpaidPeriod;
          if (typeof row.currentPeriodPaid === "boolean") item.currentPeriodPaid = row.currentPeriodPaid;
          const prepayInterest = Number(row.prepayInterest);
          if (Number.isFinite(prepayInterest) && prepayInterest >= 0) {
            item.prepayInterest = prepayInterest;
            if (typeof row.prepayInterestFromDate === "string") item.prepayInterestFromDate = row.prepayInterestFromDate;
            const prepayInterestDays = Number(row.prepayInterestDays);
            if (Number.isFinite(prepayInterestDays) && prepayInterestDays >= 0) item.prepayInterestDays = prepayInterestDays;
            const prepayAnnualRate = Number(row.prepayAnnualRate);
            if (Number.isFinite(prepayAnnualRate) && prepayAnnualRate >= 0) item.prepayAnnualRate = prepayAnnualRate;
          }
          return [item];
        }));
      })
      .catch(() => {
        if (!cancelled) setRepayableLoanAccountRows([]);
      })
      .finally(() => {
        if (!cancelled) setRepayableLoanAccountsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [date, editingEntryId, isLoanRepaymentMode, open]);
  const repaymentTotal = useMemo(() => {
    if (!principal.trim() && !interest.trim() && !penalty.trim()) return "";
    return (parseMoneyText(principal) + (showInterest ? parseMoneyText(interest) : 0) + (showPrepayment ? parseMoneyText(penalty) : 0)).toFixed(2);
  }, [interest, penalty, principal, showInterest, showPrepayment]);
  const cashAccountLabel = mode === "borrow_in"
    ? (isLoanBorrow ? t("debtTx.accountLabel.repaymentAccount") : t("debtTx.accountLabel.postingAccount"))
    : mode === "repay_out" || mode === "prepay_out"
      ? t("debtTx.accountLabel.expenseAccount")
      : mode === "collect_in"
        ? t("debtTx.accountLabel.incomeAccount")
        : t("debtTx.accountLabel.expenseAccount");
  const debtAccountOptions: SmartSelectOption[] = useMemo(
    () => restrictAccountsByType(localDebtAccounts, (account) => {
        if (account.counterpartyId) return true;
        if (mode === "borrow_in") return account.debtDirection === "payable";
        if (mode === "repay_out" || mode === "prepay_out") return account.debtDirection === "payable";
        if (mode === "collect_in") return account.debtDirection === "receivable";
        if (mode === "lend_out") return account.debtDirection === "receivable";
        return true;
      })
      .filter((account) => {
        if (loanType) return accountMatchesLoanType(account, loanType);
        return true;
      })
      .map((account) => ({ id: account.id, label: account.label, subLabel: account.subLabel })),
    [localDebtAccounts, mode, loanType],
  );
  const repayableLoanAccountOptions: SmartSelectOption[] = useMemo(
    () => repayableLoanAccountRows.flatMap((row) => {
      const account = localDebtAccounts.find((item) => item.id === row.accountId);
      // The API already restricts rows to loan accounts. Some callers build
      // AccountOption without kind, so checking it here would silently empty the list.
      if (!account || account.isInstitutionLoan !== true) return [];
      const balance = Math.abs(row.balance);
        return {
          id: account.id,
          label: account.label,
          subLabel: [
            account.subLabel,
            t("debtTx.repayableBalanceSubLabel", { date, amount: formatMoneyPreview(balance, language) }),
          ].filter(Boolean).join(" · "),
        };
    }),
    [date, language, localDebtAccounts, repayableLoanAccountRows, t],
  );
  useEffect(() => {
    if (!isLoanRepaymentMode || editingEntryId || repayableLoanAccountsLoading || !debtAccountId) return;
    if (!repayableLoanAccountOptions.some((option) => option.id === debtAccountId)) {
      setDebtAccountId("");
      setDebtInstitutionId("");
    }
  }, [debtAccountId, editingEntryId, isLoanRepaymentMode, repayableLoanAccountOptions, repayableLoanAccountsLoading]);
  const debtObjectAccountOptions: SmartSelectOption[] = useMemo(
    () => localDebtAccounts
      .filter((account) => {
        if (!canSelectDebtObject) return debtAccountOptions.some((option) => option.id === account.id);
        if (!isDebtObjectRef(debtInstitutionId)) return false;
        const rawId = rawDebtObjectId(debtInstitutionId);
        if (!isLoanDialog) return account.counterpartyId === rawId;
        if (debtInstitutionId.startsWith("counterparty:")) return account.counterpartyId === rawId;
        if (account.institutionId !== rawId) return false;
        const expectedDirection = debtDirectionForMode(mode);
        return !account.debtDirection || account.debtDirection === expectedDirection;
      })
      .map((account) => {
        const directionLabel = account.debtDirection === "payable" ? t(MODE_LABELS.borrow_in) : account.debtDirection === "receivable" ? t(MODE_LABELS.lend_out) : t("debtTx.direction.unspecified");
        return {
          id: account.id,
          label: account.label,
          subLabel: [directionLabel, account.subLabel].filter(Boolean).join(" · "),
        };
      }),
    [canSelectDebtObject, debtAccountOptions, debtInstitutionId, isLoanDialog, localDebtAccounts, mode, t],
  );
  const disabled = !isLoanDialog && cashAccounts.length === 0;
  const isFixedRepaymentMethod = isFixedRepaymentMethodValue(repaymentMethod);
  const loanSchedulePreview = useMemo(() => {
    if (!showBorrowPlan || !isFixedRepaymentMethod) return null;
    const firstRunDate = dateInputToUtcDate(isHomeLoanBorrow || autoDebit ? autoDebitFirstDate : firstRepaymentDate);
    const principalAmount = parseAbsMoneyText(principal);
    const totalRuns = Number.parseInt(loanTotalRuns || "0", 10);
    const intervalMonths = Number.parseInt(repaymentIntervalMonths || "1", 10);
    const allowZeroAnnualRate = allowsZeroAnnualRateRepaymentMethod(repaymentMethod);
    const baseAnnualRate = annualRate.trim() ? Number(annualRate) : allowZeroAnnualRate ? 0 : NaN;
    if (
      !firstRunDate ||
      principalAmount <= 0 ||
      !Number.isFinite(totalRuns) ||
      totalRuns <= 0 ||
      (allowZeroAnnualRate
        ? (!Number.isFinite(baseAnnualRate) || baseAnnualRate < 0)
        : (!Number.isFinite(baseAnnualRate) || baseAnnualRate <= 0))
    ) {
      return null;
    }
    const adjustments = showHistoricalRates
      ? normalizeLoanRateAdjustments(historicalRateRows.map((row) => ({
          effectiveDate: row.effectiveDate,
          annualRate: Number(row.annualRate),
        })))
      : [];
    const rows = buildLoanRepaymentSchedulePreview({
      principal: principalAmount,
      repaymentMethod,
      baseAnnualRate,
      adjustments,
      intervalMonths,
      totalRuns,
      firstRunDate,
      maxRows: totalRuns,
    });
    if (rows.length === 0) return null;
    return {
      rows,
      repaymentDay: firstRunDate.getUTCDate(),
      intervalMonths,
      totalPrincipal: roundMoneyValue(rows.reduce((sum, row) => sum + row.principal, 0)),
      totalInterest: roundMoneyValue(rows.reduce((sum, row) => sum + row.interest, 0)),
      totalPayment: roundMoneyValue(rows.reduce((sum, row) => sum + row.payment, 0)),
      hasRateAdjustments: adjustments.length > 0,
    };
  }, [
    annualRate,
    autoDebit,
    autoDebitFirstDate,
    firstRepaymentDate,
    historicalRateRows,
    isFixedRepaymentMethod,
    isHomeLoanBorrow,
    loanTotalRuns,
    principal,
    repaymentIntervalMonths,
    repaymentMethod,
    showBorrowPlan,
    showHistoricalRates,
  ]);
  const formatRateInput = (value: number) => value.toFixed(3).replace(/\.?0+$/, "");
  function buildMortgageLprHistoricalRateRows(discount: number, loanDate: string) {
    return buildMortgageLprRateAdjustments({
      discount,
      throughDate: today,
      fromDate: loanDate,
    }).map((item) => createHistoricalRateRow(
      item.effectiveDate,
      formatRateInput(item.annualRate),
    ));
  }

  function buildCurrentMortgageLprGeneration(options?: { alertOnInvalid?: boolean; fillDefaultDiscount?: boolean }) {
    const rawDiscount = mortgageLprDiscount.trim();
    const discount = rawDiscount ? Number(rawDiscount) : 1;
    if (!Number.isFinite(discount) || discount <= 0) {
      if (options?.alertOnInvalid) window.alert(t("debtTx.alert.lprDiscountInvalid"));
      return null;
    }
    const loanDate = isValidDateInput(date) ? date : today;
    if (!rawDiscount && options?.fillDefaultDiscount) setMortgageLprDiscount(formatRateInput(discount));
    return {
      discount,
      loanDate,
      rows: buildMortgageLprHistoricalRateRows(discount, loanDate),
    };
  }

  function applyMortgageLprDiscount(options?: { silent?: boolean }) {
    const generated = buildCurrentMortgageLprGeneration({
      alertOnInvalid: !options?.silent,
      fillDefaultDiscount: !options?.silent,
    });
    if (!generated) return;

    const quote = getMortgageBankExecutionRate(generated.loanDate);
    const fetchedAnnualRate = quote ? quote.rate * generated.discount : null;
    if (fetchedAnnualRate != null && (!annualRateManuallyEdited || !options?.silent || !annualRate.trim())) {
      setAnnualRate(formatRateInput(fetchedAnnualRate));
    }
    if (generated.rows.length > 0) {
      setHistoricalRateRows(generated.rows);
      setShowHistoricalRates(true);
    }
  }

  function handleMortgageLprDiscountBlur() {
    if (!mortgageLprDiscount.trim()) return;
    applyMortgageLprDiscount({ silent: true });
  }

  const renderDateField = () => (
    <div className="space-y-1">
      <div className="form-label">{isLoanRepaymentMode ? t("debtTx.date.repayment") : mode === "borrow_in" ? (isLoanBorrow ? t("debtTx.date.occurred") : t("detail.column.postedAt")) : t("detail.column.date")}</div>
      <DateStepper name="date" value={date} onChange={setDate} />
    </div>
  );

  const renderCashAccountField = (options?: { label?: string; value?: string; onChange?: (id: string) => void }) => (
    <div className="space-y-1">
      <div className="form-label">{options?.label ?? cashAccountLabel}</div>
      <SmartSelect
        mode="single"
        value={options?.value ?? cashAccountId}
        onChange={options?.onChange ?? setCashAccountId}
        options={visibleCashOptions}
        placeholder={t("txForm.selectPlaceholder")}
        behavior={{
          hierarchy: "auto",
          search: "auto",
          clearable: false,
          headerExtra: cashOwnerCycleButton,
        }}
      />
    </div>
  );

  function handleFirstRepaymentDateChange(value: string) {
    setFirstRepaymentDate(value);
  }

  const renderDebtObjectField = () => canSelectDebtObject ? (
    <div className="space-y-1">
      <div className="form-label">{isLoanDialog ? t("debtTx.loanInstitution") : t("txForm.counterparty")}</div>
      <SmartSelect
        mode="single"
        value={debtInstitutionId}
        onChange={handleDebtItemOrObjectChange}
        options={visibleDebtObjectOptions}
        placeholder={isLoanDialog ? t("debtTx.placeholder.selectLoanInstitution") : t("debtTx.placeholder.selectCounterparty")}
        onCreateClick={() => { void openDebtObjectCreate(); }}
        createLabel={isLoanDialog ? t("debtTx.addLoanInstitution") : t("txForm.addCounterparty")}
        behavior={{
          hierarchy: false,
          search: true,
          clearable: false,
          minDropdownWidth: 320,
        }}
      />
    </div>
  ) : null;

  const renderRepayableLoanAccountField = () => (
    <div className="space-y-1">
      <div className="form-label">{t("debtTx.loanAccount")} <span className="text-red-500">*</span></div>
      <SmartSelect
        mode="single"
        value={debtAccountId}
        onChange={handleDebtAccountChange}
        options={repayableLoanAccountOptions}
        placeholder={repayableLoanAccountsLoading ? t("debtTx.placeholder.loadingRepayableLoanAccounts") : t("debtTx.placeholder.selectRepayableLoanAccount")}
        behavior={{
          hierarchy: false,
          search: true,
          clearable: false,
          minDropdownWidth: 420,
        }}
      />
      <div className="text-[11px] text-slate-500">
        {!repayableLoanAccountsLoading && repayableLoanAccountOptions.length === 0
          ? t("debtTx.noRepayableLoanAccountsForDate")
          : t("debtTx.repayableLoanAccountHint")}
      </div>
    </div>
  );

  const renderDebtAccountField = () => isLoanBorrow && editingEntryId ? (
    <div className="space-y-1">
      <div className="form-label">{t("debtTx.loanName")} <span className="text-red-500">*</span></div>
      <input
        value={debtItemName}
        onChange={(event) => setDebtItemName(event.target.value)}
        className="form-input"
      />
    </div>
  ) : canSelectDebtObject ? (
    <div className="space-y-1">
      <div className="form-label">{isLoanDialog ? t("debtTx.loanAccount") : t("debtTx.counterpartyAccount")}</div>
      <SmartSelect
        mode="single"
        value={debtAccountId}
        onChange={handleDebtAccountChange}
        options={debtObjectAccountOptions}
        placeholder={debtInstitutionId ? t("debtTx.placeholder.autoReuseOrCreate") : t(isLoanDialog ? "debtTx.placeholder.selectLoanInstitutionFirst" : "debtTx.placeholder.selectObjectFirst")}
        onCreateClick={isLoanDialog && canCreateDebtItem && isDebtObjectRef(debtInstitutionId) ? () => { void openDebtAccountCreate(); } : undefined}
        createLabel={isLoanDialog ? t("debtTx.addLoanAccount") : t("debtTx.addAccount")}
        behavior={{
          hierarchy: false,
          search: true,
          clearable: true,
          minDropdownWidth: 360,
        }}
      />
    </div>
  ) : showPrepayment ? (
    <div className="col-span-2 space-y-1">
      <div className="form-label">{t("debtTx.borrowItem")}</div>
      <SmartSelect
        mode="single"
        value={debtAccountId}
        onChange={setDebtAccountId}
        options={debtAccountOptions}
        placeholder={t("debtTx.placeholder.selectExistingBorrowing")}
        behavior={{
          hierarchy: false,
          search: true,
          clearable: false,
          minDropdownWidth: 360,
        }}
      />
    </div>
  ) : (
    <div className="col-span-2 space-y-1">
      <div className="form-label">{mode === "repay_out" ? t("debtTx.borrowItem") : t("debtTx.lendItem")}</div>
      <SmartSelect
        mode="single"
        value={debtAccountId}
        onChange={setDebtAccountId}
        options={debtAccountOptions}
        placeholder={mode === "repay_out" ? t("debtTx.placeholder.selectExistingBorrowing") : t("debtTx.placeholder.selectExistingLending")}
        behavior={{
          hierarchy: false,
          search: true,
          clearable: false,
          minDropdownWidth: 360,
        }}
      />
    </div>
  );

  const renderLoanTotalField = () => (
    <div className="space-y-1">
      <div className="form-label">{t("debtTx.totalBorrowing")}</div>
      <CalcInput value={principal} onChange={setPrincipal} placeholder={t("debtTx.placeholder.exampleAmount")} label={t("debtTx.totalBorrowing")} precision={2} />
    </div>
  );

  const renderFixedAssetAccountSelect = () => (
    <SmartSelect
      mode="single"
      value={fixedAssetAccountId}
      onChange={(id: string) => {
        setFixedAssetAccountId(id);
        setFixedAssetAssetId("");
        recordRecentAccount(id);
      }}
      options={fixedAssetAccountOptions}
      placeholder={t("txForm.selectFixedAssetAccount")}
      onCreateClick={() => setFixedAssetAccountNestedOpen(true)}
      createLabel={t("txForm.createFixedAssetAccount")}
      behavior={{
        hierarchy: "auto",
        search: "auto",
        clearable: false,
        minDropdownWidth: 360,
      }}
    />
  );

  const renderLoanFixedAssetField = (options?: { accountSelect?: "inline" | "separate" }) => showLoanFixedAssetFields ? (
    <div className="space-y-1">
      <div className="form-label">{t("txForm.fixedAssetToggle")}</div>
      <div className="flex h-8 items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={fixedAssetLinked}
          aria-label={t("txForm.fixedAssetToggle")}
          onClick={handleFixedAssetToggle}
          className={[
            "flex h-8 w-12 items-center justify-center rounded-full border px-1.5 text-xs font-medium transition",
            fixedAssetLinked
              ? "border-blue-300 bg-blue-50 text-blue-700"
              : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50",
          ].join(" ")}
        >
          <span
            className={[
              "relative h-4 w-7 shrink-0 rounded-full transition",
              fixedAssetLinked ? "bg-blue-600" : "bg-slate-300",
            ].join(" ")}
          >
            <span
              className={[
                "absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition",
                fixedAssetLinked ? "left-3.5" : "left-0.5",
              ].join(" ")}
            />
          </span>
        </button>
      </div>
      {fixedAssetLinked && options?.accountSelect !== "separate" ? renderFixedAssetAccountSelect() : null}
    </div>
  ) : null;

  const renderCollateralFixedAssetField = () => (
    <div className="space-y-1">
      <div className="form-label">{t("txForm.fixedAssetToggle")} <span className="text-red-500">*</span></div>
      <SmartSelect
        mode="single"
        value={fixedAssetAssetId}
        onChange={handleCollateralFixedAssetChange}
        options={fixedAssetAssetOptions}
        placeholder={fixedAssetAssetsLoading ? t("common.loading") : t("debtTx.fixedAssetPlaceholder")}
        behavior={{
          hierarchy: false,
          search: true,
          clearable: false,
          minDropdownWidth: 360,
        }}
      />
    </div>
  );

  const renderRepaymentMethodField = () => (
    <div className="space-y-1">
      <div className="form-label">{t("debtTx.repaymentMethod")}</div>
      <select value={repaymentMethod} onChange={(event) => {
        const method = event.target.value;
        setRepaymentMethod(method);
        if (isInstallmentRepaymentMethod(method) && parseNonNegativeNumberText(annualRate) == null) {
          setAnnualRate("0");
          setAnnualRateManuallyEdited(false);
        }
      }}
      className={isConsumerLoanBorrow ? "form-input rounded-[8px] px-2 text-xs" : "form-input"}
      style={isConsumerLoanBorrow ? { height: 32, minHeight: 32 } : undefined}
      >
        <option value={EQUAL_PAYMENT_REPAYMENT_METHOD}>{t("debtTx.method.equalInstallment")}</option>
        <option value={EQUAL_PRINCIPAL_REPAYMENT_METHOD}>{t("debtTx.method.equalPrincipal")}</option>
        <option value={INSTALLMENT_REPAYMENT_METHOD}>{t("debtTx.method.interestFreeInstallment")}</option>
        <option value={FREE_REPAYMENT_METHOD}>{t("debtTx.method.freeRepayment")}</option>
        <option value={INTEREST_FIRST_REPAYMENT_METHOD}>{t("debtTx.method.interestFirstThenPrincipal")}</option>
      </select>
    </div>
  );

  const renderFirstRepaymentDateField = () => (
    <div className="space-y-1">
      <div className="form-label">{t("debtTx.firstRepaymentDate")} <span className="text-red-500">*</span></div>
      <DateStepper value={firstRepaymentDate} onChange={handleFirstRepaymentDateChange} />
    </div>
  );

  const renderFirstBillDateField = () => (
    <div className="space-y-1">
      <div className="form-label">{t("debtTx.firstBillDate")} <span className="text-red-500">*</span></div>
      <DateStepper value={firstBillDate} onChange={setFirstBillDate} />
    </div>
  );

  const renderAutoDebitDateField = () => (
    <div className="space-y-1">
      <div className="form-label">{t("debtTx.autoDebitDate")} <span className="text-red-500">*</span></div>
      <DateStepper value={autoDebitFirstDate} onChange={setAutoDebitFirstDate} />
    </div>
  );

  const renderAutoDebitCashAccountField = () => renderCashAccountField({
    label: t("debtTx.autoDebitAccount"),
    value: isCollateralLoanBorrow ? autoDebitCashAccountId : cashAccountId,
    onChange: isCollateralLoanBorrow ? setAutoDebitCashAccountId : setCashAccountId,
  });

  const renderLoanTotalRunsField = () => (
    <div className="space-y-1">
      <div className="form-label">{t("debtTx.totalRuns")} <span className="text-red-500">*</span></div>
      <input
        type="number"
        min={1}
        max={600}
        value={loanTotalRuns}
        onChange={(event) => setLoanTotalRuns(event.target.value)}
        className="form-input"
      />
    </div>
  );

  const renderAnnualRateField = () => (
    <div className="space-y-1">
      <div className="form-label">
        {t("debtShell.rateAdjust.annualRateLabel")}
        {allowsZeroAnnualRateRepaymentMethod(repaymentMethod) ? (
          <span className="text-slate-400"> {t("stockFee.optional")}</span>
        ) : (
          <span className="text-red-500"> *</span>
        )}
      </div>
      <input
        value={annualRate}
        onChange={(event) => {
          setAnnualRateManuallyEdited(true);
          setAnnualRate(event.target.value);
        }}
        placeholder={allowsZeroAnnualRateRepaymentMethod(repaymentMethod) ? "0" : t("debtTx.placeholder.exampleAnnualRate")}
        inputMode="decimal"
        className="form-input"
      />
    </div>
  );

  return (
    <ModalLayerProvider value={modalZIndex}>
      {showTriggerButton ? (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            resetDraft();
          }}
          disabled={disabled}
          className="primary-button h-8 gap-1 px-3 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          {editingEntryId ? t("debtTx.editRepayment") : triggerLabel ?? (isLoanDialog ? t("debtTx.loanTitle") : t("debtTx.borrowRepay"))}
          <ChevronDown className="w-4 h-4 opacity-90" />
        </button>
      ) : null}

      {open
        ? createPortal(
            <div className="app-modal-backdrop" style={{ zIndex: modalZIndex }}>
              <div className="app-modal-panel max-w-xl">
                  <div className="modal-header shrink-0">
                    <div className="text-sm font-semibold text-slate-800">
                      {editingEntryId
                        ? (isLoanDialog ? t("debtTx.editLoan") : t("debtTx.editRepayment"))
                        : isLoanDialog ? t("debtTx.loanTitle") : t("debtTx.title")}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          resetDraft();
                        }}
                        className="secondary-button h-8 px-2"
                      >
                        {t("table.close")}
                      </button>
                    </div>
                  </div>

                  <form className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" onSubmit={onSubmit}>
                    {isLoanDialog ? (
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                        {LOAN_TABS.map((tab) => (
                          <button
                            key={tab}
                            type="button"
                            onClick={() => handleLoanTabSelect(tab)}
                            disabled={!!editingEntryId && tab !== activeLoanTab}
                            className={`segment-button h-9 ${activeLoanTab === tab ? "segment-button-active" : ""}`}
                          >
                            {t(LOAN_TAB_LABELS[tab])}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="grid grid-cols-5 gap-2">
                        {(Object.keys(MODE_LABELS) as DebtMode[]).map((item) => (
                          <button
                            key={item}
                            type="button"
                            onClick={() => handleModeSelect(item)}
                            disabled={!!editingEntryId && !canSwitchDebtEditMode(mode, item)}
                            className={`segment-button h-9 ${mode === item ? "segment-button-active" : ""}`}
                          >
                            {t(MODE_LABELS[item])}
                          </button>
                        ))}
                      </div>
                    )}

                    {isLoanBorrow ? (
                      <>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          {renderDateField()}
                          {renderDebtObjectField()}
                        </div>
                        {isCollateralLoanBorrow ? (
                          <>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                              {renderDebtAccountField()}
                              {renderCashAccountField({ label: t("debtTx.accountLabel.postingAccount") })}
                            </div>
                            {renderCollateralFixedAssetField()}
                            <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2">
                              {renderLoanTotalField()}
                              <EntryTagsField value={selectedTagIds} onChange={setSelectedTagIds} />
                            </div>
                          </>
                        ) : (
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {renderDebtAccountField()}
                            {renderLoanTotalField()}
                          </div>
                        )}
                      </>
                    ) : isLoanRepaymentMode ? (
                      <>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          {renderDateField()}
                          {renderCashAccountField()}
                        </div>
                        {renderRepayableLoanAccountField()}
                        <div className="grid grid-cols-2 gap-2">
                          {(["repay_out", "prepay_out"] as const).map((item) => (
                            <button
                              key={item}
                              type="button"
                              onClick={() => handleModeSelect(item)}
                              disabled={!!editingEntryId && !canSwitchDebtEditMode(mode, item)}
                              className={`segment-button h-9 ${mode === item ? "segment-button-active" : ""}`}
                            >
                              {t(MODE_LABELS[item])}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          {renderDateField()}
                          {renderCashAccountField()}
                        </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          {renderDebtObjectField()}
                          {renderDebtAccountField()}
                        </div>
                      </>
                    )}
                    {!!debtAccountId && isLoanRepaymentMode && !showPrepayment ? (
                      selectedRepaymentCurrentPeriodPaid ? (
                        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                          <div className="text-xs leading-5 text-emerald-800">
                            <span className="font-medium">{t("debtTx.currentPeriodPaidLabel")}</span>
                            {selectedRepaymentUnpaidPeriod != null ? (
                              <span className="block text-[11px] text-emerald-600">
                                {t("debtTx.currentPeriodPaidHint", { period: selectedRepaymentUnpaidPeriod })}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      ) : selectedRepayableLoanRow?.currentPrincipal != null ? (
                        <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2">
                          <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
                          <div className="text-xs leading-5 text-blue-800">
                            <span className="font-medium">{t("debtTx.currentUnpaidPeriodLabel")}</span>
                            <span className="block text-[11px] text-blue-600">
                              {t("debtTx.currentUnpaidPeriodHint", { period: selectedRepaymentUnpaidPeriod ?? 0 })}
                            </span>
                          </div>
                        </div>
                      ) : null
                    ) : null}

                    {!showPrepayment && !showBorrowPlan ? (
                    <div className={`grid gap-3 ${showInterest ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1"}`}>
                      <div className="space-y-1">
                        <div className="form-label">{mode === "borrow_in" ? t("debtTx.totalBorrowing") : mode === "repay_out" || mode === "collect_in" || mode === "lend_out" ? t("debtShell.colPrincipal") : t("txForm.amount")}</div>
                        <CalcInput value={principal} onChange={setPrincipal} placeholder={t("debtTx.placeholder.exampleAmount")} label={t("txForm.amount")} precision={2} />
                      </div>
                      {showInterest ? (
                        <div className="space-y-1">
                          <div className="form-label">{t("debtShell.colInterest")}</div>
                          <CalcInput value={interest} onChange={setInterest} placeholder={t("debtTx.placeholder.exampleInterest")} label={t("debtShell.colInterest")} precision={2} />
                        </div>
                      ) : null}
                      {showInterest && !showPrepayment ? (
                        <div className="space-y-1">
                            <div className="form-label">{mode === "lend_out" ? t("debtTx.receivableTotal") : t("debtTx.principalInterestTotal")}</div>
                          <input
                            value={repaymentTotal}
                            readOnly
                            placeholder={t("debtShell.lpr.autoCalculated")}
                            className="form-input bg-slate-50 text-right font-mono text-slate-700"
                          />
                        </div>
                      ) : null}
                    </div>
                    ) : null}

                    {showPrepayment ? (
                      <>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <div className="form-label">{t("debtTx.prepayPrincipal")}</div>
                            <CalcInput value={principal} onChange={handlePrincipalChange} placeholder={t("debtTx.placeholder.exampleAmount")} label={t("debtTx.prepayPrincipal")} precision={2} />
                          </div>
                          {showPrepayInterest ? (
                            <div className="space-y-1">
                              <div className="form-label">{t("debtTx.prepayInterest")}</div>
                              <CalcInput value={interest} onChange={handlePrepayInterestChange} placeholder={t("debtTx.placeholder.autoOrManual")} label={t("debtTx.prepayInterest")} precision={2} />
                            </div>
                          ) : null}
                          <div className="space-y-1">
                            <div className="form-label">{t("debtTx.feePenalty")}</div>
                            <CalcInput value={penalty} onChange={handlePenaltyChange} placeholder={t("stockFee.optional")} label={t("txForm.fee")} precision={2} />
                          </div>
                          <div className="space-y-1">
                            <div className="form-label">{t("debtTx.handleFollowUpPlan")}</div>
                            <select
                              value={prepayStrategy}
                              onChange={(event) => setPrepayStrategy(event.target.value as PrepayStrategy)}
                              className="form-input"
                            >
                              {(Object.keys(PREPAY_STRATEGY_LABELS) as PrepayStrategy[]).map((item) => (
                                <option key={item} value={item}>{t(PREPAY_STRATEGY_LABELS[item])}</option>
                              ))}
                            </select>
                          </div>
                          <div className="space-y-1">
                            <div className="form-label">{t("debtTx.expenseTotal")}</div>
                            <CalcInput
                              value={prepayTotal}
                              onChange={handlePrepayTotalChange}
                              onBlur={() => applyPrepayTotalDraft()}
                              placeholder={t("debtTx.placeholder.autoOrManual")}
                              label={t("debtTx.expenseTotal")}
                              precision={2}
                            />
                          </div>
                        </div>
                        {showPrepayInterest ? (
                          <p className="text-xs leading-5 text-slate-500">
                            {selectedRepayableLoanRow?.prepayAnnualRate != null && selectedRepayableLoanRow.prepayAnnualRate > 0
                              ? t("debtTx.prepayInterestHint", {
                                  from: selectedRepayableLoanRow.prepayInterestFromDate ?? "",
                                  days: selectedRepayableLoanRow.prepayInterestDays ?? 0,
                                  rate: formatRateInput(selectedRepayableLoanRow.prepayAnnualRate),
                                })
                              : t("debtTx.prepayInterestHintNoRate")}
                          </p>
                        ) : null}
                      </>
                    ) : null}

                    {showBorrowPlan ? (
                      <>
                        {isCollateralLoanBorrow ? (
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                            {renderRepaymentMethodField()}
                            {renderLoanTotalRunsField()}
                            {renderAnnualRateField()}
                          </div>
                        ) : isConsumerLoanBorrow ? (
                          <>
                            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                              {showLoanPurpose ? (
                                <div className="space-y-1">
                                  <div className="form-label">{t("debtTx.loanPurpose")} <span className="text-red-500">*</span></div>
                                  <SmartSelect
                                    mode="single"
                                    value={loanPurposeCategoryId}
                                    onChange={handleLoanPurposeChange}
                                    options={loanPurposeOptions}
                                    placeholder={t("debtTx.loanPurposePlaceholder")}
                                    behavior={{
                                      hierarchy: true,
                                      search: true,
                                      initialCollapsedAll: true,
                                      accordionGroups: true,
                                      selectableGroups: true,
                                      groupSelectOnDoubleClick: false,
                                      minDropdownWidth: 560,
                                      dropdownMaxHeight: 420,
                                      density: "compact",
                                      expandedGroupColumns: 4,
                                    }}
                                  />
                                </div>
                              ) : null}
                              {renderLoanFixedAssetField({ accountSelect: "separate" })}
                              {renderRepaymentMethodField()}
                            </div>
                            {fixedAssetLinked ? (
                              <div className="space-y-1">
                                <div className="form-label">{t("txForm.fixedAssetAccount")}</div>
                                {renderFixedAssetAccountSelect()}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            {renderLoanFixedAssetField()}
                            {renderRepaymentMethodField()}
                          </div>
                        )}

                        {isFixedRepaymentMethod ? (
                          <>
                            {isConsumerLoanBorrow ? (
                              autoDebit ? (
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                  {renderLoanTotalRunsField()}
                                  {renderAnnualRateField()}
                                </div>
                              ) : (
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                  {renderFirstBillDateField()}
                                  {renderFirstRepaymentDateField()}
                                  {renderLoanTotalRunsField()}
                                  {renderAnnualRateField()}
                                </div>
                              )
                            ) : isCollateralLoanBorrow ? null : (
                              <>
                                <div className={`grid grid-cols-1 gap-3 ${showHomeLoanLprFields ? "sm:grid-cols-4" : "sm:grid-cols-2"}`}>
                                  {renderLoanTotalRunsField()}
                                  {renderAnnualRateField()}
                                  {showHomeLoanLprFields ? (
                                    <div className="flex items-end">
                                      <button
                                        type="button"
                                        className="secondary-button h-9 shrink-0 gap-1.5 whitespace-nowrap px-3"
                                        onClick={() => { void applyMortgageLprDiscount(); }}
                                        title={t("debtTx.fetchLprRate")}
                                        aria-label={t("debtTx.fetchLprRate")}
                                      >
                                        <RefreshCw size={14} />
                                        {t("debtTx.fetchLprRate")}
                                      </button>
                                    </div>
                                  ) : null}
                                  {showHomeLoanLprFields ? (
                                    <div className="space-y-1">
                                      <div className="form-label">{t("debtShell.lpr.discountLabel")} <span className="text-slate-400">{t("stockFee.optional")}</span></div>
                                      <input
                                        value={mortgageLprDiscount}
                                        onChange={(event) => setMortgageLprDiscount(event.target.value)}
                                        onBlur={handleMortgageLprDiscountBlur}
                                        placeholder={t("debtShell.lpr.discountPlaceholder")}
                                        inputMode="decimal"
                                        className="form-input"
                                      />
                                    </div>
                                  ) : null}
                                </div>
                              </>
                            )}

                            {isHomeLoanBorrow ? (
                              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                  {renderAutoDebitDateField()}
                                  {renderAutoDebitCashAccountField()}
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                                <label className="flex cursor-pointer select-none items-start gap-2 text-xs text-slate-600">
                                  <input
                                    type="checkbox"
                                    checked={autoDebit}
                                    onChange={(event) => {
                                      const checked = event.target.checked;
                                      setAutoDebit(checked);
                                      if (checked) {
                                        setAutoDebitFirstDate(firstRepaymentDate || addMonthsInput(today, 1));
                                      } else {
                                        setFirstBillDate(firstBillDate || autoDebitFirstDate);
                                        setFirstRepaymentDate(firstRepaymentDate || autoDebitFirstDate);
                                      }
                                    }}
                                    className="mt-0.5 h-3.5 w-3.5 accent-blue-600"
                                  />
                                  <span>
                                    {t("debtTx.autoDebitLabel")}
                                    <span className="block text-[11px] text-slate-400">{t("debtTx.autoDebitHint")}</span>
                                  </span>
                                </label>
                                {autoDebit ? (
                                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                    {renderFirstBillDateField()}
                                    {renderAutoDebitDateField()}
                                    {renderAutoDebitCashAccountField()}
                                  </div>
                                ) : null}
                              </div>
                            )}

                            {showLoanRateAdjustmentFields ? (
                              <div className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                                <div>
                                  <div className="text-xs font-medium text-slate-700">{t("debtShell.rateAdjustment")}</div>
                                  <div className="mt-0.5 text-[11px] text-slate-500">
                                    {showHistoricalRates && historicalRateRows.some((row) => row.effectiveDate.trim() || row.annualRate.trim())
                                      ? t("debtTx.rateAdjustFilledHint", { count: historicalRateRows.filter((row) => row.effectiveDate.trim() || row.annualRate.trim()).length })
                                      : isHomeLoanBorrow
                                        ? t("debtTx.rateAdjustDefaultHint")
                                        : t("debtTx.rateAdjustSimpleHint")}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  className="secondary-button h-8 shrink-0 px-3 text-xs"
                                  onClick={() => {
                                    if (isHomeLoanBorrow) {
                                      const generated = buildCurrentMortgageLprGeneration({
                                        alertOnInvalid: true,
                                        fillDefaultDiscount: true,
                                      });
                                      if (!generated) return;
                                      setShowHistoricalRates(true);
                                      setHistoricalRateRows((prev) => prev.length > 0
                                        ? prev
                                        : generated.rows.length > 0
                                          ? generated.rows
                                          : [createHistoricalRateRow(firstRepaymentDate, annualRate)]);
                                      setHistoricalRatesOpen(true);
                                      return;
                                    }
                                    setShowHistoricalRates(true);
                                    setHistoricalRateRows((prev) => prev.length > 0
                                      ? prev
                                      : [createHistoricalRateRow((autoDebit ? autoDebitFirstDate : firstRepaymentDate) || date, annualRate)]);
                                    setHistoricalRatesOpen(true);
                                  }}
                                >
                                  {t("debtShell.rateAdjustment")}
                                </button>
                              </div>
                            ) : null}

                            {loanSchedulePreview ? (
                              <div className="rounded-md border border-slate-200">
                                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                                  <span className="font-medium text-slate-700">
                                    {t("debtTx.schedulePreviewTitle", {
                                      count: loanSchedulePreview.rows.length,
                                      interval: loanSchedulePreview.intervalMonths === 1 ? t("debtTx.everyMonth") : t("debtTx.everyNMonths", { n: loanSchedulePreview.intervalMonths }),
                                      day: loanSchedulePreview.repaymentDay,
                                    })}
                                  </span>
                                  <span className="tabular-nums">
                                    {t("debtTx.scheduleSummary", {
                                      principal: formatMoneyPreview(loanSchedulePreview.totalPrincipal, language),
                                      interest: formatMoneyPreview(loanSchedulePreview.totalInterest, language),
                                      total: formatMoneyPreview(loanSchedulePreview.totalPayment, language),
                                    })}
                                  </span>
                                </div>
                                <div className="max-h-56 overflow-auto">
                                  <table className="min-w-full text-xs tabular-nums">
                                    <thead className="sticky top-0 bg-white text-slate-500 shadow-[0_1px_0_0_#e2e8f0]">
                                      <tr>
                                        <th className="px-2 py-1 text-left font-medium">{t("txForm.periods")}</th>
                                        <th className="px-2 py-1 text-left font-medium">{t("debtTx.colBillingDate")}</th>
                                        <th className="px-2 py-1 text-left font-medium">
                                          {autoDebit || isHomeLoanBorrow ? t("debtTx.autoDebitDate") : t("debtTx.colRepaymentDate")}
                                        </th>
                                        <th className="px-2 py-1 text-right font-medium">{t("debtShell.colPrincipal")}</th>
                                        <th className="px-2 py-1 text-right font-medium">{t("debtShell.colInterest")}</th>
                                        <th className="px-2 py-1 text-right font-medium">{t("txForm.dueAmount")}</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {loanSchedulePreview.rows.map((row) => (
                                        <tr key={`${row.period}-${row.date}`} className="border-t border-slate-100">
                                          <td className="px-2 py-1 text-slate-600">{row.period}/{loanTotalRuns}</td>
                                          <td className="px-2 py-1 text-slate-600">
                                            {!isHomeLoanBorrow && isValidDateInput(firstBillDate)
                                              ? addMonthsInput(firstBillDate, (row.period - 1) * loanSchedulePreview.intervalMonths)
                                              : row.date}
                                          </td>
                                          <td className="px-2 py-1 text-slate-600">{row.date}</td>
                                          <td className="px-2 py-1 text-right text-slate-700">{formatMoneyPreview(row.principal, language)}</td>
                                          <td className="px-2 py-1 text-right text-slate-700">{formatMoneyPreview(row.interest, language)}</td>
                                          <td className="px-2 py-1 text-right font-medium text-slate-800">{formatMoneyPreview(row.payment, language)}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <div className="rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                            {t("debtTx.freeRepaymentHint")}
                          </div>
                        )}

                      </>
                    ) : null}

                    {!showBorrowPlan ? (
                      <>
                        <div className="space-y-1">
                          <div className="form-label">{t("detail.column.remark")}</div>
                          <input
                            name="note"
                            placeholder={t("stockFee.optional")}
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            className="form-input"
                          />
                        </div>

                        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                          {mode === "repay_out"
                            ? t("debtTx.hint.repayOut")
                            : mode === "prepay_out"
                              ? t("debtTx.hint.prepayOut")
                            : mode === "lend_out"
                              ? t("debtTx.hint.lendOut")
                              : t("debtTx.hint.collectIn")}
                        </div>
                      </>
                    ) : null}

                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button type="button" className="secondary-button h-9 px-3" disabled={submitting} onClick={() => saveDebtTransaction(true)}>
                        {submitting ? t("txForm.saving") : t("txForm.saveAndRepeat")}
                      </button>
                      <button type="submit" className="primary-button h-9 px-3" disabled={submitting}>
                        {submitting ? t("txForm.saving") : t("common.save")}
                      </button>
                    </div>
                  </form>
              </div>
            </div>,
            document.body,
          )
        : null}
      {open && historyConfirmOpen
        ? createPortal(
            <div className="app-modal-backdrop" style={{ zIndex: confirmModalZIndex }}>
              <div className="app-modal-panel max-w-lg">
                <div className="modal-header shrink-0">
                  <div className="text-sm font-semibold text-slate-800">{t("debtTx.historyConfirmTitle")}</div>
                  <button
                    type="button"
                    onClick={() => setHistoryConfirmOpen(false)}
                    className="secondary-button h-8 px-2"
                    disabled={submitting}
                  >
                    {t("debtTx.back")}
                  </button>
                </div>
                <div className="space-y-3 p-4 text-sm text-slate-700">
                  <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                    {t("debtTx.historyPrompt.warning", { date: firstRepaymentDate || "-" })}
                  </div>

                  <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                    <input
                      type="checkbox"
                      checked={createHistoricalRepaymentRecords}
                      onChange={(event) => setCreateHistoricalRepaymentRecords(event.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-blue-600"
                    />
                    <span>
                      <span className="block font-medium text-slate-800">{t("debtTx.historyPrompt.generateLabel")}</span>
                      <span className="block text-xs text-slate-500">{t("debtTx.historyPrompt.generateHint")}</span>
                    </span>
                  </label>

                  {showLoanBorrowOptions ? (
                    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
                      <input
                        type="checkbox"
                        checked={showHistoricalRates}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          if (checked) {
                            const generated = buildCurrentMortgageLprGeneration({
                              alertOnInvalid: true,
                              fillDefaultDiscount: true,
                            });
                            if (!generated) return;
                            setShowHistoricalRates(true);
                            setHistoricalRateRows((prev) => prev.length > 0
                              ? prev
                              : generated.rows.length > 0
                                ? generated.rows
                                : [createHistoricalRateRow()]);
                            setHistoricalRatesOpen(true);
                          } else {
                            setShowHistoricalRates(false);
                            setHistoricalRateRows([]);
                            setHistoricalRatesOpen(false);
                          }
                        }}
                        className="mt-0.5 h-4 w-4 accent-blue-600"
                      />
                      <span>
                        <span className="block font-medium text-slate-800">{t("debtTx.historyPrompt.hasRateAdjustments")}</span>
                        <span className="block text-xs text-slate-500">{t("debtTx.historyPrompt.rateAdjustmentsHint")}</span>
                      </span>
                    </label>
                  ) : null}

                  {showLoanBorrowOptions && showHistoricalRates ? (
                    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <div>
                        <div className="text-xs font-medium text-slate-700">
                          {t("debtTx.historyRateFilled", { count: historicalRateRows.filter((row) => row.effectiveDate.trim() || row.annualRate.trim()).length })}
                        </div>
                        <div className="text-[11px] text-slate-500">{t("debtTx.historyRateValidateHint")}</div>
                      </div>
                      <button
                        type="button"
                        className="secondary-button h-8 px-3 text-xs"
                        onClick={() => {
                          const generated = buildCurrentMortgageLprGeneration({
                            alertOnInvalid: true,
                            fillDefaultDiscount: true,
                          });
                          if (!generated) return;
                          setHistoricalRateRows((prev) => prev.length > 0
                            ? prev
                            : generated.rows.length > 0
                              ? generated.rows
                              : [createHistoricalRateRow()]);
                          setHistoricalRatesOpen(true);
                        }}
                      >
                        {t("debtShell.rateAdjustment")}
                      </button>
                    </div>
                  ) : null}

                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      className="secondary-button h-9 px-3"
                      disabled={submitting}
                      onClick={() => setHistoryConfirmOpen(false)}
                    >
                      {t("debtTx.backToEdit")}
                    </button>
                    <button
                      type="button"
                      className="primary-button h-9 px-3"
                      disabled={submitting}
                      onClick={() => { void confirmHistoricalPrompt(); }}
                    >
                      {submitting ? t("txForm.saving") : t("debtTx.confirmSave")}
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      {open && historicalRatesOpen
        ? createPortal(
            <div className="app-modal-backdrop" style={{ zIndex: rateModalZIndex }}>
              <div className="app-modal-panel max-w-xl">
                <div className="modal-header shrink-0">
                  <div className="text-sm font-semibold text-slate-800">{t("debtShell.rateAdjustment")}</div>
                  <button
                    type="button"
                    onClick={() => setHistoricalRatesOpen(false)}
                    className="secondary-button h-8 px-2"
                  >
                    {t("table.close")}
                  </button>
                </div>
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-sm text-slate-700">
                  <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
                    {t("debtTx.rateModal.hint")}
                  </div>

                  <div className="space-y-2">
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] gap-2 px-1 text-xs font-medium text-slate-500">
                      <div>{t("debtShell.rateAdjust.effectiveDate")}</div>
                      <div>{t("debtShell.rateAdjust.annualRateLabel")}</div>
                      <div className="text-right">{t("detail.column.actions")}</div>
                    </div>
                    <div className="max-h-[230px] space-y-2 overflow-y-auto pr-1">
                      {historicalRateRows.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-5 text-center text-sm text-slate-500">
                          {t("debtShell.rateAdjust.empty")}
                        </div>
                      ) : historicalRateRows.map((row) => (
                        <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_72px] gap-2">
                          <DateStepper
                            value={row.effectiveDate}
                            onChange={(value) => {
                              setHistoricalRateRows((prev) => prev.map((item) => (
                                item.key === row.key ? { ...item, effectiveDate: value } : item
                              )));
                            }}
                          />
                          <input
                            value={row.annualRate}
                            onChange={(event) => {
                              setHistoricalRateRows((prev) => prev.map((item) => (
                                item.key === row.key ? { ...item, annualRate: event.target.value } : item
                              )));
                            }}
                            inputMode="decimal"
                            placeholder={t("debtShell.rateAdjust.annualRatePlaceholder")}
                            className="form-input"
                          />
                          <button
                            type="button"
                            className="secondary-button h-9 px-2 text-rose-600 hover:bg-rose-50"
                            onClick={() => {
                              setHistoricalRateRows((prev) => prev.filter((item) => item.key !== row.key));
                            }}
                          >
                            {t("common.delete")}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
                    <button
                      type="button"
                      className="secondary-button h-9 px-3"
                      onClick={() => setHistoricalRateRows((prev) => [...prev, createHistoricalRateRow()])}
                    >
                      {t("debtTx.addRow")}
                    </button>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="secondary-button h-9 px-3 text-slate-500"
                        onClick={() => {
                          setHistoricalRateRows([]);
                          setShowHistoricalRates(false);
                          setHistoricalRatesOpen(false);
                        }}
                      >
                        {t("table.clear")}
                      </button>
                      <button
                        type="button"
                        className="primary-button h-9 px-3"
                        onClick={() => {
                          if (historicalRateRows.length === 0) {
                            setShowHistoricalRates(false);
                            setHistoricalRatesOpen(false);
                            return;
                          }
                          const result = serializeHistoricalRateRows(historicalRateRows, t);
                          if (!result.ok) {
                            window.alert(result.error);
                            return;
                          }
                          setHistoricalRatesOpen(false);
                        }}
                      >
                        {t("table.confirm")}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      {open && debtObjectNestedOpen
        ? createPortal(
            <EntityCreateForm
              mode="compact"
              entityType={isLoanDialog ? "institution" : "counterparty"}
              open={debtObjectNestedOpen}
              onClose={() => setDebtObjectNestedOpen(false)}
              title={isLoanDialog ? t("debtTx.addLoanInstitution") : t("txForm.addCounterparty")}
              nameLabel={isLoanDialog ? t("debtTx.loanInstitutionName") : t("debtTx.objectName")}
              namePlaceholder={isLoanDialog ? t("debtTx.loanInstitutionNamePlaceholder") : t("debtTx.objectNamePlaceholder")}
              defaultType={isLoanDialog ? "bank" : "person"}
              allowedInstitutionTypes={isLoanDialog ? ["bank", "debt"] : undefined}
              onCreated={(id, name, extra) => {
                const type = extra?.type ?? (isLoanDialog ? "bank" : "person");
                const option = { id: debtObjectOptionId(id, type), label: name, subLabel: institutionTypeLabel(type) };
                const fieldKey = isLoanDialog ? "institutionId" : "counterpartyId";
                setLocalNestedFieldData((prev) => ({
                  ...(prev ?? nestedFieldData ?? {}),
                  [fieldKey]: [...((prev ?? nestedFieldData)?.[fieldKey] ?? []), { id, name, type }],
                }));
                setLocalDebtObjectOptions((prev) => mergeSmartSelectOptions(prev ?? debtObjectOptions, [option]));
                setDebtInstitutionId(option.id);
                setDebtAccountId("");
                setDebtObjectNestedOpen(false);
              }}
            />,
            document.body,
          )
        : null}
      {open && debtAccountNestedOpen
        ? createPortal(
            <EntityCreateForm
              mode="compact"
              entityType="account"
              open={debtAccountNestedOpen}
              onClose={() => setDebtAccountNestedOpen(false)}
              title={isLoanDialog ? t("debtTx.addLoanAccount") : t("debtTx.addCounterpartyAccount")}
              nameLabel={isLoanDialog ? t("debtTx.loanAccountName") : t("debtTx.counterpartyAccountName")}
              namePlaceholder={isLoanDialog ? t("debtTx.loanAccountNamePlaceholder") : t("debtTx.counterpartyAccountNamePlaceholder")}
              defaultType={isLoanDialog ? "loan" : "settlement"}
              nestedFieldData={localNestedFieldData ?? nestedFieldData}
              hiddenFields={[
                "kind",
                "groupId",
                "institutionId",
                "currency",
                "billingDay",
                "repaymentDay",
                "creditLimit",
                "creditBillMode",
                "numberMasked",
                "investProductType",
                "fundUnitsDecimals",
                "tradingCalendar",
                "costBasisMethod",
                "defaultFundQueryApiId",
              ]}
              extraFields={{
                kind: isLoanDialog ? "loan" : "settlement",
                ...(isLoanDialog && activeLoanTab !== "repay_out" ? { loanType: activeLoanTab } : {}),
                ...(debtInstitutionId.startsWith("institution:")
                  ? { institutionId: rawDebtObjectId(debtInstitutionId) }
                  : { counterpartyId: rawDebtObjectId(debtInstitutionId) }),
                debtDirection: debtDirectionForMode(mode),
              }}
              onCreated={(id, name, extra) => {
                const ownerName = extra?.counterpartyName ?? extra?.institutionShortName ?? extra?.institutionName;
                const nextKind = extra?.kind ?? (isLoanDialog ? "loan" : "settlement");
                const nextCounterpartyId = extra?.counterpartyId ?? (debtInstitutionId.startsWith("counterparty:") ? rawDebtObjectId(debtInstitutionId) : null);
                const nextInstitutionId = extra?.institutionId ?? (debtInstitutionId.startsWith("institution:") ? rawDebtObjectId(debtInstitutionId) : null);
                const nextLoanType = nextKind === "loan" ? resolveLoanTypeValue(extra?.loanType, extra?.isConsumerLoan) : null;
                const nextOption: AccountOption = {
                  id,
                  label: name,
                  subLabel: ownerName ? t("debtTx.subLabel.settlement", { name: ownerName }) : t("debtTx.subLabel.settlementPlain"),
                  kind: nextKind,
                  counterpartyId: nextCounterpartyId,
                  institutionId: nextInstitutionId,
                  isInstitutionLoan: nextKind === "loan" && !!nextInstitutionId && !nextCounterpartyId,
                  isConsumerLoan: nextLoanType === "consumer",
                  loanType: nextLoanType,
                  debtDirection: extra?.debtDirection ?? debtDirectionForMode(mode),
                };
                setLocalDebtAccounts((prev) => (prev.some((item) => item.id === id) ? prev : [...prev, nextOption]));
                setDebtAccountId(id);
                setDebtAccountNestedOpen(false);
              }}
            />,
            document.body,
          )
        : null}
      {open && fixedAssetAccountNestedOpen
        ? createPortal(
            <EntityCreateForm
              mode="compact"
              entityType="account"
              open={fixedAssetAccountNestedOpen}
              onClose={() => setFixedAssetAccountNestedOpen(false)}
              title={t("txForm.createFixedAssetAccount")}
              nameLabel={t("txForm.fixedAssetAccountName")}
              namePlaceholder={t("txForm.fixedAssetAccountPlaceholder")}
              defaultType="investment"
              nestedFieldData={localNestedFieldData ?? nestedFieldData}
              hiddenFields={[
                "kind",
                "investProductType",
                "institutionId",
                "fundUnitsDecimals",
                "tradingCalendar",
                "costBasisMethod",
              ]}
              extraFields={{ kind: "investment", investProductType: "property" }}
              onCreated={(id, name) => {
                const option: SmartSelectOption = {
                  id,
                  label: name,
                  subLabel: t("txForm.fixedAssetAccount"),
                };
                setFixedAssetAccountList((prev) => (prev.some((item) => item.id === id) ? prev : [...prev, option]));
                setLocalFixedAssetAccountSSOpts((prev) => mergeSmartSelectOptions(prev, [option]));
                setFixedAssetLinked(true);
                setFixedAssetAccountId(id);
                setFixedAssetAssetId("");
                setFixedAssetAccountNestedOpen(false);
              }}
            />,
            document.body,
          )
        : null}
    </ModalLayerProvider>
  );
}
