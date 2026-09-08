import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createHash } from "node:crypto";
import type { Readable } from "stream";
import { extractPdfText } from "@/lib/mail/pdf";
import { extractSpreadsheetText } from "@/lib/mail/spreadsheet";

export type ImapConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox?: string;
};

export type MailListItem = { uid: number; subject: string; from: string; date: string; hash: string };
export type MailAttachment = { id: string; filename: string; contentType: string; size: number; text?: string; parseError?: string };
export type MailDetail = { uid: number; subject: string; from: string; date: string; text: string; html: string; attachments: MailAttachment[] };
export type MailListMeta = {
  total: number;
  scanned: number;
  matched: number;
  limited: number;
  hasKeyword: boolean;
  scanLimit: number;
  sinceDate: string;
  endDate: string;
  searchMode?: "imap" | "scan";
  timingMs?: {
    connect?: number;
    list?: number;
    total?: number;
  };
};

type MailClient = {
  client: InstanceType<typeof ImapFlow>;
  mailbox: string;
};

type DownloadedMail = {
  content: Readable;
};

type SearchObject = {
  subject?: string;
  from?: string;
  since?: Date | string;
  before?: Date | string;
  or?: SearchObject[];
};

const IMAP_OPERATION_TIMEOUT_MS = 15000;
const IMAP_CLIENT_NAME = "MMH";

function buildClient(config: ImapConfig) {
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.password,
    },
    clientInfo: {
      name: IMAP_CLIENT_NAME,
      version: "1.0.0",
    },
    logger: false,
    tls: {
      servername: config.host,
      minVersion: "TLSv1.2",
    },
    socketTimeout: IMAP_OPERATION_TIMEOUT_MS,
    connectionTimeout: IMAP_OPERATION_TIMEOUT_MS,
    greetingTimeout: IMAP_OPERATION_TIMEOUT_MS,
  });
}

function withTimeout<T>(task: Promise<T>, message: string, timeoutMs = IMAP_OPERATION_TIMEOUT_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function toIso(value: Date | string | undefined) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function normalizeHashPart(value: string | number | undefined | null) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function buildMailListHash(input: { subject: string; from: string; date: string }) {
  const payload = [
    normalizeHashPart(input.subject),
    normalizeHashPart(input.from),
    normalizeHashPart(input.date),
  ].join("\n");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function formatAddress(address?: { name?: string; address?: string }[]) {
  const first = address?.[0];
  return (first?.address || first?.name || "").trim();
}

function buildRecentSequenceRange(total: number, limit: number, hasKeyword: boolean, scanLimit?: number) {
  const requestedScanLimit = scanLimit && Number.isFinite(scanLimit) ? Math.max(1, Math.floor(scanLimit)) : 0;
  const effectiveScanLimit = requestedScanLimit > 0
    ? Math.max(limit, requestedScanLimit)
    : hasKeyword
      ? Math.max(limit * 100, 500)
      : limit;
  const scanLimitClamped = Math.min(total, effectiveScanLimit);
  const start = Math.max(1, total - scanLimitClamped + 1);
  return `${start}:${total}`;
}

type MailEnvelopeMessage = {
  uid: number;
  envelope?: {
    subject?: string | null;
    from?: Array<{ name?: string | null; address?: string | null }> | null;
    date?: Date | string | null;
  } | null;
};

function buildMailListItem(message: MailEnvelopeMessage) {
  const subject = (message.envelope?.subject || "").trim();
  const from = formatAddress(message.envelope?.from?.map((item) => ({
    name: item.name ?? undefined,
    address: item.address ?? undefined,
  })));
  const date = toIso(message.envelope?.date ?? undefined);
  return {
    uid: message.uid,
    subject,
    from,
    date,
    hash: buildMailListHash({ subject, from, date }),
  } satisfies MailListItem;
}

function mailListItemMatchesFilters(
  item: MailListItem,
  filters: {
    keywords: string[];
    subjectKeyword?: string;
    fromKeyword?: string;
    sinceValid?: Date | null;
    beforeValid?: Date | null;
  },
) {
  if (filters.sinceValid || filters.beforeValid) {
    const date = item.date ? new Date(item.date) : null;
    if (date && !Number.isNaN(date.getTime())) {
      if (filters.sinceValid && date < filters.sinceValid) return false;
      if (filters.beforeValid && date >= filters.beforeValid) return false;
    }
  }
  const normalizedSubject = item.subject.toLowerCase();
  const normalizedFrom = item.from.toLowerCase();
  const keywordOk = filters.keywords.length === 0 || filters.keywords.some((keyword) => normalizedSubject.includes(keyword) || normalizedFrom.includes(keyword));
  const subjectOk = !filters.subjectKeyword || normalizedSubject.includes(filters.subjectKeyword);
  const fromOk = !filters.fromKeyword || normalizedFrom.includes(filters.fromKeyword);
  return keywordOk && subjectOk && fromOk;
}

function orSearchQueries(queries: SearchObject[]) {
  if (queries.length === 0) return null;
  if (queries.length === 1) return queries[0];
  return { or: queries } satisfies SearchObject;
}

function hasNonAsciiSearchText(value: string | undefined) {
  return Boolean(value && /[^\x00-\x7F]/.test(value));
}

function buildMailSearchQuery(input: {
  keywords: string[];
  subjectKeyword?: string;
  fromKeyword?: string;
  sinceValid?: Date | null;
  beforeValid?: Date | null;
}) {
  const query: SearchObject = {};
  if (input.sinceValid) query.since = input.sinceValid;
  if (input.beforeValid) query.before = input.beforeValid;

  if (input.keywords.length > 0) {
    const keywordQuery = orSearchQueries(input.keywords.flatMap((keyword) => [
      { subject: keyword } satisfies SearchObject,
      { from: keyword } satisfies SearchObject,
    ]));
    if (keywordQuery?.or) query.or = keywordQuery.or;
    else if (keywordQuery) Object.assign(query, keywordQuery);
  }
  if (input.subjectKeyword) query.subject = input.subjectKeyword;
  if (input.fromKeyword) query.from = input.fromKeyword;

  return Object.keys(query).length > 0 ? query : null;
}

async function trySearchMailListRows(
  client: MailClient["client"],
  filters: {
    limit: number;
    keywords: string[];
    subjectKeyword?: string;
    fromKeyword?: string;
    sinceValid?: Date | null;
    beforeValid?: Date | null;
  },
  trace: string[],
) {
  const textTerms = [...filters.keywords, filters.subjectKeyword, filters.fromKeyword];
  if (textTerms.some(hasNonAsciiSearchText)) {
    trace.push("search skipped unicode text");
    return null;
  }

  const query = buildMailSearchQuery(filters);
  if (!query) return null;

  try {
    trace.push("search start");
    const searched = await withTimeout(client.search(query, { uid: true }), "IMAP mail list search timed out");
    if (searched === false) {
      trace.push("search unavailable");
      return null;
    }
    const uids = Array.isArray(searched)
      ? Array.from(new Set(searched.filter((uid) => Number.isFinite(uid)))).sort((a, b) => b - a)
      : [];
    trace.push(`search ok ${uids.length}`);
    if (uids.length === 0) return { items: [] as MailListItem[], matched: 0, searched: true };

    const fetchUids = uids.slice(0, Math.max(filters.limit, 20));
    const rows: MailListItem[] = [];
    for await (const message of client.fetch(fetchUids, { envelope: true, uid: true }, { uid: true })) {
      const item = buildMailListItem(message);
      if (mailListItemMatchesFilters(item, filters)) rows.push(item);
    }
    return {
      items: rows.sort((a, b) => b.uid - a.uid).slice(0, filters.limit),
      matched: uids.length,
      searched: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    trace.push(`search fallback: ${message}`);
    return null;
  }
}

export async function connectAndOpenBox(config: ImapConfig, trace: string[] = []) {
  const mailbox = (config.mailbox ?? "INBOX").trim() || "INBOX";
  const client = buildClient(config);

  trace.push(`connect ${config.host}:${config.port} secure=${config.secure ? "1" : "0"}`);
  try {
    await withTimeout(client.connect(), "IMAP connection timed out");
    trace.push("connect ok");
    await withTimeout(client.mailboxOpen(mailbox, { readOnly: true }), "Mailbox folder open timed out");
    trace.push(`mailbox open ok: ${mailbox}`);
    return { client, mailbox };
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function closeImap(target: MailClient["client"] | MailClient) {
  const client = "client" in target ? target.client : target;
  try {
    if (client.usable) {
      await withTimeout(client.logout(), "IMAP logout timed out", 1000);
    } else {
      client.close();
    }
  } catch {
    client.close();
  }
}

export async function listMails(
  target: MailClient["client"] | MailClient,
  options: { limit: number; scanLimit?: number; sinceDate?: string; endDate?: string; keyword?: string; keywords?: string[]; subjectIncludes?: string; fromIncludes?: string },
  trace: string[] = []
): Promise<{ items: MailListItem[]; meta: MailListMeta }> {
  const client = "client" in target ? target.client : target;
  const total = client.mailbox && typeof client.mailbox.exists === "number" ? client.mailbox.exists : 0;
  trace.push(`box total ${total}`);
  if (!total) {
    return { items: [], meta: { total: 0, scanned: 0, matched: 0, limited: options.limit, hasKeyword: false, scanLimit: options.scanLimit ?? options.limit, sinceDate: options.sinceDate ?? "", endDate: options.endDate ?? "", searchMode: "scan" } };
  }

  const keywords = Array.from(new Set([
    options.keyword,
    ...(options.keywords ?? []),
  ]
    .map((item) => item?.trim().toLowerCase())
    .filter((item): item is string => !!item)));
  const subjectKeyword = options.subjectIncludes?.trim().toLowerCase();
  const fromKeyword = options.fromIncludes?.trim().toLowerCase();
  const hasKeyword = Boolean(keywords.length > 0 || subjectKeyword || fromKeyword);
  const since = options.sinceDate ? new Date(`${options.sinceDate}T00:00:00.000Z`) : null;
  const sinceValid = since && !Number.isNaN(since.getTime()) ? since : null;
  const before = options.endDate ? new Date(`${options.endDate}T00:00:00.000Z`) : null;
  const beforeValid = before && !Number.isNaN(before.getTime())
    ? new Date(before.getTime() + 24 * 60 * 60 * 1000)
    : null;
  const searchedRows = await trySearchMailListRows(client, {
    limit: options.limit,
    keywords,
    subjectKeyword,
    fromKeyword,
    sinceValid,
    beforeValid,
  }, trace);
  if (searchedRows) {
    return {
      items: searchedRows.items,
      meta: {
        total,
        scanned: searchedRows.matched,
        matched: searchedRows.matched,
        limited: options.limit,
        hasKeyword,
        scanLimit: searchedRows.matched,
        sinceDate: options.sinceDate ?? "",
        endDate: options.endDate ?? "",
        searchMode: "imap",
      },
    };
  }

  const range = buildRecentSequenceRange(total, options.limit, hasKeyword || Boolean(sinceValid) || Boolean(beforeValid), options.scanLimit);
  let scanned = 0;
  trace.push(`fetch seq ${range}`);

  const rows: MailListItem[] = [];
  const task = (async () => {
    for await (const message of client.fetch(range, { envelope: true, uid: true })) {
      const item = buildMailListItem(message);
      scanned += 1;
      if (!mailListItemMatchesFilters(item, { keywords, subjectKeyword, fromKeyword, sinceValid, beforeValid })) continue;
      rows.push(item);
      trace.push(`row ok uid=${message.uid} "${item.subject}"`);
    }
  })();

  await withTimeout(task, "IMAP mail list read timed out");
  const items = rows.sort((a, b) => b.uid - a.uid).slice(0, options.limit);
  return {
    items,
    meta: {
      total,
      scanned,
      matched: rows.length,
      limited: options.limit,
      hasKeyword,
      scanLimit: options.scanLimit ?? scanned,
      sinceDate: options.sinceDate ?? "",
      endDate: options.endDate ?? "",
      searchMode: "scan",
    },
  };
}

export async function fetchMailDetail(target: MailClient["client"] | MailClient, uid: number) {
  const client = "client" in target ? target.client : target;
  const downloaded = await withTimeout(
    client.download(String(uid), undefined, { uid: true }),
    "IMAP email content read timed out"
  ) as DownloadedMail;
  const chunks: Buffer[] = [];

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      downloaded.content.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      downloaded.content.once("error", reject);
      downloaded.content.once("end", resolve);
    }),
    "IMAP email content download timed out"
  );

  const source = Buffer.concat(chunks);
  if (!source.length) throw new Error("Email content not found.");

  const parsed = await simpleParser(source);
  const attachments = await Promise.all((parsed.attachments ?? []).map(async (attachment, index): Promise<MailAttachment> => {
    const filename = (attachment.filename ?? `Attachment ${index + 1}`).toString();
    const contentType = (attachment.contentType ?? "").toString();
    const content = Buffer.isBuffer(attachment.content) ? attachment.content : Buffer.from(attachment.content ?? []);
    const isPdf = contentType.toLowerCase().includes("pdf") || filename.toLowerCase().endsWith(".pdf");
    const isSpreadsheet = /\.(?:xls|xlsx)$/i.test(filename)
      || /spreadsheet|excel|vnd\.ms-excel|officedocument\.spreadsheetml/i.test(contentType);
    if (!isPdf && !isSpreadsheet) {
      return { id: String(index), filename, contentType, size: attachment.size ?? content.length };
    }

    try {
      const text = isPdf ? await extractPdfText(content) : await extractSpreadsheetText(content);
      return {
        id: String(index),
        filename,
        contentType,
        size: attachment.size ?? content.length,
        text: text || undefined,
        parseError: text ? undefined : isPdf ? "No text was extracted from the PDF." : "No table text was extracted from the spreadsheet.",
      };
    } catch {
      return {
        id: String(index),
        filename,
        contentType,
        size: attachment.size ?? content.length,
        parseError: isPdf ? "PDF text extraction failed. The file may be scanned or encrypted." : "Spreadsheet reading failed. The file may be encrypted or malformed.",
      };
    }
  }));
  return {
    uid,
    subject: (parsed.subject ?? "").toString(),
    from: (parsed.from?.value?.[0]?.address ?? parsed.from?.value?.[0]?.name ?? "").toString(),
    date: toIso(parsed.date),
    text: (parsed.text ?? "").toString(),
    html: (parsed.html ?? "").toString(),
    attachments,
  } satisfies MailDetail;
}
