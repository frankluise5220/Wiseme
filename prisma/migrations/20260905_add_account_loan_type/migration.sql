-- Add Account.loanType to classify loan accounts
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LoanType') THEN
    CREATE TYPE "LoanType" AS ENUM ('home', 'mortgage', 'consumer', 'other');
  END IF;
END
$$;

ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "loanType" "LoanType";

-- Backfill: consumer loans -> consumer, all other legacy loan accounts -> home
UPDATE "Account"
SET "loanType" = CASE
  WHEN "isConsumerLoan" = TRUE THEN 'consumer'::"LoanType"
  ELSE 'home'::"LoanType"
END
WHERE "kind" = 'loan';
