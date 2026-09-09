ALTER TYPE "AccountKind" ADD VALUE IF NOT EXISTS 'settlement';

UPDATE "Account"
SET "kind" = 'settlement',
    "loanType" = NULL,
    "isConsumerLoan" = FALSE
WHERE "kind" = 'loan'
  AND "counterpartyId" IS NOT NULL
  AND "institutionId" IS NULL;
