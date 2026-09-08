WITH legacy_category_rules AS (
  SELECT
    'recog_legacy_' || "id" AS "id",
    "householdId",
    "type",
    TRIM(
      CASE
        WHEN POSITION('有限责任公司' IN "matchText") > 0 THEN SUBSTRING("matchText" FROM 1 FOR POSITION('有限责任公司' IN "matchText") - 1)
        WHEN POSITION('股份有限公司' IN "matchText") > 0 THEN SUBSTRING("matchText" FROM 1 FOR POSITION('股份有限公司' IN "matchText") - 1)
        WHEN POSITION('集团有限公司' IN "matchText") > 0 THEN SUBSTRING("matchText" FROM 1 FOR POSITION('集团有限公司' IN "matchText") - 1)
        WHEN POSITION('有限公司' IN "matchText") > 0 THEN SUBSTRING("matchText" FROM 1 FOR POSITION('有限公司' IN "matchText") - 1)
        ELSE "matchText"
      END
    ) AS "keyword",
    TRIM(
      CASE
        WHEN POSITION('有限责任公司' IN "normalizedText") > 0 THEN SUBSTRING("normalizedText" FROM 1 FOR POSITION('有限责任公司' IN "normalizedText") - 1)
        WHEN POSITION('股份有限公司' IN "normalizedText") > 0 THEN SUBSTRING("normalizedText" FROM 1 FOR POSITION('股份有限公司' IN "normalizedText") - 1)
        WHEN POSITION('集团有限公司' IN "normalizedText") > 0 THEN SUBSTRING("normalizedText" FROM 1 FOR POSITION('集团有限公司' IN "normalizedText") - 1)
        WHEN POSITION('有限公司' IN "normalizedText") > 0 THEN SUBSTRING("normalizedText" FROM 1 FOR POSITION('有限公司' IN "normalizedText") - 1)
        ELSE "normalizedText"
      END
    ) AS "normalizedKeyword",
    "categoryId",
    "categoryName",
    "source",
    CASE WHEN "source" = 'system_default' THEN 100 ELSE 230 END AS "priority",
    "hitCount",
    "lastSeenAt",
    "createdAt",
    "updatedAt"
  FROM "statement_category_rules"
  WHERE "type" IN ('income', 'expense')
    AND "categoryName" IS NOT NULL
    AND "matchText" IS NOT NULL
    AND "normalizedText" IS NOT NULL
)
INSERT INTO "statement_recognition_rules" (
  "id", "householdId", "targetType", "transactionType", "keyword", "normalizedKeyword",
  "categoryId", "categoryName", "institutionId", "institutionName", "fieldName", "source", "priority",
  "isActive", "hitCount", "lastSeenAt", "createdAt", "updatedAt"
)
SELECT
  "id", "householdId", 'category', "type", "keyword", "normalizedKeyword",
  "categoryId", "categoryName", NULL, NULL, NULL, "source", "priority",
  true, "hitCount", "lastSeenAt", "createdAt", "updatedAt"
FROM legacy_category_rules
WHERE "keyword" <> ''
  AND "normalizedKeyword" <> ''
ON CONFLICT ("householdId", "targetType", "transactionType", "normalizedKeyword")
DO UPDATE SET
  "categoryId" = EXCLUDED."categoryId",
  "categoryName" = EXCLUDED."categoryName",
  "source" = EXCLUDED."source",
  "priority" = GREATEST("statement_recognition_rules"."priority", EXCLUDED."priority"),
  "isActive" = true,
  "hitCount" = "statement_recognition_rules"."hitCount" + EXCLUDED."hitCount",
  "lastSeenAt" = GREATEST(COALESCE("statement_recognition_rules"."lastSeenAt", EXCLUDED."lastSeenAt"), COALESCE(EXCLUDED."lastSeenAt", "statement_recognition_rules"."lastSeenAt")),
  "updatedAt" = CURRENT_TIMESTAMP,
  "keyword" = EXCLUDED."keyword";

CREATE TEMP TABLE "_mmh_statement_keyword_cleanup" AS
SELECT
  "id",
  "householdId",
  "targetType",
  "transactionType",
  TRIM(
    CASE
      WHEN POSITION('有限责任公司' IN "keyword") > 0 THEN SUBSTRING("keyword" FROM 1 FOR POSITION('有限责任公司' IN "keyword") - 1)
      WHEN POSITION('股份有限公司' IN "keyword") > 0 THEN SUBSTRING("keyword" FROM 1 FOR POSITION('股份有限公司' IN "keyword") - 1)
      WHEN POSITION('集团有限公司' IN "keyword") > 0 THEN SUBSTRING("keyword" FROM 1 FOR POSITION('集团有限公司' IN "keyword") - 1)
      WHEN POSITION('有限公司' IN "keyword") > 0 THEN SUBSTRING("keyword" FROM 1 FOR POSITION('有限公司' IN "keyword") - 1)
      ELSE "keyword"
    END
  ) AS "keyword",
  TRIM(
    CASE
      WHEN POSITION('有限责任公司' IN "normalizedKeyword") > 0 THEN SUBSTRING("normalizedKeyword" FROM 1 FOR POSITION('有限责任公司' IN "normalizedKeyword") - 1)
      WHEN POSITION('股份有限公司' IN "normalizedKeyword") > 0 THEN SUBSTRING("normalizedKeyword" FROM 1 FOR POSITION('股份有限公司' IN "normalizedKeyword") - 1)
      WHEN POSITION('集团有限公司' IN "normalizedKeyword") > 0 THEN SUBSTRING("normalizedKeyword" FROM 1 FOR POSITION('集团有限公司' IN "normalizedKeyword") - 1)
      WHEN POSITION('有限公司' IN "normalizedKeyword") > 0 THEN SUBSTRING("normalizedKeyword" FROM 1 FOR POSITION('有限公司' IN "normalizedKeyword") - 1)
      ELSE "normalizedKeyword"
    END
  ) AS "normalizedKeyword",
  "hitCount"
FROM "statement_recognition_rules"
WHERE "keyword" LIKE '%有限公司%'
   OR "normalizedKeyword" LIKE '%有限公司%';

UPDATE "statement_recognition_rules" AS target
SET
  "hitCount" = target."hitCount" + source."hitCount",
  "updatedAt" = CURRENT_TIMESTAMP
FROM "_mmh_statement_keyword_cleanup" AS source
WHERE target."householdId" = source."householdId"
  AND target."targetType" = source."targetType"
  AND target."transactionType" = source."transactionType"
  AND target."normalizedKeyword" = source."normalizedKeyword"
  AND target."id" <> source."id";

DELETE FROM "statement_recognition_rules" AS original
USING "_mmh_statement_keyword_cleanup" AS source
WHERE original."id" = source."id"
  AND EXISTS (
    SELECT 1
    FROM "statement_recognition_rules" AS target
    WHERE target."householdId" = source."householdId"
      AND target."targetType" = source."targetType"
      AND target."transactionType" = source."transactionType"
      AND target."normalizedKeyword" = source."normalizedKeyword"
      AND target."id" <> source."id"
  );

UPDATE "statement_recognition_rules" AS target
SET
  "keyword" = source."keyword",
  "normalizedKeyword" = source."normalizedKeyword",
  "updatedAt" = CURRENT_TIMESTAMP
FROM "_mmh_statement_keyword_cleanup" AS source
WHERE target."id" = source."id"
  AND source."keyword" <> ''
  AND source."normalizedKeyword" <> '';

DROP TABLE "_mmh_statement_keyword_cleanup";

DROP TABLE IF EXISTS "statement_category_rules";
