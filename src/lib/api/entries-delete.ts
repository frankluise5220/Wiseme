import { showBlockingLoading } from "@/lib/client/blocking-loading";
import { showChoiceDialog, showConfirmDialog } from "@/lib/client/confirm-dialog";

export type EntriesDeleteRequest = {
  entryIds: string[];
  linkedAction?: "deleteBusiness" | "keepBusiness";
  checkOnly?: boolean;
  action?: undefined;
} | {
  action: "restore";
  transactionIds: string[];
};

export type EntryBusinessDeleteImpact = {
  selectedEntryId?: string;
  selectedSide?: "cash" | "business" | "both";
  entryId: string;
  businessEntryId: string;
  counterpartEntryId?: string | null;
  counterpartLabel?: string;
  businessType: string;
  businessLabel: string;
  legacyCombinedRecord?: boolean;
};

export type EntriesDeleteResponse =
  | {
      ok: true;
      message: string;
      count?: number;
      deletedCount?: number;
      keptBusinessCount?: number;
      deletedEntryIds?: string[];
      removedEntryIds?: string[];
      accountIds?: string[];
      needConfirm?: boolean;
      impacts?: EntryBusinessDeleteImpact[];
    }
  | { ok: false; error: string; code?: string; needConfirm?: boolean; impacts?: EntryBusinessDeleteImpact[] };

export type I18nT = (key: string, params?: Record<string, string | number>) => string;

export async function callDeleteEntries(body: EntriesDeleteRequest): Promise<EntriesDeleteResponse> {
  const res = await fetch("/api/v1/entries/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export function getDeleteRefreshEntryIds(data: EntriesDeleteResponse, fallbackEntryIds: string[]) {
  if (!data.ok) return fallbackEntryIds;
  const ids = data.removedEntryIds?.length
    ? data.removedEntryIds
    : data.deletedEntryIds?.length
      ? data.deletedEntryIds
      : fallbackEntryIds;
  return Array.from(new Set(ids.filter(Boolean)));
}

export function getDeleteRefreshAccountIds(data: EntriesDeleteResponse) {
  return data.ok ? Array.from(new Set((data.accountIds ?? []).filter(Boolean))) : [];
}

function describeBusinessImpacts(impacts: EntryBusinessDeleteImpact[] = [], t: I18nT, labelOverride?: string) {
  const counts = new Map<string, number>();
  for (const impact of impacts) {
    const label = labelOverride || impact.counterpartLabel || impact.businessLabel || t("entriesDelete.linkedRecord");
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const parts = Array.from(counts.entries()).map(([label, count]) => t("entriesDelete.impactCount", { label, count }));
  return parts.join(", ") || t("entriesDelete.businessDetail");
}

export async function deleteEntriesWithLinkedPrompt({
  entryIds,
  confirmMessage,
  selectedRecordLabel,
  counterpartRecordLabel,
  t,
}: {
  entryIds: string[];
  confirmMessage: string;
  selectedRecordLabel?: string;
  counterpartRecordLabel?: string;
  t: I18nT;
}): Promise<EntriesDeleteResponse> {
  if (entryIds.length === 0) return { ok: false, error: t("entriesDelete.noDeletableRecord") };

  const precheck = await callDeleteEntries({ entryIds, checkOnly: true });
  if (!precheck.ok && !precheck.needConfirm) return precheck;

  const impacts = precheck.impacts ?? [];
  if (impacts.length > 0 || precheck.needConfirm) {
    const impactText = describeBusinessImpacts(impacts, t, counterpartRecordLabel);
    const selectedIdSet = new Set(entryIds);
    const linkedSelectedEntryIds = new Set(
      impacts
        .map((impact) => impact.selectedEntryId || impact.entryId)
        .filter((id): id is string => Boolean(id) && selectedIdSet.has(id)),
    );
    const linkedSelectedCount = linkedSelectedEntryIds.size;
    const unlinkedSelectedCount = Math.max(0, entryIds.length - linkedSelectedCount);
    const mixedSelection = linkedSelectedCount > 0 && unlinkedSelectedCount > 0;
    const allBusinessSide = impacts.length > 0 && impacts.every((impact) => impact.selectedSide === "business");
    const businessRecordLabel = t("entriesDelete.businessRecord");
    const selectedLabel = allBusinessSide
      ? (Array.from(new Set(impacts.map((impact) => impact.businessLabel || businessRecordLabel))).join(", ") || businessRecordLabel)
      : t("entriesDelete.thisAccountRecord");
    const effectiveSelectedLabel = selectedRecordLabel || selectedLabel;
    const counterpartLabel = counterpartRecordLabel || (allBusinessSide ? t("entriesDelete.linkedCashTransaction") : t("entriesDelete.businessSideRecord"));
    const messageKey = mixedSelection ? "entriesDelete.rangeMessageMixed" : "entriesDelete.rangeMessage";
    const linkedAction = await showChoiceDialog<"keepBusiness" | "deleteBusiness">({
      title: entryIds.length > 1 ? t("entriesDelete.batchRangeTitle") : t("entriesDelete.rangeTitle"),
      message: t(messageKey, {
        impactText,
        selectedLabel: effectiveSelectedLabel,
        counterpartLabel,
        linkedCount: linkedSelectedCount,
        unlinkedCount: unlinkedSelectedCount,
      }),
      choices: [
        {
          value: "keepBusiness",
          label: t(mixedSelection ? "entriesDelete.onlyDeleteMixedLabel" : "entriesDelete.onlyDeleteLabel", { label: effectiveSelectedLabel }),
        },
        {
          value: "deleteBusiness",
          label: t(mixedSelection ? "entriesDelete.deleteBothMixedLabel" : "entriesDelete.deleteBothLabel"),
          tone: "danger",
        },
      ],
      cancelLabel: t("common.cancel"),
      tone: "danger",
    });
    if (!linkedAction) return { ok: false, code: "DELETE_CANCELLED", error: t("entriesDelete.cancelled") };
    const closeBlocking = showBlockingLoading(t("common.batchDeleting"));
    try {
      return await callDeleteEntries({ entryIds, linkedAction });
    } finally {
      closeBlocking();
    }
  }

  const confirmed = await showConfirmDialog({
    title: entryIds.length > 1 ? t("entriesDelete.deleteSelectedTitle") : t("entriesDelete.deleteRecordTitle"),
    message: confirmMessage,
    confirmLabel: t("common.delete"),
    cancelLabel: t("common.cancel"),
    tone: "danger",
  });
  if (!confirmed) return { ok: false, code: "DELETE_CANCELLED", error: t("entriesDelete.cancelled") };

  const closeBlocking = showBlockingLoading(t("common.batchDeleting"));
  try {
    return await callDeleteEntries({ entryIds });
  } finally {
    closeBlocking();
  }
}
