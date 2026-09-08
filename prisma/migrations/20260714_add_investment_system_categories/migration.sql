-- Add investment as a first-class category type and classify investment records.

WITH desired(name) AS (
  VALUES
    ('基金投资'),
    ('理财投资'),
    ('存款投资'),
    ('贵金属投资'),
    ('保险投资'),
    ('其他投资')
)
INSERT INTO "Category" (id, name, type, "parentId", "householdId", "isSystem")
SELECT
  'system_invest_' || SUBSTRING(MD5(household.id || desired.name), 1, 20),
  desired.name,
  'investment',
  NULL,
  household.id,
  TRUE
FROM "Household" AS household
CROSS JOIN desired
ON CONFLICT ("householdId", name) DO UPDATE
SET type = 'investment', "parentId" = NULL, "isSystem" = TRUE;

UPDATE "transactions" AS tx
SET
  "categoryId" = category.id,
  "categoryName" = category.name
FROM "Category" AS category
WHERE
  tx.type::text = 'investment'
  AND tx."deletedAt" IS NULL
  AND category."householdId" = tx."householdId"
  AND category.type = 'investment'
  AND category.name = CASE
    WHEN tx.source = 'insurance' OR tx."insuranceProductId" IS NOT NULL THEN '保险投资'
    WHEN tx."fundProductType"::text = 'wealth' THEN '理财投资'
    WHEN tx."fundProductType"::text = 'deposit' THEN '存款投资'
    WHEN tx."fundProductType"::text = 'metal' THEN '贵金属投资'
    WHEN tx."fundProductType"::text IN ('fund', 'money') THEN '基金投资'
    ELSE '其他投资'
  END;

CREATE OR REPLACE FUNCTION "setInvestmentSystemCategory"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_is_custom BOOLEAN := FALSE;
  target_name TEXT;
  target_id TEXT;
BEGIN
  IF NEW.type::text <> 'investment' THEN
    IF NEW."categoryId" IS NOT NULL AND EXISTS (
      SELECT 1
      FROM "Category"
      WHERE id = NEW."categoryId" AND type = 'investment' AND "isSystem" = TRUE
    ) THEN
      NEW."categoryId" := NULL;
      NEW."categoryName" := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."categoryId" IS NOT NULL THEN
    SELECT NOT (type = 'investment' AND "isSystem" = TRUE)
    INTO current_is_custom
    FROM "Category"
    WHERE id = NEW."categoryId";
  END IF;
  IF current_is_custom THEN RETURN NEW; END IF;

  target_name := CASE
    WHEN NEW.source = 'insurance' OR NEW."insuranceProductId" IS NOT NULL THEN '保险投资'
    WHEN NEW."fundProductType"::text = 'wealth' THEN '理财投资'
    WHEN NEW."fundProductType"::text = 'deposit' THEN '存款投资'
    WHEN NEW."fundProductType"::text = 'metal' THEN '贵金属投资'
    WHEN NEW."fundProductType"::text IN ('fund', 'money') THEN '基金投资'
    ELSE '其他投资'
  END;

  SELECT id INTO target_id
  FROM "Category"
  WHERE
    "householdId" = NEW."householdId"
    AND type = 'investment'
    AND name = target_name
  LIMIT 1;

  IF target_id IS NOT NULL THEN
    NEW."categoryId" := target_id;
    NEW."categoryName" := target_name;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "transactions_set_investment_system_category" ON "transactions";
CREATE TRIGGER "transactions_set_investment_system_category"
BEFORE INSERT OR UPDATE OF type, "fundProductType", source, "insuranceProductId", "householdId", "categoryId"
ON "transactions"
FOR EACH ROW
EXECUTE FUNCTION "setInvestmentSystemCategory"();
