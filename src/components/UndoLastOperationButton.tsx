"use client";

import { useEffect, useState } from "react";
import { Undo2 } from "lucide-react";

import { showConfirmDialog } from "@/lib/client/confirm-dialog";
import {
  dispatchFinanceDataChanged,
  FINANCE_DATA_CHANGED_EVENT,
} from "@/lib/client/refresh";
import { formatMoney } from "@/lib/format";
import { useI18n } from "@/lib/i18n";

type TFunction = (key: string, params?: Record<string, string | number>) => string;

type UndoPreviewItem = {
  id: string;
  date: string;
  type: string;
  amount: number | null;
  accountName: string;
  toAccountName: string;
  categoryName: string;
  counterpartyInstitutionName: string;
  fundCode: string;
  fundName: string;
  note: string;
};

type UndoPreview = {
  count: number;
  hiddenCount: number;
  items: UndoPreviewItem[];
};

type UndoState = {
  label: string;
  action?: string;
  canUndo: boolean;
  undoCount?: number;
  historyLimit?: number;
  preview?: UndoPreview | null;
} | null;

function undoLabel(operation: { label: string; action?: string }, t: TFunction) {
  switch (operation.action) {
    case "create":
    case "batch_create":
      return t("undo.action.revertCreate");
    case "delete":
    case "batch_delete":
      return t("undo.action.restoreDeleted");
    case "edit":
    case "batch_edit":
      return t("undo.action.revertEdit");
    default:
      return operation.label;
  }
}

const TRANSACTION_TYPE_LABEL_KEYS: Record<string, string> = {
  expense: "transaction.type.expense",
  income: "transaction.type.income",
  transfer: "transaction.type.transfer",
  investment: "transaction.type.investment",
};

function truncateText(value: string, maxLength = 48) {
  const text = value.trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function transactionTypeLabel(type: string, t: TFunction) {
  const key = TRANSACTION_TYPE_LABEL_KEYS[type];
  return key ? t(key) : type;
}

function formatUndoAmount(amount: number | null) {
  if (amount == null) return "";
  const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
  return `${sign}${formatMoney(Math.abs(amount))}`;
}

function formatUndoPreviewItem(item: UndoPreviewItem, t: TFunction) {
  const main = [
    item.date,
    item.type ? transactionTypeLabel(item.type, t) : "",
    formatUndoAmount(item.amount),
  ].filter(Boolean).join(" | ");
  const account = item.toAccountName
    ? `${item.accountName || t("undo.previewUnknownAccount")} -> ${item.toAccountName}`
    : item.accountName;
  const subject = item.fundName || item.fundCode || item.categoryName || item.counterpartyInstitutionName;
  const note = item.note ? t("undo.previewNote", { note: truncateText(item.note) }) : "";

  return [main, account, subject, note].filter(Boolean).join(" | ");
}

function buildUndoConfirmMessage(operation: NonNullable<UndoState>, t: TFunction) {
  const lines = [t("undo.confirmMessage", { label: undoLabel(operation, t) })];
  const preview = operation.preview;
  if (preview?.items?.length) {
    lines.push("");
    lines.push(t("undo.previewHeader", { count: preview.count }));
    for (const [index, item] of preview.items.entries()) {
      lines.push(t("undo.previewItem", { index: index + 1, detail: formatUndoPreviewItem(item, t) }));
    }
    if (preview.hiddenCount > 0) {
      lines.push(t("undo.previewMore", { count: preview.hiddenCount }));
    }
  }
  return lines.join("\n");
}

export function UndoLastOperationButton({
  compact = false,
  className,
  iconSize = 18,
}: {
  compact?: boolean;
  className?: string;
  iconSize?: number;
}) {
  const [state, setState] = useState<UndoState>(null);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const { t } = useI18n();

  async function loadState() {
    const result = await fetch("/api/v1/undo", { cache: "no-store" })
      .then((response) => response.json())
      .catch((error) => {
        console.warn("[undo] failed to load latest operation", error);
        return null;
      });
    setState(result?.ok && result.data ? result.data : null);
  }

  useEffect(() => {
    void loadState();
    const refresh = () => void loadState();
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
    };
  }, []);

  async function undo() {
    const operation = state;
    if (!operation?.canUndo || loading || confirming) return;

    setConfirming(true);
    setMessage("");
    let confirmed = false;
    try {
      confirmed = await showConfirmDialog({
        title: t("undo.confirmTitle"),
        message: buildUndoConfirmMessage(operation, t),
        confirmLabel: t("undo.confirmButton"),
        cancelLabel: t("common.cancel"),
        tone: "danger",
      });
    } finally {
      setConfirming(false);
    }
    if (!confirmed) return;

    setLoading(true);
    try {
      const response = await fetch("/api/v1/undo", { method: "POST" });
      const result = await response.json().catch(() => ({ ok: false, error: t("undo.undoFailed") }));
      if (!response.ok || !result?.ok) {
        setMessage(result?.error ?? t("undo.undoFailed"));
        return;
      }
      const remainingCount = Number(result.data?.remainingCount ?? 0);
      setMessage(remainingCount > 0
        ? t("undo.doneWithMore", { label: undoLabel({ label: result.data?.label ?? operation.label, action: result.data?.action ?? operation.action }, t), count: remainingCount })
        : t("undo.done", { label: undoLabel({ label: result.data?.label ?? operation.label, action: result.data?.action ?? operation.action }, t) }));
      setState(null);
      dispatchFinanceDataChanged({ reason: "undo-entry-operation", entryIds: undefined });
    } finally {
      setLoading(false);
    }
  }

  const undoCount = Number(state?.undoCount ?? 0);
  const title = state?.canUndo
    ? undoCount > 0
      ? t("undo.titleWithMore", { label: undoLabel(state, t), count: undoCount })
      : t("undo.title", { label: undoLabel(state, t) })
    : t("undo.noOperations");
  if (compact) {
    return (
      <button
        type="button"
        onClick={undo}
        disabled={!state?.canUndo || loading || confirming}
        className={className ?? "flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-white hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-300"}
        title={title}
        aria-label={title}
      >
        <Undo2 size={iconSize} />
      </button>
    );
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={undo}
        disabled={!state?.canUndo || loading || confirming}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-slate-600 transition-colors hover:bg-white hover:text-slate-900 disabled:cursor-not-allowed disabled:text-slate-300"
        title={title}
      >
        <Undo2 size={18} />
        <span className="min-w-0 flex-1 truncate text-left">{loading ? t("undo.undoing") : t("undo.undoLastStep")}</span>
      </button>
      {message ? <div className="truncate px-3 pt-1 text-[10px] text-slate-500" title={message}>{message}</div> : null}
    </div>
  );
}
