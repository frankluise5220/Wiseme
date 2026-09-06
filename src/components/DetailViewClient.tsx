"use client";

import { useCallback, useState, useEffect, useMemo, useRef, type ReactNode, type MouseEvent } from "react";
import { Paperclip } from "lucide-react";
import { formatDateDisplay, formatDateLocal as localDateKey, toNumber } from "@/lib/date-utils";
import { formatCurrencyMoney } from "@/lib/format";
import { getColorSchemeFromCookie, pnlColor } from "@/lib/client/colors";
import { getInsuranceDetailCategoryName, getInsuranceDetailNote } from "@/lib/insurance/detail-display";
import { dispatchEntryEdit, EntryRowActions, type EditPayload } from "./EntryRowActions";
import { AdvancedDataTable, type AdvancedDataTableColumn, type AdvancedDataTableDropPosition } from "./AdvancedDataTable";
import { BusinessLinkActionButton } from "./BusinessLinkActionButton";
import { EntryAttachmentWindow } from "./EntryAttachmentWindow";
import { BasicDetailBatchDeleteButton,
  BasicDetailBatchReplaceButton,
  type BasicDetailBatchCategoryOption,
  useBasicDetailSelection,
  usePruneBasicDetailSelection,
} from "./BasicDetailSelection";
import type { BatchReplaceField } from "@/lib/client/batchReplaceEntries";
import { useI18n } from "@/lib/i18n";
import { BALANCE_INITIALIZATION_SOURCE, BALANCE_RECONCILE_SOURCE, applyBalanceReconcileEntry, effectiveAmountForAccount, getBalanceReconcileTarget } from "@/lib/balance-reconcile";
import { compareDetailEntriesAsc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { DEFAULT_LOAN_PREPAY_STRATEGY, parseLoanPrepayStrategy } from "@/lib/loan-prepay-strategy";
import { dispatchFinanceDataChanged, FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";
import { isCreditCardRepaymentTransfer, isLicensedInsuranceEntry, isRegularInvestRefundEntry, TRANSACTION_SOURCE_INSURANCE } from "@/lib/transaction-semantics";
import { normalizeSettlementTransferCategoryName } from "@/lib/default-categories";
import { advanceDialogAmount } from "@/lib/advance-transfer";
import {
  DETAIL_ALL_PAGE_SIZE,
  normalizeDetailPage,
  normalizeDetailPageSize,
  readStoredDetailPreference,
} from "@/lib/detail-pagination-preference";
import { parseImportAccountId } from "@/lib/account-import-match";
import { formatAccountTableLabel, formatAccountTableTitle } from "@/lib/account-display";
import { systemCategoryLabel } from "@/lib/system-category-labels";
import { APP_PREFS_EVENT, getAccountLabelFieldsPreference, getDateDisplayFormatPreference, getDetailDateBackgroundPreference, type DateDisplayFormat } from "@/lib/client/appPreferences";

/* Types */

export type DetailEntry = {
  id: string;
  cashEntryId?: string | null;
  businessTransactionId?: string | null;
  stockTransactionId?: string | null;
  stockTransaction?: {
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
  } | null;
  date: string;
  postedAt?: string | null;
  createdAt?: string | null;
  dayOrder?: number | null;
  amount: number;
  currency?: string | null;
  runningBalance?: number | null;
  type: string;
  categoryId: string | null;
  categoryName: string | null;
  accountId: string | null;
  accountName: string | null;
  accountKind?: string | null;
  accountDebtDirection?: string | null;
  accountIsSettlementDebt?: boolean | null;
  accountInstitutionName?: string | null;
  counterpartyInstitutionId?: string | null;
  counterpartyInstitutionName?: string | null;
  toAccountId: string | null;
  toAccountName: string | null;
  toAccountKind?: string | null;
  toAccountDebtDirection?: string | null;
  toAccountIsSettlementDebt?: boolean | null;
  toAccountInstitutionName?: string | null;
  note: string | null;
  businessNote?: string | null;
  toNote?: string | null;
  fundSubtype: string | null;
  fundCode: string | null;
  fundName: string | null;
  wealthProductId?: string | null;
  source: string | null;
  fundProductType: string | null;
  metalTypeId?: string | null;
  metalTypeName?: string | null;
  metalUnitId?: string | null;
  metalUnitName?: string | null;
  metalQuantity?: number | null;
  metalUnitPrice?: number | null;
  metalFee?: number | null;
  insuranceProductId?: string | null;
  insuranceAction?: string | null;
  insuranceProductName?: string | null;
  debtPrincipalAmount?: number | null;
  debtInterestAmount?: number | null;
  debtFeeAmount?: number | null;
  realizedProfit?: number | null;
  cashAccountId?: string | null;
  coverageAmount?: number | null;
  paymentTermYears?: number | null;
  fundUnits: number | null;
  fundNav: number | null;
  depositAnnualRate?: number | null;
  depositInterest?: number | null;
  depositSourceEntryId?: string | null;
  fundFee: number | null;
  fundConfirmDate: string | null;
  fundArrivalDate: string | null;
  fundSourceEntryId?: string | null;
  fundArrivalAmount: number | null;
  businessLinkCount?: number;
  businessLinkLabels?: string[];
  relatedAccountId?: string | null;
  relatedAccountName?: string | null;
  attachments?: Array<{
    id: string;
    name: string;
    mimeType?: string | null;
    url?: string | null;
  }>;
  entryTags: Array<{
    tagId: string;
    Tag: { name: string; color: string } | null;
  }>;
};

function cssEscape(value: string) {
  const escape = typeof window !== "undefined" ? window.CSS?.escape : undefined;
  return escape ? escape(value) : value.replace(/["\\]/g, "\\$&");
}

function EntryAttachmentIndicator({
  entry,
  onClick,
  asButton = true,
}: {
  entry: DetailEntry;
  onClick: () => void;
  asButton?: boolean;
}) {
  const attachments = entry.attachments ?? [];
  if (attachments.length === 0) return null;
  const names = attachments.map((item) => item.name).join("、");
  const content = <Paperclip className="h-3.5 w-3.5" />;
  const handleClick = (event: MouseEvent) => {
    event.stopPropagation();
    onClick();
  };
  // Boxed style consistent with the adjacent row action icons (BusinessLinkActionButton,
  // EntryRowActions): visible border, white background, amber accent for attachments.
  const className =
    "flex h-6 w-6 shrink-0 items-center justify-center rounded border border-amber-200 bg-white text-amber-600 transition-colors hover:border-amber-300 hover:bg-amber-50";
  // The mobile entry row is itself a <button>, so the indicator must not render a nested
  // button there (invalid HTML and a React hydration error). Render a span instead.
  if (!asButton) {
    return (
      <span title={names} onClick={handleClick} className={className}>
        {content}
      </span>
    );
  }
  return (
    <button type="button" title={names} onClick={handleClick} className={className}>
      {content}
    </button>
  );
}

function buildBasicEntryEditPayload(entry: DetailEntry, currentAccountId?: string | null) {
  const isAdvanceReturn = entry.source === "advance" && entry.accountKind === "loan";
  const numericAmount = toNumber(entry.amount);
  const dialogAmount = entry.type === "transfer" && entry.source !== "advance"
    ? Math.abs(numericAmount)
    : advanceDialogAmount({ amount: numericAmount, accountKind: entry.accountKind, source: entry.source });
  return {
    id: entry.id,
    transactionId: entry.id,
    date: (entry.date ?? "").slice(0, 10),
    postedAt: entry.postedAt ?? null,
    type: (entry.source === "advance" ? "advance" : entry.source === "fx_conversion" ? "fx" : entry.type) as EditPayload["type"],
    amount: dialogAmount,
    note: displayDetailRemark(entry, currentAccountId),
    toNote: entry.toNote ?? "",
    categoryId: entry.categoryId ?? undefined,
    categoryName: entry.categoryName ?? undefined,
    accountId: (isAdvanceReturn ? entry.toAccountId : entry.accountId) ?? undefined,
    accountName: (isAdvanceReturn ? entry.toAccountName : entry.accountName) ?? undefined,
    counterpartyInstitutionId: entry.counterpartyInstitutionId ?? undefined,
    counterpartyInstitutionName: entry.counterpartyInstitutionName ?? undefined,
    fromAccountId: entry.type === "transfer" ? entry.accountId ?? undefined : undefined,
    fromAccountName: entry.type === "transfer" ? entry.accountName ?? undefined : undefined,
    toAccountId: entry.toAccountId ?? undefined,
    toAccountName: entry.toAccountName ?? undefined,
    tagIds: entry.entryTags?.map((item) => item.tagId) ?? [],
    tags: entry.entryTags?.map((item) => ({
      id: item.tagId,
      name: item.Tag?.name ?? "",
      color: item.Tag?.color ?? null,
    })) ?? [],
  };
}

function runningBalanceContribution(entry: DetailEntry, accountId: string) {
  return applyBalanceReconcileEntry(0, entry, accountId);
}

function canRecalculateRunningBalanceFromLoadedEntries(entries: DetailEntry[], accountId: string) {
  const ascEntries = [...entries].sort((a, b) => compareDetailEntriesAsc(a, b, accountId));
  const firstEntry = ascEntries[0];
  if (!firstEntry || firstEntry.runningBalance == null) return false;
  return Math.abs(toNumber(firstEntry.runningBalance) - runningBalanceContribution(firstEntry, accountId)) < 0.005;
}

function recalculateLoadedRunningBalances(entries: DetailEntry[], accountId: string) {
  const runningBalanceById = new Map<string, number>();
  let runningBalance = 0;
  for (const entry of [...entries].sort((a, b) => compareDetailEntriesAsc(a, b, accountId))) {
    runningBalance = applyBalanceReconcileEntry(runningBalance, entry, accountId);
    runningBalanceById.set(entry.id, runningBalance);
  }
  return entries.map((entry) => ({ ...entry, runningBalance: runningBalanceById.get(entry.id) ?? entry.runningBalance ?? null }));
}

function removeEntriesAndUpdateRunningBalances(entries: DetailEntry[], deletedSet: Set<string>, accountId: string) {
  const deletedEntries = entries.filter((entry) => deletedSet.has(entry.id));
  if (deletedEntries.length === 0) return entries;
  const remainingEntries = entries.filter((entry) => !deletedSet.has(entry.id));
  if (canRecalculateRunningBalanceFromLoadedEntries(remainingEntries, accountId)) {
    return recalculateLoadedRunningBalances(remainingEntries, accountId);
  }
  if (deletedEntries.some((entry) => getBalanceReconcileTarget(entry) != null)) return remainingEntries;
  return remainingEntries.map((entry) => {
    if (entry.runningBalance == null) return entry;
    const adjustment = deletedEntries.reduce((sum, deletedEntry) => (
      compareDetailEntriesAsc(deletedEntry, entry, accountId) < 0
        ? sum + runningBalanceContribution(deletedEntry, accountId)
        : sum
    ), 0);
    return adjustment === 0
      ? entry
      : { ...entry, runningBalance: toNumber(entry.runningBalance) - adjustment };
  });
}

type DebtMode = "borrow_in" | "repay_out" | "prepay_out" | "lend_out" | "collect_in";
type DetailAccountOption = {
  id: string;
  label: string;
  fullLabel?: string | null;
  title?: string | null;
  kind?: string | null;
  debtDirection?: string | null;
  numberMasked?: string | null;
  isSettlementDebt?: boolean | null;
};

/* Helpers */

function shouldShowBusinessLinkStatus(entry: DetailEntry) {
  const hasBusinessLink = (entry.businessLinkCount ?? 0) > 0;
  const hasInvestmentSide = entry.accountKind === "investment" || entry.toAccountKind === "investment";
  return hasBusinessLink || entry.type === "investment" || (entry.type === "transfer" && hasInvestmentSide);
}

function formatType(type: string, t: (key: string) => string) {
  if (type === "expense") return t("transaction.type.expense");
  if (type === "income") return t("transaction.type.income");
  if (type === "transfer") return t("transaction.type.transfer");
  if (type === "investment") return t("transaction.type.investment");
  return type;
}

function propertyIncomeExpenseType(entry: DetailEntry): "income" | "expense" | null {
  if (entry.type === "income" || entry.type === "expense") return entry.type;
  const amount = toNumber(entry.amount);
  if (amount > 0) return "income";
  if (amount < 0) return "expense";
  return null;
}

function entryCurrency(entry: { currency?: string | null }) {
  return String(entry.currency ?? "CNY").trim().toUpperCase() || "CNY";
}

function formatEntryCurrencyMoney(amount: number, entry: { currency?: string | null }) {
  const currency = entryCurrency(entry);
  return formatCurrencyMoney(amount, currency);
}

function formatSelectedAmountsByCurrency(amounts: Map<string, number>) {
  return Array.from(amounts.entries())
    .sort(([currencyA], [currencyB]) => currencyA.localeCompare(currencyB))
    .map(([currency, amount]) => formatCurrencyMoney(amount, currency))
    .join(" + ");
}

function isCreditCardRepaymentDisplayEntry(entry: DetailEntry) {
  if (entry.accountIsSettlementDebt || entry.toAccountIsSettlementDebt) return false;
  if (entry.accountKind === "loan" || entry.toAccountKind === "loan") return false;
  return isCreditCardRepaymentTransfer(entry);
}

function debtModeFromSource(source: string, note?: string | null): DebtMode | null {
  if (source === "debt_borrow_in") return "borrow_in";
  if (source === "debt_financed_purchase") return "borrow_in";
  if (source === "debt_lend_out") return "lend_out";
  if (source === "debt_repay_out") return "repay_out";
  if (source === "debt_prepay_out") return "prepay_out";
  if (source === "debt_collect_in") return "collect_in";
  if (source === "scheduled_task" && String(note ?? "").includes("还贷款")) return "repay_out";
  return null;
}

function inferDebtMode(
  entry: {
    type: string;
    source: string | null;
    note?: string | null;
    accountKind?: string | null;
    accountDebtDirection?: string | null;
    toAccountKind?: string | null;
    toAccountDebtDirection?: string | null;
  },
  accountById?: Map<string, DetailAccountOption>,
): DebtMode | null {
  if (entry.type !== "transfer") return null;
  if (entry.source === "advance") return null;
  const sourceMode = debtModeFromSource(String(entry.source ?? ""), entry.note);
  if (sourceMode) return sourceMode;
  const sourceAccount = accountById?.get((entry as { accountId?: string | null }).accountId ?? "");
  const targetAccount = accountById?.get((entry as { toAccountId?: string | null }).toAccountId ?? "");
  const sourceKind = entry.accountKind ?? sourceAccount?.kind ?? null;
  const targetKind = entry.toAccountKind ?? targetAccount?.kind ?? null;
  const sourceDirection = entry.accountDebtDirection ?? sourceAccount?.debtDirection ?? null;
  const targetDirection = entry.toAccountDebtDirection ?? targetAccount?.debtDirection ?? null;
  if (sourceKind === "loan") return sourceDirection === "receivable" ? "collect_in" : "borrow_in";
  if (targetKind === "loan") return targetDirection === "receivable" ? "lend_out" : "repay_out";
  return null;
}

function isDebtActivityEntry(entry: {
  type: string;
  source: string | null;
  note: string | null;
  accountKind?: string | null;
  accountDebtDirection?: string | null;
  accountIsSettlementDebt?: boolean | null;
  toAccountKind?: string | null;
  toAccountDebtDirection?: string | null;
  toAccountIsSettlementDebt?: boolean | null;
}, accountById?: Map<string, DetailAccountOption>) {
  if (entry.type !== "transfer") return false;
  return inferDebtMode(entry, accountById) != null;
}

function bankDebtTransferLabel(entry: DetailEntry, mode: DebtMode | null, t: (key: string) => string) {
  const involvesBankDebt =
    (entry.accountKind === "loan" && !entry.accountIsSettlementDebt) ||
    (entry.toAccountKind === "loan" && !entry.toAccountIsSettlementDebt);
  if (!involvesBankDebt) return null;
  if (entry.source === "debt_financed_purchase") return t("txForm.installment");
  if (mode === "borrow_in") return t("detailView.loanDisbursement");
  if (mode === "repay_out") return t("detailView.loanRepayment");
  if (mode === "prepay_out") return t("detailView.loanPrepayment");
  if (mode === "lend_out") return t("detailView.bankLending");
  if (mode === "collect_in") return t("detailView.bankCollection");
  return systemCategoryLabel(entry.categoryName, t) || t("detailView.bankLoan");
}

function debtCategoryLabel(entry: DetailEntry, accountById: Map<string, DetailAccountOption> | undefined, t: (key: string) => string) {
  if (!isDebtActivityEntry(entry, accountById)) return null;
  const mode = inferDebtMode(entry, accountById);
  const bankLabel = bankDebtTransferLabel(entry, mode, t);
  if (bankLabel) return bankLabel;
  return systemCategoryLabel(normalizeSettlementTransferCategoryName(entry.categoryName), t);
}

function displaySecondRemark(entry: { toNote?: string | null }) {
  return parseLoanPrepayStrategy(entry.toNote) ? "" : (entry.toNote ?? "");
}

function displayDetailRemark(entry: DetailEntry, currentAccountId?: string | null) {
  if (isLicensedInsuranceEntry(entry)) return getInsuranceDetailNote(entry);
  if (entry.type === "transfer" && currentAccountId && entry.toAccountId === currentAccountId) {
    return (displaySecondRemark(entry).trim() || (entry.note ?? "").trim());
  }
  return (entry.note ?? "").trim();
}

function detailEntryDayKey(entry: DetailEntry, accountId: string) {
  return localDateKey(getDetailEntryDisplayDate(entry, accountId));
}

function canManuallyReorderDetailEntry(entry: DetailEntry) {
  return getBalanceReconcileTarget(entry) == null;
}

function batchCategoryTypeForEntry(entry: DetailEntry) {
  if (entry.type === "expense" || entry.type === "income" || entry.type === "investment") return entry.type;
  if (entry.source === "advance") return "advance";
  return "";
}

function reorderEntriesToTarget(entries: DetailEntry[], sourceId: string, targetId: string, position: AdvancedDataTableDropPosition) {
  const sourceIndex = entries.findIndex((entry) => entry.id === sourceId);
  const targetIndex = entries.findIndex((entry) => entry.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return entries;
  const next = [...entries];
  const [moving] = next.splice(sourceIndex, 1);
  const targetIndexAfterRemoval = next.findIndex((entry) => entry.id === targetId);
  if (targetIndexAfterRemoval < 0) return entries;
  next.splice(position === "after" ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval, 0, moving);
  if (next.every((entry, index) => entry.id === entries[index]?.id)) return entries;
  return next;
}

function applyServerEntryOrder(entries: DetailEntry[], orderedEntryIds: string[]) {
  if (orderedEntryIds.length === 0) return entries;
  const orderedIdSet = new Set(orderedEntryIds);
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const orderedEntries = orderedEntryIds
    .map((id) => entryById.get(id))
    .filter((entry): entry is DetailEntry => !!entry);
  if (orderedEntries.length === 0) return entries;

  let orderedIndex = 0;
  let changed = false;
  const next = entries.map((entry) => {
    if (!orderedIdSet.has(entry.id)) return entry;
    const replacement = orderedEntries[orderedIndex++] ?? entry;
    if (replacement.id !== entry.id) changed = true;
    return replacement;
  });
  return changed ? next : entries;
}

function applyServerRunningBalances(entries: DetailEntry[], runningBalances?: Record<string, number>) {
  if (!runningBalances) return entries;
  let changed = false;
  const next = entries.map((entry) => {
    const runningBalance = runningBalances[entry.id];
    if (runningBalance == null) return entry;
    if (entry.runningBalance != null && Math.abs(toNumber(entry.runningBalance) - runningBalance) < 0.005) return entry;
    changed = true;
    return { ...entry, runningBalance };
  });
  return changed ? next : entries;
}

type ReorderResponse = {
  ok?: boolean;
  changed?: boolean;
  orderedEntryIds?: string[];
  runningBalances?: Record<string, number>;
  error?: string;
};

function activityLabel(type: string, fundSubtype: string | null, source: string | null, t: (key: string) => string, balanceTarget: number | null = null): string {
  if (balanceTarget != null && source === BALANCE_INITIALIZATION_SOURCE) return t("detailView.initialBalance");
  if (source === BALANCE_RECONCILE_SOURCE) return t("detailView.balanceReconcile");
  if (source === TRANSACTION_SOURCE_INSURANCE) {
    return fundSubtype === "redeem" || fundSubtype === "switch_out" ? t("detailView.insuranceRefund") : t("detailView.insuranceExpense");
  }
  if (source === "advance") return t("txForm.advance");
  if (type === "investment" && (source === "deposit" || source === "deposit_manual")) return t("detailView.deposit");
  return formatType(type, t);
}

function investmentCategoryLabel(
  entry: DetailEntry,
  entryFundProductType: string | null | undefined,
  t: (key: string) => string,
): string {
  if (isLicensedInsuranceEntry(entry)) return getInsuranceDetailCategoryName(entry);
  if (entry.categoryName) return systemCategoryLabel(entry.categoryName, t);
  const subtype = String(entry.fundSubtype ?? "");
  const source = String(entry.source ?? "");
  const productType = entryFundProductType ?? null;
  if (productType === "deposit") {
    if (subtype === "redeem") return t("detailView.depositWithdraw");
    if (subtype === "buy") return t("txForm.depositIn");
  }
  if (productType === "wealth") {
    if (subtype === "redeem") return t("detailView.wealthRedeem");
    if (isRegularInvestRefundEntry({ fundSubtype: subtype, source })) return t("detailView.buyRefund");
    if (subtype === "buy_failed") return t("detailView.buyFailed");
    if (subtype === "buy") return t("detailView.wealthBuy");
  }
  if (productType === "metal") {
    if (subtype === "redeem") return t("detailView.metalSell");
    if (subtype === "buy") return t("detailView.metalBuy");
  }
  if (productType === "fund" || productType === "money" || !productType) {
    if (subtype === "buy" && source === "regular_invest") return t("detailView.fundRegularInvest");
    if (subtype === "buy" && source === "dividend") return t("detailView.dividendInvest");
    if (subtype === "redeem") return t("detailView.fundRedeem");
    if (subtype === "dividend_cash") return t("detailView.dividendCash");
    if (subtype === "dividend_reinvest") return t("detailView.dividendReinvest");
    if (isRegularInvestRefundEntry({ fundSubtype: subtype, source })) return t("detailView.buyRefund");
    if (subtype === "buy_failed") return t("detailView.buyFailed");
    if (subtype === "buy") return t("detailView.fundBuy");
  }
  return "";
}

/* Component */

export function DetailViewClient({
  accountId,
  initialEntries,
  accountOptions,
  categoryOptions = [],
  tagOptions = [],
  investmentProductTypeByAccountId,
  compactRows = false,
  storageKey = "mmh_basic_detail_table_v1",
  refreshOnGlobalEvent = true,
  toolbarMode = "default",
  toolbarTitle,
  toolbarRightContent,
  batchReplaceFields,
  resetKey,
  emptyText,
  draggableRows = true,
  allowInvestmentEdit = true,
  showAccountColumn = false,
  accountColumnLabel,
  accountColumnMode = "account",
  accountColumnDefaultHidden = false,
  relatedAccountDefaultHidden = false,
  showRunningBalance = true,
  runningBalanceDefaultHidden = false,
  enableAccountNavigation = false,
  focusEntryId,
  reorderAccountIds,
  sortable = true,
  onDisplayRowsChange,
}: {
  accountId: string;
  isInvestAccount: boolean;
  initialEntries: DetailEntry[];
  accountOptions: DetailAccountOption[];
  categoryOptions?: BasicDetailBatchCategoryOption[];
  tagOptions?: BasicDetailBatchCategoryOption[];
  investmentProductTypeByAccountId: Record<string, string | undefined | null>;
  compactRows?: boolean;
  storageKey?: string;
  refreshOnGlobalEvent?: boolean;
  toolbarMode?: "default" | "custom" | "none";
  toolbarTitle?: ReactNode;
  toolbarRightContent?: ReactNode;
  batchReplaceFields?: BatchReplaceField[];
  resetKey?: string;
  emptyText?: string;
  draggableRows?: boolean;
  allowInvestmentEdit?: boolean;
  showAccountColumn?: boolean;
  accountColumnLabel?: string;
  accountColumnMode?: "account" | "cardLast4";
  accountColumnDefaultHidden?: boolean;
  relatedAccountDefaultHidden?: boolean;
  showRunningBalance?: boolean;
  runningBalanceDefaultHidden?: boolean;
  enableAccountNavigation?: boolean;
  focusEntryId?: string;
  reorderAccountIds?: string[];
  sortable?: boolean;
  onDisplayRowsChange?: (rows: DetailEntry[]) => void;
}) {
  const { t } = useI18n();
  const [dateDisplayFormat, setDateDisplayFormat] = useState<DateDisplayFormat>("yyyy-mm-dd");
  const [detailDateBackground, setDetailDateBackground] = useState(false);

  useEffect(() => {
    const syncDisplayPreferences = () => {
      setDateDisplayFormat(getDateDisplayFormatPreference());
      setDetailDateBackground(getDetailDateBackgroundPreference());
    };
    syncDisplayPreferences();
    window.addEventListener(APP_PREFS_EVENT, syncDisplayPreferences);
    return () => window.removeEventListener(APP_PREFS_EVENT, syncDisplayPreferences);
  }, []);
  const [attachmentViewEntryId, setAttachmentViewEntryId] = useState<string | null>(null);
  const resolvedEmptyText = emptyText ?? t("detail.empty");
  const resolvedAccountColumnLabel = accountColumnLabel ?? t("common.account");
  const accountOptionById = useMemo(
    () => new Map(accountOptions.map((option) => [option.id, option])),
    [accountOptions],
  );
  const accountDisplayFallback = useCallback((accountId?: string | null, fallback?: string | null) => {
    const byId = accountId ? accountOptionById.get(accountId) : undefined;
    if (byId) {
      const label = formatAccountTableLabel(byId, "", getAccountLabelFieldsPreference());
      return { label, title: formatAccountTableTitle(byId, label, getAccountLabelFieldsPreference()) };
    }
    const raw = String(fallback ?? "").trim();
    if (!raw) return { label: "", title: "" };
    const encodedId = parseImportAccountId(raw);
    const directId = encodedId || (/^cm[a-z0-9]{8,}$/i.test(raw) ? raw : "");
    const byFallbackId = directId ? accountOptionById.get(directId) : undefined;
    if (byFallbackId) {
      const label = formatAccountTableLabel(byFallbackId, "", getAccountLabelFieldsPreference());
      return { label, title: formatAccountTableTitle(byFallbackId, label, getAccountLabelFieldsPreference()) };
    }
    return { label: raw, title: raw };
  }, [accountOptionById]);
  const accountColumnScopeIds = useMemo(
    () => new Set((reorderAccountIds?.length ? reorderAccountIds : [accountId]).filter(Boolean)),
    [accountId, reorderAccountIds],
  );
  const accountColumnScopeIdList = useMemo(
    () => Array.from(accountColumnScopeIds),
    [accountColumnScopeIds],
  );
  const relatedAccountTarget = useCallback((entry: DetailEntry) => {
    const sourceInScope = !!entry.accountId && accountColumnScopeIds.has(entry.accountId);
    const targetInScope = !!entry.toAccountId && accountColumnScopeIds.has(entry.toAccountId);
    if (!entry.toAccountId && (entry.relatedAccountId || entry.relatedAccountName)) {
      return { id: entry.relatedAccountId ?? null, name: entry.relatedAccountName ?? null };
    }
    if (targetInScope && !sourceInScope) return { id: entry.accountId, name: entry.accountName };
    if (sourceInScope && !targetInScope) return { id: entry.toAccountId, name: entry.toAccountName };
    if (targetInScope) return { id: entry.accountId, name: entry.accountName };
    return { id: entry.toAccountId, name: entry.toAccountName };
  }, [accountColumnScopeIds]);
  const accountColumnTarget = useCallback((entry: DetailEntry) => {
    if (accountColumnMode === "cardLast4") {
      if (entry.accountId && accountColumnScopeIds.has(entry.accountId)) {
        return { id: entry.accountId, name: entry.accountName };
      }
      if (entry.toAccountId && accountColumnScopeIds.has(entry.toAccountId)) {
        return { id: entry.toAccountId, name: entry.toAccountName };
      }
    }
    return { id: entry.accountId, name: entry.accountName };
  }, [accountColumnMode, accountColumnScopeIds]);
  const accountColumnDisplayFallback = useCallback((entry: DetailEntry) => {
    const target = accountColumnTarget(entry);
    if (accountColumnMode === "cardLast4") {
      const option = target.id ? accountOptionById.get(target.id) : undefined;
      const last4 = option?.numberMasked?.trim();
      if (last4) {
        const title = option?.title ?? option?.fullLabel ?? option?.label ?? last4;
        return { id: target.id, label: last4, title };
      }
      return {
        id: target.id,
        label: "-",
        title: option?.title ?? option?.fullLabel ?? option?.label ?? target.name ?? "",
      };
    }
    return { id: target.id, ...accountDisplayFallback(target.id, target.name) };
  }, [accountColumnMode, accountColumnTarget, accountDisplayFallback, accountOptionById]);
  const tf = (key: string, values: Record<string, string | number>) => {
    let text: string = t(key);
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };
  const detailCategoryLabel = useCallback((entry: DetailEntry) => {
    const debtLabel = debtCategoryLabel(entry, accountOptionById, t);
    if (debtLabel) return debtLabel;
    const entryFundProductType =
      entry.fundProductType ??
      (entry.toAccountId ? investmentProductTypeByAccountId[entry.toAccountId] : undefined) ??
      (entry.accountId ? investmentProductTypeByAccountId[entry.accountId] : undefined) ??
      null;
    if (entryFundProductType === "property" && entry.type === "investment") return systemCategoryLabel(entry.categoryName, t);
    if (entry.type === "investment") return investmentCategoryLabel(entry, entryFundProductType, t);
    if (isCreditCardRepaymentDisplayEntry(entry)) return t("transaction.category.creditCardRepayment");
    if (isLicensedInsuranceEntry(entry)) return getInsuranceDetailCategoryName(entry);
    return systemCategoryLabel(entry.categoryName, t);
  }, [accountOptionById, investmentProductTypeByAccountId, t]);
  const [refreshedEntries, setRefreshedEntries] = useState<{ accountId: string; entries: DetailEntry[] } | null>(null);
  const [linkingIds, setLinkingIds] = useState<Set<string>>(new Set());
  const entries = refreshedEntries?.accountId === accountId ? refreshedEntries.entries : initialEntries;
  const linkDetailCashFlow = useCallback(async (entry: DetailEntry) => {
    const id = String(entry.id ?? "").trim();
    if (!id || linkingIds.has(id)) return;
    const businessTransactionId = String(entry.businessTransactionId ?? "").trim();
    const businessType =
      entry.fundProductType === "wealth"
        ? "wealth"
        : entry.fundProductType === "deposit"
          ? "deposit"
          : entry.fundProductType === "metal"
            ? "metal"
            : entry.insuranceProductId || entry.insuranceAction || isLicensedInsuranceEntry(entry)
              ? "insurance"
              : entry.fundProductType === "fund" || entry.fundCode
                ? "fund"
                : null;
    if (!businessType) {
      window.alert(t("detailView.alert.missingBusinessType"));
      return;
    }
    if (!businessTransactionId) {
      window.alert(t("detailView.alert.missingBusinessId"));
      return;
    }
    setLinkingIds((prev) => new Set(prev).add(id));
    try {
      const res = await fetch("/api/v1/business-transactions/link-cash-flow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessType, businessTransactionId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? t("detailView.alert.linkFailed"));
      dispatchFinanceDataChanged({ reason: "detail-link-cash-flow", entryIds: [data.data?.cashEntryId, id].filter(Boolean) });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("detailView.alert.linkFailed"));
    } finally {
      setLinkingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [linkingIds, t]);
  const navigateToAccountEntry = useCallback((targetAccountId: string | null | undefined, entry: DetailEntry) => {
    const target = String(targetAccountId ?? "").trim();
    if (!enableAccountNavigation || !target) return;
    const params = new URLSearchParams({
      accountId: target,
      view: "detail",
      pageSize: "40",
      focusEntryId: entry.id,
    });
    window.location.assign(`/?${params.toString()}`);
  }, [enableAccountNavigation]);

  const renderNavigableAccountLabel = useCallback((
    entry: DetailEntry,
    targetAccountId: string | null | undefined,
    label: string | null | undefined,
    title: string | null | undefined,
    className: string,
  ) => {
    const text = label || "";
    if (!enableAccountNavigation || !targetAccountId) {
      return <span className={className} title={title ?? ""}>{text || <span className="text-slate-300">-</span>}</span>;
    }
    return (
      <span
        data-row-double-click-ignore
        className={`${className} cursor-zoom-in decoration-dotted underline-offset-4 hover:underline`}
        title={t("detailView.navigateAccountTitle", { name: title || text })}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          navigateToAccountEntry(targetAccountId, entry);
        }}
      >
        {text || <span className="text-slate-300">-</span>}
      </span>
    );
  }, [enableAccountNavigation, navigateToAccountEntry]);

  useEffect(() => {
    const target = String(focusEntryId ?? "").trim();
    if (!target) return;
    const frame = window.requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-advanced-row-key="${cssEscape(target)}"]`);
      row?.scrollIntoView({ block: "center", inline: "nearest" });
      const url = new URL(window.location.href);
      if (url.searchParams.get("focusEntryId") === target) {
        url.searchParams.delete("focusEntryId");
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entries, focusEntryId]);

  const linkedInvestmentCandidateEntries = useMemo(
    () => entries
      .filter((entry) => entry.type === "investment" && entry.fundCode && entry.fundSubtype)
      .map((entry) => ({
        id: entry.id,
        date: (entry.date ?? "").slice(0, 10),
        createdAt: entry.createdAt ?? null,
        fundConfirmDate: entry.fundConfirmDate?.slice(0, 10) ?? null,
        fundArrivalDate: entry.fundArrivalDate?.slice(0, 10) ?? null,
        fundSourceEntryId: entry.fundSourceEntryId ?? null,
        fundCode: entry.fundCode ?? "",
        fundSubtype: entry.fundSubtype ?? "",
        fundUnits: entry.fundUnits != null ? toNumber(entry.fundUnits) : null,
        source: entry.source ?? null,
        accountId: entry.accountId,
        toAccountId: entry.toAccountId,
        amount: toNumber(entry.amount),
      })),
    [entries],
  );
  const buildEntryEditRequest = useCallback((e: DetailEntry): {
    edit?: Omit<EditPayload, "entryId">;
    customEditEvent?: { name: string; detail: Record<string, unknown> };
  } => {
    const dateStr = (e.date ?? "").slice(0, 10);
    const amount = toNumber(e.amount);
    const linkedBusinessLabels = e.businessLinkLabels ?? [];
    const linkedStockTransaction = e.stockTransaction ?? null;
    if (linkedStockTransaction || e.stockTransactionId) {
      if (!linkedStockTransaction) return {};
      return {
        customEditEvent: {
          name: "mmh:stock:edit",
          detail: {
            requestId: `edit-${linkedStockTransaction.id}-${Date.now()}`,
            transaction: {
              id: linkedStockTransaction.id,
              stockAccountId: linkedStockTransaction.stockAccountId,
              cashAccountId: linkedStockTransaction.cashAccountId ?? e.cashAccountId ?? e.accountId ?? null,
              securityId: linkedStockTransaction.securityId ?? null,
              market: linkedStockTransaction.market || "CN",
              stockCode: linkedStockTransaction.stockCode || "",
              stockName: linkedStockTransaction.stockName ?? null,
              action: linkedStockTransaction.action || "buy",
              tradeDate: linkedStockTransaction.tradeDate || dateStr,
              settleDate: linkedStockTransaction.settleDate ?? null,
              grossAmount: linkedStockTransaction.grossAmount ?? null,
              netAmount: linkedStockTransaction.netAmount ?? null,
              quantity: linkedStockTransaction.quantity ?? null,
              price: linkedStockTransaction.price ?? null,
              brokerTradeId: linkedStockTransaction.brokerTradeId ?? null,
              note: linkedStockTransaction.note ?? e.businessNote ?? e.note ?? null,
            },
          },
        },
      };
    }
    const linkedFundProductType = linkedBusinessLabels.includes("理财交易")
      ? "wealth"
      : linkedBusinessLabels.includes("存款交易")
        ? "deposit"
        : linkedBusinessLabels.includes("贵金属交易")
          ? "metal"
          : linkedBusinessLabels.includes("基金交易")
            ? "fund"
            : null;
    const entryFundProductType =
      e.fundProductType ??
      linkedFundProductType ??
      (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
      (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
      null;
    const isRedeemEditEntry =
      e.fundSubtype === "redeem" ||
      e.fundSubtype === "switch_out" ||
      isRegularInvestRefundEntry(e) ||
      (e.type === "investment" &&
        !e.fundSubtype &&
        Boolean(e.toAccountId) &&
        entryFundProductType != null &&
        investmentProductTypeByAccountId[e.accountId ?? ""] === entryFundProductType);
    const targetInvestmentEditEntryId =
      isRegularInvestRefundEntry(e) && e.fundSourceEntryId
        ? e.fundSourceEntryId
        : e.id;
    const investmentEditPayload =
      e.type !== "investment" || !allowInvestmentEdit
        ? undefined
        : {
            targetEntryId: targetInvestmentEditEntryId,
            transactionId: e.id,
            cashEntryId: e.cashEntryId ?? e.id,
            businessTransactionId: e.businessTransactionId ?? null,
            date: dateStr,
            confirmDate: e.fundConfirmDate?.slice(0, 10),
            type: e.type,
            amount,
            note: entryFundProductType === "wealth" ? e.businessNote ?? "" : e.note ?? "",
            fundCode: e.fundCode ?? undefined,
            fundName: e.fundName ?? undefined,
            wealthProductId: e.wealthProductId ?? null,
            insuranceProductId: e.insuranceProductId ?? null,
            insuranceAction: e.insuranceAction === "premium" || e.insuranceAction === "additional_premium" || e.insuranceAction === "refund" ? e.insuranceAction : undefined,
            insuranceProductName: e.insuranceProductName ?? undefined,
            fundUnits: e.fundUnits != null ? toNumber(e.fundUnits) : undefined,
            fundNav: e.fundNav != null ? toNumber(e.fundNav) : undefined,
            depositAnnualRate: e.depositAnnualRate != null ? toNumber(e.depositAnnualRate) : undefined,
            depositInterest: e.depositInterest != null ? toNumber(e.depositInterest) : undefined,
            depositSourceEntryId: e.depositSourceEntryId ?? null,
            fundFee: e.fundFee != null ? toNumber(e.fundFee) : undefined,
            fundProductType: entryFundProductType ?? undefined,
            metalTypeId: e.metalTypeId ?? null,
            metalTypeName: e.metalTypeName ?? null,
            metalUnitId: e.metalUnitId ?? null,
            metalUnitName: e.metalUnitName ?? null,
            metalQuantity: e.metalQuantity ?? null,
            metalUnitPrice: e.metalUnitPrice ?? null,
            metalFee: e.metalFee ?? null,
            fundSubtype: e.fundSubtype ?? (isRedeemEditEntry ? "redeem" : undefined),
            source: e.source,
            accountId: e.accountId ?? undefined,
            toAccountId: e.toAccountId ?? undefined,
            cashAccountId: (isRedeemEditEntry ? e.toAccountId : e.accountId) ?? undefined,
            toAccountName: e.toAccountName ?? undefined,
            fundArrivalDate: e.fundArrivalDate?.slice(0, 10),
            fundSourceEntryId: e.fundSourceEntryId ?? null,
            fundArrivalAmount: e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null,
            linkedCandidateEntries: linkedInvestmentCandidateEntries,
          } satisfies Omit<EditPayload, "entryId">;

    const balanceReconcileTarget = getBalanceReconcileTarget(e);
    const balanceReconcileEditEvent = balanceReconcileTarget == null || (e.source !== BALANCE_RECONCILE_SOURCE && e.source !== BALANCE_INITIALIZATION_SOURCE) ? undefined : {
      name: "mmh:balance-reconcile:edit",
      detail: {
        entryId: e.id,
        accountId: e.accountId,
        accountName: e.accountName,
        date: dateStr,
        amount: balanceReconcileTarget,
        source: e.source,
      },
    };
    const debtMode = inferDebtMode(e, accountOptionById);
    const isDebtActivity = isDebtActivityEntry(e, accountOptionById);
    const debtPrincipalAmount = e.debtPrincipalAmount == null ? Math.abs(toNumber(e.amount)) : toNumber(e.debtPrincipalAmount);
    const debtInterestAmount = Math.abs(toNumber(e.realizedProfit ?? e.debtInterestAmount ?? 0));
    const debtFeeAmount = Math.abs(toNumber(e.debtFeeAmount ?? 0));
    const isDebtAccountFromSide = debtMode === "borrow_in" || debtMode === "collect_in";
    const debtAccountIdForEdit = isDebtAccountFromSide ? (e.accountId ?? "") : (e.toAccountId ?? "");
    const cashAccountIdForEdit = isDebtAccountFromSide ? (e.toAccountId ?? "") : (e.accountId ?? "");
    const debtEditDialogType =
      (e.accountKind === "loan" && !e.accountIsSettlementDebt) ||
      (e.toAccountKind === "loan" && !e.toAccountIsSettlementDebt)
        ? "loan"
        : "debt";
    const debtEditEvent =
      !balanceReconcileEditEvent && isDebtActivity && debtMode
        ? {
            name: debtEditDialogType === "loan" ? "mmh:loan:create" : "mmh:debt:create",
            detail: {
              editEntryId: e.id,
              mode: debtMode,
              dialogType: debtEditDialogType,
              defaultDebtAccountId: debtAccountIdForEdit,
              defaultCashAccountId: cashAccountIdForEdit,
              defaultLoanFundingMode: e.source === "debt_financed_purchase" ? "financed_purchase" : "cash_disbursement",
              defaultDate: dateStr,
              defaultPrincipal: debtPrincipalAmount,
              defaultInterest: debtInterestAmount,
              defaultPenalty: debtFeeAmount,
              defaultNote: e.note ?? "",
              defaultPrepayStrategy: e.source === "debt_prepay_out"
                ? parseLoanPrepayStrategy(e.toNote) ?? DEFAULT_LOAN_PREPAY_STRATEGY
                : undefined,
            },
          }
        : undefined;

    if (balanceReconcileEditEvent || debtEditEvent) return { customEditEvent: balanceReconcileEditEvent ?? debtEditEvent };
    return { edit: e.type === "investment" ? investmentEditPayload : buildBasicEntryEditPayload(e, accountId) };
  }, [accountId, accountOptionById, allowInvestmentEdit, investmentProductTypeByAccountId, linkedInvestmentCandidateEntries]);
  const colorScheme =
    typeof document === "undefined"
      ? "red_up_green_down"
      : getColorSchemeFromCookie(document.cookie ?? null);
  const inflowCls = pnlColor(1, colorScheme);
  const outflowCls = pnlColor(-1, colorScheme);
  const { selectedIds, setSelection } = useBasicDetailSelection();
  const selectedCount = selectedIds.size;
  const currentEntryIds = useMemo(() => entries.map((entry) => entry.id), [entries]);
  const selectedFlowSummary = useMemo(() => {
    const inflowByCurrency = new Map<string, number>();
    const outflowByCurrency = new Map<string, number>();
    for (const entry of entries) {
      if (!selectedIds.has(entry.id)) continue;
      const amount = effectiveAmountForAccount(entry, accountId);
      const currency = entryCurrency(entry);
      if (!inflowByCurrency.has(currency)) inflowByCurrency.set(currency, 0);
      if (!outflowByCurrency.has(currency)) outflowByCurrency.set(currency, 0);
      if (amount > 0) {
        inflowByCurrency.set(currency, (inflowByCurrency.get(currency) ?? 0) + amount);
      } else if (amount < 0) {
        outflowByCurrency.set(currency, (outflowByCurrency.get(currency) ?? 0) - amount);
      }
    }
    return {
      inflow: formatSelectedAmountsByCurrency(inflowByCurrency),
      outflow: formatSelectedAmountsByCurrency(outflowByCurrency),
    };
  }, [accountId, entries, selectedIds]);
  const selectedCategoryTypes = useMemo(() => {
    const types = new Set<string>();
    for (const entry of entries) {
      if (!selectedIds.has(entry.id)) continue;
      const categoryType = batchCategoryTypeForEntry(entry);
      if (categoryType) types.add(categoryType);
    }
    return Array.from(types);
  }, [entries, selectedIds]);
  usePruneBasicDetailSelection(currentEntryIds);
  const detailRefreshSeqRef = useRef(0);
  const lastResetKeyRef = useRef<string | undefined>(resetKey);

  const persistEntryReorder = useCallback(async (payload: { entryId: string; targetEntryId: string; targetPosition: AdvancedDataTableDropPosition }) => {
    const res = await fetch("/api/v1/transactions/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, accountIds: reorderAccountIds, ...payload }),
    });
    const data = (await res.json().catch(() => null)) as ReorderResponse | null;
    if (!data?.ok) {
      throw new Error(data?.error ?? t("detailView.alert.reorderFailed"));
    }
    return data;
  }, [accountId, reorderAccountIds, t]);

  const canDropDetailEntry = useCallback((source: DetailEntry, target: DetailEntry, position?: AdvancedDataTableDropPosition) => {
    void position;
    return (
    canManuallyReorderDetailEntry(source) &&
    canManuallyReorderDetailEntry(target) &&
    detailEntryDayKey(source, accountId) === detailEntryDayKey(target, accountId)
    );
  }, [accountId]);

  const rowDropTargetAtEnd = useCallback((source: DetailEntry, sourceIndex: number, orderedRows: DetailEntry[]) => {
    const sourceDayKey = detailEntryDayKey(source, accountId);
    let targetIndex = -1;
    for (let index = 0; index < orderedRows.length; index += 1) {
      const candidate = orderedRows[index];
      if (detailEntryDayKey(candidate, accountId) !== sourceDayKey) continue;
      if (!canDropDetailEntry(source, candidate, "after")) continue;
      targetIndex = index;
    }
    if (targetIndex < 0 || targetIndex === sourceIndex) return null;
    return { row: orderedRows[targetIndex], index: targetIndex };
  }, [accountId, canDropDetailEntry]);

  const reorderEntryByDrag = useCallback(async (source: DetailEntry, target: DetailEntry, position: AdvancedDataTableDropPosition) => {
    if (source.id === target.id) return;
    if (!canManuallyReorderDetailEntry(source) || !canManuallyReorderDetailEntry(target)) return;
    if (detailEntryDayKey(source, accountId) !== detailEntryDayKey(target, accountId)) {
      window.alert(t("detailView.alert.reorderSameDayOnly"));
      return;
    }
    if (!canDropDetailEntry(source, target, position)) return;
    const previousEntries = entries;
    const nextEntries = reorderEntriesToTarget(entries, source.id, target.id, position);
    if (nextEntries === entries) return;
    detailRefreshSeqRef.current += 1;
    setRefreshedEntries({ accountId, entries: nextEntries });
    try {
      const data = await persistEntryReorder({ entryId: source.id, targetEntryId: target.id, targetPosition: position });
      if (data.orderedEntryIds?.length || data.runningBalances) {
        setRefreshedEntries((current) => {
          const currentEntries = current?.accountId === accountId ? current.entries : nextEntries;
          const orderedEntries = applyServerEntryOrder(currentEntries, data.orderedEntryIds ?? []);
          return {
            accountId,
            entries: showRunningBalance
              ? applyServerRunningBalances(orderedEntries, data.runningBalances)
              : orderedEntries,
          };
        });
      }
    } catch (error) {
      setRefreshedEntries({ accountId, entries: previousEntries });
      window.alert(error instanceof Error ? error.message : t("detailView.alert.reorderFailed"));
    }
  }, [accountId, canDropDetailEntry, entries, persistEntryReorder, showRunningBalance, t]);

  useEffect(() => {
    setRefreshedEntries((current) => (current?.accountId === accountId ? current : null));
  }, [accountId]);

  useEffect(() => {
    if (resetKey == null) return;
    if (lastResetKeyRef.current === resetKey) return;
    lastResetKeyRef.current = resetKey;
    setRefreshedEntries(null);
    setSelection(new Set());
  }, [resetKey, setSelection]);

  // Listen for financial data changes → re-fetch from detail API
  useEffect(() => {
    if (!refreshOnGlobalEvent) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ accountIds?: string[]; deletedEntryIds?: string[] }>).detail ?? {};
      const eventAccountIds = detail.accountIds ?? [];
      if (eventAccountIds.length > 0 && !eventAccountIds.includes(accountId)) return;
      const deletedEntryIds = detail.deletedEntryIds ?? [];
      if (deletedEntryIds.length > 0) {
        const deletedSet = new Set(deletedEntryIds);
        detailRefreshSeqRef.current += 1;
        setRefreshedEntries((current) => {
          const currentEntries = current?.accountId === accountId ? current.entries : entries;
          return { accountId, entries: removeEntriesAndUpdateRunningBalances(currentEntries, deletedSet, accountId) };
        });
        setSelection(new Set());
        return;
      }
      const url = new URL(window.location.href);
      const storedPagination = readStoredDetailPreference(accountId);
      const detailAll = url.searchParams.has("detailAll")
        ? url.searchParams.get("detailAll") === "1"
        : storedPagination?.detailAll ?? false;
      const detailPage = normalizeDetailPage(
        url.searchParams.get("detailPage") ?? storedPagination?.detailPage ?? 1,
      );
      const pageSize = normalizeDetailPageSize(
        url.searchParams.get("pageSize") ?? storedPagination?.pageSize ?? 20,
      );
      const params = new URLSearchParams({
        accountId,
        page: detailAll ? "1" : String(detailPage),
        pageSize: detailAll ? String(DETAIL_ALL_PAGE_SIZE) : String(pageSize),
      });
      const seq = ++detailRefreshSeqRef.current;
      fetch(`/api/v1/transactions/detail?${params.toString()}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((data) => {
          if (seq !== detailRefreshSeqRef.current) return;
          if (data?.ok && Array.isArray(data?.data?.entries)) {
            setRefreshedEntries({ accountId, entries: data.data.entries });
            setSelection(new Set());
          }
        })
        .catch(() => {});
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
    return () => window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, handler);
  }, [accountId, entries, refreshOnGlobalEvent, setSelection]);

  const columns = useMemo<AdvancedDataTableColumn<DetailEntry>[]>(() => [
    {
      key: "date",
      label: t("detail.column.date"),
      width: 96,
      minWidth: 78,
      filterKind: "dateRange",
      filterText: (e) => localDateKey(getDetailEntryDisplayDate(e, accountId)),
      sortValue: (e) => getDetailEntryDisplayDate(e, accountId).getTime(),
      render: (e) => <span className="tabular-nums text-slate-600">{formatDateDisplay(getDetailEntryDisplayDate(e, accountId), dateDisplayFormat)}</span>,
    },
    ...(showAccountColumn ? [{
      key: "account",
      label: resolvedAccountColumnLabel,
      width: accountColumnMode === "cardLast4" ? 82 : 190,
      minWidth: accountColumnMode === "cardLast4" ? 64 : 110,
      hideable: true,
      defaultHidden: accountColumnDefaultHidden,
      filterText: (e: DetailEntry) => accountColumnDisplayFallback(e).label,
      filterTitle: (e: DetailEntry) => accountColumnDisplayFallback(e).title,
      filterSearchText: (e: DetailEntry) => {
        const option = accountColumnDisplayFallback(e);
        return [option.label, option.title, e.accountName, e.toAccountName].filter(Boolean).join(" ");
      },
      render: (e: DetailEntry) => {
        const option = accountColumnDisplayFallback(e);
        const text = option.label;
        const title = option.title;
        return renderNavigableAccountLabel(e, option.id, text, title, "block truncate text-slate-600");
      },
    } satisfies AdvancedDataTableColumn<DetailEntry>] : []),
    {
      key: "postedAt",
      label: t("detail.column.postedAt"),
      width: 132,
      minWidth: 110,
      hideable: true,
      filterKind: "dateRange",
      filterText: (e) => (e.postedAt ?? "").slice(0, 10),
      render: (e) => (
        <span className="tabular-nums text-slate-500">
          {e.postedAt ? formatDateDisplay(e.postedAt, dateDisplayFormat) : ""}
        </span>
      ),
    },
    {
      key: "inflow",
      label: t("detail.column.inflow"),
      width: 96,
      minWidth: 76,
      align: "right",
      filterKind: "numberRange",
      filterText: (e) => {
        const amount = effectiveAmountForAccount(e, accountId);
        return amount > 0 ? String(amount) : "";
      },
      filterNumber: (e) => {
        const amount = effectiveAmountForAccount(e, accountId);
        return amount > 0 ? amount : null;
      },
      sortValue: (e) => {
        const amount = effectiveAmountForAccount(e, accountId);
        return amount > 0 ? amount : null;
      },
      render: (e) => {
        const effectiveAmount = effectiveAmountForAccount(e, accountId);
        const inflow = effectiveAmount > 0 ? effectiveAmount : null;
        return <span className={`whitespace-nowrap tabular-nums ${inflow !== null ? inflowCls : "text-slate-700"}`}>{inflow !== null ? formatEntryCurrencyMoney(inflow, e) : ""}</span>;
      },
    },
    {
      key: "outflow",
      label: t("detail.column.outflow"),
      width: 96,
      minWidth: 76,
      align: "right",
      filterKind: "numberRange",
      filterText: (e) => {
        const amount = effectiveAmountForAccount(e, accountId);
        return amount < 0 ? String(-amount) : "";
      },
      filterNumber: (e) => {
        const amount = effectiveAmountForAccount(e, accountId);
        return amount < 0 ? -amount : null;
      },
      sortValue: (e) => {
        const amount = effectiveAmountForAccount(e, accountId);
        return amount < 0 ? -amount : null;
      },
      render: (e) => {
        const effectiveAmount = effectiveAmountForAccount(e, accountId);
        const outflow = effectiveAmount < 0 ? -effectiveAmount : null;
        return <span className={`whitespace-nowrap tabular-nums ${outflow !== null ? outflowCls : "text-slate-700"}`}>{outflow !== null ? formatEntryCurrencyMoney(outflow, e) : ""}</span>;
      },
    },
    {
      key: "currency",
      label: t("detail.column.currency"),
      width: 68,
      minWidth: 54,
      hideable: true,
      filterText: (e) => entryCurrency(e),
      render: (e) => <span className="block truncate text-center font-medium tabular-nums text-slate-500">{entryCurrency(e)}</span>,
    },
    {
      key: "type",
      label: t("detailView.column.type"),
      width: 96,
      minWidth: 74,
      filterText: (e) => {
        const entryFundProductType =
          e.fundProductType ??
          (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
          (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
          null;
        const displaySource = entryFundProductType === "deposit" ? "deposit" : e.source;
        if (isDebtActivityEntry(e, accountOptionById)) return t("transaction.type.transfer");
        if (entryFundProductType === "property" && e.type === "investment") {
          const ordinaryType = propertyIncomeExpenseType(e);
          if (ordinaryType) return formatType(ordinaryType, t);
        }
        if (e.type === "investment") return t("transaction.type.investment");
        const balanceTarget = getBalanceReconcileTarget(e);
        return activityLabel(e.type, e.fundSubtype, displaySource, t, balanceTarget);
      },
      render: (e) => {
        const isDebtActivity = isDebtActivityEntry(e, accountOptionById);
        const entryFundProductType =
          e.fundProductType ??
          (e.toAccountId ? investmentProductTypeByAccountId[e.toAccountId] : undefined) ??
          (e.accountId ? investmentProductTypeByAccountId[e.accountId] : undefined) ??
          null;
        const displaySource = entryFundProductType === "deposit" ? "deposit" : e.source;
        const balanceTarget = getBalanceReconcileTarget(e);
        const ordinaryPropertyType = entryFundProductType === "property" && e.type === "investment" ? propertyIncomeExpenseType(e) : null;
        const actLabel = isDebtActivity
          ? t("transaction.type.transfer")
          : ordinaryPropertyType
            ? formatType(ordinaryPropertyType, t)
            : e.type === "investment"
              ? t("transaction.type.investment")
              : activityLabel(e.type, e.fundSubtype, displaySource, t, balanceTarget);
        return (
          <>
            {balanceTarget != null && e.source === BALANCE_INITIALIZATION_SOURCE ? (
              <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] font-medium text-slate-600">
                {t("detailView.initialBalance")}
              </span>
            ) : e.source === BALANCE_RECONCILE_SOURCE ? (
              <span className="rounded bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-700">
                {t("detailView.balanceReconcile")}
              </span>
            ) : (
              <span className="text-slate-700">{actLabel}</span>
            )}
          </>
        );
      },
    },
    {
      key: "category",
      label: t("detail.column.category"),
      width: 140,
      minWidth: 90,
      filterText: (e) => detailCategoryLabel(e),
      render: (e) => {
        const text = detailCategoryLabel(e);
        return <span className="block truncate text-slate-500" title={text}>{text || <span className="text-slate-300">-</span>}</span>;
      },
    },
    {
      key: "counterpartyInstitution",
      label: t("detail.column.counterparty"),
      width: 140,
      minWidth: 96,
      hideable: true,
      defaultHidden: true,
      filterText: (e) => e.counterpartyInstitutionName ?? "",
      render: (e) => <span className="block truncate text-slate-500" title={e.counterpartyInstitutionName ?? ""}>{e.counterpartyInstitutionName || <span className="text-slate-300">-</span>}</span>,
    },
    {
      key: "related",
      label: t("detail.column.relatedAccount"),
      width: 190,
      minWidth: 100,
      hideable: true,
      defaultHidden: relatedAccountDefaultHidden,
      filterText: (e) => {
        const related = relatedAccountTarget(e);
        return accountDisplayFallback(related.id, related.name).label;
      },
      filterTitle: (e) => {
        const related = relatedAccountTarget(e);
        return accountDisplayFallback(related.id, related.name).title;
      },
      filterSearchText: (e) => {
        const related = relatedAccountTarget(e);
        const selected = accountDisplayFallback(related.id, related.name);
        return [
          selected.label,
          selected.title,
          related.name,
        ].filter(Boolean).join(" ");
      },
      render: (e) => {
        const related = relatedAccountTarget(e);
        const display = accountDisplayFallback(related.id, related.name);
        return renderNavigableAccountLabel(e, related.id, display.label, display.title, "block truncate text-slate-500");
      },
    },
    ...(showRunningBalance ? [{
      key: "balance",
      label: t("detail.column.balance"),
      width: 110,
      minWidth: 82,
      align: "right" as const,
      hideable: true,
      defaultHidden: runningBalanceDefaultHidden,
      render: (e: DetailEntry) => <span className="whitespace-nowrap tabular-nums text-slate-700">{e.runningBalance != null ? formatEntryCurrencyMoney(toNumber(e.runningBalance), e) : ""}</span>,
    } satisfies AdvancedDataTableColumn<DetailEntry>] : []),
    {
      key: "profit",
      label: t("reports.stock.realizedProfit"),
      width: 110,
      minWidth: 82,
      align: "right" as const,
      hideable: true,
      defaultHidden: false,
      filterNumber: (e) => e.realizedProfit ?? null,
      sortValue: (e) => e.realizedProfit ?? null,
      render: (e: DetailEntry) => {
        const profit = e.realizedProfit;
        return <span className={`whitespace-nowrap tabular-nums ${profit == null ? "text-slate-300" : pnlColor(profit, colorScheme)}`}>{profit == null ? "" : formatEntryCurrencyMoney(profit, e)}</span>;
      },
    } satisfies AdvancedDataTableColumn<DetailEntry>,
    {
      key: "tags",
      label: t("detail.column.tags"),
      width: 150,
      minWidth: 90,
      hideable: true,
      filterText: (e) => e.entryTags?.map((et) => et.Tag?.name ?? "").join(" ") ?? "",
      render: (e) => e.entryTags && e.entryTags.length > 0 ? (
        <span className="inline-flex flex-wrap gap-0.5">
          {e.entryTags.map((et) => {
            const c = et.Tag?.color || "#3B82F6";
            return (
              <span
                key={et.tagId}
                className="rounded-full border px-1 py-0.5 text-[10px] leading-none"
                style={{ backgroundColor: c + "18", color: c, borderColor: c + "60" }}
              >
                {et.Tag?.name}
              </span>
            );
          })}
        </span>
      ) : null,
    },
    {
      key: "remark",
      label: t("detail.column.remark"),
      width: 220,
      minWidth: 120,
      hideable: true,
      filterText: (e) => displayDetailRemark(e, accountId),
      render: (e) => {
        const text = displayDetailRemark(e, accountId);
        return <span className="block truncate text-slate-500" title={text}>{text}</span>;
      },
    },
  ], [accountColumnDefaultHidden, accountColumnDisplayFallback, resolvedAccountColumnLabel, accountColumnMode, accountDisplayFallback, accountId, accountOptionById, dateDisplayFormat, detailCategoryLabel, inflowCls, investmentProductTypeByAccountId, outflowCls, relatedAccountDefaultHidden, relatedAccountTarget, renderNavigableAccountLabel, runningBalanceDefaultHidden, showAccountColumn, showRunningBalance, t]);

  const customToolbarLeft = toolbarMode === "custom" ? (
    <div className="flex min-w-0 items-center gap-2">
      {selectedCount > 0 ? <BasicDetailBatchReplaceButton fields={batchReplaceFields} accountOptions={accountOptions} categoryOptions={categoryOptions} tagOptions={tagOptions} categoryTypes={selectedCategoryTypes} contextAccountId={accountId} contextAccountIds={accountColumnScopeIdList} /> : null}
      {selectedCount > 0 ? <BasicDetailBatchDeleteButton /> : null}
      {selectedCount > 0 ? <span className="text-xs font-medium text-slate-600">{tf("detail.selectedCount", { count: selectedCount })}</span> : null}
      {selectedCount > 0 ? <span className={`text-xs font-medium ${inflowCls}`}>{t("detail.column.inflow")} {selectedFlowSummary.inflow}</span> : null}
      {selectedCount > 0 ? <span className={`text-xs font-medium ${outflowCls}`}>{t("detail.column.outflow")} {selectedFlowSummary.outflow}</span> : null}
      {selectedCount === 0 && toolbarTitle ? <div className="text-sm font-semibold text-slate-800">{toolbarTitle}</div> : null}
    </div>
  ) : undefined;
  const tableResetKey = resetKey ?? `${accountId}:detail-table`;
  const mobileGroups = useMemo(() => {
    const groups: Array<{ date: string; entries: DetailEntry[] }> = [];
    for (const entry of entries) {
      const date = detailEntryDayKey(entry, accountId) || t("detailView.noDate");
      const current = groups[groups.length - 1];
      if (current?.date === date) current.entries.push(entry);
      else groups.push({ date, entries: [entry] });
    }
    return groups;
  }, [accountId, entries, t]);

  return (
    <>
    <div className="h-full overflow-y-auto bg-slate-100 md:hidden">
      {mobileGroups.length > 0 ? (
        <div className="pb-4">
          {mobileGroups.map((group, groupIndex) => (
            <section key={`${group.date}:${group.entries[0]?.id ?? groupIndex}`} className={detailDateBackground ? (groupIndex % 2 === 0 ? "bg-sky-50/30" : "bg-emerald-50/30") : undefined}>
              <div className="sticky top-0 z-10 border-y border-slate-200 bg-slate-100/96 px-3 py-1.5 text-xs font-semibold text-slate-500 backdrop-blur">
                {formatDateDisplay(group.date, dateDisplayFormat)}
              </div>
              <div className="divide-y divide-slate-100 bg-white">
                {group.entries.map((entry, entryIndex) => {
                  const effectiveAmount = effectiveAmountForAccount(entry, accountId);
                  const entryFundProductType =
                    entry.fundProductType ??
                    (entry.toAccountId ? investmentProductTypeByAccountId[entry.toAccountId] : undefined) ??
                    (entry.accountId ? investmentProductTypeByAccountId[entry.accountId] : undefined) ??
                    null;
                  const category = (
                    debtCategoryLabel(entry, accountOptionById, t) ?? (entry.type === "investment"
                      ? investmentCategoryLabel(entry, entryFundProductType, t)
                      : getInsuranceDetailCategoryName(entry))
                  ) || t("txForm.uncategorized");
                  const note = displayDetailRemark(entry, accountId);
                  const related = relatedAccountTarget(entry);
                  const relatedDisplay = accountDisplayFallback(related.id, related.name);
                  const counterpart = entry.type === "transfer"
                    ? relatedDisplay.label
                    : entry.fundName || note;
                  const { edit, customEditEvent } = buildEntryEditRequest(entry);
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => {
                        if (!edit && !customEditEvent) return;
                        dispatchEntryEdit({ entryId: entry.id, edit, customEditEvent });
                      }}
                      className={`flex min-h-[68px] w-full items-center gap-3 px-3 py-2.5 text-left ${detailDateBackground ? (entryIndex % 2 === 0 ? "bg-white/70" : "bg-white/40") : ""}`}
                    >
                      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ${effectiveAmount >= 0 ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
                        {entry.type === "transfer"
                          ? t("detailView.badgeTransfer")
                          : entry.type === "investment"
                            ? t("detailView.badgeInvestment")
                            : effectiveAmount >= 0
                              ? t("detailView.badgeIncome")
                              : t("detailView.badgeExpense")}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-slate-900">{category}</span>
                        <span className="mt-0.5 block truncate text-xs text-slate-500">{counterpart || note || t("detailView.noNote")}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className={`block text-sm font-semibold tabular-nums ${effectiveAmount >= 0 ? inflowCls : outflowCls}`}>
                          {effectiveAmount >= 0 ? "+" : "-"}{formatEntryCurrencyMoney(Math.abs(effectiveAmount), entry)}
                        </span>
                        {showRunningBalance && entry.runningBalance != null ? (
                          <span className="mt-0.5 block text-[11px] tabular-nums text-slate-400">{t("detailView.runningBalance", { amount: formatEntryCurrencyMoney(toNumber(entry.runningBalance), entry) })}</span>
                        ) : null}
                      </span>
                      <EntryAttachmentIndicator entry={entry} asButton={false} onClick={() => setAttachmentViewEntryId(entry.id)} />
                      <span className="text-slate-300">›</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="flex h-40 items-center justify-center text-sm text-slate-400">{resolvedEmptyText}</div>
      )}
    </div>
    <div className="hidden h-full md:block">
    <AdvancedDataTable
      storageKey={storageKey}
      resetKey={tableResetKey}
      columns={columns}
      rows={entries}
      rowKey={(entry) => entry.id}
      minTableWidth={1160}
      emptyText={resolvedEmptyText}
      selectable
      selectOnRowClick
      selectAllScope="renderedRows"
      selectedKeys={selectedIds}
      onSelectionChange={setSelection}
      onRowDoubleClick={(entry) => {
        const { edit, customEditEvent } = buildEntryEditRequest(entry);
        if (!edit && !customEditEvent) return;
        dispatchEntryEdit({ entryId: entry.id, edit, customEditEvent });
      }}
      draggableRows={draggableRows}
      rowDragDisabled={(entry) => !canManuallyReorderDetailEntry(entry)}
      rowDropAllowed={(source, target, _sourceIndex, _targetIndex, position) => canDropDetailEntry(source, target, position)}
      rowDropTargetAtEnd={rowDropTargetAtEnd}
      onRowReorder={(source, target, _sourceIndex, _targetIndex, position) => reorderEntryByDrag(source, target, position)}
      rowActions={(entry) => {
        const { edit, customEditEvent } = buildEntryEditRequest(entry);
        const linkLabels = entry.businessLinkLabels ?? [];
        const hasBusinessLink = (entry.businessLinkCount ?? 0) > 0;
        const linkTitle = hasBusinessLink
          ? t("detailView.linkedLabel", { labels: linkLabels.join("、") || t("detailView.businessRecord") })
          : t("detailView.notLinked");
        return (
          <>
            <EntryAttachmentIndicator entry={entry} onClick={() => setAttachmentViewEntryId(entry.id)} />
            {shouldShowBusinessLinkStatus(entry) ? (
              <BusinessLinkActionButton
                active={hasBusinessLink}
                title={linkTitle}
                busy={linkingIds.has(entry.id)}
                onClick={() => linkDetailCashFlow(entry)}
              />
            ) : null}
            <EntryRowActions
              entryId={entry.id}
              edit={edit}
              customEditEvent={customEditEvent}
            />
          </>
        );
      }}
      rowActionsWidth={128}
      rowActionsMinWidth={104}
      batchActionSlot={toolbarMode === "default" ? (
        <>
          <BasicDetailBatchReplaceButton fields={batchReplaceFields} accountOptions={accountOptions} categoryOptions={categoryOptions} tagOptions={tagOptions} categoryTypes={selectedCategoryTypes} contextAccountId={accountId} contextAccountIds={accountColumnScopeIdList} />
          <BasicDetailBatchDeleteButton />
        </>
      ) : undefined}
      rowClassName={(entry) => entry.id === focusEntryId
        ? "bg-amber-50 ring-1 ring-inset ring-amber-300 hover:bg-amber-50"
        : "hover:bg-blue-50/40"}
      rowBackgroundEnabled={detailDateBackground}
      rowBackgroundGroupKey={(entry) => detailEntryDayKey(entry, accountId)}
      fillHeight
      compactRows={compactRows}
      toolbarMode={toolbarMode}
      toolbarLeftContent={customToolbarLeft}
      toolbarRightContent={toolbarRightContent}
      showTableStateInCustomToolbar={toolbarMode === "custom"}
      sortable={sortable}
      onDisplayRowsChange={onDisplayRowsChange}
    />
    </div>
    <EntryAttachmentWindow
      open={attachmentViewEntryId != null}
      entryId={attachmentViewEntryId}
      onClose={() => setAttachmentViewEntryId(null)}
    />
    </>
  );
}
