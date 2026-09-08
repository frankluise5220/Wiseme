ALTER TABLE "wealth_transactions"
  ADD COLUMN IF NOT EXISTS "units" DECIMAL(20,6);

UPDATE "wealth_transactions" AS wt
SET "units" = t."fundUnits"
FROM "transactions" AS t
WHERE wt."units" IS NULL
  AND t."fundUnits" IS NOT NULL
  AND (wt."id" = t."id" OR wt."cashEntryId" = t."id");

UPDATE "wealth_transactions"
SET "grossAmount" = GREATEST(
  0,
  COALESCE("arrivalAmount", "grossAmount") - COALESCE("interest", 0) + COALESCE("fee", 0)
)
WHERE "action" IN ('redeem', 'switch_out')
  AND "arrivalAmount" IS NOT NULL;
