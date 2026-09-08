-- Split business-side transactions from cash ledger rows.
-- This keeps legacy TxRecord business links compatible while adding real business tables.

ALTER TABLE "entry_business_links"
  ADD COLUMN IF NOT EXISTS "fundTransactionId" TEXT,
  ADD COLUMN IF NOT EXISTS "insuranceTransactionId" TEXT,
  ADD COLUMN IF NOT EXISTS "wealthTransactionId" TEXT,
  ADD COLUMN IF NOT EXISTS "depositTransactionId" TEXT,
  ADD COLUMN IF NOT EXISTS "preciousMetalTransactionId" TEXT;

ALTER TABLE "entry_business_links"
  ALTER COLUMN "businessEntryId" DROP NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_business_links_businessEntryId_fkey') THEN
    ALTER TABLE "entry_business_links" DROP CONSTRAINT "entry_business_links_businessEntryId_fkey";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_business_links_businessEntryId_fkey') THEN
    ALTER TABLE "entry_business_links"
      ADD CONSTRAINT "entry_business_links_businessEntryId_fkey"
      FOREIGN KEY ("businessEntryId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fund_transactions_cashAccountId_fkey') THEN
    ALTER TABLE "fund_transactions"
      ADD CONSTRAINT "fund_transactions_cashAccountId_fkey"
      FOREIGN KEY ("cashAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "insurance_transactions" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "cashAccountId" TEXT,
  "cashEntryId" TEXT,
  "insuranceProductId" TEXT NOT NULL,
  "action" TEXT NOT NULL DEFAULT 'premium',
  "source" TEXT DEFAULT 'manual',
  "tradeDate" TIMESTAMP(3) NOT NULL,
  "postedAt" TIMESTAMP(3),
  "amount" DECIMAL(18,2) NOT NULL,
  "fee" DECIMAL(18,2),
  "realizedProfit" DECIMAL(18,2),
  "note" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "insurance_transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "wealth_transactions" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "cashAccountId" TEXT,
  "cashEntryId" TEXT,
  "wealthProductId" TEXT,
  "action" "FundSubtype" NOT NULL DEFAULT 'buy',
  "source" TEXT DEFAULT 'manual',
  "tradeDate" TIMESTAMP(3) NOT NULL,
  "confirmDate" TIMESTAMP(3),
  "arrivalDate" TIMESTAMP(3),
  "grossAmount" DECIMAL(18,2) NOT NULL,
  "arrivalAmount" DECIMAL(18,2),
  "interest" DECIMAL(18,2),
  "fee" DECIMAL(18,2),
  "annualRate" DECIMAL(10,6),
  "realizedProfit" DECIMAL(18,2),
  "note" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wealth_transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "deposit_transactions" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "cashAccountId" TEXT,
  "cashEntryId" TEXT,
  "sourceDepositTransactionId" TEXT,
  "action" "FundSubtype" NOT NULL DEFAULT 'buy',
  "source" TEXT DEFAULT 'manual',
  "tradeDate" TIMESTAMP(3) NOT NULL,
  "maturityDate" TIMESTAMP(3),
  "arrivalDate" TIMESTAMP(3),
  "principalAmount" DECIMAL(18,2) NOT NULL,
  "arrivalAmount" DECIMAL(18,2),
  "interest" DECIMAL(18,2),
  "fee" DECIMAL(18,2),
  "annualRate" DECIMAL(10,6),
  "realizedProfit" DECIMAL(18,2),
  "note" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deposit_transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "precious_metal_transactions" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "cashAccountId" TEXT,
  "cashEntryId" TEXT,
  "metalTypeId" TEXT NOT NULL,
  "metalTypeName" TEXT NOT NULL,
  "metalUnitId" TEXT NOT NULL,
  "metalUnitName" TEXT NOT NULL,
  "action" "FundSubtype" NOT NULL DEFAULT 'buy',
  "source" TEXT DEFAULT 'manual',
  "tradeDate" TIMESTAMP(3) NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "quantity" DECIMAL(20,6),
  "unitPrice" DECIMAL(20,6),
  "fee" DECIMAL(18,2),
  "realizedProfit" DECIMAL(18,2),
  "note" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "precious_metal_transactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "insurance_transactions_cashEntryId_key" ON "insurance_transactions"("cashEntryId");
CREATE INDEX IF NOT EXISTS "insurance_transactions_householdId_accountId_tradeDate_idx" ON "insurance_transactions"("householdId", "accountId", "tradeDate");
CREATE INDEX IF NOT EXISTS "insurance_transactions_cashAccountId_tradeDate_idx" ON "insurance_transactions"("cashAccountId", "tradeDate");
CREATE INDEX IF NOT EXISTS "insurance_transactions_insuranceProductId_tradeDate_idx" ON "insurance_transactions"("insuranceProductId", "tradeDate");
CREATE INDEX IF NOT EXISTS "insurance_transactions_deletedAt_idx" ON "insurance_transactions"("deletedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "wealth_transactions_cashEntryId_key" ON "wealth_transactions"("cashEntryId");
CREATE INDEX IF NOT EXISTS "wealth_transactions_householdId_accountId_tradeDate_idx" ON "wealth_transactions"("householdId", "accountId", "tradeDate");
CREATE INDEX IF NOT EXISTS "wealth_transactions_cashAccountId_tradeDate_idx" ON "wealth_transactions"("cashAccountId", "tradeDate");
CREATE INDEX IF NOT EXISTS "wealth_transactions_wealthProductId_tradeDate_idx" ON "wealth_transactions"("wealthProductId", "tradeDate");
CREATE INDEX IF NOT EXISTS "wealth_transactions_deletedAt_idx" ON "wealth_transactions"("deletedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "deposit_transactions_cashEntryId_key" ON "deposit_transactions"("cashEntryId");
CREATE INDEX IF NOT EXISTS "deposit_transactions_householdId_accountId_tradeDate_idx" ON "deposit_transactions"("householdId", "accountId", "tradeDate");
CREATE INDEX IF NOT EXISTS "deposit_transactions_cashAccountId_tradeDate_idx" ON "deposit_transactions"("cashAccountId", "tradeDate");
CREATE INDEX IF NOT EXISTS "deposit_transactions_sourceDepositTransactionId_idx" ON "deposit_transactions"("sourceDepositTransactionId");
CREATE INDEX IF NOT EXISTS "deposit_transactions_deletedAt_idx" ON "deposit_transactions"("deletedAt");

CREATE UNIQUE INDEX IF NOT EXISTS "precious_metal_transactions_cashEntryId_key" ON "precious_metal_transactions"("cashEntryId");
CREATE INDEX IF NOT EXISTS "precious_metal_transactions_householdId_accountId_tradeDate_idx" ON "precious_metal_transactions"("householdId", "accountId", "tradeDate");
CREATE INDEX IF NOT EXISTS "precious_metal_transactions_cashAccountId_tradeDate_idx" ON "precious_metal_transactions"("cashAccountId", "tradeDate");
CREATE INDEX IF NOT EXISTS "precious_metal_transactions_metalTypeId_metalUnitId_tradeDate_idx" ON "precious_metal_transactions"("metalTypeId", "metalUnitId", "tradeDate");
CREATE INDEX IF NOT EXISTS "precious_metal_transactions_deletedAt_idx" ON "precious_metal_transactions"("deletedAt");

CREATE INDEX IF NOT EXISTS "entry_business_links_fundTransactionId_idx" ON "entry_business_links"("fundTransactionId");
CREATE INDEX IF NOT EXISTS "entry_business_links_insuranceTransactionId_idx" ON "entry_business_links"("insuranceTransactionId");
CREATE INDEX IF NOT EXISTS "entry_business_links_wealthTransactionId_idx" ON "entry_business_links"("wealthTransactionId");
CREATE INDEX IF NOT EXISTS "entry_business_links_depositTransactionId_idx" ON "entry_business_links"("depositTransactionId");
CREATE INDEX IF NOT EXISTS "entry_business_links_preciousMetalTransactionId_idx" ON "entry_business_links"("preciousMetalTransactionId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'insurance_transactions_householdId_fkey') THEN
    ALTER TABLE "insurance_transactions" ADD CONSTRAINT "insurance_transactions_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'insurance_transactions_accountId_fkey') THEN
    ALTER TABLE "insurance_transactions" ADD CONSTRAINT "insurance_transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'insurance_transactions_cashAccountId_fkey') THEN
    ALTER TABLE "insurance_transactions" ADD CONSTRAINT "insurance_transactions_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'insurance_transactions_insuranceProductId_fkey') THEN
    ALTER TABLE "insurance_transactions" ADD CONSTRAINT "insurance_transactions_insuranceProductId_fkey" FOREIGN KEY ("insuranceProductId") REFERENCES "InsuranceProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_transactions_householdId_fkey') THEN
    ALTER TABLE "wealth_transactions" ADD CONSTRAINT "wealth_transactions_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_transactions_accountId_fkey') THEN
    ALTER TABLE "wealth_transactions" ADD CONSTRAINT "wealth_transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_transactions_cashAccountId_fkey') THEN
    ALTER TABLE "wealth_transactions" ADD CONSTRAINT "wealth_transactions_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wealth_transactions_wealthProductId_fkey') THEN
    ALTER TABLE "wealth_transactions" ADD CONSTRAINT "wealth_transactions_wealthProductId_fkey" FOREIGN KEY ("wealthProductId") REFERENCES "WealthProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deposit_transactions_householdId_fkey') THEN
    ALTER TABLE "deposit_transactions" ADD CONSTRAINT "deposit_transactions_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deposit_transactions_accountId_fkey') THEN
    ALTER TABLE "deposit_transactions" ADD CONSTRAINT "deposit_transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deposit_transactions_cashAccountId_fkey') THEN
    ALTER TABLE "deposit_transactions" ADD CONSTRAINT "deposit_transactions_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deposit_transactions_sourceDepositTransactionId_fkey') THEN
    ALTER TABLE "deposit_transactions" ADD CONSTRAINT "deposit_transactions_sourceDepositTransactionId_fkey" FOREIGN KEY ("sourceDepositTransactionId") REFERENCES "deposit_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'precious_metal_transactions_householdId_fkey') THEN
    ALTER TABLE "precious_metal_transactions" ADD CONSTRAINT "precious_metal_transactions_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'precious_metal_transactions_accountId_fkey') THEN
    ALTER TABLE "precious_metal_transactions" ADD CONSTRAINT "precious_metal_transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'precious_metal_transactions_cashAccountId_fkey') THEN
    ALTER TABLE "precious_metal_transactions" ADD CONSTRAINT "precious_metal_transactions_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'precious_metal_transactions_metalTypeId_fkey') THEN
    ALTER TABLE "precious_metal_transactions" ADD CONSTRAINT "precious_metal_transactions_metalTypeId_fkey" FOREIGN KEY ("metalTypeId") REFERENCES "PreciousMetalType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'precious_metal_transactions_metalUnitId_fkey') THEN
    ALTER TABLE "precious_metal_transactions" ADD CONSTRAINT "precious_metal_transactions_metalUnitId_fkey" FOREIGN KEY ("metalUnitId") REFERENCES "PreciousMetalUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_business_links_fundTransactionId_fkey') THEN
    ALTER TABLE "entry_business_links" ADD CONSTRAINT "entry_business_links_fundTransactionId_fkey" FOREIGN KEY ("fundTransactionId") REFERENCES "fund_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_business_links_insuranceTransactionId_fkey') THEN
    ALTER TABLE "entry_business_links" ADD CONSTRAINT "entry_business_links_insuranceTransactionId_fkey" FOREIGN KEY ("insuranceTransactionId") REFERENCES "insurance_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_business_links_wealthTransactionId_fkey') THEN
    ALTER TABLE "entry_business_links" ADD CONSTRAINT "entry_business_links_wealthTransactionId_fkey" FOREIGN KEY ("wealthTransactionId") REFERENCES "wealth_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_business_links_depositTransactionId_fkey') THEN
    ALTER TABLE "entry_business_links" ADD CONSTRAINT "entry_business_links_depositTransactionId_fkey" FOREIGN KEY ("depositTransactionId") REFERENCES "deposit_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entry_business_links_preciousMetalTransactionId_fkey') THEN
    ALTER TABLE "entry_business_links" ADD CONSTRAINT "entry_business_links_preciousMetalTransactionId_fkey" FOREIGN KEY ("preciousMetalTransactionId") REFERENCES "precious_metal_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
