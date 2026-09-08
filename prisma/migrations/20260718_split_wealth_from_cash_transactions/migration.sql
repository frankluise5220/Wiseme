-- Make wealth transactions independent from cash ledger rows.
-- Existing wealth business fields are copied into wealth_transactions, linked through
-- entry_business_links, then cleared from the cash-side transactions row.

INSERT INTO "wealth_transactions" (
  "id",
  "householdId",
  "accountId",
  "cashAccountId",
  "cashEntryId",
  "wealthProductId",
  "productName",
  "action",
  "source",
  "tradeDate",
  "confirmDate",
  "arrivalDate",
  "grossAmount",
  "arrivalAmount",
  "units",
  "interest",
  "fee",
  "annualRate",
  "realizedProfit",
  "note",
  "deletedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  t."id",
  t."householdId",
  CASE
    WHEN t."fundSubtype"::text IN ('redeem', 'switch_out', 'dividend_cash') THEN t."accountId"
    WHEN t."toAccountId" IS NOT NULL THEN t."toAccountId"
    ELSE t."accountId"
  END,
  CASE
    WHEN cash."id" IS NOT NULL AND cash."id" <> t."id" THEN cash."accountId"
    WHEN t."fundSubtype"::text IN ('redeem', 'switch_out', 'dividend_cash') THEN t."toAccountId"
    WHEN t."toAccountId" IS NOT NULL THEN t."accountId"
    ELSE NULL
  END,
  COALESCE(link."cashEntryId", t."id"),
  t."wealthProductId",
  COALESCE(wp."name", t."fundName"),
  COALESCE(t."fundSubtype", 'buy'::"FundSubtype"),
  COALESCE(t."source", 'manual'),
  t."date",
  COALESCE(t."fundConfirmDate", t."date"),
  t."fundArrivalDate",
  CASE
    WHEN t."fundSubtype"::text IN ('redeem', 'switch_out') THEN
      GREATEST(
        0,
        ABS(COALESCE(t."fundArrivalAmount", t."amount"))
          - COALESCE(t."realizedProfit", COALESCE(t."depositInterest", 0) - COALESCE(t."fundFee", 0), 0)
      )
    ELSE ABS(t."amount")
  END,
  CASE WHEN t."fundArrivalAmount" IS NULL THEN NULL ELSE ABS(t."fundArrivalAmount") END,
  t."fundUnits",
  CASE
    WHEN t."fundSubtype"::text = 'dividend_cash' AND t."depositInterest" IS NULL THEN ABS(t."amount")
    ELSE t."depositInterest"
  END,
  t."fundFee",
  t."depositAnnualRate",
  CASE
    WHEN t."fundSubtype"::text = 'dividend_cash' AND t."realizedProfit" IS NULL THEN ABS(t."amount")
    ELSE t."realizedProfit"
  END,
  t."note",
  t."deletedAt",
  t."createdAt",
  CURRENT_TIMESTAMP
FROM "transactions" t
LEFT JOIN LATERAL (
  SELECT l."cashEntryId"
  FROM "entry_business_links" l
  WHERE l."businessType" = 'wealth'
    AND l."deletedAt" IS NULL
    AND (l."businessEntryId" = t."id" OR l."wealthTransactionId" = t."id")
    AND l."cashEntryId" IS NOT NULL
  ORDER BY (l."cashEntryId" <> t."id") DESC
  LIMIT 1
) link ON TRUE
LEFT JOIN "transactions" cash ON cash."id" = link."cashEntryId"
LEFT JOIN "WealthProduct" wp ON wp."id" = t."wealthProductId"
WHERE t."householdId" IS NOT NULL
  AND t."type" = 'investment'
  AND (t."fundProductType"::text = 'wealth' OR t."wealthProductId" IS NOT NULL)
ON CONFLICT ("id") DO UPDATE SET
  "accountId" = EXCLUDED."accountId",
  "cashAccountId" = EXCLUDED."cashAccountId",
  "cashEntryId" = EXCLUDED."cashEntryId",
  "wealthProductId" = EXCLUDED."wealthProductId",
  "productName" = EXCLUDED."productName",
  "action" = EXCLUDED."action",
  "source" = EXCLUDED."source",
  "tradeDate" = EXCLUDED."tradeDate",
  "confirmDate" = EXCLUDED."confirmDate",
  "arrivalDate" = EXCLUDED."arrivalDate",
  "grossAmount" = EXCLUDED."grossAmount",
  "arrivalAmount" = EXCLUDED."arrivalAmount",
  "units" = EXCLUDED."units",
  "interest" = EXCLUDED."interest",
  "fee" = EXCLUDED."fee",
  "annualRate" = EXCLUDED."annualRate",
  "realizedProfit" = EXCLUDED."realizedProfit",
  "note" = EXCLUDED."note",
  "deletedAt" = EXCLUDED."deletedAt",
  "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "entry_business_links" (
  "id",
  "householdId",
  "cashEntryId",
  "businessEntryId",
  "wealthTransactionId",
  "businessType",
  "linkType",
  "cashFlowDirection",
  "source",
  "note",
  "metadata",
  "updatedAt"
)
SELECT
  'ebl_' || wt."cashEntryId" || '_wealth_' || wt."id",
  wt."householdId",
  wt."cashEntryId",
  NULL,
  wt."id",
  'wealth'::"EntryBusinessType",
  'cash_flow'::"EntryBusinessLinkType",
  CASE
    WHEN cash."amount" < 0 THEN 'outflow'::"EntryCashFlowDirection"
    WHEN cash."amount" > 0 THEN 'inflow'::"EntryCashFlowDirection"
    ELSE 'none'::"EntryCashFlowDirection"
  END,
  COALESCE(wt."source", 'manual'),
  'Linked cash flow to wealth transaction',
  '{"splitRecord":true,"independentBusinessTransaction":true}'::jsonb,
  CURRENT_TIMESTAMP
FROM "wealth_transactions" wt
JOIN "transactions" cash ON cash."id" = wt."cashEntryId"
WHERE wt."cashEntryId" IS NOT NULL
ON CONFLICT ("id") DO UPDATE SET
  "cashEntryId" = EXCLUDED."cashEntryId",
  "businessEntryId" = NULL,
  "wealthTransactionId" = EXCLUDED."wealthTransactionId",
  "businessType" = EXCLUDED."businessType",
  "linkType" = EXCLUDED."linkType",
  "cashFlowDirection" = EXCLUDED."cashFlowDirection",
  "source" = EXCLUDED."source",
  "note" = EXCLUDED."note",
  "metadata" = EXCLUDED."metadata",
  "deletedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP;

UPDATE "entry_business_links" l
SET "deletedAt" = CURRENT_TIMESTAMP,
    "updatedAt" = CURRENT_TIMESTAMP
WHERE l."businessType" = 'wealth'
  AND l."linkType" = 'legacy_combined_record'
  AND l."deletedAt" IS NULL;

UPDATE "transactions" t
SET
  "fundCode" = NULL,
  "fundProductType" = NULL,
  "fundSubtype" = NULL,
  "fundName" = NULL,
  "wealthProductId" = NULL,
  "fundUnits" = NULL,
  "fundNav" = NULL,
  "fundFee" = NULL,
  "fundConfirmDate" = NULL,
  "fundArrivalDate" = NULL,
  "fundArrivalAmount" = NULL,
  "depositAnnualRate" = NULL,
  "depositInterest" = NULL,
  "realizedProfit" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE t."id" IN (
  SELECT wt."cashEntryId"
  FROM "wealth_transactions" wt
  WHERE wt."cashEntryId" IS NOT NULL
)
  AND (
    t."fundProductType"::text = 'wealth'
    OR t."wealthProductId" IS NOT NULL
  );
