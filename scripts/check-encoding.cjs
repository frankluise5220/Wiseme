#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const root = process.cwd();
const includeRoots = ["src", "docs", "scripts", "prisma"];
const includeFiles = new Set(["AGENTS.md", "package.json", "tsconfig.json", "next.config.ts", "next.config.js"]);
const includeExts = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".cjs",
  ".mjs",
  ".json",
  ".md",
  ".css",
  ".sql",
  ".prisma",
  ".sh",
  ".yml",
  ".yaml",
  ".txt",
]);

const skipDirs = new Set([
  "node_modules",
  ".next",
  ".git",
  "coverage",
  "dist",
  "build",
  "tmp",
  "temp",
]);

const skipMojibakeScanFiles = new Set([
  "scripts/check-encoding.cjs",
]);

const mojibakePatterns = [
  "锟",
  "烫",
  "鈥",
  "缃",
  "粶",
  "閿",
  "欒",
  "",
  "瀵",
  "璇",
  "楠",
  "岃",
  "瘉",
  "閫",
  "氳",
  "繃",
  "鎴",
  "璐",
  "鍗",
];

function walk(dir, files) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, files);
      continue;
    }
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    if (includeFiles.has(entry.name) || includeExts.has(path.extname(entry.name).toLowerCase())) {
      files.push({ abs, rel });
    }
  }
}

function collectFiles() {
  const files = [];
  for (const relRoot of includeRoots) {
    const absRoot = path.join(root, relRoot);
    if (fs.existsSync(absRoot) && fs.statSync(absRoot).isDirectory()) {
      walk(absRoot, files);
    }
  }
  for (const file of includeFiles) {
    const abs = path.join(root, file);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      files.push({ abs, rel: file });
    }
  }
  const seen = new Set();
  return files.filter((file) => {
    if (seen.has(file.rel)) return false;
    seen.add(file.rel);
    return true;
  });
}

function checkUtf8(buffer) {
  const text = buffer.toString("utf8");
  const roundTrip = Buffer.from(text, "utf8");
  return roundTrip.equals(buffer);
}

function hasUtf8Bom(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
}

function main() {
  const files = collectFiles();
  const issues = [];

  for (const file of files) {
    const buffer = fs.readFileSync(file.abs);
    const text = buffer.toString("utf8");

    if (!checkUtf8(buffer)) {
      issues.push({ file: file.rel, type: "encoding", detail: "not valid UTF-8" });
      continue;
    }

    if (hasUtf8Bom(buffer)) {
      issues.push({ file: file.rel, type: "bom", detail: "starts with UTF-8 BOM; strip it before committing" });
    }

    if (text.includes("\r\n")) {
      issues.push({ file: file.rel, type: "line-ending", detail: "contains CRLF" });
    }

    if (!skipMojibakeScanFiles.has(file.rel)) {
      for (const pattern of mojibakePatterns) {
        if (text.includes(pattern)) {
          issues.push({ file: file.rel, type: "mojibake", detail: `contains suspicious text: ${pattern}` });
          break;
        }
      }
    }
  }

  if (issues.length === 0) {
    console.log(`OK: checked ${files.length} files, no encoding issues found.`);
    process.exit(0);
  }

  console.error(`Found ${issues.length} encoding issue(s):`);
  for (const issue of issues) {
    console.error(`- [${issue.type}] ${issue.file} :: ${issue.detail}`);
  }
  process.exit(1);
}

main();
