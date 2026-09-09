"use client";

import { UnifiedEntryLauncher } from "@/components/UnifiedEntryLauncher";
import { useI18n } from "@/lib/i18n";

export function TopEntryLauncher({
  defaultAction = "transaction",
}: {
  defaultAction?:
    | "transaction"
    | "transfer"
    | "fx"
    | "fx-sell"
    | "investment"
    | "stock"
    | "stock-transfer"
    | "wealth"
    | "deposit-buy"
    | "deposit-redeem"
    | "insurance"
    | "debt"
    | "regular-task";
}) {
  const { t } = useI18n();
  return (
    <UnifiedEntryLauncher
      defaultAction={defaultAction}
      actions={[
        { key: "transaction", label: t("basicDetail.guide.entry.title") },
        { key: "transfer", label: t("transaction.type.transfer") },
        {
          key: "fx",
          label: t("entry.kind.fxGroup"),
          children: [
            { key: "fx", label: t("entry.kind.fx") },
            { key: "fx-sell", label: t("entry.kind.fxSell") },
          ],
        },
        { key: "investment", label: t("txForm.fund") },
        { key: "stock", label: t("investment.product.stock") },
        { key: "stock-transfer", label: t("stockPanel.transfer") },
        { key: "wealth", label: t("investment.product.wealth") },
        { key: "deposit-buy", label: t("txForm.depositIn") },
        { key: "deposit-redeem", label: t("detailView.depositWithdraw") },
        { key: "insurance", label: t("sidebar.section.insurance") },
        { key: "debt", label: t("debtTx.borrowRepay") },
        { key: "regular-task", label: t("nav.scheduledTasks") },
      ]}
      context={{}}
    />
  );
}
