-- Category names are unique within a household, regardless of type or depth.

-- Merge the legacy "其他支出 > 其他" category into the canonical category.
UPDATE "transactions" AS tx
SET
  "categoryId" = target.id,
  "categoryName" = target.name
FROM "Category" AS source
JOIN "Category" AS source_parent ON source_parent.id = source."parentId"
JOIN "Category" AS target
  ON target."householdId" = source."householdId"
  AND target.name = '其他杂项支出'
WHERE
  tx."categoryId" = source.id
  AND source.name = '其他'
  AND source_parent.name = '其他支出';

DELETE FROM "Category" AS source
USING "Category" AS source_parent, "Category" AS target
WHERE
  source_parent.id = source."parentId"
  AND source_parent.name = '其他支出'
  AND source.name = '其他'
  AND target."householdId" = source."householdId"
  AND target.name = '其他杂项支出';

-- Preserve the meaning of the other known legacy category.
UPDATE "Category" AS category
SET name = '其他大件采购'
FROM "Category" AS parent
WHERE
  parent.id = category."parentId"
  AND parent.name = '大件采购'
  AND category.name = '其他';

UPDATE "transactions" AS tx
SET "categoryName" = category.name
FROM "Category" AS category
WHERE tx."categoryId" = category.id;

-- Safely disambiguate any remaining historical duplicates before adding the constraint.
DO $$
DECLARE
  duplicate_group RECORD;
  duplicate_row RECORD;
  base_name TEXT;
  candidate_name TEXT;
  suffix_number INTEGER;
BEGIN
  FOR duplicate_group IN
    SELECT "householdId", name
    FROM "Category"
    WHERE "householdId" IS NOT NULL
    GROUP BY "householdId", name
    HAVING COUNT(*) > 1
  LOOP
    FOR duplicate_row IN
      SELECT category.id, parent.name AS parent_name
      FROM "Category" AS category
      LEFT JOIN "Category" AS parent ON parent.id = category."parentId"
      WHERE
        category."householdId" = duplicate_group."householdId"
        AND category.name = duplicate_group.name
      ORDER BY category.id
      OFFSET 1
    LOOP
      base_name := COALESCE(NULLIF(duplicate_row.parent_name, ''), '分类') || '·' || duplicate_group.name;
      candidate_name := base_name;
      suffix_number := 2;

      WHILE EXISTS (
        SELECT 1
        FROM "Category"
        WHERE
          "householdId" = duplicate_group."householdId"
          AND name = candidate_name
      ) LOOP
        candidate_name := base_name || '（' || suffix_number || '）';
        suffix_number := suffix_number + 1;
      END LOOP;

      UPDATE "Category" SET name = candidate_name WHERE id = duplicate_row.id;
      UPDATE "transactions" SET "categoryName" = candidate_name WHERE "categoryId" = duplicate_row.id;
    END LOOP;
  END LOOP;
END $$;

CREATE UNIQUE INDEX "Category_householdId_name_key"
ON "Category"("householdId", "name");
