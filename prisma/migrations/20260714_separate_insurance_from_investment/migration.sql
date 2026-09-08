-- Insurance uses its own premium/refund semantics and is not a generic investment category.

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

  IF NEW.source = 'insurance' OR NEW."insuranceProductId" IS NOT NULL THEN
    NEW."categoryId" := NULL;
    NEW."categoryName" := NULL;
    RETURN NEW;
  END IF;

  target_name := CASE
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

UPDATE "transactions"
SET "categoryId" = NULL, "categoryName" = NULL
WHERE "categoryId" IN (
  SELECT id FROM "Category" WHERE type = 'investment' AND name = '保险投资'
);

DELETE FROM "Category"
WHERE type = 'investment' AND name = '保险投资';
