-- Link cash ledger rows to business-side records.
-- Existing combined TxRecord rows are backfilled as self-links so old data remains compatible.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EntryBusinessType') THEN
    CREATE TYPE "EntryBusinessType" AS ENUM ('fund', 'wealth', 'deposit', 'insurance', 'metal', 'other_investment');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EntryBusinessLinkType') THEN
    CREATE TYPE "EntryBusinessLinkType" AS ENUM ('cash_flow', 'legacy_combined_record', 'generated_detail', 'adjustment');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EntryCashFlowDirection') THEN
    CREATE TYPE "EntryCashFlowDirection" AS ENUM ('outflow', 'inflow', 'internal', 'none');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "entry_business_links" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "cashEntryId" TEXT,
  "businessEntryId" TEXT NOT NULL,
  "businessType" "EntryBusinessType" NOT NULL,
  "linkType" "EntryBusinessLinkType" NOT NULL DEFAULT 'cash_flow',
  "cashFlowDirection" "EntryCashFlowDirection",
  "source" TEXT DEFAULT 'manual',
  "note" TEXT,
  "metadata" JSONB,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "entry_business_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "entry_business_links_cashEntryId_businessEntryId_linkType_key"
  ON "entry_business_links"("cashEntryId", "businessEntryId", "linkType");
CREATE INDEX IF NOT EXISTS "entry_business_links_householdId_businessType_idx"
  ON "entry_business_links"("householdId", "businessType");
CREATE INDEX IF NOT EXISTS "entry_business_links_cashEntryId_idx"
  ON "entry_business_links"("cashEntryId");
CREATE INDEX IF NOT EXISTS "entry_business_links_businessEntryId_idx"
  ON "entry_business_links"("businessEntryId");
CREATE INDEX IF NOT EXISTS "entry_business_links_deletedAt_idx"
  ON "entry_business_links"("deletedAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_business_links_householdId_fkey') THEN
    ALTER TABLE "entry_business_links"
      ADD CONSTRAINT "entry_business_links_householdId_fkey"
      FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_business_links_cashEntryId_fkey') THEN
    ALTER TABLE "entry_business_links"
      ADD CONSTRAINT "entry_business_links_cashEntryId_fkey"
      FOREIGN KEY ("cashEntryId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_business_links_businessEntryId_fkey') THEN
    ALTER TABLE "entry_business_links"
      ADD CONSTRAINT "entry_business_links_businessEntryId_fkey"
      FOREIGN KEY ("businessEntryId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

INSERT INTO "entry_business_links" (
  "id",
  "householdId",
  "cashEntryId",
  "businessEntryId",
  "businessType",
  "linkType",
  "cashFlowDirection",
  "source",
  "note",
  "metadata",
  "createdAt",
  "updatedAt"
)
SELECT
  'ebl_' || t."id",
  t."householdId",
  t."id",
  t."id",
  CASE
    WHEN t."source" = 'insurance' OR t."insuranceProductId" IS NOT NULL THEN 'insurance'::"EntryBusinessType"
    WHEN t."fundProductType"::text = 'wealth' THEN 'wealth'::"EntryBusinessType"
    WHEN t."fundProductType"::text = 'deposit' THEN 'deposit'::"EntryBusinessType"
    WHEN t."fundProductType"::text = 'metal' OR t."metalTypeId" IS NOT NULL THEN 'metal'::"EntryBusinessType"
    WHEN t."fundProductType"::text IN ('fund', 'money') OR t."fundCode" IS NOT NULL THEN 'fund'::"EntryBusinessType"
    ELSE 'other_investment'::"EntryBusinessType"
  END,
  'legacy_combined_record'::"EntryBusinessLinkType",
  CASE
    WHEN t."fundSubtype"::text = 'dividend_reinvest' THEN 'internal'::"EntryCashFlowDirection"
    WHEN t."amount" < 0 THEN 'outflow'::"EntryCashFlowDirection"
    WHEN t."amount" > 0 THEN 'inflow'::"EntryCashFlowDirection"
    ELSE 'none'::"EntryCashFlowDirection"
  END,
  COALESCE(t."source", 'manual'),
  'Legacy combined cash/business TxRecord',
  jsonb_build_object('legacyCombinedRecord', true),
  t."createdAt",
  CURRENT_TIMESTAMP
FROM "transactions" t
WHERE t."householdId" IS NOT NULL
  AND t."type" = 'investment'
  AND (
    t."fundProductType" IS NOT NULL
    OR t."fundCode" IS NOT NULL
    OR t."wealthProductId" IS NOT NULL
    OR t."insuranceProductId" IS NOT NULL
    OR t."source" = 'insurance'
    OR t."metalTypeId" IS NOT NULL
    OR t."depositSourceEntryId" IS NOT NULL
  )
ON CONFLICT DO NOTHING;
