"use client";

import { Check, ChevronDown, ChevronRight, HandCoins, Pencil, Percent, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AccountTypeQuickEdit, type AccountQuickEditValue, type LoanQuickEditValue } from "./AccountTypeQuickEdit";
import { AdvancedDataTable, type AdvancedDataTableColumn, type AdvancedDataTableSortState } from "./AdvancedDataTable";
import { DateStepper } from "./DateStepper";
import { dispatchEntryEdit, EntryRowActions } from "./EntryRowActions";
import { ResizableVerticalSplit } from "./ResizableVerticalSplit";
import {
  BasicDetailBatchDeleteButton,
  BasicDetailBatchDeleteMessage,
  BasicDetailBatchReplaceButton,
  BasicDetailSelectionProvider,
  useBasicDetailSelection,
  usePruneBasicDetailSelection,
  type BasicDetailBatchCategoryOption,
} from "./BasicDetailSelection";
import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import {
  buildMortgageLprRateAdjustments,
  calcMortgageLprSpreadFromDiscount,
  getLatestFiveYearLpr,
  MORTGAGE_BASE_BENCHMARK_RATE,
  MORTGAGE_LPR_CONVERSION_BASE_RATE,
} from "@/lib/loan-lpr";
import { calcLoanScheduledAmount, roundLoanMoney } from "@/lib/loan-repayment";
import { todayDateLocalYmd } from "@/lib/date-utils";
import { formatLoanRecalculateSuccessMessage } from "@/lib/loan-repayment-recalculate-result";
import { resolveLoanTypeValue, type LoanTypeValue } from "@/lib/loan-type";

type DebtRow = {
  key: string;
  name: string;
  objectType: string;
  objectName: string;
  itemName: string;
  accountId: string;
  institutionId: string;
  counterpartyId: string;
  itemType: string;
  repaymentMethod: string;
  repaymentCycle: string;
  baseAnnualRate: number | null;
  annualRate: number | null;
  mortgageLprDiscount: number | null;
  loanStartDate: string;
  remainingRuns: number | null;
  paidPrincipal: number;
  paidInterest: number;
  remainingPrincipal: number;
  remainingInterest: number;
  remainingTotal: number;
  nextRepaymentDate: string;
  nextRepaymentPrincipal: number | null;
  nextRepaymentInterest: number | null;
  nextRepaymentCashAccountId: string;
  loanRateAdjustments: Array<{ effectiveDate: string; annualRate: number }>;
  payable: number;
  receivable: number;
  net: number;
  accountCount: number;
  parentKey?: string | null;
  depth?: number;
  isGroup?: boolean;
  isLoan?: boolean;
  isConsumerLoan?: boolean | null;
  loanType?: LoanTypeValue | null;
};

type DebtEntry = {
  id: string;
  date: string;
  typeLabel: string;
  relatedAccountLabel: string;
  note: string;
  amount: number;
  principal: number;
  interest: number;
  paymentTotal: number | null;
  balance: number;
  balanceReconcileEdit?: {
    entryId: string;
    accountId: string;
    accountName: string;
    date: string;
    amount: number;
  };
  debtEdit?: {
    editEntryId: string;
    mode: "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";
    defaultDebtAccountId: string;
    defaultDebtAccountName?: string | null;
    defaultCashAccountId: string;
    defaultAutoDebitCashAccountId?: string;
    defaultFixedAssetAccountId?: string;
    defaultFixedAssetAssetId?: string;
    defaultDate: string;
    defaultPrincipal: number;
    defaultInterest: number;
    defaultNote?: string | null;
    defaultPenalty?: number;
    defaultRecalculateStartDate?: string | null;
    defaultPrepayStrategy?: string;
    defaultLoanFundingMode?: "cash_disbursement" | "financed_purchase";
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
    defaultTagIds?: string[] | null;
    dialogType?: "debt" | "loan";
  };
  edit?: {
    type: "expense" | "income" | "advance" | "transfer" | "investment";
    date: string;
    amount: number;
    note: string;
    accountId?: string;
    categoryId?: string;
    counterpartyInstitutionId?: string;
    fromAccountId?: string;
    toAccountId?: string;
  };
};

type RepaymentScheduleRow = {
  rowType: "payment" | "rate_adjustment";
  status?: "paid" | "planned";
  eventType?: "repayment" | "prepayment" | "rate_adjustment";
  period: number;
  date: string;
  payment: number;
  principal: number;
  interest: number;
  remainingPrincipal: number;
  annualRate: number | null;
};

type RateAdjustmentDraft = {
  id: string;
  effectiveDate: string;
  annualRate: string;
  originalEffectiveDate?: string | null;
  originalAnnualRate?: number | null;
  isEditing?: boolean;
  isInitial?: boolean;
};

type LoanRebuildPreview = {
  startRunDate: string;
  lastRemainingDate: string | null;
  updateCount: number;
  extrasCount: number;
  preservedAmount: number | null;
  lastRemainingPayment?: number | null;
  effectiveAnnualRate: number | null;
  balanceStart: number;
  remainingRuns: number | null;
  totalRuns: number | null;
  recalcAtStart: boolean;
  prepaymentInStartPeriod: boolean;
  repaymentMethod: string | null;
  intervalMonths: number | null;
  previewPayment: number;
  previewPrincipal: number;
  previewInterest: number;
};

type AccountOption = { id: string; label: string; title?: string | null; hoverTitle?: string | null };

const EMPTY_ACCOUNT_EDIT_DATA: AccountQuickEditValue[] = [];

function accountLoanType(account: Pick<AccountQuickEditValue, "loanType" | "isConsumerLoan"> | null | undefined): LoanTypeValue {
  return resolveLoanTypeValue(account?.loanType, account?.isConsumerLoan);
}

function amountClass(value: number, isRedUp: boolean) {
  return pnlClassFromRedUp(value, isRedUp, "strongMuted");
}

function formatRate(value: number | null, language: string) {
  if (value == null || !Number.isFinite(value)) return "-";
  return value.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

// 由执行利率反推折扣：LPR 时代 = (利率 − LPR + 4.8) / 4.9；早期基准利率时代 = 利率 / 4.9
function inferRowLprDiscount(effectiveDate: string, annualRate: number): number | null {
  const rate = Number(annualRate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const lpr = getLatestFiveYearLpr(effectiveDate);
  const discount = lpr
    ? (rate - lpr.fiveYearRate + MORTGAGE_LPR_CONVERSION_BASE_RATE) / MORTGAGE_BASE_BENCHMARK_RATE
    : rate / MORTGAGE_BASE_BENCHMARK_RATE;
  return Number.isFinite(discount) && discount > 0 && discount <= 2
    ? Math.round(discount * 10000) / 10000
    : null;
}

function formatDiscountValue(discount: number) {
  return discount.toFixed(4).replace(/\.?0+$/, "");
}

const SETTLED_DEBT_EPSILON = 0.005;

function isSettledDebtRow(row: DebtRow) {
  return Math.abs(row.net) < SETTLED_DEBT_EPSILON && row.payable + row.receivable < SETTLED_DEBT_EPSILON;
}

function shouldShowUnpaidScheduleRow(row: RepaymentScheduleRow, todayKey: string) {
  if (row.status === "paid") return false;
  if (row.date < todayKey) return false;
  return true;
}

function makeDraftId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatRateDraftValue(value: number) {
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function rateDraftAnnualRateNumber(value: string) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const rate = Number(text);
  return Number.isFinite(rate) ? rate : null;
}

function makeRateDraft(
  effectiveDate: string,
  annualRate: number,
  options: Pick<RateAdjustmentDraft, "isEditing" | "isInitial"> = {},
): RateAdjustmentDraft {
  return {
    id: makeDraftId(),
    effectiveDate,
    annualRate: formatRateDraftValue(annualRate),
    originalEffectiveDate: effectiveDate,
    originalAnnualRate: annualRate,
    ...options,
  };
}

function buildSimpleLoanRateDrafts(row: DebtRow, todayKey: string) {
  const loanDate = row.loanStartDate || row.loanRateAdjustments[0]?.effectiveDate || todayKey;
  const byDate = new Map(
    row.loanRateAdjustments
      .map((item) => ({
        effectiveDate: String(item.effectiveDate ?? "").slice(0, 10),
        annualRate: Number(item.annualRate),
      }))
      .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate) && Number.isFinite(item.annualRate) && item.annualRate >= 0)
      .map((item) => [item.effectiveDate, item] as const),
  );
  const initialRate = byDate.get(loanDate)?.annualRate ?? row.baseAnnualRate ?? row.annualRate ?? 0;
  const drafts = [makeRateDraft(loanDate, initialRate, { isInitial: true })];
  const seenDates = new Set([loanDate]);
  const laterRows = Array.from(byDate.values())
    .filter((item) => !seenDates.has(item.effectiveDate))
    .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  for (const item of laterRows) {
    seenDates.add(item.effectiveDate);
    drafts.push(makeRateDraft(item.effectiveDate, item.annualRate));
  }
  return drafts;
}

function getSimpleLoanRateChangedStartDate(originalDrafts: RateAdjustmentDraft[], currentDrafts: RateAdjustmentDraft[]) {
  const normalize = (items: RateAdjustmentDraft[]) => items
    .map((item) => ({
      effectiveDate: item.effectiveDate.trim(),
      annualRate: rateDraftAnnualRateNumber(item.annualRate),
    }))
    .filter((item): item is { effectiveDate: string; annualRate: number } => (
      /^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate) && item.annualRate != null
    ));
  const originalByDate = new Map(normalize(originalDrafts).map((item) => [item.effectiveDate, item.annualRate] as const));
  const currentByDate = new Map(normalize(currentDrafts).map((item) => [item.effectiveDate, item.annualRate] as const));
  const changedDates: string[] = [];

  for (const [date, originalRate] of originalByDate) {
    const currentRate = currentByDate.get(date);
    if (currentRate == null || Math.abs(currentRate - originalRate) >= 0.0005) changedDates.push(date);
  }
  for (const date of currentByDate.keys()) {
    if (!originalByDate.has(date)) changedDates.push(date);
  }

  return changedDates.sort((a, b) => a.localeCompare(b))[0] ?? null;
}

function hasActiveDebtFilters(filters: Partial<Record<string, string[]>>) {
  return Object.values(filters).some((values) => (values?.length ?? 0) > 0);
}

function debtRowMatchesFilters(
  row: DebtRow,
  filters: Partial<Record<string, string[]>>,
  columns: AdvancedDataTableColumn<DebtRow>[],
) {
  for (const [key, values] of Object.entries(filters)) {
    if ((values?.length ?? 0) === 0) continue;
    const column = columns.find((item) => item.key === key);
    if (!column?.filterText) continue;
    const value = column.filterText(row)?.trim() || "-";
    if (!values?.includes(value)) return false;
  }
  return true;
}

function compareDebtSortValues(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
) {
  const leftEmpty = left == null || left === "";
  const rightEmpty = right == null || right === "";
  if (leftEmpty || rightEmpty) {
    if (leftEmpty && rightEmpty) return 0;
    return leftEmpty ? 1 : -1;
  }
  return typeof left === "number" && typeof right === "number"
    ? left - right
    : String(left).localeCompare(String(right), "zh-CN", { numeric: true });
}

function collectDebtChildrenByParentKey(rows: DebtRow[]) {
  const childrenByParentKey = new Map<string, DebtRow[]>();
  for (const row of rows) {
    if (!row.parentKey) continue;
    const children = childrenByParentKey.get(row.parentKey) ?? [];
    children.push(row);
    childrenByParentKey.set(row.parentKey, children);
  }
  return childrenByParentKey;
}

function buildDebtTreeRows(
  rows: DebtRow[],
  filters: Partial<Record<string, string[]>>,
  columns: AdvancedDataTableColumn<DebtRow>[],
  expandedKeys: ReadonlySet<string>,
) {
  const filtersActive = hasActiveDebtFilters(filters);
  const childrenByParentKey = collectDebtChildrenByParentKey(rows);
  const output: DebtRow[] = [];

  for (const row of rows) {
    if (row.parentKey) continue;
    const children = childrenByParentKey.get(row.key) ?? [];
    if (!row.isGroup) {
      if (!filtersActive || debtRowMatchesFilters(row, filters, columns)) output.push(row);
      continue;
    }

    if (!filtersActive) {
      output.push(row);
      if (expandedKeys.has(row.key)) output.push(...children);
      continue;
    }

    const rowMatches = debtRowMatchesFilters(row, filters, columns);
    const matchingChildren = children.filter((child) => debtRowMatchesFilters(child, filters, columns));
    if (!rowMatches && matchingChildren.length === 0) continue;
    output.push(row);
    output.push(...(rowMatches ? children : matchingChildren));
  }

  return output;
}

function sortDebtTreeRows(
  rows: DebtRow[],
  sortState: AdvancedDataTableSortState | null,
  columns: AdvancedDataTableColumn<DebtRow>[],
) {
  if (!sortState) return rows;
  const column = columns.find((item) => item.key === sortState.key);
  const readValue = column?.sortValue ?? column?.filterText;
  if (!readValue) return rows;

  const direction = sortState.direction === "asc" ? 1 : -1;
  const originalIndexByKey = new Map(rows.map((row, index) => [row.key, index]));
  const compareRows = (left: DebtRow, right: DebtRow) => {
    const compared = compareDebtSortValues(readValue(left), readValue(right));
    if (compared !== 0) return compared * direction;
    return (originalIndexByKey.get(left.key) ?? 0) - (originalIndexByKey.get(right.key) ?? 0);
  };
  const childrenByParentKey = collectDebtChildrenByParentKey(rows);
  const sortedRows: DebtRow[] = [];
  const topRows = rows.filter((row) => !row.parentKey).sort(compareRows);
  for (const row of topRows) {
    sortedRows.push(row);
    const children = childrenByParentKey.get(row.key);
    if (children?.length) sortedRows.push(...[...children].sort(compareRows));
  }
  return sortedRows;
}

export function DebtShell({
  rows,
  selectedKey,
  entries,
  repaymentScheduleRows,
  summaryRemainingTotal,
  isRedUp,
  accountOptions,
  categoryOptions,
  accountEditData = EMPTY_ACCOUNT_EDIT_DATA,
  selectedLoanType = null,
  loanEditAction,
}: {
  rows: DebtRow[];
  selectedKey: string;
  entries: DebtEntry[];
  repaymentScheduleRows: RepaymentScheduleRow[];
  summaryRemainingTotal: number;
  totalPayable: number;
  totalReceivable: number;
  isRedUp: boolean;
  accountOptions: AccountOption[];
  categoryOptions: BasicDetailBatchCategoryOption[];
  accountEditData?: AccountQuickEditValue[];
  selectedLoanType?: LoanTypeValue | null;
  loanEditAction: (formData: FormData) => Promise<
    | { ok: true; warning?: string; recalculateAfterSave?: { accountId: string; startDate: string } | null }
    | { ok: false; error: string }
  >;
}) {
  const router = useRouter();
  const { t, language } = useI18n();
  const todayKey = todayDateLocalYmd();
  const [detailTab, setDetailTab] = useState<"entries" | "schedule">("entries");
  const [showPaidScheduleRows, setShowPaidScheduleRows] = useState(false);
  const [rateCardOpen, setRateCardOpen] = useState(false);
  const [rateSaving, setRateSaving] = useState(false);
  const [rateDrafts, setRateDrafts] = useState<RateAdjustmentDraft[]>([]);
  const [rebuildDialog, setRebuildDialog] = useState<{ effectiveDate: string; preview: LoanRebuildPreview } | null>(null);
  const [rebuildRemainingRuns, setRebuildRemainingRuns] = useState("");
  const [rebuildBusy, setRebuildBusy] = useState(false);
  const [showSettledRows, setShowSettledRows] = useState(() => {
    const selected = rows.find((row) => row.key === selectedKey);
    return selected ? isSettledDebtRow(selected) : false;
  });
  const [expandedDebtRowKeys, setExpandedDebtRowKeys] = useState<Set<string>>(() => new Set());
  const [editingDebtAccount, setEditingDebtAccount] = useState<AccountQuickEditValue | null>(null);
  const [editingLoanDetails, setEditingLoanDetails] = useState<LoanQuickEditValue | null>(null);
  const [accountEditOpenSignal, setAccountEditOpenSignal] = useState(0);
  const [pendingLoanEditAccountId, setPendingLoanEditAccountId] = useState<string | null>(null);
  const rowClickTimerRef = useRef<number | null>(null);
  const baseRows = useMemo(
    () => showSettledRows ? rows : rows.filter((row) => !isSettledDebtRow(row)),
    [rows, showSettledRows],
  );
  const childrenByParentKey = useMemo(() => collectDebtChildrenByParentKey(baseRows), [baseRows]);
  const safeAccountEditData = Array.isArray(accountEditData) ? accountEditData : EMPTY_ACCOUNT_EDIT_DATA;
  const accountEditDataById = useMemo(
    () => new Map(safeAccountEditData.map((account) => [account.id, account])),
    [safeAccountEditData],
  );
  // Loan-only views switch table wording to loan-specific columns and hide item names.
  const displayedNonGroupRows = useMemo(() => baseRows.filter((row) => !row.isGroup), [baseRows]);
  const isLoanTableView = useMemo(
    () => !!selectedLoanType || (displayedNonGroupRows.length > 0 && displayedNonGroupRows.every((row) => row.isLoan === true)),
    [displayedNonGroupRows, selectedLoanType],
  );
  const loanViewType = useMemo<LoanTypeValue | null>(() => {
    if (selectedLoanType) return selectedLoanType;
    if (!isLoanTableView || displayedNonGroupRows.length === 0) return null;
    const firstLoanRow = displayedNonGroupRows[0];
    if (firstLoanRow.loanType) return firstLoanRow.loanType;
    const account = accountEditDataById.get(firstLoanRow.accountId);
    return accountLoanType(account);
  }, [accountEditDataById, displayedNonGroupRows, isLoanTableView, selectedLoanType]);
  const loanViewTypeLabel = loanViewType
    ? t(`loan.type.${loanViewType}`)
    : "";
  const selectedRow =
    baseRows.find((row) => row.key === selectedKey) ??
    rows.find((row) => row.key === selectedKey) ??
    null;
  const remainingTotalLabel = selectedLoanType || selectedRow?.objectType === "银行贷款"
    ? t("debtShell.remainingTotal.payable")
    : selectedRow?.objectType === "银行应收"
      ? t("debtShell.remainingTotal.receivable")
      : t("debtShell.remainingTotal.both");
  const settledCount = rows.filter((row) => !row.parentKey && isSettledDebtRow(row)).length;
  const isSelectedBankLoan = !!selectedRow && !selectedRow.isGroup && selectedRow.isLoan === true;
  const canRepaySelectedRow = !!selectedRow && !selectedRow.isGroup && selectedRow.net < -SETTLED_DEBT_EPSILON;
  const selectedRowLoanType = selectedRow?.loanType ?? null;
  const isSelectedConsumerLoan = selectedRowLoanType === "consumer" || selectedRow?.isConsumerLoan === true;
  const isSelectedMortgageLoan = isSelectedBankLoan && !isSelectedConsumerLoan && (
    selectedRowLoanType == null || selectedRowLoanType === "home"
  );
  const canAdjustRateSelectedRow = isSelectedBankLoan && canRepaySelectedRow && !!selectedRow?.accountId && (
    isSelectedMortgageLoan || isSelectedConsumerLoan
  );
  const filterDebtRows = useCallback((
    tableRows: DebtRow[],
    filters: Partial<Record<string, string[]>>,
    columns: AdvancedDataTableColumn<DebtRow>[],
  ) => buildDebtTreeRows(tableRows, filters, columns, expandedDebtRowKeys), [expandedDebtRowKeys]);
  const sortDebtRows = useCallback((
    tableRows: DebtRow[],
    sortState: AdvancedDataTableSortState | null,
    columns: AdvancedDataTableColumn<DebtRow>[],
  ) => sortDebtTreeRows(tableRows, sortState, columns), []);
  const toggleDebtRowExpanded = useCallback((rowKey: string) => {
    setExpandedDebtRowKeys((current) => {
      const next = new Set(current);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  }, []);
  const visibleRepaymentScheduleRows = useMemo(
    () => showPaidScheduleRows
      ? repaymentScheduleRows
      : repaymentScheduleRows.filter((row) => shouldShowUnpaidScheduleRow(row, todayKey)),
    [repaymentScheduleRows, showPaidScheduleRows, todayKey],
  );
  const debtRowSummary = useMemo(() => {
    const summaryRows = baseRows.filter((row) => !row.parentKey);
    const net = summaryRows.reduce((sum, row) => sum + row.net, 0);
    return {
      paidPrincipal: summaryRows.reduce((sum, row) => sum + Math.abs(row.paidPrincipal), 0),
      paidInterest: summaryRows.reduce((sum, row) => sum + Math.abs(row.paidInterest), 0),
      remainingPrincipal: Math.abs(net),
      remainingInterest: summaryRows.reduce((sum, row) => sum + Math.abs(row.remainingInterest), 0),
      remainingTotal: Math.abs(summaryRemainingTotal),
      net,
    };
  }, [baseRows, summaryRemainingTotal]);
  useEffect(() => {
    return () => {
      if (rowClickTimerRef.current) {
        window.clearTimeout(rowClickTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const selected = rows.find((row) => row.key === selectedKey);
    if (selected && isSettledDebtRow(selected)) {
      setShowSettledRows(true);
    }
  }, [rows, selectedKey]);

  useEffect(() => {
    const selected = rows.find((row) => row.key === selectedKey);
    if (!selected?.parentKey) return;
    setExpandedDebtRowKeys((current) => {
      if (current.has(selected.parentKey ?? "")) return current;
      const next = new Set(current);
      next.add(selected.parentKey ?? "");
      return next;
    });
  }, [rows, selectedKey]);

  useEffect(() => {
    if (!isSelectedBankLoan && detailTab === "schedule") {
      setDetailTab("entries");
    }
  }, [detailTab, isSelectedBankLoan]);

  const loanSetupEditForAccount = useCallback((accountId: string): LoanQuickEditValue | null => {
    const entry = entries
      .filter((item) => (
        item.debtEdit?.dialogType === "loan" &&
        item.debtEdit.mode === "borrow_in" &&
        item.debtEdit.defaultDebtAccountId === accountId
      ))
      .sort((left, right) => left.date.localeCompare(right.date))[0];
    if (!entry?.debtEdit) return null;
    const account = accountEditDataById.get(accountId);
    return {
      ...entry.debtEdit,
      mode: "borrow_in",
      dialogType: "loan",
      loanType: accountLoanType(account),
    };
  }, [accountEditDataById, entries]);

  useEffect(() => {
    if (!pendingLoanEditAccountId) return;
    const detail = loanSetupEditForAccount(pendingLoanEditAccountId);
    if (!detail) return;
    const account = accountEditDataById.get(pendingLoanEditAccountId);
    if (!account) return;
    setEditingDebtAccount(account);
    setEditingLoanDetails(detail);
    setAccountEditOpenSignal((value) => value + 1);
    setPendingLoanEditAccountId(null);
  }, [accountEditDataById, loanSetupEditForAccount, pendingLoanEditAccountId]);

  function openDebtRow(row: DebtRow) {
    if (rowClickTimerRef.current) {
      window.clearTimeout(rowClickTimerRef.current);
    }
    rowClickTimerRef.current = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      params.set("view", "debt");
      params.set("debtPerson", row.key);
      router.push(`/?${params.toString()}`, { scroll: false });
      rowClickTimerRef.current = null;
    }, 360);
  }

  const openDebtAccountProperties = useCallback((row: DebtRow) => {
    if (rowClickTimerRef.current) {
      window.clearTimeout(rowClickTimerRef.current);
      rowClickTimerRef.current = null;
    }
    if (row.isGroup) {
      toggleDebtRowExpanded(row.key);
      return;
    }
    if (row.isLoan && row.accountId) {
      const account = accountEditDataById.get(row.accountId);
      if (!account) return;
      const detail = loanSetupEditForAccount(row.accountId);
      if (detail) {
        setEditingDebtAccount(account);
        setEditingLoanDetails(detail);
        setAccountEditOpenSignal((value) => value + 1);
        return;
      }
      setPendingLoanEditAccountId(row.accountId);
      const params = new URLSearchParams(window.location.search);
      params.set("view", "debt");
      params.set("debtPerson", row.key);
      router.push(`/?${params.toString()}`, { scroll: false });
      return;
    }
    const account = row.accountId ? accountEditDataById.get(row.accountId) : null;
    if (!account) return;
    setEditingDebtAccount(account);
    setEditingLoanDetails(null);
    setAccountEditOpenSignal((value) => value + 1);
  }, [accountEditDataById, loanSetupEditForAccount, router, toggleDebtRowExpanded]);

  function openRateAdjustment(row: DebtRow) {
    if (!row.accountId) return;
    const rowLoanType = row.loanType ?? null;
    const isConsumerLoanRow = rowLoanType === "consumer" || row.isConsumerLoan === true;
    const isHomeLoanRow = row.isConsumerLoan !== true && (rowLoanType == null || rowLoanType === "home");
    if (!isHomeLoanRow && !isConsumerLoanRow) return;
    const canGenerateMortgageLpr = isHomeLoanRow;
    if (!canGenerateMortgageLpr) {
      setRateDrafts(buildSimpleLoanRateDrafts(row, todayKey));
      setRateCardOpen(true);
      return;
    }
    const generatedDrafts = canGenerateMortgageLpr && row.loanRateAdjustments.length === 0 && row.mortgageLprDiscount != null && row.mortgageLprDiscount > 0
      ? buildMortgageLprRateAdjustments({
          discount: row.mortgageLprDiscount,
          throughDate: todayKey,
          fromDate: row.loanStartDate || undefined,
        }).map((item) => ({
          id: makeDraftId(),
          effectiveDate: item.effectiveDate,
          annualRate: formatRateDraftValue(item.annualRate),
          originalEffectiveDate: item.effectiveDate,
          originalAnnualRate: item.annualRate,
          isEditing: false,
        }))
      : [];
    // Loaded/generated rows render read-only in the table; each row switches
    // to edit mode only via its own edit button.
    const drafts = row.loanRateAdjustments.length > 0
      ? row.loanRateAdjustments.map((item) => ({
          id: makeDraftId(),
          effectiveDate: item.effectiveDate,
          annualRate: formatRateDraftValue(item.annualRate),
          originalEffectiveDate: item.effectiveDate,
          originalAnnualRate: item.annualRate,
          isEditing: false,
        }))
      : generatedDrafts.length > 0
        ? generatedDrafts
      : [{
          id: makeDraftId(),
          effectiveDate: row.loanStartDate || todayKey,
          annualRate: formatRateDraftValue(row.baseAnnualRate ?? row.annualRate ?? 0),
          originalEffectiveDate: row.loanStartDate || todayKey,
          originalAnnualRate: row.baseAnnualRate ?? row.annualRate ?? 0,
          isEditing: false,
        }];
    setRateDrafts(drafts);
    setRateCardOpen(true);
  }

  function addRateDraft() {
    setRateDrafts((items) => [
      ...items,
      {
        id: makeDraftId(),
        effectiveDate: todayKey,
        annualRate: "",
        originalEffectiveDate: null,
        originalAnnualRate: null,
        isEditing: true,
      },
    ]);
  }

  // 查询最新 5 年期 LPR：比表格里最新一行更新才新增一行，执行利率按折扣推算
  // （LPR + 加点，加点 = 4.9×折扣 − 4.8；折扣优先取借款备注里的值，否则由最后一行反推）。
  async function queryLatestLpr() {
    if (rateSaving) return;
    setRateSaving(true);
    try {
      const response = await fetch("/api/v1/loan-lpr/latest", { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok || !data.data?.date || !Number.isFinite(Number(data.data.rate))) {
        window.alert(data?.error || t("debtShell.rateAdjust.lprQueryFailed"));
        return;
      }
      const quoteDate: string = data.data.date;
      const lprRate: number = Number(data.data.rate);
      const latestRowDate = rateDrafts.reduce((max, item) => (
        item.effectiveDate.trim() > max ? item.effectiveDate.trim() : max
      ), "");
      if (quoteDate <= latestRowDate) {
        window.alert(t("debtShell.rateAdjust.lprUpToDate", { date: quoteDate }));
        return;
      }
      const lastFilled = [...rateDrafts].reverse().find((item) => (
        /^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate.trim()) && rateDraftAnnualRateNumber(item.annualRate) != null
      ));
      const lastRowRate = lastFilled ? rateDraftAnnualRateNumber(lastFilled.annualRate) : null;
      const discount = selectedRow?.mortgageLprDiscount != null && selectedRow.mortgageLprDiscount > 0
        ? selectedRow.mortgageLprDiscount
        : (lastFilled && lastRowRate != null ? inferRowLprDiscount(lastFilled.effectiveDate, lastRowRate) : null);
      const annualRate = discount != null && discount > 0
        ? lprRate + calcMortgageLprSpreadFromDiscount(discount)
        : lprRate;
      setRateDrafts((prev) => [
        ...prev,
        {
          id: makeDraftId(),
          effectiveDate: quoteDate,
          annualRate: formatRateDraftValue(Math.round(annualRate * 1000) / 1000),
          originalEffectiveDate: null,
          originalAnnualRate: null,
          isEditing: false,
        },
      ]);
    } finally {
      setRateSaving(false);
    }
  }

  function updateRateDraft(id: string, patch: Partial<RateAdjustmentDraft>) {
    setRateDrafts((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function deleteRateDraft(id: string) {
    setRateDrafts((items) => items.filter((item) => item.id !== id));
  }

  function saveRateDraftRow(id: string) {
    const target = rateDrafts.find((item) => item.id === id);
    if (!target) return;
    const effectiveDate = target.effectiveDate.trim();
    const annualRate = rateDraftAnnualRateNumber(target.annualRate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || annualRate == null || annualRate < 0) {
      window.alert(t("debtShell.alert.rateDraftInvalid"));
      return;
    }
    const duplicate = rateDrafts.some((item) => (
      item.id !== id &&
      (item.effectiveDate.trim() || item.annualRate.trim()) &&
      item.effectiveDate.trim() === effectiveDate
    ));
    if (duplicate) {
      window.alert(t("debtShell.alert.rateDraftDuplicateDate", { date: effectiveDate }));
      return;
    }
    updateRateDraft(id, {
      effectiveDate,
      annualRate: formatRateDraftValue(annualRate),
      isEditing: false,
    });
  }

  async function recalculateRepaymentPlanFromDate(accountId: string, startDate: string) {
    const response = await fetch("/api/v1/loan-repayment/recalculate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, startDate }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      window.alert(data?.error || t("debtShell.error.recalculateFailed"));
      return;
    }
    window.alert(formatLoanRecalculateSuccessMessage(data.data));
    dispatchFinanceDataChanged({ reason: "loan-repayment-recalculate", accountIds: [accountId] });
  }

  async function openRebuildDialogForDate(effectiveDate: string) {
    const accountId = selectedRow?.accountId;
    if (!accountId || rebuildBusy || rateSaving) return;
    setRebuildBusy(true);
    try {
      const response = await fetch("/api/v1/loan-repayment/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          fromDate: effectiveDate,
          dryRun: true,
          ...(rebuildRemainingRuns.trim() ? { remainingRuns: Number.parseInt(rebuildRemainingRuns.trim(), 10) } : {}),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        window.alert(data?.error || t("debtShell.error.rebuildFailed"));
        return;
      }
      const preview = data.data as LoanRebuildPreview;
      setRebuildDialog({ effectiveDate, preview });
    } finally {
      setRebuildBusy(false);
    }
  }

  const rebuildPreviewRefreshRef = useRef<number | null>(null);
  function changeRebuildFromDate(nextDate: string) {
    if (!rebuildDialog) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate.trim())) return;
    setRebuildDialog((dialog) => dialog ? { ...dialog, effectiveDate: nextDate } : dialog);
    if (rebuildPreviewRefreshRef.current) window.clearTimeout(rebuildPreviewRefreshRef.current);
    const accountId = selectedRow?.accountId;
    if (!accountId) return;
    rebuildPreviewRefreshRef.current = window.setTimeout(() => {
      void (async () => {
        if (rebuildBusy) return;
        setRebuildBusy(true);
        try {
          const response = await fetch("/api/v1/loan-repayment/rebuild", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              accountId,
              fromDate: nextDate,
              dryRun: true,
              ...(rebuildRemainingRuns.trim() ? { remainingRuns: Number.parseInt(rebuildRemainingRuns.trim(), 10) } : {}),
            }),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok || !data?.ok) return;
          const preview = data.data as LoanRebuildPreview;
          setRebuildDialog((prev) => prev && prev.effectiveDate === nextDate ? { effectiveDate: nextDate, preview } : prev);
        } finally {
          setRebuildBusy(false);
        }
      })();
    }, 300);
  }

  async function confirmRebuild() {
    const dialog = rebuildDialog;
    const accountId = selectedRow?.accountId;
    if (!dialog || !accountId || rebuildBusy) return;
    const remainingRunsText = rebuildRemainingRuns.trim();
    let remainingRuns: number | null = null;
    if (remainingRunsText) {
      const parsed = Number.parseInt(remainingRunsText, 10);
      if (!Number.isFinite(parsed) || String(parsed) !== remainingRunsText || parsed < 1 || parsed > 600) {
        window.alert(t("debtShell.rebuild.invalidRemainingRuns"));
        return;
      }
      remainingRuns = parsed;
    }
    setRebuildBusy(true);
    try {
      const response = await fetch("/api/v1/loan-repayment/rebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          fromDate: dialog.effectiveDate,
          dryRun: false,
          ...(remainingRuns != null ? { remainingRuns } : {}),
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        window.alert(data?.error || t("debtShell.error.rebuildFailed"));
        return;
      }
      window.alert(t("debtShell.rebuild.successMessage", {
        date: data.data.startRunDate,
        count: data.data.updateCount,
        payment: formatMoney(data.data.previewPayment ?? 0),
      }));
      setRebuildDialog(null);
      dispatchFinanceDataChanged({ reason: "loan-repayment-rebuild", accountIds: [accountId] });
    } finally {
      setRebuildBusy(false);
    }
  }

  const rebuildPreviewParts = useMemo(() => {
    const dialog = rebuildDialog;
    if (!dialog) return null;
    const preview = dialog.preview;
    const runsText = rebuildRemainingRuns.trim();
    const runs = runsText ? Number.parseInt(runsText, 10) : Number.NaN;
    if (
      preview.recalcAtStart &&
      !preview.prepaymentInStartPeriod &&
      Number.isFinite(runs) &&
      runs >= 1 &&
      preview.effectiveAnnualRate != null
    ) {
      const payment = calcLoanScheduledAmount({
        repaymentMethod: preview.repaymentMethod,
        annualRate: preview.effectiveAnnualRate,
        principal: preview.balanceStart,
        totalRuns: runs,
        intervalMonths: preview.intervalMonths ?? 1,
      });
      if (payment != null && payment > 0) {
        const intervalMonths = preview.intervalMonths ?? 1;
        const interest = roundLoanMoney((preview.balanceStart * (preview.effectiveAnnualRate / 100) / 12) * intervalMonths);
        return { payment, principal: Math.max(0, roundLoanMoney(payment - interest)), interest };
      }
    }
    return {
      payment: preview.previewPayment,
      principal: preview.previewPrincipal,
      interest: preview.previewInterest,
    };
  }, [rebuildDialog, rebuildRemainingRuns]);

  async function saveRateAdjustments() {
    if (!selectedRow?.accountId || rateSaving) return;
    const filledRateDrafts = rateDrafts
      .filter((item) => item.effectiveDate.trim() || item.annualRate.trim());
    const adjustments = filledRateDrafts
      .map((item) => ({
        effectiveDate: item.effectiveDate.trim(),
        annualRate: item.annualRate.trim() ? Number(item.annualRate) : Number.NaN,
      }));
    const duplicateDates = new Set<string>();
    for (const item of adjustments) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate) || !Number.isFinite(item.annualRate) || item.annualRate < 0) {
        window.alert(t("debtShell.alert.rateDraftInvalid"));
        return;
      }
      if (duplicateDates.has(item.effectiveDate)) {
        window.alert(t("debtShell.alert.rateDraftDuplicateDate", { date: item.effectiveDate }));
        return;
      }
      duplicateDates.add(item.effectiveDate);
    }
    const changedStartDate = !isSelectedMortgageLoan
      ? getSimpleLoanRateChangedStartDate(buildSimpleLoanRateDrafts(selectedRow, todayKey), filledRateDrafts)
      : null;

    setRateSaving(true);
    try {
      const response = await fetch("/api/v1/loan-rate-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: selectedRow.accountId,
          adjustments,
          mortgageLprDiscount: isSelectedMortgageLoan && selectedRow?.mortgageLprDiscount != null
            ? selectedRow.mortgageLprDiscount
            : null,
          loanStartDate: selectedRow.loanStartDate || null,
        }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        window.alert(data?.error || t("debtShell.error.saveRateAdjustmentsFailed"));
        return;
      }
      setRateCardOpen(false);
      dispatchFinanceDataChanged({ reason: "loan-rate-adjustment", accountIds: [selectedRow.accountId] });
      if (changedStartDate) {
        const accepted = await showConfirmDialog({
          title: t("debtShell.rateAdjust.recalculateTitle"),
          message: t("debtShell.rateAdjust.recalculateMessage", { date: changedStartDate }),
          confirmLabel: t("debtShell.recalc.confirm"),
          cancelLabel: t("debtShell.recalc.skip"),
        });
        if (accepted) {
          await recalculateRepaymentPlanFromDate(selectedRow.accountId, changedStartDate);
        }
      }
    } finally {
      setRateSaving(false);
    }
  }

  const rowColumns = useMemo<AdvancedDataTableColumn<DebtRow>[]>(() => [
    {
      key: "objectType",
      label: isLoanTableView ? t("debtShell.colName") : t("debtShell.colObjectType"),
      width: isLoanTableView ? 180 : 112,
      minWidth: isLoanTableView ? 120 : 84,
      filterText: (row) => (isLoanTableView ? row.name : row.objectType),
      sortValue: (row) => (isLoanTableView ? row.name : row.objectType),
      render: (row) => (
        <span className={`block truncate ${amountClass(row.net, isRedUp)}`} title={isLoanTableView ? row.name : row.objectType}>
          {isLoanTableView ? row.name : row.objectType}
        </span>
      ),
    },
    {
      key: "objectName",
      label: isLoanTableView ? t("debtShell.colLoanInstitution") : t("debtShell.colObject"),
      width: 180,
      minWidth: 120,
      filterText: (row) => row.objectName,
      sortValue: (row) => row.objectName,
      render: (row) => {
        const childCount = row.isGroup ? childrenByParentKey.get(row.key)?.length ?? 0 : 0;
        const expanded = expandedDebtRowKeys.has(row.key);
        return (
          <span
            className={`flex min-w-0 items-center truncate text-sm ${row.isGroup ? "font-semibold text-slate-900" : "font-medium text-slate-800"}`}
            style={{ paddingLeft: `${Math.max(0, row.depth ?? 0) * 18}px` }}
            title={row.objectName || row.name}
          >
            {childCount > 0 ? (
              <button
                type="button"
                className="mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                title={t(expanded ? "common.collapse" : "common.expand")}
                aria-label={t(expanded ? "common.collapse" : "common.expand")}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleDebtRowExpanded(row.key);
                }}
              >
                {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            ) : row.depth ? (
              <span className="mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center text-slate-300">└</span>
            ) : (
              <span className="mr-1 h-5 w-5 shrink-0" />
            )}
            <span className="truncate">{row.objectName || "-"}</span>
          </span>
        );
      },
    },
    ...(isLoanTableView
      ? []
      : [{
          key: "itemName",
          label: t("debtShell.colItem"),
          width: 190,
          minWidth: 120,
          filterText: (row) => row.itemName,
          sortValue: (row) => row.itemName,
          render: (row) => (
            <span className={`block truncate ${row.isGroup ? "font-medium text-slate-800" : "text-slate-700"}`} title={row.name}>
              {row.itemName || "-"}
            </span>
          ),
        }]),
    {
      key: "itemType",
      label: t("debtShell.colItemType"),
      width: 150,
      minWidth: 110,
      filterText: (row) => row.itemType,
      sortValue: (row) => row.itemType,
      render: (row) => <span className={amountClass(row.net, isRedUp)}>{row.itemType}</span>,
    },
    {
      key: "repaymentMethod",
      label: t("debtShell.colRepaymentMethod"),
      width: 140,
      minWidth: 100,
      hideable: true,
      filterText: (row) => row.repaymentMethod || "-",
      sortValue: (row) => row.repaymentMethod || "",
      render: (row) => <span className="text-slate-600">{row.repaymentMethod || "-"}</span>,
    },
    {
      key: "annualRate",
      label: t("debtShell.colAnnualRate"),
      width: 110,
      minWidth: 80,
      align: "right",
      hideable: true,
      sortValue: (row) => row.annualRate,
      render: (row) => <span className="tabular-nums text-slate-600">{formatRate(row.annualRate, language)}</span>,
    },
    {
      key: "remainingRuns",
      label: t("debtShell.colRemainingRuns"),
      width: 110,
      minWidth: 80,
      align: "right",
      hideable: true,
      sortValue: (row) => row.remainingRuns,
      render: (row) => <span className="tabular-nums text-slate-600">{row.remainingRuns == null ? "-" : row.remainingRuns}</span>,
    },
    {
      key: "paidPrincipal",
      label: t("debtShell.colPaidPrincipal"),
      width: 130,
      minWidth: 96,
      align: "right",
      hideable: true,
      sortValue: (row) => Math.abs(row.paidPrincipal),
      render: (row) => <span className="tabular-nums text-emerald-700">{formatMoney(Math.abs(row.paidPrincipal))}</span>,
    },
    {
      key: "paidInterest",
      label: t("debtShell.colPaidInterest"),
      width: 130,
      minWidth: 96,
      align: "right",
      hideable: true,
      sortValue: (row) => Math.abs(row.paidInterest),
      render: (row) => <span className="tabular-nums text-amber-700">{formatMoney(Math.abs(row.paidInterest))}</span>,
    },
    {
      key: "remainingInterest",
      label: t("debtShell.colRemainingInterest"),
      width: 130,
      minWidth: 96,
      align: "right",
      hideable: true,
      sortValue: (row) => Math.abs(row.remainingInterest),
      render: (row) => <span className="tabular-nums text-amber-700">{formatMoney(Math.abs(row.remainingInterest))}</span>,
    },
    {
      key: "remainingPrincipal",
      label: t("debtShell.colRemainingPrincipal"),
      width: 130,
      minWidth: 96,
      align: "right",
      hideable: true,
      sortValue: (row) => Math.abs(row.remainingPrincipal),
      render: (row) => <span className="tabular-nums text-slate-700">{formatMoney(Math.abs(row.remainingPrincipal))}</span>,
    },
    {
      key: "remainingTotal",
      label: remainingTotalLabel,
      width: 150,
      minWidth: 112,
      align: "right",
      sortValue: (row) => Math.abs(row.remainingTotal),
      render: (row) => <span className={`font-semibold tabular-nums ${amountClass(row.net, isRedUp)}`}>{formatMoney(Math.abs(row.remainingTotal))}</span>,
    },
    {
      key: "actions",
      label: t("detail.column.actions"),
      width: 64,
      minWidth: 56,
      align: "center",
      render: (row) => (
        <div className="flex items-center justify-center gap-1">
          {row.accountId ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                openDebtAccountProperties(row);
              }}
              title={t("debtShell.editRow")}
              aria-label={t("debtShell.editRow")}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50 hover:text-blue-600"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ),
    },
  ], [t, language, isRedUp, remainingTotalLabel, childrenByParentKey, expandedDebtRowKeys, toggleDebtRowExpanded, isLoanTableView, loanViewTypeLabel, openDebtAccountProperties]);

  const entryColumns = useMemo<AdvancedDataTableColumn<DebtEntry>[]>(() => [
    { key: "date", label: t("detail.column.date"), width: 100, minWidth: 80, filterText: (entry) => entry.date, render: (entry) => <span className="tabular-nums text-slate-700">{entry.date}</span> },
    { key: "type", label: t("debtShell.colType"), width: 90, minWidth: 70, filterText: (entry) => entry.typeLabel, render: (entry) => <span className="text-slate-700">{entry.typeLabel}</span> },
    { key: "relatedAccount", label: t("debtShell.colCashAccount"), width: 160, minWidth: 100, filterText: (entry) => entry.relatedAccountLabel, render: (entry) => <span className="block truncate text-slate-600" title={entry.relatedAccountLabel}>{entry.relatedAccountLabel || "-"}</span> },
    {
      key: "outflow",
      label: t("detail.column.outflow"),
      width: 110,
      minWidth: 86,
      align: "right",
      render: (entry) => (
        <span className="font-semibold tabular-nums text-rose-700">
          {entry.principal < 0 ? formatMoney(Math.abs(entry.principal)) : "-"}
        </span>
      ),
    },
    {
      key: "inflow",
      label: t("detail.column.inflow"),
      width: 110,
      minWidth: 86,
      align: "right",
      render: (entry) => (
        <span className="font-semibold tabular-nums text-emerald-700">
          {entry.principal > 0 ? formatMoney(entry.principal) : "-"}
        </span>
      ),
    },
    {
      key: "interest",
      label: t("debtShell.colInterest"),
      width: 110,
      minWidth: 80,
      align: "right",
      hideable: true,
      render: (entry) => <span className="tabular-nums text-amber-700">{entry.interest ? formatMoney(entry.interest) : "-"}</span>,
    },
    {
      key: "paymentTotal",
      label: isSelectedBankLoan ? t("debtShell.colPaymentTotalLoan") : t("debtShell.colPaymentTotalInflow"),
      width: 120,
      minWidth: 92,
      align: "right",
      hideable: true,
      filterText: (entry) => entry.paymentTotal == null ? "-" : entry.paymentTotal.toFixed(2),
      render: (entry) => (
        <span className="font-semibold tabular-nums text-slate-700">
          {entry.paymentTotal == null ? "-" : formatMoney(entry.paymentTotal)}
        </span>
      ),
    },
    { key: "balance", label: t("debtShell.colBalance"), width: 130, minWidth: 92, align: "right", render: (entry) => <span className={`font-semibold tabular-nums ${amountClass(entry.balance, isRedUp)}`}>{formatMoney(entry.balance)}</span> },
    { key: "note", label: t("detail.column.remark"), width: 260, minWidth: 120, hideable: true, filterText: (entry) => entry.note, render: (entry) => <span className="block truncate text-slate-600" title={entry.note}>{entry.note || "-"}</span> },
  ], [t, isRedUp, isSelectedBankLoan]);

  const repaymentScheduleColumns = useMemo<AdvancedDataTableColumn<RepaymentScheduleRow>[]>(() => [
    {
      key: "status",
      label: t("debtShell.colStatus"),
      width: 82,
      minWidth: 64,
      filterText: (row) => row.rowType === "rate_adjustment" ? t("debtShell.rateAdjustment") : row.status === "paid" ? t("debtShell.paid") : t("debtShell.planned"),
      render: (row) => row.rowType === "rate_adjustment"
        ? <span className="text-blue-700">{t("debtShell.rate")}</span>
        : row.status === "paid"
          ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">{t("debtShell.paid")}</span>
          : <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{t("debtShell.planned")}</span>,
    },
    {
      key: "eventType",
      label: t("debtShell.colType"),
      width: 100,
      minWidth: 78,
      filterText: (row) => row.rowType === "rate_adjustment" ? t("debtShell.rateAdjustment") : row.eventType === "prepayment" ? t("debtShell.prepayment") : t("debtShell.repayment"),
      render: (row) => row.rowType === "rate_adjustment"
        ? <span className="font-medium text-blue-700">{t("debtShell.rateAdjustment")}</span>
        : row.eventType === "prepayment"
          ? <span className="font-medium text-amber-700">{t("debtShell.prepayment")}</span>
          : <span className="text-slate-700">{t("debtShell.repayment")}</span>,
    },
    { key: "period", label: t("debtShell.colPeriod"), width: 80, minWidth: 64, align: "right", render: (row) => row.rowType === "rate_adjustment" || row.eventType === "prepayment" ? <span className="text-slate-400">-</span> : <span className="tabular-nums text-slate-700">{row.period}</span> },
    { key: "date", label: t("detail.column.date"), width: 110, minWidth: 86, filterText: (row) => row.date, render: (row) => <span className="tabular-nums text-slate-700">{row.date}</span> },
    { key: "principal", label: t("debtShell.colPrincipal"), width: 130, minWidth: 96, align: "right", render: (row) => row.rowType === "rate_adjustment" ? <span className="tabular-nums text-blue-700">{formatRate(row.annualRate, language)}</span> : <span className="tabular-nums text-emerald-700">{formatMoney(row.principal)}</span> },
    { key: "interest", label: t("debtShell.colInterest"), width: 130, minWidth: 96, align: "right", render: (row) => row.rowType === "rate_adjustment" ? <span className="text-slate-400">-</span> : <span className="tabular-nums text-amber-700">{formatMoney(row.interest)}</span> },
    { key: "payment", label: t("debtShell.colPayment"), width: 130, minWidth: 96, align: "right", render: (row) => row.rowType === "rate_adjustment" ? <span className="font-medium text-blue-700">{t("debtShell.rateAdjustment")}</span> : <span className="font-semibold tabular-nums text-slate-700">{formatMoney(row.payment)}</span> },
    { key: "remainingPrincipal", label: t("debtShell.colRemainingPrincipal"), width: 140, minWidth: 104, align: "right", render: (row) => <span className="font-semibold tabular-nums text-slate-700">{formatMoney(row.remainingPrincipal)}</span> },
  ], [t, language]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent p-4 md:p-5">
      {editingDebtAccount ? (
        <AccountTypeQuickEdit
          account={editingDebtAccount}
          accountLabel={editingDebtAccount.name}
          openSignal={accountEditOpenSignal}
          showTrigger={false}
          loanDetails={editingLoanDetails}
          loanEditAction={loanEditAction}
        />
      ) : null}
      <ResizableVerticalSplit
        storageKey="mmh:debt:split-height"
        hasLowerPane={!!selectedRow}
        defaultUpperHeight={360}
        separatorLabel={t("debtShell.resizeLabel")}
        separatorTitle={t("debtShell.resizeTitle")}
      >
        <section className="panel-surface flex h-full min-h-0 flex-col overflow-hidden">
          <AdvancedDataTable
            storageKey="mmh_debt_rows_table_v1"
            columns={rowColumns}
            rows={baseRows}
            rowKey={(row) => row.key}
            minTableWidth={1040}
            emptyText={t("debtShell.emptyRows")}
            fillHeight
            filterRows={filterDebtRows}
            sortRows={sortDebtRows}
            toolbarTitle={(
              <span className="inline-flex items-center gap-2 text-sm font-semibold text-slate-800">
                <HandCoins className="h-4 w-4 text-amber-500" />
                {isLoanTableView && loanViewTypeLabel ? loanViewTypeLabel : t("debtShell.title")}
              </span>
            )}
            toolbarRightContent={(
              <div className="flex items-center gap-3">
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-500">
                  <input
                    type="checkbox"
                    checked={showSettledRows}
                    onChange={(event) => setShowSettledRows(event.target.checked)}
                    className="h-3.5 w-3.5 accent-blue-600"
                  />
                  {t("debtShell.showSettledRows")}{settledCount > 0 ? `(${settledCount})` : ""}
                </label>
                <div className="text-xs text-slate-400">{t("debtShell.inflowOutflowHint")}</div>
              </div>
            )}
            onRowClick={(row) => openDebtRow(row)}
            onRowDoubleClick={(row) => openDebtAccountProperties(row)}
            rowClassName={(row) => {
              if (row.key === (selectedRow?.key ?? "")) return "cursor-pointer bg-blue-50 hover:bg-blue-50";
              if (row.parentKey) return "cursor-pointer bg-slate-50/70 hover:bg-slate-100";
              return "cursor-pointer hover:bg-slate-50";
            }}
            summaryRow={{
              rowClassName: "bg-slate-50",
              cellClassName: "py-2.5",
              cells: {
                name: <span className="font-semibold tracking-[0.08em] text-slate-500">{t("debtShell.summaryRow")}</span>,
                paidPrincipal: <span className="font-semibold tabular-nums text-emerald-700">{formatMoney(debtRowSummary.paidPrincipal)}</span>,
                paidInterest: <span className="font-semibold tabular-nums text-amber-700">{formatMoney(debtRowSummary.paidInterest)}</span>,
                remainingInterest: <span className="font-semibold tabular-nums text-amber-700">{formatMoney(debtRowSummary.remainingInterest)}</span>,
                remainingPrincipal: <span className="font-semibold tabular-nums text-slate-700">{formatMoney(debtRowSummary.remainingPrincipal)}</span>,
                remainingTotal: <span className="font-semibold tabular-nums text-slate-700">{formatMoney(debtRowSummary.remainingTotal)}</span>,
              },
            }}
          />
        </section>

        <section className="panel-surface flex h-full min-h-0 flex-1 flex-col overflow-hidden">
          {isSelectedBankLoan ? <div className="panel-header">
            {isSelectedBankLoan ? (
              <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-0.5">
                <button
                  type="button"
                  onClick={() => setDetailTab("entries")}
                  className={`h-7 rounded-full px-3 text-xs font-medium transition ${detailTab === "entries" ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-white"}`}
                >
                  {t("debtShell.tabEntries")}
                </button>
                <button
                  type="button"
                  onClick={() => setDetailTab("schedule")}
                  className={`h-7 rounded-full px-3 text-xs font-medium transition ${detailTab === "schedule" ? "bg-slate-900 text-white shadow-sm" : "text-slate-600 hover:bg-white"}`}
                >
                  {t("debtShell.tabSchedule")}
                </button>
              </div>
            ) : <div />}
            <div className="flex min-w-0 items-center gap-2">
              {isSelectedBankLoan ? (
                <>
                  <button
                    type="button"
                    disabled={!canAdjustRateSelectedRow}
                    onClick={() => selectedRow && openRateAdjustment(selectedRow)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 text-xs font-medium text-blue-700 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                    title={canAdjustRateSelectedRow ? t("debtShell.rateAdjust.title") : t("debtShell.rateAdjust.disabledTitle")}
                  >
                    <Percent className="h-3.5 w-3.5" />
                    {t("debtShell.rateAdjustment")}
                  </button>
                </>
              ) : null}
            </div>
          </div> : null}

          {!selectedRow ? (
            <div className="flex min-h-0 flex-1 items-center justify-center border-t border-slate-100 bg-slate-50/60 px-4 text-sm text-slate-500">
              {t("debtShell.selectRowFirst")}
            </div>
          ) : detailTab === "entries" || !isSelectedBankLoan ? (
            <BasicDetailSelectionProvider resetKey={`debt-entries:${selectedRow.key}`}>
              <BasicDetailBatchDeleteMessage />
              <DebtEntriesTable
                accountOptions={accountOptions}
                categoryOptions={categoryOptions}
                contextAccountId={selectedRow.accountId}
                columns={entryColumns}
                entries={entries}
                loanType={accountLoanType(accountEditDataById.get(selectedRow.accountId))}
              />
            </BasicDetailSelectionProvider>
          ) : (
            <AdvancedDataTable
              storageKey="mmh_debt_repayment_schedule_table_v1"
              columns={repaymentScheduleColumns}
              rows={visibleRepaymentScheduleRows}
              rowKey={(row) => `${row.status ?? ""}:${row.eventType ?? ""}:${row.rowType}:${row.period}:${row.date}:${row.annualRate ?? ""}`}
              minTableWidth={920}
              emptyText={t("debtShell.emptySchedule")}
              fillHeight
              toolbarMode="custom"
              toolbarLeftContent={(
                <span>
                  {showPaidScheduleRows
                    ? t("debtShell.scheduleVisibleCount", { visible: visibleRepaymentScheduleRows.length, total: repaymentScheduleRows.length })
                    : t("debtShell.scheduleUnpaidCount", { count: visibleRepaymentScheduleRows.length })}
                </span>
              )}
              toolbarRightContent={(
                <label className="flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600">
                  <input
                    type="checkbox"
                    checked={showPaidScheduleRows}
                    onChange={(event) => setShowPaidScheduleRows(event.target.checked)}
                    className="h-3.5 w-3.5 accent-blue-600"
                  />
                  {t("debtShell.showPaid")}
                </label>
              )}
              rowClassName={(row) => row.rowType === "rate_adjustment"
                ? "bg-blue-50 hover:bg-blue-50"
                : row.status === "paid"
                  ? "bg-emerald-50/40 hover:bg-emerald-50"
                  : ""}
            />
          )}
        </section>
      </ResizableVerticalSplit>

        {rateCardOpen ? (
          <div className="app-modal-backdrop z-50">
            <div className="app-modal-panel max-w-2xl">
              <div className="modal-header shrink-0">
                <div>
                  <div className="text-sm font-semibold text-slate-800">{t("debtShell.rateAdjustment")}</div>
                  <div className="mt-0.5 text-xs text-slate-500">{selectedRow?.name ?? t("debtShell.currentLoan")}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setRateCardOpen(false)}
                  className="secondary-button h-8 px-2"
                  disabled={rateSaving}
                >
                  {t("table.close")}
                </button>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
                  {t(isSelectedMortgageLoan ? "debtShell.rateAdjust.hint" : "debtShell.rateAdjust.simpleHint")}
                </div>

                {isSelectedMortgageLoan ? (
                  <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                    <div className="max-h-[260px] overflow-y-auto">
                      <table className="min-w-full table-fixed text-sm">
                        <thead className="sticky top-0 bg-slate-50 text-xs font-medium text-slate-500 shadow-[0_1px_0_0_#e2e8f0]">
                          <tr>
                            <th className="w-[28%] px-3 py-2 text-left">{t("debtShell.rateAdjust.effectiveDate")}</th>
                            <th className="w-[22%] px-3 py-2 text-right">{t("debtShell.rateAdjust.annualRateLabel")}</th>
                            <th className="w-[16%] px-3 py-2 text-right">{t("debtShell.rateAdjust.discountLabel")}</th>
                            <th className="w-[28%] px-3 py-2 text-right">{t("detail.column.actions")}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {rateDrafts.length === 0 ? (
                            <tr>
                              <td colSpan={4} className="px-3 py-8 text-center text-sm text-slate-500">
                                {t("debtShell.rateAdjust.empty")}
                              </td>
                            </tr>
                          ) : rateDrafts.map((item) => {
                            const draftRate = rateDraftAnnualRateNumber(item.annualRate);
                            const draftDiscount = draftRate != null ? inferRowLprDiscount(item.effectiveDate, draftRate) : null;
                            return (
                              <tr key={item.id} className={item.isEditing ? "bg-amber-50/50" : "bg-white"}>
                                <td className="px-3 py-2 align-middle">
                                  {item.isEditing ? (
                                    <DateStepper
                                      value={item.effectiveDate}
                                      onChange={(value) => updateRateDraft(item.id, { effectiveDate: value })}
                                    />
                                  ) : (
                                    <span className="tabular-nums text-slate-700">{item.effectiveDate}</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right align-middle">
                                  {item.isEditing ? (
                                    <input
                                      value={item.annualRate}
                                      onChange={(event) => updateRateDraft(item.id, { annualRate: event.target.value })}
                                      inputMode="decimal"
                                      placeholder={t("debtShell.rateAdjust.annualRatePlaceholder")}
                                      className="form-input text-right"
                                    />
                                  ) : (
                                    <span className="tabular-nums text-slate-700">{formatRate(draftRate, language)}</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right align-middle text-xs tabular-nums text-slate-600" title={t("debtShell.rateAdjust.discountTitle")}>
                                  {draftDiscount != null ? formatDiscountValue(draftDiscount) : "-"}
                                </td>
                                <td className="px-3 py-2 text-right align-middle">
                                  <div className="inline-flex items-center gap-1.5">
                                    {item.isEditing ? (
                                      <button
                                        type="button"
                                        onClick={() => saveRateDraftRow(item.id)}
                                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-emerald-600 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                                        disabled={rateSaving}
                                        title={t("common.save")}
                                        aria-label={t("common.save")}
                                      >
                                        <Check className="h-3.5 w-3.5" />
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => updateRateDraft(item.id, { isEditing: true })}
                                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                                        disabled={rateSaving}
                                        title={t("common.edit")}
                                        aria-label={t("common.edit")}
                                      >
                                        <Pencil className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => { void openRebuildDialogForDate(item.effectiveDate); }}
                                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-blue-700 transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
                                      disabled={rebuildBusy || rateSaving}
                                      title={t("debtShell.rebuild.buttonTitle")}
                                      aria-label={t("debtShell.recalc")}
                                    >
                                      <RefreshCw className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => deleteRateDraft(item.id)}
                                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-rose-600 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                                      disabled={rateSaving}
                                      title={t("common.delete")}
                                      aria-label={t("common.delete")}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                    <div className="max-h-[260px] overflow-y-auto">
                      <table className="min-w-full table-fixed text-sm">
                        <thead className="sticky top-0 bg-slate-50 text-xs font-medium text-slate-500 shadow-[0_1px_0_0_#e2e8f0]">
                          <tr>
                            <th className="w-[38%] px-3 py-2 text-left">{t("debtShell.rateAdjust.effectiveDate")}</th>
                            <th className="w-[32%] px-3 py-2 text-right">{t("debtShell.rateAdjust.annualRateLabel")}</th>
                            <th className="w-[30%] px-3 py-2 text-right">{t("detail.column.actions")}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {rateDrafts.length === 0 ? (
                            <tr>
                              <td colSpan={3} className="px-3 py-8 text-center text-sm text-slate-500">
                                {t("debtShell.rateAdjust.empty")}
                              </td>
                            </tr>
                          ) : rateDrafts.map((item) => {
                            const annualRate = rateDraftAnnualRateNumber(item.annualRate);
                            return (
                              <tr key={item.id} className={item.isInitial ? "bg-blue-50/50" : "bg-white"}>
                                <td className="px-3 py-2 align-middle">
                                  {item.isEditing && !item.isInitial ? (
                                    <DateStepper
                                      value={item.effectiveDate}
                                      onChange={(value) => updateRateDraft(item.id, { effectiveDate: value })}
                                    />
                                  ) : (
                                    <span className="tabular-nums text-slate-700">{item.effectiveDate}</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right align-middle">
                                  {item.isEditing ? (
                                    <input
                                      value={item.annualRate}
                                      onChange={(event) => updateRateDraft(item.id, { annualRate: event.target.value })}
                                      inputMode="decimal"
                                      placeholder={t("debtShell.rateAdjust.annualRatePlaceholder")}
                                      className="form-input text-right"
                                    />
                                  ) : (
                                    <span className="tabular-nums text-slate-700">{formatRate(annualRate, language)}</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-right align-middle">
                                  <div className="inline-flex items-center gap-1.5">
                                    <button
                                      type="button"
                                      onClick={() => { void openRebuildDialogForDate(item.effectiveDate); }}
                                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-blue-700 transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
                                      disabled={rebuildBusy || rateSaving}
                                      title={t("debtShell.rebuild.buttonTitle")}
                                      aria-label={t("debtShell.recalc")}
                                    >
                                      <RefreshCw className="h-3.5 w-3.5" />
                                    </button>
                                    {item.isEditing ? (
                                      <button
                                        type="button"
                                        onClick={() => saveRateDraftRow(item.id)}
                                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-emerald-600 transition-colors hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                                        disabled={rateSaving}
                                        title={t("common.save")}
                                        aria-label={t("common.save")}
                                      >
                                        <Check className="h-3.5 w-3.5" />
                                      </button>
                                    ) : (
                                      <>
                                        <button
                                          type="button"
                                          onClick={() => updateRateDraft(item.id, { isEditing: true })}
                                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-600 transition-colors hover:bg-slate-50 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                                          disabled={rateSaving}
                                          title={t("common.edit")}
                                          aria-label={t("common.edit")}
                                        >
                                          <Pencil className="h-3.5 w-3.5" />
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => deleteRateDraft(item.id)}
                                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-rose-600 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                                          disabled={rateSaving || item.isInitial}
                                          title={item.isInitial ? t("debtShell.rateAdjust.initialDeleteDisabled") : t("common.delete")}
                                          aria-label={t("common.delete")}
                                        >
                                          <Trash2 className="h-3.5 w-3.5" />
                                        </button>
                                      </>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                  <div className="flex items-center gap-2">
                    {isSelectedMortgageLoan ? (
                      <button
                        type="button"
                        onClick={() => { void queryLatestLpr(); }}
                        className="secondary-button h-9 px-3"
                        disabled={rateSaving}
                        title={t("debtShell.rateAdjust.queryLprTitle")}
                      >
                        {t("debtShell.rateAdjust.queryLpr")}
                      </button>
                    ) : null}
                    {isSelectedMortgageLoan ? null : (
                      <button
                        type="button"
                        onClick={addRateDraft}
                        className="secondary-button h-9 px-3"
                        disabled={rateSaving}
                      >
                        {t("debtShell.rateAdjust.addRow")}
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => { void saveRateAdjustments(); }}
                    className="primary-button h-9 px-3"
                    disabled={rateSaving}
                  >
                    {rateSaving ? t("debtShell.saving") : t("debtShell.saveRateAdjustments")}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {rebuildDialog ? (
          <div className="app-modal-backdrop z-[60]">
            <div className="app-modal-panel max-w-md">
              <div className="modal-header shrink-0">
                <div>
                  <div className="text-sm font-semibold text-slate-800">{t("debtShell.rebuild.title")}</div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {t("debtShell.rebuild.subtitle", { date: rebuildDialog.effectiveDate })} · {selectedRow?.name ?? t("debtShell.currentLoan")}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setRebuildDialog(null)}
                  className="secondary-button h-8 px-2"
                  disabled={rebuildBusy}
                >
                  {t("table.close")}
                </button>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <div className="rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                  {t("debtShell.rebuild.intro", { count: rebuildDialog.preview.updateCount })}
                </div>

                <div className="space-y-1">
                  <div className="form-label">{t("debtShell.rebuild.startPeriod")}</div>
                  <DateStepper
                    value={rebuildDialog.effectiveDate}
                    onChange={(value) => changeRebuildFromDate(value)}
                  />
                  <div className="text-[11px] leading-5 text-slate-500">{t("debtShell.rebuild.startPeriodHint")}</div>
                </div>

                <div className="space-y-1 text-xs text-slate-600">
                  <div className="flex items-center justify-between">
                    <span>{t("debtShell.rebuild.startPeriod")}</span>
                    <span className="tabular-nums text-slate-800">{rebuildDialog.preview.startRunDate}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>{t("debtShell.rebuild.balanceStart")}</span>
                    <span className="tabular-nums text-slate-800">{formatMoney(rebuildDialog.preview.balanceStart)}</span>
                  </div>
                  {rebuildDialog.preview.effectiveAnnualRate != null ? (
                    <div className="flex items-center justify-between">
                      <span>{t("debtShell.rebuild.effectiveRate")}</span>
                      <span className="tabular-nums text-slate-800">{formatRate(rebuildDialog.preview.effectiveAnnualRate, language)}%</span>
                    </div>
                  ) : null}
                  {rebuildDialog.preview.preservedAmount != null && !rebuildDialog.preview.recalcAtStart ? (
                    <div className="flex items-center justify-between">
                      <span>{t("debtShell.rebuild.preservedAmount")}</span>
                      <span className="tabular-nums text-slate-800">
                        {formatMoney(rebuildDialog.preview.lastRemainingPayment ?? rebuildDialog.preview.preservedAmount)}
                      </span>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-1">
                  <div className="form-label">{t("debtShell.rebuild.remainingRunsLabel")}</div>
                  <input
                    value={rebuildRemainingRuns}
                    onChange={(event) => setRebuildRemainingRuns(event.target.value)}
                    inputMode="numeric"
                    className="form-input"
                  />
                  <div className="text-[11px] leading-5 text-slate-500">{t("debtShell.rebuild.remainingRunsHint")}</div>
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-600">{t("debtShell.rebuild.newPaymentLabel")}</span>
                    <span className="text-sm font-semibold tabular-nums text-slate-900">{formatMoney(rebuildPreviewParts?.payment ?? rebuildDialog.preview.previewPayment)}</span>
                  </div>
                  <div className="mt-1 text-right text-[11px] tabular-nums text-slate-500">
                    {t("debtShell.rebuild.newPaymentDetail", {
                      principal: formatMoney(rebuildPreviewParts?.principal ?? rebuildDialog.preview.previewPrincipal),
                      interest: formatMoney(rebuildPreviewParts?.interest ?? rebuildDialog.preview.previewInterest),
                    })}
                  </div>
                  <div className="mt-1 text-[11px] leading-5 text-slate-500">
                    {rebuildDialog.preview.recalcAtStart
                      ? t("debtShell.rebuild.recalcNote")
                      : t("debtShell.rebuild.preserveNote")}
                  </div>
                </div>
              </div>

              <div className="modal-footer flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 p-4">
                <button
                  type="button"
                  onClick={() => setRebuildDialog(null)}
                  className="secondary-button h-9 px-3"
                  disabled={rebuildBusy}
                >
                  {t("debtShell.rebuild.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => { void confirmRebuild(); }}
                  className="primary-button h-9 px-3"
                  disabled={rebuildBusy}
                >
                  {rebuildBusy ? t("debtShell.rebuild.busy") : t("debtShell.rebuild.confirm")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
  );
}

function DebtEntriesTable({
  accountOptions,
  categoryOptions,
  contextAccountId,
  columns,
  entries,
  loanType,
}: {
  accountOptions: AccountOption[];
  categoryOptions: BasicDetailBatchCategoryOption[];
  contextAccountId?: string | null;
  columns: AdvancedDataTableColumn<DebtEntry>[];
  entries: DebtEntry[];
  loanType: LoanTypeValue;
}) {
  const { t } = useI18n();
  const { selectedIds, setSelection } = useBasicDetailSelection();
  const currentEntryIds = useMemo(() => entries.map((entry) => entry.id), [entries]);
  usePruneBasicDetailSelection(currentEntryIds);
  const normalizedAccountOptions = useMemo(
    () => accountOptions.map((account) => ({
      id: account.id,
      label: account.label,
      title: account.title ?? account.hoverTitle ?? undefined,
    })),
    [accountOptions],
  );
  const getCustomEditEvent = (entry: DebtEntry) => {
    if (entry.balanceReconcileEdit) {
      return { name: "mmh:balance-reconcile:edit", detail: { ...entry.balanceReconcileEdit } };
    }
    if (!entry.debtEdit) return undefined;
    const detail = entry.debtEdit.dialogType === "loan"
      ? { ...entry.debtEdit, loanType }
      : { ...entry.debtEdit };
    return {
      name: entry.debtEdit.dialogType === "loan" ? "mmh:loan:create" : "mmh:debt:create",
      detail,
    };
  };

  return (
    <AdvancedDataTable
      storageKey="mmh_debt_entries_table_v1"
      resetKey={`debt-entries:${contextAccountId ?? "all"}`}
      columns={columns}
      rows={entries}
      rowKey={(entry) => entry.id}
      minTableWidth={1240}
      emptyText={t("debtShell.emptyEntries")}
      fillHeight
      toolbarTitle={t("debtShell.tabEntries")}
      toolbarRightContent={<span className="text-xs text-slate-500">{t("debtShell.entryCount", { count: entries.length })}</span>}
      selectable
      selectOnRowClick
      selectedKeys={selectedIds}
      onSelectionChange={setSelection}
      onRowDoubleClick={(entry) => {
        const customEditEvent = getCustomEditEvent(entry);
        dispatchEntryEdit({
          entryId: entry.id,
          edit: entry.edit,
          customEditEvent,
        });
      }}
      rowClassName={() => "hover:bg-blue-50/40"}
      rowActions={(entry) => (
        <EntryRowActions
          entryId={entry.id}
          edit={entry.edit}
          customEditEvent={getCustomEditEvent(entry)}
        />
      )}
      rowActionsWidth={92}
      rowActionsMinWidth={76}
      batchActionSlot={(
        <>
          <BasicDetailBatchReplaceButton
            accountOptions={normalizedAccountOptions}
            categoryOptions={categoryOptions}
            contextAccountId={contextAccountId}
          />
          <BasicDetailBatchDeleteButton recordLabel={t("debtShell.recordLabel")} />
        </>
      )}
    />
  );
}
