ALTER TABLE "transactions" ADD COLUMN "postedAt" TIMESTAMP(3);

CREATE INDEX "transactions_accountId_postedAt_idx" ON "transactions"("accountId", "postedAt");
