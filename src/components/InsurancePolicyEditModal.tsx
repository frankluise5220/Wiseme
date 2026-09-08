"use client";

import { useEffect, useState } from "react";
import { DateStepper } from "./DateStepper";
import { useI18n } from "@/lib/i18n";

type InsurancePolicyEditValue = {
  id: string;
  policyNo: string;
  effectiveDate: string;
  policyholderPersonId: string;
  insuredPersonId: string;
  paymentTermYears: string;
  coverageAmount: string;
};

type InsurancePolicyEditMeta = {
  name?: string | null;
  institutionName?: string | null;
  ownerName?: string | null;
};

export function InsurancePolicyEditModal({
  open,
  saving,
  value,
  meta,
  familyMemberOptions,
  onClose,
  onChange,
  onSaved,
}: {
  open: boolean;
  saving: boolean;
  value: InsurancePolicyEditValue | null;
  meta: InsurancePolicyEditMeta | null;
  familyMemberOptions?: Array<{ id: string; label: string }>;
  onClose: () => void;
  onChange?: (next: InsurancePolicyEditValue | null) => void;
  onSaved: (next: InsurancePolicyEditValue) => Promise<void>;
}) {
  const [draft, setDraft] = useState<InsurancePolicyEditValue | null>(value);
  const { t } = useI18n();

  useEffect(() => {
    setDraft(value);
  }, [value]);

  if (!open || !draft || !meta) return null;

  return (
    <div className="app-modal-backdrop z-[1200]">
      <div className="app-modal-panel max-w-xl">
        <div className="modal-header">
          <div className="text-sm font-semibold text-slate-800">{t("insurancePolicy.editTitle")}</div>
          <button type="button" onClick={onClose} className="secondary-button h-8 px-2">
            {t("table.close")}
          </button>
        </div>

        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void onSaved(draft);
          }}
        >
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <div className="rounded-lg bg-slate-50/70 px-3 py-2 text-[11px] leading-5 text-slate-500">
              {[
                meta.name ? t("insurancePolicy.policyLine", { name: meta.name }) : "",
                meta.institutionName ? t("insurancePolicy.institutionLine", { name: meta.institutionName }) : "",
                meta.ownerName ? t("insurancePolicy.currentOwnerLine", { name: meta.ownerName }) : "",
              ]
                .filter(Boolean)
                .join("  ")}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="form-label">{t("insuranceShell.colPolicyNo")}</div>
                <input
                  value={draft.policyNo}
                  onChange={(event) => {
                    const next = { ...draft, policyNo: event.target.value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                  placeholder={t("insurancePolicy.optional")}
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("insurancePolicy.effectiveDate")}</div>
                <DateStepper
                  value={draft.effectiveDate}
                  onChange={(value) => {
                    const next = { ...draft, effectiveDate: value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("insuranceShell.colPolicyholder")}</div>
                <select
                  value={draft.policyholderPersonId}
                  onChange={(event) => {
                    const next = { ...draft, policyholderPersonId: event.target.value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                >
                  <option value="">{t("txForm.selectPlaceholder")}</option>
                  {(familyMemberOptions ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("insuranceShell.colInsured")}</div>
                <select
                  value={draft.insuredPersonId}
                  onChange={(event) => {
                    const next = { ...draft, insuredPersonId: event.target.value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                >
                  <option value="">{t("txForm.selectPlaceholder")}</option>
                  {(familyMemberOptions ?? []).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("insuranceShell.colPaymentTerm")}</div>
                <input
                  value={draft.paymentTermYears}
                  onChange={(event) => {
                    const next = { ...draft, paymentTermYears: event.target.value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                  placeholder={t("insurancePolicy.termYearsPlaceholder")}
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("insuranceOverview.totalCoverage")}</div>
                <input
                  value={draft.coverageAmount}
                  onChange={(event) => {
                    const next = { ...draft, coverageAmount: event.target.value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                  placeholder={t("insurancePolicy.coveragePlaceholder")}
                />
              </div>
            </div>
          </div>

          <div className="shrink-0 border-t border-slate-100 bg-white/95 px-4 py-3">
            <div className="flex items-center justify-end gap-2">
              <button type="button" onClick={onClose} className="secondary-button h-9 px-4">
                {t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="primary-button h-9 px-4 text-white disabled:opacity-50"
              >
                {saving ? t("insurancePolicy.saving") : t("common.save")}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export type { InsurancePolicyEditMeta, InsurancePolicyEditValue };
