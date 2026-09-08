-- Add Account.collateralAssetId: durable record of the collateral asset a
-- mortgage loan was borrowed against. Kept after settlement (the release only
-- clears PropertyAsset.mortgageLoanAccountId) so the settled loan record can
-- still show which collateral was used.
ALTER TABLE "Account" ADD COLUMN IF NOT EXISTS "collateralAssetId" TEXT;

-- Backfill from currently-marked mortgaged assets.
UPDATE "Account"
SET "collateralAssetId" = pa.id
FROM property_assets pa
WHERE pa."mortgageLoanAccountId" = "Account"."id"
  AND pa."deletedAt" IS NULL
  AND "Account"."collateralAssetId" IS NULL;
