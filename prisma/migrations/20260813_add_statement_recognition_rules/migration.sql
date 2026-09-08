CREATE TABLE IF NOT EXISTS "statement_recognition_rules" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "targetType" TEXT NOT NULL,
  "transactionType" TEXT NOT NULL DEFAULT 'any',
  "keyword" TEXT NOT NULL,
  "normalizedKeyword" TEXT NOT NULL,
  "categoryId" TEXT,
  "categoryName" TEXT,
  "institutionId" TEXT,
  "institutionName" TEXT,
  "fieldName" TEXT,
  "source" TEXT NOT NULL DEFAULT 'system_default',
  "priority" INTEGER NOT NULL DEFAULT 100,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "hitCount" INTEGER NOT NULL DEFAULT 0,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "statement_recognition_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "statement_recognition_rules_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "statement_recognition_rules_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "statement_recognition_rules_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

ALTER TABLE "statement_recognition_rules"
  ADD COLUMN IF NOT EXISTS "fieldName" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "statement_recognition_rules_householdId_targetType_transactionType_normalizedKeyword_key"
  ON "statement_recognition_rules"("householdId", "targetType", "transactionType", "normalizedKeyword");

CREATE INDEX IF NOT EXISTS "statement_recognition_rules_householdId_targetType_idx"
  ON "statement_recognition_rules"("householdId", "targetType");

CREATE INDEX IF NOT EXISTS "statement_recognition_rules_categoryId_idx"
  ON "statement_recognition_rules"("categoryId");

CREATE INDEX IF NOT EXISTS "statement_recognition_rules_institutionId_idx"
  ON "statement_recognition_rules"("institutionId");

CREATE INDEX IF NOT EXISTS "statement_recognition_rules_isActive_idx"
  ON "statement_recognition_rules"("isActive");
