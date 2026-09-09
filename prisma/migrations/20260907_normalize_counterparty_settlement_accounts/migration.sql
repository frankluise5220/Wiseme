-- Normalize legacy counterparty debt accounts after splitting settlement from loan.
-- In 0.1.52, a loan account with counterpartyId was treated as a settlement
-- account even if dirty/manual data also retained institutionId.
ALTER TYPE "AccountKind" ADD VALUE IF NOT EXISTS 'settlement';

UPDATE "Account"
SET "kind" = 'settlement'::"AccountKind",
    "institutionId" = NULL,
    "loanType" = NULL,
    "isConsumerLoan" = FALSE
WHERE "kind" = 'loan'::"AccountKind"
  AND "counterpartyId" IS NOT NULL;

UPDATE "Account"
SET "institutionId" = NULL,
    "loanType" = NULL,
    "isConsumerLoan" = FALSE
WHERE "kind" = 'settlement'::"AccountKind";
