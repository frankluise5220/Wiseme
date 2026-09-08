import { prisma } from "@/lib/db/prisma";

/**
 * Default sender address. Set it with RESEND_FROM in your env / .env to use a
 * personal verified domain; otherwise falls back to Resend's platform
 * placeholder so the source never hardcodes a private domain.
 */
export const RESEND_FROM = (process.env.RESEND_FROM ?? "").trim() || "onboarding@resend.dev";

type ResendConfig = {
  apiKey: string;
  from: string;
};

function normalizeResendError(input: { message?: string; name?: string; error?: string } | null, status: number) {
  const raw = (input?.message || input?.error || "").trim();
  const lower = raw.toLowerCase();
  if (status === 401 || lower.includes("api key is invalid") || lower.includes("invalid api key")) {
    return "Resend API Key 无效，请到系统设置 > 邮箱账户重新验证并保存有效的 API Key，或改用 SMTP 发件。";
  }
  if (status === 403 || lower.includes("domain") || lower.includes("from")) {
    return "Resend 发件地址或域名未通过验证，请检查系统设置里的 Resend 发件配置。";
  }
  return raw || `Resend 发信失败：${status}`;
}

function allowEnvResendConfig() {
  const explicit = (process.env.MMH_ALLOW_ENV_RESEND_CONFIG ?? "").trim().toLowerCase();
  if (explicit === "1" || explicit === "true" || explicit === "yes") return true;
  return process.env.NODE_ENV !== "production";
}

export function getEnvResendConfig(): ResendConfig | null {
  if (!allowEnvResendConfig()) return null;
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  if (!apiKey) return null;
  // env can override from, but defaults to the fixed value
  const from = (process.env.RESEND_FROM ?? "").trim() || RESEND_FROM;
  return { apiKey, from };
}

/** Reads the Resend config from the SystemSetting table or env. */
async function getDbResendConfig(): Promise<ResendConfig | null> {
  try {
    const setting = await prisma.systemSetting.findUnique({ where: { key: "resend_config" } });
    if (setting) {
      const parsed = JSON.parse(setting.value) as { apiKey?: string; from?: string };
      if (parsed.apiKey) {
        // Prefer the from stored in the database, which is the fixed value anyway
        return { apiKey: parsed.apiKey, from: parsed.from || RESEND_FROM };
      }
    }
    // fallback: legacy UserSettings (for backward compatibility with old data)
    const users = await prisma.user.findMany({ where: { role: "admin" }, take: 1 });
    if (users[0]) {
      const settings = await prisma.userSettings.findUnique({ where: { userId: users[0].id } });
      if (settings?.resendApiKey) {
        return { apiKey: settings.resendApiKey, from: settings.resendFrom || RESEND_FROM };
      }
    }
  } catch {}
  return null;
}

async function resolveResendConfig(): Promise<ResendConfig | null> {
  const db = await getDbResendConfig();
  if (db) return db;
  return getEnvResendConfig();
}

export function hasResendConfig(): boolean {
  return getEnvResendConfig() !== null;
}

export async function hasAnyResendConfig(): Promise<boolean> {
  return (await resolveResendConfig()) !== null;
}

export async function sendEmailByResend(params: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}) {
  const cfg = await resolveResendConfig();
  if (!cfg) {
    return { ok: false as const, error: "未配置 Resend 邮件服务" };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      from: cfg.from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
    }),
  });

  const data = await res.json().catch(() => null) as { message?: string; name?: string; error?: string } | null;
  if (!res.ok) {
    return { ok: false as const, error: normalizeResendError(data, res.status) };
  }

  return { ok: true as const };
}

export function formatResendSendError(input: { message?: string; name?: string; error?: string } | null, status: number) {
  return normalizeResendError(input, status);
}
