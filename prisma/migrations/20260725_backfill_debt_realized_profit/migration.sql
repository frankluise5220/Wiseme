UPDATE "transactions"
SET "realizedProfit" = CASE
  WHEN "source" = 'debt_collect_in' THEN ABS(COALESCE("debtInterestAmount", 0))
  WHEN "source" IN ('debt_repay_out', 'debt_prepay_out', 'debt_lend_out', 'scheduled_task') THEN -ABS(COALESCE("debtInterestAmount", 0))
  ELSE "realizedProfit"
END
WHERE "deletedAt" IS NULL
  AND "type" = 'transfer'
  AND "debtInterestAmount" IS NOT NULL
  AND COALESCE("debtInterestAmount", 0) <> 0
  AND "realizedProfit" IS NULL;
