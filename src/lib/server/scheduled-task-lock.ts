import type { Prisma } from "@prisma/client";

function isSqliteDatabaseUrl() {
  const url = process.env.DATABASE_URL ?? "";
  return url === ":memory:" || url.startsWith("file:");
}

/**
 * Serializes scheduled-task writes for one plan inside the current DB transaction.
 * This prevents two concurrent requests from both passing the pre-check and
 * inserting the same plan/date records before either transaction commits.
 */
export async function acquireScheduledTaskPlanLock(tx: Prisma.TransactionClient, planId: string) {
  if (isSqliteDatabaseUrl()) return;
  try {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`scheduled-task:${planId}`}))`;
  } catch (error) {
    // Defense-in-depth: if the advisory lock function is unavailable (e.g.,
    // running on SQLite despite the guard above), skip the lock rather than
    // crashing. SQLite has its own transaction isolation so the advisory
    // lock is not needed. Re-throw genuine PostgreSQL errors.
    const msg = String((error as { message?: unknown } | null | undefined)?.message ?? error);
    if (msg.includes("hashtext") || msg.includes("no such function")) {
      return;
    }
    throw error;
  }
}
