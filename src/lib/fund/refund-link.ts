import { isRegularInvestRefundEntry } from "@/lib/transaction-semantics";
type RefundLinkableEntry = {
  id: string;
  date: string | Date | null | undefined;
  createdAt?: string | Date | null | undefined;
  fundConfirmDate?: string | Date | null | undefined;
  fundArrivalDate?: string | Date | null | undefined;
  accountId?: string | null;
  toAccountId?: string | null;
  fundCode?: string | null;
  fundSubtype?: string | null;
  fundUnits?: number | null;
  source?: string | null;
  amount: number;
  regularInvestPlanId?: string | null;
  fundSourceEntryId?: string | null;
};

export type { RefundLinkableEntry };

export function getConfirmedBuyAmount(
  grossAmount: number | null | undefined,
  refundAmount: number | null | undefined = 0,
): number {
  const gross = Math.max(0, Math.abs(Number(grossAmount) || 0));
  const refund = Math.min(gross, Math.max(0, Math.abs(Number(refundAmount) || 0)));
  return Math.max(0, gross - refund);
}

export function calculateConfirmedBuyUnits(params: {
  grossAmount: number | null | undefined;
  refundAmount?: number | null | undefined;
  fee?: number | null | undefined;
  nav?: number | null | undefined;
  roundUnits?: (value: number) => number;
}): number | null {
  const nav = Number(params.nav);
  if (!Number.isFinite(nav) || nav <= 0) return null;
  const fee = Math.max(0, Number(params.fee) || 0);
  const confirmedAmount = getConfirmedBuyAmount(params.grossAmount, params.refundAmount);
  const sharePrincipal = Math.max(0, confirmedAmount - fee);
  if (sharePrincipal <= 0) return null;
  const units = sharePrincipal / nav;
  return params.roundUnits ? params.roundUnits(units) : units;
}

function toYmd(value: string | Date | null | undefined): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  if (!text) return "";
  return text.slice(0, 10);
}

function sortKey(entry: RefundLinkableEntry): string {
  return `${toYmd(entry.date)}::${toYmd(entry.createdAt)}::${entry.id}`;
}

function buildFlowKey(entry: RefundLinkableEntry, kind: "buy" | "refund"): string | null {
  if (kind === "buy" && (entry.fundSubtype ?? "") !== "buy") return null;
  if (kind === "refund" && !isRegularInvestRefundEntry(entry)) return null;
  const fundCode = String(entry.fundCode ?? "").trim();
  const fundAccountId = String(kind === "buy" ? entry.toAccountId : entry.accountId).trim();
  const cashAccountId = String(kind === "buy" ? entry.accountId : entry.toAccountId).trim();
  if (!fundCode || !fundAccountId || !cashAccountId) return null;
  return [fundCode, fundAccountId, cashAccountId].join("::");
}

function expectedRefundDates(entry: RefundLinkableEntry): string[] {
  const dates = [entry.fundArrivalDate, entry.fundConfirmDate, entry.date]
    .map(toYmd)
    .filter(Boolean);
  return Array.from(new Set(dates));
}

function isRefundLinkedToBuy(buy: RefundLinkableEntry, refund: RefundLinkableEntry): boolean {
  const explicitBuyId = String(refund.fundSourceEntryId ?? "").trim();
  if (explicitBuyId) return explicitBuyId === buy.id;

  const refundBuyAnchor = toYmd(refund.fundConfirmDate);
  if (refundBuyAnchor) {
    const buyAnchors = [buy.date, buy.fundConfirmDate, buy.fundArrivalDate].map(toYmd).filter(Boolean);
    return buyAnchors.includes(refundBuyAnchor);
  }

  const refundDate = toYmd(refund.date);
  if (!refundDate) return false;
  return expectedRefundDates(buy).includes(refundDate);
}

export function allocateBuyFailedRefunds(entries: RefundLinkableEntry[]) {
  const refundAmountByBuyId = new Map<string, number>();
  const matchedRefundIds = new Set<string>();
  const refundIdsByBuyId = new Map<string, Set<string>>();
  const buyIdsByRefundId = new Map<string, Set<string>>();

  const buysByKey = new Map<string, RefundLinkableEntry[]>();
  const refundsByKey = new Map<string, RefundLinkableEntry[]>();

  for (const entry of entries) {
    const buyKey = buildFlowKey(entry, "buy");
    if (buyKey) {
      const list = buysByKey.get(buyKey) ?? [];
      list.push(entry);
      buysByKey.set(buyKey, list);
      continue;
    }
    const refundKey = buildFlowKey(entry, "refund");
    if (refundKey) {
      const list = refundsByKey.get(refundKey) ?? [];
      list.push(entry);
      refundsByKey.set(refundKey, list);
    }
  }

  for (const [key, buys] of buysByKey) {
    const refunds = refundsByKey.get(key);
    if (!refunds || refunds.length === 0) continue;

    const sortedBuys = [...buys].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const sortedRefunds = [...refunds].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    const remainingByBuyId = new Map<string, number>();
    for (const buy of sortedBuys) {
      const grossBuyAmount = Math.max(0, Math.abs(Number(buy.amount) || 0));
      if (grossBuyAmount > 0) remainingByBuyId.set(buy.id, grossBuyAmount);
    }

    for (const refund of sortedRefunds) {
      let remainingRefund = Math.max(0, Math.abs(Number(refund.amount) || 0));
      if (remainingRefund <= 0) continue;

      for (const buy of sortedBuys) {
        if (remainingRefund <= 0) break;
        if (!isRefundLinkedToBuy(buy, refund)) continue;
        const remainingBuyAmount = remainingByBuyId.get(buy.id) ?? 0;
        if (remainingBuyAmount <= 0) continue;
        const allocated = Math.min(remainingBuyAmount, remainingRefund);
        if (allocated <= 0) continue;
        refundAmountByBuyId.set(buy.id, (refundAmountByBuyId.get(buy.id) ?? 0) + allocated);
        if (!refundIdsByBuyId.has(buy.id)) refundIdsByBuyId.set(buy.id, new Set());
        refundIdsByBuyId.get(buy.id)?.add(refund.id);
        if (!buyIdsByRefundId.has(refund.id)) buyIdsByRefundId.set(refund.id, new Set());
        buyIdsByRefundId.get(refund.id)?.add(buy.id);
        remainingByBuyId.set(buy.id, remainingBuyAmount - allocated);
        remainingRefund -= allocated;
      }

      if (remainingRefund < Math.max(0, Math.abs(Number(refund.amount) || 0))) matchedRefundIds.add(refund.id);
    }
  }

  return { refundAmountByBuyId, matchedRefundIds, refundIdsByBuyId, buyIdsByRefundId };
}

export function getNetBuyAmount(entryId: string, grossAmount: number, refundAmountByBuyId: Map<string, number>) {
  return getConfirmedBuyAmount(grossAmount, refundAmountByBuyId.get(entryId) ?? 0);
}

export function getEffectiveBuyUnits(storedUnits: number | null | undefined) {
  const units = Math.max(0, Number(storedUnits) || 0);
  return units;
}

export function getEffectiveBuyUnitsByRefunds(
  entry: Pick<RefundLinkableEntry, "id" | "amount"> & { fundUnits?: number | null },
  refundAmountByBuyId: Map<string, number>,
) {
  void refundAmountByBuyId;
  return getEffectiveBuyUnits(entry.fundUnits);
}


/**
 * Find the linked buy record(s) for a given refund entry, or the linked
 * refund record(s) for a given buy entry. Matching is by fundCode +
 * fundAccount + cashAccount, then by the refund record's buy anchor date
 * (fundConfirmDate) when present. Older rows without that anchor fall back to
 * matching the buy record's expected refund date. It deliberately does not
 * require regularInvestPlanId.
 */
export function findLinkedEntries(
  target: RefundLinkableEntry,
  allEntries: RefundLinkableEntry[],
): { linkedBuys: RefundLinkableEntry[]; linkedRefunds: RefundLinkableEntry[] } {
  const isRefund = isRegularInvestRefundEntry(target);
  const isBuy = (target.fundSubtype ?? "") === "buy";
  if (!isRefund && !isBuy) return { linkedBuys: [], linkedRefunds: [] };

  const targetFundCode = String(target.fundCode ?? "").trim();
  if (!toYmd(target.date) || !targetFundCode) return { linkedBuys: [], linkedRefunds: [] };
  const allocation = allocateBuyFailedRefunds(allEntries);

  if (isRefund) {
    const targetKey = buildFlowKey(target, "refund");
    const linkedBuyIds = allocation.buyIdsByRefundId.get(target.id) ?? new Set<string>();
    const linkedBuys = allEntries.filter(e => {
      if ((e.fundSubtype ?? "") !== "buy") return false;
      if (buildFlowKey(e, "buy") !== targetKey) return false;
      if (!isRefundLinkedToBuy(e, target)) return false;
      return linkedBuyIds.has(e.id);
    }).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    return { linkedBuys, linkedRefunds: [] };
  }

  const targetKey = buildFlowKey(target, "buy");
  const linkedRefundIds = allocation.refundIdsByBuyId.get(target.id) ?? new Set<string>();
  const linkedRefunds = allEntries.filter(e => {
    if (!isRegularInvestRefundEntry(e)) return false;
    if (buildFlowKey(e, "refund") !== targetKey) return false;
    if (!isRefundLinkedToBuy(target, e)) return false;
    return linkedRefundIds.has(e.id);
  }).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  return { linkedBuys: [], linkedRefunds };
}
