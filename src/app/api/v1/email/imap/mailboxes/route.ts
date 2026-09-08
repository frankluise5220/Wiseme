import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ImapFlow } from "imapflow";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

const BodySchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().min(1),
  password: z.string().min(1),
});

/**
 * POST /api/v1/email/imap/mailboxes
 *
 * Connects to the given IMAP server and lists mailboxes (admin only).
 * This endpoint starts a server-side connection using the host/port/credentials
 * provided by the caller; allowing anonymous use would turn it into an
 * intranet-scan/credential-testing proxy, so admin authentication is required.
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }
  if (!isAdmin(currentUser)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "仅管理员可操作" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "参数格式不正确" }, { status: 400 });
  }

  const { host, port, secure, user, password } = parsed.data;
  const trace: string[] = [];

  const client = new ImapFlow({
    host,
    port,
    secure,
    auth: { user, pass: password, loginMethod: "LOGIN" },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    disableAutoEnable: true,
    disableCompression: true,
    disableBinary: true,
    disableAutoIdle: true,
    tls: secure ? { minVersion: "TLSv1.2", servername: host } : undefined,
  });

  try {
    trace.push(`connect ${host}:${port} secure=${secure ? "1" : "0"}`);
    await client.connect();
    trace.push("connect ok");

    const boxes: string[] = [];
    const anyClient = client as unknown as {
      list?: () => Promise<unknown> | AsyncIterable<unknown>;
      listTree?: () => Promise<unknown> | AsyncIterable<unknown>;
    };

    async function collectFrom(source: unknown) {
      if (!source) return;
      if (typeof (source as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
        for await (const box of source as AsyncIterable<{ path?: string; name?: string }>) {
          const path = (box.path ?? box.name ?? "").toString();
          if (path) boxes.push(path);
        }
        return;
      }
      if (Array.isArray(source)) {
        for (const box of source as Array<{ path?: string; name?: string }>) {
          const path = (box.path ?? box.name ?? "").toString();
          if (path) boxes.push(path);
        }
      }
    }

    if (typeof anyClient.list === "function") {
      await collectFrom(await anyClient.list());
    }
    if (!boxes.length && typeof anyClient.listTree === "function") {
      await collectFrom(await anyClient.listTree());
    }

    if (!boxes.length) {
      boxes.push("INBOX", "Inbox", "收件箱");
    }

    const unique = Array.from(new Set(boxes));
    trace.push(`mailbox list ok: ${unique.length}`);
    return NextResponse.json({ ok: true, trace, mailboxes: unique.slice(0, 200) });
  } catch (e) {
    const rawMsg = e instanceof Error ? e.message : "邮箱连接失败";
    const lower = rawMsg.toLowerCase();
    const msg = lower.includes("auth") || lower.includes("login")
      ? "认证失败：请确认邮箱账号与授权码是否正确。"
      : lower.includes("timed out") || lower.includes("timeout")
        ? "连接超时：请检查网络、端口与TLS设置。"
        : lower.includes("enotfound")
          ? "域名解析失败：请检查IMAP主机地址是否正确。"
          : rawMsg;
    return NextResponse.json({ ok: false, code: "IMAP_CONNECT_FAILED", error: msg, trace: [...trace, `error: ${rawMsg}`] }, { status: 500 });
  } finally {
    try {
      await client.logout();
    } catch {}
  }
}
