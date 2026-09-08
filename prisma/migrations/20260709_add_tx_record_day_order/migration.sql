ALTER TABLE "transactions"
ADD COLUMN IF NOT EXISTS "dayOrder" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "transactions_accountId_date_dayOrder_idx"
ON "transactions"("accountId", "date", "dayOrder");
