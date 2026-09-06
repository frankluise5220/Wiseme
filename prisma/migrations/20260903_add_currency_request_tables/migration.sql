-- Add tables for the user-submitted custom currency approval workflow.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CustomCurrencyRequestStatus') THEN
        CREATE TYPE "CustomCurrencyRequestStatus" AS ENUM ('pending', 'approved', 'rejected');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ApprovedCurrency" (
    "id"        TEXT NOT NULL,
    "code"      TEXT NOT NULL,
    "nameZh"    TEXT NOT NULL,
    "nameEn"    TEXT NOT NULL,
    "countryZh" TEXT,
    "countryEn" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    CONSTRAINT "ApprovedCurrency_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ApprovedCurrency_code_key"
    ON "ApprovedCurrency"("code");

CREATE TABLE IF NOT EXISTS "CustomCurrencyRequest" (
    "id"           TEXT NOT NULL,
    "code"         TEXT NOT NULL,
    "nameZh"       TEXT NOT NULL,
    "nameEn"       TEXT NOT NULL,
    "countryZh"    TEXT NOT NULL,
    "countryEn"    TEXT,
    "status"       "CustomCurrencyRequestStatus" NOT NULL DEFAULT 'pending',
    "requesterId"  TEXT NOT NULL,
    "householdId"  TEXT,
    "approverId"   TEXT,
    "rejectReason" TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomCurrencyRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CustomCurrencyRequest_status_idx"
    ON "CustomCurrencyRequest"("status");
CREATE INDEX IF NOT EXISTS "CustomCurrencyRequest_requesterId_idx"
    ON "CustomCurrencyRequest"("requesterId");
CREATE INDEX IF NOT EXISTS "CustomCurrencyRequest_code_idx"
    ON "CustomCurrencyRequest"("code");
