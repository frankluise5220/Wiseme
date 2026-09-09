"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { EntryAttachmentButton, uploadEntryAttachmentFiles } from "./EntryAttachmentPanel";
import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { EntityCreateForm } from "./EntityCreateForm";
import { ModalLayerProvider, getNextModalLayerZIndex, useModalLayerZIndex } from "./ModalLayer";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";
import { formatMoneyWithCurrencyCode as formatMoney } from "@/lib/format";
import { todayDateLocalYmd as todayDateInputValue } from "@/lib/date-utils";
import { useI18n } from "@/lib/i18n";

type StockTransactionAction =
  | "buy"
  | "sell"
  | "dividend"
  | "bonus_share"
  | "split_share"
  | "merge_share";

type StockModalAction = "buy" | "sell" | "dividend" | "share_change";
type StockDividendMode = "cash" | "shares" | "cash_shares";
type SubmitMode = "close" | "repeat";

type AccountOption = {
  id: string;
  name?: string;
  label: string;
  subLabel?: string;
  title?: string;
  hoverTitle?: string;
  kind?: string | null;
  groupId?: string | null;
  groupName?: string | null;
  institutionId?: string | null;
  institutionType?: string | null;
  investProductType?: string | null;
  currency?: string | null;
};

type CreatedAccountPayload = {
  id: string;
  name: string;
  kind?: string | null;
  currency?: string | null;
  investProductType?: string | null;
  groupId?: string | null;
  institutionId?: string | null;
  AccountGroup?: { id?: string; name?: string | null } | null;
  Institution?: { id?: string; name?: string | null; shortName?: string | null; type?: string | null } | null;
};

type CreatedAccountResponse = {
  ok?: boolean;
  error?: string;
  account?: CreatedAccountPayload;
  brokerageCashAccount?: CreatedAccountPayload | null;
};

type StockAccountCreatedExtra = {
  kind?: string;
  groupId?: string;
  groupName?: string;
  institutionId?: string;
  institutionName?: string;
  institutionShortName?: string;
  currency?: string;
  brokerageCashAccount?: CreatedAccountPayload | null;
};

type InvestmentAccountsResponse = {
  ok?: boolean;
  accounts?: Array<{
    id: string;
    name: string;
    investProductType?: string | null;
    currency?: string | null;
    institutionName?: string | null;
    institutionId?: string | null;
    institutionType?: string | null;
    groupId?: string | null;
    groupName?: string | null;
  }>;
};

type StockSecurityLookupResponse = {
  ok?: boolean;
  error?: string;
  data?: {
    security?: {
      id: string;
      market: string;
      stockCode: string;
      stockName?: string | null;
      currency?: string | null;
      exchange?: string | null;
    } | null;
  };
};

type SellStockHolding = {
  id: string;
  accountId: string;
  securityId: string;
  market: string;
  stockCode: string;
  stockName?: string | null;
  quantity: number;
};

type StockHoldingsResponse = {
  ok?: boolean;
  error?: string;
  data?: {
    holdings?: SellStockHolding[];
  };
};

type StockFeeEstimateResponse = {
  ok?: boolean;
  error?: string;
  data?: {
    grossAmount?: number;
    fees?: {
      fee?: number | null;
      commission?: number | null;
      stampTax?: number | null;
      transferFee?: number | null;
      exchangeFee?: number | null;
      regulatoryFee?: number | null;
      otherFee?: number | null;
    };
    totalFee?: number;
    cashAmount?: number;
    updatedMarketDefaultCount?: number;
  };
};

type FeeDraftKey = "stampTax" | "commission" | "surcharge" | "transferFee";
type FeeDraftState = Record<FeeDraftKey, string>;

const EMPTY_FEE_DRAFT: FeeDraftState = {
  stampTax: "",
  commission: "",
  surcharge: "",
  transferFee: "",
};
const FEE_DRAFT_KEYS: FeeDraftKey[] = ["stampTax", "commission", "surcharge", "transferFee"];

type StockCreateEventDetail = {
  requestId?: string;
  defaultStockAccountId?: string;
  defaultCashAccountId?: string;
  defaultDate?: string;
  defaultAmount?: number;
  defaultAction?: StockModalAction;
};

type StockEditEventDetail = {
  requestId?: string;
  transaction: {
    id: string;
    stockAccountId: string;
    cashAccountId?: string | null;
    securityId?: string | null;
    market: string;
    stockCode: string;
    stockName?: string | null;
    action: string;
    tradeDate: string;
    settleDate?: string | null;
    grossAmount?: number | null;
    netAmount?: number | null;
    quantity?: number | null;
    price?: number | null;
    brokerTradeId?: string | null;
    note?: string | null;
  };
};

const STOCK_ACTIONS: Array<{ key: StockModalAction; labelKey: string; tone: string }> = [
  { key: "buy", labelKey: "stockPanel.action.buy", tone: "bg-blue-600 text-white border-blue-600" },
  { key: "sell", labelKey: "stockPanel.action.sell", tone: "bg-orange-600 text-white border-orange-600" },
  { key: "dividend", labelKey: "stockPanel.action.dividend", tone: "bg-emerald-600 text-white border-emerald-600" },
  { key: "share_change", labelKey: "stockTx.action.shareChange", tone: "bg-violet-600 text-white border-violet-600" },
];

const SHARE_CHANGE_ACTIONS = [
  { key: "bonus_share", labelKey: "stockTx.shareChange.bonusShare" },
  { key: "split_share", labelKey: "stockTx.shareChange.splitShare" },
  { key: "merge_share", labelKey: "stockTx.shareChange.mergeShare" },
];
function parseNumber(value: string) {
  const num = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function formatStockQuantity(value?: number | null, locale = "zh-CN") {
  if (value == null || !Number.isFinite(Number(value))) return "";
  return Number(value).toLocaleString(locale, { maximumFractionDigits: 4 });
}

function sumFeeValues(values: Array<number | null | undefined>) {
  return values.reduce<number>((sum, value) => sum + Math.max(0, Number(value ?? 0)), 0);
}

function feeDraftValue(value: number | null | undefined) {
  return value == null || !Number.isFinite(Number(value)) ? "" : String(Number(value));
}

function parseFeeDraftValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeStockCode(value: string) {
  return value.trim().toUpperCase();
}

function hasUsableDisplayStockName(value: string, stockCode: string) {
  const name = value.trim();
  const code = normalizeStockCode(stockCode);
  return Boolean(name && name !== code);
}

function inferStockMarketFromCode(value: string) {
  const code = normalizeStockCode(value);
  if (/^\d{6}$/.test(code)) return "CN";
  if (/^\d{5}$/.test(code)) return "HK";
  if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(code)) return "US";
  return "CN";
}

function currencyForStockMarket(market: string, fallbackCurrency?: string | null) {
  const normalizedMarket = market.trim().toUpperCase();
  if (normalizedMarket === "CN" || normalizedMarket === "CN_SH" || normalizedMarket === "CN_SZ") return "CNY";
  if (normalizedMarket === "HK") return "HKD";
  if (normalizedMarket === "US") return "USD";
  return (fallbackCurrency || "CNY").toUpperCase();
}

function sameBrokerageFundingAccount(stockAccount: AccountOption | null, cashAccount: AccountOption) {
  if (!stockAccount?.institutionId || cashAccount.institutionId !== stockAccount.institutionId) return false;
  if (stockAccount.groupId && cashAccount.groupId && cashAccount.groupId !== stockAccount.groupId) return false;
  if (stockAccount.currency && cashAccount.currency && cashAccount.currency !== stockAccount.currency) return false;
  return true;
}

function isSelectableStockFundingAccount(account: AccountOption) {
  return account.kind === "cash" || account.kind === "bank_debit" || account.kind === "ewallet";
}

function mergeAccounts(primary: AccountOption[], secondary: AccountOption[]) {
  const result: AccountOption[] = [];
  const seen = new Set<string>();
  for (const item of [...primary, ...secondary]) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function mergeOptions(primary: SmartSelectOption[] | undefined, secondary: SmartSelectOption[] | undefined) {
  const result: SmartSelectOption[] = [];
  const seen = new Set<string>();
  for (const item of [...(primary ?? []), ...(secondary ?? [])]) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function createdAccountToOption(account: NonNullable<CreatedAccountResponse["account"]>, t: (key: string) => string): AccountOption {
  const institutionName = account.Institution?.shortName?.trim() || account.Institution?.name?.trim() || "";
  const label = [institutionName, account.name].filter(Boolean).join("·") || account.name;
  return {
    id: account.id,
    name: account.name,
    label,
    subLabel: [
      account.AccountGroup?.name ?? "",
      t("stockPanel.stockAccountTitle"),
    ].filter(Boolean).join(" · "),
    kind: account.kind ?? "investment",
    groupId: account.groupId ?? account.AccountGroup?.id ?? null,
    groupName: account.AccountGroup?.name ?? null,
    institutionId: account.institutionId ?? account.Institution?.id ?? null,
    institutionType: account.Institution?.type ?? null,
    investProductType: "stock",
    currency: account.currency ?? "CNY",
  };
}

function createdCashAccountToOption(account: CreatedAccountPayload, t: (key: string) => string): AccountOption {
  const institutionName = account.Institution?.shortName?.trim() || account.Institution?.name?.trim() || "";
  const groupName = account.AccountGroup?.name?.trim() || "";
  const labelParts = account.name.includes(institutionName)
    ? [groupName, account.name]
    : [groupName, institutionName, account.name];
  const label = labelParts.filter(Boolean).join("·") || account.name;
  return {
    id: account.id,
    name: account.name,
    label,
    subLabel: [
      account.AccountGroup?.name ?? "",
      t("stockTx.brokerageCashAccountSubLabel"),
    ].filter(Boolean).join(" · "),
    kind: account.kind ?? "ewallet",
    groupId: account.groupId ?? account.AccountGroup?.id ?? null,
    groupName: account.AccountGroup?.name ?? null,
    institutionId: account.institutionId ?? account.Institution?.id ?? null,
    institutionType: account.Institution?.type ?? null,
    investProductType: account.investProductType ?? null,
    currency: account.currency ?? "CNY",
  };
}

function inferBrokerageNameFromStockAccount(account: AccountOption | null, defaultStockAccountName: string) {
  if (!account) return "";
  const accountName = account.name?.trim() || "";
  const groupName = account.groupName?.trim() || "";
  for (const label of [account.label, account.title, account.hoverTitle]) {
    const parts = (label ?? "").split("·").map((part) => part.trim()).filter(Boolean);
    // Data matching: exclude a generic stock-account label part from the parsed brokerage name.
    const candidate = parts.find((part) => part !== accountName && part !== groupName && part !== defaultStockAccountName);
    if (candidate) return candidate;
  }
  return "";
}

function investmentAccountToOption(account: NonNullable<InvestmentAccountsResponse["accounts"]>[number], t: (key: string) => string): AccountOption {
  const label = [account.institutionName?.trim() ?? "", account.name].filter(Boolean).join("·") || account.name;
  return {
    id: account.id,
    name: account.name,
    label,
    subLabel: t("stockPanel.stockAccountTitle"),
    kind: "investment",
    investProductType: "stock",
    groupId: account.groupId ?? null,
    groupName: account.groupName ?? null,
    institutionId: account.institutionId ?? null,
    institutionType: account.institutionType ?? null,
    currency: account.currency ?? "CNY",
  };
}

function accountToSmartOption(account: AccountOption): SmartSelectOption {
  return {
    id: account.id,
    label: account.label,
    subLabel: account.subLabel,
    title: account.title ?? account.hoverTitle,
    parentId: account.groupId ? `group:${account.groupId}` : undefined,
    kind: account.kind ?? null,
    investProductType: "stock",
    institutionId: account.institutionId ?? null,
    currency: account.currency ?? null,
  };
}

function cashAccountToSmartOption(account: AccountOption): SmartSelectOption {
  return {
    id: account.id,
    label: account.label,
    subLabel: account.subLabel,
    title: account.title ?? account.hoverTitle,
    parentId: account.groupId ? `group:${account.groupId}` : undefined,
    kind: account.kind ?? null,
    investProductType: account.investProductType ?? null,
    institutionId: account.institutionId ?? null,
    currency: account.currency ?? null,
  };
}

function resolveDefaultCashAccountId(params: {
  explicitCashAccountId?: string;
  stockAccountId?: string;
  stockAccounts: AccountOption[];
  cashAccounts: AccountOption[];
  fallbackCashAccountId?: string;
}) {
  const cashIds = new Set(params.cashAccounts.map((account) => account.id));
  const stockAccount = params.stockAccounts.find((account) => account.id === params.stockAccountId) ?? null;
  const explicit = params.explicitCashAccountId?.trim();
  if (explicit && (cashIds.has(explicit) || explicit === params.stockAccountId)) return explicit;

  const fallback = params.fallbackCashAccountId?.trim();
  if (fallback && cashIds.has(fallback)) return fallback;

  const sameInstitutionCash = params.cashAccounts.find((account) => sameBrokerageFundingAccount(stockAccount, account)) ?? null;
  if (sameInstitutionCash?.id) return sameInstitutionCash.id;

  return "";
}

function quantityLabelForAction(t: (key: string) => string, action: StockTransactionAction) {
  if (action === "bonus_share") return t("stockTx.quantity.bonusShare");
  if (action === "split_share") return t("stockTx.quantity.splitShare");
  if (action === "merge_share") return t("stockTx.quantity.mergeShare");
  return t("stockTx.quantity");
}

function amountLabelForAction(t: (key: string) => string, action: StockModalAction) {
  if (action === "dividend") return t("stockTx.dividendAmount");
  return t("stockPanel.colGrossAmount");
}

export function StockTransactionFormModal({
  defaultStockAccountId,
  defaultCashAccountId,
  stockAccounts = [],
  stockAccountSSOptions,
  cashAccounts = [],
  cashAccountSSOptions,
}: {
  defaultStockAccountId?: string;
  defaultCashAccountId?: string;
  stockAccounts?: AccountOption[];
  stockAccountSSOptions?: SmartSelectOption[];
  cashAccounts?: AccountOption[];
  cashAccountSSOptions?: SmartSelectOption[];
}) {
  const today = useMemo(() => todayDateInputValue(), []);
  const recentAccountIds = useRecentAccountIds();
  const { t, language } = useI18n();
  const parentModalZIndex = useModalLayerZIndex();
  const modalZIndex = getNextModalLayerZIndex(parentModalZIndex);

  const [open, setOpen] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [stockAccountId, setStockAccountId] = useState(defaultStockAccountId ?? "");
  const [cashAccountId, setCashAccountId] = useState(defaultCashAccountId ?? "");
  const [localStockAccounts, setLocalStockAccounts] = useState<AccountOption[]>(stockAccounts);
  const [localStockSSOptions, setLocalStockSSOptions] = useState<SmartSelectOption[] | undefined>(stockAccountSSOptions);
  const [localCashAccounts, setLocalCashAccounts] = useState<AccountOption[]>(cashAccounts);
  const [localCashSSOptions, setLocalCashSSOptions] = useState<SmartSelectOption[] | undefined>(cashAccountSSOptions);
  const [autoCreatingAccount, setAutoCreatingAccount] = useState(false);
  const [autoCreateError, setAutoCreateError] = useState("");
  const [nestedAccountOpen, setNestedAccountOpen] = useState(false);
  const [nestedCashAccountOpen, setNestedCashAccountOpen] = useState(false);
  const autoCreateAttemptedRef = useRef(false);
  const cashAccountTouchedRef = useRef(false);
  const feeManualOverrideRef = useRef<Record<FeeDraftKey, boolean>>({
    stampTax: false,
    commission: false,
    surcharge: false,
    transferFee: false,
  });

  const [action, setAction] = useState<StockModalAction>("buy");
  const [dividendMode, setDividendMode] = useState<StockDividendMode>("cash");
  const [shareChangeAction, setShareChangeAction] = useState<Extract<StockTransactionAction, "bonus_share" | "split_share" | "merge_share">>("bonus_share");
  const [market, setMarket] = useState("CN");
  const [stockCode, setStockCode] = useState("");
  const [stockName, setStockName] = useState("");
  const [selectedSecurityId, setSelectedSecurityId] = useState("");
  const [sellHoldings, setSellHoldings] = useState<SellStockHolding[]>([]);
  const [sellHoldingsLoading, setSellHoldingsLoading] = useState(false);
  const [sellHoldingsError, setSellHoldingsError] = useState("");
  const [tradeDate, setTradeDate] = useState(today);
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [grossAmount, setGrossAmount] = useState("");
  const [netAmount, setNetAmount] = useState("");
  const [stockLookupLoading, setStockLookupLoading] = useState(false);
  const [feeEstimate, setFeeEstimate] = useState<NonNullable<StockFeeEstimateResponse["data"]> | null>(null);
  const [feeEstimateLoading, setFeeEstimateLoading] = useState(false);
  const [feeEstimateError, setFeeEstimateError] = useState("");
  const [feeEstimateStatus, setFeeEstimateStatus] = useState("");
  const [feeDraft, setFeeDraft] = useState<FeeDraftState>(EMPTY_FEE_DRAFT);
  const [pendingAttachmentFiles, setPendingAttachmentFiles] = useState<File[]>([]);
  const [attachmentEntryId, setAttachmentEntryId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const submitModeRef = useRef<SubmitMode>("close");

  const resetFeeDraft = useCallback(() => {
    feeManualOverrideRef.current = {
      stampTax: false,
      commission: false,
      surcharge: false,
      transferFee: false,
    };
    setFeeDraft({ ...EMPTY_FEE_DRAFT });
    setPendingAttachmentFiles([]);
    setAttachmentEntryId(null);
  }, []);

  const updateFeeDraft = useCallback((key: FeeDraftKey, value: string) => {
    feeManualOverrideRef.current[key] = value.trim().length > 0;
    setFeeDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  useEffect(() => {
    setLocalStockAccounts((prev) => mergeAccounts(stockAccounts, prev));
  }, [stockAccounts]);

  useEffect(() => {
    setLocalStockSSOptions((prev) => mergeOptions(stockAccountSSOptions, prev));
  }, [stockAccountSSOptions]);

  useEffect(() => {
    setLocalCashAccounts((prev) => mergeAccounts(cashAccounts, prev));
  }, [cashAccounts]);

  useEffect(() => {
    setLocalCashSSOptions((prev) => mergeOptions(cashAccountSSOptions, prev));
  }, [cashAccountSSOptions]);

  const stockAccountOptions = useMemo<SmartSelectOption[]>(
    () => {
      const fallback = localStockAccounts.map(accountToSmartOption);
      const scoped = (localStockSSOptions ?? []).filter((option) => option.isHeader || option.investProductType === "stock" || localStockAccounts.some((account) => account.id === option.id));
      return mergeOptions(scoped.length > 0 ? scoped : fallback, fallback);
    },
    [localStockAccounts, localStockSSOptions],
  );
  const { ownerFilterLabel, cycleOwnerFilter, filteredOptions } = useAccountSSFilter(stockAccountOptions);
  const selectedAccount = localStockAccounts.find((account) => account.id === stockAccountId) ?? null;
  const eligibleCashAccounts = useMemo(
    () => localCashAccounts.filter(isSelectableStockFundingAccount),
    [localCashAccounts],
  );
  const eligibleCashAccountOptions = useMemo<SmartSelectOption[]>(() => {
    const fallback = eligibleCashAccounts.map(cashAccountToSmartOption);
    const eligibleIds = new Set(eligibleCashAccounts.map((account) => account.id));
    const scoped = (localCashSSOptions ?? []).filter((option) => option.isHeader || eligibleIds.has(option.id));
    return mergeOptions(scoped.length > 0 ? scoped : fallback, fallback);
  }, [eligibleCashAccounts, localCashSSOptions]);
  const selectedCashAccount = eligibleCashAccounts.find((account) => account.id === cashAccountId)
    ?? null;
  const sellHoldingOptions = useMemo<SmartSelectOption[]>(
    () => sellHoldings.map((holding) => ({
      id: holding.securityId,
      label: holding.stockName?.trim() || holding.stockCode,
      subLabel: `${holding.stockCode} · ${t("stockTx.holdingQuantitySubLabel", { quantity: formatStockQuantity(holding.quantity, language) })}`,
    })),
    [sellHoldings, t, language],
  );
  const selectedSellHolding = sellHoldings.find((holding) => holding.securityId === selectedSecurityId) ?? null;

  function changeModalAction(nextAction: StockModalAction) {
    setAction(nextAction);
    if (nextAction !== "dividend") setDividendMode("cash");
    setSelectedSecurityId("");
    if (nextAction === "sell" || nextAction === "dividend" || nextAction === "share_change") {
      setStockCode("");
      setStockName("");
      setQuantity("");
    }
  }

  function handleTradeDateChange(value: string) {
    setTradeDate(value);
    if (action === "sell" || action === "dividend" || action === "share_change") {
      setSelectedSecurityId("");
      setStockCode("");
      setStockName("");
      setQuantity("");
    }
  }

  function selectHolding(id: string) {
    const holding = sellHoldings.find((item) => item.securityId === id) ?? null;
    if (!holding) return;
    setSelectedSecurityId(holding.securityId);
    setMarket(holding.market);
    setStockCode(holding.stockCode);
    setStockName(holding.stockName?.trim() || holding.stockCode);
    setQuantity(action === "sell" ? formatStockQuantity(holding.quantity, language) : "");
  }

  const isDividendCash = action === "dividend" && dividendMode === "cash";
  const isDividendShares = action === "dividend" && dividendMode === "shares";
  const isDividendCashShares = action === "dividend" && dividendMode === "cash_shares";
  const isHoldingSelectionAction = action === "sell" || action === "dividend" || action === "share_change";
  const transactionAction: StockTransactionAction = action === "share_change"
    ? shareChangeAction
    : isDividendShares
      ? "bonus_share"
      : action;
  const isBuySell = action === "buy" || action === "sell";
  const isDividendAction = action === "dividend";
  const isShareAction = action === "share_change";
  const isCashAmountAction = action === "buy" || action === "sell" || isDividendCash || isDividendCashShares;
  const showQuantityField = isBuySell || isShareAction || isDividendShares || isDividendCashShares;
  const showPriceField = isBuySell;
  const showAmountField = isCashAmountAction;
  const showNetAmount = isDividendCash || isDividendCashShares;
  const quantityFieldLabel = (isDividendShares || isDividendCashShares) ? t("stockTx.dividendShares") : quantityLabelForAction(t, transactionAction);
  const grossFromQuantity = parseNumber(quantity) * parseNumber(price);
  const effectiveGrossAmount = isBuySell ? grossFromQuantity : parseNumber(grossAmount);
  const previewCashAmount = action === "sell" || action === "dividend"
    ? Math.max(0, parseNumber(netAmount) || effectiveGrossAmount)
    : action === "buy"
      ? effectiveGrossAmount
      : 0;
  const displayCurrency = currencyForStockMarket(market, selectedCashAccount?.currency || selectedAccount?.currency);
  const feeInputConfigs = [
    {
      key: "stampTax" as const,
      labelKey: "stockFee.feeType.stamp_tax",
      estimateValue: feeEstimate?.fees?.stampTax ?? null,
    },
    {
      key: "commission" as const,
      labelKey: "stockFee.feeType.commission",
      estimateValue: feeEstimate?.fees?.commission ?? null,
    },
    {
      key: "surcharge" as const,
      labelKey: "stockTx.feeType.surcharge",
      estimateValue: feeEstimate
        ? sumFeeValues([
            feeEstimate.fees?.exchangeFee,
            feeEstimate.fees?.regulatoryFee,
            feeEstimate.fees?.otherFee,
            feeEstimate.fees?.fee,
          ])
        : null,
    },
    {
      key: "transferFee" as const,
      labelKey: "stockFee.feeType.transfer_fee",
      estimateValue: feeEstimate?.fees?.transferFee ?? null,
    },
  ] as const;
  const feeDraftStampTax = parseFeeDraftValue(feeDraft.stampTax);
  const feeDraftCommission = parseFeeDraftValue(feeDraft.commission);
  const feeDraftSurcharge = parseFeeDraftValue(feeDraft.surcharge);
  const feeDraftTransferFee = parseFeeDraftValue(feeDraft.transferFee);
  const feeResolvedStampTax = feeDraftStampTax ?? feeEstimate?.fees?.stampTax ?? undefined;
  const feeResolvedCommission = feeDraftCommission ?? feeEstimate?.fees?.commission ?? undefined;
  const feeResolvedSurcharge = feeDraftSurcharge ?? (feeEstimate
    ? sumFeeValues([
        feeEstimate.fees?.exchangeFee,
        feeEstimate.fees?.regulatoryFee,
        feeEstimate.fees?.otherFee,
        feeEstimate.fees?.fee,
      ])
    : undefined);
  const feeResolvedTransferFee = feeDraftTransferFee ?? feeEstimate?.fees?.transferFee ?? undefined;
  const feeDraftTotal = sumFeeValues([feeResolvedStampTax, feeResolvedCommission, feeResolvedSurcharge, feeResolvedTransferFee]);
  const hasFeeDraftValue = FEE_DRAFT_KEYS.some((key) => feeDraft[key].trim().length > 0);
  const feeCardVisible = Boolean(feeEstimate || hasFeeDraftValue);
  const finalCashAmountLabel = action === "buy" ? t("stockTx.expectedPayable") : t("stockTx.expectedArrival");
  const feeBreakdownTitle = feeCardVisible
    ? [
        t("stockTx.feeBreakdownLine", { label: t("stockFee.feeType.stamp_tax"), value: formatMoney(feeResolvedStampTax ?? 0, displayCurrency) }),
        t("stockTx.feeBreakdownLine", { label: t("stockFee.feeType.commission"), value: formatMoney(feeResolvedCommission ?? 0, displayCurrency) }),
        t("stockTx.feeBreakdownLine", { label: t("stockTx.feeType.surcharge"), value: formatMoney(feeResolvedSurcharge ?? 0, displayCurrency) }),
        t("stockTx.feeBreakdownLine", { label: t("stockFee.feeType.transfer_fee"), value: formatMoney(feeResolvedTransferFee ?? 0, displayCurrency) }),
        t("stockTx.feeBreakdownTotal", { amount: formatMoney(feeDraftTotal, displayCurrency) }),
        t("stockTx.feeBreakdownFinal", {
          label: finalCashAmountLabel,
          amount: formatMoney(
            action === "buy"
              ? effectiveGrossAmount + feeDraftTotal
              : Math.max(0, effectiveGrossAmount - feeDraftTotal),
            displayCurrency,
          ),
        }),
      ].join("\n")
    : feeEstimateLoading
      ? t("stockTx.calculatingFees")
      : feeEstimateError || t("stockTx.feeAutoHint");
  const feeTotalDisplay = feeEstimateLoading
    ? t("stockTx.calculating")
    : feeCardVisible
      ? formatMoney(feeDraftTotal, displayCurrency)
      : "-";
  const finalCashAmountDisplay = feeEstimateLoading
    ? t("stockTx.calculating")
    : feeCardVisible
      ? formatMoney(
          action === "buy"
            ? effectiveGrossAmount + feeDraftTotal
            : Math.max(0, effectiveGrossAmount - feeDraftTotal),
          displayCurrency,
        )
      : "-";
  const accountCreateFieldData = useMemo(() => {
    const accounts = mergeAccounts(localStockAccounts, localCashAccounts);
    const groups = new Map<string, { id: string; name: string }>();
    const institutions = new Map<string, { id: string; name: string; type?: string }>();
    for (const account of accounts) {
      if (account.groupId) groups.set(account.groupId, { id: account.groupId, name: account.groupName || t("settings.accounts.owner") });
      if (account.institutionId) {
        const label = account.label.split("·")[0] || account.institutionId;
        institutions.set(account.institutionId, {
          id: account.institutionId,
          name: label,
          type: account.institutionType ?? "brokerage",
        });
      }
    }
    return {
      groupId: Array.from(groups.values()),
      institutionId: Array.from(institutions.values()),
    };
  }, [localCashAccounts, localStockAccounts, t]);
  const existingStockAccountNames = useMemo(
    () => localStockAccounts.map((account) => account.name || account.label),
    [localStockAccounts],
  );
  const existingCashAccountNames = useMemo(
    () => localCashAccounts.map((account) => account.name || account.label),
    [localCashAccounts],
  );
  const cashAccountCreateExtraFields = useMemo(() => ({
    ...(selectedAccount?.groupId ? { groupId: selectedAccount.groupId } : {}),
    ...(selectedAccount?.institutionId ? { institutionId: selectedAccount.institutionId } : {}),
    ...(selectedAccount?.currency ? { currency: selectedAccount.currency } : {}),
  }), [selectedAccount]);
  const cashAccountCreateReadOnlyFields = useMemo(() => [
    ...(selectedAccount?.groupId ? ["groupId"] : []),
    ...(selectedAccount?.institutionId ? ["institutionId"] : []),
    ...(selectedAccount?.currency ? ["currency"] : []),
  ], [selectedAccount]);

  const resetDraft = useCallback((detail?: StockCreateEventDetail) => {
    const nextStockAccountId =
      detail?.defaultStockAccountId ||
      defaultStockAccountId ||
      localStockAccounts[0]?.id ||
      "";
    const nextCashAccountId = resolveDefaultCashAccountId({
      explicitCashAccountId: detail?.defaultCashAccountId,
      stockAccountId: nextStockAccountId,
      stockAccounts: localStockAccounts,
      cashAccounts: localCashAccounts,
      fallbackCashAccountId: defaultCashAccountId,
    });
    setRequestId(detail?.requestId ?? null);
    setEditingId(null);
    setAction(STOCK_ACTIONS.find((item) => item.key === detail?.defaultAction)?.key ?? "buy");
    setDividendMode("cash");
    setMarket("CN");
    setStockCode("");
    setStockName("");
    setSelectedSecurityId("");
    setSellHoldings([]);
    setSellHoldingsLoading(false);
    setSellHoldingsError("");
    setTradeDate(detail?.defaultDate ?? todayDateInputValue());
    setQuantity("");
    setPrice("");
    setGrossAmount(detail?.defaultAmount ? String(detail.defaultAmount) : "");
    setNetAmount("");
    setStockLookupLoading(false);
    setFeeEstimate(null);
    setFeeEstimateLoading(false);
    setFeeEstimateError("");
    setFeeEstimateStatus("");
    resetFeeDraft();
    setNote("");
    setAutoCreateError("");
    autoCreateAttemptedRef.current = false;
    cashAccountTouchedRef.current = false;
    setStockAccountId(nextStockAccountId);
    setCashAccountId(nextCashAccountId);
  }, [defaultCashAccountId, defaultStockAccountId, localCashAccounts, localStockAccounts, resetFeeDraft]);

  const resetDraftForEdit = useCallback((detail: StockEditEventDetail) => {
    const tx = detail.transaction;
    const nextStockAccountId = tx.stockAccountId || defaultStockAccountId || localStockAccounts[0]?.id || "";
    setRequestId(detail.requestId ?? null);
    setEditingId(tx.id);
    // Backfill the action: within dividend, distinguish cash vs bonus shares; share_change maps to capital changes.
    if (tx.action === "buy" || tx.action === "sell") {
      setAction(tx.action);
      setDividendMode("cash");
    } else if (tx.action === "dividend" || tx.action === "bonus_share") {
      setAction("dividend");
      setDividendMode(tx.action === "bonus_share" ? "shares" : "cash");
    } else if (tx.action === "split_share" || tx.action === "merge_share") {
      setAction("share_change");
      setShareChangeAction(tx.action as Extract<StockTransactionAction, "bonus_share" | "split_share" | "merge_share">);
    } else {
      setAction("buy");
      setDividendMode("cash");
    }
    setMarket(tx.market || "CN");
    setStockCode(normalizeStockCode(tx.stockCode));
    setStockName(tx.stockName?.trim() || tx.stockCode);
    setSelectedSecurityId(tx.securityId ?? "");
    setSellHoldings([]);
    setSellHoldingsLoading(false);
    setSellHoldingsError("");
    setTradeDate(tx.tradeDate || todayDateInputValue());
    setQuantity(tx.quantity == null ? "" : formatStockQuantity(Number(tx.quantity), language));
    setPrice(tx.price == null ? "" : String(Number(tx.price)));
    setGrossAmount(tx.grossAmount == null ? "" : String(Number(tx.grossAmount)));
    setNetAmount(tx.netAmount == null ? "" : String(Number(tx.netAmount)));
    setStockLookupLoading(false);
    setFeeEstimate(null);
    setFeeEstimateLoading(false);
    setFeeEstimateError("");
    setFeeEstimateStatus("");
    resetFeeDraft();
    setNote(tx.note ?? "");
    setAutoCreateError("");
    autoCreateAttemptedRef.current = true;
    cashAccountTouchedRef.current = true;
    setStockAccountId(nextStockAccountId);
    setCashAccountId(tx.cashAccountId ?? "");
  }, [defaultStockAccountId, localStockAccounts, language, resetFeeDraft]);

  const close = useCallback(() => {
    if (submitting) return;
    setOpen(false);
  }, [submitting]);

  const repeatDraft = useCallback(() => {
    setRequestId(null);
    setEditingId(null);
    setQuantity("");
    setPrice("");
    setGrossAmount("");
    setNetAmount("");
    setFeeEstimate(null);
    setFeeEstimateLoading(false);
    setFeeEstimateError("");
    setFeeEstimateStatus("");
    resetFeeDraft();
    setPendingAttachmentFiles([]);
    setAttachmentEntryId(null);
    setNote("");
    submitModeRef.current = "close";
    autoCreateAttemptedRef.current = true;
    cashAccountTouchedRef.current = false;
  }, [resetFeeDraft]);

  useCloseOnNavigation(open, () => setOpen(false));

  useEffect(() => {
    function onOpen(event: Event) {
      const detail = (event as CustomEvent<StockCreateEventDetail>).detail ?? {};
      resetDraft(detail);
      setOpen(true);
    }
    window.addEventListener("mmh:stock:create", onOpen);
    return () => window.removeEventListener("mmh:stock:create", onOpen);
  }, [resetDraft]);

  useEffect(() => {
    function onEditOpen(event: Event) {
      const detail = (event as CustomEvent<StockEditEventDetail>).detail;
      if (!detail?.transaction?.id) return;
      resetDraftForEdit(detail);
      setOpen(true);
    }
    window.addEventListener("mmh:stock:edit", onEditOpen);
    return () => window.removeEventListener("mmh:stock:edit", onEditOpen);
  }, [resetDraftForEdit]);

  const ensureDefaultStockAccount = useCallback(async () => {
    if (autoCreatingAccount || autoCreateAttemptedRef.current || localStockAccounts.length > 0) return;
    autoCreateAttemptedRef.current = true;
    setAutoCreatingAccount(true);
    setAutoCreateError("");
    try {
      const existingRes = await fetch("/api/v1/accounts/investment");
      const existingData = await existingRes.json().catch(() => null) as InvestmentAccountsResponse | null;
      const existingStockAccounts = existingData?.ok
        ? (existingData.accounts ?? []).filter((account) => account.investProductType === "stock")
        : [];
      if (existingStockAccounts.length > 0) {
        const options = existingStockAccounts.map((account) => investmentAccountToOption(account, t));
        const nextStockAccountId = options[0]?.id ?? "";
        setLocalStockAccounts((prev) => mergeAccounts(options, prev));
        setLocalStockSSOptions((prev) => mergeOptions(prev, options.map(accountToSmartOption)));
        setStockAccountId(nextStockAccountId);
        setCashAccountId(resolveDefaultCashAccountId({
          explicitCashAccountId: defaultCashAccountId,
          stockAccountId: nextStockAccountId,
          stockAccounts: options,
          cashAccounts: localCashAccounts,
          fallbackCashAccountId: defaultCashAccountId,
        }));
        return;
      }

      const seedCashAccount = localCashAccounts.find((account) => account.id === cashAccountId)
        ?? localCashAccounts.find((account) => account.id === defaultCashAccountId)
        ?? null;
      if (!seedCashAccount?.institutionId) return;
      const res = await fetch("/api/v1/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Kept as data: this is the stored default account name for auto-created stock accounts.
          name: t("stockTx.defaultStockAccountName"),
          kind: "investment",
          investProductType: "stock",
          groupId: seedCashAccount?.groupId ?? undefined,
          institutionId: seedCashAccount?.institutionId ?? undefined,
          currency: seedCashAccount?.currency ?? "CNY",
        }),
      });
      const data = await res.json().catch(() => null) as CreatedAccountResponse | null;
      if (!res.ok || !data?.ok || !data.account?.id) {
        throw new Error(data?.error ?? t("stockTx.error.autoCreateStockAccountFailed"));
      }
      const option = createdAccountToOption(data.account, t);
      const brokerageCashOption = data.brokerageCashAccount ? createdCashAccountToOption(data.brokerageCashAccount, t) : null;
      setLocalStockAccounts((prev) => mergeAccounts([option], prev));
      setLocalStockSSOptions((prev) => mergeOptions(prev, [accountToSmartOption(option)]));
      if (brokerageCashOption) {
        setLocalCashAccounts((prev) => mergeAccounts([brokerageCashOption], prev));
        setLocalCashSSOptions((prev) => mergeOptions(prev, [cashAccountToSmartOption(brokerageCashOption)]));
      }
      setStockAccountId(option.id);
      setCashAccountId((prev) => brokerageCashOption?.id || prev || resolveDefaultCashAccountId({
        stockAccountId: option.id,
        stockAccounts: [option],
        cashAccounts: brokerageCashOption ? mergeAccounts([brokerageCashOption], localCashAccounts) : localCashAccounts,
        fallbackCashAccountId: defaultCashAccountId,
      }));
      requestAnimationFrame(() => {
        dispatchFinanceDataChanged({
          reason: "stock-account-auto-create",
          accountIds: [option.id, brokerageCashOption?.id ?? ""].filter((id): id is string => Boolean(id)),
        });
      });
    } catch (error) {
      setAutoCreateError(error instanceof Error ? error.message : t("stockTx.error.autoCreateStockAccountFailed"));
    } finally {
      setAutoCreatingAccount(false);
    }
  }, [autoCreatingAccount, cashAccountId, defaultCashAccountId, localCashAccounts, localStockAccounts.length, t]);

  function handleStockAccountCreated(id: string, name: string, extra?: StockAccountCreatedExtra) {
    const institutionName = extra?.institutionShortName?.trim() || extra?.institutionName?.trim() || "";
    const option: AccountOption = {
      id,
      name,
      label: [institutionName, name].filter(Boolean).join("·") || name,
      subLabel: [extra?.groupName ?? "", t("stockPanel.stockAccountTitle")].filter(Boolean).join(" · "),
      kind: "investment",
      investProductType: "stock",
      groupId: extra?.groupId ?? null,
      groupName: extra?.groupName ?? null,
      institutionId: extra?.institutionId ?? null,
      institutionType: "brokerage",
      currency: extra?.currency ?? "CNY",
    };
    const brokerageCashOption = extra?.brokerageCashAccount ? createdCashAccountToOption(extra.brokerageCashAccount, t) : null;
    setLocalStockAccounts((prev) => mergeAccounts([option], prev));
    setLocalStockSSOptions((prev) => mergeOptions(prev, [accountToSmartOption(option)]));
    if (brokerageCashOption) {
      setLocalCashAccounts((prev) => mergeAccounts([brokerageCashOption], prev));
      setLocalCashSSOptions((prev) => mergeOptions(prev, [cashAccountToSmartOption(brokerageCashOption)]));
    }
    cashAccountTouchedRef.current = false;
    setStockAccountId(id);
    setCashAccountId(brokerageCashOption?.id ?? "");
    setNestedAccountOpen(false);
    requestAnimationFrame(() => {
      dispatchFinanceDataChanged({
        reason: "stock-account:create",
        accountIds: [id, brokerageCashOption?.id ?? ""].filter((item): item is string => Boolean(item)),
      });
    });
  }

  function openNestedCashAccountCreate() {
    if (!selectedAccount?.id) {
      window.alert(t("stockTx.alert.selectStockAccount"));
      return;
    }
    if (!selectedAccount.institutionId) {
      window.alert(t("stockTx.alert.selectStockAccountWithBroker"));
      return;
    }
    setNestedCashAccountOpen(true);
  }

  function handleCashAccountCreated(id: string, name: string, extra?: StockAccountCreatedExtra) {
    const institutionName = extra?.institutionShortName?.trim()
      || extra?.institutionName?.trim()
      || inferBrokerageNameFromStockAccount(selectedAccount, t("stockTx.defaultStockAccountName"));
    const groupName = extra?.groupName ?? selectedAccount?.groupName ?? "";
    const labelParts = name.includes(institutionName)
      ? [groupName, name]
      : [groupName, institutionName, name];
    const option: AccountOption = {
      id,
      name,
      label: labelParts.filter(Boolean).join("·") || name,
      subLabel: [groupName, t("stockTx.brokerageCashAccountSubLabel")].filter(Boolean).join(" · "),
      kind: extra?.kind ?? "ewallet",
      groupId: extra?.groupId ?? selectedAccount?.groupId ?? null,
      groupName: groupName || null,
      institutionId: extra?.institutionId ?? selectedAccount?.institutionId ?? null,
      institutionType: "brokerage",
      investProductType: null,
      currency: extra?.currency ?? selectedAccount?.currency ?? "CNY",
    };
    setLocalCashAccounts((prev) => mergeAccounts([option], prev));
    setLocalCashSSOptions((prev) => mergeOptions(prev, [cashAccountToSmartOption(option)]));
    cashAccountTouchedRef.current = true;
    setCashAccountId(id);
    setNestedCashAccountOpen(false);
    requestAnimationFrame(() => {
      dispatchFinanceDataChanged({
        reason: "stock-funding-account:create",
        accountIds: [id, stockAccountId].filter((item): item is string => Boolean(item)),
      });
    });
  }

  useEffect(() => {
    if (!open) return;
    if (localStockAccounts.length > 0) return;
    void ensureDefaultStockAccount();
  }, [ensureDefaultStockAccount, localStockAccounts.length, open]);

  useEffect(() => {
    if (!stockAccountId && localStockAccounts.length > 0) {
      setStockAccountId(defaultStockAccountId || localStockAccounts[0]?.id || "");
    }
  }, [defaultStockAccountId, localStockAccounts, stockAccountId]);

  useEffect(() => {
    if (!open || editingId || cashAccountTouchedRef.current) return;
    const nextCashAccountId = resolveDefaultCashAccountId({
      stockAccountId,
      stockAccounts: localStockAccounts,
      cashAccounts: localCashAccounts,
      fallbackCashAccountId: defaultCashAccountId,
    });
    setCashAccountId((prev) => (prev === nextCashAccountId ? prev : nextCashAccountId));
  }, [defaultCashAccountId, editingId, localCashAccounts, localStockAccounts, open, stockAccountId]);

  useEffect(() => {
    if (!open) return;
    const code = normalizeStockCode(stockCode);
    if (!code) {
      setStockName("");
      setStockLookupLoading(false);
      return;
    }
    if (hasUsableDisplayStockName(stockName, code)) {
      setStockLookupLoading(false);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setStockLookupLoading(true);
      try {
        const lookupMarket = inferStockMarketFromCode(code);
        const params = new URLSearchParams({ market: lookupMarket, code, localOnly: "1" });
        const res = await fetch(`/api/v1/stocks/securities?${params.toString()}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const data = await res.json().catch(() => null) as StockSecurityLookupResponse | null;
        if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("stockTx.error.stockNameLookupFailed"));
        const security = data.data?.security ?? null;
        const nextName = security?.stockName?.trim() ?? "";
        if (nextName && nextName !== code) {
          setStockName(nextName);
          if (security?.market) setMarket(security.market);
        } else {
          setStockName("");
        }
      } catch (error) {
        if ((error as Error)?.name !== "AbortError") setStockName("");
      } finally {
        if (!controller.signal.aborted) setStockLookupLoading(false);
      }
    }, 150);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, stockCode, stockName, t]);

  useEffect(() => {
    if (!open || !isHoldingSelectionAction || !stockAccountId || !tradeDate) {
      setSellHoldingsLoading(false);
      return;
    }
    const controller = new AbortController();
    setSellHoldingsLoading(true);
    setSellHoldingsError("");
    setSellHoldings([]);
    const params = new URLSearchParams({
      accountId: stockAccountId,
      tradeDate,
    });
    fetch(`/api/v1/stocks/holdings?${params.toString()}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then((res) => res.json().catch(() => null))
      .then((data: StockHoldingsResponse | null) => {
        if (!data?.ok) throw new Error(data?.error ?? t("stockTx.error.holdingsLoadFailed"));
        setSellHoldings(Array.isArray(data.data?.holdings) ? data.data.holdings : []);
      })
      .catch((error) => {
        if ((error as Error)?.name === "AbortError") return;
        setSellHoldings([]);
        setSellHoldingsError(error instanceof Error ? error.message : t("stockTx.error.holdingsLoadFailed"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setSellHoldingsLoading(false);
      });
    return () => controller.abort();
  }, [isHoldingSelectionAction, open, stockAccountId, tradeDate, t]);

  const loadFeeEstimate = useCallback(async (refresh = false) => {
    const normalizedCode = normalizeStockCode(stockCode);
    if (editingId || !open || !isBuySell || !stockAccountId || effectiveGrossAmount <= 0 || !normalizedCode) {
      setFeeEstimate(null);
      setFeeEstimateLoading(false);
      setFeeEstimateError("");
      setFeeEstimateStatus("");
      return;
    }
    setFeeEstimateLoading(true);
    setFeeEstimateError("");
    if (!refresh) setFeeEstimateStatus("");
    try {
      const params = new URLSearchParams({
        accountId: stockAccountId,
        estimate: "1",
        direction: action,
        tradeDate,
        market,
        stockCode: normalizedCode,
        grossAmount: effectiveGrossAmount.toFixed(2),
      });
      if (refresh) params.set("refresh", "1");
      const res = await fetch(`/api/v1/stocks/fee-rules?${params.toString()}`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as StockFeeEstimateResponse | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("stockTx.error.feeEstimateFailed"));
      setFeeEstimate(data.data ?? null);
      const nextDraft: FeeDraftState = {
        stampTax: feeDraftValue(data.data?.fees?.stampTax),
        commission: feeDraftValue(data.data?.fees?.commission),
        surcharge: feeDraftValue(sumFeeValues([
          data.data?.fees?.exchangeFee,
          data.data?.fees?.regulatoryFee,
          data.data?.fees?.otherFee,
          data.data?.fees?.fee,
        ])),
        transferFee: feeDraftValue(data.data?.fees?.transferFee),
      };
      setFeeDraft((prev) => ({
        stampTax: feeManualOverrideRef.current.stampTax ? prev.stampTax : nextDraft.stampTax,
        commission: feeManualOverrideRef.current.commission ? prev.commission : nextDraft.commission,
        surcharge: feeManualOverrideRef.current.surcharge ? prev.surcharge : nextDraft.surcharge,
        transferFee: feeManualOverrideRef.current.transferFee ? prev.transferFee : nextDraft.transferFee,
      }));
      setFeeEstimateStatus(refresh ? t("stockTx.feeRateRefreshed") : "");
    } catch (error) {
      setFeeEstimateError(error instanceof Error ? error.message : t("stockTx.error.feeEstimateFailed"));
      if (refresh) setFeeEstimateStatus("");
    } finally {
      setFeeEstimateLoading(false);
    }
  }, [action, editingId, effectiveGrossAmount, isBuySell, market, open, stockAccountId, stockCode, t, tradeDate]);

  useEffect(() => {
    if (editingId || !open || !isBuySell || effectiveGrossAmount <= 0) {
      setFeeEstimate(null);
      setFeeEstimateLoading(false);
      setFeeEstimateError("");
      setFeeEstimateStatus("");
      return;
    }
    const timer = window.setTimeout(() => {
      void loadFeeEstimate(false);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [effectiveGrossAmount, editingId, isBuySell, loadFeeEstimate, open]);

  useEffect(() => {
    if (editingId || !open || !isBuySell || !stockAccountId) return;
    const controller = new AbortController();
    void fetch(`/api/v1/stocks/fee-rules?${new URLSearchParams({ accountId: stockAccountId, list: "1" }).toString()}`, {
      cache: "no-store",
      signal: controller.signal,
    }).catch(() => null);
    return () => controller.abort();
  }, [editingId, isBuySell, open, stockAccountId]);

  useEffect(() => {
    if (!open) return;
    if (!editingId) {
      setAttachmentEntryId(null);
      return;
    }
    if (!stockAccountId) return;
    let cancelled = false;
    fetch(`/api/v1/stocks/transactions?${new URLSearchParams({ accountId: stockAccountId, limit: "500" }).toString()}`, { cache: "no-store" })
      .then((response) => response.json().catch(() => null) as Promise<{ ok?: boolean; data?: { transactions?: Array<{ id: string; cashEntryId?: string | null }> } }>)
      .then((result) => {
        if (cancelled) return;
        const current = result?.ok ? result.data?.transactions?.find((item) => item.id === editingId) ?? null : null;
        setAttachmentEntryId(current?.cashEntryId ?? null);
      })
      .catch(() => {
        if (!cancelled) setAttachmentEntryId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [editingId, open, stockAccountId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    if (!stockAccountId) {
      window.alert(t("stockTx.alert.selectStockAccount"));
      return;
    }
    const normalizedCode = normalizeStockCode(stockCode);
    if (isHoldingSelectionAction && !selectedSecurityId) {
      window.alert(action === "sell" || action === "share_change" ? t("stockTx.alert.selectHoldingStock") : t("stockTx.alert.selectDividendStock"));
      return;
    }
    if (!isHoldingSelectionAction && !normalizedCode) {
      window.alert(t("stockTx.alert.enterStockCode"));
      return;
    }
    if (isBuySell && (!parseNumber(quantity) || !parseNumber(price) || effectiveGrossAmount <= 0)) {
      window.alert(t("stockTx.alert.quantityAndPriceRequired"));
      return;
    }
    if (action === "sell" && selectedSellHolding && parseNumber(quantity) > selectedSellHolding.quantity + 0.000001) {
      window.alert(t("stockTx.alert.sellQuantityExceeds", { quantity: formatStockQuantity(selectedSellHolding.quantity, language) }));
      return;
    }
    if ((isDividendShares || isDividendCashShares) && !parseNumber(quantity)) {
      window.alert(t("stockTx.alert.enterDividendShares"));
      return;
    }
    if (isShareAction && !parseNumber(quantity)) {
      window.alert(t("stockTx.alert.enterShareChangeQuantity"));
      return;
    }
    if (isCashAmountAction && effectiveGrossAmount <= 0) {
      window.alert(t("stockTx.alert.enterAmount"));
      return;
    }
    const feeOverrides = isBuySell
      ? feeManualOverrideRef.current.surcharge
        ? {
            fee: 0,
            exchangeFee: 0,
            regulatoryFee: 0,
            otherFee: feeDraftSurcharge ?? 0,
            commission: feeDraftCommission,
            stampTax: feeDraftStampTax,
            transferFee: feeDraftTransferFee,
          }
        : {
            fee: feeEstimate?.fees?.fee ?? undefined,
            exchangeFee: feeEstimate?.fees?.exchangeFee ?? undefined,
            regulatoryFee: feeEstimate?.fees?.regulatoryFee ?? undefined,
            otherFee: feeEstimate?.fees?.otherFee ?? undefined,
            commission: feeDraftCommission ?? feeEstimate?.fees?.commission ?? undefined,
            stampTax: feeDraftStampTax ?? feeEstimate?.fees?.stampTax ?? undefined,
            transferFee: feeDraftTransferFee ?? feeEstimate?.fees?.transferFee ?? undefined,
          }
      : {};
    setSubmitting(true);
    try {
      const commonPayload = {
        stockAccountId,
        cashAccountId: selectedCashAccount?.id || cashAccountId || undefined,
        securityId: selectedSecurityId || undefined,
        market,
        stockCode: normalizedCode,
        stockName: stockName.trim() || normalizedCode,
        tradeDate,
        note: note.trim() || undefined,
        source: "manual",
      };
      const postTransaction = async (body: Record<string, unknown>) => {
        const res = await fetch(editingId ? `/api/v1/stocks/transactions?id=${encodeURIComponent(editingId)}` : "/api/v1/stocks/transactions", {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; data?: { transaction?: { id?: string; cashEntryId?: string | null } | null } } | null;
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error ?? t("stockTx.error.saveFailed"));
        }
        return data;
      };
      let lastData: Awaited<ReturnType<typeof postTransaction>> | null = null;
      if (isDividendCashShares && !editingId) {
        // Split one "cash dividend + bonus/transferred shares" entry into two independent business records:
        // 1) dividend: cash dividend (dividend amount + net arrival -> securities cash account)
        lastData = await postTransaction({
          ...commonPayload,
          action: "dividend",
          grossAmount: effectiveGrossAmount || undefined,
          netAmount: netAmount || undefined,
        });
        // 2) bonus_share: bonus/transferred shares (only adds holding quantity, no cash flow)
        await postTransaction({
          ...commonPayload,
          action: "bonus_share",
          quantity: quantity || undefined,
          grossAmount: 0,
        });
      } else {
        lastData = await postTransaction({
          ...commonPayload,
          action: transactionAction,
          ...feeOverrides,
          quantity: showQuantityField ? quantity || undefined : undefined,
          price: showPriceField ? price || undefined : undefined,
          grossAmount: showAmountField ? effectiveGrossAmount || undefined : undefined,
          netAmount: showNetAmount ? netAmount || undefined : undefined,
        });
      }
      if (requestId) {
        window.dispatchEvent(new CustomEvent(editingId ? "mmh:stock:edit:success" : "mmh:stock:create:success", { detail: { requestId } }));
      }
      requestAnimationFrame(() => {
        dispatchFinanceDataChanged({
          reason: editingId ? "stock-transaction-update" : "stock-transaction-save",
          accountIds: Array.from(new Set([stockAccountId, selectedCashAccount?.id].filter((id): id is string => Boolean(id)))),
          entryIds: [lastData?.data?.transaction?.cashEntryId ?? "", lastData?.data?.transaction?.id ?? ""].filter(Boolean),
        });
      });
      const nextAttachmentEntryId = lastData?.data?.transaction?.cashEntryId ?? attachmentEntryId ?? null;
      if (nextAttachmentEntryId && pendingAttachmentFiles.length > 0) {
        try {
          await uploadEntryAttachmentFiles(nextAttachmentEntryId, pendingAttachmentFiles);
          setPendingAttachmentFiles([]);
        } catch (attachmentError) {
          window.alert(t("attachments.saveAfterCreateFailed", {
            reason: attachmentError instanceof Error ? attachmentError.message : t("attachments.uploadFailed"),
          }));
        }
      }
      if (submitModeRef.current === "repeat" && !editingId) {
        repeatDraft();
      } else {
        setOpen(false);
        if (editingId) {
          setEditingId(null);
          resetDraft();
        } else {
          resetDraft();
        }
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("stockTx.error.saveFailed"));
    } finally {
      submitModeRef.current = "close";
      setSubmitting(false);
    }
  }

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <ModalLayerProvider value={modalZIndex}>
      <div className="app-modal-backdrop" style={{ zIndex: modalZIndex }}>
        <div className="app-modal-panel max-w-[min(38rem,calc(100vw-1rem))]">
          <form ref={formRef} onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <div className="modal-header">
              <div className="text-sm font-semibold text-slate-800">{editingId ? t("stockTx.editTitle") : t("stockTx.title")}</div>
              <button type="button" onClick={close} className="secondary-button h-8 px-2" title={t("stockTx.close")}>
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3 sm:px-5 sm:py-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {STOCK_ACTIONS.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => changeModalAction(item.key)}
                    className={`h-8 rounded-[10px] border px-2 text-xs ${action === item.key ? item.tone : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}
                  >
                    {t(item.labelKey)}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <div className="form-label">{t("stockPanel.stockAccountTitle")}</div>
                  <SmartSelect
                    mode="single"
                    value={stockAccountId}
                    onChange={(id) => {
                      cashAccountTouchedRef.current = false;
                      setStockAccountId(id);
                      if (isHoldingSelectionAction) {
                        setSelectedSecurityId("");
                        setStockCode("");
                        setStockName("");
                        setQuantity("");
                      }
                    }}
                    options={sortOptionsByRecent(filteredOptions ?? stockAccountOptions, recentAccountIds)}
                    placeholder={autoCreatingAccount ? t("stockTx.autoCreatingStockAccount") : t("stockTx.selectStockAccount")}
                    onCreateClick={() => setNestedAccountOpen(true)}
                    createLabel={t("stockTx.addStockAccount")}
                    onCycleOwnerFilter={cycleOwnerFilter}
                    ownerFilterLabel={ownerFilterLabel}
                    behavior={{ search: true, density: "compact", minDropdownWidth: 280 }}
                  />
                  {autoCreateError ? <div className="text-[11px] text-rose-600">{autoCreateError}</div> : null}
                </div>
                <div className="space-y-1">
                  <div className="form-label">{t("txForm.cashAccount")}</div>
                  <SmartSelect
                    mode="single"
                    value={selectedCashAccount?.id ?? cashAccountId}
                    onChange={(value) => {
                      cashAccountTouchedRef.current = true;
                      setCashAccountId(value);
                    }}
                    options={sortOptionsByRecent(eligibleCashAccountOptions, recentAccountIds)}
                    placeholder={eligibleCashAccountOptions.length > 0 ? t("stockTx.selectCashAccount") : t("stockTx.addCashAccount")}
                    onCreateClick={openNestedCashAccountCreate}
                    createLabel={t("stockTx.addCashAccount")}
                    behavior={{ search: true, density: "compact", minDropdownWidth: 260 }}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {isHoldingSelectionAction ? (
                  <div className="space-y-1 sm:col-span-3">
                    <div className="form-label">{action === "sell" || action === "share_change" ? t("stockTx.holdingStock") : t("stockTx.dividendStock")}</div>
                    <SmartSelect
                      mode="single"
                      value={selectedSecurityId}
                      onChange={selectHolding}
                      options={sellHoldingOptions}
                      placeholder={sellHoldingsLoading ? t("stockTx.loadingHoldings") : action === "sell" ? t("stockTx.selectSellableStock") : action === "share_change" ? t("stockTx.selectHoldingStock") : t("stockTx.selectDividendHoldingStock")}
                      behavior={{ search: true, density: "compact", minDropdownWidth: 300 }}
                    />
                    {sellHoldingsError ? <div className="text-[11px] text-rose-600">{sellHoldingsError}</div> : null}
                  </div>
                ) : (
                  <>
                    <div className="space-y-1">
                      <div className="form-label">{t("stockTx.stockCodeLabel")}</div>
                      <input
                        value={stockCode}
                        onChange={(event) => {
                          const nextCode = event.target.value.toUpperCase();
                          setStockCode(nextCode);
                          setStockName("");
                          setMarket(inferStockMarketFromCode(nextCode));
                        }}
                        className="form-input"
                        placeholder="600519 / 00700 / AAPL"
                      />
                    </div>
                    <div className="space-y-1 sm:col-span-2">
                      <div className="form-label">{t("stockTx.stockNameLabel")}</div>
                      <div className="flex h-9 items-center rounded-[10px] border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700">
                        {stockLookupLoading ? t("stockTx.searching") : stockName || ""}
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className={`grid grid-cols-1 gap-3 ${isBuySell ? "sm:grid-cols-3" : "sm:grid-cols-1"}`}>
                <div className="space-y-1">
                  <div className="form-label">{t("stockTx.tradeDateLabel")}</div>
                  <DateStepper value={tradeDate} onChange={handleTradeDateChange} />
                </div>
                {isBuySell ? (
                  <div className="space-y-1">
                    <div className="form-label">{quantityFieldLabel}</div>
                    <CalcInput value={quantity} onChange={setQuantity} placeholder={t("stockTx.quantityPlaceholder")} label={quantityFieldLabel} precision={4} />
                  </div>
                ) : null}
                {isBuySell ? (
                  <div className="space-y-1">
                    <div className="form-label">{t("stockTx.priceLabel")}</div>
                    <CalcInput value={price} onChange={setPrice} placeholder={t("stockTx.pricePlaceholder")} label={t("stockTx.priceLabel")} precision={4} />
                  </div>
                ) : null}
              </div>

              {isDividendAction ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                  <div className="space-y-1 sm:w-40 sm:shrink-0">
                    <div className="form-label">{t("stockTx.dividendModeLabel")}</div>
                    <select
                      value={dividendMode}
                      onChange={(event) => {
                        const nextMode = event.target.value as StockDividendMode;
                        setDividendMode(nextMode);
                        setQuantity("");
                        setGrossAmount("");
                        setNetAmount("");
                      }}
                      className="form-input"
                    >
                      <option value="cash">{t("stockTx.dividendMode.cash")}</option>
                      <option value="shares">{t("stockTx.dividendMode.shares")}</option>
                      <option value="cash_shares">{t("stockTx.dividendMode.cashShares")}</option>
                    </select>
                  </div>
                  <div className={`grid flex-1 grid-cols-1 gap-3 ${dividendMode === "cash_shares" ? "sm:grid-cols-3" : dividendMode === "cash" ? "sm:grid-cols-2" : "sm:grid-cols-1"}`}>
                    {dividendMode === "shares" ? (
                      <div className="space-y-1">
                        <div className="form-label">{t("stockTx.dividendShares")}</div>
                        <CalcInput value={quantity} onChange={setQuantity} placeholder={t("stockTx.dividendShares")} label={t("stockTx.dividendShares")} precision={4} />
                      </div>
                    ) : (
                      <>
                        <div className="space-y-1">
                          <div className="form-label">{t("stockTx.dividendAmount")}</div>
                          <CalcInput value={grossAmount} onChange={setGrossAmount} placeholder={t("stockTx.dividendAmount")} label={t("stockTx.dividendAmount")} precision={2} />
                        </div>
                        <div className="space-y-1">
                          <div className="form-label">{t("stockTx.netArrival")}</div>
                          <CalcInput value={netAmount} onChange={setNetAmount} placeholder={previewCashAmount > 0 ? previewCashAmount.toFixed(2) : t("stockFee.optional")} label={t("stockTx.netAmountLabel")} precision={2} />
                        </div>
                        {dividendMode === "cash_shares" ? (
                          <div className="space-y-1">
                            <div className="form-label">{t("stockTx.dividendShares")}</div>
                            <CalcInput value={quantity} onChange={setQuantity} placeholder={t("stockTx.dividendShares")} label={t("stockTx.dividendShares")} precision={4} />
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              ) : null}

              <div className={`grid grid-cols-1 gap-3 ${isBuySell ? "sm:grid-cols-1" : "sm:grid-cols-3"}`}>
                {isShareAction ? (
                  <div className="space-y-2 sm:col-span-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                      <div className="space-y-1 sm:w-40 sm:shrink-0">
                        <div className="form-label">{t("stockTx.shareChangeTypeLabel")}</div>
                        <select
                          value={shareChangeAction}
                          onChange={(event) => setShareChangeAction(event.target.value as typeof shareChangeAction)}
                          className="form-input"
                        >
                          {SHARE_CHANGE_ACTIONS.map((item) => <option key={item.key} value={item.key}>{t(item.labelKey)}</option>)}
                        </select>
                      </div>
                      <div className="flex-1 space-y-1">
                        <div className="form-label">{quantityFieldLabel}</div>
                        <CalcInput value={quantity} onChange={setQuantity} placeholder={t("stockTx.shareChangeQuantity")} label={quantityFieldLabel} precision={4} />
                      </div>
                    </div>
                    <div className="text-[11px] leading-relaxed text-slate-500">
                      {t("stockTx.shareChangeHint")}
                    </div>
                  </div>
                ) : null}
                {showQuantityField && !isBuySell && !isDividendAction && !isShareAction ? (
                  <div className="space-y-1">
                    <div className="form-label">{quantityFieldLabel}</div>
                    <CalcInput value={quantity} onChange={setQuantity} placeholder={t("stockTx.quantityPlaceholder")} label={quantityFieldLabel} precision={4} />
                  </div>
                ) : null}
                {showAmountField && !isBuySell && !isDividendAction ? (
                  <div className="space-y-1">
                    <div className="form-label">{amountLabelForAction(t, action)}</div>
                    <CalcInput
                      value={grossAmount}
                      onChange={setGrossAmount}
                      placeholder={t("txForm.amount")}
                      label={amountLabelForAction(t, action)}
                      precision={2}
                    />
                  </div>
                ) : null}
                {showNetAmount && !isDividendAction ? (
                  <div className="space-y-1">
                    <div className="form-label">{t("stockTx.netArrival")}</div>
                    <CalcInput value={netAmount} onChange={setNetAmount} placeholder={previewCashAmount > 0 ? previewCashAmount.toFixed(2) : t("stockFee.optional")} label={t("stockTx.netAmountLabel")} precision={2} />
                  </div>
                ) : null}
              </div>

              {isBuySell && !editingId ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                    {feeInputConfigs.map((item) => (
                      <div key={item.key} className="space-y-1">
                        <div className="form-label">{t(item.labelKey)}</div>
                        <CalcInput
                          value={feeDraft[item.key] || (item.estimateValue == null ? "" : feeDraftValue(item.estimateValue))}
                          onChange={(value) => updateFeeDraft(item.key, value)}
                          placeholder={item.estimateValue == null ? t("stockFee.optional") : formatMoney(item.estimateValue, displayCurrency)}
                          label={t(item.labelKey)}
                          precision={2}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <div className="form-label">{t("stockTx.feeSubtotalWithCurrency", { currency: displayCurrency })}</div>
                      <input
                        value={feeTotalDisplay}
                        readOnly
                        title={feeBreakdownTitle}
                        className="form-input bg-slate-50 text-right font-semibold tabular-nums text-slate-900"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="form-label">{t("stockTx.amountTotalWithCurrency", { currency: displayCurrency })}</div>
                      <input
                        value={finalCashAmountDisplay}
                        readOnly
                        title={action === "buy" ? t("stockTx.finalCashDebitTitle") : t("stockTx.finalCashCreditTitle")}
                        className="form-input bg-slate-50 text-right font-semibold tabular-nums text-slate-900"
                      />
                    </div>
                  </div>
                  {feeEstimateError ? <div className="text-xs text-rose-600">{feeEstimateError}</div> : null}
                  {feeEstimateStatus ? <div className="text-xs text-emerald-700">{feeEstimateStatus}</div> : null}
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-3">
                <div className="space-y-1">
                  <div className="form-label">{t("detail.column.remark")}</div>
                  <div className="flex items-start gap-2">
                    <input value={note} onChange={(event) => setNote(event.target.value)} className="form-input flex-1" placeholder={t("stockFee.optional")} />
                    <EntryAttachmentButton
                      entryId={attachmentEntryId}
                      pendingFiles={pendingAttachmentFiles}
                      onPendingFilesChange={setPendingAttachmentFiles}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="shrink-0 border-t border-slate-100 bg-white/95 px-3 py-3 sm:px-5">
              <div className="flex justify-end gap-2">
                {!editingId ? (
                  <button
                    type="button"
                    disabled={submitting || autoCreatingAccount}
                    className="secondary-button h-9 px-4 text-sm disabled:opacity-50"
                    onClick={() => {
                      submitModeRef.current = "repeat";
                      formRef.current?.requestSubmit();
                    }}
                  >
                    {t("txForm.saveAndRepeat")}
                  </button>
                ) : null}
                <button
                  type="submit"
                  disabled={submitting || autoCreatingAccount}
                  className="primary-button h-9 px-4 text-sm disabled:opacity-50"
                >
                  {submitting ? t("stockTx.saving") : t("common.save")}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
      <EntityCreateForm
        mode="compact"
        entityType="account"
        open={nestedAccountOpen}
        onClose={() => setNestedAccountOpen(false)}
        onCreated={(id, name, extra) => handleStockAccountCreated(id, name, extra as StockAccountCreatedExtra)}
        title={t("stockTx.addStockAccount")}
        nameLabel={t("stockTx.stockAccountNameLabel")}
        namePlaceholder={t("stockTx.stockAccountNamePlaceholder")}
        defaultType="investment"
        extraFields={{ kind: "investment", investProductType: "stock" }}
        hiddenFields={["kind", "investProductType", "fundUnitsDecimals", "tradingCalendar"]}
        nestedFieldData={accountCreateFieldData}
        existingNames={existingStockAccountNames}
      />
      <EntityCreateForm
        mode="compact"
        entityType="account"
        open={nestedCashAccountOpen}
        onClose={() => setNestedCashAccountOpen(false)}
        onCreated={(id, name, extra) => handleCashAccountCreated(id, name, extra as StockAccountCreatedExtra)}
        title={t("stockTx.addCashAccount")}
        nameLabel={t("stockTx.cashAccountNameLabel")}
        namePlaceholder={t("stockTx.cashAccountNamePlaceholder")}
        defaultType="ewallet"
        extraFields={cashAccountCreateExtraFields}
        hiddenFields={[]}
        allowedAccountKinds={["bank_debit", "ewallet"]}
        readOnlyFields={cashAccountCreateReadOnlyFields}
        nestedFieldData={accountCreateFieldData}
        existingNames={existingCashAccountNames}
      />
    </ModalLayerProvider>,
    document.body,
  );
}
