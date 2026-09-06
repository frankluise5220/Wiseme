import { NextRequest, NextResponse } from "next/server";
import { connectAndOpenBox, closeImap } from "@/lib/mail/imap-client";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isAdmin } from "@/lib/server/auth";
import { isValidSender } from "@/lib/mail/address";

export const runtime = "nodejs";

/**
 * POST /api/v1/settings/email-accounts/test
 * Tests the IMAP connection and SMTP sending for an email account.
 * Body: { accountId?, imapHost, imapPort, imapSecure, username, password?, mailbox?, smtpHost?, smtpPort?, smtpFrom? }
 * When modifying a saved account, pass accountId and omit password; the server
 * uses the saved authorization code of that household account for testing.
 */
export async function POST(req: NextRequest) {
  const { householdId, user } = await getHouseholdScope();
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "ADMIN_REQUIRED", error: "Administrator permission is required" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const accountId = String(body.accountId ?? "").trim();
  const imapHost = String(body.imapHost ?? "").trim();
  const imapPort = Number(body.imapPort) || 993;
  const imapSecure = body.imapSecure !== false;
  const username = String(body.username ?? "").trim();
  let password = String(body.password ?? "").trim();
  const mailbox = String(body.mailbox ?? "INBOX").trim() || "INBOX";

  if (!password && accountId) {
    const existing = await prisma.emailAccount.findFirst({
      where: { id: accountId, householdId },
      select: { password: true },
    });
    password = existing?.password ?? "";
  }

  if (!imapHost || !username || !password) {
    return NextResponse.json({ ok: false, code: "INCOMPLETE_CONFIG", error: "Complete configuration is required; new accounts need an authorization code, and edited accounts need to keep or provide one for retesting" }, { status: 400 });
  }

  const smtpFrom = String(body.smtpFrom ?? "").trim();
  if (smtpFrom && !isValidSender(smtpFrom)) {
    return NextResponse.json(
      {
        ok: false,
        code: "INVALID_SMTP_FROM",
        error: "Invalid sender address. Enter a full email address; QQ/163 usually require it to match the login account.",
      },
      { status: 400 }
    );
  }

  const results: string[] = [];

  // Test IMAP
  try {
    const client = connectAndOpenBox({ host: imapHost, port: imapPort, secure: imapSecure, user: username, password, mailbox }, []);
    const imapResult = await Promise.race([
      client,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("IMAP connection timed out")), 15000)),
    ]);
    results.push(`IMAP connected (${imapResult.mailbox})`);
    closeImap(imapResult.client);
  } catch (e) {
    results.push(`IMAP failed: ${e instanceof Error ? e.message : "Unknown error"}`);
    return NextResponse.json({ ok: false, code: "IMAP_CONNECT_FAILED", error: results.join("; ") });
  }

  // Test SMTP (optional)
  const smtpHost = String(body.smtpHost ?? "").trim();
  const smtpPort = Number(body.smtpPort) || 465;
  const smtpSecure = body.smtpSecure === undefined ? smtpPort === 465 : body.smtpSecure !== false;
  if (smtpHost && smtpFrom) {
    try {
      const nodemailer = await import("nodemailer");
      const transporter = nodemailer.createTransport({
        host: smtpHost, port: smtpPort, secure: smtpSecure,
        auth: { user: username, pass: password },
      });
      await transporter.verify();
      results.push("SMTP connected");
    } catch (e) {
      results.push(`SMTP failed: ${e instanceof Error ? e.message : "Unknown error"}`);
      return NextResponse.json({ ok: false, code: "SMTP_CONNECT_FAILED", error: results.join("; ") });
    }
  }

  return NextResponse.json({ ok: true, results });
}
