export type LoanPrepayStrategy = "reduce_term" | "reduce_payment" | "settle";

export const DEFAULT_LOAN_PREPAY_STRATEGY: LoanPrepayStrategy = "reduce_term";

const PAYLOAD_PREFIX = "MMH_LOAN_PREPAY:";

export function normalizeLoanPrepayStrategy(value: unknown): LoanPrepayStrategy {
  return value === "reduce_term" || value === "settle" || value === "reduce_payment"
    ? value
    : DEFAULT_LOAN_PREPAY_STRATEGY;
}

export function encodeLoanPrepayStrategy(value: unknown) {
  return `${PAYLOAD_PREFIX}${JSON.stringify({ strategy: normalizeLoanPrepayStrategy(value) })}`;
}

export function isEncodedLoanPrepayStrategy(value?: string | null) {
  return String(value ?? "").trim().startsWith(PAYLOAD_PREFIX);
}

export function parseLoanPrepayStrategy(value?: string | null): LoanPrepayStrategy | null {
  const text = String(value ?? "").trim();
  if (!text.startsWith(PAYLOAD_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(PAYLOAD_PREFIX.length));
    return normalizeLoanPrepayStrategy(parsed?.strategy);
  } catch {
    return null;
  }
}
