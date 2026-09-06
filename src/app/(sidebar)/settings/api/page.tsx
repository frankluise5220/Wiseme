"use client";

import { useState, useEffect } from "react";
import { X } from "lucide-react";
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
import { copyToClipboard } from "@/lib/client/clipboard";
import { generateRandomKey } from "@/lib/client/randomKey";
import { useI18n } from "@/lib/i18n";

type AccessKey = {
  id: string;
  name: string;
  keyPreview: string;
  createdAt?: string;
};

export default function ApiKeysPage() {
  const { t } = useI18n();
  const [keys, setKeys] = useState<AccessKey[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetchKeys(controller.signal);
    return () => controller.abort();
  }, []);

  async function fetchKeys(signal?: AbortSignal) {
    try {
      const res = await fetch("/api/v1/settings/access-keys", { signal });
      const data = await res.json();
      if (data.ok && Array.isArray(data.keys)) setKeys(data.keys);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }

  async function handleCreate() {
    if (!name.trim() || !newKey.trim()) return;
    try {
      const res = await fetch("/api/v1/settings/access-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), key: newKey }),
      });
      const data = await res.json();
      if (data.ok && data.key) {
        setKeys(prev => [data.key, ...prev]);
        setShowModal(false);
        setName("");
        setNewKey("");
      }
    } catch { /* ignore */ }
  }

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/v1/settings/access-keys?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) setKeys(prev => prev.filter(k => k.id !== id));
    } catch { /* ignore */ }
  }

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={t("settings.externalApiKeys.title")}
        description={t("settings.externalApiKeys.description")}
        count={keys.length}
      />

      <SettingsSection
        title={t("settings.externalApiKeys.listTitle")}
        count={keys.length}
        actions={
          <SettingsPrimaryAddButton onClick={() => { setNewKey(generateRandomKey()); setName(""); setShowModal(true); }}>
            {t("settings.externalApiKeys.add")}
          </SettingsPrimaryAddButton>
        }
      >
      <SettingsTable minWidth={760} maxWidth="full">
        <thead className="sticky top-0 z-10">
          <tr>
            <SettingsTh>{t("settings.externalApiKeys.name")}</SettingsTh>
            <SettingsTh>{t("settings.externalApiKeys.key")}</SettingsTh>
            <SettingsTh>{t("settings.externalApiKeys.createdAt")}</SettingsTh>
            <SettingsTh align="right">{t("settings.externalApiKeys.actions")}</SettingsTh>
          </tr>
        </thead>
        <tbody>
          {keys.length > 0 ? keys.map((k) => (
              <tr key={k.id} className="hover:bg-slate-50">
                <SettingsTd className="text-sm font-medium text-slate-800">{k.name}</SettingsTd>
                <SettingsTd className="max-w-[24rem] truncate font-mono text-[11px] text-slate-500">
                  {k.keyPreview}
                </SettingsTd>
                <SettingsTd>{k.createdAt ? new Date(k.createdAt).toLocaleString() : "-"}</SettingsTd>
                <SettingsTd align="right">
                  <SettingsRowActions>
                    <SettingsActionButton
                      label={t("settings.externalApiKeys.deleteKey")}
                      variant="delete"
                      onClick={() => handleDelete(k.id)}
                    />
                  </SettingsRowActions>
                </SettingsTd>
              </tr>
          )) : (
            <SettingsEmptyRow colSpan={4}>{t("settings.externalApiKeys.empty")}</SettingsEmptyRow>
          )}
        </tbody>
      </SettingsTable>
      </SettingsSection>

      {showModal && (
        <div className="app-modal-backdrop z-[1100]">
          <div className="app-modal-panel max-w-md">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">{t("settings.externalApiKeys.addTitle")}</div>
              <button type="button" onClick={() => setShowModal(false)} className="secondary-button h-8 px-2">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="form-label mb-1.5 block">{t("settings.externalApiKeys.name")}</label>
                <input className="form-input"
                  value={name} onChange={(e) => setName(e.target.value)} placeholder={t("settings.externalApiKeys.namePlaceholder")} autoFocus />
              </div>
              <div>
                <label className="form-label mb-1.5 block">{t("settings.externalApiKeys.key")}</label>
                <div className="flex items-center gap-2">
                  <div className="h-9 flex-1 rounded-md border border-slate-200 bg-slate-50 px-3 text-sm text-slate-700 overflow-hidden font-mono">{newKey}</div>
                  <button className="secondary-button h-9 px-3"
                    onClick={() => copyToClipboard(newKey)}>{t("settings.externalApiKeys.copy")}</button>
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
                <button className="secondary-button h-9 px-4" onClick={() => setShowModal(false)}>{t("common.cancel")}</button>
                <button className="primary-button h-9 px-4 disabled:opacity-50"
                  onClick={handleCreate} disabled={!name.trim()}>{t("common.save")}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
