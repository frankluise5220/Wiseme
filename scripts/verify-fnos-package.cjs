#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const failures = [];
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const verifyVersion = normalizeFnosVersion(process.env.FNOS_PACKAGE_VERSION || pkg.version || "0.1.0");
const verifyTarget = normalizeFnosTarget(process.env.FNOS_TARGET_ARCH || process.env.FNOS_TARGET || "x86");
const fnosPublicFiles = new Set([
  "apple-touch-icon.png",
  "favicon.ico",
  "sw.js",
  "branding/mmh-logo-pageflip.square.png",
  "branding/mmh-logo-pageflip-192.png",
  "branding/mmh-logo-pageflip-512.png",
]);

function expect(condition, message) {
  if (!condition) failures.push(message);
}

// Migration SQL files are executed verbatim by `prisma migrate deploy`; a
// UTF-8 BOM is parsed as an invalid statement prefix and fails every deploy
// with "syntax error at or near \ufeff". Shipping a BOM'd migration would
// break every dev/test database updated after the release.
function scanMigrationSqlForBom() {
  const migrationsDir = path.join(root, "prisma", "migrations");
  if (!fs.existsSync(migrationsDir)) return;
  for (const entry of fs.readdirSync(migrationsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sqlPath = path.join(migrationsDir, entry.name, "migration.sql");
    if (!fs.existsSync(sqlPath)) continue;
    const buffer = fs.readFileSync(sqlPath);
    if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      failures.push(`prisma/migrations/${entry.name}/migration.sql starts with a UTF-8 BOM; strip it before releasing (prisma migrate deploy would fail with "syntax error at or near \\ufeff").`);
    }
  }
}

scanMigrationSqlForBom();

function normalizeFnosTarget(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/_/g, "-");
  if (["", "x86", "x86-64", "x64", "amd64"].includes(raw)) {
    return {
      id: "x86",
      manifestArch: "x86_64",
      manifestPlatform: "x86",
      assetSuffix: "x86_64",
      stageDirName: "mmh-fpk",
      builtFpkName: fnosFpkAssetName("x86_64"),
    };
  }
  if (["arm", "arm64", "aarch64"].includes(raw)) {
    return {
      id: "arm64",
      manifestArch: "aarch64",
      manifestPlatform: "arm",
      assetSuffix: "arm64",
      stageDirName: "mmh-arm64-fpk",
      builtFpkName: fnosFpkAssetName("arm64"),
    };
  }
  failures.push(`FNOS_TARGET_ARCH must be x86 or arm64, got ${value || "(empty)"}.`);
  return {
    id: "x86",
    manifestArch: "x86_64",
    manifestPlatform: "x86",
    assetSuffix: "x86_64",
    stageDirName: "mmh-fpk",
    builtFpkName: fnosFpkAssetName("x86_64"),
  };
}

function normalizeFnosVersion(value) {
  const raw = String(value || "").trim();
  if (!raw) return "0.1.0";
  const normalized = raw
    .replace(/^refs\/tags\//, "")
    .replace(/^v(?=\d)/, "")
    .replace(/-fnos(?:$|[.-].*)?$/, "");
  if (!/^0\.1\.\d+$/.test(normalized)) {
    failures.push(`FNOS_PACKAGE_VERSION must use 0.1.x format, got ${normalized}.`);
    return "0.1.0";
  }
  return normalized;
}

function fnosFpkAssetName(assetSuffix) {
  return `mmh-fnos-v${verifyVersion}-${assetSuffix}.fpk`;
}

function read(file) {
  if (!fs.existsSync(file)) {
    failures.push(`Missing ${path.relative(root, file)}`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

function readTarEntry(archive, entry) {
  if (!fs.existsSync(archive)) return "";
  const result = spawnSync("tar", ["-xOf", archive, entry], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    failures.push(`Could not read ${entry} from ${path.relative(root, archive)}.\n${result.stderr || result.stdout || result.error?.message}`);
    return "";
  }
  return result.stdout;
}

function normalizeTarName(name) {
  return name.replace(/^\.\//, "");
}

function listTarEntries(archive) {
  if (!fs.existsSync(archive)) return [];
  const result = spawnSync("tar", ["-tzf", archive], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    failures.push(`Could not list ${path.relative(root, archive)}.\n${result.stderr || result.stdout || result.error?.message}`);
    return [];
  }
  return result.stdout.split(/\r?\n/).filter(Boolean).map(normalizeTarName);
}

function tarHasEntry(archive, entry) {
  return listTarEntries(archive).some((name) => name === entry);
}

function tarHasEntryOrChild(archive, entry) {
  const normalizedEntry = entry.replace(/\/+$/, "");
  return listTarEntries(archive).some((name) => {
    const normalizedName = name.replace(/\/+$/, "");
    return normalizedName === normalizedEntry || normalizedName.startsWith(`${normalizedEntry}/`);
  });
}

function parseTarPermission(value) {
  const chars = value.slice(1);
  let mode = 0;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const bit = 8 - index;
    if (char !== "-") mode |= 1 << bit;
  }
  return mode;
}

function tarEntryMode(archive, entry) {
  if (!fs.existsSync(archive)) return null;
  const result = spawnSync("tar", ["-tvzf", archive, entry], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    failures.push(`Could not inspect ${entry} from ${path.relative(root, archive)}.\n${result.stderr || result.stdout || result.error?.message}`);
    return null;
  }
  const line = result.stdout.split(/\r?\n/).find(Boolean);
  if (!line) return null;
  return parseTarPermission(line.split(/\s+/, 1)[0]);
}

function expectTarEntryModeAtLeast(archive, entry, requiredMode, label) {
  const mode = tarEntryMode(archive, entry);
  expect(mode !== null, `${label} must include ${entry}.`);
  if (mode === null) return;
  expect((mode & requiredMode) === requiredMode, `${label} ${entry} must include mode ${requiredMode.toString(8)}; got ${(mode & 0o777).toString(8)}.`);
}

function listFilesRelative(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  const walk = (current, base) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const relative = base ? `${base}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  };
  walk(dir, "");
  return files.sort();
}

function expectFnosPublicFiles(files, label) {
  for (const requiredFile of fnosPublicFiles) {
    expect(files.includes(requiredFile), `${label} must include ${requiredFile}.`);
  }
  for (const file of files) {
    expect(fnosPublicFiles.has(file), `${label} must not include unused public asset ${file}.`);
  }
}

function listFpkAppEntries(archive) {
  if (!fs.existsSync(archive)) return [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmh-fnos-fpk-"));
  try {
    const extract = spawnSync("tar", ["-xzf", archive, "-C", tmpDir, "app.tgz"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
      maxBuffer: 1024 * 1024,
    });
    if (extract.status !== 0) {
      failures.push(`Could not extract app.tgz from ${path.relative(root, archive)}.\n${extract.stderr || extract.stdout || extract.error?.message}`);
      return [];
    }
    return listTarEntries(path.join(tmpDir, "app.tgz"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function pngSize(file) {
  if (!fs.existsSync(file)) return null;
  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function expectPngSize(file, size) {
  const dimensions = pngSize(file);
  expect(
    dimensions?.width === size && dimensions?.height === size,
    `${path.relative(root, file)} must be a ${size}x${size} PNG.`,
  );
}

const buildScript = read(path.join(root, "scripts", "build-fnos-package.cjs"));
const appBuildScript = read(path.join(root, "scripts", "build-fnos-app.cjs"));
const schemaScript = read(path.join(root, "scripts", "generate-native-sqlite-schema.cjs"));
const fnosReleaseWorkflow = read(path.join(root, ".github", "workflows", "fnos-release.yml"));
const fnosStageWorkflow = read(path.join(root, ".github", "workflows", "fnos-stage.yml"));
const prismaConfig = read(path.join(root, "prisma.config.ts"));
const dbClient = read(path.join(root, "src", "lib", "db", "prisma.ts"));
const systemUpdateRoute = read(path.join(root, "src", "app", "api", "v1", "settings", "system-update", "route.ts"));
const systemUpdatePage = read(path.join(root, "src", "app", "(sidebar)", "settings", "system-update", "page.tsx"));
const authVerifyRoute = read(path.join(root, "src", "app", "api", "v1", "auth", "verify", "route.ts"));
const backupSource = read(path.join(root, "src", "lib", "server", "backup.ts"));
const currencySchema = read(path.join(root, "prisma", "schema.prisma"));
const currencyMigration = read(path.join(root, "prisma", "migrations", "20260903_add_currency_request_tables", "migration.sql"));
const scheduledTaskLock = read(path.join(root, "src", "lib", "server", "scheduled-task-lock.ts"));
const fundProfileSource = read(path.join(root, "src", "lib", "fund", "fundProfile.ts"));
const repositoryExample = read(path.join(root, "deploy", "fnos", "repository", "apps.example.json"));
const repositoryApiApps = read(path.join(root, "deploy", "fnos", "repository", "api", "apps"));
const fnosReadme = read(path.join(root, "deploy", "fnos", "README.md"));
const fnosPackagePlan = read(path.join(root, "docs", "fnos-package-plan.md"));
const nativeSchema = path.join(root, "prisma", "schema.native.prisma");
const stageDir = path.join(root, "release-artifacts", "fnos", verifyTarget.stageDirName);
const prismaCli = path.join(root, "node_modules", "prisma", "build", "index.js");
const nativeSchemaBackfillCalls = buildScript.match(/\n\s+applyMissingSchemaObjectsFromInitSql\(db, sqlPath\);/g) || [];
const standaloneCopyIndex = buildScript.indexOf('copyDir(standaloneAppDir, path.join(stageDir, "app", "server"))');
const standaloneEnvScrubIndex = buildScript.indexOf('for (const envFile of [".env", ".env.local", ".env.production", ".env.development"])');
const publicAssetCopyIndex = buildScript.indexOf("copyFnosPublicAssets(publicDir");
const persistedPortFileIndex = buildScript.indexOf('if [ -f "$port_file" ]; then');
const persistedEnvPortIndex = buildScript.indexOf('env_port="$(read_env_value PORT');
const fnosInitSqliteIndex = buildScript.indexOf('(cd "$SERVER_DIR" && "$NODE_BIN" "$SERVER_DIR/scripts/init-sqlite.cjs")');
const fnosPidCheckIndex = buildScript.indexOf('if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")"');

expect(/provider = "sqlite"/.test(schemaScript), "Native schema generator must switch datasource provider to sqlite.");
expect(/@db\\\./.test(schemaScript), "Native schema generator must strip PostgreSQL native column annotations.");
expect(/PRISMA_SCHEMA_PATH/.test(prismaConfig), "Prisma config must allow selecting the native schema.");
expect(/PrismaBetterSqlite3/.test(dbClient), "Database client must support the SQLite adapter.");
expect(/connectionString\.startsWith\("file:"\)/.test(dbClient), "Database client must route file: URLs to SQLite.");
expect(/FNOS_NODE_TARBALL/.test(buildScript), "fnOS package build must require an explicit Linux Node runtime input.");
expect(/FNOS_TARGET_ARCH/.test(buildScript), "fnOS package build must accept FNOS_TARGET_ARCH for multi-architecture releases.");
expect(/normalizeFnosTarget/.test(buildScript), "fnOS package build must normalize x86 and arm64 targets.");
expect(/normalizeFnosVersion/.test(buildScript), "fnOS package build must normalize Release tags into package versions.");
expect(buildScript.includes("^0\\.1\\.\\d+$"), "fnOS package build must enforce the unified 0.1.x version format.");
expect(/os_min_version=\$\{osMinVersion\}/.test(buildScript), "fnOS manifest must include os_min_version for official submission.");
expect(/function toSingleLineText\(value\)/.test(buildScript), "fnOS package build must normalize release notes into single-line manifest text.");
expect(/const manifestChangelog = toSingleLineText\(changelog\);/.test(buildScript), "fnOS package build must derive a single-line manifest changelog.");
expect(/changelog=\$\{manifestChangelog\}/.test(buildScript), "fnOS manifest must include a changelog for official submission.");
expect(/mmhReleaseNotes/.test(buildScript), "fnOS package build must copy release notes into the runtime package.json.");
expect(!/path\.join\(stageDir,\s*"wizard",\s*"install"\)/.test(buildScript), "fnOS package must not ship wizard/install; the FN soft-store client only parses that file, and shipping it makes every update wait for the service port again.");
expect(!/path\.join\(stageDir,\s*"wizard",\s*"upgrade"\)/.test(buildScript), "fnOS package must not ship wizard/upgrade; updates must not ask for the service port.");
expect(!/path\.join\(stageDir,\s*"wizard",\s*"uninstall"\)/.test(buildScript), "fnOS package must not ship wizard/uninstall; uninstall must stay non-interactive.");
expect(/path\.join\(stageDir,\s*"wizard",\s*"config"\)/.test(buildScript), "fnOS package must ship wizard/config so the service port stays editable from App Center settings without an install wizard.");
expect(/\$\{wizard_port:-\}/.test(buildScript), "fnOS settings wizard must expose wizard_port so config_callback can apply a changed port.");
expect(/write_env_file "\$NEW_PORT"/.test(buildScript), "fnOS config_callback must apply the wizard port explicitly, because resolve_port prefers the persisted .port.");
expect(/probe_free_port/.test(buildScript), "fnOS first installs must probe for a free port; without an install wizard a taken 7777 would otherwise deadlock the install.");
expect(persistedPortFileIndex !== -1 && persistedEnvPortIndex !== -1, "fnOS port resolver must reuse the persisted .port before the persisted mmh.env PORT during overlay updates.");
expect(persistedPortFileIndex < persistedEnvPortIndex, "fnOS port resolver must reuse the installed port before falling back to package defaults.");
expect(/backupLifecycle\("upgrade"\)/.test(buildScript), "fnOS package must create cmd/upgrade_init to back up app data before upgrades.");
expect(/backupLifecycle\("uninstall"\)/.test(buildScript), "fnOS package must create cmd/uninstall_init to back up app data before uninstall/reinstall flows.");
expect(/upgrade-backups/.test(buildScript) && /sha256sum/.test(buildScript), "fnOS backup lifecycle must copy appdata to an upgrade backup directory and record the SQLite checksum when available.");
expect(/"\$data_root\/\.port"/.test(buildScript), "fnOS backup lifecycle must preserve the persisted service port file.");
expect(/data_root\/upgrade-backups/.test(buildScript), "fnOS backup lifecycle must fall back to an app-owned upgrade backup directory when sibling appdata backups are not writable.");
expect(/cp -a "\$data_root\/data"/.test(buildScript), "fnOS backup lifecycle must avoid recursively copying appdata into itself when using the app-owned backup fallback.");
expect(/upgrade_callback/.test(buildScript), "fnOS package must include upgrade_callback for overlay upgrades.");
expect(/const MIGRATIONS = \[/.test(buildScript), "fnOS SQLite init must include an explicit runtime migration list for existing databases.");
expect(/function splitSqlStatements\(sql\)/.test(buildScript) && /function applyMissingSchemaObjectsFromInitSql\(db, sqlPath\)/.test(buildScript), "fnOS SQLite init must parse native-init.sql to backfill newly added tables for existing databases.");
expect(/function stripLeadingSqlComments\(statement\)/.test(buildScript), "fnOS SQLite init must ignore leading Prisma SQL comments before parsing schema statements.");
expect(/for \(const rawStatement of statements\)/.test(buildScript) && /stripLeadingSqlComments\(rawStatement\)/.test(buildScript), "fnOS SQLite schema backfill must normalize raw native-init.sql statements before checking tables, columns, and indexes.");
expect(/createTableColumnDefinitionsFromStatement/.test(buildScript) && /SQLite schema column added from native-init.sql/.test(buildScript), "fnOS SQLite init must backfill safe newly added columns from native-init.sql for existing databases.");
expect(/canAddColumnFromCreateTableDefinition/.test(buildScript) && /SQLite schema column skipped from native-init.sql because it cannot be safely added/.test(buildScript), "fnOS SQLite column backfill must skip unsafe column transforms instead of guessing destructive migrations.");
expect(/CREATE INDEX IF NOT EXISTS/.test(buildScript) && /createIndexStatementIfMissing/.test(buildScript), "fnOS SQLite schema backfill must make native-init.sql indexes idempotent for existing databases.");
expect(/indexColumnsExist/.test(buildScript) && /SQLite schema index skipped from native-init.sql/.test(buildScript), "fnOS SQLite schema backfill must skip incompatible indexes instead of failing existing databases.");
expect(/busy_timeout = 10000/.test(buildScript), "fnOS SQLite init must wait briefly for database locks during package upgrades.");
expect(fnosInitSqliteIndex !== -1 && fnosPidCheckIndex !== -1 && fnosInitSqliteIndex < fnosPidCheckIndex, "fnOS start must run SQLite init before returning for an already-running process.");
expect(/startsWith\("file:"\)/.test(scheduledTaskLock) && /if \(isSqliteDatabaseUrl\(\)\) return;/.test(scheduledTaskLock) && /pg_advisory_xact_lock/.test(scheduledTaskLock) && /catch \(error\)/.test(scheduledTaskLock), "Scheduled-task locks must skip PostgreSQL advisory-lock SQL on fnOS SQLite with defense-in-depth try-catch.");
expect(/PRAGMA table_info\("FundProfile"\)/.test(fundProfileSource) && /FROM information_schema\.columns/.test(fundProfileSource), "FundProfile schema probing must use SQLite PRAGMA on fnOS and reserve information_schema.columns for PostgreSQL.");
expect(/model ApprovedCurrency \{/.test(currencySchema) && /model CustomCurrencyRequest \{/.test(currencySchema) && /enum CustomCurrencyRequestStatus \{/.test(currencySchema), "Currency request models must be present in the PostgreSQL schema.");
expect(/CREATE TABLE IF NOT EXISTS "ApprovedCurrency"/.test(currencyMigration) && /CREATE TABLE IF NOT EXISTS "CustomCurrencyRequest"/.test(currencyMigration) && /CREATE TYPE "CustomCurrencyRequestStatus"/.test(currencyMigration), "Currency request models must have a PostgreSQL migration.");
expect(/model ApprovedCurrency \{/.test(read(nativeSchema)) && /model CustomCurrencyRequest \{/.test(read(nativeSchema)) && /enum CustomCurrencyRequestStatus \{/.test(read(nativeSchema)), "Currency request models must be present in the native SQLite schema.");
expect(/applyMissingSchemaObjectsFromInitSql\(db, sqlPath\)/.test(buildScript), "fnOS upgrades must backfill newly added currency tables from native-init.sql.");
expect(/20260812_account_note/.test(buildScript) && /addColumnIfMissing\(db, "Account", "note", "TEXT"\)/.test(buildScript), "fnOS SQLite migrations must add Account.note to existing databases without rebuilding tables.");
expect(/20260812_user_session_days/.test(buildScript) && /addColumnIfMissing\(db, "UserSettings", "sessionDays", "INTEGER NOT NULL DEFAULT 30"\)/.test(buildScript), "fnOS SQLite migrations must add UserSettings.sessionDays to existing databases before restore writes user settings.");
expect(/20260811_stock_domain/.test(buildScript) && /createStockDomainTables\(db\)/.test(buildScript), "fnOS SQLite migrations must create stock core tables for existing databases.");
expect(/stock_transactions/.test(buildScript) && /entry_business_links_stockTransactionId_idx/.test(buildScript), "fnOS SQLite stock migration must include stock transactions and business-link stock relation.");
expect(/20260812_stock_reference_tables/.test(buildScript) && /createStockReferenceTables\(db\)/.test(buildScript), "fnOS SQLite migrations must create stock reference tables for existing databases.");
expect(/stock_market_fee_rules/.test(buildScript) && /stock_brokerage_catalog/.test(buildScript), "fnOS SQLite migrations must include stock market fee rules and brokerage catalog tables.");
expect(/20260813_zz_unify_statement_learning_rules/.test(buildScript), "fnOS SQLite statement-rule migration version must match the finalized Prisma migration directory.");
expect(/20260814_fix_property_cash_entry_fk/.test(buildScript) && /rebuildPropertyTransactionsCashEntryFk/.test(buildScript), "fnOS SQLite migrations must rebuild property_transactions when cashEntryId still references TxRecord.");
expect(/20260819_add_category_sort_order/.test(buildScript) && /addCategorySortOrder\(db\)/.test(buildScript), "fnOS SQLite migrations must add Category.sortOrder for existing databases.");
expect(/Category_householdId_type_parentId_sortOrder_idx/.test(buildScript), "fnOS SQLite Category.sortOrder migration must create the ordering index for existing databases.");
// Syntax-check the generated init-sqlite.cjs to catch template-literal quoting bugs
(function validateInitSqliteSyntax() {
  const startMarker = 'write(path.join(stageDir, "app", "server", "scripts", "init-sqlite.cjs"), `';
  const startIdx = buildScript.indexOf(startMarker);
  expect(startIdx !== -1, "fnOS build script must generate init-sqlite.cjs via a template literal.");
  if (startIdx === -1) return;
  const tplStart = startIdx + startMarker.length;
  let endIdx = -1;
  for (let i = tplStart; i < buildScript.length; i++) {
    if (buildScript[i] === "`" && buildScript[i + 1] === ")" && buildScript[i + 2] === ";") {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && buildScript[j] === "\\"; j--) backslashes++;
      if (backslashes % 2 === 0) { endIdx = i; break; }
    }
  }
  expect(endIdx !== -1, "fnOS build script init-sqlite.cjs template literal must be properly closed.");
  if (endIdx === -1) return;
  const rawTemplate = buildScript.substring(tplStart, endIdx);
  let generated;
  try {
    generated = eval("`" + rawTemplate + "`");
  } catch (e) {
    expect(false, "fnOS build script init-sqlite.cjs template literal must evaluate without error: " + e.message);
    return;
  }
  try {
    new Function(generated);
  } catch (e) {
    expect(false, "fnOS build script generated init-sqlite.cjs must pass JavaScript syntax check: " + e.message);
  }
})();

expect(/20260820_add_ai_model_api_mode/.test(buildScript) && /addColumnIfMissing\(db, "AiModel", "apiMode", "TEXT NOT NULL DEFAULT 'chat'"\)/.test(buildScript), "fnOS SQLite migrations must add AiModel.apiMode for existing databases.");
expect(/20260823_add_entry_origin/.test(buildScript) && /entryOrigin/.test(buildScript) && /TEXT NOT NULL DEFAULT 'manual'/.test(buildScript), "fnOS SQLite migrations must add transaction entryOrigin fields for existing databases.");
expect(/20260826_add_stock_latest_price_date/.test(buildScript) && /addColumnIfMissing\(db, "stock_holdings", "latestPriceDate", "DATETIME"\)/.test(buildScript), "fnOS SQLite migrations must add StockHolding.latestPriceDate for existing databases.");
expect(/20260828_add_fixed_asset_type/.test(buildScript) && /addColumnIfMissing\(db, "Account", "fixedAssetType", "TEXT"\)/.test(buildScript) && /addColumnIfMissing\(db, "property_assets", "assetType", "TEXT NOT NULL DEFAULT 'property'"\)/.test(buildScript), "fnOS SQLite migrations must add fixed asset type fields for existing databases.");
expect(/20260905_add_property_mortgage_loan_account/.test(buildScript) && /addColumnIfMissing\(db, "property_assets", "mortgageLoanAccountId", "TEXT"\)/.test(buildScript), "fnOS SQLite migrations must add mortgage loan linkage for fixed assets.");
expect(/20260905_add_account_loan_type/.test(buildScript) && /addColumnIfMissing\(db, "Account", "loanType", "TEXT"\)/.test(buildScript) && /'consumer'/.test(buildScript), "fnOS SQLite migrations must add Account.loanType for existing databases.");
expect(/20260906_restore_counterparty_settlement_kind/.test(buildScript) && /counterparty-owned settlement accounts/.test(buildScript) && /counterpartyId IS NOT NULL AND institutionId IS NULL/.test(buildScript), "fnOS SQLite migrations must restore counterparty settlement accounts misclassified as loans.");
expect(/20260829_add_credit_card_billing_day/.test(buildScript) && /createCreditCardBillingDayTable\(db\)/.test(buildScript) && /CreditCardBillingDay_accountId_effectiveDate_key/.test(buildScript) && /CreditCardBillingDay/.test(buildScript) && /updatedAt/.test(buildScript), "fnOS SQLite migrations must create, index, and timestamp CreditCardBillingDay for existing databases.");
expect(/20260902_add_regular_invest_plan_name/.test(buildScript) && /addColumnIfMissing\(db, "RegularInvestPlan", "planName", "TEXT"\)/.test(buildScript), "fnOS SQLite migrations must add RegularInvestPlan.planName for existing databases.");
expect(/20260903_normalize_ewallet_institution_type/.test(buildScript) && /SET \\+"type\\+" = 'payment' WHERE \\+"type\\+" = 'ewallet'/.test(buildScript), "fnOS SQLite migrations must normalize legacy ewallet institutions to the payment type for existing databases.");
expect(/20260903_add_fund_profile_trading_calendar/.test(buildScript) && /addColumnIfMissing\(db, "FundProfile", "tradingCalendar", "TEXT"\)/.test(buildScript) && /jp_fund/.test(buildScript), "fnOS SQLite migrations must add FundProfile.tradingCalendar and Japan fund calendar support for existing databases.");
expect(/20260903_restore_fund_profile_company_code/.test(buildScript) && /addColumnIfMissing\(db, "FundProfile", "fundCompanyCode", "TEXT"\)/.test(buildScript), "fnOS SQLite migrations must restore FundProfile.fundCompanyCode for existing databases.");
expect(/20260903_z_repair_investment_business_sources/.test(buildScript) && /repairInvestmentBusinessSources\(db\)/.test(buildScript), "fnOS SQLite migrations must repair split fund and wealth business sources for existing databases.");
for (const tableName of [
  "transactions",
  "fund_transactions",
  "stock_transactions",
  "insurance_transactions",
  "wealth_transactions",
  "deposit_transactions",
  "precious_metal_transactions",
  "property_transactions",
]) {
  expect(buildScript.includes(`"${tableName}"`), `fnOS SQLite entryOrigin migration must cover ${tableName}.`);
}
expect(/applyRuntimeMigrations\(db\)/.test(buildScript), "fnOS SQLite init must run runtime migrations for both fresh and existing databases.");
expect(nativeSchemaBackfillCalls.length >= 2, "fnOS SQLite init must backfill missing native-init.sql schema objects for both fresh and existing databases.");
expect(/applyRuntimeMigrations\(db\);\n\s+applyMissingSchemaObjectsFromInitSql\(db, sqlPath\);/.test(buildScript), "fnOS SQLite init must run schema-object backfill after explicit runtime migrations.");
expect(/SQLite database already initialized and migrated/.test(buildScript), "fnOS SQLite init must report that existing databases were migrated.");
expect(/buildRestoredCategoryBatches/.test(backupSource), "Backup restore must normalize category rows before writing them.");
expect(/record\.parentId === record\.id/.test(backupSource) && /!recordIds\.has\(record\.parentId \?\? ""\)/.test(backupSource), "Backup restore must drop self or missing category parent links before createMany.");
expect(/restoredCategoryNameById/.test(backupSource) && /categoryNameById/.test(backupSource), "Backup restore must keep restored category names aligned for transactions and statement rules.");
if (fs.existsSync(path.join(root, "deploy", "fnos", "README.md"))) {
  expect(/覆盖升级/.test(fnosReadme) && /upgrade_init/.test(fnosReadme), "deploy/fnos/README.md must document direct same-app overlay upgrades.");
  expect(!/appcenter-cli uninstall/.test(fnosReadme), "deploy/fnos/README.md must not describe uninstall/install as the normal update path.");
}
if (fs.existsSync(path.join(root, "docs", "fnos-package-plan.md"))) {
  expect(/覆盖升级/.test(fnosPackagePlan) && /appname=mmh/.test(fnosPackagePlan), "docs/fnos-package-plan.md must keep same-app overlay upgrade as the normal update path.");
}
expect(/process\.platform === "linux"/.test(buildScript), "fnOS release builds must be guarded to Linux/fnOS.");
expect(/resolve_data_dest/.test(buildScript), "fnOS start script must resolve a persistent fnOS data directory.");
expect(/TRIM_PKGVAR\/data/.test(buildScript), "fnOS start script must prefer TRIM_PKGVAR/data when TRIM_DATADEST is unavailable.");
expect(/@appdata\/"\$appname"/.test(buildScript), "fnOS start script fallback must use the fnOS appdata directory.");
expect(!/TRIM_DATADEST:-\$APP_DEST\/data/.test(buildScript), "fnOS start script must not fall back to the app install directory for SQLite data.");
expect(/DATABASE_URL="file:\$DATA_DEST\/mmh\.db"/.test(buildScript), "fnOS start script must store SQLite data under the resolved persistent data directory.");
expect(/SELECT name FROM sqlite_master WHERE type = 'table'/.test(buildScript), "fnOS SQLite init must check for existing user tables before applying the initial schema.");
expect(/if \(!existing\)/.test(buildScript), "fnOS SQLite init must skip schema creation when an existing database is present.");
expect(/export MMH_DEPLOY_TARGET=fnos/.test(buildScript), "fnOS start script must mark the deployment target as fnos.");
expect(/manifestPlatform/.test(buildScript) && /manifestArch/.test(buildScript), "fnOS manifest must be generated from the target architecture.");
expect(/assetSuffix/.test(buildScript), "fnOS package outputs must include architecture-specific asset names.");
expect(/fnos-v\$\{version\}-\$\{target\.assetSuffix\}/.test(buildScript), "fnOS release asset names must include fnOS, package version, and architecture.");
expect(!/`\$\{appName\}-\$\{target\.assetSuffix\}\.fpk`/.test(buildScript), "fnOS release must not publish unversioned architecture-only .fpk aliases.");
expect(!/legacyAlias/.test(buildScript), "fnOS release must not publish a third legacy mmh.fpk alias.");
expect(!/wizard_system_password/.test(buildScript), "fnOS package must not ask for a separate system password.");
expect(/MMH_SYSTEM_PASSWORD/.test(buildScript), "fnOS start script must export MMH_SYSTEM_PASSWORD.");
expect(/mmh-system-password\.txt/.test(buildScript), "fnOS start script must persist generated system passwords in app data.");
expect(/install_callback/.test(buildScript) && /write_env_file/.test(buildScript), "fnOS lifecycle callbacks must persist package runtime settings.");
expect(!/"run-as": "package"/.test(buildScript), "fnOS lifecycle scripts must not default to the package user; install_init can fail before app data permissions exist.");
expect(/restart_start_as_package_user/.test(buildScript) && /runuser -u mmh/.test(buildScript), "fnOS start script must drop from app-center/root lifecycle execution to the mmh package user before running Node.");
expect(/makeFnosPackageEntriesReadable/.test(buildScript), "fnOS package build must normalize entry permissions before packaging.");
expect(/MMH_SESSION_SECRET/.test(buildScript) && /mmh-session-secret\.txt/.test(buildScript), "fnOS start script must persist a strong session secret for signed login cookies.");
expect(/resolve_session_secret/.test(buildScript) && /generate_session_secret/.test(buildScript), "fnOS lifecycle settings must generate and reuse a strong signed-session secret.");
expect(/MMH_SESSION_SECRET=\\?\$\{session_secret\}/.test(buildScript), "fnOS lifecycle settings must write MMH_SESSION_SECRET into mmh.env for production login cookies.");
expect(/@appcenter\/"\$appname"/.test(buildScript), "fnOS start script must be able to rediscover the appcenter install directory when TRIM_APPDEST is unavailable.");
expect(/verifySensitiveOperationPassword/.test(authVerifyRoute) && /getCurrentUser/.test(authVerifyRoute) && /isAdmin/.test(authVerifyRoute), "Sensitive operation verification must require the current admin user and check that user's own password.");
expect(!/process\.env\.(POSTGRES_PASSWORD|MMH_SYSTEM_PASSWORD)/.test(authVerifyRoute), "Sensitive operation verification must not rely on deployment database passwords.");
expect(/FNOS_MANUAL_FPK/.test(buildScript), "fnOS package build should keep an explicit manual test FPK mode.");
expect(/schema\.native\.prisma/.test(appBuildScript), "fnOS app build must generate and build against the SQLite schema.");
expect(/MMH_DEPLOY_TARGET/.test(systemUpdateRoute), "System update API must detect fnOS by MMH_DEPLOY_TARGET.");
expect(/isFnos/.test(systemUpdateRoute), "System update API must return an explicit isFnos flag.");
expect(/remoteVersion/.test(systemUpdateRoute), "System update API must return the remote app version for update display.");
expect(/飞牛版请通过飞牛应用中心更新 MMH 应用包/.test(systemUpdateRoute), "System update API must reject in-app updates for fnOS.");
expect(/packageManaged \? t\("settings\.systemUpdate\.versionInfo"\)/.test(systemUpdatePage), "System update page must label package-managed details as version information.");
expect(/githubProjectUrl/.test(systemUpdatePage) && /systemUpdate\.githubHome/.test(systemUpdatePage), "System update page must expose the GitHub project link for fnOS users.");
expect(/availableVersionText/.test(systemUpdatePage) && /systemUpdate\.availableVersion/.test(systemUpdatePage), "System update page must show the available app version beside the update commit.");
expect(/systemUpdate\.fnosManagedInfo/.test(systemUpdatePage) && /systemUpdate\.managedByFnos/.test(systemUpdatePage), "System update page must guide fnOS users to update with the architecture-matched FPK.");
expect(!/docker-project/.test(buildScript), "fnOS package build must not declare Docker resources.");
expect(/better-sqlite3/.test(buildScript), "fnOS package build must explicitly include the SQLite native runtime dependency.");
expect(/copyFnosPublicAssets/.test(buildScript), "fnOS package build must copy only whitelisted runtime public assets.");
expect(!/copyDir\(publicDir/.test(buildScript), "fnOS package build must not copy the whole public directory.");
expect(standaloneCopyIndex >= 0 && standaloneCopyIndex < standaloneEnvScrubIndex && standaloneEnvScrubIndex < publicAssetCopyIndex, "fnOS package build must scrub standalone env files before public asset copying can fail.");
expect(/release:\s*\n\s*types:\s*\[published\]/.test(fnosReleaseWorkflow), "fnOS workflow should run when a GitHub Release is published.");
expect(/npm ci/.test(fnosReleaseWorkflow), "fnOS workflow should install Linux native dependencies.");
expect(/FNOS_NODE_TARBALL/.test(fnosReleaseWorkflow), "fnOS workflow should provide a Linux Node runtime tarball.");
expect(/npm run build:fnos:app/.test(fnosReleaseWorkflow), "fnOS workflow should build the Linux SQLite standalone app.");
expect(/npm run build:fnos/.test(fnosReleaseWorkflow), "fnOS workflow should build the formal .fpk package.");
expect(!/existing-fpk/.test(fnosReleaseWorkflow), "fnOS workflow must rebuild release packages instead of skipping when an old .fpk asset already exists.");
expect(/overwrite_files:\s*true/.test(fnosReleaseWorkflow), "fnOS workflow must overwrite existing Release .fpk assets with the newly built package.");
expect(/Verify built fnOS FPK/.test(fnosReleaseWorkflow) && /npm run check:fnos/.test(fnosReleaseWorkflow), "fnOS workflow must verify the built .fpk before upload.");
expect(/release-artifacts\/fnos\/\*\.fpk/.test(fnosReleaseWorkflow), "fnOS workflow should upload .fpk files.");
expect(/target_arch/.test(fnosReleaseWorkflow) && /arm64/.test(fnosReleaseWorkflow), "fnOS release workflow must build both x86 and arm64 packages.");
expect(/linux-\$\{FNPACK_ARCH\}/.test(fnosReleaseWorkflow), "fnOS release workflow must download fnpack for the current runner architecture.");
expect(/linux-\$\{NODE_ARCH\}/.test(fnosReleaseWorkflow), "fnOS release workflow must download the Node runtime for the package architecture.");
expect(/target_arch/.test(fnosStageWorkflow) && /arm64/.test(fnosStageWorkflow), "fnOS stage workflow must build both x86 and arm64 package sources.");
expect(!/path:\s*release-artifacts\/fnos\/\*-fpk-source\.tgz/.test(fnosReleaseWorkflow), "fnOS release workflow must not upload stage-only .tgz files.");
expect(/fnpack was not found/.test(fnosReleaseWorkflow), "fnOS workflow should fail clearly when fnpack is unavailable.");
expect(!/mmh-native\.fpk/.test(fnosReleaseWorkflow), "fnOS workflow must not publish a second mmh-native.fpk package.");
expect(!/0\.1\.0-fnos/.test(fnosReleaseWorkflow), "fnOS release workflow must not default to the old 0.1.0-fnos package version.");
expect(!/0\.1\.0-fnos/.test(fnosStageWorkflow), "fnOS stage workflow must not default to the old 0.1.0-fnos package version.");
expect(/default:\s*""/.test(fnosReleaseWorkflow), "fnOS release workflow should let package.json own the default package version.");
expect(/default:\s*""/.test(fnosStageWorkflow), "fnOS stage workflow should let package.json own the default package version.");
expect(/"platform"\s*:\s*"x86"/.test(repositoryExample), "fnOS repository example must keep x86 as the legacy default platform.");
expect(/"platforms"\s*:\s*\[\s*"x86"\s*,\s*"arm"\s*\]/.test(repositoryExample), "fnOS repository example must list x86 and arm platforms.");
expect(/"download_urls"/.test(repositoryExample) && /"x86_64"/.test(repositoryExample) && /"arm64"/.test(repositoryExample), "fnOS repository example must include exactly the x86_64 and arm64 download_urls.");
expect(!/"x86"\s*:/.test(repositoryExample), "fnOS repository example must not include a third x86 alias download URL.");
expect(/"platform"\s*:\s*"x86"/.test(repositoryApiApps), "fnOS repository api/apps must keep x86 as the legacy default platform.");
expect(/"platforms"\s*:\s*\[\s*"x86"\s*,\s*"arm"\s*\]/.test(repositoryApiApps), "fnOS repository api/apps must list x86 and arm platforms.");
expect(/"download_urls"/.test(repositoryApiApps) && /"x86_64"/.test(repositoryApiApps) && /"arm64"/.test(repositoryApiApps), "fnOS repository api/apps must include exactly the x86_64 and arm64 download_urls.");
expect(!/"x86"\s*:/.test(repositoryApiApps), "fnOS repository api/apps must not include a third x86 alias download URL.");

if (fs.existsSync(stageDir)) {
  const stageManifest = read(path.join(stageDir, "manifest"));
  const stagePrivilege = read(path.join(stageDir, "config", "privilege"));
  const stageMainScript = read(path.join(stageDir, "cmd", "main"));
  const stageApplySettingsScript = read(path.join(stageDir, "cmd", "apply-settings"));
  expect(new RegExp(`arch\\s*=\\s*${verifyTarget.manifestArch}`).test(stageManifest), `fnOS ${verifyTarget.id} stage manifest must declare arch=${verifyTarget.manifestArch}.`);
  expect(new RegExp(`platform\\s*=\\s*${verifyTarget.manifestPlatform}`).test(stageManifest), `fnOS ${verifyTarget.id} stage manifest must declare platform=${verifyTarget.manifestPlatform}.`);
  expect(!/"run-as"\s*:\s*"package"/.test(stagePrivilege), `fnOS ${verifyTarget.id} stage privilege must not run lifecycle scripts as the package user.`);
  expect(/"username"\s*:\s*"mmh"/.test(stagePrivilege) && /"groupname"\s*:\s*"mmh"/.test(stagePrivilege), `fnOS ${verifyTarget.id} stage privilege must still declare the mmh package user and group.`);
  expect(/restart_start_as_package_user/.test(stageMainScript) && /runuser -u mmh/.test(stageMainScript), `fnOS ${verifyTarget.id} stage cmd/main must drop root-started service execution to the mmh user.`);
  expect(/@appcenter\/"\$appname"/.test(stageMainScript), `fnOS ${verifyTarget.id} stage cmd/main must rediscover the appcenter install directory without TRIM_APPDEST.`);
  expect(/MMH_SESSION_SECRET/.test(stageMainScript) && /mmh-session-secret\.txt/.test(stageMainScript), `fnOS ${verifyTarget.id} stage cmd/main must export and persist MMH_SESSION_SECRET.`);
  expect(/resolve_session_secret/.test(stageApplySettingsScript) && /MMH_SESSION_SECRET=\$\{session_secret\}/.test(stageApplySettingsScript), `fnOS ${verifyTarget.id} stage cmd/apply-settings must persist MMH_SESSION_SECRET into mmh.env.`);
  expect(!fs.existsSync(path.join(stageDir, "wizard", "install")), `fnOS ${verifyTarget.id} stage must not include wizard/install; the FN soft-store client parses it and would block silent updates on user input.`);
  expect(fs.existsSync(path.join(stageDir, "wizard", "config")), `fnOS ${verifyTarget.id} stage must include wizard/config so the service port stays editable after a silent install.`);
  for (const envFile of [".env", ".env.local", ".env.production", ".env.development"]) {
    expect(!fs.existsSync(path.join(stageDir, "app", "server", envFile)), `fnOS stage must not include ${envFile}.`);
  }
  expectPngSize(path.join(stageDir, "ICON.PNG"), 64);
  expectPngSize(path.join(stageDir, "ICON_256.PNG"), 256);
  if (fs.existsSync(path.join(stageDir, "app"))) {
    expectPngSize(path.join(stageDir, "app", "ui", "images", "icon_64.png"), 64);
    expectPngSize(path.join(stageDir, "app", "ui", "images", "icon_256.png"), 256);
  }
  const publicDir = path.join(stageDir, "app", "server", "public");
  if (fs.existsSync(publicDir)) expectFnosPublicFiles(listFilesRelative(publicDir), "fnOS stage public");
}

const builtFpk = path.join(root, "release-artifacts", "fnos", verifyTarget.builtFpkName);
if (process.env.FNOS_VERIFY_BUILT_FPK === "1") {
  expect(fs.existsSync(builtFpk), `Built fnOS ${verifyTarget.id} .fpk must exist before upload.`);
  const manifest = readTarEntry(builtFpk, "manifest");
  const mainScript = readTarEntry(builtFpk, "cmd/main");
  const applySettingsScript = readTarEntry(builtFpk, "cmd/apply-settings");
  expect(/version\s*=/.test(manifest), "Built fnOS .fpk manifest must include a version.");
  expect(new RegExp(`arch\\s*=\\s*${verifyTarget.manifestArch}`).test(manifest), `Built fnOS .fpk manifest must declare arch=${verifyTarget.manifestArch}.`);
  expect(new RegExp(`platform\\s*=\\s*${verifyTarget.manifestPlatform}`).test(manifest), `Built fnOS .fpk manifest must declare platform=${verifyTarget.manifestPlatform}.`);
  expect(!tarHasEntryOrChild(builtFpk, "wizard/install"), "Built fnOS .fpk must not include wizard/install; the FN soft-store client parses it and would block silent updates on user input.");
  expect(!tarHasEntryOrChild(builtFpk, "wizard/upgrade"), "Built fnOS .fpk must not include wizard/upgrade; updates must not ask for the service port.");
  expect(!tarHasEntryOrChild(builtFpk, "wizard/uninstall"), "Built fnOS .fpk must not include wizard/uninstall; uninstall must stay non-interactive.");
  expect(tarHasEntry(builtFpk, "wizard/config"), "Built fnOS .fpk must include wizard/config so the service port stays editable from App Center settings.");
  expect(tarHasEntry(builtFpk, "cmd/config_callback"), "Built fnOS .fpk must include cmd/config_callback to apply a changed service port.");
  expect(tarHasEntry(builtFpk, "cmd/upgrade_init"), "Built fnOS .fpk must include cmd/upgrade_init to back up app data before upgrades.");
  expect(tarHasEntry(builtFpk, "cmd/upgrade_callback"), "Built fnOS .fpk must include cmd/upgrade_callback for overlay upgrades.");
  expect(tarHasEntry(builtFpk, "cmd/uninstall_init"), "Built fnOS .fpk must include cmd/uninstall_init to back up app data before uninstall/reinstall flows.");
  for (const entry of ["cmd", "config"]) {
    expectTarEntryModeAtLeast(builtFpk, entry, 0o755, "Built fnOS .fpk");
  }
  for (const entry of [
    "cmd/install_init",
    "cmd/install_callback",
    "cmd/upgrade_init",
    "cmd/upgrade_callback",
    "cmd/uninstall_init",
    "cmd/uninstall_callback",
    "cmd/config_init",
    "cmd/config_callback",
    "cmd/main",
  ]) {
    expectTarEntryModeAtLeast(builtFpk, entry, 0o755, "Built fnOS .fpk");
  }
  expectTarEntryModeAtLeast(builtFpk, "app.tgz", 0o644, "Built fnOS .fpk");
  expectTarEntryModeAtLeast(builtFpk, "manifest", 0o644, "Built fnOS .fpk");
  const upgradeInitScript = readTarEntry(builtFpk, "cmd/upgrade_init");
  const uninstallInitScript = readTarEntry(builtFpk, "cmd/uninstall_init");
  expect(/upgrade-backups/.test(upgradeInitScript) && /data\/mmh\.db/.test(upgradeInitScript), "Built fnOS upgrade_init must back up persistent app data when SQLite data exists.");
  expect(/upgrade-backups/.test(uninstallInitScript) && /data\/mmh\.db/.test(uninstallInitScript), "Built fnOS uninstall_init must back up persistent app data when SQLite data exists.");
  expect(/resolve_data_dest/.test(mainScript), "Built fnOS .fpk cmd/main must resolve the persistent fnOS data directory.");
  expect(/TRIM_PKGVAR\/data/.test(mainScript), "Built fnOS .fpk cmd/main must prefer TRIM_PKGVAR/data.");
  expect(!/TRIM_DATADEST:-\$APP_DEST\/data/.test(mainScript), "Built fnOS .fpk cmd/main must not fall back to the app install directory for SQLite data.");
  expect(/DATABASE_URL="file:\$DATA_DEST\/mmh\.db"/.test(mainScript), "Built fnOS .fpk cmd/main must store SQLite data under DATA_DEST.");
  expect(/MMH_SYSTEM_PASSWORD/.test(mainScript), "Built fnOS .fpk cmd/main must export MMH_SYSTEM_PASSWORD.");
  expect(/mmh-system-password\.txt/.test(mainScript), "Built fnOS .fpk cmd/main must persist generated system passwords.");
  expect(/MMH_SESSION_SECRET/.test(mainScript) && /mmh-session-secret\.txt/.test(mainScript), "Built fnOS .fpk cmd/main must persist the signed-session secret.");
  expect(/@appcenter\/"\$appname"/.test(mainScript), "Built fnOS .fpk cmd/main must rediscover the appcenter install directory when TRIM_APPDEST is unavailable.");
  expect(/resolve_session_secret/.test(applySettingsScript) && /MMH_SESSION_SECRET=\$\{session_secret\}/.test(applySettingsScript), "Built fnOS .fpk cmd/apply-settings must persist MMH_SESSION_SECRET into mmh.env.");
  const appEntries = listFpkAppEntries(builtFpk);
  const publicFiles = appEntries
    .filter((entry) => entry.startsWith("server/public/") && !entry.endsWith("/"))
    .filter((entry) => entry !== "server/public/branding")
    .map((entry) => entry.slice("server/public/".length))
    .sort();
  expectFnosPublicFiles(publicFiles, "Built fnOS .fpk public");
}

if (fs.existsSync(nativeSchema)) {
  const validate = spawnSync(process.execPath, [prismaCli, "validate", "--schema", nativeSchema], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  expect(validate.status === 0, `Native Prisma schema should validate.\n${validate.stderr || validate.stdout || validate.error?.message}`);
}

if (failures.length > 0) {
  console.error("fnOS package verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("fnOS package verification passed.");
