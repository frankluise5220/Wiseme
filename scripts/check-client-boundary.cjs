/**
 * Dev-only guard: find server modules that import a *function* from a
 * "use client" module and then call it. At runtime Next turns every export of a
 * "use client" module into a client reference, so calling one from the server
 * throws "Attempted to call X() from the server but X is on the client".
 *
 * Constants are fine (they are only read), so only call sites are reported.
 */
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const ROOT = path.join(PROJECT_ROOT, "src");
const ALIASES = { "@": ROOT };

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT);
const source = new Map(files.map((file) => [file, fs.readFileSync(file, "utf8")]));
const isClientModule = new Map(
  files.map((file) => [file, /^\s*["']use client["']/.test(source.get(file) ?? "")]),
);

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) return null;
  let base = specifier.startsWith("@/")
    ? path.join(ALIASES["@"], specifier.slice(2))
    : path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ];
  return candidates.find((candidate) => source.has(candidate)) ?? null;
}

/** Every module specifier a file imports, resolved to files we scanned. */
function importedFiles(file) {
  const code = source.get(file) ?? "";
  const out = [];
  const regex = /from\s+["']([^"']+)["']/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    const target = resolveImport(file, match[1]);
    if (target) out.push(target);
  }
  return out;
}

/**
 * Files reachable from a server entry (app router pages/layouts/route handlers)
 * without crossing into a "use client" module. Anything outside this set only
 * ever ships to the browser, where calling a client function is perfectly legal.
 */
function serverReachableFiles() {
  const entryName = /^(page|layout|route|template|default|error|loading|not-found)\.(tsx|ts|js|jsx)$/;
  const queue = files.filter((file) => {
    if (isClientModule.get(file)) return false;
    const relative = path.relative(PROJECT_ROOT, file).split(path.sep);
    if (!relative.includes("app")) return false;
    return entryName.test(path.basename(file));
  });
  const seen = new Set(queue);
  while (queue.length > 0) {
    const current = queue.pop();
    for (const next of importedFiles(current)) {
      // Crossing into a client module means everything below it is client bundle.
      if (isClientModule.get(next) || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

const reachable = serverReachableFiles();

const problems = [];
for (const file of files) {
  if (isClientModule.get(file)) continue; // client modules may import client helpers freely
  if (!reachable.has(file)) continue; // never evaluated on the server
  const code = source.get(file);
  // Named imports: import { a, b as c } from "..."
  const importRegex = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
  let match;
  while ((match = importRegex.exec(code)) !== null) {
    if (/^\s*type\s/.test(match[0])) continue;
    const target = resolveImport(file, match[2]);
    if (!target || !isClientModule.get(target)) continue;
    const names = match[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const alias = part.split(/\s+as\s+/);
        return { imported: alias[0].trim(), local: (alias[1] ?? alias[0]).trim() };
      });
    for (const { imported, local } of names) {
      if (!/^[A-Za-z_$][\w$]*$/.test(local)) continue;
      // Skip pure type imports.
      if (/^\s*type\s/.test(imported)) continue;
      // Called as a function somewhere in this file?
      const called = new RegExp(`(?<![\\w$.<])${local}\\s*\\(`).test(code);
      // Used as a JSX component?
      const asJsx = new RegExp(`<${local}[\\s/>]`).test(code);
      if (called && !asJsx) {
        problems.push({
          file: path.relative(PROJECT_ROOT, file),
          symbol: imported,
          from: match[2],
        });
      }
    }
  }
}

if (problems.length === 0) {
  console.log("OK: no server->client function calls found.");
} else {
  console.log(`FOUND ${problems.length} suspicious server->client function import(s):`);
  for (const problem of problems) {
    console.log(`  ${problem.file}  calls  ${problem.symbol}()  from  ${problem.from}`);
  }
  process.exitCode = 1;
}
