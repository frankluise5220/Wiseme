import { IntervalUnit, RegularInvestStatus, TransactionType } from "@prisma/client";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { formatDateUtc, startOfDayUtc, toNumber } from "@/lib/date-utils";
import { calcInitialScheduledRunDate, calcNextScheduledRunDate } from "@/lib/scheduled-task-date";
import { logger } from "@/lib/logger";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterTxChange } from "@/lib/server/revalidate";
import { ENTRY_ORIGIN_SCHEDULED_TASK } from "@/lib/transaction-semantics";

/**
 * POST /api/v1/cleanup/financed-purchase-repayments
 * Body: {
 *   dryRun?: boolean,
 *   mode?: "future" | "all",
 *   cutoffDate?: "YYYY-MM-DD",
 *   accountId?: string,
 *   planId?: string
 * }
 *
 * Internal maintenance endpoint. Finds auto-generated `scheduled_task` loan
 * repayment TxRecord rows for loans whose initial row is `debt_financed_purchase`.
 * Defaults to dry-run and only targets future-dated rows. Passing `dryRun:false`
 * soft-deletes matched rows, recalculates affected balances, and realigns the
 * repayment plan cursor from the remaining linked repayment rows.
 */
export const runtime = "nodejs";

type CleanupMode = "future" | "all";

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

function normalizeMode(value: unknown): CleanupMode {
  return value === "all" ? "all" : "future";
}

function nextStatusAfterCleanup(params: {
  currentStatus: RegularInvestStatus;
  totalRuns: number | null;
  executedRuns: number;
  endDate: Date | null;
  nextRunDate: Date;
}) {
  if (params.currentStatus === RegularInvestStatus.paused || params.currentStatus === RegularInvestStatus.stopped) {
    return params.currentStatus;
  }
  const reachedRuns = params.totalRuns != null && params.executedRuns >= params.totalRuns;
  const passedEndDate = params.endDate != null && params.nextRunDate > params.endDate;
  return reachedRuns || passedEndDate ? RegularInvestStatus.completed : RegularInvestStatus.active;
}

export async function POST(req: Request) {
  try {
    const scope = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun !== false;
    const mode = normalizeMode(body?.mode);
    const cutoffDate = body?.cutoffDate ? parseDateOnlyUtc(body.cutoffDate) : startOfDayUtc(new Date());
    const accountId = String(body?.accountId ?? "").trim();
    const planId = String(body?.planId ?? "").trim();

    if (!cutoffDate) {
      return NextResponse.json({ ok: false, error: "cutoffDate 格式不正确" }, { status: 400 });
    }

    const financedBorrowRows = await prisma.txRecord.findMany({
      where: {
        ...scope.hidFilter,
        deletedAt: null,
        type: TransactionType.transfer,
        source: "debt_financed_purchase",
        ...(accountId ? { accountId } : {}),
      },
      select: {
        id: true,
        accountId: true,
        accountName: true,
        date: true,
        amount: true,
      },
      orderBy: [{ date: "asc" }, { id: "asc" }],
    });
    const financedLoanAccountIds = Array.from(new Set(financedBorrowRows.map((row) => row.accountId)));

    const plans = financedLoanAccountIds.length
      ? await prisma.regularInvestPlan.findMany({
          where: {
            ...scope.hidFilter,
            accountId: { in: financedLoanAccountIds },
            fundCode: "loan_repayment",
            ...(planId ? { id: planId } : {}),
          },
          select: {
            id: true,
            accountId: true,
            accountName: true,
            cashAccountId: true,
            cashAccountName: true,
            startDate: true,
            nextRunDate: true,
            lastRunDate: true,
            intervalUnit: true,
            intervalValue: true,
            executionDay: true,
            executedRuns: true,
            totalRuns: true,
            endDate: true,
            status: true,
          },
          orderBy: [{ accountName: "asc" }, { startDate: "asc" }],
        })
      : [];

    const planIds = plans.map((plan) => plan.id);
    const candidates = planIds.length
      ? await prisma.txRecord.findMany({
          where: {
            ...scope.hidFilter,
            deletedAt: null,
            regularInvestPlanId: { in: planIds },
            source: "scheduled_task",
            entryOrigin: ENTRY_ORIGIN_SCHEDULED_TASK,
            type: TransactionType.transfer,
            toAccountId: { in: financedLoanAccountIds },
            ...(mode === "future" ? { date: { gt: cutoffDate } } : {}),
          },
          select: {
            id: true,
            regularInvestPlanId: true,
            date: true,
            accountId: true,
            accountName: true,
            toAccountId: true,
            toAccountName: true,
            amount: true,
            debtPrincipalAmount: true,
            debtInterestAmount: true,
          },
          orderBy: [{ date: "asc" }, { id: "asc" }],
        })
      : [];

    const candidatesByPlan = new Map<string, typeof candidates>();
    for (const candidate of candidates) {
      if (!candidate.regularInvestPlanId) continue;
      const rows = candidatesByPlan.get(candidate.regularInvestPlanId) ?? [];
      rows.push(candidate);
      candidatesByPlan.set(candidate.regularInvestPlanId, rows);
    }

    const planSummaries = plans.map((plan) => {
      const rows = candidatesByPlan.get(plan.id) ?? [];
      return {
        planId: plan.id,
        accountId: plan.accountId,
        accountName: plan.accountName,
        cashAccountId: plan.cashAccountId,
        cashAccountName: plan.cashAccountName,
        status: plan.status,
        startDate: formatDateUtc(plan.startDate),
        lastRunDate: plan.lastRunDate ? formatDateUtc(plan.lastRunDate) : null,
        nextRunDate: formatDateUtc(plan.nextRunDate),
        executedRuns: plan.executedRuns,
        totalRuns: plan.totalRuns,
        matchedRows: rows.length,
        matchedAmount: rows.reduce((sum, row) => sum + Math.abs(toNumber(row.amount)), 0),
        firstMatchedDate: rows[0]?.date ? formatDateUtc(rows[0].date) : null,
        lastMatchedDate: rows[rows.length - 1]?.date ? formatDateUtc(rows[rows.length - 1]!.date) : null,
        sampleRows: rows.slice(0, 5).map((row) => ({
          id: row.id,
          date: formatDateUtc(row.date),
          amount: toNumber(row.amount),
          principal: row.debtPrincipalAmount == null ? null : toNumber(row.debtPrincipalAmount),
          interest: row.debtInterestAmount == null ? null : toNumber(row.debtInterestAmount),
        })),
      };
    });

    if (dryRun || candidates.length === 0) {
      return NextResponse.json({
        ok: true,
        data: {
          dryRun,
          mode,
          cutoffDate: formatDateUtc(cutoffDate),
          financedBorrowRows: financedBorrowRows.length,
          financedLoanAccounts: financedLoanAccountIds.length,
          loanRepaymentPlans: plans.length,
          matchedRows: candidates.length,
          plans: planSummaries,
        },
      });
    }

    const affectedAccountIds = new Set<string>();
    for (const row of candidates) {
      affectedAccountIds.add(row.accountId);
      if (row.toAccountId) affectedAccountIds.add(row.toAccountId);
    }
    for (const plan of plans) {
      affectedAccountIds.add(plan.accountId);
      if (plan.cashAccountId) affectedAccountIds.add(plan.cashAccountId);
    }

    const deletedAt = new Date();
    const updatedPlans: Array<{
      planId: string;
      executedRuns: number;
      lastRunDate: string | null;
      nextRunDate: string;
      status: RegularInvestStatus;
    }> = [];

    await prisma.$transaction(async (tx) => {
      await tx.txRecord.updateMany({
        where: {
          id: { in: candidates.map((row) => row.id) },
          ...scope.hidFilter,
          deletedAt: null,
        },
        data: { deletedAt },
      });

      for (const plan of plans) {
        const remainingRows = await tx.txRecord.findMany({
          where: {
            ...scope.hidFilter,
            deletedAt: null,
            regularInvestPlanId: plan.id,
            type: TransactionType.transfer,
            toAccountId: plan.accountId,
            source: { in: ["scheduled_task", "debt_repay_out"] },
          },
          select: { date: true },
          orderBy: [{ date: "asc" }, { id: "asc" }],
        });
        const lastRemainingRunDate = remainingRows[remainingRows.length - 1]?.date ?? null;
        const nextRunDate = lastRemainingRunDate
          ? calcNextScheduledRunDate(
              lastRemainingRunDate,
              plan.intervalUnit as IntervalUnit,
              plan.intervalValue,
              plan.executionDay,
              false,
            )
          : calcInitialScheduledRunDate(
              plan.startDate,
              plan.intervalUnit as IntervalUnit,
              plan.intervalValue,
              plan.executionDay,
              false,
            );
        const nextStatus = nextStatusAfterCleanup({
          currentStatus: plan.status,
          totalRuns: plan.totalRuns,
          executedRuns: remainingRows.length,
          endDate: plan.endDate,
          nextRunDate,
        });

        await tx.regularInvestPlan.update({
          where: { id: plan.id },
          data: {
            executedRuns: remainingRows.length,
            lastRunDate: lastRemainingRunDate,
            nextRunDate,
            status: nextStatus,
          },
        });
        updatedPlans.push({
          planId: plan.id,
          executedRuns: remainingRows.length,
          lastRunDate: lastRemainingRunDate ? formatDateUtc(lastRemainingRunDate) : null,
          nextRunDate: formatDateUtc(nextRunDate),
          status: nextStatus,
        });
      }
    });

    for (const affectedAccountId of affectedAccountIds) {
      await recalcAndSaveAccountBalance(affectedAccountId).catch(
        logger.catchLog("车贷清理后余额重算失败", "cleanup-financed-purchase-repayments"),
      );
    }
    revalidateAfterTxChange();

    return NextResponse.json({
      ok: true,
      data: {
        dryRun: false,
        mode,
        cutoffDate: formatDateUtc(cutoffDate),
        deletedRows: candidates.length,
        affectedAccounts: Array.from(affectedAccountIds),
        plans: updatedPlans,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "清理车贷还款记录失败" },
      { status: 500 },
    );
  }
}
