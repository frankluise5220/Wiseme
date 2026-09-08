import { type Prisma } from "@prisma/client";

import { startOfDayUtc } from "@/lib/date-utils";
import { CREDIT_CARD_BILLING_DAY_INITIAL_DATE } from "@/lib/credit/billing";

const MIN_BILLING_DAY = 1;
const MAX_BILLING_DAY = 31;

type Writer = Prisma.TransactionClient;

type BillingDayRuleInput = {
  accountIds: readonly string[];
  billingDay: number | null | undefined;
  effectiveDate?: Date | null;
};

function normalizeBillingDay(value: number | null | undefined) {
  if (value == null) return null;
  const day = Math.trunc(value);
  return day >= MIN_BILLING_DAY && day <= MAX_BILLING_DAY ? day : null;
}

export async function ensureInitialCreditCardBillingDayRules(
  writer: Writer,
  input: BillingDayRuleInput,
) {
  const billingDay = normalizeBillingDay(input.billingDay);
  if (!billingDay || input.accountIds.length === 0) return;

  for (const accountId of new Set(input.accountIds.filter(Boolean))) {
    await writer.creditCardBillingDay.upsert({
      where: {
        accountId_effectiveDate: {
          accountId,
          effectiveDate: CREDIT_CARD_BILLING_DAY_INITIAL_DATE,
        },
      },
      create: {
        accountId,
        effectiveDate: CREDIT_CARD_BILLING_DAY_INITIAL_DATE,
        billingDay,
      },
      update: {},
    });
  }
}

export async function recordCreditCardBillingDayChange(
  writer: Writer,
  input: BillingDayRuleInput,
) {
  const billingDay = normalizeBillingDay(input.billingDay);
  if (!billingDay || input.accountIds.length === 0) return;
  const effectiveDate = input.effectiveDate
    ? startOfDayUtc(input.effectiveDate)
    : startOfDayUtc(new Date());

  for (const accountId of new Set(input.accountIds.filter(Boolean))) {
    await writer.creditCardBillingDay.upsert({
      where: {
        accountId_effectiveDate: {
          accountId,
          effectiveDate,
        },
      },
      create: {
        accountId,
        effectiveDate,
        billingDay,
      },
      update: {
        billingDay,
      },
    });
  }
}
