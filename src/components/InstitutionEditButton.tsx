"use client";

import { useState, type FormEvent } from "react";
import { SettingsActionButton } from "@/components/settings/SettingsPageScaffold";
import { notifySettingsDataChanged } from "@/lib/client/settingsCache";
import { useI18n } from "@/lib/i18n";

type InstitutionType = "family_member" | "person" | "organization" | "bank" | "insurance" | "brokerage" | "fund_company" | "payment" | "debt" | "other";
const TYPE_LABEL_KEYS: Record<InstitutionType, string> = {
  family_member: "institution.type.family_member",
  person: "institution.type.person",
  organization: "institution.type.organization",
  bank: "institution.type.bank",
  insurance: "institution.type.insurance",
  brokerage: "institution.type.brokerage",
  fund_company: "institution.type.fund_company",
  payment: "institution.type.payment",
  debt: "institution.type.debt",
  other: "institution.type.other",
};

export function InstitutionEditButton({
  institution,
  action,
  title,
  nameLabel,
  allowedTypes,
  onSaved,
}: {
  institution: { id: string; name: string; shortName?: string | null; type: string | null };
  action: (formData: FormData) => void | { ok?: boolean; error?: string } | Promise<void | { ok?: boolean; error?: string }>;
  title?: string;
  nameLabel?: string;
  allowedTypes?: string[];
  onSaved?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(institution.name);
  const [shortName, setShortName] = useState(institution.shortName ?? "");
  const [type, setType] = useState<InstitutionType>((institution.type as InstitutionType) ?? "other");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true);
    const fd = new FormData();
    fd.set("institutionId", institution.id);
    fd.set("name", name.trim());
    fd.set("shortName", shortName.trim());
    fd.set("type", type);
    try {
      setError("");
      const result = await action(fd);
      if (typeof result === "object" && result && result.ok === false) {
        setError(result.error ?? t("institutionEdit.saveFailed"));
        return;
      }
      setOpen(false);
      onSaved?.();
      void notifySettingsDataChanged({ scope: "accounts", reason: "institution:save", prefetch: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("institutionEdit.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <SettingsActionButton
        label={title ?? t("settings.counterparties.editTitle")}
        variant="edit"
        onClick={() => {
          setName(institution.name);
          setShortName(institution.shortName ?? "");
          const initialType = (institution.type as InstitutionType) ?? "other";
          setType((allowedTypes?.includes(initialType) ? initialType : allowedTypes?.[0] ?? "other") as InstitutionType);
          setError("");
          setOpen(true);
        }}
      />

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white border border-slate-200 shadow-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-800">{title ?? t("settings.counterparties.editTitle")}</div>
              <button type="button" onClick={() => setOpen(false)}
                className="h-8 px-2 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50">{t("table.close")}</button>
            </div>
            <form className="p-4 space-y-3" onSubmit={onSubmit}>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{nameLabel ?? t("liabilitiesGuide.nameLabel")}</div>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  required
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("institutionEdit.shortName")}</div>
                <input
                  value={shortName}
                  onChange={(e) => setShortName(e.target.value)}
                  placeholder={t("institutionEdit.shortNamePlaceholder")}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("institutionEdit.type")}</div>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value as InstitutionType)}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                >
                  {(Object.keys(TYPE_LABEL_KEYS) as InstitutionType[])
                    .filter((typeKey) => !allowedTypes?.length || allowedTypes.includes(typeKey))
                    .map((typeKey) => (
                    <option key={typeKey} value={typeKey}>{t(TYPE_LABEL_KEYS[typeKey])}</option>
                  ))}
                </select>
              </div>
              {error && <div className="text-xs text-red-600">{error}</div>}
              <div className="flex justify-end">
                <button type="submit" disabled={saving}
                  className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50">
                  {saving ? t("institutionEdit.saving") : t("common.save")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
