"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
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
import { AI_API_MODES, CHANNEL_TYPES, getModelsUrl, normalizeAiApiMode, type AiApiMode } from "@/lib/ai/config";
import { dispatchAiConfigChanged } from "@/lib/client/aiConfig";
import { parseBaseUrl, buildBaseUrl, PROTOCOL_OPTIONS, PORT_SUGGESTIONS } from "@/lib/urlInput";
import type { ParsedUrl } from "@/lib/urlInput";
import { useI18n } from "@/lib/i18n";

type ModelEntry = {
  id: string;
  name: string;
  channelId: string;
  channelType: string;
  channelName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiMode: AiApiMode;
  category?: string;
  supportsVision?: boolean;
};

export type InitialAiChannel = {
  id: string;
  name: string;
  channelType: string;
  baseUrl: string;
  apiKey: string;
  AiModel: Array<{ id: string; name: string | null; model: string; vision: boolean; apiMode?: string | null; active: boolean }>;
};

const MODELS_KEY = "mmh_ai_models";
const ACTIVE_MODEL_KEY = "mmh_ai_active_model";

function genId() { return Math.random().toString(36).slice(2, 10); }

function detectModelInfo(id: string) {
  const lower = id.toLowerCase();
  const supportsVision = /gpt-4o|vision|qwen[-_]?vl|glm-4v|internvl|llava|pix|multimodal|mm/.test(lower);
  const category = supportsVision ? "vision"
    : /embed|embedding/.test(lower) ? "embedding"
    : /whisper|audio|tts|speech|transcrib/.test(lower) ? "audio"
    : /dall|image|sdxl|stable[-_ ]diffusion|flux/.test(lower) ? "image"
    : "text";
  return { id, category, supportsVision };
}

function categoryLabel(category: string, t: (key: string, params?: Record<string, string | number>) => string) {
  if (category === "vision") return t("settings.ai.client.category.vision");
  if (category === "embedding") return t("settings.ai.client.category.embedding");
  if (category === "audio") return t("settings.ai.client.category.audio");
  if (category === "image") return t("settings.ai.client.category.image");
  return t("settings.ai.client.category.text");
}

function loadModels(): ModelEntry[] {
  try {
    const raw = localStorage.getItem(MODELS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ModelEntry[];
      return parsed.map((entry) => ({ ...entry, apiMode: normalizeAiApiMode(entry.apiMode) }));
    }
  } catch {}
  return [];
}
function saveModels(models: ModelEntry[]) {
  try { localStorage.setItem(MODELS_KEY, JSON.stringify(models)); } catch {}
}
function loadActiveModel(): string {
  try { return localStorage.getItem(ACTIVE_MODEL_KEY) ?? ""; } catch { return ""; }
}
function saveActiveModel(name: string) {
  try { localStorage.setItem(ACTIVE_MODEL_KEY, name); } catch {}
}

function buildModelsFromServer(channels: InitialAiChannel[]): ModelEntry[] {
  const merged: ModelEntry[] = [];
  for (const ch of channels) {
    for (const m of ch.AiModel ?? []) {
      const info = detectModelInfo(m.model);
      merged.push({
        id: m.id,
        name: m.name || m.model,
        channelId: ch.id,
        channelType: ch.channelType || "custom",
        channelName: ch.name,
        baseUrl: ch.baseUrl,
        apiKey: ch.apiKey ?? "",
        model: m.model,
        apiMode: normalizeAiApiMode(m.apiMode),
        category: info.category,
        supportsVision: m.vision || info.supportsVision,
      });
    }
  }
  return merged;
}

async function fetchModelsForChannel(baseUrl: string, apiKey: string, modelsUrl: string, t: (key: string, params?: Record<string, string | number>) => string) {
  if (!baseUrl) return [];
  const res = await fetch("/api/v1/ai/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl, apiKey, modelsUrl }),
  });
  const data = await res.json() as { ok: boolean; models?: string[]; modelInfos?: Array<{ id: string; category: string; supportsVision: boolean }> };
  if (!data.ok) throw new Error((data as any).error ?? t("settings.ai.client.fetchModelsFailed"));
  if (Array.isArray(data.modelInfos) && data.modelInfos.length) return data.modelInfos;
  if (Array.isArray(data.models) && data.models.length) return data.models.map(m => detectModelInfo(m));
  return [];
}

type ModelInfo = ReturnType<typeof detectModelInfo>;

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
          placeholder={t("settings.ai.client.hostPlaceholder")}
          className="h-9 flex-1 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none font-mono"
        />
        <span className="text-slate-300 text-sm font-mono">:</span>
        <input
          value={value.port}
          onChange={e => onChange({ ...value, port: e.target.value })}
          type="number"
          placeholder={t("settings.ai.client.portPlaceholder")}
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
          placeholder={t("settings.ai.client.pathPlaceholder")}
          className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none font-mono"
        />
      </div>
    </div>
  );
}

function ModelModal({
  initial,
  onSave,
  onCancel,
}: {
  initial?: ModelEntry;
  onSave: (entry: ModelEntry) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<"config" | "models">("config");
  const [channelName, setChannelName] = useState(initial?.name ?? "");
  const [channelType, setChannelType] = useState(initial?.channelType ?? initial?.channelId ?? "openai");
  const [urlParts, setUrlParts] = useState<ParsedUrl>(parseBaseUrl(initial?.baseUrl));
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const [modelList, setModelList] = useState<ModelInfo[]>(
    initial?.model ? [{ id: initial.model, category: initial.category ?? detectModelInfo(initial.model).category, supportsVision: initial.supportsVision ?? detectModelInfo(initial.model).supportsVision }] : []
  );
  const [selectedModel, setSelectedModel] = useState(initial?.model ?? "");
  const [apiMode, setApiMode] = useState<AiApiMode>(initial?.apiMode ?? "chat");

  const currentBaseUrl = buildBaseUrl(urlParts);

  async function handleFetch() {
    if (!currentBaseUrl) { setError(t("settings.ai.client.errBaseUrlRequired")); return; }
    if (channelType !== "ollama" && !apiKey.trim()) { setError(t("settings.ai.client.errApiKeyRequired")); return; }
    setFetching(true); setError("");
    try {
      const models = await fetchModelsForChannel(currentBaseUrl, apiKey.trim(), getModelsUrl(channelType), t);
      if (models.length === 0) { setError(t("settings.ai.client.errNoModels")); setFetching(false); return; }
      setModelList(models); setSelectedModel(models[0]?.id ?? ""); setStep("models");
    } catch (e) {
      setError(t("settings.ai.client.errFetchFailed", { message: e instanceof Error ? e.message : t("batchImport.unknownError") }));
    } finally { setFetching(false); }
  }

  function handleConfirm() {
    if (!selectedModel) return;
    const name = channelName.trim() || selectedModel;
    const info = modelList.find(m => m.id === selectedModel) ?? detectModelInfo(selectedModel);
    onSave({
      id: initial?.id ?? genId(), name, channelId: initial?.channelId ?? "", channelType,
      channelName: name,
      baseUrl: currentBaseUrl, apiKey: apiKey.trim(), model: selectedModel,
      apiMode: channelType === "ollama" ? "chat" : apiMode,
      category: info.category, supportsVision: info.supportsVision,
    });
  }

  const modalTitle = step === "config"
    ? initial ? t("settings.ai.client.modalTitle.configEdit") : t("settings.ai.client.modalTitle.config")
    : initial ? t("settings.ai.client.modalTitle.selectEdit") : t("settings.ai.client.modalTitle.select");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg bg-white rounded-xl shadow-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
          <div className="text-sm font-semibold text-slate-800">
            {modalTitle}
          </div>
        </div>
        <div className="p-5 space-y-4">
          {step === "config" ? (
            <>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">{t("settings.ai.client.channelName")}</label>
                <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  placeholder={t("settings.ai.client.channelNamePlaceholder")} value={channelName} onChange={e => setChannelName(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">{t("settings.ai.client.channelType")}</label>
                <select className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  value={channelType} onChange={e => { setChannelType(e.target.value); if (e.target.value === "ollama" && !urlParts.host) { setUrlParts({ protocol: "http:", host: "localhost", port: "11434", path: "" }); } }}>
                  {CHANNEL_TYPES.map(ct => (
                    <option key={ct.id} value={ct.id}>{t(`settings.ai.client.channelType.${ct.id}`)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">{t("settings.ai.client.serviceUrl")}</label>
                <UrlInputGroup value={urlParts} onChange={setUrlParts} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">{t("settings.ai.client.apiKey")}</label>
                <input className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  type="password" placeholder="sk-..." value={apiKey} onChange={e => setApiKey(e.target.value)} />
                {channelType === "ollama" && <p className="text-[11px] text-slate-400 mt-1">{t("settings.ai.client.ollamaNoKey")}</p>}
              </div>
              {error && <div className="text-xs text-red-600">{error}</div>}
              <div className="flex justify-end gap-2">
                <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
                  onClick={onCancel}>{t("common.cancel")}</button>
                <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                  onClick={handleFetch} disabled={fetching}>
                  {fetching ? t("settings.ai.client.fetching") : t("settings.ai.client.fetchModels")}
                </button>
              </div>
            </>
          ) : (
            <>
              {channelType !== "ollama" && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">{t("settings.ai.client.apiMode")}</label>
                  <select className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                    value={apiMode} onChange={e => setApiMode(e.target.value as AiApiMode)}>
                    {AI_API_MODES.map(mode => (
                      <option key={mode.id} value={mode.id}>{t(mode.labelKey)}</option>
                    ))}
                  </select>
                </div>
              )}
              <select className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                value={selectedModel} onChange={e => setSelectedModel(e.target.value)}>
                {modelList.map(m => (
                  <option key={m.id} value={m.id}>{m.id}{m.supportsVision ? t("settings.ai.client.visionSuffix") : ""}</option>
                ))}
              </select>
              {modelList.length <= 20 && (
                <div className="max-h-40 overflow-auto">
                  {modelList.map(m => (
                    <div key={m.id} className={`px-3 py-2 text-sm cursor-pointer ${m.id === selectedModel ? "bg-blue-50 text-blue-700" : "hover:bg-slate-50"}`}
                      onClick={() => setSelectedModel(m.id)}>
                      <span className="truncate">{m.id}</span>
                      <span className="text-[11px] text-slate-500 ml-2">{categoryLabel(m.category, t)}</span>
                      {m.supportsVision && <span className="text-[11px] text-emerald-700 ml-1">{t("settings.ai.client.category.vision")}</span>}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50"
                  onClick={() => { setStep("config"); }}>{t("settings.ai.client.back")}</button>
                <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50"
                  onClick={handleConfirm} disabled={!selectedModel}>
                  {initial ? t("common.save") : t("settings.ai.client.add")}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AISettingsClient({
  initialChannels,
  initialActiveModelId,
}: {
  initialChannels: InitialAiChannel[];
  initialActiveModelId: string | null;
}) {
  const { t } = useI18n();
  const [pageReady, setPageReady] = useState(false);
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [activeModel, setActiveModel] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editingModel, setEditingModel] = useState<ModelEntry | null>(null);
  const [quickAdd, setQuickAdd] = useState<ModelEntry | null>(null);
  const [quickFetching, setQuickFetching] = useState(false);
  const [quickModelList, setQuickModelList] = useState<ModelInfo[]>([]);
  const [quickSelected, setQuickSelected] = useState("");
  const [quickApiMode, setQuickApiMode] = useState<AiApiMode>("chat");

  useEffect(() => {
    const serverModels = buildModelsFromServer(initialChannels);
    const nextModels = serverModels.length > 0 || initialChannels.length > 0 ? serverModels : loadModels();
    setModels(nextModels);
    saveModels(nextModels);

    const activeEntry = nextModels.find((item) => item.id === initialActiveModelId);
    const nextActive = activeEntry?.name ?? loadActiveModel();
    setActiveModel(nextActive);
    if (nextActive) saveActiveModel(nextActive);
    setPageReady(true);
  }, [initialActiveModelId, initialChannels]);

  useEffect(() => {
    if (!pageReady) return;
    saveModels(models);
  }, [models, pageReady]);

  useEffect(() => {
    if (!pageReady) return;
    const handler = () => {
      setModels(loadModels());
      setActiveModel(loadActiveModel());
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [pageReady]);

  function handleAddModel(entry: ModelEntry): Promise<ModelEntry | null> {
    if (models.some(m => m.id !== entry.id && m.model === entry.model && m.channelName === entry.channelName)) {
      alert(t("settings.ai.client.duplicateModel"));
      return Promise.resolve(null);
    }
    const idx = models.findIndex(m => m.id === entry.id);
    let next: ModelEntry[];
    if (idx >= 0) {
      next = [...models]; next[idx] = entry;
    } else {
      next = [...models, entry];
    }
    setModels(next);
    setShowModal(false);
    setEditingModel(null);

    return syncToServer(entry)
      .then(({ channelId, modelId }) => {
        const savedEntry = {
          ...entry,
          channelId: channelId || entry.channelId,
          id: modelId || entry.id,
        };
        setModels(prev => prev.map(item => (item.id === entry.id ? savedEntry : item)));
        return savedEntry;
      })
      .catch(() => {
        alert(t("settings.ai.client.syncFailed"));
        return null;
      });
  }

  async function syncToServer(entry: ModelEntry): Promise<{ channelId: string; modelId: string }> {
    const headers = { "Content-Type": "application/json" };
    const channelResponse = await fetch("/api/v1/settings/ai-config", {
      method: entry.channelId ? "PUT" : "POST",
      headers,
      body: JSON.stringify({
        ...(entry.channelId ? { channelId: entry.channelId } : {}),
        name: entry.channelName || entry.name,
        channelType: entry.channelType || "custom",
        baseUrl: entry.baseUrl,
        apiKey: entry.apiKey,
      }),
    });
    const channelData = await channelResponse.json().catch(() => null) as any;
    if (!channelResponse.ok || !channelData?.ok) {
      throw new Error(channelData?.error ?? t("settings.ai.client.syncFailed"));
    }
    const channelId = entry.channelId || channelData.channel?.id;
    if (!channelId) throw new Error(t("settings.ai.client.syncFailed"));

    const modelResponse = await fetch("/api/v1/settings/ai-config", {
      method: "PUT",
      headers,
      body: JSON.stringify(entry.channelId ? {
        updateModelId: entry.id,
        model: entry.model,
        name: entry.name,
        vision: !!entry.supportsVision,
        apiMode: entry.channelType === "ollama" ? "chat" : entry.apiMode,
      } : {
        model: entry.model,
        name: entry.name,
        channelId,
        vision: !!entry.supportsVision,
        apiMode: entry.channelType === "ollama" ? "chat" : entry.apiMode,
      }),
    });
    const modelData = await modelResponse.json().catch(() => null) as any;
    if (!modelResponse.ok || !modelData?.ok) {
      throw new Error(modelData?.error ?? t("settings.ai.client.syncFailed"));
    }
    dispatchAiConfigChanged();
    return { channelId, modelId: modelData.model?.id || entry.id };
  }

  function handleRemoveModel(id: string) {
    const entry = models.find(m => m.id === id);
    if (!entry) return;
    setModels(prev => prev.filter(m => m.id !== id));
    if (activeModel === entry.name) {
      const remaining = models.filter(m => m.id !== id);
      const nextActive = remaining[0]?.name ?? "";
      saveActiveModel(nextActive);
      setActiveModel(nextActive);
    }
    if (entry.channelId) {
      void fetch("/api/v1/settings/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteModelId: entry.id }),
      }).then(async (response) => {
        const data = await response.json().catch(() => null) as any;
        if (!response.ok || !data?.ok) alert(t("settings.ai.client.syncFailed"));
        else dispatchAiConfigChanged();
      }).catch(() => alert(t("settings.ai.client.syncFailed")));
    }
  }

  function handleSetDefault(name: string, entryOverride?: ModelEntry) {
    const entry = entryOverride ?? models.find(item => item.name === name);
    saveActiveModel(name);
    setActiveModel(name);
    if (entry?.channelId) {
      void fetch("/api/v1/settings/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeModelId: entry.id }),
      }).then(async (response) => {
        const data = await response.json().catch(() => null) as any;
        if (!response.ok || !data?.ok) alert(t("settings.ai.client.syncFailed"));
        else dispatchAiConfigChanged();
      }).catch(() => alert(t("settings.ai.client.syncFailed")));
    }
  }

  function handleQuickAdd(base: ModelEntry) {
    setQuickAdd(base);
    setQuickFetching(true);
    setQuickModelList([]);
    setQuickSelected("");
    setQuickApiMode(base.apiMode);

    const modelsUrl = getModelsUrl(base.channelType);
    fetchModelsForChannel(base.baseUrl, base.apiKey ?? "", modelsUrl, t)
      .then(list => {
        setQuickModelList(list);
        setQuickSelected(list[0]?.id ?? "");
      })
      .catch(() => {})
      .finally(() => setQuickFetching(false));
  }

  function confirmQuickAdd() {
    if (!quickSelected || !quickAdd) return;
    const existing = models.find(m =>
      m.model === quickSelected &&
      (m.channelName || m.name) === (quickAdd.channelName || quickAdd.name),
    );
    if (existing) {
      handleSetDefault(existing.name || existing.model);
      setQuickAdd(null);
      return;
    }
    const info = quickModelList.find(m => m.id === quickSelected) ?? detectModelInfo(quickSelected);
    const entry = {
      id: genId(),
      name: quickSelected,
      channelId: "",
      channelType: quickAdd.channelType,
      channelName: quickAdd.channelName || quickAdd.name,
      baseUrl: quickAdd.baseUrl,
      apiKey: quickAdd.apiKey ?? "",
      model: quickSelected,
      apiMode: quickAdd.channelType === "ollama" ? "chat" : quickApiMode,
      category: info.category,
      supportsVision: info.supportsVision,
    };
    void handleAddModel(entry).then(savedEntry => {
      if (savedEntry) handleSetDefault(savedEntry.name, savedEntry);
    });
    setQuickAdd(null);
  }

  if (!pageReady) {
    return <div className="text-sm text-slate-400">{t("common.loading")}</div>;
  }

  return (
    <div className="space-y-4">
      <SettingsPageHeader
        title={t("settings.ai.client.title")}
        description={t("settings.ai.client.description")}
        count={models.length}
      />

      <SettingsSection
        title={t("settings.ai.client.listTitle")}
        count={models.length}
        actions={
          <SettingsPrimaryAddButton onClick={() => { setEditingModel(null); setShowModal(true); }}>
            {t("settings.ai.client.newChannel")}
          </SettingsPrimaryAddButton>
        }
      >
      <SettingsTable minWidth={860} maxWidth="full">
        <thead className="sticky top-0 z-10">
          <tr>
            <SettingsTh>{t("settings.ai.client.col.model")}</SettingsTh>
            <SettingsTh>{t("settings.ai.client.col.channel")}</SettingsTh>
            <SettingsTh>{t("batchImport.field.type")}</SettingsTh>
            <SettingsTh>{t("settings.fundApi.status")}</SettingsTh>
            <SettingsTh align="right">{t("detail.column.actions")}</SettingsTh>
          </tr>
        </thead>
        <tbody>
          {models.length > 0 ? models.map((m) => {
            const name = m.name || m.model;
            const isActive = activeModel === name;
            const info = detectModelInfo(m.model);
            const category = m.category ?? info.category;
            const supportsVision = m.supportsVision ?? info.supportsVision;
            return (
              <tr key={m.id} className={isActive ? "bg-blue-50/60 hover:bg-blue-50" : "hover:bg-slate-50"}>
                <SettingsTd className="text-sm">
                  <div className="min-w-0">
                    <div className={`truncate font-medium ${isActive ? "text-blue-700" : "text-slate-800"}`}>{name}</div>
                    {m.model !== name ? <div className="mt-0.5 truncate text-[11px] text-slate-400">{m.model}</div> : null}
                  </div>
                </SettingsTd>
                <SettingsTd>
                  <div className="min-w-0">
                    <div className="truncate text-xs text-slate-600">{m.channelName || m.channelId}</div>
                    <div className="mt-0.5 truncate text-[11px] text-slate-400">{m.channelType}</div>
                  </div>
                </SettingsTd>
                <SettingsTd>
                  <div className="text-xs text-slate-600">{categoryLabel(category, t)}</div>
                  {m.channelType !== "ollama" && (
                    <div className="mt-0.5 text-[11px] text-slate-400">
                      {t(AI_API_MODES.find(mode => mode.id === m.apiMode)?.labelKey ?? "settings.ai.client.apiMode.chat")}
                    </div>
                  )}
                </SettingsTd>
                <SettingsTd>
                  <div className="flex flex-wrap gap-1.5">
                    {supportsVision ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">{t("settings.ai.client.category.vision")}</span> : null}
                    {isActive ? <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] text-blue-700">{t("settings.display.default")}</span> : null}
                    {!supportsVision && !isActive ? <span className="text-xs text-slate-400">-</span> : null}
                  </div>
                </SettingsTd>
                <SettingsTd align="right">
                  <SettingsRowActions>
                    <SettingsActionButton
                      label={t("settings.ai.client.action.switch")}
                      icon={<ArrowLeftRight className="h-3.5 w-3.5" />}
                      onClick={() => handleQuickAdd(m)}
                    />
                    {!isActive ? (
                      <SettingsActionButton
                        label={t("settings.ai.client.action.setDefault")}
                        variant="defaultMark"
                        onClick={() => handleSetDefault(name)}
                      />
                    ) : null}
                    <SettingsActionButton
                      label={t("settings.ai.client.action.edit")}
                      variant="edit"
                      onClick={() => { setEditingModel(m); setShowModal(true); }}
                    />
                    <SettingsActionButton
                      label={t("settings.ai.client.action.delete")}
                      variant="delete"
                      onClick={() => handleRemoveModel(m.id)}
                    />
                  </SettingsRowActions>
                </SettingsTd>
              </tr>
            );
          }) : (
            <SettingsEmptyRow colSpan={5}>
              <button className="text-blue-600 hover:text-blue-700 text-xs" onClick={() => setShowModal(true)}>
                {t("settings.ai.client.addFirst")}
              </button>
            </SettingsEmptyRow>
          )}
        </tbody>
      </SettingsTable>
      </SettingsSection>

      {/* Quick add modal */}
      {quickAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md bg-white rounded-xl shadow-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-200 bg-slate-50">
              <div className="text-sm font-semibold text-slate-800">{t("settings.ai.client.switchTitle", { name: quickAdd.channelName || quickAdd.channelId })}</div>
            </div>
            <div className="p-5 space-y-3">
              {quickFetching ? (
                <div className="text-sm text-slate-500 text-center py-4">{t("settings.ai.client.fetchingModels")}</div>
              ) : quickModelList.length > 0 ? (
                <>
                  {quickAdd.channelType !== "ollama" && (
                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1.5">{t("settings.ai.client.apiMode")}</label>
                      <select className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                        value={quickApiMode} onChange={e => setQuickApiMode(e.target.value as AiApiMode)}>
                        {AI_API_MODES.map(mode => (
                          <option key={mode.id} value={mode.id}>{t(mode.labelKey)}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <select className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={quickSelected} onChange={e => setQuickSelected(e.target.value)}>
                    {quickModelList.map(m => (
                      <option key={m.id} value={m.id}>{m.id}{m.supportsVision ? t("settings.ai.client.visionSuffix") : ""}</option>
                    ))}
                  </select>
                  {quickModelList.length <= 20 && (
                    <div className="max-h-40 overflow-auto rounded-md border border-slate-200">
                      {quickModelList.map(m => (
                        <div key={m.id} className={`px-3 py-2 text-sm cursor-pointer ${m.id === quickSelected ? "bg-blue-50 text-blue-700" : "hover:bg-slate-50"}`}
                          onClick={() => setQuickSelected(m.id)}>
                          <span className="truncate">{m.id}</span>
                          <span className="text-[11px] text-slate-500 ml-2">{categoryLabel(m.category, t)}</span>
                          {m.supportsVision && <span className="text-[11px] text-emerald-700 ml-1">{t("settings.ai.client.category.vision")}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-sm text-red-600 text-center py-4">{t("settings.ai.client.errQuickNoModels")}</div>
              )}
              <div className="flex justify-end gap-2">
                <button className="h-9 px-4 rounded-md border border-slate-200 bg-white text-sm text-slate-700 hover:bg-slate-50" onClick={() => setQuickAdd(null)}>{t("common.cancel")}</button>
                <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={confirmQuickAdd} disabled={!quickSelected}>{t("ledgerSwitch.confirmSwitch")}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <ModelModal
          initial={editingModel ?? undefined}
          onSave={handleAddModel}
          onCancel={() => { setShowModal(false); setEditingModel(null); }}
        />
      )}
    </div>
  );
}
