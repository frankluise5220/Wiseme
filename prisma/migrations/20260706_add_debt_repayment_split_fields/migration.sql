-- Store loan repayment split on the single cash-side debit record.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "debtPrincipalAmount" DECIMAL(18, 2);
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "debtInterestAmount" DECIMAL(18, 2);
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "debtFeeAmount" DECIMAL(18, 2);

-- Backfill principal rows with the old principal amount first.
UPDATE "transactions"
SET "debtPrincipalAmount" = ABS("amount")
WHERE "deletedAt" IS NULL
  AND "type" = 'transfer'
  AND "source" IN ('debt_repay_out', 'debt_prepay_out', 'debt_collect_in', 'scheduled_task')
  AND "debtPrincipalAmount" IS NULL;

-- Move legacy loan interest/fee rows onto the matching principal transfer row.
WITH extras AS (
  SELECT
    COALESCE("regularInvestPlanId", '') AS plan_id,
    "accountId" AS cash_account_id,
    "toAccountId" AS debt_account_id,
    "date"::date AS tx_date,
    SUM(CASE WHEN "source" IN ('debt_repay_out_interest', 'debt_prepay_out_interest', 'debt_collect_in_interest') OR "categoryName" LIKE '%利息%' OR "note" LIKE '%利息%' THEN ABS("amount") ELSE 0 END) AS interest_amount,
    SUM(CASE WHEN "source" = 'debt_prepay_out_fee' OR "categoryName" LIKE '%手续费%' OR "note" LIKE '%违约金%' THEN ABS("amount") ELSE 0 END) AS fee_amount
  FROM "transactions"
  WHERE "deletedAt" IS NULL
    AND "type" <> 'transfer'
    AND (
      "source" IN ('debt_repay_out_interest', 'debt_prepay_out_interest', 'debt_collect_in_interest', 'debt_prepay_out_fee')
      OR ("source" = 'scheduled_task' AND ("categoryName" LIKE '%利息%' OR "note" LIKE '%利息%'))
    )
  GROUP BY COALESCE("regularInvestPlanId", ''), "accountId", "toAccountId", "date"::date
)
UPDATE "transactions" p
SET
  "debtInterestAmount" = COALESCE(p."debtInterestAmount", 0) + e.interest_amount,
  "debtFeeAmount" = COALESCE(p."debtFeeAmount", 0) + e.fee_amount,
  "amount" = CASE
    WHEN p."amount" < 0 THEN -1
    ELSE 1
  END * (COALESCE(p."debtPrincipalAmount", ABS(p."amount")) + e.interest_amount + e.fee_amount)
FROM extras e
WHERE p."deletedAt" IS NULL
  AND p."type" = 'transfer'
  AND p."source" IN ('debt_repay_out', 'debt_prepay_out', 'debt_collect_in', 'scheduled_task')
  AND COALESCE(p."regularInvestPlanId", '') = e.plan_id
  AND p."accountId" = e.cash_account_id
  AND (p."toAccountId" = e.debt_account_id OR e.debt_account_id IS NULL)
  AND p."date"::date = e.tx_date;

-- Soft-delete old split rows after their values have been copied.
UPDATE "transactions"
SET "deletedAt" = NOW()
WHERE "deletedAt" IS NULL
  AND "type" <> 'transfer'
  AND (
    "source" IN ('debt_repay_out_interest', 'debt_prepay_out_interest', 'debt_collect_in_interest', 'debt_prepay_out_fee')
    OR ("source" = 'scheduled_task' AND ("categoryName" LIKE '%利息%' OR "note" LIKE '%利息%'))
  )
  AND EXISTS (
    SELECT 1
    FROM "transactions" p
    WHERE p."deletedAt" IS NULL
      AND p."type" = 'transfer'
      AND p."source" IN ('debt_repay_out', 'debt_prepay_out', 'debt_collect_in', 'scheduled_task')
      AND COALESCE(p."regularInvestPlanId", '') = COALESCE("transactions"."regularInvestPlanId", '')
      AND p."accountId" = "transactions"."accountId"
      AND (p."toAccountId" = "transactions"."toAccountId" OR "transactions"."toAccountId" IS NULL)
      AND p."date"::date = "transactions"."date"::date
  );
