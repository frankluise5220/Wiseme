import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { FundCashFlowKind, FundSubtype, IntervalUnit, RegularInvestStatus } from "@prisma/client";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { getFundConfirmDays, getFundArrivalDays, normalizeNonNegativeDays } from "@/lib/fund/confirmDays";
import { getFundFeeRate, getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { normalizeFundDisplayName, resolveFundName } from "@/lib/fund/fundProfile";
import { createFundTransactionWithCashFlows } from "@/lib/fund/transactions";
import { getFundNavFromCacheOnly } from "@/lib/fund/navCache";
import { normalizeFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import {
  REGULAR_INVEST_CATEGORY_NAME,
  regularInvestBuyNote,
  regularInvestFailureNote,
  regularInvestRefundNote,
} from "@/lib/fund/regular-invest-display";
import { addWorkdaysUtc, formatDateUtc } from "@/lib/date-utils";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { decodeScheduledTaskMemo } from "@/lib/scheduled-task";
import { calcInitialScheduledRunDate, calcNextScheduledRunDate, skipWeekend } from "@/lib/scheduled-task-date";
import { executeNonFundScheduledTaskPlan, isNonFundScheduledTask } from "@/lib/server/scheduled-task-executor";
import { resolveCategorySnapshot } from "@/lib/default-categories";
import { ENTRY_ORIGIN_SCHEDULED_TASK } from "@/lib/transaction-semantics";
import { acquireScheduledTaskPlanLock } from "@/lib/server/scheduled-task-lock";

function utcDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function calcNextRunDate(
  fromDate: Date,
  intervalUnit: string,
  intervalValue: number,
  executionDay?: number | null,
  secondaryExecutionDay?: number | null,
): Date {
  return calcNextScheduledRunDate(
    fromDate,
    intervalUnit as IntervalUnit,
    intervalValue,
    executionDay,
    true,
    secondaryExecutionDay,
  );
}

const BATCH_EXECUTE_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 60_000,
};

/**
 * Batch-executes a regular investment plan: generates all due transaction
 * records from the start date up to now.
 * POST /api/v1/regular-invest/batch-execute
 * Body: { planId: string }
 *
 * Duplicate-prevention:
 * 1. Query all TxRecords already generated for this plan (by regularInvestPlanId)
 * 2. Collect their application dates
 * 3. Build the set of existing dates
 * 4. Generate only the missing records
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();

    const body = await req.json();
    const { planId } = body;

    if (!planId) {
      return NextResponse.json({ ok: false, code: "MISSING_PLAN_ID", error: "缺少 planId" }, { status: 400 });
    }

    const plan = await prisma.regularInvestPlan.findUnique({
      where: { id: planId },
    });

    if (!plan) {
      return NextResponse.json({ ok: false, code: "PLAN_NOT_FOUND", error: "计划不存在" }, { status: 404 });
    }

    if (plan.householdId && plan.householdId !== householdId) {
      return NextResponse.json({ ok: false, code: "PLAN_NOT_IN_HOUSEHOLD", error: "计划不属于当前账簿" }, { status: 403 });
    }

    if (plan.status !== RegularInvestStatus.active) {
      // Allow a completed-but-never-executed plan to backfill records
      if (plan.status === RegularInvestStatus.completed && plan.executedRuns === 0) {
        // Temporarily restore to active so records can be generated
        await prisma.regularInvestPlan.update({
          where: { id: planId },
          data: { status: RegularInvestStatus.active },
        });
      } else {
        return NextResponse.json({
          ok: false,
          code: "PLAN_NOT_ACTIVE",
          error: `计划状态为 ${plan.status}，只有 active 状态才能执行`,
        }, { status: 400 });
      }
    }

    const now = new Date();
    // Even when endDate has passed, allow generating historical records
    // (startDate → endDate), marking the plan completed afterwards.
    // Do not reject early, avoiding "completed but no records" cases.

    if (plan.totalRuns && plan.executedRuns >= plan.totalRuns) {
      await prisma.regularInvestPlan.update({
        where: { id: planId },
        data: { status: RegularInvestStatus.completed },
      });
      return NextResponse.json({ ok: false, code: "PLAN_RUN_LIMIT_REACHED", error: "计划已达到执行次数，自动标记为已完成" }, { status: 400 });
    }

    const scheduledTask = decodeScheduledTaskMemo(plan.memo);
    if (isNonFundScheduledTask(scheduledTask.type)) {
      const result = await executeNonFundScheduledTaskPlan({
        householdId,
        plan,
        task: scheduledTask,
        now,
      });
      return NextResponse.json({
        ok: true,
        message: result.message,
        executedCount: result.generatedCount,
        completed: result.completed,
        stats: result.stats,
      });
    }

    const fundAcc = await prisma.account.findUnique({ where: { id: plan.accountId } });
    if (!fundAcc) {
      return NextResponse.json({ ok: false, code: "FUND_ACCOUNT_NOT_FOUND", error: "基金账户不存在" }, { status: 400 });
    }
    const fundUnitsDecimals = normalizeFundUnitsDecimals(fundAcc.fundUnitsDecimals);

    const cashAcc = plan.cashAccountId
      ? await prisma.account.findUnique({ where: { id: plan.cashAccountId }, select: { id: true, name: true, currency: true } })
      : null;

    const amountNum = parseFloat(String(plan.amount));
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return NextResponse.json({ ok: false, code: "INVALID_AMOUNT", error: "金额不正确" }, { status: 400 });
    }

    // Duplicate-prevention: query all fund transactions already generated for this plan
    const existingFundTransactions = await prisma.fundTransaction.findMany({
      where: {
        regularInvestPlanId: planId,
        source: "regular_invest",
        deletedAt: null,
      },
      select: {
        id: true,
        applyDate: true,
      },
    });

    // Build the set of existing transaction dates
    const existingDates = new Set<string>();
    for (const tx of existingFundTransactions) {
      if (tx.applyDate) {
        const dateStr = formatDateUtc(tx.applyDate);
        existingDates.add(dateStr);
      }
    }

    // Start after the most recently executed date (no historical backfill)
    let currentDate: Date;
    if (existingFundTransactions.length > 0) {
      // Find the latest record date and start from the day after it
      const latestDate = existingFundTransactions.reduce((max, r) => (r.applyDate > max ? r.applyDate : max), new Date(0));
      currentDate = calcNextRunDate(
        latestDate,
        plan.intervalUnit,
        plan.intervalValue,
        plan.executionDay,
        plan.secondaryExecutionDay,
      );
    } else {
      currentDate = calcInitialScheduledRunDate(
        new Date(plan.startDate),
        plan.intervalUnit,
        plan.intervalValue,
        plan.executionDay,
        true,
        plan.secondaryExecutionDay,
      );
    }

    // Upper bound of the generation range: endDate (if already passed) or now, whichever is earlier
    const effectiveEndDate = plan.endDate && plan.endDate < now ? plan.endDate : now;

    // Collect all dates that should have run but have not yet
    const datesToExecute: Date[] = [];
    while (currentDate <= effectiveEndDate) {
      const dateStr = formatDateUtc(currentDate);
      if (!existingDates.has(dateStr)) {
        datesToExecute.push(new Date(currentDate));
      }
      currentDate = calcNextRunDate(
        currentDate,
        plan.intervalUnit,
        plan.intervalValue,
        plan.executionDay,
        plan.secondaryExecutionDay,
      );
    }

    if (datesToExecute.length === 0) {
      return NextResponse.json({
        ok: true,
        message: "所有到期的交易明细已存在，无需重复生成",
        executedCount: 0,
      });
    }

    // Cap the number of records generated this run (do not exceed the total run limit)
    const maxToExecute = plan.totalRuns ? plan.totalRuns - plan.executedRuns : datesToExecute.length;
    let datesToProcess = datesToExecute.slice(0, maxToExecute);
    let skippedCount = 0;

    // ── Pre-compute NAV: filter out paused purchases and no-NAV gaps ──
    const confirmDays = normalizeNonNegativeDays(plan.confirmDays ?? await getFundConfirmDays(plan.accountId, plan.fundCode), 0);
    const arrivalDays = normalizeNonNegativeDays(plan.arrivalDays ?? await getFundArrivalDays(plan.accountId, plan.fundCode), 2);
    const todayStr = formatDateUtc(now);
    const navResultMap = new Map<string, { hasNav: boolean; sgzt: string; confirmDateStr: string }>();
    for (const d of datesToProcess) {
      const ds = formatDateUtc(d);
      let confirmDateStr = addWorkdaysUtc(ds, confirmDays);
      if (confirmDateStr < ds) {
        logger.warn(`[pre-calc] confirmDate ${confirmDateStr} < runDate ${ds}, confirmDays=${confirmDays}`, "batch-execute");
        confirmDateStr = ds;
      }
      const foundNav = await getFundNavFromCacheOnly(plan.fundCode, utcDate(confirmDateStr));
      navResultMap.set(ds, {
        hasNav: foundNav != null && foundNav.nav != null && foundNav.nav > 0,
        sgzt: foundNav?.sgzt ?? "",
        confirmDateStr,
      });
    }

    const filtered: Date[] = [];
    const arr = datesToProcess;
    let skippedPaused = 0;
    let skippedGap = 0;
    for (let i = 0; i < arr.length; i++) {
      const ds = formatDateUtc(arr[i]!);
      const cur = navResultMap.get(ds);

      // skipPendingPreceding: skip paused purchases + historical no-NAV days (market holidays)
      if (plan.skipPendingPreceding !== false) {
        // Skip dates with suspended purchases (generate no records)
        if (cur && cur.sgzt === "暂停申购") {
          skippedPaused++;
          continue;
        }

        // No NAV on confirm date: if the confirm date has passed with no NAV → market holiday, skip
        // If the confirm date has not arrived or is today → NAV not yet published is normal, keep (nav=null filled later)
        const noNav = !cur || (!cur.hasNav && cur.sgzt !== "暂停申购");
        const confirmDateStr = cur?.confirmDateStr ?? addWorkdaysUtc(ds, confirmDays);
        if (noNav && confirmDateStr < todayStr) {
          skippedGap++;
          continue;
        }
      }
      filtered.push(arr[i]!);
    }
    skippedCount = skippedPaused + skippedGap;
    datesToProcess = filtered;

    const newRecordsCount = datesToProcess.length;

    if (newRecordsCount === 0) {
      return NextResponse.json({
        ok: true,
        message: `所有到期的交易明细已处理${skippedCount > 0 ? `（跳过 ${skippedCount} 个无净值间隙日期）` : ""}`,
        executedCount: 0,
        skippedCount,
      });
    }

    // NAV data is read from the cache (the frontend calls /api/v1/fund/preload-nav first to expand the NAV cache)
    const category = await resolveCategorySnapshot(prisma, householdId, {
      categoryName: REGULAR_INVEST_CATEGORY_NAME,
      type: "investment",
    });
    const fundDisplayName = await resolveFundName(plan.fundCode, { householdId })
      ?? normalizeFundDisplayName(plan.fundCode, plan.fundName)
      ?? plan.fundCode;
    const runsToCreate: Array<{
      runDate: Date;
      confirmDate: Date;
      arrivalDate: Date;
      sgzt: string;
      feeAmount: number | null;
      fundNav: number | null;
      fundUnits: number | null;
      note: string;
    }> = [];
    for (const runDate of datesToProcess) {
      const runDateStr = formatDateUtc(runDate);
      let confirmDateStr = navResultMap.get(runDateStr)?.confirmDateStr ?? addWorkdaysUtc(runDateStr, confirmDays);
      if (confirmDateStr < runDateStr) {
        logger.warn(`[create] confirmDate ${confirmDateStr} < runDate ${runDateStr}, confirmDays=${confirmDays}`, "batch-execute");
        confirmDateStr = runDateStr;
      }
      const confirmDate = utcDate(confirmDateStr);
      const arrivalDateStr = arrivalDays > 0 ? addWorkdaysUtc(confirmDateStr, arrivalDays) : confirmDateStr;
      const arrivalDate = utcDate(arrivalDateStr);
      const foundNav = await getFundNavFromCacheOnly(plan.fundCode, confirmDate);
      const sgzt = foundNav?.sgzt ?? "";
      let feeRateRaw = await getFundFeeRateByDate(plan.accountId, plan.fundCode, runDate, "buy");
      if (feeRateRaw === 0) {
        feeRateRaw = await getFundFeeRate(plan.accountId, plan.fundCode, "buy");
      }
      const feeRate = feeRateRaw / 100;
      const feeAmount = feeRate > 0 ? amountNum * feeRate : null;
      const feeAmountNumber = feeAmount ?? 0;
      let fundNav: number | null = null;
      let fundUnits: number | null = null;

      if (foundNav && foundNav.nav > 0) {
        fundNav = foundNav.nav;
        fundUnits = calculateConfirmedBuyUnits({
          grossAmount: amountNum,
          refundAmount: 0,
          fee: feeAmountNumber,
          nav: foundNav.nav,
          roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
        });
      }

      let note = regularInvestBuyNote(plan.fundCode, fundDisplayName);
      if (sgzt && (sgzt.includes("限制") || sgzt.includes("限额"))) {
        note += `（${sgzt}，请确认定投金额是否超限）`;
      }

      runsToCreate.push({
        runDate,
        confirmDate,
        arrivalDate,
        sgzt,
        feeAmount,
        fundNav,
        fundUnits,
        note,
      });
    }

    let actualCreatedCount = 0;
    let skippedDuplicateAtCommit = 0;

    await prisma.$transaction(async (tx) => {
      await acquireScheduledTaskPlanLock(tx, planId);

      const existingAtCommit = await tx.fundTransaction.findMany({
        where: {
          regularInvestPlanId: planId,
          source: "regular_invest",
          deletedAt: null,
          applyDate: { in: runsToCreate.map((run) => run.runDate) },
        },
        select: { applyDate: true },
      });
      const existingDateSet = new Set(existingAtCommit.map((record) => formatDateUtc(record.applyDate)));
      const actualRunsToCreate = runsToCreate.filter((run) => !existingDateSet.has(formatDateUtc(run.runDate)));
      skippedDuplicateAtCommit = runsToCreate.length - actualRunsToCreate.length;
      if (actualRunsToCreate.length === 0) return;

      for (const run of actualRunsToCreate) {
        // Suspended purchase: create two records that net to 0
        // Record 1: regular invest (suspended) — cash account to fund account, amount -100
        // Record 2: regular invest (refund) — fund account to cash account, amount -100
        // Cash account view: record 1 is an outflow, record 2 is an inflow, netting to 0
        // Fund account view: both buy_failed records are skipped in position calculation and do not affect holdings
        if (run.sgzt === "暂停申购") {
          await createFundTransactionWithCashFlows(tx, {
            householdId,
            fundAccountId: fundAcc.id,
            cashAccountId: cashAcc?.id ?? null,
            fundCode: plan.fundCode,
            fundName: fundDisplayName,
            fundProductType: plan.fundProductType || fundAcc.investProductType,
            fundSubtype: FundSubtype.buy_failed,
            source: "regular_invest",
            entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
            applyDate: run.runDate,
            confirmDate: run.confirmDate,
            arrivalDate: run.arrivalDate,
            grossAmount: amountNum,
            refundAmount: amountNum,
            fee: null,
            nav: null,
            units: null,
            regularInvestPlanId: planId,
            note: regularInvestFailureNote(plan.fundCode, fundDisplayName, run.runDate),
            cashFlows: cashAcc ? [
              {
                kind: FundCashFlowKind.buy_out,
                date: run.runDate,
                accountId: cashAcc.id,
                accountName: cashAcc.name,
                amount: -amountNum,
                currency: cashAcc.currency ?? fundAcc.currency ?? "CNY",
                source: "regular_invest",
                regularInvestPlanId: planId,
                note: regularInvestFailureNote(plan.fundCode, fundDisplayName, run.runDate),
              },
              {
                kind: FundCashFlowKind.refund_in,
                date: run.arrivalDate,
                accountId: cashAcc.id,
                accountName: cashAcc.name,
                amount: amountNum,
                currency: cashAcc.currency ?? fundAcc.currency ?? "CNY",
                source: "regular_invest_refund",
                regularInvestPlanId: planId,
                note: regularInvestRefundNote(
                  plan.fundCode,
                  fundDisplayName,
                  amountNum,
                  run.runDate,
                  cashAcc.currency ?? fundAcc.currency ?? "CNY",
                ),
              },
            ] : [],
          });
          continue;
        }

        await createFundTransactionWithCashFlows(tx, {
          householdId,
          fundAccountId: fundAcc.id,
          cashAccountId: cashAcc?.id ?? null,
          fundCode: plan.fundCode,
          fundName: fundDisplayName,
          fundProductType: plan.fundProductType || fundAcc.investProductType,
          fundSubtype: FundSubtype.buy,
          source: "regular_invest",
          applyDate: run.runDate,
          confirmDate: run.confirmDate,
          arrivalDate: run.arrivalDate,
          grossAmount: amountNum,
          fee: run.feeAmount,
          nav: run.fundNav,
          units: run.fundUnits,
          regularInvestPlanId: planId,
          note: run.note,
          cashFlows: cashAcc ? [{
            kind: FundCashFlowKind.buy_out,
            date: run.runDate,
            accountId: cashAcc.id,
            accountName: cashAcc.name,
            amount: -amountNum,
            currency: cashAcc.currency ?? fundAcc.currency ?? "CNY",
            source: "regular_invest",
            categoryId: category?.id ?? null,
            categoryName: category?.name ?? REGULAR_INVEST_CATEGORY_NAME,
            regularInvestPlanId: planId,
            note: run.note,
          }] : [],
        });
      }

      // Update the regular investment plan status
      const finalExecutedRuns = plan.executedRuns + actualRunsToCreate.length;
      const finalLastRunDate = actualRunsToCreate[actualRunsToCreate.length - 1]!.runDate;
      const nextRunDate = calcNextRunDate(
        finalLastRunDate,
        plan.intervalUnit,
        plan.intervalValue,
        plan.executionDay,
        plan.secondaryExecutionDay,
      );

      const willComplete =
        (plan.totalRuns && finalExecutedRuns >= plan.totalRuns) ||
        (plan.endDate && plan.endDate < skipWeekend(nextRunDate));

      await tx.regularInvestPlan.update({
        where: { id: planId },
        data: {
          lastRunDate: finalLastRunDate,
          nextRunDate: skipWeekend(nextRunDate),
          executedRuns: finalExecutedRuns,
          status: willComplete ? RegularInvestStatus.completed : RegularInvestStatus.active,
        },
      });
      actualCreatedCount = actualRunsToCreate.length;
    }, BATCH_EXECUTE_TRANSACTION_OPTIONS);

    if (actualCreatedCount === 0) {
      const updatedPlan = await prisma.regularInvestPlan.findUnique({
        where: { id: planId },
      });
      return NextResponse.json({
        ok: true,
        message: "所有到期的交易明细已存在，无需重复生成",
        executedCount: 0,
        skippedCount: skippedCount + skippedDuplicateAtCommit,
        completed: false,
        stats: {
          plan: updatedPlan ? {
            executedRuns: updatedPlan.executedRuns,
            lastRunDate: updatedPlan.lastRunDate?.toISOString() ?? null,
            nextRunDate: updatedPlan.nextRunDate?.toISOString() ?? null,
            status: updatedPlan.status,
          } : null,
        },
      });
    }

    await recalcFundPositions(fundAcc.id, [plan.fundCode]).catch(logger.catchLog("操作失败", "route.ts"));

    // Query the updated statistics after the run
    const updatedEntries = await prisma.fundTransaction.findMany({
      where: {
        regularInvestPlanId: planId,
        source: "regular_invest",
        deletedAt: null,
      },
      select: { grossAmount: true, refundAmount: true, units: true, fundSubtype: true },
    });

    const totalExecutedCount = updatedEntries.filter((e) => e.fundSubtype !== "buy_failed").length;
    const totalExecutedAmount = updatedEntries.filter((e) => e.fundSubtype !== "buy_failed").reduce((sum, e) => sum + Math.abs(Number(e.grossAmount)), 0);
    const confirmedEntries = updatedEntries.filter((e) => e.fundSubtype !== "buy_failed" && e.units != null && Number(e.units) > 0);
    const totalConfirmedCount = confirmedEntries.length;
    const totalConfirmedAmount = confirmedEntries.reduce((sum, e) => sum + Math.abs(Number(e.grossAmount)), 0);
    const failedEntries = updatedEntries.filter((e) => e.fundSubtype === "buy_failed");
    const totalFailedCount = failedEntries.filter((e) => Number(e.refundAmount) > 0).length;
    const totalFailedAmount = failedEntries.reduce((sum, e) => sum + Math.abs(Number(e.refundAmount)), 0);

    const updatedPlan = await prisma.regularInvestPlan.findUnique({
      where: { id: planId },
    });

    return NextResponse.json({
      ok: true,
      message: `已执行基金定投 ${plan.fundCode}，生成 ${actualCreatedCount} 条交易明细${totalFailedCount > 0 ? `（暂停申购退回 ${totalFailedCount} 笔）` : ""}${skippedCount + skippedDuplicateAtCommit > 0 ? `（跳过 ${skippedCount + skippedDuplicateAtCommit} 个已处理或无净值日期）` : ""}`,
      executedCount: actualCreatedCount,
      skippedCount: skippedCount + skippedDuplicateAtCommit,
      completed: plan.totalRuns && plan.executedRuns + actualCreatedCount >= plan.totalRuns,
      stats: {
        executedCount: totalExecutedCount,
        executedAmount: totalExecutedAmount,
        confirmedCount: totalConfirmedCount,
        confirmedAmount: totalConfirmedAmount,
        failedCount: totalFailedCount,
        failedRefundAmount: totalFailedAmount,
        plan: updatedPlan ? {
          executedRuns: updatedPlan.executedRuns,
          lastRunDate: updatedPlan.lastRunDate?.toISOString() ?? null,
          nextRunDate: updatedPlan.nextRunDate?.toISOString() ?? null,
          status: updatedPlan.status,
        } : null,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "EXECUTE_FAILED", error: e instanceof Error ? e.message : "执行失败" }, { status: 500 });
  }
}
