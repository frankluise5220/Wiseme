-- Account.billingDayTxPeriod: whether transactions ON the billing day fall
-- into the current statement (current, existing behavior) or the next one
-- (next). The billing cycle for "next" ends one day before the billing day.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CreditBillingDayTxPeriod') THEN
    CREATE TYPE "CreditBillingDayTxPeriod" AS ENUM ('current', 'next');
  END IF;
END
$$;

ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "billingDayTxPeriod" "CreditBillingDayTxPeriod" NOT NULL DEFAULT 'current';
