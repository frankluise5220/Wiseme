CREATE TABLE "UndoOperation" (
  "id" TEXT NOT NULL,
  "householdId" TEXT NOT NULL,
  "userId" TEXT,
  "action" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "snapshots" JSONB NOT NULL,
  "entryIds" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "undoneAt" TIMESTAMP(3),

  CONSTRAINT "UndoOperation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UndoOperation_householdId_userId_createdAt_idx"
ON "UndoOperation"("householdId", "userId", "createdAt");
