"use client";

import { DatabaseZap, Pencil, Plus, Repeat, Trash2 } from "lucide-react";
import { CalcInput } from "./CalcInput";
import { DateStepper } from "./DateStepper";
import { NestedAddModal } from "./EntityCreateForm";
import { HoldingPicker } from "./HoldingPicker";
import { EntryTagsField } from "./EntryTagsField";
import { ModalLayerProvider, getNextModalLayerZIndex, useModalLayerZIndex } from "./ModalLayer";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { useI18n } from "@/lib/i18n";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { deleteEntriesWithLinkedPrompt, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { sortOptionsByRecent, useRecentAccountIds } from "@/lib/client/recentAccounts";
import { getColorSchemeFromCookie, pnlClassFromRedUp } from "@/lib/client/colors";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useCloseOnNavigation } from "@/lib/client/useCloseOnNavigation";
import { addTradingDaysUtc, countTradingDaysUtc } from "@/lib/date-utils";
import { findLinkedEntries, type RefundLinkableEntry } from "@/lib/fund/refund-link";
import { formatFundUnitsValue, normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision-core";
import {
  type FundSubtype,
  type ProductType,
  PRODUCT_SUBTYPES,
  parseNumber,
  isRedeemLike,
  isBuyLike,
  isDividend,
  showConfirmFor,
  showAccountSelectorsFor,
  showUnitsFor,
  showFeeFor,
} from "@/lib/investment-config";

const KNOWN_SUBTYPES = new Set<FundSubtype>(["buy", "redeem", "dividend_cash", "dividend_reinvest", "buy_failed"]);

function pnlCls(n: number | null | undefined): string {
  if (n == null) return "text-slate-600";
  const scheme = getColorSchemeFromCookie(typeof document === "undefined" ? null : document.cookie);
  return pnlClassFromRedUp(n, scheme === "red_up_green_down");
}

const p = parseNumber;

function addFundTradingDays(date: string, days: number) {
  return days > 0 ? addTradingDaysUtc(date, days, "cn_fund") : date;
}

function buildFundNavUrl(code: string, date: string, accountId?: string, applyDate?: string, subtype?: FundSubtype) {
  const params = new URLSearchParams({
    code,
    date,
  });
  if (accountId) params.set("accountId", accountId);
  if (subtype === "buy" && applyDate) {
    params.set("purpose", "buy");
    params.set("applyDate", applyDate);
  }
  return `/api/v1/fund/nav?${params.toString()}`;
}

function normalizeYmd(value: string | Date | null | undefined): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim().slice(0, 10);
}

// Entry data for edit mode.
export type InvestmentEntry = {
  id: string;
  transactionId: string;
  date: string;
  confirmDate?: string;
  amount: number;
  note: string | null;
  memo: string | null;
  fundCode: string | null;
  fundName: string | null;
  fundUnits: number | null;
  displayFundUnits?: number | null;
  fundNav: number | null;
  fundFee: number | null;
  fundProductType: string | null;
  fundSubtype: string | null;
  metalTypeId?: string | null;
  metalTypeName?: string | null;
  metalUnitId?: string | null;
  metalUnitName?: string | null;
  metalQuantity?: number | null;
  metalUnitPrice?: number | null;
  metalFee?: number | null;
  source?: string | null;
  accountId?: string | null;
  toAccountId?: string | null;
  fundSourceEntryId?: string | null;
  cashAccountId?: string | null;
  toAccountName?: string | null;
  fundArrivalDate?: string | null;
  fundArrivalAmount?: number | null;
  refundAmount?: number | null;
  realizedProfit?: number | null;
  feeRate?: string | number | null;
  tags?: Array<{ id?: string; tagId?: string }> | null;
  tagIds?: string[] | null;
};

// Default values for create mode.
export type InvestmentDefaults = {
  fundCode?: string;
  fundName?: string;
  fundUnits?: number | null;
  confirmDays?: number | null;
  feeRate?: string | null;
};

type OpenInvestmentCreateDetail = {
  requestId: string;
  defaultAccountId?: string;
  defaultCashAccountId?: string;
  defaultDate?: string;
  defaultAmount?: number;
  defaultProductType?: ProductType;
  defaultFundCode?: string;
  defaultFundName?: string;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;
type AccountOption = {
  id: string;
  label: string;
  kind?: string;
  investProductType?: string | null;
  institutionId?: string | null;
};
type FundHoldingOption = { fundCode: string; name: string; units: number };
type LoadedFundAccountData = {
  accountId: string;
  holdings: FundHoldingOption[];
  allEntries: LinkedCandidateEntry[];
};
type PreciousMetalTypeOption = { id: string; code: string; name: string; shortName?: string | null };
type PreciousMetalUnitOption = { id: string; code: string; name: string; symbol?: string | null; decimals?: number | null };
type BuyResultStatus = "normal" | "refund";
type LinkedCandidateEntry = {
  id: string;
  date: string;
  createdAt?: string | Date | null;
  fundConfirmDate?: string | null;
  fundArrivalDate?: string | null;
  fundCode: string;
  fundName?: string | null;
  fundSubtype: string;
  fundUnits: number | null;
  source: string | null;
  accountId?: string | null;
  toAccountId?: string | null;
  amount?: number;
  fundSourceEntryId?: string | null;
};

type InvestmentEditDetail = {
  requestId: string;
  entryId: string;
  type: string;
  date: string;
  confirmDate?: string | null;
  amount: number;
  note: string;
  accountId?: string;
  toAccountId?: string;
  fundCode?: string;
  fundName?: string;
  fundSubtype?: string;
  source?: string;
  fundSourceEntryId?: string | null;
  fundUnits?: number;
  displayFundUnits?: number;
  fundNav?: number;
  fundFee?: number;
  fundProductType?: string;
  metalTypeId?: string | null;
  metalTypeName?: string | null;
  metalUnitId?: string | null;
  metalUnitName?: string | null;
  cashAccountId?: string;
  fundArrivalDate?: string | null;
  fundArrivalAmount?: number | null;
  refundAmount?: number | null;
  linkedCandidateEntries?: LinkedCandidateEntry[];
  feeRate?: string | number | null;
  tags?: Array<{ id?: string; tagId?: string }> | null;
  tagIds?: string[] | null;
};

function inferNonNegativeDays(startDate?: string | null, endDate?: string | null) {
  const start = String(startDate ?? "").trim();
  const end = String(endDate ?? "").trim();
  if (!start || !end) return null;
  const startTime = new Date(`${start.slice(0, 10)}T00:00:00Z`).getTime();
  const endTime = new Date(`${end.slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  const diff = Math.round((endTime - startTime) / 86400000);
  return diff >= 0 ? diff : null;
}

export function InvestmentFormModal({
  mode,
  accountId: defaultAccountId,
  accountProductType,
  entry,
  defaults,
  cashAccounts,
  investmentAccounts,
  cashAccountSSOptions,
  investmentAccountSSOptions,
  metalTypes,
  metalUnits,
  nestedFieldData: nestedFieldDataProp,
  holdings,
  allEntries,
  createAction,
  editAction,
  openSignal,
  hideTrigger,
  listenCreateEvents = true,
  fundUnitsDecimals: fundUnitsDecimalsProp,
}: {
  mode: "create" | "edit";
  accountId: string;
  accountProductType?: string | null;
  entry?: InvestmentEntry;
  defaults?: InvestmentDefaults;
  cashAccounts?: AccountOption[];
  investmentAccounts?: AccountOption[];
  cashAccountSSOptions?: SmartSelectOption[];
  investmentAccountSSOptions?: SmartSelectOption[];
  metalTypes?: PreciousMetalTypeOption[];
  metalUnits?: PreciousMetalUnitOption[];
  nestedFieldData?: NestedFieldData;
  holdings?: FundHoldingOption[];
  allEntries?: LinkedCandidateEntry[];
  createAction: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  editAction?: (formData: FormData) => Promise<{ ok: true } | { ok: false; error: string }>;
  openSignal?: number;
  hideTrigger?: boolean;
  listenCreateEvents?: boolean;
  fundUnitsDecimals?: number | null;
}) {
  const { t, language } = useI18n();
  const parentModalZIndex = useModalLayerZIndex();
  const modalZIndex = getNextModalLayerZIndex(parentModalZIndex);
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const fundUnitsDecimals = normalizeFundUnitsDecimals(fundUnitsDecimalsProp, 2);
  const formatUnits = (value: number) => formatFundUnitsValue(value, fundUnitsDecimals);

  const fixedProductType: ProductType =
    (["fund", "money", "wealth", "deposit", "metal"].includes(accountProductType ?? "")
      ? accountProductType as ProductType
      : (mode === "edit" && entry?.fundProductType && ["fund", "money", "wealth", "deposit", "metal"].includes(entry.fundProductType)
        ? entry.fundProductType as ProductType
        : "fund"));

  // When editing legacy records, map the stored form to the current display subtype.
  const initDisplaySubtype: FundSubtype = mode === "edit" && entry?.fundSubtype === "buy_failed" && entry?.source === "regular_invest_refund"
    ? "buy"
    : mode === "edit" && entry?.fundSubtype === "buy" && entry?.source === "dividend"
    ? "dividend_reinvest"
    : mode === "edit" && entry?.fundSubtype && KNOWN_SUBTYPES.has(entry.fundSubtype as FundSubtype)
    ? entry.fundSubtype as FundSubtype
    : (mode === "edit" && entry && entry.amount < 0 ? "buy" : "redeem");
  const initSubtype: FundSubtype = initDisplaySubtype;
  const initAmount = mode === "edit" && entry ? Math.abs(entry.amount) : "";
  const initNav = mode === "edit" && fixedProductType === "metal" && entry?.metalUnitPrice != null
    ? String(entry.metalUnitPrice)
    : mode === "edit" && entry?.fundNav != null ? String(entry.fundNav) : "";
  const initUsesRedeemAsOfUnits =
    mode === "create" &&
    isRedeemLike(initSubtype) &&
    (fixedProductType === "fund" || fixedProductType === "money");
  const initUnits = mode === "edit" && fixedProductType === "metal" && entry?.metalQuantity != null
    ? formatUnits(Number(entry.metalQuantity))
    : mode === "edit" && (entry?.displayFundUnits ?? entry?.fundUnits) != null ? formatUnits(Number(entry?.displayFundUnits ?? entry?.fundUnits))
    : !initUsesRedeemAsOfUnits && defaults?.fundUnits && defaults.fundUnits > 0 ? formatUnits(Number(defaults.fundUnits)) : "";
  const initFee = mode === "edit" && fixedProductType === "metal" && entry?.metalFee != null
    ? String(entry.metalFee)
    : mode === "edit" && entry?.fundFee != null ? String(entry.fundFee) : "";
  // Buy: cash account -> fund account; redeem / cash dividend: fund account -> cash account.
  const initCashReceivingEntry = isRedeemLike(initSubtype) || initSubtype === "dividend_cash";
  const initCashAccountId = mode === "edit"
    ? (initCashReceivingEntry ? (entry?.toAccountId ?? "") : (entry?.accountId ?? ""))
    : "";
  const initToAccountId = mode === "edit"
    ? (initCashReceivingEntry ? (entry?.accountId ?? defaultAccountId) : (entry?.toAccountId ?? defaultAccountId))
    : defaultAccountId;
  const initConfirmDays =
    (mode === "edit" && entry ? inferNonNegativeDays(entry.date, entry.confirmDate ?? null) : null)
    ?? (defaults?.confirmDays ?? 0);
  const initFeeRate = mode === "edit" ? String(entry?.feeRate ?? defaults?.feeRate ?? "0") : (defaults?.feeRate ?? "0");
  const initFundCode = mode === "edit" ? (entry?.fundCode ?? "") : (defaults?.fundCode ?? "");
  const initFundName = mode === "edit" ? (entry?.fundName ?? entry?.fundCode ?? "") : (defaults?.fundName ?? "");
  const initMetalTypeId = mode === "edit" ? (entry?.metalTypeId ?? (fixedProductType === "metal" ? initFundCode : "")) : "";
  const initMetalUnitId = mode === "edit" ? (entry?.metalUnitId ?? "") : "";
  const initArrivalDate = mode === "edit"
    ? (entry?.fundArrivalDate ?? (() => {
        const dt = mode === "edit" && entry ? entry.date : today;
        const days = typeof initConfirmDays === "number" ? initConfirmDays : Number(initConfirmDays) || 0;
        if ((initSubtype === "dividend_cash" || initSubtype === "dividend_reinvest") && dt && days >= 0) {
          const d = new Date(dt + "T00:00:00Z");
          d.setDate(d.getDate() + days);
          return d.toISOString().slice(0, 10);
        }
        return "";
      })())
    : (initSubtype === "dividend_cash" ? today : "");
  const initRefundAmount = mode === "edit" && entry?.fundSubtype === "buy"
    ? Math.max(0, Number(entry?.refundAmount) || 0)
    : 0;
  const initArrivalAmount = mode === "edit" && entry?.fundSubtype === "buy" && initRefundAmount > 0
    ? String(initRefundAmount)
    : mode === "edit" && entry?.fundArrivalAmount != null
      ? String(entry.fundArrivalAmount)
      : "";
  const initMemo = mode === "edit" ? (entry?.memo ?? entry?.note ?? "") : "";
  const initDate = mode === "edit" && entry ? entry.date : today;
  const initConfirmDate = mode === "edit" && entry ? (entry.confirmDate ?? "") : "";
  const initHasRefund =
    mode === "edit" &&
    ((entry?.fundSubtype === "buy_failed" && entry?.source === "regular_invest_refund") ||
      (entry?.fundSubtype === "buy" && initRefundAmount > 0));
  const initConfirmDaysValue = typeof initConfirmDays === "number" ? initConfirmDays : Number(initConfirmDays) || 0;

  const [open, setOpen] = useState(false);
  const [productType, setProductType] = useState<ProductType>(fixedProductType);
  const [subtype, setSubtype] = useState<FundSubtype>(initSubtype);
  const [applyDate, setApplyDate] = useState(initDate);
  const [confirmDate, setConfirmDate] = useState(initConfirmDate);
  const [cashAccountId, setCashAccountId] = useState(initCashAccountId);
  const [toAccountId, setToAccountId] = useState(initToAccountId);
  const cashAccountIdRef = useRef(initCashAccountId);
  const cashAccountTouchedRef = useRef(false);
  const cashAccountAutoRef = useRef(false);
  const investmentAccountTouchedRef = useRef(mode === "edit");
  const [fundCode, setFundCode] = useState(initFundCode);
  const [fundName, setFundName] = useState(initFundName);
  const [metalTypeId, setMetalTypeId] = useState(initMetalTypeId);
  const [metalUnitId, setMetalUnitId] = useState(initMetalUnitId);
  const [nameLoading, setNameLoading] = useState(false);
  const [nav, setNav] = useState(initNav);
  const [navLoading, setNavLoading] = useState(false);
  const [navActualDate, setNavActualDate] = useState<string | null>(null);
  const [units, setUnits] = useState(initUnits);
  const [amount, setAmount] = useState(String(initAmount));
  const [feeRate, setFeeRate] = useState(initFeeRate);
  const [arrivalDate, setArrivalDate] = useState(initArrivalDate);
  const [arrivalAmount, setArrivalAmount] = useState(initArrivalAmount);
  const [feeRateEdited, setFeeRateEdited] = useState(false);
  const [fee, setFee] = useState(initFee);
  const [feeEdited, setFeeEdited] = useState(false);
  const redeemTermsRef = useRef({
    mode,
    productType: fixedProductType,
    subtype: initSubtype,
    units: initUnits,
    nav: initNav,
    fee: initFee,
    feeRate: initFeeRate,
    feeRateEdited,
    feeEdited: false,
  });
  redeemTermsRef.current = { mode, productType, subtype, units, nav, fee, feeRate, feeRateEdited, feeEdited };
  function shouldRecalculateFeeFromRateForCurrentInputs() {
    return showFeeFor(subtype, productType) && !feeEdited && (mode === "create" || feeRateEdited);
  }
  function shouldRecalculateFeeFromRateForTerms(terms: typeof redeemTermsRef.current) {
    return showFeeFor(terms.subtype, terms.productType) && !terms.feeEdited && (terms.mode === "create" || terms.feeRateEdited);
  }
  const [confirmDays, setConfirmDays] = useState(initConfirmDaysValue);
  const [confirmDaysEdited, setConfirmDaysEdited] = useState(false);
  const [redeemCostDays, setRedeemCostDays] = useState(1);
  const [arrivalDays, setArrivalDays] = useState(2);
  const [deleting, setDeleting] = useState(false);
  const [editEntryId, setEditEntryId] = useState<string | null>(null);
  const [buyResultStatus, setBuyResultStatus] = useState<BuyResultStatus>(initHasRefund ? "refund" : "normal");
  const [eventEditEntry, setEventEditEntry] = useState<InvestmentEntry | null>(null);
  const [eventLinkedEntries, setEventLinkedEntries] = useState<LinkedCandidateEntry[] | null>(null);
  const [loadedFundAccountData, setLoadedFundAccountData] = useState<LoadedFundAccountData | null>(null);
  const [holdingFundLoading, setHoldingFundLoading] = useState(false);
  const [linkedRefundEntryId, setLinkedRefundEntryId] = useState<string | null>(null);
  const fundAccountDataCacheRef = useRef<Map<string, LoadedFundAccountData>>(new Map());
  const lastNavFetchKey = useRef<string>("");
  const navDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  function setNavFromApi(navStr: string) {
    setNav(navStr);
    navEditedRef.current = true;
  }
  const [memo, setMemo] = useState(initMemo);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(() =>
    mode === "edit" && entry
      ? (entry.tags as Array<{ id: string }> | undefined)?.map((tag) => tag.id) ?? (entry.tagIds as string[] | undefined) ?? []
      : [],
  );
  const unitsEditedRef = useRef(false);
  const amountEditedRef = useRef(false);
  const navEditedRef = useRef(false);
  const [holdingSearch, setHoldingSearch] = useState(initFundCode && initFundName ? `${initFundCode} ${initFundName}` : "");
  const [submitting, setSubmitting] = useState(false);
  const [nestedEntityType, setNestedEntityType] = useState<"cash-account" | "invest-account" | null>(null);
  // Local copy of nested option data (institutions/groups) so newly created
  // nested entities persist across account-dialog instances within this modal.
  const [nestedFieldData, setNestedFieldData] = useState<NestedFieldData>(nestedFieldDataProp ?? {});
  const dividendAmountRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef<string | null>(null);
  const handledInvestmentEditRequestRef = useRef<string | null>(null);
  const pendingFundCodeFetchRef = useRef<string | null>(null);
  const prevSavedDateRef = useRef<string | null>(null);
  const editAutoNavEnabledRef = useRef(mode !== "edit");
  const suppressFeeAutoCalcRef = useRef(mode === "edit");
  const [localCashAccountList, setLocalCashAccountList] = useState(cashAccounts ?? []);
  const [localInvestmentAccountList, setLocalInvestmentAccountList] = useState(investmentAccounts ?? []);
  const [localCashSSOptions, setLocalCashSSOptions] = useState(cashAccountSSOptions);
  const [localInvestmentSSOptions, setLocalInvestmentSSOptions] = useState(investmentAccountSSOptions);

  // Keep the local nested option data in sync when the server-provided prop
  // changes (e.g. after a page refresh), without discarding locally created
  // institutions/groups.
  useEffect(() => {
    if (nestedFieldDataProp) setNestedFieldData(nestedFieldDataProp);
  }, [nestedFieldDataProp]);

  const currentEditEntry = mode === "edit" ? (eventEditEntry ?? entry ?? null) : null;

  function shouldHandleInvestmentEdit(detail: InvestmentEditDetail) {
    if (mode !== "edit") return false;
    if (entry?.id && entry.id !== detail.entryId && entry.transactionId !== detail.entryId) return false;
    if (!defaultAccountId) return true;
    const relatedAccountIds = [detail.accountId, detail.toAccountId, detail.cashAccountId].filter(Boolean);
    return relatedAccountIds.length === 0 || relatedAccountIds.includes(defaultAccountId);
  }

  // Linked buy/refund records for display in the edit modal.
  const linkedRecords = useMemo(() => {
    // The detail API supplies the complete cross-account link set. Keep page
    // entries too, but let those complete records win when IDs overlap.
    const candidateById = new Map<string, LinkedCandidateEntry>();
    for (const item of allEntries ?? []) candidateById.set(item.id, item);
    for (const item of eventLinkedEntries ?? []) candidateById.set(item.id, item);
    const candidateEntries = Array.from(candidateById.values());
    if (mode !== "edit" || !currentEditEntry || !candidateEntries || candidateEntries.length === 0) return null;
    const target: RefundLinkableEntry = {
      id: currentEditEntry.id,
      date: currentEditEntry.date,
      fundConfirmDate: currentEditEntry.confirmDate ?? null,
      fundArrivalDate: currentEditEntry.fundArrivalDate ?? null,
      accountId: currentEditEntry.accountId,
      toAccountId: currentEditEntry.toAccountId,
      fundCode: currentEditEntry.fundCode,
      fundSubtype: currentEditEntry.fundSubtype,
      source: currentEditEntry.source,
      amount: currentEditEntry.amount,
      fundSourceEntryId: currentEditEntry.fundSourceEntryId ?? null,
    };
    const allMapped: RefundLinkableEntry[] = candidateEntries.map(e => ({
      id: e.id,
      date: e.date,
      createdAt: e.createdAt,
      fundConfirmDate: e.fundConfirmDate ?? null,
      fundArrivalDate: e.fundArrivalDate ?? null,
      accountId: e.accountId ?? null,
      toAccountId: e.toAccountId ?? null,
      fundCode: e.fundCode,
      fundSubtype: e.fundSubtype,
      source: e.source,
      amount: e.amount ?? 0,
      fundSourceEntryId: e.fundSourceEntryId ?? null,
    }));
    return findLinkedEntries(target, allMapped);
  }, [mode, currentEditEntry, allEntries, eventLinkedEntries]);

  const linkedRefundTotal = useMemo(() => {
    if (mode !== "edit" || !linkedRecords || linkedRecords.linkedRefunds.length === 0) return 0;
    return linkedRecords.linkedRefunds.reduce((sum, r) => sum + Math.abs(r.amount), 0);
  }, [mode, linkedRecords]);

  const firstLinkedRefund = useMemo(() => {
    if (mode !== "edit" || !linkedRecords || linkedRecords.linkedRefunds.length === 0) return null;
    return linkedRecords.linkedRefunds[0] ?? null;
  }, [mode, linkedRecords]);

  function applyLinkedRefundToForm(refund?: RefundLinkableEntry | null) {
    if (!refund) return false;
    setLinkedRefundEntryId(refund.id);
    setArrivalAmount(Math.abs(Number(refund.amount) || 0).toFixed(2));
    const refundDate = normalizeYmd(refund.fundArrivalDate ?? refund.date);
    if (refundDate && !arrivalDateEditedRef.current) setArrivalDate(refundDate);
    calculateBuyUnits(amount, fee, String(Math.abs(Number(refund.amount) || 0)), nav, true);
    return true;
  }

  function toggleBuyRefund(enabled: boolean) {
    setBuyResultStatus(enabled ? "refund" : "normal");
    if (enabled) {
      const applied = applyLinkedRefundToForm(firstLinkedRefund);
      if (!applied && !arrivalDate) {
        const baseDate = applyDate || confirmDate;
        setArrivalDate(baseDate && arrivalDays > 0 ? addFundTradingDays(baseDate, arrivalDays) : baseDate);
      }
      return;
    }
    setArrivalAmount("");
    calculateUnitsAfterRefundChange("");
  }

  useEffect(() => {
    if (mode !== "edit" || !open || subtype !== "buy" || linkedRefundTotal <= 0) return;
    setBuyResultStatus("refund");
    if (firstLinkedRefund && !linkedRefundEntryId) setLinkedRefundEntryId(firstLinkedRefund.id);
    if (p(arrivalAmount) === 0) setArrivalAmount(linkedRefundTotal.toFixed(2));
    const firstRefundDate = firstLinkedRefund?.fundArrivalDate ?? firstLinkedRefund?.date;
    if (firstRefundDate && !arrivalDateEditedRef.current) setArrivalDate(normalizeYmd(firstRefundDate));
  }, [mode, open, subtype, linkedRefundTotal, firstLinkedRefund, linkedRefundEntryId, arrivalAmount]);

  useEffect(() => {
    if (mode !== "edit" || !open || !editEntryId) return;
    const controller = new AbortController();
    fetch(`/api/v1/transactions/detail?id=${encodeURIComponent(editEntryId)}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => {
        const candidates = d?.data?.linkedCandidateEntries;
        if (Array.isArray(candidates)) setEventLinkedEntries(candidates);
      })
      .catch((err) => {
        if (err?.name !== "AbortError") console.error("Load linked fund records failed:", err);
      });
    return () => controller.abort();
  }, [mode, open, editEntryId]);

  const flatCashAccountOptions = useMemo<SmartSelectOption[]>(
    () => localCashAccountList.map((account) => ({ id: account.id, label: account.label })),
    [localCashAccountList],
  );
  const flatInvestmentAccountOptions = useMemo<SmartSelectOption[]>(
    () => localInvestmentAccountList.map((account) => ({ id: account.id, label: account.label })),
    [localInvestmentAccountList],
  );
  const investmentAccountMatchesProductType = (account: AccountOption) => {
    if (productType === "metal") return account.investProductType === "metal";
    if (productType === "wealth") return account.investProductType === "wealth";
    if (productType === "deposit") return account.investProductType === "deposit" || account.kind === "deposit";
    if (productType === "fund" || productType === "money") {
      return account.investProductType === "fund" || account.investProductType === "money";
    }
    return true;
  };
  const productInvestmentAccountList = useMemo(
    () => localInvestmentAccountList.filter(investmentAccountMatchesProductType),
    [localInvestmentAccountList, productType],
  );
  const productInvestmentAccountIds = useMemo(
    () => new Set(productInvestmentAccountList.map((account) => account.id)),
    [productInvestmentAccountList],
  );
  const selectedCashInstitutionId = useMemo(
    () => localCashAccountList.find((account) => account.id === cashAccountId)?.institutionId ?? null,
    [localCashAccountList, cashAccountId],
  );
  const currentInvestmentAccountOption = useMemo(
    () => localInvestmentAccountList.find((account) => account.id === toAccountId) ?? null,
    [localInvestmentAccountList, toAccountId],
  );
  const productInvestmentSSOptions = useMemo(
    () => (localInvestmentSSOptions ?? []).filter((option) => option.isHeader || productInvestmentAccountIds.has(option.id)),
    [localInvestmentSSOptions, productInvestmentAccountIds],
  );
  const flatProductInvestmentAccountOptions = useMemo<SmartSelectOption[]>(
    () => productInvestmentAccountList.map((account) => ({ id: account.id, label: account.label })),
    [productInvestmentAccountList],
  );
  const metalTypeOptions = useMemo<SmartSelectOption[]>(
    () => (metalTypes ?? []).map((item) => ({
      id: item.id,
      label: item.name,
      subLabel: [item.shortName?.trim(), item.code].filter(Boolean).join(" · "),
    })),
    [metalTypes],
  );
  const metalUnitOptions = useMemo<SmartSelectOption[]>(
    () => (metalUnits ?? []).map((item) => ({
      id: item.id,
      label: item.symbol ? `${item.name} (${item.symbol})` : item.name,
      subLabel: item.code,
    })),
    [metalUnits],
  );
  const {
    ownerFilterLabel: cashOwnerFilterLabel,
    cycleOwnerFilter: cycleCashOwnerFilter,
    filteredOptions: cashAccountSSFiltered,
  } = useAccountSSFilter(localCashSSOptions);
  const {
    ownerFilterLabel: investmentOwnerFilterLabel,
    cycleOwnerFilter: cycleInvestmentOwnerFilter,
    filteredOptions: investmentAccountSSFiltered,
  } = useAccountSSFilter(productInvestmentSSOptions);
  const recentAccountIds = useRecentAccountIds();
  const visibleCashAccountOptions = sortOptionsByRecent(localCashSSOptions ? (cashAccountSSFiltered ?? localCashSSOptions) : flatCashAccountOptions, recentAccountIds);
  const visibleInvestmentAccountOptions = sortOptionsByRecent(productInvestmentSSOptions.length > 0 ? (investmentAccountSSFiltered ?? productInvestmentSSOptions) : flatProductInvestmentAccountOptions, recentAccountIds);
  const cashCycleAction = localCashSSOptions?.some((option) => option.isHeader)
    ? {
        onClick: cycleCashOwnerFilter,
        title: t("investForm.ownerFilter.title", { label: cashOwnerFilterLabel }),
        ariaLabel: t("investForm.ownerFilter.ariaLabel", { label: cashOwnerFilterLabel }),
        icon: <Repeat className="h-3.5 w-3.5" />,
      }
    : undefined;
  const investmentCycleAction = productInvestmentSSOptions.some((option) => option.isHeader)
    ? {
        onClick: cycleInvestmentOwnerFilter,
        title: t("investForm.ownerFilter.title", { label: investmentOwnerFilterLabel }),
        ariaLabel: t("investForm.ownerFilter.ariaLabel", { label: investmentOwnerFilterLabel }),
        icon: <Repeat className="h-3.5 w-3.5" />,
      }
    : undefined;

  useEffect(() => {
    setLocalCashAccountList(cashAccounts ?? []);
  }, [cashAccounts]);

  useEffect(() => {
    setLocalInvestmentAccountList(investmentAccounts ?? []);
  }, [investmentAccounts]);

  useEffect(() => {
    setLocalCashSSOptions(cashAccountSSOptions);
  }, [cashAccountSSOptions]);

  useEffect(() => {
    setLocalInvestmentSSOptions(investmentAccountSSOptions);
  }, [investmentAccountSSOptions]);

  useEffect(() => {
    if (!open) return;
    if (toAccountId && productInvestmentAccountIds.has(toAccountId)) return;
    if (mode === "edit" && toAccountId) return;
    if (investmentAccountTouchedRef.current) return;
    const fallbackAccountId = productInvestmentAccountList[0]?.id ?? "";
    if (fallbackAccountId) setToAccountId(fallbackAccountId);
  }, [mode, open, productInvestmentAccountIds, productInvestmentAccountList, toAccountId]);

  useEffect(() => {
    if (mode !== "create" || !open) return;
    if (!isBuyLike(subtype) || isDividend(subtype)) return;
    if (!selectedCashInstitutionId) return;
    if (investmentAccountTouchedRef.current) return;
    if (currentInvestmentAccountOption?.institutionId === selectedCashInstitutionId) return;
    const sameInstitutionAccount = productInvestmentAccountList.find(
      (account) => account.institutionId && account.institutionId === selectedCashInstitutionId,
    );
    if (!sameInstitutionAccount) return;
    setToAccountId(sameInstitutionAccount.id);
  }, [
    currentInvestmentAccountOption?.institutionId,
    mode,
    open,
    productInvestmentAccountList,
    selectedCashInstitutionId,
    subtype,
  ]);

  useEffect(() => {
    if (productType !== "metal") return;
    if (!metalTypeId && metalTypes?.[0]) applyMetalType(metalTypes[0].id);
    if (!metalUnitId && metalUnits?.[0]) setMetalUnitId(metalUnits[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productType, metalTypes, metalUnits]);

  function selectCashAccount(id: string) {
    cashAccountTouchedRef.current = true;
    cashAccountAutoRef.current = false;
    setCashAccountId(id);
  }

  function renderCashAccountSelect(placeholder = t("investForm.selectCashAccount")) {
    return (
      <SmartSelect
        mode="single"
        value={cashAccountId}
        onChange={selectCashAccount}
        options={visibleCashAccountOptions}
        placeholder={placeholder}
        onCreateClick={() => setNestedEntityType("cash-account")}
        createLabel={t("settings.accounts.add")}
        cycleAction={cashCycleAction}
        behavior={{
          hierarchy: "auto",
          search: "auto",
          clearable: true,
        }}
      />
    );
  }

  function renderInvestmentAccountSelect(placeholder = t("investForm.selectAccount")) {
    return (
      <SmartSelect
        mode="single"
        value={toAccountId}
        onChange={(id) => {
          investmentAccountTouchedRef.current = true;
          setToAccountId(id);
        }}
        options={visibleInvestmentAccountOptions}
        placeholder={placeholder}
        onCreateClick={() => setNestedEntityType("invest-account")}
        createLabel={t("settings.accounts.add")}
        cycleAction={investmentCycleAction}
        behavior={{
          hierarchy: "auto",
          search: "auto",
          clearable: true,
        }}
      />
    );
  }

  function renderMetalFields() {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-600">{t("investForm.metalType")}</div>
          <SmartSelect
            mode="single"
            value={metalTypeId}
            onChange={applyMetalType}
            options={metalTypeOptions}
            placeholder={t("investForm.selectMetalType")}
            searchable
          />
        </div>
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-600">{t("investForm.unit")}</div>
          <SmartSelect
            mode="single"
            value={metalUnitId}
            onChange={setMetalUnitId}
            options={metalUnitOptions}
            placeholder={t("investForm.selectUnit")}
            searchable
          />
        </div>
      </div>
    );
  }

  function handleNestedAccountCreated(id: string, name: string, extra?: { kind?: string }) {
    const kind = extra?.kind || (nestedEntityType === "cash-account" ? "bank_debit" : "investment");
    const nextOption: SmartSelectOption = {
      id,
      label: name,
      subLabel: t(`account.kind.${kind}`),
    };
    if (nestedEntityType === "cash-account") {
      setLocalCashAccountList((prev) => [...prev, { id, label: name }]);
      setLocalCashSSOptions((prev) => (prev ? [...prev, nextOption] : [nextOption]));
      selectCashAccount(id);
    } else if (nestedEntityType === "invest-account") {
      setLocalInvestmentAccountList((prev) => [...prev, { id, label: name, kind, investProductType: productType }]);
      setLocalInvestmentSSOptions((prev) => (prev ? [...prev, nextOption] : [nextOption]));
      investmentAccountTouchedRef.current = true;
      setToAccountId(id);
    }
    setNestedEntityType(null);
  }

  // Called when a nested institution/group is created inside an account dialog.
  // Keep the shared nested option data fresh so subsequent account dialogs
  // (e.g. the cash-account dialog) can select the newly created entity.
  function handleNestedOptionCreated(id: string, name: string, extra?: { kind?: string; type?: string }) {
    setNestedFieldData((prev) => {
      if (extra?.type !== undefined) {
        const existing = prev.institutionId ?? [];
        if (existing.some((item) => item.id === id)) return prev;
        return { ...prev, institutionId: [...existing, { id, name, type: extra.type }] };
      }
      const existing = prev.groupId ?? [];
      if (existing.some((item) => item.id === id)) return prev;
      return { ...prev, groupId: [...existing, { id, name }] };
    });
  }

  function applyMetalType(nextId: string) {
    setMetalTypeId(nextId);
    const selected = metalTypes?.find((item) => item.id === nextId);
    setFundCode(selected?.id ?? "");
    setFundName(selected?.name ?? "");
    setHoldingSearch(selected ? `${selected.name} ${selected.code}` : "");
  }

  function selectedMetalType() {
    return metalTypes?.find((item) => item.id === metalTypeId) ?? null;
  }

  function selectedMetalUnit() {
    return metalUnits?.find((item) => item.id === metalUnitId) ?? null;
  }

  function enableEditAutoNav() {
    if (mode === "edit") editAutoNavEnabledRef.current = true;
  }

  function clearUnavailableNav() {
    lastNavFetchKey.current = "";
    setNav("");
    setNavActualDate(null);
    navEditedRef.current = false;
    if (isBuyLike(subtype)) {
      setUnits("");
      unitsEditedRef.current = false;
    }
  }

  function changeApplyDate(val: string) {
    enableEditAutoNav();
    clearUnavailableNav();
    setApplyDate(val);
  }

  function changeConfirmDate(val: string) {
    enableEditAutoNav();
    clearUnavailableNav();
    setConfirmDate(val);
  }

  function changeFundCode(val: string) {
    enableEditAutoNav();
    clearUnavailableNav();
    setFundCode(val);
  }

  // Reset edit form state from the resolved edit detail, not the stale row snapshot.
  useEffect(() => {
    if (!open || mode !== "edit" || !currentEditEntry) return;
    const editEntry = currentEditEntry;
    const nextSubtype: FundSubtype =
      editEntry.fundSubtype === "buy_failed" && editEntry.source === "regular_invest_refund"
        ? "buy"
        : editEntry.fundSubtype === "buy" && editEntry.source === "dividend"
          ? "dividend_reinvest"
          : editEntry.fundSubtype && KNOWN_SUBTYPES.has(editEntry.fundSubtype as FundSubtype)
            ? editEntry.fundSubtype as FundSubtype
            : editEntry.amount < 0
              ? "buy"
              : "redeem";
    const nextCashReceivingEntry = isRedeemLike(nextSubtype) || nextSubtype === "dividend_cash";
    const nextConfirmDays =
      inferNonNegativeDays(editEntry.date, editEntry.confirmDate ?? null)
      ?? (typeof initConfirmDays === "number" ? initConfirmDays : Number(initConfirmDays) || 0);
    const nextArrivalDate = editEntry.fundArrivalDate ?? (() => {
      const dt = editEntry.date;
      if ((nextSubtype === "dividend_cash" || nextSubtype === "dividend_reinvest") && dt && nextConfirmDays >= 0) {
        return addFundTradingDays(dt, nextConfirmDays);
      }
      return "";
    })();
    const nextRefundAmount = editEntry.fundSubtype === "buy" ? Math.max(0, Number(editEntry.refundAmount) || 0) : 0;
    const nextArrivalAmount =
      editEntry.fundSubtype === "buy" && nextRefundAmount > 0
        ? String(nextRefundAmount)
        : editEntry.fundArrivalAmount != null
          ? String(editEntry.fundArrivalAmount)
          : "";
    const nextDisplayUnits = editEntry.displayFundUnits ?? editEntry.fundUnits;
    const nextCashAccountId = nextCashReceivingEntry ? (editEntry.toAccountId ?? "") : (editEntry.accountId ?? "");
    const nextToAccountId = nextCashReceivingEntry ? (editEntry.accountId ?? defaultAccountId) : (editEntry.toAccountId ?? defaultAccountId);

    setSubtype(nextSubtype);
    setApplyDate(editEntry.date);
    setConfirmDate(editEntry.confirmDate ?? "");
    setCashAccountId(nextCashAccountId ?? "");
    setToAccountId(nextToAccountId ?? defaultAccountId);
    setFundCode(editEntry.fundCode ?? "");
    setFundName(editEntry.fundName ?? editEntry.fundCode ?? "");
    setMetalTypeId(editEntry.metalTypeId ?? (editEntry.fundProductType === "metal" ? editEntry.fundCode ?? "" : ""));
    setMetalUnitId(editEntry.metalUnitId ?? "");
    setNav(editEntry.fundNav != null ? String(editEntry.fundNav) : "");
    setUnits(nextDisplayUnits != null ? formatFundUnitsValue(Number(nextDisplayUnits), fundUnitsDecimals) : "");
    setAmount(String(Math.abs(Number(editEntry.amount) || 0)));
    setFeeRate(String(editEntry.feeRate ?? defaults?.feeRate ?? "0"));
    setFee(editEntry.fundFee != null ? String(editEntry.fundFee) : "");
    setFeeEdited(false);
    setFeeRateEdited(false);
    setConfirmDays(nextConfirmDays);
    setConfirmDaysEdited(false);
    setMemo(editEntry.memo ?? editEntry.note ?? "");
    setSelectedTagIds(
      Array.isArray(editEntry.tags)
        ? editEntry.tags.map((tag: { id?: string; tagId?: string }) => tag.id ?? tag.tagId ?? "").filter(Boolean)
        : Array.isArray(editEntry.tagIds)
          ? editEntry.tagIds.filter((id: string) => !!id)
          : [],
    );
    setArrivalDate(nextArrivalDate);
    setArrivalAmount(nextArrivalAmount);
    unitsEditedRef.current = false;
    amountEditedRef.current = false;
    navEditedRef.current = false;
    arrivalDateEditedRef.current = false;
    arrivalDaysEditedRef.current = false;
    lastNavFetchKey.current = "";
    editAutoNavEnabledRef.current = false;
    suppressFeeAutoCalcRef.current = true;
    cashAccountTouchedRef.current = false;
    cashAccountAutoRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, currentEditEntry, defaultAccountId, defaults?.feeRate, fundUnitsDecimals, initConfirmDays]);

  // Fetch fund name/rate/confirmDays when AI sets a fund code
  useEffect(() => {
    if (!pendingFundCodeFetchRef.current || !open) return;
    const code = pendingFundCodeFetchRef.current;
    pendingFundCodeFetchRef.current = null;

    setNameLoading(true);
    fetch(`/api/v1/fund/name?code=${encodeURIComponent(code)}`)
      .then(r => r.json())
      .then(d => { if (d.ok && d.name) setFundName(d.name); })
      .catch(() => {})
      .finally(() => setNameLoading(false));

    if (!confirmDaysEdited) {
      fetch(`/api/v1/fund/confirm-days?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(code)}`)
        .then(r => r.json())
        .then(d => { if (d.ok && d.days != null) { setConfirmDays(d.days); if (d.redeemCostDays != null) setRedeemCostDays(d.redeemCostDays); if (d.arrivalDays != null) setArrivalDays(d.arrivalDays); } })
        .catch(() => {});
    }
    if (mode === "create") {
      fetch(`/api/v1/fund/fee-rate?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(code)}&feeType=${isRedeemLike(subtype) ? "redeem" : "buy"}`)
        .then(r => r.json())
        .then(d => {
          if (!d.ok || d.rate == null) return;
          const nextRate = String(d.rate);
          setFeeRate(prev => prev === nextRate ? prev : nextRate);
        })
        .catch(() => {});
    }
  }, [open, toAccountId, subtype]);


  // When the AI panel triggers a new entry, auto-fill the recognized fund info.
  useEffect(() => {
    if (mode !== "create") return;

    function onOpenFromAi(ev: Event) {
      const detail = (ev as CustomEvent<{
        requestId: string;
        item?: {
          type?: string;
          date?: string;
          amount?: number;
          account?: string;
          fromAccount?: string;
          toAccount?: string;
          category?: string;
          counterparty?: string;
          remark?: string;
          rawText?: string;
        };
      }>).detail;
      if (!detail?.requestId || !detail.item) return;
      // Only handle investment types
      if (detail.item.type !== "investment") return;

      requestIdRef.current = detail.requestId;

      // Extract a 6-digit fund code from the category or counterparty.
      const catCode = (detail.item.category ?? "").match(/\b(\d{6})\b/)?.[1];
      const cptyCode = (detail.item.counterparty ?? "").match(/\b(\d{6})\b/)?.[1];
      const fundCodeFromAi = catCode || cptyCode || "";

      const amt = detail.item.amount ?? 0;
      const aiDate = detail.item.date ?? today;
      const note = (detail.item.remark ?? detail.item.rawText ?? "").trim();
      const isRedeem = /赎回|卖出/.test(note + detail.item.rawText);
      const isDivCash = /现金红利/.test(note + detail.item.rawText);

      // Reset form first, then populate
      resetForCreate();
      if (isDivCash) {
        setSubtype("dividend_cash");
        setArrivalDate(aiDate);
      } else if (isRedeem) {
        setSubtype("redeem");
        setApplyDate(aiDate);
        setArrivalDate(aiDate);
      } else {
        setSubtype("buy");
        setApplyDate(aiDate);
      }
      arrivalDateEditedRef.current = false;
      arrivalDaysEditedRef.current = false;

      if (fundCodeFromAi) {
        setFundCode(fundCodeFromAi);
        pendingFundCodeFetchRef.current = fundCodeFromAi;
      }
      if (amt > 0) setAmount(String(amt));
      if (note) setMemo(note);

      setOpen(true);
    }

    window.addEventListener("mmh:create-transaction:open", onOpenFromAi as EventListener);
    return () => window.removeEventListener("mmh:create-transaction:open", onOpenFromAi as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, defaultAccountId, today, defaults]);

  useEffect(() => {
    if (mode !== "create") return;
    if (!listenCreateEvents) return;

    function onOpenFromCreate(ev: Event) {
      const detail = (ev as CustomEvent<OpenInvestmentCreateDetail>).detail;
      if (!detail?.requestId) return;

      requestIdRef.current = detail.requestId;
      resetForCreate(false, { preferDefaults: true });
      const requestedProductType: ProductType = detail.defaultProductType && ["fund", "money", "wealth", "deposit", "metal"].includes(detail.defaultProductType)
        ? detail.defaultProductType as ProductType
        : fixedProductType;
      setProductType(requestedProductType);
      if (requestedProductType === "metal") {
        const nextType = metalTypes?.[0] ?? null;
        const nextUnit = metalUnits?.[0] ?? null;
        if (nextType) {
          setMetalTypeId(nextType.id);
          setFundCode(nextType.id);
          setFundName(nextType.name);
          setHoldingSearch(`${nextType.name} ${nextType.code}`);
        }
        if (nextUnit) setMetalUnitId(nextUnit.id);
      }
      if (detail.defaultDate) setApplyDate(detail.defaultDate);
      if (typeof detail.defaultAmount === "number" && detail.defaultAmount > 0) {
        setAmount(String(detail.defaultAmount));
      }
      if ("defaultAccountId" in detail) setToAccountId(detail.defaultAccountId ?? "");
      if ("defaultCashAccountId" in detail) setCashAccountId(detail.defaultCashAccountId ?? "");
      const nextFundCode = String(detail.defaultFundCode ?? "").trim();
      if (nextFundCode && requestedProductType !== "metal") {
        const nextFundName = String(detail.defaultFundName ?? "").trim() || findFundNameFromHoldings(nextFundCode) || nextFundCode;
        setFundCode(nextFundCode);
        setFundName(nextFundName);
        setHoldingSearch(`${nextFundCode} ${nextFundName}`);
        pendingFundCodeFetchRef.current = nextFundCode;
      }
      investmentAccountTouchedRef.current = false;
      setOpen(true);
    }

    window.addEventListener("mmh:investment:create", onOpenFromCreate as EventListener);
    return () => window.removeEventListener("mmh:investment:create", onOpenFromCreate as EventListener);
  }, [mode, today, defaults, listenCreateEvents, fixedProductType, metalTypes, metalUnits]);

  // Listen for edit events (dispatched by EntryRowActions for fund/money investment records).
  useEffect(() => {
    if (mode !== "edit") return;

    const toLinkedCandidate = (value: Partial<LinkedCandidateEntry> & { entryId?: string }): RefundLinkableEntry => ({
      id: value.id ?? value.entryId ?? "",
      date: value.date ?? "",
      createdAt: value.createdAt ?? null,
      fundConfirmDate: value.fundConfirmDate ?? null,
      fundArrivalDate: value.fundArrivalDate ?? null,
      fundCode: value.fundCode ?? "",
      fundSubtype: value.fundSubtype ?? "",
      fundUnits: value.fundUnits ?? null,
      source: value.source ?? null,
      accountId: value.accountId ?? null,
      toAccountId: value.toAccountId ?? null,
      amount: Number(value.amount) || 0,
      fundSourceEntryId: value.fundSourceEntryId ?? null,
    });

    const detailToEntry = (detail: InvestmentEditDetail): InvestmentEntry => ({
      id: detail.entryId,
      transactionId: detail.entryId,
      date: detail.date || today,
      confirmDate: detail.confirmDate ?? undefined,
      amount: Number(detail.amount) || 0,
      note: detail.note ?? null,
      memo: detail.note ?? null,
      fundCode: detail.fundCode ?? null,
      fundName: detail.fundName ?? null,
      fundUnits: detail.fundUnits ?? null,
      displayFundUnits: detail.displayFundUnits ?? null,
      fundNav: detail.fundNav ?? null,
      fundFee: detail.fundFee ?? null,
      fundProductType: detail.fundProductType ?? null,
      fundSubtype: detail.fundSubtype ?? null,
      fundSourceEntryId: detail.fundSourceEntryId ?? null,
      metalTypeId: detail.metalTypeId ?? null,
      metalTypeName: detail.metalTypeName ?? null,
      metalUnitId: detail.metalUnitId ?? null,
      metalUnitName: detail.metalUnitName ?? null,
      source: detail.source ?? null,
      accountId: detail.accountId ?? null,
      toAccountId: detail.toAccountId ?? null,
      cashAccountId: detail.cashAccountId ?? null,
      fundArrivalDate: detail.fundArrivalDate ?? null,
      fundArrivalAmount: detail.fundArrivalAmount ?? null,
      refundAmount: detail.refundAmount ?? null,
      feeRate: detail.feeRate ?? null,
    });

    const loadInvestmentDetail = async (entryId: string, requestId: string): Promise<InvestmentEditDetail | null> => {
      const res = await fetch(`/api/v1/transactions/detail?id=${encodeURIComponent(entryId)}`);
      const json = await res.json();
      if (!json?.ok || !json.data) return null;
      const data = json.data;
      return {
        ...data,
        requestId,
        entryId: data.id ?? entryId,
        confirmDate: data.fundConfirmDate ?? data.confirmDate ?? null,
        note: data.note ?? "",
        amount: Number(data.amount) || 0,
        linkedCandidateEntries: Array.isArray(data.linkedCandidateEntries) ? data.linkedCandidateEntries : undefined,
      };
    };

    const applyInvestmentDetail = (detail: InvestmentEditDetail, linkedRefund?: RefundLinkableEntry | null) => {
      requestIdRef.current = detail.requestId;
      setEditEntryId(detail.entryId);
      setEventEditEntry(detailToEntry(detail));
      setEventLinkedEntries(detail.linkedCandidateEntries ?? null);
      const detailRefundAmount = Math.max(0, Number(detail.refundAmount) || 0);
      setBuyResultStatus(linkedRefund || detailRefundAmount > 0 ? "refund" : "normal");
      setLinkedRefundEntryId(linkedRefund?.id ?? null);
      if (detail.fundProductType && ["fund", "money", "wealth", "deposit", "metal"].includes(detail.fundProductType)) {
        setProductType(detail.fundProductType as ProductType);
      }

      editAutoNavEnabledRef.current = false;
      setApplyDate(detail.date || today);
      setConfirmDate(detail.confirmDate ?? "");
      setArrivalDate(linkedRefund ? normalizeYmd(linkedRefund.fundArrivalDate ?? linkedRefund.date) : detail.fundArrivalDate ?? "");
      setArrivalAmount(
        linkedRefund?.amount != null
          ? String(Math.abs(Number(linkedRefund.amount)))
          : detailRefundAmount > 0
            ? String(detailRefundAmount)
            : "",
      );
      const numericAmount = Number(detail.amount);
      setAmount(Number.isFinite(numericAmount) && numericAmount !== 0 ? String(Math.abs(numericAmount)) : "");
      setMemo(detail.note ?? "");
      setSelectedTagIds(
        Array.isArray(detail.tags)
          ? detail.tags.map((tag: { id?: string; tagId?: string }) => tag.id ?? tag.tagId ?? "").filter(Boolean)
          : Array.isArray(detail.tagIds)
            ? detail.tagIds.filter((id: string) => !!id)
            : [],
      );
      const isRedeemEntry =
        detail.fundSubtype === "redeem" ||
        detail.fundSubtype === "switch_out";
      const nextFundAccountId = isRedeemEntry ? detail.accountId : detail.toAccountId;
      const nextCashAccountId = detail.cashAccountId ?? (isRedeemEntry ? detail.toAccountId : detail.accountId);
      setCashAccountId(nextCashAccountId ?? "");
      investmentAccountTouchedRef.current = true;
      setToAccountId(nextFundAccountId ?? "");
      cashAccountTouchedRef.current = true;
      cashAccountAutoRef.current = false;
      setFundCode(detail.fundCode ?? "");
      setFundName(detail.fundName ?? "");
      setMetalTypeId(detail.metalTypeId ?? (detail.fundProductType === "metal" ? detail.fundCode ?? "" : ""));
      setMetalUnitId(detail.metalUnitId ?? "");
      setHoldingSearch(detail.fundCode ? `${detail.fundCode} ${detail.fundName ?? ""}` : "");
      if (detail.fundSubtype) {
        const st = detail.fundSubtype === "buy_failed" && detail.source === "regular_invest_refund"
          ? "buy"
          : detail.fundSubtype as FundSubtype;
        if (KNOWN_SUBTYPES.has(st as FundSubtype)) setSubtype(st as FundSubtype);
      }
      const linkedRefundAmount = linkedRefund ? Math.abs(Number(linkedRefund.amount) || 0) : 0;
      const detailAmount = Math.max(0, Math.abs(Number(detail.amount) || 0));
      const detailNav = Number(detail.fundNav) || 0;
      const detailFee = Math.max(0, Number(detail.fundFee) || 0);
      const calculatedRefundUnits =
        detail.fundSubtype === "buy" && linkedRefundAmount > 0 && detailNav > 0
          ? Math.max(0, detailAmount - linkedRefundAmount - detailFee) / detailNav
          : null;
      const displayUnits =
        calculatedRefundUnits != null
          ? calculatedRefundUnits
          : detail.displayFundUnits ?? detail.fundUnits;
      if (displayUnits != null) setUnits(formatUnits(Number(displayUnits)));
      if (detail.fundNav != null) setNav(String(detail.fundNav));
      if (detail.fundFee != null) setFee(String(detail.fundFee));
      if (detail.fundName) setFundName(detail.fundName);
      setFeeRate(String(detail.feeRate ?? defaults?.feeRate ?? "0"));
      setFeeEdited(false);
      setFeeRateEdited(false);
      unitsEditedRef.current = false;
      amountEditedRef.current = false;
      navEditedRef.current = false;
      suppressFeeAutoCalcRef.current = true;
      setOpen(true);
    };

    async function onInvestmentEdit(ev: Event) {
      const detail = (ev as CustomEvent<InvestmentEditDetail>).detail;
      if (!detail?.requestId || !detail.entryId) return;
      if (detail.type !== "investment") return;
      if (!shouldHandleInvestmentEdit(detail)) return;
      if (handledInvestmentEditRequestRef.current === detail.requestId) return;
      handledInvestmentEditRequestRef.current = detail.requestId;

      let currentDetail = detail;
      try {
        const freshDetail = await loadInvestmentDetail(detail.entryId, detail.requestId);
        if (freshDetail) currentDetail = freshDetail;
      } catch (err) {
        console.error("Load investment detail failed:", err);
      }

      const candidates: RefundLinkableEntry[] = (currentDetail.linkedCandidateEntries ?? detail.linkedCandidateEntries ?? []).map(toLinkedCandidate);
      const target = toLinkedCandidate(currentDetail);
      const linked = findLinkedEntries(target, candidates);
      const isFailedRefund =
        currentDetail.fundSubtype === "buy_failed" &&
        currentDetail.source === "regular_invest_refund";

      if (isFailedRefund) {
        const linkedBuy = linked.linkedBuys[0];
        if (linkedBuy?.id) {
          try {
            const buyDetail = await loadInvestmentDetail(linkedBuy.id, detail.requestId);
            if (buyDetail) {
              applyInvestmentDetail(buyDetail, target);
              return;
            }
          } catch (err) {
            console.error("Load linked buy for refund failed:", err);
          }
        }
      }

      applyInvestmentDetail(currentDetail, currentDetail.fundSubtype === "buy" ? linked.linkedRefunds[0] ?? null : null);
    }

    window.addEventListener("mmh:investment:edit", onInvestmentEdit as EventListener);
    return () => window.removeEventListener("mmh:investment:edit", onInvestmentEdit as EventListener);
  }, [mode, today, defaultAccountId, entry?.id, entry?.transactionId, defaults?.feeRate]);

  // Dispatch success event when create form is saved from AI panel
  function notifyAiSuccess(requestId: string) {
    window.dispatchEvent(new CustomEvent("mmh:create-transaction:success", { detail: { requestId } }));
  }

  const isFundHoldingAsOfMode =
    (productType === "fund" || productType === "money") &&
    (isRedeemLike(subtype) || isDividend(subtype));
  const selectedHoldingAccountId = (toAccountId || defaultAccountId || "").trim();
  const propsProvideSelectedFundData =
    selectedHoldingAccountId === String(defaultAccountId ?? "").trim() &&
    Array.isArray(allEntries);
  const activeLoadedFundData = loadedFundAccountData?.accountId === selectedHoldingAccountId
    ? loadedFundAccountData
    : null;
  const activeHoldings = activeLoadedFundData?.holdings ?? (propsProvideSelectedFundData ? holdings : undefined);
  const activeAllEntries = activeLoadedFundData?.allEntries ?? (propsProvideSelectedFundData ? allEntries : undefined);

  useEffect(() => {
    if (!open || !isFundHoldingAsOfMode || !selectedHoldingAccountId) {
      setHoldingFundLoading(false);
      return;
    }
    if (propsProvideSelectedFundData) {
      setLoadedFundAccountData((current) => current?.accountId === selectedHoldingAccountId ? null : current);
      setHoldingFundLoading(false);
      return;
    }
    const cached = fundAccountDataCacheRef.current.get(selectedHoldingAccountId);
    if (cached) {
      setLoadedFundAccountData(cached);
      setHoldingFundLoading(false);
      return;
    }

    const controller = new AbortController();
    setHoldingFundLoading(true);
    const params = new URLSearchParams({
      accountId: selectedHoldingAccountId,
      entryScope: "account",
    });
    fetch(`/api/v1/fund/shell-data?${params.toString()}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((data) => {
        if (!data?.ok) throw new Error(String(data?.error ?? "Failed to load held funds"));
        const nextData: LoadedFundAccountData = {
          accountId: selectedHoldingAccountId,
          holdings: Array.isArray(data.positions)
            ? data.positions.map((position: any) => ({
                fundCode: String(position.fundCode ?? ""),
                name: String(position.name ?? position.fundCode ?? ""),
                units: Number(position.units ?? 0),
              })).filter((position: FundHoldingOption) => position.fundCode)
            : [],
          allEntries: Array.isArray(data.allEntries)
            ? data.allEntries.map((entry: any) => ({
                id: String(entry.id ?? ""),
                date: normalizeYmd(entry.date),
                createdAt: entry.createdAt ? String(entry.createdAt) : null,
                fundConfirmDate: normalizeYmd(entry.fundConfirmDate) || null,
                fundArrivalDate: normalizeYmd(entry.fundArrivalDate) || null,
                fundCode: String(entry.fundCode ?? ""),
                fundName: entry.fundName == null ? null : String(entry.fundName),
                fundSubtype: String(entry.fundSubtype ?? ""),
                fundUnits: entry.fundUnits == null ? null : Number(entry.fundUnits),
                source: entry.source == null ? null : String(entry.source),
                accountId: entry.accountId == null ? null : String(entry.accountId),
                toAccountId: entry.toAccountId == null ? null : String(entry.toAccountId),
                amount: entry.amount == null ? 0 : Number(entry.amount),
                fundSourceEntryId: entry.fundSourceEntryId == null ? null : String(entry.fundSourceEntryId),
              })).filter((entry: LinkedCandidateEntry) => entry.id || entry.fundCode)
            : [],
        };
        fundAccountDataCacheRef.current.set(selectedHoldingAccountId, nextData);
        setLoadedFundAccountData(nextData);
      })
      .catch((error) => {
        if (error?.name !== "AbortError") console.error("Load fund holding candidates failed:", error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setHoldingFundLoading(false);
      });
    return () => controller.abort();
  }, [isFundHoldingAsOfMode, open, propsProvideSelectedFundData, selectedHoldingAccountId]);

  // Replay fund units available on the application date for redemption and dividend flows.
  const holdingsAsOfDate = useMemo(() => {
    if (!activeAllEntries || !isFundHoldingAsOfMode || !applyDate) return null;
    const investmentAccountId = selectedHoldingAccountId;
    const excludedEntryIds = new Set<string>();
    if (mode === "edit" && currentEditEntry) {
      for (const id of [currentEditEntry.id, currentEditEntry.transactionId]) {
        const normalized = String(id ?? "").trim();
        if (normalized) excludedEntryIds.add(normalized);
      }
    }
    const seenEntryIds = new Set<string>();
    const replayRows: Array<{
      code: string;
      availableDate: string;
      date: string;
      createdAt: string;
      delta: number;
    }> = [];
    for (const e of activeAllEntries) {
      if (!e.fundCode) continue;
      if (investmentAccountId && e.accountId !== investmentAccountId && e.toAccountId !== investmentAccountId) continue;
      const entryId = String(e.id ?? "").trim();
      if (entryId && excludedEntryIds.has(entryId)) continue;
      if (entryId) {
        if (seenEntryIds.has(entryId)) continue;
        seenEntryIds.add(entryId);
      }
      const sub = e.fundSubtype;
      const availableDate = sub === "buy" || sub === "dividend_reinvest"
        ? (e.fundArrivalDate ?? e.fundConfirmDate ?? e.date)
        : sub === "redeem" || sub === "switch_out" || (sub === "buy_failed" && e.source === "regular_invest_refund")
        ? (e.fundArrivalDate ?? e.date)
        : e.date;
      if (availableDate > applyDate) continue;
      const code = e.fundCode.trim();
      if (!code) continue;
      let delta = 0;
      if (sub === "buy" || sub === "dividend_reinvest") {
        delta = roundFundUnits(e.fundUnits ?? 0, fundUnitsDecimals);
      } else if (sub === "redeem") {
        delta = -roundFundUnits(e.fundUnits ?? 0, fundUnitsDecimals);
      }
      replayRows.push({
        code,
        availableDate,
        date: e.date,
        createdAt: e.createdAt ? String(e.createdAt) : "",
        delta,
      });
    }
    replayRows.sort((left, right) =>
      left.availableDate.localeCompare(right.availableDate) ||
      left.date.localeCompare(right.date) ||
      left.createdAt.localeCompare(right.createdAt)
    );
    const map = new Map<string, number>();
    for (const row of replayRows) {
      const nextUnits = roundFundUnits((map.get(row.code) ?? 0) + row.delta, fundUnitsDecimals);
      map.set(row.code, Math.max(0, nextUnits));
    }
    return map;
  }, [activeAllEntries, applyDate, currentEditEntry, fundUnitsDecimals, isFundHoldingAsOfMode, mode, selectedHoldingAccountId, subtype]);

  const isFundRedeemAsOfMode =
    isRedeemLike(subtype) &&
    (productType === "fund" || productType === "money");

  const holdingUnitsByFund = useMemo(() => {
    return new Map((activeHoldings ?? []).map((holding) => [
      holding.fundCode,
      roundFundUnits(holding.units ?? 0, fundUnitsDecimals),
    ]));
  }, [activeHoldings, fundUnitsDecimals]);

  const redeemAvailableUnitsByFund = useMemo(() => {
    if (!isFundHoldingAsOfMode) return null;
    const adjusted = holdingsAsOfDate ? new Map(holdingsAsOfDate) : new Map<string, number>();
    if (mode === "edit" && currentEditEntry) {
      const originalCode = String(currentEditEntry.fundCode ?? "").trim();
      const originalDate = normalizeYmd(currentEditEntry.date);
      const originalAccountMatches =
        selectedHoldingAccountId &&
        (currentEditEntry.accountId === selectedHoldingAccountId || currentEditEntry.toAccountId === selectedHoldingAccountId);
      if (!isRedeemLike(subtype) && originalCode && originalAccountMatches && (!holdingsAsOfDate || originalDate === applyDate)) {
        const savedUnits = roundFundUnits(
          Math.abs(Number(currentEditEntry.displayFundUnits ?? currentEditEntry.fundUnits ?? 0)),
          fundUnitsDecimals,
        );
        adjusted.set(originalCode, Math.max(adjusted.get(originalCode) ?? 0, savedUnits));
      }
    }
    return adjusted;
  }, [applyDate, currentEditEntry, fundUnitsDecimals, holdingsAsOfDate, isFundHoldingAsOfMode, mode, selectedHoldingAccountId, subtype]);

  const effectiveHoldings = useMemo(() => {
    if (!activeHoldings) return undefined;
    if (!redeemAvailableUnitsByFund) return activeHoldings;
    // Redeem mode uses the application-date confirmed-unit replay as the only source of availability.
    return activeHoldings.map(h => {
      const availableUnits = redeemAvailableUnitsByFund.get(h.fundCode) ?? 0;
      return {
        ...h,
        units: isFundRedeemAsOfMode
          ? Math.max(0, availableUnits)
          : availableUnits > 0.0001
            ? availableUnits
            : (holdingUnitsByFund.get(h.fundCode) ?? 0),
      };
    });
  }, [activeHoldings, holdingUnitsByFund, isFundRedeemAsOfMode, redeemAvailableUnitsByFund]);

  const holdingFundOptions = useMemo<SmartSelectOption[]>(() => {
    if (!isFundHoldingAsOfMode || !redeemAvailableUnitsByFund) return [];
    const names = new Map<string, string>();
    for (const holding of activeHoldings ?? []) {
      if (holding.name?.trim()) names.set(holding.fundCode, holding.name.trim());
    }
    for (const entry of activeAllEntries ?? []) {
      if (entry.fundCode?.trim() && entry.fundName?.trim() && !names.has(entry.fundCode.trim())) {
        names.set(entry.fundCode.trim(), entry.fundName.trim());
      }
    }
    if (fundCode.trim() && fundName.trim() && !names.has(fundCode.trim())) {
      names.set(fundCode.trim(), fundName.trim());
    }
    const optionCodes = new Set(
      Array.from(redeemAvailableUnitsByFund.entries())
        .filter(([, units]) => units > 0.0001)
        .map(([code]) => code),
    );
    if (mode === "edit" && fundCode.trim()) optionCodes.add(fundCode.trim());
    return Array.from(optionCodes)
      .map((code) => {
        const availableUnits = redeemAvailableUnitsByFund.get(code) ?? 0;
        const currentUnits = holdingUnitsByFund.get(code) ?? 0;
        return {
          code,
          availableUnits,
          currentUnits,
          visible: availableUnits > 0.0001 || code === fundCode.trim(),
        };
      })
      .filter((item) => item.visible)
      .map(({ code, availableUnits, currentUnits }) => {
        const displayAvailable = Math.max(0, availableUnits);
        const currentText = currentUnits > displayAvailable + 0.0001
          ? t("investForm.redeemOption.currentUnits", { units: formatFundUnitsValue(currentUnits, fundUnitsDecimals) })
          : "";
        return {
          id: code,
          label: names.get(code)?.trim() || code,
          subLabel: `${code} · ${t("investForm.redeemOption.dateRemaining", { units: formatFundUnitsValue(displayAvailable, fundUnitsDecimals) })}${isFundRedeemAsOfMode ? currentText : ""}`,
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label, language));
  }, [activeAllEntries, activeHoldings, fundCode, fundName, fundUnitsDecimals, holdingUnitsByFund, isFundHoldingAsOfMode, isFundRedeemAsOfMode, language, mode, redeemAvailableUnitsByFund, t]);

  function selectHoldingFund(code: string) {
    const nextCode = code.trim();
    changeFundCode(nextCode);
    setHoldingSearch("");
    if (mode === "create") unitsEditedRef.current = false;
    if (!nextCode) {
      setFundName("");
      if (mode === "create") setUnits("");
      return;
    }
    const holding = activeHoldings?.find((item) => item.fundCode === nextCode);
    const availableUnits = redeemAvailableUnitsByFund?.get(nextCode) ?? 0;
    const historicalName = (activeAllEntries ?? []).find((entry) => entry.fundCode === nextCode && entry.fundName?.trim())?.fundName?.trim();
    setFundName(holding?.name ?? historicalName ?? "");
    if (mode === "create" && isFundRedeemAsOfMode) {
      setUnits(availableUnits > 0.0001 ? formatUnits(availableUnits) : "");
    }
  }

  function findFundNameFromHoldings(code: string) {
    const target = code.trim();
    if (!target) return "";
    const match = (effectiveHoldings ?? activeHoldings ?? []).find((item) => item.fundCode === target);
    return match?.name?.trim() ?? "";
  }

  const subtypeGroups = PRODUCT_SUBTYPES[productType];
  const allSubtypes = subtypeGroups.flat();
  function selectSubtype(nextSubtype: FundSubtype) {
    if (isRedeemLike(nextSubtype) && !isRedeemLike(subtype)) {
      // Switching to redeem clears buy amount/fee; create mode may prefill application-date available units.
      setAmount("");
      setFee("");
      setFeeEdited(false);
      setFeeRate("0");
      setFeeRateEdited(false);
      amountEditedRef.current = false;
      if (mode === "create" && !arrivalDateEditedRef.current) {
        setArrivalDate(applyDate || today);
      }
      const nextIsFundRedeemAsOfMode =
        (productType === "fund" || productType === "money") && isRedeemLike(nextSubtype);
      const availableUnits = nextIsFundRedeemAsOfMode && fundCode.trim()
        ? (redeemAvailableUnitsByFund?.get(fundCode.trim()) ?? 0)
        : 0;
      if (mode === "create") {
        if (nextIsFundRedeemAsOfMode) {
          setUnits(availableUnits > 0.0001 ? formatUnits(availableUnits) : "");
        } else {
          const h = effectiveHoldings?.find(p => p.fundCode === fundCode);
          if (h && h.units > 0) setUnits(formatUnits(Number(h.units)));
          else if (defaults?.fundUnits && defaults.fundUnits > 0) setUnits(formatUnits(Number(defaults.fundUnits)));
          else setUnits("");
        }
      }
    }
    if (isBuyLike(nextSubtype) && !isBuyLike(subtype)) {
      // Switching back to buy clears redeem amount, arrival amount, and related auto-calc state.
      setUnits("");
      unitsEditedRef.current = false;
      amountEditedRef.current = false;
      navEditedRef.current = false;
      setAmount("");
      setFee("");
      setFeeEdited(false);
      setFeeRate("0");
      setFeeRateEdited(false);
      setArrivalAmount("");
    }
    if (isDividend(nextSubtype)) {
      if (!arrivalDateEditedRef.current) setArrivalDate(applyDate || today);
      if (nextSubtype === "dividend_reinvest") {
        setCashAccountId("");
        cashAccountAutoRef.current = false;
      } else if (!cashAccountId && cashAccounts && cashAccounts.length > 0) {
        setCashAccountId(cashAccounts[0].id);
      }
      if (defaults?.fundCode && !fundCode) {
        setFundCode(defaults.fundCode);
        setFundName(defaults.fundName ?? defaults.fundCode);
        setHoldingSearch(`${defaults.fundCode} ${defaults.fundName ?? defaults.fundCode}`);
      }
    }
    setSubtype(nextSubtype);
  }

  function selectSubtypeOption(nextSubtype: FundSubtype) {
    if (nextSubtype !== "buy") {
      setBuyResultStatus("normal");
      setLinkedRefundEntryId(null);
    }
    selectSubtype(nextSubtype);
  }

  useEffect(() => {
    if (!allSubtypes.includes(subtype)) {
      setSubtype(allSubtypes[0]);
    }
  }, [productType]);

  // Focus the amount input when the cash-dividend mode opens.
  useEffect(() => {
    if (subtype === "dividend_cash" && open) {
      setTimeout(() => dividendAmountRef.current?.focus(), 100);
    }
  }, [subtype, open]);

  useEffect(() => {
    cashAccountIdRef.current = cashAccountId;
  }, [cashAccountId]);

  const fundCodeKey = useMemo(() => {
    const raw = fundCode.trim();
    return /^\d{6}$/.test(raw) ? raw : "";
  }, [fundCode]);

  // After create mode opens, fill cash account and fee rate from the fund account/code.
  useEffect(() => {
    if (mode !== "create" || !open || !toAccountId) return;
    if (subtype === "dividend_reinvest") {
      setCashAccountId("");
      cashAccountAutoRef.current = false;
      return;
    }
    const controller = new AbortController();
    fetch(`/api/v1/fund/last-cash-account?accountId=${encodeURIComponent(toAccountId)}${fundCodeKey ? `&fundCode=${encodeURIComponent(fundCodeKey)}` : ""}`, { signal: controller.signal })
      .then(r => r.json())
      .then(d => {
        if (cashAccountTouchedRef.current) return;
        const fallback = cashAccounts && cashAccounts.length > 0 ? cashAccounts[0].id : "";
        const desired = d?.ok && d.cashAccountId ? String(d.cashAccountId) : fallback;
        if (desired && (cashAccountAutoRef.current || !cashAccountIdRef.current)) {
          cashAccountAutoRef.current = true;
          setCashAccountId(desired);
        }
      })
      .catch(() => {
        if (cashAccountTouchedRef.current) return;
        const fallback = cashAccounts && cashAccounts.length > 0 ? cashAccounts[0].id : "";
        if (fallback && (cashAccountAutoRef.current || !cashAccountIdRef.current)) {
          cashAccountAutoRef.current = true;
          setCashAccountId(fallback);
        }
      });
    if (isDividend(subtype)) return;
    if (fundCodeKey) {
      const feeType = isRedeemLike(subtype) ? "redeem" : "buy";
      fetch(`/api/v1/fund/fee-rate?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(fundCodeKey)}&feeType=${feeType}${confirmDate ? `&effectiveDate=${encodeURIComponent(confirmDate)}` : ""}`)
        .then(r => r.json())
        .then(d => {
          if (feeRateEdited) return;
          const nextRate = d.ok && d.rate != null ? String(d.rate) : "0";
          setFeeRate(prev => prev === nextRate ? prev : nextRate);
        })
        .catch(() => {
          if (feeRateEdited || feeRate) return;
          setFeeRate(prev => prev === "0" ? prev : "0");
        });
    }
    return () => controller.abort();
  }, [mode, open, toAccountId, fundCodeKey, cashAccounts, subtype, confirmDate]);

  useEffect(() => {
    if (!open || !toAccountId || confirmDaysEdited) return;
    if (mode !== "create") return;
    const controller = new AbortController();
    const params = new URLSearchParams({ accountId: toAccountId });
    if (fundCodeKey) params.set("fundCode", fundCodeKey);
    fetch(`/api/v1/fund/confirm-days?${params.toString()}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.days != null) {
          setConfirmDays(d.days);
          if (d.redeemCostDays != null) setRedeemCostDays(d.redeemCostDays);
          if (d.arrivalDays != null) setArrivalDays(d.arrivalDays);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [mode, open, toAccountId, fundCodeKey, confirmDaysEdited]);

  // In edit mode, refresh the displayed fee rate after source fields change, but
  // never recalculate the saved fee unless the user edits the rate input itself.
  useEffect(() => {
    if (mode !== "edit") return;
    if (!open || !toAccountId || !fundCodeKey) return;
    if (!showFeeFor(subtype, productType) || feeRateEdited) return;
    if (!editAutoNavEnabledRef.current) return;
    const feeType = isRedeemLike(subtype) ? "redeem" : "buy";
    const url = `/api/v1/fund/fee-rate?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(fundCodeKey)}&feeType=${feeType}${confirmDate ? `&effectiveDate=${encodeURIComponent(confirmDate)}` : ""}`;
    const controller = new AbortController();
    fetch(url, { signal: controller.signal })
      .then(r => r.json())
      .then(d => {
        if (!d.ok || d.rate == null || feeRateEdited) return;
        const nextRate = String(d.rate);
        setFeeRate(prev => prev === nextRate ? prev : nextRate);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [open, mode, toAccountId, fundCodeKey, confirmDate, subtype, productType, feeRateEdited]);


  function buildInvestmentCalculation(options?: {
    amountRaw?: string;
    feeRaw?: string;
    feeRateRaw?: string;
    navRaw?: string;
    refundRaw?: string;
    refundEnabled?: boolean;
  }) {
    const hasFeeRawOption = Object.prototype.hasOwnProperty.call(options ?? {}, "feeRaw");
    const hasFeeRateRawOption = Object.prototype.hasOwnProperty.call(options ?? {}, "feeRateRaw");
    const amountN = Math.max(0, p(options?.amountRaw ?? amount));
    const navN = p(options?.navRaw ?? nav);
    const feeInputN = Math.max(0, p(options?.feeRaw ?? fee));
    const feeRateN = Math.max(0, p(options?.feeRateRaw ?? feeRate));
    const refundEnabled = options?.refundEnabled ?? (subtype === "buy" && buyResultStatus === "refund");
    const refundN = subtype === "buy" && refundEnabled
      ? Math.min(amountN, Math.max(0, p(options?.refundRaw ?? arrivalAmount)))
      : 0;
    const confirmedAmountN = isBuyLike(subtype) ? Math.max(0, amountN - refundN) : amountN;
    const unitsN = Math.max(0, p(units));
    const grossRedeemN = isRedeemLike(subtype) && navN > 0 && unitsN > 0 ? navN * unitsN : 0;
    const feeBaseAmount = isRedeemLike(subtype) && grossRedeemN > 0
      ? grossRedeemN
      : confirmedAmountN;
    const calculatedFeeN = feeBaseAmount > 0 && feeRateN > 0 && showFeeFor(subtype, productType)
      ? feeBaseAmount * feeRateN / 100
      : 0;
    const shouldDeriveFeeFromRate = hasFeeRateRawOption || (mode === "create" && !feeEdited);
    const effectiveFeeN = hasFeeRawOption && !hasFeeRateRawOption
      ? feeInputN
      : shouldDeriveFeeFromRate && feeRateN > 0
        ? calculatedFeeN
        : feeInputN;
    let unitsText = "";
    if (isBuyLike(subtype) && navN > 0 && amountN > 0) {
      const principal = confirmedAmountN - effectiveFeeN;
      unitsText = principal > 0 ? formatUnits(principal / navN) : "";
    } else if (isRedeemLike(subtype) && !isFundRedeemAsOfMode && defaults?.fundUnits && defaults.fundUnits > 0) {
      unitsText = formatUnits(Number(defaults.fundUnits));
    }
    return {
      confirmedBuyAmount: confirmedAmountN,
      redeemGrossAmount: grossRedeemN,
      computedFee: calculatedFeeN > 0 ? calculatedFeeN.toFixed(2) : "",
      effectiveFee: effectiveFeeN,
      computedUnits: unitsText,
    };
  }

  const investmentCalculation = useMemo(
    () => buildInvestmentCalculation(),
    [amount, arrivalAmount, buyResultStatus, defaults?.fundUnits, fee, feeEdited, feeRate, mode, nav, productType, subtype, units],
  );
  const redeemGrossAmount = investmentCalculation.redeemGrossAmount;
  const confirmedBuyAmount = investmentCalculation.confirmedBuyAmount;
  const computedFee = investmentCalculation.computedFee;
  const redeemPanelMode = isRedeemLike(subtype);

  useEffect(() => {
    if (buyResultStatus !== "refund" || subtype !== "buy") return;
    if (linkedRefundEntryId) return;
    if (applyDate && !arrivalDateEditedRef.current) {
      const nextArrivalDate = arrivalDays > 0 ? addFundTradingDays(applyDate, arrivalDays) : applyDate;
      if (arrivalDate !== nextArrivalDate) setArrivalDate(nextArrivalDate);
    }
  }, [buyResultStatus, subtype, applyDate, arrivalDate, arrivalDays, linkedRefundEntryId]);

  const computedUnits = investmentCalculation.computedUnits;

  function recalculateBuyUnitsFromInputs(options?: {
    amountRaw?: string;
    navRaw?: string;
    feeRaw?: string;
    feeRateRaw?: string;
    refundRaw?: string;
    recalculateFeeFromRate?: boolean;
  }) {
    if (productType !== "fund" && productType !== "money") return false;
    if (subtype !== "buy") return false;

    const nextAmountRaw = options?.amountRaw ?? amount;
    const nextNavRaw = options?.navRaw ?? nav;
    const nextRefundRaw = options?.refundRaw ?? arrivalAmount;
    let nextFeeRaw = options?.feeRaw ?? fee;

    if (options?.recalculateFeeFromRate) {
      const rateCalc = buildInvestmentCalculation({
        amountRaw: nextAmountRaw,
        feeRaw: "",
        feeRateRaw: options?.feeRateRaw ?? feeRate,
        navRaw: nextNavRaw,
        refundRaw: nextRefundRaw,
        refundEnabled: buyResultStatus === "refund",
      });
      nextFeeRaw = rateCalc.computedFee || "0";
      setFee(nextFeeRaw);
      setFeeEdited(false);
    }

    unitsEditedRef.current = false;
    calculateBuyUnits(
      nextAmountRaw,
      nextFeeRaw,
      nextRefundRaw,
      nextNavRaw,
      buyResultStatus === "refund",
      true,
      options?.feeRateRaw,
    );
    return true;
  }

  function recalculateRedeemAmountsFromTerms(options?: {
    unitsRaw?: string;
    navRaw?: string;
    feeRaw?: string;
    feeRateRaw?: string;
    recalculateFeeFromRate?: boolean;
  }) {
    const redeemTerms = redeemTermsRef.current;
    if (redeemTerms.productType !== "fund" && redeemTerms.productType !== "money") return false;
    if (!isRedeemLike(redeemTerms.subtype)) return false;

    const unitsN = Math.max(0, p(options?.unitsRaw ?? redeemTerms.units));
    const navN = Math.max(0, p(options?.navRaw ?? redeemTerms.nav));
    if (unitsN <= 0 || navN <= 0) return false;

    const recalculateFeeFromRate = options?.recalculateFeeFromRate ?? (options?.feeRaw === undefined && shouldRecalculateFeeFromRateForTerms(redeemTerms));
    const grossAmountN = unitsN * navN;
    const feeN = recalculateFeeFromRate
      ? grossAmountN * Math.max(0, p(options?.feeRateRaw ?? redeemTerms.feeRate)) / 100
      : Math.max(0, p(options?.feeRaw ?? redeemTerms.fee));

    if (recalculateFeeFromRate) {
      const nextFeeText = feeN > 0 ? feeN.toFixed(2) : "0";
      setFee(prev => prev === nextFeeText ? prev : nextFeeText);
      setFeeEdited(prev => prev ? false : prev);
    }

    const nextAmountText = grossAmountN.toFixed(2);
    const nextArrivalAmountText = Math.max(0, grossAmountN - feeN).toFixed(2);
    amountEditedRef.current = false;
    setAmount(prev => prev === nextAmountText ? prev : nextAmountText);
    setArrivalAmount(prev => prev === nextArrivalAmountText ? prev : nextArrivalAmountText);
    return true;
  }

  function recalculateRedeemAmountsFromNav(nextNavRaw: string, options?: { recalculateFeeFromRate?: boolean }) {
    const redeemTerms = redeemTermsRef.current;
    return recalculateRedeemAmountsFromTerms({
      navRaw: nextNavRaw,
      unitsRaw: redeemTerms.units,
      feeRaw: redeemTerms.fee,
      feeRateRaw: redeemTerms.feeRate,
      recalculateFeeFromRate: options?.recalculateFeeFromRate ?? shouldRecalculateFeeFromRateForTerms(redeemTerms),
    });
  }

  // Redeem has its own linkage: units + NAV -> gross amount -> arrival amount.
  // Do not let fee state changes retrigger this effect, or zero-fee redeems can
  // bounce between the buy-flow empty fee placeholder and the redeem-flow value.
  useEffect(() => {
    if (!open || productType === "metal" || !isRedeemLike(subtype)) return;
    if (mode === "edit" && !editAutoNavEnabledRef.current && !navEditedRef.current) return;
    if (!nav.trim()) return;
    recalculateRedeemAmountsFromTerms({ recalculateFeeFromRate: shouldRecalculateFeeFromRateForCurrentInputs() });
  }, [feeEdited, feeRate, feeRateEdited, mode, nav, open, productType, subtype, units]);

  useEffect(() => {
    if (mode !== "create") return;
    if (isRedeemLike(subtype)) return;
    if (!showFeeFor(subtype, productType) || feeEdited) return;
    if (fee !== computedFee) {
      setFee(computedFee);
      if (!recalculateBuyUnitsFromInputs({ feeRaw: computedFee })) {
        calculateBuyUnits(amount, computedFee);
      }
    }
  }, [amount, computedFee, fee, feeEdited, mode, productType, subtype]);

  useEffect(() => {
    if (mode !== "create") return;
    if (!isBuyLike(subtype) || productType === "metal" || unitsEditedRef.current) return;
    if (units !== computedUnits) setUnits(computedUnits);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computedUnits, mode, productType, subtype]);

  function calculateBuyUnits(
    nextAmountRaw: string,
    nextFeeRaw: string,
    nextRefundRaw = arrivalAmount,
    nextNavRaw = nav,
    refundEnabled = buyResultStatus === "refund",
    force = false,
    nextFeeRateRaw?: string,
  ) {
    suppressFeeAutoCalcRef.current = false;
    if (!isBuyLike(subtype) || (!force && unitsEditedRef.current)) return;
    const nextCalc = buildInvestmentCalculation({
      amountRaw: nextAmountRaw,
      feeRaw: nextFeeRaw,
      feeRateRaw: nextFeeRateRaw,
      refundRaw: nextRefundRaw,
      navRaw: nextNavRaw,
      refundEnabled,
    });
    setUnits(nextCalc.computedUnits);
  }

  function calculateUnitsAfterFeeChange(nextFeeRaw: string) {
    if (
      !recalculateBuyUnitsFromInputs({ feeRaw: nextFeeRaw }) &&
      !recalculateRedeemAmountsFromTerms({ feeRaw: nextFeeRaw })
    ) {
      calculateBuyUnits(amount, nextFeeRaw);
    }
  }

  function calculateUnitsAfterAmountChange(nextAmountRaw: string) {
    if (
      !recalculateBuyUnitsFromInputs({ amountRaw: nextAmountRaw, recalculateFeeFromRate: shouldRecalculateFeeFromRateForCurrentInputs() }) &&
      !recalculateRedeemAmountsFromTerms({ recalculateFeeFromRate: shouldRecalculateFeeFromRateForCurrentInputs() })
    ) {
      calculateBuyUnits(nextAmountRaw, fee);
    }
  }

  function calculateUnitsAfterRefundChange(nextRefundRaw: string) {
    unitsEditedRef.current = false;
    if (!recalculateBuyUnitsFromInputs({ refundRaw: nextRefundRaw, recalculateFeeFromRate: shouldRecalculateFeeFromRateForCurrentInputs() })) {
      calculateBuyUnits(amount, fee, nextRefundRaw, nav, p(nextRefundRaw) > 0 || buyResultStatus === "refund", true);
    }
  }

  function calculateFeeFromRate(nextRateRaw: string) {
    suppressFeeAutoCalcRef.current = false;
    setFeeEdited(prev => prev ? false : prev);
    const recalculateOptions = {
      feeRateRaw: nextRateRaw,
      recalculateFeeFromRate: true,
    };
    if (recalculateBuyUnitsFromInputs(recalculateOptions)) return;
    if (recalculateRedeemAmountsFromTerms(recalculateOptions)) return;
    if (isRedeemLike(subtype)) return;

    unitsEditedRef.current = false;
    const rateCalc = buildInvestmentCalculation({ feeRaw: "", feeRateRaw: nextRateRaw });
    const nextFee = rateCalc.computedFee;
    const feeChanged = p(nextFee) !== p(fee);
    setFee(prev => prev === nextFee ? prev : nextFee);

    const nextCalc = buildInvestmentCalculation({
      feeRaw: nextFee,
      feeRateRaw: nextRateRaw,
      refundEnabled: buyResultStatus === "refund",
    });
    setUnits(prev => prev === nextCalc.computedUnits ? prev : nextCalc.computedUnits);

    if (feeChanged && isRedeemLike(subtype)) {
      const gross = redeemGrossAmount > 0 ? redeemGrossAmount : p(amount);
      if (gross > 0) setArrivalAmount(Math.max(0, gross - p(nextFee)).toFixed(2));
    }
  }

  // When the apply date changes, update the confirm and arrival dates.
  // The arrival date is a terminal field; it only back-fills arrivalDays and must not drive confirmDate.
  useEffect(() => {
    if (mode === "edit" && !editAutoNavEnabledRef.current) return;
    if (isDividend(subtype) && applyDate && !arrivalDateEditedRef.current) {
      setArrivalDate(applyDate);
      return;
    }
    if ((isBuyLike(subtype) || isRedeemLike(subtype)) && applyDate && confirmDays >= 0) {
      const nextConfirmDate = addFundTradingDays(applyDate, confirmDays);
      setConfirmDate(nextConfirmDate);
      // Derive the arrival date from the application date, skipping non-trading days.
      if (!arrivalDateEditedRef.current) {
        setArrivalDate(arrivalDays > 0 ? addFundTradingDays(applyDate, arrivalDays) : applyDate);
      }
    }
  }, [applyDate, confirmDays, subtype, open, mode]);

  // When the user edits the arrival date, back-calculate arrivalDays.
  const arrivalDateEditedRef = useRef(false);
  const arrivalDaysEditedRef = useRef(false);
  function onArrivalDateChange(val: string) {
    setArrivalDate(val);
    arrivalDateEditedRef.current = true;
    arrivalDaysEditedRef.current = true;
    // arrivalDate - applyDate gives the arrival days on the fund trading calendar.
    if (val && applyDate) {
      const diff = countTradingDaysUtc(applyDate, val, "cn_fund");
      if (diff != null) {
        setArrivalDays(diff);
      }
    }
  }

  // Held-fund flows restrict fund choices by application date; only create mode auto-fills redeem units.
  useEffect(() => {
    if (isFundRedeemAsOfMode) {
      if (mode !== "create") return;
      if (!redeemAvailableUnitsByFund || !fundCode) return;
      const availableUnits = redeemAvailableUnitsByFund.get(fundCode) ?? 0;
      unitsEditedRef.current = false;
      if (availableUnits > 0.0001) {
        setUnits(formatUnits(availableUnits));
      } else {
        changeFundCode("");
        setFundName("");
        setHoldingSearch("");
        setUnits("");
      }
      return;
    }
    if (isFundHoldingAsOfMode) {
      if (mode !== "create" || !holdingsAsOfDate || !fundCode) return;
      const availableUnits = redeemAvailableUnitsByFund?.get(fundCode) ?? 0;
      if (availableUnits <= 0.0001) {
        changeFundCode("");
        setFundName("");
        setHoldingSearch("");
      }
      return;
    }
    if (mode !== "create") return;
    if (!isRedeemLike(subtype) || unitsEditedRef.current || !fundCode || !effectiveHoldings) return;
    const h = effectiveHoldings.find(p => p.fundCode === fundCode);
    if (h && h.units > 0) setUnits(formatUnits(Number(h.units)));
  }, [applyDate, effectiveHoldings, fundCode, holdingsAsOfDate, isFundHoldingAsOfMode, isFundRedeemAsOfMode, mode, redeemAvailableUnitsByFund, subtype]);

  useEffect(() => {
    const code = fundCode.trim();
    if (!confirmDate || !code || !showUnitsFor(subtype, productType)) return;
    if (productType === "metal") return;
    if (mode === "edit" && !editAutoNavEnabledRef.current) return;
    // Source fields drive NAV lookup; buy-flow units are terminal output and must not retrigger it.
    // Debounce NAV fetching to avoid consecutive requests when date/code link.
    if (navDebounce.current) clearTimeout(navDebounce.current);
    navDebounce.current = setTimeout(() => {
      const fetchKey = `${toAccountId}:${code}:${applyDate}:${confirmDate}:${subtype}`;
      if (lastNavFetchKey.current === fetchKey) return;
      lastNavFetchKey.current = fetchKey;
      setNavLoading(true);
      fetch(buildFundNavUrl(code, confirmDate, toAccountId, applyDate, subtype))
        .then(r => r.json())
        .then(d => {
          if (d.ok && d.nav) {
            const nextNav = String(d.nav);
            setNavFromApi(nextNav);
            setNavActualDate(d.date && d.date !== confirmDate ? d.date : null);
            const recalculated = subtype === "buy"
              ? recalculateBuyUnitsFromInputs({
                  navRaw: nextNav,
                  recalculateFeeFromRate: shouldRecalculateFeeFromRateForCurrentInputs(),
                })
              : recalculateRedeemAmountsFromNav(nextNav);
            if (!recalculated && isBuyLike(subtype)) {
              calculateBuyUnits(amount, fee, arrivalAmount, nextNav);
            }
          }
        })
        .catch(() => {})
        .finally(() => setNavLoading(false));
    }, 500);
    return () => { if (navDebounce.current) clearTimeout(navDebounce.current); };
  }, [amount, applyDate, arrivalAmount, buyResultStatus, confirmDate, fee, feeEdited, feeRate, feeRateEdited, fundCode, mode, productType, subtype, toAccountId]);

  function resetForCreate(keepSubtype = false, options?: { preferDefaults?: boolean }) {
    // Read current fund from URL at click time (defaults prop may be stale from SSR)
    let urlFundCode = "";
    if (!options?.preferDefaults) {
      try {
        const q = new URLSearchParams(window.location.search);
        const view = q.get("view") ?? "";
        if (view === "investfund" || view === "investmoney") urlFundCode = q.get("fundCode") ?? "";
      } catch { /* SSR guard */ }
    }

    if (!keepSubtype) {
      setProductType(fixedProductType);
      setSubtype("buy");
      setCashAccountId("");
      investmentAccountTouchedRef.current = false;
      setToAccountId(defaultAccountId);
      setMetalTypeId("");
      setMetalUnitId("");
      const nextFundCode = urlFundCode ? urlFundCode : (defaults?.fundCode ?? "");
      const nextFundName = urlFundCode ? (defaults?.fundName ?? urlFundCode) : (defaults?.fundName ?? "");
      const nextConfirmDays = typeof defaults?.confirmDays === "number" ? defaults.confirmDays : Number(defaults?.confirmDays) || 0;
      setFundCode(nextFundCode);
      setFundName(nextFundName);
      setHoldingSearch(nextFundCode ? `${nextFundCode} ${nextFundName || nextFundCode}` : "");
      setFeeRate(defaults?.feeRate ?? "0");
      setConfirmDays(nextConfirmDays);
      setConfirmDate(addFundTradingDays(today, nextConfirmDays));
      setFeeRateEdited(false);
    }
    // Reset date, amount, units, NAV, fee, and memo.
    setApplyDate(today);
    cashAccountTouchedRef.current = false;
    cashAccountAutoRef.current = false;
    prevSavedDateRef.current = null;
    setArrivalDate("");
    setArrivalAmount("");
    setArrivalDays(2);
    arrivalDateEditedRef.current = false;
    arrivalDaysEditedRef.current = false;
    setNav("");
    setNavActualDate(null);
    lastNavFetchKey.current = "";
    setNavLoading(false);
    setUnits("");
    setAmount("");
    setFee("");
    setFeeEdited(false);
    setMemo("");
    unitsEditedRef.current = false;
    amountEditedRef.current = false;
    navEditedRef.current = false;
  }

  useEffect(() => {
    if (!openSignal) return;
    if (mode === "edit" && entry) {
      setOpen(true);
      return;
    }
    if (mode !== "create") return;
    resetForCreate(false, { preferDefaults: true });
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry, mode, openSignal, defaults?.fundCode, defaults?.fundName, defaults?.fundUnits, defaults?.confirmDays, defaults?.feeRate]);

  async function handleFundCodeBlur() {
    if (!open) return;
    const code = fundCode.trim();
    if (!code || code.length !== 6) return;

    const unchangedEditCode = mode === "edit" && code === initFundCode && !!initFundName;
    if (unchangedEditCode) return;

    const holdingName = findFundNameFromHoldings(code);
    if (holdingName) {
      setFundName(holdingName);
    } else {
      setNameLoading(true);
      try {
        const res = await fetch(`/api/v1/fund/name?code=${encodeURIComponent(code)}`);
        const data = await res.json();
        if (data.ok && data.name) setFundName(data.name);
      } catch {} finally {
        setNameLoading(false);
      }
    }

    if (!feeRateEdited) {
      fetch(`/api/v1/fund/fee-rate?accountId=${encodeURIComponent(toAccountId)}&fundCode=${encodeURIComponent(code)}&feeType=${isRedeemLike(subtype) ? "redeem" : "buy"}${confirmDate ? `&effectiveDate=${encodeURIComponent(confirmDate)}` : ""}`)
        .then(r => r.json())
        .then(d => {
          if (!d.ok || d.rate == null || feeRateEdited) return;
          const nextRate = String(d.rate);
          setFeeRate(prev => prev === nextRate ? prev : nextRate);
          if (mode === "create") calculateFeeFromRate(nextRate);
        })
        .catch(() => {});
    }
  }

  async function fetchNav() {
    if (!fundCode) return;
    if (productType === "metal") return;
    const fetchDate = confirmDate || applyDate;
    setNavLoading(true);
    try {
      const res = await fetch(buildFundNavUrl(fundCode, fetchDate, toAccountId, applyDate, subtype));
      const data = await res.json();
      if (data.ok && data.nav) {
        const nextNav = String(data.nav);
        setNavFromApi(nextNav);
        setNavActualDate(data.date && data.date !== fetchDate ? data.date : null);
        lastNavFetchKey.current = `${toAccountId}:${fundCode.trim()}:${fetchDate}`;
        const recalculated = subtype === "buy"
          ? recalculateBuyUnitsFromInputs({
              navRaw: nextNav,
              recalculateFeeFromRate: shouldRecalculateFeeFromRateForCurrentInputs(),
            })
          : recalculateRedeemAmountsFromNav(nextNav);
        if (!recalculated && isBuyLike(subtype)) {
          calculateBuyUnits(amount, fee, arrivalAmount, nextNav, buyResultStatus === "refund", true);
        }
      } else {
        clearUnavailableNav();
        window.alert(data.error ?? t("investForm.alert.navFetchFailed", { code: fundCode, date: fetchDate }));
      }
    } catch (err) {
      clearUnavailableNav();
      window.alert(err instanceof Error ? err.message : t("investForm.alert.navFetchError"));
    } finally {
      setNavLoading(false);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>, keepOpen = false) {
    e.preventDefault();
    if (submitting) return;
    const finalAmount = p(amount);
    // Dividend reinvest changes fund-side units only; it does not create a cash amount.
    if (isDividend(subtype) && subtype !== "dividend_cash") {
      // Only validate units; do not block an empty amount.
    } else if (!amount.trim() || finalAmount < 0) {
      window.alert(t("investForm.alert.invalidAmount"));
      return;
    }
    if (!isDividend(subtype) && confirmDate && confirmDate < applyDate) { window.alert(t("investForm.alert.confirmDateBeforeApply")); return; }

    const userClearedUnits =
      mode === "edit" &&
      unitsEditedRef.current &&
      !units.trim();
    const shouldUseConfirmedBuyUnits =
      subtype === "buy" &&
      buyResultStatus === "refund" &&
      p(arrivalAmount) > 0 &&
      !userClearedUnits;
    const redeemAsOfUnits = isRedeemLike(subtype) && redeemAvailableUnitsByFund
      ? (redeemAvailableUnitsByFund.get(fundCode.trim()) ?? 0)
      : 0;
    const typedUnits = p(units);
    const shouldUseRedeemAsOfUnits = isFundRedeemAsOfMode &&
      redeemAsOfUnits > 0.0001 &&
      !unitsEditedRef.current &&
      (mode === "create" || typedUnits <= 0 || typedUnits > redeemAsOfUnits + 0.0001);
    const rawFinalUnits = shouldUseConfirmedBuyUnits
      ? (computedUnits ? p(computedUnits) : 0)
      : userClearedUnits
        ? 0
        : shouldUseRedeemAsOfUnits
          ? redeemAsOfUnits
          : (typedUnits > 0 ? typedUnits : (redeemAsOfUnits > 0 ? redeemAsOfUnits : (computedUnits ? p(computedUnits) : 0)));
    const finalUnits = rawFinalUnits > 0 ? roundFundUnits(rawFinalUnits, fundUnitsDecimals) : 0;
    if (subtype === "dividend_reinvest" && finalUnits <= 0) {
      window.alert(t("fundUnitsReconcile.enterValidUnits"));
      return;
    }
    const finalFee = investmentCalculation.effectiveFee;
    const finalFeeRate = p(feeRate);
    const currentMetalType = productType === "metal" ? selectedMetalType() : null;
    const currentMetalUnit = productType === "metal" ? selectedMetalUnit() : null;
    if (productType === "metal" && !currentMetalType) {
      window.alert(t("investForm.alert.selectMetalType"));
      return;
    }
    if (productType === "metal" && !currentMetalUnit) {
      window.alert(t("investForm.alert.selectMetalUnit"));
      return;
    }
    const finalFundCode = productType === "metal" ? "" : fundCode.trim();
    const finalFundName = productType === "metal" ? "" : fundName.trim();

    if (isFundHoldingAsOfMode && (mode === "create" || redeemAvailableUnitsByFund)) {
      const availableUnits = redeemAvailableUnitsByFund?.get(finalFundCode) ?? 0;
      const currentUnits = holdingUnitsByFund.get(finalFundCode) ?? 0;
      const redeemLimitUnits = isFundRedeemAsOfMode
        ? availableUnits
        : availableUnits > 0.0001 ? availableUnits : currentUnits;
      if (!finalFundCode || redeemLimitUnits <= 0.0001) {
        window.alert(t("investForm.alert.selectRedeemFund"));
        return;
      }
      if (isFundRedeemAsOfMode && finalUnits <= 0) {
        window.alert(t("investForm.alert.redeemUnitsPositive"));
        return;
      }
      if (isFundRedeemAsOfMode && finalUnits > redeemLimitUnits + 0.0001) {
        window.alert(t("investForm.alert.redeemUnitsExceed", { units: formatUnits(redeemLimitUnits) }));
        return;
      }
    }

    const effectiveAmount = subtype === "dividend_reinvest" ? 0 : finalAmount;
    const shouldSubmitCashAccount = subtype !== "dividend_reinvest";
    const shouldSubmitFundNavFields = !isDividend(subtype) || subtype === "dividend_reinvest";

    const isCreateMode = mode === "create";
    const shouldWriteConfirmRule =
      !isDividend(subtype) &&
      (isCreateMode || confirmDaysEdited || arrivalDaysEditedRef.current);
    const confirmRuleBody =
      productType !== "metal" && fundCode.trim() && confirmDays >= 0 && shouldWriteConfirmRule
        ? {
            accountId: toAccountId,
            rows: [{
              fundCode: fundCode.trim(),
              ...(isCreateMode || confirmDaysEdited ? { days: isDividend(subtype) ? 0 : confirmDays } : {}),
              ...(isCreateMode || arrivalDaysEditedRef.current ? { arrivalDays } : {}),
              ...(isCreateMode ? { redeemCostDays, effectiveDate: applyDate } : {}),
            }],
          }
        : null;

    // Write the new rate for this confirm date only when the user edited the rate manually.
    if (mode === "create" && feeRateEdited && !isDividend(subtype) && (productType === "fund" || productType === "money") && fundCode.trim() && showFeeFor(subtype, productType)) {
      fetch("/api/v1/fund/fee-rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: toAccountId, fundCode: fundCode.trim(), rate: finalFeeRate, feeType: isRedeemLike(subtype) ? "redeem" : "buy", effectiveDate: confirmDate || applyDate }),
      }).catch(() => {});
    }

    const formData = new FormData();
    // The business date is the application date; arrivalDate remains the cash-side arrival date.
    const effectiveDate = applyDate;
    const submitSubtype: FundSubtype = subtype;
    const submitEntry = mode === "edit" ? (eventEditEntry ?? entry ?? null) : null;
    const submitSource = mode === "edit" ? (submitEntry?.source ?? "") : "";

    if (mode === "edit" && (submitEntry || editEntryId)) {
      formData.set("intent", "editInvestment");
      formData.set("entryId", editEntryId || submitEntry?.id || "");
      formData.set("transactionId", submitEntry?.transactionId || editEntryId || "");
      formData.set("subtype", submitSubtype);
      formData.set("fundSubtype", submitSubtype);
      if (submitSource && !(submitSubtype === "buy" && submitSource === "regular_invest_refund")) formData.set("source", submitSource);
      formData.set("buyResultStatus", submitSubtype === "buy" ? buyResultStatus : "normal");
      if (linkedRefundEntryId) formData.set("linkedRefundEntryId", linkedRefundEntryId);
      formData.set("date", effectiveDate);
      formData.set("amount", String(effectiveAmount));
      formData.set("memo", memo.trim());
      formData.set("fundCode", finalFundCode);
      formData.set("fundName", finalFundName);
      formData.set("fundProductType", productType);
      if (productType === "metal" && currentMetalType && currentMetalUnit) {
        formData.set("metalTypeId", currentMetalType.id);
        formData.set("metalTypeName", currentMetalType.name);
        formData.set("metalUnitId", currentMetalUnit.id);
        formData.set("metalUnitName", currentMetalUnit.symbol ? `${currentMetalUnit.name}(${currentMetalUnit.symbol})` : currentMetalUnit.name);
        formData.set("metalQuantity", finalUnits > 0 ? String(finalUnits) : "");
        formData.set("metalUnitPrice", nav.trim());
        formData.set("metalFee", fee.trim());
      }
      if (!isDividend(subtype) || subtype === "dividend_reinvest") {
        formData.set("fundUnits", finalUnits > 0 ? String(finalUnits) : "");
      }
      if (shouldSubmitFundNavFields) {
        formData.set("fundNav", nav.trim() ? String(p(nav)) : "");
        if (!isDividend(subtype)) formData.set("fundFee", finalFee > 0 ? String(finalFee) : "");
        formData.set("fundConfirmDate", confirmDate || "");
      }
      formData.set("accountId", toAccountId);
      formData.set("toAccountId", toAccountId);
      if (shouldSubmitCashAccount) formData.set("cashAccountId", cashAccountId || "");
      if (isDividend(subtype)) {
        formData.set("fundArrivalDate", arrivalDate || effectiveDate);
      } else {
        formData.set("fundArrivalDate", arrivalDate || "");
        formData.set("fundArrivalAmount", isRedeemLike(subtype) && arrivalAmount.trim() ? String(p(arrivalAmount)) : "");
        if (subtype === "buy" && buyResultStatus === "refund") {
          formData.set("refundAmount", arrivalAmount.trim() ? String(p(arrivalAmount)) : "");
          formData.set("refundDate", arrivalDate || confirmDate || effectiveDate);
        }
      }
      if (!isDividend(subtype) && showFeeFor(subtype, productType)) {
        formData.set("feeRate", feeRate.trim() ? feeRate : "");
        if (feeRateEdited) formData.set("feeRateEdited", "1");
      }
      if (!isDividend(subtype)) {
        formData.set("confirmDays", String(confirmDays));
        formData.set("arrivalDays", String(arrivalDays));
      }
    } else {
      formData.set("type", "investment");
      formData.set("subtype", subtype);
      formData.set("fundSubtype", subtype);
      formData.set("buyResultStatus", subtype === "buy" ? buyResultStatus : "normal");
      formData.set("accountId", toAccountId);
      if (shouldSubmitCashAccount && cashAccountId) formData.set("cashAccountId", cashAccountId);
      formData.set("date", effectiveDate);
      formData.set("amount", String(effectiveAmount));
      formData.set("note", memo.trim() || finalFundName || finalFundCode);
      formData.set("fundProductType", productType);
      if (finalFundCode) formData.set("fundCode", finalFundCode);
      if (finalFundName) formData.set("fundName", finalFundName);
      if (productType === "metal" && currentMetalType && currentMetalUnit) {
        formData.set("metalTypeId", currentMetalType.id);
        formData.set("metalTypeName", currentMetalType.name);
        formData.set("metalUnitId", currentMetalUnit.id);
        formData.set("metalUnitName", currentMetalUnit.symbol ? `${currentMetalUnit.name}(${currentMetalUnit.symbol})` : currentMetalUnit.name);
        formData.set("metalQuantity", finalUnits > 0 ? String(finalUnits) : "");
        formData.set("metalUnitPrice", nav.trim());
        formData.set("metalFee", fee.trim());
      }
      if (!isDividend(subtype) || subtype === "dividend_reinvest") {
        if (finalUnits > 0) formData.set("fundUnits", String(finalUnits));
      }
      if (shouldSubmitFundNavFields) {
        if (p(nav) > 0) formData.set("fundNav", String(p(nav)));
        if (!isDividend(subtype)) formData.set("fundFee", finalFee > 0 ? String(finalFee) : "");
        if (confirmDate) formData.set("fundConfirmDate", confirmDate);
      }
      if (isDividend(subtype)) {
        if (arrivalDate) formData.set("fundArrivalDate", arrivalDate);
      } else if (isRedeemLike(subtype)) {
        if (arrivalDate) formData.set("fundArrivalDate", arrivalDate);
        if (isRedeemLike(subtype) && p(arrivalAmount) > 0) formData.set("fundArrivalAmount", String(p(arrivalAmount)));
      } else if (subtype === "buy" && buyResultStatus === "refund") {
        formData.set("fundArrivalDate", arrivalDate || confirmDate || effectiveDate);
        formData.set("refundAmount", p(arrivalAmount) > 0 ? String(p(arrivalAmount)) : "");
        formData.set("refundDate", arrivalDate || confirmDate || effectiveDate);
      }
      formData.set("redeemCostDays", String(redeemCostDays));
      formData.set('arrivalDays', String(arrivalDays));
    }
    formData.set("tagIds", JSON.stringify(selectedTagIds));
    setSubmitting(true);
    try {
      const res = mode === "edit" && editAction ? await editAction(formData) : await createAction(formData);
      if (!res.ok) { window.alert(res.error); return; }
      if (confirmRuleBody) {
        fetch("/api/v1/fund/confirm-days", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(confirmRuleBody),
        }).catch(() => {});
      }
      if (mode === "create" && requestIdRef.current) {
        notifyAiSuccess(requestIdRef.current);
        requestIdRef.current = null;
      }
      if (keepOpen) {
        if (mode === "create") {
          // When saving and continuing, derive the next apply date from the previous save interval.
          const currentDate = applyDate;
          const prev = prevSavedDateRef.current;
          const intervalRaw = prev
            ? Math.round((new Date(currentDate + "T00:00:00Z").getTime() - new Date(prev + "T00:00:00Z").getTime()) / 86400000)
            : 1;
          const interval = intervalRaw >= 7 ? intervalRaw : 1;
          prevSavedDateRef.current = currentDate;
          const [y, m, d] = currentDate.split("-").map(Number);
          const next = new Date(Date.UTC(y, m - 1, d + interval));
          while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1);
          const nextDate = next.toISOString().slice(0, 10);
          setApplyDate(nextDate);
          setConfirmDate(addFundTradingDays(nextDate, confirmDays));
          setNav("");
          setNavLoading(false);
          setFee("");
          setFeeEdited(false);
          setMemo("");
          amountEditedRef.current = false;
          navEditedRef.current = false;
          setConfirmDaysEdited(true);
          arrivalDateEditedRef.current = false;
          arrivalDaysEditedRef.current = false;
          // Preserve amount and fund, clear nav/units (user re-fetches or enters nav for new date)
          if (amount.trim() && fundCode.trim()) {
            // Check if nav is available in cache for the new date via API
            fetch(buildFundNavUrl(fundCode.trim(), nextDate, toAccountId, nextDate, subtype))
              .then(r => r.json())
              .then(d => {
                if (d.ok && d.nav) {
                  const nextNav = String(d.nav);
                  setNavFromApi(nextNav);
                  setNavActualDate(d.date && d.date !== nextDate ? d.date : null);
                  const navN = p(nextNav);
                  const amountN = p(amount);
                  const recalculated = subtype === "buy"
                    ? recalculateBuyUnitsFromInputs({
                        navRaw: nextNav,
                        recalculateFeeFromRate: shouldRecalculateFeeFromRateForCurrentInputs(),
                      })
                    : recalculateRedeemAmountsFromNav(nextNav);
                  if (!recalculated && isBuyLike(subtype) && navN > 0 && amountN > 0) {
                    const feeN = p(fee);
                    const effectiveFee = feeEdited ? feeN : (feeN > 0 ? feeN : (amountN * (p(feeRate) / 100)));
                    const refundAmountN = buyResultStatus === "refund" ? Math.max(0, p(arrivalAmount)) : 0;
                    const principal = Math.max(0, amountN - refundAmountN) - effectiveFee;
                    setUnits(principal > 0 ? formatUnits(principal / navN) : "");
                  }
                }
              })
              .catch(() => {});
          }
        }
        requestAnimationFrame(() => {
          dispatchFinanceDataChanged({ reason: "investment-save" });
        });
      } else {
        setOpen(false);
        if (mode === "create") resetForCreate();
        requestAnimationFrame(() => {
          dispatchFinanceDataChanged({ reason: "investment-save" });
        });
      }
    } catch (err) { window.alert(err instanceof Error ? err.message : (mode === "edit" ? t("investForm.alert.saveFailed") : t("txForm.alert.saveFailed"))); }
    finally { setSubmitting(false); }
  }

  async function onDelete() {
    if (deleting || mode !== "edit" || !entry) return;
    setDeleting(true);
    try {
      const data = await deleteEntriesWithLinkedPrompt({
        entryIds: [entry.id],
        confirmMessage: t("investForm.deleteConfirm"),
        t,
      });
      if (!data.ok) {
        if (data.code !== "DELETE_CANCELLED" && data.error !== "已取消删除") window.alert(data.error ?? t("investForm.alert.deleteFailed"));
        return;
      }
      requestAnimationFrame(() => {
        const refreshEntryIds = getDeleteRefreshEntryIds(data, [entry.id]);
        dispatchFinanceDataChanged({ reason: "investment-delete", accountIds: getDeleteRefreshAccountIds(data), deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });
      });
    } catch {
      window.alert(t("investForm.alert.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  const showCode = productType === "fund" || productType === "money" || productType === "metal";
  const showFee = showFeeFor(subtype, productType);
  const productShortLabel = productType === "metal" ? t("investment.product.metal") : t("txForm.fund");
  const productAccountLabel = t("investForm.productAccount", { product: productShortLabel });
  const productCodeLabel = t("investForm.productCode", { product: productShortLabel });
  const productNameLabel = t("investForm.productName", { product: productShortLabel });
  const productCodePlaceholder = productType === "metal" ? t("investForm.codePlaceholderMetal") : t("investForm.codePlaceholderFund");
  const productNameReadOnly = productType !== "metal";

  const title = mode === "edit"
    ? t("investForm.editTitle", { product: productShortLabel })
    : t("investForm.createTitle");
  useCloseOnNavigation(open, () => {
    setOpen(false);
    if (mode === "create") resetForCreate();
  });

  // Edit mode shows icon buttons; create mode shows the record button.
  const triggerButton = mode === "edit" ? (
    entry ? (
      <div className="flex h-7 shrink-0 items-center gap-1">
        <button type="button" onClick={() => setOpen(true)}
          className="secondary-button h-7 w-7 shrink-0 px-0 text-slate-500 hover:text-blue-600">
          <Pencil className="h-3.5 w-3.5 shrink-0" />
        </button>
        <button type="button" onClick={onDelete} disabled={deleting}
          className="secondary-button h-7 w-7 shrink-0 px-0 text-slate-500 hover:text-red-600 disabled:opacity-50">
          <Trash2 className="h-3.5 w-3.5 shrink-0" />
        </button>
      </div>
    ) : null
  ) : (
    <button type="button" onClick={() => { resetForCreate(); setOpen(true); }}
      className="primary-button h-8 gap-1 px-3 shadow-sm">
      <Plus className="w-4 h-4" />{t("txForm.record")}
    </button>
  );

  return (
    <ModalLayerProvider value={modalZIndex}>
      {!hideTrigger ? triggerButton : null}

      {open && typeof document !== "undefined" ? createPortal(
        <div className="app-modal-backdrop" style={{ zIndex: modalZIndex }}>
          <div className="app-modal-panel max-w-2xl">
              <div className="modal-header shrink-0">
                <div className="text-sm font-semibold text-slate-800">
                  {title}
                  <span className="ml-2 text-xs font-normal text-slate-500">{t(`investment.product.${productType}`)}</span>
                </div>
                <button type="button" onClick={() => { setOpen(false); if (mode === "create") resetForCreate(); }}
                    className="secondary-button h-8 px-2">{t("investForm.close")}</button>
              </div>

              <form className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" onSubmit={onSubmit}>
              <div className="space-y-1">
                <div className="form-label">{t("investForm.transactionType")}</div>
                <div className="space-y-1.5">
                  {PRODUCT_SUBTYPES[productType].map((group, gi) => (
                    <div key={gi} className="flex gap-1.5">
                      {group.map((s) => {
                        const isActive = subtype === s;
                        return (
                          <button key={s} type="button" onClick={() => selectSubtypeOption(s)}
                            className={`segment-button h-8 flex-1 text-xs ${isActive ? "segment-button-active font-medium" : ""}`}>
                            {productType === "deposit"
                              ? (s === "buy" ? t("investForm.subtype.depositIn") : t("investForm.subtype.depositOut"))
                              : t(`fund.subtype.${s}`)}
                          </button>
                        );
                      })}

                    </div>
                  ))}
                </div>
              </div>

              {isDividend(subtype) ? (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("investForm.applyDate")}</div>
                      <DateStepper value={applyDate} onChange={changeApplyDate} />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("investForm.arrivalDate")}</div>
                      <DateStepper value={arrivalDate} onChange={onArrivalDateChange} />
                    </div>
                  </div>

                  {subtype === "dividend_reinvest" && investmentAccounts && investmentAccounts.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{productAccountLabel}</div>
                      {renderInvestmentAccountSelect(t("investForm.selectProductAccount", { account: productAccountLabel }))}
                    </div>
                  )}

                  {subtype === "dividend_cash" && (
                    <>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        {investmentAccounts && investmentAccounts.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-slate-600">{productAccountLabel}</div>
                            {renderInvestmentAccountSelect(t("investForm.selectProductAccount", { account: productAccountLabel }))}
                          </div>
                        )}
                        {cashAccounts && cashAccounts.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-xs font-medium text-slate-600">{t("investForm.arrivalCashAccount")}</div>
                            {renderCashAccountSelect(t("investForm.noLink"))}
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {productType === "metal" ? renderMetalFields() : isFundHoldingAsOfMode ? (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("txForm.fund")}</div>
                      <SmartSelect
                        mode="single"
                        value={fundCode}
                        onChange={selectHoldingFund}
                        options={holdingFundOptions}
                        placeholder={holdingFundLoading ? t("investForm.fetching") : holdingFundOptions.length > 0 ? t("investForm.selectHoldingFund") : t("investForm.noHoldingFundOnDate")}
                        behavior={{ search: true, clearable: false, density: "compact" }}
                      />
                    </div>
                  ) : showCode && effectiveHoldings && effectiveHoldings.length > 0 ? (
                    <HoldingPicker
                      holdings={effectiveHoldings}
                      fundCode={fundCode}
                      fundName={fundName}
                      searchText={holdingSearch}
                      onSearchChange={setHoldingSearch}
                      onSelect={(h) => { changeFundCode(h.fundCode); setFundName(h.name); }}
                      onBlur={handleFundCodeBlur}
                    />
                  ) : showCode ? (
                    <div className="grid grid-cols-[1fr_2fr] gap-2 items-end">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">{productCodeLabel}</div>
                        <input
                          value={fundCode}
                          onChange={(e) => changeFundCode(e.target.value)}
                          onBlur={handleFundCodeBlur}
                          placeholder={productCodePlaceholder}
                          className="form-input"
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">
                          {productNameLabel}
                          {nameLoading ? (
                            <span className="ml-1 font-normal text-slate-400">{t("investForm.fetching")}</span>
                          ) : null}
                        </div>
                        <input
                          value={fundName}
                          onChange={(e) => setFundName(e.target.value)}
                          readOnly={productNameReadOnly}
                          className="form-input"
                        />
                      </div>
                    </div>
                  ) : null}

                  {subtype === "dividend_cash" && (
                    <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-2">
                      <EntryTagsField value={selectedTagIds} onChange={setSelectedTagIds} />
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">{t("investForm.dividendCashAmount")}</div>
                        <input ref={dividendAmountRef} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
                          className="form-input" />
                      </div>
                    </div>
                  )}

                  {subtype === "dividend_reinvest" && (
                    <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-2">
                      <EntryTagsField value={selectedTagIds} onChange={setSelectedTagIds} />
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">{t("investForm.dividendReinvestUnits")}</div>
                        <CalcInput
                          value={units}
                          onChange={(v) => {
                            unitsEditedRef.current = true;
                            setUnits(v);
                          }}
                          placeholder="0.00"
                          label={t("investForm.units")}
                          precision={fundUnitsDecimals}
                        />
                      </div>
                    </div>
                  )}

                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("detail.column.remark")}</div>
                    <input
                      value={memo}
                      onChange={(e) => setMemo(e.target.value)}
                      placeholder={t("stockFee.optional")}
                      className="form-input"
                    />
                  </div>

                  <EntryTagsField value={selectedTagIds} onChange={setSelectedTagIds} />

                  <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex justify-end gap-2 border-t border-slate-100 bg-white/95 px-4 py-3 backdrop-blur">
                    {mode === "create" && (
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={(e) => {
                          e.preventDefault();
                          onSubmit(e as any, true);
                        }}
                        className="secondary-button h-9 px-4 text-blue-700 disabled:opacity-50"
                      >
                        {submitting ? t("stockFee.saving") : t("investForm.saveAndContinue")}
                      </button>
                    )}
                    <button
                      type="submit"
                      disabled={submitting}
                      className="primary-button h-9 disabled:opacity-50"
                    >
                      {submitting ? t("stockFee.saving") : t("common.save")}
                    </button>
                  </div>
                </>
              ) : (
              <>
              <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("investForm.applyDate")}</div>
                  <DateStepper value={applyDate} onChange={changeApplyDate}
                    onBlur={() => {
                      if (confirmDays >= 0 && applyDate) {
                        enableEditAutoNav();
                        setConfirmDate(addFundTradingDays(applyDate, confirmDays));
                      }
                    }} />
                </div>
                {showConfirmFor(subtype) && (
                  <div className="flex items-center gap-1 text-xs text-slate-600 shrink-0 pb-1">
                    <span>T+</span>
                    <input inputMode="numeric" value={confirmDays}
                      onChange={(e) => {
                        enableEditAutoNav();
                        const days = Number(e.target.value) || 0;
                        setConfirmDays(days);
                        setConfirmDaysEdited(true);
                        if (applyDate) setConfirmDate(addFundTradingDays(applyDate, days));
                      }}
                      placeholder="0"
                      className="h-7 w-8 rounded-[8px] border border-slate-300/70 bg-white text-center text-xs outline-none transition-colors focus:border-blue-400 focus:ring-2 focus:ring-blue-100" />
                  </div>
                )}
                {showConfirmFor(subtype) && (
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("investForm.confirmDate")}</div>
                    <DateStepper value={confirmDate} onChange={changeConfirmDate} min={applyDate} />
                  </div>
                )}
              </div>

              {redeemPanelMode ? (
                <>
                  {investmentAccounts && investmentAccounts.length > 0 && (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                          <div className="text-xs font-medium text-slate-600">{productAccountLabel}</div>
                          {renderInvestmentAccountSelect(t("investForm.selectProductAccount", { account: productAccountLabel }))}
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">{t("investForm.redeemArrivalAccount")}</div>
                        {renderCashAccountSelect(t("investForm.selectCashAccount"))}
                      </div>
                    </div>
                  )}

                  {productType === "metal" ? renderMetalFields() : isFundRedeemAsOfMode ? (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("txForm.fund")}</div>
                      <SmartSelect
                        mode="single"
                        value={fundCode}
                        onChange={selectHoldingFund}
                        options={holdingFundOptions}
                        placeholder={holdingFundLoading ? t("investForm.fetching") : holdingFundOptions.length > 0 ? t("investForm.selectHoldingFund") : t("investForm.noRedeemableFund")}
                        behavior={{ search: true, clearable: false, density: "compact" }}
                      />
                    </div>
                  ) : showCode && effectiveHoldings && effectiveHoldings.length > 0 ? (
                    <HoldingPicker
                      holdings={effectiveHoldings}
                      fundCode={fundCode}
                      fundName={fundName}
                      searchText={holdingSearch}
                      onSearchChange={setHoldingSearch}
                      onSelect={(h) => {
                        changeFundCode(h.fundCode);
                        setFundName(h.name);
                        if (mode === "create" && !unitsEditedRef.current && h.units != null) setUnits(formatUnits(Number(h.units)));
                      }}
                      onBlur={handleFundCodeBlur}
                    />
                  ) : showCode ? (
                    <div className="grid grid-cols-[1fr_2fr] gap-2 items-end">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">{productCodeLabel}</div>
                        <input
                          value={fundCode}
                          onChange={(e) => changeFundCode(e.target.value)}
                          onBlur={handleFundCodeBlur}
                          placeholder={productCodePlaceholder}
                          className="form-input"
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">
                          {productNameLabel}
                          {nameLoading ? (
                            <span className="ml-1 font-normal text-slate-400">{t("investForm.fetching")}</span>
                          ) : null}
                        </div>
                        <input
                          value={fundName}
                          onChange={(e) => setFundName(e.target.value)}
                          readOnly={productNameReadOnly}
                          className="form-input"
                        />
                      </div>
                    </div>
                  ) : null}
                  {!showCode && (
                    <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">{t("investForm.productNameLabel")}</div>
                      <input placeholder={t("investForm.productNamePlaceholder")} value={fundName} onChange={(e) => setFundName(e.target.value)}
                        className="form-input" />
                    </div>
                  )}

                  <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">{t("investForm.units")}</div>
                        <CalcInput
                          value={units}
                          onChange={(v) => {
                            unitsEditedRef.current = true;
                            amountEditedRef.current = false;
                            setUnits(v);
                            recalculateRedeemAmountsFromTerms({ unitsRaw: v });
                          }}
                          placeholder="0.00"
                          label={t("investForm.units")}
                          precision={fundUnitsDecimals}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={fetchNav}
                        disabled={navLoading || !fundCode || productType === "metal"}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-amber-200 bg-amber-50 text-amber-700 transition-colors hover:border-amber-300 hover:bg-amber-100 disabled:opacity-50"
                        title={productType === "metal" ? t("investForm.metalPriceManualTitle") : t("investForm.fetchNav")}
                      >
                        <DatabaseZap className={`h-4 w-4 ${navLoading ? "animate-pulse" : ""}`} />
                      </button>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">
                          {productType === "metal" ? t("investForm.metalPrice") : t("investForm.nav")}
                          {navLoading ? (
                            <span className="ml-1 font-normal text-slate-400">{t("investForm.fetching")}</span>
                          ) : null}
                          {navActualDate && !navLoading ? (
                            <span className="ml-1 font-normal text-amber-600">{t("investForm.navActualDate", { date: navActualDate, label: productType === "metal" ? t("investForm.metalPrice") : t("investForm.nav") })}</span>
                          ) : null}
                        </div>
                        <input
                          inputMode="decimal"
                          value={nav}
                          onChange={(e) => {
                            const nextNav = e.target.value;
                            setNav(nextNav);
                            navEditedRef.current = true;
                            recalculateRedeemAmountsFromNav(nextNav, {
                              recalculateFeeFromRate: shouldRecalculateFeeFromRateForCurrentInputs(),
                            });
                          }}
                          placeholder={navLoading
                            ? t("investForm.fetching")
                            : productType !== "metal" && fundCode.trim()
                              ? t("investForm.navUnavailable")
                              : "1.2345"}
                          style={{ caretColor: "var(--foreground)" }}
                          className="form-input caret-slate-800"
                        />
                      </div>
                    </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("investForm.redeemAmount")}</div>
                    <input
                      inputMode="decimal"
                      value={amount}
                      readOnly
                      style={{ caretColor: "var(--foreground)" }}
                      className="form-input bg-slate-50 text-slate-700 caret-slate-800"
                    />
                  </div>

                  {showFee && (
                  <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">{t("investForm.feeRatePercent")}</div>
                        <input
                          inputMode="decimal"
                          value={feeRate}
                          onChange={(e) => {
                            const nextRate = e.target.value;
                            setFeeRate(nextRate);
                            setFeeRateEdited(true);
                            calculateFeeFromRate(nextRate);
                          }}
                          placeholder="0"
                          style={{ caretColor: "var(--foreground)" }}
                          className="form-input caret-slate-800"
                        />
                      </div>
                      <div className="space-y-1">
                        <div className="text-xs font-medium text-slate-600">{t("investForm.feeAmount")}</div>
                        <input
                          inputMode="decimal"
                          value={fee}
                          onChange={(e) => {
                            suppressFeeAutoCalcRef.current = false;
                            setFee(e.target.value);
                            setFeeEdited(true);
                            calculateUnitsAfterFeeChange(e.target.value);
                          }}
                          placeholder={computedFee || "0.00"}
                          style={{ caretColor: "var(--foreground)" }}
                          className="form-input caret-slate-800"
                        />
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("investForm.arrivalDate")}</div>
                      <DateStepper value={arrivalDate} onChange={onArrivalDateChange} min={applyDate} />
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("investForm.arrivalAmount")}</div>
                      <CalcInput value={arrivalAmount} onChange={setArrivalAmount} placeholder={t("investForm.arrivalAmountPlaceholder")} label={t("investForm.arrivalAmount")} precision={2} />
                    </div>
                  </div>

                  {mode === "edit" && entry && (
                    <div className="space-y-1 rounded-md border border-emerald-100 bg-emerald-50/40 p-3">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-slate-600">{t("investForm.redeemProfit")}</span>
                        <span className={`tabular-nums font-semibold ${pnlCls(entry.realizedProfit)}`}>
                          {entry.realizedProfit != null ? entry.realizedProfit.toFixed(2) : t("investForm.profitAfterSave")}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-400">{t("investForm.redeemProfitHint")}</div>
                    </div>
                  )}
                </>
              ) : (
                <>
              {showAccountSelectorsFor(subtype) && cashAccounts && cashAccounts.length > 0 && investmentAccounts && investmentAccounts.length > 0 ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("investForm.cashSourceAccount")}</div>
                    {renderCashAccountSelect(t("investForm.selectCashAccount"))}
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{productAccountLabel}</div>
                    {renderInvestmentAccountSelect(t("investForm.selectProductAccount", { account: productAccountLabel }))}
                  </div>
                </div>
              ) : showAccountSelectorsFor(subtype) && cashAccounts && cashAccounts.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("investForm.cashSourceAccount")}</div>
                  {renderCashAccountSelect(t("investForm.selectCashAccount"))}
                </div>
              ) : investmentAccounts && investmentAccounts.length > 0 ? (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{productAccountLabel}</div>
                  {renderInvestmentAccountSelect(t("investForm.selectProductAccount", { account: productAccountLabel }))}
                </div>
              ) : null}

              {productType === "metal" ? renderMetalFields() : showCode && !fundCode.trim() && holdings && holdings.length > 0 ? (
                <HoldingPicker
                  holdings={holdings}
                  fundCode={fundCode}
                  fundName={fundName}
                  searchText={holdingSearch}
                  onSearchChange={setHoldingSearch}
                  onSelect={(h) => {
                    changeFundCode(h.fundCode);
                    setFundName(h.name);
                  }}
                  onBlur={handleFundCodeBlur}
                  placeholder={productCodePlaceholder}
                />
              ) : showCode ? (
                <div className="grid grid-cols-[1fr_2fr] items-end gap-2">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{productCodeLabel}</div>
                    <input
                      value={fundCode}
                      onChange={(e) => {
                        const nextCode = e.target.value;
                        changeFundCode(nextCode);
                        if (!nextCode.trim()) setHoldingSearch("");
                      }}
                      onBlur={handleFundCodeBlur}
                      placeholder={productCodePlaceholder}
                      className="form-input"
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">
                      {productNameLabel}
                      {nameLoading ? (
                        <span className="ml-1 font-normal text-slate-400">{t("investForm.fetching")}</span>
                      ) : null}
                    </div>
                    <input
                      value={fundName}
                      onChange={(e) => setFundName(e.target.value)}
                      readOnly={productNameReadOnly}
                      className="form-input"
                    />
                  </div>
                </div>
              ) : null}

              {!showCode && (
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("investForm.productNameLabel")}</div>
                  <input placeholder={t("investForm.productNamePlaceholder")} value={fundName} onChange={(e) => setFundName(e.target.value)}
                    className="form-input" />
                </div>
              )}

              <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[0.7fr_auto_1fr]">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">
                    {productType === "metal" ? t("investForm.metalPrice") : t("investForm.nav")}
                    {navLoading ? (
                      <span className="ml-1 font-normal text-slate-400">{t("investForm.fetching")}</span>
                    ) : null}
                    {navActualDate && !navLoading ? (
                      <span className="ml-1 font-normal text-amber-600">{t("investForm.navActualDate", { date: navActualDate, label: productType === "metal" ? t("investForm.metalPrice") : t("investForm.nav") })}</span>
                    ) : null}
                  </div>
                  <input
                    inputMode="decimal"
                    value={nav}
                    onChange={(e) => {
                      const nextNav = e.target.value;
                      setNav(nextNav);
                      navEditedRef.current = true;
                      if (subtype === "buy") {
                        recalculateBuyUnitsFromInputs({
                          navRaw: nextNav,
                          recalculateFeeFromRate: shouldRecalculateFeeFromRateForCurrentInputs(),
                        });
                      } else {
                        calculateBuyUnits(amount, fee, arrivalAmount, nextNav);
                      }
                    }}
                    placeholder={navLoading
                      ? t("investForm.fetching")
                      : productType !== "metal" && fundCode.trim()
                        ? t("investForm.navUnavailable")
                        : "1.2345"}
                    className="form-input"
                  />
                </div>
                <button
                  type="button"
                  onClick={fetchNav}
                  disabled={navLoading || !fundCode || productType === "metal"}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-amber-200 bg-amber-50 text-amber-700 transition-colors hover:border-amber-300 hover:bg-amber-100 disabled:opacity-50"
                  title={productType === "metal" ? t("investForm.metalPriceManualTitle") : t("investForm.fetchNav")}
                >
                  <DatabaseZap className={`h-4 w-4 ${navLoading ? "animate-pulse" : ""}`} />
                </button>
                <div className={`grid grid-cols-1 gap-2 ${isBuyLike(subtype) && subtype === "buy" && !isDividend(subtype) && productType !== "metal" ? "sm:grid-cols-[1fr_1fr_1fr]" : ""}`}>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">
                      {isBuyLike(subtype) ? t("investForm.buyAmount") : t("txForm.amount")}
                      {subtype === "dividend_reinvest" ? (
                        <span className="ml-1 font-normal text-slate-400">{t("investForm.amountAutoHint")}</span>
                      ) : null}
                    </div>
                    <CalcInput
                      value={amount}
                      onChange={(v) => {
                        amountEditedRef.current = true;
                        setAmount(v);
                        calculateUnitsAfterAmountChange(v);
                      }}
                      label={t("txForm.amount")}
                      placeholder={subtype === "dividend_reinvest" ? t("investForm.amountAutoPlaceholder") : undefined}
                      precision={2}
                    />
                  </div>
                  {isBuyLike(subtype) && subtype === "buy" && !isDividend(subtype) && productType !== "metal" ? (
                    <div className="space-y-1">
                      <div className="flex min-h-4 items-center justify-between gap-2">
                        <div className="text-xs font-medium text-slate-600">{t("investForm.refundAmount")}</div>
                        <button
                          type="button"
                          onClick={() => toggleBuyRefund(buyResultStatus !== "refund")}
                          className={`h-4 rounded-full px-1.5 text-[10px] leading-none transition-colors ${buyResultStatus === "refund" ? "bg-amber-600 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}
                        >
                          {buyResultStatus === "refund" ? t("investForm.refundOn") : t("investForm.refundOff")}
                        </button>
                      </div>
                      <CalcInput
                        value={arrivalAmount}
                        onChange={(v) => {
                          setArrivalAmount(v);
                          if (p(v) > 0 && buyResultStatus !== "refund") setBuyResultStatus("refund");
                          if (p(v) > 0 && !arrivalDate) {
                            const baseDate = applyDate || confirmDate;
                            setArrivalDate(baseDate && arrivalDays > 0 ? addFundTradingDays(baseDate, arrivalDays) : baseDate);
                          }
                          calculateUnitsAfterRefundChange(v);
                        }}
                        placeholder="0.00"
                        label={t("investForm.refundAmount")}
                        precision={2}
                      />
                    </div>
                  ) : null}
                  {isBuyLike(subtype) && subtype === "buy" && !isDividend(subtype) && productType !== "metal" ? (
                    <div className="space-y-1">
                      <div className="text-xs font-medium text-slate-600">{t("investForm.confirmedAmount")}</div>
                      <input
                        value={confirmedBuyAmount > 0 ? confirmedBuyAmount.toFixed(2) : ""}
                        readOnly
                        placeholder="0.00"
                        className="form-input bg-slate-50 text-slate-500"
                      />
                    </div>
                  ) : null}
                </div>
              </div>

              {showFee && (
                <div className="grid grid-cols-1 gap-2 items-end sm:grid-cols-3">
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("investForm.feeRatePercent")}</div>
                    <input inputMode="decimal" value={feeRate}
                      onChange={(e) => {
                        const nextRate = e.target.value;
                        setFeeRate(nextRate);
                        setFeeRateEdited(true);
                        calculateFeeFromRate(nextRate);
                      }}
                      placeholder="0"
                      className="form-input" />
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-medium text-slate-600">{t("investForm.feeAmount")}</div>
                    <input inputMode="decimal" value={fee}
                      onChange={(e) => {
                        suppressFeeAutoCalcRef.current = false;
                        setFee(e.target.value);
                        setFeeEdited(true);
                        calculateUnitsAfterFeeChange(e.target.value);
                      }}
                      placeholder={computedFee || "0.00"}
                      className="form-input" />
                  </div>
                  <EntryTagsField value={selectedTagIds} onChange={setSelectedTagIds} />
                </div>
              )}

              <div className="grid grid-cols-1 gap-2 items-end sm:grid-cols-2">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("investForm.arrivalDate")}</div>
                  <DateStepper value={arrivalDate} onChange={onArrivalDateChange} min={applyDate} />
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("investForm.units")}</div>
                  <CalcInput value={units}
                    onChange={(v) => { unitsEditedRef.current = true; setUnits(v); }}
                    placeholder={computedUnits || "0.00"}
                    label={t("investForm.units")} precision={fundUnitsDecimals} />
                </div>
              </div>
                </>
              )}

              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("detail.column.remark")}</div>
                <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={t("stockFee.optional")} className="form-input" />
              </div>

              <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex justify-end gap-2 border-t border-slate-100 bg-white/95 px-4 py-3 backdrop-blur">
                {mode === "create" && (
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={(e) => {
                      e.preventDefault();
                      onSubmit(e as any, true);
                    }}
                    className="secondary-button h-9 px-4 text-blue-700 disabled:opacity-50"
                  >
                    {submitting ? t("stockFee.saving") : t("investForm.saveAndContinue")}
                  </button>
                )}
                <button
                  type="submit"
                  disabled={submitting}
                  className="primary-button h-9 disabled:opacity-50"
                >
                  {submitting ? t("stockFee.saving") : t("common.save")}
                </button>
              </div>
              </>
              )}
              </form>
          </div>
        </div>,
        document.body,
      ) : null}
      {nestedEntityType && typeof document !== "undefined" ? createPortal(
        <NestedAddModal
          mode="compact"
          entityType="account"
          open={true}
          onClose={() => setNestedEntityType(null)}
          onCreated={handleNestedAccountCreated}
          extraFields={nestedEntityType === "cash-account"
            ? undefined
            : { kind: "investment", investProductType: productType === "deposit" ? "fund" : productType }}
          hiddenFields={nestedEntityType === "cash-account" ? [] : ["kind"]}
          allowedAccountKinds={nestedEntityType === "cash-account" ? ["bank_debit", "ewallet"] : undefined}
          nestedFieldData={nestedFieldData}
          onNestedCreated={handleNestedOptionCreated}
        />,
        document.body,
      ) : null}
    </ModalLayerProvider>
  );
}
