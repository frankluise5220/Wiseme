/**
 * 消费贷提前还款应计利息（服务端唯一计算入口）。
 *
 * 口径：自「计息起点」到提前还款日（含）按日计息（年利率 / 360，与还款计划
 * 的按日计息口径一致），本金按账户真实本金时间线取值，窗口内的还本/提前
 * 还款在发生日之后降低计息基数。
 *
 * 计息起点（利息已结清边界）取以下日期的最大值：
 * - 借款日：最早的 debt_borrow_in / debt_financed_purchase 转账日期；
 * - 最近一笔 scheduled_task 自动扣款转账日期（每期扣款已结清当期利息）；
 * - 最近一笔带利息（debtInterestAmount > 0）的 debt_repay_out / debt_prepay_out。
 *
 * 仅对 loanType=consumer（消费贷）计算；房贷等其他类型返回 null，
 * 保持其利息随分期计划的既有口径。
 */
import { RegularInvestStatus, TransactionType } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { formatDateUtc, toNumber } from "@/lib/date-utils";
import { compareDetailEntriesAsc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { debtPrincipalForAccountSide } from "@/lib/debt";
import { calcLoanAccruedInterestBetweenDates } from "@/lib/loan-repayment";
import { resolveLoanTypeValue } from "@/lib/loan-type";
import { decodeScheduledTaskMemo, shouldPreferLoanScheduledPlan } from "@/lib/scheduled-task";
import {
  listLoanRateAdjustmentsByAccountIds,
  resolveLoanRateAdjustments,
} from "@/lib/server/loan-rate-adjustments";

export type LoanPrepayInterestPreview = {
  /** 应计利息金额（元，保留两位） */
  interest: number;
  /** 计息起点 YYYY-MM-DD（借款日或最近一次已结息日） */
  fromDate: string;
  /** 计息天数（不含起点、含终点） */
  days: number;
  /** 截至提前还款日执行的年利率（%）；未记录利率时为 null */
  annualRate: number | null;
};

export async function computeLoanPrepayInterestPreview(params: {
  householdId: string;
  accountId: string;
  asOfDate: Date;
  excludeEntryId?: string | null;
}): Promise<LoanPrepayInterestPreview | null> {
  const [account, txRows, plans] = await Promise.all([
    prisma.account.findFirst({
      where: { id: params.accountId, householdId: params.householdId, kind: "loan" },
      select: { id: true, loanType: true, isConsumerLoan: true },
    }),
    prisma.txRecord.findMany({
      where: {
        householdId: params.householdId,
        deletedAt: null,
        type: TransactionType.transfer,
        ...(params.excludeEntryId ? { id: { not: params.excludeEntryId } } : {}),
        OR: [
          { accountId: params.accountId, source: { in: ["debt_borrow_in", "debt_financed_purchase", "debt_repay_out", "debt_prepay_out"] } },
          { toAccountId: params.accountId, source: { in: ["debt_repay_out", "debt_prepay_out", "scheduled_task"] } },
        ],
      },
      select: {
        id: true,
        date: true,
        type: true,
        amount: true,
        accountId: true,
        toAccountId: true,
        source: true,
        debtPrincipalAmount: true,
        debtInterestAmount: true,
      },
    }),
    prisma.regularInvestPlan.findMany({
      where: {
        householdId: params.householdId,
        accountId: params.accountId,
        fundCode: "loan_repayment",
        status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused] },
      },
      select: { id: true, memo: true, status: true, nextRunDate: true },
    }),
  ]);

  if (!account) return null;
  // 按产品口径只对消费贷计算提前还款应计利息；房贷等利息随分期计划。
  if (resolveLoanTypeValue(account.loanType, account.isConsumerLoan) !== "consumer") return null;

  const orderedRows = txRows
    .slice()
    .sort((a, b) => compareDetailEntriesAsc(a, b, params.accountId));
  const dayMs = 24 * 60 * 60 * 1000;
  const dateKeyOf = (value: Date) => formatDateUtc(value);

  let loanStartDateKey: string | null = null;
  let latestSettleDateKey: string | null = null;
  let runningPrincipal = 0;
  // 每条流水处理后的余额快照，用于取计息起点当日收盘本金。
  const balanceSnapshots: Array<{ dateKey: string; balance: number }> = [];
  // 所有还本类记录（含 scheduled_task），循环结束后按最终边界过滤。
  const reductionCandidates: Array<{ dateKey: string; amount: number }> = [];

  for (const row of orderedRows) {
    const displayDate = getDetailEntryDisplayDate(row, params.accountId);
    const dateKey = dateKeyOf(displayDate);
    const source = String(row.source ?? "");
    const principalPart = Math.abs(
      row.debtPrincipalAmount == null ? toNumber(row.amount) : toNumber(row.debtPrincipalAmount),
    );
    const interestPart = Math.abs(toNumber(row.debtInterestAmount));

    if (source === "debt_borrow_in" || source === "debt_financed_purchase") {
      if (loanStartDateKey == null || dateKey < loanStartDateKey) loanStartDateKey = dateKey;
    }
    runningPrincipal += debtPrincipalForAccountSide(row, params.accountId);
    balanceSnapshots.push({ dateKey, balance: runningPrincipal });

    if (
      source === "debt_repay_out" ||
      source === "debt_prepay_out" ||
      source === "scheduled_task"
    ) {
      reductionCandidates.push({ dateKey, amount: principalPart });
    }

    // 自动扣款转账 / 带利息的还款或提前还款：利息已结清到该日期。
    const settlesInterest =
      source === "scheduled_task" ||
      ((source === "debt_repay_out" || source === "debt_prepay_out") && interestPart > 0.005);
    if (settlesInterest && (latestSettleDateKey == null || dateKey > latestSettleDateKey)) {
      latestSettleDateKey = dateKey;
    }
  }

  const boundaryKey = latestSettleDateKey ?? loanStartDateKey;
  if (!boundaryKey) return null;
  const endDateInclusive = formatDateUtc(params.asOfDate);

  // 计息起点当日收盘本金：日期 ≤ 起点的最后一条流水之后的余额。
  let principalAtBoundary = 0;
  for (const snapshot of balanceSnapshots) {
    if (snapshot.dateKey <= boundaryKey) principalAtBoundary = Math.abs(snapshot.balance);
    else break;
  }
  const principalReductions = reductionCandidates.map((item) => ({
    date: item.dateKey,
    amount: item.amount,
  }));

  if (endDateInclusive <= boundaryKey || principalAtBoundary <= 0.005) {
    return { interest: 0, fromDate: boundaryKey, days: 0, annualRate: null };
  }

  const plan = plans.reduce<typeof plans[number] | null>(
    (best, item) => (shouldPreferLoanScheduledPlan(item, best) ? item : best),
    null,
  );
  const memo = plan ? decodeScheduledTaskMemo(plan.memo) : null;
  const tableAdjustments = (await listLoanRateAdjustmentsByAccountIds({
    householdId: params.householdId,
    accountIds: [params.accountId],
  })).get(params.accountId) ?? [];
  const adjustments = resolveLoanRateAdjustments({
    tableAdjustments,
    memoAdjustments: memo?.loanRateAdjustments ?? [],
    mortgageLprDiscount: memo?.mortgageLprDiscount ?? null,
    loanStartDate: loanStartDateKey,
    throughDate: endDateInclusive,
  });
  const annualRate: number | null = adjustments.length > 0
    ? adjustments[adjustments.length - 1]!.annualRate
    : memo?.annualRate ?? null;

  const interest = calcLoanAccruedInterestBetweenDates({
    principal: principalAtBoundary,
    baseAnnualRate: memo?.annualRate ?? null,
    adjustments,
    principalReductions,
    startDateExclusive: boundaryKey,
    endDateInclusive,
  });
  const days = Math.max(
    0,
    Math.round((Date.parse(`${endDateInclusive}T00:00:00Z`) - Date.parse(`${boundaryKey}T00:00:00Z`)) / dayMs),
  );

  return { interest, fromDate: boundaryKey, days, annualRate };
}
