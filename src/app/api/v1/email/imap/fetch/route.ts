import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { closeImap, connectAndOpenBox, fetchMailDetail } from "@/lib/mail/imap-client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

const BodySchema = z.object({
  accountId: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().optional(),
  password: z.string().optional(),
  mailbox: z.string().min(1).default("INBOX"),
  uid: z.number().int().min(1),
  debug: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "参数格式不正确" }, { status: 400 });

  let { host, port, secure, user, password, mailbox, uid, debug } = parsed.data;

  if (parsed.data.accountId) {
    const account = await prisma.emailAccount.findFirst({ where: { id: parsed.data.accountId, householdId } });
    if (!account) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "账户不存在" }, { status: 404 });
    host = account.imapHost;
    port = account.imapPort;
    secure = account.imapSecure;
    user = account.username;
    password = account.password;
    mailbox = account.mailbox;
  }

  if (!host || !user || !password) {
    return NextResponse.json({ ok: false, code: "INCOMPLETE_CONFIG", error: "请填写完整配置" }, { status: 400 });
  }

  const trace: string[] = [];
  let client: Awaited<ReturnType<typeof connectAndOpenBox>>["client"] | null = null;

  try {
    const opened = await connectAndOpenBox({ host, port, secure, user, password, mailbox }, trace);
    client = opened.client;
    const item = await fetchMailDetail(client, uid);
    return NextResponse.json({ ok: true, item, mailbox: opened.mailbox, ...(debug ? { trace: [...trace, "fetch ok"] } : {}) });
  } catch (e) {
    const rawMsg = e instanceof Error ? e.message : "邮箱连接失败";
    return NextResponse.json({ ok: false, code: "IMAP_CONNECT_FAILED", error: formatImapError(rawMsg), ...(debug ? { trace: [...trace, `error: ${rawMsg}`] } : {}) }, { status: 500 });
  } finally {
    if (client) await closeImap(client);
  }
}

function formatImapError(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("authentication") || lower.includes("login") || lower.includes("auth")) {
    return "邮箱登录失败，请确认 IMAP 已开启，并使用邮箱授权码/应用专用密码，不要使用网页登录密码。";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "邮箱连接超时，请检查 IMAP 服务器、端口、TLS 设置和网络连接。";
  }
  if (lower.includes("mailbox") || lower.includes("not found")) {
    return "邮箱文件夹打开失败，请确认文件夹名称，通常可先使用 INBOX。";
  }
  return message;
}
