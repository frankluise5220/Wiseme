-- Add a dedicated ingestion-origin column to transaction tables.
-- Existing `source` keeps its business/type meaning and is not migrated.

ALTER TABLE "transactions"
ADD COLUMN IF NOT EXISTS "entryOrigin" TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE "fund_transactions"
ADD COLUMN IF NOT EXISTS "entryOrigin" TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE "stock_transactions"
ADD COLUMN IF NOT EXISTS "entryOrigin" TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE "insurance_transactions"
ADD COLUMN IF NOT EXISTS "entryOrigin" TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE "wealth_transactions"
ADD COLUMN IF NOT EXISTS "entryOrigin" TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE "deposit_transactions"
ADD COLUMN IF NOT EXISTS "entryOrigin" TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE "precious_metal_transactions"
ADD COLUMN IF NOT EXISTS "entryOrigin" TEXT NOT NULL DEFAULT 'manual';

ALTER TABLE "property_transactions"
ADD COLUMN IF NOT EXISTS "entryOrigin" TEXT NOT NULL DEFAULT 'manual';

UPDATE "transactions"
SET "entryOrigin" = CASE
  WHEN "source" = 'excel_import' THEN 'excel_import'
  WHEN "source" = 'statement_import' THEN 'email_import'
  WHEN "source" = 'ai_import' THEN 'ai_import'
  WHEN "source" IN ('scheduled_task', 'loan_bill') THEN 'scheduled_task'
  ELSE 'manual'
END
WHERE "entryOrigin" = 'manual';

UPDATE "fund_transactions"
SET "entryOrigin" = CASE
  WHEN "source" = 'excel_import' THEN 'excel_import'
  WHEN "source" = 'ai_import' THEN 'ai_import'
  WHEN "source" = 'scheduled_task' THEN 'scheduled_task'
  ELSE 'manual'
END
WHERE "entryOrigin" = 'manual';

UPDATE "stock_transactions"
SET "entryOrigin" = CASE
  WHEN "source" = 'excel_import' THEN 'excel_import'
  ELSE 'manual'
END
WHERE "entryOrigin" = 'manual';

CREATE INDEX IF NOT EXISTS "transactions_entryOrigin_idx"
ON "transactions"("entryOrigin");

CREATE INDEX IF NOT EXISTS "fund_transactions_entryOrigin_idx"
ON "fund_transactions"("entryOrigin");

CREATE INDEX IF NOT EXISTS "stock_transactions_entryOrigin_idx"
ON "stock_transactions"("entryOrigin");
