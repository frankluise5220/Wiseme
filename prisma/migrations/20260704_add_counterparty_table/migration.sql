CREATE TABLE "Counterparty" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "shortName" TEXT,
  "type" TEXT NOT NULL DEFAULT 'organization',
  "householdId" TEXT NOT NULL,
  "sourceInstitutionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Counterparty_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Counterparty_householdId_name_idx"
  ON "Counterparty"("householdId", "name");

CREATE INDEX "Counterparty_sourceInstitutionId_idx"
  ON "Counterparty"("sourceInstitutionId");

ALTER TABLE "Counterparty"
  ADD CONSTRAINT "Counterparty_householdId_fkey"
  FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Counterparty"
  ADD CONSTRAINT "Counterparty_sourceInstitutionId_fkey"
  FOREIGN KEY ("sourceInstitutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Account"
  ADD COLUMN "counterpartyId" TEXT;

CREATE INDEX "Account_counterpartyId_idx"
  ON "Account"("counterpartyId");

ALTER TABLE "Account"
  ADD CONSTRAINT "Account_counterpartyId_fkey"
  FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "Counterparty" (
  "id",
  "name",
  "shortName",
  "type",
  "householdId",
  "sourceInstitutionId",
  "createdAt",
  "updatedAt"
)
SELECT
  'counterparty_' || md5(i."id"),
  i."name",
  i."shortName",
  CASE WHEN i."type" = 'person' THEN 'person' ELSE 'organization' END,
  i."householdId",
  i."id",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Institution" i
WHERE i."householdId" IS NOT NULL
  AND i."type" IN ('person', 'organization')
ON CONFLICT ("id") DO NOTHING;

UPDATE "Account" a
SET
  "counterpartyId" = 'counterparty_' || md5(a."institutionId"),
  "institutionId" = NULL
FROM "Institution" i
WHERE a."institutionId" = i."id"
  AND a."kind" = 'loan'
  AND i."type" IN ('person', 'organization');
