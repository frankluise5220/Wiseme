#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const entrypoint = fs.readFileSync(path.join(root, "scripts", "docker-entrypoint.sh"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker-build.yml"), "utf8");
const systemUpdateRoute = fs.readFileSync(path.join(root, "src", "app", "api", "v1", "settings", "system-update", "route.ts"), "utf8");
const updaterServer = fs.readFileSync(path.join(root, "scripts", "mmh-updater-server.mjs"), "utf8");
const failures = [];

function expect(condition, message) {
  if (!condition) failures.push(message);
}

expect(
  /'consumer'::\\"LoanType\\"/.test(entrypoint) && /'home'::\\"LoanType\\"/.test(entrypoint),
  "Docker Account.loanType backfill must cast CASE branches to the PostgreSQL LoanType enum.",
);

expect(
  /"kind\\" = 'loan'::\\"AccountKind\\"/.test(entrypoint) && /"kind\\" = 'settlement'::\\"AccountKind\\"/.test(entrypoint),
  "Docker account-kind compatibility updates must cast AccountKind enum values explicitly.",
);

expect(
  /"institutionId\\" = NULL/.test(entrypoint) &&
    /WHERE \\"kind\\" = 'loan'::\\"AccountKind\\" AND \\"counterpartyId\\" IS NOT NULL/.test(entrypoint),
  "Docker settlement-account cleanup must normalize every legacy counterparty loan account and clear institution links.",
);

expect(
  /npm run check:docker/.test(workflow),
  "Docker image workflow must run check:docker before publishing images.",
);

expect(
  /\/releases\/latest/.test(systemUpdateRoute) &&
    /git ls-remote --tags/.test(systemUpdateRoute) &&
    /IMAGE_FALLBACK_ORDER = \["fnvps", "dockerproxy", "nju", "ghcr", "daocloud", "custom"\]/.test(systemUpdateRoute) &&
    !/raw\.githubusercontent\.com\/frankluise5220\/MMH\/main\/package\.json/.test(systemUpdateRoute) &&
    !/refs\/heads\/main/.test(systemUpdateRoute),
  "Docker update version checks must use the latest GitHub Release/tag and image mirrors, not the main branch.",
);

expect(
  /const autoImageSourceOrder = \["fnvps", "dockerproxy", "nju", "ghcr", "daocloud"\]/.test(updaterServer) &&
  updaterServer.indexOf("if [ -f /updater/deploy/docker-compose.yml ]; then") >= 0 &&
    updaterServer.indexOf("git -C ${quotedWorkdir} pull --ff-only;") >
      updaterServer.indexOf("if [ -f /updater/deploy/docker-compose.yml ]; then"),
  "Docker updater must prefer release-bundled deploy files before falling back to git pull.",
);

if (failures.length > 0) {
  console.error("Docker entrypoint check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Docker entrypoint check passed.");
