-- Add latest closing price date to stock holdings.
ALTER TABLE "stock_holdings" ADD COLUMN "latestPriceDate" TIMESTAMP(3);
