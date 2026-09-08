-- Add the canonical transfer category for ordinary settlement/debt-object records.

WITH transfer_roots AS (
  INSERT INTO "Category" (id, name, type, "parentId", "householdId", "isSystem")
  SELECT
    'system_root_' || SUBSTRING(MD5(household.id || '转账'), 1, 24),
    '转账',
    'transfer',
    NULL,
    household.id,
    TRUE
  FROM "Household" AS household
  ON CONFLICT ("householdId", name) DO UPDATE
  SET type = EXCLUDED.type, "parentId" = NULL, "isSystem" = TRUE
  RETURNING id, "householdId"
), settlement_categories AS (
  INSERT INTO "Category" (id, name, type, "parentId", "householdId", "isSystem")
  SELECT
    'system_transfer_settle_' || SUBSTRING(MD5(root."householdId" || '借入借出'), 1, 17),
    '借入借出',
    'transfer',
    root.id,
    root."householdId",
    TRUE
  FROM transfer_roots AS root
  ON CONFLICT ("householdId", name) DO UPDATE
  SET type = EXCLUDED.type, "parentId" = EXCLUDED."parentId", "isSystem" = TRUE
  RETURNING id, name, "householdId"
)
UPDATE "transactions" AS tx
SET "categoryId" = category.id,
    "categoryName" = category.name
FROM settlement_categories AS category
WHERE
  tx."householdId" = category."householdId"
  AND tx.type = 'transfer'
  AND tx."deletedAt" IS NULL
  AND (
    tx.source IN ('debt_borrow_in', 'debt_financed_purchase', 'debt_repay_out', 'debt_prepay_out', 'debt_lend_out', 'debt_collect_in')
    OR (
      tx.source = 'scheduled_task'
      AND EXISTS (
        SELECT 1
        FROM "Account" AS account
        WHERE account.id IN (tx."accountId", tx."toAccountId") AND account.kind = 'loan'
      )
    )
  )
  AND (
    tx."categoryId" IS NULL
    OR EXISTS (
      SELECT 1
      FROM "Category" AS current_category
      WHERE current_category.id = tx."categoryId" AND current_category."isSystem" = TRUE
    )
    OR tx."categoryName" IN ('往来款', '还款', '提前还款', '贷款还款', '借入', '借出', '出借', '收回')
  );
