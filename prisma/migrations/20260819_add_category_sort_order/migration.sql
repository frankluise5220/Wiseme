ALTER TABLE "Category"
  ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "householdId", "type", "parentId"
      ORDER BY "name" ASC, "id" ASC
    ) - 1 AS "nextSortOrder"
  FROM "Category"
)
UPDATE "Category" AS category
SET "sortOrder" = ranked."nextSortOrder"
FROM ranked
WHERE category."id" = ranked."id";

CREATE INDEX IF NOT EXISTS "Category_householdId_type_parentId_sortOrder_idx"
  ON "Category"("householdId", "type", "parentId", "sortOrder");
