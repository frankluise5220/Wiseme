/**
 * Diagnostic: send a real test mail through a saved email account.
 * Usage:
 *   node scripts/diag-smtp-send.cjs [--to=addr] [--from=addr] [--label=name]
 * The password never leaves this script and is not printed.
 */
const path = require("path");
const fs = require("fs");

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadEnv(path.join(process.cwd(), ".env"));
loadEnv(path.join(process.cwd(), ".env.local"));

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const i = a.indexOf("=");
    return i === -1 ? [a.slice(2), "true"] : [a.slice(2, i), a.slice(i + 1)];
  })
);

const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const prisma = new PrismaClient({
  log: ["error"],
  adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })),
});

(async () => {
  const account = await prisma.emailAccount.findFirst({
    where: args.label ? { label: args.label } : { label: "QQ邮箱" },
  });
  if (!account) {
    console.log("NO_ACCOUNT");
    return;
  }

  // --fix: repair an invalid stored sender address (e.g. a typo like "f")
  // by falling back to the authenticated account address.
  if (args.fix) {
    const stored = (account.smtpFrom || "").trim();
    const storedOk = /<[^<>@\s]+@[^<>@\s]+>/.test(stored) || /^[^<>@\s]+@[^<>@\s]+$/.test(stored);
    if (!storedOk) {
      await prisma.emailAccount.update({
        where: { id: account.id },
        data: { smtpFrom: account.username },
      });
      console.log(`FIXED smtpFrom: ${JSON.stringify(stored)} -> ${account.username}`);
      account.smtpFrom = account.username;
    } else {
      console.log(`smtpFrom already valid: ${stored}`);
    }
  }

  const from = args.from || account.smtpFrom || account.username;
  const to = args.to || account.username;

  console.log("--- config ---");
  console.log("host   :", account.smtpHost);
  console.log("port   :", account.smtpPort, "secure:", account.smtpSecure);
  console.log("user   :", account.username);
  console.log("from   :", JSON.stringify(from));
  console.log("to     :", to);
  console.log("--------------");

  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    auth: { user: account.username, pass: account.password },
  });

  // Mirrors src/lib/mail/smtp.ts sendEmail(): fall back to the authenticated
  // address when the stored sender is malformed, and always pin the envelope.
  const BARE = /^[^\s@<>]+@[^\s@<>]+$/;
  const ANGLED = /<([^\s@<>]+@[^\s@<>]+)>/;
  const extract = (v) => {
    const raw = (v ?? "").trim();
    if (!raw) return null;
    const m = raw.match(ANGLED);
    const cand = m ? m[1] : raw;
    return BARE.test(cand) ? cand : null;
  };
  const fromAddress = extract(from);
  const mailFrom = fromAddress ? from : account.username;
  const envelopeFrom = fromAddress ?? extract(account.username) ?? account.username;
  console.log("mailFrom     :", JSON.stringify(mailFrom));
  console.log("envelopeFrom :", envelopeFrom, fromAddress ? "" : "(fallback)");

  try {
    const info = await transporter.sendMail({
      from: mailFrom,
      envelope: { from: envelopeFrom, to },
      to,
      subject: "[MMH] SMTP 发信诊断",
      text: "这是一封来自 MMH 的 SMTP 诊断邮件。",
    });
    console.log("RESULT: OK", info.messageId ?? "");
  } catch (e) {
    console.log("RESULT: FAILED");
    console.log("code        :", e.code ?? "-");
    console.log("responseCode:", e.responseCode ?? "-");
    console.log("message     :", e.message);
    console.log("response    :", (e.response && String(e.response).split("\n")[0]) || "-");
  }
  await prisma.$disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
