import { NextResponse } from "next/server";
import { hasAnySmtpConfig } from "@/lib/mail/smtp";
import { hasAnyResendConfig } from "@/lib/mail/resend";

export const runtime = "nodejs";

/**
 * GET /api/v1/settings/email/status
 * Returns mail service availability (used for automatic detection in password recovery)
 */
export async function GET() {
  // Check Resend (SystemSetting + env)
  const hasResend = await hasAnyResendConfig();

  // Check SMTP (uses the same resolution path as actual sending)
  const hasSmtp = await hasAnySmtpConfig();

  return NextResponse.json({
    ok: true,
    hasEmailService: hasResend || hasSmtp,
    hasResend,
    hasSmtp,
  });
}
