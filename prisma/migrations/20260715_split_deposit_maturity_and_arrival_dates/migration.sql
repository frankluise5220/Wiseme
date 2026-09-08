-- Keep deposit maturity and cash-arrival dates separate in the independent business table.
-- Legacy TxRecord.fundArrivalDate is still the compatibility projection, so split by action here.

UPDATE "deposit_transactions" dt
SET
  "arrivalDate" = t."fundArrivalDate",
  "maturityDate" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "transactions" t
WHERE t."id" = dt."id"
  AND dt."action"::text IN ('redeem', 'switch_out', 'dividend_cash')
  AND t."fundArrivalDate" IS NOT NULL;

UPDATE "deposit_transactions" dt
SET
  "maturityDate" = t."fundArrivalDate",
  "arrivalDate" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "transactions" t
WHERE t."id" = dt."id"
  AND dt."action"::text NOT IN ('redeem', 'switch_out', 'dividend_cash')
  AND t."fundArrivalDate" IS NOT NULL;
