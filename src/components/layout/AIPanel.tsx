"use client";

import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PanelRightClose, PanelRightOpen, Send, X, Wand2, ImagePlus, Plus, Settings, ChevronDown, Sparkles, Trash2, Eye, Pencil, Mail } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { AI_API_MODES, CHANNEL_TYPES, getModelsUrl, normalizeAiApiMode, type AiApiMode } from "@/lib/ai/config";
import { callDeleteEntries, getDeleteRefreshAccountIds, getDeleteRefreshEntryIds } from "@/lib/api/entries-delete";
import { AI_CONFIG_CHANGED_EVENT } from "@/lib/client/aiConfig";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import { TableColumnFilter } from "@/components/TableColumnFilter";
import {
  APP_PREFS_EVENT,
  getAiPanelCollapsedPreference,
  getAiPanelEnabledPreference,
  setAiPanelCollapsedPreference,
} from "@/lib/client/appPreferences";
import { useI18n } from "@/lib/i18n";

/* ---- Types ---- */

type ParsedItemMeta = {
  accountDisplayName?: string;
  institutionName?: string;
  cardNumberMasked?: string;
  creditLimit?: number;
  billingDay?: number;
  repaymentDay?: number;
};

type ParsedItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  postedAt?: string;
  amount: number;
  accountId?: string;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  categoryId?: string;
  category?: string;
  institutionId?: string;
  institution?: string;
  remark?: string;
  counterparty?: string;
  _meta?: ParsedItemMeta;
};

type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; trace?: string[]; error?: string };

type ImportConfirmItem = {
  key: string;
  item: ParsedItem;
  ready: boolean;
  missingFields: string[];
};

type UpdatePreview = {
  operationType: string;
  action: string;
  targetField: string;
  oldValue?: string;
  newValue?: string;
  scopeFields: Array<{ label: string; value: string }>;
};

type ConfirmTarget = {
  id?: string;
  transactionId?: string;
  date: string;
  accountName: string;
  amount: number;
  remark: string;
  type?: string;
};

type ConfirmDialog = {
  kind: "delete" | "restore" | "update";
  count: number;
  label: string;
  payload: Record<string, unknown>;
  tip: string;
  targets?: ConfirmTarget[];
  preview?: UpdatePreview;
  selectedTargetIds?: Set<string>;
  selectAll?: boolean;
};

type DeletePreviewFilters = {
  text: string;
  accountName: string;
  type: "all" | "expense" | "income" | "transfer" | "investment";
  selection: "all" | "selected" | "unselected";
};

type DeletePreviewColumn = "selection" | "date" | "type" | "account" | "amount" | "remark";

type ImportConfirmDialog = {
  items: ImportConfirmItem[];
  selectedKeys: Set<string>;
  selectAll: boolean;
};

type CorrectionSkill = {
  keyword: string;
  account?: string;
  counterparty?: string;
  category?: string;
  remark?: string;
  type?: string;
};

/* ---- Constants & Helpers ---- */

const SKILLS_KEY = "mmh_ai_skills";
const AI_MODEL_CACHE_TTL_MS = 30_000;

type AiModelConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiMode: AiApiMode;
};

type AiModelLoadResult = {
  names: string[];
  configs: Record<string, AiModelConfig>;
  idsByName: Record<string, string>;
  active: string;
};

let aiModelCache: { loadedAt: number; result: AiModelLoadResult } | null = null;
let aiModelRequest: Promise<AiModelLoadResult | null> | null = null;
let aiPanelMessagesCache: Message[] | null = null;

function loadSkills(): CorrectionSkill[] {
  try {
    const raw = localStorage.getItem(SKILLS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function applySkills(items: ParsedItem[], rawText: string): ParsedItem[] {
  const skills = loadSkills();
  if (skills.length === 0) return items;
  return items.map((item) => {
    const combined = `${item.rawText} ${item.counterparty ?? ""} ${item.remark ?? ""}`.toLowerCase();
    for (const skill of skills) {
      if (combined.includes(skill.keyword.toLowerCase())) {
        return {
          ...item,
          account: item.account || skill.account,
          institution: item.institution || skill.counterparty,
          counterparty: item.counterparty || skill.counterparty,
          category: item.category || skill.category,
          remark: item.remark || skill.remark,
          type: (skill.type as ParsedItem["type"]) || item.type,
        };
      }
    }
    return item;
  });
}

function isRowReadyForImport(item: ParsedItem) {
  const amountAbs = Math.abs(item.amount ?? 0);
  if (!Number.isFinite(amountAbs) || amountAbs <= 0) return false;
  if (item.type === "transfer") return !!(item.fromAccount?.trim() && item.toAccount?.trim());
  if (!item.accountId?.trim() && !item.account?.trim() && !item._meta?.institutionName) return false;
  return true;
}

function getMissingFields(item: ParsedItem, t: (key: string, params?: Record<string, string | number>) => string): string[] {
  const missing: string[] = [];
  if (!item.date?.trim()) missing.push(t("detail.column.date"));
  if (!(item.amount > 0)) missing.push(t("stats.amount"));
  if (item.type === "transfer") {
    if (!item.fromAccount?.trim()) missing.push(t("txForm.transferFrom"));
    if (!item.toAccount?.trim()) missing.push(t("txForm.transferTo"));
  } else {
    if (!item.accountId?.trim() && !item.account?.trim()) missing.push(t("common.account"));
  }
  return missing;
}

function normalizeItemForImport(item: ParsedItem): ParsedItem {
  return {
    rawText: item.rawText,
    type: item.type,
    date: item.date?.trim() || undefined,
    postedAt: typeof item.postedAt === "string" ? item.postedAt.trim() || undefined : undefined,
    amount: Math.abs(item.amount ?? 0) || 0,
    accountId: item.accountId?.trim() || undefined,
    account: item.account?.trim() || undefined,
    fromAccount: item.fromAccount?.trim() || undefined,
    toAccount: item.toAccount?.trim() || undefined,
    categoryId: item.categoryId?.trim() || undefined,
    category: item.category?.trim() || undefined,
    institutionId: item.institutionId?.trim() || undefined,
    institution: item.institution?.trim() || undefined,
    remark: item.remark?.trim() || undefined,
    counterparty: item.counterparty?.trim() || undefined,
    _meta: item._meta ? {
      accountDisplayName: item._meta.accountDisplayName?.trim() || undefined,
      institutionName: item._meta.institutionName?.trim() || undefined,
      cardNumberMasked: item._meta.cardNumberMasked?.trim() || undefined,
      creditLimit: item._meta.creditLimit,
      billingDay: item._meta.billingDay,
      repaymentDay: item._meta.repaymentDay,
    } : undefined,
  };
}

function itemTypeLabel(type: ParsedItem["type"], t: (key: string, params?: Record<string, string | number>) => string) {
  if (type === "transfer") return t("transaction.type.transfer");
  if (type === "income") return t("transaction.type.income");
  if (type === "investment") return t("transaction.type.investment");
  return t("transaction.type.expense");
}

function itemAccountLabel(item: ParsedItem, t: (key: string, params?: Record<string, string | number>) => string) {
  if (item.type === "transfer") {
    const from = item.fromAccount?.trim() || t("aiPanel.noTransferFrom");
    const to = item.toAccount?.trim() || t("aiPanel.noTransferTo");
    return `${from} -> ${to}`;
  }
  if (item._meta?.accountDisplayName?.trim()) return item._meta.accountDisplayName.trim();
  return item.account?.trim() || item.accountId?.trim() || item._meta?.institutionName?.trim() || t("aiPanel.noAccount");
}

function formatRecognitionPreviewBlock(item: ParsedItem, index: number, t: (key: string, params?: Record<string, string | number>) => string) {
  const date = item.date?.trim() || t("aiPanel.noDate");
  const remark = item.remark?.trim() || item.counterparty?.trim() || "";
  return [
    `${index + 1}.`,
    t("aiPanel.block.date", { value: date }),
    t("aiPanel.block.postedAt", { value: item.postedAt?.trim() || date }),
    t("aiPanel.block.type", { value: itemTypeLabel(item.type, t) }),
    t("aiPanel.block.amount", { value: formatMoney(Math.abs(item.amount ?? 0)) }),
    t("aiPanel.block.account", { value: itemAccountLabel(item, t) }),
    t("aiPanel.block.counterparty", { value: item.institution?.trim() || item.counterparty?.trim() || "-" }),
    t("aiPanel.block.category", { value: item.category?.trim() || "-" }),
    t("aiPanel.block.remark", { value: remark }),
  ].join("\n");
}

function formatRecognitionPreviewText(items: ParsedItem[], t: (key: string, params?: Record<string, string | number>) => string) {
  const lines = items.slice(0, 8).map((item, index) => formatRecognitionPreviewBlock(item, index, t));
  const rest = items.length > lines.length ? t("aiPanel.preview.more", { count: items.length - lines.length }) : "";
  return `${t("aiPanel.preview.title", { count: items.length })}\n${lines.join("\n\n")}${rest}`;
}

/* ---- Component ---- */

export function AIPanel({
  defaultAccountName,
  initialCollapsed = false,
}: {
  defaultAccountName?: string;
  initialCollapsed?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const chatEndRef = useRef<HTMLDivElement>(null);
  const modelsLoadedRef = useRef(false);

  /* State */
  const [mounted, setMounted] = useState(false);
  const [enabled, setEnabled] = useState(() => getAiPanelEnabledPreference());
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>(() =>
    aiPanelMessagesCache ?? [{ role: "assistant", text: t("aiPanel.welcome") }],
  );
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsedState] = useState(() => initialCollapsed || getAiPanelCollapsedPreference());
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [importConfirmDialog, setImportConfirmDialog] = useState<ImportConfirmDialog | null>(null);
  const [deletePreviewFilters, setDeletePreviewFilters] = useState<DeletePreviewFilters>({ text: "", accountName: "", type: "all", selection: "all" });
  const [deletePreviewColumnFilters, setDeletePreviewColumnFilters] = useState<Partial<Record<DeletePreviewColumn, string[]>>>({});
  const [activeDeletePreviewFilterColumn, setActiveDeletePreviewFilterColumn] = useState<DeletePreviewColumn | null>(null);

  const [activeModel, setActiveModel] = useState(() => {
    try { return localStorage.getItem("mmh_ai_active_model") ?? ""; } catch { return ""; }
  });
  const [modelNames, setModelNames] = useState<string[]>([]);
  const [modelConfigs, setModelConfigs] = useState<Record<string, { baseUrl: string; apiKey: string; model: string; apiMode: AiApiMode }>>({});
  const [modelIdsByName, setModelIdsByName] = useState<Record<string, string>>({});
  const [modelsLoading, setModelsLoading] = useState(true);

  /* Auto-scroll chat */
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  /* Init: load models */
  useEffect(() => {
    setEnabled(getAiPanelEnabledPreference());
    setMounted(true);
  }, []);

  useEffect(() => {
    function onPreferencesChanged() {
      setEnabled(getAiPanelEnabledPreference());
    }
    window.addEventListener(APP_PREFS_EVENT, onPreferencesChanged);
    return () => window.removeEventListener(APP_PREFS_EVENT, onPreferencesChanged);
  }, []);

  useEffect(() => {
    const onAiConfigChanged = () => reloadModels(true);
    window.addEventListener(AI_CONFIG_CHANGED_EVENT, onAiConfigChanged);
    return () => window.removeEventListener(AI_CONFIG_CHANGED_EVENT, onAiConfigChanged);
  }, []);

  useEffect(() => {
    aiPanelMessagesCache = messages;
  }, [messages]);

  useEffect(() => {
    if (!mounted) return;
    if (!enabled) return;
    if (collapsed) {
      setModelsLoading(false);
      return;
    }
    const run = () => {
      modelsLoadedRef.current = true;
      reloadModels();
    };
    const requestIdle = window.requestIdleCallback;
    if (requestIdle) {
      const idleId = requestIdle(run, { timeout: 2500 });
      return () => window.cancelIdleCallback?.(idleId);
    }
    const timer = window.setTimeout(run, 800);
    return () => window.clearTimeout(timer);
  }, [mounted, enabled]);

  useEffect(() => {
    if (!mounted) return;
    function onFocus() {
      if (pathname.startsWith("/settings") && collapsed) return;
      reloadModels();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [mounted, pathname, collapsed]);

  function setCollapsedPersist(next: boolean) {
    setCollapsedState(next);
    setAiPanelCollapsedPreference(next);
    if (!next && !modelsLoadedRef.current) {
      modelsLoadedRef.current = true;
      reloadModels();
    }
  }

  /* ---- Models ---- */

  async function loadModelsFromDB(): Promise<AiModelLoadResult | null> {
    if (aiModelCache && Date.now() - aiModelCache.loadedAt < AI_MODEL_CACHE_TTL_MS) {
      return aiModelCache.result;
    }
    if (aiModelRequest) return aiModelRequest;

    aiModelRequest = (async () => {
    try {
      const res = await fetch("/api/v1/settings/ai-config");
      const data = await res.json();
      if (!data.ok || !data.channels) return null;
      const models: Array<{ id: string; name: string; baseUrl: string; apiKey: string; model: string; apiMode: string | null | undefined }> = [];
      for (const ch of data.channels) {
        for (const m of ch.AiModel) {
          models.push({
            id: m.id,
            name: m.name || m.model,
            baseUrl: ch.baseUrl,
            apiKey: ch.apiKey ?? "",
            model: m.model,
            apiMode: m.apiMode,
          });
        }
      }
      if (models.length === 0) return null;
      const names = models.map((m) => m.name).filter(Boolean);
      const configs: Record<string, { baseUrl: string; apiKey: string; model: string; apiMode: AiApiMode }> = {};
      const idsByName: Record<string, string> = {};
      for (const m of models) {
        if (!m.name) continue;
        configs[m.name] = {
          baseUrl: m.baseUrl,
          apiKey: m.apiKey,
          model: m.model,
          apiMode: normalizeAiApiMode(m.apiMode),
        };
        idsByName[m.name] = m.id;
      }
      const activeModelFromDB = models.find((m) => m.id === data.activeModelId);
      const active = activeModelFromDB?.name ?? names[0] ?? "";
      return { names, configs, idsByName, active };
    } catch {
      return null;
    }
    })();

    const result = await aiModelRequest;
    aiModelRequest = null;
    if (result) aiModelCache = { loadedAt: Date.now(), result };
    return result;
  }

  function reloadModels(force = false) {
    if (force) aiModelCache = null;
    loadModelsFromDB().then((dbResult) => {
      setModelsLoading(false);
      if (dbResult && dbResult.names.length > 0) {
        setModelNames(dbResult.names);
        setModelConfigs(dbResult.configs);
        setModelIdsByName(dbResult.idsByName);
        setActiveModel((current) => {
          const saved = current || localStorage.getItem("mmh_ai_active_model") || "";
          const next = saved && dbResult.configs[saved] ? saved : dbResult.active;
          try { localStorage.setItem("mmh_ai_active_model", next); } catch { /* ignore */ }
          return next;
        });
      }
    });
  }

  /* ---- API Calls ---- */

  function getFundContext(): { fundCode: string; accountId?: string } | null {
    try {
      const q = new URLSearchParams(window.location.search);
      const view = q.get("view");
      if (view !== "investfund" && view !== "investmoney") return null;
      const fundCode = q.get("fundCode");
      if (!fundCode) return null;
      return { fundCode, accountId: q.get("accountId") ?? undefined };
    } catch { return null; }
  }

  function getViewAccountContext() {
    const accountId = searchParams.get("accountId")?.trim() || undefined;
    const accountName = searchParams.get("account")?.trim() || defaultAccountName?.trim() || undefined;
    return { accountId, accountName };
  }

  async function parseStatement(payload: { text?: string; imageDataUrl?: string; accountName?: string }) {
    const cfg = modelConfigs[activeModel];
    const fundContext = getFundContext();
    const viewAccount = getViewAccountContext();
    const res = await fetch("/api/v1/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...payload,
        accountId: payload.accountName ? undefined : viewAccount.accountId,
        accountName: payload.accountName ?? viewAccount.accountName,
        baseUrl: cfg?.baseUrl?.trim() || undefined,
        apiKey: cfg?.apiKey?.trim() || undefined,
        modelName: cfg?.model || undefined,
        apiMode: cfg?.apiMode || undefined,
        fundContext: fundContext || undefined,
      }),
    });
    if (!res.ok) throw new Error(await readApiError(res, `HTTP ${res.status}`));
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || t("aiPanel.parseFailed"));
    return data;
  }

  async function importItems(items: ParsedItem[]) {
    const defaultAcc = (defaultAccountName ?? "").trim();
    const viewAccount = getViewAccountContext();
    const res = await fetch("/api/v1/ai/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items,
        accountId: viewAccount.accountId,
        defaultAccountName: defaultAcc || viewAccount.accountName || undefined,
      }),
    });
    if (!res.ok) throw new Error(await readApiError(res, `HTTP ${res.status}`));
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || t("creditBill.importFailed"));
    return data;
  }

  async function readApiError(res: Response, fallback: string) {
    const text = await res.text().catch(() => "");
    try {
      const data = JSON.parse(text) as { code?: string; error?: string } | null;
      if (data?.error) {
        return data.code ? `${data.code}: ${data.error}` : data.error;
      }
    } catch { /* ignore */ }
    return text.trim() || fallback;
  }

  /* ---- Handlers ---- */

  async function onSend() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setLoading(true);
    setMessages((m) => [...m, { role: "user", text }]);
    try {
      const parsed = await parseStatement({ text });

      if ("operation" in parsed && parsed.operation === "delete") {
        if (parsed.stage === "confirm") {
          const targets = parsed.targets ?? [];
          const targetIds = targets
            .map((target: { id?: string; transactionId?: string }) => target.transactionId ?? target.id)
            .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
          setConfirmDialog({
            kind: "delete",
            label: t("aiPanel.deletePreview"),
            count: parsed.deletedCount,
            payload: { sourceText: text },
            tip: t("aiPanel.willDelete", { count: parsed.deletedCount }),
            targets,
            selectedTargetIds: new Set(targetIds),
            selectAll: targetIds.length > 0 && targetIds.length === targets.length,
          });
          setDeletePreviewFilters({ text: "", accountName: "", type: "all", selection: "all" });
          setDeletePreviewColumnFilters({});
          setActiveDeletePreviewFilterColumn(null);
          setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.hitConfirm", { count: parsed.deletedCount }), trace: parsed.trace }]);
          return;
        }
        setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.deleted", { count: parsed.deletedCount }), trace: parsed.trace }]);
        dispatchFinanceDataChanged({ reason: "ai-entry-delete" });
        return;
      }

      if ("operation" in parsed && parsed.operation === "restore") {
        if (parsed.stage === "confirm") {
          setConfirmDialog({ kind: "restore", label: t("aiPanel.restoreConfirmTitle"), count: parsed.restoredCount, payload: { sourceText: text }, tip: t("aiPanel.willRestore", { count: parsed.restoredCount }), targets: parsed.targets ?? [] });
          setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.hitConfirm", { count: parsed.restoredCount }), trace: parsed.trace }]);
          return;
        }
        setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.restored", { count: parsed.restoredCount }), trace: parsed.trace }]);
        dispatchFinanceDataChanged({ reason: "ai-entry-restore" });
        return;
      }

      if ("operation" in parsed && parsed.operation === "update") {
        if (parsed.stage === "confirm") {
          setConfirmDialog({ kind: "update", label: t("aiPanel.updatePreviewTitle"), count: parsed.count, payload: { sourceText: text }, tip: t("aiPanel.willUpdate", { count: parsed.count }), targets: parsed.targets ?? [], preview: parsed.preview });
          setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.hitUpdateConfirm", { count: parsed.count }), trace: parsed.trace }]);
          return;
        }
        setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.updated", { count: parsed.updatedCount }), trace: parsed.trace }]);
        dispatchFinanceDataChanged({ reason: "ai-entry-update" });
        return;
      }

      if ("operation" in parsed && parsed.operation === "stats") {
        const statsValue = parsed.metric === "sum"
          ? t("aiPanel.sumTotal", { value: formatMoney(parsed.sum) })
          : t("aiPanel.countSuffix", { count: parsed.count });
        setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.statsResult", { value: statsValue }), trace: parsed.trace }]);
        return;
      }

      if (parsed.items) {
        const withSkills = applySkills(parsed.items, text);
        const allItems = withSkills.map(normalizeItemForImport);
        const importData = allItems.map((item, i) => ({
          key: `ai-${i}-${Date.now()}`,
          item,
          ready: isRowReadyForImport(item),
          missingFields: getMissingFields(item, t),
        }));
        setImportConfirmDialog({
          items: importData,
          selectedKeys: new Set(importData.filter(it => it.ready).map(it => it.key)),
          selectAll: importData.every(it => it.ready),
        });
        setMessages((m) => [...m, { role: "assistant", text: formatRecognitionPreviewText(allItems, t), trace: parsed.trace }]);
      } else if (parsed.operation) {
        setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.executedOp", { operation: parsed.operation }), trace: parsed.trace }]);
        dispatchFinanceDataChanged({ reason: "ai-operation" });
      }
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.error", { message: e.message }), error: e.message }]);
    } finally { setLoading(false); }
  }

  async function onPickImage(file: File) {
    if (loading) return;
    setLoading(true);
    setMessages((m) => [...m, { role: "user", text: t("aiPanel.uploadScreenshot", { name: file.name }) }]);
    try {
      const reader = new FileReader();
      const imageDataUrl = await new Promise<string>((resolve) => {
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
      });
      const parsed = await parseStatement({ imageDataUrl });
      if (parsed.items) {
        const allItems = parsed.items.map(normalizeItemForImport);
        const importData = allItems.map((item, i) => ({
          key: `img-${i}-${Date.now()}`,
          item,
          ready: isRowReadyForImport(item),
          missingFields: getMissingFields(item, t),
        }));
        setImportConfirmDialog({
          items: importData,
          selectedKeys: new Set(importData.filter(it => it.ready).map(it => it.key)),
          selectAll: importData.every(it => it.ready),
        });
        setMessages((m) => [...m, { role: "assistant", text: formatRecognitionPreviewText(allItems, t), trace: parsed.trace }]);
      }
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.recognizeFailed", { message: e.message }) }]);
    } finally { setLoading(false); }
  }

  async function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    for (const it of items) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); await onPickImage(f); }
      }
    }
  }

  async function onConfirmBatchAction() {
    if (!confirmDialog || loading) return;
    setLoading(true);
    try {
      if (confirmDialog.kind === "delete") {
        const entryIds = Array.from(confirmDialog.selectedTargetIds ?? new Set<string>());
        if (entryIds.length === 0) {
          setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.selectAtLeastOne") }]);
          return;
        }
        let data = await callDeleteEntries({ entryIds });
        if (!data.ok && data.needConfirm) {
          const deleteBusiness = await showConfirmDialog({
            title: t("aiPanel.confirmDeleteBusiness.title"),
            message: t("aiPanel.confirmDeleteBusiness.message", { ok: t("common.ok"), cancel: t("common.cancel") }),
            tone: "danger",
          });
          if (!deleteBusiness) {
            const keepBusiness = await showConfirmDialog({
              title: t("aiPanel.confirmKeepFlow.title"),
              message: t("aiPanel.confirmKeepFlow.message", { ok: t("common.ok"), cancel: t("common.cancel") }),
            });
            if (!keepBusiness) {
              setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.cancelledDelete") }]);
              setConfirmDialog(null);
              return;
            }
          }
          data = await callDeleteEntries({ entryIds, linkedAction: deleteBusiness ? "deleteBusiness" : "keepBusiness" });
        }
        if (!data?.ok) throw new Error(data?.error || t("settingsDelete.deleteFailed"));
        setMessages((m) => [...m, { role: "assistant", text: data.message || t("aiPanel.deleted", { count: entryIds.length }) }]);
        setConfirmDialog(null);
        const refreshEntryIds = getDeleteRefreshEntryIds(data, entryIds);
        dispatchFinanceDataChanged({ reason: "ai-entry-delete", accountIds: getDeleteRefreshAccountIds(data), deletedEntryIds: refreshEntryIds, entryIds: refreshEntryIds });
        return;
      }
      const src = String(confirmDialog.payload.sourceText ?? "").trim();
      const parsed = await parseStatement({ text: `${src}，确认执行` });
      if (parsed.ok) {
        setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.confirmedExecuted", { count: parsed.deletedCount || parsed.restoredCount || parsed.updatedCount || 0 }), trace: parsed.trace }]);
        setConfirmDialog(null);
        dispatchFinanceDataChanged({ reason: "ai-confirmed-operation" });
      }
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.executionFailed", { message: e.message }) }]);
    } finally { setLoading(false); }
  }

  async function onConfirmBatchImport() {
    if (!importConfirmDialog || loading) return;
    const selected = importConfirmDialog.items
      .filter(it => importConfirmDialog.selectedKeys.has(it.key))
      .map(it => it.item);
    if (!selected.length) return;
    setLoading(true);
    try {
      const result = await importItems(selected);
      const createdAccounts = Array.isArray(result.createdAccounts) ? result.createdAccounts : [];
      const accountText = createdAccounts.length
        ? t("aiPanel.autoCreatedAccounts", { names: createdAccounts.map((account: any) => `${account.institutionName ? `${account.institutionName}·` : ""}${account.name}`).join("、") })
        : "";
      setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.importedCount", { count: result.createdCount, extra: accountText }) }]);
      setImportConfirmDialog(null);
      dispatchFinanceDataChanged({ reason: "ai-entry-import" });
    } catch (e: any) {
      setMessages((m) => [...m, { role: "assistant", text: t("aiPanel.importFailed", { message: e.message }) }]);
    } finally { setLoading(false); }
  }

  function toggleImportItem(key: string) {
    if (!importConfirmDialog) return;
    const nextKeys = new Set(importConfirmDialog.selectedKeys);
    if (nextKeys.has(key)) nextKeys.delete(key); else nextKeys.add(key);
    setImportConfirmDialog({ ...importConfirmDialog, selectedKeys: nextKeys, selectAll: nextKeys.size === importConfirmDialog.items.length });
  }

  function toggleImportAll() {
    if (!importConfirmDialog) return;
    const nextSelectAll = !importConfirmDialog.selectAll;
    const nextKeys = nextSelectAll
      ? new Set(importConfirmDialog.items.map(it => it.key))
      : new Set<string>();
    setImportConfirmDialog({ ...importConfirmDialog, selectedKeys: nextKeys, selectAll: nextSelectAll });
  }

  function targetIdOf(target: { id?: string; transactionId?: string }) {
    return target.transactionId ?? target.id ?? "";
  }

  function targetTypeLabel(type?: string, translate = t) {
    return type === "transfer" ? translate("transaction.type.transfer") : type === "income" ? translate("transaction.type.income") : type === "investment" ? translate("transaction.type.investment") : translate("transaction.type.expense");
  }

  function getFilteredConfirmTargets(dialog = confirmDialog) {
    if (!dialog || dialog.kind !== "delete") return [] as ConfirmTarget[];
    const keyword = deletePreviewFilters.text.trim().toLowerCase();
    const selectedIds = dialog.selectedTargetIds ?? new Set<string>();
    return (dialog.targets ?? []).filter((target) => {
      const id = targetIdOf(target);
      if (deletePreviewFilters.accountName && target.accountName !== deletePreviewFilters.accountName) return false;
      if (deletePreviewFilters.type !== "all" && target.type !== deletePreviewFilters.type) return false;
      if (deletePreviewFilters.selection === "selected" && !selectedIds.has(id)) return false;
      if (deletePreviewFilters.selection === "unselected" && selectedIds.has(id)) return false;
      const haystack = `${target.date} ${target.accountName} ${target.remark} ${targetTypeLabel(target.type)} ${target.amount}`.toLowerCase();
      if (keyword && !haystack.includes(keyword)) return false;
      return (Object.entries(deletePreviewColumnFilters) as Array<[DeletePreviewColumn, string[] | undefined]>).every(([column, values]) => {
        if (!values || values.length === 0) return true;
        return values.includes(getDeletePreviewColumnValue(target, column, selectedIds));
      });
    });
  }

  function getDeletePreviewColumnValue(target: ConfirmTarget, column: DeletePreviewColumn, selectedIds = confirmDialog?.selectedTargetIds ?? new Set<string>()) {
    if (column === "selection") return selectedIds.has(targetIdOf(target)) ? t("stockPanel.selected") : t("aiPanel.unselected");
    if (column === "date") return target.date || "-";
    if (column === "type") return targetTypeLabel(target.type);
    if (column === "account") return target.accountName || "-";
    if (column === "amount") return `${target.amount < 0 ? "-" : "+"}${formatMoney(Math.abs(target.amount || 0))}`;
    return target.remark || t("detailView.noNote");
  }

  function deletePreviewColumnOptions(column: DeletePreviewColumn, dialog = confirmDialog) {
    if (!dialog || dialog.kind !== "delete") return [];
    const selectedIds = dialog.selectedTargetIds ?? new Set<string>();
    return Array.from(new Set((dialog.targets ?? []).map((target) => getDeletePreviewColumnValue(target, column, selectedIds))))
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }

  function renderDeletePreviewColumnFilter(column: DeletePreviewColumn, label: string) {
    const selectedValues = deletePreviewColumnFilters[column] ?? [];
    const isOpen = activeDeletePreviewFilterColumn === column;
    return (
      <TableColumnFilter
        label={label}
        options={isOpen ? deletePreviewColumnOptions(column, deletePreviewDialog) : []}
        selectedValues={selectedValues}
        open={isOpen}
        onToggleOpen={() => setActiveDeletePreviewFilterColumn((current) => current === column ? null : column)}
        onClose={() => setActiveDeletePreviewFilterColumn(null)}
        onChange={(values) => setDeletePreviewColumnFilters((current) => {
          if (!values || values.length === 0) {
            const next = { ...current };
            delete next[column];
            return next;
          }
          return { ...current, [column]: values };
        })}
      />
    );
  }

  function deletePreviewAccountOptions(dialog = confirmDialog) {
    const names = new Set<string>();
    if (dialog?.kind === "delete") {
      for (const target of dialog.targets ?? []) {
        if (target.accountName) names.add(target.accountName);
      }
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }

  function updateConfirmDialogSelection(nextIds: Set<string>) {
    if (!confirmDialog) return;
    const filteredIds = getFilteredConfirmTargets(confirmDialog).map((target) => targetIdOf(target)).filter(Boolean);
    const selectAll = filteredIds.length > 0 && filteredIds.every((id) => nextIds.has(id));
    setConfirmDialog({ ...confirmDialog, selectedTargetIds: nextIds, selectAll });
  }

  function toggleConfirmTarget(id: string) {
    if (!confirmDialog || !id) return;
    const nextIds = new Set(confirmDialog.selectedTargetIds ?? []);
    if (nextIds.has(id)) nextIds.delete(id); else nextIds.add(id);
    updateConfirmDialogSelection(nextIds);
  }

  function toggleConfirmAllTargets() {
    if (!confirmDialog) return;
    const filteredIds = getFilteredConfirmTargets(confirmDialog).map((target) => targetIdOf(target)).filter(Boolean);
    if (filteredIds.length === 0) return;
    const nextIds = new Set(confirmDialog.selectedTargetIds ?? []);
    const allFilteredSelected = filteredIds.every((id) => nextIds.has(id));
    for (const id of filteredIds) {
      if (allFilteredSelected) nextIds.delete(id);
      else nextIds.add(id);
    }
    updateConfirmDialogSelection(nextIds);
  }

  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [settingsView, setSettingsView] = useState(false);

  /* ---- Settings state ---- */
  type ChannelData = { id: string; name: string; channelType: string; baseUrl: string; apiKey: string; AiModel: Array<{ id: string; name: string; model: string; vision: boolean; apiMode?: string | null; active: boolean }> };
  const [channels, setChannels] = useState<ChannelData[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [addChannelForm, setAddChannelForm] = useState<{ name: string; channelType: string; baseUrl: string; apiKey: string; apiMode: AiApiMode }>({ name: "", channelType: "deepseek", baseUrl: "", apiKey: "", apiMode: "chat" });
  const [remoteModels, setRemoteModels] = useState<Array<{ id: string; category: string; supportsVision: boolean }>>([]);
  const [selectedRemoteModel, setSelectedRemoteModel] = useState("");
  const [newChannelId, setNewChannelId] = useState("");
  const [modelFetched, setModelFetched] = useState(false); // Whether model fetching has been attempted.
  const [fetchingModels, setFetchingModels] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsError, setSettingsError] = useState("");

  /* ---- Edit model overlay ---- */
  const [editModelOverlay, setEditModelOverlay] = useState<null | {
    modelId: string;
    modelDbId: string;
    channelId: string;
    channelName: string;
    channelType: string;
    baseUrl: string;
    apiKey: string;
    modelName: string;
    vision: boolean;
    apiMode: AiApiMode;
  }>(null);

  async function openEditModelOverlay(modelName: string) {
    const modelDbId = modelIdsByName[modelName];
    if (!modelDbId) return;
    setModelDropdownOpen(false);
    const freshChannels = await loadChannelsFromDB();
    const sourceChannels = freshChannels ?? channels;
    for (const ch of sourceChannels) {
      const m = ch.AiModel.find((m) => m.id === modelDbId);
      if (m) {
        setEditModelOverlay({
          modelId: m.model,
          modelDbId: m.id,
          channelId: ch.id,
          channelName: ch.name,
          channelType: ch.channelType ?? "custom",
          baseUrl: ch.baseUrl,
          apiKey: ch.apiKey ?? "",
          modelName: m.name || m.model,
          vision: m.vision ?? false,
          apiMode: ch.channelType === "ollama" ? "chat" : normalizeAiApiMode(m.apiMode),
        });
        return;
      }
    }
  }

  async function saveEditModelOverlay() {
    if (!editModelOverlay) return;
    setSettingsLoading(true);
    setSettingsError("");
    try {
      const chRes = await fetch("/api/v1/settings/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelId: editModelOverlay.channelId,
          name: editModelOverlay.channelName,
          channelType: editModelOverlay.channelType,
          baseUrl: editModelOverlay.baseUrl,
          apiKey: editModelOverlay.apiKey,
        }),
      });
      const chData = await chRes.json();
      if (!chData.ok) throw new Error(chData.error ?? t("aiPanel.channelUpdateFailed"));

      const mRes = await fetch("/api/v1/settings/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updateModelId: editModelOverlay.modelDbId,
          name: editModelOverlay.modelName,
          vision: editModelOverlay.vision,
          apiMode: editModelOverlay.channelType === "ollama" ? "chat" : editModelOverlay.apiMode,
        }),
      });
      const mData = await mRes.json();
      if (!mData.ok) throw new Error(mData.error ?? t("aiPanel.modelUpdateFailed"));

      setEditModelOverlay(null);
      setSettingsError("");
      await loadChannelsFromDB();
      reloadModels(true);
    } catch (e: any) {
      setSettingsError(e.message);
    } finally { setSettingsLoading(false); }
  }

  async function loadChannelsFromDB(): Promise<ChannelData[] | null> {
    try {
      const res = await fetch("/api/v1/settings/ai-config");
      const data = await res.json() as { ok?: boolean; channels?: ChannelData[]; activeModelId?: string | null };
      if (!data.ok) return null;
      const nextChannels = data.channels ?? [];
      setChannels(nextChannels);
      setActiveModelId(data.activeModelId ?? null);
      return nextChannels;
    } catch { /* ignore */ }
    return null;
  }

  async function fetchRemoteModels(baseUrl: string, apiKey: string, channelType: string) {
    const modelsUrl = getModelsUrl(channelType);
    const res = await fetch("/api/v1/ai/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKey, modelsUrl }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? t("settings.ai.client.fetchModelsFailed"));
    return data.modelInfos ?? data.models ?? [];
  }

  async function fetchModelsForAdd() {
    if (!addChannelForm.baseUrl.trim()) return;
    if (addChannelForm.channelType !== "ollama" && !addChannelForm.apiKey.trim()) return;
    setFetchingModels(true);
    setSettingsError("");
    setRemoteModels([]); // Clear the old list to show the loading state.
    try {
      const modelsUrl = getModelsUrl(addChannelForm.channelType);
      const res = await fetch("/api/v1/ai/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: addChannelForm.baseUrl.trim(), apiKey: addChannelForm.apiKey.trim(), modelsUrl }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? t("settings.ai.client.fetchModelsFailed"));
      const list: typeof remoteModels = data.modelInfos ?? data.models ?? [];
      setRemoteModels(list);
      setModelFetched(true);
      if (list.length > 0) setSelectedRemoteModel(list[0].id);
      else { setSelectedRemoteModel(""); }
    } catch (e: any) {
      setSettingsError(e.message);
      setModelFetched(true);
    } finally { setFetchingModels(false); }
  }

  /* ---- Auto-fetch models when URL/Key changes ---- */
  const prevFormRef = useRef(addChannelForm);
  useEffect(() => {
    const prev = prevFormRef.current;
    prevFormRef.current = addChannelForm;
    if (addChannelForm.baseUrl.trim() &&
        (addChannelForm.channelType === "ollama" || addChannelForm.apiKey.trim()) &&
        (prev.baseUrl !== addChannelForm.baseUrl || prev.apiKey !== addChannelForm.apiKey)) {
      fetchModelsForAdd();
    }
  }, [addChannelForm.baseUrl, addChannelForm.apiKey, addChannelForm.channelType]);

  async function handleAddChannelAndModel() {
    if (!selectedRemoteModel || !addChannelForm.baseUrl.trim()) return;
    setSettingsLoading(true);
    setSettingsError("");
    try {
      const res = await fetch("/api/v1/settings/ai-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: addChannelForm.name, channelType: addChannelForm.channelType, baseUrl: addChannelForm.baseUrl, apiKey: addChannelForm.apiKey }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? t("aiPanel.addFailed"));
      const chId = data.channel.id;
      const info = remoteModels.find(m => m.id === selectedRemoteModel);
      const mRes = await fetch("/api/v1/settings/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedRemoteModel,
          name: addChannelForm.name || selectedRemoteModel,
          channelId: chId,
          vision: info?.supportsVision ?? false,
          apiMode: addChannelForm.channelType === "ollama" ? "chat" : addChannelForm.apiMode,
        }),
      });
      const mData = await mRes.json();
      if (!mData.ok) throw new Error(mData.error ?? t("aiPanel.addModelFailed"));
      setAddChannelForm({ name: "", channelType: "deepseek", baseUrl: "", apiKey: "", apiMode: "chat" });
      setRemoteModels([]);
      setSelectedRemoteModel("");
      setModelFetched(false);
      await loadChannelsFromDB();
      reloadModels(true);
    } catch (e: any) {
      setSettingsError(e.message);
    } finally { setSettingsLoading(false); }
  }

  async function handleDeleteModel(modelId: string) {
    setSettingsLoading(true);
    try {
      await fetch("/api/v1/settings/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteModelId: modelId }),
      });
      await loadChannelsFromDB();
      reloadModels(true);
    } catch { /* ignore */ }
    finally { setSettingsLoading(false); }
  }

  async function handleDeleteChannel(channelId: string) {
    setSettingsLoading(true);
    try {
      await fetch(`/api/v1/settings/ai-config?id=${channelId}`, { method: "DELETE" });
      await loadChannelsFromDB();
      reloadModels(true);
    } catch { /* ignore */ }
    finally { setSettingsLoading(false); }
  }

  async function handleSetActiveModel(modelId: string) {
    try {
      await fetch("/api/v1/settings/ai-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeModelId: modelId }),
      });
      await loadChannelsFromDB();
      reloadModels(true);
    } catch { /* ignore */ }
  }

  /* ---- Collapsed View ---- */

  if (!enabled) return null;

  if (collapsed) {
    return (
      <aside className="w-12 bg-background border-l border-foreground/5 flex flex-col items-center py-4 shrink-0 transition-all duration-300">
        <button
          onClick={() => setCollapsedPersist(false)}
          className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-white hover:text-slate-900"
          title={t("aiPanel.expandTitle")}
        >
          <PanelRightOpen size={18} />
        </button>
        <div className="mt-8 flex flex-col gap-4 items-center text-foreground/20">
          <Sparkles size={18} />
          <div className="text-[10px] font-bold tracking-widest" style={{ writingMode: "vertical-rl" }}>{t("aiPanel.title")}</div>
        </div>
      </aside>
    );
  }

  /* ---- Main Panel (Roo Code style) ---- */

  const activeModelDisplay = activeModel || t("aiPanel.selectModel");
  const deletePreviewDialog = confirmDialog?.kind === "delete" ? confirmDialog : null;

  function renderDeletePreviewModal() {
    if (!deletePreviewDialog || typeof document === "undefined") return null;
    const filteredTargets = getFilteredConfirmTargets(deletePreviewDialog);
    const filteredIds = filteredTargets.map((target) => targetIdOf(target)).filter(Boolean);
    const selectedIds = deletePreviewDialog.selectedTargetIds ?? new Set<string>();
    const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
    const accountOptions = deletePreviewAccountOptions(deletePreviewDialog);

    return createPortal(
      <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-slate-950/40 px-4 py-6 backdrop-blur-[2px]">
        <div className="flex h-[min(82vh,760px)] w-[min(1120px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-200 bg-slate-50/80 px-5 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-slate-900">{t("aiPanel.deletePreview")}</h2>
                <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-600">{t("aiPanel.notEditable")}</span>
              </div>
              <div className="mt-1 text-xs text-slate-500">
                {t("aiPanel.deleteModeHint")}
              </div>
            </div>
            <button
              onClick={() => setConfirmDialog(null)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              title={t("table.close")}
            >
              <X size={18} />
            </button>
          </div>

          <div className="shrink-0 border-b border-slate-200 bg-white px-5 py-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <button
                onClick={toggleConfirmAllTargets}
                className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                <span className={`flex h-4 w-4 items-center justify-center rounded border-2 ${
                  allFilteredSelected ? "border-emerald-500 bg-emerald-500 text-white" : "border-slate-300"
                }`}>
                  {allFilteredSelected && <span className="text-[10px]">✓</span>}
                </span>
                {allFilteredSelected ? t("aiPanel.unselectFiltered") : t("aiPanel.selectFiltered")}
              </button>
              <div className="text-xs text-slate-500">
                {t("aiPanel.filteredLabel")} <span className="font-semibold text-slate-800">{filteredTargets.length}</span> / {deletePreviewDialog.targets?.length ?? 0}
                <span className="mx-2 text-slate-300">|</span>
                {t("aiPanel.selectedLabel")} <span className="font-semibold text-slate-800">{selectedIds.size}</span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-slate-500">{t("aiPanel.filterHint")}</div>
              <button
                type="button"
                onClick={() => {
                  setDeletePreviewColumnFilters({});
                  setActiveDeletePreviewFilterColumn(null);
                }}
                className="h-8 rounded-md border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-500 hover:bg-slate-50 hover:text-slate-800"
              >
                {t("table.clearFilters")}
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto bg-white">
            <table className="min-w-full border-separate border-spacing-0 text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-xs font-semibold text-slate-500">
                <tr>
                  <th className="w-10 border-b border-slate-200 px-3 py-2 text-left">{renderDeletePreviewColumnFilter("selection", t("aiPanel.col.selection"))}</th>
                  <th className="border-b border-slate-200 px-3 py-2 text-left">{renderDeletePreviewColumnFilter("date", t("detail.column.date"))}</th>
                  <th className="border-b border-slate-200 px-3 py-2 text-left">{renderDeletePreviewColumnFilter("type", t("batchImport.field.type"))}</th>
                  <th className="border-b border-slate-200 px-3 py-2 text-left">{renderDeletePreviewColumnFilter("account", t("common.account"))}</th>
                  <th className="border-b border-slate-200 px-3 py-2 text-right">{renderDeletePreviewColumnFilter("amount", t("stats.amount"))}</th>
                  <th className="border-b border-slate-200 px-3 py-2 text-left">{renderDeletePreviewColumnFilter("remark", t("detail.column.remark"))}</th>
                </tr>
              </thead>
              <tbody>
                {filteredTargets.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-sm text-slate-400">{t("aiPanel.noRecordsUnderFilter")}</td>
                  </tr>
                ) : filteredTargets.map((target, index) => {
                  const id = targetIdOf(target);
                  const selected = !!id && selectedIds.has(id);
                  return (
                    <tr key={id || index} className={selected ? "bg-white hover:bg-emerald-50/30" : "bg-slate-50/50 text-slate-400 hover:bg-slate-100/60"}>
                      <td className="border-b border-slate-100 px-3 py-2">
                        <button
                          onClick={() => toggleConfirmTarget(id)}
                          disabled={!id}
                          className={`flex h-4 w-4 items-center justify-center rounded border-2 disabled:opacity-30 ${
                            selected ? "border-emerald-500 bg-emerald-500 text-white" : "border-slate-300 bg-white"
                          }`}
                        >
                          {selected && <span className="text-[10px]">✓</span>}
                        </button>
                      </td>
                      <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2 font-mono text-xs text-slate-600">{target.date}</td>
                      <td className="whitespace-nowrap border-b border-slate-100 px-3 py-2 text-slate-600">{targetTypeLabel(target.type)}</td>
                      <td className="max-w-[260px] truncate border-b border-slate-100 px-3 py-2 text-slate-800" title={target.accountName}>{target.accountName}</td>
                      <td className={`whitespace-nowrap border-b border-slate-100 px-3 py-2 text-right font-semibold ${target.amount < 0 ? "text-red-500" : "text-emerald-600"}`}>
                        {target.amount < 0 ? "-" : "+"}¥{formatMoney(Math.abs(target.amount || 0))}
                      </td>
                      <td className="max-w-[360px] truncate border-b border-slate-100 px-3 py-2 text-slate-600" title={target.remark}>{target.remark || t("detailView.noNote")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-4">
            <button
              onClick={() => setConfirmDialog(null)}
              className="h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-600 hover:bg-slate-100"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={onConfirmBatchAction}
              disabled={loading || selectedIds.size === 0}
              className="h-10 rounded-lg bg-slate-900 px-5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:opacity-30"
            >
              {loading ? t("aiPanel.deleting") : t("aiPanel.confirmDeleteCount", { count: selectedIds.size })}
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <>
    {renderDeletePreviewModal()}
    <aside className="w-80 ai-panel-glass shrink-0 flex flex-col h-screen overflow-hidden transition-all duration-300 relative border-l border-foreground/5">

      {/* Header: title + model selector + action buttons */}
      <div className="shrink-0 border-b border-slate-200/70 bg-white/70 px-3 py-3 backdrop-blur">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h5 className="truncate text-sm font-semibold text-slate-900">{t("aiPanel.title")}</h5>
              <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">AI</span>
            </div>
            <p className="mt-0.5 text-[10px] font-medium text-slate-400">{t("aiPanel.subtitle")}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              onClick={() => { setMessages([{ role: "assistant", text: t("aiPanel.welcome") }]); }}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
              title={t("aiPanel.newChat")}
            >
              <Plus size={16} />
            </button>
            <button
              onClick={() => { setSettingsView(true); loadChannelsFromDB(); }}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
              title={t("aiPanel.apiConfig")}
            >
              <Settings size={16} />
            </button>
            <button
              onClick={() => setCollapsedPersist(true)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
              title={t("aiPanel.collapseTitle")}
            >
              <PanelRightClose size={18} />
            </button>
          </div>
        </div>

        {/* Model selector dropdown */}
        <div className="relative">
          {modelNames.length > 0 ? (
            <button
              onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-600 shadow-sm transition-colors hover:bg-slate-50"
            >
              <span className="font-bold truncate">{activeModelDisplay}</span>
              <ChevronDown size={14} className="shrink-0 text-slate-400" />
            </button>
          ) : (
            <button
              onClick={() => { setSettingsView(true); loadChannelsFromDB(); }}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-500 shadow-sm transition-colors hover:bg-slate-50"
            >
              <span>{modelsLoading ? t("aiPanel.loadingModels") : t("aiPanel.noModelConfigured")}</span>
              <Settings size={12} className="shrink-0" />
            </button>
          )}

          {/* Model dropdown popup */}
          {modelDropdownOpen && modelNames.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 z-50 bg-surface-white border border-foreground/10 rounded-xl shadow-lg overflow-hidden">
              <div className="max-h-[220px] overflow-y-auto py-1">
                {modelNames.map((name) => {
                  const isActive = name === activeModel;
                  return (
                    <div key={name} className={`flex items-center justify-between gap-2 px-3 py-2 transition-all hover:bg-accent-green/10 ${
                      isActive ? "bg-accent-green/5" : ""
                    }`}>
                      <button
                        onClick={() => {
                          setActiveModel(name);
                          try { localStorage.setItem("mmh_ai_active_model", name); } catch { /* ignore */ }
                          setModelDropdownOpen(false);
                        }}
                        className={`text-[11px] truncate min-w-0 flex-1 text-left ${isActive ? "font-bold text-accent-green" : "text-foreground/70"}`}
                      >
                        {isActive ? name + " ✓" : name}
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => { void openEditModelOverlay(name); }}
                          className="w-5 h-5 rounded flex items-center justify-center text-foreground/20 hover:text-foreground/50 hover:bg-foreground/10 transition-all"
                          title={t("settings.ai.client.action.edit")}
                        >
                          <Pencil size={10} />
                        </button>
                        <button
                          onClick={() => { const id = modelIdsByName[name]; if (id) { handleDeleteModel(id); setModelDropdownOpen(false); } }}
                          className="w-5 h-5 rounded flex items-center justify-center text-foreground/20 hover:text-red-500 hover:bg-red-50 transition-all"
                          title={t("settings.ai.client.action.delete")}
                        >
                          <X size={10} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="border-t border-foreground/5">
                <button
                  onClick={() => { setModelDropdownOpen(false); setSettingsView(true); loadChannelsFromDB(); }}
                  className="w-full px-3 py-2.5 text-[11px] text-left text-foreground/40 hover:bg-foreground/5 transition-all flex items-center gap-1.5"
                >
                  <Settings size={10} /> {t("aiPanel.manageModels")}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Edit model overlay */}
      {editModelOverlay && (
        <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur-md flex flex-col animate-in fade-in duration-300">
          <div className="flex items-center justify-between px-5 py-4 border-b border-foreground/5 shrink-0">
            <h6 className="font-heading text-base text-foreground">{t("settings.ai.client.action.edit")}</h6>
            <button onClick={() => { setEditModelOverlay(null); setSettingsError(""); }} className="text-foreground/20 hover:text-foreground transition-colors">
              <X size={18} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4 custom-scrollbar">
            <div className="space-y-3">
              {/* Channel info */}
              <div className="rounded-xl border border-foreground/10 bg-surface-white p-4 shadow-sm">
                <div className="text-[10px] font-bold text-foreground/30 mb-3 tracking-wider">{t("aiPanel.channelConfig")}</div>
                <div className="space-y-3">
                  <div>
                    <label className="block text-[10px] font-bold text-foreground/30 mb-1">{t("settings.ai.client.channelName")}</label>
                    <input
                      className="w-full h-10 rounded-xl bg-background/50 border border-foreground/10 px-4 text-sm outline-none focus:border-accent-green/30 text-foreground"
                      value={editModelOverlay.channelName}
                      onChange={(e) => setEditModelOverlay(o => o ? { ...o, channelName: e.target.value } : null)}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-foreground/30 mb-1">{t("aiPanel.channelType")}</label>
                    <select
                      className="w-full h-10 rounded-xl bg-background/50 border border-foreground/10 px-4 text-sm outline-none focus:border-accent-green/30 text-foreground"
                      value={editModelOverlay.channelType}
                      onChange={(e) => setEditModelOverlay(o => o ? { ...o, channelType: e.target.value, apiMode: e.target.value === "ollama" ? "chat" : o.apiMode } : null)}
                    >
                      {CHANNEL_TYPES.map(ct => <option key={ct.id} value={ct.id}>{t(`settings.ai.client.channelType.${ct.id}`)}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-foreground/30 mb-1">Base URL</label>
                    <input
                      className="w-full h-10 rounded-xl bg-background/50 border border-foreground/10 px-4 text-sm outline-none focus:border-accent-green/30 text-foreground"
                      value={editModelOverlay.baseUrl}
                      onChange={(e) => setEditModelOverlay(o => o ? { ...o, baseUrl: e.target.value } : null)}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-foreground/30 mb-1">API Key</label>
                    <input
                      type="password"
                      className="w-full h-10 rounded-xl bg-background/50 border border-foreground/10 px-4 text-sm outline-none focus:border-accent-green/30 text-foreground"
                      value={editModelOverlay.apiKey}
                      onChange={(e) => setEditModelOverlay(o => o ? { ...o, apiKey: e.target.value } : null)}
                    />
                  </div>
                </div>
              </div>

              {/* Model info */}
              <div className="rounded-xl border border-foreground/10 bg-surface-white p-4 shadow-sm">
                <div className="text-[10px] font-bold text-foreground/30 mb-3 tracking-wider">{t("aiPanel.modelConfig")}</div>
                <div className="space-y-3">
                  <div>
                    <label className="block text-[10px] font-bold text-foreground/30 mb-1">{t("aiPanel.displayName")}</label>
                    <input
                      className="w-full h-10 rounded-xl bg-background/50 border border-foreground/10 px-4 text-sm outline-none focus:border-accent-green/30 text-foreground"
                      value={editModelOverlay.modelName}
                      onChange={(e) => setEditModelOverlay(o => o ? { ...o, modelName: e.target.value } : null)}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-foreground/30 mb-1">{t("aiPanel.modelId")}</label>
                    <div className="h-10 rounded-xl bg-foreground/5 border border-foreground/5 px-4 text-sm text-foreground/50 flex items-center">
                      {editModelOverlay.modelId}
                    </div>
                  </div>
                  {editModelOverlay.channelType !== "ollama" && (
                    <div>
                      <label className="block text-[10px] font-bold text-foreground/30 mb-1">{t("settings.ai.client.apiMode")}</label>
                      <select
                        className="w-full h-10 rounded-xl bg-background/50 border border-foreground/10 px-4 text-sm outline-none focus:border-accent-green/30 text-foreground"
                        value={editModelOverlay.apiMode}
                        onChange={(e) => setEditModelOverlay(o => o ? { ...o, apiMode: e.target.value as AiApiMode } : null)}
                      >
                        {AI_API_MODES.map((mode) => (
                          <option key={mode.id} value={mode.id}>{t(mode.labelKey)}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3 py-2">
                    <span className="text-sm text-foreground/60">{t("aiPanel.visionSupport")}</span>
                    <button
                      onClick={() => setEditModelOverlay(o => o ? { ...o, vision: !o.vision } : null)}
                      className={`w-8 h-5 rounded-full transition-all ${editModelOverlay.vision ? "bg-accent-green" : "bg-foreground/10"}`}
                    >
                      <div className={`w-4 h-4 rounded-full bg-white shadow transition-all ${editModelOverlay.vision ? "ml-4" : "ml-0"}`} />
                    </button>
                  </div>
                </div>
              </div>

              {settingsError && <div className="text-[11px] text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{settingsError}</div>}
            </div>
          </div>
          <div className="px-5 py-4 border-t border-foreground/5 shrink-0 flex gap-3">
            <button onClick={() => { setEditModelOverlay(null); setSettingsError(""); }} className="flex-1 py-3 bg-background border border-foreground/10 text-foreground rounded-xl font-bold text-sm hover:bg-foreground/5 transition-colors">
              {t("table.close")}
            </button>
            <button onClick={saveEditModelOverlay} disabled={settingsLoading} className="flex-[2] py-3 bg-foreground text-background rounded-xl font-bold text-sm shadow-lg disabled:opacity-30 active:scale-95 transition-transform">
              {settingsLoading ? t("aiPanel.saving") : t("common.save")}
            </button>
          </div>
        </div>
      )}

      {/* API settings overlay dialog */}
      {settingsView && (
        <div className="absolute inset-0 z-50 bg-background/95 backdrop-blur-md flex flex-col animate-in fade-in duration-300">
          {/* Dialog header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-foreground/5 shrink-0">
            <h6 className="font-heading text-base text-foreground">{t("aiPanel.apiConfig")}</h6>
            <button onClick={() => { setSettingsView(false); }} className="text-foreground/20 hover:text-foreground transition-colors">
              <X size={18} />
            </button>
          </div>

          {/* Dialog content */}
          <div className="flex-1 overflow-y-auto px-5 py-4 custom-scrollbar">

            {/* Channel & model list */}
            {channels.length > 0 && (
              <div className="space-y-4 mb-4">
                {channels.map((ch) => (
                  <div key={ch.id} className="rounded-xl border border-foreground/5 bg-surface-white p-4 shadow-sm">
                    {/* Channel header */}
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <div className="min-w-0">
                        <div className="text-sm font-bold text-foreground">{ch.name}</div>
                        <div className="mt-0.5 text-[10px] text-foreground/30 truncate">{ch.baseUrl}</div>
                      </div>
                      <button onClick={() => handleDeleteChannel(ch.id)} className="w-7 h-7 rounded-lg flex items-center justify-center text-foreground/20 hover:text-red-500 hover:bg-red-50 transition-all" title={t("aiPanel.deleteChannel")}>
                        <Trash2 size={14} />
                      </button>
                    </div>

                    {/* Model list */}
                    {ch.AiModel.length > 0 ? (
                      <div className="space-y-2">
                        {ch.AiModel.map((m) => (
                          <div key={m.id} className="flex items-center justify-between gap-3 py-2 px-3 rounded-lg border border-foreground/5 bg-background/30 hover:bg-foreground/5 transition-all">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="text-sm font-medium text-foreground truncate">{m.name || m.model}</span>
                              {m.vision && <Eye size={12} className="text-accent-green shrink-0" />}
                              {m.active && <span className="text-[10px] bg-accent-green/10 text-accent-green px-2 py-0.5 rounded-full shrink-0 font-bold">{t("aiPanel.active")}</span>}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {!m.active && (
                                <button onClick={() => handleSetActiveModel(m.id)} className="text-[10px] text-foreground/30 hover:text-accent-green font-bold transition-colors px-2 py-1 rounded-lg hover:bg-accent-green/10">
                                  {t("aiPanel.setActive")}
                                </button>
                              )}
                              <button onClick={() => handleDeleteModel(m.id)} className="w-6 h-6 rounded-lg flex items-center justify-center text-foreground/20 hover:text-red-500 hover:bg-red-50 transition-all">
                                <X size={12} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[11px] text-foreground/30 py-3 text-center">{t("aiPanel.noModels")}</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Add channel - single-step form */}
            <div className="rounded-xl border border-foreground/10 bg-surface-white p-4 shadow-sm space-y-3">
              <div className="text-sm font-bold text-foreground">{t("aiPanel.addChannel")}</div>

              {/* Basic configuration */}
              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold text-foreground/30 mb-1">{t("aiPanel.channelNameOptional")}</label>
                  <input
                    className="w-full h-9 rounded-xl bg-background/50 border border-foreground/10 px-3 text-sm outline-none focus:border-accent-green/30 text-foreground"
                    placeholder={t("aiPanel.channelNamePlaceholder")}
                    value={addChannelForm.name}
                    onChange={(e) => setAddChannelForm(f => ({ ...f, name: e.target.value }))}
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold text-foreground/30 mb-1">{t("aiPanel.channelType")}</label>
                  <select
                    className="w-full h-9 rounded-xl bg-background/50 border border-foreground/10 px-3 text-sm outline-none focus:border-accent-green/30 text-foreground"
                    value={addChannelForm.channelType}
                    onChange={(e) => {
                      const ct = e.target.value;
                      const preset = ct === "ollama" ? "http://localhost:11434" : ct === "deepseek" ? "https://api.deepseek.com/v1" : ct === "openai" ? "https://api.openai.com/v1" : ct === "anthropic" ? "https://api.anthropic.com" : ct === "qwen" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : "";
                      setAddChannelForm(f => ({ ...f, channelType: ct, baseUrl: preset || f.baseUrl, apiMode: ct === "ollama" ? "chat" : f.apiMode }));
                      setModelFetched(false);
                      setRemoteModels([]);
                    }}
                  >
                    {CHANNEL_TYPES.map(ct => <option key={ct.id} value={ct.id}>{t(`settings.ai.client.channelType.${ct.id}`)}</option>)}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold text-foreground/30 mb-1">Base URL</label>
                  <input
                    className="w-full h-9 rounded-xl bg-background/50 border border-foreground/10 px-3 text-sm outline-none focus:border-accent-green/30 text-foreground"
                    placeholder="https://api.deepseek.com/v1"
                    value={addChannelForm.baseUrl}
                    onChange={(e) => { setAddChannelForm(f => ({ ...f, baseUrl: e.target.value })); setModelFetched(false); setRemoteModels([]); }}
                  />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] font-bold text-foreground/30 mb-1">API Key {addChannelForm.channelType === "ollama" ? t("aiPanel.optionalSuffix") : ""}</label>
                  <input
                    type="password"
                    className="w-full h-9 rounded-xl bg-background/50 border border-foreground/10 px-3 text-sm outline-none focus:border-accent-green/30 text-foreground"
                    placeholder={addChannelForm.channelType === "ollama" ? t("aiPanel.localNoKey") : "sk-..."}
                    value={addChannelForm.apiKey}
                    onChange={(e) => { setAddChannelForm(f => ({ ...f, apiKey: e.target.value })); setModelFetched(false); setRemoteModels([]); }}
                  />
                </div>
              </div>

              {/* Error hint */}
              {/* Model selection area - always visible once the Key is filled */}
              {(addChannelForm.channelType === "ollama" || addChannelForm.apiKey.trim()) && addChannelForm.baseUrl.trim() ? (
                <div className="space-y-2">
                  {addChannelForm.channelType !== "ollama" && (
                    <div>
                      <label className="block text-[10px] font-bold text-foreground/30 mb-1">{t("settings.ai.client.apiMode")}</label>
                      <select
                        className="w-full h-9 rounded-xl bg-background/50 border border-foreground/10 px-3 text-sm outline-none focus:border-accent-green/30 text-foreground"
                        value={addChannelForm.apiMode}
                        onChange={(e) => setAddChannelForm(f => ({ ...f, apiMode: e.target.value as AiApiMode }))}
                      >
                        {AI_API_MODES.map((mode) => (
                          <option key={mode.id} value={mode.id}>{t(mode.labelKey)}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <label className="block text-[10px] font-bold text-foreground/30">{t("aiPanel.selectModel")}</label>
                    {fetchingModels && <span className="text-[10px] text-accent-green animate-pulse">{t("aiPanel.fetching")}</span>}
                    {remoteModels.length > 0 && !fetchingModels && <span className="text-[10px] text-foreground/30">{t("aiPanel.modelCount", { count: remoteModels.length })}</span>}
                  </div>

                  {fetchingModels ? (
                    <div className="flex items-center gap-2 py-4 text-[11px] text-foreground/30 justify-center">
                      <Wand2 size={12} className="animate-spin text-accent-green" /> {t("aiPanel.fetchingModelList")}
                    </div>
                  ) : remoteModels.length > 0 ? (
                    <div className="max-h-[140px] overflow-y-auto rounded-xl border border-foreground/5">
                      {remoteModels.map((m) => (
                        <button
                          key={m.id}
                          onClick={() => setSelectedRemoteModel(m.id)}
                          className={`w-full px-3 py-2 text-sm text-left flex items-center justify-between transition-all ${
                            m.id === selectedRemoteModel ? "bg-accent-green/10 text-accent-green font-bold" : "text-foreground/60 hover:bg-foreground/5"
                          }`}
                        >
                          <span className="truncate">{m.id}</span>
                          <div className="flex items-center gap-1 shrink-0 ml-2">
                            {m.supportsVision && <span className="text-[10px] text-accent-green">{t("aiPanel.vision")}</span>}
                            {m.id === selectedRemoteModel && <span className="text-accent-green text-xs">✓</span>}
                          </div>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {settingsError && (
                        <div className="text-[11px] text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{settingsError}</div>
                      )}
                      <button
                        onClick={fetchModelsForAdd}
                        className="w-full py-2 rounded-xl border border-dashed border-foreground/10 text-[11px] font-bold text-foreground/40 hover:text-foreground hover:border-foreground/20 transition-all"
                      >
                        {settingsError ? t("aiPanel.retryFetch") : t("aiPanel.clickFetch")}
                      </button>
                      <div>
                        <label className="block text-[10px] font-bold text-foreground/30 mb-1">{t("aiPanel.manualModelId")}</label>
                        <input
                          className="w-full h-9 rounded-xl bg-background/50 border border-foreground/10 px-3 text-sm outline-none focus:border-accent-green/30 text-foreground"
                          placeholder={t("aiPanel.modelIdPlaceholder")}
                          value={selectedRemoteModel}
                          onChange={(e) => setSelectedRemoteModel(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-foreground/30 py-2 text-center">
                  {addChannelForm.baseUrl.trim() ? t("aiPanel.fillApiKeyFirst") : t("aiPanel.fillUrlAndKey")}
                </div>
              )}

              {settingsError && <div className="text-[11px] text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2">{settingsError}</div>}

              {/* Bottom buttons */}
              <div className="flex gap-2 pt-1">
                <button onClick={() => { setSettingsView(false); setAddChannelForm({ name: "", channelType: "deepseek", baseUrl: "", apiKey: "", apiMode: "chat" }); setRemoteModels([]); setSelectedRemoteModel(""); setModelFetched(false); setSettingsError(""); }} className="flex-1 py-2.5 bg-background border border-foreground/10 text-foreground/60 rounded-xl font-bold text-xs hover:bg-foreground/5 transition-colors">
                  {t("common.cancel")}
                </button>
                <button
                  onClick={remoteModels.length > 0 ? handleAddChannelAndModel : fetchModelsForAdd}
                  disabled={settingsLoading || fetchingModels || !addChannelForm.baseUrl.trim() || (addChannelForm.channelType !== "ollama" && !addChannelForm.apiKey.trim()) || (remoteModels.length > 0 && !selectedRemoteModel)}
                  className="flex-[2] py-2.5 bg-foreground text-background rounded-xl font-bold text-xs shadow-lg disabled:opacity-30 active:scale-95 transition-transform"
                >
                  {settingsLoading ? t("aiPanel.adding") : remoteModels.length > 0 ? t("aiPanel.addModel", { name: selectedRemoteModel || "" }) : t("settings.ai.client.fetchModels")}
                </button>
              </div>
            </div>
          </div>

          {/* The bottom add button is merged into the form above; no separate button here */}
        </div>
      )}

      {!settingsView && (
      <>
      {/* Chat area - main body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 custom-scrollbar space-y-3">
        {messages.map((m, idx) => (
          <div key={idx} className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"} gap-1`}>
            {m.role === "assistant" && m.trace && (
              <div className="text-[9px] font-mono text-foreground/30 bg-foreground/5 p-2 rounded-lg w-full border border-foreground/5">
                {m.trace.slice(0, 3).map((t, i) => <div key={i} className="truncate">› {t}</div>)}
              </div>
            )}
            <div className={`px-3 py-2 rounded-2xl text-sm shadow-sm transition-all whitespace-pre-line ${
              m.role === "user"
                ? "bg-foreground text-background rounded-tr-none max-w-[85%]"
                : "bg-surface-white text-foreground rounded-tl-none border border-foreground/5 max-w-[90%]"
            }`}>
              {m.text}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex items-center gap-2 text-[11px] text-foreground/30 px-2">
            <Wand2 size={12} className="animate-spin text-accent-green" /> {t("aiPanel.parsing")}
          </div>
        )}
        {importConfirmDialog && (
          <div className="rounded-2xl border border-foreground/10 bg-surface-white p-3 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[11px] font-bold text-foreground/60">{t("aiPanel.recognitionResult")}</div>
              <button onClick={toggleImportAll} className="text-[11px] font-bold text-accent-green">
                {importConfirmDialog.selectAll ? t("accountsQuickAdd.clearSelection") : t("table.selectAllValues")}
              </button>
            </div>
            <div className="space-y-2">
              {importConfirmDialog.items.map((it) => {
                const selected = importConfirmDialog.selectedKeys.has(it.key);
                return (
                  <label key={it.key} className={`block rounded-xl border p-3 text-xs ${
                    selected ? "border-accent-green/30 bg-accent-green/5" : "border-foreground/10 bg-background/40"
                  }`}>
                    <div className="flex items-start gap-2">
                      <input type="checkbox" checked={selected} onChange={() => toggleImportItem(it.key)} className="mt-1" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <div>{t("aiPanel.block.date", { value: it.item.date ?? t("aiPanel.noDate") })}</div>
                        <div>{t("aiPanel.block.postedAt", { value: it.item.postedAt ?? it.item.date ?? t("aiPanel.noDate") })}</div>
                        <div>{t("aiPanel.block.type", { value: itemTypeLabel(it.item.type, t) })}</div>
                        <div>{t("aiPanel.block.amount", { value: formatMoney(Math.abs(it.item.amount ?? 0)) })}</div>
                        <div className="truncate" title={itemAccountLabel(it.item, t)}>{t("aiPanel.block.account", { value: itemAccountLabel(it.item, t) })}</div>
                        <div className="truncate" title={it.item.institution ?? it.item.counterparty ?? ""}>{t("aiPanel.block.counterparty", { value: it.item.institution ?? it.item.counterparty ?? "-" })}</div>
                        <div className="truncate" title={it.item.category ?? ""}>{t("aiPanel.block.category", { value: it.item.category ?? "-" })}</div>
                        <div className="truncate text-foreground/60" title={it.item.remark ?? it.item.counterparty ?? ""}>
                          {t("aiPanel.block.remark", { value: it.item.remark ?? it.item.counterparty ?? "" })}
                        </div>
                        {!it.ready && it.missingFields.length > 0 && (
                          <div className="text-[10px] text-red-500">{t("aiPanel.missing", { fields: it.missingFields.join("、") })}</div>
                        )}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={() => setImportConfirmDialog(null)} className="flex-1 rounded-xl border border-foreground/10 py-2 text-xs font-bold">
                {t("common.cancel")}
              </button>
              <button
                onClick={onConfirmBatchImport}
                disabled={loading || importConfirmDialog.selectedKeys.size === 0}
                className="flex-[2] rounded-xl bg-foreground py-2 text-xs font-bold text-background disabled:opacity-30"
              >
                {t("aiPanel.confirmImportCount", { count: importConfirmDialog.selectedKeys.size })}
              </button>
            </div>
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Confirm dialog overlay */}
      {confirmDialog && (
        <div className="absolute inset-0 z-40 bg-background/95 backdrop-blur-md p-6 flex flex-col animate-in fade-in duration-300">
          <div className="flex justify-between items-center mb-6">
            <h6 className="font-heading text-lg text-foreground">{confirmDialog?.label ?? t("batchImport.confirmSelectedImport")}</h6>
            <button onClick={() => { setConfirmDialog(null); setImportConfirmDialog(null); }} className="text-foreground/20 hover:text-foreground transition-colors">
              <X size={20} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto space-y-3 mb-6">
            {/* Batch update preview */}
            {confirmDialog?.kind === "update" && (
              <>
                <div className="rounded-xl border border-foreground/10 bg-surface-white p-4 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[10px] font-bold text-foreground/35 tracking-wider">{t("aiPanel.operationType")}</div>
                      <div className="mt-1 text-sm font-bold">{confirmDialog.preview?.operationType ?? t("aiPanel.batchUpdate")} · {confirmDialog.preview?.action ?? t("aiPanel.fieldUpdate")}</div>
                    </div>
                    <div className="rounded-full bg-accent-green/10 px-3 py-1 text-[10px] font-bold text-accent-green">{t("aiPanel.countSuffix", { count: confirmDialog.count })}</div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">
                    {(confirmDialog.preview?.scopeFields ?? []).map((field) => (
                      <div key={field.label} className="rounded-lg bg-background/60 p-2">
                        <div className="text-foreground/35">{field.label}</div>
                        <div className="mt-1 truncate font-bold text-foreground" title={field.value}>{field.value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 rounded-lg bg-foreground/5 p-3 text-[10px]">
                    <div className="text-foreground/40">{t("aiPanel.updateField")}</div>
                    <div className="mt-1 font-bold text-foreground">{confirmDialog.preview?.targetField ?? t("common.account")}</div>
                    <div className="mt-1 text-foreground/60">
                      {confirmDialog.preview?.oldValue ?? t("aiPanel.oldValue")} → <span className="font-bold text-accent-green">{confirmDialog.preview?.newValue ?? t("aiPanel.newValue")}</span>
                    </div>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="text-[10px] font-bold text-foreground/35 tracking-wider">{t("aiPanel.recordsPreview")}</div>
                  {(confirmDialog.targets ?? []).map((target, i) => (
                    <div key={target.transactionId ?? target.id ?? i} className="rounded-lg border border-foreground/5 bg-surface-white p-3 text-[10px] text-foreground">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-foreground/50">{target.date}</span>
                        <span className="font-bold text-accent-green">¥{formatMoney(Math.abs(target.amount || 0))}</span>
                      </div>
                      <div className="mt-1 truncate font-bold" title={target.accountName}>{target.accountName}</div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-foreground/45">
                        <span>{target.type ?? t("aiPanel.recordDefault")}</span>
                        <span className="truncate" title={target.remark}>{target.remark || t("detailView.noNote")}</span>
                      </div>
                    </div>
                  ))}
                  {confirmDialog.count > (confirmDialog.targets?.length ?? 0) && (
                    <div className="rounded-lg border border-dashed border-foreground/10 p-3 text-center text-[10px] text-foreground/40">
                      {t("aiPanel.moreUpdatedLater", { count: confirmDialog.count - (confirmDialog.targets?.length ?? 0) })}
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Delete preview - selectable list */}
            {confirmDialog?.kind === "delete" && confirmDialog.targets && (
              (() => {
                const filteredTargets = getFilteredConfirmTargets(confirmDialog);
                const filteredIds = filteredTargets.map((target) => targetIdOf(target)).filter(Boolean);
                const selectedIds = confirmDialog.selectedTargetIds ?? new Set<string>();
                const allFilteredSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
                const accountOptions = deletePreviewAccountOptions(confirmDialog);
                return (
                  <>
                    <div className="sticky top-0 z-10 space-y-2 rounded-xl border border-foreground/10 bg-background/95 p-3 backdrop-blur">
                      <div className="flex items-center justify-between gap-2">
                        <button onClick={toggleConfirmAllTargets} className="flex items-center gap-2 text-[11px] font-bold text-foreground/60 hover:text-foreground transition-colors">
                          <span className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                            allFilteredSelected ? "bg-accent-green border-accent-green text-background" : "border-foreground/20"
                          }`}>
                            {allFilteredSelected && <span className="text-[9px]">✓</span>}
                          </span>
                          {allFilteredSelected ? t("aiPanel.unselectFiltered") : t("aiPanel.selectFiltered")}
                        </button>
                        <span className="text-[10px] text-foreground/40">
                          {t("aiPanel.filteredCountShort", { current: filteredTargets.length, total: confirmDialog.targets?.length ?? 0 })} · {t("aiPanel.selectedLabelShort", { count: selectedIds.size })}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          value={deletePreviewFilters.text}
                          onChange={(e) => setDeletePreviewFilters({ ...deletePreviewFilters, text: e.target.value })}
                          placeholder={t("aiPanel.searchPlaceholder")}
                          className="col-span-2 h-8 rounded-lg border border-foreground/10 bg-surface-white px-2 text-[11px] outline-none focus:border-accent-green/30"
                        />
                        <select
                          value={deletePreviewFilters.accountName}
                          onChange={(e) => setDeletePreviewFilters({ ...deletePreviewFilters, accountName: e.target.value })}
                          className="h-8 rounded-lg border border-foreground/10 bg-surface-white px-2 text-[11px] outline-none focus:border-accent-green/30"
                        >
                          <option value="">{t("statistics.allAccounts")}</option>
                          {accountOptions.map((name) => <option key={name} value={name}>{name}</option>)}
                        </select>
                        <select
                          value={deletePreviewFilters.type}
                          onChange={(e) => setDeletePreviewFilters({ ...deletePreviewFilters, type: e.target.value as DeletePreviewFilters["type"] })}
                          className="h-8 rounded-lg border border-foreground/10 bg-surface-white px-2 text-[11px] outline-none focus:border-accent-green/30"
                        >
                          <option value="all">{t("aiPanel.allTypes")}</option>
                          <option value="expense">{t("transaction.type.expense")}</option>
                          <option value="income">{t("transaction.type.income")}</option>
                          <option value="transfer">{t("transaction.type.transfer")}</option>
                          <option value="investment">{t("transaction.type.investment")}</option>
                        </select>
                        <select
                          value={deletePreviewFilters.selection}
                          onChange={(e) => setDeletePreviewFilters({ ...deletePreviewFilters, selection: e.target.value as DeletePreviewFilters["selection"] })}
                          className="h-8 rounded-lg border border-foreground/10 bg-surface-white px-2 text-[11px] outline-none focus:border-accent-green/30"
                        >
                          <option value="all">{t("aiPanel.allSelection")}</option>
                          <option value="selected">{t("aiPanel.onlySelected")}</option>
                          <option value="unselected">{t("aiPanel.onlyUnselected")}</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => setDeletePreviewFilters({ text: "", accountName: "", type: "all", selection: "all" })}
                          className="h-8 rounded-lg border border-foreground/10 bg-surface-white px-2 text-[11px] font-bold text-foreground/50 hover:text-foreground"
                        >
                          {t("table.clearFilters")}
                        </button>
                      </div>
                    </div>
                    <div className="rounded-xl border border-red-200/60 bg-red-50/80 p-3 text-[10px] text-red-600">
                      {t("aiPanel.deleteModeHint2")}
                    </div>
                    {filteredTargets.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-foreground/10 p-6 text-center text-[11px] text-foreground/35">
                        {t("aiPanel.noRecordsUnderFilter")}
                      </div>
                    ) : filteredTargets.map((target, i) => {
                      const id = targetIdOf(target);
                      const selected = !!id && selectedIds.has(id);
                      return (
                        <div key={id || i} className={`p-3 rounded-lg border text-[11px] flex items-start gap-3 transition-all ${
                          selected ? "bg-surface-white border-foreground/10 text-foreground" : "bg-background/50 border-foreground/5 text-foreground/40"
                        }`}>
                          <button onClick={() => toggleConfirmTarget(id)} disabled={!id} className={`mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-all disabled:opacity-30 ${
                            selected ? "bg-accent-green border-accent-green text-background" : "border-foreground/20"
                          }`}>
                            {selected && <span className="text-[9px]">✓</span>}
                          </button>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-foreground/60">{target.date}</span>
                              <span className={`font-bold shrink-0 ${target.amount < 0 ? "text-red-500" : "text-accent-green"}`}>
                                {target.amount < 0 ? "-" : "+"}¥{formatMoney(Math.abs(target.amount || 0))}
                              </span>
                            </div>
                            <div className="mt-1 truncate font-bold" title={target.accountName}>{target.accountName}</div>
                            <div className="mt-0.5 flex items-center justify-between gap-2 text-foreground/50">
                              <span>{targetTypeLabel(target.type)}</span>
                              <span className="truncate" title={target.remark}>{target.remark || t("detailView.noNote")}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </>
                );
              })()
            )}

            {/* Restore confirmation */}
            {confirmDialog?.kind === "restore" && confirmDialog.targets && (
              confirmDialog.targets.map((t, i) => (
                <div key={i} className="p-3 bg-surface-white rounded-lg border border-foreground/5 text-[11px] flex justify-between text-foreground">
                  <span>{t.date}</span>
                  <span className="font-bold text-accent-green">¥{formatMoney(Math.abs(t.amount || 0))}</span>
                </div>
              ))
            )}

            {/* Import confirmation - selectable list */}
            {importConfirmDialog && (
              <>
                <div className="flex items-center justify-between mb-2">
                  <button onClick={toggleImportAll} className="flex items-center gap-2 text-[11px] font-bold text-foreground/60 hover:text-foreground transition-colors">
                    <span className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${
                      importConfirmDialog.selectAll ? "bg-accent-green border-accent-green text-background" : "border-foreground/20"
                    }`}>
                      {importConfirmDialog.selectAll && <span className="text-[9px]">✓</span>}
                    </span>
                    {t("table.selectAllValues")}
                  </button>
                  <span className="text-[10px] text-foreground/40">
                    {t("aiPanel.selectedLabelShort", { count: importConfirmDialog.selectedKeys.size })}/{importConfirmDialog.items.length}
                  </span>
                </div>
                {importConfirmDialog.items.map((it) => {
                  const selected = importConfirmDialog.selectedKeys.has(it.key);
                  return (
                    <div key={it.key} className={`p-3 rounded-lg border text-[11px] flex items-start gap-3 transition-all ${
                      selected ? "bg-surface-white border-foreground/10 text-foreground" : "bg-background/50 border-foreground/5 text-foreground/40"
                    }`}>
                      <button onClick={() => toggleImportItem(it.key)} className={`mt-0.5 w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-all ${
                        selected ? "bg-accent-green border-accent-green text-background" : "border-foreground/20"
                      }`}>
                        {selected && <span className="text-[9px]">✓</span>}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="grid grid-cols-[76px_minmax(0,1fr)_44px_72px] items-center gap-2">
                          <span className="font-mono truncate">{it.item.date ?? t("aiPanel.noDate")}</span>
                          <span className="truncate" title={itemAccountLabel(it.item, t)}>{itemAccountLabel(it.item, t)}</span>
                          <span className="text-foreground/55">{itemTypeLabel(it.item.type, t)}</span>
                          <span className="font-bold text-accent-green text-right shrink-0">¥{formatMoney(it.item.amount)}</span>
                        </div>
                        <div className="mt-1 truncate text-foreground/50">{it.item.postedAt ?? it.item.date ?? t("aiPanel.noDate")} · {it.item.institution ?? it.item.counterparty ?? ""} · {it.item.category ?? "-"}</div>
                        {!it.ready && it.missingFields.length > 0 && (
                          <div className="mt-1 text-[9px] text-red-400/80">{t("aiPanel.missing", { fields: it.missingFields.join("、") })}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>

          <div className="flex gap-2">
            <button onClick={() => { setConfirmDialog(null); setImportConfirmDialog(null); }} className="flex-1 py-3 bg-background border border-foreground/10 text-foreground rounded-xl font-bold text-sm transition-colors hover:bg-foreground/5">
              {t("common.cancel")}
            </button>
            <button
              onClick={confirmDialog ? onConfirmBatchAction : onConfirmBatchImport}
              disabled={
                (!!importConfirmDialog && importConfirmDialog.selectedKeys.size === 0) ||
                (confirmDialog?.kind === "delete" && (confirmDialog.selectedTargetIds?.size ?? 0) === 0)
              }
              className="flex-[2] py-3 bg-foreground text-background rounded-xl font-bold text-sm shadow-xl active:scale-95 transition-transform disabled:opacity-30"
            >
              {confirmDialog?.kind === "delete"
                ? t("aiPanel.confirmDeleteCount", { count: confirmDialog.selectedTargetIds?.size ?? 0 })
                : t("batchImport.confirmSelectedImport")}
            </button>
          </div>
        </div>
      )}

      {/* Input area */}
      <div className="shrink-0 px-4 pb-4 pt-3 border-t border-foreground/5">

        {/* Input + send button */}
        <div className="relative">
          <input
            className="w-full pl-3 pr-10 py-2.5 bg-background/50 rounded-xl outline-none text-sm placeholder-foreground/20 border border-transparent focus:border-accent-green/30 focus:bg-surface-white transition-all font-medium text-foreground"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSend()}
            onPaste={onPaste}
            placeholder={t("aiPanel.inputPlaceholder")}
          />
          <button
            onClick={onSend}
            disabled={loading || !input.trim()}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 bg-foreground text-background rounded-lg flex items-center justify-center hover:bg-accent-green transition-all duration-300 disabled:opacity-20"
          >
            <Send size={14} />
          </button>
        </div>

        {/* Bottom action buttons */}
        <div className="flex items-center gap-2 mt-2">
          <label className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[10px] font-bold text-foreground/30 hover:text-foreground/60 hover:bg-foreground/5 transition-all cursor-pointer">
            <ImagePlus size={12} /> {t("aiPanel.image")}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickImage(f); e.target.value = ""; }} />
          </label>
          <button
            type="button"
            onClick={() => router.push("/settings/email")}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[10px] font-bold text-foreground/30 hover:text-foreground/60 hover:bg-foreground/5 transition-all"
            title={t("aiPanel.emailImportTitle")}
          >
            <Mail size={12} /> {t("aiPanel.emailImport")}
          </button>
        </div>
      </div>
      </>
      )}
    </aside>
    </>
  );
}
