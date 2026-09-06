"use client";

import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig, type BatchReplaceOption } from "@/components/BatchReplacePopoverButton";
import { evaluateCalcInputExpression } from "@/components/CalcInput";
import { DateStepper } from "@/components/DateStepper";
import { SmartSelect, type SmartSelectOption } from "@/components/SmartSelect";
import { CATEGORY_SMART_SELECT_BEHAVIOR, buildCategorySmartSelectOptions } from "@/components/categorySmartSelect";
import { useAccountSSFilter } from "@/components/accountSSFilter";
import {
  buildAccountDisplayOption,
  buildGroupedAccountOptions,
  formatAccountTableLabel,
  formatAccountTableTitle,
  type AccountDisplayOption,
} from "@/lib/account-display";
import {
  createImportAccountMatcher,
  encodeImportAccountId,
  normalizeImportAccountMatchKey,
  parseDebtAccountName,
  parseImportAccountId,
  parseImportOwnedMoneyAccountCandidate,
} from "@/lib/account-import-match";
import {
  getColorSchemeFromCookie,
  importPreviewFlowAmountColorFor,
  importPreviewFlowAmountTextFor,
} from "@/lib/client/colors";
import {
  fetchSettingsBootstrap,
  type SettingsAccountGroup,
  type SettingsCategory,
  type SettingsCounterparty,
} from "@/lib/client/settingsCache";
import { statementPreviewCategorySyncKey } from "@/lib/statement/preview-category-sync";
import { uniqueStatementInfoTexts } from "@/lib/statement/preview-meta";
import { systemCategoryLabel } from "@/lib/system-category-labels";
import { useI18n } from "@/lib/i18n";
import { getAccountLabelFieldsPreference } from "@/lib/client/appPreferences";

type BookAccount = {
  id: string;
  name: string;
  kind: string;
  numberMasked?: string | null;
  groupId?: string | null;
  investProductType?: string | null;
  label?: string | null;
  selectorLabel?: string | null;
  selectorCoreLabel?: string | null;
  fullLabel?: string | null;
  hoverTitle?: string | null;
  displaySubLabel?: string | null;
  Institution?: { id?: string | null; name?: string | null; shortName?: string | null; type?: string | null } | null;
  AccountGroup?: { id: string; name?: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
};

type BookCategory = SettingsCategory;
type BookCounterparty = SettingsCounterparty;
type BookAccountGroup = SettingsAccountGroup;

type PreviewAccountLookup = {
  accountById: Map<string, BookAccount>;
  resolveAccount: (accountName: string | undefined) => BookAccount | null;
  matchAccount: (accountName: string | undefined) => { account: BookAccount | null; ambiguousAccounts: BookAccount[] };
  hasCounterparty: (name: string | undefined) => boolean;
  ownerNames: string[];
};

export type StatementImportPreviewItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  amount: number;
  inflow?: number;
  outflow?: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  transferDirection?: "in" | "out";
  category?: string;
  categoryUserEdited?: boolean;
  remark?: string;
  counterparty?: string;
  institution?: string;
  institutionUserEdited?: boolean;
  postedDate?: string;
  currency?: string;
  _meta?: {
    institutionName?: string;
    ownerName?: string;
    cardNumberMasked?: string;
    statementCurrency?: string;
    minimumPayment?: number;
    creditLimit?: number;
    billingDay?: number;
    repaymentDay?: number;
    statementAmount?: number;
    statementPeriodStart?: string;
    statementPeriodEnd?: string;
    statementDueDate?: string;
  };
};

type PreviewEditField =
  | "date"
  | "postedDate"
  | "type"
  | "account"
  | "counterAccount"
  | "category"
  | "institution"
  | "inflow"
  | "outflow"
  | "amount"
  | "remark";

type ImportPreviewRow = {
  key: string;
  item: StatementImportPreviewItem;
  ready: boolean;
  missingFields: string[];
};

type StatementImportPreviewDialogProps = {
  open: boolean;
  title: string;
  description?: string;
  items: StatementImportPreviewItem[];
  defaultAccountName: string;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (
    items: StatementImportPreviewItem[],
    options?: { createDebtAccounts?: boolean; forceCreateOwnedMoneyAccounts?: boolean },
  ) => void | Promise<void>;
};

type PreviewCreationOptions = {
  createDebtAccounts: boolean;
  forceCreateOwnedMoneyAccounts: boolean;
};

const PREVIEW_TYPE_OPTIONS: Array<{ value: StatementImportPreviewItem["type"]; labelKey: string }> = [
  { value: "expense", labelKey: "transaction.type.expense" },
  { value: "income", labelKey: "transaction.type.income" },
  { value: "transfer", labelKey: "transaction.type.transfer" },
  { value: "investment", labelKey: "transaction.type.investment" },
];

const IMPORT_PREVIEW_FIELD_LABEL_KEYS: Record<PreviewEditField, string> = {
  date: "statementImportPreview.colDate",
  postedDate: "detail.column.postedAt",
  type: "batchImport.field.type",
  account: "batchImport.field.account",
  counterAccount: "batchImport.field.counterAccount",
  category: "detail.column.category",
  institution: "detail.column.counterparty",
  inflow: "detail.column.inflow",
  outflow: "detail.column.outflow",
  amount: "txForm.amount",
  remark: "detail.column.remark",
};

const MISSING_FIELD_LABEL_KEYS: Record<string, string> = {
  date: "detail.column.date",
  amount: "txForm.amount",
  account: "batchImport.field.account",
  counterAccount: "batchImport.field.counterAccount",
};

function isPlaceholderText(value?: string | null) {
  const text = String(value ?? "").trim();
  return !text || /^[-—–]+$/.test(text) || text === "?";
}

function cleanText(value?: string | null) {
  const text = String(value ?? "").trim();
  return isPlaceholderText(text) ? "" : text;
}

function displayPreviewValue(value?: string | null) {
  const text = String(value ?? "");
  return text.trim() === "-" ? "" : text;
}

function normalizeDateOnlyText(value?: string | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const match = raw.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?/);
  if (!match) return raw.slice(0, 10);
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function typeLabel(t: (key: string) => string, type: StatementImportPreviewItem["type"]) {
  if (type === "income") return t("transaction.type.income");
  if (type === "transfer") return t("transaction.type.transfer");
  if (type === "investment") return t("transaction.type.investment");
  return t("transaction.type.expense");
}

function previewTransferDirection(item: StatementImportPreviewItem): "in" | "out" {
  const inflow = Math.abs(Number(item.inflow ?? 0)) || 0;
  const outflow = Math.abs(Number(item.outflow ?? 0)) || 0;
  const text = [item.rawText, item.remark, item.fromAccount, item.toAccount].filter(Boolean).join(" ");
  if (
    item.type === "transfer" &&
    outflow <= 0 &&
    /银联入账|银联转账|还款|自动扣款|自动还款|repayment|payment|autopay/i.test(text)
  ) {
    return "in";
  }
  if (item.transferDirection === "in" || item.transferDirection === "out") return item.transferDirection;
  return inflow > 0 && outflow <= 0 ? "in" : "out";
}

function normalizeTransferFlow(item: StatementImportPreviewItem): StatementImportPreviewItem {
  if (item.type !== "transfer") return item;
  const inflow = Math.abs(Number(item.inflow ?? 0)) || 0;
  const outflow = Math.abs(Number(item.outflow ?? 0)) || 0;
  const amount = Math.abs(Number(item.amount ?? 0)) || inflow || outflow;
  const direction = previewTransferDirection(item);
  return {
    ...item,
    amount,
    transferDirection: direction,
    inflow: direction === "in" ? inflow || amount || undefined : undefined,
    outflow: direction === "out" ? outflow || amount || undefined : undefined,
  };
}

function amountPatchForItem(item: StatementImportPreviewItem, nextAmount: number): Partial<StatementImportPreviewItem> {
  const amount = Math.abs(Number(nextAmount) || 0);
  if (item.type === "transfer") {
    return previewTransferDirection(item) === "in"
      ? { amount, inflow: amount, outflow: undefined, transferDirection: "in" }
      : { amount, inflow: undefined, outflow: amount, transferDirection: "out" };
  }
  const isAccountInflow = item.type === "income" || (Number(item.inflow ?? 0) > 0 && Number(item.outflow ?? 0) <= 0);
  return isAccountInflow
    ? { amount, inflow: amount, outflow: undefined }
    : { amount, inflow: undefined, outflow: amount };
}

function flowAmountPatchForItem(item: StatementImportPreviewItem, side: "inflow" | "outflow", nextAmount: number): Partial<StatementImportPreviewItem> {
  const amount = Math.abs(Number(nextAmount) || 0);
  if (item.type === "transfer") {
    return side === "inflow"
      ? { amount, inflow: amount, outflow: undefined, transferDirection: "in" }
      : { amount, inflow: undefined, outflow: amount, transferDirection: "out" };
  }
  return side === "inflow"
    ? { type: "income", amount, inflow: amount, outflow: undefined }
    : { type: "expense", amount, inflow: undefined, outflow: amount };
}

function buildBookAccountDisplayOption(account: BookAccount, labelFields = getAccountLabelFieldsPreference()): AccountDisplayOption {
  return buildAccountDisplayOption({
    ...account,
    Institution: account.Institution
      ? {
          name: account.Institution.name ?? null,
          shortName: account.Institution.shortName ?? null,
        }
      : null,
    AccountGroup: account.AccountGroup
      ? {
          id: account.AccountGroup.id,
          name: account.AccountGroup.name ?? null,
        }
      : null,
  }, undefined, { fields: labelFields });
}

function isTransferOut(item: StatementImportPreviewItem) {
  return previewTransferDirection(item) === "out";
}

function metaAccountCandidate(meta?: StatementImportPreviewItem["_meta"]) {
  return creditAccountCandidates("", meta)[0] || cleanText(meta?.institutionName) || "";
}

function primaryAccountValue(item: StatementImportPreviewItem, defaultAccountName: string) {
  if (item.type !== "transfer") return cleanText(item.account) || cleanText(defaultAccountName) || metaAccountCandidate(item._meta);
  return isTransferOut(item)
    ? cleanText(item.fromAccount) || cleanText(item.account) || cleanText(defaultAccountName) || metaAccountCandidate(item._meta)
    : cleanText(item.toAccount) || cleanText(item.account) || cleanText(defaultAccountName) || metaAccountCandidate(item._meta);
}

function counterAccountValue(item: StatementImportPreviewItem) {
  if (item.type !== "transfer") return "";
  return isTransferOut(item) ? cleanText(item.toAccount) : cleanText(item.fromAccount);
}

function debtCounterpartyNameFromAccount(value?: string | null) {
  return parseDebtAccountName(cleanText(value) || "") ?? "";
}

function isCreatableDebtAccount(value: string | undefined | null, lookup: PreviewAccountLookup | null, options: PreviewCreationOptions) {
  const counterpartyName = debtCounterpartyNameFromAccount(value);
  return Boolean(options.createDebtAccounts && counterpartyName && lookup);
}

function isCreatableOwnedMoneyAccount(value: string | undefined | null, lookup: PreviewAccountLookup | null, options: PreviewCreationOptions) {
  if (!options.forceCreateOwnedMoneyAccounts || !lookup) return false;
  return Boolean(parseImportOwnedMoneyAccountCandidate(value, lookup.ownerNames));
}

function importAccountLast4(value?: string | null) {
  const matches = Array.from(String(value ?? "").matchAll(/\d{4}(?!\d)/g));
  return matches.length > 0 ? matches[matches.length - 1]?.[0] ?? "" : "";
}

function creditAccountCandidates(value: string, meta?: StatementImportPreviewItem["_meta"]) {
  const raw = cleanText(value);
  const institutionName = cleanText(meta?.institutionName);
  const last4 = cleanText(meta?.cardNumberMasked) || importAccountLast4(raw);
  const hasCreditHint = Boolean(institutionName || meta?.cardNumberMasked || /信用卡|贷记卡/.test(raw));
  const candidates = new Set<string>();
  if (raw) candidates.add(raw);
  if (last4 && hasCreditHint) {
    candidates.add(`信用卡(${last4})`);
    candidates.add(`信用卡${last4}`);
    if (institutionName) {
      candidates.add(`${institutionName}信用卡(${last4})`);
      candidates.add(`${institutionName}信用卡${last4}`);
      candidates.add(`${institutionName}贷记卡(${last4})`);
      candidates.add(`${institutionName}贷记卡${last4}`);
    }
  }
  if (institutionName && !last4) candidates.add(`${institutionName}信用卡`);
  return Array.from(candidates).filter(Boolean);
}

function findPreviewAccount(
  value: string | undefined | null,
  lookup: PreviewAccountLookup | null,
  meta?: StatementImportPreviewItem["_meta"],
) {
  const raw = cleanText(value);
  if (!raw || !lookup) return null;
  const directAccountId = parseImportAccountId(raw);
  if (directAccountId) return lookup.accountById.get(directAccountId) ?? null;

  for (const candidate of creditAccountCandidates(raw, meta)) {
    const matched = lookup.resolveAccount(candidate);
    if (matched) return matched;
  }
  return null;
}

function canonicalizePreviewAccountValue(
  value: string | undefined | null,
  lookup: PreviewAccountLookup | null,
  meta?: StatementImportPreviewItem["_meta"],
) {
  const raw = cleanText(value);
  if (!raw || !lookup) return raw || undefined;
  const matched = findPreviewAccount(raw, lookup, meta);
  return matched?.id ? encodeImportAccountId(matched.id) : raw;
}

function isPreviewAccountResolvable(
  value: string | undefined | null,
  lookup: PreviewAccountLookup | null,
  options: PreviewCreationOptions,
  meta?: StatementImportPreviewItem["_meta"],
) {
  return Boolean(
    findPreviewAccount(value, lookup, meta) ||
    isCreatableDebtAccount(value, lookup, options) ||
    isCreatableOwnedMoneyAccount(value, lookup, options)
  );
}

function canonicalizePreviewItemAccounts(
  item: StatementImportPreviewItem,
  defaultAccountName: string,
  lookup: PreviewAccountLookup | null,
) {
  if (!lookup) return item;
  if (item.type !== "transfer") {
    return {
      ...item,
      account: canonicalizePreviewAccountValue(primaryAccountValue(item, defaultAccountName), lookup, item._meta),
    };
  }

  const transferOut = isTransferOut(item);
  const primaryValue = primaryAccountValue(item, defaultAccountName);
  const counterValue = counterAccountValue(item);
  const primaryAccount = canonicalizePreviewAccountValue(primaryValue, lookup, item._meta);
  const counterAccount = canonicalizePreviewAccountValue(counterValue, lookup);
  return transferOut
    ? {
        ...item,
        account: primaryAccount,
        fromAccount: primaryAccount,
        toAccount: counterAccount,
      }
    : {
        ...item,
        account: primaryAccount,
        fromAccount: counterAccount,
        toAccount: primaryAccount,
      };
}

export function statementImportMissingFields(
  item: StatementImportPreviewItem,
  defaultAccountName: string,
  lookup: PreviewAccountLookup | null = null,
  creationOptions: PreviewCreationOptions = { createDebtAccounts: false, forceCreateOwnedMoneyAccounts: false },
) {
  const missing: string[] = [];
  if (!cleanText(item.date)) missing.push("date");
  if (!(Number(item.amount) > 0)) missing.push("amount");
  if (item.type === "transfer") {
    const primaryAccount = primaryAccountValue(item, defaultAccountName);
    const counterAccount = counterAccountValue(item);
    if (!primaryAccount || (lookup && !isPreviewAccountResolvable(primaryAccount, lookup, creationOptions, item._meta))) missing.push("account");
    if (!counterAccount || (lookup && !isPreviewAccountResolvable(counterAccount, lookup, creationOptions))) missing.push("counterAccount");
  } else {
    const primaryAccount = cleanText(item.account) || cleanText(defaultAccountName) || cleanText(item._meta?.institutionName);
    if (!primaryAccount || (lookup && !isPreviewAccountResolvable(primaryAccount, lookup, creationOptions, item._meta))) {
      missing.push("account");
    }
  }
  return Array.from(new Set(missing));
}

export function isStatementImportReady(item: StatementImportPreviewItem, defaultAccountName: string) {
  return statementImportMissingFields(item, defaultAccountName).length === 0;
}

function buildCategoryOptions(categories: BookCategory[], txType: StatementImportPreviewItem["type"] | undefined, t: (key: string) => string): BatchReplaceOption[] {
  const options: BatchReplaceOption[] = [{ value: "", label: t("statementImportPreview.clearCategory") }];
  const typeLabels: Record<string, string> = { expense: t("stats.expenseCategories"), income: t("statementImportPreview.incomeCategories") };
  const types = txType ? [txType === "income" ? "income" : "expense"] : ["expense", "income"];
  const scopedToOneType = Boolean(txType);
  return options.concat(buildCategorySmartSelectOptions({
    categories,
    types,
    typeLabels,
    typeHeaderPrefix: "preview-category-type",
    includeTypeHeaders: !scopedToOneType,
    t,
  }).map((option) => ({ ...option, value: option.id })));
}

function buildPreviewRows(
  items: StatementImportPreviewItem[],
  defaultAccountName: string,
  lookup: PreviewAccountLookup | null = null,
  creationOptions: PreviewCreationOptions = { createDebtAccounts: false, forceCreateOwnedMoneyAccounts: false },
): ImportPreviewRow[] {
  return items.map((item, index) => {
    const itemWithAccounts = canonicalizePreviewItemAccounts(item, defaultAccountName, lookup);
    const normalizedItem = normalizeTransferFlow({
      ...itemWithAccounts,
      date: normalizeDateOnlyText(itemWithAccounts.date) || undefined,
      postedDate: normalizeDateOnlyText(itemWithAccounts.postedDate) || normalizeDateOnlyText(itemWithAccounts.date) || undefined,
    });
    const missingFields = statementImportMissingFields(normalizedItem, defaultAccountName, lookup, creationOptions);
    return {
      key: `statement-${index}-${normalizedItem.date ?? ""}-${normalizedItem.amount ?? 0}-${normalizedItem.rawText ?? ""}`,
      item: normalizedItem,
      missingFields,
      ready: missingFields.length === 0,
    };
  });
}

function missingAccountCandidateValuesForRow(row: ImportPreviewRow, defaultAccountName: string) {
  const candidates: string[] = [];
  if (row.item.type === "transfer") {
    if (row.missingFields.includes("account")) candidates.push(primaryAccountValue(row.item, defaultAccountName));
    if (row.missingFields.includes("counterAccount")) candidates.push(counterAccountValue(row.item));
  } else if (row.missingFields.includes("account")) {
    candidates.push(primaryAccountValue(row.item, defaultAccountName));
  }
  return Array.from(new Set(candidates.map(cleanText).filter(Boolean)));
}

function missingDebtAccountNamesForRow(row: ImportPreviewRow, defaultAccountName: string) {
  const names = missingAccountCandidateValuesForRow(row, defaultAccountName)
    .map(debtCounterpartyNameFromAccount)
    .filter(Boolean);
  return Array.from(new Set(names));
}

export function StatementImportPreviewDialog({
  open,
  title,
  description,
  items,
  defaultAccountName,
  busy = false,
  onClose,
  onConfirm,
}: StatementImportPreviewDialogProps) {
  const [rows, setRows] = useState<ImportPreviewRow[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [editingPreviewCell, setEditingPreviewCell] = useState<{ rowKey: string; field: PreviewEditField } | null>(null);
  const [bookAccounts, setBookAccounts] = useState<BookAccount[]>([]);
  const [bookCategories, setBookCategories] = useState<BookCategory[]>([]);
  const [bookCounterparties, setBookCounterparties] = useState<BookCounterparty[]>([]);
  const [bookAccountGroups, setBookAccountGroups] = useState<BookAccountGroup[]>([]);
  const [settingsBootstrapLoaded, setSettingsBootstrapLoaded] = useState(false);
  const [createDebtAccounts, setCreateDebtAccounts] = useState(false);
  const [forceCreateOwnedMoneyAccounts, setForceCreateOwnedMoneyAccounts] = useState(false);
  const autoCheckedDebtAccountsRef = useRef(false);
  const [categorySyncMessage, setCategorySyncMessage] = useState("");
  const { t, language } = useI18n();
  const accountLabelFields = useMemo(() => getAccountLabelFieldsPreference(), []);
  const colorScheme = useMemo(
    () => getColorSchemeFromCookie(typeof document === "undefined" ? null : document.cookie),
    [],
  );

  const accountDisplayOptions = useMemo(
    () => bookAccounts
      .map((account) => buildBookAccountDisplayOption(account, accountLabelFields))
      .sort((a, b) => a.selectorLabel.localeCompare(b.selectorLabel, "zh-Hans-CN")),
    [accountLabelFields, bookAccounts],
  );
  const accountDisplayById = useMemo(
    () => new Map(accountDisplayOptions.map((account) => [account.id, account])),
    [accountDisplayOptions],
  );
  const accountLookup = useMemo<PreviewAccountLookup | null>(
    () => {
      if (!settingsBootstrapLoaded) return null;
      const matchAccount = createImportAccountMatcher(bookAccounts);
      return {
        accountById: new Map(bookAccounts.map((account) => [account.id, account])),
        resolveAccount: (accountName) => matchAccount(accountName).account,
        matchAccount,
        ownerNames: bookAccountGroups.map((group) => group.name).filter(Boolean),
        hasCounterparty: (name) => {
          const key = normalizeImportAccountMatchKey(name);
          if (!key) return false;
          return bookCounterparties.some((counterparty) =>
            normalizeImportAccountMatchKey(counterparty.name) === key ||
            normalizeImportAccountMatchKey(counterparty.shortName) === key,
          );
        },
      };
    },
    [bookAccountGroups, bookAccounts, bookCounterparties, settingsBootstrapLoaded],
  );
  const accountResolveCacheRef = useRef(new Map<string, string>());
  useEffect(() => {
    accountResolveCacheRef.current.clear();
  }, [accountLookup]);
  const creationOptions = useMemo<PreviewCreationOptions>(
    () => ({ createDebtAccounts, forceCreateOwnedMoneyAccounts }),
    [createDebtAccounts, forceCreateOwnedMoneyAccounts],
  );
  const accountSmartSelectOptions = useMemo(
    () => buildGroupedAccountOptions(accountDisplayOptions),
    [accountDisplayOptions],
  );
  const {
    ownerFilterLabel,
    cycleOwnerFilter,
    filteredOptions,
    visibleOptionIds,
  } = useAccountSSFilter(accountSmartSelectOptions);
  const displayAccountOptions = useMemo(() => {
    const source = filteredOptions?.length ? filteredOptions : accountSmartSelectOptions;
    if (!visibleOptionIds) return source;
    return source.filter((option) => option.isHeader || visibleOptionIds.has(option.id));
  }, [accountSmartSelectOptions, filteredOptions, visibleOptionIds]);
  const categoryById = useMemo(
    () => new Map(bookCategories.map((category) => [category.id, category])),
    [bookCategories],
  );
  const previewCategoryReplaceOptions = useMemo(
    () => buildCategoryOptions(bookCategories, undefined, t),
    [bookCategories, t],
  );
  const statementInfoTexts = useMemo(
    () => uniqueStatementInfoTexts(rows.map((row) => row.item)),
    [rows],
  );

  useEffect(() => {
    if (!open) return;
    if (!settingsBootstrapLoaded || !accountLookup) {
      setRows([]);
      setSelectedKeys(new Set());
      setEditingPreviewCell(null);
      setCategorySyncMessage("");
      return;
    }
    const nextRows = buildPreviewRows(items, defaultAccountName, accountLookup, creationOptions);
    if (!autoCheckedDebtAccountsRef.current && !createDebtAccounts && nextRows.some((row) => missingDebtAccountNamesForRow(row, defaultAccountName).length > 0)) {
      autoCheckedDebtAccountsRef.current = true;
      setCreateDebtAccounts(true);
      return;
    }
    setRows(nextRows);
    setSelectedKeys(new Set(nextRows.filter((row) => row.ready).map((row) => row.key)));
    setEditingPreviewCell(null);
    setCategorySyncMessage("");
  }, [accountLookup, createDebtAccounts, creationOptions, defaultAccountName, items, open, settingsBootstrapLoaded]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    autoCheckedDebtAccountsRef.current = false;
    setSettingsBootstrapLoaded(false);
    setCreateDebtAccounts(false);
    setForceCreateOwnedMoneyAccounts(false);
    setRows([]);
    setSelectedKeys(new Set());
    fetchSettingsBootstrap()
      .then((bootstrap) => {
        if (cancelled) return;
        setBookAccounts(Array.isArray(bootstrap.accounts) ? bootstrap.accounts as BookAccount[] : []);
        setBookCategories(Array.isArray(bootstrap.categories) ? bootstrap.categories : []);
        setBookCounterparties(Array.isArray(bootstrap.counterparties) ? bootstrap.counterparties : []);
        setBookAccountGroups(Array.isArray(bootstrap.groups) ? bootstrap.groups : []);
        setSettingsBootstrapLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setBookAccounts([]);
        setBookCategories([]);
        setBookCounterparties([]);
        setBookAccountGroups([]);
        setSettingsBootstrapLoaded(true);
      });
    return () => { cancelled = true; };
  }, [open]);

  function closeDialog() {
    setRows([]);
    setSelectedKeys(new Set());
    setEditingPreviewCell(null);
    autoCheckedDebtAccountsRef.current = false;
    setSettingsBootstrapLoaded(false);
    setCreateDebtAccounts(false);
    setForceCreateOwnedMoneyAccounts(false);
    setCategorySyncMessage("");
    onClose();
  }

  function findPreviewAccountId(value?: string | null, meta?: StatementImportPreviewItem["_meta"]) {
    const raw = cleanText(value);
    if (!raw || !accountLookup) return "";
    const cacheKey = [
      raw,
      meta?.institutionName ?? "",
      meta?.ownerName ?? "",
      meta?.cardNumberMasked ?? "",
    ].join("\u001F");
    const accountResolveCache = accountResolveCacheRef.current;
    const cached = accountResolveCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const matchedId = findPreviewAccount(raw, accountLookup, meta)?.id ?? "";
    accountResolveCache.set(cacheKey, matchedId);
    return matchedId;
  }

  function previewAccountSelectValue(value: string | undefined, meta?: StatementImportPreviewItem["_meta"]) {
    const text = cleanText(value);
    if (!text) return "";
    const matchedId = findPreviewAccountId(value, meta);
    return matchedId || `unmatched:${text}`;
  }

  function previewAccountOptionsFor(value: string | undefined, meta?: StatementImportPreviewItem["_meta"]) {
    const text = cleanText(value);
    const matchedId = findPreviewAccountId(text, meta);
    if (!text || matchedId) return displayAccountOptions;
    return [{
      id: `unmatched:${text}`,
      label: t("statementImportPreview.unmatchedValue", { value: text }),
      subLabel: t("statementImportPreview.originalRecognizedValue"),
    }, ...displayAccountOptions];
  }

  function previewAccountValueFromSelect(selectedId: string) {
    if (!selectedId) return "";
    if (selectedId.startsWith("unmatched:")) return selectedId.slice("unmatched:".length);
    return encodeImportAccountId(selectedId);
  }

  function previewAccountDisplayText(value: string | undefined, meta?: StatementImportPreviewItem["_meta"]) {
    const text = cleanText(value);
    if (!text) return "";
    const matchedId = findPreviewAccountId(text, meta);
    const display = matchedId ? accountDisplayById.get(matchedId) : undefined;
    if (display) return formatAccountTableLabel(display, text, accountLabelFields);
    return text;
  }

  function previewAccountDisplayTitle(value: string | undefined, meta?: StatementImportPreviewItem["_meta"]) {
    const text = cleanText(value);
    if (!text) return t("statementImportPreview.doubleClickEdit", { field: t("batchImport.field.account") });
    const matchedId = findPreviewAccountId(text, meta);
    const display = matchedId ? accountDisplayById.get(matchedId) : undefined;
    if (display) return formatAccountTableTitle(display, text, accountLabelFields);
    return text;
  }

  function previewCategorySelectValue(categoryName: string | undefined, txType: StatementImportPreviewItem["type"]) {
    const name = cleanText(categoryName);
    if (!name) return "";
    const categoryType = txType === "income" ? "income" : "expense";
    const matched = bookCategories.find((category) => category.name === name && category.type === categoryType)
      ?? bookCategories.find((category) => category.name === name);
    return matched?.id ?? "";
  }

  function missingAccountCandidateValues(row: ImportPreviewRow) {
    return missingAccountCandidateValuesForRow(row, defaultAccountName);
  }

  function missingDebtAccountNames(row: ImportPreviewRow) {
    return missingDebtAccountNamesForRow(row, defaultAccountName);
  }

  function missingOwnedMoneyAccountNames(row: ImportPreviewRow) {
    const names = missingAccountCandidateValues(row)
      .map((value) => parseImportOwnedMoneyAccountCandidate(value, accountLookup?.ownerNames ?? [])?.originalName ?? "")
      .filter(Boolean);
    return Array.from(new Set(names));
  }

  function ownedAccountTypeLabel(kind: string, investProductType?: string) {
    if (kind === "investment") {
      if (investProductType === "wealth") return t("statementImportPreview.accountType.wealth");
      if (investProductType === "money") return t("statementImportPreview.accountType.moneyFund");
      return t("statementImportPreview.accountType.fund");
    }
    if (kind === "bank_debit") return t("statementImportPreview.accountType.bankDebit");
    if (kind === "ewallet") return t("statementImportPreview.accountType.ewallet");
    if (kind === "cash") return t("statementImportPreview.accountType.cash");
    return t("batchImport.field.account");
  }

  function ownedAccountDisplayName(value: string) {
    const candidate = parseImportOwnedMoneyAccountCandidate(value, accountLookup?.ownerNames ?? []);
    if (!candidate) return "";
    return [candidate.ownerName, candidate.institutionDisplayName ?? candidate.institutionName, candidate.accountName]
      .map(cleanText)
      .filter(Boolean)
      .join("·");
  }

  function forcedOwnedAccountCreationLabels(row: ImportPreviewRow) {
    if (!forceCreateOwnedMoneyAccounts || !accountLookup) return [];
    const accountValues = row.item.type === "transfer"
      ? [
          { value: primaryAccountValue(row.item, defaultAccountName), meta: row.item._meta },
          { value: counterAccountValue(row.item), meta: undefined },
        ]
      : [{ value: primaryAccountValue(row.item, defaultAccountName), meta: row.item._meta }];
    const labels = accountValues
      .filter(({ value, meta }) => cleanText(value) && !findPreviewAccount(value, accountLookup, meta))
      .map(({ value }) => {
        const candidate = parseImportOwnedMoneyAccountCandidate(value, accountLookup.ownerNames);
        if (!candidate) return "";
        return `${ownedAccountTypeLabel(candidate.kind, candidate.investProductType)}：${ownedAccountDisplayName(value)}`;
      })
      .filter(Boolean);
    return Array.from(new Set(labels));
  }

  function debtAccountCreationLabels(row: ImportPreviewRow) {
    if (!createDebtAccounts || !accountLookup) return [];
    const accountValues = row.item.type === "transfer"
      ? [
          { value: primaryAccountValue(row.item, defaultAccountName), meta: row.item._meta },
          { value: counterAccountValue(row.item), meta: undefined },
        ]
      : [{ value: primaryAccountValue(row.item, defaultAccountName), meta: row.item._meta }];
    const names = accountValues
      .filter(({ value, meta }) => cleanText(value) && !findPreviewAccount(value, accountLookup, meta))
      .map(({ value }) => debtCounterpartyNameFromAccount(value))
      .filter(Boolean);
    return Array.from(new Set(names.map((name) => t("statementImportPreview.debtAccountName", { name }))));
  }

  function previewCreationStatus(row: ImportPreviewRow) {
    const debtLabels = debtAccountCreationLabels(row);
    if (debtLabels.length > 0) {
      return {
        kind: "debt" as const,
        text: t("statementImportPreview.willCreateDebtAccounts", { value: debtLabels.join(" / ") }),
      };
    }
    const ownedLabels = forcedOwnedAccountCreationLabels(row);
    if (ownedLabels.length > 0) {
      return {
        kind: "owned" as const,
        text: t("statementImportPreview.willCreateOwnedMoneyAccounts", { value: ownedLabels.join(" / ") }),
      };
    }
    return null;
  }

  function ambiguousAccountMatchLabels(row: ImportPreviewRow) {
    if (!accountLookup) return [];
    const labels = missingAccountCandidateValues(row)
      .filter(Boolean)
      .map((value) => {
        const match = accountLookup.matchAccount(value);
        if (match.account || match.ambiguousAccounts.length < 2) return "";
        return t("statementImportPreview.ambiguousAccountMatches", {
          count: language === "zh-CN" && match.ambiguousAccounts.length === 2 ? t("statementImportPreview.ambiguousAccountCount.two") : String(match.ambiguousAccounts.length),
          name: cleanText(value),
        });
      })
      .filter(Boolean);
    return Array.from(new Set(labels));
  }

  function previewStatusText(row: ImportPreviewRow) {
    const ambiguousLabels = ambiguousAccountMatchLabels(row);
    if (ambiguousLabels.length > 0) return ambiguousLabels.join(" / ");
    if (row.ready) {
      const creationStatus = previewCreationStatus(row);
      if (creationStatus) return creationStatus.text;
      return t("statementImportPreview.importable");
    }
    const debtAccountNames = missingDebtAccountNames(row);
    if (debtAccountNames.length > 0 && !createDebtAccounts) {
      return t("statementImportPreview.enableCreateDebtAccounts", { name: debtAccountNames.join(" / ") });
    }
    const ownedMoneyAccountNames = missingOwnedMoneyAccountNames(row);
    if (ownedMoneyAccountNames.length > 0 && !forceCreateOwnedMoneyAccounts) {
      return t("statementImportPreview.enableForceCreateOwnedMoneyAccounts", { name: ownedMoneyAccountNames.join(" / ") });
    }
    return t("statementImportPreview.missingFields", {
      fields: row.missingFields.map((field) => t(MISSING_FIELD_LABEL_KEYS[field] ?? field)).join("、") || t("statementImportPreview.field"),
    });
  }

  function previewCategoryNameById(categoryId: string) {
    if (!categoryId) return "";
    return categoryById.get(categoryId)?.name ?? "";
  }

  function previewCategorySmartSelectOptionsFor(txType: StatementImportPreviewItem["type"]): SmartSelectOption[] {
    const categoryType = txType === "income" ? "income" : "expense";
    return buildCategoryOptions(bookCategories, txType, t)
      .filter((option) => {
        if (!option.value) return true;
        if (option.isHeader) return option.value === `preview-category-type:${categoryType}`;
        return categoryById.get(option.value)?.type === categoryType;
      })
      .map((option) => ({
        id: option.value,
        label: option.label,
        isHeader: option.isHeader,
        isGroup: option.isGroup,
        parentId: option.parentId,
      }));
  }

  function primaryAccountPatch(item: StatementImportPreviewItem, value: string): Partial<StatementImportPreviewItem> {
    if (item.type !== "transfer") return { account: value || undefined };
    return isTransferOut(item)
      ? { account: value || undefined, fromAccount: value || undefined }
      : { account: value || undefined, toAccount: value || undefined };
  }

  function counterAccountPatch(item: StatementImportPreviewItem, value: string): Partial<StatementImportPreviewItem> {
    if (item.type !== "transfer") return {};
    return isTransferOut(item)
      ? { toAccount: value || undefined }
      : { fromAccount: value || undefined };
  }

  function typePatchForItem(item: StatementImportPreviewItem, type: StatementImportPreviewItem["type"]): Partial<StatementImportPreviewItem> {
    const amount = Math.abs(Number(item.amount || item.inflow || item.outflow || 0));
    const account = cleanText(item.account) || cleanText(item.toAccount) || cleanText(defaultAccountName);
    if (type === "transfer") {
      const transferDirection: "in" | "out" = item.transferDirection ?? (Number(item.outflow ?? 0) > 0 ? "out" : "in");
      return transferDirection === "out"
        ? {
            type,
            amount,
            account,
            fromAccount: cleanText(item.fromAccount) || account,
            toAccount: cleanText(item.toAccount),
            transferDirection,
            inflow: undefined,
            outflow: amount,
          }
        : {
            type,
            amount,
            account,
            toAccount: cleanText(item.toAccount) || account,
            fromAccount: cleanText(item.fromAccount),
            transferDirection,
            inflow: amount,
            outflow: undefined,
          };
    }
    if (type === "income") {
      return {
        type,
        amount,
        account,
        fromAccount: undefined,
        toAccount: undefined,
        transferDirection: undefined,
        inflow: amount,
        outflow: undefined,
      };
    }
    return {
      type,
      amount,
      account,
      fromAccount: undefined,
      toAccount: undefined,
      transferDirection: undefined,
      inflow: undefined,
      outflow: amount,
    };
  }

  function recomputeRow(row: ImportPreviewRow, patch: Partial<StatementImportPreviewItem>): ImportPreviewRow {
    let item: StatementImportPreviewItem = { ...row.item, ...patch };
    if ("date" in patch) {
      const nextDate = normalizeDateOnlyText(patch.date);
      const previousDate = normalizeDateOnlyText(row.item.date);
      const previousPostedDate = normalizeDateOnlyText(row.item.postedDate);
      item.date = nextDate || undefined;
      if (!previousPostedDate || previousPostedDate === previousDate) item.postedDate = nextDate || undefined;
    }
    if ("postedDate" in patch) item.postedDate = normalizeDateOnlyText(patch.postedDate) || undefined;
    item = normalizeTransferFlow(item);
    const missingFields = statementImportMissingFields(item, defaultAccountName, accountLookup, creationOptions);
    return {
      ...row,
      item,
      missingFields,
      ready: missingFields.length === 0,
    };
  }

  function recomputeState(nextRows: ImportPreviewRow[]) {
    const rowKeys = new Set(nextRows.map((row) => row.key));
    setRows(nextRows);
    setSelectedKeys((current) => new Set(Array.from(current).filter((key) => rowKeys.has(key))));
  }

  function updatePreviewRow(rowKey: string, patch: Partial<StatementImportPreviewItem>) {
    const nextRows = rows.map((row) => row.key === rowKey ? recomputeRow(row, patch) : row);
    recomputeState(nextRows);
  }

  function updatePreviewCategoryForMatchingRemarks(rowKey: string, categoryId: string) {
    const sourceRows = rows;
    const sourceIndex = sourceRows.findIndex((row) => row.key === rowKey);
    if (sourceIndex < 0) return;

    const category = previewCategoryNameById(categoryId);
    const sourceKey = statementPreviewCategorySyncKey(sourceRows[sourceIndex].item);
    let propagatedCount = 0;
    const nextRows = sourceRows.map((row, index) => {
      const isSource = index === sourceIndex;
      const isMatchingRemark = Boolean(sourceKey && statementPreviewCategorySyncKey(row.item) === sourceKey);
      if (!isSource && !isMatchingRemark) return row;
      if (!isSource && cleanText(row.item.category) === category) return row;
      if (!isSource) propagatedCount += 1;
      return recomputeRow(row, {
        category: category || undefined,
        categoryUserEdited: true,
      });
    });
    recomputeState(nextRows);
    setCategorySyncMessage(
      propagatedCount > 0
        ? t("statementImportPreview.sameRemarkCategoryApplied", { count: propagatedCount })
        : "",
    );
  }

  function applyPreviewReplace(field: PreviewEditField, value: string) {
    if (!settingsBootstrapLoaded) throw new Error(t("batchImport.processingDataTitle"));
    const sourceRows = rows;
    const effectiveSelectedKeys = selectedKeys;
    const selectedRowKeys = Array.from(effectiveSelectedKeys);
    if (selectedRowKeys.length === 0) throw new Error(t("statementImportPreview.selectRowsFirst"));
    let changed = 0;
    let invalid = 0;
    const nextRows = sourceRows.map((row) => {
      if (!effectiveSelectedKeys.has(row.key)) return row;
      if (field === "amount" || field === "inflow" || field === "outflow") {
        const currentValue = field === "amount"
          ? row.item.amount
          : Number(row.item[field] ?? 0) || 0;
        const computed = evaluateCalcInputExpression(value, currentValue);
        if (computed == null) {
          invalid++;
          return row;
        }
        changed++;
        return field === "amount"
          ? recomputeRow(row, amountPatchForItem(row.item, computed))
          : recomputeRow(row, flowAmountPatchForItem(row.item, field, computed));
      }
      changed++;
      if (field === "type") return recomputeRow(row, typePatchForItem(row.item, value as StatementImportPreviewItem["type"]));
      if (field === "account") return recomputeRow(row, primaryAccountPatch(row.item, value ? encodeImportAccountId(value) : ""));
      if (field === "counterAccount") return recomputeRow(row, counterAccountPatch(row.item, value ? encodeImportAccountId(value) : ""));
      if (field === "category") return recomputeRow(row, { category: previewCategoryNameById(value) || undefined, categoryUserEdited: true });
      if (field === "institution") return recomputeRow(row, { institution: value || undefined, institutionUserEdited: true });
      return recomputeRow(row, { [field]: value || undefined } as Partial<StatementImportPreviewItem>);
    });
    recomputeState(nextRows);
    const invalidSuffix = invalid > 0 ? t("statementImportPreview.invalidAmountSkipped", { count: invalid }) : "";
    return t("statementImportPreview.batchReplaceResult", { count: changed, field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS[field]), invalidSuffix });
  }

  function previewItemForImport(item: StatementImportPreviewItem): StatementImportPreviewItem {
    if (item.type !== "transfer") {
      return cleanText(item.account) ? item : { ...item, account: cleanText(defaultAccountName) || undefined };
    }
    const primaryAccount = primaryAccountValue(item, defaultAccountName);
    const counterAccount = counterAccountValue(item);
    return isTransferOut(item)
      ? {
          ...item,
          account: primaryAccount || undefined,
          fromAccount: primaryAccount || undefined,
          toAccount: counterAccount || undefined,
        }
      : {
          ...item,
          account: primaryAccount || undefined,
          fromAccount: counterAccount || undefined,
          toAccount: primaryAccount || undefined,
        };
  }

  async function confirmSelected() {
    if (busy || !settingsBootstrapLoaded) return;
    const sourceRows = rows;
    const effectiveSelectedKeys = selectedKeys;
    const selectedRows = sourceRows.filter((row) => effectiveSelectedKeys.has(row.key));
    if (selectedRows.length === 0 || selectedRows.some((row) => !row.ready)) return;
    const selectedItems = selectedRows.map((row) => previewItemForImport(row.item));
    if (selectedItems.length === 0) return;
    await onConfirm(selectedItems, {
      createDebtAccounts,
      forceCreateOwnedMoneyAccounts,
    });
  }

  const previewAccountReplaceOptions = useMemo<BatchReplaceOption[]>(
    () => [
      { value: "", label: t("batchImport.unselected") },
      ...accountDisplayOptions.map((account) => ({
        value: account.id,
        label: formatAccountTableLabel(account, "", accountLabelFields),
        title: formatAccountTableTitle(account, "", accountLabelFields),
      })),
    ],
    [accountDisplayOptions, accountLabelFields, t],
  );

  const previewReplaceFields = useMemo<BatchReplaceFieldConfig<PreviewEditField>[]>(
    () => [
      { value: "date", label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.date), kind: "text", placeholder: t("statementImportPreview.datePlaceholder") },
      { value: "postedDate", label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.postedDate), kind: "date", placeholder: t("statementImportPreview.postedDatePlaceholder") },
      {
        value: "type",
        label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.type),
        kind: "select",
        options: [{ value: "", label: t("batchImport.selectType") }, ...PREVIEW_TYPE_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))],
        placeholder: t("batchImport.selectType"),
      },
      {
        value: "account",
        label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.account),
        kind: "smartSelect",
        options: previewAccountReplaceOptions,
        placeholder: t("statementImportPreview.selectAccount"),
        allowEmpty: true,
        smartSelectBehavior: { search: true, hierarchy: true, minDropdownWidth: 252, fitContent: true, dropdownMaxHeight: 220, density: "micro", resizableDropdown: true },
      },
      {
        value: "counterAccount",
        label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.counterAccount),
        kind: "smartSelect",
        options: previewAccountReplaceOptions,
        placeholder: t("statementImportPreview.selectCounterAccount"),
        allowEmpty: true,
        smartSelectBehavior: { search: true, hierarchy: true, minDropdownWidth: 252, fitContent: true, dropdownMaxHeight: 220, density: "micro", resizableDropdown: true },
      },
      {
        value: "category",
        label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.category),
        kind: "smartSelect",
        options: previewCategoryReplaceOptions,
        placeholder: t("statementImportPreview.selectCategory"),
        allowEmpty: true,
        smartSelectBehavior: CATEGORY_SMART_SELECT_BEHAVIOR,
      },
      { value: "institution", label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.institution), kind: "text", placeholder: t("statementImportPreview.institutionPlaceholder") },
      { value: "outflow", label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.outflow), kind: "number", placeholder: t("statementImportPreview.amountExpressionPlaceholder") },
      { value: "inflow", label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.inflow), kind: "number", placeholder: t("statementImportPreview.amountExpressionPlaceholder") },
      { value: "amount", label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.amount), kind: "number", placeholder: t("statementImportPreview.amountExpressionPlaceholder") },
      { value: "remark", label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.remark), kind: "text", placeholder: t("statementImportPreview.remarkPlaceholder") },
    ],
    [previewAccountReplaceOptions, previewCategoryReplaceOptions, t],
  );

  function stopPreviewCellEvent(event: ReactMouseEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function editableCellProps(rowKey: string, field: PreviewEditField) {
    return {
      "data-row-double-click-ignore": true,
      onMouseDown: stopPreviewCellEvent,
      onClick: stopPreviewCellEvent,
      onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
        event.stopPropagation();
        setEditingPreviewCell({ rowKey, field });
      },
    };
  }

  function amountEditorSide(item: StatementImportPreviewItem): "inflow" | "outflow" {
    const inflow = Math.abs(Number(item.inflow ?? 0)) || 0;
    const outflow = Math.abs(Number(item.outflow ?? 0)) || 0;
    if (inflow > 0 && outflow <= 0) return "inflow";
    if (item.type === "income") return "inflow";
    return "outflow";
  }

  function renderAmountInput(row: ImportPreviewRow) {
    return (
      <input
        data-row-double-click-ignore
        type="number"
        value={Number(row.item.amount || 0) || ""}
        autoFocus
        step="0.01"
        onMouseDown={stopPreviewCellEvent}
        onClick={stopPreviewCellEvent}
        onDoubleClick={stopPreviewCellEvent}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => updatePreviewRow(row.key, amountPatchForItem(row.item, Number(event.target.value) || 0))}
        onBlur={() => setEditingPreviewCell(null)}
        className="h-8 w-24 rounded-md border border-blue-200 bg-white px-2 text-right text-xs tabular-nums outline-none"
      />
    );
  }

  function renderTextEditCell(row: ImportPreviewRow, field: PreviewEditField, value: string, titleText: string) {
    if (editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === field) {
      return (
        <input
          data-row-double-click-ignore
          type="text"
          value={value}
          autoFocus
          onMouseDown={stopPreviewCellEvent}
          onClick={stopPreviewCellEvent}
          onDoubleClick={stopPreviewCellEvent}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => updatePreviewRow(row.key, {
            [field]: event.target.value || undefined,
            ...(field === "institution" ? { institutionUserEdited: true } : {}),
          } as Partial<StatementImportPreviewItem>)}
          onBlur={() => setEditingPreviewCell(null)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Escape") setEditingPreviewCell(null);
          }}
          className="h-8 w-full rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
        />
      );
    }
    return (
      <span
        data-row-double-click-ignore
        className="block min-h-5 w-full truncate cursor-pointer rounded px-1 py-0.5 text-slate-700 hover:bg-slate-100"
        title={titleText}
        onMouseDown={stopPreviewCellEvent}
        onClick={stopPreviewCellEvent}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setEditingPreviewCell({ rowKey: row.key, field });
        }}
      >
        {displayPreviewValue(value)}
      </span>
    );
  }

  const columns = useMemo<AdvancedDataTableColumn<ImportPreviewRow>[]>(() => [
    {
      key: "date",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.date),
      width: 100,
      minWidth: 84,
      filterKind: "dateRange",
      filterText: (row) => row.item.date?.trim() || t("batchImport.emptyValue"),
      sortValue: (row) => row.item.date || "",
      render: (row) => (
        <div className="whitespace-nowrap tabular-nums text-slate-700" {...editableCellProps(row.key, "date")}>
          {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "date" ? (
            <DateStepper
              autoFocus
              className="h-8 rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
              value={normalizeDateOnlyText(row.item.date)}
              onBlur={() => setEditingPreviewCell(null)}
              onChange={(value) => {
                updatePreviewRow(row.key, { date: value || undefined });
                setEditingPreviewCell(null);
              }}
            />
          ) : (
            <span className="block min-h-5 w-full cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.date) })}>{displayPreviewValue(normalizeDateOnlyText(row.item.date))}</span>
          )}
        </div>
      ),
    },
    {
      key: "postedDate",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.postedDate),
      width: 110,
      minWidth: 96,
      hideable: true,
      filterKind: "dateRange",
      filterText: (row) => normalizeDateOnlyText(row.item.postedDate) || t("batchImport.emptyValue"),
      sortValue: (row) => normalizeDateOnlyText(row.item.postedDate) || "",
      render: (row) => (
        <div className="whitespace-nowrap tabular-nums text-slate-500" {...editableCellProps(row.key, "postedDate")}>
          {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "postedDate" ? (
            <DateStepper
              autoFocus
              className="h-8 rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
              value={normalizeDateOnlyText(row.item.postedDate)}
              onBlur={() => setEditingPreviewCell(null)}
              onChange={(value) => {
                updatePreviewRow(row.key, { postedDate: value || undefined });
                setEditingPreviewCell(null);
              }}
            />
          ) : (
            <span className="block min-h-5 w-full cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.postedDate) })}>{displayPreviewValue(normalizeDateOnlyText(row.item.postedDate))}</span>
          )}
        </div>
      ),
    },
    {
      key: "type",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.type),
      width: 72,
      minWidth: 60,
      filterText: (row) => typeLabel(t, row.item.type),
      render: (row) => (
        <div className="whitespace-nowrap text-slate-700" {...editableCellProps(row.key, "type")}>
          {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "type" ? (
            <select
              data-row-double-click-ignore
              autoFocus
              className="h-8 rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
              value={row.item.type}
              onMouseDown={stopPreviewCellEvent}
              onClick={stopPreviewCellEvent}
              onDoubleClick={stopPreviewCellEvent}
              onBlur={() => setEditingPreviewCell(null)}
              onChange={(event) => {
                updatePreviewRow(row.key, typePatchForItem(row.item, event.target.value as StatementImportPreviewItem["type"]));
                setEditingPreviewCell(null);
              }}
            >
              {PREVIEW_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
              ))}
            </select>
          ) : (
            <span className="cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.type) })}>{typeLabel(t, row.item.type)}</span>
          )}
        </div>
      ),
    },
    {
      key: "account",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.account),
      width: 190,
      minWidth: 140,
      filterText: (row) => previewAccountDisplayText(primaryAccountValue(row.item, defaultAccountName), row.item._meta) || t("batchImport.emptyValue"),
      render: (row) => {
        const accountValue = primaryAccountValue(row.item, defaultAccountName);
        return (
          <div className="min-w-[180px] text-slate-700" {...editableCellProps(row.key, "account")}>
            {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "account" ? (
              <SmartSelect
                mode="single"
                value={previewAccountSelectValue(accountValue, row.item._meta)}
                onChange={(selectedId) => {
                  updatePreviewRow(row.key, primaryAccountPatch(row.item, previewAccountValueFromSelect(selectedId)));
                  setEditingPreviewCell(null);
                }}
                options={previewAccountOptionsFor(accountValue, row.item._meta)}
                placeholder={t("statementImportPreview.selectAccount")}
                onCycleOwnerFilter={cycleOwnerFilter}
                ownerFilterLabel={ownerFilterLabel}
                behavior={{ search: true, hierarchy: true, clearable: true, cycleSelectionWithArrowKeys: true, minDropdownWidth: 216, fitContent: true, dropdownMaxHeight: 180, density: "micro", resizableDropdown: true, autoOpen: true, onDropdownClose: () => setEditingPreviewCell(null) }}
              />
            ) : (
              <span className="block min-h-5 w-full truncate cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={previewAccountDisplayTitle(accountValue, row.item._meta)}>
                {displayPreviewValue(previewAccountDisplayText(accountValue, row.item._meta))}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "counterAccount",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.counterAccount),
      width: 170,
      minWidth: 120,
      hideable: true,
      filterText: (row) => previewAccountDisplayText(counterAccountValue(row.item)) || t("batchImport.emptyValue"),
      render: (row) => {
        if (row.item.type !== "transfer") return <span className="text-slate-400">-</span>;
        const accountValue = counterAccountValue(row.item);
        return (
          <div className="min-w-[170px] text-slate-700" {...editableCellProps(row.key, "counterAccount")}>
            {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "counterAccount" ? (
              <SmartSelect
                mode="single"
                value={previewAccountSelectValue(accountValue)}
                onChange={(selectedId) => {
                  updatePreviewRow(row.key, counterAccountPatch(row.item, previewAccountValueFromSelect(selectedId)));
                  setEditingPreviewCell(null);
                }}
                options={previewAccountOptionsFor(accountValue)}
                placeholder={t("statementImportPreview.selectCounterAccount")}
                onCycleOwnerFilter={cycleOwnerFilter}
                ownerFilterLabel={ownerFilterLabel}
                behavior={{ search: true, hierarchy: true, clearable: true, cycleSelectionWithArrowKeys: true, minDropdownWidth: 216, fitContent: true, dropdownMaxHeight: 180, density: "micro", resizableDropdown: true, autoOpen: true, onDropdownClose: () => setEditingPreviewCell(null) }}
              />
            ) : (
              <span className="block min-h-5 w-full truncate cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={previewAccountDisplayTitle(accountValue)}>
                {displayPreviewValue(previewAccountDisplayText(accountValue))}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "category",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.category),
      width: 110,
      minWidth: 88,
      filterText: (row) => systemCategoryLabel(row.item.category, t) || t("batchImport.emptyValue"),
      render: (row) => (
        <div className="w-full min-w-0 truncate whitespace-nowrap text-slate-700" {...editableCellProps(row.key, "category")}>
          {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "category" ? (
            <div className="w-full min-w-0">
              <SmartSelect
                mode="single"
                value={previewCategorySelectValue(row.item.category, row.item.type)}
                onChange={(categoryId) => {
                  updatePreviewCategoryForMatchingRemarks(row.key, categoryId);
                  setEditingPreviewCell(null);
                }}
                options={previewCategorySmartSelectOptionsFor(row.item.type)}
                placeholder={t("statementImportPreview.selectCategory")}
                searchable
                behavior={{ ...CATEGORY_SMART_SELECT_BEHAVIOR, autoOpen: true, showGroupCounts: false, onDropdownClose: () => setEditingPreviewCell(null) }}
              />
            </div>
          ) : (
            <span className="block min-h-5 w-full cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.category) })}>{displayPreviewValue(systemCategoryLabel(row.item.category, t))}</span>
          )}
        </div>
      ),
    },
    {
      key: "institution",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.institution),
      width: 118,
      minWidth: 90,
      hideable: true,
      filterText: (row) => cleanText(row.item.institution || row.item.counterparty) || t("batchImport.emptyValue"),
      render: (row) => renderTextEditCell(row, "institution", cleanText(row.item.institution || row.item.counterparty), t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.institution) })),
    },
    {
      key: "inflow",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.inflow),
      width: 88,
      minWidth: 74,
      truncate: true,
      align: "right",
      filterKind: "numberRange",
      filterText: (row) => importPreviewFlowAmountTextFor(row.item, "inflow"),
      filterNumber: (row) => row.item.inflow ?? (row.item.type === "income" ? row.item.amount : 0),
      sortValue: (row) => row.item.inflow ?? (row.item.type === "income" ? row.item.amount : 0),
      render: (row) => (
        <div className="text-right" {...editableCellProps(row.key, "amount")}>
          {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "amount" && amountEditorSide(row.item) === "inflow" ? (
            renderAmountInput(row)
          ) : (
            <span className={`block min-h-5 w-full cursor-pointer whitespace-nowrap rounded px-1 py-0.5 tabular-nums hover:bg-slate-100 ${importPreviewFlowAmountColorFor(row.item, "inflow", colorScheme)}`} title={t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.amount) })}>
              {displayPreviewValue(importPreviewFlowAmountTextFor(row.item, "inflow"))}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "outflow",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.outflow),
      width: 88,
      minWidth: 74,
      truncate: true,
      align: "right",
      filterKind: "numberRange",
      filterText: (row) => importPreviewFlowAmountTextFor(row.item, "outflow"),
      filterNumber: (row) => row.item.outflow ?? (row.item.type === "expense" && !row.item.inflow ? row.item.amount : 0),
      sortValue: (row) => row.item.outflow ?? (row.item.type === "expense" && !row.item.inflow ? row.item.amount : 0),
      render: (row) => (
        <div className="text-right" {...editableCellProps(row.key, "amount")}>
          {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "amount" && amountEditorSide(row.item) === "outflow" ? (
            renderAmountInput(row)
          ) : (
            <span className={`block min-h-5 w-full cursor-pointer whitespace-nowrap rounded px-1 py-0.5 tabular-nums hover:bg-slate-100 ${importPreviewFlowAmountColorFor(row.item, "outflow", colorScheme)}`} title={t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.amount) })}>
              {displayPreviewValue(importPreviewFlowAmountTextFor(row.item, "outflow"))}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "remark",
      label: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.remark),
      width: 230,
      minWidth: 160,
      filterText: (row) => (row.item.remark || row.item.rawText || "").trim() || t("batchImport.emptyValue"),
      render: (row) => renderTextEditCell(row, "remark", row.item.remark || row.item.rawText || "", t("statementImportPreview.doubleClickEdit", { field: t(IMPORT_PREVIEW_FIELD_LABEL_KEYS.remark) })),
    },
    {
      key: "status",
      label: t("statementImportPreview.status"),
      width: 180,
      minWidth: 140,
      filterText: previewStatusText,
      render: (row) => {
        const statusText = previewStatusText(row);
        const creationStatus = row.ready ? previewCreationStatus(row) : null;
        if (creationStatus) {
          const className = creationStatus.kind === "debt"
            ? "rounded-full bg-violet-50 px-2 py-0.5 text-[11px] text-violet-700"
            : "rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700";
          return <span className={className} title={statusText}>{statusText}</span>;
        }
        return row.ready ? (
          <span className="text-[11px] text-slate-400">-</span>
        ) : (
          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700" title={statusText}>
            {statusText}
          </span>
        );
      },
    },
  ], [
    accountLookup,
    accountDisplayById,
    bookCategories,
    categoryById,
    colorScheme,
    createDebtAccounts,
    cycleOwnerFilter,
    defaultAccountName,
    displayAccountOptions,
    editingPreviewCell,
    forceCreateOwnedMoneyAccounts,
    language,
    ownerFilterLabel,
    rows,
    t,
    updatePreviewCategoryForMatchingRemarks,
  ]);

  const fallbackRows = rows;
  const fallbackSelectedKeys = selectedKeys;
  const previewReady = settingsBootstrapLoaded && rows.length > 0;

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 px-4 py-6">
      <div data-batch-popover-boundary data-smart-select-boundary className="flex h-[82vh] min-h-[420px] w-[72rem] min-w-0 max-w-[calc(100vw-2rem)] resize flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-800">{title}</div>
            {description ? <div className="mt-0.5 text-xs text-slate-500">{description}</div> : null}
          </div>
          <button
            type="button"
            className="h-8 w-8 rounded-md border border-slate-300 text-slate-500 hover:bg-white disabled:opacity-50"
            onClick={closeDialog}
            disabled={busy}
            aria-label={t("table.close")}
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1">
          {!settingsBootstrapLoaded ? (
            <div role="status" aria-live="polite" className="flex h-full items-center justify-center bg-white px-4">
              <div className="flex items-start gap-3 rounded-lg border border-blue-100 bg-blue-50/60 px-4 py-3 text-sm text-slate-700">
                <div className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />
                <div className="min-w-0">
                  <div className="font-medium text-slate-800">{t("batchImport.processingDataTitle")}</div>
                  <div className="mt-1 text-xs text-slate-500">{t("batchImport.processingDataHint")}</div>
                </div>
              </div>
            </div>
          ) : (
            <AdvancedDataTable
              storageKey="mmh_statement_import_preview_table_v2"
              columns={columns}
              rows={fallbackRows}
              rowKey={(row) => row.key}
              emptyText={t("batchImport.noRecordsForFilter")}
              minTableWidth={1180}
              selectable
              selectAllScope="renderedRows"
              rowSelectable={(row) => row.ready}
              selectedKeys={fallbackSelectedKeys}
              onSelectionChange={(keys) => {
                if (busy || !previewReady) return;
                const rowKeys = new Set(fallbackRows.filter((row) => row.ready).map((row) => row.key));
                setSelectedKeys(new Set(Array.from(keys).filter((key) => rowKeys.has(key))));
              }}
              batchActionSlot={(
                <BatchReplacePopoverButton
                  fields={previewReplaceFields}
                  targetCount={previewReady ? fallbackSelectedKeys.size : 0}
                  targetLabel={t("stockPanel.selected")}
                  panelAlign="left"
                  disabledTitle={t("statementImportPreview.selectRowsFirst")}
                  buttonTitle={t("statementImportPreview.batchEditSelected", { count: fallbackSelectedKeys.size })}
                  messageClassName="sr-only"
                  onApply={applyPreviewReplace}
                />
              )}
              toolbarTitle={t("statementImportPreview.previewTitle")}
              toolbarRightContent={(
                <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-slate-500">
                  <label className="inline-flex shrink-0 items-center gap-1.5 text-slate-600">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600"
                      checked={createDebtAccounts}
                      disabled={busy || !settingsBootstrapLoaded}
                      onChange={(event) => setCreateDebtAccounts(event.target.checked)}
                    />
                    <span>{t("statementImportPreview.createDebtAccounts")}</span>
                  </label>
                  <label className="inline-flex shrink-0 items-center gap-1.5 text-slate-600">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600"
                      checked={forceCreateOwnedMoneyAccounts}
                      disabled={busy || !settingsBootstrapLoaded}
                      onChange={(event) => setForceCreateOwnedMoneyAccounts(event.target.checked)}
                    />
                    <span>{t("statementImportPreview.forceCreateOwnedMoneyAccounts")}</span>
                  </label>
                  {statementInfoTexts.length > 0 ? <span>{t("statementImportPreview.statementInfo", { texts: statementInfoTexts.join(" / ") })}</span> : null}
                  <span>{t("batchImport.totalCount", { total: fallbackRows.length })}</span>
                  <span>{t("statementImportPreview.willImport", { count: fallbackSelectedKeys.size })}</span>
                </div>
              )}
              rowClassName={(row) => {
                const creationStatus = previewCreationStatus(row);
                if (creationStatus?.kind === "debt") return "bg-violet-50/70";
                if (creationStatus?.kind === "owned") return "bg-emerald-50/70";
                return fallbackSelectedKeys.has(row.key) ? "bg-blue-50/40" : row.ready ? "bg-white" : "bg-amber-50/40";
              }}
              fillHeight
              compactRows
              resetDisplayStateOnMount
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3 text-xs">
            <span className="shrink-0 text-slate-500">{t("statementImportPreview.willImport", { count: fallbackSelectedKeys.size })}</span>
            {categorySyncMessage ? <span className="truncate text-blue-600" title={categorySyncMessage}>{categorySyncMessage}</span> : null}
          </div>
          <div className="flex items-center justify-end">
            <button
              type="button"
              className="h-9 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={() => void confirmSelected()}
              disabled={busy || !previewReady || fallbackSelectedKeys.size === 0 || fallbackRows.some((row) => fallbackSelectedKeys.has(row.key) && !row.ready)}
            >
              {busy ? t("batchImport.importing") : t("batchImport.confirmImport", { count: fallbackSelectedKeys.size })}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
