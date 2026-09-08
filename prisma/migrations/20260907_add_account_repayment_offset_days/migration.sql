-- Add Account.repaymentOffsetDays: credit-card repayment day as N days after the
-- statement day (mutually exclusive with the fixed repaymentDay)
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "repaymentOffsetDays" INTEGER;
