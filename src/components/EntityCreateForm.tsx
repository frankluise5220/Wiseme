"use client";

import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState, useCallback, type FormEvent, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { kindOrder } from "@/lib/account-kinds";
import { PRODUCT_TYPES, supportsCostBasisMethod } from "@/lib/investment-config";
import { supportsTradingCalendarForAccount, TRADING_CALENDARS } from "@/lib/fund/trading-calendar";
import { DateStepper } from "@/components/DateStepper";
import { ModalLayerProvider, getNextModalLayerZIndex, useModalLayerZIndex } from "@/components/ModalLayer";
import { notifySmartSelectOptionCreated, SmartSelect, type SmartSelectOption } from "@/components/SmartSelect";
import { CurrencySmartSelect } from "@/components/CurrencySmartSelect";
import { notifySettingsDataChanged, type SettingsDataScope } from "@/lib/client/settingsCache";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { CURRENCY_OPTIONS, normalizeCurrency } from "@/lib/currency";
import {
  accountInstitutionTypeIsAllowed,
  accountRequiresInstitution,
  allowedInstitutionTypesForAccount,
  isConsumerLoanInstitutionType,
  isStockAccountInstitutionType,
  isStockInvestmentAccount,
} from "@/lib/account-institution-rules";
import { useI18n } from "@/lib/i18n";
import { FIXED_ASSET_TYPES, isFixedAssetAccountLike } from "@/lib/fixed-asset";
import { LOAN_TYPES } from "@/lib/loan-type";

/* ---- Types ---- */

type NestedEntityType = "institution" | "counterparty" | "account" | "group" | "category";

type EntityCreatedExtra = {
  parentId?: string;
  kind?: string;
  type?: string;
  groupId?: string;
  groupName?: string;
  institutionId?: string;
  institutionName?: string;
  institutionShortName?: string;
  counterpartyId?: string;
  counterpartyName?: string;
  debtDirection?: "payable" | "receivable" | null;
  loanType?: string | null;
  isConsumerLoan?: boolean | null;
  currency?: string;
  brokerageCashAccount?: {
    id: string;
    name: string;
    kind?: string | null;
    currency?: string | null;
    investProductType?: string | null;
    groupId?: string | null;
    institutionId?: string | null;
    AccountGroup?: { id?: string; name?: string | null } | null;
    Institution?: { id?: string; name?: string | null; shortName?: string | null; type?: string | null } | null;
  } | null;
};

type FieldDef = {
  key: string;
  labelKey: string;
  type: "text" | "select";
  placeholderKey?: string;
  /** Render text fields as a taller multiline textarea. */
  multiline?: boolean;
  /** Preferred textarea row count for multiline fields. */
  rows?: number;
  /** Static options (for selects whose values are fixed) */
  options?: ReadonlyArray<{ value: string; labelKey: string }>;
  /** Dynamic option key - maps to fieldData prop for runtime-populated selects */
  optionsFromData?: string;
  /** Condition to show/hide this field based on current form state */
  condition?: (form: Record<string, string>) => boolean;
  /** Default value when the form opens */
  defaultValue?: string;
  /** Whether this field supports nested inline creation (shows a "+ New" button) */
  nestedCreate?: NestedEntityType;
};

/* ---- Compact mode props (existing NestedAddModal behavior) ---- */

type CompactModeProps = {
  mode: "compact";
  entityType: NestedEntityType;
  open: boolean;
  onClose: () => void;
  onCreated: (id: string, name: string, extra?: EntityCreatedExtra) => void;
  /** Optional callback fired when a nested entity (e.g. institution/group) is
   *  created inside this form, so the parent can keep shared option data fresh. */
  onNestedCreated?: (id: string, name: string, extra?: { kind?: string; type?: string }) => void;
  defaultType?: string;
  /** Optional UI title override for reused entity concepts */
  title?: string;
  /** Optional name field label override */
  nameLabel?: string;
  /** Optional name field placeholder override */
  namePlaceholder?: string;
  /** Optional default name for compact create flows where the domain has a clear generated label */
  defaultName?: string;
  /** For institution creation: restrict type choices to a specific concept group */
  allowedInstitutionTypes?: string[];
  /** For account creation: restrict selectable account kinds (e.g. a cash-account
   *  field may only allow bank_debit and ewallet). When exactly one kind is
   *  allowed the type selector is hidden and the kind is locked. */
  allowedAccountKinds?: string[];
  /** Extra fields to merge into the POST body (e.g. { kind: "investment", investProductType: "fund" }) */
  extraFields?: Record<string, string>;
  /** Fields to hide from the form UI (e.g. ["kind"] when extraFields already specifies it) */
  hiddenFields?: string[];
  /** Extra fields that should remain visible for confirmation but not editable. */
  readOnlyFields?: string[];
  /** Existing entity names for client-side duplicate check */
  existingNames?: string[];
  /** For category type: available parent categories to create subcategories under */
  parentCategories?: Array<{ id: string; name: string; label: string; type: string; depth?: number; parentId?: string; isGroup?: boolean }>;
  /** For category type: pre-selected parent category */
  defaultParentId?: string;
  /** Pre-populated data for dynamic select fields (groups & institutions) in compact account creation */
  nestedFieldData?: Record<string, Array<{ id: string; name: string; type?: string }>>;
  /** When creating a non-investment account, also collect initial balance anchor data. */
  includeInitialBalanceFields?: boolean;
  /** For account creation: initial currency selected from the current ledger setting. */
  defaultCurrency?: string;
};

/* ---- Full mode props (new, for settings pages) ---- */

type FullModeProps = {
  mode: "full";
  entityType: NestedEntityType;
  /** Layout variant for full mode */
  layout?: "card" | "inline" | "modal";
  open?: boolean;
  onClose?: () => void;
  onCreated: (id: string, name: string, extra?: EntityCreatedExtra) => void;
  /** Optional callback fired when a nested entity (e.g. institution/group) is
   *  created inside this form, so the parent can keep shared option data fresh. */
  onNestedCreated?: (id: string, name: string, extra?: { kind?: string; type?: string }) => void;
  /** Dynamic data for select fields that need runtime-populated options */
  fieldData?: Record<string, Array<{ id: string; name: string; type?: string }>>;
  /** Existing entity names for client-side duplicate check */
  existingNames?: string[];
  /** For category: available parent categories */
  parentCategories?: Array<{ id: string; name: string; label: string; type: string; depth?: number; parentId?: string; isGroup?: boolean }>;
  /** For category: pre-selected parent */
  defaultParentId?: string;
  /** For account: pre-selected kind */
  defaultType?: string;
  /** Optional UI title override for reused entity concepts */
  title?: string;
  /** Optional name field label override */
  nameLabel?: string;
  /** Optional name field placeholder override */
  namePlaceholder?: string;
  /** Optional default name for create flows where the domain has a clear generated label */
  defaultName?: string;
  /** For institution pages: restrict type choices to a specific concept group */
  allowedInstitutionTypes?: string[];
  /** For account pages: restrict selectable account kinds (see CompactModeProps) */
  allowedAccountKinds?: string[];
  /** Extra fields to merge into POST body */
  extraFields?: Record<string, string>;
  /** Fields to hide from the form UI */
  hiddenFields?: string[];
  /** Extra fields that should remain visible for confirmation but not editable. */
  readOnlyFields?: string[];
  /** When creating a non-investment account, also collect initial balance anchor data. */
  includeInitialBalanceFields?: boolean;
  /** For account creation: initial currency selected from the current ledger setting. */
  defaultCurrency?: string;
};

export type EntityCreateFormProps = CompactModeProps | FullModeProps;

/* ---- Institution type options ---- */

const ALL_INSTITUTION_TYPES = [
  { value: "family_member", labelKey: "institution.type.family_member" },
  { value: "person", labelKey: "institution.type.person" },
  { value: "organization", labelKey: "institution.type.organization" },
  { value: "bank", labelKey: "institution.type.bank" },
  { value: "insurance", labelKey: "institution.type.insurance" },
  { value: "brokerage", labelKey: "institution.type.brokerage" },
  { value: "fund_company", labelKey: "institution.type.fund_company" },
  { value: "payment", labelKey: "institution.type.payment" },
  { value: "debt", labelKey: "institution.type.debt" },
  { value: "other", labelKey: "institution.type.other" },
];

const INSTITUTION_TYPES = ALL_INSTITUTION_TYPES.filter((option) => (
  option.value === "bank" ||
  option.value === "insurance" ||
  option.value === "brokerage" ||
  option.value === "fund_company" ||
  option.value === "payment" ||
  option.value === "other"
));

/* ---- Category type options ---- */

const CATEGORY_TYPES = [
  { value: "expense", labelKey: "transaction.type.expense" },
  { value: "income", labelKey: "transaction.type.income" },
  { value: "advance", labelKey: "txForm.advance" },
  { value: "transfer", labelKey: "transaction.type.transfer" },
  { value: "investment", labelKey: "account.kind.investment" },
];

/* ---- Cost basis method options ---- */

const COST_BASIS_OPTIONS = [
  { value: "moving_avg", labelKey: "settings.accounts.movingAverage" },
  { value: "fifo", labelKey: "settings.accounts.fifo" },
  { value: "lifo", labelKey: "settings.accounts.lifo" },
];

/* ---- Account kind options (from account-kinds.ts) ---- */

const ACCOUNT_KIND_OPTIONS = kindOrder
  .map((k) => ({ value: k, labelKey: `account.kind.${k}` }));

const LOAN_TYPE_OPTIONS = LOAN_TYPES.map((value) => ({
  value,
  labelKey: `loan.type.${value}`,
}));

/* ---- Investment product type options (from investment-config.ts) ---- */

const INVEST_PRODUCT_OPTIONS = PRODUCT_TYPES
  .filter((pt) => pt !== "deposit")
  .map((pt) => ({
    value: pt,
    labelKey: `investment.product.${pt}`,
  }));

/* ---- Fixed asset type options ---- */

const FIXED_ASSET_TYPE_OPTIONS = FIXED_ASSET_TYPES.map((value) => ({
  value,
  labelKey: `fixedAsset.type.${value}`,
}));

/* ---- Trading calendar options ---- */

const TRADING_CALENDAR_OPTIONS = TRADING_CALENDARS.map((value) => ({
  value,
  labelKey: `tradingCalendar.${value}`,
}));

/* ---- Currency options (labelKey per currency code) ---- */

const CURRENCY_OPTION_KEYS = CURRENCY_OPTIONS.map((option) => ({
  value: option.value,
  labelKey: `entityForm.currency.${option.value.toLowerCase()}`,
}));

/* ---- Credit bill mode options ---- */

const CREDIT_BILL_MODE_OPTIONS = [
  { value: "separate", labelKey: "entityForm.creditBillMode.separate" },
  { value: "consolidated", labelKey: "entityForm.creditBillMode.consolidated" },
];

/* ---- Credit repayment day mode options ---- */

const CREDIT_REPAYMENT_DAY_MODE_OPTIONS = [
  { value: "fixed", labelKey: "entityForm.repaymentDayMode.fixed" },
  { value: "offset", labelKey: "entityForm.repaymentDayMode.offset" },
];

/* ---- Credit billing day tx period options ---- */

const CREDIT_BILLING_DAY_TX_PERIOD_OPTIONS = [
  { value: "current", labelKey: "settings.accounts.billingDayTxPeriod.current" },
  { value: "next", labelKey: "settings.accounts.billingDayTxPeriod.next" },
];

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/* ---- ENTITY_CONFIG ---- */

const ENTITY_CONFIG = {
  institution: {
    titleKey: "settings.accounts.addInstitution",
    namePlaceholderKey: "settings.institutions.namePlaceholder",
    nameLabelKey: "settings.institutions.nameLabel",
    typeLabelKey: "entityForm.typeLabel",
    typeKey: "type",
    types: INSTITUTION_TYPES,
    apiPath: "/api/v1/institution",
    bodyKey: { name: "name", type: "type" },
    fullFields: [
      { key: "name", labelKey: "settings.institutions.nameLabel", type: "text", placeholderKey: "settings.institutions.namePlaceholder" },
      { key: "shortName", labelKey: "entityForm.shortNameLabel", type: "text", placeholderKey: "entityForm.institutionShortNamePlaceholder" },
      { key: "type", labelKey: "entityForm.typeLabel", type: "select", options: INSTITUTION_TYPES, defaultValue: "bank" },
    ] as FieldDef[],
  },
  counterparty: {
    titleKey: "txForm.addCounterparty",
    namePlaceholderKey: "entityForm.counterpartyNamePlaceholder",
    nameLabelKey: "entityForm.contactNameLabel",
    typeLabelKey: "entityForm.typeLabel",
    typeKey: "type",
    types: [
      { value: "person", labelKey: "institution.type.person" },
      { value: "organization", labelKey: "institution.type.organization" },
    ],
    apiPath: "/api/v1/counterparty",
    bodyKey: { name: "name", type: "type" },
    fullFields: [
      { key: "name", labelKey: "entityForm.contactNameLabel", type: "text", placeholderKey: "entityForm.counterpartyNamePlaceholder" },
      { key: "shortName", labelKey: "entityForm.shortNameLabel", type: "text", placeholderKey: "entityForm.optional" },
      { key: "type", labelKey: "entityForm.typeLabel", type: "select", options: [
        { value: "person", labelKey: "institution.type.person" },
        { value: "organization", labelKey: "institution.type.organization" },
      ], defaultValue: "person" },
    ] as FieldDef[],
  },
  account: {
    titleKey: "settings.accounts.add",
    namePlaceholderKey: "entityForm.accountNamePlaceholder",
    nameLabelKey: "entityForm.accountNameLabel",
    typeLabelKey: "entityForm.accountTypeLabel",
    typeKey: "kind",
    types: ACCOUNT_KIND_OPTIONS,
    apiPath: "/api/v1/accounts",
    bodyKey: { name: "name", kind: "kind" },
    fullFields: [
      { key: "name", labelKey: "entityForm.accountNameLabel", type: "text", placeholderKey: "entityForm.accountNamePlaceholder" },
      { key: "kind", labelKey: "entityForm.accountTypeLabel", type: "select", options: ACCOUNT_KIND_OPTIONS, defaultValue: "bank_debit" },
      { key: "fixedAssetType", labelKey: "fixedAssetEdit.assetType", type: "select", options: FIXED_ASSET_TYPE_OPTIONS, defaultValue: "property", condition: (f) => isFixedAssetAccountLike(f) },
      { key: "investProductType", labelKey: "settings.accounts.investmentAccountType", type: "select", options: INVEST_PRODUCT_OPTIONS, defaultValue: "fund", condition: (f) => f.kind === "investment" },
      { key: "fundUnitsDecimals", labelKey: "settings.accounts.fundUnitsDecimals", type: "text", defaultValue: "2", placeholderKey: "settings.accounts.defaultUnitsDecimals", condition: (f) => f.kind === "investment" && (f.investProductType ?? "fund") === "fund" },
      { key: "tradingCalendar", labelKey: "settings.accounts.tradingCalendar", type: "select", options: TRADING_CALENDAR_OPTIONS, defaultValue: "cn_fund", condition: (f) => supportsTradingCalendarForAccount(f.kind, f.investProductType ?? "fund") },
      { key: "groupId", labelKey: "settings.accounts.owner", type: "select", optionsFromData: "groupId", nestedCreate: "group" },
      {
        key: "institutionId",
        labelKey: "settings.accounts.institution",
        type: "select",
        optionsFromData: "institutionId",
        nestedCreate: "institution",
        condition: (f) => f.kind !== "settlement" && allowedInstitutionTypesForAccount(f.kind, f.investProductType ?? "fund").length > 0,
      },
      {
        key: "counterpartyId",
        labelKey: "txForm.counterparty",
        type: "select",
        optionsFromData: "counterpartyId",
        nestedCreate: "counterparty",
        condition: (f) => f.kind === "settlement",
      },
      { key: "loanType", labelKey: "settings.accounts.loanType", type: "select", options: LOAN_TYPE_OPTIONS, defaultValue: "home", condition: (f) => f.kind === "loan" },
      { key: "currency", labelKey: "detail.column.currency", type: "select", options: CURRENCY_OPTION_KEYS, defaultValue: "CNY" },
      { key: "billingDay", labelKey: "settings.accounts.billingDayLabel", type: "text", placeholderKey: "entityForm.dayRangePlaceholder", condition: (f) => f.kind === "bank_credit" },
      { key: "billingDayTxPeriod", labelKey: "settings.accounts.billingDayTxPeriodLabel", type: "select", options: CREDIT_BILLING_DAY_TX_PERIOD_OPTIONS, defaultValue: "current", condition: (f) => f.kind === "bank_credit" },
      { key: "repaymentDayMode", labelKey: "settings.accounts.repaymentDayModeLabel", type: "select", options: CREDIT_REPAYMENT_DAY_MODE_OPTIONS, defaultValue: "fixed", condition: (f) => f.kind === "bank_credit" },
      { key: "repaymentDay", labelKey: "settings.accounts.repaymentDayLabel", type: "text", placeholderKey: "entityForm.dayRangePlaceholder", condition: (f) => f.kind === "bank_credit" && f.repaymentDayMode !== "offset" },
      { key: "repaymentOffsetDays", labelKey: "settings.accounts.repaymentOffsetDaysLabel", type: "text", placeholderKey: "entityForm.repaymentOffsetDaysPlaceholder", condition: (f) => f.kind === "bank_credit" && f.repaymentDayMode === "offset" },
      { key: "creditLimit", labelKey: "settings.accounts.creditLimitLabel", type: "text", placeholderKey: "entityForm.creditLimitPlaceholder", condition: (f) => f.kind === "bank_credit" },
      { key: "creditBillMode", labelKey: "entityForm.creditBillModeLabel", type: "select", options: CREDIT_BILL_MODE_OPTIONS, defaultValue: "separate", condition: (f) => f.kind === "bank_credit" },
      { key: "numberMasked", labelKey: "settings.accounts.lastFourLabel", type: "text", placeholderKey: "entityForm.lastFourPlaceholder", condition: (f) => f.kind === "bank_credit" || f.kind === "bank_debit" },
      { key: "costBasisMethod", labelKey: "settings.accounts.costBasisMethod", type: "select", options: COST_BASIS_OPTIONS, defaultValue: "moving_avg", condition: (f) => f.kind === "investment" && supportsCostBasisMethod(f.investProductType ?? "fund") },
      { key: "note", labelKey: "detail.column.remark", type: "text", placeholderKey: "entityForm.notePlaceholder", multiline: true, rows: 4 },
    ] as FieldDef[],
  },
  group: {
    titleKey: "settings.accounts.addOwner",
    namePlaceholderKey: "settings.accounts.owner",
    nameLabelKey: "entityForm.groupNameLabel",
    typeLabelKey: null,
    typeKey: null,
    types: [],
    apiPath: "/api/v1/account-group",
    bodyKey: { name: "name" },
    fullFields: [
      { key: "name", labelKey: "entityForm.groupNameLabel", type: "text", placeholderKey: "settings.accounts.owner" },
    ] as FieldDef[],
  },
  category: {
    titleKey: "entityForm.categoryTitle",
    namePlaceholderKey: "entityForm.categoryNamePlaceholder",
    nameLabelKey: "entityForm.categoryNameLabel",
    typeLabelKey: "entityForm.typeLabel",
    typeKey: "type",
    types: CATEGORY_TYPES,
    apiPath: "/api/v1/category",
    bodyKey: { name: "name", type: "type" },
    fullFields: [
      { key: "name", labelKey: "entityForm.categoryNameLabel", type: "text", placeholderKey: "entityForm.categoryNamePlaceholder" },
      { key: "type", labelKey: "entityForm.typeLabel", type: "select", options: CATEGORY_TYPES, defaultValue: "expense",
        condition: (f) => !f.parentId /* hide type when parentId is set (inherits from parent) */ },
      { key: "parentId", labelKey: "entityForm.parentCategoryLabel", type: "select", optionsFromData: "parentId" },
    ] as FieldDef[],
  },
} as const;

/* ---- Helper: build select options for a dynamic field ---- */

type SelectOption = { value: string; label?: string; labelKey?: string };

function optionLabel(t: (key: string) => string, option: SelectOption) {
  return option.label ?? (option.labelKey ? t(option.labelKey) : "");
}

function buildSelectOptions(
  field: FieldDef,
  fieldData: Record<string, Array<{ id: string; name: string }>> | undefined,
  parentCategories: Array<{ id: string; name: string; label: string; type: string; depth?: number; parentId?: string; isGroup?: boolean }> | undefined,
  hideRootOption: boolean | undefined,
  t: (key: string) => string,
): SelectOption[] {
  if (field.options) return [...field.options];
  if (field.key === "parentId" && parentCategories) {
    const rootOpt = hideRootOption ? [] : [{ value: "", label: t("entityForm.noRootCategory") }];
    return [...rootOpt, ...parentCategories.map(pc => {
      // Use indentation for depth > 0 entries
      const indent = pc.depth && pc.depth > 0 ? "    ".repeat(pc.depth) : "";
      return { value: pc.id, label: `${indent}${pc.name}` };
    })];
  }
  if (field.optionsFromData && fieldData) {
    const data = fieldData[field.optionsFromData];
    if (data) {
      const emptyLabel = field.key === "groupId" ? t("settings.accounts.owner") : t("entityForm.none");
      return [{ value: "", label: emptyLabel }, ...data.map(d => ({ value: d.id, label: d.name }))];
    }
  }
  return [];
}

function getSmartSelectCreateLabel(t: (key: string) => string, entityType: NestedEntityType) {
  if (entityType === "institution") return t("settings.accounts.addInstitution");
  if (entityType === "counterparty") return t("txForm.addCounterparty");
  if (entityType === "group") return t("settings.accounts.addOwner");
  if (entityType === "category") return t("entityForm.categoryTitle");
  return t("entityForm.add");
}

function smartSelectPlaceholder(t: (key: string) => string, fieldKey: string) {
  if (fieldKey === "groupId") return t("settings.accounts.selectOwner");
  if (fieldKey === "counterpartyId") return t("debtTx.placeholder.selectCounterparty");
  if (fieldKey === "institutionId") return t("settings.accounts.selectInstitution");
  return t("txForm.selectPlaceholder");
}

function settingsScopeForEntity(entityType: NestedEntityType): SettingsDataScope {
  return entityType === "category" ? "categories" : "accounts";
}

function renderEntityCreatePortal(content: ReactNode) {
  if (typeof document === "undefined") return content;
  return createPortal(content, document.body);
}

/* ---- Main Component ---- */

export function EntityCreateForm(props: EntityCreateFormProps) {
  const { t } = useI18n();
  const parentModalZIndex = useModalLayerZIndex();
  const modalZIndex = getNextModalLayerZIndex(parentModalZIndex);
  const mode = props.mode;
  const entityType = props.entityType;
  const config = ENTITY_CONFIG[entityType];
  const layout = mode === "full" ? (props.layout ?? "card") : "modal";
  const displayTitle = props.title ?? t(config.titleKey);
  const displayNameLabel = props.nameLabel ?? t(config.nameLabelKey);
  const displayNamePlaceholder = props.namePlaceholder ?? t(config.namePlaceholderKey);
  const defaultName = props.defaultName ?? "";
  const includeInitialBalanceFields = entityType === "account" && Boolean(props.includeInitialBalanceFields);

  // Unpack mode-specific props
  const onCreated = props.onCreated;
  const onNestedCreated = props.onNestedCreated;
  const existingNames = props.existingNames;
  const extraFields = props.extraFields;
  const parentCategories = mode === "compact" ? props.parentCategories : props.parentCategories;
  const defaultParentId = mode === "compact" ? props.defaultParentId : props.defaultParentId ?? "";
  const fieldData = mode === "full" ? props.fieldData : undefined;
  const compactNestedFieldData = mode === "compact" ? props.nestedFieldData : undefined;
  const hiddenFields = mode === "compact" ? props.hiddenFields : props.hiddenFields ?? [];
  const readOnlyFields = mode === "compact" ? props.readOnlyFields ?? [] : props.readOnlyFields ?? [];
  const allowedInstitutionTypes =
    entityType === "institution" ? props.allowedInstitutionTypes : undefined;
  const allowedAccountKinds =
    entityType === "account" ? props.allowedAccountKinds : undefined;

  const accountKindOptions = useMemo(
    () => (entityType === "account" && allowedAccountKinds?.length
      ? config.types.filter((option) => allowedAccountKinds.includes(option.value))
      : config.types),
    [entityType, allowedAccountKinds, config.types],
  );

  // Compact mode: open/onClose
  const open = mode === "compact" ? props.open : undefined;
  const onClose = mode === "compact" ? props.onClose : undefined;
  const defaultType = props.defaultType;
  const typeKey = config.typeKey;

  /* ---- Form state ---- */
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dupWarning, setDupWarning] = useState("");

  // Full card mode: expanded state
  const [expanded, setExpanded] = useState(false);

  // Nested creation state (for full mode "+ New" buttons on dynamic select fields)
  const [nestedEntityType, setNestedEntityType] = useState<NestedEntityType | null>(null);
  const [nestedOpen, setNestedOpen] = useState(false);
  const [nestedFieldData, setNestedFieldData] = useState<Record<string, Array<{ id: string; name: string; type?: string }>>>(fieldData ?? compactNestedFieldData ?? {});
  // Set when a nested entity is created so the compact sync effect does not
  // re-initialize (and wipe) the form that just gained the new entity.
  const nestedCreatedRef = useRef(false);
  const hasAccountDefaultCurrency = entityType === "account" && String(props.defaultCurrency ?? "").trim() !== "";
  const accountDefaultCurrency = hasAccountDefaultCurrency ? normalizeCurrency(props.defaultCurrency) : "";
  const defaultValueForField = useCallback((field: FieldDef) => {
    if (entityType === "account" && field.key === "currency") return accountDefaultCurrency;
    return field.defaultValue ?? "";
  }, [accountDefaultCurrency, entityType]);
  const fallbackSelectValueForField = useCallback((field: FieldDef) => {
    if (entityType === "account" && field.key === "currency" && !accountDefaultCurrency && !(extraFields && field.key in extraFields)) {
      return "";
    }
    return field.options?.[0]?.value ?? "";
  }, [accountDefaultCurrency, entityType, extraFields]);
  const selectOptionsForField = useCallback((field: FieldDef) => {
    const opts = field.key === "type" && entityType === "institution" && allowedInstitutionTypes?.length
      ? ALL_INSTITUTION_TYPES.filter((option) => allowedInstitutionTypes.includes(option.value))
      : buildSelectOptions(field, nestedFieldData, parentCategories, undefined, t);
    if (entityType === "account" && field.key === "currency" && !accountDefaultCurrency && !(extraFields && field.key in extraFields)) {
      return [{ value: "", label: t("entityForm.ledgerDefaultCurrency") }, ...opts];
    }
    return opts;
  }, [accountDefaultCurrency, allowedInstitutionTypes, entityType, extraFields, nestedFieldData, parentCategories, t]);

  useEffect(() => {
    if (entityType !== "account" || form.kind !== "bank_credit" || !form.institutionId) return;
    let cancelled = false;
    fetch(`/api/v1/accounts/credit-card-defaults?institutionId=${encodeURIComponent(form.institutionId)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((result) => {
        if (cancelled || !result?.ok || !result.data) return;
        setForm((current) => {
          if (current.kind !== "bank_credit" || current.institutionId !== form.institutionId) return current;
          const offsetDays = result.data.repaymentOffsetDays == null ? "" : String(result.data.repaymentOffsetDays);
          return {
            ...current,
            billingDay: result.data.billingDay == null ? "" : String(result.data.billingDay),
            repaymentDay: result.data.repaymentDay == null ? "" : String(result.data.repaymentDay),
            repaymentOffsetDays: offsetDays,
            repaymentDayMode: offsetDays ? "offset" : "fixed",
            creditLimit: result.data.creditLimit == null ? "" : String(result.data.creditLimit),
            creditBillMode: result.data.creditBillMode === "consolidated" ? "consolidated" : "separate",
            billingDayTxPeriod: (result.data as { billingDayTxPeriod?: string }).billingDayTxPeriod === "next" ? "next" : "current",
          };
        });
      })
      .catch((error) => {
        console.warn("[account-create] failed to load credit-card institution defaults", error);
      });
    return () => {
      cancelled = true;
    };
  }, [entityType, form.institutionId, form.kind]);

  /** Get default type for compact mode */
  const getDefaultTypeCompact = useCallback((): string => {
    const typeKey = config.typeKey;
    if (extraFields && typeKey && extraFields[typeKey]) {
      if (config.types.some(t => t.value === extraFields[typeKey])) {
        if (!allowedAccountKinds?.length || allowedAccountKinds.includes(extraFields[typeKey])) return extraFields[typeKey];
      }
    }
    if (defaultType && config.types.some(t => t.value === defaultType)) {
      if (!allowedAccountKinds?.length || allowedAccountKinds.includes(defaultType)) return defaultType;
    }
    if (entityType === "institution") return allowedInstitutionTypes?.[0] ?? "bank";
    if (entityType === "counterparty") return "person";
    if (entityType === "category") return "expense";
    if (entityType === "account") {
      if (allowedAccountKinds?.length) return allowedAccountKinds[0];
      return "bank_debit";
    }
    return "";
  }, [config.typeKey, config.types, defaultType, entityType, extraFields, allowedAccountKinds, allowedInstitutionTypes]);

  /** Initialize form state */
  const initForm = useCallback(() => {
    const initial: Record<string, string> = {};

    if (mode === "compact") {
      initial.name = defaultName;
      if (typeKey) initial[typeKey] = getDefaultTypeCompact();
      if (defaultParentId) initial.parentId = defaultParentId ?? "";
      if (extraFields) {
        Object.entries(extraFields).forEach(([k, v]) => {
          if (v !== undefined) initial[k] = v;
        });
      }
      for (const field of config.fullFields) {
        if (field.condition && !field.condition(initial)) continue;
        if (initial[field.key] !== undefined) continue;
        if (field.key === "type" && entityType === "institution" && allowedInstitutionTypes?.length) {
          initial[field.key] = allowedInstitutionTypes.includes(field.defaultValue ?? "")
            ? field.defaultValue!
            : allowedInstitutionTypes[0];
          continue;
        }
        if (field.key === "kind" && entityType === "account" && allowedAccountKinds?.length) {
          initial[field.key] = allowedAccountKinds.includes(field.defaultValue ?? "")
            ? field.defaultValue!
            : allowedAccountKinds[0];
          continue;
        }
        const fieldDefaultValue = defaultValueForField(field);
        if (fieldDefaultValue) initial[field.key] = fieldDefaultValue;
        if (field.optionsFromData) initial[field.key] = "";
        if (field.type === "select" && !fieldDefaultValue && !field.optionsFromData) initial[field.key] = fallbackSelectValueForField(field);
        if (field.type === "text" && !fieldDefaultValue) initial[field.key] = "";
      }
    } else {
      // Full mode: set parentId first so type condition can evaluate correctly
      if (defaultName) initial.name = defaultName;
      if (defaultParentId) initial.parentId = defaultParentId;
      // All fields from fullFields
      for (const field of config.fullFields) {
        // Check condition - now parentId is set if defaultParentId was provided
        if (field.condition && !field.condition(initial)) continue;
        // Skip if the key is already set (e.g. parentId from defaultParentId)
        if (initial[field.key] !== undefined) continue;
        // Default value
        const fieldDefaultValue = defaultValueForField(field);
        if (fieldDefaultValue) initial[field.key] = fieldDefaultValue;
        // For dynamic selects, default to empty
        if (field.optionsFromData) initial[field.key] = "";
        // For conditional selects without defaultValue, set to empty
        if (field.type === "select" && !fieldDefaultValue && !field.optionsFromData) initial[field.key] = fallbackSelectValueForField(field);
        // For text fields without defaultValue, set to empty
        if (field.type === "text" && !fieldDefaultValue) initial[field.key] = "";
      }
      // Apply defaultType override
      if (defaultType && typeKey) initial[typeKey] = defaultType;
      if (
        entityType === "institution" &&
        typeKey &&
        allowedInstitutionTypes?.length &&
        !allowedInstitutionTypes.includes(initial[typeKey] ?? "")
      ) {
        initial[typeKey] = allowedInstitutionTypes[0];
      }
      if (
        entityType === "account" &&
        typeKey &&
        allowedAccountKinds?.length &&
        !allowedAccountKinds.includes(initial[typeKey] ?? "")
      ) {
        initial[typeKey] = allowedAccountKinds[0];
      }
      // Apply extraFields
      if (extraFields) {
        Object.entries(extraFields).forEach(([k, v]) => {
          if (v !== undefined) initial[k] = v;
        });
      }
    }

    if (includeInitialBalanceFields && entityType === "account") {
      initial.initialBalanceDate = todayStr();
      initial.initialBalance = "";
    }

    setForm(initial);
    setSaving(false);
    setError("");
    setDupWarning("");
  }, [mode, defaultName, defaultType, extraFields, defaultParentId, typeKey, config.fullFields, getDefaultTypeCompact, entityType, allowedInstitutionTypes, allowedAccountKinds, includeInitialBalanceFields, defaultValueForField, fallbackSelectValueForField]);

  useEffect(() => {
    if (mode !== "compact") return;
    if (open) {
      // When a nested entity was just created, keep the current form state
      // (including the newly selected entity) instead of re-initializing it.
      // The flag must survive across renders: creating a nested entity fires
      // notifySettingsDataChanged, and the parent's async refresh lands later
      // as a nestedFieldData prop change. Clearing the flag on every render
      // would let that late refresh wipe the user's input.
      if (!nestedCreatedRef.current) initForm();
      nestedCreatedRef.current = false;
      // Sync nestedFieldData with compact prop changes
      if (compactNestedFieldData) setNestedFieldData(compactNestedFieldData);
    } else {
      // Reset on close so a lingering flag never suppresses initialization
      // of the next open.
      nestedCreatedRef.current = false;
    }
  }, [mode, open, initForm, compactNestedFieldData]);

  useEffect(() => {
    if (mode === "full") {
      initForm();
      // Sync nestedFieldData with fieldData changes
      if (fieldData) setNestedFieldData(fieldData);
    }
  }, [mode, initForm, fieldData]);

  /** Determine if the type selector should be shown in compact mode */
  const shouldHideType = !typeKey
    || (hiddenFields?.includes(typeKey))
    || (extraFields && typeKey in extraFields)
    || (entityType === "account" && allowedAccountKinds?.length === 1)
    || (entityType === "category" && form.parentId);
  const compactVisibleFields = config.fullFields.filter((field) => {
    if (field.key === "name" || field.key === typeKey || field.key === "parentId") return false;
    if (field.condition && !field.condition(form)) return false;
    if (hiddenFields?.includes(field.key)) return false;
    if (extraFields && field.key in extraFields && !readOnlyFields.includes(field.key)) return false;
    return true;
  });

  /** Client-side duplicate name check */
  function checkDuplicate(nameValue: string) {
    if (!existingNames || !nameValue.trim()) { setDupWarning(""); return; }
    const trimmed = nameValue.trim();
    if (existingNames.some(n => n.trim() === trimmed)) {
      setDupWarning(t("entityForm.dupWarning", { name: trimmed }));
    } else {
      setDupWarning("");
    }
  }

  function filterInstitutionDataForAccount(dataList: Array<{ id: string; name: string; type?: string }>) {
    if (entityType !== "account") return dataList;
    const accountKind = form.kind || form.type || extraFields?.kind || defaultType;
    const investProductType = form.investProductType || extraFields?.investProductType || "fund";
    if (isStockInvestmentAccount(accountKind, investProductType)) {
      return dataList.filter((item) => isStockAccountInstitutionType(item.type));
    }
    return dataList.filter((item) => accountInstitutionTypeIsAllowed(accountKind, investProductType, item.type));
  }

  function institutionTypeMatchesCurrentAccount(type?: string) {
    if (entityType !== "account") return true;
    const accountKind = form.kind || form.type || extraFields?.kind || defaultType;
    const investProductType = form.investProductType || extraFields?.investProductType || "fund";
    if (isStockInvestmentAccount(accountKind, investProductType)) {
      return isStockAccountInstitutionType(type);
    }
    if (accountKind === "loan") {
      return isConsumerLoanInstitutionType(type);
    }
    return accountInstitutionTypeIsAllowed(accountKind, investProductType, type);
  }

  function nestedInstitutionDefaultType() {
    if (entityType !== "account" || nestedEntityType !== "institution") return undefined;
    const accountKind = form.kind || form.type || extraFields?.kind || defaultType;
    const investProductType = form.investProductType || extraFields?.investProductType || "fund";
    const allowedTypes = allowedInstitutionTypesForAccount(accountKind, investProductType);
    if (isStockInvestmentAccount(accountKind, investProductType)) return "brokerage";
    if (accountKind === "investment" && (investProductType === "fund" || investProductType === "money")) return "fund_company";
    if (accountKind === "loan") return "bank";
    if (allowedTypes.length === 1) return allowedTypes[0];
    return undefined;
  }

  function nestedInstitutionAllowedTypes() {
    if (entityType !== "account" || nestedEntityType !== "institution") return undefined;
    const accountKind = form.kind || form.type || extraFields?.kind || defaultType;
    const investProductType = form.investProductType || extraFields?.investProductType || "fund";
    if (isStockInvestmentAccount(accountKind, investProductType)) return ["brokerage"];
    if (accountKind === "loan") return ["bank", "payment", "other"];
    const allowedTypes = allowedInstitutionTypesForAccount(accountKind, investProductType);
    return allowedTypes.length > 0 ? allowedTypes : undefined;
  }

  const shouldShowInitialBalanceFields =
    includeInitialBalanceFields &&
    entityType === "account" &&
    (form.kind || form.type || defaultType) !== "investment" &&
    (form.kind || form.type || defaultType) !== "fixed_asset";
  function renderInitialBalanceFields() {
    if (!shouldShowInitialBalanceFields) return null;
    return (
      <>
        <div>
          <label className="form-label mb-1 block">{t("entityForm.initialBalanceDateLabel")}</label>
          <DateStepper
            value={form.initialBalanceDate || todayStr()}
            onChange={(value) => setForm((prev) => ({ ...prev, initialBalanceDate: value }))}
          />
        </div>
        <div>
          <label className="form-label mb-1 block">{t("detail.column.balance")}</label>
          <input
            value={form.initialBalance ?? ""}
            onChange={(event) => setForm((prev) => ({ ...prev, initialBalance: event.target.value }))}
            placeholder={t("entityForm.balancePlaceholder")}
            className="form-input text-right tabular-nums"
            inputMode="decimal"
          />
        </div>
      </>
    );
  }

  function textFieldPlaceholder(field: FieldDef) {
    return field.key === "name" ? displayNamePlaceholder : (field.placeholderKey ? t(field.placeholderKey) : "");
  }

  function textFieldInputMode(field: FieldDef) {
    return field.key === "billingDay" || field.key === "repaymentDay" || field.key === "repaymentOffsetDays" ? "numeric" : undefined;
  }

  function textFieldClassName(field: FieldDef, className = "", readOnly = false) {
    return [
      "form-input",
      field.multiline ? "min-h-[96px] resize-y leading-5" : "",
      readOnly ? "bg-slate-50 text-slate-500" : "",
      className,
    ].filter(Boolean).join(" ");
  }

  function textFieldWrapperClassName(field: FieldDef, className = "") {
    return [
      field.multiline ? "col-span-2 md:col-span-4" : "",
      className,
    ].filter(Boolean).join(" ");
  }

  function renderTextControl(
    field: FieldDef,
    options?: {
      className?: string;
      readOnly?: boolean;
      required?: boolean;
      placeholder?: string;
    },
  ) {
    const readOnly = options?.readOnly ?? false;
    const value = form[field.key] ?? defaultValueForField(field);
    const placeholder = options?.placeholder ?? textFieldPlaceholder(field);
    const onChange = (value: string) => {
      if (readOnly) return;
      setForm((prev) => ({ ...prev, [field.key]: value }));
    };

    if (field.multiline) {
      return (
        <textarea
          key={field.key}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={textFieldClassName(field, options?.className, readOnly)}
          rows={field.rows ?? 4}
          readOnly={readOnly}
          required={options?.required}
        />
      );
    }

    return (
      <input
        key={field.key}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={textFieldClassName(field, options?.className, readOnly)}
        inputMode={textFieldInputMode(field)}
        readOnly={readOnly}
        required={options?.required}
      />
    );
  }

  function selectFieldPatch(field: FieldDef, value: string, current: Record<string, string>) {
    const patch: Record<string, string> = { [field.key]: value };
    if (field.key === "kind") {
      patch.institutionId = "";
      patch.counterpartyId = "";
      patch.loanType = value === "loan" ? (current.loanType || "home") : "";
      patch.isConsumerLoan = value === "loan" && current.loanType === "consumer" ? "true" : "false";
    }
    if (field.key === "loanType") {
      patch.isConsumerLoan = value === "consumer" ? "true" : "false";
    }
    if (field.key === "investProductType") {
      const accountKind = current.kind || current.type || extraFields?.kind || defaultType;
      if (isStockInvestmentAccount(accountKind, value)) {
        const selectedInstitution = (nestedFieldData.institutionId ?? []).find((item) => item.id === current.institutionId);
        if (!selectedInstitution || !isStockAccountInstitutionType(selectedInstitution.type)) {
          patch.institutionId = "";
        }
      }
    }
    return patch;
  }

  /** Build the POST body and submit */
  async function onSubmit(e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    const name = form.name ?? "";
    if (saving || !name.trim()) return;
    // In compact mode for category: parentId is required (cannot create root category directly)
    if (mode === "compact" && entityType === "category" && parentCategories && parentCategories.length > 0 && !form.parentId) {
      setError(t("entityForm.selectParentCategory"));
      return;
    }
    if (entityType === "account" && isStockInvestmentAccount(form.kind || extraFields?.kind || defaultType, form.investProductType || extraFields?.investProductType || "fund")) {
      const selectedInstitution = (nestedFieldData.institutionId ?? []).find((item) => item.id === form.institutionId);
      if (!form.institutionId || (selectedInstitution && !isStockAccountInstitutionType(selectedInstitution.type))) {
        setError(t("entityForm.error.stockAccountInstitution"));
        return;
      }
    }
    if (entityType === "account") {
      const accountKind = form.kind || extraFields?.kind || defaultType;
      const investProductType = form.investProductType || extraFields?.investProductType || "fund";
      const selectedInstitution = (nestedFieldData.institutionId ?? []).find((item) => item.id === form.institutionId);
      if (accountKind === "settlement" && !form.counterpartyId) {
        setError(t("debtTx.placeholder.selectCounterparty"));
        return;
      }
      if (accountKind === "loan" && !form.institutionId) {
        setError(t("settings.accounts.import.institutionRequired"));
        return;
      }
      if (accountRequiresInstitution(accountKind, investProductType) && !form.institutionId) {
        setError(t("settings.accounts.import.institutionRequired"));
        return;
      }
      if (form.institutionId && !accountInstitutionTypeIsAllowed(accountKind, investProductType, selectedInstitution?.type)) {
        setError(t("settings.accounts.import.institutionNotAllowed"));
        return;
      }
    }
    if (shouldShowInitialBalanceFields && form.initialBalance?.trim()) {
      const initialBalance = Number(form.initialBalance);
      if (!Number.isFinite(initialBalance)) {
        setError(t("entityForm.error.invalidBalance"));
        return;
      }
    }
    setSaving(true);
    setError("");
    try {
      const body: Record<string, string> = {};
      for (const field of config.fullFields) {
        if (field.condition && !field.condition(form)) continue;
        const val = field.key === "name" ? name.trim() : form[field.key];
        if (val !== undefined && val !== "") {
          body[field.key] = val;
        }
      }
      if (extraFields) {
        Object.entries(extraFields).forEach(([k, v]) => {
          if (v !== undefined && v !== "") body[k] = v;
        });
      }
      if (entityType === "account" && body.kind === "fixed_asset") {
        body.kind = "investment";
        body.investProductType = "property";
        body.institutionId = "";
        body.fixedAssetType = form.fixedAssetType || "property";
      }
      if (entityType === "account" && body.kind === "settlement") {
        body.institutionId = "";
        body.loanType = "";
        body.isConsumerLoan = "false";
      }
      if (entityType === "account" && body.kind === "loan") {
        body.counterpartyId = "";
        body.loanType = body.loanType || "home";
        body.isConsumerLoan = body.loanType === "consumer" ? "true" : "false";
      }
      if (shouldShowInitialBalanceFields && form.initialBalance?.trim()) {
        body.initialBalance = form.initialBalance.trim();
        body.initialBalanceDate = form.initialBalanceDate || todayStr();
      }

      const res = await fetch(config.apiPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      const responseKey = entityType;
      if (data.ok && data[responseKey]?.id) {
        const created = data[responseKey];
        const selectedTypeValue = typeKey ? (form[typeKey] || created[typeKey] || "") : "";
        notifySmartSelectOptionCreated({
          id: created.id,
          label: created.shortName?.trim?.() || created.name,
          subLabel: entityType === "account"
            ? (created.AccountGroup?.name || (created.kind ? t(`account.kind.${created.kind}`) : undefined))
            : entityType === "institution"
              ? t(`institution.type.${selectedTypeValue || created.type || "other"}`)
              : entityType === "counterparty"
                ? t(selectedTypeValue === "person" ? "institution.type.person" : "institution.type.organization")
              : undefined,
        });
        void notifySettingsDataChanged({
          scope: settingsScopeForEntity(entityType),
          reason: `${entityType}:create`,
          prefetch: true,
        });
        if (entityType === "account" && shouldShowInitialBalanceFields && form.initialBalance?.trim() && Number(form.initialBalance) !== 0) {
          dispatchFinanceDataChanged({ reason: "account-initial-balance:create", accountIds: [created.id] });
        }
        onCreated(created.id, created.name, {
          parentId: form.parentId || undefined,
          kind: entityType === "account" ? (form.kind || created.kind || "") : undefined,
          groupId: entityType === "account" ? created.groupId ?? form.groupId ?? undefined : undefined,
          groupName: entityType === "account" ? created.AccountGroup?.name : undefined,
          institutionId: entityType === "account" ? created.institutionId ?? form.institutionId ?? undefined : undefined,
          institutionName: entityType === "account" ? created.Institution?.name : undefined,
          institutionShortName: entityType === "account" ? created.Institution?.shortName : undefined,
          counterpartyId: entityType === "account" ? created.counterpartyId ?? form.counterpartyId ?? undefined : undefined,
          counterpartyName: entityType === "account" ? created.Counterparty?.name : undefined,
          debtDirection: entityType === "account" ? created.debtDirection ?? undefined : undefined,
          loanType: entityType === "account" ? created.loanType ?? form.loanType ?? undefined : undefined,
          isConsumerLoan: entityType === "account" ? created.isConsumerLoan ?? form.isConsumerLoan === "true" : undefined,
          currency: entityType === "account" ? created.currency ?? form.currency ?? undefined : undefined,
          brokerageCashAccount: entityType === "account" ? data.brokerageCashAccount ?? null : undefined,
          type: entityType === "institution" || entityType === "counterparty" || entityType === "category" ? selectedTypeValue : undefined,
        });
        // Reset form
        if (mode === "compact") {
          onClose?.();
        } else {
          // Full mode: close the surrounding surface and re-init form.
          if (layout === "modal") props.onClose?.();
          else setExpanded(false);
          initForm();
        }
      } else {
        setError(data.error ?? t("txForm.createFailed"));
      }
    } catch {
      setError(t("entityForm.error.networkError"));
    } finally {
      setSaving(false);
    }
  }

  /** Handle nested entity creation (e.g., "+ New Institution" inside the account full form) */
  function handleNestedCreated(id: string, name: string, extra?: { kind?: string; type?: string }) {
    // Add the newly created entity to the nested field data
    if (nestedEntityType === "institution") {
      setNestedFieldData(prev => ({
        ...prev,
        institutionId: [...(prev.institutionId ?? []), { id, name, type: extra?.type }],
      }));
      if (institutionTypeMatchesCurrentAccount(extra?.type)) {
        setForm(prev => ({ ...prev, institutionId: id }));
      }
    } else if (nestedEntityType === "group") {
      setNestedFieldData(prev => ({
        ...prev,
        groupId: [...(prev.groupId ?? []), { id, name }],
      }));
      setForm(prev => ({ ...prev, groupId: id }));
    } else if (nestedEntityType === "counterparty") {
      setNestedFieldData(prev => ({
        ...prev,
        counterpartyId: [...(prev.counterpartyId ?? []), { id, name, type: extra?.type }],
      }));
      setForm(prev => ({ ...prev, counterpartyId: id }));
    }
    // Notify the parent so shared option data stays fresh across dialog instances.
    onNestedCreated?.(id, name, extra);
    // Keep the current form (with the newly selected entity) on the next sync.
    nestedCreatedRef.current = true;
    setNestedOpen(false);
    setNestedEntityType(null);
  }

  /* ---- RENDER: Compact mode (modal) ---- */
  if (mode === "compact") {
    if (!open) return null;

    return renderEntityCreatePortal(
      <ModalLayerProvider value={modalZIndex}>
        <div className="app-modal-backdrop" style={{ zIndex: modalZIndex }}>
          <div className="app-modal-panel max-w-sm">
            <div className="modal-header">
              <div className="text-sm font-semibold text-slate-800">{displayTitle}</div>
              <button type="button" onClick={onClose}
                className="secondary-button h-8 px-2">
                {t("entityForm.close")}
              </button>
            </div>
            <form className="p-4 space-y-3" onSubmit={onSubmit}>
              <div className="space-y-1">
                <div className="form-label">{displayNameLabel}</div>
                <input
                  value={form.name ?? ""}
                  onChange={(e) => { setForm(prev => ({ ...prev, name: e.target.value })); checkDuplicate(e.target.value); }}
                  placeholder={displayNamePlaceholder}
                  className="form-input"
                  autoFocus
                  required
                />
                {dupWarning && <div className="text-xs text-amber-600">{dupWarning}</div>}
              </div>
              {!shouldHideType && config.typeLabelKey && accountKindOptions.length > 0 && (
                <div className="space-y-1">
                  <div className="form-label">{t(config.typeLabelKey)}</div>
                  <select
                    value={(typeKey ? form[typeKey] : "") ?? ""}
                    onChange={(e) => setForm(prev => ({ ...prev, ...(typeKey ? { [typeKey]: e.target.value } : {}), institutionId: "" }))}
                    className="form-input"
                  >
                    {accountKindOptions.map((typeOption) => (
                      <option key={typeOption.value} value={typeOption.value}>{optionLabel(t, typeOption)}</option>
                    ))}
                  </select>
                </div>
              )}
              {compactVisibleFields.map((field) => {
                const isReadOnlyField = readOnlyFields.includes(field.key);
                if (field.type === "text") {
                  return (
                    <div key={field.key} className="space-y-1">
                      <div className="form-label">{t(field.labelKey)}</div>
                      {renderTextControl(field, { readOnly: isReadOnlyField })}
                    </div>
                  );
                }

                const opts = selectOptionsForField(field);
                if (opts.length === 0 && !field.optionsFromData) return null;

                if (field.optionsFromData && field.nestedCreate) {
                  const dataKey = field.optionsFromData;
                  const dataList = field.key === "institutionId"
                    ? filterInstitutionDataForAccount(nestedFieldData[dataKey] ?? [])
                    : nestedFieldData[dataKey] ?? [];
                  const ssOptions: SmartSelectOption[] = field.key === "institutionId"
                    ? dataList.map((item) => ({
                        id: item.id,
                        label: item.name,
                        subLabel: t(`institution.type.${item.type || "other"}`),
                      }))
                    : dataList.map((item) => ({
                        id: item.id,
                        label: item.name,
                      }));
                  const selectPlaceholder = smartSelectPlaceholder(t, field.key);
                  if (isReadOnlyField) {
                    const label = ssOptions.find((option) => option.id === (form[field.key] ?? ""))?.label
                      || (form[field.key] ? t("entityForm.specified") : selectPlaceholder);
                    return (
                      <div key={field.key} className="space-y-1">
                        <div className="form-label">{t(field.labelKey)}</div>
                        <div className="flex h-9 items-center rounded-[10px] border border-slate-200 bg-slate-50 px-3 text-sm text-slate-500">
                          {label}
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={field.key} className="space-y-1">
                      <div className="form-label">{t(field.labelKey)}</div>
                      <SmartSelect
                        mode="single"
                        value={form[field.key] ?? defaultValueForField(field)}
                        onChange={(id) => setForm((prev) => ({ ...prev, [field.key]: id }))}
                        options={ssOptions}
                        placeholder={selectPlaceholder}
                        searchable={field.key === "institutionId"}
                        onCreateClick={() => { setNestedEntityType(field.nestedCreate!); setNestedOpen(true); }}
                        createLabel={getSmartSelectCreateLabel(t, field.nestedCreate)}
                      />
                    </div>
                  );
                }

                // Currency uses SmartSelect with system + user-added currencies.
                if (field.key === "currency" && field.type === "select") {
                  const current = form[field.key] ?? defaultValueForField(field);
                  return (
                    <div key={field.key} className="space-y-1">
                      <div className="form-label">{t(field.labelKey)}</div>
                      {isReadOnlyField ? (
                        <div className="form-input flex h-9 items-center bg-slate-50 text-slate-500">
                          {current ? t(`entityForm.currency.${String(current).toLowerCase()}`, { defaultValue: current }) : t("entityForm.ledgerDefaultCurrency")}
                        </div>
                      ) : (
                        <CurrencySmartSelect
                          value={current}
                          onChange={(id) => setForm((prev) => ({
                            ...prev,
                            ...selectFieldPatch(field, id, prev),
                          }))}
                          labelSystem={(code) => t(`entityForm.currency.${code.toLowerCase()}`, { defaultValue: code })}
                        />
                      )}
                    </div>
                  );
                }

                return (
                  <div key={field.key} className="space-y-1">
                    <div className="form-label">{t(field.labelKey)}</div>
                    <select
                      value={form[field.key] ?? defaultValueForField(field)}
                      onChange={(e) => setForm((prev) => ({
                        ...prev,
                        ...selectFieldPatch(field, e.target.value, prev),
                      }))}
                      className={`form-input ${isReadOnlyField ? "bg-slate-50 text-slate-500" : ""}`}
                      disabled={isReadOnlyField}
                    >
                      {(field.key === "type" && entityType === "institution" && allowedInstitutionTypes?.length
                        ? opts.filter((option) => allowedInstitutionTypes.includes(option.value))
                        : opts
                      ).map((option) => (
                        <option key={option.value} value={option.value}>{optionLabel(t, option)}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
              {renderInitialBalanceFields()}
              {/* Parent category selector - only for category entityType when parentCategories provided */}
              {entityType === "category" && parentCategories && parentCategories.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-foreground/60">{t("entityForm.parentCategoryLabel")}</div>
                  <SmartSelect
                    mode="single"
                    value={form.parentId ?? ""}
                    onChange={(id) => setForm(prev => ({ ...prev, parentId: id }))}
                    options={parentCategories.map(pc => {
                      // Every real category can be selected as a parent. Categories
                      // with children are still collapsible groups in the dropdown.
                      const indent = pc.depth && pc.depth > 0 ? "  ".repeat(pc.depth) : "";
                      return {
                        id: pc.id,
                        label: `${indent}${pc.name}`,
                        isGroup: pc.isGroup,
                        parentId: pc.parentId || undefined,
                      };
                    })}
                    placeholder={t("entityForm.selectParentCategory")}
                    behavior={{
                      hierarchy: true,
                      search: true,
                      selectableGroups: true,
                      groupSelectOnDoubleClick: false,
                    }}
                  />
                </div>
              )}
              {/* Hidden inputs for extraFields */}
              {extraFields && Object.entries(extraFields).map(([k, v]) => (
                k !== typeKey ? <input key={k} type="hidden" name={k} value={v} /> : null
              ))}
              {error && <div className="text-xs text-red-500">{error}</div>}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={onClose}
                  className="secondary-button h-9 px-3">
                  {t("common.cancel")}
                </button>
                <button type="submit" disabled={saving || !(form.name?.trim())}
                  className="primary-button h-9 disabled:opacity-50">
                  {saving ? t("entityForm.saving") : t("common.save")}
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* Nested creation modals (for group/institution inside account compact mode) */}
        {nestedEntityType && nestedOpen && (
          <EntityCreateForm
            mode="compact"
            entityType={nestedEntityType}
            open={nestedOpen}
            onClose={() => { setNestedOpen(false); setNestedEntityType(null); }}
            onCreated={handleNestedCreated}
            defaultType={nestedInstitutionDefaultType()}
            allowedInstitutionTypes={nestedInstitutionAllowedTypes()}
          />
        )}
      </ModalLayerProvider>
    );
  }

  /* ---- RENDER: Full mode ---- */

  const visibleFields = config.fullFields.filter(field => {
    if (field.condition && !field.condition(form)) return false;
    if (hiddenFields?.includes(field.key)) return false;
    if (extraFields && field.key in extraFields && field.key !== "name") return false;
    return true;
  });

  if (layout === "inline") {
    /* ---- Inline layout: compact row form ---- */
    return (
      <>
        <form className="flex items-center gap-2" onSubmit={onSubmit}>
          {visibleFields.map(field => {
            if (field.type === "text") {
              return renderTextControl(field, {
                className: field.multiline ? "min-w-[240px]" : "flex-1 min-w-[120px]",
                placeholder: field.key === "name" ? displayNamePlaceholder : (field.placeholderKey ? t(field.placeholderKey) : t(field.labelKey)),
                required: field.key === "name",
              });
            }
            // Select field
            const opts = selectOptionsForField(field);
            if (opts.length === 0) return null; // No data yet for dynamic select
            if (field.key === "currency" && field.type === "select") {
              const current = form[field.key] ?? defaultValueForField(field);
              return (
                <div key={field.key} className="min-w-[160px] flex-1">
                  <CurrencySmartSelect
                    value={current}
                    onChange={(id) => setForm((prev) => ({
                      ...prev,
                      ...selectFieldPatch(field, id, prev),
                    }))}
                    labelSystem={(code) => t(`entityForm.currency.${code.toLowerCase()}`, { defaultValue: code })}
                  />
                </div>
              );
            }
            return (
              <select
                key={field.key}
                value={form[field.key] ?? defaultValueForField(field)}
                onChange={e => setForm(prev => ({ ...prev, ...selectFieldPatch(field, e.target.value, prev) }))}
                className="form-input"
              >
                {(field.key === "type" && entityType === "institution" && allowedInstitutionTypes?.length
                  ? opts.filter((option) => allowedInstitutionTypes.includes(option.value))
                  : opts
                ).map(o => <option key={o.value} value={o.value}>{optionLabel(t, o)}</option>)}
              </select>
            );
          })}
          {shouldShowInitialBalanceFields && (
            <>
              <div className="min-w-[150px]">
                <DateStepper
                  value={form.initialBalanceDate || todayStr()}
                  onChange={(value) => setForm((prev) => ({ ...prev, initialBalanceDate: value }))}
                />
              </div>
              <input
                value={form.initialBalance ?? ""}
                onChange={(event) => setForm((prev) => ({ ...prev, initialBalance: event.target.value }))}
                placeholder={t("detail.column.balance")}
                className="form-input min-w-[120px] text-right tabular-nums"
                inputMode="decimal"
              />
            </>
          )}
          <button
            type="submit"
            disabled={saving || !(form.name?.trim())}
            className="primary-button h-9 shrink-0"
          >
            {saving ? t("entityForm.adding") : t("entityForm.add")}
          </button>
        </form>
        {error && <div className="text-xs text-red-500 mt-1">{error}</div>}

        {/* Nested creation modals */}
        {nestedEntityType && (
          <EntityCreateForm
            mode="compact"
            entityType={nestedEntityType}
            open={nestedOpen}
            onClose={() => { setNestedOpen(false); setNestedEntityType(null); }}
            onCreated={handleNestedCreated}
            defaultType={nestedInstitutionDefaultType()}
            allowedInstitutionTypes={nestedInstitutionAllowedTypes()}
          />
        )}
      </>
    );
  }

  if (layout === "modal") {
    if (mode !== "full" || !props.open) return null;

    return renderEntityCreatePortal(
      <ModalLayerProvider value={modalZIndex}>
        <div className="app-modal-backdrop" style={{ zIndex: modalZIndex }}>
          <div className="app-modal-panel max-w-3xl">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">{displayTitle}</div>
              <button
                type="button"
                onClick={() => { props.onClose?.(); setError(""); initForm(); }}
                className="secondary-button h-8 px-2"
              >
                {t("entityForm.close")}
              </button>
            </div>
            <form className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" onSubmit={onSubmit}>
              {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                {visibleFields.map(field => {
                  if (field.type === "text") {
                    return (
                      <div key={field.key} className={textFieldWrapperClassName(field)}>
                        <label className="form-label mb-1 block">{t(field.labelKey)}</label>
                        {renderTextControl(field, { required: field.key === "name" })}
                      </div>
                    );
                  }

                  const opts = selectOptionsForField(field);
                  if (opts.length === 0 && !field.optionsFromData) return null;

                  if (field.optionsFromData && field.nestedCreate) {
                    const dataKey = field.optionsFromData;
                    const dataList = field.key === "institutionId"
                      ? filterInstitutionDataForAccount(nestedFieldData[dataKey] ?? [])
                      : nestedFieldData[dataKey] ?? [];
                    const ssOptions: SmartSelectOption[] = field.key === "institutionId"
                      ? dataList.map(d => ({
                          id: d.id,
                          label: d.name,
                          subLabel: t(`institution.type.${(d as { type?: string }).type || "other"}`),
                        }))
                      : dataList.map(d => ({
                          id: d.id,
                          label: d.name,
                        }));
                    const selectPlaceholder = smartSelectPlaceholder(t, field.key);

                    return (
                      <div key={field.key}>
                        <label className="form-label mb-1 block">{t(field.labelKey)}</label>
                        <SmartSelect
                          mode="single"
                          value={form[field.key] ?? defaultValueForField(field)}
                          onChange={id => setForm(prev => ({ ...prev, [field.key]: id }))}
                          options={ssOptions}
                          placeholder={selectPlaceholder}
                          searchable={field.key === "institutionId"}
                          onCreateClick={() => { setNestedEntityType(field.nestedCreate!); setNestedOpen(true); }}
                          createLabel={getSmartSelectCreateLabel(t, field.nestedCreate)}
                        />
                      </div>
                    );
                  }

                  // Currency uses SmartSelect with system + user-added currencies.
                  if (field.key === "currency" && field.type === "select") {
                    const current = form[field.key] ?? defaultValueForField(field);
                    return (
                      <div key={field.key}>
                        <label className="form-label mb-1 block">{t(field.labelKey)}</label>
                        <CurrencySmartSelect
                          value={current}
                          onChange={(id) => setForm((prev) => ({
                            ...prev,
                            ...selectFieldPatch(field, id, prev),
                          }))}
                          labelSystem={(code) => t(`entityForm.currency.${code.toLowerCase()}`, { defaultValue: code })}
                        />
                      </div>
                    );
                  }

                  return (
                    <div key={field.key}>
                      <label className="form-label mb-1 block">{t(field.labelKey)}</label>
                      <select
                        value={form[field.key] ?? defaultValueForField(field)}
                        onChange={e => setForm(prev => ({ ...prev, ...selectFieldPatch(field, e.target.value, prev) }))}
                        className="form-input"
                      >
                        {(field.key === "type" && entityType === "institution" && allowedInstitutionTypes?.length
                          ? opts.filter((option) => allowedInstitutionTypes.includes(option.value))
                          : opts
                        ).map(o => <option key={o.value} value={o.value}>{optionLabel(t, o)}</option>)}
                      </select>
                    </div>
                  );
                })}
                {renderInitialBalanceFields()}
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => { props.onClose?.(); setError(""); initForm(); }}
                  className="secondary-button h-9 px-4"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={saving || !(form.name?.trim())}
                  className="primary-button h-9"
                >
                  {saving ? t("entityForm.saving") : t("entityForm.create")}
                </button>
              </div>
            </form>
          </div>
        </div>

        {nestedEntityType && (
          <EntityCreateForm
            mode="compact"
            entityType={nestedEntityType}
            open={nestedOpen}
            onClose={() => { setNestedOpen(false); setNestedEntityType(null); }}
            onCreated={handleNestedCreated}
            defaultType={nestedInstitutionDefaultType()}
            allowedInstitutionTypes={nestedInstitutionAllowedTypes()}
          />
        )}
      </ModalLayerProvider>
    );
  }

  /* ---- Card layout: expandable card form ---- */
  return (
    <>
      {!expanded ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="primary-button h-9 shrink-0 gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />{displayTitle}
        </button>
      ) : (
        <div className="panel-surface overflow-hidden">
          <div className="panel-header">
            <div className="text-sm font-medium text-slate-700">{displayTitle}</div>
            {error && <div className="text-xs text-red-600">{error}</div>}
          </div>
          <form className="p-4 space-y-3" onSubmit={onSubmit}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {visibleFields.map(field => {
                if (field.type === "text") {
                  return (
                    <div key={field.key} className={textFieldWrapperClassName(field)}>
                      <label className="form-label mb-1 block">{t(field.labelKey)}</label>
                      {renderTextControl(field, { required: field.key === "name" })}
                    </div>
                  );
                }

                // Select field - use SmartSelect for dynamic fields with nestedCreate, plain <select> for static
                const opts = selectOptionsForField(field);
                if (opts.length === 0 && !field.optionsFromData) return null;

                // Build SmartSelect options for dynamic fields (institutionId / groupId)
                if (field.optionsFromData && field.nestedCreate) {
                  const dataKey = field.optionsFromData;
                  const dataList = field.key === "institutionId"
                    ? filterInstitutionDataForAccount(nestedFieldData[dataKey] ?? [])
                    : nestedFieldData[dataKey] ?? [];
                  let ssOptions: SmartSelectOption[];

                  if (field.key === "institutionId") {
                    ssOptions = dataList.map(d => ({
                      id: d.id,
                      label: d.name,
                      subLabel: t(`institution.type.${(d as { type?: string }).type || "other"}`),
                    }));
                  } else {
                    ssOptions = dataList.map(d => ({
                      id: d.id,
                      label: d.name,
                    }));
                  }

                  // Placeholder text for the SmartSelect (no empty option in the list)
                  const selectPlaceholder = smartSelectPlaceholder(t, field.key);

                  return (
                    <div key={field.key}>
                      <label className="form-label mb-1 block">{t(field.labelKey)}</label>
                      <SmartSelect
                        mode="single"
                        value={form[field.key] ?? defaultValueForField(field)}
                        onChange={id => setForm(prev => ({ ...prev, [field.key]: id }))}
                        options={ssOptions}
                        placeholder={selectPlaceholder}
                        searchable={field.key === "institutionId"}
                        onCreateClick={() => { setNestedEntityType(field.nestedCreate!); setNestedOpen(true); }}
                        createLabel={getSmartSelectCreateLabel(t, field.nestedCreate)}
                      />
                    </div>
                  );
                }

                // Currency uses SmartSelect with system + user-added currencies.
                if (field.key === "currency" && field.type === "select") {
                  const current = form[field.key] ?? defaultValueForField(field);
                  return (
                    <div key={field.key}>
                      <label className="form-label mb-1 block">{t(field.labelKey)}</label>
                      <CurrencySmartSelect
                        value={current}
                        onChange={(id) => setForm((prev) => ({
                          ...prev,
                          ...selectFieldPatch(field, id, prev),
                        }))}
                        labelSystem={(code) => t(`entityForm.currency.${code.toLowerCase()}`, { defaultValue: code })}
                      />
                    </div>
                  );
                }

                // Static select (kind, type, costBasisMethod, etc.)
                return (
                  <div key={field.key}>
                    <label className="form-label mb-1 block">{t(field.labelKey)}</label>
                    <select
                      value={form[field.key] ?? defaultValueForField(field)}
                      onChange={e => setForm(prev => ({
                        ...prev,
                        ...selectFieldPatch(field, e.target.value, prev),
                      }))}
                      className="form-input"
                    >
                      {(field.key === "type" && entityType === "institution" && allowedInstitutionTypes?.length
                        ? opts.filter((option) => allowedInstitutionTypes.includes(option.value))
                        : opts
                      ).map(o => <option key={o.value} value={o.value}>{optionLabel(t, o)}</option>)}
                    </select>
                  </div>
                );
              })}
              {renderInitialBalanceFields()}
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setExpanded(false); setError(""); initForm(); }}
                className="secondary-button h-9 px-4"
              >
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={saving || !(form.name?.trim())}
                className="primary-button h-9"
              >
                {saving ? t("entityForm.saving") : t("entityForm.create")}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Nested creation modals */}
      {nestedEntityType && (
        <EntityCreateForm
          mode="compact"
          entityType={nestedEntityType}
          open={nestedOpen}
          onClose={() => { setNestedOpen(false); setNestedEntityType(null); }}
          onCreated={handleNestedCreated}
          defaultType={nestedInstitutionDefaultType()}
          allowedInstitutionTypes={nestedInstitutionAllowedTypes()}
        />
      )}
    </>
  );
}

/* ---- Backward-compatible alias ---- */
export const NestedAddModal = EntityCreateForm;
