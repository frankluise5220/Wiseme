"use client";

import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { deleteEntriesWithLinkedPrompt, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { useI18n } from "@/lib/i18n";

export type EditPayload = {
  requestId?: string;
  entryId: string;
  transactionId?: string;
  cashEntryId?: string | null;
  businessTransactionId?: string | null;
  targetEntryId?: string;
  type: "expense" | "income" | "advance" | "transfer" | "fx" | "investment";
  date: string;
  confirmDate?: string;
  postedAt?: string | null;
  amount: number;
  note: string;
  businessNote?: string | null;
  toNote?: string;
  accountId?: string;
  accountName?: string;
  accountLabel?: string;
  categoryId?: string;
  categoryName?: string;
  counterpartyInstitutionId?: string;
  fromAccountId?: string;
  fromAccountName?: string;
  toAccountId?: string;
  toAccountName?: string;
  hasFundDetail?: boolean;
  cashAccountId?: string;
  fundCode?: string;
  fundName?: string;
  wealthProductId?: string | null;
  metalTypeId?: string | null;
  metalTypeName?: string | null;
  metalUnitId?: string | null;
  metalUnitName?: string | null;
  metalQuantity?: number | null;
  metalUnitPrice?: number | null;
  metalFee?: number | null;
  insuranceProductId?: string | null;
  insuranceAction?: "premium" | "additional_premium" | "refund";
  insuranceProductName?: string;
  fundSubtype?: string;
  fundUnits?: number;
  fundNav?: number;
  depositAnnualRate?: number;
  depositInterest?: number;
  depositSourceEntryId?: string | null;
  fundFee?: number;
  fundConfirmDate?: string;
  fundArrivalDate?: string | null;
  fundSourceEntryId?: string | null;
  fundArrivalAmount?: number | null;
  fundProductType?: string;
  source?: string | null;
  linkedCandidateEntries?: Array<{
    id?: string;
    date: string;
    createdAt?: string | null;
    fundConfirmDate?: string | null;
    fundArrivalDate?: string | null;
    fundCode: string;
    fundSubtype: string;
    fundUnits: number | null;
    source: string | null;
    accountId?: string | null;
    toAccountId?: string | null;
    fundSourceEntryId?: string | null;
    amount?: number;
  }>;
  tagIds?: string[];
  currency?: string | null;
  tags?: Array<{
    id?: string;
    tagId?: string;
    name?: string | null;
    label?: string | null;
    color?: string | null;
    Tag?: { name?: string | null; color?: string | null } | null;
  }>;
};

export function dispatchEntryEdit({
  entryId,
  edit,
  customEditEvent,
}: {
  entryId: string;
  edit?: Omit<EditPayload, "entryId">;
  customEditEvent?: { name: string; detail: Record<string, unknown> };
}) {
  if (customEditEvent) {
    window.dispatchEvent(new CustomEvent(customEditEvent.name, { detail: customEditEvent.detail }));
    return;
  }
  if (!edit) return;
  const editEntryId = edit.targetEntryId || entryId;
  const requestId = `edit-${editEntryId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const detail = { requestId, entryId: editEntryId, ...edit } satisfies EditPayload;

  const pt = edit.fundProductType;
  if (edit.type === "investment" && (edit.source === "insurance" || edit.insuranceProductId)) {
    window.dispatchEvent(new CustomEvent("mmh:insurance:edit", { detail }));
  } else if (edit.type === "investment" && pt === "wealth") {
    window.dispatchEvent(new CustomEvent("mmh:wealth:edit", { detail }));
  } else if (edit.type === "investment" && pt === "deposit") {
    window.dispatchEvent(new CustomEvent("mmh:deposit:edit", { detail }));
  } else if (edit.type === "investment") {
    window.dispatchEvent(new CustomEvent("mmh:investment:edit", { detail }));
  } else {
    window.dispatchEvent(new CustomEvent("mmh:transaction:edit", { detail }));
  }
}

export function EntryRowActions({
  entryId,
  edit,
  customEditEvent,
}: {
  entryId: string;
  edit?: Omit<EditPayload, "entryId">;
  customEditEvent?: { name: string; detail: Record<string, unknown> };
}) {
  const [deleting, setDeleting] = useState(false);
  const { t } = useI18n();
  const actionButtonClass = "flex h-6 w-6 items-center justify-center rounded border bg-white transition-colors disabled:opacity-50";

  function onEdit() {
    dispatchEntryEdit({ entryId, edit, customEditEvent });
  }

  async function onDelete() {
    if (deleting) return;

    setDeleting(true);
    try {
      const data = await deleteEntriesWithLinkedPrompt({
        entryIds: [entryId],
        confirmMessage: t("entryRowActions.deleteConfirm"),
        t,
      });
      if (!data?.ok) {
        if (data?.code === "DELETE_CANCELLED" || data?.error === "已取消删除") return;
        throw new Error(data?.error ?? t("entryRowActions.deleteFailed"));
      }
      const refreshEntryIds = getDeleteRefreshEntryIds(data, [entryId]);
      dispatchFinanceDataChanged({ reason: "entry-delete", accountIds: getDeleteRefreshAccountIds(data), deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });

    } catch (e) {
      const msg =
        e instanceof Error
          ? e.name === "AbortError"
            ? t("entryRowActions.timeout")
            : e.message
          : t("entryRowActions.deleteFailed");
      window.alert(msg);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="flex items-center gap-1">
      {edit || customEditEvent ? (
        <button
          className={`${actionButtonClass} border-slate-200 text-slate-700 hover:bg-slate-50`}
          type="button"
          onClick={onEdit}
          title={t("insuranceShell.editButton")}
          aria-label={t("insuranceShell.editButton")}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      ) : null}
      <button
        className={`${actionButtonClass} border-red-200 text-red-700 hover:bg-red-50`}
        disabled={deleting}
        type="button"
        onClick={onDelete}
        title={deleting ? t("ledgerSwitch.deleting") : t("depositShell.deleteButton")}
        aria-label={deleting ? t("ledgerSwitch.deleting") : t("depositShell.deleteButton")}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
