const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const cache = new Map();
let baseCurrency = "CNY";
let fxQueries = 0;
const accounts = [
  { id: "usd", currency: "USD" },
  { id: "cny", currency: "CNY" },
  { id: "jpy", currency: "JPY" },
  { id: "missing", currency: "XYZ" },
];
const rates = [
  { baseCurrency: "USD", quoteCurrency: "CNY", rate: 6, rateDate: new Date("2025-01-01"), updatedAt: new Date("2025-01-01") },
  { baseCurrency: "CNY", quoteCurrency: "USD", rate: 0.125, rateDate: new Date("2026-09-01"), updatedAt: new Date("2026-09-01") },
  { baseCurrency: "JPY", quoteCurrency: "CNY", rate: 0.05, rateDate: new Date("2026-09-01"), updatedAt: new Date("2026-09-01") },
];
const records = [
  { id: "salary", type: "income", accountId: "usd", amount: 100 },
  { id: "expense", type: "expense", accountId: "usd", amount: -20 },
  { id: "refund", type: "expense", accountId: "usd", amount: 5 },
  { id: "local", type: "income", accountId: "cny", amount: 30 },
  { id: "jpy-expense", type: "expense", accountId: "jpy", amount: -1000 },
  { id: "unknown", type: "income", accountId: "missing", amount: 99999 },
].map((row) => ({ ...row, date: new Date("2025-02-01"), createdAt: new Date("2025-02-01"), accountName: row.accountId, categoryId: row.type, EntryTag: [] }));
const prisma = {
  household: { findUnique: async () => ({ baseCurrency }) },
  account: { findMany: async ({ where }) => {
    assert.equal(where.householdId, "book");
    return accounts.filter((account) => !where.id || where.id.in.includes(account.id));
  } },
  category: { findMany: async () => [
    { id: "income", type: "income", name: "Salary", parentId: null },
    { id: "expense", type: "expense", name: "Shopping", parentId: null },
  ] },
  txRecord: { findMany: async ({ where }) => where.type ? [] : records },
  fxRate: { findFirst: async ({ where, orderBy }) => {
    fxQueries++;
    assert.equal(where.householdId, "book");
    assert.deepEqual(orderBy, [{ rateDate: "desc" }, { updatedAt: "desc" }]);
    return rates.filter((row) => where.OR.some((pair) => row.baseCurrency === pair.baseCurrency && row.quoteCurrency === pair.quoteCurrency))
      .sort((a, b) => b.rateDate - a.rateDate || b.updatedAt - a.updatedAt)[0] ?? null;
  } },
  fxConversion: { findFirst: async () => null },
};

// Execute the real TypeScript modules against a read-only database fixture.
function load(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const localRequire = (id) => {
    if (id === "@/lib/db/prisma") return { prisma };
    if (id === "@/lib/server/household-scope") return { getHouseholdScope: async () => ({ householdId: "book", hidFilter: { householdId: "book" } }) };
    if (id === "@/lib/server/investment-statistic-sources") return { loadFundStatisticSourceEntries: async () => [], loadWealthStatisticSourceEntries: async () => [] };
    if (id === "@/lib/server/statistics-fund-display") return { buildStatisticsFundDisplayResolver: async () => () => ({ fundCode: "", fundName: "" }) };
    if (id === "@/lib/default-categories") return { normalizeDefaultCategoryHierarchyForHousehold: async () => {} };
    if (id === "@/lib/server/i18n") return { getServerT: async () => (key) => key };
    if (id.startsWith("@/")) return load(path.join(root, "src", `${id.slice(2)}.ts`));
    return require(id);
  };
  new Function("require", "module", "exports", compiled)(localRequire, module, module.exports);
  return module.exports;
}

async function main() {
  global.fetch = async () => { throw new Error("Statistics must not request external rates"); };
  const { buildStatisticsCurrencyConverter } = load(path.join(root, "src/lib/server/statistics-currency.ts"));
  const fx = await buildStatisticsCurrencyConverter("book", records);
  assert.equal(fx.convert(records[0], 100), 800, "latest inverse rate overrides older direct rate");
  assert.equal(fx.convert(records[0], -20), -160, "preserve cash-flow sign");
  assert.equal(fx.convert(records[4], 1000), 50);
  assert.equal(fx.convert(records[5], 1000), null);
  assert.deepEqual(fx.missingFxCurrencies, ["XYZ"]);
  assert.equal(fxQueries, 3, "one FX query per foreign currency, not per transaction");
  assert.equal(fx.convert({ accountId: "usd", currency: "CNY" }, 100), 800, "account ID owns currency for legacy records");
  const original = [{ amount: 12, label: "profit" }];
  assert.equal(fx.convertItems(records[0], original)[0].amount, 96);
  assert.equal(original[0].amount, 12, "conversion cannot mutate source amounts");

  const { getIncomeExpenseReport } = load(path.join(root, "src/lib/server/income-expense-report.ts"));
  const report = await getIncomeExpenseReport({ householdId: "book", hidFilter: { householdId: "book" } }, {
    start: "2025-01-01", end: "2025-12-31", groupBy: "month", detail: { type: "net" },
  });
  assert.equal(report.income.total, 830);
  assert.equal(report.expense.total, 170);
  assert.equal(report.netTotal, 660);
  assert.equal(report.details.total, 660);
  assert.equal(report.details.rows.length, 5);
  assert.equal(report.income.rows[0].total, 830);
  assert.equal(report.expense.periodTotals[1], 170);
  assert.deepEqual(report.missingFxCurrencies, ["XYZ"]);

  const { GET } = load(path.join(root, "src/app/api/v1/statistics/route.ts"));
  const response = await GET({ nextUrl: new URL("http://localhost/api/v1/statistics?year=2025") });
  const { data, error } = await response.json();
  assert.equal(response.status, 200, error);
  assert.equal(data.totalIncome, 830);
  assert.equal(data.totalExpense, 170);
  assert.equal(data.totalNet, report.netTotal);
  assert.equal(data.incomeCategories[0].value, 830);

  baseCurrency = "USD";
  const usd = await buildStatisticsCurrencyConverter("book", records);
  assert.equal(usd.convert(records[0], 100), 100);
  assert.equal(usd.convert(records[3], 80), 10);
  rates[1].rate = 0.1;
  const updated = await buildStatisticsCurrencyConverter("book", records);
  assert.equal(updated.convert(records[3], 80), 8, "next query reads the updated stored rate");
  console.log("PASS: latest/inverse FX, multiple currencies, refunds, missing rates, report/detail/API totals, base-currency changes, fresh reads, immutable inputs.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
