CREATE TYPE "CreditBillMode" AS ENUM ('separate', 'consolidated');

ALTER TABLE "Account"
ADD COLUMN "creditBillMode" "CreditBillMode" NOT NULL DEFAULT 'separate';

WITH institution_defaults AS (
  SELECT
    "householdId",
    "institutionId",
    (array_agg("billingDay" ORDER BY ("repaymentDay" IS NOT NULL) DESC, "updatedAt" DESC)
      FILTER (WHERE "billingDay" IS NOT NULL))[1] AS "billingDay",
    (array_agg("repaymentDay" ORDER BY ("billingDay" IS NOT NULL) DESC, "updatedAt" DESC)
      FILTER (WHERE "repaymentDay" IS NOT NULL))[1] AS "repaymentDay"
  FROM "Account"
  WHERE "kind" = 'bank_credit' AND "institutionId" IS NOT NULL
  GROUP BY "householdId", "institutionId"
)
UPDATE "Account" AS account
SET
  "billingDay" = COALESCE(defaults."billingDay", account."billingDay"),
  "repaymentDay" = COALESCE(defaults."repaymentDay", account."repaymentDay")
FROM institution_defaults AS defaults
WHERE
  account."kind" = 'bank_credit'
  AND account."householdId" = defaults."householdId"
  AND account."institutionId" = defaults."institutionId";

CREATE INDEX "Account_householdId_institutionId_creditBillMode_idx"
ON "Account"("householdId", "institutionId", "creditBillMode");
