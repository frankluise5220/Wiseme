#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const file = "src/components/TransactionFormModal.tsx";
const source = fs.readFileSync(path.join(root, file), "utf8");
const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = new Set(["onSubmit", "submitForm", "saveTransaction", "repeatDraft"]);
const declarations = [];
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) {
    declarations.push(node.getText(ast));
    return;
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert.equal(declarations.length, 4, "Find the production submit/draft handlers");
const code = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

// Execute the production handlers with deferred I/O and uncommitted React state.
// Two events can arrive before a render: state alone cannot serialize them.
function harness() {
  const calls = [];
  const alerts = [];
  const refreshes = [];
  let pending = false;
  let resets = 0;
  let focused = false;
  const context = {
    FormData,
    open: true,
    submitting: false,
    submittingRef: { current: false },
    txType: "transfer",
    editEntryId: null,
    editEntryOriginalType: null,
    editEntryHasFundDetail: false,
    editOriginalRef: { current: null },
    isCreditCardAccount: false,
    fromAccountId: "source-id",
    toAccountId: "destination-id",
    defaultAccountId: "source-id",
    date: "2026-09-05",
    amount: "12.34",
    note: "Repeated transfer",
    counterpartyInstitutionId: "institution-id",
    fixedAssetLinked: false,
    fixedAssetAccountId: "",
    selectedTagIds: ["tag-id"],
    pendingAttachmentFiles: [],
    requestId: null,
    openSpecialTransferTargetIfNeeded: () => false,
    dialogAmountToStoredAmount: (_type, amount) => Number(amount),
    t: (key) => key,
    window: { alert: (message) => alerts.push(message) },
    requestAnimationFrame: (callback) => callback(),
    dispatchFinanceDataChanged: (detail) => refreshes.push(detail),
    currentFinanceRefreshDetail: () => ({ accountIds: [context.fromAccountId, context.toAccountId] }),
    setSubmitting: (value) => { pending = value; },
    setOpen: (value) => { context.open = value; },
    resetDraft: () => { resets += 1; },
    focusAmountInput: () => { focused = true; },
    action: (data) => new Promise((resolve, reject) => {
      calls.push({ data: Object.fromEntries(data), resolve, reject });
    }),
  };
  for (const field of [
    "amount", "fxToAmount", "fxRate", "fxFeeAmount", "createInstallment",
    "installmentAmount", "installmentAmountEdited", "fixedAssetLinked",
    "fixedAssetAccountId", "fixedAssetAssetId", "fixedAssetLinkLocked",
    "fixedAssetAccountNestedOpen", "fixedAssetAccountAutoOpen", "pendingAttachmentFiles",
    "requestId", "editEntryId", "editEntryOriginalType", "editEntryHasFundDetail",
    "editOriginalTransferAccounts", "fromAccountId",
  ]) {
    context[`set${field[0].toUpperCase()}${field.slice(1)}`] = (value) => { context[field] = value; };
  }
  vm.createContext(context);
  vm.runInContext(code, context, { filename: file });
  return {
    context, calls, alerts, refreshes,
    get pending() { return pending; },
    get resets() { return resets; },
    get focused() { return focused; },
    submit(mode = "repeat") {
      return context.submitForm({}, mode);
    },
  };
}

test("repeat saves once when two events arrive before React renders", async () => {
  const h = harness();
  const first = h.submit();
  const second = h.submit();
  h.calls.forEach((call) => call.resolve({ ok: true }));
  await Promise.all([first, second]);
  assert.equal(h.context.open, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.resets, 0);
  assert.equal(h.pending, false);
});

test("a close submission cannot override an in-flight repeat", async () => {
  const h = harness();
  const first = h.submit();
  const second = h.submit("close");
  h.calls.forEach((call) => call.resolve({ ok: true }));
  await Promise.all([first, second]);
  assert.equal(h.context.open, true);
  assert.equal(h.calls.length, 1);
});

test("success preserves transfer defaults and refreshes both accounts across repeated saves", async () => {
  const h = harness();
  for (const amount of ["12.34", "56.78", "90.12"]) {
    h.context.amount = amount;
    const save = h.submit();
    const call = h.calls.at(-1);
    assert.equal(call.data.amount, amount);
    assert.equal(call.data.fromAccountId, "source-id");
    assert.equal(call.data.toAccountId, "destination-id");
    assert.equal(call.data.date, "2026-09-05");
    assert.equal(call.data.note, "Repeated transfer");
    call.resolve({ ok: true });
    await save;
    assert.equal(h.context.open, true);
    assert.equal(h.context.amount, "");
    assert.equal(h.context.note, "Repeated transfer");
    assert.equal(h.focused, true);
  }
  assert.equal(h.refreshes.length, 3);
  assert.deepEqual(h.refreshes[0].accountIds, ["source-id", "destination-id"]);
});

test("ordinary save still closes", async () => {
  const h = harness();
  const save = h.submit("close");
  h.calls[0].resolve({ ok: true });
  await save;
  assert.equal(h.context.open, false);
  assert.equal(h.resets, 1);
});

for (const failure of ["response", "exception"]) {
  test(`${failure} keeps the draft and releases the lock for retry`, async () => {
    const h = harness();
    const save = h.submit();
    if (failure === "response") h.calls[0].resolve({ ok: false, error: "Save failed" });
    else h.calls[0].reject(new Error("Save failed"));
    await save;
    assert.equal(h.context.open, true);
    assert.equal(h.context.amount, "12.34");
    assert.equal(h.pending, false);
    assert.equal(h.alerts.length, 1);
    const retry = h.submit();
    assert.equal(h.calls.length, 2);
    h.calls[1].resolve({ ok: true });
    await retry;
    assert.equal(h.context.open, true);
    assert.equal(h.context.amount, "");
  });
}

test("account validation failure permits a corrected retry", async () => {
  const h = harness();
  h.context.toAccountId = "";
  await h.submit();
  assert.equal(h.calls.length, 0);
  assert.equal(h.context.amount, "12.34");
  assert.equal(h.pending, false);
  h.context.toAccountId = "destination-id";
  const retry = h.submit();
  h.calls[0].resolve({ ok: true });
  await retry;
  assert.equal(h.context.open, true);
});
