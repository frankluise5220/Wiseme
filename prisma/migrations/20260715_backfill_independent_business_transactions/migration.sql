-- Backfill independent business transaction tables from existing investment TxRecord rows.
-- The source TxRecord remains as a compatibility projection while business semantics move to dedicated tables.

INSERT INTO "insurance_transactions" (
  "id",
  "householdId",
  "accountId",
  "cashAccountId",
  "cashEntryId",
  "insuranceProductId",
  "action",
  "source",
  "tradeDate",
  "postedAt",
  "amount",
  "fee",
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
  t."insuranceProductId",
  COALESCE(t."insuranceAction", CASE WHEN t."fundSubtype"::text = 'buy' THEN 'premium' ELSE 'refund' END),
  t."source",
  t."date",
  t."postedAt",
  ABS(t."amount"),
  t."fundFee",
  t."realizedProfit",
  t."note",
  t."deletedAt",
  t."createdAt",
  CURRENT_TIMESTAMP
FROM "transactions" t
LEFT JOIN LATERAL (
  SELECT l."cashEntryId"
  FROM "entry_business_links" l
  WHERE l."businessEntryId" = t."id"
    AND l."cashEntryId" IS NOT NULL
    AND l."deletedAt" IS NULL
  ORDER BY (l."cashEntryId" <> t."id") DESC
  LIMIT 1
) link ON TRUE
LEFT JOIN "transactions" cash ON cash."id" = link."cashEntryId"
WHERE t."householdId" IS NOT NULL
  AND t."type" = 'investment'
  AND (t."source" = 'insurance' OR t."insuranceProductId" IS NOT NULL)
  AND t."insuranceProductId" IS NOT NULL
ON CONFLICT ("id") DO UPDATE SET
  "accountId" = EXCLUDED."accountId",
  "cashAccountId" = EXCLUDED."cashAccountId",
  "cashEntryId" = EXCLUDED."cashEntryId",
  "insuranceProductId" = EXCLUDED."insuranceProductId",
  "action" = EXCLUDED."action",
  "source" = EXCLUDED."source",
  "tradeDate" = EXCLUDED."tradeDate",
  "postedAt" = EXCLUDED."postedAt",
  "amount" = EXCLUDED."amount",
  "fee" = EXCLUDED."fee",
  "realizedProfit" = EXCLUDED."realizedProfit",
  "note" = EXCLUDED."note",
  "deletedAt" = EXCLUDED."deletedAt",
  "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "wealth_transactions" (
  "id",
  "householdId",
  "accountId",
  "cashAccountId",
  "cashEntryId",
  "wealthProductId",
  "action",
  "source",
  "tradeDate",
  "confirmDate",
  "arrivalDate",
  "grossAmount",
  "arrivalAmount",
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
  COALESCE(t."fundSubtype", 'buy'::"FundSubtype"),
  t."source",
  t."date",
  t."fundConfirmDate",
  t."fundArrivalDate",
  ABS(t."amount"),
  CASE WHEN t."fundArrivalAmount" IS NULL THEN NULL ELSE ABS(t."fundArrivalAmount") END,
  t."depositInterest",
  t."fundFee",
  t."depositAnnualRate",
  t."realizedProfit",
  t."note",
  t."deletedAt",
  t."createdAt",
  CURRENT_TIMESTAMP
FROM "transactions" t
LEFT JOIN LATERAL (
  SELECT l."cashEntryId"
  FROM "entry_business_links" l
  WHERE l."businessEntryId" = t."id"
    AND l."cashEntryId" IS NOT NULL
    AND l."deletedAt" IS NULL
  ORDER BY (l."cashEntryId" <> t."id") DESC
  LIMIT 1
) link ON TRUE
LEFT JOIN "transactions" cash ON cash."id" = link."cashEntryId"
WHERE t."householdId" IS NOT NULL
  AND t."type" = 'investment'
  AND t."fundProductType"::text = 'wealth'
ON CONFLICT ("id") DO UPDATE SET
  "accountId" = EXCLUDED."accountId",
  "cashAccountId" = EXCLUDED."cashAccountId",
  "cashEntryId" = EXCLUDED."cashEntryId",
  "wealthProductId" = EXCLUDED."wealthProductId",
  "action" = EXCLUDED."action",
  "source" = EXCLUDED."source",
  "tradeDate" = EXCLUDED."tradeDate",
  "confirmDate" = EXCLUDED."confirmDate",
  "arrivalDate" = EXCLUDED."arrivalDate",
  "grossAmount" = EXCLUDED."grossAmount",
  "arrivalAmount" = EXCLUDED."arrivalAmount",
  "interest" = EXCLUDED."interest",
  "fee" = EXCLUDED."fee",
  "annualRate" = EXCLUDED."annualRate",
  "realizedProfit" = EXCLUDED."realizedProfit",
  "note" = EXCLUDED."note",
  "deletedAt" = EXCLUDED."deletedAt",
  "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "deposit_transactions" (
  "id",
  "householdId",
  "accountId",
  "cashAccountId",
  "cashEntryId",
  "sourceDepositTransactionId",
  "action",
  "source",
  "tradeDate",
  "maturityDate",
  "arrivalDate",
  "principalAmount",
  "arrivalAmount",
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
  t."depositSourceEntryId",
  COALESCE(t."fundSubtype", 'buy'::"FundSubtype"),
  t."source",
  t."date",
  CASE
    WHEN t."fundSubtype"::text IN ('redeem', 'switch_out', 'dividend_cash') THEN NULL
    ELSE t."fundArrivalDate"
  END,
  CASE
    WHEN t."fundSubtype"::text IN ('redeem', 'switch_out', 'dividend_cash') THEN t."fundArrivalDate"
    ELSE NULL
  END,
  ABS(t."amount"),
  CASE WHEN t."fundArrivalAmount" IS NULL THEN NULL ELSE ABS(t."fundArrivalAmount") END,
  t."depositInterest",
  t."fundFee",
  t."depositAnnualRate",
  t."realizedProfit",
  t."note",
  t."deletedAt",
  t."createdAt",
  CURRENT_TIMESTAMP
FROM "transactions" t
LEFT JOIN LATERAL (
  SELECT l."cashEntryId"
  FROM "entry_business_links" l
  WHERE l."businessEntryId" = t."id"
    AND l."cashEntryId" IS NOT NULL
    AND l."deletedAt" IS NULL
  ORDER BY (l."cashEntryId" <> t."id") DESC
  LIMIT 1
) link ON TRUE
LEFT JOIN "transactions" cash ON cash."id" = link."cashEntryId"
WHERE t."householdId" IS NOT NULL
  AND t."type" = 'investment'
  AND t."fundProductType"::text = 'deposit'
ON CONFLICT ("id") DO UPDATE SET
  "accountId" = EXCLUDED."accountId",
  "cashAccountId" = EXCLUDED."cashAccountId",
  "cashEntryId" = EXCLUDED."cashEntryId",
  "sourceDepositTransactionId" = EXCLUDED."sourceDepositTransactionId",
  "action" = EXCLUDED."action",
  "source" = EXCLUDED."source",
  "tradeDate" = EXCLUDED."tradeDate",
  "maturityDate" = EXCLUDED."maturityDate",
  "arrivalDate" = EXCLUDED."arrivalDate",
  "principalAmount" = EXCLUDED."principalAmount",
  "arrivalAmount" = EXCLUDED."arrivalAmount",
  "interest" = EXCLUDED."interest",
  "fee" = EXCLUDED."fee",
  "annualRate" = EXCLUDED."annualRate",
  "realizedProfit" = EXCLUDED."realizedProfit",
  "note" = EXCLUDED."note",
  "deletedAt" = EXCLUDED."deletedAt",
  "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "precious_metal_transactions" (
  "id",
  "householdId",
  "accountId",
  "cashAccountId",
  "cashEntryId",
  "metalTypeId",
  "metalTypeName",
  "metalUnitId",
  "metalUnitName",
  "action",
  "source",
  "tradeDate",
  "amount",
  "quantity",
  "unitPrice",
  "fee",
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
  t."metalTypeId",
  t."metalTypeName",
  t."metalUnitId",
  t."metalUnitName",
  COALESCE(t."fundSubtype", 'buy'::"FundSubtype"),
  t."source",
  t."date",
  ABS(t."amount"),
  t."metalQuantity",
  t."metalUnitPrice",
  t."metalFee",
  t."realizedProfit",
  t."note",
  t."deletedAt",
  t."createdAt",
  CURRENT_TIMESTAMP
FROM "transactions" t
LEFT JOIN LATERAL (
  SELECT l."cashEntryId"
  FROM "entry_business_links" l
  WHERE l."businessEntryId" = t."id"
    AND l."cashEntryId" IS NOT NULL
    AND l."deletedAt" IS NULL
  ORDER BY (l."cashEntryId" <> t."id") DESC
  LIMIT 1
) link ON TRUE
LEFT JOIN "transactions" cash ON cash."id" = link."cashEntryId"
WHERE t."householdId" IS NOT NULL
  AND t."type" = 'investment'
  AND (t."fundProductType"::text = 'metal' OR t."metalTypeId" IS NOT NULL)
  AND t."metalTypeId" IS NOT NULL
  AND t."metalUnitId" IS NOT NULL
  AND t."metalTypeName" IS NOT NULL
  AND t."metalUnitName" IS NOT NULL
ON CONFLICT ("id") DO UPDATE SET
  "accountId" = EXCLUDED."accountId",
  "cashAccountId" = EXCLUDED."cashAccountId",
  "cashEntryId" = EXCLUDED."cashEntryId",
  "metalTypeId" = EXCLUDED."metalTypeId",
  "metalTypeName" = EXCLUDED."metalTypeName",
  "metalUnitId" = EXCLUDED."metalUnitId",
  "metalUnitName" = EXCLUDED."metalUnitName",
  "action" = EXCLUDED."action",
  "source" = EXCLUDED."source",
  "tradeDate" = EXCLUDED."tradeDate",
  "amount" = EXCLUDED."amount",
  "quantity" = EXCLUDED."quantity",
  "unitPrice" = EXCLUDED."unitPrice",
  "fee" = EXCLUDED."fee",
  "realizedProfit" = EXCLUDED."realizedProfit",
  "note" = EXCLUDED."note",
  "deletedAt" = EXCLUDED."deletedAt",
  "updatedAt" = CURRENT_TIMESTAMP;

UPDATE "entry_business_links" l
SET "insuranceTransactionId" = it."id",
    "updatedAt" = CURRENT_TIMESTAMP
FROM "insurance_transactions" it
WHERE l."businessEntryId" = it."id"
  AND l."businessType" = 'insurance';

UPDATE "entry_business_links" l
SET "wealthTransactionId" = wt."id",
    "updatedAt" = CURRENT_TIMESTAMP
FROM "wealth_transactions" wt
WHERE l."businessEntryId" = wt."id"
  AND l."businessType" = 'wealth';

UPDATE "entry_business_links" l
SET "depositTransactionId" = dt."id",
    "updatedAt" = CURRENT_TIMESTAMP
FROM "deposit_transactions" dt
WHERE l."businessEntryId" = dt."id"
  AND l."businessType" = 'deposit';

UPDATE "entry_business_links" l
SET "preciousMetalTransactionId" = mt."id",
    "updatedAt" = CURRENT_TIMESTAMP
FROM "precious_metal_transactions" mt
WHERE l."businessEntryId" = mt."id"
  AND l."businessType" = 'metal';

UPDATE "entry_business_links" l
SET "fundTransactionId" = ft."id",
    "updatedAt" = CURRENT_TIMESTAMP
FROM "fund_transactions" ft
WHERE l."businessEntryId" = ft."cashEntryId"
  AND l."businessType" = 'fund';
