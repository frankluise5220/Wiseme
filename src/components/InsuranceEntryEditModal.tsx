"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { DateStepper } from "./DateStepper";
import { CalcInput } from "./CalcInput";
import { SmartSelect, type SmartSelectOption } from "./SmartSelect";
import { useAccountSSFilter } from "./accountSSFilter";
import { NestedAddModal } from "./EntityCreateForm";
import { ModalLayerProvider, getNextModalLayerZIndex, useModalLayerZIndex } from "./ModalLayer";
import { kindLabel } from "@/lib/account-kinds";
import { useI18n } from "@/lib/i18n";

type InsuranceEntryEditValue = {
  id: string;
  date: string;
  arrivalDate?: string;
  amount: string;
  cashAccountId: string;
  coverageAmount: string;
  paymentTermYears: string;
  note: string;
  insuranceAction: "premium" | "additional_premium" | "refund";
  insuranceProductId: string;
  insuranceProductName: string;
};

export type { InsuranceEntryEditValue };

type AccountOption = {
  id: string;
  label: string;
  icon?: string;
  subLabel?: string;
};

type NestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;

function parseOptionalNumber(input: string) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  const value = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

export function InsuranceEntryEditModal({
  open,
  value,
  cashAccounts,
  cashAccountSSOptions,
  nestedFieldData,
  onClose,
  onSaved,
}: {
  open: boolean;
  value: InsuranceEntryEditValue | null;
  cashAccounts?: AccountOption[];
  cashAccountSSOptions?: SmartSelectOption[];
  nestedFieldData?: NestedFieldData;
  onClose: () => void;
  onSaved: (next: InsuranceEntryEditValue) => Promise<void>;
}) {
  const [draft, setDraft] = useState<InsuranceEntryEditValue | null>(value);
  const [saving, setSaving] = useState(false);
  const [cashAccountList, setCashAccountList] = useState(cashAccounts ?? []);
  const [localCashSSOpts, setLocalCashSSOpts] = useState(cashAccountSSOptions);
  const [nestedEntityType, setNestedEntityType] = useState<"cash-account" | null>(null);
  // Local copy of nested option data so newly created institutions/groups persist
  // across account-dialog instances within this modal.
  const [localNestedFieldData, setLocalNestedFieldData] = useState<NestedFieldData | undefined>(nestedFieldData);

  // Keep local nested option data in sync when the server-provided prop changes.
  useEffect(() => {
    if (nestedFieldData) setLocalNestedFieldData(nestedFieldData);
  }, [nestedFieldData]);

  useEffect(() => {
    setDraft(value);
  }, [value]);
  useEffect(() => setCashAccountList(cashAccounts ?? []), [cashAccounts]);
  useEffect(() => setLocalCashSSOpts(cashAccountSSOptions), [cashAccountSSOptions]);

  const { filteredOptions: cashFiltered } = useAccountSSFilter(localCashSSOpts);

  const cashOptions = cashFiltered ?? cashAccountList;
  const { t } = useI18n();
  const parentModalZIndex = useModalLayerZIndex();
  const modalZIndex = getNextModalLayerZIndex(parentModalZIndex);

  // Called when a nested institution/group is created inside an account dialog.
  // Keep the shared nested option data fresh so subsequent account dialogs can
  // select the newly created entity.
  function handleNestedOptionCreated(id: string, name: string, extra?: { kind?: string; type?: string }) {
    setLocalNestedFieldData((prev) => {
      const base = prev ?? nestedFieldData ?? {};
      if (extra?.type !== undefined) {
        const existing = base.institutionId ?? [];
        if (existing.some((item) => item.id === id)) return base;
        return { ...base, institutionId: [...existing, { id, name, type: extra.type }] };
      }
      const existing = base.groupId ?? [];
      if (existing.some((item) => item.id === id)) return base;
      return { ...base, groupId: [...existing, { id, name }] };
    });
  }

  if (!open || !draft) return null;

  async function handleSave(options?: { keepOpen?: boolean }) {
    const currentDraft = draft;
    if (!currentDraft) return;
    const isCreating = !currentDraft.id;

    const amountValue = parseOptionalNumber(currentDraft.amount);
    if (amountValue == null || amountValue <= 0) {
      window.alert(t("insuranceEntryEdit.alert.validAmount"));
      return;
    }
    if (!currentDraft.cashAccountId) {
      window.alert(currentDraft.insuranceAction === "refund" ? t("insuranceEntryEdit.alert.selectArrivalAccount") : t("insuranceEntryEdit.alert.selectSourceAccount"));
      return;
    }

    setSaving(true);
    try {
      const isRefund = currentDraft.insuranceAction === "refund";
      const response = await fetch("/api/v1/transactions/detail", {
        method: isCreating ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: isCreating ? undefined : currentDraft.id,
          type: "investment",
          date: currentDraft.date,
          fundArrivalDate: isRefund ? (currentDraft.arrivalDate || currentDraft.date) : undefined,
          amount: amountValue,
          cashAccountId: currentDraft.cashAccountId,
          fundSubtype: isRefund ? "redeem" : "buy",
          fundProductType: null,
          source: "insurance",
          insuranceAction: currentDraft.insuranceAction,
          insuranceProductName: currentDraft.insuranceProductName,
          insuranceProductId: currentDraft.insuranceProductId,
          createInsurancePremiumPlan: false,
          skipPlanCreation: true,
          skipDuplicateInsurancePremiumDate: false,
          note: currentDraft.note,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; data?: { id?: string }; error?: string }
        | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || t("insuranceEntryEdit.saveFailed"));
      }
      const savedDraft = isCreating && typeof data?.data?.id === "string"
        ? { ...currentDraft, id: data.data.id }
        : currentDraft;
      const keepOpen = options?.keepOpen === true;
      const nextDraft = keepOpen
        ? { ...currentDraft, id: "", amount: "", note: "" }
        : savedDraft;
      await onSaved(nextDraft);
      if (keepOpen) {
        setDraft(nextDraft);
      } else {
        onClose();
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("insuranceEntryEdit.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  const isCreating = !draft.id;
  const title =
    draft.insuranceAction === "additional_premium"
      ? isCreating ? t("insuranceEntryEdit.title.addPremium") : t("insuranceEntryEdit.title.editPremium")
      : draft.insuranceAction === "refund"
        ? isCreating ? t("insuranceEntryEdit.title.addRefund") : t("insuranceEntryEdit.title.editRefund")
        : isCreating ? t("insuranceEntryEdit.title.addRenewal") : t("insuranceEntryEdit.title.editRenewal");
  const amountLabel =
    draft.insuranceAction === "additional_premium"
      ? t("insuranceEntryEdit.amount.additional")
      : draft.insuranceAction === "refund"
        ? t("insuranceEntryEdit.amount.refund")
        : t("insuranceEntryEdit.amount.premium");
  const isRefund = draft.insuranceAction === "refund";

  if (nestedEntityType === "cash-account" && typeof document !== "undefined") {
    return createPortal(
      <ModalLayerProvider value={modalZIndex}>
        <NestedAddModal
          mode="compact"
          entityType="account"
          open={true}
          onClose={() => setNestedEntityType(null)}
          onCreated={(id, name, extra) => {
            const option = { id, label: name, subLabel: kindLabel(extra?.kind ?? "bank_debit") };
            setCashAccountList((prev) => [...prev, option]);
            setLocalCashSSOpts((prev) => (prev ? [...prev, option] : prev));
            setDraft((prev) => (prev ? { ...prev, cashAccountId: id } : prev));
            setNestedEntityType(null);
          }}
          allowedAccountKinds={["bank_debit", "ewallet"]}
          hiddenFields={[]}
          nestedFieldData={localNestedFieldData ?? nestedFieldData}
          onNestedCreated={handleNestedOptionCreated}
        />
      </ModalLayerProvider>,
      document.body,
    );
  }

  return createPortal(
    <ModalLayerProvider value={modalZIndex}>
    <div className="app-modal-backdrop" style={{ zIndex: modalZIndex }}>
      <div className="app-modal-panel max-w-xl">
        <div className="modal-header">
          <div className="text-sm font-semibold text-slate-800">{title}</div>
          <button type="button" onClick={onClose} className="secondary-button h-8 px-2">
            {t("table.close")}
          </button>
        </div>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
        >
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <div className="space-y-1">
              <div className="form-label">{t("insuranceEntryEdit.product")}</div>
              <div className="form-input flex h-9 items-center bg-slate-50 text-sm text-slate-600">
                {draft.insuranceProductName || "-"}
              </div>
            </div>

            {/* Date */}
            {isRefund ? (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <div className="form-label">{t("detail.column.date")}</div>
                  <DateStepper
                    value={draft.date}
                    onChange={(next) => setDraft({ ...draft, date: next })}
                  />
                </div>
                <div className="space-y-1">
                  <div className="form-label">{t("insuranceEntryEdit.arrivalDate")}</div>
                  <DateStepper
                    value={draft.arrivalDate || draft.date}
                    onChange={(next) => setDraft({ ...draft, arrivalDate: next })}
                  />
                </div>
                <div className="space-y-1">
                  <div className="form-label">{amountLabel}</div>
                  <CalcInput
                    value={draft.amount}
                    onChange={(val) => setDraft({ ...draft, amount: val })}
                    placeholder="0.00"
                    label={amountLabel}
                    precision={2}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="form-label">{t("detail.column.date")}</div>
                <DateStepper
                  value={draft.date}
                  onChange={(next) => setDraft({ ...draft, date: next })}
                />
              </div>
            )}

            {/* Cash source */}
            <div className="space-y-1">
              <div className="form-label">{isRefund ? t("insuranceEntryEdit.arrivalAccount") : t("insuranceEntryEdit.sourceAccount")}</div>
              <SmartSelect
                mode="single"
                value={draft.cashAccountId}
                onChange={(id) => setDraft({ ...draft, cashAccountId: id })}
                options={cashOptions}
                placeholder={t("insuranceEntryEdit.selectAccount")}
                behavior={{
                  hierarchy: false,
                  search: "auto",
                  clearable: false,
                  create: {
                    type: "button",
                    onClick: () => setNestedEntityType("cash-account"),
                    label: "+",
                  },
                }}
              />
            </div>

            {!isRefund ? (
              <div className="space-y-1">
                <div className="form-label">{amountLabel}</div>
                <CalcInput
                  value={draft.amount}
                  onChange={(val) => setDraft({ ...draft, amount: val })}
                  placeholder="0.00"
                  label={amountLabel}
                  precision={2}
                />
              </div>
            ) : null}

            <div className="space-y-1">
              <div className="form-label">{t("detail.column.remark")}</div>
              <textarea
                value={draft.note}
                onChange={(event) => setDraft({ ...draft, note: event.target.value })}
                className="form-input min-h-[72px] resize-none py-2"
                placeholder={t("insuranceEntryEdit.notePlaceholder")}
              />
            </div>
          </div>

          <div className="shrink-0 border-t border-slate-100 bg-white/95 px-4 py-3">
            <div className="flex justify-end gap-2">
              {isCreating ? (
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => handleSave({ keepOpen: true })}
                  className="secondary-button h-9 px-4 disabled:opacity-50"
                >
                  {t("txForm.saveAndRepeat")}
                </button>
              ) : null}
              <button
                type="submit"
                disabled={saving}
                className="primary-button h-9 px-4 text-white disabled:opacity-50"
              >
                {saving ? t("insuranceEntryEdit.saving") : t("common.save")}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
    </ModalLayerProvider>,
    document.body,
  );
}
