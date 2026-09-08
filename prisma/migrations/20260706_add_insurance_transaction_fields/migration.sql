-- Add insurance-specific fields so insurance records no longer need fund semantics.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "insuranceAction" TEXT;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "insuranceProductName" TEXT;
ALTER TABLE "RegularInvestPlan" ADD COLUMN IF NOT EXISTS "taskType" TEXT;
ALTER TABLE "RegularInvestPlan" ADD COLUMN IF NOT EXISTS "targetName" TEXT;
ALTER TABLE "RegularInvestPlan" ADD COLUMN IF NOT EXISTS "insuranceProductName" TEXT;

-- Backfill existing insurance transaction records from legacy fund fields.
UPDATE "transactions"
SET
  "insuranceAction" = CASE
    WHEN "fundSubtype" IN ('redeem', 'switch_out') THEN 'refund'
    ELSE 'premium'
  END,
  "insuranceProductName" = COALESCE("insuranceProductName", "fundName")
WHERE "source" = 'insurance'
  AND "deletedAt" IS NULL
  AND ("insuranceAction" IS NULL OR "insuranceProductName" IS NULL);

-- Backfill insurance premium plans from the memo/fund fields used before this migration.
UPDATE "RegularInvestPlan"
SET
  "taskType" = 'insurance_premium',
  "targetName" = COALESCE("targetName", "fundName", "fundCode"),
  "insuranceProductName" = COALESCE("insuranceProductName", "fundName", "fundCode")
WHERE (
    "fundCode" = 'insurance_premium'
    OR "memo" LIKE '%"type":"insurance_premium"%'
  )
  AND ("taskType" IS NULL OR "targetName" IS NULL OR "insuranceProductName" IS NULL);
