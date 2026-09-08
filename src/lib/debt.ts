export type DebtDirectionValue = "payable" | "receivable";

export const DEBT_DIRECTION_LABELS: Record<DebtDirectionValue, string> = {
  payable: "我欠别人",
  receivable: "别人欠我",
};

export function isDebtAccountKind(kind: string | null | undefined) {
  return kind === "bank_credit" || isLoanOrSettlementAccountKind(kind);
}

export function isLoanOrSettlementAccountKind(kind: string | null | undefined) {
  return kind === "loan" || kind === "settlement";
}

export function normalizeDebtDirection(
  kind: string | null | undefined,
  raw: unknown,
): DebtDirectionValue | null {
  if (!isDebtAccountKind(kind)) return null;
  if (kind === "bank_credit") return "payable";
  const value = String(raw ?? "").trim();
  return value === "receivable" ? "receivable" : "payable";
}

export function debtDirectionLabel(raw: string | null | undefined) {
  return raw === "receivable" ? DEBT_DIRECTION_LABELS.receivable : DEBT_DIRECTION_LABELS.payable;
}

export function debtActionLabel(params: {
  direction: string | null | undefined;
  isDebtAccountFromSide: boolean;
}) {
  if (params.direction === "receivable") {
    return params.isDebtAccountFromSide ? "收回" : "出借";
  }
  return params.isDebtAccountFromSide ? "借入" : "还款";
}

export type DebtPrincipalEntryLike = {
  amount: unknown;
  debtPrincipalAmount?: unknown;
  source?: string | null;
  accountId?: string | null;
  toAccountId?: string | null;
};

function debtNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export function debtPrincipalForAccountSide(
  entry: DebtPrincipalEntryLike,
  debtAccountIdOrIds: string | Set<string>,
) {
  const amount = debtNumber(entry.amount);
  const principal = entry.debtPrincipalAmount == null ? Math.abs(amount) : debtNumber(entry.debtPrincipalAmount);
  const source = String(entry.source ?? "");
  if (source === "debt_borrow_in" || source === "debt_financed_purchase") return -principal;
  if (source === "debt_repay_out" || source === "debt_prepay_out") return principal;
  if (source === "debt_lend_out") return principal;
  if (source === "debt_collect_in") return -principal;
  if (source === "scheduled_task") return principal;

  const isToDebtAccount = typeof debtAccountIdOrIds === "string"
    ? entry.toAccountId === debtAccountIdOrIds
    : debtAccountIdOrIds.has(entry.toAccountId ?? "");
  if (!isToDebtAccount) return amount;
  return principal;
}
