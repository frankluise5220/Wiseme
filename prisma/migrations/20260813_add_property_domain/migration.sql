DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'FundProductType' AND e.enumlabel = 'property'
  ) THEN
    ALTER TYPE "FundProductType" ADD VALUE 'property';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'EntryBusinessType' AND e.enumlabel = 'property'
  ) THEN
    ALTER TYPE "EntryBusinessType" ADD VALUE 'property';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PropertyTransactionAction') THEN
    CREATE TYPE "PropertyTransactionAction" AS ENUM ('purchase', 'improvement', 'sale');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "property_assets" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "propertyType" TEXT,
  "address" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "purchaseDate" TIMESTAMP(3),
  "purchasePrice" DECIMAL(18,2),
  "cost" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "marketValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "latestValuationDate" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'active',
  "note" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "property_assets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "property_valuations" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "propertyAssetId" TEXT NOT NULL,
  "valuationDate" TIMESTAMP(3) NOT NULL,
  "marketValue" DECIMAL(18,2) NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "property_valuations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "property_transactions" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "cashAccountId" TEXT,
  "cashEntryId" TEXT,
  "propertyAssetId" TEXT NOT NULL,
  "action" "PropertyTransactionAction" NOT NULL DEFAULT 'purchase',
  "source" TEXT DEFAULT 'manual',
  "tradeDate" TIMESTAMP(3) NOT NULL,
  "settlementDate" TIMESTAMP(3),
  "amount" DECIMAL(18,2) NOT NULL,
  "fee" DECIMAL(18,2),
  "tax" DECIMAL(18,2),
  "realizedProfit" DECIMAL(18,2),
  "note" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "property_transactions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "entry_business_links"
  ADD COLUMN IF NOT EXISTS "propertyTransactionId" TEXT;

CREATE INDEX IF NOT EXISTS "property_assets_householdId_accountId_idx"
  ON "property_assets"("householdId", "accountId");
CREATE INDEX IF NOT EXISTS "property_assets_householdId_status_idx"
  ON "property_assets"("householdId", "status");
CREATE INDEX IF NOT EXISTS "property_assets_accountId_idx"
  ON "property_assets"("accountId");
CREATE INDEX IF NOT EXISTS "property_assets_deletedAt_idx"
  ON "property_assets"("deletedAt");

CREATE INDEX IF NOT EXISTS "property_valuations_householdId_valuationDate_idx"
  ON "property_valuations"("householdId", "valuationDate");
CREATE INDEX IF NOT EXISTS "property_valuations_propertyAssetId_valuationDate_idx"
  ON "property_valuations"("propertyAssetId", "valuationDate");

CREATE UNIQUE INDEX IF NOT EXISTS "property_transactions_cashEntryId_key"
  ON "property_transactions"("cashEntryId")
  WHERE "cashEntryId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "property_transactions_householdId_accountId_tradeDate_idx"
  ON "property_transactions"("householdId", "accountId", "tradeDate");
CREATE INDEX IF NOT EXISTS "property_transactions_cashAccountId_tradeDate_idx"
  ON "property_transactions"("cashAccountId", "tradeDate");
CREATE INDEX IF NOT EXISTS "property_transactions_propertyAssetId_tradeDate_idx"
  ON "property_transactions"("propertyAssetId", "tradeDate");
CREATE INDEX IF NOT EXISTS "property_transactions_deletedAt_idx"
  ON "property_transactions"("deletedAt");
CREATE INDEX IF NOT EXISTS "entry_business_links_propertyTransactionId_idx"
  ON "entry_business_links"("propertyTransactionId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_assets_householdId_fkey') THEN
    ALTER TABLE "property_assets"
      ADD CONSTRAINT "property_assets_householdId_fkey"
      FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_assets_accountId_fkey') THEN
    ALTER TABLE "property_assets"
      ADD CONSTRAINT "property_assets_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_valuations_householdId_fkey') THEN
    ALTER TABLE "property_valuations"
      ADD CONSTRAINT "property_valuations_householdId_fkey"
      FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_valuations_propertyAssetId_fkey') THEN
    ALTER TABLE "property_valuations"
      ADD CONSTRAINT "property_valuations_propertyAssetId_fkey"
      FOREIGN KEY ("propertyAssetId") REFERENCES "property_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_transactions_householdId_fkey') THEN
    ALTER TABLE "property_transactions"
      ADD CONSTRAINT "property_transactions_householdId_fkey"
      FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_transactions_accountId_fkey') THEN
    ALTER TABLE "property_transactions"
      ADD CONSTRAINT "property_transactions_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_transactions_cashAccountId_fkey') THEN
    ALTER TABLE "property_transactions"
      ADD CONSTRAINT "property_transactions_cashAccountId_fkey"
      FOREIGN KEY ("cashAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_transactions_propertyAssetId_fkey') THEN
    ALTER TABLE "property_transactions"
      ADD CONSTRAINT "property_transactions_propertyAssetId_fkey"
      FOREIGN KEY ("propertyAssetId") REFERENCES "property_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_transactions_cashEntryId_fkey') THEN
    ALTER TABLE "property_transactions"
      ADD CONSTRAINT "property_transactions_cashEntryId_fkey"
      FOREIGN KEY ("cashEntryId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_business_links_propertyTransactionId_fkey') THEN
    ALTER TABLE "entry_business_links"
      ADD CONSTRAINT "entry_business_links_propertyTransactionId_fkey"
      FOREIGN KEY ("propertyTransactionId") REFERENCES "property_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
