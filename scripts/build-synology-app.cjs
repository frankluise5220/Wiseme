#!/usr/bin/env node

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const nativeSchema = path.join(root, "prisma", "schema.native.prisma");
const pgSchema = path.join(root, "prisma", "schema.prisma");

function run(command, args, env) {
  const useShell = process.platform === "win32" && (command === "npm" || command === "npx");
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: useShell,
    env: {
      ...process.env,
      ...env,
    },
  });
  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status || 1);
  }
}

run(process.execPath, [path.join(root, "scripts", "generate-native-sqlite-schema.cjs")], {});
run("npx", ["prisma", "generate", "--schema", nativeSchema], {
  DATABASE_URL: "file:./native-build.db",
  PRISMA_SCHEMA_PATH: nativeSchema,
});
run("npm", ["run", "build"], {
  DATABASE_URL: "file:./native-build.db",
  PRISMA_SCHEMA_PATH: nativeSchema,
  MMH_DEPLOY_TARGET: "synology",
});
run("npx", ["prisma", "generate", "--schema", pgSchema], {});
