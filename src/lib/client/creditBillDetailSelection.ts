"use client";

export const CREDIT_BILL_DETAIL_SELECTION_EVENT = "mmh:credit-bill-detail-selection";

export type CreditBillDetailSelectionDetail = {
  accountId: string;
  billMonth: string;
  href: string;
};

export function dispatchCreditBillDetailSelection(detail: CreditBillDetailSelectionDetail) {
  window.dispatchEvent(new CustomEvent<CreditBillDetailSelectionDetail>(CREDIT_BILL_DETAIL_SELECTION_EVENT, { detail }));
}
