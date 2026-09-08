"use client";

import { Paperclip, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/lib/i18n";

export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export type EntryAttachmentItem = {
  id: string;
  name: string;
  mimeType?: string | null;
  url?: string | null;
};

type ApiListResponse = { ok?: boolean; data?: EntryAttachmentItem[]; error?: string };
type ApiUploadResponse = { ok?: boolean; data?: EntryAttachmentItem[]; error?: string };

export async function uploadEntryAttachmentFiles(entryId: string, files: File[]) {
  if (files.length === 0) return [];
  const form = new FormData();
  form.set("entryId", entryId);
  files.forEach((file) => form.append("files", file));
  const response = await fetch("/api/v1/attachments", { method: "POST", body: form });
  const result = await response.json().catch(() => null) as ApiUploadResponse | null;
  if (!response.ok || !result?.ok) throw new Error(result?.error || response.statusText || "Attachment upload failed.");
  return result.data ?? [];
}

function fileSizeLabel(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${size} B`;
}

/**
 * Reusable in-page attachment window. Shows the attachment list for one entry,
 * with per-file download links, delete, an add button, and a close button.
 * The main window stays untouched; this modal renders on top of the current page.
 */
export function EntryAttachmentWindow({
  open,
  entryId,
  onClose,
  pendingFiles,
  onPendingFilesChange,
}: {
  open: boolean;
  entryId?: string | null;
  onClose: () => void;
  pendingFiles?: File[];
  onPendingFilesChange?: (files: File[]) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<EntryAttachmentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const effectivePendingFiles = pendingFiles ?? [];

  useEffect(() => {
    if (!open) return;
    if (!entryId) {
      setAttachments([]);
      setError("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(`/api/v1/attachments?entryId=${encodeURIComponent(entryId)}`, { cache: "no-store" })
      .then((response) => response.json() as Promise<ApiListResponse>)
      .then((result) => {
        if (cancelled) return;
        if (result?.ok && Array.isArray(result.data)) setAttachments(result.data);
        else setError(result?.error || t("attachments.loadFailed"));
      })
      .catch(() => {
        if (!cancelled) setError(t("attachments.loadFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, open, t]);

  function openPicker() {
    inputRef.current?.click();
  }

  async function addFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    const oversized = files.find((file) => file.size > ATTACHMENT_MAX_BYTES);
    if (oversized) {
      setError(t("attachments.fileTooLarge", { name: oversized.name, size: fileSizeLabel(ATTACHMENT_MAX_BYTES) }));
      return;
    }
    setError("");
    if (!entryId) {
      onPendingFilesChange?.([...effectivePendingFiles, ...files]);
      return;
    }
    setBusy(true);
    try {
      const uploaded = await uploadEntryAttachmentFiles(entryId, files);
      setAttachments((current) => [...current, ...uploaded]);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : t("attachments.uploadFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function deleteAttachment(id: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/v1/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
      const result = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !result?.ok) throw new Error(result?.error || response.statusText);
      setAttachments((current) => current.filter((item) => item.id !== id));
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t("attachments.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  function removePendingFile(index: number) {
    onPendingFilesChange?.(effectivePendingFiles.filter((_, itemIndex) => itemIndex !== index));
  }

  if (!open) return null;

  return createPortal(
    <div className="app-modal-backdrop z-[70]" onClick={onClose}>
      <div
        className="app-modal-panel max-w-md"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header shrink-0">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
            <Paperclip className="h-4 w-4" />
            {t("attachments.title")}
          </div>
          <button type="button" className="secondary-button h-8 px-2" onClick={onClose}>
            {t("table.close")}
          </button>
        </div>
        <div className="max-h-80 min-h-24 space-y-2 overflow-y-auto p-4">
          {loading ? <div className="text-sm text-slate-400">{t("common.loading")}</div> : null}
          {attachments.map((item) => (
            <div key={item.id} className="flex items-center gap-2 rounded border border-slate-200 bg-white px-2 py-1.5 text-sm">
              <a
                className="min-w-0 flex-1 truncate text-blue-600 hover:underline"
                href={item.url || `/api/v1/attachments/${encodeURIComponent(item.id)}`}
                target="_blank"
                rel="noreferrer"
                title={item.name}
              >
                {item.name}
              </a>
              <button
                type="button"
                onClick={() => void deleteAttachment(item.id)}
                disabled={busy}
                className="text-slate-400 hover:text-red-600"
                title={t("attachments.remove")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          {effectivePendingFiles.map((file, index) => (
            <div key={`${file.name}:${file.size}:${index}`} className="flex items-center gap-2 rounded border border-dashed border-slate-200 bg-white px-2 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate text-slate-600" title={file.name}>{file.name}</span>
              <span className="shrink-0 text-xs text-slate-400">{fileSizeLabel(file.size)}</span>
              <button
                type="button"
                onClick={() => removePendingFile(index)}
                className="text-slate-400 hover:text-red-600"
                title={t("attachments.remove")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
          {attachments.length === 0 && effectivePendingFiles.length === 0 && !loading ? (
            <div className="text-sm text-slate-400">{t("attachments.empty")}</div>
          ) : null}
          {error ? <div className="text-sm text-red-600">{error}</div> : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 p-3">
          <button type="button" className="secondary-button h-8 px-3" onClick={openPicker} disabled={busy || (!entryId && !onPendingFilesChange)}>
            <Plus className="mr-1 inline h-3.5 w-3.5" />
            {t("attachments.add")}
          </button>
          <button type="button" className="secondary-button h-8 px-3" onClick={onClose}>
            {t("table.close")}
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            void addFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
