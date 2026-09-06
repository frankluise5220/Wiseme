"use client";

import { useEffect, useState } from "react";
import { DateStepper } from "./DateStepper";
import { useI18n } from "@/lib/i18n";
import { FIXED_ASSET_TYPES, type FixedAssetType } from "@/lib/fixed-asset";

type FixedAssetEditValue = {
  id: string;
  name: string;
  assetType: FixedAssetType;
  propertyType: string;
  address: string;
  attributes: Record<string, unknown>;
  purchaseDate: string;
  purchasePrice: string;
  note: string;
  status: string;
};

type FixedAssetEditMeta = {
  accountName?: string | null;
  marketValue?: number | null;
  cost?: number | null;
};

function typeLabel(t: (key: string) => string, assetType: FixedAssetType) {
  return t(`fixedAsset.type.${assetType}`);
}

export function FixedAssetEditModal({
  open,
  saving,
  value,
  meta,
  onClose,
  onChange,
  onSaved,
}: {
  open: boolean;
  saving: boolean;
  value: FixedAssetEditValue | null;
  meta: FixedAssetEditMeta | null;
  onClose: () => void;
  onChange?: (next: FixedAssetEditValue | null) => void;
  onSaved: (next: FixedAssetEditValue) => Promise<void>;
}) {
  const [draft, setDraft] = useState<FixedAssetEditValue | null>(value);
  const { t } = useI18n();

  useEffect(() => {
    setDraft(value);
  }, [value]);

  if (!open || !draft || !meta) return null;

  const current = draft;

  function updateAttributes(key: string, value: string) {
    const next = { ...current, attributes: { ...current.attributes, [key]: value } };
    setDraft(next);
    onChange?.(next);
  }

  function attributeValue(key: string) {
    const raw = current.attributes?.[key];
    return raw == null ? "" : String(raw);
  }

  return (
    <div className="app-modal-backdrop z-[1200]">
      <div className="app-modal-panel max-w-xl">
        <div className="modal-header">
          <div className="text-sm font-semibold text-slate-800">{t("fixedAssetEdit.editTitle")}</div>
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
                meta.accountName ? t("fixedAssetEdit.accountLine", { name: meta.accountName }) : "",
                meta.marketValue != null ? t("fixedAssetEdit.marketValueLine", { value: String(meta.marketValue) }) : "",
                meta.cost != null ? t("fixedAssetEdit.costLine", { value: String(meta.cost) }) : "",
              ]
                .filter(Boolean)
                .join("  ")}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="form-label">{t("propertyForm.propertyName")}</div>
                <input
                  value={draft.name}
                  onChange={(event) => {
                    const next = { ...draft, name: event.target.value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                  placeholder={t("propertyForm.namePlaceholder")}
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("fixedAssetEdit.assetType")}</div>
                <select
                  value={draft.assetType}
                  onChange={(event) => {
                    const next = { ...draft, assetType: event.target.value as FixedAssetType };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                >
                  {FIXED_ASSET_TYPES.map((assetType) => (
                    <option key={assetType} value={assetType}>
                      {typeLabel(t, assetType)}
                    </option>
                  ))}
                </select>
              </div>

              {draft.assetType === "property" ? (
                <>
                  <div className="space-y-1">
                    <div className="form-label">{t("propertyForm.propertyType")}</div>
                    <input
                      value={draft.propertyType}
                      onChange={(event) => {
                        const next = { ...draft, propertyType: event.target.value };
                        setDraft(next);
                        onChange?.(next);
                      }}
                      className="form-input"
                      placeholder={t("propertyForm.typePlaceholder")}
                    />
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("propertyForm.address")}</div>
                    <input
                      value={draft.address}
                      onChange={(event) => {
                        const next = { ...draft, address: event.target.value };
                        setDraft(next);
                        onChange?.(next);
                      }}
                      className="form-input"
                    />
                  </div>
                </>
              ) : null}

              {draft.assetType === "vehicle" ? (
                <>
                  <div className="space-y-1">
                    <div className="form-label">{t("fixedAssetEdit.attr.plateNo")}</div>
                    <input value={attributeValue("plateNo")} onChange={(event) => updateAttributes("plateNo", event.target.value)} className="form-input" />
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("fixedAssetEdit.attr.brandModel")}</div>
                    <input value={attributeValue("brandModel")} onChange={(event) => updateAttributes("brandModel", event.target.value)} className="form-input" />
                  </div>
                </>
              ) : null}

              {draft.assetType === "equipment" || draft.assetType === "furniture" ? (
                <>
                  <div className="space-y-1">
                    <div className="form-label">{t("fixedAssetEdit.attr.brand")}</div>
                    <input value={attributeValue("brand")} onChange={(event) => updateAttributes("brand", event.target.value)} className="form-input" />
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("fixedAssetEdit.attr.model")}</div>
                    <input value={attributeValue("model")} onChange={(event) => updateAttributes("model", event.target.value)} className="form-input" />
                  </div>
                </>
              ) : null}

              {draft.assetType === "collectible" ? (
                <>
                  <div className="space-y-1">
                    <div className="form-label">{t("fixedAssetEdit.attr.category")}</div>
                    <input value={attributeValue("category")} onChange={(event) => updateAttributes("category", event.target.value)} className="form-input" />
                  </div>
                  <div className="space-y-1">
                    <div className="form-label">{t("fixedAssetEdit.attr.origin")}</div>
                    <input value={attributeValue("origin")} onChange={(event) => updateAttributes("origin", event.target.value)} className="form-input" />
                  </div>
                </>
              ) : null}

              <div className="space-y-1">
                <div className="form-label">{t("fixedAssetEdit.purchaseDate")}</div>
                <DateStepper
                  value={draft.purchaseDate}
                  onChange={(value) => {
                    const next = { ...draft, purchaseDate: value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("fixedAssetEdit.purchasePrice")}</div>
                <input
                  value={draft.purchasePrice}
                  onChange={(event) => {
                    const next = { ...draft, purchasePrice: event.target.value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                  placeholder={t("fixedAssetEdit.purchasePricePlaceholder")}
                />
              </div>
              <div className="space-y-1">
                <div className="form-label">{t("fixedAssetEdit.note")}</div>
                <input
                  value={draft.note}
                  onChange={(event) => {
                    const next = { ...draft, note: event.target.value };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="form-input"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="flex cursor-pointer select-none items-start gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={draft.status === "mortgaged"}
                  onChange={(event) => {
                    const next = { ...draft, status: event.target.checked ? "mortgaged" : "active" };
                    setDraft(next);
                    onChange?.(next);
                  }}
                  className="mt-0.5 h-3.5 w-3.5 accent-indigo-600"
                />
                <span>{t("fixedAssetEdit.status.mortgaged")}</span>
              </label>
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
                {saving ? t("fixedAssetEdit.saving") : t("common.save")}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export type { FixedAssetEditMeta, FixedAssetEditValue };