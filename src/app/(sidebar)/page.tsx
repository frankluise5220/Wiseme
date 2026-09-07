import { redirect } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { connection } from "next/server";
import { cookies } from "next/headers";
import { AccountKind, CreditCardInstallmentSourceType, FundCashFlowKind, TransactionType, FundSubtype, RegularInvestStatus } from "@prisma/client";
import { institutionTypeLabel, kindLabel } from "@/lib/account-kinds";
import { TransactionFormModal } from "@/components/TransactionFormModal";
import { InvestmentFormModal } from "@/components/InvestmentFormModal";
import { StockTransactionFormModal } from "@/components/StockTransactionFormModal";
import { StockHoldingsPanel } from "@/components/StockHoldingsPanel";
import { PropertyFormModal } from "@/components/PropertyFormModal";
import { PropertyShell } from "@/components/PropertyShell";
import { WealthFormModal } from "@/components/WealthFormModal";
import { DepositFormModal } from "@/components/DepositFormModal";
import { InsuranceFormModal } from "@/components/InsuranceFormModal";
import { InsuranceEntryEditBridge } from "@/components/InsuranceEntryEditBridge";
import { DebtShell } from "@/components/DebtShell";
import { DebtTransactionModal } from "@/components/DebtTransactionModal";
import { FundShell } from "@/components/FundShell";
import { DepositShell } from "@/components/DepositShell";
import { InsuranceShell } from "@/components/InsuranceShell";
import { RegularInvestForm } from "@/components/RegularInvestForm";
import { DashboardOverview } from "@/components/DashboardOverview";
import { UnifiedEntryLauncher } from "@/components/UnifiedEntryLauncher";
import type { DetailEntry } from "@/components/DetailViewClient";
import { BasicDetailPanel } from "@/components/BasicDetailPanel";
import { CreditBillSummaryTable } from "@/components/CreditBillSummaryTable";
import { CreditBillDetailPanel } from "@/components/CreditBillDetailPanel";
import { ResizableVerticalSplit } from "@/components/ResizableVerticalSplit";


import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { recalcPreciousMetalPositions } from "@/lib/metal/recalcPosition";
import { calculateWealthCashDividendProfit, recalcWealthPositions } from "@/lib/wealth-position";
import { computeAccountDisplayBalances, recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { computeDebtDisplaySummary } from "@/lib/server/debt-display-summary";
import {
  applyDebtRowEntryMetrics,
  buildDebtDetailEntriesViewData,
  buildDebtRepaymentScheduleRows,
  buildDebtRowsViewData,
} from "@/lib/server/debt-view-data";
import { loadCreditBillPageData } from "@/lib/server/credit-bill-page-data";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { prepareEntryUndo, saveEntryUndo } from "@/lib/server/entry-undo";
import { getCreditBillAccountIds } from "@/lib/server/credit-card-institution-settings";
import { getFundArrivalDays, getFundConfirmDays, setFundConfirmDays, setFundArrivalDays } from "@/lib/fund/confirmDays";
import { setFundFeeRateByDate } from "@/lib/fund/feeRate";
import { formatCurrencyMoney, formatMoney } from "@/lib/format";
import { pnlClassFromRedUp } from "@/lib/client/colors";
import { LiveAccountBalance } from "@/components/LiveAccountBalance";
import { AccountFxRateInline } from "@/components/AccountFxRateInline";
import { createFundTransactionWithCashFlows, detachFundTransactionCashFlow, findFundTransactionForEntryId, syncFundTransactionsFromTxRecords, upsertFundTransactionRefundCashFlow, type FundCashFlowInput } from "@/lib/fund/transactions";
import { regularInvestRefundNote } from "@/lib/fund/regular-invest-display";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";
import { getCachedHouseholdScope, getHouseholdScope } from "@/lib/server/household-scope";
import { attachEntryTags, replaceEntryTags } from "@/lib/server/entry-tags";
import { buildEntryBusinessLinkSummary, entryBusinessLinkSummaryInclude, upsertEntryBusinessCashFlowLink } from "@/lib/server/entry-business-link";
import {
  loadDepositTransactionDetailLike,
  loadInsuranceTransactionDetailLike,
  loadWealthTransactionEntryLike,
} from "@/lib/server/business-transaction-entries";
import { getInsuranceDetailCategoryName, getInsuranceDetailNote } from "@/lib/insurance/detail-display";
import { systemCategoryLabel } from "@/lib/system-category-labels";
import { compareCategoryOrder, sortCategorySources } from "@/components/categorySmartSelect";
import { computeInsuranceAccountDisplayBalances } from "@/lib/insurance/balance";
import { insuranceCashValueDelta } from "@/lib/insurance/transaction";
import { loadCommonData, loadSelectedAccount, loadEntriesForAccount, loadInvestAccountData, loadInvestBalances, loadFixedAssetPositionDisplay, loadFixedAssetTransactionEntries } from "@/lib/server/cached-data";
import { computePositionDisplay } from "@/lib/invest-balance";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import { compareDetailEntriesAsc, compareDetailEntriesDesc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import {
  SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE,
  buildAccountDisplayOption,
  buildFlatAccountOptions,
  normalizeCreditCardLabelTemplate,
} from "@/lib/account-display";
import { getInvestmentAccountView, isDepositAccount, isPureInvestmentAccount, isSpecialCashTargetAccount } from "@/lib/account-kind-utils";
import { normalizeFixedAssetType } from "@/lib/fixed-asset";
import { normalizeLoanType, resolveLoanTypeValue } from "@/lib/loan-type";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { resolveOrCreateDepositAccount } from "@/lib/server/deposit-account";
import { resolveOrCreateWealthAccount } from "@/lib/server/wealth-account";
import { resolveOrCreateAdvanceAccount } from "@/lib/server/advance-account";
import { createCreditCardInstallmentPlan } from "@/lib/server/credit-card-installment";
import { regularInvestFormAction } from "@/lib/server/sidebar-actions/regular-invest-actions";
import { fillFundNavFromCache } from "@/lib/server/sidebar-actions/fund-actions";
import { createDebtTransaction } from "@/lib/server/sidebar-actions/debt-actions";
import { createTransaction, editInvestment, updateTransactionFromDialog } from "@/lib/server/sidebar-actions/transaction-actions";
import {
  listLoanRateAdjustmentsByAccountIds,
} from "@/lib/server/loan-rate-adjustments";
import { getInsuranceDisplayTypeLabel, getInsuranceMetricLabel, getInsuranceMetricMode } from "@/lib/insurance/display";
import { BALANCE_INITIALIZATION_SOURCE, BALANCE_RECONCILE_SOURCE, applyBalanceReconcileEntry, effectiveAmountForAccount, getBalanceReconcileTarget } from "@/lib/balance-reconcile";
import { ENTRY_ORIGIN_MANUAL, isCreditCardRepaymentTransfer, statementMonthForTransfer } from "@/lib/transaction-semantics";
import { isLoanOrSettlementAccountKind } from "@/lib/debt";
import { ensureSettlementTransferCategory, resolveCategorySnapshot, resolveCreditCardRepaymentCategory } from "@/lib/default-categories";
import { getInvestmentCategoryName } from "@/lib/investment-category";
import { getCashFlowDate } from "@/lib/cash-flow-date";
import { buildWealthCashFlowNote } from "@/lib/wealth-cash-note";
import { linkExpenseToFixedAsset, syncLinkedFixedAssetTransactionFromCashEntry } from "@/lib/property/transactions";
import { normalizeCurrency, resolveSameCurrencyTransfer } from "@/lib/currency";
import { shouldPreferLoanAutoDebitPlan, shouldPreferLoanScheduledPlan } from "@/lib/scheduled-task";
import { convertCurrencyAmounts, getHouseholdBaseCurrency } from "@/lib/server/fx-rates";
import { resolveAdvanceTransfer } from "@/lib/advance-transfer";
import { findRecentManualTransactionDuplicate } from "@/lib/server/transaction-dedupe";
import { txRecordAccountScopeWhere } from "@/lib/transaction-account-scope";
import {
  DETAIL_ALL_PAGE_SIZE,
  decodeDetailPaginationPreference,
  detailPaginationCookieName,
  normalizeDetailPage,
  normalizeDetailPageSize,
} from "@/lib/detail-pagination-preference";
import type { CreditCardInstallmentRateType } from "@/lib/credit/installment";
import { ACCOUNT_LABEL_FIELDS_COOKIE, accountLabelFieldsFromCookieValue } from "@/lib/server/account-label-fields";
import {
  ACCOUNT_DROPDOWN_RESTRICT_TYPE_COOKIE,
  accountDropdownRestrictTypeFromCookieValue,
} from "@/lib/server/account-dropdown-restrict";
import { getServerT } from "@/lib/server/i18n";
import { touchAccountUsage } from "@/lib/server/account-usage";
import { AccountTypeQuickEdit, type AccountQuickEditValue } from "@/components/AccountTypeQuickEdit";

export const dynamic = "force-dynamic";

import { formatDateLocal, formatDateUtc, toNumber, parseDateInputToUtc } from "@/lib/date-utils";




function formatType(t: (key: string, params?: Record<string, string | number>) => string, type: string) {
  if (type === "expense") return t("transaction.type.expense");
  if (type === "income") return t("transaction.type.income");
  if (type === "advance") return t("txForm.advance");
  if (type === "transfer") return t("transaction.type.transfer");
  if (type === "investment") return t("transaction.type.investment");
  return type;
}

function parseMortgageLprDiscountFromText(value?: string | null) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(/LPR\s*折扣\s*[：:]\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!match?.[1]) return null;
  const discount = Number(match[1]);
  return Number.isFinite(discount) && discount > 0 ? discount : null;
}

type AccountQuickEditSource = {
  id: string;
  name: string;
  kind: unknown;
  currency?: string | null;
  note?: string | null;
  groupId?: string | null;
  institutionId?: string | null;
  counterpartyId?: string | null;
  debtDirection?: string | null;
  isConsumerLoan?: boolean | null;
  loanType?: string | null;
  billingDay?: number | null;
  repaymentDay?: number | null;
  repaymentOffsetDays?: number | null;
  creditLimit?: unknown;
  creditBillMode?: "separate" | "consolidated" | null;
  numberMasked?: string | null;
  investProductType?: string | null;
  costBasisMethod?: string | null;
  fundUnitsDecimals?: number | null;
  tradingCalendar?: string | null;
  fixedAssetType?: string | null;
};

function toAccountQuickEditValue(account: AccountQuickEditSource): AccountQuickEditValue {
  return {
    id: account.id,
    name: account.name,
    kind: String(account.kind),
    currency: account.currency,
    note: account.note,
    groupId: account.groupId,
    institutionId: account.institutionId,
    counterpartyId: account.counterpartyId,
    debtDirection: account.debtDirection,
    isConsumerLoan: account.isConsumerLoan,
    loanType: account.loanType,
    billingDay: account.billingDay,
    repaymentDay: account.repaymentDay,
    repaymentOffsetDays: account.repaymentOffsetDays,
    creditLimit: account.creditLimit == null ? null : String(account.creditLimit),
    creditBillMode: account.creditBillMode,
    numberMasked: account.numberMasked,
    investProductType: account.investProductType,
    costBasisMethod: account.costBasisMethod,
    fundUnitsDecimals: account.fundUnitsDecimals,
    tradingCalendar: account.tradingCalendar,
    fixedAssetType: account.fixedAssetType,
  };
}


import { subtypeDisplay } from "@/lib/investment-config";

type DetailFilterColumn = "date" | "flow" | "type" | "category" | "related" | "remark";

const DETAIL_FILTER_SEPARATOR = "\u001F";

function parseDetailFilterParam(value: string | undefined) {
  if (!value) return [];
  return value.split(DETAIL_FILTER_SEPARATOR).map((v) => v.trim()).filter(Boolean);
}

function fundSubtypeInfo(
  t: (key: string, params?: Record<string, string | number>) => string,
  subtype: string | null | undefined,
  source: string | null | undefined,
  _amount: number,
  fundProductType?: string | null,
) {
  const base = subtypeDisplay(subtype, source);
  const baseLabel = { label: t(base.labelKey), cls: base.cls, textCls: base.textCls };
  if (fundProductType === "deposit") {
    if (subtype === "buy") return { label: t("deposit.subtype.buy"), cls: "bg-blue-50 text-blue-600" };
    if (subtype === "redeem") return { label: t("deposit.subtype.redeem"), cls: "bg-orange-50 text-orange-600" };
  }
  // Source-based overrides for the buy subtype (auto-invest / dividend reinvest / switch in).
  if (subtype === "buy" && source) {
    const srcLabels: Record<string, { label: string; cls: string; textCls?: string }> = {
      regular_invest: { label: t("fund.subtype.regular_invest"), cls: "bg-blue-50 text-blue-600" },
      dividend: { label: t("fund.subtype.dividend"), cls: "bg-emerald-50 text-emerald-600", textCls: "text-emerald-600" },
      switch: { label: t("fund.subtype.switch"), cls: "bg-blue-50 text-blue-600" },
    };
    return srcLabels[source] ?? baseLabel;
  }
  return baseLabel;
}

const ymdUtc = formatDateUtc;

function toValidDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function toIsoOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? date.toISOString() : null;
}

function toDateOnlyLocalOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? formatDateLocal(date) : null;
}

function toYmdOrNull(value: unknown) {
  const date = toValidDate(value);
  return date ? ymdUtc(date) : null;
}

/**
 * Day count between two YYYY-MM-DD dates (both parsed as UTC midnight to avoid
 * timezone drift). Returns a non-negative integer; 0 when either side is invalid.
 */
function diffYmdDays(start: string, end: string): number {
  const s = parseDateInputToUtc(start);
  const e = parseDateInputToUtc(end);
  if (!s || !e) return 0;
  return Math.max(0, Math.round((e.getTime() - s.getTime()) / 86400000));
}

/**
 * Expected interest for a held deposit certificate, following the same simple
 * interest convention used by the deposit form: principal x annual rate (%) x
 * term days / 365. Falls back to days up to today when the maturity date is
 * missing. Returns null when any required input is unavailable.
 */
function calcDepositExpectedInterest(params: {
  principal: number;
  annualRate: number | null | undefined;
  startDate: string | null | undefined;
  maturityDate: string | null | undefined;
  today: string;
}): number | null {
  const { principal, annualRate, startDate, maturityDate, today } = params;
  if (!(principal > 0) || annualRate == null || annualRate <= 0 || !startDate) return null;
  const days = diffYmdDays(startDate, maturityDate ?? today);
  if (days <= 0) return null;
  return Number(((principal * (annualRate / 100) * days) / 365).toFixed(2));
}

function buildCategoryPathLabels(categories: Array<{ id: string; name: string; type: string; parentId: string | null }>) {
  const labelById = new Map<string, string>();
  for (const c of categories) {
    labelById.set(c.id, c.name);
  }
  return labelById;
}

function buildCategoryExportLabels(
  t: (key: string, params?: Record<string, string | number>) => string,
  categories: Array<{ id: string; name: string; type: string; parentId: string | null }>,
) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const memo = new Map<string, string[]>();
  // Root category names are user data stored in the DB; keep the Chinese names for matching.
  const rootLabels = new Set(["支出", "收入", "转账", "代付", "投资"]);

  function pathNames(id: string): string[] {
    const cached = memo.get(id);
    if (cached) return cached;
    const c = byId.get(id);
    if (!c) return [];
    const seen = new Set<string>();
    const names: string[] = [];
    let cur: typeof c | undefined = c;
    while (cur) {
      if (seen.has(cur.id)) break;
      seen.add(cur.id);
      names.push(cur.name);
      if (!cur.parentId) break;
      const parent = byId.get(cur.parentId);
      if (!parent) break;
      if (parent.type !== cur.type) break;
      cur = parent;
    }
    names.reverse();
    memo.set(id, names);
    return names;
  }

  const labelById = new Map<string, string>();
  for (const c of categories) {
    const names = pathNames(c.id);
    const exportNames = [...names];
    if (exportNames[0] === formatType(t, c.type) || rootLabels.has(exportNames[0] ?? "")) {
      exportNames.shift();
    }
    labelById.set(c.id, exportNames.map((name) => systemCategoryLabel(name, t)).join("."));
  }
  return labelById;
}

type ExportAccountLike = {
  name?: string | null;
  kind?: string | null;
  numberMasked?: string | null;
  Institution?: { name?: string | null; shortName?: string | null } | null;
  AccountGroup?: { name?: string | null } | null;
} | null | undefined;

function exportAccountLabel(account: ExportAccountLike, fallbackName?: string | null) {
  const owner = isLoanOrSettlementAccountKind(account?.kind) ? "" : account?.AccountGroup?.name?.trim() || "";
  const institution = account?.Institution?.shortName?.trim() || account?.Institution?.name?.trim() || "";
  const accountName = account?.name?.trim() || fallbackName?.trim() || "";
  const tailOrName = account?.numberMasked?.trim() || accountName;
  const accountType = account?.kind ? kindLabel(account.kind) : "";
  return [owner, institution, tailOrName, accountType].filter(Boolean).join("·");
}

function stripExportCategoryRootLabel(value?: string | null) {
  const text = value?.trim() ?? "";
  return ["支出", "收入", "转账", "代付", "投资"].includes(text) ? "" : text;
}










export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{
    account?: string;
    accountId?: string;
    tagId?: string;
    view?: string;
    billMonth?: string;
    hideZeroBills?: string;
    hideSettledBills?: string;
    billMonthsLimit?: string;
    billPage?: string;
    pageSize?: string;
    detailPage?: string;
    symbol?: string;
    fundCode?: string;
    wealthProductId?: string;
    fundSort?: string;
    fundSortDir?: string;
    fundPageSize?: string;
    fundPage?: string;
    showCleared?: string;
    fixedAssetType?: string;
    debtPerson?: string;
    debtLoanType?: string;
    detailAll?: string;
    detailFilterDate?: string;
    detailFilterFlow?: string;
    detailFilterType?: string;
    detailFilterCategory?: string;
    detailFilterRelated?: string;
    detailFilterRemark?: string;
    detailDateFrom?: string;
    detailDateTo?: string;
    detailInFrom?: string;
    detailInTo?: string;
    detailOutFrom?: string;
    detailOutTo?: string;
    focusEntryId?: string;
    guide?: string;
  }>;
}) {
  const t = await getServerT();
  const params = await searchParams;
  await connection();
  const accountId = typeof params?.accountId === "string" ? params.accountId.trim() : "";
  const accountName = typeof params?.account === "string" ? params.account.trim() : "";
  const tagIdParam = typeof params?.tagId === "string" ? params.tagId.trim() : "";
  const rawFixedAssetTypeParam = typeof params?.fixedAssetType === "string" ? params.fixedAssetType.trim() : "";
  const fixedAssetTypeParam = rawFixedAssetTypeParam ? normalizeFixedAssetType(rawFixedAssetTypeParam) : "";
  // If no account is selected, default to the overview page.
  if (!accountId && !accountName && !tagIdParam && params?.view !== "debt" && params?.view !== "investproperty") {
    redirect("/overview");
  }
  const viewParam = tagIdParam
    ? "detail"
    : params?.view === "bill"
      ? "bill"
      : params?.view === "detail"
        ? "detail"
        : params?.view === "investfund"
          ? "investfund"
        : params?.view === "investmoney"
          ? "investmoney"
          : params?.view === "investwealth"
            ? "investwealth"
            : params?.view === "investstock"
              ? "investstock"
              : params?.view === "investproperty"
                ? "investproperty"
                : params?.view === "regularinvest"
                  ? "regularinvest"
                  : params?.view === "debt"
                    ? "debt"
                    : params?.view === "deposit"
                      ? "deposit"
                      : "";
  const debtPersonParam = typeof params?.debtPerson === "string" ? params.debtPerson.trim() : "";
  const debtLoanTypeParam = normalizeLoanType(typeof params?.debtLoanType === "string" ? params.debtLoanType : "");
  const billMonthParam = typeof params?.billMonth === "string" ? params.billMonth.trim() : "";
  const billPageParam = typeof params?.billPage === "string" ? parseInt(params.billPage, 10) : 1;
  const billPage = Number.isFinite(billPageParam) && billPageParam >= 1 ? billPageParam : 1;

  // Read the cookie preference. The pagination cookie preserves the detail-table
  // context after an edit refresh.
  const cookieStore = await cookies();
  const accountLabelFields = accountLabelFieldsFromCookieValue(cookieStore.get(ACCOUNT_LABEL_FIELDS_COOKIE)?.value);
  const restrictAccountDropdownTypes = accountDropdownRestrictTypeFromCookieValue(
    cookieStore.get(ACCOUNT_DROPDOWN_RESTRICT_TYPE_COOKIE)?.value,
  );
  // Applies a type-style filter to an account list, unless the "账户下拉限制类型"
  // setting is off (in which case every dropdown shows all accounts).
  const restrictAccountList = <T extends { kind?: string | null }>(items: T[], predicate: (a: T) => boolean) =>
    restrictAccountDropdownTypes ? items.filter(predicate) : items;
  const detailPaginationPref = decodeDetailPaginationPreference(
    cookieStore.get(detailPaginationCookieName(accountId))?.value,
  );
  const pageSizeParam = typeof params?.pageSize === "string"
    ? parseInt(params.pageSize, 10)
    : detailPaginationPref?.pageSize ?? 20;
  const pageSize = normalizeDetailPageSize(pageSizeParam);
  const detailPageParam = typeof params?.detailPage === "string"
    ? parseInt(params.detailPage, 10)
    : detailPaginationPref?.detailPage ?? 1;
  const detailPage = normalizeDetailPage(detailPageParam);
  const detailAll = tagIdParam
    ? true
    : params?.detailAll === "1"
    ? true
    : typeof params?.detailAll === "string"
      ? false
      : detailPaginationPref?.detailAll ?? false;
  const detailDateFrom = typeof params?.detailDateFrom === "string" ? params.detailDateFrom.trim() : "";
  const detailDateTo = typeof params?.detailDateTo === "string" ? params.detailDateTo.trim() : "";
  const detailInFrom = typeof params?.detailInFrom === "string" ? params.detailInFrom.trim() : "";
  const detailInTo = typeof params?.detailInTo === "string" ? params.detailInTo.trim() : "";
  const detailOutFrom = typeof params?.detailOutFrom === "string" ? params.detailOutFrom.trim() : "";
  const detailOutTo = typeof params?.detailOutTo === "string" ? params.detailOutTo.trim() : "";
  const focusEntryId = typeof params?.focusEntryId === "string" ? params.focusEntryId.trim() : "";
  const guideParam = typeof params?.guide === "string" ? params.guide.trim() : "";
  const detailColumnFilters: Record<DetailFilterColumn, string[]> = {
    date: parseDetailFilterParam(params?.detailFilterDate),
    flow: parseDetailFilterParam(params?.detailFilterFlow),
    type: parseDetailFilterParam(params?.detailFilterType),
    category: parseDetailFilterParam(params?.detailFilterCategory),
    related: parseDetailFilterParam(params?.detailFilterRelated),
    remark: parseDetailFilterParam(params?.detailFilterRemark),
  };
  const hasDetailFilters =
    !!(detailDateFrom || detailDateTo || detailInFrom || detailInTo || detailOutFrom || detailOutTo) ||
    Object.values(detailColumnFilters).some((values) => values.length > 0);
  const rawFundCodeParam = typeof params?.fundCode === "string" ? params.fundCode.trim() : "";
  const wealthProductIdParam = typeof params?.wealthProductId === "string" ? params.wealthProductId.trim() : "";
  const fundSortParam = typeof params?.fundSort === "string" ? params.fundSort.trim() : "marketValue";
  const fundSortDirParam = params?.fundSortDir === "asc" ? "asc" : "desc";
  const fundPageSizeParam = typeof params?.fundPageSize === "string" ? parseInt(params.fundPageSize, 10) : 20;
  const fundPageSize = [10, 20, 40].includes(fundPageSizeParam) ? fundPageSizeParam : 20;
  const fundPageParam = typeof params?.fundPage === "string" ? parseInt(params.fundPage, 10) : 1;
  const fundPage = Number.isFinite(fundPageParam) && fundPageParam >= 1 ? fundPageParam : 1;
  const showCleared = params?.showCleared === "1";

  // Read the up/down color scheme.
  const colorScheme = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") as "red_up_green_down" | "green_up_red_down";
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_label_template")?.value,
    creditCardLabelMode,
  );
  const creditBillHideZeroPref = cookieStore.get("mmh_credit_hide_zero_bills")?.value;
  const creditBillHideSettledPref = cookieStore.get("mmh_credit_hide_settled_bills")?.value;
  const creditBillRecentCyclesPref = cookieStore.get("mmh_credit_recent_cycles")?.value;
  const hideZeroBills =
    typeof params?.hideZeroBills === "string"
      ? params.hideZeroBills === "1"
      : creditBillHideZeroPref === "1" || creditBillHideZeroPref === "true";
  const hideSettledBills =
    typeof params?.hideSettledBills === "string"
      ? params.hideSettledBills === "1"
      : creditBillHideSettledPref === "1" || creditBillHideSettledPref === "true";
  const showRecentBillCycles =
    typeof params?.billMonthsLimit === "string"
      ? params.billMonthsLimit !== "all"
      : creditBillRecentCyclesPref == null
        ? true
        : creditBillRecentCyclesPref === "1" || creditBillRecentCyclesPref === "true";
  const billMonthsLimit = showRecentBillCycles ? 10 : 9999;
  const isRedUp = colorScheme === "red_up_green_down";
  const ctx = await getCachedHouseholdScope();
  const { hidFilter, householdId } = ctx;
  const baseCurrency = await getHouseholdBaseCurrency(householdId);
  // Color helper.
  const pnlCls = (n: number) => pnlClassFromRedUp(n, isRedUp);
  // Common data: shared across accounts, cached across requests.
  const common = await loadCommonData(hidFilter);
  const { categories, tags, groups, institutions, counterparties, preciousMetalDictionaries } = common;
  const metalTypes = preciousMetalDictionaries.types;
  const metalUnits = preciousMetalDictionaries.units;
  // Account balance/active state changes frequently and drives financial totals.
  // Read accounts fresh so sidebar, debt view, and detail pages use one source of truth.
  const accounts = await prisma.account.findMany({
    where: { isPlaceholder: { not: true }, ...hidFilter },
    include: { Institution: true, Counterparty: true, AccountGroup: true },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
  // selectedAccount: per-account, deduplicated at request level.
  const selectedAccount = await loadSelectedAccount(accountId || undefined, hidFilter);
  const fundUnitsDecimals = normalizeFundUnitsDecimals(selectedAccount?.fundUnitsDecimals, 2);
  const isBillAccount =
    (selectedAccount?.kind === AccountKind.bank_credit || selectedAccount?.kind === AccountKind.loan) ||
    !!selectedAccount?.billingDay;
  const billAccountIds = selectedAccount && isBillAccount
    ? await getCreditBillAccountIds(prisma, selectedAccount)
    : [];
  const billStorageAccountId = billAccountIds[0] ?? selectedAccount?.id ?? "";
  const isDebtAccount = isLoanOrSettlementAccountKind(selectedAccount?.kind);
  const isInvestAccount = selectedAccount ? isPureInvestmentAccount(selectedAccount) : false;
  const isDepositView = selectedAccount ? isDepositAccount(selectedAccount) : false;
  const missingBillingDayForBill =
    viewParam === "bill" &&
    selectedAccount?.kind === AccountKind.bank_credit &&
    !selectedAccount?.billingDay;
  const isOverview = !viewParam && !accountId && !accountName;
  const isInsuranceView = selectedAccount?.kind === AccountKind.insurance;
  const view: "bill" | "detail" | "investfund" | "investmoney" | "investwealth" | "investstock" | "investproperty" | "regularinvest" | "debt" | "overview" | "deposit" | "insurance" =
    isDebtAccount
      ? "debt"
      : viewParam
        ? viewParam
        : isBillAccount
          ? "bill"
          : isDepositView
            ? "deposit"
          : isInsuranceView
            ? "insurance"
          : isInvestAccount
            ? getInvestmentAccountView(selectedAccount)
            : isOverview
              ? "overview"
          : "detail";
  const selectedWealthProductIdParam = view === "investwealth"
    ? (wealthProductIdParam || rawFundCodeParam)
    : "";
  const fundCodeParam = view === "investwealth" ? "" : rawFundCodeParam;
  const needsDetailEntries = view === "detail" || view === "deposit" || view === "insurance" || (view === "bill" && isBillAccount);

  const hid = { householdId };
  const where = accountId
    ? {
        ...txRecordAccountScopeWhere(accountId),
        deletedAt: null,
        ...hid,
      }
    : accountName
      ? { accountName: accountName, deletedAt: null, ...hid }
      : tagIdParam
        ? {
            deletedAt: null,
            ...hid,
            EntryTag: { some: { tagId: tagIdParam } },
          }
      : {
          deletedAt: null,
          account: {
            OR: [
              { kind: { not: AccountKind.investment } },
              { kind: AccountKind.investment, investProductType: "deposit" as any },
            ],
            ...hidFilter,
          },
        };

  const insuranceProductsForAccount =
    view === "insurance" && selectedAccount
      ? await prisma.insuranceProduct.findMany({
          where: { ...hidFilter, accountId: selectedAccount.id },
          include: { OwnerGroup: true, InsuredUser: true, InsuredPerson: true, PolicyholderPerson: true },
          orderBy: [{ name: "asc" }],
        })
      : [];
  const insuranceProductIdsForAccount = insuranceProductsForAccount.map((product) => product.id);

  const rawEntries = needsDetailEntries
    ? accountId
      ? view === "insurance" && selectedAccount
        ? await prisma.txRecord.findMany({
            where: {
              ...hid,
              deletedAt: null,
              type: "investment",
              source: "insurance",
              OR: [
                { accountId },
                { toAccountId: accountId },
                ...(insuranceProductIdsForAccount.length > 0
                  ? [{ insuranceProductId: { in: insuranceProductIdsForAccount } }]
                  : []),
              ],
            },
            include: {
              EntryTag: { include: { Tag: true } },
              Attachment: { select: { id: true, name: true, mimeType: true, url: true } },
              ...entryBusinessLinkSummaryInclude,
              account: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
              toAccount: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
            },
            orderBy: [{ date: "desc" }, { createdAt: "desc" }],
            take: DETAIL_ALL_PAGE_SIZE,
          })
        : view === "bill" && isBillAccount && billAccountIds.length > 0
          ? await prisma.txRecord.findMany({
              where: {
                ...hid,
                deletedAt: null,
                ...txRecordAccountScopeWhere(billAccountIds),
              },
              include: {
                EntryTag: { include: { Tag: true } },
                Attachment: { select: { id: true, name: true, mimeType: true, url: true } },
                ...entryBusinessLinkSummaryInclude,
                account: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
                toAccount: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
              },
              orderBy: [{ date: "desc" }, { createdAt: "desc" }],
              take: DETAIL_ALL_PAGE_SIZE,
            })
        : await loadEntriesForAccount(accountId, JSON.stringify(hidFilter))
      : await prisma.txRecord.findMany({
          where,
          include: {
            EntryTag: { include: { Tag: true } },
            Attachment: { select: { id: true, name: true, mimeType: true, url: true } },
            ...entryBusinessLinkSummaryInclude,
            account: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
            toAccount: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
          },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          take: DETAIL_ALL_PAGE_SIZE,
        })
    : [];
  const entryDisplayDate = (e: (typeof rawEntries)[number]) => getDetailEntryDisplayDate(e, accountId);
  const entries = [...rawEntries].sort((a, b) => compareDetailEntriesDesc(a, b, accountId));
  const accountMetaById = new Map(accounts.map((account) => [account.id, account]));
  const isSettlementDebtAccountId = (id?: string | null) => {
    if (!id) return false;
    const account = accountMetaById.get(id);
    if (!account) return false;
    return account.kind === AccountKind.settlement || (account.kind === AccountKind.loan && !!account.counterpartyId);
  };
  const isCreditCardRepaymentForDisplay = (e: (typeof entries)[number]) => {
    if (isSettlementDebtAccountId(e.accountId) || isSettlementDebtAccountId(e.toAccountId)) return false;
    return isCreditCardRepaymentTransfer({
      type: e.type,
      accountKind: e.account?.kind ?? accountMetaById.get(e.accountId ?? "")?.kind ?? null,
      toAccountKind: e.toAccount?.kind ?? accountMetaById.get(e.toAccountId ?? "")?.kind ?? null,
    });
  };
  const getEntryDisplayNote = (e: (typeof entries)[number]) => {
    const fromNote = (e.note ?? "").trim();
    const receiverNote = (e.toNote ?? "").trim();
    const displayNote = !accountId
      ? fromNote
      : e.toAccountId === accountId ? (receiverNote || fromNote) : fromNote;
    return getInsuranceDetailNote({
      source: e.source,
      fundName: e.fundName,
      fundSubtype: e.fundSubtype,
      note: displayNote,
    });
  };
  const getDetailFilterColumnValue = (e: (typeof entries)[number], column: DetailFilterColumn) => {
    const amount = toNumber(e.amount);
    const effectiveAmount = effectiveAmountForAccount(e, accountId);
    const balanceTarget = getBalanceReconcileTarget(e);
    if (column === "date") return entryDisplayDate(e).toISOString().slice(0, 10);
    if (column === "flow" && balanceTarget != null && e.source === BALANCE_INITIALIZATION_SOURCE) return t("detailView.initialBalance");
    if (column === "flow" && e.source === BALANCE_RECONCILE_SOURCE) return t("detailView.balanceReconcile");
    if (column === "flow") return effectiveAmount >= 0 ? t("detail.column.inflow") : t("detail.column.outflow");
    if (column === "type" && balanceTarget != null && e.source === BALANCE_INITIALIZATION_SOURCE) return t("detailView.initialBalance");
    if (column === "type" && e.source === BALANCE_RECONCILE_SOURCE) return t("detailView.balanceReconcile");
    if (column === "type") {
      if (e.source === "insurance") return getInsuranceDetailCategoryName(e);
      if (e.source === "advance") return t("txForm.advance");
      if (e.type === "investment" && e.fundProductType === "deposit") return t("detailView.deposit");
      return e.type === "investment" && e.fundSubtype ? (fundSubtypeInfo(t, e.fundSubtype, e.source, amount, e.fundProductType)?.label ?? formatType(t, e.type)) : formatType(t, e.type);
    }
    if (column === "category") {
      if (isCreditCardRepaymentForDisplay(e)) return t("transaction.category.creditCardRepayment");
      if (e.type === TransactionType.investment) {
        if (e.source === "insurance") return getInsuranceDetailCategoryName(e);
        return e.categoryName || getInvestmentCategoryName(e) || t("detail.emptyValue");
      }
      return getInsuranceDetailCategoryName(e) || t("detail.emptyValue");
    }
    if (column === "related") {
      const related = accountId && e.toAccountId === accountId ? (e.accountName ?? "") : (e.toAccountName ?? "");
      return related.trim() || t("detail.emptyValue");
    }
    return getEntryDisplayNote(e) || t("detail.emptyValue");
  };
  const detailDateInRange = (v: string) => {
    let f = detailDateFrom;
    let t = detailDateTo;
    if (f && t && f > t) {
      const tmp = f; f = t; t = tmp;
    }
    if (!f && !t) return true;
    if (!v) return false;
    if (f && v < f) return false;
    if (t && v > t) return false;
    return true;
  };

  const parseRangeNumber = (v: string) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  const detailInFromN = parseRangeNumber(detailInFrom);
  const detailInToN = parseRangeNumber(detailInTo);
  const detailOutFromN = parseRangeNumber(detailOutFrom);
  const detailOutToN = parseRangeNumber(detailOutTo);

  const detailNumberInRange = (n: number, fromN: number | null, toN: number | null) => {
    let f = fromN;
    let t = toN;
    if (f != null && t != null && f > t) {
      const tmp = f; f = t; t = tmp;
    }
    if (f != null && n < f) return false;
    if (t != null && n > t) return false;
    return true;
  };

  const filteredEntries = entries.filter((e) => (Object.keys(detailColumnFilters) as DetailFilterColumn[]).every((column) => {
    const allowedValues = detailColumnFilters[column];
    const v = getDetailFilterColumnValue(e, column);
    if (allowedValues.length > 0 && !allowedValues.includes(v)) return false;
    if (column === "date" && (detailDateFrom || detailDateTo) && !detailDateInRange(v)) return false;
    return true;
  }));
  const filteredEntries2 = filteredEntries.filter((e) => {
    const effectiveAmount = effectiveAmountForAccount(e, accountId);
    const inflow = effectiveAmount > 0 ? effectiveAmount : null;
    const outflow = effectiveAmount < 0 ? -effectiveAmount : null;
    if ((detailInFromN != null || detailInToN != null)) {
      if (inflow == null) return false;
      if (!detailNumberInRange(inflow, detailInFromN, detailInToN)) return false;
    }
    if ((detailOutFromN != null || detailOutToN != null)) {
      if (outflow == null) return false;
      if (!detailNumberInRange(outflow, detailOutFromN, detailOutToN)) return false;
    }
    return true;
  });
  const detailTotalPages = Math.max(1, Math.ceil(filteredEntries2.length / pageSize));
  const focusEntryIndex = focusEntryId
    ? filteredEntries2.findIndex((entry) => entry.id === focusEntryId)
    : -1;
  const focusDetailPage = focusEntryIndex >= 0
    ? Math.floor(focusEntryIndex / pageSize) + 1
    : null;
  const safeDetailPage = detailAll ? 1 : Math.min(focusDetailPage ?? detailPage, detailTotalPages);
  const categoryLabels = buildCategoryPathLabels(categories);
  const exportCategoryLabels = buildCategoryExportLabels(t, categories);
  const getExportCategoryName = (e: (typeof filteredEntries2)[number]) => {
    if (isCreditCardRepaymentForDisplay(e)) return t("transaction.category.creditCardRepayment");
    if (e.categoryId) return exportCategoryLabels.get(e.categoryId) ?? systemCategoryLabel(stripExportCategoryRootLabel(e.categoryName), t);
    if (e.type === TransactionType.investment) {
      if (e.source === "insurance") return getInsuranceDetailCategoryName(e);
      return systemCategoryLabel(stripExportCategoryRootLabel(e.categoryName), t) || systemCategoryLabel(getInvestmentCategoryName(e), t) || "";
    }
    return systemCategoryLabel(stripExportCategoryRootLabel(e.categoryName), t);
  };
  const normalExportHeader = [
    t("detail.column.date"),
    t("detailView.column.type"),
    t("detail.column.category"),
    t("detail.column.outflow"),
    t("detail.column.inflow"),
    t("common.account"),
    t("batchImport.field.counterAccount"),
    t("detail.column.counterparty"),
    t("detail.column.tags"),
    t("detail.column.remark"),
  ];
  const normalExportEntryRows = filteredEntries2.map((e) => {
    const effectiveAmount = effectiveAmountForAccount(e, accountId);
    const outflow = effectiveAmount < 0 ? String(-effectiveAmount) : "";
    const inflow = effectiveAmount > 0 ? String(effectiveAmount) : "";
    const isToSide = accountId && e.toAccountId === accountId;
    const accountLabel = isToSide
      ? exportAccountLabel(e.toAccount, e.toAccountName)
      : exportAccountLabel(e.account, e.accountName);
    const counterAccountLabel = e.type === TransactionType.transfer || e.type === TransactionType.investment
      ? isToSide
        ? exportAccountLabel(e.account, e.accountName)
        : exportAccountLabel(e.toAccount, e.toAccountName)
      : "";
    const tagsText = (e.EntryTag || [])
      .map((entryTag) => entryTag.Tag?.name?.trim() || "")
      .filter(Boolean)
      .join("、");
    return {
      id: e.id,
      row: [
        entryDisplayDate(e).toISOString().slice(0, 10),
        e.source === "insurance" ? getInsuranceDetailCategoryName(e) : formatType(t, e.type),
        getExportCategoryName(e),
        outflow,
        inflow,
        accountLabel,
        counterAccountLabel,
        e.counterpartyInstitutionName ?? "",
        tagsText,
        getEntryDisplayNote(e),
      ],
    };
  });
  const normalExportRows = [normalExportHeader, ...normalExportEntryRows.map((item) => item.row)];
  const normalExportRowsByEntryId = Object.fromEntries(normalExportEntryRows.map((item) => [item.id, item.row]));
  const normalExportFilename = t("sidebar.export.filename", {
    name: selectedAccount?.name || accountName || t("statistics.allAccounts"),
  });

  const expenseCategories = categories
    .filter((c) => c.type === "expense")
    .map((c) => ({ ...c, label: categoryLabels.get(c.id) ?? c.name }))
    .sort(compareCategoryOrder);
  const incomeCategories = categories
    .filter((c) => c.type === "income")
    .map((c) => ({ ...c, label: categoryLabels.get(c.id) ?? c.name }))
    .sort(compareCategoryOrder);
  const advanceCategories = categories
    .filter((c) => c.type === "advance")
    .map((c) => ({ ...c, label: categoryLabels.get(c.id) ?? c.name }))
    .sort(compareCategoryOrder);
  const categoryBatchReplaceOptions = (() => {
    const typeLabels: Record<string, string> = {
      expense: t("stats.expenseCategories"),
      income: t("categoryType.income"),
      advance: t("categoryType.advance"),
      transfer: t("categoryType.transfer"),
      investment: t("categoryType.investment"),
    };
    const typeOrder = ["expense", "income", "advance", "transfer", "investment"];
    const options: Array<{
      value: string;
      label: string;
      subLabel?: string;
      parentId?: string;
      isHeader?: boolean;
      isGroup?: boolean;
      categoryType?: string;
    }> = [];
    const indent = "　";

    for (const type of typeOrder) {
      const typedCategories = categories.filter((category) => category.type === type);
      if (typedCategories.length === 0) continue;

      const childrenByParentId = new Map<string | null, typeof typedCategories>();
      for (const category of typedCategories) {
        const key = category.parentId ?? null;
        const list = childrenByParentId.get(key) ?? [];
        list.push(category);
        childrenByParentId.set(key, list);
      }
      for (const [parentId, list] of childrenByParentId) {
        childrenByParentId.set(parentId, sortCategorySources(list));
      }

      const headerId = `category-type:${type}`;
      options.push({ value: headerId, label: typeLabels[type] ?? type, isHeader: true, categoryType: type });

      function walk(parentId: string | null, level: number, parentOptionId: string) {
        const children = childrenByParentId.get(parentId) ?? [];
        for (const child of children) {
          const hasChildren = (childrenByParentId.get(child.id) ?? []).length > 0;
          options.push({
            value: child.id,
            label: `${indent.repeat(level)}${systemCategoryLabel(child.name, t)}`,
            subLabel: typeLabels[type] ?? type,
            parentId: parentOptionId,
            isGroup: hasChildren,
            categoryType: type,
          });
          if (hasChildren) walk(child.id, level + 1, child.id);
        }
      }

      walk(null, 0, headerId);
    }

      return options;
  })();
  const tagBatchReplaceOptions = tags.map((tag) => ({
    value: tag.id,
    label: tag.name,
    color: tag.color,
  }));

  const [cashDisplayBalanceByAccountId, insuranceDisplayBalanceByAccountId, debtDisplaySummary, investBalances] = await Promise.all([
    computeAccountDisplayBalances(
      accounts
        .filter((account) => !isPureInvestmentAccount(account) && account.kind !== AccountKind.insurance)
        .map((account) => ({
          id: account.id,
          kind: account.kind,
          investProductType: account.investProductType,
          billingDay: account.billingDay,
        })),
      hidFilter,
    ),
    computeInsuranceAccountDisplayBalances(
      accounts
        .filter((account) => account.kind === AccountKind.insurance)
        .map((account) => account.id),
      hidFilter,
    ),
    computeDebtDisplaySummary(ctx),
    loadInvestBalances(JSON.stringify(hidFilter)),
  ]);
  const investBalByAccountId = new Map(Object.entries(investBalances));

  const accountDisplayValueById = new Map<string, number>();
  for (const account of accounts) {
    const value = isPureInvestmentAccount(account)
      ? investBalByAccountId.get(account.id)?.marketValue ?? toNumber(account.balance)
      : account.kind === AccountKind.insurance
        ? insuranceDisplayBalanceByAccountId.get(account.id) ?? 0
        : isLoanOrSettlementAccountKind(account.kind)
          ? debtDisplaySummary.balanceByAccountId.get(account.id) ?? cashDisplayBalanceByAccountId.get(account.id) ?? toNumber(account.balance)
          : cashDisplayBalanceByAccountId.get(account.id) ?? toNumber(account.balance);
    accountDisplayValueById.set(account.id, value);
  }
  const netWorthConversion = await convertCurrencyAmounts({
    householdId,
    amounts: accounts.map((account) => ({
      amount: accountDisplayValueById.get(account.id) ?? 0,
      currency: account.currency,
    })),
    toCurrency: baseCurrency,
    refreshMissing: true,
  });
  const fxRateByCurrency = new Map(netWorthConversion.rates.map((rate) => [rate.fromCurrency, rate]));
  const convertedAccountValueById = new Map<string, number | null>();
  for (const account of accounts) {
    const rate = fxRateByCurrency.get(normalizeCurrency(account.currency));
    convertedAccountValueById.set(
      account.id,
      rate?.rate == null ? null : (accountDisplayValueById.get(account.id) ?? 0) * rate.rate,
    );
  }
  const totalNetWorthValue = netWorthConversion.total;
  const missingFxCurrencies = netWorthConversion.missingCurrencies;
  const monthGrowthValue = 0; // TODO: Real calculation

  const balanceByEntryId = new Map<string, number>();
  if (where) {
    const asc = [...rawEntries].sort((a, b) => compareDetailEntriesAsc(a, b, accountId));
    let running = 0;
    for (const e of asc) {
      running = applyBalanceReconcileEntry(running, e, accountId);
      balanceByEntryId.set(e.id, running);
    }
  }

  const selectedAccountLabel = (() => {
    if (tagIdParam) return tags.find((tag) => tag.id === tagIdParam)?.name || t("statistics.allAccounts");
    if (view === "debt") return t("account.kind.loan");
    if (view === "investproperty") return t("txForm.fixedAssetToggle");
    if (selectedAccount) {
      const display = buildAccountDisplayOption({
        id: selectedAccount.id,
        name: selectedAccount.name,
        kind: selectedAccount.kind,
        numberMasked: selectedAccount.numberMasked,
        groupId: selectedAccount.groupId,
        investProductType: selectedAccount.investProductType,
        Institution: selectedAccount.Institution,
        AccountGroup: selectedAccount.AccountGroup,
      }, selectedAccount.kind === AccountKind.bank_credit ? SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE : creditCardLabelTemplate, { fields: accountLabelFields });
      const accountLabel = display.label;
      if (isPureInvestmentAccount(selectedAccount)) return accountLabel;
      if (isDepositAccount(selectedAccount)) return `${t("entry.kind.deposit")} / ${accountLabel}`;
      if (selectedAccount.kind === AccountKind.insurance) return `${t("entry.kind.insurance")} / ${accountLabel}`;
      const group = isLoanOrSettlementAccountKind(selectedAccount.kind) ? "" : (selectedAccount.AccountGroup?.name ?? "").trim();
      return [group, accountLabel].filter(Boolean).join(" / ");
    }
    return accountName || "";
  })();

  const accountOptions = accounts
    .filter(a => a.name !== "未指定账户")
    .map((a) => {
    const display = buildAccountDisplayOption({
      id: a.id,
      name: a.name,
      kind: a.kind,
      numberMasked: a.numberMasked,
      groupId: a.groupId,
      investProductType: a.investProductType,
      Institution: a.Institution,
      AccountGroup: a.AccountGroup,
    }, creditCardLabelTemplate, { fields: accountLabelFields });
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      numberMasked: a.numberMasked,
      label: display.selectorLabel,
      // Table cells render `listLabel`, which follows the configured display
      // fields (owner and account kind included); `label`/`selectorLabel` stay
      // the dropdown labels so pickers keep their existing shape.
      listLabel: display.listLabel,
      fullLabel: display.fullLabel,
      title: display.hoverTitle,
      hoverTitle: display.hoverTitle,
      groupId: display.groupId,
      groupName: display.groupName,
      institutionName: display.institutionName,
      institutionId: a.institutionId ?? "",
      institutionType: a.Institution?.type ?? "",
      counterpartyId: a.counterpartyId ?? "",
      isSettlementDebt: a.kind === AccountKind.settlement || (a.kind === AccountKind.loan && !!a.counterpartyId),
      isConsumerLoan: a.isConsumerLoan === true,
      investProductType: a.investProductType,
      debtDirection: a.debtDirection ?? null,
      billingDay: a.billingDay ?? null,
      subLabel: kindLabel(a.kind),
      currency: a.currency ?? "CNY",
    };
  });

  // Build hierarchical SmartSelect options: grouped by AccountGroup (isHeader),
  // ungrouped accounts shown flat with institution as subLabel
  type SSOpt = { id: string; label: string; subLabel?: string; title?: string; isHeader?: boolean; isGroup?: boolean; parentId?: string; kind?: string | null; investProductType?: string | null; debtDirection?: string | null; institutionId?: string | null; institutionType?: string | null; counterpartyId?: string | null; isSettlementDebt?: boolean | null; isConsumerLoan?: boolean | null; billingDay?: number | null; currency?: string | null };
  const joinSSSubLabel = (parts: Array<string | null | undefined>) => {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const part of parts) {
      const text = part?.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      result.push(text);
    }
    return result.join(" · ");
  };
  function buildAccountSSOptions(filter?: (a: typeof accountOptions[number]) => boolean): SSOpt[] {
    const filtered = filter && restrictAccountDropdownTypes ? accountOptions.filter(filter) : accountOptions;
    const grouped = filtered.filter(a => a.groupId);
    const ungrouped = filtered.filter(a => !a.groupId);

    // Build group header entries — exclude the unspecified group (stored group name is user data).
    const groupHeaders: SSOpt[] = groups
      .filter(g => g.name !== "未指定")
      .filter(g => grouped.some(a => a.groupId === g.id))
      .map(g => ({ id: `group:${g.id}`, label: g.name, isHeader: true }));

    // Build grouped account entries (parentId → group header)
    // Also exclude accounts belonging to excluded groups
    const excludedGroupIds = new Set(groups.filter(g => g.name === "未指定").map(g => g.id));
    const groupedItems: SSOpt[] = grouped
      .filter(a => !excludedGroupIds.has(a.groupId))
      .map(a => ({
        id: a.id,
        label: a.label,
        subLabel: joinSSSubLabel([a.groupName, a.subLabel]),
        title: a.hoverTitle,
        parentId: `group:${a.groupId}`,
        kind: a.kind,
        investProductType: a.investProductType ?? null,
        debtDirection: a.debtDirection ?? null,
        institutionId: a.institutionId || null,
        institutionType: a.institutionType || null,
        counterpartyId: a.counterpartyId || null,
        isSettlementDebt: a.isSettlementDebt ?? null,
        isConsumerLoan: a.isConsumerLoan ?? null,
        billingDay: a.billingDay ?? null,
        currency: a.currency ?? null,
      }));

    // Build ungrouped account entries (no parentId)
    const ungroupedItems: SSOpt[] = ungrouped.map(a => ({
      id: a.id,
      label: a.label,
      subLabel: joinSSSubLabel([a.subLabel]),
      title: a.hoverTitle,
      kind: a.kind,
      investProductType: a.investProductType ?? null,
      debtDirection: a.debtDirection ?? null,
      institutionId: a.institutionId || null,
      institutionType: a.institutionType || null,
      counterpartyId: a.counterpartyId || null,
      isSettlementDebt: a.isSettlementDebt ?? null,
      isConsumerLoan: a.isConsumerLoan ?? null,
      billingDay: a.billingDay ?? null,
      currency: a.currency ?? null,
    }));

    return [...groupHeaders, ...groupedItems, ...ungroupedItems];
  }

  const spendingAccountOptions = restrictAccountList(
    accounts,
    (a) => a.name !== "未指定账户" && !isPureInvestmentAccount(a),
  )
    .map((a) => {
      const display = buildAccountDisplayOption({
        id: a.id,
        name: a.name,
        kind: a.kind,
        numberMasked: a.numberMasked,
        groupId: a.groupId,
        investProductType: a.investProductType,
        Institution: a.Institution,
        AccountGroup: a.AccountGroup,
      }, creditCardLabelTemplate, { fields: accountLabelFields });
      return {
        id: a.id,
        name: a.name,
        kind: a.kind,
        label: display.selectorLabel,
        // Table cells render `listLabel`; see the note on `accountOptions`.
        listLabel: display.listLabel,
        title: display.hoverTitle,
        hoverTitle: display.hoverTitle,
        groupId: display.groupId,
        groupName: display.groupName,
        institutionId: a.institutionId ?? "",
        institutionType: a.Institution?.type ?? "",
        investProductType: a.investProductType,
        debtDirection: a.debtDirection ?? null,
        billingDay: a.billingDay ?? null,
        subLabel: kindLabel(a.kind),
        currency: a.currency ?? "CNY",
      };
    });
  const investmentAccountOptions = restrictAccountList(
    accounts,
    (a) => isPureInvestmentAccount(a) || isDepositAccount(a),
  )
    .map((a) => {
      const display = buildAccountDisplayOption({
        id: a.id,
        name: a.name,
        kind: a.kind,
        numberMasked: a.numberMasked,
        groupId: a.groupId,
        investProductType: a.investProductType,
        Institution: a.Institution,
        AccountGroup: a.AccountGroup,
      }, creditCardLabelTemplate, { fields: accountLabelFields });
      return {
        id: a.id,
        name: a.name,
        kind: a.kind,
        label: display.selectorLabel,
        // Table cells render `listLabel`; see the note on `accountOptions`.
        listLabel: display.listLabel,
        title: display.hoverTitle,
        hoverTitle: display.hoverTitle,
        groupId: display.groupId,
        groupName: display.groupName,
        institutionId: a.institutionId ?? "",
        institutionType: a.Institution?.type ?? "",
        investProductType: a.investProductType,
        subLabel: kindLabel(a.kind),
        currency: a.currency ?? "CNY",
      };
    });
  const accountLabelById = new Map(accountOptions.map((a) => [a.id, a.label]));
  const investmentProductTypeByAccountId = new Map(investmentAccountOptions.map((a) => [a.id, a.investProductType]));
  const investmentProductTypeByAccountIdObj = Object.fromEntries(investmentProductTypeByAccountId);
  const defaultFundInvestmentAccountId =
    selectedAccount && isPureInvestmentAccount(selectedAccount) && (selectedAccount.investProductType === "fund" || selectedAccount.investProductType === "money")
      ? selectedAccount.id
      : investmentAccountOptions.find((account) => account.investProductType === "fund" || account.investProductType === "money")?.id ?? "";
  const defaultMetalInvestmentAccountId =
    selectedAccount && isPureInvestmentAccount(selectedAccount) && selectedAccount.investProductType === "metal"
      ? selectedAccount.id
      : investmentAccountOptions.find((account) => account.investProductType === "metal")?.id ?? "";
  const stockAccountOptions = investmentAccountOptions.filter((account) => account.investProductType === "stock");
  const defaultStockInvestmentAccountId =
    selectedAccount && isPureInvestmentAccount(selectedAccount) && selectedAccount.investProductType === "stock"
      ? selectedAccount.id
      : stockAccountOptions[0]?.id ?? "";
  const propertyAccountOptions = investmentAccountOptions.filter((account) => account.investProductType === "property");
  const defaultPropertyInvestmentAccountId =
    selectedAccount && isPureInvestmentAccount(selectedAccount) && selectedAccount.investProductType === "property"
      ? selectedAccount.id
      : propertyAccountOptions[0]?.id ?? "";
  const defaultInvestmentCreateAccountId =
    selectedAccount && isPureInvestmentAccount(selectedAccount)
      ? selectedAccount.id
      : (defaultFundInvestmentAccountId || (investmentAccountOptions.find((account) => account.investProductType !== "deposit")?.id ?? ""));

  // Pre-computed hierarchical SS options for modal props
  const allAccountSSOptions = buildAccountSSOptions(); // all accounts for transfer dropdown
  const cashAccountSSOptions = buildAccountSSOptions(a => a.kind === "bank_debit" || a.kind === "cash" || a.kind === "ewallet");
  // Transfers in the cash view stay unchanged: just exclude investment accounts.
  // In the stock view, transfers only allow cash accounts (bank_debit/ewallet) of the same owner.
  const transferOwnerGroupId = (selectedAccount?.groupId ?? "").trim();
  const isStockTransferEligibleAccount = (a: (typeof accountOptions)[number]) =>
    (a.kind === "bank_debit" || a.kind === "ewallet")
    && (!transferOwnerGroupId || a.groupId === transferOwnerGroupId);
  const transferAccountSSOptions = view === "investstock"
    ? buildAccountSSOptions(isStockTransferEligibleAccount)
    : buildAccountSSOptions(a => !isPureInvestmentAccount(a));
  const transferAccountOptions = view === "investstock"
    ? restrictAccountList(accountOptions, isStockTransferEligibleAccount)
    : restrictAccountList(accountOptions, (a) => !isPureInvestmentAccount(a));
  const stockAccountSSOptions = buildAccountSSOptions(a => a.kind === "investment" && a.investProductType === "stock");
  const propertyAccountSSOptions = buildAccountSSOptions(a => a.kind === "investment" && a.investProductType === "property");
  const debtTransferAccountSSOptions = buildAccountSSOptions(a => a.kind === "bank_debit" || a.kind === "cash" || a.kind === "ewallet" || a.kind === "bank_credit");
  const debtCounterpartyOptions = counterparties;
  const loanSourceInstitutions = institutions.filter((institution) => institution.type === "bank" || institution.type === "debt");
  const debtObjectOptions: SSOpt[] = debtCounterpartyOptions.length > 0
    ? [
        { id: "debt-counterparty-header", label: t("txForm.counterparty"), isHeader: true },
        ...debtCounterpartyOptions.map((counterparty) => ({
          id: `counterparty:${counterparty.id}`,
          label: counterparty.shortName?.trim() || counterparty.name,
          subLabel: counterparty.type === "person" ? t("sidebar.debt.counterpartyPerson") : t("sidebar.debt.counterpartyOrganization"),
        })),
      ]
    : [];
  const loanObjectOptions: SSOpt[] = loanSourceInstitutions.length > 0
    ? [
        { id: "loan-institution-source-header", label: t("debtTx.loanInstitutionHeader"), isHeader: true },
        ...loanSourceInstitutions.map((institution) => ({
          id: `institution:${institution.id}`,
          label: institution.shortName?.trim() || institution.name,
          subLabel: institutionTypeLabel(institution.type ?? null),
        })),
      ]
    : [];
  const spendingAccountSSOptions = buildAccountSSOptions(a => a.kind !== "investment" || a.investProductType === "deposit");
  const investmentAccountSSOptions = buildFlatAccountOptions(restrictAccountList(accountOptions, (a) => isPureInvestmentAccount(a) || isDepositAccount(a)));
  // Flat lists for components that don't use SS hierarchy (backward compat)
  const cashAccountList = restrictAccountList(
    accountOptions,
    (a) => a.kind === "bank_debit" || a.kind === "cash" || a.kind === "ewallet",
  )
    .map(a => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      groupId: a.groupId ?? "",
      institutionId: a.institutionId || null,
      institutionType: a.institutionType || null,
      counterpartyId: a.counterpartyId || null,
      isSettlementDebt: a.isSettlementDebt ?? null,
      isConsumerLoan: a.isConsumerLoan ?? null,
      label: a.label,
      title: a.hoverTitle,
      hoverTitle: a.hoverTitle,
      subLabel: joinSSSubLabel([a.groupName, a.subLabel]),
      currency: a.currency,
    }));
  const debtTransferAccountList = restrictAccountList(
    accountOptions,
    (a) => a.kind === "bank_debit" || a.kind === "cash" || a.kind === "ewallet" || a.kind === "bank_credit",
  )
    .map(a => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      groupId: a.groupId ?? "",
      institutionId: a.institutionId || null,
      institutionType: a.institutionType || null,
      counterpartyId: a.counterpartyId || null,
      isSettlementDebt: a.isSettlementDebt ?? null,
      isConsumerLoan: a.isConsumerLoan ?? null,
      label: a.label,
      title: a.hoverTitle,
      hoverTitle: a.hoverTitle,
      subLabel: joinSSSubLabel([a.groupName, a.subLabel]),
      currency: a.currency,
    }));
  const investmentAccountList = restrictAccountList(
    accountOptions,
    (a) => isPureInvestmentAccount(a) || isDepositAccount(a),
  )
    .map(a => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      groupId: a.groupId ?? "",
      institutionId: a.institutionId || null,
      institutionType: a.institutionType || null,
      investProductType: a.investProductType ?? null,
      label: a.label,
      title: a.hoverTitle,
      hoverTitle: a.hoverTitle,
      subLabel: joinSSSubLabel([a.groupName, a.subLabel]),
      currency: a.currency,
    }));
  // NestedAddModal fieldData for groups & institutions
  const nestedFieldData = {
    groupId: groups.filter(g => g.name !== "未指定").map(g => ({ id: g.id, name: g.name })),
    institutionId: institutions.map(it => ({ id: it.id, name: it.name, type: it.type ?? "" })),
    counterpartyId: counterparties.map(it => ({ id: it.id, name: it.shortName?.trim() || it.name, type: it.type ?? "organization" })),
  };

  const debtAccounts = accounts.filter((account) => isLoanOrSettlementAccountKind(account.kind) && account.isActive);
  const debtAccountEditData = debtAccounts.map(toAccountQuickEditValue);
  const loanRepaymentPlans =
    view === "debt" && debtAccounts.length > 0
      ? await prisma.regularInvestPlan.findMany({
          where: {
            ...hid,
            accountId: { in: debtAccounts.map((account) => account.id) },
            fundCode: "loan_repayment",
            status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused] },
          },
          select: {
            id: true,
            accountId: true,
            amount: true,
            intervalUnit: true,
            intervalValue: true,
            executionDay: true,
            memo: true,
            startDate: true,
            nextRunDate: true,
            lastRunDate: true,
            cashAccountId: true,
            totalRuns: true,
            executedRuns: true,
            status: true,
          },
          orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
        })
      : [];
  const loanRateAdjustmentsByAccountId =
    view === "debt" && loanRepaymentPlans.length > 0
      ? await listLoanRateAdjustmentsByAccountIds({
          householdId,
          accountIds: loanRepaymentPlans.map((plan) => plan.accountId),
        })
      : new Map<string, Array<{ effectiveDate: string; annualRate: number }>>();
  const debtBorrowLprDiscountEntries =
    view === "debt" && debtAccounts.length > 0
      ? await prisma.txRecord.findMany({
          where: {
            deletedAt: null,
            ...hid,
            source: { in: ["debt_borrow_in", "debt_financed_purchase"] },
            accountId: { in: debtAccounts.map((account) => account.id) },
          },
          select: { accountId: true, date: true, note: true, toNote: true },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        })
      : [];
  const debtBorrowLprDiscountByAccountId = new Map<string, number>();
  const debtBorrowStartDateByAccountId = new Map<string, string>();
  for (const entry of debtBorrowLprDiscountEntries) {
    const discount = parseMortgageLprDiscountFromText(entry.note) ?? parseMortgageLprDiscountFromText(entry.toNote);
    if (discount != null && !debtBorrowLprDiscountByAccountId.has(entry.accountId)) {
      debtBorrowLprDiscountByAccountId.set(entry.accountId, discount);
    }
    const dateKey = formatDateUtc(entry.date);
    const existingDate = debtBorrowStartDateByAccountId.get(entry.accountId);
    if (!existingDate || dateKey < existingDate) {
      debtBorrowStartDateByAccountId.set(entry.accountId, dateKey);
    }
  }
  const loanRepaymentPlanByAccountId = new Map<string, (typeof loanRepaymentPlans)[number]>();
  const loanAutoDebitPlanByAccountId = new Map<string, (typeof loanRepaymentPlans)[number]>();
  for (const plan of loanRepaymentPlans) {
    const existing = loanRepaymentPlanByAccountId.get(plan.accountId);
    if (shouldPreferLoanScheduledPlan(plan, existing)) {
      loanRepaymentPlanByAccountId.set(plan.accountId, plan);
    }
    const existingAutoDebit = loanAutoDebitPlanByAccountId.get(plan.accountId);
    if (shouldPreferLoanAutoDebitPlan(plan, existingAutoDebit)) {
      loanAutoDebitPlanByAccountId.set(plan.accountId, plan);
    }
  }
  const mortgagedPropertyAssets =
    view === "debt" && debtAccounts.length > 0
      ? await prisma.propertyAsset.findMany({
          where: {
            deletedAt: null,
            ...hid,
            mortgageLoanAccountId: { in: debtAccounts.map((account) => account.id) },
          },
          select: { id: true, accountId: true, mortgageLoanAccountId: true },
          orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        })
      : [];
  const mortgagedAssetByLoanAccountId = new Map<string, { accountId: string; id: string }>();
  for (const asset of mortgagedPropertyAssets) {
    if (!asset.mortgageLoanAccountId || mortgagedAssetByLoanAccountId.has(asset.mortgageLoanAccountId)) continue;
    mortgagedAssetByLoanAccountId.set(asset.mortgageLoanAccountId, { accountId: asset.accountId, id: asset.id });
  }
  // 抵押物名称（按贷款账户）。读 Account.collateralAssetId —— 结清自动解除后该字段
  // 保留，已还清的贷款记录也能表明当时使用的抵押物。
  const collateralNameByLoanAccountId =
    view === "debt" && debtAccounts.length > 0
      ? await (async () => {
          const collateralAssetIds = Array.from(
            new Set(debtAccounts.map((account) => account.collateralAssetId).filter((id): id is string => !!id)),
          );
          if (collateralAssetIds.length === 0) return new Map<string, string>();
          const collateralAssets = await prisma.propertyAsset.findMany({
            where: { deletedAt: null, ...hid, id: { in: collateralAssetIds } },
            select: { id: true, name: true },
          });
          const nameById = new Map(collateralAssets.map((asset) => [asset.id, asset.name]));
          const map = new Map<string, string>();
          for (const account of debtAccounts) {
            if (!account.collateralAssetId) continue;
            const name = nameById.get(account.collateralAssetId);
            if (name) map.set(account.id, name);
          }
          return map;
        })()
      : new Map<string, string>();
  const {
    debtRows,
    debtRowsForShell,
    selectedDebtKey,
    selectedDebtRow,
    selectedDebtObjectValue,
    ordinaryDebtAccountIds,
  } = buildDebtRowsViewData({
    debtAccounts,
    cashDisplayBalanceByAccountId,
    loanRepaymentPlanByAccountId,
    loanRateAdjustmentsByAccountId,
    debtBorrowLprDiscountByAccountId,
    debtBorrowStartDateByAccountId,
    selectedAccountId: selectedAccount?.id,
    selectedAccountKind: selectedAccount?.kind,
    debtPersonParam,
    debtLoanTypeParam,
  });
  const selectedRepaymentPlan = selectedDebtRow ? loanRepaymentPlanByAccountId.get(selectedDebtRow.accountId) ?? null : null;
  const selectedAutoDebitPlan = selectedDebtRow ? loanAutoDebitPlanByAccountId.get(selectedDebtRow.accountId) ?? null : null;
  const selectedLoanTypeForLauncher = selectedDebtRow?.isLoan
    ? resolveLoanTypeValue(selectedDebtRow.loanType, selectedDebtRow.isConsumerLoan)
    : debtLoanTypeParam;
  const isDebtLoanLauncherContext = view === "debt" && !!selectedLoanTypeForLauncher;

  const loanRepaymentPlanIds = loanRepaymentPlans.map((plan) => plan.id);
  const debtEntriesRaw =
    view === "debt" && debtAccounts.length > 0
      ? await prisma.txRecord.findMany({
          where: {
            deletedAt: null,
            ...hid,
            OR: [
              { accountId: { in: debtAccounts.map((account) => account.id) } },
              { toAccountId: { in: debtAccounts.map((account) => account.id) } },
              ...(loanRepaymentPlanIds.length > 0 ? [{ regularInvestPlanId: { in: loanRepaymentPlanIds } }] : []),
            ],
          },
          include: {
            EntryTag: { include: { Tag: true } },
            Attachment: { select: { id: true, name: true, mimeType: true, url: true } },
            ...entryBusinessLinkSummaryInclude,
            account: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
            toAccount: { include: { Institution: { select: { name: true, shortName: true } }, AccountGroup: { select: { name: true } } } },
          },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          take: 3000,
        })
      : [];
  applyDebtRowEntryMetrics({
    debtRows,
    debtEntriesRaw,
    loanRepaymentPlans,
    loanRepaymentPlanByAccountId,
    loanRateAdjustmentsByAccountId,
    displayAccountId: accountId,
  });
  const debtShellRemainingTotal = debtRowsForShell.filter((row) => !row.parentKey).reduce((sum, row) => sum + row.remainingTotal, 0);
  const debtDisplaySummaryValue = debtShellRemainingTotal;
  const selectedDebtAccountIds = new Set(selectedDebtRow?.accountIds ?? ordinaryDebtAccountIds);
  const debtAccountLabelById = new Map(
    debtAccounts.map((account) => [
      account.id,
      (account.Institution?.name ? `${account.Institution.name}·${account.name}` : account.name),
    ]),
  );
  const debtDirectionByAccountId = new Map(
    debtAccounts.map((account) => [account.id, account.debtDirection ?? null]),
  );
  const selectedLoanRepaymentPlanIds = new Set(
    loanRepaymentPlans
      .filter((plan) => selectedDebtAccountIds.has(plan.accountId))
      .map((plan) => plan.id),
  );
  const repaymentScheduleRows = buildDebtRepaymentScheduleRows({
    selectedDebtRow,
    selectedRepaymentPlan,
    debtEntriesRaw,
    selectedDebtAccountIds,
    displayAccountId: accountId,
  });
  const { debtDetailEntries, repaymentScheduleRows: finalRepaymentScheduleRows } = buildDebtDetailEntriesViewData({
    debtEntriesRaw,
    selectedDebtAccountIds,
    selectedLoanRepaymentPlanIds,
    selectedDebtRow,
    selectedRepaymentPlan,
    selectedAutoDebitPlan,
    repaymentScheduleRows,
    accountLabelById,
    debtDirectionByAccountId,
    displayAccountId: accountId,
    mortgagedAssetByLoanAccountId,
    collateralNameByLoanAccountId,
  });

  // Query the most recently used cash account.
  const lastUsedCashAccount = isInvestAccount && accountId
    ? await prisma.txRecord.findFirst({
        where: {
          toAccountId: accountId,
          fundProductType: { not: null },
          accountId: { not: accountId },
          deletedAt: null,
        },
        orderBy: { createdAt: "desc" },
        select: { accountId: true },
      })
    : null;

  const {
    creditCardBill,
    settledBillMonth,
    lastRepayToAccountId,
    lastRepayFromAccountId,
    creditBillSummaryRows,
    selectedCreditBillMonth,
    creditBillBalanceValue,
    creditCardBillDetails,
    currentPage,
    billListPageSize,
    hasCreditBillSummaries,
    showAllCreditBillDetails,
  } = await loadCreditBillPageData({
    householdId,
    selectedAccount,
    isBillAccount,
    billAccountIds,
    billStorageAccountId,
    billMonthParam,
    billPage,
    billMonthsLimit,
    hideZeroBills,
    hideSettledBills,
    showRecentBillCycles,
    view,
    t,
    categoryLabels,
    isSettlementDebtAccountId,
    isCreditCardRepaymentForDisplay,
  });

  const selectedAccountRawBalanceValue = selectedAccount
    ? isPureInvestmentAccount(selectedAccount)
      ? investBalByAccountId.get(selectedAccount.id)?.marketValue ?? toNumber(selectedAccount.balance)
      : selectedAccount.kind === AccountKind.bank_credit
        ? creditBillBalanceValue
      : isLoanOrSettlementAccountKind(selectedAccount.kind)
        ? debtDisplaySummary.balanceByAccountId.get(selectedAccount.id) ?? cashDisplayBalanceByAccountId.get(selectedAccount.id) ?? toNumber(selectedAccount.balance)
        : cashDisplayBalanceByAccountId.get(selectedAccount.id) ?? toNumber(selectedAccount.balance)
    : 0;
  const selectedAccountFxRate = selectedAccount ? fxRateByCurrency.get(normalizeCurrency(selectedAccount.currency)) : null;
  const selectedAccountCurrency = selectedAccount ? normalizeCurrency(selectedAccount.currency) : baseCurrency;
  const showSelectedAccountFxInline = !!selectedAccount && selectedAccountCurrency !== baseCurrency;

  const investDataParams = JSON.stringify({
    fundSortParam,
    fundSortDirParam,
    fundPageSize,
    fundPage,
    fundCodeParam,
    wealthProductIdParam: selectedWealthProductIdParam,
  });
  const investDataHidFilter = JSON.stringify(hidFilter);
  const investmoneyData = view === "investmoney" && accountId
    ? await loadInvestAccountData(investDataHidFilter, accountId, investDataParams)
    : null;
  const investwealthData = view === "investwealth" && accountId
    ? await loadInvestAccountData(investDataHidFilter, accountId, investDataParams)
    : null;
  const investstockData = view === "investstock" && accountId
    ? await computePositionDisplay(ctx, accountId)
    : null;
  let investpropertyData: Awaited<ReturnType<typeof loadFixedAssetPositionDisplay>> | null = null;
  let investpropertyEntries: Awaited<ReturnType<typeof loadFixedAssetTransactionEntries>> = [];
  if (view === "investproperty") {
    const propertyAccountIds = accountId
      ? [accountId]
      : propertyAccountOptions.map((account) => account.id);
    [investpropertyData, investpropertyEntries] = await Promise.all([
      loadFixedAssetPositionDisplay(investDataHidFilter, accountId || ""),
      loadFixedAssetTransactionEntries(householdId, JSON.stringify(propertyAccountIds)),
    ]);
  }
  const investpropertyFilteredData = investpropertyData && fixedAssetTypeParam
    ? (() => {
        const positions = investpropertyData.positions.filter(
          (position) => normalizeFixedAssetType(position.assetType) === fixedAssetTypeParam,
        );
        const totalMarketValue = positions.reduce((sum, row) => sum + row.marketValue, 0);
        const totalCost = positions.reduce((sum, row) => sum + row.cost, 0);
        return { ...investpropertyData, positions, totalMarketValue, totalCost };
      })()
    : investpropertyData;
  const investfundData = view === "investfund" && accountId
    ? await loadInvestAccountData(investDataHidFilter, accountId, investDataParams)
    : null;
  const currentInvestData =
    view === "investfund"
      ? investfundData
      : view === "investmoney"
        ? investmoneyData
        : view === "investwealth"
          ? investwealthData
          : null;
  const isFundLikeInvestView = view === "investfund" || view === "investmoney";
  const selectedFundCode = currentInvestData?.selectedFundCode ?? "";
  const currentFundDefault = currentInvestData && isFundLikeInvestView
    ? currentInvestData.positions.find((position) => position.fundCode === selectedFundCode)
    : null;
  const currentFundConfirmDays = currentInvestData && isFundLikeInvestView
    ? (selectedFundCode ? currentInvestData.confirmDaysMap[selectedFundCode] : undefined) ?? selectedAccount?.defaultConfirmDays ?? undefined
    : selectedAccount?.defaultConfirmDays ?? undefined;
  const currentFundInvestmentAccountId =
    currentInvestData && selectedAccount && isPureInvestmentAccount(selectedAccount)
      ? selectedAccount.id
      : defaultFundInvestmentAccountId;

  const baseQuery = new URLSearchParams();
  if (accountId) baseQuery.set("accountId", accountId);
  else if (accountName) baseQuery.set("account", accountName);
  const detailLinkedWealthIds = Array.from(new Set((filteredEntries2 || []).flatMap((entry: any) =>
    [...(entry.EntryBusinessLinkCash ?? []), ...(entry.EntryBusinessLinkBusiness ?? [])]
      .map((link: any) => link.wealthTransactionId)
      .filter(Boolean),
  )));
  const detailLinkedWealthRows = detailLinkedWealthIds.length > 0
    ? await prisma.wealthTransaction.findMany({
        where: { id: { in: detailLinkedWealthIds }, householdId, deletedAt: null },
        include: { WealthProduct: true, Account: true, CashAccount: true },
      })
    : [];
  const detailLinkedWealthById = new Map(detailLinkedWealthRows.map((row) => [row.id, row]));
  const linkedWealthRowOf = (entry: any) => {
    const link = [...(entry.EntryBusinessLinkCash ?? []), ...(entry.EntryBusinessLinkBusiness ?? [])]
      .find((item: any) => item.wealthTransactionId && detailLinkedWealthById.has(item.wealthTransactionId));
    return link?.wealthTransactionId ? detailLinkedWealthById.get(link.wealthTransactionId) ?? null : null;
  };
  const detailLinkedFundIds = Array.from(new Set((filteredEntries2 || []).flatMap((entry: any) =>
    [...(entry.EntryBusinessLinkCash ?? []), ...(entry.EntryBusinessLinkBusiness ?? [])]
      .map((link: any) => link.fundTransactionId)
      .filter(Boolean),
  )));
  const detailLinkedFundRows = detailLinkedFundIds.length > 0
    ? await prisma.fundTransaction.findMany({
        where: { id: { in: detailLinkedFundIds }, householdId, deletedAt: null },
        include: { Account: true, CashAccount: true },
      })
    : [];
  const detailLinkedFundById = new Map(detailLinkedFundRows.map((row) => [row.id, row]));
  const linkedFundRowOf = (entry: any) => {
    const link = [...(entry.EntryBusinessLinkCash ?? []), ...(entry.EntryBusinessLinkBusiness ?? [])]
      .find((item: any) => item.fundTransactionId && detailLinkedFundById.has(item.fundTransactionId));
    return link?.fundTransactionId ? detailLinkedFundById.get(link.fundTransactionId) ?? null : null;
  };

  // Convert filtered entries to serializable format for client-side detail paging.
  const allDetailEntries: DetailEntry[] = (filteredEntries2 || []).map((e) => {
    const linkedWealth = linkedWealthRowOf(e);
    const linkedFund = linkedFundRowOf(e);
    const linkedWealthAction = linkedWealth?.action ?? null;
    const linkedWealthIsCashIn =
      linkedWealthAction === FundSubtype.redeem ||
      linkedWealthAction === FundSubtype.switch_out ||
      linkedWealthAction === FundSubtype.dividend_cash;
    const linkedWealthGrossAmount = linkedWealth ? Math.abs(toNumber(linkedWealth.grossAmount)) : null;
    const linkedWealthArrivalAmount = linkedWealth?.arrivalAmount != null ? Math.abs(toNumber(linkedWealth.arrivalAmount)) : null;
    const linkedWealthAmount = linkedWealth && linkedWealthGrossAmount != null
      ? linkedWealthIsCashIn
        ? linkedWealthGrossAmount
        : -linkedWealthGrossAmount
      : toNumber(e.amount);
    const linkedFundIsCashIn =
      linkedFund?.fundSubtype === FundSubtype.redeem ||
      linkedFund?.fundSubtype === FundSubtype.switch_out ||
      linkedFund?.fundSubtype === FundSubtype.dividend_cash;
    const linkedFundGrossAmount = linkedFund ? Math.abs(toNumber(linkedFund.grossAmount)) : null;
    const linkedFundAmount = linkedFund && linkedFundGrossAmount != null
      ? linkedFundIsCashIn
        ? Math.abs(toNumber(linkedFund.arrivalAmount ?? linkedFund.grossAmount))
        : -linkedFundGrossAmount
      : linkedWealthAmount;
    const linkedFundAccountId = linkedFund?.fundAccountId ?? null;
    const linkedFundCashAccountId = linkedFund?.cashAccountId ?? e.accountId;
    const linkedFundAccountName = linkedFund?.Account?.name ?? linkedFundAccountId ?? "";
    const linkedFundCashAccountName = linkedFund?.CashAccount?.name ?? e.accountName ?? "";
    return ({
    id: e.id,
    cashEntryId: linkedWealth?.cashEntryId ?? linkedFund?.cashEntryId ?? e.id,
    businessTransactionId: linkedWealth?.id ?? linkedFund?.id ?? null,
    date: e.date.toISOString().slice(0, 10),
    postedAt: toDateOnlyLocalOrNull(e.postedAt),
    createdAt: toIsoOrNull(e.createdAt),
    dayOrder: e.dayOrder ?? 0,
    amount: linkedFundAmount,
    currency: e.currency ?? "CNY",
    runningBalance: balanceByEntryId.get(e.id) ?? null,
    type: e.type,
    categoryId: e.categoryId,
    categoryName: e.categoryName,
    accountId: linkedFund ? (linkedFundIsCashIn ? linkedFundAccountId : linkedFundCashAccountId) : e.accountId,
    accountName: linkedFund ? (linkedFundIsCashIn ? linkedFundAccountName : linkedFundCashAccountName) : e.accountName,
    accountKind: linkedFund ? (linkedFundIsCashIn ? linkedFund?.Account?.kind ?? null : linkedFund?.CashAccount?.kind ?? e.account?.kind ?? null) : e.account?.kind ?? null,
    accountDebtDirection: e.account?.debtDirection ?? null,
    accountIsSettlementDebt: isSettlementDebtAccountId(linkedFund ? (linkedFundIsCashIn ? linkedFundAccountId : linkedFundCashAccountId) : e.accountId),
    counterpartyInstitutionId: e.counterpartyInstitutionId ?? null,
    counterpartyInstitutionName: e.counterpartyInstitutionName ?? null,
    toAccountId: linkedFund ? (linkedFundIsCashIn ? linkedFundCashAccountId : linkedFundAccountId) : e.toAccountId,
    toAccountName: linkedFund ? (linkedFundIsCashIn ? linkedFundCashAccountName : linkedFundAccountName) : e.toAccountName,
    toAccountKind: linkedFund ? (linkedFundIsCashIn ? linkedFund?.CashAccount?.kind ?? e.toAccount?.kind ?? null : linkedFund?.Account?.kind ?? null) : e.toAccount?.kind ?? null,
    toAccountDebtDirection: e.toAccount?.debtDirection ?? null,
    toAccountIsSettlementDebt: isSettlementDebtAccountId(linkedFund ? (linkedFundIsCashIn ? linkedFundCashAccountId : linkedFundAccountId) : e.toAccountId),
    note: linkedWealth
      ? buildWealthCashFlowNote({
          action: linkedWealth.action,
          productName: linkedWealth.WealthProduct?.name ?? linkedWealth.productName ?? e.fundName,
          units: linkedWealth.units == null ? null : toNumber(linkedWealth.units),
          userNote: linkedWealth.note,
        })
      : linkedFund
        ? linkedFund.note ?? e.note
      : e.note,
    businessNote: linkedWealth?.note ?? null,
    toNote: e.toNote,
    fundSubtype: linkedWealth?.action ?? linkedFund?.fundSubtype ?? e.fundSubtype,
    fundCode: linkedWealth ? null : linkedFund?.fundCode ?? e.fundCode,
    fundName: linkedWealth?.WealthProduct?.name ?? linkedWealth?.productName ?? linkedFund?.fundName ?? e.fundName,
    wealthProductId: linkedWealth?.wealthProductId ?? e.wealthProductId ?? null,
    source: linkedFund?.source ?? e.source,
    insuranceProductId: e.insuranceProductId ?? null,
    debtPrincipalAmount: e.debtPrincipalAmount != null ? toNumber(e.debtPrincipalAmount) : null,
    debtInterestAmount: e.debtInterestAmount != null ? toNumber(e.debtInterestAmount) : null,
    debtFeeAmount: e.debtFeeAmount != null ? toNumber(e.debtFeeAmount) : null,
    realizedProfit: e.realizedProfit != null ? toNumber(e.realizedProfit) : null,
    depositAnnualRate: linkedWealth?.annualRate != null ? toNumber(linkedWealth.annualRate) : e.depositAnnualRate != null ? toNumber(e.depositAnnualRate) : null,
    depositInterest: linkedWealth?.interest != null ? toNumber(linkedWealth.interest) : e.depositInterest != null ? toNumber(e.depositInterest) : null,
    fundProductType: linkedWealth ? "wealth" : linkedFund?.fundProductType ?? e.fundProductType,
    metalTypeId: e.metalTypeId ?? null,
    metalTypeName: e.metalTypeName ?? null,
    metalUnitId: e.metalUnitId ?? null,
    metalUnitName: e.metalUnitName ?? null,
    metalQuantity: e.metalQuantity != null ? toNumber(e.metalQuantity) : null,
    metalUnitPrice: e.metalUnitPrice != null ? toNumber(e.metalUnitPrice) : null,
    metalFee: e.metalFee != null ? toNumber(e.metalFee) : null,
    fundUnits: linkedWealth?.units != null ? toNumber(linkedWealth.units) : linkedFund?.units != null ? toNumber(linkedFund.units) : e.fundUnits != null ? toNumber(e.fundUnits) : null,
    fundNav: linkedWealth?.nav != null ? toNumber(linkedWealth.nav) : linkedFund?.nav != null ? toNumber(linkedFund.nav) : e.fundNav != null ? toNumber(e.fundNav) : null,
    fundFee: linkedWealth?.fee != null ? toNumber(linkedWealth.fee) : linkedFund?.fee != null ? toNumber(linkedFund.fee) : e.fundFee != null ? toNumber(e.fundFee) : null,
    fundConfirmDate: linkedWealth?.confirmDate ? toIsoOrNull(linkedWealth.confirmDate) : linkedFund?.confirmDate ? toIsoOrNull(linkedFund.confirmDate) : toIsoOrNull(e.fundConfirmDate),
    fundArrivalDate: linkedWealth?.arrivalDate ? toIsoOrNull(linkedWealth.arrivalDate) : linkedFund?.arrivalDate ? toIsoOrNull(linkedFund.arrivalDate) : toIsoOrNull(e.fundArrivalDate),
    fundSourceEntryId: e.fundSourceEntryId ?? null,
    fundArrivalAmount: linkedWealthArrivalAmount ?? (linkedFund?.arrivalAmount != null ? toNumber(linkedFund.arrivalAmount) : e.fundArrivalAmount != null ? toNumber(e.fundArrivalAmount) : null),
    ...buildEntryBusinessLinkSummary(e),
    attachments: (e.Attachment || []).map((attachment: any) => ({
      id: attachment.id,
      name: attachment.name || t("attachments.title"),
      mimeType: attachment.mimeType ?? null,
      url: attachment.url || `/api/v1/attachments/${encodeURIComponent(attachment.id)}`,
    })),
    entryTags: (e.EntryTag || []).map((et: any) => ({
      tagId: et.tagId,
      Tag: et.Tag ? { name: et.Tag.name, color: et.Tag.color } : null,
    })),
  });
  });
  const pagedDetailEntries: DetailEntry[] = detailAll
    ? allDetailEntries
    : allDetailEntries.slice((safeDetailPage - 1) * pageSize, safeDetailPage * pageSize);
  const creditBillDetailEntries = showAllCreditBillDetails
    ? allDetailEntries
    : (creditCardBillDetails?.details ?? []);
  const creditBillDetailTitle = showAllCreditBillDetails
    ? t("creditBill.allDetails")
    : creditCardBill?.statementMonth
      ? t("creditBill.detailTitleWithMonth", { month: creditCardBill.statementMonth })
      : t("creditBill.detailTitle");

  const allDepositAccounts = accounts.filter((account) => isDepositAccount(account));
  const selectedDepositAccountIds =
    view === "deposit" && selectedAccount
      ? isDepositAccount(selectedAccount)
        ? [selectedAccount.id]
        : selectedAccount.institutionId
          ? allDepositAccounts
              .filter((account) => account.institutionId === selectedAccount.institutionId)
              .map((account) => account.id)
          : []
      : [];
  const currentDepositTransactionEntries =
    view === "deposit"
      ? await loadDepositTransactionDetailLike({
          householdId,
          accountIds: selectedDepositAccountIds,
        })
      : [];

  const depositEntries =
    view === "deposit"
      ? [
          ...(currentDepositTransactionEntries || []).map((entry) => {
            const depositSubtype = String(entry.fundSubtype ?? "");
            const isRedeemEntry = depositSubtype === "redeem" || depositSubtype === "switch_out";
            const cashAccountLabel = isRedeemEntry
              ? (entry.toAccountId ? (accountLabelById.get(entry.toAccountId) ?? entry.toAccountName ?? "") : (entry.toAccountName ?? ""))
              : (entry.accountId ? (accountLabelById.get(entry.accountId) ?? entry.accountName ?? "") : (entry.accountName ?? ""));
            const entryDate = toYmdOrNull(entry.date) ?? "";
            const arrivalDate = toYmdOrNull(entry.fundArrivalDate);
            return {
              id: entry.id,
              date: entryDate,
              typeLabel: entry.fundSubtype === "redeem" ? t("deposit.subtype.redeem") : t("deposit.subtype.buy"),
              fundName: entry.fundName ?? entry.fundCode ?? "",
              maturityDate: arrivalDate,
              cashAccountLabel,
              note: entry.note ?? "",
              amount: entry.toAccountId === accountId ? Math.abs(toNumber(entry.fundArrivalAmount ?? entry.amount)) : toNumber(entry.amount),
              businessLinkCount: entry.businessLinkCount ?? 0,
              businessLinkLabels: entry.businessLinkLabels ?? [],
              edit: {
                type: "investment" as const,
                date: entryDate,
                amount: Math.abs(toNumber(entry.amount)),
                note: entry.note ?? "",
                accountId: isRedeemEntry ? (entry.accountId ?? "") : (entry.toAccountId ?? ""),
                cashAccountId: isRedeemEntry ? (entry.toAccountId ?? "") : (entry.accountId ?? ""),
                fundName: entry.fundName ?? undefined,
                fundNav: entry.fundNav ?? undefined,
                depositAnnualRate:
                  entry.depositAnnualRate != null
                    ? toNumber(entry.depositAnnualRate)
                    : entry.fundNav != null ? toNumber(entry.fundNav) : undefined,
                depositInterest:
                  entry.depositInterest != null
                    ? toNumber(entry.depositInterest)
                    : undefined,
                depositSourceEntryId: entry.depositSourceEntryId ?? undefined,
                fundArrivalDate: arrivalDate ?? undefined,
                fundProductType: "deposit",
                fundSubtype: entry.fundSubtype ?? "buy",
              },
            };
          }),
          ...(selectedDepositAccountIds.length > 0 ? entries : [])
            .filter((entry) => {
              // Keep only ordinary income/expense/transfer rows here: deposit
              // business entries (fundProductType=deposit) are already rendered
              // by loadDepositTransactionDetailLike, so skip them to avoid duplicates.
              if (entry.deletedAt) return false;
              if (entry.fundProductType === "deposit") return false;
              if (!(entry.accountId && selectedDepositAccountIds.includes(entry.accountId)) &&
                  !(entry.toAccountId && selectedDepositAccountIds.includes(entry.toAccountId))) {
                return false;
              }
              return true;
            })
            .map((entry) => {
              const entryDate = toYmdOrNull(getDetailEntryDisplayDate(entry, accountId)) ?? "";
              const isDepositReceivingSide = entry.toAccountId === accountId;
              const effectiveAmount = effectiveAmountForAccount(entry, accountId);
              const typeLabel =
                entry.type === "income"
                  ? t("transaction.type.income")
                  : entry.type === "expense"
                    ? t("transaction.type.expense")
                    : entry.type === "transfer"
                      ? t("transaction.type.transfer")
                      : formatType(t, entry.type);
              return {
                id: entry.id,
                date: entryDate,
                typeLabel,
                fundName: entry.categoryName ?? "",
                maturityDate: null,
                cashAccountLabel: isDepositReceivingSide
                  ? (entry.accountId ? (accountLabelById.get(entry.accountId) ?? entry.accountName ?? "") : (entry.accountName ?? ""))
                  : (entry.toAccountId ? (accountLabelById.get(entry.toAccountId) ?? entry.toAccountName ?? "") : (entry.toAccountName ?? "")),
                note: entry.note ?? "",
                amount: effectiveAmount,
                businessLinkCount: 0,
                businessLinkLabels: [],
                edit: {
                  type: entry.type === "income" || entry.type === "expense" || entry.type === "transfer" ? entry.type : ("expense" as const),
                  date: entryDate,
                  amount: Math.abs(toNumber(entry.amount)),
                  note: entry.note ?? "",
                  accountId: entry.accountId ?? "",
                  toAccountId: entry.toAccountId ?? undefined,
                  toAccountName: entry.toAccountName ?? undefined,
                  categoryId: entry.categoryId ?? undefined,
                  categoryName: entry.categoryName ?? undefined,
                  source: entry.source ?? null,
                },
              };
            }),
        ]
      : [];

  const insuranceEntries =
    view === "insurance"
      ? (await loadInsuranceTransactionDetailLike({ householdId, accountId: accountId ?? "" }))
          .map((entry) => {
            const insuranceSubtype = String(entry.fundSubtype ?? "");
            const isRedeemEntry = insuranceSubtype === "redeem" || insuranceSubtype === "switch_out";
            const cashAccountLabel = isRedeemEntry ? (entry.toAccountName ?? "") : (entry.accountName ?? "");
            const amount = isRedeemEntry ? Math.abs(toNumber(entry.amount)) : -Math.abs(toNumber(entry.amount));
            const entryDate = toYmdOrNull(entry.date) ?? "";
            return {
              id: entry.id,
              date: entryDate,
              typeLabel: isRedeemEntry ? t("fund.subtype.redeem") : t("insuranceShell.entryType.premium"),
              productName: entry.fundName ?? "",
              cashAccountLabel,
              cashAccountId: isRedeemEntry ? (entry.toAccountId ?? null) : (entry.accountId ?? null),
              note: entry.note ?? "",
              amount,
              businessLinkCount: entry.businessLinkCount ?? 0,
              businessLinkLabels: entry.businessLinkLabels ?? [],
              coverageAmount:
                (entry as { coverageAmount?: number | null }).coverageAmount ?? null,
              paymentTermYears:
                (entry as { paymentTermYears?: number | null }).paymentTermYears ?? null,
              edit: {
                type: "investment" as const,
                date: entryDate,
                amount: Math.abs(toNumber(entry.amount)),
                note: entry.note ?? "",
                accountId: isRedeemEntry ? (entry.accountId ?? "") : (entry.toAccountId ?? ""),
                cashAccountId: isRedeemEntry ? (entry.toAccountId ?? "") : (entry.accountId ?? ""),
                insuranceProductId: (entry as { insuranceProductId?: string | null }).insuranceProductId ?? null,
                fundName: entry.fundName ?? undefined,
                fundProductType: entry.fundProductType ?? undefined,
                fundSubtype: entry.fundSubtype ?? undefined,
                source: "insurance",
              },
            };
          })
      : [];

  const insuranceHoldings =
    view === "insurance" && selectedAccount
      ? insuranceProductsForAccount.map((product) => {
          const relatedEntries = insuranceEntries.filter(
            (entry) => entry.edit?.insuranceProductId === product.id,
          );
          const sortedEntries = [...relatedEntries].sort((a, b) => a.date.localeCompare(b.date));
          const metricMode = getInsuranceMetricMode(product.productType, product.accountingType, product.cashValueEnabled);
          const balance = relatedEntries.reduce((sum, entry) => sum + insuranceCashValueDelta({
            amount: entry.amount,
            fundSubtype: entry.edit?.fundSubtype,
            source: "insurance",
          }), 0);
          const totalPremium = relatedEntries
            .filter((entry) => entry.amount < 0)
            .reduce((sum, entry) => sum + Math.abs(entry.amount), 0);
          const coverageAmount = Number(product.coverageAmount ?? 0);
          return {
            id: product.id,
            label: product.name,
            policyNo: product.policyNo ?? null,
            startDate: sortedEntries[0]?.date ?? product.startDate?.toISOString().slice(0, 10) ?? null,
            ownerName: product.PolicyholderPerson?.name ?? product.OwnerGroup?.name ?? "",
            policyholderPersonId: product.policyholderPersonId ?? null,
            insuredPersonName: product.InsuredPerson?.name ?? product.InsuredUser?.name ?? "",
            insuredPersonId: product.insuredPersonId ?? null,
            beneficiaryName: product.beneficiaryName ?? null,
            displayTypeLabel: getInsuranceDisplayTypeLabel(metricMode),
            cashValueLabel: getInsuranceMetricLabel(metricMode),
            cashValue: metricMode === "coverage" ? null : balance,
            coverageAmount,
            totalPremium,
            statusLabel:
              product.status === "matured"
                ? t("insuranceShell.status.matured")
                : product.status === "surrendered"
                  ? t("insuranceShell.status.surrendered")
                  : product.status === "lapsed"
                    ? t("insuranceShell.status.lapsed")
                    : t("insuranceShell.status.active"),
            status: product.status,
            frequencyLabel:
              product.premiumFrequencyMonths === 1
                ? t("insuranceShell.frequency.monthly")
                : product.premiumFrequencyMonths === 3
                  ? t("insuranceShell.frequency.quarterly")
                  : product.premiumFrequencyMonths === 6
                    ? t("insuranceShell.frequency.semiannual")
                    : product.premiumFrequencyMonths === 12
                      ? t("insuranceShell.frequency.annual")
                      : product.premiumFrequencyMonths === 999999
                        ? t("insuranceShell.frequency.single")
                        : "-",
            paymentTermYears: product.paymentTermYears ? Number(product.paymentTermYears) : null,
            coverageTermYears: product.coverageTermYears ? Number(product.coverageTermYears) : null,
            institutionId: product.institutionId ?? null,
            institutionName: selectedAccount.Institution?.name ?? null,
            ownerGroupId: product.ownerGroupId ?? null,
            productType: product.productType ?? null,
            accountingType: product.accountingType ?? null,
            currency: product.currency ?? null,
            accountId: product.accountId ?? null,
            premiumMode: product.premiumMode ?? null,
            premiumFrequencyMonths: product.premiumFrequencyMonths ?? null,
            cashValueEnabled: product.cashValueEnabled ?? null,
            effectiveDate: product.effectiveDate?.toISOString().slice(0, 10) ?? null,
            maturityDate: product.maturityDate?.toISOString().slice(0, 10) ?? null,
            note: product.note ?? null,
            relatedEntryIds: relatedEntries.map((entry) => entry.id),
          };
        })
      : [];
  const allDepositAccountIds = allDepositAccounts.map((account) => account.id);
  const allDepositEntries =
    allDepositAccountIds.length > 0
      ? await loadDepositTransactionDetailLike({
          householdId,
          accountIds: allDepositAccountIds,
        })
      : [];

  const allWealthAccounts = restrictAccountList(investmentAccountOptions, (account) => account.investProductType === "wealth");
  const allWealthAccountIds = allWealthAccounts.map((account) => account.id);
  const allWealthEntries =
    allWealthAccountIds.length > 0
      ? await loadWealthTransactionEntryLike({
          householdId,
          accountIds: allWealthAccountIds,
        })
      : [];

  function buildWealthHoldingOptions(sourceEntryPool: Array<any>) {
    if (allWealthAccountIds.length === 0) return [];
    const accountNameById = new Map(allWealthAccounts.map((account) => [account.id, account.label || account.name]));
    const buckets = new Map<string, {
      id: string;
      label: string;
      fundName: string;
      wealthProductId: string | null;
      wealthAccountId: string;
      wealthAccountLabel: string;
      remainingAmount: number;
      remainingUnits: number;
      hasUnits: boolean;
      annualRate: number | null;
      termDays: number | null;
      firstDate: string;
      movements: Array<{ date: string; delta: number }>;
      unitMovements: Array<{ date: string; delta: number }>;
    }>();

    for (const entry of sourceEntryPool) {
      if (entry.fundProductType !== "wealth" || entry.deletedAt) continue;
      const amountValue = toNumber(entry.amount);
      const principalAmountValue = entry.wealthPrincipalAmount != null ? toNumber(entry.wealthPrincipalAmount) : amountValue;
      const isRedeemEntry =
        entry.fundSubtype === "redeem" ||
        entry.fundSubtype === "switch_out" ||
        (amountValue > 0 && allWealthAccountIds.includes(entry.accountId ?? "") && entry.fundSubtype !== "dividend_cash");
      const isDividendEntry = entry.fundSubtype === "dividend_cash";
      const wealthAccountId = (isRedeemEntry ? entry.accountId : entry.toAccountId) ?? "";
      if (!wealthAccountId || !allWealthAccountIds.includes(wealthAccountId)) continue;

      const productName = entry.WealthProduct?.name ?? entry.fundName ?? t("sidebar.wealthHolding.unnamed");
      const productLabel = entry.WealthProduct?.shortName?.trim() || productName;
      const productKey = entry.wealthProductId ? `product:${entry.wealthProductId}` : `name:${productName}`;
      const key = `${wealthAccountId}\u001f${productKey}`;
      const existing = buckets.get(key);
      const annualRate =
        entry.depositAnnualRate != null
          ? toNumber(entry.depositAnnualRate)
          : entry.WealthProduct?.annualRate != null
            ? toNumber(entry.WealthProduct.annualRate)
            : null;
      const principalDelta = isRedeemEntry
        ? -Math.abs(principalAmountValue)
        : isDividendEntry
          ? 0
          : Math.abs(principalAmountValue);
      const unitsValue = entry.fundUnits == null ? null : Math.abs(toNumber(entry.fundUnits));
      const unitsDelta = unitsValue == null || isDividendEntry ? 0 : isRedeemEntry ? -unitsValue : unitsValue;
      const movementDate = toYmdOrNull(entry.date) ?? "";

      if (existing) {
        existing.remainingAmount += principalDelta;
        if (unitsValue != null) {
          existing.hasUnits = true;
          existing.remainingUnits += unitsDelta;
        }
        if (principalDelta !== 0 && movementDate) {
          existing.movements.push({ date: movementDate, delta: Number(principalDelta.toFixed(2)) });
        }
        if (unitsValue != null && unitsDelta !== 0 && movementDate) {
          existing.unitMovements.push({ date: movementDate, delta: Number(unitsDelta.toFixed(6)) });
        }
        if (existing.annualRate == null && annualRate != null) existing.annualRate = annualRate;
        if (existing.termDays == null && entry.WealthProduct?.termDays != null) existing.termDays = entry.WealthProduct.termDays;
      } else {
        buckets.set(key, {
          id: key,
          label: productLabel,
          fundName: productName,
          wealthProductId: entry.wealthProductId ?? null,
          wealthAccountId,
          wealthAccountLabel: accountNameById.get(wealthAccountId) ?? entry.toAccountName ?? entry.accountName ?? t("sidebar.wealthAccount"),
          remainingAmount: principalDelta,
          remainingUnits: unitsDelta,
          hasUnits: unitsValue != null,
          annualRate,
          termDays: entry.WealthProduct?.termDays ?? null,
          firstDate: movementDate,
          movements: principalDelta !== 0 && movementDate ? [{ date: movementDate, delta: Number(principalDelta.toFixed(2)) }] : [],
          unitMovements: unitsValue != null && unitsDelta !== 0 && movementDate ? [{ date: movementDate, delta: Number(unitsDelta.toFixed(6)) }] : [],
        });
      }
    }

    return Array.from(buckets.values())
      .filter((holding) => holding.movements.some((movement) => movement.delta > 0))
      .map((holding) => ({
        id: holding.id,
        label: holding.label,
        subLabel: [
          holding.wealthAccountLabel,
          holding.annualRate != null ? t("sidebar.wealthHolding.annualRate", { rate: holding.annualRate }) : "",
          holding.termDays ? t("sidebar.wealthHolding.termDays", { days: holding.termDays }) : "",
          t("sidebar.wealthHolding.redeemable", { amount: formatMoney(holding.remainingAmount) }),
          holding.hasUnits ? t("sidebar.wealthHolding.units", { units: holding.remainingUnits.toFixed(6) }) : "",
        ].filter(Boolean).join(" · "),
        fundName: holding.fundName,
        wealthProductId: holding.wealthProductId,
        wealthAccountId: holding.wealthAccountId,
        wealthAccountLabel: holding.wealthAccountLabel,
        remainingAmount: Number(holding.remainingAmount.toFixed(2)),
        remainingUnits: Number(holding.remainingUnits.toFixed(6)),
        hasUnits: holding.hasUnits,
        annualRate: holding.annualRate,
        termDays: holding.termDays,
        firstDate: holding.firstDate,
        movements: holding.movements,
        unitMovements: holding.unitMovements,
      }))
      .sort((a, b) => {
        if (a.wealthAccountLabel !== b.wealthAccountLabel) return a.wealthAccountLabel.localeCompare(b.wealthAccountLabel, "zh-Hans-CN");
        return a.label.localeCompare(b.label, "zh-Hans-CN");
      });
  }

  const wealthHoldingOptions = buildWealthHoldingOptions(allWealthEntries);

  function buildDepositLots(sourceEntryPool: Array<any>, activeDepositAccountIds: Set<string>, sortAccountId?: string | null) {
    if (activeDepositAccountIds.size === 0) return [];
    const sourceEntries = sourceEntryPool.filter(
      (entry) =>
        entry.fundProductType === "deposit" &&
        !entry.deletedAt &&
        ((entry.accountId && activeDepositAccountIds.has(entry.accountId)) ||
          (entry.toAccountId && activeDepositAccountIds.has(entry.toAccountId))),
    );
    if (sourceEntries.length === 0) return [];

    const accountNameById = new Map(allDepositAccounts.map((account) => [account.id, account.name]));
    const sourceEntryById = new Map(sourceEntries.map((entry) => [entry.id, entry]));
    const depositSourceEntries = [...sourceEntries].sort((a, b) =>
      compareDetailEntriesAsc(a, b, sortAccountId ?? undefined),
    );

    const lotBuckets = new Map<
      string,
      Array<{
        id: string;
        fundName: string;
        maturityDate: string | null;
        remainingAmount: number;
        depositAccountId: string;
        depositAccountName: string;
        relatedEntryIds: string[];
      }>
    >();

    const allLots: Array<{
      id: string;
      fundName: string;
      maturityDate: string | null;
      remainingAmount: number;
      depositAccountId: string;
      depositAccountName: string;
      relatedEntryIds: string[];
    }> = [];

    for (const entry of depositSourceEntries) {
      const fundName = (entry.fundName ?? entry.fundCode ?? "").trim() || t("sidebar.deposit.unnamed");
      const maturityDate = toYmdOrNull(entry.fundArrivalDate);
      const isRedeemEntry = entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out";
      const amountValue = isRedeemEntry
        ? Math.max(
            0,
            Math.abs(toNumber(entry.amount)) - Math.max(0, toNumber(entry.depositInterest)),
          )
        : Math.abs(toNumber(entry.fundArrivalAmount ?? entry.amount));
      const depositAccountId = (
        isRedeemEntry ? entry.accountId : entry.toAccountId
      ) ?? "";
      const depositAccountName = accountNameById.get(depositAccountId) ?? entry.toAccountName ?? entry.accountName ?? t("sidebar.deposit.fallbackName");
      const lotKey = `${depositAccountId}\u001f${fundName}\u001f${maturityDate ?? ""}`;

      if (!isRedeemEntry) {
        const lot = {
          id: entry.id,
          fundName,
          maturityDate,
          remainingAmount: amountValue,
          depositAccountId,
          depositAccountName,
          relatedEntryIds: [entry.id],
        };
        const bucket = lotBuckets.get(lotKey);
        if (bucket) bucket.push(lot);
        else lotBuckets.set(lotKey, [lot]);
        allLots.push(lot);
        continue;
      }

      const linkedBucket = entry.depositSourceEntryId
        ? allLots.filter((lot) => lot.id === entry.depositSourceEntryId)
        : [];
      const bucket = linkedBucket.length > 0 ? linkedBucket : (lotBuckets.get(lotKey) ?? []);
      for (const lot of bucket) {
        if (lot.remainingAmount <= 0) continue;
        lot.relatedEntryIds.push(entry.id);
        lot.remainingAmount = 0;
        break;
      }
    }

    return allLots
      .map((lot) => {
        const sourceEntry = sourceEntryById.get(lot.id);
        const originalAmount = Number(Math.abs(toNumber(sourceEntry?.fundArrivalAmount ?? sourceEntry?.amount ?? lot.remainingAmount)).toFixed(2));
        const annualRate = (() => {
          if (sourceEntry?.depositAnnualRate != null) return toNumber(sourceEntry.depositAnnualRate);
          return sourceEntry?.fundNav != null ? toNumber(sourceEntry.fundNav) : null;
        })();
        const startDate = toYmdOrNull(sourceEntry?.date);
        const expectedInterest =
          lot.remainingAmount > 0.0001
            ? calcDepositExpectedInterest({
                principal: originalAmount,
                annualRate,
                startDate,
                maturityDate: lot.maturityDate,
                today: formatDateUtc(new Date()),
              })
            : null;
        return {
          id: lot.id,
          label: lot.fundName,
          originalAmount,
          subLabel: [
            lot.depositAccountName,
            lot.maturityDate ? t("sidebar.depositLot.maturity", { date: lot.maturityDate }) : "",
            lot.remainingAmount > 0.0001 ? t("sidebar.depositLot.withdrawable", { amount: formatMoney(lot.remainingAmount) }) : t("sidebar.depositLot.closed"),
          ]
            .filter(Boolean)
            .join(" · "),
          fundName: lot.fundName,
          startDate,
          maturityDate: lot.maturityDate,
          remainingAmount: Number(lot.remainingAmount.toFixed(2)),
          status: lot.remainingAmount > 0.0001 ? "open" as const : "closed" as const,
          annualRate,
          expectedInterest,
          depositAccountId: lot.depositAccountId,
          depositAccountLabel: lot.depositAccountName,
          relatedEntryIds: lot.relatedEntryIds,
        };
      })
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === "open" ? -1 : 1;
        const dateA = a.maturityDate ?? "9999-12-31";
        const dateB = b.maturityDate ?? "9999-12-31";
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return a.label.localeCompare(b.label, "zh-Hans-CN");
      });
  }

  const activeDepositAccountIds = new Set<string>();
  if (selectedAccount) {
    if (isDepositAccount(selectedAccount)) {
      activeDepositAccountIds.add(selectedAccount.id);
    }
    if (selectedAccount.institutionId) {
      for (const account of allDepositAccounts) {
        if (account.institutionId === selectedAccount.institutionId) {
          activeDepositAccountIds.add(account.id);
        }
      }
    }
    for (const entry of allDepositEntries) {
      if (entry.fundProductType !== "deposit" || entry.deletedAt) continue;
      if (entry.accountId !== selectedAccount.id && entry.toAccountId !== selectedAccount.id) continue;
      const isRedeemEntry = entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out";
      const depositAccountId = (isRedeemEntry ? entry.accountId : entry.toAccountId) ?? "";
      if (depositAccountId && allDepositAccounts.some((account) => account.id === depositAccountId)) {
        activeDepositAccountIds.add(depositAccountId);
      }
    }
  }
  const depositLots = buildDepositLots(
    entries,
    activeDepositAccountIds,
    selectedAccount && isDepositAccount(selectedAccount) ? selectedAccount.id : undefined,
  );
  const allDepositLots = buildDepositLots(allDepositEntries, new Set(allDepositAccountIds));
  const scopedOpenDepositLots = depositLots.filter((lot) => lot.status === "open" && lot.remainingAmount > 0.0001);
  const globalOpenDepositLots = allDepositLots.filter((lot) => lot.status === "open" && lot.remainingAmount > 0.0001);
  const redeemLotSource = scopedOpenDepositLots.length > 0 ? scopedOpenDepositLots : globalOpenDepositLots;
  const redeemLotOptions = redeemLotSource
    .map((lot) => ({
      id: lot.id,
      label: lot.label,
      subLabel: lot.subLabel,
      fundName: lot.fundName,
      startDate: lot.startDate,
      maturityDate: lot.maturityDate,
      remainingAmount: lot.remainingAmount,
      annualRate: lot.annualRate,
      depositAccountId: lot.depositAccountId,
      depositAccountLabel: lot.depositAccountLabel,
    }));
  const selectedAccountDisplayValue = selectedAccount
    ? accountDisplayValueById.get(selectedAccount.id) ?? selectedAccountRawBalanceValue
    : selectedAccountRawBalanceValue;
  const selectedViewHeaderAmount = view === "debt"
    ? debtDisplaySummaryValue
    : view === "investproperty" && investpropertyFilteredData
      ? investpropertyFilteredData.totalMarketValue
      : selectedAccountDisplayValue;
  const showDerivedViewHeaderAmount =
    !!currentInvestData ||
    (view === "investstock" && !!investstockData) ||
    (view === "investproperty" && !!investpropertyFilteredData) ||
    (view === "insurance" && !!selectedAccount) ||
    (view === "deposit" && !!selectedAccount);
  const headerFxBalance = showDerivedViewHeaderAmount ? selectedViewHeaderAmount : selectedAccountRawBalanceValue;
  const defaultDepositAccountForSelectedInstitution =
    selectedAccount && isDepositAccount(selectedAccount)
      ? selectedAccount.id
      : selectedAccount?.institutionId
        ? allDepositAccounts.find((account) => account.institutionId === selectedAccount.institutionId)?.id ?? ""
        : "";
  const defaultCashAccountForSelectedInstitution =
    selectedAccount && cashAccountList.some((account) => account.id === selectedAccount.id)
      ? selectedAccount.id
      : selectedAccount?.institutionId
        ? cashAccountList.find((account) => account.kind === "bank_debit" && account.institutionId === selectedAccount.institutionId)?.id
        ?? cashAccountList.find((account) => account.institutionId === selectedAccount.institutionId)?.id
        ?? cashAccountList[0]?.id
        ?? ""
      : cashAccountList[0]?.id ?? "";
  const defaultStockCashAccountId = (() => {
    const stockAccount = stockAccountOptions.find((account) => account.id === defaultStockInvestmentAccountId) ?? null;
    const stockOwnerGroupId = (stockAccount?.groupId ?? "").trim();
    if (stockAccount?.institutionId) {
      const sameOwnerCash = (account: typeof cashAccountList[number]) =>
        (!stockOwnerGroupId || (account.groupId ?? "") === stockOwnerGroupId);
      const cashAccount = cashAccountList.find((account) =>
        account.institutionId === stockAccount.institutionId && account.institutionType === "brokerage" && sameOwnerCash(account))
        ?? cashAccountList.find((account) =>
          account.institutionId === stockAccount.institutionId && sameOwnerCash(account))
        ?? null;
      return cashAccount?.id ?? defaultCashAccountForSelectedInstitution;
    }
    return defaultCashAccountForSelectedInstitution;
  })();
  const defaultStockCashAccountName = cashAccountList.find((account) => account.id === defaultStockCashAccountId)?.label ?? null;
  const defaultStockTransferFromAccountId = (() => {
    const stockAccount = stockAccountOptions.find((account) => account.id === defaultStockInvestmentAccountId) ?? null;
    const stockOwnerGroupId = (stockAccount?.groupId ?? "").trim();
    const sameOwner = (account: typeof cashAccountList[number]) =>
      (!stockOwnerGroupId || (account.groupId ?? "") === stockOwnerGroupId);
    // Stock transfer: default the source to a bank debit card of the same owner
    // (not the securities cash account itself, and not cash/credit cards).
    return cashAccountList.find((account) => account.id !== defaultStockCashAccountId && account.kind === "bank_debit" && sameOwner(account))?.id
      ?? cashAccountList.find((account) => account.id !== defaultStockCashAccountId && sameOwner(account) && account.kind !== "cash")?.id
      ?? "";
  })();
  const defaultWealthAccountForSelectedInstitution =
    selectedAccount && isPureInvestmentAccount(selectedAccount) && selectedAccount.investProductType === "wealth"
      ? selectedAccount.id
      : selectedAccount?.institutionId
        ? investmentAccountOptions.find((account) => account.investProductType === "wealth" && account.institutionId === selectedAccount.institutionId)?.id
          ?? investmentAccountOptions.find((account) => account.investProductType === "wealth")?.id
          ?? ""
        : investmentAccountOptions.find((account) => account.investProductType === "wealth")?.id ?? "";
  // Keep the server/client boundary plain: Prisma Decimal/Date fields and
  // relation objects are not serializable as client component props.
  const selectedAccountEditData = selectedAccount
    ? toAccountQuickEditValue(selectedAccount)
    : null;

  return (
    <div className="flex h-full w-full bg-transparent">
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="page-header">
          <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-2 md:px-5">
            <div className="flex min-w-0 flex-wrap items-center gap-3 text-sm">
              {view === "investproperty" && !selectedAccountEditData ? (
                <span className="page-title">
                  {fixedAssetTypeParam ? t(`fixedAsset.type.${fixedAssetTypeParam}`) : t("txForm.fixedAssetToggle")}
                </span>
              ) : selectedAccountEditData ? (
                <AccountTypeQuickEdit
                  account={selectedAccountEditData}
                  accountLabel={selectedAccountLabel || selectedAccountEditData.name}
                />
              ) : (
                <span className="page-title">{selectedAccountLabel || t("statistics.allAccounts")}</span>
              )}
              {view === "debt" ? (
                <span className={`tabular-nums font-semibold ${pnlCls(debtDisplaySummaryValue)}`}>
                  {formatCurrencyMoney(debtDisplaySummaryValue, baseCurrency)}
                </span>
              ) : view === "investproperty" && investpropertyFilteredData ? (
                <span className={`tabular-nums font-semibold ${pnlCls(investpropertyFilteredData.totalMarketValue)}`}>
                  {formatCurrencyMoney(investpropertyFilteredData.totalMarketValue, selectedAccountCurrency)}
                </span>
              ) : !selectedAccount ? (
                <LiveAccountBalance mode="total" initialValue={totalNetWorthValue} isRedUp={isRedUp} baseCurrency={baseCurrency} />
              ) : showDerivedViewHeaderAmount ? (
                <span className={`tabular-nums font-semibold ${pnlCls(selectedViewHeaderAmount)}`}>{formatCurrencyMoney(selectedViewHeaderAmount, selectedAccountCurrency)}</span>
              ) : (
                <LiveAccountBalance
                  mode="account"
                  accountId={selectedAccount.id}
                  initialValue={selectedAccountRawBalanceValue}
                  isRedUp={isRedUp}
                  semantic={selectedAccount.kind === AccountKind.bank_credit ? "liability" : "default"}
                  displayMultiplier={selectedAccount.kind === AccountKind.bank_credit ? -1 : 1}
                  baseCurrency={selectedAccountCurrency}
                  accountDisplayMode="original"
                />
              )}
              {showSelectedAccountFxInline ? (
                <AccountFxRateInline
                  fromCurrency={selectedAccountCurrency}
                  toCurrency={baseCurrency}
                  accountBalance={headerFxBalance}
                  initialRate={selectedAccountFxRate?.rate ?? null}
                  initialRateDate={selectedAccountFxRate?.rateDate ?? null}
                  initialSource={selectedAccountFxRate?.source ?? null}
                />
              ) : null}
              {missingFxCurrencies.length > 0 ? (
                <span className="text-xs text-amber-700">
                  {t("sidebar.missingFxRateDetail", { currencies: missingFxCurrencies.join("、") })}
                </span>
              ) : null}
            </div>
            <div className={`flex shrink-0 flex-wrap items-center justify-end gap-2 ${currentInvestData ? "hidden md:flex" : ""}`}>
              <UnifiedEntryLauncher
                defaultAction={
                  isDepositView
                    ? "deposit"
                    : view === "investstock"
                      ? "stock"
                    : view === "investproperty"
                      ? "property"
                    : currentInvestData
                      ? (
                          selectedAccount?.investProductType === "metal"
                            ? "metal"
                            : selectedAccount?.investProductType === "wealth"
                              ? "wealth"
                              : "investment"
                        )
                      : view === "regularinvest"
                        ? "regular-task"
                        : view === "debt"
                          ? isDebtLoanLauncherContext
                            ? "loan"
                            : "debt"
                          : isInsuranceView
                            ? "insurance"
                            : isBillAccount
                              ? "transaction"
                              : "transaction"
                }
                context={{
                  defaultAccountId: selectedAccount?.id ?? accountId ?? "",
                  defaultCashAccountId: defaultCashAccountForSelectedInstitution,
                  defaultTransferFromAccountId: isBillAccount
                    ? (lastRepayFromAccountId ?? cashAccountList[0]?.id ?? "")
                    : view === "investstock"
                      ? (defaultStockCashAccountId || defaultStockTransferFromAccountId || (cashAccountList[0]?.id ?? ""))
                      : (selectedAccount?.id ?? accountId ?? ""),
                  defaultTransferToAccountId: isBillAccount ? (selectedAccount?.id ?? accountId ?? "") : "",
                  defaultInvestmentAccountId: currentFundInvestmentAccountId,
                  defaultStockAccountId: defaultStockInvestmentAccountId,
                  defaultStockCashAccountId,
                  defaultStockTransferFromAccountId,
                  defaultPropertyAccountId: defaultPropertyInvestmentAccountId,
                  defaultMetalAccountId: defaultMetalInvestmentAccountId,
                  defaultWealthAccountId: defaultWealthAccountForSelectedInstitution,
                  defaultDepositAccountId: isDepositView ? defaultDepositAccountForSelectedInstitution : "",
                  defaultDepositSubtype: isDepositView && globalOpenDepositLots.length > 0 ? "redeem" : "buy",
                  defaultInsuranceAccountId: isInsuranceView ? (selectedAccount?.id ?? "") : "",
                  defaultDebtAccountId: selectedDebtRow?.accountIds?.[0] ?? "",
                  defaultDebtInstitutionId: selectedDebtObjectValue,
                  defaultFundCode: isFundLikeInvestView ? selectedFundCode : "",
                  defaultFundName: currentFundDefault?.name ?? "",
                  defaultScheduledTaskType:
                    view === "regularinvest"
                      ? "fund_regular_invest"
                      : isInsuranceView
                        ? "insurance_premium"
                        : "fund_regular_invest",
                }}
                actions={[
                  { key: "transaction", label: t("entry.kind.transaction") },
                  { key: "advance", label: t("entry.kind.advance") },
                  { key: "transfer", label: isBillAccount ? t("transaction.type.creditCardRepayment") : t("entry.kind.transfer") },
                  { key: "fx", label: t("entry.kind.fx") },
                  { key: "investment", label: t("entry.kind.investment") },
                  { key: "stock", label: t("entry.kind.stock") },
                  { key: "stock-transfer", label: t("entry.kind.stockTransfer") },
                  { key: "property", label: t("entry.kind.property") },
                  { key: "metal", label: t("entry.kind.metal") },
                  { key: "wealth", label: t("entry.kind.wealth") },
                  { key: "deposit", label: t("entry.kind.deposit") },
                  { key: "insurance", label: t("entry.kind.insurance") },
                  { key: "debt", label: t("entry.kind.debt"), disabled: cashAccountList.length === 0 },
                  {
                    key: "loan",
                    label: t("entry.kind.loan"),
                    loanType: selectedLoanTypeForLauncher ?? "home",
                    children: [
                      { key: "loan", label: t("loan.type.home"), loanType: "home" },
                      { key: "loan", label: t("loan.type.mortgage"), loanType: "mortgage" },
                      { key: "loan", label: t("loan.type.consumer"), loanType: "consumer" },
                      { key: "loan", label: t("loan.type.other"), loanType: "other" },
                      {
                        key: "loan",
                        label: t("debtShell.repayment"),
                        mode: "repay_out",
                        ...(selectedLoanTypeForLauncher ? { loanType: selectedLoanTypeForLauncher } : {}),
                      },
                      {
                        key: "loan",
                        label: t("debtShell.prepayment"),
                        mode: "prepay_out",
                        ...(selectedLoanTypeForLauncher ? { loanType: selectedLoanTypeForLauncher } : {}),
                      },
                    ],
                  },
                  { key: "regular-task", label: t("entry.kind.regularTask") },
                ]}
              />
              <>
              <TransactionFormModal
                accounts={spendingAccountOptions} transferAccounts={transferAccountOptions}
                accountSSOptions={spendingAccountSSOptions} transferAccountSSOptions={transferAccountSSOptions}
                fixedAssetAccounts={propertyAccountOptions} fixedAssetAccountSSOptions={propertyAccountSSOptions}
                nestedFieldData={nestedFieldData}
                expenseCategories={expenseCategories.map((c) => ({
                  id: c.id,
                  label: c.label,
                  parentId: c.parentId,
                  type: c.type,
                  sortOrder: c.sortOrder,
                  isSystem: c.isSystem,
                }))}
                incomeCategories={incomeCategories.map((c) => ({
                  id: c.id,
                  label: c.label,
                  parentId: c.parentId,
                  type: c.type,
                  sortOrder: c.sortOrder,
                  isSystem: c.isSystem,
                }))}
                advanceCategories={advanceCategories.map((c) => ({
                  id: c.id,
                  label: c.label,
                  parentId: c.parentId,
                  type: c.type,
                  sortOrder: c.sortOrder,
                  isSystem: c.isSystem,
                }))}
                defaultAccountId={accountId || undefined}
                lastRepayToAccountId={lastRepayToAccountId} lastRepayFromAccountId={lastRepayFromAccountId}
                isCreditCardAccount={isBillAccount} showInvestment={isInvestAccount} action={createTransaction} editAction={updateTransactionFromDialog}
                allTags={tags.map(t => ({ id: t.id, name: t.name, color: t.color }))}
                hideTrigger
              />
              <StockTransactionFormModal
                defaultStockAccountId={defaultStockInvestmentAccountId}
                defaultCashAccountId={defaultStockCashAccountId}
                stockAccounts={stockAccountOptions}
                stockAccountSSOptions={stockAccountSSOptions}
                cashAccounts={cashAccountList}
                cashAccountSSOptions={cashAccountSSOptions}
              />
              <PropertyFormModal
                defaultPropertyAccountId={defaultPropertyInvestmentAccountId}
                defaultCashAccountId={defaultCashAccountForSelectedInstitution}
                propertyAccounts={propertyAccountOptions}
                propertyAccountSSOptions={propertyAccountSSOptions}
                cashAccounts={cashAccountList}
                cashAccountSSOptions={cashAccountSSOptions}
                propertyAssets={investpropertyFilteredData?.positions.map((position) => ({
                  id: position.propertyAssetId ?? position.fundCode,
                  name: position.name,
                  marketValue: position.marketValue,
                })) ?? []}
              />
              <InvestmentFormModal
                mode="create"
                hideTrigger
                accountId={currentFundInvestmentAccountId}
                accountProductType={selectedAccount && isPureInvestmentAccount(selectedAccount) ? selectedAccount.investProductType ?? null : null}
                defaults={{
                  fundCode: isFundLikeInvestView ? selectedFundCode || undefined : undefined,
                  fundName: currentFundDefault?.name ?? undefined,
                  fundUnits: currentFundDefault?.units ?? undefined,
                  confirmDays: currentFundConfirmDays,
                }}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                metalTypes={metalTypes}
                metalUnits={metalUnits}
                nestedFieldData={nestedFieldData}
                holdings={currentInvestData?.positions.map(p => ({ fundCode: p.fundCode, name: p.name, units: p.units })) ?? undefined}
                allEntries={currentInvestData?.allEntries.map(e => ({
                  id: e.id,
                  date: toYmdOrNull(e.date) ?? "",
                  createdAt: toIsoOrNull(e.createdAt),
                  fundConfirmDate: toYmdOrNull(e.fundConfirmDate),
                  fundArrivalDate: toYmdOrNull(e.fundArrivalDate),
                  fundSourceEntryId: e.fundSourceEntryId ?? null,
                  fundCode: e.fundCode ?? "",
                  fundName: e.fundName ?? null,
                  fundSubtype: e.fundSubtype ?? "",
                  fundUnits: e.fundUnits != null ? Number(e.fundUnits) : null,
                  source: e.source ?? null,
                  accountId: e.accountId ?? null,
                  toAccountId: e.toAccountId ?? null,
                  amount: e.amount != null ? Number(e.amount) : 0,
                })) ?? undefined}
                createAction={createTransaction}
                fundUnitsDecimals={fundUnitsDecimals}
              />
              <InvestmentFormModal
                mode="edit"
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                accountProductType={selectedAccount?.investProductType ?? null}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                metalTypes={metalTypes}
                metalUnits={metalUnits}
                nestedFieldData={nestedFieldData}
                holdings={currentInvestData?.positions.map(p => ({ fundCode: p.fundCode, name: p.name, units: p.units })) ?? undefined}
                allEntries={currentInvestData?.allEntries.map(e => ({
                  id: e.id,
                  date: toYmdOrNull(e.date) ?? "",
                  createdAt: toIsoOrNull(e.createdAt),
                  fundConfirmDate: toYmdOrNull(e.fundConfirmDate),
                  fundArrivalDate: toYmdOrNull(e.fundArrivalDate),
                  fundSourceEntryId: e.fundSourceEntryId ?? null,
                  fundCode: e.fundCode ?? "",
                  fundName: e.fundName ?? null,
                  fundSubtype: e.fundSubtype ?? "",
                  fundUnits: e.fundUnits != null ? Number(e.fundUnits) : null,
                  source: e.source ?? null,
                  accountId: e.accountId ?? null,
                  toAccountId: e.toAccountId ?? null,
                  amount: e.amount != null ? Number(e.amount) : 0,
                })) ?? undefined}
                createAction={createTransaction}
                editAction={editInvestment}
                fundUnitsDecimals={fundUnitsDecimals}
              />
              <WealthFormModal
                mode="create"
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                wealthHoldingOptions={wealthHoldingOptions}
                nestedFieldData={nestedFieldData}
                createAction={createTransaction}
                editAction={editInvestment}
              />
              <WealthFormModal
                mode="edit"
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                wealthHoldingOptions={wealthHoldingOptions}
                nestedFieldData={nestedFieldData}
                createAction={createTransaction}
                editAction={editInvestment}
              />
              <DepositFormModal
                mode="create"
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                redeemLotOptions={redeemLotOptions}
                allRedeemLotOptions={allDepositLots}
                nestedFieldData={nestedFieldData}
                createAction={createTransaction}
                editAction={editInvestment}
              />
              <DepositFormModal
                mode="edit"
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                redeemLotOptions={redeemLotOptions}
                allRedeemLotOptions={allDepositLots}
                nestedFieldData={nestedFieldData}
                createAction={createTransaction}
                editAction={editInvestment}
              />
              <InsuranceFormModal
                mode="create"
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                cashAccounts={cashAccountList}
                cashAccountSSOptions={cashAccountSSOptions}
                nestedFieldData={nestedFieldData}
              />
              {!isInsuranceView ? (
                <InsuranceEntryEditBridge
                  cashAccounts={cashAccountList}
                  cashAccountSSOptions={cashAccountSSOptions}
                  nestedFieldData={nestedFieldData}
                />
              ) : null}
              <RegularInvestForm
                accountId={selectedAccount?.id ?? investmentAccountOptions[0]?.id ?? ""}
                accountLabel={selectedAccountLabel}
                cashAccounts={cashAccountList}
                investmentAccounts={investmentAccountOptions.map((item) => ({ id: item.id, name: item.label, label: item.label }))}
                transferTargetAccounts={accountOptions}
                insuranceProductOptions={[]}
                cashAccountSSOptions={cashAccountSSOptions}
                investmentAccountSSOptions={investmentAccountSSOptions}
                transferTargetAccountSSOptions={allAccountSSOptions}
                nestedFieldData={nestedFieldData}
                action={regularInvestFormAction}
                showTriggerButton={false}
              />
              <DebtTransactionModal
                dialogType="debt"
                debtAccounts={debtAccounts.filter((account) => !!account.counterpartyId).map((account) => ({
                  id: account.id,
                  kind: account.kind,
                  label: debtAccountLabelById.get(account.id) ?? account.name,
                  subLabel: account.Counterparty?.name ? t("txForm.counterparty") : account.Institution?.name ? t("liabilities.institutionDeal") : t("account.kind.loan"),
                  institutionId: account.institutionId ?? null,
                  counterpartyId: account.counterpartyId ?? null,
                  institutionType: account.Institution?.type ?? account.Counterparty?.type ?? null,
                  isInstitutionLoan: false,
                  isConsumerLoan: account.isConsumerLoan === true,
                  loanType: null,
                  debtDirection: account.debtDirection ?? null,
                }))}
                cashAccounts={debtTransferAccountList}
                debtObjectOptions={debtObjectOptions}
                cashAccountSSOptions={debtTransferAccountSSOptions}
                nestedFieldData={nestedFieldData}
                defaultDebtAccountId={selectedDebtRow?.isLoan ? "" : selectedDebtRow?.accountIds?.[0] ?? ""}
                defaultDebtInstitutionId={selectedDebtRow?.isLoan ? "" : selectedDebtObjectValue}
                defaultCashAccountId={debtTransferAccountList[0]?.id ?? ""}
                action={createDebtTransaction}
                showTriggerButton={false}
              />
              <DebtTransactionModal
                dialogType="loan"
                debtAccounts={debtAccounts.filter((account) => account.kind === AccountKind.loan && !account.counterpartyId).map((account) => ({
                  id: account.id,
                  kind: account.kind,
                  label: debtAccountLabelById.get(account.id) ?? account.name,
                  subLabel: account.Institution?.name ? t("liabilities.institutionDeal") : t("account.kind.loan"),
                  institutionId: account.institutionId ?? null,
                  counterpartyId: null,
                  institutionType: account.Institution?.type ?? null,
                  // Keep filtering aligned with the sidebar loan section:
                  // loan accounts have kind=loan and no counterparty.
                  isInstitutionLoan: account.kind === AccountKind.loan && !account.counterpartyId,
                  isConsumerLoan: account.isConsumerLoan === true,
                  loanType: resolveLoanTypeValue(account.loanType, account.isConsumerLoan),
                  debtDirection: account.debtDirection ?? null,
                }))}
                cashAccounts={debtTransferAccountList}
                debtObjectOptions={loanObjectOptions}
                cashAccountSSOptions={debtTransferAccountSSOptions}
                nestedFieldData={nestedFieldData}
                expenseCategories={expenseCategories.map((c) => ({
                  id: c.id,
                  label: c.label,
                  name: c.name,
                  parentId: c.parentId,
                  type: c.type,
                  sortOrder: c.sortOrder,
                  isSystem: c.isSystem,
                }))}
                fixedAssetAccounts={propertyAccountOptions}
                fixedAssetAccountSSOptions={propertyAccountSSOptions}
                defaultDebtAccountId={selectedDebtRow?.isLoan ? selectedDebtRow?.accountIds?.[0] ?? "" : ""}
                defaultDebtInstitutionId={selectedDebtRow?.isLoan ? selectedDebtObjectValue : ""}
                defaultCashAccountId={debtTransferAccountList[0]?.id ?? ""}
                action={createDebtTransaction}
                showTriggerButton={false}
              />
              </>
            </div>
          </div>
        </header>

        <div className="flex flex-1 flex-col overflow-hidden bg-transparent">
          {isOverview ? (
            <DashboardOverview 
              totalNetWorth={totalNetWorthValue} 
              monthGrowth={monthGrowthValue} 
              isRedUp={isRedUp}
              createAction={createTransaction}
            />
          ) : view === "bill" && isBillAccount ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent">
              <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 md:p-5">
                {missingBillingDayForBill ? (
                  <div className="panel-surface border-amber-200 bg-amber-50/70">
                    <div className="px-4 py-4">
                      <div className="text-sm font-semibold text-amber-900">{t("sidebar.bill.missingBillingDayTitle")}</div>
                      <div className="mt-1 text-xs leading-5 text-amber-800">
                        {t("sidebar.bill.missingBillingDayBody")}
                      </div>
                      <div className="mt-2 text-xs text-amber-700">
                        {t("sidebar.bill.missingBillingDayAction")}
                      </div>
                    </div>
                  </div>
                ) : null}
                <ResizableVerticalSplit
                  storageKey="mmh:credit-bill:split-height"
                  hasLowerPane
                  defaultUpperHeight={360}
                  separatorLabel={t("sidebar.bill.resizeLabel")}
                  separatorTitle={t("sidebar.bill.resizeTitle")}
                >
                  {hasCreditBillSummaries ? (
                    <CreditBillSummaryTable
                      accountId={selectedAccount?.id ?? ""}
                      accountName={selectedAccount?.name ?? ""}
                      billingDay={selectedAccount?.billingDay ?? null}
                      rows={creditBillSummaryRows}
                      initialPage={currentPage}
                      pageSize={billListPageSize}
                      selectedBillMonth={selectedCreditBillMonth}
                      activeStatementMonth={selectedCreditBillMonth}
                      settledBillMonth={settledBillMonth}
                      hideZeroBills={hideZeroBills}
                      hideSettledBills={hideSettledBills}
                      showRecentBillCycles={showRecentBillCycles}
                      fillHeight
                    />
                  ) : (
                    <div className="panel-surface flex h-full items-center justify-center text-sm text-slate-400">
                      {t("creditBill.empty")}
                    </div>
                  )}

                  <CreditBillDetailPanel
                    accountId={selectedAccount?.id ?? ""}
                    reorderAccountIds={billAccountIds}
                    showCardColumn
                    entries={creditBillDetailEntries}
                    initialPage={detailPage}
                    initialPageSize={pageSize}
                    initialDetailAll={detailAll}
                    resetKey={`${selectedAccount?.id ?? ""}:${selectedCreditBillMonth || "all"}:credit-bill-detail`}
                    selectedBillMonth={selectedCreditBillMonth}
                    title={creditBillDetailTitle}
                    accountOptions={accountOptions}
                    categoryOptions={categoryBatchReplaceOptions}
                    tagOptions={tagBatchReplaceOptions}
                    investmentProductTypeByAccountId={investmentProductTypeByAccountIdObj}
                  />
                </ResizableVerticalSplit>
              </div>
            </div>
          ) : view === "debt" ? (
            <DebtShell
              rows={debtRowsForShell.map((row) => ({
                key: row.key,
                name: row.name,
                objectType: row.objectType,
                objectName: row.objectName,
                itemName: row.itemName,
                accountId: row.accountId,
                institutionId: row.institutionId,
                counterpartyId: row.counterpartyId,
                itemType: row.itemType,
                repaymentMethod: row.repaymentMethod,
                repaymentCycle: row.repaymentCycle,
                baseAnnualRate: row.baseAnnualRate,
                annualRate: row.annualRate,
                mortgageLprDiscount: row.mortgageLprDiscount,
                loanStartDate: row.loanStartDate,
                remainingRuns: row.remainingRuns,
                paidPrincipal: row.paidPrincipal,
                paidInterest: row.paidInterest,
                remainingPrincipal: row.remainingPrincipal,
                remainingInterest: row.remainingInterest,
                remainingTotal: row.remainingTotal,
                nextRepaymentDate: row.nextRepaymentDate,
                nextRepaymentPrincipal: row.nextRepaymentPrincipal,
                nextRepaymentInterest: row.nextRepaymentInterest,
                nextRepaymentCashAccountId: row.nextRepaymentCashAccountId,
                loanRateAdjustments: row.loanRateAdjustments,
                payable: row.payable,
                receivable: row.receivable,
                net: row.net,
                accountCount: row.accountCount,
                parentKey: row.parentKey,
                depth: row.depth,
                isGroup: row.isGroup,
                isLoan: row.isLoan,
                loanType: row.loanType,
              }))}
              selectedKey={selectedDebtKey}
              selectedLoanType={debtLoanTypeParam}
              entries={debtDetailEntries}
              repaymentScheduleRows={finalRepaymentScheduleRows}
              summaryRemainingTotal={debtShellRemainingTotal}
              totalPayable={debtDisplaySummary.totalPayable}
              totalReceivable={debtDisplaySummary.totalReceivable}
              isRedUp={isRedUp}
              accountOptions={accountOptions}
              categoryOptions={categoryBatchReplaceOptions}
              accountEditData={debtAccountEditData}
              loanEditAction={createDebtTransaction}
            />
          ) : view === "deposit" && selectedAccount ? (
            <DepositShell
              accountLabel={selectedAccountLabel}
              institutionName={selectedAccount.Institution?.name ?? ""}
              entries={depositEntries}
              lots={depositLots}
              cashAccounts={cashAccountList}
            />
          ) : view === "insurance" && selectedAccount ? (
            <InsuranceShell
              accountId={selectedAccount.id}
              accountLabel={selectedAccountLabel}
              institutionName={selectedAccount.Institution?.name ?? ""}
              holdings={insuranceHoldings}
              entries={insuranceEntries}
              cashAccounts={cashAccountList}
              cashAccountSSOptions={cashAccountSSOptions}
              familyMemberOptions={institutions
                .filter((item) => item.type === "family_member")
                .map((item) => ({
                  id: item.id,
                  label: item.name,
                  subLabel: t("settings.familyMembers"),
                }))}
            />
          ) : view === "investmoney" && investmoneyData ? (
            <FundShell
              key={`investmoney-${accountId}`}
              view="investmoney"
              initialFundCode={investmoneyData.selectedFundCode}
              positions={investmoneyData.positions}
              clearedPositions={investmoneyData.clearedPositions}
              allEntries={JSON.parse(JSON.stringify(investmoneyData.allEntries))}
              totalMarketValue={investmoneyData.totalMarketValue}
              totalCost={investmoneyData.totalCost}
              totalHistoricalProfit={investmoneyData.totalHistoricalProfit}
              confirmDaysMap={investmoneyData.confirmDaysMap}
              feeRateMap={investmoneyData.feeRateMap}
              initialShowCleared={showCleared}
              baseQuery={baseQuery.toString()}
              accountId={accountId}
              selectedAccount={JSON.parse(JSON.stringify(selectedAccount ?? {}))}
              selectedAccountLabel={selectedAccountLabel}
              accountOptions={accountOptions}
              cashAccounts={cashAccountList}
              investmentAccounts={investmentAccountList}
              cashAccountSSOptions={cashAccountSSOptions}
              investmentAccountSSOptions={investmentAccountSSOptions}
              wealthHoldingOptions={wealthHoldingOptions}
              metalTypes={metalTypes}
              metalUnits={metalUnits}
              nestedFieldData={nestedFieldData}
              createAction={createTransaction}
              editAction={editInvestment}
              fillNavAction={fillFundNavFromCache}
              regularInvestFormAction={regularInvestFormAction}
              lastUsedCashAccount={lastUsedCashAccount}
              isRedUp={isRedUp}
              fundUnitsDecimals={fundUnitsDecimals}
            />
          ) : view === "investwealth" && investwealthData ? (
            <FundShell
              key={`investwealth-${accountId}`}
              view="investwealth"
              initialFundCode={investwealthData.selectedWealthProductId}
              positions={investwealthData.positions}
              clearedPositions={investwealthData.clearedPositions}
              allEntries={JSON.parse(JSON.stringify(investwealthData.allEntries))}
              totalMarketValue={investwealthData.totalMarketValue}
              totalCost={investwealthData.totalCost}
              totalHistoricalProfit={investwealthData.totalHistoricalProfit}
              confirmDaysMap={investwealthData.confirmDaysMap}
              feeRateMap={investwealthData.feeRateMap}
              initialShowCleared={showCleared}
              baseQuery={baseQuery.toString()}
              accountId={accountId}
              selectedAccount={JSON.parse(JSON.stringify(selectedAccount ?? {}))}
              selectedAccountLabel={selectedAccountLabel}
              accountOptions={accountOptions}
              cashAccounts={cashAccountList}
              investmentAccounts={investmentAccountList}
              cashAccountSSOptions={cashAccountSSOptions}
              investmentAccountSSOptions={investmentAccountSSOptions}
              wealthHoldingOptions={wealthHoldingOptions}
              metalTypes={metalTypes}
              metalUnits={metalUnits}
              nestedFieldData={nestedFieldData}
              createAction={createTransaction}
              editAction={editInvestment}
              fillNavAction={fillFundNavFromCache}
              regularInvestFormAction={regularInvestFormAction}
              lastUsedCashAccount={lastUsedCashAccount}
              isRedUp={isRedUp}
              fundUnitsDecimals={fundUnitsDecimals}
            />
          ) : view === "investproperty" && investpropertyFilteredData ? (
            <PropertyShell
              key={`investproperty-${accountId || "all"}${fixedAssetTypeParam ? `-${fixedAssetTypeParam}` : ""}`}
              accountId={accountId || defaultPropertyInvestmentAccountId}
              currency={selectedAccount?.currency ?? baseCurrency}
              baseCurrency={baseCurrency}
              positions={JSON.parse(JSON.stringify(investpropertyFilteredData.positions))}
              entries={JSON.parse(JSON.stringify(investpropertyEntries))}
              totalMarketValue={investpropertyFilteredData.totalMarketValue}
              totalCost={investpropertyFilteredData.totalCost}
              isRedUp={isRedUp}
              assetType={fixedAssetTypeParam || selectedAccount?.fixedAssetType || null}
              accountOptions={accountOptions}
              categoryOptions={categoryBatchReplaceOptions}
              tagOptions={tagBatchReplaceOptions}
            />
          ) : view === "investstock" && investstockData ? (
            <StockHoldingsPanel
              key={`investstock-${accountId}`}
              accountId={accountId}
              accountLabel={selectedAccountLabel}
              currency={selectedAccount?.currency ?? baseCurrency}
              positions={JSON.parse(JSON.stringify(investstockData.positions))}
              clearedPositions={JSON.parse(JSON.stringify(investstockData.clearedPositions))}
              initialShowCleared={showCleared}
              cashBalance={investstockData.cashBalance ?? 0}
              totalMarketValue={investstockData.totalMarketValue}
              totalCost={investstockData.totalCost}
              isRedUp={isRedUp}
              stockCashAccountId={defaultStockCashAccountId}
              stockCashAccountName={defaultStockCashAccountName}
            />
          ) : view === "investfund" && investfundData ? (
            <FundShell
              key={`investfund-${accountId}`}
              view="investfund"
              initialFundCode={investfundData.selectedFundCode}
              positions={investfundData.positions}
              clearedPositions={investfundData.clearedPositions}
              allEntries={JSON.parse(JSON.stringify(investfundData.allEntries))}
              totalMarketValue={investfundData.totalMarketValue}
              totalCost={investfundData.totalCost}
              totalHistoricalProfit={investfundData.totalHistoricalProfit}
              confirmDaysMap={investfundData.confirmDaysMap}
              feeRateMap={investfundData.feeRateMap}
              initialShowCleared={showCleared}
              baseQuery={baseQuery.toString()}
              accountId={accountId}
              selectedAccount={JSON.parse(JSON.stringify(selectedAccount ?? {}))}
              selectedAccountLabel={selectedAccountLabel}
              accountOptions={accountOptions}
              cashAccounts={cashAccountList}
              investmentAccounts={investmentAccountList}
              cashAccountSSOptions={cashAccountSSOptions}
              investmentAccountSSOptions={investmentAccountSSOptions}
              metalTypes={metalTypes}
              metalUnits={metalUnits}
              nestedFieldData={nestedFieldData}
              createAction={createTransaction}
              editAction={editInvestment}
              fillNavAction={fillFundNavFromCache}
              regularInvestFormAction={regularInvestFormAction}
              lastUsedCashAccount={lastUsedCashAccount}
              isRedUp={isRedUp}
              fundUnitsDecimals={fundUnitsDecimals}
            />
          ) : (
            <div className="flex-1 min-h-0 flex flex-col bg-transparent p-4 md:p-5">
              <div className="panel-surface flex min-h-0 flex-1 flex-col overflow-hidden">
                <BasicDetailPanel
                  accountId={accountId}
                  isInvestAccount={isInvestAccount}
                  entries={pagedDetailEntries}
                  totalCount={filteredEntries2.length}
                  originalCount={entries.length}
                  hasDetailFilters={hasDetailFilters}
                  initialPage={safeDetailPage}
                  initialPageSize={pageSize}
                  initialDetailAll={detailAll}
                  normalExportFilename={normalExportFilename}
                  normalExportRows={normalExportRows}
                  normalExportRowsByEntryId={normalExportRowsByEntryId}
                  accountOptions={accountOptions.map((a) => ({ id: a.id, label: a.label, fullLabel: a.fullLabel, title: a.hoverTitle }))}
                  categoryOptions={categoryBatchReplaceOptions}
                  tagOptions={tagBatchReplaceOptions}
                  investmentProductTypeByAccountId={investmentProductTypeByAccountIdObj}
                  showBalanceReconcile={
                    !tagIdParam && (
                      selectedAccount?.kind === AccountKind.cash ||
                      selectedAccount?.kind === AccountKind.bank_debit ||
                      selectedAccount?.kind === AccountKind.ewallet
                    )
                  }
                  showAccountColumn={!!tagIdParam}
                  showRunningBalance={!tagIdParam && !isInvestAccount}
                  refreshOnGlobalEvent={!tagIdParam}
                  draggableRows={!tagIdParam}
                  sortable={!tagIdParam}
                  showPagination={!tagIdParam}
                  showImportExport={!tagIdParam}
                  accountKind={selectedAccount?.kind ?? null}
                  accountName={selectedAccount?.name ?? ""}
                  accountLabel={selectedAccountLabel}
                  currentBalance={selectedAccountRawBalanceValue}
                  focusEntryId={focusEntryId}
                  showGuideOverlay={guideParam === "daily-table"}
                />
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
    );
  }
