import type { IntervalUnit } from "@prisma/client";
import { calcInitialScheduledRunDate, calcNextScheduledRunDate } from "@/lib/scheduled-task-date";
import { normalizeScheduledTaskType } from "@/lib/scheduled-task";

type TxRecordReader = {
  txRecord: {
    findFirst: (args: {
      where: {
        regularInvestPlanId: string;
        deletedAt: null;
        householdId?: string;
        source: { in: string[] };
      };
      orderBy: Array<{ date: "desc" } | { createdAt: "desc" }>;
      select: { date: true };
    }) => Promise<{ date: Date } | null>;
  };
};

type RegularInvestPlanSchedule = {
  id: string;
  householdId?: string | null;
  taskType?: string | null;
  startDate: Date;
  lastRunDate?: Date | null;
  intervalUnit: IntervalUnit;
  intervalValue: number;
  executionDay?: number | null;
  secondaryExecutionDay?: number | null;
};

export function getRegularInvestPlanRecordSources(taskType: string | null | undefined): string[] {
  const normalizedTaskType = normalizeScheduledTaskType(taskType);
  if (normalizedTaskType === "fund_regular_invest") return ["regular_invest"];
  if (normalizedTaskType === "insurance_premium") return ["insurance"];
  return ["scheduled_task"];
}

export async function deriveRegularInvestNextRunDate(
  db: TxRecordReader,
  plan: RegularInvestPlanSchedule,
): Promise<Date> {
  const normalizedTaskType = normalizeScheduledTaskType(plan.taskType);
  const latestRecord = await db.txRecord.findFirst({
    where: {
      regularInvestPlanId: plan.id,
      deletedAt: null,
      ...(plan.householdId ? { householdId: plan.householdId } : {}),
      source: { in: getRegularInvestPlanRecordSources(normalizedTaskType) },
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    select: { date: true },
  });

  const usesBusinessDays = normalizedTaskType === "fund_regular_invest";
  const cursorDate = latestRecord?.date ?? plan.lastRunDate ?? null;
  if (cursorDate) {
    return calcNextScheduledRunDate(
      cursorDate,
      plan.intervalUnit,
      plan.intervalValue,
      plan.executionDay,
      usesBusinessDays,
      plan.secondaryExecutionDay,
    );
  }

  return calcInitialScheduledRunDate(
    plan.startDate,
    plan.intervalUnit,
    plan.intervalValue,
    plan.executionDay,
    usesBusinessDays,
    plan.secondaryExecutionDay,
  );
}
