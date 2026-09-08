import { toNumber } from "@/lib/date-utils";

export const BALANCE_RECONCILE_SOURCE = "balance_reconcile";
export const BALANCE_INITIALIZATION_SOURCE = "initialization";

const TARGET_PREFIX = "balance_reconcile_target:";

type BalanceReconcileEntryLike = {
  source?: string | null;
  toNote?: string | null;
};

type AccountFlowEntryLike = BalanceReconcileEntryLike & {
  amount: unknown;
  debtPrincipalAmount?: unknown;
  fundArrivalAmount?: unknown;
  toAccountId?: string | null;
};

export function encodeBalanceReconcileTarget(balance: number) {
  return `${TARGET_PREFIX}${Number(balance).toFixed(2)}`;
}

export function getBalanceReconcileTarget(entry: BalanceReconcileEntryLike) {
  const raw = String(entry.toNote ?? "").trim();
  if (!raw.startsWith(TARGET_PREFIX)) return null;
  const value = Number(raw.slice(TARGET_PREFIX.length));
  return Number.isFinite(value) ? value : null;
}

export function effectiveAmountForAccount(entry: AccountFlowEntryLike, accountId?: string | null) {
  const target = getBalanceReconcileTarget(entry);
  if (target != null) return 0;
  const amount = toNumber(entry.amount);
  const isDebtReceivingSide = accountId && entry.toAccountId === accountId && entry.debtPrincipalAmount != null;
  if (isDebtReceivingSide) return toNumber(entry.debtPrincipalAmount);
  return accountId && entry.toAccountId === accountId
    ? Math.abs(toNumber(entry.fundArrivalAmount ?? amount))
    : amount;
}

export function applyBalanceReconcileEntry(
  currentBalance: number,
  entry: AccountFlowEntryLike,
  accountId?: string | null,
) {
  const target = getBalanceReconcileTarget(entry);
  if (target != null) return target;
  return currentBalance + effectiveAmountForAccount(entry, accountId);
}
