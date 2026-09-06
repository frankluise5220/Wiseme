"use server";

import { IntervalUnit, RegularInvestStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { normalizeNonNegativeDays, setFundArrivalDays, setFundArrivalDaysInTx, setFundConfirmDays, setFundConfirmDaysInTx } from "@/lib/fund/confirmDays";
import { setFundFeeRateByDateInTx } from "@/lib/fund/feeRate";
import { normalizeFundDisplayName, resolveFundName } from "@/lib/fund/fundProfile";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { calcInitialScheduledRunDate, calcResumedScheduledRunDate, skipWeekend } from "@/lib/scheduled-task-date";
import { decodeScheduledTaskMemo, encodeScheduledTaskMemo, getLoanScheduledPlanRole, normalizeScheduledTaskType, scheduledTaskTypeLabel } from "@/lib/scheduled-task";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { deriveRegularInvestNextRunDate } from "@/lib/server/regular-invest-plan";
import { allowsZeroAnnualRateRepaymentMethod, normalizeLoanRepaymentMethod } from "@/lib/loan-repayment";

function parseDateOnlyUtc(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

function sameDateOnly(a: Date | null | undefined, b: Date | null | undefined) {
  if (!a || !b) return a == null && b == null;
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

function parseOptionalNonNegativeNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : parseFloat(String(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parsePositiveInteger(value: unknown, fallback = 1): number {
  const parsed = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeIntervalUnitValue(value: string): IntervalUnit {
  if (value === "day" || value === "week" || value === "biweek" || value === "month" || value === "year") {
    return value;
  }
  return IntervalUnit.month;
}

function normalizeIntervalScheduleValue(unit: IntervalUnit, value: number): { unit: IntervalUnit; value: number } {
  const safeValue = Number.isFinite(value) && value > 0 ? value : 1;
  if (unit === "biweek") return { unit: "week", value: safeValue * 2 };
  return { unit, value: safeValue };
}

function parseSecondaryExecutionDayValue(
  unit: IntervalUnit,
  value: unknown,
): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return null;
  if (unit === "month") return parsed >= 1 && parsed <= 31 ? parsed : null;
  if (unit === "week" || unit === "biweek") return parsed >= 1 && parsed <= 7 ? parsed : null;
  if (unit === "year") {
    const month = Math.floor(parsed / 100);
    const day = parsed % 100;
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? parsed : null;
  }
  return null;
}

function parseExecutionDayValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function createRegularInvest(formData: FormData) {
  const { householdId } = await getHouseholdScope();
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "createRegularInvest") return { ok: false as const, error: "intent 不匹配" };

  const taskType = normalizeScheduledTaskType(formData.get("taskType"));
  const isFundTask = taskType === "fund_regular_invest";
  const isOrdinaryTask = taskType === "income" || taskType === "expense";
  const requiresCashAccount = taskType === "transfer" || taskType === "loan_repayment" || taskType === "insurance_premium";
  const accountId = String(formData.get("accountId") ?? "").trim();
  const fundCodeRaw = String(formData.get("fundCode") ?? "").trim();
  const fundCode = isFundTask ? fundCodeRaw : taskType;
  const categoryId = String(formData.get("categoryId") ?? "").trim() || null;
  const categoryName = String(formData.get("categoryName") ?? "").trim() || null;
  const note = String(formData.get("note") ?? "").trim() || null;
  const suppliedFundName = String(formData.get("fundName") ?? "").trim() || null;
  const suppliedPlanName = String(formData.get("planName") ?? "").trim() || null;
  const insuranceProductId = String(formData.get("insuranceProductId") ?? "").trim() || null;
  const amountRaw = parseFloat(String(formData.get("amount") ?? ""));
  const intervalUnit = String(formData.get("intervalUnit") ?? "month").trim();
  const intervalValueRaw = parseInt(String(formData.get("intervalValue") ?? "1"), 10);
  const startDateStr = String(formData.get("startDate") ?? "").trim();
  const endDateStr = String(formData.get("endDate") ?? "").trim();
  const totalRunsRaw = String(formData.get("totalRuns") ?? "").trim();
  const executionDayRaw = String(formData.get("executionDay") ?? "").trim();
  const secondaryExecutionDayRaw = String(formData.get("secondaryExecutionDay") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim() || null;
  const feeRateRaw = String(formData.get("feeRate") ?? "").trim();
  const confirmDaysRaw = String(formData.get("confirmDays") ?? "").trim();
  const arrivalDaysRaw = String(formData.get("arrivalDays") ?? "").trim();
  const repaymentMethod = normalizeLoanRepaymentMethod(formData.get("repaymentMethod") as string | null);
  const parsedAnnualRate = parseOptionalNonNegativeNumber(formData.get("annualRate"));
  const annualRate = parsedAnnualRate ?? (taskType === "loan_repayment" && allowsZeroAnnualRateRepaymentMethod(repaymentMethod) ? 0 : null);
  const repaymentIntervalMonths = parsePositiveInteger(formData.get("repaymentIntervalMonths"), 1);
  const skipPendingPreceding = formData.get("skipPendingPreceding") !== "false"; // default true

  if (!accountId || !amountRaw || !startDateStr || (isFundTask && !fundCode)) {
    return { ok: false as const, error: "缺少必填字段" };
  }
  if (!Number.isFinite(amountRaw) || amountRaw <= 0) {
    return { ok: false as const, error: "金额不正确" };
  }
  if (requiresCashAccount && !cashAccountId) {
    return { ok: false as const, error: "计划任务缺少资金账户" };
  }
  if (taskType === "insurance_premium" && !insuranceProductId) {
    return { ok: false as const, error: "缴费计划缺少保险产品" };
  }

  const targetAcc = await prisma.account.findUnique({ where: { id: accountId } });
  if (!targetAcc) return { ok: false as const, error: isFundTask ? "基金账户不存在" : "目标账户不存在" };
  if (householdId && targetAcc.householdId !== householdId) return { ok: false as const, error: "目标账户不属于当前账簿" };

  const cashAcc = cashAccountId
    ? await prisma.account.findUnique({ where: { id: cashAccountId }, select: { id: true, name: true, householdId: true } })
    : null;
  if (cashAcc && householdId && cashAcc.householdId !== householdId) return { ok: false as const, error: "资金账户不属于当前账簿" };

  const parsedStartDate = parseDateOnlyUtc(startDateStr);
  if (!parsedStartDate) return { ok: false as const, error: "开始日期不正确" };

  const feeRate = feeRateRaw ? parseFloat(feeRateRaw) : null;
  const confirmDays = confirmDaysRaw ? normalizeNonNegativeDays(confirmDaysRaw, 0) : null;
  const arrivalDays = arrivalDaysRaw ? normalizeNonNegativeDays(arrivalDaysRaw, 2) : null;
  const normalizedInterval = normalizeIntervalScheduleValue(
    normalizeIntervalUnitValue(intervalUnit),
    Number.isFinite(intervalValueRaw) && intervalValueRaw > 0 ? intervalValueRaw : 1,
  );
  const intervalValue = normalizedInterval.value;
  const intervalUnitValue = normalizedInterval.unit;
  const executionDay = parseExecutionDayValue(executionDayRaw);
  const secondaryExecutionDay = parseSecondaryExecutionDayValue(intervalUnitValue, secondaryExecutionDayRaw);
  const dedupedSecondaryExecutionDay =
    intervalValue !== 1 || (secondaryExecutionDay != null && secondaryExecutionDay === executionDay)
      ? null
      : secondaryExecutionDay;
  const startDate = isFundTask ? skipWeekend(parsedStartDate) : parsedStartDate;
  const nextRunDate = calcInitialScheduledRunDate(
    parsedStartDate,
    intervalUnitValue,
    intervalValue,
    executionDay,
    isFundTask,
    dedupedSecondaryExecutionDay,
  );
  const endDate = endDateStr ? parseDateOnlyUtc(endDateStr) : null;
  if (endDateStr && !endDate) return { ok: false as const, error: "结束日期不正确" };
  const totalRuns = totalRunsRaw ? parseInt(totalRunsRaw, 10) : null;
  const profileFundName = isFundTask ? await resolveFundName(fundCode, { householdId }) : null;
  const fundName = isFundTask
    ? profileFundName ?? normalizeFundDisplayName(fundCode, suppliedFundName) ?? fundCode
    : suppliedFundName ?? (isOrdinaryTask ? categoryName ?? scheduledTaskTypeLabel(taskType) : scheduledTaskTypeLabel(taskType));

  try {
    await prisma.$transaction(async (tx) => {
      await tx.regularInvestPlan.create({
        data: {
          accountId,
          accountName: targetAcc.name,
          cashAccountId: cashAccountId || null,
          cashAccountName: cashAcc?.name || null,
          fundCode,
          fundName,
          planName: suppliedPlanName ?? fundName,
          taskType,
          targetName: fundName,
          insuranceProductName: taskType === "insurance_premium" ? fundName : null,
          fundProductType: isFundTask ? (targetAcc.investProductType || null) : null,
          amount: amountRaw,
          intervalUnit: intervalUnitValue,
          intervalValue,
          executionDay: executionDay != null && Number.isFinite(executionDay) ? executionDay : null,
          secondaryExecutionDay: dedupedSecondaryExecutionDay,
          startDate,
          nextRunDate,
          endDate: endDate && Number.isFinite(endDate.getTime()) ? endDate : null,
          totalRuns: totalRuns && Number.isFinite(totalRuns) && totalRuns > 0 ? totalRuns : null,
          status: RegularInvestStatus.active,
          feeRate: isFundTask && feeRate != null && Number.isFinite(feeRate) ? feeRate : isFundTask ? null : 0,
          confirmDays: isFundTask ? confirmDays : 0,
          arrivalDays: isFundTask ? arrivalDays : 0,
          memo: encodeScheduledTaskMemo({
            type: taskType,
            title: fundName,
            fromAccountId: isOrdinaryTask ? null : cashAccountId || null,
            toAccountId: accountId,
            categoryId: isOrdinaryTask ? categoryId : null,
            categoryName: isOrdinaryTask ? categoryName : null,
            insuranceProductId,
            note: isOrdinaryTask ? note : null,
            annualRate: taskType === "loan_repayment" ? annualRate : null,
            repaymentMethod: taskType === "loan_repayment" ? repaymentMethod : null,
            repaymentIntervalMonths: taskType === "loan_repayment" ? repaymentIntervalMonths : null,
            loanPlanRole: taskType === "loan_repayment" ? "auto_debit" : null,
          }),
          skipPendingPreceding: isFundTask ? skipPendingPreceding : false,
          ...{ householdId },
        },
      });

      // Keep the canonical confirm-days and fee-rate stores in sync (matching the API route)
      const newDays = confirmDays != null && Number.isFinite(confirmDays) ? confirmDays : 0;
      const newRate = feeRate != null && Number.isFinite(feeRate) ? feeRate : 0;
      if (isFundTask && accountId && fundCode) {
        await setFundConfirmDaysInTx(tx, accountId, fundCode, newDays);
        await setFundFeeRateByDateInTx(tx, accountId, fundCode, newRate, startDate, "buy");
        const newArrivalDays = arrivalDays != null && Number.isFinite(arrivalDays) ? arrivalDays : 2;
        await setFundArrivalDaysInTx(tx, accountId, fundCode, newArrivalDays);
      }
    });

    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "创建失败" };
  }
}

async function regularInvestAction(formData: FormData) {
  const { householdId } = await getHouseholdScope();
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "regularInvestAction") return { ok: false as const, error: "intent 不匹配" };

  const planId = String(formData.get("planId") ?? "").trim();
  const actionType = String(formData.get("action") ?? "").trim();

  if (!planId) return { ok: false as const, error: "缺少 planId" };

  const plan = await prisma.regularInvestPlan.findUnique({ where: { id: planId } });
  if (!plan) return { ok: false as const, error: "计划不存在" };
  if (householdId && plan.householdId && plan.householdId !== householdId) return { ok: false as const, error: "越权操作" };

  // Mortgage bills ("bill" loan plans) are system-generated and read-only;
  // auto-debit transfer plans remain manageable (pause/resume/stop).
  const actionTask = decodeScheduledTaskMemo(plan.memo);
  if (actionTask.type === "loan_repayment" && getLoanScheduledPlanRole(actionTask) === "bill") {
    return { ok: false as const, error: "房贷账单由系统生成（利率由人行/LPR调整），不可作为计划任务修改" };
  }

  try {
    if (actionType === "pause") {
      if (plan.status !== RegularInvestStatus.active) {
        return { ok: false as const, error: "只有活跃状态的计划才能暂停" };
      }
      await prisma.regularInvestPlan.update({
        where: { id: planId },
        data: { status: RegularInvestStatus.paused },
      });
    } else if (actionType === "resume") {
      if (plan.status !== RegularInvestStatus.paused) {
        return { ok: false as const, error: "只有暂停状态的计划才能恢复" };
      }
      const task = decodeScheduledTaskMemo(plan.memo);
      const usesBusinessDays = task.type === "fund_regular_invest";
      const nextRunDate = calcResumedScheduledRunDate(
        plan.nextRunDate,
        new Date(),
        plan.intervalUnit,
        plan.intervalValue,
        plan.executionDay,
        usesBusinessDays,
        plan.secondaryExecutionDay,
      );

      await prisma.regularInvestPlan.update({
        where: { id: planId },
        data: { status: RegularInvestStatus.active, nextRunDate },
      });
    } else if (actionType === "stop") {
      if (plan.status === RegularInvestStatus.stopped || plan.status === RegularInvestStatus.completed) {
        return { ok: false as const, error: "计划已终止或已完成" };
      }
      await prisma.regularInvestPlan.update({
        where: { id: planId },
        data: { status: RegularInvestStatus.stopped },
      });
    } else {
      return { ok: false as const, error: "未知操作类型" };
    }

    // Client-side handles page refresh via mmh finance refresh events.
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "操作失败" };
  }
}

async function updateRegularInvest(formData: FormData) {
  const { householdId } = await getHouseholdScope();
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "updateRegularInvest") return { ok: false as const, error: "intent 不匹配" };

  const planId = String(formData.get("planId") ?? "").trim();
  if (!planId) return { ok: false as const, error: "缺少 planId" };

  const plan = await prisma.regularInvestPlan.findUnique({ where: { id: planId } });
  if (!plan) return { ok: false as const, error: "计划不存在" };
  if (householdId && plan.householdId && plan.householdId !== householdId) return { ok: false as const, error: "越权操作" };

  // Mortgage bills ("bill" loan plans) are system-generated and read-only:
  // the bill schedule and the rate (PBOC/LPR driven) are derived from the
  // loan and managed through the debt module. Auto-debit transfer plans
  // stay user-editable below.
  const existingTaskForGuard = decodeScheduledTaskMemo(plan.memo);
  if (existingTaskForGuard.type === "loan_repayment" && getLoanScheduledPlanRole(existingTaskForGuard) === "bill") {
    return { ok: false as const, error: "房贷账单由系统生成（利率由人行/LPR调整），不可作为计划任务修改" };
  }

  const existingTask = decodeScheduledTaskMemo(plan.memo);
  const existingTaskType = normalizeScheduledTaskType(plan.taskType ?? existingTask.type);
  const taskType = normalizeScheduledTaskType(formData.get("taskType") || existingTaskType);
  if (existingTaskType === "loan_repayment" && formData.has("amount")) {
    const requestedAmount = parseOptionalNonNegativeNumber(formData.get("amount"));
    const currentAmount = Number(plan.amount ?? 0);
    if (requestedAmount == null || Math.abs(requestedAmount - currentAmount) > 0.001) {
      return { ok: false as const, code: "LOAN_REPAYMENT_AMOUNT_LOCKED", error: "Loan repayment amount is generated by the repayment schedule and cannot be changed." };
    }
  }
  const isFundTask = taskType === "fund_regular_invest";
  const isOrdinaryTask = taskType === "income" || taskType === "expense";
  const requiresCashAccount = taskType === "transfer" || taskType === "loan_repayment" || taskType === "insurance_premium";
  const accountId = String(formData.get("accountId") ?? plan.accountId).trim();
  const fundCodeRaw = String(formData.get("fundCode") ?? plan.fundCode).trim();
  const fundCode = isFundTask ? fundCodeRaw : taskType;
  const insuranceProductId = String(formData.get("insuranceProductId") ?? "").trim() || existingTask.insuranceProductId || null;
  const suppliedFundName = String(formData.get("fundName") ?? "").trim() || null;
  const suppliedPlanName = formData.has("planName")
    ? String(formData.get("planName") ?? "").trim() || null
    : undefined;
  const nextCategoryId = formData.has("categoryId")
    ? String(formData.get("categoryId") ?? "").trim() || null
    : existingTask.categoryId ?? null;
  const nextCategoryName = formData.has("categoryName")
    ? String(formData.get("categoryName") ?? "").trim() || null
    : existingTask.categoryName ?? null;
  const nextNote = formData.has("note")
    ? String(formData.get("note") ?? "").trim() || null
    : existingTask.note ?? null;
  const amountRaw = parseFloat(String(formData.get("amount") ?? ""));
  const intervalUnit = String(formData.get("intervalUnit") ?? "").trim();
  const intervalValueRaw = parseInt(String(formData.get("intervalValue") ?? "1"), 10);
  const startDateStr = String(formData.get("startDate") ?? "").trim();
  const nextRunDateStr = String(formData.get("nextRunDate") ?? "").trim();
  const endDateStr = String(formData.get("endDate") ?? "").trim();
  const totalRunsRaw = String(formData.get("totalRuns") ?? "").trim();
  const executionDayRaw = String(formData.get("executionDay") ?? "").trim();
  const secondaryExecutionDayRaw = String(formData.get("secondaryExecutionDay") ?? "").trim();
  const cashAccountId = String(formData.get("cashAccountId") ?? "").trim() || null;
  const feeRateRaw = String(formData.get("feeRate") ?? "").trim();
  const confirmDaysRaw = String(formData.get("confirmDays") ?? "").trim();
  const arrivalDaysRaw = String(formData.get("arrivalDays") ?? "").trim();
  const nextRepaymentMethod = formData.has("repaymentMethod") && String(formData.get("repaymentMethod") ?? "").trim()
    ? normalizeLoanRepaymentMethod(formData.get("repaymentMethod") as string | null)
    : normalizeLoanRepaymentMethod(existingTask.repaymentMethod);
  const parsedNextAnnualRate = formData.has("annualRate")
    ? parseOptionalNonNegativeNumber(formData.get("annualRate"))
    : existingTask.annualRate ?? null;
  const nextAnnualRate = parsedNextAnnualRate ?? (taskType === "loan_repayment" && allowsZeroAnnualRateRepaymentMethod(nextRepaymentMethod) ? 0 : null);
  const nextRepaymentIntervalMonths = formData.has("repaymentIntervalMonths")
    ? parsePositiveInteger(formData.get("repaymentIntervalMonths"), 1)
    : existingTask.repaymentIntervalMonths ?? 1;

  if (!accountId || (isFundTask && !fundCode)) return { ok: false as const, error: "缺少必填字段" };
  if (requiresCashAccount && !cashAccountId) return { ok: false as const, error: "计划任务缺少资金账户" };
  if (taskType === "insurance_premium" && !insuranceProductId) return { ok: false as const, error: "缴费计划缺少保险产品" };

  const updateData: any = {};
  const profileFundName = isFundTask ? await resolveFundName(fundCode, { householdId }) : null;
  const displayName = isFundTask
    ? profileFundName ?? normalizeFundDisplayName(fundCode, suppliedFundName) ?? normalizeFundDisplayName(fundCode, plan.fundName) ?? fundCode
    : suppliedFundName || (isOrdinaryTask ? nextCategoryName ?? plan.targetName ?? plan.fundName ?? scheduledTaskTypeLabel(taskType) : scheduledTaskTypeLabel(taskType));
  updateData.accountId = accountId;
  updateData.fundCode = fundCode;
  updateData.fundName = displayName;
  if (suppliedPlanName !== undefined) updateData.planName = suppliedPlanName;
  updateData.taskType = taskType;
  updateData.targetName = displayName;
  updateData.insuranceProductName = taskType === "insurance_premium" ? displayName : null;
  updateData.memo = encodeScheduledTaskMemo({
    type: taskType,
    title: displayName,
    fromAccountId: isOrdinaryTask ? null : cashAccountId || null,
    toAccountId: accountId,
    categoryId: isOrdinaryTask ? nextCategoryId : null,
    categoryName: isOrdinaryTask ? nextCategoryName : null,
    insuranceProductId,
    note: isOrdinaryTask ? nextNote : null,
    annualRate: taskType === "loan_repayment" ? nextAnnualRate : null,
    repaymentMethod: taskType === "loan_repayment" ? nextRepaymentMethod : null,
    repaymentIntervalMonths: taskType === "loan_repayment" ? nextRepaymentIntervalMonths : null,
    loanPlanRole: taskType === "loan_repayment" ? getLoanScheduledPlanRole(existingTask) ?? "auto_debit" : null,
  });
  if (accountId !== plan.accountId || formData.has("accountId")) {
    const targetAcc = await prisma.account.findUnique({ where: { id: accountId }, select: { name: true, householdId: true, investProductType: true } });
    if (!targetAcc) return { ok: false as const, error: isFundTask ? "基金账户不存在" : "目标账户不存在" };
    if (householdId && targetAcc.householdId !== householdId) return { ok: false as const, error: "目标账户不属于当前账簿" };
    updateData.accountName = targetAcc.name;
    updateData.fundProductType = isFundTask ? (targetAcc.investProductType || plan.fundProductType || null) : null;
  } else if (!isFundTask) {
    updateData.fundProductType = null;
  }
  if (Number.isFinite(amountRaw) && amountRaw > 0) updateData.amount = amountRaw;
  const normalizedEffectiveInterval = normalizeIntervalScheduleValue(
    normalizeIntervalUnitValue(intervalUnit || plan.intervalUnit),
    Number.isFinite(intervalValueRaw) && intervalValueRaw > 0 ? intervalValueRaw : plan.intervalValue,
  );
  const effectiveIntervalUnit = normalizedEffectiveInterval.unit;
  const effectiveIntervalValue = normalizedEffectiveInterval.value;
  const effectiveExecutionDay = effectiveIntervalUnit === "year"
    ? null
    : executionDayRaw
      ? parseExecutionDayValue(executionDayRaw)
      : formData.has("executionDay")
        ? null
        : plan.executionDay;
  const effectiveSecondaryExecutionDay = parseSecondaryExecutionDayValue(
    effectiveIntervalUnit,
    formData.has("secondaryExecutionDay")
      ? secondaryExecutionDayRaw
      : secondaryExecutionDayRaw || plan.secondaryExecutionDay,
  );
  const normalizedSecondaryExecutionDay = effectiveIntervalValue === 1 ? effectiveSecondaryExecutionDay : null;
  if (intervalUnit || (Number.isFinite(intervalValueRaw) && intervalValueRaw > 0)) {
    updateData.intervalUnit = effectiveIntervalUnit;
    updateData.intervalValue = effectiveIntervalValue;
  }
  const parsedStartDate = startDateStr ? parseDateOnlyUtc(startDateStr) : null;
  if (startDateStr && !parsedStartDate) return { ok: false as const, error: "开始日期不正确" };
  const parsedNextRunDate = nextRunDateStr ? parseDateOnlyUtc(nextRunDateStr) : null;
  if (nextRunDateStr && !parsedNextRunDate) return { ok: false as const, error: "下次执行日期不正确" };
  const nextStoredStartDate = parsedStartDate
    ? isFundTask ? skipWeekend(parsedStartDate) : parsedStartDate
    : plan.startDate;
  if (parsedNextRunDate && parsedNextRunDate < nextStoredStartDate) return { ok: false as const, code: "NEXT_RUN_DATE_BEFORE_START_DATE", error: "Next run date cannot be earlier than the effective date." };
  const startDateChanged = parsedStartDate != null && !sameDateOnly(nextStoredStartDate, plan.startDate);
  const taskTypeChanged = taskType !== existingTaskType;
  const normalizedExistingExecutionDay = effectiveIntervalUnit === IntervalUnit.year ? null : plan.executionDay;
  const normalizedExistingSecondaryExecutionDay =
    effectiveIntervalUnit === plan.intervalUnit ? plan.secondaryExecutionDay : null;
  const scheduleChanged =
    startDateChanged ||
    taskTypeChanged ||
    effectiveIntervalUnit !== plan.intervalUnit ||
    effectiveIntervalValue !== plan.intervalValue ||
    effectiveExecutionDay !== normalizedExistingExecutionDay ||
    normalizedSecondaryExecutionDay !== normalizedExistingSecondaryExecutionDay;
  let linkedRecordCount: number | null = null;
  const getLinkedRecordCount = async () => {
    if (linkedRecordCount == null) {
      linkedRecordCount = await prisma.txRecord.count({ where: { regularInvestPlanId: plan.id, deletedAt: null } });
    }
    return linkedRecordCount;
  };
  const hasGeneratedRecords = (plan.executedRuns ?? 0) > 0 || !!plan.lastRunDate;
  if (startDateChanged && hasGeneratedRecords) {
    return { ok: false as const, error: "该计划已生成记录，不能修改起始日期。后续执行会自动从最后一笔生成记录后的下一个周期继续；如需调整范围，请修改停止日期、频率或总次数。" };
  }
  if (taskTypeChanged && hasGeneratedRecords) {
    return { ok: false as const, error: "该计划已生成记录，不能修改任务类型。请新建计划处理不同类型的后续任务。" };
  }
  if (startDateChanged) {
    if (await getLinkedRecordCount() > 0) {
      return { ok: false as const, error: "该计划已生成记录，不能修改起始日期。后续执行会自动从最后一笔生成记录后的下一个周期继续；如需调整范围，请修改停止日期、频率或总次数。" };
    }
  }
  if (taskTypeChanged && await getLinkedRecordCount() > 0) {
    return { ok: false as const, error: "该计划已生成记录，不能修改任务类型。请新建计划处理不同类型的后续任务。" };
  }
  if (parsedStartDate) updateData.startDate = nextStoredStartDate;
  if (effectiveIntervalUnit === "year") updateData.executionDay = effectiveExecutionDay;
  else if (formData.has("executionDay")) updateData.executionDay = effectiveExecutionDay;
  if (formData.has("secondaryExecutionDay")) updateData.secondaryExecutionDay = normalizedSecondaryExecutionDay;
  else if (effectiveIntervalUnit !== plan.intervalUnit) updateData.secondaryExecutionDay = null;
  if (scheduleChanged) {
    updateData.nextRunDate = await deriveRegularInvestNextRunDate(prisma, {
      id: plan.id,
      householdId,
      taskType,
      startDate: nextStoredStartDate,
      lastRunDate: plan.lastRunDate,
      intervalUnit: effectiveIntervalUnit,
      intervalValue: effectiveIntervalValue,
      executionDay: effectiveExecutionDay,
      secondaryExecutionDay: updateData.secondaryExecutionDay ?? normalizedSecondaryExecutionDay,
    });
  }
  if (parsedNextRunDate) updateData.nextRunDate = parsedNextRunDate;
  if (endDateStr) {
    const endDate = parseDateOnlyUtc(endDateStr);
    if (!endDate) return { ok: false as const, error: "结束日期不正确" };
    updateData.endDate = endDate;
  } else if (formData.has("endDate")) {
    updateData.endDate = null;
  }
  if (totalRunsRaw) {
    const totalRuns = parseInt(totalRunsRaw, 10);
    if (Number.isFinite(totalRuns) && totalRuns > 0) updateData.totalRuns = totalRuns;
  } else if (formData.has("totalRuns")) {
    updateData.totalRuns = null;
  }
  if (cashAccountId != null) {
    updateData.cashAccountId = cashAccountId;
    if (cashAccountId) {
      const cashAcc = await prisma.account.findUnique({ where: { id: cashAccountId }, select: { name: true, householdId: true } });
      if (cashAcc && householdId && cashAcc.householdId !== householdId) return { ok: false as const, error: "资金账户不属于当前账簿" };
      updateData.cashAccountName = cashAcc?.name || null;
    } else {
      updateData.cashAccountName = null;
    }
  } else if (isOrdinaryTask) {
    updateData.cashAccountId = null;
    updateData.cashAccountName = null;
  }
  if (isFundTask && feeRateRaw) {
    const feeRate = parseFloat(feeRateRaw);
    if (Number.isFinite(feeRate)) updateData.feeRate = feeRate;
  } else if (isFundTask && formData.has("feeRate")) {
    updateData.feeRate = null;
  }
  if (isFundTask && confirmDaysRaw !== "") {
    updateData.confirmDays = normalizeNonNegativeDays(confirmDaysRaw, 0);
  } else if (isFundTask && formData.has("confirmDays")) {
    updateData.confirmDays = null;
  }

  if (isFundTask && arrivalDaysRaw !== "") {
    updateData.arrivalDays = normalizeNonNegativeDays(arrivalDaysRaw, 2);
  } else if (isFundTask && formData.has("arrivalDays")) {
    updateData.arrivalDays = null;
  }
  if (!isFundTask) {
    updateData.fundProductType = null;
    updateData.confirmDays = 0;
    updateData.arrivalDays = 0;
    updateData.feeRate = 0;
    updateData.skipPendingPreceding = false;
  } else if (formData.has("skipPendingPreceding")) {
    updateData.skipPendingPreceding = formData.get("skipPendingPreceding") !== "false";
  }

  // Auto-debit loan transfer plans are user-editable, but only for the
  // funding (cash) account, next run date and plan name.
  // The repayment schedule and the rate (PBOC/LPR driven) are derived from
  // the loan and must be changed through the debt module. The memo is
  // rebuilt from the existing payload so loan-derived fields (LPR discount,
  // rate adjustments, original total runs, role) are preserved.
  if (existingTaskType === "loan_repayment") {
    const loanUpdateData: any = {};
    if (updateData.cashAccountId !== undefined) {
      loanUpdateData.cashAccountId = updateData.cashAccountId;
      loanUpdateData.cashAccountName = updateData.cashAccountName;
    }
    if (updateData.nextRunDate !== undefined) loanUpdateData.nextRunDate = updateData.nextRunDate;
    if (updateData.planName !== undefined) loanUpdateData.planName = updateData.planName;
    loanUpdateData.memo = encodeScheduledTaskMemo({
      ...existingTask,
      fromAccountId: cashAccountId || null,
      toAccountId: plan.accountId,
    });
    try {
      await prisma.regularInvestPlan.update({
        where: { id: planId },
        data: loanUpdateData,
      });
      // Client-side handles page refresh
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : "更新失败" };
    }
  }

  try {
    await prisma.regularInvestPlan.update({
      where: { id: planId },
      data: updateData,
    });

    if (isFundTask && updateData.confirmDays != null) {
      await setFundConfirmDays(accountId, fundCode, updateData.confirmDays).catch(() => {});
    }
    if (isFundTask && updateData.arrivalDays != null) {
      await setFundArrivalDays(accountId, fundCode, updateData.arrivalDays).catch(() => {});
    }

    // Client-side handles page refresh
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "更新失败" };
  }
}

async function deleteRegularInvest(formData: FormData) {
  const { householdId } = await getHouseholdScope();
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent !== "deleteRegularInvest") return { ok: false as const, error: "intent 不匹配" };

  const planId = String(formData.get("planId") ?? "").trim();
  if (!planId) return { ok: false as const, error: "缺少 planId" };

  const plan = await prisma.regularInvestPlan.findUnique({ where: { id: planId } });
  if (!plan) return { ok: false as const, error: "计划不存在" };
  if (householdId && plan.householdId && plan.householdId !== householdId) return { ok: false as const, error: "越权操作" };

  // Loan repayment plans (bills and auto-debit transfers alike) are derived
  // from the loan and cannot be deleted manually here.
  const deleteTask = decodeScheduledTaskMemo(plan.memo);
  if (deleteTask.type === "loan_repayment") {
    return { ok: false as const, error: "贷款还款计划由系统管理，不可手动删除" };
  }

  const deleteRecords = formData.get("deleteRecords") === "1";

  try {
    if (deleteRecords && plan.accountId) {
      // Soft-delete the linked transaction records
      await prisma.txRecord.updateMany({
        where: { regularInvestPlanId: planId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
    }

    await prisma.regularInvestPlan.delete({ where: { id: planId } });

    if (plan.accountId && plan.fundCode) {
      await recalcFundPositions(plan.accountId, [plan.fundCode]).catch(() => {});
    }

    // Client-side handles page refresh
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "删除失败" };
  }
}

/** Unified entry point for regular-invest operations: dispatches to the different Server Actions by intent */
export async function regularInvestFormAction(formData: FormData) {
  const intent = String(formData.get("intent") ?? "").trim();
  if (intent === "createRegularInvest") return createRegularInvest(formData);
  if (intent === "regularInvestAction") return regularInvestAction(formData);
  if (intent === "updateRegularInvest") return updateRegularInvest(formData);
  if (intent === "deleteRegularInvest") return deleteRegularInvest(formData);
  return { ok: false as const, error: "未知 intent" };
}
