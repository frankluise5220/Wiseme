-- Create real system parent nodes while the UI uses the type header to render them.

WITH desired(name, type) AS (
  VALUES ('转账', 'transfer'), ('投资', 'investment')
)
INSERT INTO "Category" (id, name, type, "parentId", "householdId", "isSystem")
SELECT
  'system_root_' || SUBSTRING(MD5(household.id || desired.name), 1, 24),
  desired.name,
  desired.type,
  NULL,
  household.id,
  TRUE
FROM "Household" AS household
CROSS JOIN desired
ON CONFLICT ("householdId", name) DO UPDATE
SET type = EXCLUDED.type, "parentId" = NULL, "isSystem" = TRUE;

UPDATE "Category" AS child
SET "parentId" = parent.id
FROM "Category" AS parent
WHERE
  child."householdId" = parent."householdId"
  AND child.name = '信用卡还款'
  AND child.type = 'transfer'
  AND parent.name = '转账'
  AND parent.type = 'transfer';

UPDATE "Category" AS child
SET "parentId" = parent.id
FROM "Category" AS parent
WHERE
  child."householdId" = parent."householdId"
  AND child.name IN ('基金投资', '理财投资', '存款投资', '贵金属投资', '保险投资', '其他投资')
  AND child.type = 'investment'
  AND parent.name = '投资'
  AND parent.type = 'investment';
