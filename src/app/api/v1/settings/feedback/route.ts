import { NextRequest, NextResponse } from "next/server";
import { sendEmailByResend } from "@/lib/mail/resend";
import { sendEmail, hasAnySmtpConfig } from "@/lib/mail/smtp";
import { getCurrentUser } from "@/lib/server/auth";

export const runtime = "nodejs";

/** Fixed recipient for user feedback. */
const FEEDBACK_TO = "frankluise5220@gmail.com";

/**
 * POST /api/v1/settings/feedback
 *
 * Sends user feedback (suggestions / issues) to the product mailbox.
 * Prefers SMTP, falls back to Resend.
 *
 * Body: { subject: string, content: string, contact?: string }
 * Response: { ok: true } on success, { ok: false, code, error } on failure.
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Please sign in first" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const subject = String(body.subject ?? "").trim();
  const content = String(body.content ?? "").trim();
  const contact = String(body.contact ?? "").trim();

  if (!subject) {
    return NextResponse.json({ ok: false, code: "MISSING_SUBJECT", error: "Subject is required" }, { status: 400 });
  }
  if (!content) {
    return NextResponse.json({ ok: false, code: "MISSING_CONTENT", error: "Content is required" }, { status: 400 });
  }

  const userLine = `User: ${currentUser.name || "unknown"} (id: ${currentUser.id})`;
  const contactLine = contact ? `Contact: ${contact}` : "";
  const text = [userLine, contactLine, "", content].filter((line) => line !== "").join("\n");
  const html = [
    `<p><strong>User:</strong> ${escapeHtml(currentUser.name || "unknown")} (id: ${escapeHtml(currentUser.id)})</p>`,
    contact ? `<p><strong>Contact:</strong> ${escapeHtml(contact)}</p>` : "",
    `<p>${escapeHtml(content).replace(/\n/g, "<br>")}</p>`,
  ].join("");

  if (await hasAnySmtpConfig(currentUser.householdId)) {
    const result = await sendEmail({
      to: FEEDBACK_TO,
      subject: `[MMH Feedback] ${subject}`,
      text,
      html,
      householdId: currentUser.householdId,
    });
    if (result.ok) return NextResponse.json({ ok: true });
    return NextResponse.json({ ok: false, code: "SEND_FAILED", error: result.error }, { status: 502 });
  }

  const result = await sendEmailByResend({
    to: FEEDBACK_TO,
    subject: `[MMH Feedback] ${subject}`,
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
