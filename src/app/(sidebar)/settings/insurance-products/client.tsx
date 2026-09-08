"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Search, X } from "lucide-react";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import {
  SettingsActionButton,
  SettingsEmptyRow,
  SettingsPageHeader,
  SettingsPrimaryAddButton,
  SettingsRowActions,
  SettingsSection,
  SettingsTable,
  SettingsTd,
  SettingsTh,
} from "@/components/settings/SettingsPageScaffold";
import { useI18n } from "@/lib/i18n";

type I18nT = (key: string, params?: Record<string, string | number>) => string;

type Option = {
  id: string;
  name: string;
  shortName?: string | null;
  label?: string;
};

type InsuranceProductMasterRow = {
  id: string;
  name: string;
  shortName?: string | null;
  productType: string;
  accountingType: string;
  currency: string;
  institutionId: string;
  institutionName: string;
  institutionShortName?: string | null;
  note?: string | null;
  policyCount: number;
};

type EditState = {
  id?: string;
  name: string;
  shortName: string;
  productType: string;
  accountingType: string;
  currency: string;
  institutionId: string;
  note: string;
};

type DeleteState = {
  id: string;
  name: string;
  policyCount: number;
};

const PRODUCT_TYPE_VALUES = [
  "savings",
  "dividend",
  "annuity",
  "universal",
  "investment_linked",
  "critical_illness",
  "medical",
  "accident",
  "term_life",
  "whole_life",
  "other",
] as const;

const ACCOUNTING_TYPE_VALUES = [
  "asset",
  "protection",
  "hybrid",
] as const;

/** Localized label for an insurance product type. */
function productTypeLabel(t: I18nT, value?: string | null) {
  const known = (PRODUCT_TYPE_VALUES as readonly string[]).includes(value ?? "");
  return t(`insuranceProduct.type.${known && value ? value : "other"}`);
}

/** Localized label for an insurance product accounting type. */
function accountingTypeLabel(t: I18nT, value?: string | null) {
  const known = (ACCOUNTING_TYPE_VALUES as readonly string[]).includes(value ?? "");
  return t(`insuranceProduct.accountingType.${known && value ? value : "asset"}`);
}

function toEditState(item: InsuranceProductMasterRow): EditState {
  return {
    id: item.id,
    name: item.name,
    shortName: item.shortName ?? "",
    productType: item.productType,
    accountingType: item.accountingType,
    currency: item.currency,
    institutionId: item.institutionId,
    note: item.note ?? "",
  };
}

function createBlankEditState(institutionId: string): EditState {
  return {
    name: "",
    shortName: "",
    productType: "savings",
    accountingType: "asset",
    currency: "CNY",
    institutionId,
    note: "",
  };
}

function mapApiProductMaster(
  item: Record<string, unknown>,
  previous?: InsuranceProductMasterRow,
): InsuranceProductMasterRow {
  return {
    id: String(item.id ?? previous?.id ?? ""),
    name: String(item.name ?? previous?.name ?? ""),
    shortName: item.shortName ? String(item.shortName) : null,
    productType: String(item.productType ?? previous?.productType ?? "other"),
    accountingType: String(item.accountingType ?? previous?.accountingType ?? "asset"),
    currency: String(item.currency ?? previous?.currency ?? "CNY"),
    institutionId: String(item.institutionId ?? previous?.institutionId ?? ""),
    institutionName: String(item.institutionName ?? previous?.institutionName ?? ""),
    institutionShortName: item.institutionShortName ? String(item.institutionShortName) : null,
    note: item.note ? String(item.note) : null,
    policyCount:
      typeof item.policyCount === "number"
        ? item.policyCount
        : previous?.policyCount ?? 0,
  };
}

export function SettingsInsuranceProductsClient({
  initialProducts,
  institutions,
}: {
  initialProducts: InsuranceProductMasterRow[];
  institutions: Option[];
}) {
  const { t } = useI18n();
  const [products, setProducts] = useState(initialProducts);
  const [query, setQuery] = useState("");
  const [productTypeFilter, setProductTypeFilter] = useState("all");
  const [editing, setEditing] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteState | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteCascade, setDeleteCascade] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const filteredProducts = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return products
      .filter((item) => productTypeFilter === "all" || item.productType === productTypeFilter)
      .filter((item) => {
        if (!keyword) return true;
        return [
          item.name,
          item.shortName,
          item.institutionName,
          item.institutionShortName,
          item.note,
        ].some((text) => String(text ?? "").toLowerCase().includes(keyword));
      });
  }, [productTypeFilter, products, query]);

  const linkedCount = products.filter((item) => item.policyCount > 0).length;

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (!editing || saving) return;
    if (!editing.name.trim()) {
      window.alert(t("settings.insuranceProducts.client.nameRequired"));
      return;
    }
    if (!editing.institutionId) {
      window.alert(t("settings.insuranceProducts.client.selectInstitution"));
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/v1/insurance-products", {
        method: editing.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...editing,
          mode: "master",
          shortName: editing.shortName.trim() || null,
          note: editing.note.trim() || null,
        }),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; productMaster?: Record<string, unknown> }
        | null;
      if (!response.ok || !data?.ok || !data.productMaster) {
        throw new Error(data?.error || t("insuranceShell.saveProductFailed"));
      }
      const productMaster = data.productMaster;
      setProducts((prev) => {
        if (!editing.id) return [...prev, mapApiProductMaster(productMaster)];
        return prev.map((item) => (item.id === editing.id ? mapApiProductMaster(productMaster, item) : item));
      });
      setEditing(null);
      dispatchFinanceDataChanged({ reason: "insurance-product:save" });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t("insuranceShell.saveProductFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const response = await fetch(
        `/api/v1/insurance-products?id=${encodeURIComponent(deleteTarget.id)}&mode=master`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            password: deletePassword,
            cascade: deleteCascade,
          }),
        },
      );
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || t("settings.insuranceProducts.client.deleteFailed"));
      }
      setProducts((prev) => prev.filter((item) => item.id !== deleteTarget.id));
      if (editing?.id === deleteTarget.id) {
        setEditing(null);
      }
      setDeleteTarget(null);
      setDeletePassword("");
      setDeleteCascade(false);
      dispatchFinanceDataChanged({ reason: "insurance-product:delete" });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t("settings.insuranceProducts.client.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={t("settings.insuranceProducts")}
        description={t("settings.insuranceProducts.client.description")}
        count={products.length}
      />

      <SettingsSection
        title={t("settings.insuranceProducts.client.libraryTitle")}
        description={t("settings.insuranceProducts.client.linkedSummary", { linked: linkedCount, unlinked: products.length - linkedCount })}
        count={filteredProducts.length}
        actions={
          <SettingsPrimaryAddButton onClick={() => setEditing(createBlankEditState(institutions[0]?.id ?? ""))}>
            {t("insuranceFormModal.newProductTitle")}
          </SettingsPrimaryAddButton>
        }
      >

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
          <div className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("settings.insuranceProducts.client.searchPlaceholder")}
              className="form-input h-9 pl-8 text-sm"
            />
          </div>
          <select
            value={productTypeFilter}
            onChange={(event) => setProductTypeFilter(event.target.value)}
            className="form-input h-9 w-36 text-sm"
            title={t("settings.insuranceProducts.client.typeFilterLabel")}
            aria-label={t("settings.insuranceProducts.client.typeFilterLabel")}
          >
            <option value="all">{t("settings.insuranceProducts.client.allTypes")}</option>
            {PRODUCT_TYPE_VALUES.map((value) => (
              <option key={value} value={value}>
                {productTypeLabel(t, value)}
              </option>
            ))}
          </select>
        </div>

        <SettingsTable minWidth={920}>
            <thead className="sticky top-0 z-10 bg-slate-50">
              <tr>
                <SettingsTh>{t("settings.insuranceProducts")}</SettingsTh>
                <SettingsTh>{t("insuranceProductEdit.productTypeLabel")}</SettingsTh>
                <SettingsTh>{t("insuranceProductEdit.accountingTypeLabel")}</SettingsTh>
                <SettingsTh>{t("insuranceProductEdit.institutionLabel")}</SettingsTh>
                <SettingsTh>{t("detail.column.currency")}</SettingsTh>
                <SettingsTh align="right">{t("settings.insuranceProducts.client.linkedPolicies")}</SettingsTh>
                <SettingsTh>{t("insurance.col.note")}</SettingsTh>
                <SettingsTh align="right">{t("detail.column.actions")}</SettingsTh>
              </tr>
            </thead>
            <tbody className="text-sm">
              {filteredProducts.length > 0 ? (
                filteredProducts.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50">
                    <SettingsTd>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-slate-800" title={item.name}>
                          {item.name}
                        </div>
                        {item.shortName ? (
                          <div className="mt-0.5 text-[11px] text-slate-400">{item.shortName}</div>
                        ) : null}
                      </div>
                    </SettingsTd>
                    <SettingsTd>{productTypeLabel(t, item.productType)}</SettingsTd>
                    <SettingsTd>{accountingTypeLabel(t, item.accountingType)}</SettingsTd>
                    <SettingsTd>{item.institutionShortName || item.institutionName || "-"}</SettingsTd>
                    <SettingsTd>{item.currency}</SettingsTd>
                    <SettingsTd align="right">{item.policyCount}</SettingsTd>
                    <SettingsTd>
                      <div className="line-clamp-2 max-w-[20rem] text-xs text-slate-500">
                        {item.note || "-"}
                      </div>
                    </SettingsTd>
                    <SettingsTd align="right">
                      <SettingsRowActions>
                        <SettingsActionButton
                          label={t("insuranceProductEdit.editTitle")}
                          variant="edit"
                          onClick={() => setEditing(toEditState(item))}
                        />
                        <SettingsActionButton
                          label={t("settings.insuranceProducts.client.deleteProduct")}
                          variant="delete"
                          onClick={() => {
                            setDeleteError("");
                            setDeletePassword("");
                            setDeleteCascade(false);
                            setDeleteTarget({
                              id: item.id,
                              name: item.name,
                              policyCount: item.policyCount,
                            });
                          }}
                        />
                      </SettingsRowActions>
                    </SettingsTd>
                  </tr>
                ))
              ) : (
                <SettingsEmptyRow colSpan={8}>{t("settings.insuranceProducts.client.empty")}</SettingsEmptyRow>
              )}
            </tbody>
        </SettingsTable>
      </SettingsSection>

      {editing ? (
        <div className="app-modal-backdrop z-[1000]">
          <div className="app-modal-panel max-w-[min(42rem,calc(100vw-1rem))]">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">{editing.id ? t("insuranceProductEdit.editTitle") : t("insuranceFormModal.newProductTitle")}</div>
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="secondary-button h-8 px-2"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSave}>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 sm:p-4">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <Field label={t("investForm.productNameLabel")}>
                    <input
                      value={editing.name}
                      onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                      className="form-input"
                    />
                  </Field>
                  <Field label={t("wealthForm.shortName")}>
                    <input
                      value={editing.shortName}
                      onChange={(event) => setEditing({ ...editing, shortName: event.target.value })}
                      className="form-input"
                    />
                  </Field>
                  <Field label={t("insuranceProductEdit.productTypeLabel")}>
                    <select
                      value={editing.productType}
                      onChange={(event) => setEditing({ ...editing, productType: event.target.value })}
                      className="form-input"
                    >
                      {PRODUCT_TYPE_VALUES.map((value) => (
                        <option key={value} value={value}>
                          {productTypeLabel(t, value)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t("insuranceProductEdit.accountingTypeLabel")}>
                    <select
                      value={editing.accountingType}
                      onChange={(event) =>
                        setEditing({ ...editing, accountingType: event.target.value })
                      }
                      className="form-input"
                    >
                      {ACCOUNTING_TYPE_VALUES.map((value) => (
                        <option key={value} value={value}>
                          {accountingTypeLabel(t, value)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t("insuranceProductEdit.institutionLabel")}>
                    <select
                      value={editing.institutionId}
                      onChange={(event) => setEditing({ ...editing, institutionId: event.target.value })}
                      className="form-input"
                    >
                      <option value="">{t("txForm.selectPlaceholder")}</option>
                      {institutions.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label || item.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t("detail.column.currency")}>
                    <input
                      value={editing.currency}
                      onChange={(event) => setEditing({ ...editing, currency: event.target.value.toUpperCase() })}
                      className="form-input"
                    />
                  </Field>
                </div>
                <Field label={t("insurance.col.note")}>
                  <textarea
                    value={editing.note}
                    onChange={(event) => setEditing({ ...editing, note: event.target.value })}
                    className="form-input min-h-24 resize-y"
                  />
                </Field>
              </div>

              <div className="shrink-0 border-t border-slate-100 bg-white/95 px-3 py-3 sm:px-4">
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="secondary-button h-9 px-4"
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="primary-button h-9 px-4 disabled:opacity-50"
                  >
                    {saving ? t("settings.tags.saving") : t("settings.insuranceProducts.client.saveProduct")}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div
          className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[1px]"
          onMouseDown={() => {
            if (deleting) return;
            setDeleteTarget(null);
            setDeleteError("");
          }}
        >
          <div
            className="w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-4 shadow-xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="text-sm font-semibold text-slate-800">{t("settings.insuranceProducts.client.deleteConfirmTitle")}</div>
            <div className="mt-1 text-xs leading-5 text-slate-500">
              {deleteTarget.policyCount > 0
                ? t("settings.insuranceProducts.client.deleteLinkedWarning", { name: deleteTarget.name, count: deleteTarget.policyCount })
                : t("settings.insuranceProducts.client.deleteNoLinked", { name: deleteTarget.name })}
            </div>
            {deleteTarget.policyCount > 0 ? (
              <label className="mt-3 flex items-start gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={deleteCascade}
                  onChange={(event) => setDeleteCascade(event.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300"
                />
                <span>{t("settings.insuranceProducts.client.cascadeLabel")}</span>
              </label>
            ) : null}
            <input
              type="password"
              value={deletePassword}
              onChange={(event) => {
                setDeletePassword(event.target.value);
                setDeleteError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void confirmDelete();
                }
              }}
              placeholder={t("settings.insuranceProducts.client.passwordPlaceholder")}
              autoFocus
              className="mt-3 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-blue-400"
            />
            {deleteError ? <div className="mt-1 text-xs text-red-500">{deleteError}</div> : null}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  if (deleting) return;
                  setDeleteTarget(null);
                  setDeleteError("");
                }}
                className="h-8 rounded-md border border-slate-200 bg-white px-3 text-xs text-slate-600 hover:bg-slate-50"
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deleting}
                className="h-8 rounded-md bg-red-600 px-3 text-xs text-white hover:bg-red-700 disabled:opacity-50"
              >
                {deleting ? t("stockPanel.deleting") : t("settings.accounts.confirmDelete")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1">
      <div className="form-label">{label}</div>
      {children}
    </label>
  );
}
