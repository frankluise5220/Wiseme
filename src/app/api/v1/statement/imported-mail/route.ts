import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser } from "@/lib/server/auth";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const runtime = "nodejs";

const MailRefSchema = z.object({
  emailAccountId: z.string().min(1),
  uid: z.number().int().min(1),
  hash: z.string().min(16).max(128).optional(),
});

function buildMailImportNote(mail: z.infer<typeof MailRefSchema>) {
  return `email:${mail.emailAccountId}:${mail.uid}`;
}

function normalizeHash(value?: string | null) {
  const hash = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{32,128}$/.test(hash) ? hash : "";
}

function parseBatchRawText(rawText?: string | null) {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText) as { mailHash?: string };
  } catch {
    return null;
  }
}

/**
 * POST /api/v1/statement/imported-mail
 *
 * Body: { mails: [{ emailAccountId, uid, hash? }] }
 * Response: { ok: true, imported: [{ emailAccountId, uid, hash?, importBatchId, createdAt }] }
 *
 * Used by credit-card email bill import to mark messages that were already imported.
 * `hash` is an envelope-level fallback; the import endpoint also checks statement content fingerprints.
 */
export async function POST(req: Request) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "未授权" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = z.object({ mails: z.array(MailRefSchema).max(100) }).safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "INVALID_MAILS", error: "mails 格式不正确" }, { status: 400 });
  }

  const { householdId } = await getHouseholdScope();
  const mails = parsed.data.mails.map((mail) => ({ ...mail, hash: normalizeHash(mail.hash) }));
  const notes = Array.from(new Set(mails.map(buildMailImportNote)));
  const hashes = Array.from(new Set(mails.map((mail) => mail.hash).filter(Boolean)));
  const or: any[] = [];
  if (notes.length > 0) or.push({ note: { in: notes } });
  for (const hash of hashes) {
    or.push({ rawText: { contains: `"mailHash":"${hash}"` } });
  }
  if (or.length === 0) {
    return NextResponse.json({ ok: true, imported: [] });
  }

  const batches = await prisma.importBatch.findMany({
    where: {
      householdId,
      source: "credit_bill_mail",
      OR: or,
    },
    select: {
      id: true,
      note: true,
      rawText: true,
      createdAt: true,
    },
  });

  const imported = mails.flatMap((mail) => {
    const note = buildMailImportNote(mail);
    const batch = batches.find((item) => {
      if (item.note === note) return true;
      const raw = parseBatchRawText(item.rawText);
      return Boolean(mail.hash && normalizeHash(raw?.mailHash) === mail.hash);
    });
    if (!batch) return [];
    return [{
      emailAccountId: mail.emailAccountId,
      uid: mail.uid,
      hash: mail.hash || undefined,
      importBatchId: batch.id,
      createdAt: batch.createdAt.toISOString(),
    }];
  });

  return NextResponse.json({ ok: true, imported });
}
