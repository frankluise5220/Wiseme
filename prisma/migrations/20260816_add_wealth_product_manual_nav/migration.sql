-- Manual NAV (unit value) entered by the user for a wealth product,
-- used to display real-time market value and floating P&L of wealth holdings.
ALTER TABLE "WealthProduct"
  ADD COLUMN IF NOT EXISTS "manualNav" DECIMAL(20, 6),
  ADD COLUMN IF NOT EXISTS "manualNavDate" TIMESTAMP(3);
