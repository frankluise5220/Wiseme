-- Repair historical investment rows after business transactions were split
-- from the cash ledger. Only rows whose account identity proves they are
-- wealth transactions are materialized; ambiguous rows stay unclassified.

UPDATE "fund_transactions" ft
SET "fundName" = fp."fundName",
    "updatedAt" = CURRENT_TIMESTAMP
FROM "FundProfile" fp
WHERE ft."fundCode" = fp."fundCode"
  AND (
    ft."fundName" IS NULL
    OR btrim(ft."fundName") = ''
    OR ft."fundName" = ft."fundCode"
  )
  AND fp."fundName" IS NOT NULL
  AND btrim(fp."fundName") <> '';

INSERT INTO "entry_business_links" (
  "id",
  "householdId",
  "cashEntryId",
  "businessEntryId",
  "fundTransactionId",
  "businessType",
  "linkType",
  "cashFlowDirection",
  "source",
  "note",
  "metadata",
  "deletedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  'ebl_' || cf."txRecordId" || '_fund_' || cf."fundTransactionId",
  ft."householdId",
  cf."txRecordId",
  NULL,
  cf."fundTransactionId",
  'fund'::"EntryBusinessType",
  'cash_flow'::"EntryBusinessLinkType",
  CASE
    WHEN cf."kind" IN ('buy_out', 'switch_in') THEN 'outflow'::"EntryCashFlowDirection"
    WHEN cf."kind" IN ('refund_in', 'redeem_in', 'dividend_in') THEN 'inflow'::"EntryCashFlowDirection"
    ELSE 'none'::"EntryCashFlowDirection"
  END,
  COALESCE(ft."source", 'manual'),
  'Repaired link to fund transaction',
  '{"splitRecord":true,"independentBusinessTransaction":true,"repairedBy":"20260903_z_repair_investment_business_sources"}'::jsonb,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "fund_transaction_cash_flows" cf
JOIN "fund_transactions" ft ON ft."id" = cf."fundTransactionId"
JOIN "transactions" cash ON cash."id" = cf."txRecordId"
WHERE ft."deletedAt" IS NULL
  AND cash."deletedAt" IS NULL
ON CONFLICT ("id") DO UPDATE SET
  "cashEntryId" = EXCLUDED."cashEntryId",
  "businessEntryId" = NULL,
  "fundTransactionId" = EXCLUDED."fundTransactionId",
  "businessType" = EXCLUDED."businessType",
  "linkType" = EXCLUDED."linkType",
  "cashFlowDirection" = EXCLUDED."cashFlowDirection",
  "source" = EXCLUDED."source",
  "note" = EXCLUDED."note",
  "metadata" = EXCLUDED."metadata",
  "deletedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "entry_business_links" (
  "id",
  "householdId",
  "cashEntryId",
  "businessEntryId",
  "fundTransactionId",
  "businessType",
  "linkType",
  "cashFlowDirection",
  "source",
  "note",
  "metadata",
  "deletedAt",
  "createdAt",
  "updatedAt"
)
SELECT
  'ebl_' || ft."cashEntryId" || '_fund_' || ft."id",
  ft."householdId",
  ft."cashEntryId",
  NULL,
  ft."id",
  'fund'::"EntryBusinessType",
  'cash_flow'::"EntryBusinessLinkType",
  CASE
    WHEN cash."amount" < 0 THEN 'outflow'::"EntryCashFlowDirection"
    WHEN cash."amount" > 0 THEN 'inflow'::"EntryCashFlowDirection"
    ELSE 'none'::"EntryCashFlowDirection"
  END,
  COALESCE(ft."source", 'manual'),
  'Repaired link to fund transaction',
  '{"splitRecord":true,"independentBusinessTransaction":true,"repairedBy":"20260903_z_repair_investment_business_sources"}'::jsonb,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "fund_transactions" ft
JOIN "transactions" cash ON cash."id" = ft."cashEntryId"
WHERE ft."deletedAt" IS NULL
  AND ft."cashEntryId" IS NOT NULL
  AND cash."deletedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "fund_transaction_cash_flows" cf
    WHERE cf."fundTransactionId" = ft."id"
  )
ON CONFLICT ("id") DO UPDATE SET
  "cashEntryId" = EXCLUDED."cashEntryId",
  "businessEntryId" = NULL,
  "fundTransactionId" = EXCLUDED."fundTransactionId",
  "businessType" = EXCLUDED."businessType",
  "linkType" = EXCLUDED."linkType",
  "cashFlowDirection" = EXCLUDED."cashFlowDirection",
  "source" = EXCLUDED."source",
  "note" = EXCLUDED."note",
  "metadata" = EXCLUDED."metadata",
  "deletedAt" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP;

WITH legacy_wealth AS (
  SELECT
    t."id",
    t."householdId",
    t."accountId",
    t."toAccountId",
    t."amount",
    t."fundCode",
    t."fundName",
    t."fundProductType",
    t."fundSubtype",
    t."source",
    t."entryOrigin",
    t."date",
    t."fundConfirmDate",
    t."fundArrivalDate",
    t."fundArrivalAmount",
    t."fundUnits",
    t."fundNav",
    t."fundFee",
    t."depositAnnualRate",
    t."depositInterest",
    t."realizedProfit",
    t."note",
    a."investProductType" AS "accountProductType",
    ta."investProductType" AS "toAccountProductType"
  FROM "transactions" t
  LEFT JOIN "Account" a ON a."id" = t."accountId"
  LEFT JOIN "Account" ta ON ta."id" = t."toAccountId"
  WHERE t."householdId" IS NOT NULL
    AND t."type" = 'investment'
    AND t."deletedAt" IS NULL
    AND (a."investProductType" = 'wealth' OR ta."investProductType" = 'wealth')
    AND NOT EXISTS (
      SELECT 1
      FROM "wealth_transactions" wt
      WHERE wt."id" = t."id"
         OR wt."cashEntryId" = t."id"
    )
)
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
  "entryOrigin",
  "tradeDate",
  "confirmDate",
  "arrivalDate",
  "grossAmount",
  "arrivalAmount",
  "units",
  "nav",
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
  lw."id",
  lw."householdId",
  CASE
    WHEN lw."accountProductType" = 'wealth' THEN lw."accountId"
    ELSE lw."toAccountId"
  END,
  CASE
    WHEN lw."accountProductType" = 'wealth' THEN lw."toAccountId"
    ELSE lw."accountId"
  END,
  lw."id",
  NULL,
  lw."fundName",
  CASE
    WHEN lw."fundSubtype" IS NOT NULL THEN lw."fundSubtype"
    WHEN lw."amount" < 0 THEN 'buy'::"FundSubtype"
    ELSE 'redeem'::"FundSubtype"
  END,
  COALESCE(lw."source", 'manual'),
  COALESCE(lw."entryOrigin", 'manual'),
  lw."date",
  COALESCE(lw."fundConfirmDate", lw."date"),
  lw."fundArrivalDate",
  CASE
    WHEN COALESCE(lw."fundSubtype"::text, CASE WHEN lw."amount" < 0 THEN 'buy' ELSE 'redeem' END) IN ('redeem', 'switch_out') THEN
      GREATEST(
        0,
        ABS(lw."amount") - COALESCE(lw."realizedProfit", COALESCE(lw."depositInterest", 0) - COALESCE(lw."fundFee", 0), 0)
      )
    ELSE ABS(lw."amount")
  END,
  CASE WHEN lw."fundArrivalAmount" IS NULL THEN NULL ELSE ABS(lw."fundArrivalAmount") END,
  lw."fundUnits",
  lw."fundNav",
  lw."depositInterest",
  lw."fundFee",
  lw."depositAnnualRate",
  lw."realizedProfit",
  lw."note",
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM legacy_wealth lw
ON CONFLICT ("id") DO NOTHING;

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
  "deletedAt",
  "createdAt",
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
  'Repaired link to wealth transaction',
  '{"splitRecord":true,"independentBusinessTransaction":true,"repairedBy":"20260903_z_repair_investment_business_sources"}'::jsonb,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "wealth_transactions" wt
JOIN "transactions" cash ON cash."id" = wt."cashEntryId"
WHERE wt."deletedAt" IS NULL
  AND wt."cashEntryId" IS NOT NULL
  AND cash."deletedAt" IS NULL
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
