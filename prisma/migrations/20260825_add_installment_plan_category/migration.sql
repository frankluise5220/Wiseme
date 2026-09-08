-- Persist the installment category on the plan so lazily materialized
-- payment/fee rows inherit the correct category instead of "uncategorized".
ALTER TABLE "CreditCardInstallmentPlan"
  ADD COLUMN "categoryId" TEXT,
  ADD COLUMN "categoryName" TEXT;
