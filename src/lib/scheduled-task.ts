import { normalizeLoanRepaymentMethod } from "@/lib/loan-repayment";

export type ScheduledTaskType =
  | "fund_regular_invest"
  | "loan_repayment"
  | "transfer"
  | "insurance_premium"
  | "income"
  | "expense";

export type LoanScheduledPlanRole = "bill" | "auto_debit";

export type ScheduledTaskPayload = {
  type: ScheduledTaskType;
  title?: string | null;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  insuranceProductId?: string | null;
  note?: string | null;
  annualRate?: number | null;
  mortgageLprDiscount?: number | null;
  repaymentMethod?: string | null;
  repaymentIntervalMonths?: number | null;
  originalTotalRuns?: number | null;
  firstBillDate?: string | null;
  firstRepaymentDate?: string | null;
  /**
   * Loan scheduled plans can be split into two roles:
   * - bill: generate the installment/bill on the loan account.
   * - auto_debit: debit a cash account on the repayment date.
   */
  loanPlanRole?: LoanScheduledPlanRole | null;
  /**
   * Loan repayment execution mode.
   * true (default) = auto-debit: the due repayment is generated as a cash
   * transfer from the payment account (mortgage-style auto-payment).
   * false = bill only: only a bill record (source "loan_bill") is generated on
   * the loan side; the user pays manually.
   */
  autoDebit?: boolean | null;
  loanRateAdjustments?: Array<{
    effectiveDate: string;
    annualRate: number;
  }>;
};

const SCHEDULED_TASK_MEMO_PREFIX = "MMH_SCHEDULED_TASK:";

export const SCHEDULED_TASK_TYPE_LABEL: Record<ScheduledTaskType, string> = {
  fund_regular_invest: "基金定投",
  loan_repayment: "还贷款",
  transfer: "转账",
  insurance_premium: "保费缴费",
  income: "Income",
  expense: "Expense",
};

export function normalizeScheduledTaskType(value: unknown): ScheduledTaskType {
  if (
    value === "fund_regular_invest" ||
    value === "loan_repayment" ||
    value === "transfer" ||
    value === "insurance_premium" ||
    value === "income" ||
    value === "expense"
  ) {
    return value;
  }
  return "fund_regular_invest";
}

export function encodeScheduledTaskMemo(payload: ScheduledTaskPayload) {
  return `${SCHEDULED_TASK_MEMO_PREFIX}${JSON.stringify(payload)}`;
}

export function normalizeLoanScheduledPlanRole(value: unknown, autoDebit?: boolean | null): LoanScheduledPlanRole {
  if (value === "bill" || value === "auto_debit") return value;
  return autoDebit === false ? "bill" : "auto_debit";
}

export function getLoanScheduledPlanRole(task?: Pick<ScheduledTaskPayload, "type" | "loanPlanRole" | "autoDebit"> | null) {
  if (!task || task.type !== "loan_repayment") return null;
  return normalizeLoanScheduledPlanRole(task.loanPlanRole, task.autoDebit);
}

function dateRank(value: unknown) {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

export function shouldPreferLoanScheduledPlan(
  candidate: { memo?: string | null; status?: string | null; nextRunDate?: Date | string | null },
  existing?: { memo?: string | null; status?: string | null; nextRunDate?: Date | string | null } | null,
) {
  if (!existing) return true;
  const candidateTask = decodeScheduledTaskMemo(candidate.memo);
  const existingTask = decodeScheduledTaskMemo(existing.memo);
  const candidateRole = getLoanScheduledPlanRole(candidateTask);
  const existingRole = getLoanScheduledPlanRole(existingTask);
  const roleRank = (role: LoanScheduledPlanRole | null) => (role === "bill" ? 0 : role === "auto_debit" ? 1 : 2);
  const candidateRoleRank = roleRank(candidateRole);
  const existingRoleRank = roleRank(existingRole);
  if (candidateRoleRank !== existingRoleRank) return candidateRoleRank < existingRoleRank;
  const candidateActiveRank = String(candidate.status ?? "") === "active" ? 0 : 1;
  const existingActiveRank = String(existing.status ?? "") === "active" ? 0 : 1;
  if (candidateActiveRank !== existingActiveRank) return candidateActiveRank < existingActiveRank;
  return dateRank(candidate.nextRunDate) < dateRank(existing.nextRunDate);
}

export function shouldPreferLoanAutoDebitPlan(
  candidate: { memo?: string | null; status?: string | null; nextRunDate?: Date | string | null },
  existing?: { memo?: string | null; status?: string | null; nextRunDate?: Date | string | null } | null,
) {
  const candidateTask = decodeScheduledTaskMemo(candidate.memo);
  if (getLoanScheduledPlanRole(candidateTask) !== "auto_debit") return false;
  if (!existing) return true;
  const candidateActiveRank = String(candidate.status ?? "") === "active" ? 0 : 1;
  const existingActiveRank = String(existing.status ?? "") === "active" ? 0 : 1;
  if (candidateActiveRank !== existingActiveRank) return candidateActiveRank < existingActiveRank;
  return dateRank(candidate.nextRunDate) < dateRank(existing.nextRunDate);
}

export function decodeScheduledTaskMemo(memo?: string | null): ScheduledTaskPayload {
  const value = String(memo ?? "").trim();
  if (!value.startsWith(SCHEDULED_TASK_MEMO_PREFIX)) return { type: "fund_regular_invest" };

  try {
    const parsed = JSON.parse(value.slice(SCHEDULED_TASK_MEMO_PREFIX.length)) as Partial<ScheduledTaskPayload>;
    const rawMortgageLprDiscount = parsed.mortgageLprDiscount as unknown;
    const mortgageLprDiscount =
      typeof rawMortgageLprDiscount === "number" && Number.isFinite(rawMortgageLprDiscount)
        ? rawMortgageLprDiscount
        : typeof rawMortgageLprDiscount === "string" &&
            rawMortgageLprDiscount.trim() &&
            Number.isFinite(Number(rawMortgageLprDiscount))
          ? Number(rawMortgageLprDiscount)
          : null;
    const type = normalizeScheduledTaskType(parsed.type);
    const autoDebit = parsed.autoDebit === false ? false : true;
    if (type) {
      return {
        type,
        title: parsed.title ?? null,
        fromAccountId: parsed.fromAccountId ?? null,
        toAccountId: parsed.toAccountId ?? null,
        categoryId: parsed.categoryId ?? null,
        categoryName: parsed.categoryName ?? null,
        insuranceProductId: parsed.insuranceProductId ?? null,
        note: parsed.note ?? null,
        annualRate: typeof parsed.annualRate === "number" && Number.isFinite(parsed.annualRate) ? parsed.annualRate : null,
        mortgageLprDiscount,
        repaymentMethod: typeof parsed.repaymentMethod === "string" ? normalizeLoanRepaymentMethod(parsed.repaymentMethod) : null,
        repaymentIntervalMonths: typeof parsed.repaymentIntervalMonths === "number" && Number.isFinite(parsed.repaymentIntervalMonths) ? parsed.repaymentIntervalMonths : null,
        originalTotalRuns: typeof parsed.originalTotalRuns === "number" && Number.isFinite(parsed.originalTotalRuns) && parsed.originalTotalRuns > 0
          ? Math.floor(parsed.originalTotalRuns)
          : null,
        firstBillDate: typeof parsed.firstBillDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.firstBillDate)
          ? parsed.firstBillDate
          : null,
        firstRepaymentDate: typeof parsed.firstRepaymentDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(parsed.firstRepaymentDate)
          ? parsed.firstRepaymentDate
          : null,
        loanPlanRole: type === "loan_repayment" ? normalizeLoanScheduledPlanRole(parsed.loanPlanRole, autoDebit) : null,
        autoDebit,
        loanRateAdjustments: Array.isArray(parsed.loanRateAdjustments)
          ? parsed.loanRateAdjustments
              .map((item) => ({
                effectiveDate: typeof item?.effectiveDate === "string" ? item.effectiveDate.slice(0, 10) : "",
                annualRate: typeof item?.annualRate === "number" && Number.isFinite(item.annualRate) ? item.annualRate : NaN,
              }))
              .filter((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.effectiveDate) && Number.isFinite(item.annualRate) && item.annualRate >= 0)
              .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
          : [],
      };
    }
  } catch {
    // Legacy free-text memo: treat it as a fund regular-invest task.
  }

  return { type: "fund_regular_invest" };
}

export function scheduledTaskTypeLabel(type?: string | null) {
  return SCHEDULED_TASK_TYPE_LABEL[(type as ScheduledTaskType) || "fund_regular_invest"] ?? "计划任务";
}
