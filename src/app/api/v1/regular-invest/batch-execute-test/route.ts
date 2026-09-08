import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { formatDateUtc } from "@/lib/date-utils";
import { decodeScheduledTaskMemo } from "@/lib/scheduled-task";
import { getScheduledTaskSourceFilter, isNonFundScheduledTask } from "@/lib/server/scheduled-task-executor";

/**
 * Debug endpoint for scheduled task execution state.
 * GET /api/v1/regular-invest/batch-execute-test?planId=xxx
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const planId = searchParams.get("planId");

    if (!planId) {
      return NextResponse.json({ ok: false, code: "MISSING_PLAN_ID", error: "缺少 planId" }, { status: 400 });
    }

    const plan = await prisma.regularInvestPlan.findUnique({
      where: { id: planId },
    });

    if (!plan) {
      return NextResponse.json({ ok: false, code: "PLAN_NOT_FOUND", error: "计划不存在" }, { status: 404 });
    }

    const task = decodeScheduledTaskMemo(plan.memo);
    const sourceFilter = isNonFundScheduledTask(task.type)
      ? getScheduledTaskSourceFilter(task.type)
      : ["regular_invest", "regular_invest_refund"];

    const entriesWithPlanId = await prisma.txRecord.findMany({
      where: {
        regularInvestPlanId: planId,
        source: { in: sourceFilter },
      },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        date: true,
        type: true,
        source: true,
        amount: true,
        accountId: true,
        accountName: true,
        toAccountId: true,
        toAccountName: true,
        fundCode: true,
        fundSubtype: true,
        note: true,
        deletedAt: true,
        regularInvestPlanId: true,
      },
    });

    const activeDates = new Set(
      entriesWithPlanId
        .filter((entry) => !entry.deletedAt)
        .map((entry) => formatDateUtc(entry.date)),
    );

    const relatedEntryWhere = isNonFundScheduledTask(task.type)
      ? {
          OR: [
            { accountId: plan.cashAccountId ?? undefined, toAccountId: plan.accountId },
            { accountId: plan.accountId },
          ],
          source: { in: sourceFilter },
        }
      : {
          OR: [{ toAccountId: plan.accountId }, { accountId: plan.accountId }],
          fundCode: plan.fundCode,
          source: { in: sourceFilter },
        };

    const relatedEntries = await prisma.txRecord.findMany({
      where: {
        ...relatedEntryWhere,
        deletedAt: null,
      },
      orderBy: [{ date: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        date: true,
        type: true,
        source: true,
        amount: true,
        accountName: true,
        toAccountName: true,
        fundCode: true,
        regularInvestPlanId: true,
        note: true,
      },
    });

    return NextResponse.json({
      ok: true,
      plan: {
        id: plan.id,
        taskType: task.type,
        fundCode: plan.fundCode,
        amount: Number(plan.amount),
        startDate: formatDateUtc(plan.startDate),
        lastRunDate: plan.lastRunDate ? formatDateUtc(plan.lastRunDate) : null,
        nextRunDate: formatDateUtc(plan.nextRunDate),
        intervalUnit: plan.intervalUnit,
        intervalValue: plan.intervalValue,
        executionDay: plan.executionDay,
        status: plan.status,
        executedRuns: plan.executedRuns,
        accountId: plan.accountId,
        accountName: plan.accountName,
        cashAccountId: plan.cashAccountId,
        cashAccountName: plan.cashAccountName,
        memo: plan.memo,
      },
      sourceFilter,
      activeDates: [...activeDates],
      entriesWithPlanId: entriesWithPlanId.length,
      entriesWithPlanIdData: entriesWithPlanId.map((entry) => ({
        ...entry,
        amount: Number(entry.amount),
        date: formatDateUtc(entry.date),
        deleted: Boolean(entry.deletedAt),
        deletedAt: entry.deletedAt?.toISOString() ?? null,
      })),
      relatedEntries: relatedEntries.length,
      relatedEntriesData: relatedEntries.map((entry) => ({
        ...entry,
        amount: Number(entry.amount),
        date: formatDateUtc(entry.date),
      })),
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      code: "FETCH_FAILED",
      error: e instanceof Error ? e.message : "查询失败",
    }, { status: 500 });
  }
}
