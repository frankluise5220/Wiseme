-- Investment transaction categories now use concrete action categories under product-group parents.

WITH roots AS (
  INSERT INTO "Category" (id, name, type, "parentId", "householdId", "isSystem")
  SELECT
    'system_invest_root_' || SUBSTRING(MD5(household.id), 1, 16),
    '投资',
    'investment',
    NULL,
    household.id,
    TRUE
  FROM "Household" AS household
  ON CONFLICT ("householdId", name) DO UPDATE
  SET type = 'investment', "parentId" = NULL, "isSystem" = TRUE
  RETURNING id, "householdId"
), parents(name) AS (
  VALUES
    ('基金投资'),
    ('理财投资'),
    ('存款投资'),
    ('贵金属投资'),
    ('其他投资')
)
INSERT INTO "Category" (id, name, type, "parentId", "householdId", "isSystem")
SELECT
  'system_invest_' || SUBSTRING(MD5(roots."householdId" || parents.name), 1, 20),
  parents.name,
  'investment',
  roots.id,
  roots."householdId",
  TRUE
FROM roots
CROSS JOIN parents
ON CONFLICT ("householdId", name) DO UPDATE
SET type = 'investment', "parentId" = EXCLUDED."parentId", "isSystem" = TRUE;

WITH parent_rows AS (
  SELECT id, name, "householdId"
  FROM "Category"
  WHERE type = 'investment'
    AND "isSystem" = TRUE
    AND name IN ('基金投资', '理财投资', '存款投资', '贵金属投资')
), desired(parent_name, child_name) AS (
  VALUES
    ('基金投资', '基金定投'),
    ('基金投资', '基金买入'),
    ('基金投资', '基金赎回'),
    ('基金投资', '现金分红'),
    ('基金投资', '分红再投资'),
    ('基金投资', '买入退回'),
    ('基金投资', '买入失败'),
    ('理财投资', '理财买入'),
    ('理财投资', '理财赎回'),
    ('理财投资', '理财分红'),
    ('存款投资', '存款存入'),
    ('存款投资', '存款取出'),
    ('贵金属投资', '贵金属买入'),
    ('贵金属投资', '贵金属卖出')
)
INSERT INTO "Category" (id, name, type, "parentId", "householdId", "isSystem")
SELECT
  'system_invest_' || SUBSTRING(MD5(parent_rows."householdId" || desired.child_name), 1, 20),
  desired.child_name,
  'investment',
  parent_rows.id,
  parent_rows."householdId",
  TRUE
FROM parent_rows
JOIN desired ON desired.parent_name = parent_rows.name
ON CONFLICT ("householdId", name) DO UPDATE
SET type = 'investment', "parentId" = EXCLUDED."parentId", "isSystem" = TRUE;

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
  AND (
    tx."categoryId" IS NULL
    OR EXISTS (
      SELECT 1 FROM "Category" AS current_category
      WHERE current_category.id = tx."categoryId"
        AND current_category.type = 'investment'
        AND current_category."isSystem" = TRUE
    )
  )
  AND category.name = CASE
    WHEN tx.source = 'insurance' OR tx."insuranceProductId" IS NOT NULL THEN NULL
    WHEN tx."fundSubtype"::text = 'buy_failed' AND tx.source = 'regular_invest_refund' THEN '买入退回'
    WHEN tx."fundSubtype"::text = 'buy_failed' THEN '买入失败'
    WHEN tx."fundProductType"::text = 'wealth' AND tx."fundSubtype"::text IN ('redeem', 'switch_out') THEN '理财赎回'
    WHEN tx."fundProductType"::text = 'wealth' AND tx."fundSubtype"::text = 'dividend_cash' THEN '理财分红'
    WHEN tx."fundProductType"::text = 'wealth' THEN '理财买入'
    WHEN tx."fundProductType"::text = 'deposit' AND tx."fundSubtype"::text IN ('redeem', 'switch_out') THEN '存款取出'
    WHEN tx."fundProductType"::text = 'deposit' THEN '存款存入'
    WHEN tx."fundProductType"::text = 'metal' AND tx."fundSubtype"::text IN ('redeem', 'switch_out') THEN '贵金属卖出'
    WHEN tx."fundProductType"::text = 'metal' THEN '贵金属买入'
    WHEN tx."fundProductType"::text IN ('fund', 'money') OR tx."fundProductType" IS NULL THEN CASE
      WHEN tx."fundSubtype"::text IN ('buy', 'regular_invest') AND tx.source = 'regular_invest' THEN '基金定投'
      WHEN tx."fundSubtype"::text IN ('redeem', 'switch_out') THEN '基金赎回'
      WHEN tx."fundSubtype"::text = 'dividend_cash' THEN '现金分红'
      WHEN tx."fundSubtype"::text = 'dividend_reinvest' OR (tx."fundSubtype"::text = 'buy' AND tx.source = 'dividend') THEN '分红再投资'
      WHEN tx."fundSubtype"::text = 'buy' OR tx."fundSubtype" IS NULL THEN '基金买入'
      ELSE '其他投资'
    END
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

  IF NEW.source = 'insurance' OR NEW."insuranceProductId" IS NOT NULL THEN
    NEW."categoryId" := NULL;
    NEW."categoryName" := NULL;
    RETURN NEW;
  END IF;

  target_name := CASE
    WHEN NEW."fundSubtype"::text = 'buy_failed' AND NEW.source = 'regular_invest_refund' THEN '买入退回'
    WHEN NEW."fundSubtype"::text = 'buy_failed' THEN '买入失败'
    WHEN NEW."fundProductType"::text = 'wealth' AND NEW."fundSubtype"::text IN ('redeem', 'switch_out') THEN '理财赎回'
    WHEN NEW."fundProductType"::text = 'wealth' AND NEW."fundSubtype"::text = 'dividend_cash' THEN '理财分红'
    WHEN NEW."fundProductType"::text = 'wealth' THEN '理财买入'
    WHEN NEW."fundProductType"::text = 'deposit' AND NEW."fundSubtype"::text IN ('redeem', 'switch_out') THEN '存款取出'
    WHEN NEW."fundProductType"::text = 'deposit' THEN '存款存入'
    WHEN NEW."fundProductType"::text = 'metal' AND NEW."fundSubtype"::text IN ('redeem', 'switch_out') THEN '贵金属卖出'
    WHEN NEW."fundProductType"::text = 'metal' THEN '贵金属买入'
    WHEN NEW."fundProductType"::text IN ('fund', 'money') OR NEW."fundProductType" IS NULL THEN CASE
      WHEN NEW."fundSubtype"::text IN ('buy', 'regular_invest') AND NEW.source = 'regular_invest' THEN '基金定投'
      WHEN NEW."fundSubtype"::text IN ('redeem', 'switch_out') THEN '基金赎回'
      WHEN NEW."fundSubtype"::text = 'dividend_cash' THEN '现金分红'
      WHEN NEW."fundSubtype"::text = 'dividend_reinvest' OR (NEW."fundSubtype"::text = 'buy' AND NEW.source = 'dividend') THEN '分红再投资'
      WHEN NEW."fundSubtype"::text = 'buy' OR NEW."fundSubtype" IS NULL THEN '基金买入'
      ELSE '其他投资'
    END
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
BEFORE INSERT OR UPDATE OF type, "fundProductType", "fundSubtype", source, "insuranceProductId", "householdId", "categoryId"
ON "transactions"
FOR EACH ROW
EXECUTE FUNCTION "setInvestmentSystemCategory"();
