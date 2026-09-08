export const LOAN_TYPES = ["home", "mortgage", "consumer", "other"] as const;
export type LoanTypeValue = (typeof LOAN_TYPES)[number];

export function normalizeLoanType(raw: unknown): LoanTypeValue | null {
  const value = String(raw ?? "").trim();
  return LOAN_TYPES.includes(value as LoanTypeValue) ? (value as LoanTypeValue) : null;
}

export function resolveLoanTypeValue(raw: unknown, isConsumerLoan?: boolean | null): LoanTypeValue {
  return normalizeLoanType(raw) ?? (isConsumerLoan === true ? "consumer" : "home");
}

export function isHomeLoanType(raw: unknown) {
  return normalizeLoanType(raw) === "home";
}

export function isCollateralLoanType(raw: unknown) {
  return normalizeLoanType(raw) === "mortgage";
}
