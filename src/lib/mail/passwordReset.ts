import { sendEmailByResend, hasAnyResendConfig } from "./resend";
import { sendEmail, hasAnySmtpConfig } from "./smtp";

type PasswordResetEmailParams = {
  to: string;
  username: string;
  code: string;
  expiresMinutes: number;
  householdId?: string | null;
};

export type SendEmailResult = {
  ok: boolean;
  error?: string;
};

function buildPasswordResetContent(params: PasswordResetEmailParams) {
  const subject = "MMH 密码找回验证码";
  const text = `你正在找回 MMH 账号（${params.username}）的密码。\n\n验证码：${params.code}\n有效期：${params.expiresMinutes} 分钟\n\n如果不是你本人操作，请忽略本邮件。`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.7; color: #0f172a;">
      <h2 style="margin: 0 0 12px;">MMH 密码找回验证码</h2>
      <p>你正在找回 MMH 账号（${params.username}）的密码。</p>
      <p style="font-size: 24px; letter-spacing: 6px; font-weight: 700; margin: 18px 0;">${params.code}</p>
      <p>验证码有效期：${params.expiresMinutes} 分钟。</p>
      <p style="color: #64748b; font-size: 13px;">如果不是你本人操作，请忽略本邮件。</p>
    </div>
  `;
  return { subject, text, html };
}

/** Checks whether any email sending service is available (auto-enable condition for password recovery) */
export async function hasEmailService(householdId?: string | null): Promise<boolean> {
  // Resend is the preferred channel
  if (await hasAnyResendConfig()) return true;

  // SMTP (env + EmailAccount + UserSettings) is the fallback
  if (await hasAnySmtpConfig(householdId)) return true;

  return false;
}

export async function sendPasswordResetEmail(params: PasswordResetEmailParams): Promise<SendEmailResult> {
  // Check whether any email service is available
  if (!await hasEmailService(params.householdId)) {
    return { ok: false, error: "未配置邮件服务，无法发送密码找回邮件。请在设置中配置 SMTP 或 Resend。" };
  }

  const content = buildPasswordResetContent(params);

  // Prefer Resend
  if (await hasAnyResendConfig()) {
    const resendResult = await sendEmailByResend({ to: params.to, ...content });
    if (resendResult.ok) {
      return resendResult;
    }
    if (await hasAnySmtpConfig(params.householdId)) {
      const smtpResult = await sendEmail({ to: params.to, householdId: params.householdId, ...content });
      if (smtpResult.ok) {
        return smtpResult;
      }
      return { ok: false, error: `${resendResult.error ?? "Resend 发信失败"}；SMTP 备用通道也发送失败：${smtpResult.error ?? "未知错误"}` };
    }
    return resendResult;
  }

  // SMTP fallback
  if (await hasAnySmtpConfig(params.householdId)) {
    return sendEmail({ to: params.to, householdId: params.householdId, ...content });
  }

  return { ok: false, error: "未配置邮件服务，无法发送密码找回邮件。请在设置中配置 Resend 或 SMTP。" };
}
