CREATE TABLE IF NOT EXISTS "WealthProduct" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "shortName" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "annualRate" DECIMAL(10,6),
  "termDays" INTEGER,
  "note" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "householdId" TEXT NOT NULL,
  "institutionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WealthProduct_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "wealthProductId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "WealthProduct_householdId_institutionId_name_key" ON "WealthProduct"("householdId", "institutionId", "name");
CREATE INDEX IF NOT EXISTS "WealthProduct_householdId_isActive_name_idx" ON "WealthProduct"("householdId", "isActive", "name");
CREATE INDEX IF NOT EXISTS "WealthProduct_institutionId_idx" ON "WealthProduct"("institutionId");
CREATE INDEX IF NOT EXISTS "transactions_wealthProductId_idx" ON "transactions"("wealthProductId");

ALTER TABLE "WealthProduct" ADD CONSTRAINT "WealthProduct_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WealthProduct" ADD CONSTRAINT "WealthProduct_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_wealthProductId_fkey" FOREIGN KEY ("wealthProductId") REFERENCES "WealthProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "WealthProduct" ("id", "name", "currency", "householdId", "institutionId", "createdAt", "updatedAt")
SELECT 'wealth_' || md5(COALESCE(t."householdId", '') || '|' || COALESCE(a."institutionId", '') || '|' || t."fundName"),
       t."fundName",
       COALESCE(NULLIF(t."currency", ''), 'CNY'),
       t."householdId",
       a."institutionId",
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
FROM "transactions" t
LEFT JOIN "Account" a ON a."id" = COALESCE(t."toAccountId", t."accountId")
WHERE t."fundProductType" = 'wealth'
  AND t."fundName" IS NOT NULL
  AND btrim(t."fundName") <> ''
  AND t."householdId" IS NOT NULL
ON CONFLICT ("householdId", "institutionId", "name") DO NOTHING;

UPDATE "transactions" t
SET "wealthProductId" = wp."id"
FROM "Account" a, "WealthProduct" wp
WHERE t."fundProductType" = 'wealth'
  AND t."fundName" IS NOT NULL
  AND t."householdId" = wp."householdId"
  AND t."fundName" = wp."name"
  AND a."id" = COALESCE(t."toAccountId", t."accountId")
  AND (a."institutionId" IS NOT DISTINCT FROM wp."institutionId")
  AND t."wealthProductId" IS NULL;
