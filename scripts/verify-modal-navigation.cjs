#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const file = path.resolve(__dirname, "../src/lib/client/useCloseOnNavigation.ts");
const source = ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness() {
  const slots = [];
  let cursor = 0;
  let effects = [];
  let location = new URL("https://example.test/?accountId=source&view=detail");
  let closeCount = 0;
  const context = {
    exports: {}, URLSearchParams,
    require(name) {
      if (name === "next/navigation") return {
        usePathname: () => location.pathname,
        useSearchParams: () => location.searchParams,
      };
      assert.equal(name, "react");
      return {
        useRef(initial) {
          const index = cursor++;
          return slots[index] ??= { current: initial };
        },
        useEffect(effect, deps) {
          const index = cursor++;
          if (!slots[index] || deps.some((dep, i) => !Object.is(dep, slots[index][i]))) {
            slots[index] = deps;
            effects.push(effect);
          }
        },
      };
    },
  };
  vm.runInNewContext(source, context, { filename: file });
  return {
    get closed() { return closeCount; },
    render(href = location.href, open = true, onClose = () => { closeCount += 1; }) {
      location = new URL(href, location);
      cursor = 0;
      effects = [];
      context.exports.useCloseOnNavigation(open, onClose);
      effects.forEach(effect => effect());
    },
  };
}

test("delayed pagination normalization after repeat does not close the dialog", async () => {
  const h = harness();
  h.render();
  h.render();
  await new Promise(resolve => setImmediate(resolve));
  h.render("?accountId=source&view=detail&pageSize=50&detailPage=1");
  h.render("?accountId=source&view=detail&pageSize=100&detailAll=1&billPage=2");
  assert.equal(h.closed, 0);
});

test("consuming entry and row-focus hints preserves the dialog", () => {
  const h = harness();
  h.render("?accountId=source&view=detail&quickEntry=1&focusEntryId=entry");
  h.render("?accountId=source&view=detail");
  assert.equal(h.closed, 0);
});

test("query ordering and equivalent URL encoding are not navigation", () => {
  const h = harness();
  h.render("?accountId=source&view=detail&filter=a%20b");
  h.render("?filter=a+b&view=detail&accountId=source");
  assert.equal(h.closed, 0);
});

for (const [name, initial, next] of [
  ["account", "?accountId=source&view=detail", "?accountId=destination&view=detail"],
  ["view", "?accountId=source&view=detail", "?accountId=source&view=bill"],
  ["bill month", "?accountId=source&view=bill&billMonth=2026-08", "?accountId=source&view=bill&billMonth=2026-09"],
  ["fund", "?fundCode=000001", "?fundCode=000002"],
  ["book", "?bookId=one", "?bookId=two"],
  ["page", "/?accountId=source", "/settings/accounts"],
  ["other filters", "?tagId=one", "?tagId=two"],
]) {
  test(`changing ${name} still closes the dialog once`, () => {
    const h = harness();
    h.render(initial);
    h.render(next);
    h.render(next);
    assert.equal(h.closed, 1);
  });
}

test("navigation while closed does not close a subsequently opened dialog", () => {
  const h = harness();
  h.render(undefined, false);
  h.render("?accountId=destination", false);
  h.render(undefined, true);
  assert.equal(h.closed, 0);
});

test("navigation uses the latest close callback", () => {
  const h = harness();
  let latestCalls = 0;
  h.render();
  h.render("?accountId=destination", true, () => { latestCalls += 1; });
  assert.equal(h.closed, 0);
  assert.equal(latestCalls, 1);
});
