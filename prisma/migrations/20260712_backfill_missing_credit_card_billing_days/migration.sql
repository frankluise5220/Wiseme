WITH institution_billing_days AS (
  SELECT DISTINCT ON ("householdId", "institutionId")
    "householdId",
    "institutionId",
    "billingDay"
  FROM "Account"
  WHERE
    "kind" = 'bank_credit'
    AND "institutionId" IS NOT NULL
    AND "billingDay" IS NOT NULL
  ORDER BY "householdId", "institutionId", "updatedAt" DESC, "id" ASC
)
UPDATE "Account" AS account
SET "billingDay" = defaults."billingDay"
FROM institution_billing_days AS defaults
WHERE
  account."kind" = 'bank_credit'
  AND account."billingDay" IS NULL
  AND account."householdId" = defaults."householdId"
  AND account."institutionId" = defaults."institutionId";
