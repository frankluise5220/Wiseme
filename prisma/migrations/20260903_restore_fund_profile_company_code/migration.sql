-- Restore the FundProfile.fundCompanyCode column for migrate-deploy databases.
--
-- 0.1.46 shipped two contradictory changes: the schema (both variants) kept
-- `fundCompanyCode` after the 0.1.47 crash fix re-added it, while the
-- `20260830_clear_invalid_fund_company_codes` migration dropped it. Every
-- `prisma migrate deploy` path therefore ended without the column while the
-- schema still declared it, and any non-select FundProfile query failed with
-- "column FundProfile.fundCompanyCode does not exist".
--
-- The schema is the source of truth here: Docker updates re-create the column
-- via `prisma db push`, fnOS/Synology ship it through native-init.sql, and no
-- runtime code reads the value. This migration makes the deploy path converge
-- to the same state instead of staying drifted.
ALTER TABLE "FundProfile"
  ADD COLUMN IF NOT EXISTS "fundCompanyCode" TEXT;
