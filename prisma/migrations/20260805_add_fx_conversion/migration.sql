CREATE TABLE "FxConversion" (
  "id" TEXT NOT NULL,
  "date" TIMESTAMP(3) NOT NULL,
  "householdId" TEXT NOT NULL,
  "fromEntryId" TEXT NOT NULL,
  "toEntryId" TEXT NOT NULL,
  "fromAccountId" TEXT NOT NULL,
  "toAccountId" TEXT NOT NULL,
  "fromCurrency" TEXT NOT NULL,
  "toCurrency" TEXT NOT NULL,
  "fromAmount" DECIMAL(18,2) NOT NULL,
  "toAmount" DECIMAL(18,2) NOT NULL,
  "exchangeRate" DECIMAL(20,8) NOT NULL,
  "feeAmount" DECIMAL(18,2),
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FxConversion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FxConversion_fromEntryId_key" ON "FxConversion"("fromEntryId");
CREATE UNIQUE INDEX "FxConversion_toEntryId_key" ON "FxConversion"("toEntryId");
CREATE INDEX "FxConversion_householdId_date_idx" ON "FxConversion"("householdId", "date");
CREATE INDEX "FxConversion_fromAccountId_date_idx" ON "FxConversion"("fromAccountId", "date");
CREATE INDEX "FxConversion_toAccountId_date_idx" ON "FxConversion"("toAccountId", "date");
CREATE INDEX "FxConversion_fromCurrency_toCurrency_idx" ON "FxConversion"("fromCurrency", "toCurrency");

ALTER TABLE "FxConversion"
  ADD CONSTRAINT "FxConversion_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FxConversion"
  ADD CONSTRAINT "FxConversion_fromAccountId_fkey"
  FOREIGN KEY ("fromAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FxConversion"
  ADD CONSTRAINT "FxConversion_toAccountId_fkey"
  FOREIGN KEY ("toAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FxConversion"
  ADD CONSTRAINT "FxConversion_fromEntryId_fkey"
  FOREIGN KEY ("fromEntryId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FxConversion"
  ADD CONSTRAINT "FxConversion_toEntryId_fkey"
  FOREIGN KEY ("toEntryId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
