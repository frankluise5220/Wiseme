import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sendEmailByResend } from "@/lib/mail/resend";
import { sendEmail, hasAnySmtpConfig } from "@/lib/mail/smtp";
import { getCurrentUser } from "@/lib/server/auth";

export const runtime = "nodejs";

/** Fixed recipient for user feedback. */
const FEEDBACK_TO = "frankluise5220@gmail.com";

/** Max characters of client logs accepted in one feedback submission. */
const MAX_LOGS_LENGTH = 8000;

type FeedbackType = "suggestion" | "bug";

let cachedAppVersion: string | null = null;

/** Reads the app version from package.json (cached after first read). */
function getAppVersion(): string {
  if (cachedAppVersion) return cachedAppVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as { version?: string };
    cachedAppVersion = pkg.version || "unknown";
  } catch {
    cachedAppVersion = "unknown";
  }
  return cachedAppVersion;
}

function isFeedbackType(value: unknown): value is FeedbackType {
  return value === "suggestion" || value === "bug";
}

/**
 * POST /api/v1/settings/feedback
 *
 * Sends user feedback (suggestions / bug reports) to the product mailbox.
 * Prefers SMTP, falls back to Resend.
 * Bug reports carry a fixed template filled by the user; every submission
 * attaches the app version and recent client-side logs collected by the browser.
 *
 * Body: { type?: "suggestion" | "bug", subject: string, content: string, contact?: string, logs?: string }
 * Response: { ok: true } on success, { ok: false, code, error } on failure.
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const type: FeedbackType = isFeedbackType(body.type) ? body.type : "suggestion";
  const subject = String(body.subject ?? "").trim();
  const content = String(body.content ?? "").trim();
  const contact = String(body.contact ?? "").trim();
  const logs = String(body.logs ?? "").trim().slice(0, MAX_LOGS_LENGTH);

  if (!subject) {
    return NextResponse.json({ ok: false, code: "MISSING_SUBJECT", error: "请填写主题" }, { status: 400 });
  }
  if (!content) {
    return NextResponse.json({ ok: false, code: "MISSING_CONTENT", error: "请填写反馈内容" }, { status: 400 });
  }

  const typeLabel = type === "bug" ? "Bug" : "Suggestion";
  const version = getAppVersion();

  const headerLines = [
    `User: ${currentUser.name || "unknown"} (id: ${currentUser.id})`,
    contact ? `Contact: ${contact}` : "",
    `Type: ${typeLabel}`,
    `App version: ${version}`,
  ];
  const logSection = logs ? ["", "---- Client logs ----", logs].join("\n") : "";
  const text = [...headerLines, "", content].filter((line) => line !== "").join("\n") + logSection;

  const html = [
    `<p><strong>User:</strong> ${escapeHtml(currentUser.name || "unknown")} (id: ${escapeHtml(currentUser.id)})</p>`,
    contact ? `<p><strong>Contact:</strong> ${escapeHtml(contact)}</p>` : "",
    `<p><strong>Type:</strong> ${typeLabel}</p>`,
    `<p><strong>App version:</strong> ${escapeHtml(version)}</p>`,
    `<p>${escapeHtml(content).replace(/\n/g, "<br>")}</p>`,
    logs ? `<pre style="white-space:pre-wrap;background:#f5f7fa;padding:8px;border-radius:6px;font-size:12px;">${escapeHtml(logs)}</pre>` : "",
  ].join("");

  const subjectPrefix = type === "bug" ? "[MMH Bug]" : "[MMH Feedback]";

  if (await hasAnySmtpConfig(currentUser.householdId)) {
    const result = await sendEmail({
      to: FEEDBACK_TO,
      subject: `${subjectPrefix} ${subject}`,
      text,
      html,
      householdId: currentUser.householdId,
    });
    if (result.ok) return NextResponse.json({ ok: true });
    return NextResponse.json({ ok: false, code: "SEND_FAILED", error: result.error }, { status: 502 });
  }

  const result = await sendEmailByResend({
    to: FEEDBACK_TO,
    subject: `${subjectPrefix} ${subject}`,
    text,
    html,
  });
  if (result.ok) return NextResponse.json({ ok: true });
  return NextResponse.json({ ok: false, code: "SEND_FAILED", error: result.error }, { status: 502 });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
