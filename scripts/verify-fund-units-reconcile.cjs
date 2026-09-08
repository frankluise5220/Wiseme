#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const Module = require("node:module");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const scratch = fs.mkdtempSync(path.join(root, "_tmp_fund_reconcile_"));
const schemaPath = path.join(scratch, "schema.prisma");
const dbPath = path.join(scratch, "probe.db");
const env = { ...process.env, DATABASE_URL: `file:${dbPath.replaceAll("\\", "/")}`, PRISMA_SCHEMA_PATH: schemaPath };
const originalLoad = Module._load;
let prisma;
let blocker;

function checkDialog() {
  const file = "src/components/FundUnitsReconcileButton.tsx";
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let submit;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "submit") submit = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(submit);
  const calls = [];
  const state = { error: "", submitting: false, refreshes: 0 };
  const context = {
    parsedActualUnits: 7777, actualUnits: "7777", date: "2026-09-05", note: "Keep this note",
    accountId: "fund", fundCode: "159941", fundName: "Probe fund", submittingRef: { current: false },
    setSubmitting: (value) => { state.submitting = value; },
    setError: (value) => { state.error = value; }, setInfo() {}, t: (key) => key,
    dispatchFinanceDataChanged: () => { state.refreshes++; },
    fetch: (_url, options) => new Promise((resolve) => { calls.push({ options, resolve }); }),
  };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(submit, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return (async () => {
    const first = context.submit();
    const duplicate = context.submit();
    assert.equal(calls.length, 1, "A second click cannot submit before React rerenders");
    calls[0].resolve({ ok: false, json: async () => ({ ok: false, code: "FUND_UNITS_RECONCILE_BUSY", error: "Internal error" }) });
    await Promise.all([first, duplicate]);
    assert.equal(state.error, "fundUnitsReconcile.busy");
    assert.equal(state.submitting, false);
    assert.equal(context.submittingRef.current, false);
    assert.equal(context.actualUnits, "7777");
    assert.equal(context.note, "Keep this note");
    assert.equal(context.date, "2026-09-05");
    assert.equal(state.refreshes, 0);
    const retry = context.submit();
    assert.equal(calls.length, 2);
    assert.deepEqual(JSON.parse(calls[1].options.body), JSON.parse(calls[0].options.body));
    calls[1].resolve({ ok: false, json: async () => ({ ok: false, error: "Private database error" }) });
    await retry;
    assert.equal(state.error, "fundUnitsReconcile.failed");
    console.log("PASS: dialog prevents duplicate submits, localizes errors, and preserves the draft for retry");
  })();
}

async function main() {
  // Generate a separate SQLite client and schema. Never regenerate the app client or use its database.
  const schema = fs.readFileSync(path.join(root, "prisma/schema.native.prisma"), "utf8")
    .replace('provider = "prisma-client-js"', 'provider = "prisma-client-js"\n  output = "./client"');
  fs.writeFileSync(schemaPath, schema, "utf8");
  const cli = path.join(root, "node_modules/prisma/build/index.js");
  execFileSync(process.execPath, [cli, "generate"], { cwd: root, env, stdio: "pipe" });
  const sql = execFileSync(process.execPath, [cli, "migrate", "diff", "--from-empty", "--to-schema", schemaPath, "--script"], { cwd: root, env, encoding: "utf8", stdio: "pipe" });
  const db = new (require("better-sqlite3"))(dbPath);
  db.exec(sql);
  db.close();
  const { PrismaClient, Prisma } = require(path.join(scratch, "client"));
  require("tsx/cjs");
  const { PrismaBetterSqlite3WithSafeRollback } = require(path.join(root, "src/lib/db/sqlite-adapter.ts"));
  prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3WithSafeRollback({ url: env.DATABASE_URL }) });
  const tsxLoad = Module._load;
  const logs = [];
  // Only replace request context, cache invalidation, logging, and the database instance.
  // The route, reconciliation writes, and canonical holding calculations run unchanged.
  Module._load = function (id, parent, isMain) {
    if (id === "@/lib/db/prisma") return { prisma };
    if (id === "@/lib/server/household-scope") return {
      getHouseholdScope: async () => ({ householdId: "probe-household", hidFilter: { householdId: "probe-household" } }),
    };
    if (id === "@/lib/server/revalidate") return { revalidateAfterInvestChange() {} };
    if (id === "@/lib/logger") return { logger: {
      warn: (...args) => logs.push(args),
      error: (...args) => logs.push(args),
    } };
    return tsxLoad.call(this, id, parent, isMain);
  };
  const { POST } = require(path.join(root, "src/app/api/v1/fund/units-reconcile/route.ts"));
  const { recalcFundPositions } = require(path.join(root, "src/lib/fund/recalcPosition.ts"));
  const { translate } = require(path.join(root, "src/lib/i18n-core.ts"));
  const translations = ["zh-CN", "en-US", "ja-JP"].map((language) => translate(language, "fundUnitsReconcile.busy"));
  assert.equal(new Set(translations).size, 3, "Each locale must supply its own busy message");
  assert.ok(translations.every((value) => value !== "fundUnitsReconcile.busy"));
  const transaction = prisma.$transaction.bind(prisma);
  await prisma.household.create({ data: { id: "probe-household", name: "Probe" } });
  await prisma.accountGroup.create({ data: { id: "probe-group", householdId: "probe-household", name: "Probe" } });
  await prisma.account.create({ data: {
    id: "probe-fund", householdId: "probe-household", name: "Probe fund", groupId: "probe-group",
    kind: "investment", investProductType: "fund", fundUnitsDecimals: 2,
  } });
  const buy = await prisma.fundTransaction.create({ data: {
    householdId: "probe-household", fundAccountId: "probe-fund", fundCode: "159941",
    fundName: "Probe fund", fundProductType: "fund", fundSubtype: "buy",
    applyDate: new Date("2026-09-05T00:00:00Z"), confirmDate: new Date("2026-09-08T00:00:00Z"),
    arrivalDate: new Date("2026-09-08T00:00:00Z"), grossAmount: 5000, units: 555, nav: 9,
  } });
  const request = () => ({ json: async () => ({
    accountId: "probe-fund", fundCode: "159941", fundName: "Probe fund",
    date: "2026-09-05", actualUnits: 7777, note: "Keep this note",
  }) });
  const send = async () => {
    const response = await POST(request());
    return { response, payload: await response.json() };
  };
  async function reset() {
    prisma.$transaction = transaction;
    await prisma.entryBusinessLink.deleteMany({});
    await prisma.fundTransaction.deleteMany({ where: { id: { not: buy.id } } });
    await recalcFundPositions("probe-fund", ["159941"]);
  }
  async function verifySaved() {
    const rows = await prisma.fundTransaction.findMany({ where: { id: { not: buy.id } } });
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].units), 7222);
    assert.equal(rows[0].note, "Keep this note");
    assert.equal(rows[0].source, "fund_units_reconcile");
    assert.equal(rows[0].applyDate.toISOString(), "2026-09-05T00:00:00.000Z");
    assert.equal(await prisma.entryBusinessLink.count(), 1);
    const holding = await prisma.fundHolding.findUnique({ where: { accountId_fundCode: { accountId: "probe-fund", fundCode: "159941" } } });
    assert.equal(Number(holding.units), 7777);
    assert.equal(await prisma.txRecord.count(), 0);
    assert.equal(await prisma.fundTransactionCashFlow.count(), 0);
    const original = await prisma.fundTransaction.findUnique({ where: { id: buy.id } });
    assert.deepEqual(original, buy);
  }
  async function contend(milliseconds) {
    await reset();
    let attempts = 0;
    prisma.$transaction = async (...args) => {
      attempts++;
      if (attempts === 1) {
        let entered;
        const ready = new Promise((resolve) => { entered = resolve; });
        blocker = transaction(async () => { entered(); await delay(milliseconds); }, { timeout: milliseconds + 5000 });
        await ready;
      }
      return transaction(...args);
    };
    const result = await send();
    await blocker;
    blocker = null;
    prisma.$transaction = transaction;
    return { ...result, attempts };
  }

  let result = await send();
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.data.currentUnits, 555);
  assert.equal(result.payload.data.deltaUnits, 7222);
  await verifySaved();
  result = await send();
  assert.equal(result.payload.data.noChange, true);
  await verifySaved();
  console.log("PASS: September 5 reconciliation before September 8 arrival and repeat target");

  result = await contend(3000);
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.attempts, 1);
  await verifySaved();
  console.log("PASS: 3-second SQLite contention succeeds without a retry");

  result = await contend(11000);
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  assert.equal(result.attempts, 2);
  await verifySaved();
  console.log("PASS: initial transaction-start timeout retries once and saves exactly one reconciliation");

  result = await contend(21000);
  assert.equal(result.response.status, 503, JSON.stringify(result.payload));
  assert.equal(result.payload.code, "FUND_UNITS_RECONCILE_BUSY");
  assert.equal(result.response.headers.get("Retry-After"), "2");
  assert.equal(result.attempts, 2);
  assert.equal(await prisma.fundTransaction.count(), 1);
  assert.equal(await prisma.entryBusinessLink.count(), 0);
  assert.ok(logs.some((entry) => entry[0].includes("could not start")));
  console.log("PASS: persistent contention returns localized-error code after bounded attempts without writes");

  await reset();
  const simultaneous = await Promise.all([send(), send()]);
  assert.ok(simultaneous.every((item) => item.response.status === 200), JSON.stringify(simultaneous.map((item) => item.payload)));
  assert.equal(simultaneous.filter((item) => item.payload.data.noChange).length, 1);
  await verifySaved();
  console.log("PASS: concurrent same-target requests re-read holdings and do not double-adjust units");

  for (const committed of [false, true]) {
    await reset();
    let attempts = 0;
    const failure = new Prisma.PrismaClientKnownRequestError("Transaction API error: Unable to start a transaction in the given time.", { code: "P2028", clientVersion: "test" });
    prisma.$transaction = async (work, options) => {
      attempts++;
      await transaction(async (tx) => {
        await work(tx);
        if (!committed) throw failure;
      }, options);
      throw failure;
    };
    result = await send();
    assert.equal(result.response.status, 500);
    assert.equal(result.payload.code, "FUND_UNITS_RECONCILE_FAILED");
    assert.equal(attempts, 1, "Never replay after the transaction callback has started");
    assert.equal(await prisma.fundTransaction.count(), committed ? 2 : 1);
    assert.equal(await prisma.entryBusinessLink.count(), committed ? 1 : 0);
    prisma.$transaction = transaction;
    if (committed) {
      result = await send();
      assert.equal(result.payload.data.noChange, true);
      await verifySaved();
    }
    console.log(`PASS: ${committed ? "uncertain commit response" : "callback failure rolls back all writes"} is never retried automatically`);
  }
  await checkDialog();

  prisma.$transaction = transaction;
  await prisma.$transaction([
    prisma.accessKey.create({ data: { id: "batch-probe", name: "Probe", key: "test-fixture" } }),
    prisma.accessKey.delete({ where: { id: "batch-probe" } }),
  ]);
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.accessKey.create({ data: { id: "expired-probe", name: "Probe", key: "test-fixture" } });
    await delay(150);
    await tx.accessKey.count();
  }, { timeout: 50 }), (error) => error.code === "P2028");
  assert.equal(await prisma.accessKey.count(), 0);
  assert.equal(await prisma.$transaction((tx) => tx.accessKey.count()), 0);
  console.log("PASS: SQLite batch commit, execution-timeout rollback, and subsequent transaction remain healthy");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (blocker) await blocker.catch(() => {});
  if (prisma) await prisma.$disconnect();
  Module._load = originalLoad;
  const resolved = path.resolve(scratch);
  assert.equal(path.dirname(resolved), root);
  assert.ok(path.basename(resolved).startsWith("_tmp_fund_reconcile_"));
  fs.rmSync(resolved, { recursive: true, force: true });
});
