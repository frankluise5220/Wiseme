import { toNumber } from "@/lib/date-utils";

export type InsuranceAction = "premium" | "additional_premium" | "refund";

type InsuranceEntryLike = {
  readonly source?: string | null;
  readonly action?: string | null;
  readonly insuranceAction?: string | null;
  readonly insuranceProductName?: string | null;
  readonly fundSubtype?: string | null;
  readonly fundName?: string | null;
};

type InsuranceAmountEntryLike = InsuranceEntryLike & {
  readonly amount?: unknown;
};

export function isInsuranceEntry(entry: InsuranceEntryLike) {
  return entry.source === "insurance";
}

export function getInsuranceAction(entry: InsuranceEntryLike): InsuranceAction {
  if (entry.action === "refund") return "refund";
  if (entry.action === "additional_premium") return "additional_premium";
  if (entry.action === "premium") return "premium";
  if (entry.insuranceAction === "refund") return "refund";
  if (entry.insuranceAction === "additional_premium") return "additional_premium";
  if (entry.insuranceAction === "premium") return "premium";
  return entry.fundSubtype === "redeem" || entry.fundSubtype === "switch_out"
    ? "refund"
    : "premium";
}

export function normalizeInsuranceAction(value: unknown, fallback: InsuranceAction = "premium"): InsuranceAction {
  const raw = String(value ?? "").trim();
  if (raw === "refund") return "refund";
  if (raw === "additional_premium") return "additional_premium";
  if (raw === "premium") return "premium";
  return fallback;
}

export function isInsuranceRefund(entry: InsuranceEntryLike) {
  return getInsuranceAction(entry) === "refund";
}

export function insuranceCashValueDelta(entry: InsuranceAmountEntryLike) {
  const amount = Math.abs(toNumber(entry.amount));
  return isInsuranceRefund(entry) ? -amount : amount;
}

export function getInsuranceProductName(entry: InsuranceEntryLike) {
  return (entry.insuranceProductName ?? entry.fundName ?? "").trim();
}

export function insuranceActionToLegacyFundSubtype(action: InsuranceAction) {
  return action === "refund" ? "redeem" : "buy";
}

export function legacyFundSubtypeToInsuranceAction(fundSubtype?: string | null): InsuranceAction {
  return fundSubtype === "redeem" || fundSubtype === "switch_out" ? "refund" : "premium";
}
