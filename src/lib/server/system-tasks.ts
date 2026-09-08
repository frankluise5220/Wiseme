import { prisma } from "@/lib/db/prisma";
import { materializeDueInstallmentPayments } from "@/lib/server/credit-card-installment";
import { logger } from "@/lib/logger";

/**
 * System-level scheduled tasks (no user session required).
 *
 * Currently: materialize due credit-card installment payment rows for ALL
 * households. Runs periodically from `src/instrumentation.ts` so installments
 * are generated exactly when their date arrives, independent of any login.
 */
export async function runDueSystemTasks(): Promise<{ materializedInstallments: number }> {
  const households = await prisma.household.findMany({ select: { id: true } });
  let materializedInstallments = 0;
  for (const household of households) {
    try {
      const result = await materializeDueInstallmentPayments(prisma, { householdId: household.id });
      materializedInstallments += result.materialized;
    } catch (error) {
      logger.error("installment materialization failed for household", "system-task", { householdId: household.id, error });
    }
  }
  if (materializedInstallments > 0) {
    logger.info(`system task materialized ${materializedInstallments} installment rows`, "system-task");
  }
  return { materializedInstallments };
}
