import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isAdmin } from "@/lib/server/auth";
import { isValidSender } from "@/lib/mail/address";

export const runtime = "nodejs";

const INVALID_SENDER_MESSAGE =
  "Invalid sender address. Enter a full email address; QQ/163 usually require it to match the login account.";

function invalidSenderResponse() {
  return NextResponse.json({ ok: false, code: "INVALID_SMTP_FROM", error: INVALID_SENDER_MESSAGE }, { status: 400 });
}

/**
 * GET /api/v1/settings/email-accounts
 * Returns all email accounts of the current household.
 */
export async function GET() {
  const { householdId } = await getHouseholdScope();
  const accounts = await prisma.emailAccount.findMany({
    where: { householdId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, label: true, username: true,
      imapHost: true, imapPort: true, imapSecure: true,
      outboundType: true, smtpHost: true, smtpPort: true, smtpFrom: true,
      mailbox: true, createdAt: true,
    },
  });
  return NextResponse.json({ ok: true, accounts });
}

/**
 * POST /api/v1/settings/email-accounts
 * Creates a new email account (SMTP outbound only).
 * Body: { label, username, imapHost, imapPort, imapSecure, smtpHost?, smtpPort?, smtpFrom?, password, mailbox? }
 */
export async function POST(req: NextRequest) {
  const { householdId, user } = await getHouseholdScope();
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "ADMIN_REQUIRED", error: "Administrator permission is required" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const label = String(body.label ?? "").trim();
  const username = String(body.username ?? "").trim();
  const imapHost = String(body.imapHost ?? "").trim();
  const imapPort = Number(body.imapPort) || 993;
  const imapSecure = body.imapSecure !== false;
  const password = String(body.password ?? "").trim();
  const mailbox = String(body.mailbox ?? "INBOX").trim() || "INBOX";

  if (!label || !username || !imapHost || !password) {
    return NextResponse.json({ ok: false, code: "MISSING_FIELDS", error: "Label, username, IMAP host, and authorization code are required" }, { status: 400 });
  }

  const smtpFromRaw = String(body.smtpFrom ?? "").trim();
  if (smtpFromRaw && !isValidSender(smtpFromRaw)) {
    return invalidSenderResponse();
  }

  const account = await prisma.emailAccount.create({
    data: {
      householdId,
      label, username, imapHost, imapPort, imapSecure,
      outboundType: "smtp",
      smtpHost: String(body.smtpHost ?? "").trim() || null,
      smtpPort: Number(body.smtpPort) || 465,
      smtpSecure: body.smtpSecure === undefined ? (Number(body.smtpPort) || 465) === 465 : body.smtpSecure !== false,
      smtpFrom: smtpFromRaw || null,
      resendApiKey: null,
      resendFrom: null,
      password, mailbox,
    },
  });

  return NextResponse.json({ ok: true, account });
}

/**
 * PUT /api/v1/settings/email-accounts
 * Updates an email account.
 * Body: { id, label?, username?, ... }
 */
export async function PUT(req: NextRequest) {
  const { householdId, user } = await getHouseholdScope();
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "ADMIN_REQUIRED", error: "Administrator permission is required" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim();
  if (!id) {
    return NextResponse.json({ ok: false, code: "MISSING_ID", error: "Missing id" }, { status: 400 });
  }

  const existing = await prisma.emailAccount.findFirst({ where: { id, householdId } });
  if (!existing) {
    return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Email account not found" }, { status: 404 });
  }

  const data: Record<string, unknown> = {};
  if (body.label !== undefined) data.label = String(body.label).trim();
  if (body.username !== undefined) data.username = String(body.username).trim();
  if (body.imapHost !== undefined) data.imapHost = String(body.imapHost).trim();
  if (body.imapPort !== undefined) data.imapPort = Number(body.imapPort) || 993;
  if (body.imapSecure !== undefined) data.imapSecure = body.imapSecure !== false;
  if (body.smtpFrom !== undefined) {
    const nextFrom = String(body.smtpFrom).trim();
    if (nextFrom && !isValidSender(nextFrom)) {
      return invalidSenderResponse();
    }
    data.smtpFrom = nextFrom;
  }
  if (body.smtpHost !== undefined) data.smtpHost = String(body.smtpHost).trim();
  if (body.smtpPort !== undefined) data.smtpPort = Number(body.smtpPort) || 465;
  if (body.smtpSecure !== undefined) data.smtpSecure = body.smtpSecure !== false;
  if (body.password !== undefined) data.password = String(body.password).trim();
  if (body.mailbox !== undefined) data.mailbox = String(body.mailbox).trim() || "INBOX";

  await prisma.emailAccount.update({ where: { id }, data });
  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/v1/settings/email-accounts
 * Deletes an email account.
 * Body: { id }
 */
export async function DELETE(req: NextRequest) {
  const { householdId, user } = await getHouseholdScope();
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "ADMIN_REQUIRED", error: "Administrator permission is required" }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "").trim();
  if (!id) {
    return NextResponse.json({ ok: false, code: "MISSING_ID", error: "Missing id" }, { status: 400 });
  }
  const existing = await prisma.emailAccount.findFirst({ where: { id, householdId } });
  if (!existing) {
    return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "Email account not found" }, { status: 404 });
  }
  await prisma.emailAccount.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
