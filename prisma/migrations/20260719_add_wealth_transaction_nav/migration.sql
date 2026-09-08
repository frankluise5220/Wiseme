ALTER TABLE "wealth_transactions"
ADD COLUMN IF NOT EXISTS "nav" DECIMAL(18, 6);
