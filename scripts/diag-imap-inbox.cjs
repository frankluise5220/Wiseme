/**
 * Diagnostic: list recent messages in the account inbox so we can tell whether
 * Cloudflare Email Routing actually delivered a forwarded copy.
 * Usage: node scripts/diag-imap-inbox.cjs [--label=QQ邮箱] [--limit=15]
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
const limit = Number(args.limit) || 15;

const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");
const prisma = new PrismaClient({
  log: ["error"],
  adapter: new PrismaPg(new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })),
});

(async () => {
  const account = await prisma.emailAccount.findFirst({ where: { label: args.label || "QQ邮箱" } });
  if (!account) return console.log("NO_ACCOUNT");

  console.log("imap:", account.imapHost, account.imapPort, "secure:", account.imapSecure, "box:", account.mailbox || "INBOX");

  const { ImapFlow } = require("imapflow");
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: account.username, pass: account.password },
    logger: false,
  });

  await client.connect();
  const box = account.mailbox || "INBOX";
  const lock = await client.getMailboxLock(box);
  try {
    if (args.uid) {
      const { simpleParser } = require("mailparser");
      let uids;
      if (args.uid === "search") {
        uids = await client.search({ subject: args.subject || "退信" });
      } else {
        uids = [Number(args.uid)];
      }
      console.log("target uids:", JSON.stringify(uids));
      let count = 0;
      for (const one of uids) {
        for await (const msg of client.fetch(String(one), { uid: true, source: true, envelope: true })) {
        count += 1;
        const parsed = await simpleParser(msg.source);
        console.log("=== uid", msg.uid, "===");
        console.log("subject:", (msg.envelope && msg.envelope.subject) || "");
        console.log("date   :", parsed.date ? parsed.date.toISOString() : "");
        const plain = (parsed.text || "").trim();
        const html = (parsed.html || "")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/(p|div|tr|td)>/gi, "\n")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        console.log("--- body ---");
        console.log((plain || html || "(empty)").slice(0, 4000));
        if (parsed.attachments && parsed.attachments.length) {
          console.log("--- attachments ---");
          for (const a of parsed.attachments) console.log(a.filename, a.contentType, a.size);
        }
        }
      }
      console.log("fetched count:", count);
      lock.release();
      await client.logout();
      await prisma.$disconnect();
      process.exit(0);
    }
    const total = client.mailbox.exists;
    console.log("total messages:", total);
    const start = Math.max(1, total - limit + 1);
    const rows = [];
    for await (const msg of client.fetch(`${start}:*`, { envelope: true, internalDate: true })) {
      rows.push(msg);
    }
    for (const msg of rows.slice(-limit)) {
      const env = msg.envelope || {};
      const from = (env.from || []).map((a) => a.address).join(",");
      const to = (env.to || []).map((a) => a.address).join(",");
      console.log(
        [String(msg.uid), (msg.internalDate || "").toISOString().slice(0, 19), `from=${from}`, `to=${to}`, `subj=${env.subject || ""}`].join(" | ")
      );
    }
  } finally {
    lock.release();
    await client.logout();
  }
  await prisma.$disconnect();
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
