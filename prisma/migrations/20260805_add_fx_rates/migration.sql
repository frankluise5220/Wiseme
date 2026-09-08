ALTER TABLE "Household" ADD COLUMN "baseCurrency" TEXT NOT NULL DEFAULT 'CNY';

CREATE TABLE "FxRate" (
  "id" TEXT NOT NULL,
  "householdId" TEXT,
  "baseCurrency" TEXT NOT NULL,
  "quoteCurrency" TEXT NOT NULL,
  "rate" DECIMAL(20,8) NOT NULL,
  "rateDate" TIMESTAMP(3) NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FxRate_householdId_baseCurrency_quoteCurrency_rateDate_key"
  ON "FxRate"("householdId", "baseCurrency", "quoteCurrency", "rateDate");
CREATE INDEX "FxRate_baseCurrency_quoteCurrency_rateDate_idx"
  ON "FxRate"("baseCurrency", "quoteCurrency", "rateDate");
CREATE INDEX "FxRate_householdId_rateDate_idx"
  ON "FxRate"("householdId", "rateDate");

ALTER TABLE "FxRate"
  ADD CONSTRAINT "FxRate_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
