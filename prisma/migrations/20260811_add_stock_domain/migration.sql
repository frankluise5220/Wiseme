-- Add an independent stock investment domain.
-- Stock records must not reuse fund business fields; cash linkage goes through
-- entry_business_links.stockTransactionId with businessType = stock.

DO $$ BEGIN
  ALTER TYPE "FundProductType" ADD VALUE 'stock';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TYPE "EntryBusinessType" ADD VALUE 'stock';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StockTransactionAction') THEN
    CREATE TYPE "StockTransactionAction" AS ENUM (
      'buy',
      'sell',
      'dividend',
      'bonus_share',
      'split_share',
      'merge_share',
      'fee_adjustment',
      'tax_adjustment'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StockFeeType') THEN
    CREATE TYPE "StockFeeType" AS ENUM (
      'commission',
      'stamp_tax',
      'transfer_fee',
      'exchange_fee',
      'regulatory_fee',
      'platform_fee',
      'other'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'StockTradeDirection') THEN
    CREATE TYPE "StockTradeDirection" AS ENUM ('buy', 'sell', 'both');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "stock_securities" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "market" TEXT NOT NULL,
  "stockCode" TEXT NOT NULL,
  "stockName" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "exchange" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_securities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "stock_holdings" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "securityId" TEXT NOT NULL,
  "market" TEXT NOT NULL,
  "stockCode" TEXT NOT NULL,
  "stockName" TEXT,
  "quantity" DECIMAL(20,6) NOT NULL DEFAULT 0,
  "avgCost" DECIMAL(20,6) NOT NULL DEFAULT 0,
  "cost" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "latestPrice" DECIMAL(20,6),
  "marketValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "historicalProfit" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_holdings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "stock_transactions" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "stockAccountId" TEXT NOT NULL,
  "cashAccountId" TEXT,
  "cashEntryId" TEXT,
  "securityId" TEXT,
  "market" TEXT NOT NULL,
  "stockCode" TEXT NOT NULL,
  "stockName" TEXT,
  "action" "StockTransactionAction" NOT NULL,
  "source" TEXT DEFAULT 'manual',
  "tradeDate" TIMESTAMP(3) NOT NULL,
  "settleDate" TIMESTAMP(3),
  "grossAmount" DECIMAL(18,2) NOT NULL,
  "netAmount" DECIMAL(18,2),
  "quantity" DECIMAL(20,6),
  "price" DECIMAL(20,6),
  "fee" DECIMAL(18,2),
  "commission" DECIMAL(18,2),
  "stampTax" DECIMAL(18,2),
  "transferFee" DECIMAL(18,2),
  "exchangeFee" DECIMAL(18,2),
  "regulatoryFee" DECIMAL(18,2),
  "otherFee" DECIMAL(18,2),
  "realizedProfit" DECIMAL(18,2),
  "externalLinkId" TEXT,
  "brokerTradeId" TEXT,
  "note" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "stock_price_cache" (
  "id" TEXT NOT NULL,
  "securityId" TEXT,
  "market" TEXT NOT NULL,
  "stockCode" TEXT NOT NULL,
  "priceDate" TIMESTAMP(3) NOT NULL,
  "closePrice" DECIMAL(20,6) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "source" TEXT NOT NULL DEFAULT 'manual',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_price_cache_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "stock_fee_rules" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "securityId" TEXT,
  "market" TEXT,
  "stockCode" TEXT,
  "feeType" "StockFeeType" NOT NULL,
  "direction" "StockTradeDirection" NOT NULL DEFAULT 'both',
  "rate" DECIMAL(12,8),
  "amount" DECIMAL(18,2),
  "minAmount" DECIMAL(18,2),
  "currency" TEXT NOT NULL DEFAULT 'CNY',
  "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stock_fee_rules_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "entry_business_links" ADD COLUMN IF NOT EXISTS "stockTransactionId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "stock_securities_householdId_market_stockCode_key"
  ON "stock_securities"("householdId", "market", "stockCode");
CREATE INDEX IF NOT EXISTS "stock_securities_householdId_stockName_idx"
  ON "stock_securities"("householdId", "stockName");
CREATE INDEX IF NOT EXISTS "stock_securities_market_stockCode_idx"
  ON "stock_securities"("market", "stockCode");

CREATE UNIQUE INDEX IF NOT EXISTS "stock_holdings_accountId_securityId_key"
  ON "stock_holdings"("accountId", "securityId");
CREATE INDEX IF NOT EXISTS "stock_holdings_householdId_accountId_idx"
  ON "stock_holdings"("householdId", "accountId");
CREATE INDEX IF NOT EXISTS "stock_holdings_accountId_idx"
  ON "stock_holdings"("accountId");
CREATE INDEX IF NOT EXISTS "stock_holdings_securityId_idx"
  ON "stock_holdings"("securityId");
CREATE INDEX IF NOT EXISTS "stock_holdings_market_stockCode_idx"
  ON "stock_holdings"("market", "stockCode");

CREATE UNIQUE INDEX IF NOT EXISTS "stock_transactions_cashEntryId_key"
  ON "stock_transactions"("cashEntryId");
CREATE UNIQUE INDEX IF NOT EXISTS "stock_transactions_householdId_stockAccountId_externalLinkId_key"
  ON "stock_transactions"("householdId", "stockAccountId", "externalLinkId");
CREATE INDEX IF NOT EXISTS "stock_transactions_householdId_stockAccountId_tradeDate_idx"
  ON "stock_transactions"("householdId", "stockAccountId", "tradeDate");
CREATE INDEX IF NOT EXISTS "stock_transactions_cashAccountId_tradeDate_idx"
  ON "stock_transactions"("cashAccountId", "tradeDate");
CREATE INDEX IF NOT EXISTS "stock_transactions_securityId_tradeDate_idx"
  ON "stock_transactions"("securityId", "tradeDate");
CREATE INDEX IF NOT EXISTS "stock_transactions_market_stockCode_tradeDate_idx"
  ON "stock_transactions"("market", "stockCode", "tradeDate");
CREATE INDEX IF NOT EXISTS "stock_transactions_brokerTradeId_idx"
  ON "stock_transactions"("brokerTradeId");
CREATE INDEX IF NOT EXISTS "stock_transactions_deletedAt_idx"
  ON "stock_transactions"("deletedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "stock_price_cache_market_stockCode_priceDate_key"
  ON "stock_price_cache"("market", "stockCode", "priceDate");
CREATE INDEX IF NOT EXISTS "stock_price_cache_securityId_priceDate_idx"
  ON "stock_price_cache"("securityId", "priceDate");
CREATE INDEX IF NOT EXISTS "stock_price_cache_priceDate_idx"
  ON "stock_price_cache"("priceDate");

CREATE INDEX IF NOT EXISTS "stock_fee_rules_accountId_feeType_direction_idx"
  ON "stock_fee_rules"("accountId", "feeType", "direction");
CREATE INDEX IF NOT EXISTS "stock_fee_rules_accountId_securityId_feeType_direction_idx"
  ON "stock_fee_rules"("accountId", "securityId", "feeType", "direction");
CREATE INDEX IF NOT EXISTS "stock_fee_rules_accountId_market_stockCode_feeType_direction_idx"
  ON "stock_fee_rules"("accountId", "market", "stockCode", "feeType", "direction");
CREATE INDEX IF NOT EXISTS "stock_fee_rules_effectiveDate_idx"
  ON "stock_fee_rules"("effectiveDate");
CREATE INDEX IF NOT EXISTS "entry_business_links_stockTransactionId_idx"
  ON "entry_business_links"("stockTransactionId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_securities_householdId_fkey') THEN
    ALTER TABLE "stock_securities"
      ADD CONSTRAINT "stock_securities_householdId_fkey"
      FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_holdings_householdId_fkey') THEN
    ALTER TABLE "stock_holdings"
      ADD CONSTRAINT "stock_holdings_householdId_fkey"
      FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_holdings_accountId_fkey') THEN
    ALTER TABLE "stock_holdings"
      ADD CONSTRAINT "stock_holdings_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_holdings_securityId_fkey') THEN
    ALTER TABLE "stock_holdings"
      ADD CONSTRAINT "stock_holdings_securityId_fkey"
      FOREIGN KEY ("securityId") REFERENCES "stock_securities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_transactions_householdId_fkey') THEN
    ALTER TABLE "stock_transactions"
      ADD CONSTRAINT "stock_transactions_householdId_fkey"
      FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_transactions_stockAccountId_fkey') THEN
    ALTER TABLE "stock_transactions"
      ADD CONSTRAINT "stock_transactions_stockAccountId_fkey"
      FOREIGN KEY ("stockAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_transactions_cashAccountId_fkey') THEN
    ALTER TABLE "stock_transactions"
      ADD CONSTRAINT "stock_transactions_cashAccountId_fkey"
      FOREIGN KEY ("cashAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_transactions_securityId_fkey') THEN
    ALTER TABLE "stock_transactions"
      ADD CONSTRAINT "stock_transactions_securityId_fkey"
      FOREIGN KEY ("securityId") REFERENCES "stock_securities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_price_cache_securityId_fkey') THEN
    ALTER TABLE "stock_price_cache"
      ADD CONSTRAINT "stock_price_cache_securityId_fkey"
      FOREIGN KEY ("securityId") REFERENCES "stock_securities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_fee_rules_accountId_fkey') THEN
    ALTER TABLE "stock_fee_rules"
      ADD CONSTRAINT "stock_fee_rules_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_fee_rules_securityId_fkey') THEN
    ALTER TABLE "stock_fee_rules"
      ADD CONSTRAINT "stock_fee_rules_securityId_fkey"
      FOREIGN KEY ("securityId") REFERENCES "stock_securities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_business_links_stockTransactionId_fkey') THEN
    ALTER TABLE "entry_business_links"
      ADD CONSTRAINT "entry_business_links_stockTransactionId_fkey"
      FOREIGN KEY ("stockTransactionId") REFERENCES "stock_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
