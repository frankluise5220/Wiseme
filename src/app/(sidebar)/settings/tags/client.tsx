"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { SettingsActionButton, SettingsPrimaryAddButton } from "@/components/settings/SettingsPageScaffold";
import { BasicDataSubmenuHeader } from "@/components/settings/BasicDataImportExport";
import { fetchSettingsTags, getCachedSettingsTags, notifySettingsDataChanged, setSettingsTags } from "@/lib/client/settingsCache";
import { useI18n } from "@/lib/i18n";
import { TAG_COLORS } from "@/lib/tag-colors";

type Tag = {
  id: string;
  name: string;
  color: string | null;
};

export default function SettingsTagsClient({
  initialTags,
  initialLoaded = false,
}: {
  initialTags: Tag[];
  initialLoaded?: boolean;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [tags, setTags] = useState<Tag[]>(initialTags);
  const [editing, setEditing] = useState<Tag | null>(null);

  useEffect(() => {
    if (initialLoaded) {
      setSettingsTags(initialTags);
      return;
    }
    const cached = getCachedSettingsTags();
    if (cached) {
      setTags(cached);
      return;
    }
    void fetchTags();
  }, [initialLoaded, initialTags]);

  async function fetchTags(options?: { force?: boolean }) {
    const next = await fetchSettingsTags(options).catch(() => null);
    if (next) setTags(next);
  }

  const handleDelete = useCallback(async (id: string) => {
    const res = await fetch(`/api/v1/tags?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await res.json();
    if (data.ok) {
      setTags(prev => {
        const next = prev.filter(t => t.id !== id);
        setSettingsTags(next);
        return next;
      });
      void notifySettingsDataChanged({ scope: "tags", reason: "tag:delete", prefetch: true });
    }
    else window.alert(data.error || t("settings.tags.deleteFailed"));
  }, [t]);

  async function handleSaveTag(input: { id?: string; name: string; color: string }) {
    const res = await fetch("/api/v1/tags", {
      method: input.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; tag?: Tag } | null;
    if (!res.ok || !data?.ok || !data.tag) {
      throw new Error(data?.error || t("settings.tags.saveFailed"));
    }
    setTags((prev) => {
      const next = input.id
        ? prev.map((tag) => (tag.id === input.id ? data.tag! : tag))
        : [...prev, data.tag!];
      setSettingsTags(next);
      return next;
    });
    void notifySettingsDataChanged({ scope: "tags", reason: input.id ? "tag:update" : "tag:create", prefetch: true });
  }

  // Columns must be memoized: AdvancedDataTable re-derives hideable-column keys from the
  // columns identity, and a fresh array each render would retrigger its hidden-keys effect.
  const columns: AdvancedDataTableColumn<Tag>[] = useMemo(() => [
    {
      key: "name",
      label: t("settings.tags.tag"),
      width: 220,
      sortValue: (row) => row.name,
      render: (row) => <span className="font-medium text-slate-800">{row.name}</span>,
    },
    {
      key: "color",
      label: t("settings.tags.color"),
      width: 160,
      sortValue: (row) => row.color ?? "",
      render: (row) => (
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: row.color || "#64748B" }} />
          <span className="font-mono text-[11px] text-slate-500">{row.color || "#64748B"}</span>
        </div>
      ),
    },
    {
      key: "actions",
      label: t("settings.tags.actions"),
      width: 100,
      align: "right",
      render: (row) => (
        <div className="flex items-center justify-end gap-1">
          <SettingsActionButton
            label={t("settings.tags.edit")}
            variant="edit"
            onClick={() => setEditing(row)}
          />
          <SettingsActionButton
            label={t("settings.tags.delete")}
            variant="delete"
            onClick={() => handleDelete(row.id)}
          />
        </div>
      ),
    },
  ], [t, handleDelete]);

  return (
    <div className="space-y-4">
      <BasicDataSubmenuHeader onImported={() => void fetchTags({ force: true })} />

      <AdvancedDataTable
        storageKey="mmh_settings_tags_table_v1"
        columns={columns}
        rows={tags}
        rowKey={(row) => row.id}
        emptyText={t("settings.tags.empty")}
        minTableWidth={640}
        showFilters={false}
        onRowDoubleClick={(row) => {
          const params = new URLSearchParams({
            view: "detail",
            tagId: row.id,
            detailAll: "1",
          });
          router.push(`/?${params.toString()}`);
        }}
        toolbarRightContent={(
          <SettingsPrimaryAddButton onClick={() => setEditing({ id: "", name: "", color: TAG_COLORS[6] })}>{t("settings.tags.add")}</SettingsPrimaryAddButton>
        )}
      />

      {editing ? (
        <TagEditModal
          tag={editing.id ? editing : undefined}
          onCancel={() => setEditing(null)}
          onSave={async (input) => {
            await handleSaveTag(input);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function TagEditModal({
  tag,
  onCancel,
  onSave,
}: {
  tag?: Tag;
  onCancel: () => void;
  onSave: (input: { id?: string; name: string; color: string }) => Promise<void>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState(tag?.color || TAG_COLORS[6]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave({ id: tag?.id, name: name.trim(), color });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.tags.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="app-modal-backdrop z-[1100]">
      <div className="app-modal-panel max-w-md">
        <div className="modal-header shrink-0">
          <div className="text-sm font-semibold text-slate-800">{tag ? t("settings.tags.edit") : t("settings.tags.add")}</div>
          <button type="button" onClick={onCancel} className="secondary-button h-8 px-2">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form className="space-y-4 p-4" onSubmit={submit}>
          {error ? <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div> : null}
          <label className="block space-y-1">
            <span className="form-label">{t("settings.tags.name")}</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              className="form-input"
              placeholder={t("settings.tags.namePlaceholder")}
            />
          </label>
          <div className="space-y-2">
            <div className="form-label">{t("settings.tags.color")}</div>
            <div className="grid grid-cols-6 gap-2">
              {TAG_COLORS.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setColor(item)}
                  className={`h-8 rounded-md border-2 transition ${color === item ? "border-slate-900" : "border-transparent hover:border-slate-300"}`}
                  style={{ backgroundColor: item }}
                  title={item}
                />
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
            <button type="button" onClick={onCancel} className="secondary-button h-9 px-4">{t("common.cancel")}</button>
            <button type="submit" disabled={saving || !name.trim()} className="primary-button h-9 px-4 disabled:opacity-50">
              {saving ? t("settings.tags.saving") : t("common.save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
