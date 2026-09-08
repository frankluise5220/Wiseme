import { SYSTEM_FUND_REGULAR_INVEST_CATEGORY } from "@/lib/investment-category";
import { formatCurrencyMoney } from "@/lib/format";

export const REGULAR_INVEST_CATEGORY_NAME = SYSTEM_FUND_REGULAR_INVEST_CATEGORY;

function dateText(value: Date | string | null | undefined) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function investmentDisplayName(fundCode: string | null | undefined, fundName: string | null | undefined) {
  const code = String(fundCode ?? "").trim();
  const name = String(fundName ?? "").trim();
  return name && name !== code ? `${code}${name}` : code;
}

export function regularInvestBuyNote(fundCode: string | null | undefined, fundName: string | null | undefined) {
  const displayName = investmentDisplayName(fundCode, fundName);
  return displayName ? `定投 ${displayName}` : "定投";
}

export function regularInvestFailureNote(
  fundCode: string | null | undefined,
  fundName: string | null | undefined,
  purchaseDate: Date | string | null | undefined,
) {
  const date = dateText(purchaseDate);
  const displayName = investmentDisplayName(fundCode, fundName);
  const suffix = displayName ? `买入 ${displayName}` : "买入";
  return date ? `买入失败，购买日期 ${date}，${suffix}` : `买入失败，${suffix}`;
}

export function regularInvestRefundNote(
  fundCode: string | null | undefined,
  fundName: string | null | undefined,
  refundAmount: number | null | undefined,
  purchaseDate: Date | string | null | undefined,
  currency = "CNY",
  userNote?: string | null,
) {
  const amount = formatCurrencyMoney(Math.abs(Number(refundAmount) || 0), currency);
  const date = dateText(purchaseDate);
  const displayName = investmentDisplayName(fundCode, fundName);
  const suffix = displayName ? `买入 ${displayName}` : "买入";
  const detail = date
    ? `买入退回 ${amount}，购买日期 ${date}，${suffix}`
    : `买入退回 ${amount}，${suffix}`;
  const memo = String(userNote ?? "").trim();
  return memo && memo !== detail ? `${memo}；${detail}` : detail;
}
