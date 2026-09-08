-- Account usage frequency tracking, used to order account selectors in the
-- entry ("record a transaction") forms by most-used-first on Web and Android.
ALTER TABLE "Account"
  ADD COLUMN IF NOT EXISTS "usageCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP(3);
