CREATE TABLE IF NOT EXISTS "statement_category_rules" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "categoryId" TEXT,
  "categoryName" TEXT NOT NULL,
  "normalizedText" TEXT NOT NULL,
  "counterpartyInstitutionName" TEXT,
  "paymentChannelName" TEXT,
  "source" TEXT NOT NULL DEFAULT 'user_category_edit',
  "hitCount" INTEGER NOT NULL DEFAULT 1,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "matchText" TEXT NOT NULL,

  CONSTRAINT "statement_category_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "statement_category_rules_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "statement_category_rules_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "statement_category_rules_householdId_type_normalizedText_key"
  ON "statement_category_rules"("householdId", "type", "normalizedText");

CREATE INDEX IF NOT EXISTS "statement_category_rules_householdId_type_idx"
  ON "statement_category_rules"("householdId", "type");

CREATE INDEX IF NOT EXISTS "statement_category_rules_categoryId_idx"
  ON "statement_category_rules"("categoryId");

CREATE INDEX IF NOT EXISTS "statement_category_rules_lastSeenAt_idx"
  ON "statement_category_rules"("lastSeenAt");
