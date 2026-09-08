ALTER TABLE "insurance_transactions" ADD COLUMN IF NOT EXISTS "arrivalDate" TIMESTAMP(3);

UPDATE "insurance_transactions" it
SET "arrivalDate" = t."fundArrivalDate"
FROM "transactions" t
WHERE t."id" = it."id"
  AND it."arrivalDate" IS NULL
  AND t."fundArrivalDate" IS NOT NULL;
