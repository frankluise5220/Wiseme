import { prisma } from "@/lib/db/prisma";
import { addTradingDaysUtc } from "@/lib/date-utils";

export type FundConfirmRule = {
  days: number;
  arrivalDays: number;
  exists: boolean;
};

export type FundConfirmRuleFallback = {
  days?: unknown;
  arrivalDays?: unknown;
};

export function normalizeNonNegativeDays(value: unknown, fallback: number): number {
  const days = Number(value);
  if (!Number.isFinite(days)) return fallback;
  return Math.max(0, Math.trunc(days));
}

export function fundUnitsProfitStartDate(
  navDate: string | null | undefined,
  tradingCalendar?: string | null,
): string | null {
  const date = String(navDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return addTradingDaysUtc(date, 1, tradingCalendar ?? "cn_fund");
}

export async function getFundConfirmDays(accountId: string, fundCode: string): Promise<number> {
  const record = await prisma.fundConfirmDays.findUnique({
    where: { accountId_fundCode: { accountId, fundCode } },
  });
  return normalizeNonNegativeDays(record?.days, 0);
}

export async function getFundArrivalDays(accountId: string, fundCode: string): Promise<number> {
  const record = await prisma.fundConfirmDays.findUnique({
    where: { accountId_fundCode: { accountId, fundCode } },
  });
  return normalizeNonNegativeDays(record?.arrivalDays, 2);
}

export async function getFundConfirmRule(
  accountId: string,
  fundCode: string,
  fallback?: FundConfirmRuleFallback,
): Promise<FundConfirmRule> {
  const record = await prisma.fundConfirmDays.findUnique({
    where: { accountId_fundCode: { accountId, fundCode } },
  });
  const fallbackDays = normalizeNonNegativeDays(fallback?.days, 0);
  const fallbackArrivalDays = normalizeNonNegativeDays(fallback?.arrivalDays, 2);
  return {
    days: normalizeNonNegativeDays(record?.days, fallbackDays),
    arrivalDays: normalizeNonNegativeDays(record?.arrivalDays, fallbackArrivalDays),
    exists: !!record,
  };
}

export async function setFundConfirmDays(accountId: string, fundCode: string, days: number): Promise<void> {
  const safeDays = normalizeNonNegativeDays(days, 0);
  await prisma.fundConfirmDays.upsert({
    where: { accountId_fundCode: { accountId, fundCode } },
    create: { accountId, fundCode, days: safeDays },
    update: { days: safeDays },
  });
}

export async function setFundArrivalDays(accountId: string, fundCode: string, arrivalDays: number): Promise<void> {
  const safeArrivalDays = normalizeNonNegativeDays(arrivalDays, 2);
  await prisma.fundConfirmDays.upsert({
    where: { accountId_fundCode: { accountId, fundCode } },
    create: { accountId, fundCode, days: 0, arrivalDays: safeArrivalDays },
    update: { arrivalDays: safeArrivalDays },
  });
}

export async function setFundConfirmDaysInTx(tx: any, accountId: string, fundCode: string, days: number): Promise<void> {
  const safeDays = normalizeNonNegativeDays(days, 0);
  await tx.fundConfirmDays.upsert({
    where: { accountId_fundCode: { accountId, fundCode } },
    create: { accountId, fundCode, days: safeDays },
    update: { days: safeDays },
  });
}

export async function setFundArrivalDaysInTx(tx: any, accountId: string, fundCode: string, arrivalDays: number): Promise<void> {
  const safeArrivalDays = normalizeNonNegativeDays(arrivalDays, 2);
  await tx.fundConfirmDays.upsert({
    where: { accountId_fundCode: { accountId, fundCode } },
    create: { accountId, fundCode, days: 0, arrivalDays: safeArrivalDays },
    update: { arrivalDays: safeArrivalDays },
  });
}

export async function setFundConfirmRuleInTx(
  tx: any,
  accountId: string,
  fundCode: string,
  days: number,
  arrivalDays: number,
): Promise<void> {
  const safeDays = normalizeNonNegativeDays(days, 0);
  const safeArrivalDays = normalizeNonNegativeDays(arrivalDays, 2);
  await tx.fundConfirmDays.upsert({
    where: { accountId_fundCode: { accountId, fundCode } },
    create: { accountId, fundCode, days: safeDays, arrivalDays: safeArrivalDays },
    update: { days: safeDays, arrivalDays: safeArrivalDays },
  });
}
