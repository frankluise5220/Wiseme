-- Credit card billing-day history.
-- Each row records a billing day that takes effect from `effectiveDate`
-- (inclusive). The billing cycle for a statement month is computed by walking
-- these rows: a cycle starts the day after the previous cycle's end, and ends
-- on the billing day that is in effect at the cycle's start date.
CREATE TABLE "CreditCardBillingDay" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "billingDay" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditCardBillingDay_pkey" PRIMARY KEY ("id")
);

-- Backfill an initial row for every credit card that already has a billing day,
-- effective from the epoch (1900-01-01) so historical cycles keep their old
-- billing day until a later change is recorded.
INSERT INTO "CreditCardBillingDay" ("id", "accountId", "effectiveDate", "billingDay")
SELECT
    'ccbd_' || md5(a."id" || ':' || a."billingDay"),
    a."id",
    '1900-01-01 00:00:00'::timestamp,
    a."billingDay"
FROM "Account" a
WHERE a."kind" = 'bank_credit'
  AND a."billingDay" IS NOT NULL;

CREATE INDEX "CreditCardBillingDay_accountId_idx" ON "CreditCardBillingDay"("accountId");

CREATE UNIQUE INDEX "CreditCardBillingDay_accountId_effectiveDate_key" ON "CreditCardBillingDay"("accountId", "effectiveDate");

ALTER TABLE "CreditCardBillingDay" ADD CONSTRAINT "CreditCardBillingDay_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
