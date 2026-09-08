import {
  BALANCE_INITIALIZATION_SOURCE,
  BALANCE_RECONCILE_SOURCE,
  getBalanceReconcileTarget,
} from "@/lib/balance-reconcile";

type DetailEntryLike = {
  id: string;
  date: Date | string | number | null | undefined;
  postedAt?: Date | string | number | null | undefined;
  createdAt?: Date | string | number | null | undefined;
  dayOrder?: number | null | undefined;
  type: string;
  toAccountId?: string | null | undefined;
  fundSubtype?: string | null | undefined;
  source?: string | null | undefined;
  toNote?: string | null | undefined;
  fundConfirmDate?: Date | string | number | null | undefined;
  fundArrivalDate?: Date | string | number | null | undefined;
};

function toValidDate(value: Date | string | number | null | undefined) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function localDateKey(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isBalanceAnchor(entry: DetailEntryLike) {
  const source = String(entry.source ?? "");
  if (source !== BALANCE_RECONCILE_SOURCE && source !== BALANCE_INITIALIZATION_SOURCE) return false;
  return getBalanceReconcileTarget(entry) != null;
}

export function getDetailEntryDisplayDate(entry: DetailEntryLike, accountId?: string | null) {
  if (entry.type === "expense" || entry.type === "income") {
    return toValidDate(entry.postedAt) ?? toValidDate(entry.date) ?? new Date(0);
  }

  const isFundBuyRefundCashReceipt =
    entry.type === "investment" &&
    accountId &&
    entry.toAccountId === accountId &&
    entry.fundSubtype === "buy_failed" &&
    entry.source === "regular_invest_refund";
  if (isFundBuyRefundCashReceipt) {
    return toValidDate(entry.fundArrivalDate) ?? toValidDate(entry.date) ?? new Date(0);
  }

  const isInvestmentCashReceipt =
    entry.type === "investment" &&
    accountId &&
    entry.toAccountId === accountId &&
    (
      entry.fundSubtype === "redeem" ||
      entry.fundSubtype === "dividend_cash"
    );
  if (isInvestmentCashReceipt) {
    return toValidDate(entry.fundArrivalDate) ?? toValidDate(entry.date) ?? new Date(0);
  }

  return toValidDate(entry.date) ?? new Date(0);
}

export function compareDetailEntriesDesc(a: DetailEntryLike, b: DetailEntryLike, accountId?: string | null) {
  const aDate = getDetailEntryDisplayDate(a, accountId);
  const bDate = getDetailEntryDisplayDate(b, accountId);
  const aDay = localDateKey(aDate);
  const bDay = localDateKey(bDate);
  const byDay = bDay.localeCompare(aDay, "en");
  if (byDay !== 0) return byDay;

  const aAnchor = isBalanceAnchor(a);
  const bAnchor = isBalanceAnchor(b);
  if (aAnchor !== bAnchor) return aAnchor ? -1 : 1;

  const byDayOrder = (b.dayOrder ?? 0) - (a.dayOrder ?? 0);
  if (byDayOrder !== 0) return byDayOrder;

  const byDate = bDate.getTime() - aDate.getTime();
  if (byDate !== 0) return byDate;

  const byCreatedAt = (toValidDate(b.createdAt) ?? new Date(0)).getTime() - (toValidDate(a.createdAt) ?? new Date(0)).getTime();
  if (byCreatedAt !== 0) return byCreatedAt;

  return b.id.localeCompare(a.id, "en");
}

export function compareDetailEntriesAsc(a: DetailEntryLike, b: DetailEntryLike, accountId?: string | null) {
  return compareDetailEntriesDesc(b, a, accountId);
}
