ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "fundSourceEntryId" TEXT;

CREATE INDEX IF NOT EXISTS "transactions_fundSourceEntryId_idx"
  ON "transactions"("fundSourceEntryId");
