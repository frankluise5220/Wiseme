import { toStatementMonth } from "@/lib/date-utils";
export const ENTRY_ORIGIN_MANUAL = "manual" as const;
export const ENTRY_ORIGIN_AI_IMPORT = "ai_import" as const;
export const ENTRY_ORIGIN_EXCEL_IMPORT = "excel_import" as const;
export const ENTRY_ORIGIN_SCHEDULED_TASK = "scheduled_task" as const;
export const ENTRY_ORIGIN_EMAIL_IMPORT = "email_import" as const;

type CreditCardRepaymentLike = {
  readonly type?: string | null;
  readonly accountKind?: string | null;
  readonly toAccountKind?: string | null;
};

type StatementAccountLike = {
  readonly kind?: string | null;
  readonly billingDay?: number | null;
};

export const ENTRY_ORIGIN_VALUES = [
  ENTRY_ORIGIN_MANUAL,
  ENTRY_ORIGIN_AI_IMPORT,
  ENTRY_ORIGIN_EXCEL_IMPORT,
  ENTRY_ORIGIN_SCHEDULED_TASK,
  ENTRY_ORIGIN_EMAIL_IMPORT,
] as const;

export type EntryOrigin = (typeof ENTRY_ORIGIN_VALUES)[number];

export function isEntryOrigin(value: unknown): value is EntryOrigin {
  return ENTRY_ORIGIN_VALUES.includes(value as EntryOrigin);
}

export function normalizeEntryOrigin(value: string | null | undefined): EntryOrigin {
  return isEntryOrigin(value) ? value : ENTRY_ORIGIN_MANUAL;
}

export const TRANSACTION_SOURCE_MANUAL = "manual" as const;
export const TRANSACTION_SOURCE_INSURANCE = "insurance" as const;
export const TRANSACTION_SOURCE_REGULAR_INVEST = "regular_invest" as const;
export const TRANSACTION_SOURCE_REGULAR_INVEST_REFUND = "regular_invest_refund" as const;
export const TRANSACTION_SOURCE_FUND_UNITS_RECONCILE = "fund_units_reconcile" as const;
export const TRANSACTION_SOURCE_SCHEDULED_TASK = "scheduled_task" as const;
export const TRANSACTION_SOURCE_STATEMENT_IMPORT = "statement_import" as const;

export function isLicensedInsuranceEntry(entry: { source?: string | null; insuranceProductId?: string | null }) {
  return entry.source === TRANSACTION_SOURCE_INSURANCE || Boolean(entry.insuranceProductId);
}

export function isRegularInvestRefundEntry(entry: { source?: string | null; fundSubtype?: string | null }) {
  return entry.fundSubtype === "buy_failed" && entry.source === TRANSACTION_SOURCE_REGULAR_INVEST_REFUND;
}

export function isFundUnitsReconcileEntry(entry: { source?: string | null }) {
  return entry.source === TRANSACTION_SOURCE_FUND_UNITS_RECONCILE;
}

export function isGeneratedScheduledRecord(entry: { source?: string | null; entryOrigin?: string | null; regularInvestPlanId?: string | null }) {
  return entry.entryOrigin === ENTRY_ORIGIN_SCHEDULED_TASK || entry.source === TRANSACTION_SOURCE_SCHEDULED_TASK;
}

export function recordMatchesRegularInvestPlan(taskType: string | null | undefined, entry: { source?: string | null }) {
  if (taskType === "fund_regular_invest") return entry.source === TRANSACTION_SOURCE_REGULAR_INVEST;
  if (taskType === "insurance_premium") return entry.source === TRANSACTION_SOURCE_INSURANCE;
  return entry.source === TRANSACTION_SOURCE_SCHEDULED_TASK;
}

export const CREDIT_CARD_REPAYMENT_BUSINESS_TYPE = "credit_card_repayment" as const;
export const CREDIT_CARD_REPAYMENT_CATEGORY_NAME = "信用卡还款" as const;
export type CreditCardRepaymentBusinessType = typeof CREDIT_CARD_REPAYMENT_BUSINESS_TYPE;

const REPAYMENT_SOURCE_ACCOUNT_KINDS = new Set(["cash", "bank_debit", "ewallet"]);
const REPAYMENT_IMPORT_SOURCE_ACCOUNT_KINDS = new Set(["bank_debit", "ewallet"]);

export function isCreditCardRepaymentBusinessType(value: unknown) {
  return value === CREDIT_CARD_REPAYMENT_BUSINESS_TYPE;
}

export function isCreditCardRepaymentSourceAccountKind(kind: string | null | undefined) {
  return REPAYMENT_SOURCE_ACCOUNT_KINDS.has(kind ?? "");
}

export function isCreditCardRepaymentImportSourceAccountKind(kind: string | null | undefined) {
  return REPAYMENT_IMPORT_SOURCE_ACCOUNT_KINDS.has(kind ?? "");
}

export function isCreditCardRepaymentTargetAccountKind(kind: string | null | undefined) {
  return kind === "bank_credit";
}

export function isCreditCardRepaymentTransfer(entry: CreditCardRepaymentLike) {
  return (
    entry.type === "transfer" &&
    isCreditCardRepaymentSourceAccountKind(entry.accountKind) &&
    isCreditCardRepaymentTargetAccountKind(entry.toAccountKind)
  );
}

function statementMonthForBillSide(date: Date, account: StatementAccountLike | null | undefined) {
  if (!account?.billingDay) return null;
  if (account.kind !== "bank_credit" && account.kind !== "loan" && account.kind !== "settlement") return null;
  return toStatementMonth(date, account.billingDay);
}

/**
 * Returns true for transfer records whose cash movement represents a debt-principal
 * flow (borrow/lend, repayment, collection) and should not be counted as income
 * or expense in cash-flow statistics.  These are:
 *   debt_borrow_in         — money I borrowed (principal enters my cash account)
 *   debt_financed_purchase — installment purchase (principal enters my cash account)
 *   debt_lend_out          — money I lent out (principal leaves my cash account)
 *   debt_collect_in        — money I borrowed / collected back (principal enters my cash account)
 *   debt_repay_out         — principal repaid to a creditor
 *   debt_prepay_out        — early repayment of principal
 *   scheduled_task         — scheduled repayment (same as debt_repay_out)
 *
 * Only the interest portion (handled separately via getBusinessResultStatisticItems)
 * should appear in income/expense statistics.
 *
 * ⚠️ 必须包含 `debt_borrow_in` / `debt_financed_purchase`：当 scope 排除债务账户时，
 * 这两种 source 的现金方向（现金账户 in、债务账户 out）会触发 `isToSelf && !isFromSelf`，
 * 本金会落入"收入来源"饼图。这是统计页与 API 端点都必须调用的过滤函数，
 * 任何漏配都会让借到的钱变成"收入"被错误呈现。
 */
export function isDebtPrincipalTransfer(entry: { source?: string | null } | null | undefined) {
  const src = entry?.source ?? "";
  return (
    src === "debt_borrow_in" ||
    src === "debt_financed_purchase" ||
    src === "debt_lend_out" ||
    src === "debt_collect_in" ||
    src === "debt_repay_out" ||
    src === "debt_prepay_out" ||
    src === "scheduled_task"
  );
}

export function statementMonthForTransfer(
  date: Date,
  fromAccount: StatementAccountLike | null | undefined,
  toAccount: StatementAccountLike | null | undefined,
) {
  return statementMonthForBillSide(date, toAccount) ?? statementMonthForBillSide(date, fromAccount);
}
