import { isLoanOrSettlementAccountKind } from "@/lib/debt";
import { resolveLoanTypeValue, type LoanTypeValue } from "@/lib/loan-type";

export { isDebtAccountKind, isLoanOrSettlementAccountKind } from "@/lib/debt";

export type AccountKindLike = {
  kind?: string | null;
  investProductType?: string | null;
  debtDirection?: string | null;
  isConsumerLoan?: boolean | null;
  loanType?: string | null;
};

export type CashTargetOperation = "transfer" | "investment" | "wealth" | "deposit" | "debt";

export type InvestmentAccountView = "investfund" | "investmoney" | "investwealth" | "investstock" | "investproperty";


export function isLegacyDepositAccount(account: AccountKindLike) {
  return account.kind === "investment" && account.investProductType === "deposit";
}

export function isDepositAccount(account: AccountKindLike) {
  return account.kind === "deposit" || isLegacyDepositAccount(account);
}

export function isPureInvestmentAccount(account: AccountKindLike) {
  return account.kind === "investment" && account.investProductType !== "deposit";
}

export function isFundLikeInvestmentAccount(account: AccountKindLike) {
  return isPureInvestmentAccount(account) && (account.investProductType === "fund" || account.investProductType === "money");
}

export function getInvestmentAccountView(account: Pick<AccountKindLike, "investProductType"> | null | undefined): InvestmentAccountView {
  if (account?.investProductType === "money") return "investmoney";
  if (account?.investProductType === "wealth") return "investwealth";
  if (account?.investProductType === "stock") return "investstock";
  if (account?.investProductType === "property") return "investproperty";
  return "investfund";
}

export function isInsuranceAccount(account: AccountKindLike) {
  return account.kind === "insurance";
}

export function isConsumerLoanAccount(account: AccountKindLike | null | undefined) {
  return account?.kind === "loan" && account.isConsumerLoan === true;
}

/**
 * Resolve the effective loan type for a loan account. Falls back to a derived
 * value from isConsumerLoan when loanType is not stored yet (legacy data).
 */
export function resolveLoanType(account: { kind?: string | null; isConsumerLoan?: boolean | null; loanType?: string | null } | null | undefined): LoanTypeValue | null {
  if (!account || account.kind !== "loan") return null;
  return resolveLoanTypeValue(account.loanType, account.isConsumerLoan);
}

export function isSpendableAccount(account: AccountKindLike | null | undefined) {
  return account?.kind === "cash" ||
    account?.kind === "bank_debit" ||
    account?.kind === "ewallet" ||
    account?.kind === "bank_credit" ||
    isConsumerLoanAccount(account);
}

export function isBillLikeAccount(account: Pick<AccountKindLike, "kind"> & { billingDay?: number | null }) {
  return account.kind === "bank_credit" && !!account.billingDay;
}

export function getCashTargetOperation(account: AccountKindLike | null | undefined): CashTargetOperation {
  if (!account) return "transfer";
  if (isDepositAccount(account)) return "deposit";
  if (isPureInvestmentAccount(account)) {
    // Investment accounts (including stock) do not participate in normal transfers; they only use their dedicated entry windows
    if (account.investProductType === "wealth") return "wealth";
    return "investment";
  }
  if (isLoanOrSettlementAccountKind(account.kind)) return "debt";
  return "transfer";
}

export function isSpecialCashTargetAccount(account: AccountKindLike | null | undefined) {
  return getCashTargetOperation(account) !== "transfer";
}
