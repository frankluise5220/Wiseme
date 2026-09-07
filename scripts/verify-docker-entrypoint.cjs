#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const entrypoint = fs.readFileSync(path.join(root, "scripts", "docker-entrypoint.sh"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "docker-build.yml"), "utf8");
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

if (failures.length > 0) {
  console.error("Docker entrypoint check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Docker entrypoint check passed.");
