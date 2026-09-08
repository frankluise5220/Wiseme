-- Add cache storage for market benchmark NAV series used by statistics charts.
CREATE TABLE IF NOT EXISTS "BenchmarkCache" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "navDate" TIMESTAMP(3) NOT NULL,
  "nav" DECIMAL(20,6) NOT NULL,
  "cumNav" DECIMAL(20,6),
  "name" TEXT,
  "source" TEXT DEFAULT 'eastmoney',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BenchmarkCache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BenchmarkCache_code_navDate_key"
  ON "BenchmarkCache"("code", "navDate");

CREATE INDEX IF NOT EXISTS "BenchmarkCache_code_idx"
  ON "BenchmarkCache"("code");

CREATE INDEX IF NOT EXISTS "BenchmarkCache_navDate_idx"
  ON "BenchmarkCache"("navDate");
