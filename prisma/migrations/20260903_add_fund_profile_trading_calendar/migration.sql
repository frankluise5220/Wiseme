DO $$
BEGIN
  ALTER TYPE "TradingCalendar" ADD VALUE 'jp_fund';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "FundProfile" ADD COLUMN "tradingCalendar" "TradingCalendar";
