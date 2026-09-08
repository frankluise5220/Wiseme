-- Backfill existing investment records from product-group parent categories to concrete action categories.

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
    OR tx."categoryName" IN ('基金投资', '理财投资', '存款投资', '贵金属投资')
    OR EXISTS (
      SELECT 1 FROM "Category" AS current_category
      WHERE current_category.id = tx."categoryId"
        AND current_category.type = 'investment'
        AND current_category."isSystem" = TRUE
        AND current_category.name IN ('基金投资', '理财投资', '存款投资', '贵金属投资')
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
