export type AdvanceTransferAccountLike = {
  id: string;
  name: string;
  kind?: string | null;
  billingDay?: number | null;
};

export function resolveAdvanceTransfer(input: {
  amount: number;
  cashAccount: AdvanceTransferAccountLike;
  advanceAccount: AdvanceTransferAccountLike;
}) {
  const amountAbs = Math.abs(input.amount);
  const isReturn = input.amount < 0;
  const fromAccount = isReturn ? input.advanceAccount : input.cashAccount;
  const toAccount = isReturn ? input.cashAccount : input.advanceAccount;
  return {
    isReturn,
    amountAbs,
    fromAccount,
    toAccount,
    transferAmount: -amountAbs,
    defaultNote: isReturn ? "代付返还" : "代付",
  };
}

export function advanceDialogAmount(input: {
  amount: number;
  accountKind?: string | null;
  source?: string | null;
}) {
  if (input.source !== "advance") return input.amount;
  const amountAbs = Math.abs(input.amount);
  return input.accountKind === "loan" ? -amountAbs : amountAbs;
}
