-- Split fund business transactions from cash ledger rows.
-- TxRecord remains the cash/debit ledger. fund_transactions owns fund order semantics.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FundCashFlowKind') THEN
    CREATE TYPE "FundCashFlowKind" AS ENUM ('buy_out', 'refund_in', 'redeem_in', 'dividend_in', 'dividend_reinvest_internal', 'switch_in', 'switch_out', 'other');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "fund_transactions" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "fundAccountId" TEXT NOT NULL,
  "cashAccountId" TEXT,
  "cashEntryId" TEXT,
  "fundCode" TEXT NOT NULL,
  "fundName" TEXT,
  "fundProductType" "FundProductType" NOT NULL DEFAULT 'fund',
  "fundSubtype" "FundSubtype" NOT NULL,
  "source" TEXT DEFAULT 'manual',
  "applyDate" TIMESTAMP(3) NOT NULL,
  "confirmDate" TIMESTAMP(3),
  "arrivalDate" TIMESTAMP(3),
  "grossAmount" DECIMAL(18,2) NOT NULL,
  "refundAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "arrivalAmount" DECIMAL(18,2),
  "fee" DECIMAL(18,2),
  "nav" DECIMAL(18,6),
  "units" DECIMAL(20,6),
  "realizedProfit" DECIMAL(18,2),
  "regularInvestPlanId" TEXT,
  "note" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fund_transactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "fund_transaction_cash_flows" (
  "id" TEXT NOT NULL,
  "fundTransactionId" TEXT NOT NULL,
  "txRecordId" TEXT NOT NULL,
  "kind" "FundCashFlowKind" NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "flowDate" TIMESTAMP(3) NOT NULL,
  "accountId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "fund_transaction_cash_flows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "fund_transactions_cashEntryId_key" ON "fund_transactions"("cashEntryId");
CREATE INDEX IF NOT EXISTS "fund_transactions_householdId_fundAccountId_fundCode_idx" ON "fund_transactions"("householdId", "fundAccountId", "fundCode");
CREATE INDEX IF NOT EXISTS "fund_transactions_cashEntryId_idx" ON "fund_transactions"("cashEntryId");
CREATE INDEX IF NOT EXISTS "fund_transactions_fundAccountId_applyDate_idx" ON "fund_transactions"("fundAccountId", "applyDate");
CREATE INDEX IF NOT EXISTS "fund_transactions_fundAccountId_fundCode_applyDate_idx" ON "fund_transactions"("fundAccountId", "fundCode", "applyDate");
CREATE INDEX IF NOT EXISTS "fund_transactions_deletedAt_idx" ON "fund_transactions"("deletedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "fund_transaction_cash_flows_txRecordId_key" ON "fund_transaction_cash_flows"("txRecordId");
CREATE INDEX IF NOT EXISTS "fund_transaction_cash_flows_fundTransactionId_idx" ON "fund_transaction_cash_flows"("fundTransactionId");
CREATE INDEX IF NOT EXISTS "fund_transaction_cash_flows_txRecordId_idx" ON "fund_transaction_cash_flows"("txRecordId");
CREATE INDEX IF NOT EXISTS "fund_transaction_cash_flows_accountId_flowDate_idx" ON "fund_transaction_cash_flows"("accountId", "flowDate");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fund_transactions_fundAccountId_fkey') THEN
    ALTER TABLE "fund_transactions"
      ADD CONSTRAINT "fund_transactions_fundAccountId_fkey"
      FOREIGN KEY ("fundAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fund_transactions_householdId_fkey') THEN
    ALTER TABLE "fund_transactions"
      ADD CONSTRAINT "fund_transactions_householdId_fkey"
      FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fund_transaction_cash_flows_fundTransactionId_fkey') THEN
    ALTER TABLE "fund_transaction_cash_flows"
      ADD CONSTRAINT "fund_transaction_cash_flows_fundTransactionId_fkey"
      FOREIGN KEY ("fundTransactionId") REFERENCES "fund_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

INSERT INTO "fund_transactions" (
  "id", "householdId", "fundAccountId", "cashAccountId", "cashEntryId",
  "fundCode", "fundName", "fundProductType", "fundSubtype", "source",
  "applyDate", "confirmDate", "arrivalDate", "grossAmount", "arrivalAmount",
  "fee", "nav", "units", "realizedProfit", "regularInvestPlanId", "note",
  "deletedAt", "createdAt", "updatedAt"
)
SELECT
  t."id",
  t."householdId",
  CASE
    WHEN t."fundSubtype" IN ('redeem', 'switch_out', 'dividend_cash') THEN t."accountId"
    ELSE COALESCE(t."toAccountId", t."accountId")
  END AS "fundAccountId",
  CASE
    WHEN t."fundSubtype" IN ('redeem', 'switch_out', 'dividend_cash') THEN t."toAccountId"
    ELSE t."accountId"
  END AS "cashAccountId",
  t."id" AS "cashEntryId",
  t."fundCode",
  t."fundName",
  COALESCE(t."fundProductType", 'fund'::"FundProductType") AS "fundProductType",
  COALESCE(t."fundSubtype", CASE WHEN t."amount" < 0 THEN 'buy'::"FundSubtype" ELSE 'redeem'::"FundSubtype" END) AS "fundSubtype",
  t."source",
  t."date" AS "applyDate",
  t."fundConfirmDate" AS "confirmDate",
  t."fundArrivalDate" AS "arrivalDate",
  ABS(t."amount") AS "grossAmount",
  t."fundArrivalAmount" AS "arrivalAmount",
  t."fundFee" AS "fee",
  t."fundNav" AS "nav",
  t."fundUnits" AS "units",
  t."realizedProfit",
  t."regularInvestPlanId",
  t."note",
  t."deletedAt",
  t."createdAt",
  t."updatedAt"
FROM "transactions" t
WHERE t."fundCode" IS NOT NULL
  AND NOT (t."fundSubtype" = 'buy_failed' AND t."source" = 'regular_invest_refund')
  AND t."householdId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "fund_transactions" ft WHERE ft."cashEntryId" = t."id");

INSERT INTO "fund_transaction_cash_flows" ("id", "fundTransactionId", "txRecordId", "kind", "amount", "flowDate", "accountId", "createdAt")
SELECT
  'cff_' || t."id",
  ft."id",
  t."id",
  CASE
    WHEN ft."fundSubtype" = 'buy' THEN 'buy_out'::"FundCashFlowKind"
    WHEN ft."fundSubtype" IN ('redeem', 'switch_out') THEN 'redeem_in'::"FundCashFlowKind"
    WHEN ft."fundSubtype" = 'dividend_cash' THEN 'dividend_in'::"FundCashFlowKind"
    WHEN ft."fundSubtype" = 'dividend_reinvest' THEN 'dividend_reinvest_internal'::"FundCashFlowKind"
    WHEN ft."fundSubtype" = 'switch_in' THEN 'switch_in'::"FundCashFlowKind"
    ELSE 'other'::"FundCashFlowKind"
  END,
  ABS(t."amount"),
  CASE
    WHEN ft."fundSubtype" IN ('redeem', 'switch_out', 'dividend_cash') THEN COALESCE(t."fundArrivalDate", t."date")
    ELSE t."date"
  END,
  CASE
    WHEN ft."fundSubtype" IN ('redeem', 'switch_out', 'dividend_cash') THEN t."toAccountId"
    ELSE t."accountId"
  END,
  t."createdAt"
FROM "fund_transactions" ft
JOIN "transactions" t ON t."id" = ft."cashEntryId"
WHERE NOT EXISTS (SELECT 1 FROM "fund_transaction_cash_flows" cf WHERE cf."txRecordId" = t."id");

INSERT INTO "fund_transaction_cash_flows" ("id", "fundTransactionId", "txRecordId", "kind", "amount", "flowDate", "accountId", "createdAt")
SELECT
  'cfr_' || r."id",
  ft."id",
  r."id",
  'refund_in'::"FundCashFlowKind",
  ABS(r."amount"),
  COALESCE(r."fundArrivalDate", r."date"),
  r."toAccountId",
  r."createdAt"
FROM "transactions" r
JOIN "fund_transactions" ft ON ft."cashEntryId" = r."fundSourceEntryId"
WHERE r."fundSubtype" = 'buy_failed'
  AND r."source" = 'regular_invest_refund'
  AND r."fundSourceEntryId" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "fund_transaction_cash_flows" cf WHERE cf."txRecordId" = r."id");

UPDATE "fund_transactions" ft
SET "refundAmount" = COALESCE(r."refundAmount", 0),
    "arrivalDate" = COALESCE(r."lastRefundDate", ft."arrivalDate")
FROM (
  SELECT "fundTransactionId", SUM("amount") AS "refundAmount", MAX("flowDate") AS "lastRefundDate"
  FROM "fund_transaction_cash_flows"
  WHERE "kind" = 'refund_in'
  GROUP BY "fundTransactionId"
) r
WHERE ft."id" = r."fundTransactionId";
