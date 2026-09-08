"use client";

import { Paperclip } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { EntryAttachmentWindow, uploadEntryAttachmentFiles, type EntryAttachmentItem } from "./EntryAttachmentWindow";

export { uploadEntryAttachmentFiles };
export type { EntryAttachmentItem };
export { ATTACHMENT_MAX_BYTES } from "./EntryAttachmentWindow";

/**
 * Attachment button placed next to the note field. It never changes the main
 * form layout: clicking opens the file picker directly when there are no
 * attachments yet, otherwise it opens a small in-page attachment window with
 * the list, an add button, and a close button.
 */
export function EntryAttachmentButton({
  entryId,
  pendingFiles,
  onPendingFilesChange,
}: {
  entryId?: string | null;
  pendingFiles?: File[];
  onPendingFilesChange?: (files: File[]) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<EntryAttachmentItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const effectivePendingFiles = pendingFiles ?? [];

  useEffect(() => {
    if (!entryId) {
      setAttachments([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(`/api/v1/attachments?entryId=${encodeURIComponent(entryId)}`, { cache: "no-store" })
      .then((response) => response.json() as Promise<{ ok?: boolean; data?: EntryAttachmentItem[]; error?: string }>)
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
  }, [entryId, t]);

  function openPicker() {
    inputRef.current?.click();
  }

  async function addFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    const oversized = files.find((file) => file.size > 5 * 1024 * 1024);
    if (oversized) {
      setError(t("attachments.fileTooLarge", { name: oversized.name, size: "5 MB" }));
      setModalOpen(true);
      return;
    }
    setError("");
    if (!entryId) {
      onPendingFilesChange?.([...effectivePendingFiles, ...files]);
      setModalOpen(true);
      return;
    }
    setBusy(true);
    try {
      const uploaded = await uploadEntryAttachmentFiles(entryId, files);
      setAttachments((current) => [...current, ...uploaded]);
      setModalOpen(true);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : t("attachments.uploadFailed"));
      setModalOpen(true);
    } finally {
      setBusy(false);
    }
  }

  function onButtonClick() {
    if (loading) return;
    if (error) {
      setModalOpen(true);
      return;
    }
    if (attachments.length === 0 && effectivePendingFiles.length === 0) {
      openPicker();
      return;
    }
    setModalOpen(true);
  }

  const totalCount = attachments.length + effectivePendingFiles.length;

  return (
    <>
      <button
        type="button"
        onClick={onButtonClick}
        disabled={busy || loading}
        title={t("attachments.title")}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700 disabled:opacity-50"
      >
        <Paperclip className="h-4 w-4" />
        {totalCount > 0 ? (
          <span className="ml-0.5 text-[10px] font-medium text-slate-600">{totalCount}</span>
        ) : null}
      </button>
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
      <EntryAttachmentWindow
        open={modalOpen}
        entryId={entryId}
        onClose={() => setModalOpen(false)}
        pendingFiles={effectivePendingFiles}
        onPendingFilesChange={onPendingFilesChange}
      />
    </>
  );
}
