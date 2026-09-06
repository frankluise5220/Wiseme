import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { IntervalUnit, RegularInvestStatus } from "@prisma/client";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { normalizeNonNegativeDays, setFundConfirmDays, setFundConfirmDaysInTx, setFundArrivalDays, setFundArrivalDaysInTx } from "@/lib/fund/confirmDays";
import { setFundFeeRate, setFundFeeRateInTx } from "@/lib/fund/feeRate";
import { getFundProfileNameMap, normalizeFundDisplayName, resolveFundName } from "@/lib/fund/fundProfile";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { decodeScheduledTaskMemo, encodeScheduledTaskMemo, getLoanScheduledPlanRole, normalizeScheduledTaskType, scheduledTaskTypeLabel } from "@/lib/scheduled-task";
import { revalidateAfterInvestChange, revalidateAfterTxChange } from "@/lib/server/revalidate";
import { calcInitialScheduledRunDate as calcInitialRunDate, calcResumedScheduledRunDate as calcResumedRunDate, skipWeekend } from "@/lib/scheduled-task-date";
import { deriveRegularInvestNextRunDate } from "@/lib/server/regular-invest-plan";
import { allowsZeroAnnualRateRepaymentMethod, normalizeLoanRepaymentMethod } from "@/lib/loan-repayment";

/**
 * /api/v1/regular-invest
 *
 * GET lists scheduled tasks. POST creates fund regular-invest, transfer,
 * insurance-premium, fixed-income, or fixed-expense tasks. PUT updates task
 * metadata/status, including the optional user-editable planName display field.
 * Fixed income and fixed expense store category/note fields in the task memo and
 * generate ordinary TxRecord rows when executed.
 */

function normalizeIntervalUnit(value: unknown): IntervalUnit {
  if (value === "day" || value === "week" || value === "biweek" || value === "month" || value === "year") {
    return value;
  }
  return IntervalUnit.month;
}

function normalizeIntervalSchedule(unit: IntervalUnit, value: number): { unit: IntervalUnit; value: number } {
  const safeValue = Number.isFinite(value) && value > 0 ? value : 1;
  if (unit === IntervalUnit.biweek) {
    return { unit: IntervalUnit.week, value: safeValue * 2 };
  }
  return { unit, value: safeValue };
}

function parseSecondaryExecutionDay(
  unit: IntervalUnit,
  value: unknown,
  fallback?: number | null,
): number | null {
  const parsed = value == null || value === ""
    ? (fallback == null ? null : Number(fallback))
    : typeof value === "number"
      ? value
      : parseInt(String(value), 10);
  if (parsed == null || !Number.isFinite(parsed)) return null;
  if (unit === "month") return parsed >= 1 && parsed <= 31 ? parsed : null;
  if (unit === "week" || unit === "biweek") return parsed >= 1 && parsed <= 7 ? parsed : null;
  if (unit === "year") {
    const month = Math.floor(parsed / 100);
    const day = parsed % 100;
    return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? parsed : null;
  }
  return null;
}

function parseDateOnlyUtc(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? "").trim());
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

function cleanOptionalString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text || null;
}

export async function GET(req: NextRequest) {
  try {
    const { hidFilter } = await getHouseholdScope();
    const accountId = req.nextUrl.searchParams.get("accountId");
    const status = req.nextUrl.searchParams.get("status") as RegularInvestStatus | null;

    const plans = await prisma.regularInvestPlan.findMany({
      where: {
        ...hidFilter,
        ...(accountId ? { accountId } : {}),
        ...(status ? { status } : {}),
      },
      include: {
        Account_RegularInvestPlan_accountIdToAccount: {
          include: { Institution: { select: { name: true } } },
        },
        Account_RegularInvestPlan_cashAccountIdToAccount: {
          include: { Institution: { select: { name: true } } },
        },
      },
      orderBy: { nextRunDate: "asc" },
    });

    const profileFundNames = await getFundProfileNameMap(
      plans
        .filter((plan) => normalizeScheduledTaskType(plan.taskType ?? decodeScheduledTaskMemo(plan.memo).type) === "fund_regular_invest")
        .map((plan) => plan.fundCode),
    );

    // Mortgage bills ("bill" loan plans) are system-generated: the schedule and
    // the rate (PBOC/LPR driven) are derived from the loan, so they are shown
    // read-only. Auto-debit transfer plans remain user-editable.
    return NextResponse.json({
      ok: true,
      plans: plans.map((plan) => {
        const scheduledTask = decodeScheduledTaskMemo(plan.memo);
        const resolvedTaskType = normalizeScheduledTaskType(plan.taskType ?? scheduledTask.type);
        const profileFundName = resolvedTaskType === "fund_regular_invest" ? profileFundNames.get(plan.fundCode) ?? null : null;
        const displayFundName = profileFundName ?? normalizeFundDisplayName(plan.fundCode, plan.fundName) ?? plan.fundName;
        const displayTargetName = resolvedTaskType === "fund_regular_invest"
          ? profileFundName ?? normalizeFundDisplayName(plan.fundCode, plan.targetName) ?? displayFundName
          : plan.targetName;
        return {
          ...plan,
          planName: plan.planName ?? null,
          fundName: displayFundName,
          targetName: displayTargetName,
          isSystemTask: scheduledTask.type === "loan_repayment" && getLoanScheduledPlanRole(scheduledTask) === "bill",
          taskLoanPlanRole: getLoanScheduledPlanRole(scheduledTask),
          accountInstitutionName: plan.Account_RegularInvestPlan_accountIdToAccount.Institution?.name ?? "",
          cashAccountInstitutionName: plan.Account_RegularInvestPlan_cashAccountIdToAccount?.Institution?.name ?? "",
        };
      }),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: e instanceof Error ? e.message : "查询失败" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();

    const body = await req.json();
    const {
      accountId,
      cashAccountId,
      taskType = "fund_regular_invest",
      insuranceProductId,
      fundCode,
      fundName,
      planName,
      fundProductType,
      amount,
      intervalUnit = "month" as IntervalUnit,
      intervalValue = 1,
      startDate,
      endDate,
      totalRuns,
      executionDay,
      secondaryExecutionDay,
      feeRate,
      confirmDays,
      arrivalDays,
      annualRate,
      repaymentMethod,
      repaymentIntervalMonths,
      categoryId,
      categoryName,
      note,
      skipPendingPreceding,
    } = body;

    const scheduledTaskType = normalizeScheduledTaskType(taskType);
    const isFundTask = scheduledTaskType === "fund_regular_invest";
    const isInsuranceTask = scheduledTaskType === "insurance_premium";
    const isLoanTask = scheduledTaskType === "loan_repayment";
    const isOrdinaryTask = scheduledTaskType === "income" || scheduledTaskType === "expense";
    const requiresCashAccount = scheduledTaskType === "transfer" || scheduledTaskType === "loan_repayment" || isInsuranceTask;
    const loanRepaymentMethod = normalizeLoanRepaymentMethod(typeof repaymentMethod === "string" ? repaymentMethod : null);
    const parsedLoanAnnualRate = parseOptionalNonNegativeNumber(annualRate);
    const loanAnnualRate = parsedLoanAnnualRate ?? (isLoanTask && allowsZeroAnnualRateRepaymentMethod(loanRepaymentMethod) ? 0 : null);
    const loanRepaymentIntervalMonths = parsePositiveInteger(repaymentIntervalMonths, 1);
    const taskCategoryId = cleanOptionalString(categoryId);
    const taskCategoryName = cleanOptionalString(categoryName);
    const taskNote = cleanOptionalString(note);

    // Insurance tasks require insuranceProductId or accountId
    if (!amount || !startDate || (isFundTask && (!accountId || !fundCode))) {
      return NextResponse.json({ ok: false, code: "MISSING_REQUIRED_FIELDS", error: "缺少必填字段" }, { status: 400 });
    }
    if (isInsuranceTask && !insuranceProductId && !accountId) {
      return NextResponse.json({ ok: false, code: "MISSING_REQUIRED_FIELDS", error: "缺少必填字段" }, { status: 400 });
    }
    if (!isInsuranceTask && !isFundTask && !accountId) {
      return NextResponse.json({ ok: false, code: "MISSING_REQUIRED_FIELDS", error: "缺少必填字段" }, { status: 400 });
    }
    if (requiresCashAccount && !cashAccountId) {
      return NextResponse.json({ ok: false, code: "CASH_ACCOUNT_REQUIRED", error: "请选择资金账户" }, { status: 400 });
    }

    // Resolve the target account for insurance_premium
    let effectiveAccountId = accountId;
    let effectiveAccountName: string | null = null;
    let insuranceProductName: string | null = null;
    if (isInsuranceTask && insuranceProductId && !accountId) {
      const product = await prisma.insuranceProduct.findFirst({
        where: { id: insuranceProductId, householdId },
        include: { Account: { select: { id: true, name: true } } },
      });
      if (!product) return NextResponse.json({ ok: false, code: "INSURANCE_PRODUCT_NOT_FOUND", error: "保险产品不存在" }, { status: 400 });
      effectiveAccountId = product.accountId;
      effectiveAccountName = product.Account.name;
      insuranceProductName = product.name;
    } else if (isInsuranceTask && insuranceProductId) {
      const product = await prisma.insuranceProduct.findFirst({
        where: { id: insuranceProductId, householdId },
        select: { name: true },
      });
      insuranceProductName = product?.name ?? null;
    }

    const amountNum = parseFloat(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return NextResponse.json({ ok: false, code: "INVALID_AMOUNT", error: "金额不正确" }, { status: 400 });
    }

    const targetAcc = await prisma.account.findUnique({ where: { id: effectiveAccountId } });
    if (!targetAcc) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "目标账户不存在" }, { status: 400 });
    if (targetAcc.householdId !== householdId) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_IN_HOUSEHOLD", error: "目标账户不属于当前账簿" }, { status: 403 });

    const cashAcc = cashAccountId
      ? await prisma.account.findUnique({ where: { id: cashAccountId }, select: { id: true, name: true, householdId: true } })
      : null;
    if (cashAcc && cashAcc.householdId !== householdId) return NextResponse.json({ ok: false, code: "CASH_ACCOUNT_NOT_IN_HOUSEHOLD", error: "资金账户不属于当前账簿" }, { status: 403 });
    if (requiresCashAccount && !cashAcc) return NextResponse.json({ ok: false, code: "CASH_ACCOUNT_NOT_FOUND", error: "资金账户不存在" }, { status: 400 });
    if (scheduledTaskType === "transfer" && cashAccountId === effectiveAccountId) {
      return NextResponse.json({ ok: false, code: "SAME_TRANSFER_ACCOUNTS", error: "转出/转入账户不能相同" }, { status: 400 });
    }

    const suppliedTaskName = cleanOptionalString(fundName);
    const profileFundName = isFundTask ? await resolveFundName(fundCode, { householdId }) : null;
    const normalizedSuppliedFundName = isFundTask ? normalizeFundDisplayName(fundCode, suppliedTaskName) : suppliedTaskName;
    const taskTitle =
      (isFundTask ? profileFundName ?? normalizedSuppliedFundName : suppliedTaskName) ||
      (isInsuranceTask && insuranceProductName) ||
      (isOrdinaryTask && taskCategoryName) ||
      (isFundTask
        ? fundCode
        : scheduledTaskType === "transfer" && cashAcc
          ? `${cashAcc.name} -> ${targetAcc.name}`
          : targetAcc.name || scheduledTaskTypeLabel(scheduledTaskType));

    const totalRunsInt = totalRuns ? parseInt(totalRuns) : null;
    const normalizedInterval = normalizeIntervalSchedule(normalizeIntervalUnit(intervalUnit), parseInt(intervalValue) || 1);
    const unitVal = normalizedInterval.value;
    const intervalUnitValue = normalizedInterval.unit;
    const executionDayInt = executionDay ? parseInt(executionDay) : null;
    let secondaryExecutionDayInt = parseSecondaryExecutionDay(intervalUnitValue, secondaryExecutionDay);
    if (unitVal !== 1) secondaryExecutionDayInt = null;
    if (
      secondaryExecutionDayInt != null &&
      executionDayInt != null &&
      secondaryExecutionDayInt === executionDayInt
    ) {
      secondaryExecutionDayInt = null;
    }
    const parsedStartDate = parseDateOnlyUtc(startDate);
    if (!parsedStartDate) {
      return NextResponse.json({ ok: false, code: "INVALID_START_DATE", error: "开始日期不正确" }, { status: 400 });
    }
    const parsedEndDate = endDate ? parseDateOnlyUtc(endDate) : null;
    if (endDate && !parsedEndDate) {
      return NextResponse.json({ ok: false, code: "INVALID_END_DATE", error: "Invalid endDate" }, { status: 400 });
    }
    const start = isFundTask ? skipWeekend(parsedStartDate) : parsedStartDate;
    const initialRunDate = calcInitialRunDate(parsedStartDate, intervalUnitValue, unitVal, executionDayInt, isFundTask, secondaryExecutionDayInt);

    const safeConfirmDays = confirmDays != null ? normalizeNonNegativeDays(confirmDays, 0) : null;
    const safeArrivalDays = arrivalDays != null ? normalizeNonNegativeDays(arrivalDays, 2) : null;

    const createdPlan = await prisma.$transaction(async (tx) => {
      const plan = await tx.regularInvestPlan.create({
        data: {
          householdId,
          accountId: effectiveAccountId,
          accountName: effectiveAccountName || targetAcc.name,
          cashAccountId: cashAccountId || null,
          cashAccountName: cashAcc?.name || null,
          fundCode: isFundTask ? fundCode : scheduledTaskType,
          fundName: taskTitle,
          planName: cleanOptionalString(planName) ?? taskTitle,
          taskType: scheduledTaskType,
          targetName: taskTitle,
          insuranceProductName: isInsuranceTask ? insuranceProductName ?? taskTitle : null,
          fundProductType: isFundTask ? (fundProductType || targetAcc.investProductType || null) : null,
          amount: amountNum,
          intervalUnit: intervalUnitValue,
          intervalValue: unitVal,
          executionDay: executionDayInt,
          secondaryExecutionDay: secondaryExecutionDayInt,
          startDate: start,
          endDate: parsedEndDate,
          totalRuns: totalRunsInt,
          executedRuns: 0,
          nextRunDate: initialRunDate,
          status: RegularInvestStatus.active,
          feeRate: feeRate != null ? parseFloat(feeRate) : null,
          confirmDays: safeConfirmDays,
          arrivalDays: safeArrivalDays,
          memo: encodeScheduledTaskMemo({
            type: scheduledTaskType,
            title: taskTitle,
            fromAccountId: cashAccountId || null,
            toAccountId: effectiveAccountId,
            categoryId: isOrdinaryTask ? taskCategoryId : null,
            categoryName: isOrdinaryTask ? taskCategoryName : null,
            insuranceProductId: insuranceProductId || null,
            note: isOrdinaryTask ? taskNote : null,
            annualRate: isLoanTask ? loanAnnualRate : null,
            repaymentMethod: isLoanTask ? loanRepaymentMethod : null,
            repaymentIntervalMonths: isLoanTask ? loanRepaymentIntervalMonths : null,
            loanPlanRole: isLoanTask ? "auto_debit" : null,
          }),
          skipPendingPreceding: isFundTask ? skipPendingPreceding !== false : false,
        },
      });

      // Update the confirm days table
      const newDays = safeConfirmDays ?? 0;
      if (isFundTask && effectiveAccountId && fundCode) {
        await setFundConfirmDaysInTx(tx, effectiveAccountId, fundCode, newDays);
      }

      // Update the fee rate table
      const newRate = feeRate != null ? parseFloat(feeRate) : 0;
      if (isFundTask && effectiveAccountId && fundCode) {
        await setFundFeeRateInTx(tx, effectiveAccountId, fundCode, newRate);
      }

      // Update the arrival days table
      const newArrivalDays = safeArrivalDays ?? 2;
      if (isFundTask && effectiveAccountId && fundCode) {
        await setFundArrivalDaysInTx(tx, effectiveAccountId, fundCode, newArrivalDays);
      }

      // Do not pre-generate transaction entries; wait for the "batch generate" button
      return plan;
    });

    // Client-side handles page refresh, but return the created row so the current
    // list can show it immediately even before the server component refresh lands.
    return NextResponse.json({
      ok: true,
      message: "计划任务已创建，请点击执行按钮生成到期交易明细",
      plan: {
        ...createdPlan,
        taskType: scheduledTaskType,
        taskTypeLabel: scheduledTaskTypeLabel(scheduledTaskType),
        planName: createdPlan.planName ?? null,
        taskTitle,
        taskFromAccountId: cashAccountId || null,
        taskToAccountId: effectiveAccountId,
        taskCategoryId: isOrdinaryTask ? taskCategoryId : null,
        taskCategoryName: isOrdinaryTask ? taskCategoryName : null,
        taskInsuranceProductId: insuranceProductId || null,
        taskNote: isOrdinaryTask ? taskNote : null,
        taskAnnualRate: isLoanTask ? loanAnnualRate : null,
        taskRepaymentMethod: isLoanTask ? loanRepaymentMethod : null,
        taskRepaymentIntervalMonths: isLoanTask ? loanRepaymentIntervalMonths : null,
        secondaryExecutionDay: createdPlan.secondaryExecutionDay,
        amount: Number(createdPlan.amount),
        feeRate: createdPlan.feeRate == null ? null : Number(createdPlan.feeRate),
        startDate: createdPlan.startDate?.toISOString() ?? null,
        endDate: createdPlan.endDate?.toISOString() ?? null,
        nextRunDate: createdPlan.nextRunDate?.toISOString() ?? null,
        lastRunDate: createdPlan.lastRunDate?.toISOString() ?? null,
        createdAt: createdPlan.createdAt?.toISOString() ?? null,
        updatedAt: createdPlan.updatedAt?.toISOString() ?? null,
        executedCount: 0,
        executedAmount: 0,
        confirmedCount: 0,
        confirmedAmount: 0,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "CREATE_FAILED", error: e instanceof Error ? e.message : "创建失败" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();

    const body = await req.json();
    const hasSecondaryExecutionDay = Object.prototype.hasOwnProperty.call(body, "secondaryExecutionDay");
    const {
      id,
      action,
      taskType,
      insuranceProductId,
      fundCode,
      fundName,
      planName,
      accountId,
      amount,
      intervalUnit,
      intervalValue,
      startDate,
      nextRunDate,
      endDate,
      totalRuns,
      executionDay,
      secondaryExecutionDay,
      feeRate,
      confirmDays,
      arrivalDays,
      cashAccountId,
      memo,
      annualRate,
      repaymentMethod,
      repaymentIntervalMonths,
      categoryId,
      categoryName,
      note,
      skipPendingPreceding,
    } = body;

    if (!id) return NextResponse.json({ ok: false, code: "MISSING_PLAN_ID", error: "缺少 id" }, { status: 400 });

    const existing = await prisma.regularInvestPlan.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ ok: false, code: "PLAN_NOT_FOUND", error: "计划不存在" }, { status: 404 });
    if (existing.householdId && existing.householdId !== householdId) return NextResponse.json({ ok: false, code: "PLAN_NOT_IN_HOUSEHOLD", error: "计划不属于当前账簿" }, { status: 403 });
    const existingTaskForAction = decodeScheduledTaskMemo(existing.memo);
    const actionUsesBusinessDays = existingTaskForAction.type === "fund_regular_invest";

    // Mortgage bills ("bill" loan plans) are read-only here: the bill schedule
    // and the rate (PBOC/LPR driven) are derived from the loan and managed
    // through the loan flows, not this endpoint. Auto-debit transfer plans
    // stay user-editable below.
    if (existingTaskForAction.type === "loan_repayment" && getLoanScheduledPlanRole(existingTaskForAction) === "bill") {
      return NextResponse.json({ ok: false, code: "SYSTEM_MANAGED_PLAN", error: "房贷账单由系统生成（利率由人行/LPR调整），不可作为计划任务修改" }, { status: 403 });
    }

    // Status actions
    if (action === "pause") {
      if (existing.status !== RegularInvestStatus.active) {
        return NextResponse.json({ ok: false, code: "PLAN_NOT_ACTIVE", error: "只有活跃状态的计划才能暂停" }, { status: 400 });
      }
      const plan = await prisma.regularInvestPlan.update({
        where: { id },
        data: { status: RegularInvestStatus.paused },
      });
      // Client-side handles page refresh
      return NextResponse.json({ ok: true, plan, message: "计划任务已暂停" });
    }

    if (action === "resume") {
      if (existing.status !== RegularInvestStatus.paused) {
        return NextResponse.json({ ok: false, code: "PLAN_NOT_PAUSED", error: "只有暂停状态的计划才能恢复" }, { status: 400 });
      }
      // Resume from the current period; do not backfill runs missed while paused.
      const nextRunDate = calcResumedRunDate(
        existing.nextRunDate,
        new Date(),
        existing.intervalUnit,
        existing.intervalValue,
        existing.executionDay,
        actionUsesBusinessDays,
        existing.secondaryExecutionDay,
      );

      const plan = await prisma.regularInvestPlan.update({
        where: { id },
        data: {
          status: RegularInvestStatus.active,
          nextRunDate,
        },
      });
      // Client-side handles page refresh
      return NextResponse.json({ ok: true, plan, message: "计划任务已恢复" });
    }

    if (action === "stop") {
      if (existing.status === RegularInvestStatus.stopped || existing.status === RegularInvestStatus.completed) {
        return NextResponse.json({ ok: false, code: "PLAN_ALREADY_STOPPED", error: "计划已终止或已完成" }, { status: 400 });
      }
      const plan = await prisma.regularInvestPlan.update({
        where: { id },
        data: { status: RegularInvestStatus.stopped },
      });
      // Client-side handles page refresh
      return NextResponse.json({ ok: true, plan, message: "计划任务已终止" });
    }

    // Regular update
    const updateData: any = {};
    const hasPlanName = Object.prototype.hasOwnProperty.call(body, "planName");
    const existingTask = decodeScheduledTaskMemo(existing.memo);
    const existingTaskType = normalizeScheduledTaskType(existing.taskType ?? existingTask.type);
    const nextTaskType = normalizeScheduledTaskType(taskType || existingTaskType);
    if (existingTaskType === "loan_repayment" && amount != null) {
      const requestedAmount = parseOptionalNonNegativeNumber(amount);
      const currentAmount = Number(existing.amount ?? 0);
      if (requestedAmount == null || Math.abs(requestedAmount - currentAmount) > 0.001) {
        return NextResponse.json({ ok: false, code: "LOAN_REPAYMENT_AMOUNT_LOCKED", error: "Loan repayment amount is generated by the repayment schedule and cannot be changed." }, { status: 403 });
      }
    }
    const isFundTask = nextTaskType === "fund_regular_invest";
    const isInsuranceTask = nextTaskType === "insurance_premium";
    const isLoanTask = nextTaskType === "loan_repayment";
    const isOrdinaryTask = nextTaskType === "income" || nextTaskType === "expense";
    const nextRepaymentMethod =
      repaymentMethod !== undefined && String(repaymentMethod).trim()
        ? normalizeLoanRepaymentMethod(String(repaymentMethod))
        : normalizeLoanRepaymentMethod(existingTask.repaymentMethod);
    const parsedNextAnnualRate =
      annualRate !== undefined ? parseOptionalNonNegativeNumber(annualRate) : existingTask.annualRate ?? null;
    const nextAnnualRate = parsedNextAnnualRate ?? (isLoanTask && allowsZeroAnnualRateRepaymentMethod(nextRepaymentMethod) ? 0 : null);
    const nextRepaymentIntervalMonths =
      repaymentIntervalMonths !== undefined ? parsePositiveInteger(repaymentIntervalMonths, 1) : existingTask.repaymentIntervalMonths ?? 1;
    const nextCategoryId = categoryId !== undefined ? cleanOptionalString(categoryId) : existingTask.categoryId ?? null;
    const nextCategoryName = categoryName !== undefined ? cleanOptionalString(categoryName) : existingTask.categoryName ?? null;
    const nextNote = note !== undefined ? cleanOptionalString(note) : existingTask.note ?? null;
    const requiresCashAccount = nextTaskType === "transfer" || nextTaskType === "loan_repayment" || nextTaskType === "insurance_premium";
    const effectiveAccountIdForValidation = accountId || existing.accountId;
    const effectiveCashAccountIdForValidation =
      cashAccountId != null ? cashAccountId || null : existing.cashAccountId;
    if (requiresCashAccount && !effectiveCashAccountIdForValidation) {
      return NextResponse.json({ ok: false, code: "CASH_ACCOUNT_REQUIRED", error: "请选择资金账户" }, { status: 400 });
    }
    if (nextTaskType === "transfer" && effectiveCashAccountIdForValidation === effectiveAccountIdForValidation) {
      return NextResponse.json({ ok: false, code: "SAME_TRANSFER_ACCOUNTS", error: "转出/转入账户不能相同" }, { status: 400 });
    }

    if (accountId != null) {
      updateData.accountId = accountId;
      const fundAcc = await prisma.account.findUnique({ where: { id: accountId }, select: { name: true } });
      updateData.accountName = fundAcc?.name || null;
    }
    let nextInsuranceProductName: string | null = existing.insuranceProductName ?? null;
    const effectiveInsuranceProductId = insuranceProductId || existingTask.insuranceProductId || null;
    if (isInsuranceTask && effectiveInsuranceProductId) {
      const product = await prisma.insuranceProduct.findFirst({
        where: { id: effectiveInsuranceProductId, householdId },
        select: { name: true },
      });
      nextInsuranceProductName = product?.name ?? nextInsuranceProductName;
    }
    const parsedStartDate = startDate != null ? parseDateOnlyUtc(startDate) : null;
    if (startDate != null && !parsedStartDate) {
      return NextResponse.json({ ok: false, code: "INVALID_START_DATE", error: "开始日期不正确" }, { status: 400 });
    }
    const parsedNextRunDate = nextRunDate != null ? parseDateOnlyUtc(nextRunDate) : null;
    if (nextRunDate != null && !parsedNextRunDate) {
      return NextResponse.json({ ok: false, code: "INVALID_NEXT_RUN_DATE", error: "下次执行日期不正确" }, { status: 400 });
    }
    const parsedEndDate = endDate ? parseDateOnlyUtc(endDate) : null;
    if (endDate && !parsedEndDate) {
      return NextResponse.json({ ok: false, code: "INVALID_END_DATE", error: "Invalid endDate" }, { status: 400 });
    }
    const rawEffectiveIntervalUnit = normalizeIntervalUnit(intervalUnit || existing.intervalUnit);
    const rawEffectiveIntervalValue = intervalValue != null ? parseInt(intervalValue) || 1 : existing.intervalValue;
    const normalizedEffectiveInterval = normalizeIntervalSchedule(rawEffectiveIntervalUnit, rawEffectiveIntervalValue);
    const effectiveIntervalUnit = normalizedEffectiveInterval.unit;
    const effectiveIntervalValue = normalizedEffectiveInterval.value;
    const effectiveExecutionDay = executionDay != null
      ? (executionDay ? parseInt(executionDay) : null)
      : existing.executionDay;
    const effectiveSecondaryExecutionDay = parseSecondaryExecutionDay(
      effectiveIntervalUnit,
      hasSecondaryExecutionDay ? secondaryExecutionDay : undefined,
      hasSecondaryExecutionDay ? undefined : existing.secondaryExecutionDay,
    );
    const normalizedSecondaryExecutionDay = effectiveIntervalValue === 1 ? effectiveSecondaryExecutionDay : null;
    const nextStoredStartDate = parsedStartDate
      ? isFundTask ? skipWeekend(parsedStartDate) : parsedStartDate
      : existing.startDate;
    if (parsedNextRunDate && parsedNextRunDate < nextStoredStartDate) {
      return NextResponse.json({ ok: false, code: "NEXT_RUN_DATE_BEFORE_START_DATE", error: "Next run date cannot be earlier than the effective date." }, { status: 400 });
    }
    const startDateChanged = parsedStartDate != null && !sameDateOnly(nextStoredStartDate, existing.startDate);
    const taskTypeChanged = nextTaskType !== existingTaskType;
    const normalizedExistingExecutionDay = existing.executionDay;
    const normalizedExistingSecondaryExecutionDay =
      effectiveIntervalUnit === existing.intervalUnit
        ? existing.secondaryExecutionDay
        : null;
    const scheduleChanged =
      startDateChanged ||
      taskTypeChanged ||
      effectiveIntervalUnit !== existing.intervalUnit ||
      effectiveIntervalValue !== existing.intervalValue ||
      effectiveExecutionDay !== normalizedExistingExecutionDay ||
      normalizedSecondaryExecutionDay !== normalizedExistingSecondaryExecutionDay;
    let linkedRecordCount: number | null = null;
    const getLinkedRecordCount = async () => {
      if (linkedRecordCount == null) {
        linkedRecordCount = await prisma.txRecord.count({ where: { regularInvestPlanId: existing.id, deletedAt: null } });
      }
      return linkedRecordCount;
    };
    const hasGeneratedRecords = (existing.executedRuns ?? 0) > 0 || !!existing.lastRunDate;
    if (startDateChanged && hasGeneratedRecords) {
      return NextResponse.json({ ok: false, code: "START_DATE_LOCKED_AFTER_RECORDS", error: "该计划已生成记录，不能修改起始日期。后续执行会自动从最后一笔生成记录后的下一个周期继续；如需调整范围，请修改停止日期、频率或总次数。" }, { status: 400 });
    }
    if (taskTypeChanged && hasGeneratedRecords) {
      return NextResponse.json({ ok: false, code: "TASK_TYPE_LOCKED_AFTER_RECORDS", error: "该计划已生成记录，不能修改任务类型。请新建计划处理不同类型的后续任务。" }, { status: 400 });
    }
    if (startDateChanged) {
      if (await getLinkedRecordCount() > 0) {
        return NextResponse.json({ ok: false, code: "START_DATE_LOCKED_AFTER_RECORDS", error: "该计划已生成记录，不能修改起始日期。后续执行会自动从最后一笔生成记录后的下一个周期继续；如需调整范围，请修改停止日期、频率或总次数。" }, { status: 400 });
      }
    }
    if (taskTypeChanged && await getLinkedRecordCount() > 0) {
      return NextResponse.json({ ok: false, code: "TASK_TYPE_LOCKED_AFTER_RECORDS", error: "该计划已生成记录，不能修改任务类型。请新建计划处理不同类型的后续任务。" }, { status: 400 });
    }

    if (parsedStartDate) updateData.startDate = nextStoredStartDate;
    const effectiveFundCode = isFundTask ? cleanOptionalString(fundCode) ?? existing.fundCode : nextTaskType;
    if (fundCode != null && isFundTask) updateData.fundCode = effectiveFundCode;
    const suppliedFundName = fundName != null ? cleanOptionalString(fundName) : null;
    const profileUpdateFundName = isFundTask
      ? await resolveFundName(effectiveFundCode, { householdId })
      : null;
    const normalizedSuppliedFundName = isFundTask
      ? normalizeFundDisplayName(effectiveFundCode, suppliedFundName)
      : suppliedFundName;
    const normalizedExistingFundName = isFundTask
      ? normalizeFundDisplayName(effectiveFundCode, existing.fundName)
      : existing.fundName;
    const fundDisplayName = isFundTask ? profileUpdateFundName ?? normalizedSuppliedFundName ?? normalizedExistingFundName ?? effectiveFundCode : null;
    if (isFundTask) updateData.fundName = fundDisplayName;
    else if (fundName != null && suppliedFundName) updateData.fundName = suppliedFundName;
    updateData.taskType = nextTaskType;
    updateData.targetName =
      isInsuranceTask
        ? nextInsuranceProductName ?? suppliedFundName ?? existing.targetName ?? existing.fundName ?? scheduledTaskTypeLabel(nextTaskType)
        : isOrdinaryTask
          ? suppliedFundName ?? nextCategoryName ?? existing.targetName ?? existing.fundName ?? scheduledTaskTypeLabel(nextTaskType)
          : fundDisplayName ?? scheduledTaskTypeLabel(nextTaskType);
    updateData.insuranceProductName = isInsuranceTask ? nextInsuranceProductName ?? updateData.targetName : null;
    if (amount != null) updateData.amount = parseFloat(amount);
    if (intervalUnit != null || intervalValue != null) {
      updateData.intervalUnit = effectiveIntervalUnit;
      updateData.intervalValue = effectiveIntervalValue;
    }
    if (executionDay != null) updateData.executionDay = executionDay ? parseInt(executionDay) : null; // Execution day update
    if (hasSecondaryExecutionDay) {
      updateData.secondaryExecutionDay = normalizedSecondaryExecutionDay;
    } else if (intervalUnit != null && effectiveIntervalUnit !== existing.intervalUnit) {
      updateData.secondaryExecutionDay = null;
    }
    if (scheduleChanged) {
      updateData.nextRunDate = await deriveRegularInvestNextRunDate(prisma, {
        id: existing.id,
        householdId,
        taskType: nextTaskType,
        startDate: nextStoredStartDate,
        lastRunDate: existing.lastRunDate,
        intervalUnit: effectiveIntervalUnit,
        intervalValue: effectiveIntervalValue,
        executionDay: effectiveExecutionDay,
        secondaryExecutionDay: updateData.secondaryExecutionDay ?? normalizedSecondaryExecutionDay,
      });
    }
    if (parsedNextRunDate) {
      updateData.nextRunDate = parsedNextRunDate;
    }
    if (endDate != null) updateData.endDate = parsedEndDate;
    if (totalRuns != null) updateData.totalRuns = totalRuns ? parseInt(totalRuns) : null;
    if (feeRate != null) updateData.feeRate = parseFloat(feeRate);
    if (confirmDays != null) updateData.confirmDays = normalizeNonNegativeDays(confirmDays, 0);
    if (arrivalDays != null) updateData.arrivalDays = normalizeNonNegativeDays(arrivalDays, 2);
    if (cashAccountId != null) {
      updateData.cashAccountId = cashAccountId || null;
      // Update the cash account name
      if (cashAccountId) {
        const cashAcc = await prisma.account.findUnique({ where: { id: cashAccountId }, select: { name: true } });
        updateData.cashAccountName = cashAcc?.name || null;
      } else {
        updateData.cashAccountName = null;
      }
    } else if (isOrdinaryTask) {
      updateData.cashAccountId = null;
      updateData.cashAccountName = null;
    }
    if (memo != null) updateData.memo = memo || null;
    if (hasPlanName) updateData.planName = cleanOptionalString(planName);
    if (skipPendingPreceding !== undefined) (updateData as any).skipPendingPreceding = skipPendingPreceding;
    updateData.memo = encodeScheduledTaskMemo({
      type: nextTaskType,
      title: updateData.targetName,
      fromAccountId: isOrdinaryTask ? null : cashAccountId != null ? cashAccountId || null : existing.cashAccountId,
      toAccountId: accountId || existing.accountId,
      categoryId: isOrdinaryTask ? nextCategoryId : null,
      categoryName: isOrdinaryTask ? nextCategoryName : null,
      insuranceProductId: effectiveInsuranceProductId,
      note: isOrdinaryTask ? nextNote : null,
      annualRate: isLoanTask ? nextAnnualRate : null,
      repaymentMethod: isLoanTask ? nextRepaymentMethod : null,
      repaymentIntervalMonths: isLoanTask ? nextRepaymentIntervalMonths : null,
      loanPlanRole: isLoanTask ? getLoanScheduledPlanRole(existingTask) ?? "auto_debit" : null,
    });
    if (!isFundTask) {
      updateData.fundCode = nextTaskType;
      updateData.fundName = updateData.targetName;
      updateData.fundProductType = null;
      updateData.confirmDays = 0;
      updateData.arrivalDays = 0;
      updateData.feeRate = 0;
      updateData.skipPendingPreceding = false;
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
        fromAccountId: updateData.cashAccountId !== undefined ? updateData.cashAccountId : existing.cashAccountId,
        toAccountId: existing.accountId,
      });
      const plan = await prisma.regularInvestPlan.update({
        where: { id },
        data: loanUpdateData,
      });
      return NextResponse.json({ ok: true, plan });
    }

    const plan = await prisma.regularInvestPlan.update({
      where: { id },
      data: updateData,
    });

    // Sync confirm days and fee rate to the unified store
    const effectiveAccountId = accountId || existing.accountId;
    const effectiveRuleFundCode = effectiveFundCode;
    if (isFundTask && confirmDays != null && effectiveAccountId && effectiveRuleFundCode) {
      await setFundConfirmDays(effectiveAccountId, effectiveRuleFundCode, normalizeNonNegativeDays(confirmDays, 0));
    }
    if (isFundTask && arrivalDays != null && effectiveAccountId && effectiveRuleFundCode) {
      await setFundArrivalDays(effectiveAccountId, effectiveRuleFundCode, normalizeNonNegativeDays(arrivalDays, 2));
    }
    if (isFundTask && feeRate != null && effectiveAccountId && effectiveRuleFundCode) {
      await setFundFeeRate(effectiveAccountId, effectiveRuleFundCode, parseFloat(feeRate));
    }

    // Client-side handles page refresh
    return NextResponse.json({ ok: true, plan });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "UPDATE_FAILED", error: e instanceof Error ? e.message : "更新失败" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();

    const { searchParams } = req.nextUrl;
    const id = searchParams.get("id");
    const deleteMode = searchParams.get("deleteRecords") ?? "0";
    const deleteEntries = deleteMode === "1";
    const deleteRecordsOnly = deleteMode === "records";

    if (!id) return NextResponse.json({ ok: false, code: "MISSING_PLAN_ID", error: "缺少 id" }, { status: 400 });

    const plan = await prisma.regularInvestPlan.findUnique({ where: { id } });
    if (!plan) return NextResponse.json({ ok: false, code: "PLAN_NOT_FOUND", error: "计划不存在" }, { status: 404 });
    if (plan.householdId && plan.householdId !== householdId) return NextResponse.json({ ok: false, code: "PLAN_NOT_IN_HOUSEHOLD", error: "计划不属于当前账簿" }, { status: 403 });

    // System-level plans (loan repayment) cannot be deleted manually.
    if (decodeScheduledTaskMemo(plan.memo).type === "loan_repayment") {
      return NextResponse.json({ ok: false, code: "SYSTEM_MANAGED_PLAN", error: "贷款还款计划由系统管理，不可手动删除" }, { status: 403 });
    }

    // Delete only transaction records, keep the plan, and reset it to the un-executed state
    if (deleteRecordsOnly) {
      const affectedRecords = await prisma.txRecord.findMany({
        where: { regularInvestPlanId: id, householdId },
        select: { accountId: true, toAccountId: true },
      });
      const task = decodeScheduledTaskMemo(plan.memo);
      const resetNextRunDate = calcInitialRunDate(
        plan.startDate,
        plan.intervalUnit,
        plan.intervalValue,
        plan.executionDay,
        task.type === "fund_regular_invest",
      );
      const resetPlan = await prisma.$transaction(async (tx) => {
        await tx.txRecord.deleteMany({ where: { regularInvestPlanId: id, householdId } });
        return tx.regularInvestPlan.update({
          where: { id },
          data: {
            status: RegularInvestStatus.active,
            executedRuns: 0,
            lastRunDate: null,
            nextRunDate: resetNextRunDate,
          },
          select: {
            id: true,
            status: true,
            executedRuns: true,
            lastRunDate: true,
            nextRunDate: true,
          },
        });
      });

      const accountsToRecalc = new Set<string>();
      accountsToRecalc.add(plan.accountId);
      if (plan.cashAccountId) accountsToRecalc.add(plan.cashAccountId);
      for (const r of affectedRecords) {
        if (r.accountId) accountsToRecalc.add(r.accountId);
        if (r.toAccountId) accountsToRecalc.add(r.toAccountId);
      }
      if (plan.accountId && plan.fundCode) {
        await recalcFundPositions(plan.accountId, [plan.fundCode]).catch(() => {});
      }
      for (const acctId of accountsToRecalc) {
        if (acctId) await recalcAndSaveAccountBalance(acctId).catch(() => {});
      }
      if (task.type === "fund_regular_invest" || task.type === "insurance_premium") revalidateAfterInvestChange();
      else revalidateAfterTxChange();
      // Client-side handles page refresh
      return NextResponse.json({
        ok: true,
        deletedEntries: true,
        reset: true,
        plan: {
          ...resetPlan,
          lastRunDate: resetPlan.lastRunDate?.toISOString() ?? null,
          nextRunDate: resetPlan.nextRunDate.toISOString(),
        },
      });
    }

    // If deleting entries, first collect the involved account IDs (records are deleted inside the transaction)
    const affectedRecords = deleteEntries
      ? await prisma.txRecord.findMany({
          where: { regularInvestPlanId: id },
          select: { accountId: true, toAccountId: true },
        })
      : [];
    const accountsToRecalc = new Set<string>();
    accountsToRecalc.add(plan.accountId);
    if (plan.cashAccountId) accountsToRecalc.add(plan.cashAccountId);
    for (const r of affectedRecords) {
      if (r.accountId) accountsToRecalc.add(r.accountId);
      if (r.toAccountId) accountsToRecalc.add(r.toAccountId);
    }

    // If deleting linked transaction entries is requested
    if (deleteEntries) {
      await prisma.$transaction(async (tx) => {
        // First delete linked TxRecords
        await tx.txRecord.deleteMany({
          where: { regularInvestPlanId: id },
        });
        // Then delete the regular invest plan
        await tx.regularInvestPlan.delete({ where: { id } });
      });
    } else {
      // Delete only the plan and keep transaction entries (clearing the link)
      await prisma.$transaction(async (tx) => {
        // Clear the linked fields on transaction entries
        await tx.txRecord.updateMany({
          where: { regularInvestPlanId: id },
          data: { regularInvestPlanId: null },
        });
        // Delete the regular invest plan
        await tx.regularInvestPlan.delete({ where: { id } });
      });
    }

    if (plan.accountId && plan.fundCode) {
      await recalcFundPositions(plan.accountId, [plan.fundCode]).catch(() => {});
    }

    // Refresh involved account balances
    for (const acctId of accountsToRecalc) {
      if (acctId) await recalcAndSaveAccountBalance(acctId).catch(() => {});
    }
    const task = decodeScheduledTaskMemo(plan.memo);
    if (deleteEntries) {
      if (task.type === "fund_regular_invest" || task.type === "insurance_premium") revalidateAfterInvestChange();
      else revalidateAfterTxChange();
    }

    // Client-side handles page refresh
    return NextResponse.json({ ok: true, deletedEntries: deleteEntries });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "DELETE_FAILED", error: e instanceof Error ? e.message : "删除失败" }, { status: 500 });
  }
}
