export type SignedAmountInflowSign = "positive" | "negative";
export type MoneyDirection = "in" | "out";

const TOKEN_SEPARATOR = "[\\s/\\\\|,.;:(){}\\-_+\\u3000\\uff0c\\u3001\\uff1b\\uff1a\\uff08\\uff09\\u3010\\u3011]";
const STANDALONE_REPAYMENT_RE = new RegExp(
  `(?:^|${TOKEN_SEPARATOR})\\u8fd8\\u6b3e(?:$|${TOKEN_SEPARATOR})`,
  "i",
);
const STANDALONE_PAYMENT_RE = /^\s*payment\s*$/i;
const EXPLICIT_REPAYMENT_RE =
  /\u94f6\u8054\u5165\u8d26|\u94f6\u8054\u8f6c\u8d26|\u4ed8\u6b3e\u5c3e\u53f7|\u6263\u6b3e\u5c3e\u53f7|\u8fd8\u6b3e\u5c3e\u53f7|\u81ea\u52a8\u8fd8\u6b3e|\u81ea\u52a8\u6263\u6b3e|\u4fe1\u7528\u5361\u8fd8\u6b3e|\u8fd8\u6b3e\u5165\u8d26|\u8fd8\u6b3e\u6210\u529f|\u6210\u529f\u8fd8\u6b3e|\u5df2\u8fd8\u6b3e|repayment|autopay|auto\s*pay|automatic\s+payment|payment\s+(?:received|posted|made|credited)|payment\s*[-\u2013\u2014]\s*thank\s+you|thank\s+you(?:\s+for)?(?:\s+your)?\s+payment/i;

export function isCreditCardRepaymentLikeText(text: string) {
  const normalized = String(text ?? "");
  return EXPLICIT_REPAYMENT_RE.test(normalized) ||
    STANDALONE_REPAYMENT_RE.test(normalized) ||
    STANDALONE_PAYMENT_RE.test(normalized);
}

export function isExpenseRefundLikeText(text: string) {
  const normalized = String(text ?? "");
  if (!normalized.trim()) return false;
  if (isCreditCardRepaymentLikeText(normalized)) return false;
  return /\u9000\u6b3e|\u9000\u8d27|\u9000\u56de|\u6d88\u8d39\u64a4\u9500|\u4ea4\u6613\u64a4\u9500|\u51b2\u6b63|\u64a4\u9500|Refund|Return|Reversal/i.test(normalized);
}

export function isCreditCardCreditAdjustmentLikeText(text: string) {
  const normalized = String(text ?? "");
  if (!normalized.trim()) return false;
  if (isCreditCardRepaymentLikeText(normalized)) return false;
  return /\u5237\u5361\u91d1|\u62b5\u6263|\u51b2\u62b5|\u51cf\u514d|\u4f18\u60e0|\u8fd4\u73b0|\u9000\u6b3e|\u9000\u8d27|\u9000\u56de|\u64a4\u9500|\u51b2\u6b63|\u5206\u671f\u8f6c\u5206\u671f\u4ed8\u6b3e|Credit|Refund|Return|Reversal/i.test(normalized);
}

export function isDefiniteCreditCardInflowText(text: string) {
  return isCreditCardRepaymentLikeText(text) ||
    isExpenseRefundLikeText(text) ||
    isCreditCardCreditAdjustmentLikeText(text);
}

export function inferSignedAmountInflowSign(
  samples: Array<{ amount: number | null | undefined; text: string; definiteInflow?: boolean }>,
): SignedAmountInflowSign | null {
  let positiveInflowVotes = 0;
  let negativeInflowVotes = 0;
  for (const sample of samples) {
    const amount = Number(sample.amount ?? 0);
    if (!Number.isFinite(amount) || amount === 0) continue;
    const definiteInflow = sample.definiteInflow ?? isDefiniteCreditCardInflowText(sample.text);
    if (!definiteInflow) continue;
    if (amount > 0) positiveInflowVotes += 1;
    if (amount < 0) negativeInflowVotes += 1;
  }
  if (positiveInflowVotes === negativeInflowVotes) return null;
  return positiveInflowVotes > negativeInflowVotes ? "positive" : "negative";
}

export function signedAmountDirection(
  amount: number | null | undefined,
  inflowSign: SignedAmountInflowSign | null,
  fallbackInflowSign: SignedAmountInflowSign = "negative",
): MoneyDirection | null {
  const value = Number(amount ?? 0);
  if (!Number.isFinite(value) || value === 0) return null;
  const sign = inflowSign ?? fallbackInflowSign;
  if (sign === "positive") return value > 0 ? "in" : "out";
  return value < 0 ? "in" : "out";
}
