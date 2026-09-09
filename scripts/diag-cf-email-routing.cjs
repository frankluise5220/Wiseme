/**
 * Diagnostic: inspect Cloudflare Email Routing for a zone via the Cloudflare API.
 *
 * Setup — put the token in .env.local (gitignored), never inline it here:
 *   CLOUDFLARE_API_TOKEN=xxxxxxxx
 * Token permissions needed: Zone / Email Routing Rules / Read,
 *                           Zone / Email Routing Addresses / Read
 *
 * Usage:
 *   node scripts/diag-cf-email-routing.cjs [--zone=floatingice.win]
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

const ZONE = args.zone || "floatingice.win";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || "";
const BASE = "https://api.cloudflare.com/client/v4";

async function cfGet(url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, status: res.status, raw: text.slice(0, 500) };
  }
  return { ok: res.ok && json.success, status: res.status, json };
}

(async () => {
  if (!TOKEN) {
    console.log("MISSING_TOKEN — 请在 .env.local 中设置 CLOUDFLARE_API_TOKEN=... 后重试");
    process.exit(1);
  }

  const zones = await cfGet(`${BASE}/zones?name=${encodeURIComponent(ZONE)}`);
  if (!zones.ok || !zones.json || !zones.json.result || zones.json.result.length === 0) {
    console.log("ZONE_LOOKUP_FAILED status:", zones.status);
    if (zones.json && zones.json.errors) console.log(JSON.stringify(zones.json.errors, null, 2));
    if (zones.raw) console.log(zones.raw);
    process.exit(1);
  }
  const zone = zones.json.result[0];
  console.log(`zone: ${zone.name}  id=${zone.id}  status=${zone.status}`);

  const rules = await cfGet(`${BASE}/zones/${zone.id}/email/routing/rules?per_page=100`);
  console.log("\n=== Routing rules ===");
  if (!rules.ok) {
    console.log("查询失败 status:", rules.status);
    if (rules.json && rules.json.errors) console.log(JSON.stringify(rules.json.errors, null, 2));
  } else {
    const list = rules.json.result || [];
    if (list.length === 0) console.log("(没有任何转发规则)");
    for (const r of list) {
      const matchers = (r.matchers || []).map((m) => `${m.field}=${m.value}`).join(" & ");
      const actions = (r.actions || []).map((a) => `${a.type}:${(a.value || []).join(",")}`).join(" | ");
      console.log(`- [${r.enabled ? "enabled" : "DISABLED"}] ${r.name}  match(${matchers}) -> ${actions}`);
    }
  }

  console.log("\n=== Catch-all ===");
  const catchAll = await cfGet(`${BASE}/zones/${zone.id}/email/routing/rules/catch_all`);
  if (!catchAll.ok) {
    console.log("(未设置 catch-all，或查询失败) status:", catchAll.status);
  } else {
    const c = catchAll.json.result || {};
    const actions = (c.actions || []).map((a) => `${a.type}:${(a.value || []).join(",")}`).join(" | ");
    console.log(`- [${c.enabled ? "enabled" : "DISABLED"}] ${c.name || "(catch-all)"} -> ${actions || "(无动作)"}`);
  }

  console.log("\n=== Destination addresses ===");
  const addrs = await cfGet(`${BASE}/zones/${zone.id}/email/routing/addresses?per_page=100`);
  if (!addrs.ok) {
    console.log("查询失败 status:", addrs.status);
    if (addrs.json && addrs.json.errors) console.log(JSON.stringify(addrs.json.errors, null, 2));
  } else {
    const list = addrs.json.result || [];
    if (list.length === 0) console.log("(没有已配置的目标邮箱)");
    for (const a of list) {
      const verified = a.verified ? "verified" : "NOT VERIFIED";
      console.log(`- ${a.email}  [${verified}]  created=${a.created || "-"}`);
    }
  }

  console.log("\n=== 判定 ===");
  const list = (rules.ok && rules.json && rules.json.result) || [];
  const hasMmh = list.some(
    (r) =>
      r.enabled &&
      (r.matchers || []).some((m) => m.field === "to" && String(m.value).toLowerCase() === `mmh@${ZONE}`.toLowerCase())
  );
  const catchAllOk =
    catchAll.ok && catchAll.json && catchAll.json.result && catchAll.json.result.enabled === true;
  if (hasMmh) {
    console.log(`OK：存在 mmh@${ZONE} 的启用规则，550 应该是旧缓存，可重新发信验证。`);
  } else if (catchAllOk) {
    console.log(`OK：catch-all 已启用，mmh@${ZONE} 应可被接收。`);
  } else {
    console.log(`未生效：Cloudflare 侧没有 mmh@${ZONE} 的启用规则，且 catch-all 未启用 —— 这就是 550 5.1.1 的原因。`);
  }
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
