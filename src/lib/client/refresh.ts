"use client";

export const FINANCE_DATA_CHANGED_EVENT = "mmh:finance:changed";

export type FinanceDataChangedDetail = {
  reason?: string;
  accountIds?: string[];
  entryIds?: string[];
  deletedEntryIds?: string[];
  statementMonth?: string;
  /**
   * false = this change does NOT affect any account balance (e.g. a remark-only
   * edit). Heavy listeners (sidebar balances, top summary, holdings) must skip
   * their refresh in that case and only the affected record area refreshes.
   * Absent/true keeps the previous full-refresh behavior.
   */
  balanceChanged?: boolean;
};

/**
 * Broadcast a scoped finance-data change.
 *
 * Views should refresh only their affected rows, balances, and summaries.
 * A single event is dispatched: listeners must use FINANCE_DATA_CHANGED_EVENT.
 * (The legacy `mmh:fund:refresh` event and its dual-listening pattern were
 * removed so one save does not trigger every view's refresh twice.)
 */
export function dispatchFinanceDataChanged(detail: FinanceDataChangedDetail = {}) {
  window.dispatchEvent(new CustomEvent(FINANCE_DATA_CHANGED_EVENT, { detail }));
}
