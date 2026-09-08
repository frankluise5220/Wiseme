-- Split wealth cash rows are cash-ledger rows, but their category still carries
-- the investment business semantics. The second-level category is 理财投资 and
-- the action category is stored on the cash row for display/filter/statistics.
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

WITH target_categories AS (
  SELECT
    cash.id AS "cashEntryId",
    category.id AS "categoryId",
    category.name AS "categoryName"
  FROM "transactions" cash
  JOIN "wealth_transactions" wt
    ON cash.id = wt."cashEntryId"
  JOIN "Category" category
    ON category."householdId" = wt."householdId"
   AND category.type = 'investment'
   AND category.name = CASE
      WHEN wt.action::text IN ('redeem', 'switch_out') THEN '理财赎回'
      WHEN wt.action::text = 'dividend_cash' THEN '理财分红'
      ELSE '理财买入'
    END
  WHERE cash."deletedAt" IS NULL
    AND wt."deletedAt" IS NULL
    AND (
      cash."categoryId" IS NULL
      OR EXISTS (
        SELECT 1
        FROM "Category" current_category
        WHERE current_category.id = cash."categoryId"
          AND current_category."isSystem" = TRUE
      )
      OR cash."categoryName" IN ('基金投资', '基金买入', '理财投资', '理财买入', '理财赎回', '理财分红')
    )
)
UPDATE "transactions" cash
SET
  "categoryId" = target_categories."categoryId",
  "categoryName" = target_categories."categoryName"
FROM target_categories
WHERE cash.id = target_categories."cashEntryId";
