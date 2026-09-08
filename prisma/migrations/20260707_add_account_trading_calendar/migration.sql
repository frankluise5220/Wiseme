DO $$
BEGIN
  CREATE TYPE "TradingCalendar" AS ENUM ('cn_fund', 'hk_fund', 'us_fund', 'generic_weekday');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Account"
ADD COLUMN IF NOT EXISTS "tradingCalendar" "TradingCalendar";

UPDATE "Account"
SET "tradingCalendar" = 'cn_fund'
WHERE "tradingCalendar" IS NULL
  AND "kind" = 'investment'
  AND "investProductType" IN ('fund', 'money');
