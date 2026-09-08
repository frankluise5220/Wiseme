-- Add the `disposal` value to PropertyTransactionAction enum.
--
-- The original `20260813_add_property_domain` migration created the enum with
-- three values (purchase / improvement / sale), but the Prisma schema and the
-- application code both reference a fourth value, `disposal`. Newer code
-- paths (reports, cash-flow mapping, the property API handler) fail with
-- "invalid input value for enum 'PropertyTransactionAction': 'disposal'"
-- because the generated client passes the value in query parameters.
--
-- This migration only extends the enum; it does not touch existing rows.
-- PostgreSQL requires `ALTER TYPE ... ADD VALUE` to run outside an explicit
-- transaction, so the file must be applied with autocommit (Prisma migrate
-- does this automatically for SQL migrations).

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PropertyTransactionAction'
          AND e.enumlabel = 'disposal'
    ) THEN
        ALTER TYPE "PropertyTransactionAction" ADD VALUE 'disposal';
    END IF;
END $$;