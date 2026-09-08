-- Create and/or upgrade the fund-level profile table.
CREATE TABLE IF NOT EXISTS "FundProfile" (
  "fundCode" TEXT NOT NULL,
  "fundName" TEXT,
  "fundCompany" TEXT,
  "fundCompanyCode" TEXT,
  "custodian" TEXT,
  "manager" TEXT,
  "navDateOffset" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FundProfile_pkey" PRIMARY KEY ("fundCode")
);

ALTER TABLE "FundProfile"
  ADD COLUMN IF NOT EXISTS "navDateOffset" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "FundProfile_fundCompany_idx"
  ON "FundProfile"("fundCompany");
