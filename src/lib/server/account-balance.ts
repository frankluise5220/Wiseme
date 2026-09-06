import { prisma } from "@/lib/db/prisma";
import { AccountKind, TransactionType } from "@prisma/client";
import { toNumber } from "@/lib/date-utils";
import { compareDetailEntriesAsc, getDetailEntryDisplayDate } from "@/lib/detail-entry-order";
import { applyBalanceReconcileEntry, getBalanceReconcileTarget } from "@/lib/balance-reconcile";
import { isLoanOrSettlementAccountKind } from "@/lib/debt";
import { debtPrincipalForAccountSide } from "@/lib/debt";
import { txRecordAccountScopeWhere } from "@/lib/transaction-account-scope";

const FX_CONVERSION_SOURCE = "fx_conversion";

type AccountBalanceLike = {
  id: string;
  kind: AccountKind;
  investProductType?: string | null;
  billingDay?: number | null;
};

function localDateKey(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function computeAccountDisplayBalances(
  accounts: AccountBalanceLike[],
  hidFilter?: { householdId?: string },
) {
  const accountIds = accounts.map((account) => account.id).filter(Boolean);
  const result = new Map<string, number>();
  if (accountIds.length === 0) return result;
  const todayKey = localDateKey(new Date());
  const isOnOrBeforeToday = (date: Date) => localDateKey(date) <= todayKey;
  const depositAccountIds = accounts
    .filter((account) => account.kind === AccountKind.deposit || account.investProductType === "deposit")
    .map((account) => account.id);
  const depositAccountIdSet = new Set(depositAccountIds);

  const txWhere = {
    deletedAt: null,
    ...(hidFilter ?? {}),
  };

  if (depositAccountIds.length > 0) {
    const depositEntries = await prisma.depositTransaction.findMany({
      where: {
        deletedAt: null,
        ...(hidFilter ?? {}),
        accountId: { in: depositAccountIds },
      },
      select: {
        id: true,
        accountId: true,
        tradeDate: true,
        principalAmount: true,
        arrivalAmount: true,
        action: true,
        sourceDepositTransactionId: true,
      },
      orderBy: [{ tradeDate: "asc" }, { id: "asc" }],
    });

    const remainingByLotId = new Map<string, { depositAccountId: string; amount: number }>();
    for (const entry of depositEntries) {
      if (!isOnOrBeforeToday(entry.tradeDate)) continue;
      const isRedeem = entry.action === "redeem" || entry.action === "switch_out";
      const depositAccountId = entry.accountId;
      if (!depositAccountId || !depositAccountIdSet.has(depositAccountId)) continue;

      if (!isRedeem) {
        remainingByLotId.set(entry.id, {
          depositAccountId,
          amount: Math.abs(toNumber(entry.arrivalAmount ?? entry.principalAmount)),
        });
        continue;
      }

      if (entry.sourceDepositTransactionId) {
        const lot = remainingByLotId.get(entry.sourceDepositTransactionId);
        if (lot) lot.amount = 0;
      }
    }

    for (const id of depositAccountIds) result.set(id, 0);
    for (const lot of remainingByLotId.values()) {
      result.set(lot.depositAccountId, (result.get(lot.depositAccountId) ?? 0) + lot.amount);
    }

    // Deposit accounts may also carry ordinary income/expense and transfers.
    // Deposit business entries (type=investment with fundProductType=deposit) are
    // already counted via DepositTransaction as unredeemed arrival amounts; only
    // non-deposit TxRecords are layered on top here to avoid double counting.
    const depositTxRows = await prisma.txRecord.findMany({
      where: {
        ...txWhere,
        ...txRecordAccountScopeWhere(depositAccountIds),
        NOT: {
          type: TransactionType.investment,
          fundProductType: "deposit",
        },
      },
      select: {
        id: true,
        date: true,
        postedAt: true,
        createdAt: true,
        dayOrder: true,
        type: true,
        amount: true,
        accountId: true,
        toAccountId: true,
        toNote: true,
        source: true,
        debtPrincipalAmount: true,
        fundSubtype: true,
        fundConfirmDate: true,
        fundArrivalDate: true,
      },
    });

    const depositTxByAccountId = new Map<string, typeof depositTxRows>();
    for (const accountId of depositAccountIds) {
      depositTxByAccountId.set(accountId, []);
    }
    for (const entry of depositTxRows) {
      if (entry.accountId && depositTxByAccountId.has(entry.accountId)) {
        depositTxByAccountId.get(entry.accountId)?.push(entry);
      }
      if (entry.source !== FX_CONVERSION_SOURCE && entry.toAccountId && depositTxByAccountId.has(entry.toAccountId)) {
        depositTxByAccountId.get(entry.toAccountId)?.push(entry);
      }
    }

    for (const account of accounts) {
      if (!depositAccountIdSet.has(account.id)) continue;
      const rows = depositTxByAccountId.get(account.id) ?? [];
      const orderedRows = rows
        .filter((entry) => isOnOrBeforeToday(getDetailEntryDisplayDate(entry, account.id)))
        .sort((a, b) => compareDetailEntriesAsc(a, b, account.id));
      let runningBalance = result.get(account.id) ?? 0;
      for (const entry of orderedRows) {
        runningBalance = applyBalanceReconcileEntry(runningBalance, entry, account.id);
      }
      result.set(account.id, runningBalance);
    }
  }

  const nonDepositAccounts = accounts.filter(
    (account) => account.kind !== AccountKind.deposit && account.investProductType !== "deposit",
  );
  const nonDepositAccountIds = nonDepositAccounts.map((account) => account.id);

  if (nonDepositAccountIds.length > 0) {
    const txRows = await prisma.txRecord.findMany({
      where: {
        ...txWhere,
        ...txRecordAccountScopeWhere(nonDepositAccountIds),
      },
      select: {
        id: true,
        date: true,
        postedAt: true,
        createdAt: true,
        dayOrder: true,
        type: true,
        amount: true,
        accountId: true,
        toAccountId: true,
        toNote: true,
        source: true,
        debtPrincipalAmount: true,
        fundSubtype: true,
        fundConfirmDate: true,
        fundArrivalDate: true,
      },
    });

    const txByAccountId = new Map<string, typeof txRows>();
    for (const accountId of nonDepositAccountIds) {
      txByAccountId.set(accountId, []);
    }
    for (const entry of txRows) {
      if (entry.accountId && txByAccountId.has(entry.accountId)) {
        txByAccountId.get(entry.accountId)?.push(entry);
      }
      if (entry.source !== FX_CONVERSION_SOURCE && entry.toAccountId && txByAccountId.has(entry.toAccountId)) {
        txByAccountId.get(entry.toAccountId)?.push(entry);
      }
    }

    for (const account of nonDepositAccounts) {
      const isCreditBill = account.kind === AccountKind.bank_credit && !!account.billingDay;
      if (isCreditBill) {
        result.set(account.id, 0);
        continue;
      }

      const rows = txByAccountId.get(account.id) ?? [];
      const orderedRows = rows
        .filter((entry) => isOnOrBeforeToday(getDetailEntryDisplayDate(entry, account.id)))
        .sort((a, b) => compareDetailEntriesAsc(a, b, account.id));
      let runningBalance = 0;
      for (const entry of orderedRows) {
        if (isLoanOrSettlementAccountKind(account.kind)) {
          if (getBalanceReconcileTarget(entry) != null) {
            runningBalance = applyBalanceReconcileEntry(runningBalance, entry, account.id);
            continue;
          }
          if (entry.type !== TransactionType.transfer) continue;
          runningBalance += debtPrincipalForAccountSide(entry, account.id);
          continue;
        }
        runningBalance = applyBalanceReconcileEntry(runningBalance, entry, account.id);
      }
      result.set(account.id, runningBalance);
    }
  }

  return result;
}

export async function computeLoanPrincipalBalancesAsOf(
  accounts: AccountBalanceLike[],
  hidFilter: { householdId?: string } | undefined,
  asOfDate: Date,
  options?: { excludeEntryId?: string | null },
) {
  const accountIds = accounts
    .filter((account) => isLoanOrSettlementAccountKind(account.kind))
    .map((account) => account.id)
    .filter(Boolean);
  const result = new Map<string, number>();
  for (const accountId of accountIds) {
    result.set(accountId, 0);
  }
  if (accountIds.length === 0 || !Number.isFinite(asOfDate.getTime())) return result;

  const asOfDateKey = asOfDate.toISOString().slice(0, 10);
  const txRows = await prisma.txRecord.findMany({
    where: {
      deletedAt: null,
      ...(hidFilter ?? {}),
      ...txRecordAccountScopeWhere(accountIds),
      ...(options?.excludeEntryId ? { id: { not: options.excludeEntryId } } : {}),
    },
    select: {
      id: true,
      date: true,
      postedAt: true,
      createdAt: true,
      dayOrder: true,
      type: true,
      amount: true,
      accountId: true,
      toAccountId: true,
      toNote: true,
      source: true,
      debtPrincipalAmount: true,
      fundSubtype: true,
      fundConfirmDate: true,
      fundArrivalDate: true,
    },
  });

  const txByAccountId = new Map<string, typeof txRows>();
  for (const accountId of accountIds) {
    txByAccountId.set(accountId, []);
  }
  for (const entry of txRows) {
    if (entry.accountId && txByAccountId.has(entry.accountId)) {
      txByAccountId.get(entry.accountId)?.push(entry);
    }
    if (entry.source !== FX_CONVERSION_SOURCE && entry.toAccountId && txByAccountId.has(entry.toAccountId)) {
      txByAccountId.get(entry.toAccountId)?.push(entry);
    }
  }

  for (const accountId of accountIds) {
    const orderedRows = (txByAccountId.get(accountId) ?? [])
      .filter((entry) => getDetailEntryDisplayDate(entry, accountId).toISOString().slice(0, 10) <= asOfDateKey)
      .sort((a, b) => compareDetailEntriesAsc(a, b, accountId));
    let runningBalance = 0;
    for (const entry of orderedRows) {
      const reconcileTarget = getBalanceReconcileTarget(entry);
      if (reconcileTarget != null) {
        runningBalance = reconcileTarget;
        continue;
      }
      if (entry.type !== TransactionType.transfer) continue;
      runningBalance += debtPrincipalForAccountSide(entry, accountId);
    }
    result.set(accountId, runningBalance);
  }

  return result;
}

/**
 * Recalculate an account's display balance and persist it to Account.balance.
 * For incoming-side records, the receiver always treats the flow as positive.
 */
export async function recalcAndSaveAccountBalance(accountId: string) {
  const acc = await prisma.account.findUnique({
    where: { id: accountId },
    select: { kind: true, investProductType: true, billingDay: true },
  });
  if (!acc) return;

  // Credit-bill accounts (bank_credit with a billing day) always fold to a
  // display balance of 0 — computeAccountDisplayBalances discards the folded
  // sum for them because the shown balance is derived from the
  // CreditCardCycle cache. Skip the full transaction-history scan entirely so
  // saving entries on a credit card does not pull its entire ledger.
  if (acc.kind === AccountKind.bank_credit && acc.billingDay) {
    await prisma.account
      .update({ where: { id: accountId }, data: { balance: "0" } })
      .catch(() => {});
    return;
  }

  const balanceMap = await computeAccountDisplayBalances([
    { id: accountId, kind: acc.kind, investProductType: acc.investProductType, billingDay: acc.billingDay },
  ]);
  const newBalance = String(balanceMap.get(accountId) ?? 0);

  await prisma.account
    .update({ where: { id: accountId }, data: { balance: newBalance } })
    .catch(() => {});
}
