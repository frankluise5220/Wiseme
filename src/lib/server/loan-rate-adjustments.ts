import { Prisma, type LoanRateAdjustment as LoanRateAdjustmentRow } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { inferMortgageLprDiscountFromRateAdjustments, normalizeMortgageLprAdjustmentHistory } from "@/lib/loan-lpr";
import { normalizeLoanRateAdjustments, type LoanRateAdjustment } from "@/lib/loan-repayment";

type LoanRateAdjustmentStore = Pick<Prisma.TransactionClient, "loanRateAdjustment">;

function dateOnlyToUtcDate(value: string) {
  const text = String(value ?? "").trim().slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

function formatDateOnly(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function loanRateAdjustmentRowsToPayload(rows: Pick<LoanRateAdjustmentRow, "effectiveDate" | "annualRate">[]) {
  return normalizeLoanRateAdjustments(
    rows.map((row) => ({
      effectiveDate: formatDateOnly(row.effectiveDate),
      annualRate: Number(row.annualRate),
    })),
  );
}

export function resolveLoanRateAdjustments(params: {
  tableAdjustments?: LoanRateAdjustment[] | null;
  memoAdjustments?: LoanRateAdjustment[] | null;
  mortgageLprDiscount?: number | null;
  loanStartDate?: string | null;
  throughDate?: string | null;
}) {
  const tableAdjustments = normalizeLoanRateAdjustments(params.tableAdjustments);
  const adjustments = tableAdjustments.length > 0 ? tableAdjustments : normalizeLoanRateAdjustments(params.memoAdjustments);
  const mortgageLprDiscount = params.mortgageLprDiscount ?? inferMortgageLprDiscountFromRateAdjustments(adjustments, {
    skipOnOrBefore: params.loanStartDate,
  });
  return normalizeMortgageLprAdjustmentHistory({
    adjustments,
    discount: mortgageLprDiscount,
    throughDate: params.throughDate ?? formatDateOnly(new Date()),
    fromDate: params.loanStartDate,
  });
}

export async function listLoanRateAdjustmentsByAccountIds(params: {
  householdId: string;
  accountIds: string[];
}) {
  const accountIds = Array.from(new Set(params.accountIds.filter(Boolean)));
  if (accountIds.length === 0) return new Map<string, LoanRateAdjustment[]>();

  const rows = await prisma.loanRateAdjustment.findMany({
    where: {
      householdId: params.householdId,
      accountId: { in: accountIds },
    },
    orderBy: [{ accountId: "asc" }, { effectiveDate: "asc" }],
  });

  const map = new Map<string, LoanRateAdjustment[]>();
  for (const row of rows) {
    const list = map.get(row.accountId) ?? [];
    list.push({
      effectiveDate: formatDateOnly(row.effectiveDate),
      annualRate: Number(row.annualRate),
    });
    map.set(row.accountId, list);
  }
  for (const [accountId, items] of map) {
    map.set(accountId, normalizeLoanRateAdjustments(items));
  }
  return map;
}

export async function replaceLoanRateAdjustmentsForAccount(
  db: LoanRateAdjustmentStore,
  params: {
    householdId: string;
    accountId: string;
    regularInvestPlanId?: string | null;
    adjustments: LoanRateAdjustment[];
  },
) {
  const adjustments = normalizeLoanRateAdjustments(params.adjustments);
  const rows = adjustments.map((item) => {
    const effectiveDate = dateOnlyToUtcDate(item.effectiveDate);
    if (!effectiveDate) throw new Error(`利率生效日期不正确：${item.effectiveDate}`);
    return {
      householdId: params.householdId,
      accountId: params.accountId,
      regularInvestPlanId: params.regularInvestPlanId ?? null,
      effectiveDate,
      annualRate: new Prisma.Decimal(item.annualRate),
    };
  });

  await db.loanRateAdjustment.deleteMany({
    where: {
      householdId: params.householdId,
      accountId: params.accountId,
    },
  });
  if (rows.length > 0) {
    await db.loanRateAdjustment.createMany({ data: rows });
  }
  return adjustments;
}
