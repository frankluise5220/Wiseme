-- Preserve the concrete action category for regular-investment fund purchases.
-- Older normalization runs classified these rows as generic fund buys because
-- the broad buy assignment ran after the regular-investment assignment.
UPDATE "transactions" AS tx
SET
  "categoryId" = category.id,
  "categoryName" = category.name
FROM "Category" AS category
WHERE tx.type::text = 'investment'
  AND tx."deletedAt" IS NULL
  AND tx.source = 'regular_invest'
  AND (
    tx."fundSubtype"::text IN ('buy', 'regular_invest')
    OR (tx."fundSubtype" IS NULL AND tx."regularInvestPlanId" IS NOT NULL)
  )
  AND category."householdId" = tx."householdId"
  AND category.type = 'investment'
  AND category.name = '基金定投';

CREATE OR REPLACE FUNCTION "setInvestmentSystemCategory"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  selected_category_type TEXT;
  selected_category_name TEXT;
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
    SELECT type, name
    INTO selected_category_type, selected_category_name
    FROM "Category"
    WHERE id = NEW."categoryId";

    IF selected_category_type = 'investment' THEN
      NEW."categoryName" := selected_category_name;
      RETURN NEW;
    END IF;
  END IF;

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
      WHEN NEW.source = 'regular_invest' AND (
        NEW."fundSubtype"::text IN ('buy', 'regular_invest')
        OR (NEW."fundSubtype" IS NULL AND NEW."regularInvestPlanId" IS NOT NULL)
      ) THEN '基金定投'
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
  WHERE "householdId" = NEW."householdId"
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
