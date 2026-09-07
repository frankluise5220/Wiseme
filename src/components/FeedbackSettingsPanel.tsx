"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { buildFeedbackLogsPayload } from "@/lib/client/feedback-logs";

type FeedbackType = "suggestion" | "bug";

export function FeedbackSettingsPanel() {
  const { t } = useI18n();
  const [feedbackType, setFeedbackType] = useState<FeedbackType>("suggestion");
  const [subject, setSubject] = useState("");
  const [content, setContent] = useState("");
  const [contact, setContact] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const bugTemplate = t("settings.feedback.bugTemplate");

  function switchType(next: FeedbackType) {
    if (next === feedbackType) return;
    setFeedbackType(next);
    if (next === "bug") {
      // Prefill the fixed bug template only when the user hasn't typed anything yet.
      if (!content.trim()) setContent(bugTemplate);
    } else if (content === bugTemplate) {
      // Switching back to suggestion: drop the untouched bug template.
      setContent("");
    }
    setError("");
  }

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
        body: JSON.stringify({
          type: feedbackType,
          subject: trimmedSubject,
          content: trimmedContent,
          contact: contact.trim(),
          logs: buildFeedbackLogsPayload(),
        }),
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

  const typeOptions: Array<{ value: FeedbackType; label: string }> = [
    { value: "suggestion", label: t("settings.feedback.typeSuggestion") },
    { value: "bug", label: t("settings.feedback.typeBug") },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
        <h2 className="text-sm font-semibold text-slate-800">{t("settings.feedback.title")}</h2>
        <p className="mt-1 text-xs text-slate-500">{t("settings.feedback.description")}</p>
        <p className="mt-1 text-xs text-slate-400">{t("settings.feedback.attachNotice")}</p>
      </div>

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      {info && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{info}</div>}

      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-600">{t("settings.feedback.typeLabel")}</label>
            <div className="inline-flex rounded-md border border-slate-200 p-0.5">
              {typeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => switchType(option.value)}
                  className={
                    feedbackType === option.value
                      ? "rounded-[5px] bg-blue-600 px-3 py-1.5 text-xs font-medium text-white"
                      : "rounded-[5px] px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:text-slate-900"
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

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
              placeholder={feedbackType === "bug" ? t("settings.feedback.bugContentPlaceholder") : t("settings.feedback.contentPlaceholder")}
              rows={feedbackType === "bug" ? 9 : 6}
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
