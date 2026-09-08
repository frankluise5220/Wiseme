-- Structured credit-card installment plans and their generated bill entries.
CREATE TYPE "CreditCardInstallmentRateType" AS ENUM ('annual_interest', 'period_fee');
CREATE TYPE "CreditCardInstallmentStatus" AS ENUM ('active', 'completed', 'cancelled');

CREATE TABLE "CreditCardInstallmentPlan" (
    "id" TEXT NOT NULL,
    "householdId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sourceEntryId" TEXT NOT NULL,
    "originalAmount" DECIMAL(18,2) NOT NULL,
    "installmentPrincipal" DECIMAL(18,2) NOT NULL,
    "totalRuns" INTEGER NOT NULL,
    "rateType" "CreditCardInstallmentRateType" NOT NULL,
    "rate" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "firstStatementMonth" VARCHAR(7) NOT NULL,
    "status" "CreditCardInstallmentStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditCardInstallmentPlan_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "transactions"
  ADD COLUMN "creditCardInstallmentPlanId" TEXT,
  ADD COLUMN "installmentNo" INTEGER,
  ADD COLUMN "installmentTotal" INTEGER,
  ADD COLUMN "installmentPrincipal" DECIMAL(18,2),
  ADD COLUMN "installmentInterest" DECIMAL(18,2),
  ADD COLUMN "installmentRole" TEXT;

CREATE UNIQUE INDEX "CreditCardInstallmentPlan_sourceEntryId_key" ON "CreditCardInstallmentPlan"("sourceEntryId");
CREATE INDEX "CreditCardInstallmentPlan_householdId_accountId_status_idx" ON "CreditCardInstallmentPlan"("householdId", "accountId", "status");
CREATE INDEX "CreditCardInstallmentPlan_firstStatementMonth_idx" ON "CreditCardInstallmentPlan"("firstStatementMonth");
CREATE INDEX "transactions_creditCardInstallmentPlanId_installmentNo_idx" ON "transactions"("creditCardInstallmentPlanId", "installmentNo");

ALTER TABLE "CreditCardInstallmentPlan" ADD CONSTRAINT "CreditCardInstallmentPlan_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditCardInstallmentPlan" ADD CONSTRAINT "CreditCardInstallmentPlan_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditCardInstallmentPlan" ADD CONSTRAINT "CreditCardInstallmentPlan_sourceEntryId_fkey" FOREIGN KEY ("sourceEntryId") REFERENCES "transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_creditCardInstallmentPlanId_fkey" FOREIGN KEY ("creditCardInstallmentPlanId") REFERENCES "CreditCardInstallmentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
