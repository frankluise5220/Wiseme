import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";

/**
 * Records account usage: increments usageCount and refreshes lastUsedAt.
 *
 * This is the shared backend signal for "most frequently used accounts" so
 * Web, iOS and Android entry forms can order account selectors the same way.
 * It is best-effort: a tracking failure must never fail the transaction save.
 */
export async function touchAccountUsage(accountIds: Array<string | null | undefined>) {
  const ids = Array.from(
    new Set(accountIds.map((id) => String(id ?? "").trim()).filter(Boolean)),
  );
  if (ids.length === 0) return;
  try {
    await prisma.account.updateMany({
      where: { id: { in: ids } },
      data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
    });
  } catch (error) {
    // Non-fatal: usage tracking must not break the entry save flow.
    logger.catchLog("account usage tracking failed", "server/account-usage")(error);
  }
}
