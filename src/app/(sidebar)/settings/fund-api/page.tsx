"use client";

import { useState, useEffect, type DragEvent } from "react";
import { Power, PowerOff } from "lucide-react";
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
import { parseBaseUrl, buildBaseUrl, PROTOCOL_OPTIONS, PORT_SUGGESTIONS } from "@/lib/urlInput";
import type { ParsedUrl } from "@/lib/urlInput";
import { useI18n } from "@/lib/i18n";

type FundQueryApiRecord = {
  id: string;
  code: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  priority: number;
  isActive: boolean;
};

type EditForm = Omit<Partial<FundQueryApiRecord>, "baseUrl"> & {
  urlParts: ParsedUrl;
};

function makeForm(api?: Partial<FundQueryApiRecord> | null): EditForm {
  return {
    code: api?.code ?? "",
    name: api?.name ?? "",
    urlParts: parseBaseUrl(api?.baseUrl),
    apiKey: api?.apiKey ?? "",
    priority: api?.priority ?? 0,
    isActive: api?.isActive ?? true,
  };
}

function flatForm(f: EditForm): Omit<EditForm, "urlParts"> & { baseUrl: string } {
  return {
    code: f.code,
    name: f.name,
    baseUrl: buildBaseUrl(f.urlParts),
    apiKey: f.apiKey,
    priority: f.priority,
    isActive: f.isActive,
  };
}

function sortApis(apis: FundQueryApiRecord[]) {
  return [...apis].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function reorderApis(apis: FundQueryApiRecord[], sourceId: string, targetId: string) {
  const next = [...apis];
  const from = next.findIndex((api) => api.id === sourceId);
  const to = next.findIndex((api) => api.id === targetId);
  if (from < 0 || to < 0 || from === to) return apis;
  const [moved] = next.splice(from, 1);
  if (!moved) return apis;
  next.splice(to, 0, moved);
  return next.map((api, index) => ({ ...api, priority: index + 1 }));
}

function UrlInputGroup({
  value,
  onChange,
}: {
  value: ParsedUrl;
  onChange: (next: ParsedUrl) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <select
          value={value.protocol}
          onChange={e => onChange({ ...value, protocol: e.target.value })}
          className="h-9 rounded-md border border-slate-200 bg-white px-2.5 text-sm outline-none shrink-0"
        >
          {PROTOCOL_OPTIONS.map(op => (
            <option key={op.value} value={op.value}>{op.label}</option>
          ))}
        </select>
        <span className="text-slate-300 text-sm font-mono">://</span>
        <input
          value={value.host}
          onChange={e => onChange({ ...value, host: e.target.value })}
          placeholder="fund.example.com"
          className="h-9 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none font-mono"
        />
        <span className="text-slate-300 text-sm font-mono">:</span>
        <input
          value={value.port}
          onChange={e => onChange({ ...value, port: e.target.value })}
          type="number"
          placeholder={t("settings.fundApi.port")}
          list="port-suggestions"
          className="h-9 w-24 rounded-md border border-slate-200 bg-white px-2.5 text-sm outline-none font-mono"
        />
        <datalist id="port-suggestions">
          {PORT_SUGGESTIONS.filter(s => s.value).map(s => (
            <option key={s.value} value={s.value}>{t(s.labelKey)}</option>
          ))}
        </datalist>
      </div>
      <div>
        <input
          value={value.path}
          onChange={e => onChange({ ...value, path: e.target.value })}
          placeholder={t("settings.fundApi.pathPlaceholder")}
          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none font-mono"
        />
      </div>
    </div>
  );
}

export default function FundQueryApiPage() {
  const { t } = useI18n();
  const [apis, setApis] = useState<FundQueryApiRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EditForm>(makeForm());
  const [saving, setSaving] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/settings/fund-query-api", { signal: controller.signal })
      .then(async (r) => {
        const text = await r.text();
        let payload: { ok?: boolean; apis?: FundQueryApiRecord[]; error?: string } | { raw: string } = { raw: "" };
        try {
          payload = JSON.parse(text) as { ok?: boolean; apis?: FundQueryApiRecord[]; error?: string };
        } catch {
          payload = { raw: text.slice(0, 200) };
        }
        return { status: r.status, ok: r.ok, payload };
      })
      .then(({ status, payload }) => {
        if ("ok" in payload && payload.ok) {
          setApis(sortApis(Array.isArray(payload.apis) ? payload.apis : []));
          setLoadError("");
        } else {
          setApis([]);
          const hint = "ok" in payload ? (payload.error || t("settings.fundApi.requestFailed", { status })) : t("settings.fundApi.requestFailed", { status });
          setLoadError(hint);
        }
      })
      .catch((error) => {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setApis([]);
        setLoadError(t("settings.fundApi.networkFailed"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  function openEdit(api: FundQueryApiRecord) {
    setEditingId(api.id);
    setForm(makeForm(api));
  }

  function openCreate() {
    setEditingId("__new__");
    setForm(makeForm({ code: "", name: "", priority: apis.length + 1, isActive: true }));
  }

  async function saveOrder(nextApis: FundQueryApiRecord[]) {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/settings/fund-query-api", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          priorities: nextApis.map((api, index) => ({ id: api.id, priority: index + 1 })),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setApis(sortApis(Array.isArray(data.apis) ? data.apis : nextApis));
        return true;
      } else {
        alert(data.error || t("settings.fundApi.orderSaveFailed"));
        return false;
      }
    } catch {
      alert(t("settings.fundApi.orderSaveFailed"));
      return false;
    } finally {
      setSaving(false);
    }
  }

  function handleDragStart(event: DragEvent<HTMLTableRowElement>, id: string) {
    setDraggingId(id);
    setDragOverId(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
    const ghost = event.currentTarget.cloneNode(true) as HTMLElement;
    ghost.style.width = `${event.currentTarget.offsetWidth}px`;
    ghost.style.border = "2px solid rgb(37 99 235)";
    ghost.style.borderRadius = "0.375rem";
    ghost.style.boxShadow = "0 18px 45px rgba(15, 23, 42, 0.22)";
    ghost.style.background = "white";
    ghost.style.opacity = "0.98";
    ghost.style.display = "table";
    ghost.style.position = "fixed";
    ghost.style.top = "-1000px";
    ghost.style.left = "-1000px";
    ghost.style.pointerEvents = "none";
    document.body.appendChild(ghost);
    event.dataTransfer.setDragImage(ghost, 28, 28);
    window.setTimeout(() => ghost.remove(), 0);
  }

  function handleDragOver(event: DragEvent<HTMLTableRowElement>, id: string) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (draggingId && draggingId !== id) setDragOverId(id);
  }

  function handleDragLeave(event: DragEvent<HTMLTableRowElement>, id: string) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    if (dragOverId === id) setDragOverId(null);
  }

  async function handleDrop(event: DragEvent<HTMLTableRowElement>, targetId: string) {
    event.preventDefault();
    const sourceId = draggingId || event.dataTransfer.getData("text/plain");
    setDraggingId(null);
    setDragOverId(null);
    if (!sourceId || sourceId === targetId || saving) return;
    const previous = apis;
    const next = reorderApis(apis, sourceId, targetId);
    if (next === apis) return;
    setApis(next);
    const saved = await saveOrder(next);
    if (!saved) setApis(previous);
  }

  async function save() {
    if (!editingId) return;
    setSaving(true);
    try {
      const isCreate = editingId === "__new__";
      const body = isCreate ? flatForm(form) : { id: editingId, ...flatForm(form) };
      const res = await fetch("/api/v1/settings/fund-query-api", {
        method: isCreate ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.ok) {
        if (isCreate && data.api) {
          setApis(prev => [...prev, data.api].sort((a, b) => a.priority - b.priority));
        } else {
          const flat = flatForm(form);
          setApis(prev => prev.map(a => a.id === editingId ? { ...a, ...flat } as FundQueryApiRecord : a));
        }
        setEditingId(null);
        setForm(makeForm());
      } else {
        alert(data.error || t("settings.fundApi.saveFailed"));
      }
    } catch {
      alert(t("settings.fundApi.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(api: FundQueryApiRecord) {
    setSaving(true);
    try {
      const res = await fetch("/api/v1/settings/fund-query-api", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: api.id, isActive: !api.isActive }),
      });
      const data = await res.json();
      if (data.ok) {
        setApis(prev => prev.map(a => a.id === api.id ? { ...a, isActive: !a.isActive } : a));
      }
    } catch {
      alert(t("settings.fundApi.actionFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="text-sm text-slate-400">{t("common.loading")}</div>;
  }

  const isCreating = editingId === "__new__";
  const editingApi = editingId && !isCreating ? apis.find((api) => api.id === editingId) ?? null : null;

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={t("settings.fundApi.title")}
        description={t("settings.fundApi.description")}
        count={apis.length}
      />

      {loadError && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">
          {loadError}
        </div>
      )}

      <SettingsSection
        title={t("settings.fundApi.listTitle")}
        count={apis.length}
        actions={<SettingsPrimaryAddButton onClick={openCreate}>{t("settings.fundApi.add")}</SettingsPrimaryAddButton>}
      >
      <SettingsTable minWidth={920} maxWidth="full">
        <colgroup>
          <col className="w-[4.5rem]" />
          <col className="w-[13rem]" />
          <col className="w-[9rem]" />
          <col />
          <col className="w-[6rem]" />
          <col className="w-[6.5rem]" />
        </colgroup>
        <thead className="sticky top-0 z-10">
          <tr>
            <SettingsTh align="center">{t("settings.fundApi.order")}</SettingsTh>
            <SettingsTh>{t("settings.fundApi.name")}</SettingsTh>
            <SettingsTh>{t("settings.fundApi.code")}</SettingsTh>
            <SettingsTh>{t("settings.fundApi.url")}</SettingsTh>
            <SettingsTh>{t("settings.fundApi.status")}</SettingsTh>
            <SettingsTh align="right">{t("settings.fundApi.actions")}</SettingsTh>
          </tr>
        </thead>
        <tbody>
          {apis.length > 0 ? apis.map((api, index) => (
            <tr
              key={api.id}
              draggable={editingId === null && !saving}
              onDragStart={(event) => handleDragStart(event, api.id)}
              onDragEnd={() => { setDraggingId(null); setDragOverId(null); }}
              onDragOver={(event) => handleDragOver(event, api.id)}
              onDragLeave={(event) => handleDragLeave(event, api.id)}
              onDrop={(event) => handleDrop(event, api.id)}
              className={[
                api.isActive ? "hover:bg-slate-50" : "bg-slate-50/70 opacity-70",
                draggingId === api.id ? "bg-blue-50/80 opacity-95 ring-2 ring-inset ring-blue-200" : "",
                dragOverId === api.id && draggingId !== api.id ? "bg-blue-50 ring-2 ring-inset ring-blue-300" : "",
              ].join(" ")}
            >
              <SettingsTd align="center">
                <span className="inline-flex h-7 w-7 cursor-grab select-none items-center justify-center rounded-md border border-slate-200 bg-slate-50 text-xs font-semibold text-slate-500 active:cursor-grabbing">
                  {index + 1}
                </span>
              </SettingsTd>
              <SettingsTd className="text-sm font-medium text-slate-800">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{api.name}</span>
                  {api.code === "alipay" ? (
                    <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-normal text-blue-700">{t("settings.fundApi.alipayPriority")}</span>
                  ) : null}
                </div>
              </SettingsTd>
              <SettingsTd className="font-mono text-[11px] text-slate-500">{api.code}</SettingsTd>
              <SettingsTd className="truncate font-mono text-[11px] text-slate-400" title={api.baseUrl}>{api.baseUrl}</SettingsTd>
              <SettingsTd>
                <span className={`rounded px-2 py-0.5 text-xs ${api.isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                  {api.isActive ? t("common.enabled") : t("common.disabled")}
                </span>
              </SettingsTd>
              <SettingsTd align="right">
                <SettingsRowActions>
                  <SettingsActionButton
                    label={api.isActive ? t("settings.fundApi.disableApi") : t("settings.fundApi.enableApi")}
                    icon={api.isActive ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                    onClick={() => toggleActive(api)}
                    disabled={saving}
                  />
                  <SettingsActionButton label={t("settings.fundApi.editApi")} variant="edit" onClick={() => openEdit(api)} />
                </SettingsRowActions>
              </SettingsTd>
            </tr>
          )) : (
            <SettingsEmptyRow colSpan={6}>{t("settings.fundApi.empty")}</SettingsEmptyRow>
          )}
        </tbody>
      </SettingsTable>
      </SettingsSection>

      {(isCreating || editingApi) ? (
        <div className="app-modal-backdrop z-[1100]">
          <div className="app-modal-panel max-w-2xl">
            <div className="modal-header shrink-0">
              <div className="text-sm font-semibold text-slate-800">{isCreating ? t("settings.fundApi.addTitle") : t("settings.fundApi.editTitle")}</div>
            </div>
            <div className="space-y-3 p-5">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("settings.fundApi.code")}</div>
                  {isCreating ? (
                    <input value={form.code ?? ""} onChange={e => setForm(f => ({ ...f, code: e.target.value }))}
                      className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none font-mono" />
                  ) : (
                    <div className="flex h-9 items-center rounded-md border border-slate-100 bg-slate-50 px-3 text-sm font-mono text-slate-500">
                      {editingApi?.code ?? form.code}
                    </div>
                  )}
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-medium text-slate-600">{t("settings.fundApi.order")}</div>
                  <div className="flex h-9 items-center rounded-md border border-slate-100 bg-slate-50 px-3 text-sm text-slate-500">
                    {isCreating ? t("settings.fundApi.dragAfterCreate") : t("settings.fundApi.positionInfo", { position: apis.findIndex((api) => api.id === editingId) + 1 })}
                  </div>
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("settings.fundApi.name")}</div>
                <input value={form.name ?? ""} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("settings.fundApi.url")}</div>
                <UrlInputGroup value={form.urlParts} onChange={next => setForm(f => ({ ...f, urlParts: next }))} />
              </div>
              <div className="space-y-1">
                <div className="text-xs font-medium text-slate-600">{t("settings.fundApi.apiKey")}</div>
                <input value={form.apiKey ?? ""} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
                  className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" />
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
                <button onClick={() => { setEditingId(null); setForm(makeForm()); }}
                  className="h-9 rounded-md border border-slate-200 bg-white px-4 text-sm text-slate-700 hover:bg-slate-50">{t("common.cancel")}</button>
                <button onClick={save} disabled={saving}
                  className="h-9 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700 disabled:opacity-50">{isCreating ? t("settings.fundApi.create") : t("common.save")}</button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
