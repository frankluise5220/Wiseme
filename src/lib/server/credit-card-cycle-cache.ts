import { AccountKind } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import {
  CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE,
  CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE,
} from "@/lib/credit/billing";

export async function invalidateCreditCardCycleCacheForAccountIds(
  accountIds: Iterable<string | null | undefined>,
  options: { deleteManualCycles?: boolean } = {},
) {
  const ids = Array.from(new Set(Array.from(accountIds).filter((id): id is string => !!id)));
  if (ids.length === 0) return 0;

  const billAccounts = await prisma.account.findMany({
    where: {
      id: { in: ids },
      kind: { in: [AccountKind.bank_credit, AccountKind.loan, AccountKind.settlement] },
      billingDay: { not: null },
    },
    select: { id: true },
  });
  if (billAccounts.length === 0) return 0;

  const result = await prisma.creditCardCycle.deleteMany({
    where: {
      accountId: { in: billAccounts.map((account) => account.id) },
      ...(options.deleteManualCycles
        ? {}
        : {
            OR: [
              { lockSource: null },
              {
                AND: [
                  { NOT: { lockSource: { contains: CREDIT_CARD_MANUAL_CYCLE_LOCK_SOURCE } } },
                  { NOT: { lockSource: { contains: CREDIT_CARD_STATEMENT_IMPORT_CYCLE_LOCK_SOURCE } } },
                ],
              },
            ],
          }),
    },
  });
  return result.count;
}
