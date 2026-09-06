import { IntervalUnit, RegularInvestStatus, TransactionType } from "@prisma/client";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { formatDateUtc, startOfDayUtc, toNumber } from "@/lib/date-utils";
import {
  calcLoanRunPartsWithRateAdjustments,
  getEffectiveLoanAnnualRate,
  roundLoanMoney,
} from "@/lib/loan-repayment";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import {
  decodeScheduledTaskMemo,
  shouldPreferLoanAutoDebitPlan,
  shouldPreferLoanScheduledPlan,
} from "@/lib/scheduled-task";
import { calcInitialScheduledRunDate, calcNextScheduledRunDate } from "@/lib/scheduled-task-date";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { listLoanRateAdjustmentsByAccountIds, resolveLoanRateAdjustments } from "@/lib/server/loan-rate-adjustments";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

/**
 * POST /api/v1/loan-repayment/rebuild
 * Body: { accountId, fromDate: "YYYY-MM-DD", remainingRuns?: number, dryRun?: boolean }
 *
 * Rebuilds generated repayment rows from the period containing `fromDate`.
 * The rebuild runs chronologically: rate adjustments recalculate the payment
 * using the remaining term at that point, while later reduce-term prepayments
 * shorten the term only when their period is reached.
 *
 * 资金账户侧的银行扣款流水（source === "scheduled_task"）是银行实际扣款的事实记录。
 * 对 auto_debit 角色（自动扣款）的贷款，它与还款表共用同一条 TxRecord，
 * 因此重算还款表时绝不允许改写或删除它——否则就等于篡改资金账户的交易流水。
 * 只有 loan_bill 账单行属于"还款表"本身，允许原地更正。
 */
const CORRECTABLE_REPAYMENT_SOURCE = "loan_bill";
function parseDateOnlyUtc(value: unknown) {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function dateKey(value: Date) {
  return startOfDayUtc(value).toISOString().slice(0, 10);
}

function principalOf(row: { debtPrincipalAmount?: unknown; amount: unknown }) {
  return Math.abs(toNumber(row.debtPrincipalAmount ?? row.amount));
}

function parseLoanTotalRunsFromNote(note?: string | null) {
  const match = String(note ?? "").match(/\u671f\u6570[\uff1a:]\s*(\d+)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export async function POST(req: Request) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null);
    const accountId = String(body?.accountId ?? "").trim();
    const fromDate = parseDateOnlyUtc(body?.fromDate);
    const dryRun = body?.dryRun === true;
    const remainingRunsInput = body?.remainingRuns == null ? null : Math.floor(Number(body.remainingRuns));

    if (!accountId) return NextResponse.json({ ok: false, code: "LOAN_ACCOUNT_REQUIRED", error: "缺少贷款账户" }, { status: 400 });
    if (!fromDate) return NextResponse.json({ ok: false, code: "INVALID_START_DATE", error: "重算起始日期不正确" }, { status: 400 });
    if (remainingRunsInput != null && (!Number.isFinite(remainingRunsInput) || remainingRunsInput < 1 || remainingRunsInput > 600)) {
      return NextResponse.json({ ok: false, code: "INVALID_REMAINING_RUNS", error: "剩余期数必须在 1 到 600 之间" }, { status: 400 });
    }

    const plans = await prisma.regularInvestPlan.findMany({
      where: {
        householdId,
        accountId,
        fundCode: "loan_repayment",
        status: { in: [RegularInvestStatus.active, RegularInvestStatus.paused] },
      },
      orderBy: [{ status: "asc" }, { nextRunDate: "asc" }],
    });
    let scheduledPlan: (typeof plans)[number] | null = null;
    let autoDebitPlan: (typeof plans)[number] | null = null;
    for (const candidate of plans) {
      if (shouldPreferLoanScheduledPlan(candidate, scheduledPlan)) scheduledPlan = candidate;
      if (shouldPreferLoanAutoDebitPlan(candidate, autoDebitPlan)) autoDebitPlan = candidate;
    }
    const plan = autoDebitPlan ?? scheduledPlan;
    if (!plan) return NextResponse.json({ ok: false, code: "REBUILD_PLAN_NOT_FOUND", error: "未找到可重算的还款计划" }, { status: 404 });

    const memo = decodeScheduledTaskMemo(plan.memo);
    if (memo.type !== "loan_repayment") {
      return NextResponse.json({ ok: false, code: "NOT_LOAN_REPAYMENT_PLAN", error: "当前计划不是贷款还款计划" }, { status: 400 });
    }
    if (memo.repaymentMethod === "自由还款") {
      return NextResponse.json({ ok: false, code: "FREE_REPAYMENT_NOT_RECALCULABLE", error: "自由还款没有固定计划，不需要重算" }, { status: 400 });
    }

    const account = await prisma.account.findUnique({
      where: { id: plan.accountId },
      select: { id: true, balance: true },
    });
    if (!account) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "贷款账户不存在" }, { status: 404 });

    const originalBorrow = await prisma.txRecord.findFirst({
      where: {
        householdId,
        deletedAt: null,
        source: { in: ["debt_borrow_in", "debt_financed_purchase"] },
        type: TransactionType.transfer,
        accountId: plan.accountId,
      },
      orderBy: { date: "asc" },
      select: { date: true, note: true },
    });
    const originalTotalRuns = parseLoanTotalRunsFromNote(originalBorrow?.note);

    const tableAdjustments = (await listLoanRateAdjustmentsByAccountIds({
      householdId,
      accountIds: [plan.accountId],
    })).get(plan.accountId);
    const adjustments = resolveLoanRateAdjustments({
      tableAdjustments,
      memoAdjustments: memo.loanRateAdjustments,
      mortgageLprDiscount: memo.mortgageLprDiscount,
      loanStartDate: originalBorrow?.date ? formatDateUtc(originalBorrow.date) : memo.firstRepaymentDate ?? formatDateUtc(plan.startDate),
    });

    // 起始期：fromDate 之后的第一个已生成期；没有则按计划网格对齐（未来的利率调整）
    const firstEntryAfterFromDate = await prisma.txRecord.findFirst({
      where: {
        householdId,
        regularInvestPlanId: plan.id,
        source: { in: ["scheduled_task", "loan_bill"] },
        deletedAt: null,
        date: { gte: fromDate },
      },
      orderBy: { date: "asc" },
      select: { date: true },
    });
    const alignedFromDate = calcInitialScheduledRunDate(
      fromDate,
      plan.intervalUnit as IntervalUnit,
      plan.intervalValue,
      plan.executionDay,
      false,
    );
    const startRunDate = firstEntryAfterFromDate ? startOfDayUtc(firstEntryAfterFromDate.date) : startOfDayUtc(alignedFromDate);
    const startRunDateKey = dateKey(startRunDate);

    const windowEntries = await prisma.txRecord.findMany({
      where: {
        householdId,
        regularInvestPlanId: plan.id,
        source: { in: ["scheduled_task", "loan_bill"] },
        deletedAt: null,
        date: { gte: startRunDate },
      },
      orderBy: [{ date: "asc" }, { id: "asc" }],
      select: { id: true, date: true, amount: true, debtPrincipalAmount: true, source: true },
    });
    const lastRemaining = await prisma.txRecord.findFirst({
      where: {
        householdId,
        regularInvestPlanId: plan.id,
        source: { in: ["scheduled_task", "loan_bill"] },
        deletedAt: null,
        date: { lt: startRunDate },
      },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      select: { date: true, amount: true },
    });
    const lastRemainingDate = lastRemaining?.date ? startOfDayUtc(lastRemaining.date) : null;
    const lastRemainingDateKey = lastRemainingDate ? dateKey(lastRemainingDate) : null;

    // 还原到上一期扣款后的余额：|当前余额| + 窗口内（将被更正的）流水本金 + 窗口内提前还款/手工还款本金
    const windowFilter = {
      householdId,
      deletedAt: null,
      toAccountId: plan.accountId,
      ...(lastRemainingDate ? { date: { gt: lastRemainingDate } } : {}),
    };
    const windowPrepayRows = await prisma.txRecord.findMany({
      where: { ...windowFilter, source: "debt_prepay_out", type: TransactionType.transfer },
      orderBy: [{ date: "asc" }, { id: "asc" }],
      select: { date: true, amount: true, debtPrincipalAmount: true },
    });
    const windowManualRepayRows = await prisma.txRecord.findMany({
      where: { ...windowFilter, source: "debt_repay_out" },
      orderBy: [{ date: "asc" }, { id: "asc" }],
      select: { date: true, amount: true, debtPrincipalAmount: true },
    });

    const balanceStart = roundLoanMoney(
      Math.abs(toNumber(account.balance))
      + windowEntries.reduce((sum, row) => sum + principalOf(row), 0)
      + windowPrepayRows.reduce((sum, row) => sum + principalOf(row), 0)
      + windowManualRepayRows.reduce((sum, row) => sum + principalOf(row), 0),
    );

    const executedRunsBefore = Math.max(0, Math.max(0, plan.executedRuns) - windowEntries.length);
    // 剩余期数以计划的 totalRuns 为唯一权威来源：它是用户一等输入，且已经扣掉提前还款"缩短期数"减少的期数。
    // 不能用放款备注里的 originalTotalRuns 反推 —— 那样会漏掉提前还款造成的期数缩短，
    // 重定价时用 annuity(余额, 剩余期数) 自算月供就会偏小（月亮园 2026-09 事故：算出 3797.12，银行实扣 4100.97）。
    const currentRemainingRuns = plan.totalRuns == null ? null : Math.max(0, plan.totalRuns - plan.executedRuns);
    const remainingRuns = remainingRunsInput
      ?? (currentRemainingRuns != null
        ? currentRemainingRuns + windowEntries.length
        : originalTotalRuns != null
          ? Math.max(0, originalTotalRuns - executedRunsBefore)
          : null);
    const totalRunsAfter = remainingRuns != null ? executedRunsBefore + remainingRuns : originalTotalRuns ?? plan.totalRuns;
    const preservedAmount = lastRemaining ? roundLoanMoney(Math.abs(toNumber(lastRemaining.amount))) : null;
    const baseScheduledAmount = preservedAmount ?? toNumber(plan.amount);
    const effectiveAnnualRate = getEffectiveLoanAnnualRate({
      baseAnnualRate: memo.annualRate,
      adjustments,
      date: startRunDateKey,
    });
    const hasRateAdjustmentInStartPeriod = lastRemainingDate
      ? adjustments.some((item) => item.effectiveDate > lastRemainingDateKey! && item.effectiveDate <= startRunDateKey)
      : adjustments.some((item) => item.effectiveDate <= startRunDateKey);

    // 逐期重算窗口内每一条已生成流水（与执行器同源计算），原地更正
    let rollingScheduledAmount = baseScheduledAmount;
    let rollingScheduledAmountExact = baseScheduledAmount;
    let rollingExactRemainingPrincipal = balanceStart;
    let previousRunDateKey = lastRemainingDateKey;
    const updatePlans: Array<{ id: string; payment: number; principal: number; interest: number; source: string }> = [];
    const removeIds: string[] = [];
    // 资金侧银行扣款流水：只参与滚动计算，绝不改写、绝不软删
    const skippedDebitRows: Array<{ id: string; date: string }> = [];
    let prepaymentInStartPeriod = false;
    for (const [index, entry] of windowEntries.entries()) {
      const runDateKey = dateKey(entry.date);
      const principalAdjustments = windowPrepayRows
        .filter((row) => {
          const rowKey = dateKey(row.date);
          return rowKey > (previousRunDateKey ?? "") && rowKey <= runDateKey;
        })
        .map((row) => ({ date: formatDateUtc(row.date), amount: Math.abs(toNumber(row.debtPrincipalAmount ?? row.amount)) }));
      if (index === 0) prepaymentInStartPeriod = principalAdjustments.length > 0;
      const remainingRunsForThisRun = totalRunsAfter != null
        ? Math.max(1, totalRunsAfter - executedRunsBefore - index)
        : 1;
      const parts = calcLoanRunPartsWithRateAdjustments({
        repaymentMethod: memo.repaymentMethod,
        baseAnnualRate: memo.annualRate,
        adjustments,
        principalAdjustments,
        intervalMonths: memo.repaymentIntervalMonths ?? (plan.intervalUnit === IntervalUnit.month ? plan.intervalValue : 1),
        scheduledAmount: rollingScheduledAmount,
        scheduledAmountExact: rollingScheduledAmountExact,
        preserveScheduledAmount: true,
        remainingPrincipal: rollingExactRemainingPrincipal,
        remainingRuns: remainingRunsForThisRun,
        previousRunDate: previousRunDateKey ?? undefined,
        runDate: runDateKey,
      });
      rollingScheduledAmount = parts.scheduledAmount;
      rollingScheduledAmountExact = parts.scheduledAmountExact ?? rollingScheduledAmountExact;
      const inPeriodTotal = principalAdjustments.reduce((sum, item) => sum + item.amount, 0);
      rollingExactRemainingPrincipal = Math.max(
        0,
        roundLoanMoney(rollingExactRemainingPrincipal - (parts.principalExact ?? parts.principal) - inPeriodTotal),
      );
      if (parts.payment > 0.005) {
        if (entry.source === CORRECTABLE_REPAYMENT_SOURCE) {
          updatePlans.push({
            id: entry.id,
            payment: parts.payment,
            principal: parts.principal,
            interest: parts.interest,
            source: entry.source,
          });
        } else {
          // 银行实际扣款流水：保留原值，不参与原地更正
          skippedDebitRows.push({ id: entry.id, date: runDateKey });
        }
      } else if (entry.source === CORRECTABLE_REPAYMENT_SOURCE) {
        // 提前结清后的多余期：仅移除账单行（唯一会移除记录的情形）
        removeIds.push(entry.id);
      } else {
        skippedDebitRows.push({ id: entry.id, date: runDateKey });
      }
      previousRunDateKey = runDateKey;
    }

    const firstUpdate = updatePlans[0] ?? null;
    // 保留下来的最后一期（银行扣款流水永远保留），用于回写 lastRunDate / nextRunDate
    const retainedEntries = windowEntries.filter((entry) => !removeIds.includes(entry.id));
    const lastRetainedEntry = retainedEntries[retainedEntries.length - 1] ?? null;
    // 窗口里有银行已实际扣款的流水时，月供以"实扣金额"为准，不用自算值覆盖：
    // 自算依赖期数/余额账本，一旦与银行口径有偏差就会把月供给改坏，且会连带改掉资金账户流水。
    const hasDebitHistory = windowEntries.some((entry) => entry.source !== CORRECTABLE_REPAYMENT_SOURCE);
    const lastDebitAmount = lastRetainedEntry && lastRetainedEntry.source !== CORRECTABLE_REPAYMENT_SOURCE
      ? roundLoanMoney(Math.abs(toNumber(lastRetainedEntry.amount)))
      : null;
    const appliedScheduledAmount = hasDebitHistory
      ? (lastDebitAmount ?? roundLoanMoney(baseScheduledAmount))
      : roundLoanMoney(rollingScheduledAmount);
    const startRunDateTime = startRunDate.getTime();
    const nextRunDateTime = plan.nextRunDate ? startOfDayUtc(plan.nextRunDate).getTime() : 0;
    const futureOnly = startRunDateTime > nextRunDateTime;

    if (dryRun) {
      return NextResponse.json({
        ok: true,
        data: {
          dryRun: true,
          startRunDate: startRunDateKey,
          lastRemainingDate: lastRemainingDateKey,
          updateCount: updatePlans.length,
          extrasCount: removeIds.length,
          // 资金侧银行扣款流水：只读，不会被改写
          skippedDebitRows: skippedDebitRows.length,
          preservedAmount,
          effectiveAnnualRate,
          balanceStart,
          remainingRuns,
          totalRuns: totalRunsAfter,
          recalcAtStart: hasRateAdjustmentInStartPeriod,
          prepaymentInStartPeriod,
          repaymentMethod: memo.repaymentMethod ?? null,
          intervalMonths: memo.repaymentIntervalMonths ?? (plan.intervalUnit === IntervalUnit.month ? plan.intervalValue : 1),
          previewPayment: firstUpdate?.payment ?? appliedScheduledAmount,
          previewPrincipal: firstUpdate?.principal ?? 0,
          previewInterest: firstUpdate?.interest ?? 0,
          amountKeptAsDebited: hasDebitHistory,
          lastRemainingPayment: preservedAmount,
        },
      });
    }

    if (futureOnly) {
      // 生效日在下次还款之后：没有已生成的流水需要更正，只按需修正总期数
      if (remainingRuns != null && plan.totalRuns !== executedRunsBefore + remainingRuns) {
        await prisma.regularInvestPlan.update({
          where: { id: plan.id },
          data: { totalRuns: executedRunsBefore + remainingRuns },
        });
        revalidateAfterTxChange();
      }
      return NextResponse.json({
        ok: true,
        data: {
          dryRun: false,
          startRunDate: startRunDateKey,
          updateCount: 0,
          extrasCount: 0,
          generatedCount: 0,
          remainingRuns,
          totalRuns: totalRunsAfter,
          futureOnly: true,
        },
      });
    }

    await prisma.$transaction(async (tx) => {
      for (const update of updatePlans) {
        await tx.txRecord.update({
          where: { id: update.id },
          data: {
            amount: -roundLoanMoney(update.payment),
            debtPrincipalAmount: roundLoanMoney(update.principal),
            debtInterestAmount: roundLoanMoney(update.interest),
            ...(update.source === "scheduled_task"
              ? { realizedProfit: update.interest > 0 ? -Math.abs(roundLoanMoney(update.interest)) : null }
              : {}),
          },
        });
      }
      if (removeIds.length > 0) {
        await tx.txRecord.updateMany({
          where: { id: { in: removeIds }, householdId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        await tx.entryBusinessLink.updateMany({
          where: { householdId, deletedAt: null, cashEntryId: { in: removeIds } },
          data: { deletedAt: new Date() },
        });
      }
      await tx.regularInvestPlan.update({
        where: { id: plan.id },
        data: {
          // 有银行实扣历史时保持实扣月供，不用自算值覆盖（见 appliedScheduledAmount 说明）
          amount: appliedScheduledAmount,
          totalRuns: remainingRuns != null ? executedRunsBefore + remainingRuns : plan.totalRuns,
          executedRuns: executedRunsBefore + retainedEntries.length,
          ...(removeIds.length > 0
            ? {
                lastRunDate: lastRetainedEntry ? startOfDayUtc(lastRetainedEntry.date) : lastRemainingDate,
                nextRunDate: calcNextScheduledRunDate(
                  startOfDayUtc(lastRetainedEntry?.date ?? lastRemainingDate ?? plan.startDate),
                  plan.intervalUnit as IntervalUnit,
                  plan.intervalValue,
                  plan.executionDay,
                  false,
                ),
              }
            : {}),
          status: rollingExactRemainingPrincipal <= 0.005
            ? RegularInvestStatus.completed
            : plan.status === RegularInvestStatus.completed
              ? RegularInvestStatus.active
              : plan.status,
        },
      });
    });

    for (const balanceAccountId of [plan.accountId, plan.cashAccountId].filter(Boolean) as string[]) {
      await recalcAndSaveAccountBalance(balanceAccountId).catch(() => {});
    }
    revalidateAfterTxChange();

    return NextResponse.json({
      ok: true,
      data: {
        dryRun: false,
        startRunDate: startRunDateKey,
        lastRemainingDate: lastRemainingDateKey,
        updateCount: updatePlans.length,
        extrasCount: removeIds.length,
        generatedCount: 0,
        // 资金侧银行扣款流水：只读，不会被改写
        skippedDebitRows: skippedDebitRows.length,
        preservedAmount: baseScheduledAmount,
        effectiveAnnualRate,
        balanceStart,
        remainingRuns,
        totalRuns: totalRunsAfter,
        nextAmount: appliedScheduledAmount,
        amountKeptAsDebited: hasDebitHistory,
        previewPayment: firstUpdate?.payment ?? appliedScheduledAmount,
        previewPrincipal: firstUpdate?.principal ?? 0,
        previewInterest: firstUpdate?.interest ?? 0,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "REBUILD_FAILED", error: error instanceof Error ? error.message : "重算还款计划表失败" },
      { status: 500 },
    );
  }
}
