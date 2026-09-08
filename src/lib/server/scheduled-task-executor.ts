import { AccountKind, FundSubtype, Prisma, RegularInvestStatus, TransactionType, type IntervalUnit, type RegularInvestPlan } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { formatDateUtc, startOfDayUtc, toNumber, toStatementMonth } from "@/lib/date-utils";
import { logger } from "@/lib/logger";
import {
  calcLoanRunPartsWithRateAdjustments,
  roundLoanMoney,
} from "@/lib/loan-repayment";
import {
  decodeScheduledTaskMemo,
  getLoanScheduledPlanRole,
  scheduledTaskTypeLabel,
  type ScheduledTaskPayload,
  type ScheduledTaskType,
} from "@/lib/scheduled-task";
import { calcNextScheduledRunDate } from "@/lib/scheduled-task-date";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { releaseMortgagedAssetsForSettledLoanAccounts } from "@/lib/server/collateral-mortgage";
import { listLoanRateAdjustmentsByAccountIds, resolveLoanRateAdjustments } from "@/lib/server/loan-rate-adjustments";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import { resolveCategorySnapshot, resolveCreditCardRepaymentCategory } from "@/lib/default-categories";
import { ENTRY_ORIGIN_SCHEDULED_TASK, isCreditCardRepaymentTransfer } from "@/lib/transaction-semantics";
import { syncIndependentBusinessTransactionFromTxRecord } from "@/lib/server/business-transactions";

export type NonFundTaskType = Exclude<ScheduledTaskType, "fund_regular_invest">;

const NON_FUND_SCHEDULED_TASK_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 60_000,
};

export type NonFundScheduledTaskResult = {
  ok: true;
  taskType: NonFundTaskType;
  generatedCount: number;
  skipped: boolean;
  message: string;
  date: string | null;
  executedRuns: number;
  completed: boolean;
  stats: {
    executedCount: number;
    executedAmount: number;
    confirmedCount: number;
    confirmedAmount: number;
    plan: {
      executedRuns: number;
      lastRunDate: string | null;
      nextRunDate: string | null;
      status: RegularInvestStatus;
    };
  };
};

export function isNonFundScheduledTask(type: ScheduledTaskType): type is NonFundTaskType {
  return type !== "fund_regular_invest";
}

export function getScheduledTaskSourceFilter(type: NonFundTaskType) {
  if (type === "insurance_premium") return ["insurance"];
  if (type === "loan_repayment") return ["scheduled_task", "loan_bill"];
  return ["scheduled_task"];
}

function toPositiveAmount(value: unknown) {
  const amount = value instanceof Prisma.Decimal ? value.toNumber() : Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function getTaskNote(type: NonFundTaskType, label?: string | null) {
  if (type === "loan_repayment") return "计划任务：还贷款";
  if (type === "insurance_premium") return label ? `计划任务：保险缴费：${label}` : "计划任务：保险缴费";
  if (type === "income") return label ? `Scheduled task: ${label}` : "Scheduled task: income";
  if (type === "expense") return label ? `Scheduled task: ${label}` : "Scheduled task: expense";
  return "计划任务：转账";
}

function makeNextRunDate(plan: RegularInvestPlan, fromDate: Date) {
  return calcNextScheduledRunDate(
    fromDate,
    plan.intervalUnit as IntervalUnit,
    plan.intervalValue,
    plan.executionDay,
    false,
    plan.secondaryExecutionDay,
  );
}

async function loadTaskAccounts(plan: RegularInvestPlan) {
  const [targetAcc, cashAcc] = await Promise.all([
    prisma.account.findUnique({ where: { id: plan.accountId }, select: { id: true, name: true, kind: true, billingDay: true } }),
    plan.cashAccountId
      ? prisma.account.findUnique({ where: { id: plan.cashAccountId }, select: { id: true, name: true, kind: true, billingDay: true } })
      : Promise.resolve(null),
  ]);
  return { targetAcc, cashAcc };
}

function requiresCashAccount(task: ScheduledTaskPayload) {
  if (task.type === "loan_repayment" && getLoanScheduledPlanRole(task) === "bill") return false;
  return task.type === "transfer" || task.type === "loan_repayment" || task.type === "insurance_premium";
}

function statementMonthForSingleAccount(date: Date, account: { kind: string; billingDay: number | null }) {
  return (account.kind === AccountKind.bank_credit || account.kind === AccountKind.loan || account.kind === AccountKind.settlement) && account.billingDay
    ? toStatementMonth(date, account.billingDay)
    : null;
}

export async function executeNonFundScheduledTaskPlan(params: {
  householdId: string;
  plan: RegularInvestPlan;
  task?: ScheduledTaskPayload;
  overrideDate?: Date | null;
  overrideAmount?: number | null;
  initialLoanPrincipal?: number | null;
  now?: Date;
}): Promise<NonFundScheduledTaskResult> {
  const { householdId, plan } = params;
  const task = params.task ?? decodeScheduledTaskMemo(plan.memo);
  if (!isNonFundScheduledTask(task.type)) {
    throw new Error("该执行器仅支持非基金类计划任务");
  }
  const loanRateAdjustments = task.type === "loan_repayment"
    ? resolveLoanRateAdjustments({
        tableAdjustments: (await listLoanRateAdjustmentsByAccountIds({
          householdId,
          accountIds: [plan.accountId],
        })).get(plan.accountId),
        memoAdjustments: task.loanRateAdjustments,
        mortgageLprDiscount: task.mortgageLprDiscount,
        loanStartDate: task.firstRepaymentDate ?? formatDateUtc(plan.startDate),
      })
    : [];

  const { targetAcc, cashAcc } = await loadTaskAccounts(plan);
  if (!targetAcc) throw new Error("目标账户不存在");
  if (requiresCashAccount(task) && !cashAcc) throw new Error("计划任务缺少资金账户");

  const amountNum = params.overrideAmount && params.overrideAmount > 0
    ? params.overrideAmount
    : toPositiveAmount(plan.amount);
  if (!amountNum) throw new Error("金额不正确");

  const sourceFilter = getScheduledTaskSourceFilter(task.type);
  const existingTxRecords = await prisma.txRecord.findMany({
    where: task.type === "insurance_premium" && task.insuranceProductId
      ? {
          householdId,
          insuranceProductId: task.insuranceProductId,
          source: { in: sourceFilter },
          type: TransactionType.investment,
          fundSubtype: FundSubtype.buy,
          deletedAt: null,
        }
      : {
          householdId,
          regularInvestPlanId: plan.id,
          source: { in: sourceFilter },
          deletedAt: null,
        },
    select: { date: true },
  });
  const existingDates = new Set(existingTxRecords.map((record) => formatDateUtc(record.date)));
  const remainingRuns = plan.totalRuns ? Math.max(0, plan.totalRuns - plan.executedRuns) : Number.POSITIVE_INFINITY;
  const datesToProcess: Date[] = [];
  const firstExistingDate = existingTxRecords[0]?.date ?? null;
  const latestExistingDate = firstExistingDate
    ? existingTxRecords.reduce((latest, record) => (record.date > latest ? record.date : latest), firstExistingDate)
    : null;

  if (params.overrideDate) {
    const overrideRunDate = startOfDayUtc(params.overrideDate);
    if (!existingDates.has(formatDateUtc(overrideRunDate)) && remainingRuns > 0) {
      datesToProcess.push(overrideRunDate);
    }
  } else {
    const today = startOfDayUtc(params.now ?? new Date());
    const effectiveEndDate = plan.endDate && startOfDayUtc(plan.endDate) < today ? startOfDayUtc(plan.endDate) : today;
    let currentDate = startOfDayUtc(plan.nextRunDate);
    let guard = 0;
    while (currentDate <= effectiveEndDate && datesToProcess.length < remainingRuns) {
      const dateStr = formatDateUtc(currentDate);
      if (!existingDates.has(dateStr)) datesToProcess.push(currentDate);
      currentDate = makeNextRunDate(plan, currentDate);
      guard++;
      if (guard > 1200) throw new Error("计划周期异常，已停止生成以避免无限循环");
    }
  }

  if (datesToProcess.length === 0) {
    return {
      ok: true,
      taskType: task.type,
      generatedCount: 0,
      skipped: true,
      message: "所有到期的计划记录已存在，无需重复生成",
      date: null,
      executedRuns: plan.executedRuns,
      completed: false,
      stats: {
        executedCount: existingTxRecords.length,
        executedAmount: existingTxRecords.length * amountNum,
        confirmedCount: 0,
        confirmedAmount: 0,
        plan: {
          executedRuns: plan.executedRuns,
          lastRunDate: plan.lastRunDate?.toISOString() ?? null,
          nextRunDate: plan.nextRunDate?.toISOString() ?? null,
          status: plan.status,
        },
      },
    };
  }

  const insuranceProduct = task.type === "insurance_premium"
    ? await prisma.insuranceProduct.findFirst({ where: { id: task.insuranceProductId || "", householdId } })
    : null;
  if (task.type === "insurance_premium" && !task.insuranceProductId) throw new Error("计划缺少保险产品");
  if (task.type === "insurance_premium" && !insuranceProduct) throw new Error("保险产品不存在");

  const finalLastRunDate = datesToProcess[datesToProcess.length - 1]!;
  const finalExecutedRuns = plan.executedRuns + datesToProcess.length;
  const nextRunDate = makeNextRunDate(plan, finalLastRunDate);
  const willComplete = !!(
    (plan.totalRuns && finalExecutedRuns >= plan.totalRuns) ||
    (plan.endDate && startOfDayUtc(plan.endDate) < nextRunDate)
  );
  const nextStatus = willComplete ? RegularInvestStatus.completed : RegularInvestStatus.active;

  const initialDebtAccount =
    task.type === "loan_repayment"
      ? await prisma.account.findUnique({
          where: { id: targetAcc.id },
          select: { balance: true },
        })
      : null;
  let rollingRemainingPrincipal =
    task.type === "loan_repayment" && params.initialLoanPrincipal && params.initialLoanPrincipal > 0
      ? params.initialLoanPrincipal
      : Math.abs(toNumber(initialDebtAccount?.balance ?? 0));
  let rollingExactRemainingPrincipal = rollingRemainingPrincipal;
  let rollingPreviousRunDate = latestExistingDate
    ? startOfDayUtc(latestExistingDate)
    : plan.lastRunDate
      ? startOfDayUtc(plan.lastRunDate)
      : startOfDayUtc(plan.startDate);
  const prepaymentRows = task.type === "loan_repayment"
    ? await prisma.txRecord.findMany({
        where: {
          householdId,
          deletedAt: null,
          source: "debt_prepay_out",
          type: TransactionType.transfer,
          toAccountId: plan.accountId,
          date: { gt: rollingPreviousRunDate, lte: finalLastRunDate },
        },
        orderBy: [{ date: "asc" }, { id: "asc" }],
        select: { date: true, amount: true, debtPrincipalAmount: true },
      })
    : [];
  if (task.type === "loan_repayment" && !(params.initialLoanPrincipal && params.initialLoanPrincipal > 0) && prepaymentRows.length > 0) {
    const prepaymentsAlreadyInBalance = prepaymentRows.reduce(
      (sum, row) => sum + Math.abs(toNumber(row.debtPrincipalAmount ?? row.amount)),
      0,
    );
    rollingRemainingPrincipal = roundLoanMoney(rollingRemainingPrincipal + prepaymentsAlreadyInBalance);
    rollingExactRemainingPrincipal += prepaymentsAlreadyInBalance;
  }
  let nextPrepaymentIndex = 0;
  const applyPrepaymentsBefore = (previousRunDate: Date) => {
    while (nextPrepaymentIndex < prepaymentRows.length && prepaymentRows[nextPrepaymentIndex]!.date <= previousRunDate) {
      const amount = Math.abs(toNumber(prepaymentRows[nextPrepaymentIndex]!.debtPrincipalAmount ?? prepaymentRows[nextPrepaymentIndex]!.amount));
      rollingExactRemainingPrincipal = Math.max(0, rollingExactRemainingPrincipal - amount);
      rollingRemainingPrincipal = Math.max(0, roundLoanMoney(rollingRemainingPrincipal - amount));
      nextPrepaymentIndex += 1;
    }
  };
  // 起始月供直接沿用计划金额：正常期由 preserveScheduledAmount 保持不变，
  // 只有期内出现利率调整（年度重定价）才会重算一次。此前每期用
  // annuity(剩余本金, 剩余期数) 自算月供，期数/余额账本一旦与真实摊还路径
  // 偏离（提前还款缩期、重算复位等），月供就会跳变（2026-07 房贷 4086.83 事故）。
  let rollingScheduledAmount = amountNum;
  let rollingScheduledAmountExact = amountNum;
  const repaymentCategory = task.type === "transfer" && isCreditCardRepaymentTransfer({
    type: TransactionType.transfer,
    accountKind: cashAcc?.kind,
    toAccountKind: targetAcc.kind,
  })
    ? await resolveCreditCardRepaymentCategory(prisma, householdId)
    : null;
  const affectedAccountIds = new Set<string>([targetAcc.id]);
  if (cashAcc) affectedAccountIds.add(cashAcc.id);
  const createdInvestmentEntryIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    const ordinaryCategory = task.type === "income" || task.type === "expense"
      ? await resolveCategorySnapshot(tx, householdId, {
          categoryId: task.categoryId,
          categoryName: task.categoryName,
          type: task.type,
        })
      : null;

    for (const [runIndex, runDate] of datesToProcess.entries()) {
      if (task.type === "loan_repayment") {
        const loanPlanRole = getLoanScheduledPlanRole(task);
        if (loanPlanRole !== "bill" && !cashAcc) throw new Error("计划任务缺少资金账户");
        applyPrepaymentsBefore(rollingPreviousRunDate);
        const remainingRunsForThisRun = plan.totalRuns
          ? Math.max(1, plan.totalRuns - plan.executedRuns - runIndex)
          : 1;
        const runDateKey = formatDateUtc(runDate);
        const parts = calcLoanRunPartsWithRateAdjustments({
          repaymentMethod: task.repaymentMethod,
          baseAnnualRate: task.annualRate,
          adjustments: loanRateAdjustments,
          principalAdjustments: prepaymentRows
            .filter((row) => row.date > rollingPreviousRunDate && row.date <= runDate)
            .map((row) => ({
              date: formatDateUtc(row.date),
              amount: Math.abs(toNumber(row.debtPrincipalAmount ?? row.amount)),
            })),
          intervalMonths: task.repaymentIntervalMonths,
          scheduledAmount: rollingScheduledAmount,
          scheduledAmountExact: rollingScheduledAmountExact,
          preserveScheduledAmount: true,
          remainingPrincipal: rollingExactRemainingPrincipal,
          remainingRuns: remainingRunsForThisRun,
          previousRunDate: formatDateUtc(rollingPreviousRunDate),
          runDate: runDateKey,
        });
        rollingScheduledAmount = parts.scheduledAmount;
        rollingScheduledAmountExact = parts.scheduledAmountExact ?? rollingScheduledAmountExact;
        const inPeriodPrepaymentTotal = prepaymentRows
          .filter((row) => row.date > rollingPreviousRunDate && row.date <= runDate)
          .reduce((sum, row) => sum + Math.abs(toNumber(row.debtPrincipalAmount ?? row.amount)), 0);
        rollingExactRemainingPrincipal = Math.max(0, rollingExactRemainingPrincipal - (parts.principalExact ?? parts.principal));
        rollingRemainingPrincipal = Math.max(0, roundLoanMoney(rollingRemainingPrincipal - parts.principal));
        if (inPeriodPrepaymentTotal > 0) {
          rollingExactRemainingPrincipal = Math.max(0, rollingExactRemainingPrincipal - inPeriodPrepaymentTotal);
          rollingRemainingPrincipal = Math.max(0, roundLoanMoney(rollingRemainingPrincipal - inPeriodPrepaymentTotal));
          while (nextPrepaymentIndex < prepaymentRows.length && prepaymentRows[nextPrepaymentIndex]!.date <= runDate) {
            nextPrepaymentIndex += 1;
          }
        }
        rollingPreviousRunDate = runDate;

        if (parts.principal > 0 || parts.interest > 0) {
          if (loanPlanRole !== "bill") {
            const debitCashAcc = cashAcc;
            if (!debitCashAcc) throw new Error("计划任务缺少资金账户");
            // Auto-debit (mortgage-style): generate the repayment as a cash
            // transfer from the payment account to the loan account.
            await tx.txRecord.create({
              data: {
                householdId,
                type: TransactionType.transfer,
                date: runDate,
                accountId: debitCashAcc.id,
                accountName: debitCashAcc.name,
                toAccountId: targetAcc.id,
                toAccountName: targetAcc.name,
                amount: -roundLoanMoney(parts.principal + parts.interest),
                debtPrincipalAmount: Math.abs(parts.principal),
                debtInterestAmount: Math.abs(parts.interest),
                debtFeeAmount: 0,
                realizedProfit: parts.interest > 0 ? -Math.abs(parts.interest) : null,
                source: "scheduled_task",
                entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
                regularInvestPlanId: plan.id,
                installmentNo: plan.executedRuns + runIndex + 1,
                installmentTotal: plan.totalRuns,
                note: getTaskNote(task.type),
              },
            });
          } else {
            // Bill-only (consumer loan without auto-debit): generate only a
            // bill record on the loan side — no cash movement. source
            // "loan_bill" keeps it out of the debt view's principal/interest
            // aggregations (it is a bill, not a payment).
            await tx.txRecord.create({
              data: {
                householdId,
                type: TransactionType.expense,
                date: runDate,
                accountId: targetAcc.id,
                accountName: targetAcc.name,
                amount: -roundLoanMoney(parts.principal + parts.interest),
                debtPrincipalAmount: Math.abs(parts.principal),
                debtInterestAmount: Math.abs(parts.interest),
                debtFeeAmount: 0,
                source: "loan_bill",
                entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
                regularInvestPlanId: plan.id,
                installmentNo: plan.executedRuns + runIndex + 1,
                installmentTotal: plan.totalRuns,
                note: `消费贷账单：本期应还 ${roundLoanMoney(parts.principal + parts.interest).toFixed(2)}`,
              },
            });
          }
        }
      } else if (task.type === "transfer") {
        if (!cashAcc) throw new Error("计划任务缺少资金账户");
        await tx.txRecord.create({
          data: {
            householdId,
            type: TransactionType.transfer,
            date: runDate,
            accountId: cashAcc.id,
            accountName: cashAcc.name,
            toAccountId: targetAcc.id,
            toAccountName: targetAcc.name,
            amount: -amountNum,
            categoryId: repaymentCategory?.id ?? null,
            categoryName: repaymentCategory?.name ?? null,
            source: "scheduled_task",
            entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
            regularInvestPlanId: plan.id,
            note: getTaskNote(task.type),
          },
        });
      } else if (task.type === "insurance_premium" && insuranceProduct) {
        if (!cashAcc) throw new Error("计划任务缺少资金账户");
        affectedAccountIds.add(insuranceProduct.accountId);
        const created = await tx.txRecord.create({
          data: {
            householdId,
            type: TransactionType.investment,
            date: runDate,
            accountId: cashAcc.id,
            accountName: cashAcc.name,
            toAccountId: insuranceProduct.accountId,
            toAccountName: targetAcc.name,
            amount: -amountNum,
            fundName: insuranceProduct.name,
            fundSubtype: "buy",
            insuranceAction: "premium",
            insuranceProductName: insuranceProduct.name,
            source: "insurance",
            entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
            insuranceProductId: insuranceProduct.id,
            regularInvestPlanId: plan.id,
            note: getTaskNote(task.type, insuranceProduct.name),
          },
        });
        createdInvestmentEntryIds.push(created.id);
      } else if (task.type === "income" || task.type === "expense") {
        await tx.txRecord.create({
          data: {
            householdId,
            type: task.type === "income" ? TransactionType.income : TransactionType.expense,
            date: runDate,
            accountId: targetAcc.id,
            accountName: targetAcc.name,
            amount: task.type === "income" ? amountNum : -amountNum,
            categoryId: ordinaryCategory?.id ?? null,
            categoryName: ordinaryCategory?.name ?? null,
            statementMonth: statementMonthForSingleAccount(runDate, targetAcc),
            source: "scheduled_task",
            entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
            regularInvestPlanId: plan.id,
            note: task.note?.trim() || getTaskNote(task.type, task.title),
          },
        });
      }
    }

    await tx.regularInvestPlan.update({
      where: { id: plan.id },
      data: {
        // 重定价期内重算出的新月供要写回计划，否则下次调用又会从旧金额起步
        ...(task.type === "loan_repayment" && rollingScheduledAmount !== amountNum
          ? { amount: roundLoanMoney(rollingScheduledAmount) }
          : {}),
        lastRunDate: finalLastRunDate,
        nextRunDate,
        executedRuns: finalExecutedRuns,
        status: nextStatus,
      },
    });

    // 贷款扣款落库后，若贷款就此结清（最后一期扣完），同步解除抵押资产状态
    if (task.type === "loan_repayment") {
      await releaseMortgagedAssetsForSettledLoanAccounts(tx, { householdId, debtAccountIds: [targetAcc.id] });
    }
  }, NON_FUND_SCHEDULED_TASK_TRANSACTION_OPTIONS);

  for (const accountId of affectedAccountIds) {
    await recalcAndSaveAccountBalance(accountId).catch(logger.catchLog("balance", "scheduled-task-executor"));
  }
  for (const id of createdInvestmentEntryIds) {
    await syncIndependentBusinessTransactionFromTxRecord(prisma, { businessEntryId: id }).catch(
      logger.catchLog("同步独立业务单失败", "scheduled-task-executor"),
    );
  }
  if (task.type === "insurance_premium") revalidateAfterInvestChange();
  else revalidateAfterTxChange();

  const updatedRows = await prisma.txRecord.findMany({
    where: {
      householdId,
      regularInvestPlanId: plan.id,
      source: { in: sourceFilter },
      deletedAt: null,
    },
    select: { amount: true, fundUnits: true },
  });
  const executedCount = updatedRows.length;
  const executedAmount = updatedRows.reduce((sum, row) => sum + Math.abs(toNumber(row.amount)), 0);
  const confirmedRows = updatedRows.filter((row) => row.fundUnits != null && toNumber(row.fundUnits) > 0);
  const confirmedCount = confirmedRows.length;
  const confirmedAmount = confirmedRows.reduce((sum, row) => sum + Math.abs(toNumber(row.amount)), 0);

  return {
    ok: true,
    taskType: task.type,
    generatedCount: datesToProcess.length,
    skipped: false,
    message: `已执行${scheduledTaskTypeLabel(task.type)}，生成 ${datesToProcess.length} 条交易明细，金额 ${amountNum.toFixed(2)}，累计第 ${finalExecutedRuns} 次`,
    date: formatDateUtc(finalLastRunDate),
    executedRuns: finalExecutedRuns,
    completed: willComplete,
    stats: {
      executedCount,
      executedAmount,
      confirmedCount,
      confirmedAmount,
      plan: {
        executedRuns: finalExecutedRuns,
        lastRunDate: finalLastRunDate.toISOString(),
        nextRunDate: nextRunDate.toISOString(),
        status: nextStatus,
      },
    },
  };
}
