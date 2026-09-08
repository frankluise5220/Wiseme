-- Wallet is an account kind, not an institution type.
-- Normalize legacy wallet institutions to the payment-platform type.
UPDATE "Institution"
SET "type" = 'payment'
WHERE "type" = 'ewallet';
