export type InsuranceMetricMode = "balance" | "coverage" | "hybrid";

const BALANCE_PRODUCT_TYPES = new Set([
  "savings",
  "dividend",
  "annuity",
  "universal",
  "investment_linked",
]);

const HYBRID_PRODUCT_TYPES = new Set([
  "whole_life",
]);

const COVERAGE_PRODUCT_TYPES = new Set([
  "critical_illness",
  "medical",
  "accident",
  "term_life",
]);

export function getInsuranceMetricMode(
  productType?: string | null,
  accountingType?: string | null,
  cashValueEnabled?: boolean | null,
): InsuranceMetricMode {
  const normalizedProductType = String(productType ?? "").trim();
  const normalizedAccountingType = String(accountingType ?? "").trim();
  const hasCashValue = cashValueEnabled !== false;

  if (normalizedAccountingType === "hybrid") return "hybrid";
  if (normalizedAccountingType === "protection" && hasCashValue) return "hybrid";
  if (normalizedAccountingType === "protection") return "coverage";
  if (normalizedAccountingType === "asset") return "balance";
  if (HYBRID_PRODUCT_TYPES.has(normalizedProductType)) return "hybrid";
  if (COVERAGE_PRODUCT_TYPES.has(normalizedProductType) && hasCashValue) return "hybrid";
  if (COVERAGE_PRODUCT_TYPES.has(normalizedProductType)) return "coverage";
  if (BALANCE_PRODUCT_TYPES.has(normalizedProductType)) return "balance";
  return "balance";
}

export function getInsuranceMetricLabel(mode: InsuranceMetricMode) {
  if (mode === "coverage") return "保额";
  if (mode === "hybrid") return "现金价值";
  return "余额";
}

export function getInsuranceDisplayTypeLabel(mode: InsuranceMetricMode) {
  if (mode === "coverage") return "保障型";
  if (mode === "hybrid") return "混合型";
  return "资产型";
}

export function isInsuranceBalanceMetric(
  productType?: string | null,
  accountingType?: string | null,
  cashValueEnabled?: boolean | null,
) {
  const mode = getInsuranceMetricMode(productType, accountingType, cashValueEnabled);
  return mode === "balance" || mode === "hybrid";
}
