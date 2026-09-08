"use client";

import { Trash2 } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig, type BatchReplaceOption } from "@/components/BatchReplacePopoverButton";
import { CATEGORY_SMART_SELECT_BEHAVIOR } from "@/components/categorySmartSelect";
import { deleteEntriesWithLinkedPrompt, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { batchReplaceEntries, type BatchReplaceField } from "@/lib/client/batchReplaceEntries";
import { translate, useI18n } from "@/lib/i18n";

type SelectionContextValue = {
  selectedIds: Set<string>;
  toggleOne: (id: string) => void;
  toggleAll: (ids: string[]) => void;
  setSelection: (ids: Set<string>) => void;
  clear: () => void;
  deleteMessage: string;
  setDeleteMessage: (msg: string) => void;
};

type AccountOption = { id: string; label: string; title?: string | null };
export type BasicDetailBatchCategoryOption = BatchReplaceOption;

function getFieldLabels(t: (key: string) => string): Record<BatchReplaceField, string> {
  return {
    date: t("detail.column.date"),
    postedAt: t("detail.column.postedAt"),
    type: t("batchImport.field.type"),
    amount: t("txForm.amount"),
    inflow: t("detail.column.inflow"),
    outflow: t("detail.column.outflow"),
    account: t("basicDetailSelection.accountLabel"),
    viewAccount: t("basicDetailSelection.accountLabel"),
    toAccount: t("batchImport.field.counterAccount"),
    categoryId: t("detail.column.category"),
    institution: t("batchImport.field.institution"),
    tagId: t("detail.column.tags"),
    remark: t("detail.column.remark"),
  };
}

function getTypeOptions(t: (key: string) => string) {
  return [
    { value: "", label: t("batchImport.selectType") },
    { value: "expense", label: t("transaction.type.expense") },
    { value: "income", label: t("transaction.type.income") },
    { value: "transfer", label: t("transaction.type.transfer") },
    { value: "investment", label: t("transaction.type.investment") },
  ];
}
const defaultBatchReplaceFields: BatchReplaceField[] = ["date", "postedAt", "type", "outflow", "inflow", "amount", "viewAccount", "toAccount", "categoryId", "institution", "tagId", "remark"];

function scopeBatchCategoryOptions(
  categoryOptions: BasicDetailBatchCategoryOption[],
  categoryTypes: string[] = [],
) {
  const typeSet = new Set(categoryTypes.filter(Boolean));
  if (typeSet.size === 0) return categoryOptions;

  const scopedOptions = categoryOptions.filter((option) => option.categoryType && typeSet.has(option.categoryType));
  if (typeSet.size !== 1) return scopedOptions;

  const [categoryType] = Array.from(typeSet);
  const typeHeaderId = `category-type:${categoryType}`;
  return scopedOptions
    .filter((option) => option.value !== typeHeaderId)
    .map((option) => ({
      ...option,
      parentId: option.parentId === typeHeaderId ? undefined : option.parentId,
      subLabel: undefined,
    }));
}

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function useBasicDetailSelection() {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("BasicDetailSelection components must be used inside BasicDetailSelectionProvider");
  return ctx;
}

export function usePruneBasicDetailSelection(validIds: string[]) {
  const { selectedIds, setSelection } = useBasicDetailSelection();

  useEffect(() => {
    if (selectedIds.size === 0) return;
    const validIdSet = new Set(validIds);
    let changed = false;
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (validIdSet.has(id)) next.add(id);
      else changed = true;
    }
    if (changed) setSelection(next);
  }, [selectedIds, setSelection, validIds]);
}

export function BasicDetailSelectionProvider({
  children,
  resetKey,
}: {
  children: ReactNode;
  resetKey?: string;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteMessage, setDeleteMessage] = useState<string>("");

  useEffect(() => {
    setSelectedIds(new Set());
    setDeleteMessage("");
  }, [resetKey]);

  const value = useMemo<SelectionContextValue>(() => ({
    selectedIds,
    deleteMessage,
    toggleOne: (id: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    toggleAll: (ids: string[]) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        const allSelected = ids.length > 0 && ids.every((id) => next.has(id));
        ids.forEach((id) => {
          if (allSelected) next.delete(id);
          else next.add(id);
        });
        return next;
      });
    },
    setSelection: (ids: Set<string>) => setSelectedIds(new Set(ids)),
    clear: () => {
      setSelectedIds(new Set());
      setDeleteMessage("");
    },
    setDeleteMessage,
  }), [selectedIds, deleteMessage]);

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

export function BasicDetailSelectAll({ ids }: { ids: string[] }) {
  const { selectedIds, toggleAll } = useBasicDetailSelection();
  const { t } = useI18n();
  const checked = ids.length > 0 && ids.every((id) => selectedIds.has(id));
  const indeterminate = !checked && ids.some((id) => selectedIds.has(id));

  return (
    <input
      type="checkbox"
      checked={checked}
      ref={(input) => {
        if (input) input.indeterminate = indeterminate;
      }}
      onChange={() => toggleAll(ids)}
      className="h-3.5 w-3.5 accent-blue-600"
      aria-label={t("basicDetailSelection.selectAllAria")}
    />
  );
}

export function BasicDetailRowCheckbox({ id }: { id: string }) {
  const { selectedIds, toggleOne } = useBasicDetailSelection();
  const { t } = useI18n();

  return (
    <input
      type="checkbox"
      checked={selectedIds.has(id)}
      onChange={() => toggleOne(id)}
      className="h-3.5 w-3.5 accent-blue-600"
      aria-label={t("basicDetailSelection.selectRowAria")}
    />
  );
}

export function BasicDetailBatchReplaceButton({
  accountOptions,
  categoryOptions = [],
  tagOptions = [],
  categoryTypes = [],
  fields = defaultBatchReplaceFields,
  targetLabel,
  contextAccountId,
  contextAccountIds,
}: {
  accountOptions: AccountOption[];
  categoryOptions?: BasicDetailBatchCategoryOption[];
  tagOptions?: BasicDetailBatchCategoryOption[];
  categoryTypes?: string[];
  fields?: BatchReplaceField[];
  targetLabel?: string;
  contextAccountId?: string | null;
  contextAccountIds?: string[];
}) {
  const { t } = useI18n();
  const { selectedIds, clear } = useBasicDetailSelection();
  const selectedCount = selectedIds.size;
  const fieldConfigs = useMemo<BatchReplaceFieldConfig<BatchReplaceField>[]>(() => {
    const fieldLabels = getFieldLabels(t);
    const typeOptions = getTypeOptions(t);
    const accountSelectOptions = [
      { value: "", label: t("fundShell.selectAccount") },
      ...accountOptions.map((account) => ({ value: account.id, label: account.label, title: account.title ?? undefined })),
    ];
    const categorySelectOptions = [
      { value: "", label: t("basicDetailSelection.clearCategory") },
      ...scopeBatchCategoryOptions(categoryOptions, categoryTypes),
    ];
    const tagSelectOptions = [
      { value: "", label: t("basicDetailSelection.clearTag") },
      ...tagOptions,
    ];
    const configByField: Record<BatchReplaceField, BatchReplaceFieldConfig<BatchReplaceField>> = {
      date: { value: "date", label: fieldLabels.date, kind: "date" },
      postedAt: { value: "postedAt", label: fieldLabels.postedAt, kind: "date", allowEmpty: true },
      type: { value: "type", label: fieldLabels.type, kind: "select", options: typeOptions },
      amount: { value: "amount", label: fieldLabels.amount, kind: "number", placeholder: t("basicDetailSelection.amountPlaceholder") },
      inflow: { value: "inflow", label: fieldLabels.inflow, kind: "number", placeholder: t("basicDetailSelection.inflowPlaceholder") },
      outflow: { value: "outflow", label: fieldLabels.outflow, kind: "number", placeholder: t("basicDetailSelection.outflowPlaceholder") },
      account: {
        value: "account",
        label: fieldLabels.account,
        kind: "smartSelect",
        options: accountSelectOptions,
      },
      viewAccount: {
        value: "viewAccount",
        label: fieldLabels.viewAccount,
        kind: "smartSelect",
        options: accountSelectOptions,
      },
      toAccount: {
        value: "toAccount",
        label: fieldLabels.toAccount,
        kind: "smartSelect",
        options: accountSelectOptions,
      },
      categoryId: {
        value: "categoryId",
        label: fieldLabels.categoryId,
        kind: "smartSelect",
        options: categorySelectOptions,
        placeholder: t("basicDetailSelection.selectCategory"),
        allowEmpty: true,
        smartSelectBehavior: CATEGORY_SMART_SELECT_BEHAVIOR,
      },
      institution: { value: "institution", label: fieldLabels.institution, kind: "text", placeholder: t("basicDetailSelection.institutionPlaceholder"), allowEmpty: true },
      tagId: { value: "tagId", label: fieldLabels.tagId, kind: "select", options: tagSelectOptions, allowEmpty: true },
      remark: { value: "remark", label: fieldLabels.remark, kind: "text", placeholder: t("stockPanel.batchNotePlaceholder"), allowEmpty: true },
    };
    return fields.map((field) => configByField[field]).filter(Boolean);
  }, [accountOptions, categoryOptions, categoryTypes, fields, t, tagOptions]);

  async function applyReplace(field: BatchReplaceField, value: string) {
    const entryIds = Array.from(selectedIds);
    const result = await batchReplaceEntries({ ids: entryIds, field, value, contextAccountId, contextAccountIds });
    if (!result.ok) throw new Error(result.error ?? t("basicDetailSelection.batchReplaceFailed"));
    clear();
    dispatchFinanceDataChanged({ reason: "entry-batch-replace", entryIds });
    return t("basicDetailSelection.replacedCount", { count: result.updatedCount ?? 0 });
  }

  return (
    <BatchReplacePopoverButton
      fields={fieldConfigs}
      targetCount={selectedCount}
      targetLabel={targetLabel}
      buttonClassName="flex h-6 w-6 items-center justify-center rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-40 [&_svg]:h-3.5 [&_svg]:w-3.5"
      onApply={applyReplace}
    />
  );
}

export function BasicDetailBatchDeleteButton({ recordLabel }: { recordLabel?: string }) {
  const { t } = useI18n();
  const { selectedIds, clear, setDeleteMessage } = useBasicDetailSelection();
  const [submitting, setSubmitting] = useState(false);
  const selectedCount = selectedIds.size;
  const disabled = selectedCount === 0 || submitting;
  const effectiveRecordLabel = recordLabel ?? t("basicDetail.entriesTitle");

  async function applyDelete() {
    if (disabled) return;
    const entryIds = Array.from(selectedIds);

    setSubmitting(true);
    setDeleteMessage("");
    try {
      const data = await deleteEntriesWithLinkedPrompt({
        entryIds,
        confirmMessage: t("basicDetailSelection.deleteConfirm", { count: entryIds.length, label: effectiveRecordLabel }),
        t,
      });
      if (!data.ok) {
        if (data.error === translate("zh-CN", "basicDetailSelection.deleteCanceled")) return;
        setDeleteMessage(data.error ?? t("stockPanel.error.batchDeleteFailed"));
        return;
      }
      setDeleteMessage(data.message ?? t("fundShell.deletedCount", { count: entryIds.length }));
      clear();
      const refreshEntryIds = getDeleteRefreshEntryIds(data, entryIds);
      dispatchFinanceDataChanged({ reason: "entry-batch-delete", accountIds: getDeleteRefreshAccountIds(data), deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });
    } catch {
      setDeleteMessage(t("stockPanel.error.batchDeleteFailed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <button
      type="button"
      onClick={applyDelete}
      disabled={disabled}
      className="flex h-6 w-6 items-center justify-center rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
      title={selectedCount === 0 ? t("stockPanel.error.selectRowsFirst") : t("common.delete")}
      aria-label={selectedCount === 0 ? t("basicDetailSelection.deleteDisabledAria") : t("common.delete")}
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  );
}


export function BasicDetailBatchDeleteMessage() {
  const { deleteMessage } = useBasicDetailSelection();
  if (!deleteMessage) return null;
  return (
    <div className="px-4 py-2 bg-rose-50 border-b border-rose-100 text-xs text-rose-600">
      {deleteMessage}
    </div>
  );
}
