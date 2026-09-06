import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { formatResendSendError, getEnvResendConfig } from "@/lib/mail/resend";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

/**
 * POST /api/v1/settings/resend/test
 * Sends a test email using the provided Resend configuration.
 * Body: { apiKey: string, from: string } (optional: falls back to the saved configuration when omitted)
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "ADMIN_ONLY", error: "Administrator access required." }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  let apiKey = String(body.apiKey ?? "").trim();
  let from = String(body.from ?? "").trim();

  if (!apiKey || !from) {
    const setting = await prisma.systemSetting.findUnique({ where: { key: "resend_config" } });
    if (setting) {
      try {
        const parsed = JSON.parse(setting.value) as { apiKey?: string; from?: string };
        if (!apiKey) apiKey = parsed.apiKey ?? "";
        if (!from) from = parsed.from ?? "";
      } catch {}
    }
  }

  if (!apiKey || !from) {
    const envConfig = getEnvResendConfig();
    if (envConfig) {
      if (!apiKey) apiKey = envConfig.apiKey;
      if (!from) from = envConfig.from;
    }
  }

  if (!apiKey || !from) {
    return NextResponse.json({ ok: false, code: "MISSING_RESEND_CONFIG", error: "请填写 Resend API Key 和发件地址" }, { status: 400 });
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      from,
      to: from,
      subject: "MMH Resend 测试邮件",
      text: "如果你收到这封邮件，说明 Resend 发件配置正确。",
      html: "<div><h2>MMH Resend 测试邮件</h2><p>如果你收到这封邮件，说明 Resend 发件配置正确。</p></div>",
    }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => null) as { message?: string; error?: string } | null;
    return NextResponse.json({ ok: false, code: "SEND_FAILED", error: formatResendSendError(data, res.status) });
  }

  return NextResponse.json({ ok: true });
}
