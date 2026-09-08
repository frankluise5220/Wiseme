import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { closeImap, connectAndOpenBox, listMails } from "@/lib/mail/imap-client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

const MAX_MAIL_SEARCH_LIMIT = 50;
const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * POST /api/v1/email/imap/list
 *
 * Lists mailbox envelopes for one configured email account or an ad-hoc IMAP
 * configuration. `sinceDate` and `endDate` are date-only bounds in YYYY-MM-DD
 * format, both inclusive from the user's perspective. `limit` and `scanLimit`
 * are capped at 50 so the import picker remains bounded.
 */
const BodySchema = z.object({
  accountId: z.string().optional(),
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  user: z.string().optional(),
  password: z.string().optional(),
  mailbox: z.string().min(1).default("INBOX"),
  limit: z.number().int().min(1).max(MAX_MAIL_SEARCH_LIMIT).default(MAX_MAIL_SEARCH_LIMIT),
  scanLimit: z.number().int().min(1).max(MAX_MAIL_SEARCH_LIMIT).default(MAX_MAIL_SEARCH_LIMIT),
  sinceDate: DateOnlySchema.optional(),
  endDate: DateOnlySchema.optional(),
  keyword: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  subjectIncludes: z.string().optional(),
  fromIncludes: z.string().optional(),
  debug: z.boolean().optional(),
});

export async function POST(req: NextRequest) {
  const { householdId } = await getHouseholdScope();
  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, code: "INVALID_REQUEST", error: "Invalid request body." }, { status: 400 });

  let { host, port, secure, user, password, mailbox, limit, scanLimit, sinceDate, endDate, keyword, keywords, subjectIncludes, fromIncludes, debug } = parsed.data;

  if (sinceDate && endDate && sinceDate > endDate) {
    return NextResponse.json({ ok: false, code: "INVALID_DATE_RANGE", error: "Start date must not be later than end date." }, { status: 400 });
  }

  if (parsed.data.accountId) {
    const account = await prisma.emailAccount.findFirst({ where: { id: parsed.data.accountId, householdId } });
    if (!account) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Email account not found." }, { status: 404 });
    host = account.imapHost;
    port = account.imapPort;
    secure = account.imapSecure;
    user = account.username;
    password = account.password;
    mailbox = account.mailbox;
  }

  if (!host || !user || !password) {
    return NextResponse.json({ ok: false, code: "INCOMPLETE_CONFIG", error: "Complete IMAP configuration is required." }, { status: 400 });
  }

  const trace: string[] = [];
  let client: Awaited<ReturnType<typeof connectAndOpenBox>>["client"] | null = null;
  const startedAt = Date.now();

  try {
    const opened = await connectAndOpenBox({ host, port, secure, user, password, mailbox }, trace);
    const openedAt = Date.now();
    client = opened.client;
    const result = await listMails(client, { limit, scanLimit, sinceDate, endDate, keyword, keywords, subjectIncludes, fromIncludes }, trace);
    const listedAt = Date.now();
    return NextResponse.json({
      ok: true,
      items: result.items,
      meta: {
        ...result.meta,
        timingMs: {
          connect: openedAt - startedAt,
          list: listedAt - openedAt,
          total: listedAt - startedAt,
        },
      },
      mailbox: opened.mailbox,
      ...(debug ? { trace: [...trace, `list ok ${result.items.length}`] } : {}),
    });
  } catch (e) {
    const rawMsg = e instanceof Error ? e.message : "Mailbox connection failed.";
    return NextResponse.json({ ok: false, code: "IMAP_CONNECT_FAILED", error: formatImapError(rawMsg), ...(debug ? { trace: [...trace, `error: ${rawMsg}`] } : {}) }, { status: 500 });
  } finally {
    if (client) await closeImap(client);
  }
}

function formatImapError(message: string) {
  const lower = message.toLowerCase();
  if (lower.includes("authentication") || lower.includes("login") || lower.includes("auth")) {
    return "Mailbox login failed. Confirm that IMAP is enabled and use an app password instead of the web login password.";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "Mailbox connection timed out. Check the IMAP server, port, TLS setting, and network connection.";
  }
  if (lower.includes("mailbox") || lower.includes("not found")) {
    return "Mailbox folder could not be opened. Confirm the folder name; INBOX is usually the first value to try.";
  }
  return message;
}
