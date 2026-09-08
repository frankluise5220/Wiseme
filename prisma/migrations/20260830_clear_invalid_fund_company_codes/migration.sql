-- Eastmoney provider link identifiers are not official regulator codes.
-- Remove the invalid legacy column instead of exposing or consuming it.
ALTER TABLE "FundProfile"
  DROP COLUMN IF EXISTS "fundCompanyCode";
