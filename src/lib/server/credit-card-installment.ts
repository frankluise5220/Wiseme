import {
  CreditCardInstallmentSourceType,
  TransactionType,
  type Prisma,
} from "@prisma/client";

import {
  buildCreditCardInstallmentSchedule,
  type CreditCardInstallmentRateType,
} from "@/lib/credit/installment";
import { formatDateUtc, toStatementMonth } from "@/lib/date-utils";
import { attachEntryTags } from "@/lib/server/entry-tags";

type InstallmentWriter = Prisma.TransactionClient;

export type CreateCreditCardInstallmentInput = {
  householdId: string;
  account: { id: string; name: string };
  sourceType: CreditCardInstallmentSourceType;
  sourceEntryId?: string | null;
  sourceStatementMonth?: string | null;
  originalAmount: number;
  principal: number;
  totalRuns: number;
  rateType: CreditCardInstallmentRateType;
  rate: number;
  adjustmentDate: Date;
  adjustmentStatementMonth: string;
  billingDay: number;
  firstPaymentDate: Date;
  firstPaymentStatementMonth: string;
  billingDayTxPeriod?: string | null;
  category?: { id: string; name: string } | null;
  label: string;
  tagIds?: string[];
};

export async function normalizeCreditCardInstallmentStatementMonths(
  tx: InstallmentWriter,
  input: {
    householdId: string;
    accountIds: string[];
    billingDay: number;
    billingDayTxPeriod?: string | null;
  },
) {
  const accountIds = Array.from(new Set(input.accountIds.map((id) => String(id ?? "").trim()).filter(Boolean)));
  if (accountIds.length === 0) return { updatedEntries: 0, updatedPlans: 0 };

  const plans = await tx.creditCardInstallmentPlan.findMany({
    where: {
      householdId: input.householdId,
      accountId: { in: accountIds },
      sourceType: CreditCardInstallmentSourceType.statement,
      status: "active",
    },
    select: {
      id: true,
      sourceStatementMonth: true,
      firstStatementMonth: true,
    },
  });
  if (plans.length === 0) return { updatedEntries: 0, updatedPlans: 0 };

  const planIds = plans.map((plan) => plan.id);
  const entries = await tx.txRecord.findMany({
    where: {
      householdId: input.householdId,
      accountId: { in: accountIds },
      deletedAt: null,
      source: "credit_card_installment",
      creditCardInstallmentPlanId: { in: planIds },
    },
    select: {
      id: true,
      date: true,
      statementMonth: true,
      creditCardInstallmentPlanId: true,
      installmentRole: true,
    },
  });

  let updatedEntries = 0;
  const sourceStatementMonthByPlanId = new Map<string, string>();
  const firstPaymentMonthByPlanId = new Map<string, string>();

  for (const entry of entries) {
    const expectedMonth = toStatementMonth(entry.date, input.billingDay, input.billingDayTxPeriod);
    if (entry.statementMonth !== expectedMonth) {
      await tx.txRecord.updateMany({
        where: {
          id: entry.id,
          householdId: input.householdId,
          deletedAt: null,
        },
        data: { statementMonth: expectedMonth },
      });
      updatedEntries += 1;
    }
    const planId = entry.creditCardInstallmentPlanId;
    if (!planId) continue;
    if (entry.installmentRole === "adjustment") {
      sourceStatementMonthByPlanId.set(planId, expectedMonth);
    }
    if (entry.installmentRole === "payment") {
      const current = firstPaymentMonthByPlanId.get(planId);
      if (!current || expectedMonth < current) {
        firstPaymentMonthByPlanId.set(planId, expectedMonth);
      }
    }
  }

  let updatedPlans = 0;
  for (const plan of plans) {
    const nextData: { sourceStatementMonth?: string; firstStatementMonth?: string } = {};
    const sourceMonth = sourceStatementMonthByPlanId.get(plan.id);
    if (sourceMonth && plan.sourceStatementMonth !== sourceMonth) {
      nextData.sourceStatementMonth = sourceMonth;
    }
    const firstPaymentMonth = firstPaymentMonthByPlanId.get(plan.id);
    if (firstPaymentMonth && plan.firstStatementMonth !== firstPaymentMonth) {
      nextData.firstStatementMonth = firstPaymentMonth;
    }
    if (Object.keys(nextData).length === 0) continue;
    await tx.creditCardInstallmentPlan.updateMany({
      where: { id: plan.id, householdId: input.householdId },
      data: nextData,
    });
    updatedPlans += 1;
  }

  return { updatedEntries, updatedPlans };
}

export async function createCreditCardInstallmentPlan(
  tx: InstallmentWriter,
  input: CreateCreditCardInstallmentInput,
) {
  if (input.sourceType === CreditCardInstallmentSourceType.transaction && !input.sourceEntryId) {
    throw new Error("消费分期缺少原消费记录");
  }
  if (input.sourceType === CreditCardInstallmentSourceType.statement && !input.sourceStatementMonth) {
    throw new Error("账单分期缺少来源账单月份");
  }
  if (!Number.isFinite(input.originalAmount) || input.originalAmount <= 0) {
    throw new Error("原金额必须大于 0");
  }
  if (!Number.isFinite(input.principal) || input.principal <= 0) {
    throw new Error("分期金额必须大于 0");
  }

  const schedule = buildCreditCardInstallmentSchedule({
    principal: input.principal,
    totalRuns: input.totalRuns,
    rateType: input.rateType,
    rate: input.rate,
    billingDay: input.billingDay,
    firstDate: input.firstPaymentDate,
  });
  const installmentDateLabel = formatDateUtc(input.adjustmentDate);
  const installmentKindLabel = input.sourceType === CreditCardInstallmentSourceType.statement ? "账单" : "消费";
  const plan = await tx.creditCardInstallmentPlan.create({
    data: {
      householdId: input.householdId,
      accountId: input.account.id,
      sourceType: input.sourceType,
      sourceEntryId: input.sourceEntryId ?? null,
      sourceStatementMonth: input.sourceStatementMonth ?? null,
      originalAmount: input.originalAmount,
      installmentPrincipal: input.principal,
      totalRuns: input.totalRuns,
      rateType: input.rateType,
      rate: input.rate,
      firstStatementMonth: input.firstPaymentStatementMonth,
      // Schedule rebuild inputs: future payment rows are materialized when due
      // (materializeDueInstallmentPayments) instead of being pre-generated.
      billingDay: input.billingDay,
      firstPaymentDate: input.firstPaymentDate,
      tagIds: input.tagIds?.length ? JSON.stringify(input.tagIds) : null,
      categoryId: input.category?.id ?? null,
      categoryName: input.category?.name ?? null,
    },
  });

  const adjustmentEntry = await tx.txRecord.create({
    data: {
      householdId: input.householdId,
      accountId: input.account.id,
      accountName: input.account.name,
      categoryId: input.category?.id ?? null,
      categoryName: input.category?.name ?? null,
      amount: input.principal,
      type: TransactionType.expense,
      date: input.adjustmentDate,
      postedAt: input.adjustmentDate,
      statementMonth: input.adjustmentStatementMonth,
      source: "credit_card_installment",
      creditCardInstallmentPlanId: plan.id,
      installmentTotal: input.totalRuns,
      installmentPrincipal: input.principal,
      installmentInterest: 0,
      installmentRole: "adjustment",
      note: `${installmentKindLabel}分期冲抵：${input.label}（分期日期 ${installmentDateLabel}）`,
    },
  });
  if (input.tagIds?.length) {
    await attachEntryTags({
      tx,
      entryId: adjustmentEntry.id,
      householdId: input.householdId,
      tagIds: input.tagIds,
    });
  }

  // Payment rows are NOT pre-generated here. Each installment payment/fee is
  // materialized by materializeDueInstallmentPayments when its date arrives,
  // so future-dated records never appear in ordinary record lists.
  return { plan, schedule };
}

type InstallmentPaymentRow = {
  installmentNo: number;
  date: Date;
  statementMonth: string;
  principal: number;
  interest: number;
};

function parsePlanTagIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Materialize due credit-card installment payment rows.
 *
 * Payment rows are created lazily: for each active plan, rebuild the schedule
 * from the stored billing day / first payment date and create the principal
 * (and fee) rows whose date is on or before `asOfDate` and do not exist yet.
 * Legacy plans without stored billingDay/firstPaymentDate fall back to the
 * account billing day and the first statement month + billing day.
 */
export async function materializeDueInstallmentPayments(
  db: InstallmentWriter,
  input: { householdId: string; accountIds?: string[]; asOfDate?: Date },
) {
  const asOf = input.asOfDate ?? new Date();
  const plans = await db.creditCardInstallmentPlan.findMany({
    where: {
      householdId: input.householdId,
      status: "active",
      ...(input.accountIds && input.accountIds.length > 0
        ? { accountId: { in: Array.from(new Set(input.accountIds)) } }
        : {}),
    },
    select: {
      id: true,
      accountId: true,
      sourceType: true,
      installmentPrincipal: true,
      totalRuns: true,
      rateType: true,
      rate: true,
      billingDay: true,
      firstPaymentDate: true,
      firstStatementMonth: true,
      tagIds: true,
      categoryId: true,
      categoryName: true,
      Account: { select: { name: true, billingDay: true, billingDayTxPeriod: true } },
    },
  });
  if (plans.length === 0) return { materialized: 0 };

  let materialized = 0;
  for (const plan of plans) {
    const billingDay = plan.billingDay ?? plan.Account?.billingDay ?? 1;
    const firstDate =
      plan.firstPaymentDate ??
      new Date(`${plan.firstStatementMonth}-${String(billingDay).padStart(2, "0")}T00:00:00`);
    const schedule = buildCreditCardInstallmentSchedule({
      principal: Number(plan.installmentPrincipal),
      totalRuns: plan.totalRuns,
      rateType: plan.rateType,
      rate: Number(plan.rate),
      billingDay,
      firstDate,
    });
    const dueRows: InstallmentPaymentRow[] = schedule
      .filter((row) => row.date.getTime() <= asOf.getTime())
      .map((row) => ({
        installmentNo: row.installmentNo,
        date: row.date,
        statementMonth: toStatementMonth(row.date, billingDay, plan.Account?.billingDayTxPeriod),
        principal: row.principal,
        interest: row.interest,
      }));
    if (dueRows.length === 0) continue;

    const existing = await db.txRecord.findMany({
      where: {
        creditCardInstallmentPlanId: plan.id,
        deletedAt: null,
        installmentRole: { in: ["payment", "fee"] },
      },
      select: { installmentNo: true, installmentRole: true },
    });
    const existingPaymentNos = new Set(
      existing.filter((entry) => entry.installmentRole === "payment").map((entry) => entry.installmentNo),
    );

    const tagIds = parsePlanTagIds(plan.tagIds);
    for (const row of dueRows) {
      if (existingPaymentNos.has(row.installmentNo)) continue;
      const label = plan.sourceType === CreditCardInstallmentSourceType.statement
        ? `${plan.firstStatementMonth} 账单`
        : "消费分期";
      const installmentKindLabel = plan.sourceType === CreditCardInstallmentSourceType.statement ? "账单" : "消费";
      const installmentDateLabel = formatDateUtc(row.date);

      const principalEntry = await db.txRecord.create({
        data: {
          householdId: input.householdId,
          accountId: plan.accountId,
          accountName: plan.Account?.name ?? "",
          categoryId: plan.categoryId ?? null,
          categoryName: plan.categoryName ?? null,
          amount: -row.principal,
          type: TransactionType.expense,
          date: row.date,
          postedAt: row.date,
          statementMonth: row.statementMonth,
          source: "credit_card_installment",
          creditCardInstallmentPlanId: plan.id,
          installmentNo: row.installmentNo,
          installmentTotal: plan.totalRuns,
          installmentPrincipal: row.principal,
          installmentInterest: 0,
          installmentRole: "payment",
          note: `${label}（${installmentKindLabel}分期本金 ${row.installmentNo}/${plan.totalRuns}，分期日期 ${installmentDateLabel}）`,
        },
      });
      if (tagIds.length) {
        await attachEntryTags({ tx: db, entryId: principalEntry.id, householdId: input.householdId, tagIds });
      }
      materialized += 1;

      if (row.interest > 0) {
        const feeEntry = await db.txRecord.create({
          data: {
            householdId: input.householdId,
            accountId: plan.accountId,
            accountName: plan.Account?.name ?? "",
            categoryId: plan.categoryId ?? null,
            categoryName: plan.categoryName ?? null,
            amount: -row.interest,
            type: TransactionType.expense,
            date: row.date,
            postedAt: row.date,
            statementMonth: row.statementMonth,
            source: "credit_card_installment",
            creditCardInstallmentPlanId: plan.id,
            installmentNo: row.installmentNo,
            installmentTotal: plan.totalRuns,
            installmentPrincipal: 0,
            installmentInterest: row.interest,
            installmentRole: "fee",
            note: `${label}（${installmentKindLabel}分期${plan.rateType === "annual_interest" ? "利息" : "手续费"} ${row.installmentNo}/${plan.totalRuns}，分期日期 ${installmentDateLabel}）`,
          },
        });
        if (tagIds.length) {
          await attachEntryTags({ tx: db, entryId: feeEntry.id, householdId: input.householdId, tagIds });
        }
        materialized += 1;
      }
      existingPaymentNos.add(row.installmentNo);
    }
  }

  return { materialized };
}
