CREATE TABLE IF NOT EXISTS "PreciousMetalType" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "shortName" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "householdId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreciousMetalType_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PreciousMetalUnit" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "symbol" TEXT,
  "decimals" INTEGER NOT NULL DEFAULT 3,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "householdId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreciousMetalUnit_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "metalTypeId" TEXT;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "metalTypeName" TEXT;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "metalUnitId" TEXT;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "metalUnitName" TEXT;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "metalQuantity" DECIMAL(20, 6);
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "metalUnitPrice" DECIMAL(20, 6);
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "metalFee" DECIMAL(18, 2);

CREATE TABLE IF NOT EXISTS "PreciousMetalHolding" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "metalTypeId" TEXT NOT NULL,
  "metalTypeName" TEXT NOT NULL,
  "metalUnitId" TEXT NOT NULL,
  "metalUnitName" TEXT NOT NULL,
  "quantity" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "avgCost" DECIMAL(20, 6) NOT NULL DEFAULT 0,
  "cost" DECIMAL(18, 2) NOT NULL DEFAULT 0,
  "unitPrice" DECIMAL(20, 6),
  "marketValue" DECIMAL(18, 2) NOT NULL DEFAULT 0,
  "historicalProfit" DECIMAL(18, 2) NOT NULL DEFAULT 0,
  "householdId" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreciousMetalHolding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PreciousMetalType_householdId_code_key" ON "PreciousMetalType"("householdId", "code");
CREATE INDEX IF NOT EXISTS "PreciousMetalType_householdId_isActive_sortOrder_idx" ON "PreciousMetalType"("householdId", "isActive", "sortOrder");
CREATE INDEX IF NOT EXISTS "PreciousMetalType_name_idx" ON "PreciousMetalType"("name");

CREATE UNIQUE INDEX IF NOT EXISTS "PreciousMetalUnit_householdId_code_key" ON "PreciousMetalUnit"("householdId", "code");
CREATE INDEX IF NOT EXISTS "PreciousMetalUnit_householdId_isActive_sortOrder_idx" ON "PreciousMetalUnit"("householdId", "isActive", "sortOrder");
CREATE INDEX IF NOT EXISTS "PreciousMetalUnit_name_idx" ON "PreciousMetalUnit"("name");

CREATE INDEX IF NOT EXISTS "transactions_metalTypeId_idx" ON "transactions"("metalTypeId");
CREATE INDEX IF NOT EXISTS "transactions_metalUnitId_idx" ON "transactions"("metalUnitId");

CREATE UNIQUE INDEX IF NOT EXISTS "PreciousMetalHolding_accountId_metalTypeId_metalUnitId_key" ON "PreciousMetalHolding"("accountId", "metalTypeId", "metalUnitId");
CREATE INDEX IF NOT EXISTS "PreciousMetalHolding_householdId_idx" ON "PreciousMetalHolding"("householdId");
CREATE INDEX IF NOT EXISTS "PreciousMetalHolding_accountId_idx" ON "PreciousMetalHolding"("accountId");
CREATE INDEX IF NOT EXISTS "PreciousMetalHolding_metalTypeId_idx" ON "PreciousMetalHolding"("metalTypeId");
CREATE INDEX IF NOT EXISTS "PreciousMetalHolding_metalUnitId_idx" ON "PreciousMetalHolding"("metalUnitId");

ALTER TABLE "PreciousMetalType" ADD CONSTRAINT "PreciousMetalType_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreciousMetalUnit" ADD CONSTRAINT "PreciousMetalUnit_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_metalTypeId_fkey" FOREIGN KEY ("metalTypeId") REFERENCES "PreciousMetalType"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_metalUnitId_fkey" FOREIGN KEY ("metalUnitId") REFERENCES "PreciousMetalUnit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PreciousMetalHolding" ADD CONSTRAINT "PreciousMetalHolding_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreciousMetalHolding" ADD CONSTRAINT "PreciousMetalHolding_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreciousMetalHolding" ADD CONSTRAINT "PreciousMetalHolding_metalTypeId_fkey" FOREIGN KEY ("metalTypeId") REFERENCES "PreciousMetalType"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreciousMetalHolding" ADD CONSTRAINT "PreciousMetalHolding_metalUnitId_fkey" FOREIGN KEY ("metalUnitId") REFERENCES "PreciousMetalUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "PreciousMetalType" ("id", "code", "name", "shortName", "sortOrder", "isSystem")
VALUES
  ('metal-type-gold', 'gold', '黄金', '金', 10, true),
  ('metal-type-silver', 'silver', '白银', '银', 20, true),
  ('metal-type-platinum', 'platinum', '铂金', '铂', 30, true),
  ('metal-type-palladium', 'palladium', '钯金', '钯', 40, true)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "PreciousMetalUnit" ("id", "code", "name", "symbol", "decimals", "sortOrder", "isSystem")
VALUES
  ('metal-unit-gram', 'gram', '克', 'g', 3, 10, true),
  ('metal-unit-kilogram', 'kilogram', '千克', 'kg', 6, 20, true),
  ('metal-unit-ounce', 'ounce', '盎司', 'oz', 6, 30, true),
  ('metal-unit-qian', 'qian', '钱', '钱', 3, 40, true)
ON CONFLICT ("id") DO NOTHING;
