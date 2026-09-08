"use client";

import { ArrowLeftRight, ArrowRight, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { EntityCreateForm, NestedAddModal } from "./EntityCreateForm";
import { EntryAttachmentButton, uploadEntryAttachmentFiles } from "./EntryAttachmentPanel";
import { ModalLayerProvider, getNextModalLayerZIndex, useModalLayerZIndex } from "./ModalLayer";
import { SmartSelect, SmartSelectOption } from "./SmartSelect";
import { CurrencySmartSelect } from "./CurrencySmartSelect";
import { UnifiedEntryLauncher } from "./UnifiedEntryLauncher";
import { useAccountSSFilter } from "./accountSSFilter";
import { kindLabel } from "@/lib/account-kinds";
import { getCashTargetOperation } from "@/lib/account-kind-utils";
import { buildAccountDisplayOption, buildGroupedAccountOptions } from "@/lib/account-display";
import { recordRecentAccount, sortByAccountUsage, useAccountUsage } from "@/lib/client/recentAccounts";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import {
  fetchSettingsAccountData,
  fetchSettingsCategories,
  fetchSettingsTags,
  notifySettingsDataChanged,
  SETTINGS_DATA_CHANGED_EVENT,
  type SettingsCategory,
  type SettingsDataChangedDetail,
} from "@/lib/client/settingsCache";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { parseDateInputToUtc as dateInputToUtcDate } from "@/lib/date-utils";
import {
  FIXED_ASSET_EXPENSE_CATEGORY_NAME,
  isFixedAssetAccountLike,
  isFixedAssetExpenseCategoryPath,
} from "@/lib/fixed-asset";
import { useI18n } from "@/lib/i18n";
import {
  buildCreditCardInstallmentSchedule,
  summarizeCreditCardInstallments,
  type CreditCardInstallmentRateType,
} from "@/lib/credit/installment";
import { filterIncomeExpenseInstitutions } from "@/lib/institution-rules";
import { buildCategoryParentOptions, buildCategoryTreeOptions } from "@/components/categorySmartSelect";
import { getAccountLabelFieldsPreference } from "@/lib/client/appPreferences";
import { restrictAccountsByType } from "@/lib/client/account-dropdown-filter";

type TxType = "expense" | "income" | "advance" | "transfer" | "fx" | "investment";
type TransactionActionResult =
  | { ok: true; data?: { id?: string | null; cashEntryId?: string | null } | null }
  | { ok: false; error: string };
type DebtTransferMode = "borrow_in" | "repay_out" | "lend_out" | "collect_in";

/** Red frame marking required select fields (from/to accounts etc.). */
const REQUIRED_FIELD_CLASS = "rounded-[10px] ring-1 ring-rose-200/80";

type AccountOption = {
  id: string;
  label: string;
  icon?: string;
  subLabel?: string;
  kind?: string | null;
  investProductType?: string | null;
  debtDirection?: string | null;
  institutionId?: string | null;
  institutionType?: string | null;
  counterpartyId?: string | null;
  isSettlementDebt?: boolean | null;
  isConsumerLoan?: boolean | null;
  currency?: string | null;
  billingDay?: number | null;
  isHeader?: boolean;
  isGroup?: boolean;
  parentId?: string;
};

type CategoryOption = {
  id: string;
  label: string;
  parentId: string | null;
  type: string;
  sortOrder?: number;
  isSystem?: boolean;
};

type AiPrefillItem = {
  rawText?: string;
  type?: "expense" | "income" | "transfer" | "fx" | "investment";
  date?: string;
  amount?: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  category?: string;
  remark?: string;
  counterparty?: string;
};

type OpenFromAiDetail = {
  requestId: string;
  item: AiPrefillItem;
  source?: "launcher";
  defaultAccountId?: string;
  defaultFromAccountId?: string;
  defaultToAccountId?: string;
  /** Locks the entry type: only this type is kept and the expense/income/advance tab switcher is hidden (e.g. stock-to-cash transfer only allows transfer). */
  lockedType?: TxType;
  /** Stock-to-cash transfer mode: the target account is fixed to the securities cash account of the current stock institution, and the source account is chosen from cash accounts of the same owner. */
  stockTransferMode?: boolean;
  stockCashAccountId?: string;
  stockCashAccountName?: string;
  /** Opens an expense with a fixed-asset account already selected. */
  fixedAssetAccountId?: string;
  fixedAssetAssetId?: string;
  /** Requires the expense to stay linked to a fixed asset, even before an account is selected. */
  fixedAssetRequired?: boolean;
  lockFixedAsset?: boolean;
};

function normalizeYmd(value: string | undefined) {
  const s = (value ?? "").trim();
  if (!s) return "";
  const d = new Date(s.replace(/[年/.]/g, "-").replace(/[月]/g, "-").replace(/[日]/g, ""));
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function toDateInputValue(value: string | null | undefined) {
  const raw = (value ?? "").trim();
  if (!raw) return "";
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})(?:[\sT]+\d{1,2}[:：]\d{2})?/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const normalized = raw
    .replace(/[/.]/g, "-")
    .replace("年", "-")
    .replace("月", "-")
    .replace("日", "")
    .replace(" ", "T");
  const ymd = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymd) {
    return `${ymd[1]}-${String(Number(ymd[2])).padStart(2, "0")}-${String(Number(ymd[3])).padStart(2, "0")}`;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return "";
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
}

function parseMoneyDraft(value: string) {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeCurrencyLabel(value: string | null | undefined) {
  const text = String(value ?? "CNY").trim().toUpperCase();
  return text || "CNY";
}

function formatFxRate(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function formatFxQuoteAmount(value: number, locale: string) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const BASE_CASH_CURRENCY = "CNY";

function isForeignCurrency(value: string | null | undefined) {
  return normalizeCurrencyLabel(value) !== BASE_CASH_CURRENCY;
}

function storedAmountToDialogAmount(type: TxType, value: number) {
  if (type === "transfer") return Math.abs(value);
  return type === "expense" ? -value : value;
}

function dialogAmountToStoredAmount(type: TxType, value: string) {
  const parsed = parseMoneyDraft(value);
  return type === "expense" ? -parsed : parsed;
}

function compactIds(ids: Array<string | null | undefined>) {
  return Array.from(new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean)));
}

function inferDebtTransferMode(
  sourceAccount: AccountOption | SmartSelectOption | undefined,
  targetAccount: AccountOption | SmartSelectOption | undefined,
): DebtTransferMode | null {
  const source = sourceAccount as AccountOption | undefined;
  const target = targetAccount as AccountOption | undefined;
  if (source?.kind === "loan" || source?.kind === "settlement") {
    return source.debtDirection === "receivable" ? "collect_in" : "borrow_in";
  }
  if (target?.kind === "loan" || target?.kind === "settlement") {
    return target.debtDirection === "receivable" ? "lend_out" : "repay_out";
  }
  return null;
}

function isLoanDialogAccount(account: AccountOption | SmartSelectOption | undefined) {
  const option = account as AccountOption | undefined;
  return option?.kind === "loan" && option.isSettlementDebt !== true;
}

function debtDialogEventName(sourceAccount: AccountOption | SmartSelectOption | undefined, targetAccount: AccountOption | SmartSelectOption | undefined) {
  return isLoanDialogAccount(sourceAccount) || isLoanDialogAccount(targetAccount) ? "mmh:loan:create" : "mmh:debt:create";
}

function findAccountIdByLabel(input: string | undefined, options: AccountOption[]) {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  const exact = options.find((o) => o.label === raw);
  if (exact) return exact.id;
  const bySuffix = options.find((o) => o.label.endsWith(`·${raw}`));
  if (bySuffix) return bySuffix.id;
  const lower = raw.toLowerCase();
  const fuzzy = options.find((o) => o.label.toLowerCase().includes(lower) || lower.includes(o.label.toLowerCase()));
  return fuzzy?.id ?? "";
}

function makeRequestId(prefix: string) {
  return prefix + "-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function findCategoryIdByLabel(input: string | undefined, options: CategoryOption[]) {
  const raw = (input ?? "").trim();
  if (!raw) return "";
  const exact = options.find((o) => o.label === raw);
  if (exact) return exact.id;
  const suffix = options.find((o) => o.label.endsWith(`.${raw}`) || o.label.endsWith(raw));
  if (suffix) return suffix.id;
  const lower = raw.toLowerCase();
  const fuzzy = options.find((o) => o.label.toLowerCase().includes(lower) || lower.includes(o.label.toLowerCase()));
  return fuzzy?.id ?? "";
}

function getCategoryLeafName(label: string) {
  return label.includes(".") ? label.split(".").pop() ?? label : label;
}

function buildCategoryOptionsFromSettings(categories: SettingsCategory[], type: string): CategoryOption[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const pathFor = (category: SettingsCategory) => {
    const names: string[] = [];
    const seen = new Set<string>();
    let cursor: SettingsCategory | undefined = category;
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      names.unshift(cursor.name);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
    return names.join(".");
  };
  return categories
    .filter((category) => category.type === type)
    .map((category) => ({
      id: category.id,
      label: pathFor(category),
      parentId: category.parentId ?? null,
      type: category.type,
      sortOrder: category.sortOrder,
      isSystem: category.isSystem,
    }));
}

function settingsAccountToOption(account: SettingsAccountRecord): AccountOption {
  const display = buildAccountDisplayOption(account as Parameters<typeof buildAccountDisplayOption>[0], undefined, { fields: getAccountLabelFieldsPreference() });
  return {
    id: account.id,
    label: display.selectorLabel || display.label,
    subLabel: display.subLabel,
    kind: account.kind ?? null,
    investProductType: account.investProductType ?? null,
    debtDirection: account.debtDirection ?? null,
    institutionId: account.institutionId ?? null,
    currency: account.currency ?? null,
    billingDay: account.billingDay ?? null,
  };
}

function buildGroupedOptionsFromSettingsAccounts(accounts: SettingsAccountRecord[]): SmartSelectOption[] {
  const displayOptions = accounts.map((account) => buildAccountDisplayOption(account as Parameters<typeof buildAccountDisplayOption>[0], undefined, { fields: getAccountLabelFieldsPreference() }));
  const metaById = new Map(accounts.map((account) => [account.id, settingsAccountToOption(account)]));
  return buildGroupedAccountOptions(displayOptions).map((option) => (
    option.isHeader || option.isGroup ? option : { ...option, ...metaById.get(option.id) }
  ));
}

type TagOption = {
  id: string;
  name: string;
  color?: string | null;
};

type EditTagOption = {
  id?: string;
  tagId?: string;
  name?: string | null;
  label?: string | null;
  color?: string | null;
  Tag?: { name?: string | null; color?: string | null } | null;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;
type SubmitMode = "close" | "repeat";
const COUNTERPARTY_TYPES = new Set(["person", "organization"]);

type SettingsAccountRecord = {
  id: string;
  name: string;
  kind?: string | null;
  isActive?: boolean | null;
  isPlaceholder?: boolean | null;
  groupId?: string | null;
  institutionId?: string | null;
  counterpartyId?: string | null;
  numberMasked?: string | null;
  investProductType?: string | null;
  debtDirection?: string | null;
  currency?: string | null;
  billingDay?: number | null;
  Institution?: { name: string | null; shortName?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
};

export function TransactionFormModal({
  accounts,
  transferAccounts,
  expenseCategories,
  incomeCategories,
  advanceCategories,
  defaultAccountId,
  lastRepayToAccountId,
  lastRepayFromAccountId,
  isCreditCardAccount,
  showInvestment,
  action,
  editAction,
  allTags,
  accountSSOptions,
  transferAccountSSOptions,
  fixedAssetAccounts,
  fixedAssetAccountSSOptions,
  nestedFieldData,
  hideTrigger = false,
}: {
  accounts: AccountOption[];
  transferAccounts: AccountOption[];
  expenseCategories: CategoryOption[];
  incomeCategories: CategoryOption[];
  advanceCategories?: CategoryOption[];
  defaultAccountId?: string;
  lastRepayToAccountId?: string;
  lastRepayFromAccountId?: string;
  isCreditCardAccount?: boolean;
  showInvestment?: boolean;
  action: (formData: FormData) => Promise<TransactionActionResult>;
  editAction?: (formData: FormData) => Promise<TransactionActionResult>;
  allTags?: TagOption[];
  /** Hierarchical SmartSelect options for spending account dropdown (grouped by AccountGroup) */
  accountSSOptions?: SmartSelectOption[];
  /** Hierarchical SmartSelect options for transfer account dropdown (grouped by AccountGroup) */
  transferAccountSSOptions?: SmartSelectOption[];
  /** Property investment accounts usable as fixed asset targets from normal expense entries */
  fixedAssetAccounts?: AccountOption[];
  /** Hierarchical SmartSelect options for fixed asset account dropdown */
  fixedAssetAccountSSOptions?: SmartSelectOption[];
  /** Groups & institutions data for NestedAddModal compact account creation */
  nestedFieldData?: NestedFieldData;
  hideTrigger?: boolean;
}) {
  const { t, language } = useI18n();
  const parentModalZIndex = useModalLayerZIndex();
  const modalZIndex = getNextModalLayerZIndex(parentModalZIndex);
  const quickEntryConsumedRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [txType, setTxType] = useState<TxType>("expense");
  const [lockedType, setLockedType] = useState<TxType | null>(null);
  const [stockTransferMode, setStockTransferMode] = useState(false);
  const [stockCashAccountId, setStockCashAccountId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const [editEntryOriginalType, setEditEntryOriginalType] = useState<TxType | null>(null);
  const [editEntryHasFundDetail, setEditEntryHasFundDetail] = useState(false);
  const [editOriginalTransferAccounts, setEditOriginalTransferAccounts] = useState<{ fromAccountId: string; toAccountId: string } | null>(null);
  // Original balance-affecting values captured when an edit dialog opens,
  // used to decide whether the save changes any balance (refresh scope).
  const editOriginalRef = useRef<{
    type: TxType;
    amountStored: number;
    date: string;
    accountId?: string;
    fromAccountId?: string;
    toAccountId?: string;
  } | null>(null);
  const [fromAccountIdEdited, setFromAccountIdEdited] = useState(false);
  const [categoryList, setCategoryList] = useState(expenseCategories);
  const [editCategoryFallback, setEditCategoryFallback] = useState<CategoryOption | null>(null);
  const [categoryNestedOpen, setCategoryNestedOpen] = useState(false);
  const [accountNestedOpen, setAccountNestedOpen] = useState(false);
  const [counterpartyNestedOpen, setCounterpartyNestedOpen] = useState(false);
  const [institutionNestedOpen, setInstitutionNestedOpen] = useState(false);
  const [accountCreateTarget, setAccountCreateTarget] = useState<"account" | "from" | "to">("account");
  const [tagList, setTagList] = useState(allTags ?? []);
  const [accountList, setAccountList] = useState(accounts);
  const [transferAccountList, setTransferAccountList] = useState(transferAccounts);
  const [localAccountSSOpts, setLocalAccountSSOpts] = useState(accountSSOptions);
  const [localTransferAccountSSOpts, setLocalTransferAccountSSOpts] = useState(transferAccountSSOptions);
  const [fixedAssetAccountList, setFixedAssetAccountList] = useState(fixedAssetAccounts ?? []);
  const [localFixedAssetAccountSSOpts, setLocalFixedAssetAccountSSOpts] = useState(fixedAssetAccountSSOptions);
  const [localNestedFieldData, setLocalNestedFieldData] = useState<NestedFieldData | undefined>(nestedFieldData);
  const formRef = useRef<HTMLFormElement>(null);
  const submittingRef = useRef(false);

  function mergeSmartSelectOptions(base?: SmartSelectOption[], extra?: SmartSelectOption[]) {
    const merged = [...(base ?? [])];
    const seen = new Set(merged.map((opt) => opt.id));
    for (const opt of extra ?? []) {
      if (!seen.has(opt.id)) merged.push(opt);
    }
    return merged;
  }

  function normalizeEditTagOptions(tags: EditTagOption[] | undefined): TagOption[] {
    const normalized: TagOption[] = [];
    const seen = new Set<string>();
    for (const tag of tags ?? []) {
      const id = String(tag.id ?? tag.tagId ?? "").trim();
      if (!id || seen.has(id)) continue;
      const name = String(tag.name ?? tag.label ?? tag.Tag?.name ?? "").trim();
      if (!name) continue;
      normalized.push({ id, name, color: tag.color ?? tag.Tag?.color ?? null });
      seen.add(id);
    }
    return normalized;
  }

  function mergeTagOptions(base: TagOption[], extra: TagOption[]) {
    if (extra.length === 0) return base;
    const merged = [...base];
    const byId = new Map(merged.map((tag, index) => [tag.id, index]));
    for (const tag of extra) {
      const existingIndex = byId.get(tag.id);
      if (existingIndex == null) {
        byId.set(tag.id, merged.length);
        merged.push(tag);
        continue;
      }
      const existing = merged[existingIndex];
      if (!existing.name && tag.name) {
        merged[existingIndex] = { ...existing, name: tag.name, color: existing.color ?? tag.color ?? null };
      }
    }
    return merged;
  }

  function appendAccountOptionWithGroup(
    base: SmartSelectOption[] | undefined,
    option: SmartSelectOption,
    groupId?: string,
    groupName?: string,
  ) {
    const next = [...(base ?? [])];
    const headerId = groupId ? `group:${groupId}` : "";
    if (headerId && groupName?.trim() && !next.some((item) => item.id === headerId)) {
      next.push({ id: headerId, label: groupName.trim(), isHeader: true });
    }
    if (!next.some((item) => item.id === option.id)) {
      next.push({
        ...option,
        parentId: headerId || undefined,
      });
    }
    return next;
  }

  async function openAccountCreate(target: "account" | "from" | "to") {
    setAccountCreateTarget(target);
    setAccountNestedOpen(true);
    void (async () => {
      const res = await fetch("/api/v1/accounts/internal?balances=false", { cache: "no-store" }).catch(() => null);
      if (res?.ok) {
        const data = await res.json().catch(() => null);
        if (data?.ok) {
          setLocalNestedFieldData({
            groupId: (data.groups ?? []).filter((group: { name: string }) => group.name !== "未指定").map((group: { id: string; name: string }) => ({ id: group.id, name: group.name })),
            institutionId: (data.institutions ?? []).map((institution: { id: string; name: string; shortName?: string | null; type?: string | null }) => ({
              id: institution.id,
              name: institution.shortName?.trim() || institution.name,
              type: institution.type ?? "",
            })),
            counterpartyId: (data.counterparties ?? [])
              .filter((counterparty: { type?: string | null }) => COUNTERPARTY_TYPES.has(counterparty.type ?? "other"))
              .map((counterparty: { id: string; name: string; shortName?: string | null; type?: string | null }) => ({
                id: counterparty.id,
                name: counterparty.shortName?.trim() || counterparty.name,
                type: counterparty.type ?? "other",
              })),
          });
        }
      }
    })();
  }

  useEffect(() => {
    setLocalNestedFieldData(nestedFieldData);
  }, [nestedFieldData]);

  useEffect(() => {
    if (accountSSOptions) {
      setLocalAccountSSOpts((prev) => mergeSmartSelectOptions(accountSSOptions, prev));
    }
  }, [accountSSOptions]);

  useEffect(() => {
    if (transferAccountSSOptions) {
      setLocalTransferAccountSSOpts((prev) => mergeSmartSelectOptions(transferAccountSSOptions, prev));
    }
  }, [transferAccountSSOptions]);

  useEffect(() => {
    setFixedAssetAccountList(fixedAssetAccounts ?? []);
  }, [fixedAssetAccounts]);

  useEffect(() => {
    if (fixedAssetAccountSSOptions) {
      setLocalFixedAssetAccountSSOpts((prev) => mergeSmartSelectOptions(fixedAssetAccountSSOptions, prev));
    }
  }, [fixedAssetAccountSSOptions]);

  const currentCategoryType = useMemo(() =>
    txType === "income" ? "income" :
    txType === "advance" ? "advance" :
    txType === "investment" ? "investment" : "expense",
  [txType]);

  /** Build parent category options with hierarchical display.
   * In transaction entry, new categories are created under an existing category,
   * so every existing category, including top-level categories, can be selected
   * as the parent.
   */
  const categoryParentOptions = useMemo(
    () => buildCategoryParentOptions(categoryList, t, currentCategoryType),
    [categoryList, currentCategoryType, t],
  );

  /** Build hierarchical SmartSelect options for category dropdown.
   * All real categories are selectable. Categories with children are collapsible
   * groups, and their caret toggles expansion without taking away selection.
   */
  const categorySSOptions = useMemo(() => buildCategoryTreeOptions(categoryList, t), [categoryList, t]);

  useEffect(() => {
    const nextCategoryList = txType === "income" ? incomeCategories : txType === "advance" ? (advanceCategories ?? []) : expenseCategories;
    const fallback = editCategoryFallback && editCategoryFallback.type === currentCategoryType
      ? editCategoryFallback
      : null;
    setCategoryList(() => {
      if (!fallback || nextCategoryList.some((category) => category.id === fallback.id)) return nextCategoryList;
      return [...nextCategoryList, fallback];
    });
    setCategoryId((current) => current && (nextCategoryList.some((c) => c.id === current) || fallback?.id === current) ? current : "");
  }, [currentCategoryType, editCategoryFallback, txType, incomeCategories, advanceCategories, expenseCategories]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const [date, setDate] = useState(today);
  const [postedAt, setPostedAt] = useState(() => toDateInputValue(today));
  const [postedAtEdited, setPostedAtEdited] = useState(false);
  const [amount, setAmount] = useState("");
  const [fxToAmount, setFxToAmount] = useState("");
  const [fxRate, setFxRate] = useState("");
  const [fxFeeAmount, setFxFeeAmount] = useState("");
  const [fxFromCurrencyDraft, setFxFromCurrencyDraft] = useState("CNY");
  const [fxToCurrencyDraft, setFxToCurrencyDraft] = useState("USD");
  const [fetchingFxRate, setFetchingFxRate] = useState(false);
  const [createInstallment, setCreateInstallment] = useState(false);
  const [installmentAmount, setInstallmentAmount] = useState("");
  const [installmentAmountEdited, setInstallmentAmountEdited] = useState(false);
  const [installmentTotal, setInstallmentTotal] = useState("12");
  const [installmentRateType, setInstallmentRateType] = useState<CreditCardInstallmentRateType>("period_fee");
  const [installmentRate, setInstallmentRate] = useState("0");
  const [accountId, setAccountId] = useState(defaultAccountId ?? "");
  const [fromAccountId, setFromAccountId] = useState(isCreditCardAccount ? (lastRepayFromAccountId ?? defaultAccountId ?? "") : "");
  const [toAccountId, setToAccountId] = useState(isCreditCardAccount ? (defaultAccountId ?? "") : "");
  const [categoryId, setCategoryId] = useState("");
  const [fixedAssetLinked, setFixedAssetLinked] = useState(false);
  const [fixedAssetAccountId, setFixedAssetAccountId] = useState("");
  const [fixedAssetAssetId, setFixedAssetAssetId] = useState("");
  const [fixedAssetLinkLocked, setFixedAssetLinkLocked] = useState(false);
  const [fixedAssetAccountNestedOpen, setFixedAssetAccountNestedOpen] = useState(false);
  const [fixedAssetAccountAutoOpen, setFixedAssetAccountAutoOpen] = useState(false);
  const [counterpartyInstitutionId, setCounterpartyInstitutionId] = useState("");
  const [note, setNote] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [pendingAttachmentFiles, setPendingAttachmentFiles] = useState<File[]>([]);
  const [isFromButton, setIsFromButton] = useState(false);
  const amountInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    async function refreshAccountData() {
      const data = await fetchSettingsAccountData({ force: true }).catch(() => null);
      if (cancelled || !data) return;
      const rawAccounts = (data.accounts as SettingsAccountRecord[])
        .filter((account) => account.isPlaceholder !== true && account.isActive !== false);
      const allOptions = rawAccounts.map(settingsAccountToOption);
      const allowedKinds = new Set(
        [...accounts, ...accountList]
          .map((account) => account.kind)
          .filter((kind): kind is string => Boolean(kind)),
      );
      const nextAccountOptions = restrictAccountsByType(allOptions, (option) => !allowedKinds.size || allowedKinds.has(option.kind ?? ""));
      const nextFixedAssetAccountOptions = allOptions.filter(isFixedAssetAccountLike);
      const selectedIds = new Set([accountId, fromAccountId, toAccountId].filter(Boolean));
      setAccountList((prev) => {
        const selectedOnly = prev.filter((option) => selectedIds.has(option.id) && !nextAccountOptions.some((next) => next.id === option.id));
        return mergeSmartSelectOptions(nextAccountOptions, selectedOnly);
      });
      setTransferAccountList((prev) => {
        const selectedOnly = prev.filter((option) => selectedIds.has(option.id) && !allOptions.some((next) => next.id === option.id));
        return mergeSmartSelectOptions(allOptions, selectedOnly);
      });
      setFixedAssetAccountList((prev) => {
        const selectedOnly = prev.filter((option) => fixedAssetAccountId === option.id && !nextFixedAssetAccountOptions.some((next) => next.id === option.id));
        return mergeSmartSelectOptions(nextFixedAssetAccountOptions, selectedOnly);
      });
      const groupedAll = buildGroupedOptionsFromSettingsAccounts(rawAccounts);
      const groupedAccount = buildGroupedOptionsFromSettingsAccounts(
        restrictAccountsByType(rawAccounts, (account) => !allowedKinds.size || allowedKinds.has(account.kind ?? "")),
      );
      const groupedFixedAsset = buildGroupedOptionsFromSettingsAccounts(
        rawAccounts.filter(isFixedAssetAccountLike),
      );
      setLocalAccountSSOpts(groupedAccount);
      setLocalTransferAccountSSOpts(groupedAll);
      setLocalFixedAssetAccountSSOpts(groupedFixedAsset);
      setLocalNestedFieldData({
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
      });
    }

    async function refreshCategories() {
      const next = await fetchSettingsCategories({ force: true }).catch(() => null);
      if (cancelled || !next) return;
      setCategoryList(buildCategoryOptionsFromSettings(next, currentCategoryType));
    }

    async function refreshTags() {
      const next = await fetchSettingsTags({ force: true }).catch(() => null);
      if (cancelled || !next) return;
      setTagList(next.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })));
    }

    function onSettingsChanged(ev: Event) {
      const detail = (ev as CustomEvent<SettingsDataChangedDetail>).detail;
      const scope = detail?.scope ?? "all";
      if (scope === "accounts" || scope === "all") void refreshAccountData();
      if (scope === "categories" || scope === "all") void refreshCategories();
      if (scope === "tags" || scope === "all") void refreshTags();
    }

    window.addEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    return () => {
      cancelled = true;
      window.removeEventListener(SETTINGS_DATA_CHANGED_EVENT, onSettingsChanged as EventListener);
    };
  }, [
    accountId,
    accountList,
    accounts,
    currentCategoryType,
    fromAccountId,
    fixedAssetAccountId,
    toAccountId,
  ]);

  const {
    typeFilter: accountTypeFilter,
    typeFilterLabel: accountTypeFilterLabel,
    cycleTypeFilter: cycleAccountTypeFilter,
    filteredOptions: accountSSOptionsFiltered,
    visibleOptionIds: accountVisibleOptionIds,
  } = useAccountSSFilter(localAccountSSOpts, undefined, (bucket) => (bucket ? t(`accountTypeBucket.${bucket}`) : t("common.all")));
  const {
    filteredOptions: transferFiltered,
    visibleOptionIds: transferVisibleOptionIds,
  } = useAccountSSFilter(localTransferAccountSSOpts, accountTypeFilter);
  const {
    filteredOptions: fixedAssetFiltered,
    visibleOptionIds: fixedAssetVisibleOptionIds,
  } = useAccountSSFilter(localFixedAssetAccountSSOpts, accountTypeFilter);

  const accountUsage = useAccountUsage();
  const displayTransferOptions = useMemo(() => {
    const source = (transferFiltered?.length ? transferFiltered : localTransferAccountSSOpts) ?? [];
    const filtered = source.filter((option) => !option.isHeader);
    let merged = mergeSmartSelectOptions(filtered, transferAccountList);
    const selectedIds = new Set([fromAccountId, toAccountId].filter(Boolean));
    const selectedOptions = merged.filter((option) => selectedIds.has(option.id));
    if (transferVisibleOptionIds) {
      merged = merged.filter((option) => transferVisibleOptionIds.has(option.id));
    }
    // Stock-to-cash transfer: the source account cannot be the securities cash account itself; keep only cash accounts of the same owner.
    if (stockTransferMode && stockCashAccountId) {
      merged = merged.filter((option) => option.id !== stockCashAccountId);
    }
    for (const option of selectedOptions) {
      if (!merged.some((item) => item.id === option.id)) merged.push(option);
    }
    return sortByAccountUsage(merged, accountUsage);
  }, [accountUsage, fromAccountId, localTransferAccountSSOpts, stockCashAccountId, stockTransferMode, toAccountId, transferAccountList, transferFiltered, transferVisibleOptionIds]);

  // Stock-to-cash transfer target: securities cash account of the current stock institution + cash accounts of the same owner.
  const stockTransferToOptions = useMemo(() => {
    const source = (transferFiltered?.length ? transferFiltered : localTransferAccountSSOpts) ?? [];
    const filtered = source.filter((option) => !option.isHeader);
    let merged = mergeSmartSelectOptions(filtered, transferAccountList);
    if (transferVisibleOptionIds) {
      merged = merged.filter((option) => transferVisibleOptionIds.has(option.id));
    }
    if (stockCashAccountId && !merged.some((option) => option.id === stockCashAccountId)) {
      const cashOption = transferAccountList.find((option) => option.id === stockCashAccountId)
        ?? localTransferAccountSSOpts?.find((option) => option.id === stockCashAccountId && !option.isHeader);
      if (cashOption) merged.push(cashOption);
    }
    return sortByAccountUsage(merged, accountUsage);
  }, [accountUsage, localTransferAccountSSOpts, stockCashAccountId, transferAccountList, transferFiltered, transferVisibleOptionIds]);

  const displayAccountOptions = useMemo(() => {
    let base = mergeSmartSelectOptions(accountSSOptionsFiltered, accountList);
    if (accountVisibleOptionIds) {
      base = base.filter((option) => accountVisibleOptionIds.has(option.id));
    }
    return sortByAccountUsage(base, accountUsage);
  }, [accountSSOptionsFiltered, accountList, accountUsage, accountVisibleOptionIds]);
  const displayFixedAssetAccountOptions = useMemo(() => {
    let base = mergeSmartSelectOptions(fixedAssetFiltered, fixedAssetAccountList);
    const selected = fixedAssetAccountList.find((option) => option.id === fixedAssetAccountId);
    if (fixedAssetVisibleOptionIds) {
      base = base.filter((option) => fixedAssetVisibleOptionIds.has(option.id));
    }
    if (selected && !base.some((option) => option.id === selected.id)) base.push(selected);
    return sortByAccountUsage(base, accountUsage);
  }, [accountUsage, fixedAssetAccountId, fixedAssetAccountList, fixedAssetFiltered, fixedAssetVisibleOptionIds]);
  const fixedAssetSelectableOptions = useMemo(
    () => displayFixedAssetAccountOptions.filter((option) => !option.isHeader && !option.isGroup),
    [displayFixedAssetAccountOptions],
  );
  const incomeExpenseInstitutionOptions = useMemo(
    () => filterIncomeExpenseInstitutions(localNestedFieldData?.institutionId ?? nestedFieldData?.institutionId ?? []),
    [localNestedFieldData, nestedFieldData],
  );
  const compactAccountSelectBehavior = useMemo(() => ({
    density: "compact" as const,
    dropdownMaxHeight: 320,
  }), []);
  const fixedAssetAccountSelectBehavior = useMemo(() => ({
    ...compactAccountSelectBehavior,
    autoOpen: fixedAssetAccountAutoOpen,
    onDropdownClose: () => setFixedAssetAccountAutoOpen(false),
  }), [compactAccountSelectBehavior, fixedAssetAccountAutoOpen]);

  useEffect(() => {
    if (!open || txType !== "expense" || !fixedAssetLinked) return;
    if (fixedAssetAccountId) return;
    if (fixedAssetSelectableOptions.length !== 1) return;
    const [onlyOption] = fixedAssetSelectableOptions;
    setFixedAssetAccountId(onlyOption.id);
    setFixedAssetAssetId("");
    setFixedAssetAccountAutoOpen(false);
  }, [fixedAssetAccountId, fixedAssetLinked, fixedAssetSelectableOptions, open, txType]);

  const accountMetaById = useMemo(() => {
    const map = new Map<string, AccountOption>();
    const add = (option: AccountOption | SmartSelectOption | undefined) => {
      if (!option?.id || option.isHeader || option.isGroup) return;
      const current = map.get(option.id);
      const next = option as AccountOption;
      if (!current || (!current.kind && next.kind)) {
        map.set(option.id, next);
      }
    };
    [...transferAccountList, ...accountList, ...fixedAssetAccountList].forEach(add);
    (localTransferAccountSSOpts ?? []).forEach(add);
    (localAccountSSOpts ?? []).forEach(add);
    (localFixedAssetAccountSSOpts ?? []).forEach(add);
    return map;
  }, [accountList, fixedAssetAccountList, localAccountSSOpts, localFixedAssetAccountSSOpts, localTransferAccountSSOpts, transferAccountList]);
  const selectedAccountIsCreditCard = accountMetaById.get(accountId)?.kind === "bank_credit"
    || (isCreditCardAccount && accountId === (defaultAccountId ?? accountId));
  const fxFromCurrency = fromAccountId
    ? normalizeCurrencyLabel(accountMetaById.get(fromAccountId)?.currency)
    : fxFromCurrencyDraft;
  const fxToCurrency = toAccountId
    ? normalizeCurrencyLabel(accountMetaById.get(toAccountId)?.currency)
    : fxToCurrencyDraft;
  const fxComputedRate = useMemo(() => {
    const fromValue = parseMoneyDraft(amount);
    const toValue = parseMoneyDraft(fxToAmount);
    return fromValue > 0 && toValue > 0 ? toValue / fromValue : null;
  }, [amount, fxToAmount]);
  const fxFromAccountOptions = useMemo(
    () => displayTransferOptions.filter((option) => (option as AccountOption).kind === "bank_debit"),
    [displayTransferOptions],
  );
  const fxToAccountOptions = useMemo(
    () => displayTransferOptions.filter((option) => {
      const account = option as AccountOption;
      return account.id !== fromAccountId
        && account.kind !== "bank_credit"
        && account.kind !== "loan"
        && account.kind !== "settlement"
        && isForeignCurrency(account.currency);
    }),
    [displayTransferOptions, fromAccountId],
  );
  function formatFxAmount(value: number) {
    if (!Number.isFinite(value) || value <= 0) return "";
    return value.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  }
  function updateFxFromAmount(value: string) {
    setAmount(value);
    const fromValue = parseMoneyDraft(value);
    const rateValue = parseMoneyDraft(fxRate);
    if (fromValue > 0 && rateValue > 0) setFxToAmount(formatFxAmount(fromValue * rateValue));
  }
  function updateFxRate(value: string) {
    setFxRate(value);
    const fromValue = parseMoneyDraft(amount);
    const rateValue = parseMoneyDraft(value);
    if (fromValue > 0 && rateValue > 0) setFxToAmount(formatFxAmount(fromValue * rateValue));
  }
  function updateFxToAmount(value: string) {
    setFxToAmount(value);
    const fromValue = parseMoneyDraft(amount);
    const toValue = parseMoneyDraft(value);
    if (fromValue > 0 && toValue > 0) setFxRate(formatFxRate(toValue / fromValue));
  }
  async function fetchFxRateForForm() {
    if (fetchingFxRate) return;
    if (!fxFromCurrency || !fxToCurrency || fxFromCurrency === fxToCurrency) {
      window.alert(t("txForm.alert.selectDifferentCurrencies"));
      return;
    }
    setFetchingFxRate(true);
    try {
      const params = new URLSearchParams({
        from: fxFromCurrency,
        to: fxToCurrency,
        refresh: "1",
      });
      const res = await fetch(`/api/v1/fx-rates?${params.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok || !Array.isArray(data.rates)) {
        throw new Error(data?.error || t("txForm.alert.fxFetchFailed"));
      }
      const rateRow = data.rates.find((rate: { fromCurrency?: string; toCurrency?: string }) =>
        normalizeCurrencyLabel(rate.fromCurrency) === fxFromCurrency &&
        normalizeCurrencyLabel(rate.toCurrency) === fxToCurrency
      );
      const rate = Number(rateRow?.rate);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(t("txForm.alert.fxRateUnavailable"));
      }
      const formattedRate = formatFxRate(rate);
      setFxRate(formattedRate);
      const fromValue = parseMoneyDraft(amount);
      if (fromValue > 0) setFxToAmount(formatFxAmount(fromValue * rate));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("txForm.alert.fxFetchFailedManual"));
    } finally {
      setFetchingFxRate(false);
    }
  }
  const fxCommonQuoteText = useMemo(() => {
    if (fxFromCurrency === fxToCurrency) return t("txForm.alert.sameCurrency");
    const fromValue = parseMoneyDraft(amount);
    const toValue = parseMoneyDraft(fxToAmount);
    if (fromValue <= 0 || toValue <= 0) return "";
    const quoteBase = 100;
    const quoteAmount = (fromValue / toValue) * quoteBase;
    if (!Number.isFinite(quoteAmount) || quoteAmount <= 0) return "";
    return t("txForm.fxCommonQuote", { base: quoteBase, to: fxToCurrency, amount: formatFxQuoteAmount(quoteAmount, language), from: fxFromCurrency });
  }, [amount, fxFromCurrency, language, fxToAmount, fxToCurrency, t]);
  const installmentPreview = useMemo(() => {
    if (!createInstallment) return null;
    const account = accountMetaById.get(accountId);
    const billingDay = Number(account?.billingDay);
    const firstDate = dateInputToUtcDate(date);
    if (!firstDate || !Number.isFinite(billingDay) || billingDay < 1 || billingDay > 31) return null;
    try {
      const rows = buildCreditCardInstallmentSchedule({
        principal: Number(installmentAmount),
        totalRuns: Number(installmentTotal),
        rateType: installmentRateType,
        rate: Number(installmentRate),
        billingDay,
        firstDate,
      });
      return {
        rows,
        summary: summarizeCreditCardInstallments(rows),
      };
    } catch {
      return null;
    }
  }, [accountId, accountMetaById, createInstallment, date, installmentAmount, installmentRate, installmentRateType, installmentTotal]);

  function openSpecialTransferTargetIfNeeded() {
    if (txType !== "transfer") return false;
    const sourceAccount = accountMetaById.get(fromAccountId);
    const targetAccount = accountMetaById.get(toAccountId);
    const debtMode = inferDebtTransferMode(sourceAccount, targetAccount);
    const operation = debtMode ? "debt" : getCashTargetOperation(targetAccount);
    if (operation === "transfer") return false;

    if (editEntryId) {
      if (operation === "debt" && debtMode && editEntryOriginalType !== "transfer") {
        return false;
      }
      if (operation === "debt" && debtMode) {
        const isDebtSourceFlow = debtMode === "borrow_in" || debtMode === "collect_in";
        const cashAccountId = isDebtSourceFlow ? toAccountId : fromAccountId;
        const debtAccountId = isDebtSourceFlow ? fromAccountId : toAccountId;
        if (!cashAccountId) {
          window.alert(isDebtSourceFlow ? t("txForm.alert.selectCashInAccount") : t("txForm.alert.selectCashSourceAccount"));
          return true;
        }
        const amountNumber = Number(amount);
        if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
          window.alert(t("txForm.alert.invalidAmount"));
          return true;
        }

        window.dispatchEvent(new CustomEvent(debtDialogEventName(sourceAccount, targetAccount), {
          detail: {
            requestId: requestId ?? makeRequestId(operation),
            editEntryId,
            mode: debtMode,
            defaultDebtAccountId: debtAccountId,
            defaultCashAccountId: cashAccountId,
            defaultDate: date,
            defaultPrincipal: amountNumber,
            defaultNote: note,
          },
        }));
        setOpen(false);
        resetDraft();
        return true;
      }
      window.alert(t("txForm.alert.specialTargetAccount"));
      return true;
    }
    const isDebtSourceFlow = debtMode === "borrow_in" || debtMode === "collect_in";
    const cashAccountId = isDebtSourceFlow ? toAccountId : fromAccountId;
    const debtAccountId = isDebtSourceFlow ? fromAccountId : toAccountId;
    if (!cashAccountId) {
      window.alert(isDebtSourceFlow ? t("txForm.alert.selectCashInAccount") : t("txForm.alert.selectCashSourceAccount"));
      return true;
    }
    const amountNumber = Number(amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      window.alert(t("txForm.alert.invalidAmount"));
      return true;
    }

    const nextRequestId = requestId ?? makeRequestId(operation);
    const baseDetail = {
      requestId: nextRequestId,
      defaultCashAccountId: cashAccountId,
      defaultDate: date,
      defaultAmount: amountNumber,
    };

    if (operation === "investment") {
      const productType = targetAccount?.investProductType === "metal"
        ? "metal"
        : targetAccount?.investProductType === "money"
          ? "money"
          : "fund";
      window.dispatchEvent(new CustomEvent("mmh:investment:create", {
        detail: {
          ...baseDetail,
          defaultAccountId: toAccountId,
          defaultProductType: productType,
        },
      }));
    } else if (operation === "wealth") {
      window.dispatchEvent(new CustomEvent("mmh:wealth:create", {
        detail: {
          ...baseDetail,
          defaultWealthAccountId: toAccountId,
        },
      }));
    } else if (operation === "deposit") {
      window.dispatchEvent(new CustomEvent("mmh:deposit:create", {
        detail: {
          ...baseDetail,
          defaultDepositAccountId: toAccountId,
          defaultSubtype: "buy",
        },
      }));
    } else if (operation === "debt") {
      window.dispatchEvent(new CustomEvent(debtDialogEventName(sourceAccount, targetAccount), {
        detail: {
          requestId: nextRequestId,
          mode: debtMode ?? (targetAccount?.debtDirection === "receivable" ? "lend_out" : "repay_out"),
          defaultDebtAccountId: debtAccountId,
          defaultCashAccountId: cashAccountId,
          defaultDate: date,
          defaultPrincipal: amountNumber,
        },
      }));
    }

    setOpen(false);
    resetDraft();
    return true;
  }
  useEffect(() => {
    if (!open || txType === "transfer" || !accountId) return;
    setLocalAccountSSOpts((prev) => {
      const currentOptions = prev ?? accountSSOptions ?? [];
      if (currentOptions.some((opt) => opt.id === accountId)) return prev;
      const fallback = accountList.find((opt) => opt.id === accountId);
      if (!fallback) return prev;
      return [...currentOptions, fallback];
    });
  }, [open, txType, accountId, accountList, accountSSOptions]);

  function resetDraft() {
    setTxType("expense");
    setDate(today);
    setPostedAt(toDateInputValue(today));
    setPostedAtEdited(false);
    setAmount("");
    setFxToAmount("");
    setFxRate("");
    setFxFeeAmount("");
    setFxFromCurrencyDraft("CNY");
    setFxToCurrencyDraft("USD");
    setCreateInstallment(false);
    setInstallmentAmount("");
    setInstallmentAmountEdited(false);
    setInstallmentTotal("12");
    setInstallmentRateType("period_fee");
    setInstallmentRate("0");
    setAccountId(defaultAccountId ?? "");
    if (isCreditCardAccount) {
      setFromAccountId(lastRepayFromAccountId ?? defaultAccountId ?? "");
      setToAccountId(defaultAccountId ?? "");
    } else {
      setFromAccountId("");
      setToAccountId("");
    }
    setCategoryId("");
    setEditCategoryFallback(null);
    setFixedAssetLinked(false);
    setFixedAssetAccountId("");
    setFixedAssetAssetId("");
    setFixedAssetLinkLocked(false);
    setFixedAssetAccountNestedOpen(false);
    setFixedAssetAccountAutoOpen(false);
    setCounterpartyInstitutionId("");
    setNote("");
    setSelectedTagIds([]);
    setPendingAttachmentFiles([]);
    setRequestId(null);
    setEditEntryId(null);
    setEditEntryOriginalType(null);
    setEditEntryHasFundDetail(false);
    setEditOriginalTransferAccounts(null);
    setFromAccountIdEdited(false);
    editOriginalRef.current = null;
  }
  useCloseOnNavigation(open, () => {
    setOpen(false);
    resetDraft();
  });

  function repeatDraft() {
    setAmount("");
    setFxToAmount("");
    setFxRate("");
    setFxFeeAmount("");
    setCreateInstallment(false);
    setInstallmentAmount("");
    setInstallmentAmountEdited(false);
    setFixedAssetLinked(false);
    setFixedAssetAccountId("");
    setFixedAssetAssetId("");
    setFixedAssetLinkLocked(false);
    setFixedAssetAccountNestedOpen(false);
    setFixedAssetAccountAutoOpen(false);
    setPendingAttachmentFiles([]);
    setRequestId(null);
    setEditEntryId(null);
    setEditEntryOriginalType(null);
    setEditEntryHasFundDetail(false);
    setEditOriginalTransferAccounts(null);
    editOriginalRef.current = null;
    if ((txType === "transfer" || txType === "fx") && !isCreditCardAccount && !fromAccountId && defaultAccountId) {
      setFromAccountId(defaultAccountId);
    }
    focusAmountInput();
  }

  function focusAmountInput() {
    if (txType === "fx" || txType === "investment") return;
    requestAnimationFrame(() => {
      amountInputRef.current?.focus();
    });
  }

  function swapTransferAccounts() {
    const prevFrom = fromAccountId;
    const prevTo = toAccountId;
    setFromAccountId(prevTo);
    setToAccountId(prevFrom);
  }

  function switchType(nextType: TxType) {
    if (lockedType && nextType !== lockedType) return;
    const currentType = txType;
    if ((nextType === "transfer" || nextType === "fx") && currentType !== "transfer" && currentType !== "fx") {
      setAmount((value) => {
        const numericValue = Number(String(value).replace(/,/g, ""));
        return Number.isFinite(numericValue) && numericValue !== 0 ? String(Math.abs(numericValue)) : value;
      });
      const currentAccountId = accountId || defaultAccountId || "";
      if (currentType === "income") {
        setToAccountId(currentAccountId);
        if (fromAccountId === currentAccountId) setFromAccountId("");
        setFromAccountIdEdited(false);
      } else {
        setFromAccountId(currentAccountId);
        if (toAccountId === currentAccountId) setToAccountId("");
        setFromAccountIdEdited(true);
      }
      setCategoryId("");
      setEditCategoryFallback(null);
    } else if ((currentType === "transfer" || currentType === "fx") && nextType !== "transfer" && nextType !== "fx") {
      const transferFromAccountId = fromAccountId || editOriginalTransferAccounts?.fromAccountId || "";
      const transferToAccountId = toAccountId || editOriginalTransferAccounts?.toAccountId || "";
      const nextAccountId = nextType === "income"
        ? transferToAccountId || transferFromAccountId || defaultAccountId || ""
        : transferFromAccountId || transferToAccountId || defaultAccountId || "";
      setAccountId(nextAccountId);
      setFromAccountIdEdited(false);
    }
    setTxType(nextType);
    if (nextType !== "expense") {
      setFixedAssetLinked(false);
      setFixedAssetAccountId("");
      setFixedAssetAssetId("");
      setFixedAssetLinkLocked(false);
      setFixedAssetAccountNestedOpen(false);
      setFixedAssetAccountAutoOpen(false);
    }
  }

  function handleCategoryChange(nextCategoryId: string) {
    setCategoryId(nextCategoryId);
    if (txType !== "expense") return;
    const selected = categoryList.find((category) => category.id === nextCategoryId);
    if (!isFixedAssetExpenseCategoryPath(selected?.label)) return;
    setFixedAssetLinked(true);
    setFixedAssetAccountNestedOpen(true);
    setFixedAssetAccountAutoOpen(false);
  }

  useEffect(() => {
    function onOpenFromAi(ev: Event) {
      const detail = (ev as CustomEvent<OpenFromAiDetail>).detail;
      if (!detail?.requestId || !detail.item) return;

      const item = detail.item;
      const mappedType: TxType =
        item.type === "income"
          ? "income"
          : item.type === "transfer"
            ? "transfer"
            : item.type === "fx"
              ? "fx"
            : item.type === "investment"
              ? "investment"
              : "expense";
      const effectiveType = detail.lockedType ?? mappedType;

      setRequestId(detail.requestId);
      setOpen(true);
      setIsFromButton(detail.source === "launcher");
      setLockedType(detail.lockedType ?? null);
      setStockTransferMode(detail.stockTransferMode === true);
      setStockCashAccountId(detail.stockCashAccountId ?? "");
      const forcedFixedAssetAccountId = detail.fixedAssetAccountId?.trim() ?? "";
      const fixedAssetRequired = effectiveType === "expense" && (
        detail.fixedAssetRequired === true
        || detail.lockFixedAsset === true
        || Boolean(forcedFixedAssetAccountId)
      );
      setFixedAssetLinked(fixedAssetRequired);
      setFixedAssetAccountId(forcedFixedAssetAccountId);
      setFixedAssetAssetId(detail.fixedAssetAssetId?.trim() ?? "");
      setFixedAssetLinkLocked(effectiveType === "expense" && detail.lockFixedAsset === true);
      setFixedAssetAccountNestedOpen(false);
      setFixedAssetAccountAutoOpen(fixedAssetRequired && !forcedFixedAssetAccountId);
      setTxType(effectiveType);

      const dateStr = normalizeYmd(item.date) || today;
      setDate(dateStr);
      setPostedAt(toDateInputValue(dateStr));
      setPostedAtEdited(false);

      const num = typeof item.amount === "number" && Number.isFinite(item.amount) ? item.amount : 0;
      setAmount(num > 0 ? String(num) : "");

      const noteText = (item.remark ?? "").trim() || (item.counterparty ?? "").trim() || (item.rawText ?? "").trim();
      setNote(noteText);

      setFxToAmount("");
      setFxRate("");
      setFxFeeAmount("");

      if (effectiveType === "transfer" || effectiveType === "fx") {
        const nextFromAccountId = findAccountIdByLabel(item.fromAccount, transferAccounts) || detail.defaultFromAccountId || detail.defaultAccountId || (defaultAccountId ?? "");
        const rawNextToAccountId = findAccountIdByLabel(item.toAccount ?? item.account, transferAccounts) || detail.defaultToAccountId || "";
        const rawNextToAccount = transferAccounts.find((account) => account.id === rawNextToAccountId);
        const nextToAccountId = effectiveType === "fx" && rawNextToAccount && !isForeignCurrency(rawNextToAccount.currency)
          ? ""
          : rawNextToAccountId;
        // Stock-to-cash transfer: the target account is fixed to the securities cash account of the current stock institution.
        const effectiveToAccountId = detail.stockTransferMode
          ? (detail.stockCashAccountId || nextToAccountId)
          : nextToAccountId;
        const effectiveFromAccountId = detail.stockTransferMode && effectiveToAccountId === nextFromAccountId
          ? ""
          : nextFromAccountId;
        setFromAccountId(effectiveFromAccountId);
        setToAccountId(effectiveToAccountId);
        if (effectiveType === "fx") {
          const fromCurrency = transferAccounts.find((account) => account.id === nextFromAccountId)?.currency;
          const toCurrency = transferAccounts.find((account) => account.id === nextToAccountId)?.currency;
          setFxFromCurrencyDraft(normalizeCurrencyLabel(fromCurrency));
          setFxToCurrencyDraft(toCurrency ? normalizeCurrencyLabel(toCurrency) : "USD");
        }
        setCategoryId("");
        setAccountId("");
      } else {
        setAccountId(findAccountIdByLabel(item.account, accounts) || (defaultAccountId ?? ""));

        const rawCat = (item.category ?? "").trim();
        const withTypePrefix = rawCat ? `支出.${rawCat}` : "";
        const nextCatId = fixedAssetRequired
          ? findCategoryIdByLabel(FIXED_ASSET_EXPENSE_CATEGORY_NAME, expenseCategories)
            || findCategoryIdByLabel(withTypePrefix, expenseCategories)
            || findCategoryIdByLabel(rawCat, expenseCategories)
          : findCategoryIdByLabel(withTypePrefix, expenseCategories)
            || findCategoryIdByLabel(rawCat, expenseCategories);
        setCategoryId(nextCatId);

        setFromAccountId(defaultAccountId ?? "");
        setToAccountId("");
      }
    }

    window.addEventListener("mmh:create-transaction:open", onOpenFromAi as EventListener);
    return () => window.removeEventListener("mmh:create-transaction:open", onOpenFromAi as EventListener);
  }, [accounts, defaultAccountId, expenseCategories, incomeCategories, lastRepayFromAccountId, lastRepayToAccountId, today, transferAccounts]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("quickEntry") !== "1") return;
    const key = url.searchParams.toString();
    if (quickEntryConsumedRef.current === key) return;
    quickEntryConsumedRef.current = key;
    window.dispatchEvent(
      new CustomEvent("mmh:create-transaction:open", {
        detail: {
          requestId: `url-${Date.now()}`,
          source: "launcher",
          item: { type: "expense" },
          defaultAccountId: defaultAccountId ?? "",
        },
      }),
    );
    url.searchParams.delete("quickEntry");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, [defaultAccountId]);

  useEffect(() => {
    function onOpenEdit(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId: string;
        entryId: string;
        type: TxType;
        date: string;
        postedAt?: string | null;
        amount: number;
        note: string;
        toNote?: string;
        accountId?: string;
        accountLabel?: string;
        categoryId?: string;
        counterpartyInstitutionId?: string;
        accountName?: string;
        fromAccountName?: string;
        fromAccountId?: string;
        toAccountId?: string;
        toAccountName?: string;
        fundSubtype?: string;
        hasFundDetail?: boolean;
        cashAccountId?: string;
        fundCode?: string;
        fundName?: string;
        fundUnits?: number;
        fundNav?: number;
        fundFee?: number;
        fundProductType?: string;
        tagIds?: string[];
        tags?: EditTagOption[];
        categoryName?: string;
        fixedAssetAccountId?: string;
        fixedAssetAssetId?: string;
        fixedAssetLinked?: boolean;
      }>).detail;
      if (!detail?.requestId || !detail.entryId) return;
      setRequestId(detail.requestId);
      setEditEntryId(detail.entryId);
      setEditEntryOriginalType(detail.type);
      setEditEntryHasFundDetail(detail.hasFundDetail ?? false);
      editOriginalRef.current = {
        type: detail.type,
        amountStored: Number(detail.amount),
        date: detail.date || today,
        accountId: detail.accountId ?? undefined,
        fromAccountId: detail.fromAccountId ?? undefined,
        toAccountId: detail.toAccountId ?? undefined,
      };
      setCreateInstallment(false);
      setFixedAssetLinked(detail.fixedAssetLinked === true || Boolean(detail.fixedAssetAccountId));
      setFixedAssetAccountId(detail.fixedAssetAccountId?.trim() ?? "");
      setFixedAssetAssetId(detail.fixedAssetAssetId?.trim() ?? "");
      setFixedAssetLinkLocked(false);
      setFixedAssetAccountNestedOpen(false);
      setFixedAssetAccountAutoOpen(false);
      setOpen(true);
      setTxType(detail.type);
      setDate(detail.date || today);
      setPostedAt(toDateInputValue(detail.postedAt || detail.date || today));
      setPostedAtEdited(Boolean(detail.postedAt));
      const numericAmount = Number(detail.amount);
      const dialogAmount = Number.isFinite(numericAmount) ? storedAmountToDialogAmount(detail.type, numericAmount) : 0;
      setAmount(
        dialogAmount !== 0
          ? String(dialogAmount)
          : "",
      );
      setNote(detail.note ?? "");
      setCounterpartyInstitutionId(detail.counterpartyInstitutionId ?? "");
      setEditCategoryFallback(detail.categoryId && detail.categoryName
        ? { id: detail.categoryId, label: detail.categoryName, parentId: null, type: detail.type === "income" ? "income" : "expense" }
        : null);
      const detailTags = normalizeEditTagOptions(detail.tags);
      const nextTagIds = detail.tagIds?.length ? detail.tagIds : detailTags.map((tag) => tag.id);
      setTagList((prev) => {
        const knownIds = new Set([...prev.map((tag) => tag.id), ...detailTags.map((tag) => tag.id)]);
        const missingSelectedTags = nextTagIds
          .filter((id) => !knownIds.has(id))
          .map((id) => ({ id, name: t("txForm.unknownTag"), color: null }));
        return mergeTagOptions(prev, [...detailTags, ...missingSelectedTags]);
      });
      setSelectedTagIds(nextTagIds);
      if (detail.type === "transfer") {
        const nextToAccountId = detail.toAccountId ?? "";
        const nextFromAccountId = detail.fromAccountId && detail.fromAccountId !== nextToAccountId
          ? detail.fromAccountId
          : detail.accountId ?? "";
        const fallbackTransferOption = (id: string, label?: string): AccountOption | null => {
          if (!id) return null;
          const existing = transferAccountList.find((opt) => opt.id === id)
            ?? (transferAccountSSOptions ?? []).find((opt) => opt.id === id && !opt.isHeader && !opt.isGroup) as AccountOption | undefined;
          if (existing) return existing;
          const text = (label ?? "").trim();
          return text ? { id, label: text } : null;
        };
        const transferExtras = [
          fallbackTransferOption(nextFromAccountId, detail.fromAccountName ?? detail.accountName),
          fallbackTransferOption(nextToAccountId, detail.toAccountName),
        ].filter((option): option is AccountOption => !!option);
        setLocalTransferAccountSSOpts((prev) => {
          return mergeSmartSelectOptions(prev ?? transferAccountSSOptions, transferExtras);
        });
        setTransferAccountList((prev) => mergeSmartSelectOptions(prev, transferExtras));
        setAccountId("");
        setCategoryId("");
        setFromAccountId(nextFromAccountId);
        setToAccountId(nextToAccountId);
        setEditOriginalTransferAccounts({ fromAccountId: nextFromAccountId, toAccountId: nextToAccountId });
        setFromAccountIdEdited(true);
      } else {
        const nextAccountId = detail.accountId ?? (defaultAccountId ?? "");
        setLocalAccountSSOpts((prev) => {
          const extra = accountList.find((opt) => opt.id === nextAccountId);
          if (extra) {
            return mergeSmartSelectOptions(prev ?? accountSSOptions, [extra]);
          }
          if (nextAccountId && detail.accountLabel) {
            return mergeSmartSelectOptions(prev ?? accountSSOptions, [{ id: nextAccountId, label: detail.accountLabel }]);
          }
          return prev ?? accountSSOptions;
        });
        setAccountId(nextAccountId);
        setCategoryId(detail.categoryId ?? "");
        setFromAccountId("");
        setToAccountId(detail.toAccountId ?? "");
        setEditOriginalTransferAccounts(null);
        setFromAccountIdEdited(false);
      }
    }

    window.addEventListener("mmh:transaction:edit", onOpenEdit as EventListener);
    return () => window.removeEventListener("mmh:transaction:edit", onOpenEdit as EventListener);
  }, [
    accountList,
    accountSSOptions,
    defaultAccountId,
    today,
    transferAccountList,
    transferAccountSSOptions,
    t,
  ]);

  useEffect(() => {
    if (!open || (txType !== "expense" && txType !== "income") || postedAtEdited) return;
    setPostedAt(toDateInputValue(date || today));
  }, [date, open, postedAtEdited, today, txType]);

  useEffect(() => {
    if (!open || txType !== "fx" || !editEntryId) return;
    let cancelled = false;
    fetch(`/api/v1/fx-conversions?entryId=${encodeURIComponent(editEntryId)}`)
      .then((response) => response.json())
      .then((data) => {
        if (cancelled || !data?.ok || !data.conversion) return;
        const conversion = data.conversion as {
          date?: string;
          fromAccountId?: string;
          toAccountId?: string;
          fromCurrency?: string;
          toCurrency?: string;
          fromAmount?: number;
          toAmount?: number;
          exchangeRate?: number;
          feeAmount?: number | null;
          note?: string | null;
        };
        setDate(conversion.date || today);
        setFromAccountId(conversion.fromAccountId ?? "");
        setToAccountId(conversion.toAccountId ?? "");
        setFxFromCurrencyDraft(normalizeCurrencyLabel(conversion.fromCurrency));
        setFxToCurrencyDraft(normalizeCurrencyLabel(conversion.toCurrency));
        setAmount(formatFxAmount(Number(conversion.fromAmount ?? 0)));
        setFxToAmount(formatFxAmount(Number(conversion.toAmount ?? 0)));
        setFxRate(formatFxRate(Number(conversion.exchangeRate ?? 0)));
        setFxFeeAmount(conversion.feeAmount == null ? "" : formatFxAmount(Number(conversion.feeAmount)));
        setNote(conversion.note ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [editEntryId, open, today, txType]);

  useEffect(() => {
    if (!open || txType === "fx" || txType === "investment") return;
    focusAmountInput();
  }, [open, txType]);

  useEffect(() => {
    if (!open || !isCreditCardAccount || txType !== "transfer") return;
    if (fromAccountIdEdited || !toAccountId) return;
    if (accountMetaById.get(toAccountId)?.kind !== "bank_credit") return;
    fetch(`/api/v1/fund/last-repay-account?accountId=${encodeURIComponent(toAccountId)}`)
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.repayAccountId) setFromAccountId(d.repayAccountId);
      })
      .catch(() => {});
  }, [accountMetaById, open, isCreditCardAccount, txType, toAccountId, fromAccountIdEdited]);

  function currentFinanceRefreshDetail() {
    const accountIds = txType === "transfer" || txType === "fx"
      ? compactIds([fromAccountId, toAccountId])
      : txType === "investment"
        ? compactIds([accountId, fromAccountId, toAccountId, defaultAccountId])
        : compactIds([accountId, toAccountId, defaultAccountId, fixedAssetLinked ? fixedAssetAccountId : ""]);

    // A save only skips the heavy refresh when editing an existing record and
    // every balance-affecting field (type, amount, date, accounts) is unchanged.
    const original = editOriginalRef.current;
    const currentStoredAmount = dialogAmountToStoredAmount(txType, amount);
    const balanceChanged = !editEntryId || !original
      ? true
      : !(
          original.type === txType &&
          Math.abs(original.amountStored - currentStoredAmount) < 0.005 &&
          original.date === date &&
          (txType === "transfer" || txType === "fx"
            ? original.fromAccountId === fromAccountId && original.toAccountId === toAccountId
            : original.accountId === accountId && original.toAccountId === toAccountId)
        );

    return {
      reason: "transaction-save",
      accountIds: accountIds.length > 0 ? accountIds : undefined,
      entryIds: editEntryId ? [editEntryId] : undefined,
      balanceChanged,
    };
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    void submitForm(e.currentTarget, "close");
  }

  async function submitForm(form: HTMLFormElement, submitMode: SubmitMode) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await saveTransaction(form, submitMode);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  // Form fields + submit mode -> persisted transaction -> close or next draft.
  // Capture the mode before awaiting so another event cannot change this save.
  async function saveTransaction(form: HTMLFormElement, submitMode: SubmitMode) {
    if (openSpecialTransferTargetIfNeeded()) return;

    if (editEntryId && editEntryOriginalType === "investment" && txType !== "investment" && editEntryHasFundDetail) {
      const confirmed = await showConfirmDialog({
        title: t("txForm.fundDetailTitle"),
        message: t("txForm.fundDetailMessage"),
      });
      if (!confirmed) {
        const formData = new FormData(form);
        formData.set("type", txType);
        formData.set("date", date);
        if (txType === "expense" || txType === "income") formData.set("postedAt", postedAt);
        formData.set("amount", String(dialogAmountToStoredAmount(txType, amount)));
        formData.set("note", note);
        formData.set("toNote", txType === "transfer" ? note : "");
        formData.set("entryId", editEntryId);
        formData.set("keepFundDetail", "true");
        try {
          const res = await (editAction ?? action)(formData);
          if (!res.ok) {
            window.alert(res.error);
            return;
          }
          requestAnimationFrame(() => {
            dispatchFinanceDataChanged(currentFinanceRefreshDetail());
          });
          resetDraft();
        } catch (err) {
          window.alert(String(err));
        }
        return;
      }
    }

    const shouldLinkFixedAsset = txType === "expense" && (fixedAssetLinked || Boolean(fixedAssetAccountId));
    if (shouldLinkFixedAsset && !fixedAssetAccountId) {
      window.alert(t("txForm.alert.selectFixedAssetAccount"));
      return;
    }

    // Required account validation: transfers need both a source and a
    // destination account; income/expense/advance need a posting account.
    if (txType === "transfer") {
      if (!fromAccountId) {
        window.alert(t("txForm.alert.selectTransferFromAccount"));
        return;
      }
      if (!toAccountId) {
        window.alert(t("txForm.alert.selectTransferToAccount"));
        return;
      }
    } else if ((txType === "income" || txType === "expense" || txType === "advance") && !accountId) {
      window.alert(t("txForm.alert.selectAccount"));
      return;
    }

    if (txType === "fx") {
      const fromValue = parseMoneyDraft(amount);
      const toValue = parseMoneyDraft(fxToAmount);
      const feeValue = String(fxFeeAmount ?? "").trim() ? parseMoneyDraft(fxFeeAmount) : null;
      if (!fromAccountId) {
        window.alert(t("txForm.alert.selectFromAccount"));
        return;
      }
      if (accountMetaById.get(fromAccountId)?.kind !== "bank_debit") {
        window.alert(t("txForm.alert.fromAccountDebitOnly"));
        return;
      }
      if (toAccountId && fromAccountId === toAccountId) {
        window.alert(t("txForm.alert.accountsSame"));
        return;
      }
      if (toAccountId && !isForeignCurrency(accountMetaById.get(toAccountId)?.currency)) {
        window.alert(t("txForm.alert.toAccountForeignOnly"));
        return;
      }
      if (!toAccountId && !isForeignCurrency(fxToCurrencyDraft)) {
        window.alert(t("txForm.alert.toCurrencyForeignOnly"));
        return;
      }
      if (fxFromCurrency === fxToCurrency) {
        window.alert(t("txForm.alert.sameCurrencyUseTransfer"));
        return;
      }
      if (fromValue <= 0 || toValue <= 0) {
        window.alert(t("txForm.alert.amountsPositive"));
        return;
      }
      if (feeValue != null && feeValue <= 0) {
        window.alert(t("txForm.alert.feePositiveOrEmpty"));
        return;
      }
      try {
        const res = await fetch("/api/v1/fx-conversions", {
          method: editEntryId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entryId: editEntryId,
            date,
            fromAccountId,
            toAccountId,
            toCurrency: fxToCurrencyDraft,
            fromAmount: fromValue,
            toAmount: toValue,
            exchangeRate: fxComputedRate,
            feeAmount: feeValue,
            note,
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.ok) {
          window.alert(data?.error ?? t("txForm.alert.fxSaveFailed"));
          return;
        }
        const fxEntryId = editEntryId || data?.entries?.fromEntry?.id || data?.conversion?.fromEntryId || null;
        if (fxEntryId && pendingAttachmentFiles.length > 0) {
          try {
            await uploadEntryAttachmentFiles(fxEntryId, pendingAttachmentFiles);
            setPendingAttachmentFiles([]);
          } catch (attachmentError) {
            window.alert(t("attachments.saveAfterCreateFailed", {
              reason: attachmentError instanceof Error ? attachmentError.message : t("attachments.uploadFailed"),
            }));
          }
        }
        if (requestId) {
          window.dispatchEvent(new CustomEvent(editEntryId ? "mmh:transaction:edit:success" : "mmh:create-transaction:success", { detail: { requestId } }));
        }
        void notifySettingsDataChanged({ scope: "accounts", reason: "fx:auto-account", prefetch: true });
        requestAnimationFrame(() => {
          dispatchFinanceDataChanged(currentFinanceRefreshDetail());
        });
        if (submitMode === "repeat" && !editEntryId) {
          repeatDraft();
        } else {
          setOpen(false);
          resetDraft();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : t("txForm.alert.fxSaveFailed");
        window.alert(msg);
      }
      return;
    }

    let formData: FormData;
    if (txType === "investment") {
      formData = new FormData(form);
      formData.set("type", "investment");
      formData.set("date", date);
      formData.set("amount", amount);
      formData.set("note", note);
      formData.set("toNote", "");
      formData.set("counterpartyInstitutionId", counterpartyInstitutionId);
      if (editEntryId) formData.set("entryId", editEntryId);
    } else {
      formData = new FormData();
      formData.set("type", txType);
      formData.set("date", date);
      if (txType === "expense" || txType === "income") formData.set("postedAt", postedAt);
      formData.set("amount", String(dialogAmountToStoredAmount(txType, amount)));
      formData.set("note", note);
      formData.set("toNote", txType === "transfer" ? note : "");
      formData.set("counterpartyInstitutionId", counterpartyInstitutionId);
      if (editEntryId) formData.set("entryId", editEntryId);
      if (txType === "transfer") {
        formData.set("fromAccountId", fromAccountId);
        formData.set("toAccountId", toAccountId);
        } else if (txType === "income") {
          formData.set("accountId", accountId);
          formData.set("categoryId", categoryId);
          if (toAccountId) formData.set("toAccountId", toAccountId);
        } else if (txType === "advance") {
          formData.set("accountId", accountId);
          formData.set("categoryId", categoryId);
          formData.set("counterpartyInstitutionId", counterpartyInstitutionId);
        } else {
          formData.set("accountId", accountId);
          formData.set("categoryId", categoryId);
          if (shouldLinkFixedAsset) {
            formData.set("fixedAssetAccountId", fixedAssetAccountId);
            if (fixedAssetAssetId) formData.set("fixedAssetAssetId", fixedAssetAssetId);
          }
      }
      formData.set("tagIds", JSON.stringify(selectedTagIds));
      if (txType === "expense" && createInstallment && !editEntryId) {
        formData.set("createInstallment", "true");
        formData.set("installmentAmount", installmentAmount);
        formData.set("installmentTotal", installmentTotal);
        formData.set("installmentRateType", installmentRateType);
        formData.set("installmentRate", installmentRate);
      }
    }
    try {
      const res = editEntryId ? await (editAction ?? action)(formData) : await action(formData);
      if (!res.ok) {
        window.alert(res.error);
        return;
      }
      const attachmentEntryId = editEntryId || res.data?.id || res.data?.cashEntryId || null;
      if (attachmentEntryId && pendingAttachmentFiles.length > 0) {
        try {
          await uploadEntryAttachmentFiles(attachmentEntryId, pendingAttachmentFiles);
          setPendingAttachmentFiles([]);
        } catch (attachmentError) {
          window.alert(t("attachments.saveAfterCreateFailed", {
            reason: attachmentError instanceof Error ? attachmentError.message : t("attachments.uploadFailed"),
          }));
        }
      }
      if (requestId) {
        window.dispatchEvent(
          new CustomEvent(editEntryId ? "mmh:transaction:edit:success" : "mmh:create-transaction:success", { detail: { requestId } }),
        );
      }
      requestAnimationFrame(() => {
        dispatchFinanceDataChanged(currentFinanceRefreshDetail());
      });
      if (submitMode === "repeat" && !editEntryId) {
        repeatDraft();
      } else {
        setOpen(false);
        resetDraft();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("txForm.alert.saveFailed");
      window.alert(msg);
    }
  }

  return (
    <ModalLayerProvider value={modalZIndex}>
      {!hideTrigger ? (
        <UnifiedEntryLauncher
          defaultAction="transaction"
          actions={[
            { key: "transaction", label: t("txForm.record") },
            { key: "fx", label: t("txForm.fx") },
            { key: "investment", label: t("txForm.fundMetal"), disabled: !showInvestment },
            { key: "wealth", label: t("investment.product.wealth") },
            { key: "deposit-buy", label: t("txForm.depositIn") },
            { key: "insurance", label: t("account.kind.insurance") },
          ]}
          context={{
            defaultAccountId: defaultAccountId ?? "",
            defaultCashAccountId: defaultAccountId ?? "",
            defaultDepositAccountId: defaultAccountId ?? "",
            defaultInsuranceAccountId: defaultAccountId ?? "",
          }}
        />
      ) : null}

      {open ? createPortal(
        <div className="app-modal-backdrop" style={{ zIndex: modalZIndex }}>
          <div className="app-modal-panel mobile-transaction-modal max-w-xl">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">
                {txType === "fx" ? t("txForm.fx") : editEntryId ? t("txForm.editEntry") : t("txForm.addEntry")}
              </div>
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

            <form ref={formRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" onSubmit={onSubmit}>
              {txType !== "fx" && lockedType ? (
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    className="segment-button h-9 flex-1 segment-button-active"
                  >
                    {lockedType === "transfer" ? t("transaction.type.transfer") : lockedType === "income" ? t("transaction.type.income") : lockedType === "advance" ? t("txForm.advance") : t("transaction.type.expense")}
                  </button>
                </div>
              ) : txType !== "fx" ? (
              <div className="flex flex-wrap justify-center gap-2">
                {isCreditCardAccount ? (
                  <>
                    <button
                      type="button"
                      onClick={() => switchType("expense")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "expense"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      {t("transaction.type.expense")}
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("income")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "income"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      {t("transaction.type.income")}
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("advance")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "advance"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      {t("txForm.advance")}
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("transfer")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "transfer"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      {t("transaction.type.transfer")}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => switchType("expense")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "expense"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      {t("transaction.type.expense")}
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("income")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "income"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      {t("transaction.type.income")}
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("advance")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "advance"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      {t("txForm.advance")}
                    </button>
                    <button
                      type="button"
                      onClick={() => switchType("transfer")}
                      className={`segment-button h-9 flex-1 ${
                        txType === "transfer"
                          ? "segment-button-active"
                          : ""
                      }`}
                    >
                      {t("transaction.type.transfer")}
                    </button>
                  </>
                )}
              </div>
              ) : null}

              {txType === "investment" && (
                <div className="space-y-2 pt-1">
                  <div className="text-xs font-medium text-slate-500 mb-1">{t("txForm.chooseInvestmentType")}</div>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      resetDraft();
                      window.dispatchEvent(new CustomEvent("mmh:investment:create", {
                        detail: { requestId: `create-${Date.now()}`, defaultAccountId, defaultCashAccountId: accountId, defaultDate: date, defaultAmount: Number(amount) || undefined },
                      }));
                    }}
                    className="segment-button segment-button-active h-10 w-full"
                  >
                    {t("txForm.fund")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      resetDraft();
                      window.dispatchEvent(new CustomEvent("mmh:investment:create", {
                        detail: { requestId: `create-${Date.now()}`, defaultCashAccountId: accountId, defaultProductType: "metal" },
                      }));
                    }}
                    className="h-10 w-full rounded-[10px] border border-yellow-200 bg-yellow-50 text-sm text-yellow-700 transition-colors hover:bg-yellow-100"
                  >
                    {t("investment.product.metal")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      resetDraft();
                      window.dispatchEvent(new CustomEvent("mmh:wealth:create", {
                        detail: { requestId: `create-${Date.now()}`, defaultCashAccountId: accountId },
                      }));
                    }}
                    className="h-10 w-full rounded-[10px] border border-amber-200 bg-amber-50 text-sm text-amber-700 transition-colors hover:bg-amber-100"
                  >
                    {t("investment.product.wealth")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      resetDraft();
                      window.dispatchEvent(new CustomEvent("mmh:deposit:create", {
                        detail: { requestId: `create-${Date.now()}`, defaultCashAccountId: accountId },
                      }));
                    }}
                    className="h-10 w-full rounded-[10px] border border-emerald-200 bg-emerald-50 text-sm text-emerald-700 transition-colors hover:bg-emerald-100"
                  >
                    {t("txForm.deposit")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      resetDraft();
                      window.dispatchEvent(new CustomEvent("mmh:insurance:create", {
                        detail: { requestId: `create-${Date.now()}`, defaultCashAccountId: accountId },
                      }));
                    }}
                    className="h-10 w-full rounded-[10px] border border-sky-200 bg-sky-50 text-sm text-sky-700 transition-colors hover:bg-sky-100"
                  >
                    {t("account.kind.insurance")}
                  </button>
                </div>
              )}

              {(txType === "expense" || txType === "income" || txType === "advance") && (
                <div className="space-y-3">
                  {txType === "advance" ? (
                    <>
                      <div className="space-y-1">
                        <div className="form-label">{t("detail.column.date")}</div>
                        <DateStepper name="date" value={date} onChange={setDate} />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <div className="form-label">{t("txForm.counterparty")}</div>
                          <SmartSelect
                            mode="single"
                            value={counterpartyInstitutionId}
                            onChange={setCounterpartyInstitutionId}
                            options={((localNestedFieldData ?? nestedFieldData)?.counterpartyId ?? [])
                              .filter((item) => COUNTERPARTY_TYPES.has(item.type ?? "other"))
                              .map((item) => ({ id: item.id, label: item.name }))}
                            placeholder={t("txForm.selectPlaceholder")}
                            onCreateClick={() => setCounterpartyNestedOpen(true)}
                            createLabel={t("txForm.addCounterparty")}
                            searchable
                          />
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">{t("txForm.belongingAccount")}</div>
                          <div className={REQUIRED_FIELD_CLASS}>
                            <SmartSelect mode="single" value={accountId}
                              onChange={(id: string) => { setAccountId(id); recordRecentAccount(id); }}
                              options={displayAccountOptions} placeholder={t("txForm.selectPlaceholder")}
                              onCreateClick={() => { void openAccountCreate("account"); }}
                              onCycleOwnerFilter={cycleAccountTypeFilter}
                              ownerFilterLabel={accountTypeFilterLabel}
                              behavior={compactAccountSelectBehavior} />
                          </div>
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <div className="form-label">{t("detail.column.date")}</div>
                          <DateStepper name="date" value={date} onChange={setDate} />
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">
                            {isCreditCardAccount ? t("txForm.recordAccount") : (txType === "income" ? t("txForm.receiveAccount") : t("txForm.cashAccount"))}
                          </div>
                          <div className={REQUIRED_FIELD_CLASS}>
                            <SmartSelect mode="single" value={accountId}
                              onChange={(id: string) => { setAccountId(id); recordRecentAccount(id); }}
                              options={displayAccountOptions} placeholder={t("txForm.selectPlaceholder")}
                              onCreateClick={() => { void openAccountCreate("account"); }}
                              onCycleOwnerFilter={cycleAccountTypeFilter}
                              ownerFilterLabel={accountTypeFilterLabel}
                              behavior={compactAccountSelectBehavior} />
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <div className="form-label">{t("detail.column.postedAt")}</div>
                          <DateStepper
                            value={postedAt}
                            onChange={(value) => {
                              setPostedAt(toDateInputValue(value));
                              setPostedAtEdited(true);
                            }}
                            className="form-input"
                          />
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">{t("detail.column.counterparty")}</div>
                          <SmartSelect
                            mode="single"
                            value={counterpartyInstitutionId}
                            onChange={setCounterpartyInstitutionId}
                            options={incomeExpenseInstitutionOptions.map((item) => ({ id: item.id, label: item.name }))}
                            placeholder={t("stockFee.optional")}
                            createLabel={t("txForm.addCounterparty")}
                            searchable
                          />
                        </div>
                      </div>
                    </>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("detail.column.category")}</div>
                      <SmartSelect mode="single" value={categoryId} onChange={handleCategoryChange}
                        options={categorySSOptions} placeholder={t("txForm.uncategorized")}
                        onCreateClick={() => setCategoryNestedOpen(true)}
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
                    <div className="space-y-1">
                      <div className="form-label">{t("detail.column.tags")}</div>
                      <SmartSelect mode="multi" value={selectedTagIds}
                        onChange={(ids) => setSelectedTagIds(ids)}
                        options={tagList.map(t => ({ id: t.id, label: t.name, color: t.color }))} placeholder={t("txForm.selectTags")}
                        onInlineCreate={async (name, color) => {
                          const res = await fetch("/api/v1/tags", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ name, color }),
                          });
                          const data = await res.json();
                          if (!data.ok || !data.tag) throw new Error(data.error ?? t("txForm.createFailed"));
                          return { id: data.tag.id, label: data.tag.name, color: data.tag.color };
                        }}
                        onCreated={(tag) => {
                          setTagList(prev => [...prev, { id: tag.id, name: tag.label, color: tag.color }]);
                          setSelectedTagIds(prev => [...prev, tag.id]);
                        }}
                      />
                    </div>
                  </div>

                  <div className={txType === "expense" ? "grid grid-cols-[4.5rem_minmax(0,1fr)] items-end gap-3" : "space-y-1"}>
                    {txType === "expense" ? (
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.fixedAssetToggle")}</div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={fixedAssetLinked}
                          aria-disabled={fixedAssetLinkLocked}
                          aria-label={t("txForm.fixedAssetToggle")}
                          onClick={() => {
                            if (fixedAssetLinkLocked) return;
                            setFixedAssetLinked((current) => {
                              const next = !current;
                              if (next) {
                                setFixedAssetAccountAutoOpen(true);
                              } else {
                                setFixedAssetAccountId("");
                                setFixedAssetAccountAutoOpen(false);
                              }
                              return next;
                            });
                          }}
                          className={[
                            "flex h-9 w-12 items-center justify-center rounded-[10px] border px-2 text-xs font-medium transition",
                            fixedAssetLinkLocked ? "cursor-not-allowed opacity-80" : "",
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
                    ) : null}
                    <div className="min-w-0 space-y-1">
                      <div className="form-label">{t("txForm.amount")}</div>
                      <CalcInput ref={amountInputRef} value={amount} onChange={(value) => {
                        setAmount(value);
                        if (createInstallment && !installmentAmountEdited) {
                          const numeric = Math.abs(Number(value));
                          setInstallmentAmount(Number.isFinite(numeric) && numeric > 0 ? String(numeric) : "");
                        }
                      }} placeholder={txType === "expense" ? t("txForm.amountPlaceholderExpense") : t("txForm.amountPlaceholderIncome")} label={t("txForm.amount")} precision={2} />
                    </div>
                  </div>

                  {txType === "expense" && fixedAssetLinked ? (
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fixedAssetAccount")}</div>
                      <SmartSelect
                        mode="single"
                        value={fixedAssetAccountId}
                        onChange={(id: string) => {
                          setFixedAssetAccountId(id);
                          setFixedAssetAssetId("");
                          recordRecentAccount(id);
                        }}
                        options={displayFixedAssetAccountOptions}
                        placeholder={t("txForm.selectFixedAssetAccount")}
                        onCreateClick={() => setFixedAssetAccountNestedOpen(true)}
                        createLabel={t("txForm.createFixedAssetAccount")}
                        onCycleOwnerFilter={cycleAccountTypeFilter}
                        ownerFilterLabel={accountTypeFilterLabel}
                        behavior={fixedAssetAccountSelectBehavior}
                      />
                    </div>
                  ) : null}

                  {txType === "expense" && selectedAccountIsCreditCard && !editEntryId ? (
                    <div className="border-y border-slate-200 py-3 space-y-3">
                      <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                        <input
                          type="checkbox"
                          checked={createInstallment}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            setCreateInstallment(checked);
                            if (checked && !installmentAmountEdited) {
                              const numeric = Math.abs(Number(amount));
                              setInstallmentAmount(Number.isFinite(numeric) && numeric > 0 ? String(numeric) : "");
                            }
                          }}
                          className="h-4 w-4 accent-slate-800"
                        />
                        {t("txForm.installment")}
                      </label>
                      {createInstallment ? (
                        <>
                          <div className="grid grid-cols-3 gap-3">
                            <div className="space-y-1">
                              <div className="form-label">{t("txForm.installmentAmount")}</div>
                              <CalcInput value={installmentAmount} onChange={(value) => {
                                setInstallmentAmount(value);
                                setInstallmentAmountEdited(true);
                              }} placeholder={t("txForm.installmentAmountPlaceholder")} label={t("txForm.installmentAmount")} precision={2} />
                            </div>
                            <div className="space-y-1">
                              <div className="form-label">{t("txForm.periods")}</div>
                              <input
                                type="number"
                                min={2}
                                max={120}
                                step={1}
                                value={installmentTotal}
                                onChange={(event) => setInstallmentTotal(event.target.value)}
                                className="form-input"
                              />
                            </div>
                            <div className="space-y-1">
                              <div className="form-label">{installmentRateType === "annual_interest" ? t("txForm.annualRatePercent") : t("txForm.periodRatePercent")}</div>
                              <input
                                type="number"
                                min={0}
                                max={100}
                                step="0.0001"
                                value={installmentRate}
                                onChange={(event) => setInstallmentRate(event.target.value)}
                                className="form-input"
                              />
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-3">
                            <div className="inline-flex h-8 overflow-hidden rounded border border-slate-200 bg-white">
                              <button type="button" onClick={() => setInstallmentRateType("period_fee")}
                                className={`px-3 text-xs ${installmentRateType === "period_fee" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                                {t("txForm.periodFee")}
                              </button>
                              <button type="button" onClick={() => setInstallmentRateType("annual_interest")}
                                className={`border-l border-slate-200 px-3 text-xs ${installmentRateType === "annual_interest" ? "bg-slate-800 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                                {t("txForm.annualRate")}
                              </button>
                            </div>
                            {installmentPreview ? (
                              <div className="text-xs tabular-nums text-slate-500">
                                {t("txForm.installmentSummary", { first: installmentPreview.summary.firstPayment.toFixed(2), interest: installmentPreview.summary.totalInterest.toFixed(2), total: installmentPreview.summary.totalPayment.toFixed(2) })}
                              </div>
                            ) : null}
                          </div>
                          {installmentPreview ? (
                            <div className="max-h-48 overflow-auto rounded-md border border-slate-200">
                              <table className="min-w-full text-xs tabular-nums">
                                <thead className="sticky top-0 bg-slate-50 text-slate-500">
                                  <tr>
                                    <th className="px-2 py-1 text-left font-medium">{t("txForm.periods")}</th>
                                    <th className="px-2 py-1 text-left font-medium">{t("detail.column.date")}</th>
                                    <th className="px-2 py-1 text-right font-medium">{t("txForm.principal")}</th>
                                    <th className="px-2 py-1 text-right font-medium">{installmentRateType === "annual_interest" ? t("txForm.interest") : t("txForm.fee")}</th>
                                    <th className="px-2 py-1 text-right font-medium">{t("txForm.dueAmount")}</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {installmentPreview.rows.map((row) => (
                                    <tr key={row.installmentNo} className="border-t border-slate-100">
                                      <td className="px-2 py-1 text-slate-600">{row.installmentNo}/{installmentTotal}</td>
                                      <td className="px-2 py-1 text-slate-600">{row.date.toISOString().slice(0, 10)}</td>
                                      <td className="px-2 py-1 text-right text-slate-700">{row.principal.toFixed(2)}</td>
                                      <td className="px-2 py-1 text-right text-slate-700">{row.interest.toFixed(2)}</td>
                                      <td className="px-2 py-1 text-right font-medium text-slate-800">{row.payment.toFixed(2)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Row 5: note + attachment */}
                  <div className="space-y-1">
                    <div className="form-label">{t("detail.column.remark")}</div>
                    <div className="flex items-start gap-2">
                      <input
                        name="note"
                        placeholder={t("stockFee.optional")}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        className="form-input flex-1"
                      />
                      <EntryAttachmentButton
                        entryId={editEntryId}
                        pendingFiles={pendingAttachmentFiles}
                        onPendingFilesChange={setPendingAttachmentFiles}
                      />
                    </div>
                  </div>
                </div>
              )}

              {txType === "fx" && (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <div className="form-label">{t("detail.column.date")}</div>
                    <DateStepper name="date" value={date} onChange={setDate} />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fxFromAccount")}</div>
                      <SmartSelect mode="single" value={fromAccountId} onChange={(v) => {
                        setFromAccountId(v);
                        const currency = normalizeCurrencyLabel(accountMetaById.get(v)?.currency);
                        if (currency) setFxFromCurrencyDraft(currency);
                        if (v && v === toAccountId) setToAccountId("");
                        recordRecentAccount(v);
                      }}
                        options={fxFromAccountOptions} placeholder={t("txForm.fxFromAccountPlaceholder")}
                        onCreateClick={() => { void openAccountCreate("from"); }} createLabel={t("txForm.addDebitAccount")}
                        onCycleOwnerFilter={cycleAccountTypeFilter} ownerFilterLabel={accountTypeFilterLabel}
                        behavior={compactAccountSelectBehavior} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fxToAccount")}</div>
                      <SmartSelect mode="single" value={toAccountId} onChange={(v) => {
                        setToAccountId(v);
                        const currency = normalizeCurrencyLabel(accountMetaById.get(v)?.currency);
                        if (currency) setFxToCurrencyDraft(currency);
                        recordRecentAccount(v);
                      }}
                        options={fxToAccountOptions}
                        placeholder={t("txForm.fxToAccountPlaceholder", { currency: fxToCurrencyDraft })}
                        onCreateClick={() => { void openAccountCreate("to"); }} createLabel={t("settings.accounts.add")}
                        onCycleOwnerFilter={cycleAccountTypeFilter} ownerFilterLabel={accountTypeFilterLabel}
                        behavior={compactAccountSelectBehavior} />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fxFromCurrency")}</div>
                      <div className="form-input flex h-9 items-center bg-slate-50 text-slate-700">
                        {fromAccountId ? fxFromCurrency : t("txForm.fxCurrencyAuto")}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fxToCurrency")}</div>
                      {toAccountId ? (
                        <div className="form-input flex h-9 items-center bg-slate-50 text-slate-700">
                          {fxToCurrency}
                        </div>
                      ) : (
                        <CurrencySmartSelect
                          value={fxToCurrencyDraft}
                          onChange={setFxToCurrencyDraft}
                          onSubmitted={setFxToCurrencyDraft}
                          excludeCodes={[BASE_CASH_CURRENCY]}
                          labelSystem={(code) => t(`entityForm.currency.${code.toLowerCase()}`, { defaultValue: code })}
                          placeholder={t("txForm.fxToCurrency")}
                          density="compact"
                        />
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fxFromAmountLabel", { currency: fxFromCurrency })}</div>
                      <CalcInput value={amount} onChange={updateFxFromAmount} placeholder={t("txForm.exampleAmount")} label={t("txForm.fxFromAmount")} precision={2} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fxRateLabel")}</div>
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <CalcInput value={fxRate} onChange={updateFxRate} placeholder={t("txForm.fxRatePlaceholder", { from: fxFromCurrency, to: fxToCurrency })} label={t("txForm.fxRate")} precision={8} />
                        </div>
                        <button
                          type="button"
                          onClick={() => void fetchFxRateForForm()}
                          disabled={fetchingFxRate || fxFromCurrency === fxToCurrency}
                          className="secondary-button h-9 shrink-0 gap-1 px-2 text-[11px] disabled:opacity-50"
                          title={t("txForm.fxFetchTitle")}
                        >
                          <RefreshCw className={`h-3 w-3 ${fetchingFxRate ? "animate-spin" : ""}`} />
                          {fetchingFxRate ? t("txForm.fxFetching") : t("txForm.fxFetch")}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fee")}</div>
                      <CalcInput value={fxFeeAmount} onChange={setFxFeeAmount} placeholder={t("txForm.fxFeePlaceholder")} label={t("txForm.fee")} precision={2} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("txForm.fxToAmountLabel", { currency: fxToCurrency })}</div>
                      <CalcInput value={fxToAmount} onChange={updateFxToAmount} placeholder={t("txForm.exampleAmount")} label={t("txForm.fxToAmount")} precision={2} />
                    </div>
                  </div>

                  <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                    {fxCommonQuoteText || t("txForm.fxQuoteHint")}
                  </div>

                  <div className="space-y-1">
                    <div className="form-label">{t("detail.column.remark")}</div>
                    <div className="flex items-start gap-2">
                      <input
                        name="note"
                        placeholder={t("txForm.fxNotePlaceholder")}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        className="form-input flex-1"
                      />
                      <EntryAttachmentButton
                        entryId={editEntryId}
                        pendingFiles={pendingAttachmentFiles}
                        onPendingFilesChange={setPendingAttachmentFiles}
                      />
                    </div>
                  </div>
                </div>
              )}

              {txType === "transfer" && (
                <div className="space-y-3">
                  {/* Row 1: date | income/expense institution */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="form-label">{t("detail.column.date")}</div>
                      <DateStepper name="date" value={date} onChange={setDate} />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("detail.column.counterparty")}</div>
                      <SmartSelect
                        mode="single"
                        value={counterpartyInstitutionId}
                        onChange={setCounterpartyInstitutionId}
                        options={incomeExpenseInstitutionOptions.map((item) => ({ id: item.id, label: item.name }))}
                        placeholder={t("stockFee.optional")}
                        onCreateClick={() => setInstitutionNestedOpen(true)}
                        createLabel={t("txForm.addInstitution")}
                        searchable
                      />
                    </div>
                  </div>

                  {/* Row 2: from account | swap | to account */}
                  {stockTransferMode ? (
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.transferFrom")}</div>
                        <div className={REQUIRED_FIELD_CLASS}>
                          <SmartSelect mode="single" value={fromAccountId} onChange={v => { setFromAccountId(v); setFromAccountIdEdited(true); recordRecentAccount(v); }}
                            options={displayTransferOptions} placeholder={t("txForm.selectPlaceholder")}
                            onCreateClick={() => { void openAccountCreate("from"); }} createLabel={t("settings.accounts.add")}
                            onCycleOwnerFilter={cycleAccountTypeFilter} ownerFilterLabel={accountTypeFilterLabel}
                            behavior={compactAccountSelectBehavior} />
                        </div>
                      </div>
                      <div className="flex flex-col items-center pb-0.5">
                        <div className="h-6 flex items-center justify-center text-emerald-600 mb-1"><ArrowRight className="w-4 h-4" /></div>
                        <button type="button" className="secondary-button h-9 w-9 px-0 text-slate-700"
                          onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title={t("txForm.swapAccounts")}><ArrowLeftRight className="w-4 h-4" /></button>
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.transferTo")}</div>
                        <div className={REQUIRED_FIELD_CLASS}>
                          <SmartSelect mode="single" value={toAccountId} onChange={(v) => { setToAccountId(v); recordRecentAccount(v); }}
                            options={stockTransferToOptions} placeholder={t("txForm.selectPlaceholder")}
                            onCycleOwnerFilter={cycleAccountTypeFilter} ownerFilterLabel={accountTypeFilterLabel}
                            behavior={compactAccountSelectBehavior} />
                        </div>
                      </div>
                    </div>
                  ) : isCreditCardAccount ? (
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.transferFrom")}</div>
                        <div className={REQUIRED_FIELD_CLASS}>
                          <SmartSelect mode="single" value={fromAccountId} onChange={v => { setFromAccountId(v); setFromAccountIdEdited(true); recordRecentAccount(v); }}
                            options={displayTransferOptions} placeholder={t("txForm.selectPlaceholder")}
                            onCreateClick={() => { void openAccountCreate("from"); }} createLabel={t("settings.accounts.add")}
                            onCycleOwnerFilter={cycleAccountTypeFilter} ownerFilterLabel={accountTypeFilterLabel}
                            behavior={compactAccountSelectBehavior} />
                        </div>
                      </div>
                      <div className="flex flex-col items-center pb-0.5">
                        <div className="h-6 flex items-center justify-center text-emerald-600 mb-1"><ArrowRight className="w-4 h-4" /></div>
                        <button type="button" className="secondary-button h-9 w-9 px-0 text-slate-700"
                          onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title={t("txForm.swapAccounts")}><ArrowLeftRight className="w-4 h-4" /></button>
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.transferTo")}</div>
                        <div className={REQUIRED_FIELD_CLASS}>
                          <SmartSelect mode="single" value={toAccountId} onChange={(v) => { setToAccountId(v); recordRecentAccount(v); }}
                            options={displayTransferOptions} placeholder={t("txForm.selectPlaceholder")}
                            onCreateClick={() => { void openAccountCreate("to"); }} createLabel={t("settings.accounts.add")}
                            onCycleOwnerFilter={cycleAccountTypeFilter} ownerFilterLabel={accountTypeFilterLabel}
                            behavior={compactAccountSelectBehavior} />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-end">
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.transferFrom")}</div>
                        <div className={REQUIRED_FIELD_CLASS}>
                          <SmartSelect mode="single" value={fromAccountId} onChange={(v) => { setFromAccountId(v); recordRecentAccount(v); }}
                            options={displayTransferOptions} placeholder={t("txForm.selectPlaceholder")}
                            onCreateClick={() => { void openAccountCreate("from"); }} createLabel={t("settings.accounts.add")}
                            onCycleOwnerFilter={cycleAccountTypeFilter} ownerFilterLabel={accountTypeFilterLabel}
                            behavior={compactAccountSelectBehavior} />
                        </div>
                      </div>
                      <div className="flex items-center justify-center pb-0.5">
                        <button type="button" className="secondary-button h-9 w-9 px-0 text-slate-700"
                          onClick={swapTransferAccounts} disabled={!fromAccountId && !toAccountId} title={t("txForm.swapAccountsTitle")}><ArrowLeftRight className="w-4 h-4" /></button>
                      </div>
                      <div className="space-y-1">
                        <div className="form-label">{t("txForm.transferTo")}</div>
                        <div className={REQUIRED_FIELD_CLASS}>
                          <SmartSelect mode="single" value={toAccountId} onChange={(v) => { setToAccountId(v); recordRecentAccount(v); }}
                            options={displayTransferOptions} placeholder={t("txForm.selectPlaceholder")}
                            onCreateClick={() => { void openAccountCreate("to"); }} createLabel={t("settings.accounts.add")}
                            onCycleOwnerFilter={cycleAccountTypeFilter} ownerFilterLabel={accountTypeFilterLabel}
                            behavior={compactAccountSelectBehavior} />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Row 3: amount */}
                  <div className="space-y-1">
                    <div className="form-label">{t("txForm.amount")}</div>
                    <CalcInput ref={amountInputRef} value={amount} onChange={setAmount} placeholder={t("txForm.amountExample")} label={t("txForm.amount")} precision={2} />
                  </div>

                  {/* Row 4: note + attachment */}
                  <div className="space-y-1">
                    <div className="form-label">{t("detail.column.remark")}</div>
                    <div className="flex items-start gap-2">
                      <input
                        name="note"
                        placeholder={t("stockFee.optional")}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        className="form-input flex-1"
                      />
                      <EntryAttachmentButton
                        entryId={editEntryId}
                        pendingFiles={pendingAttachmentFiles}
                        onPendingFilesChange={setPendingAttachmentFiles}
                      />
                    </div>
                  </div>
                </div>
              )}

              <input type="hidden" name="type" value={txType} />

              <div className="flex items-center justify-end gap-2 pt-1">
                {isFromButton && !editEntryId ? (
                  <button
                    type="button"
                    className="secondary-button h-9 px-3 border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                    onClick={() => {
                      const form = formRef.current;
                      if (form?.reportValidity()) void submitForm(form, "repeat");
                    }}
                    disabled={submitting}
                  >
                    {t("txForm.saveAndRepeat")}
                  </button>
                ) : null}
                <button
                  type="submit"
                  className="primary-button h-9 px-3"
                  disabled={submitting}
                >
                  {submitting ? t("txForm.saving") : editEntryId ? t("txForm.saveChanges") : t("common.save")}
                </button>
              </div>
            </form>
          </div>
        </div>
      , document.body) : null}
    {open && categoryNestedOpen && createPortal(
      <NestedAddModal
        mode="compact"
        key={currentCategoryType}
        entityType="category"
        open={categoryNestedOpen}
        onClose={() => setCategoryNestedOpen(false)}
        defaultType={currentCategoryType}
        hiddenFields={["type"]}
        parentCategories={categoryParentOptions}
        existingNames={categoryList.map((category) => getCategoryLeafName(category.label))}
        onCreated={(id, name, extra) => {
          const parentId = extra?.parentId;
          const type = extra?.type ?? currentCategoryType;
          if (parentId) {
            const parent = categoryList.find(c => c.id === parentId);
            const fullLabel = parent ? `${parent.label}.${name}` : name;
            setCategoryList(prev => [...prev, { id, label: fullLabel, parentId, type }]);
          } else {
            // Should not happen — parentId is always required in this context
            const typePrefix = currentCategoryType === "expense" ? "支出" : currentCategoryType === "income" ? "收入" : currentCategoryType;
            setCategoryList(prev => [...prev, { id, label: `${typePrefix}.${name}`, parentId: null, type }]);
          }
          setCategoryId(id);
        }}
      />,
      document.body,
    )}
    {open && accountNestedOpen && createPortal(
      <NestedAddModal
        mode="compact"
        entityType="account"
        open={accountNestedOpen}
        onClose={() => setAccountNestedOpen(false)}
        onCreated={(id, name, extra) => {
          const kind = extra?.kind || "bank_debit";
          const institutionLabel = extra?.institutionShortName?.trim() || extra?.institutionName;
          const groupId = extra?.groupId?.trim();
          const groupName = extra?.groupName?.trim();
          const label = institutionLabel ? `${institutionLabel}·${name}` : name;
          const subLabel = kindLabel(kind);
          const option = { id, label, subLabel, kind, currency: extra?.currency };
          setAccountList(prev => [...prev, option]);
          setTransferAccountList(prev => [...prev, option]);
          setLocalAccountSSOpts(prev => appendAccountOptionWithGroup(prev, option, groupId, groupName));
          setLocalTransferAccountSSOpts(prev => appendAccountOptionWithGroup(prev, option, groupId, groupName));
          if (accountCreateTarget === "from") setFromAccountId(id);
          else if (accountCreateTarget === "to") setToAccountId(id);
          else setAccountId(id);
          setAccountNestedOpen(false);
          setAccountCreateTarget("account");
        }}
        nestedFieldData={localNestedFieldData ?? nestedFieldData}
      />,
      document.body,
    )}
    {open && fixedAssetAccountNestedOpen && createPortal(
      <NestedAddModal
        mode="compact"
        entityType="account"
        open={fixedAssetAccountNestedOpen}
        onClose={() => setFixedAssetAccountNestedOpen(false)}
        title={t("txForm.createFixedAssetAccount")}
        nameLabel={t("txForm.fixedAssetAccountName")}
        namePlaceholder={t("txForm.fixedAssetAccountPlaceholder")}
        defaultType="investment"
        extraFields={{ kind: "investment", investProductType: "property" }}
        hiddenFields={["kind", "investProductType", "institutionId", "fundUnitsDecimals", "tradingCalendar", "costBasisMethod"]}
        onCreated={(id, name, extra) => {
          const kind = "investment";
          const groupId = extra?.groupId?.trim();
          const groupName = extra?.groupName?.trim();
          const option = {
            id,
            label: name,
            subLabel: t("txForm.fixedAssetAccount"),
            kind,
            investProductType: "property",
            currency: extra?.currency,
          };
          setFixedAssetAccountList((prev) => [...prev, option]);
          setLocalFixedAssetAccountSSOpts((prev) => appendAccountOptionWithGroup(prev, option, groupId, groupName));
          setFixedAssetLinked(true);
          setFixedAssetAccountId(id);
          setFixedAssetAccountNestedOpen(false);
          setFixedAssetAccountAutoOpen(false);
        }}
        nestedFieldData={localNestedFieldData ?? nestedFieldData}
      />,
      document.body,
    )}
    {open && counterpartyNestedOpen && createPortal(
      <EntityCreateForm
        mode="full"
        layout="modal"
        entityType="counterparty"
        open={counterpartyNestedOpen}
        onClose={() => setCounterpartyNestedOpen(false)}
        defaultType="person"
        existingNames={(localNestedFieldData?.counterpartyId ?? nestedFieldData?.counterpartyId ?? []).map((item) => item.name)}
        onCreated={(id, name, extra) => {
          const next = { id, name, type: extra?.type ?? "person" };
          setLocalNestedFieldData((prev) => ({
            ...(prev ?? nestedFieldData ?? {}),
            counterpartyId: [...((prev ?? nestedFieldData)?.counterpartyId ?? []), next],
          }));
          setCounterpartyInstitutionId(id);
          setCounterpartyNestedOpen(false);
        }}
      />,
      document.body,
    )}
    {open && institutionNestedOpen && createPortal(
      <NestedAddModal
        mode="compact"
        entityType="institution"
        open={institutionNestedOpen}
        onClose={() => setInstitutionNestedOpen(false)}
        defaultType="payment"
        title={t("txForm.addInstitution")}
        nameLabel={t("txForm.institutionName")}
        namePlaceholder={t("txForm.institutionNamePlaceholder")}
        allowedInstitutionTypes={["bank", "payment"]}
        existingNames={incomeExpenseInstitutionOptions.map((item) => item.name)}
        onCreated={(id, name, extra) => {
          const next = { id, name, type: extra?.type ?? "payment" };
          setLocalNestedFieldData((prev) => {
            const base = prev ?? nestedFieldData ?? {};
            return {
              ...base,
              institutionId: [...(base.institutionId ?? []), next],
              counterpartyId: base.counterpartyId ?? [],
            };
          });
          setCounterpartyInstitutionId(id);
          setInstitutionNestedOpen(false);
        }}
      />,
      document.body,
    )}
    </ModalLayerProvider>
  );
}
