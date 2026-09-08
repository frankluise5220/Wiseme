"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n";

type InsuranceProductEditValue = {
  id: string;
  name: string;
  shortName: string;
  productType: string;
  accountingType: string;
  currency: string;
  institutionId: string;
  note: string;
};

type InsuranceProductEditOption = {
  id: string;
  label: string;
  shortName?: string | null;
};

type InsuranceProductEditInstitution = {
  id: string;
  label: string;
};

function getProductTypeOptions(t: (key: string) => string) {
  return [
    { value: "savings", label: t("insuranceProduct.type.savings") },
    { value: "dividend", label: t("insuranceProduct.type.dividend") },
    { value: "annuity", label: t("insuranceProduct.type.annuity") },
    { value: "universal", label: t("insuranceProduct.type.universal") },
    { value: "investment_linked", label: t("insuranceProduct.type.investment_linked") },
    { value: "critical_illness", label: t("insuranceProduct.type.critical_illness") },
    { value: "medical", label: t("insuranceProduct.type.medical") },
    { value: "accident", label: t("insuranceProduct.type.accident") },
    { value: "term_life", label: t("insuranceProduct.type.term_life") },
    { value: "whole_life", label: t("insuranceProduct.type.whole_life") },
    { value: "other", label: t("insuranceProduct.type.other") },
  ];
}

function getAccountingTypeOptions(t: (key: string) => string) {
  return [
    { value: "asset", label: t("insuranceProduct.accountingType.asset") },
    { value: "protection", label: t("insuranceProduct.accountingType.protection") },
    { value: "hybrid", label: t("insuranceProduct.accountingType.hybrid") },
  ];
}

function toLabel(t: (key: string) => string, value?: string | null) {
  return getProductTypeOptions(t).find((item) => item.value === value)?.label ?? t("insuranceProduct.type.other");
}

export function InsuranceProductEditModal({
  open,
  saving,
  value,
  institutions,
  products,
  onClose,
  onChange,
  onSaved,
}: {
  open: boolean;
  saving: boolean;
  value: InsuranceProductEditValue | null;
  institutions: InsuranceProductEditInstitution[];
  products: InsuranceProductEditOption[];
  onClose: () => void;
  onChange: (next: InsuranceProductEditValue) => void;
  onSaved: (next: InsuranceProductEditValue) => Promise<void>;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<InsuranceProductEditValue | null>(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  if (!open || !draft) return null;

  return (
    <div className="app-modal-backdrop z-[1200]">
      <div className="app-modal-panel max-w-2xl">
        <div className="modal-header">
          <div className="text-sm font-semibold text-slate-800">{t("insuranceProductEdit.editTitle")}</div>
          <button type="button" onClick={onClose} className="secondary-button h-8 px-2">
            <X className="h-4 w-4" />
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
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <div className="form-label">{t("insuranceEntryEdit.product")}</div>
                <select
                  value={draft.id}
                  onChange={(event) => {
                    const matched = products.find((item) => item.id === event.target.value);
                    if (!matched) return;
                    const next = {
                      ...draft,
                      id: matched.id,
                      name: matched.label,
                      shortName: matched.shortName ?? "",
                    };
                    setDraft(next);
                    onChange(next);
                  }}
                  className="form-input"
                >
                  {products.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("insuranceProductEdit.institutionLabel")}</div>
                <select
                  value={draft.institutionId}
                  onChange={(event) => {
                    const next = { ...draft, institutionId: event.target.value };
                    setDraft(next);
                    onChange(next);
                  }}
                  className="form-input"
                >
                  {institutions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("investForm.productNameLabel")}</div>
                <input
                  value={draft.name}
                  onChange={(event) => {
                    const next = { ...draft, name: event.target.value };
                    setDraft(next);
                    onChange(next);
                  }}
                  className="form-input"
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("entityForm.shortNameLabel")}</div>
                <input
                  value={draft.shortName}
                  onChange={(event) => {
                    const next = { ...draft, shortName: event.target.value };
                    setDraft(next);
                    onChange(next);
                  }}
                  className="form-input"
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("insuranceProductEdit.productTypeLabel")}</div>
                <select
                  value={draft.productType}
                  onChange={(event) => {
                    const next = { ...draft, productType: event.target.value };
                    setDraft(next);
                    onChange(next);
                  }}
                  className="form-input"
                >
                  {getProductTypeOptions(t).map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("insuranceProductEdit.accountingTypeLabel")}</div>
                <select
                  value={draft.accountingType}
                  onChange={(event) => {
                    const next = { ...draft, accountingType: event.target.value };
                    setDraft(next);
                    onChange(next);
                  }}
                  className="form-input"
                >
                  {getAccountingTypeOptions(t).map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("detail.column.currency")}</div>
                <input
                  value={draft.currency}
                  onChange={(event) => {
                    const next = { ...draft, currency: event.target.value.toUpperCase() };
                    setDraft(next);
                    onChange(next);
                  }}
                  className="form-input"
                />
              </div>
            </div>

            <div className="space-y-1">
              <div className="form-label">{t("detail.column.remark")}</div>
              <textarea
                value={draft.note}
                onChange={(event) => {
                  const next = { ...draft, note: event.target.value };
                  setDraft(next);
                  onChange(next);
                }}
                className="form-input min-h-24 resize-y"
              />
            </div>
            <div className="text-xs text-slate-500">
              {draft.name ? `${draft.name} · ${toLabel(t, draft.productType)}` : t("insuranceProductEdit.masterDataHint")}
            </div>
          </div>

          <div className="shrink-0 border-t border-slate-100 bg-white/95 px-4 py-3">
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onClose} className="secondary-button h-9 px-4">
                {t("common.cancel")}
              </button>
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
  );
}

export type { InsuranceProductEditInstitution, InsuranceProductEditOption, InsuranceProductEditValue };
