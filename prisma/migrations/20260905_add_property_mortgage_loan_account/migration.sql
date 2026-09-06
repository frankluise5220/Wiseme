ALTER TABLE "property_assets" ADD COLUMN IF NOT EXISTS "mortgageLoanAccountId" TEXT;

CREATE INDEX IF NOT EXISTS "property_assets_householdId_mortgageLoanAccountId_idx"
  ON "property_assets"("householdId", "mortgageLoanAccountId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'property_assets_mortgageLoanAccountId_fkey') THEN
    ALTER TABLE "property_assets"
      ADD CONSTRAINT "property_assets_mortgageLoanAccountId_fkey"
      FOREIGN KEY ("mortgageLoanAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;
