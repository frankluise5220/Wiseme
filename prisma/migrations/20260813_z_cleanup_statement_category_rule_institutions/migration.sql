UPDATE "statement_category_rules"
SET
  "counterpartyInstitutionName" = NULL,
  "paymentChannelName" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "source" = 'system_default'
  AND ("counterpartyInstitutionName" IS NOT NULL OR "paymentChannelName" IS NOT NULL);
