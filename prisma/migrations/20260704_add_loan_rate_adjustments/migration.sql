CREATE TABLE "LoanRateAdjustment" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "regularInvestPlanId" TEXT,
  "effectiveDate" TIMESTAMP(3) NOT NULL,
  "annualRate" DECIMAL(10, 6) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LoanRateAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LoanRateAdjustment_householdId_accountId_effectiveDate_key"
  ON "LoanRateAdjustment"("householdId", "accountId", "effectiveDate");

CREATE INDEX "LoanRateAdjustment_householdId_accountId_idx"
  ON "LoanRateAdjustment"("householdId", "accountId");

CREATE INDEX "LoanRateAdjustment_regularInvestPlanId_idx"
  ON "LoanRateAdjustment"("regularInvestPlanId");

ALTER TABLE "LoanRateAdjustment"
  ADD CONSTRAINT "LoanRateAdjustment_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoanRateAdjustment"
  ADD CONSTRAINT "LoanRateAdjustment_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoanRateAdjustment"
  ADD CONSTRAINT "LoanRateAdjustment_regularInvestPlanId_fkey"
  FOREIGN KEY ("regularInvestPlanId") REFERENCES "RegularInvestPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "LoanRateAdjustment" (
  "id",
  "householdId",
  "accountId",
  "regularInvestPlanId",
  "effectiveDate",
  "annualRate",
  "createdAt",
  "updatedAt"
)
SELECT
  'loanrate_' || md5(p."id" || ':' || (item.value ->> 'effectiveDate')),
  COALESCE(p."householdId", a."householdId"),
  p."accountId",
  p."id",
  ((item.value ->> 'effectiveDate')::date)::timestamp,
  (item.value ->> 'annualRate')::decimal(10, 6),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "RegularInvestPlan" p
JOIN "Account" a ON a."id" = p."accountId"
CROSS JOIN LATERAL jsonb_array_elements(
  COALESCE(
    (substring(p."memo" from 20)::jsonb -> 'loanRateAdjustments'),
    '[]'::jsonb
  )
) AS item(value)
WHERE p."memo" LIKE 'MMH_SCHEDULED_TASK:%'
  AND p."fundCode" = 'loan_repayment'
  AND COALESCE(p."householdId", a."householdId") IS NOT NULL
  AND jsonb_typeof(substring(p."memo" from 20)::jsonb -> 'loanRateAdjustments') = 'array'
  AND (item.value ->> 'effectiveDate') ~ '^\d{4}-\d{2}-\d{2}$'
  AND (item.value ->> 'annualRate') ~ '^[0-9]+(\.[0-9]+)?$'
  AND (item.value ->> 'annualRate')::decimal > 0
ON CONFLICT ("householdId", "accountId", "effectiveDate") DO NOTHING;
