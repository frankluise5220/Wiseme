-- Distinguish purchase-time installments from installments created for a posted statement.
CREATE TYPE "CreditCardInstallmentSourceType" AS ENUM ('transaction', 'statement');

ALTER TABLE "CreditCardInstallmentPlan"
  ADD COLUMN "sourceType" "CreditCardInstallmentSourceType" NOT NULL DEFAULT 'transaction',
  ADD COLUMN "sourceStatementMonth" VARCHAR(7),
  ALTER COLUMN "sourceEntryId" DROP NOT NULL;

CREATE INDEX "CreditCardInstallmentPlan_householdId_accountId_sourceType_sourceStatementMonth_status_idx"
  ON "CreditCardInstallmentPlan"("householdId", "accountId", "sourceType", "sourceStatementMonth", "status");
