ALTER TABLE "wealth_transactions" ADD COLUMN IF NOT EXISTS "productName" TEXT;
ALTER TABLE "deposit_transactions" ADD COLUMN IF NOT EXISTS "productName" TEXT;

UPDATE "wealth_transactions" wt
SET "productName" = COALESCE(
  NULLIF(t."fundName", ''),
  (SELECT wp."name" FROM "WealthProduct" wp WHERE wp."id" = wt."wealthProductId")
)
FROM "transactions" t
WHERE t."id" = wt."id"
  AND wt."productName" IS NULL;

UPDATE "deposit_transactions" dt
SET "productName" = COALESCE(NULLIF(t."fundName", ''), NULLIF(t."fundCode", ''))
FROM "transactions" t
WHERE t."id" = dt."id"
  AND dt."productName" IS NULL;
