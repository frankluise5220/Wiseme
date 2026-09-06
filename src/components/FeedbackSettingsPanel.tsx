"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function FeedbackSettingsPanel() {
  const { t } = useI18n();
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [contact, setContact] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  async function submit() {
    const trimmedSubject = subject.trim();
    const trimmedContent = content.trim();
    if (!trimmedSubject) {
      setError(t("settings.feedback.subjectRequired"));
      return;
    }
    if (!trimmedContent) {
      setError(t("settings.feedback.contentRequired"));
      return;
    }
    setSending(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/v1/settings/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: trimmedSubject, content: trimmedContent, contact: contact.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setInfo(t("settings.feedback.sent"));
        setSubject("");
        setContent("");
        setContact("");
      } else {
        setError(data.error ?? t("settings.feedback.sendFailed"));
      }
    } catch {
      setError(t("settings.feedback.sendFailed"));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
        <h2 className="text-sm font-semibold text-slate-800">{t("settings.feedback.title")}</h2>
        <p className="mt-1 text-xs text-slate-500">{t("settings.feedback.description")}</p>
      </div>

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      {info && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{info}</div>}

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-600">{t("settings.feedback.subjectLabel")}</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t("settings.feedback.subjectPlaceholder")}
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-300"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-600">{t("settings.feedback.contentLabel")}</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t("settings.feedback.contentPlaceholder")}
              rows={6}
              className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-300"
            />
          </div>

          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-600">{t("settings.feedback.contactLabel")}</label>
            <input
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder={t("settings.feedback.contactPlaceholder")}
              className="h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-300"
            />
          </div>

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={submit}
              disabled={sending}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-blue-600 px-4 text-sm text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              {sending ? t("settings.feedback.sending") : t("settings.feedback.submit")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
