-- Store stock market default fee rules and public brokerage catalog metadata.
-- Account-specific commission overrides stay in stock_fee_rules.

CREATE TABLE IF NOT EXISTS "stock_market_fee_rules" (
  "id" TEXT NOT NULL,
  "householdId" TEXT,
  "market" TEXT NOT NULL,
  "stockCode" TEXT,
  "feeType" "StockFeeType" NOT NULL,
  "direction" "StockTradeDirection" NOT NULL DEFAULT 'both',
  "rate" DECIMAL(12,8),
  "amount" DECIMAL(18,2),
  "minAmount" DECIMAL(18,2),
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL DEFAULT 'system',
  "sourceUrl" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_market_fee_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "stock_brokerage_catalog" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "shortName" TEXT,
  "aliases" JSONB,
  "registryCode" TEXT,
  "officialWebsite" TEXT,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "sourceUrl" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3),
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_brokerage_catalog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "stock_market_fee_rules_householdId_market_stockCode_feeType_direction_idx"
  ON "stock_market_fee_rules"("householdId", "market", "stockCode", "feeType", "direction");
CREATE INDEX IF NOT EXISTS "stock_market_fee_rules_market_stockCode_feeType_direction_idx"
  ON "stock_market_fee_rules"("market", "stockCode", "feeType", "direction");
CREATE INDEX IF NOT EXISTS "stock_market_fee_rules_effectiveDate_idx"
  ON "stock_market_fee_rules"("effectiveDate");

CREATE UNIQUE INDEX IF NOT EXISTS "stock_brokerage_catalog_name_key"
  ON "stock_brokerage_catalog"("name");
CREATE INDEX IF NOT EXISTS "stock_brokerage_catalog_shortName_idx"
  ON "stock_brokerage_catalog"("shortName");
CREATE INDEX IF NOT EXISTS "stock_brokerage_catalog_registryCode_idx"
  ON "stock_brokerage_catalog"("registryCode");
CREATE INDEX IF NOT EXISTS "stock_brokerage_catalog_isActive_idx"
  ON "stock_brokerage_catalog"("isActive");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_market_fee_rules_householdId_fkey') THEN
    ALTER TABLE "stock_market_fee_rules"
      ADD CONSTRAINT "stock_market_fee_rules_householdId_fkey"
      FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
