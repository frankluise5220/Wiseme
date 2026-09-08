import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  extractStatementLearningKeyword,
  normalizeStatementKeywordText,
  normalizeStatementRecognitionText,
  type StatementHistoricalCategorySample,
} from "@/lib/statement/import-normalization";
import {
  STATEMENT_IMPORT_FIELD_HEADERS,
  type StatementImportField,
} from "@/lib/statement/header-catalog";

type RawSqlClient = {
  $executeRaw: (query: Prisma.Sql) => Promise<number>;
  $queryRaw: <T = unknown>(query: Prisma.Sql) => Promise<T>;
};

type StatementRecognitionTargetType = "category" | "institution" | "field";

type DefaultStatementRecognitionRule = {
  targetType: StatementRecognitionTargetType;
  transactionType?: "any" | "expense" | "income";
  keyword: string;
  categoryName?: string;
  institutionName?: string;
  fieldName?: StatementImportField;
  priority?: number;
};

type StatementRecognitionRuleRow = {
  targetType: string;
  transactionType: string;
  keyword: string;
  normalizedKeyword: string;
  institutionId: string | null;
  categoryName: string | null;
  institutionName: string | null;
  fieldName: string | null;
  source: string | null;
  priority: number | bigint | null;
  hitCount: number | bigint | null;
};

type StatementInstitutionRuleInput = {
  householdId?: string | null;
  institutionId?: string | null;
  institutionName?: string | null;
  keyword?: string | null;
  transactionType?: "any" | "expense" | "income" | string | null;
  source?: string | null;
};

type StatementCategoryRecognitionRuleInput = {
  householdId?: string | null;
  type?: "expense" | "income" | string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  keyword?: string | null;
  source?: string | null;
};

type StatementCategoryRow = {
  id: string;
  type: string;
  name: string;
};

type StatementInstitutionRow = {
  id: string;
  name: string;
  shortName: string | null;
};

const SYSTEM_DEFAULT_SOURCE = "system_default";
const MAX_TEXT_LENGTH = 500;
let fieldNameColumnChecked = false;
// Cache of householdIds whose default recognition rules have already been
// seeded this process. Seeding runs ~100 INSERT ... ON CONFLICT DO NOTHING
// statements; skipping it on every parse avoids a large fixed cost.
const defaultRulesSeeded = new Set<string>();

const DEFAULT_STATEMENT_RECOGNITION_RULES: DefaultStatementRecognitionRule[] = [
  { targetType: "category", transactionType: "expense", categoryName: "服饰装饰", keyword: "服装", priority: 110 },
  { targetType: "category", transactionType: "expense", categoryName: "服饰装饰", keyword: "服饰", priority: 110 },
  { targetType: "category", transactionType: "expense", categoryName: "服饰装饰", keyword: "班尼路", priority: 120 },
  { targetType: "category", transactionType: "expense", categoryName: "服饰装饰", keyword: "九牧王", priority: 120 },
  { targetType: "category", transactionType: "expense", categoryName: "服饰装饰", keyword: "优衣库", priority: 120 },
  { targetType: "category", transactionType: "expense", categoryName: "服饰装饰", keyword: "海澜之家", priority: 120 },
  { targetType: "category", transactionType: "expense", categoryName: "服饰装饰", keyword: "李宁", priority: 120 },
  { targetType: "category", transactionType: "expense", categoryName: "服饰装饰", keyword: "安踏", priority: 120 },
  { targetType: "category", transactionType: "expense", categoryName: "服饰装饰", keyword: "耐克", priority: 120 },
  { targetType: "category", transactionType: "expense", categoryName: "服饰装饰", keyword: "阿迪达斯", priority: 120 },
  { targetType: "category", transactionType: "expense", categoryName: "火车高铁", keyword: "中国铁路网络", priority: 120 },
  { targetType: "category", transactionType: "expense", categoryName: "火车高铁", keyword: "中国铁路", priority: 120 },
  { targetType: "category", transactionType: "expense", categoryName: "火车高铁", keyword: "12306", priority: 120 },
  { targetType: "category", transactionType: "expense", categoryName: "外卖", keyword: "美团外卖", priority: 110 },
  { targetType: "category", transactionType: "expense", categoryName: "外卖", keyword: "饿了么", priority: 110 },
  { targetType: "category", transactionType: "expense", categoryName: "餐饮美食", keyword: "大众点评", priority: 105 },
  { targetType: "category", transactionType: "expense", categoryName: "餐饮美食", keyword: "美团", priority: 95 },
  { targetType: "category", transactionType: "expense", categoryName: "打车", keyword: "滴滴出行", priority: 110 },
  { targetType: "category", transactionType: "expense", categoryName: "公交地铁", keyword: "公交", priority: 100 },
  { targetType: "category", transactionType: "expense", categoryName: "公交地铁", keyword: "地铁", priority: 100 },
  { targetType: "category", transactionType: "expense", categoryName: "停车费", keyword: "停车", priority: 100 },
  { targetType: "category", transactionType: "expense", categoryName: "充电", keyword: "云快充", priority: 105 },
  { targetType: "category", transactionType: "expense", categoryName: "充电", keyword: "充电桩", priority: 105 },
  { targetType: "category", transactionType: "expense", categoryName: "电费", keyword: "国家电网", priority: 105 },
  { targetType: "category", transactionType: "expense", categoryName: "水费", keyword: "自来水", priority: 105 },
  { targetType: "category", transactionType: "expense", categoryName: "燃气费", keyword: "燃气", priority: 95 },
  { targetType: "category", transactionType: "expense", categoryName: "快递物流", keyword: "顺丰", priority: 105 },
  { targetType: "category", transactionType: "expense", categoryName: "快递物流", keyword: "圆通", priority: 105 },
  { targetType: "category", transactionType: "expense", categoryName: "快递物流", keyword: "中通", priority: 105 },
  { targetType: "category", transactionType: "expense", categoryName: "快递物流", keyword: "韵达", priority: 105 },
  { targetType: "category", transactionType: "expense", categoryName: "快递物流", keyword: "申通", priority: 105 },
  { targetType: "institution", institutionName: "支付宝", keyword: "支付宝", priority: 120 },
  { targetType: "institution", institutionName: "微信支付", keyword: "微信支付", priority: 120 },
  { targetType: "institution", institutionName: "微信支付", keyword: "财付通", priority: 120 },
  { targetType: "institution", institutionName: "银联", keyword: "云闪付", priority: 120 },
  { targetType: "institution", institutionName: "银联", keyword: "银联", priority: 105 },
  { targetType: "institution", institutionName: "中国铁路", keyword: "中国铁路网络", priority: 125 },
  { targetType: "institution", institutionName: "中国铁路", keyword: "中国铁路", priority: 125 },
  { targetType: "institution", institutionName: "中国铁路", keyword: "12306", priority: 125 },
  { targetType: "institution", institutionName: "美团", keyword: "美团", priority: 100 },
  { targetType: "institution", institutionName: "美团外卖", keyword: "美团外卖", priority: 120 },
  { targetType: "institution", institutionName: "饿了么", keyword: "饿了么", priority: 120 },
  { targetType: "institution", institutionName: "大众点评", keyword: "大众点评", priority: 110 },
  { targetType: "institution", institutionName: "京东", keyword: "京东", priority: 105 },
  { targetType: "institution", institutionName: "京东", keyword: "网银在线", priority: 105 },
  { targetType: "institution", institutionName: "淘宝/天猫", keyword: "淘宝", priority: 105 },
  { targetType: "institution", institutionName: "淘宝/天猫", keyword: "天猫", priority: 105 },
  { targetType: "institution", institutionName: "拼多多", keyword: "拼多多", priority: 105 },
  { targetType: "institution", institutionName: "拼多多", keyword: "付费通", priority: 105 },
  { targetType: "institution", institutionName: "滴滴出行", keyword: "滴滴出行", priority: 110 },
  { targetType: "institution", institutionName: "携程", keyword: "携程", priority: 100 },
  { targetType: "institution", institutionName: "\u4e2d\u56fd\u77f3\u5316", keyword: "\u4e2d\u56fd\u77f3\u5316", priority: 110 },
  { targetType: "institution", institutionName: "\u4e2d\u56fd\u77f3\u5316", keyword: "\u4e2d\u77f3\u5316", priority: 110 },
  { targetType: "institution", institutionName: "国家电网", keyword: "国家电网", priority: 110 },
  { targetType: "institution", institutionName: "江苏云快充新能源科技有限公司", keyword: "云快充", priority: 110 },
  ...Object.entries(STATEMENT_IMPORT_FIELD_HEADERS).flatMap(([fieldName, aliases]) =>
    aliases.map((keyword) => ({
      targetType: "field" as const,
      fieldName: fieldName as StatementImportField,
      keyword,
      priority: 150,
    })),
  ),
];

function cleanText(value?: string | null) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || /^[-—–]+$/.test(text) || text === "?") return "";
  return text.slice(0, MAX_TEXT_LENGTH);
}

function isStatementRecognitionRuleTableMissing(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /statement_recognition_rules|no such table|does not exist|Undefined table/i.test(message);
}

function isSqliteRuntime() {
  const url = String(process.env.DATABASE_URL ?? "");
  return url === ":memory:" || url.startsWith("file:");
}

function isIgnorableFieldNameColumnEnsureError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /duplicate column|already exists|statement_recognition_rules|no such table|does not exist|Undefined table/i.test(message);
}

async function ensureStatementRecognitionRuleFieldNameColumn(client: RawSqlClient) {
  if (fieldNameColumnChecked) return;
  try {
    await client.$executeRaw(Prisma.sql`
      CREATE TABLE IF NOT EXISTS "statement_recognition_rules" (
        "id" TEXT NOT NULL,
        "householdId" TEXT NOT NULL,
        "targetType" TEXT NOT NULL,
        "transactionType" TEXT NOT NULL DEFAULT 'any',
        "keyword" TEXT NOT NULL,
        "normalizedKeyword" TEXT NOT NULL,
        "categoryId" TEXT,
        "categoryName" TEXT,
        "institutionId" TEXT,
        "institutionName" TEXT,
        "fieldName" TEXT,
        "source" TEXT NOT NULL DEFAULT 'system_default',
        "priority" INTEGER NOT NULL DEFAULT 100,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "hitCount" INTEGER NOT NULL DEFAULT 0,
        "lastSeenAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "statement_recognition_rules_pkey" PRIMARY KEY ("id"),
        CONSTRAINT "statement_recognition_rules_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "statement_recognition_rules_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE,
        CONSTRAINT "statement_recognition_rules_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE
      )
    `);
    await client.$executeRaw(Prisma.sql`
      CREATE UNIQUE INDEX IF NOT EXISTS "statement_recognition_rules_householdId_targetType_transactionType_normalizedKeyword_key"
      ON "statement_recognition_rules"("householdId", "targetType", "transactionType", "normalizedKeyword")
    `);
    await client.$executeRaw(Prisma.sql`
      CREATE INDEX IF NOT EXISTS "statement_recognition_rules_householdId_targetType_idx"
      ON "statement_recognition_rules"("householdId", "targetType")
    `);
    await client.$executeRaw(Prisma.sql`
      CREATE INDEX IF NOT EXISTS "statement_recognition_rules_categoryId_idx"
      ON "statement_recognition_rules"("categoryId")
    `);
    await client.$executeRaw(Prisma.sql`
      CREATE INDEX IF NOT EXISTS "statement_recognition_rules_institutionId_idx"
      ON "statement_recognition_rules"("institutionId")
    `);
    await client.$executeRaw(Prisma.sql`
      CREATE INDEX IF NOT EXISTS "statement_recognition_rules_isActive_idx"
      ON "statement_recognition_rules"("isActive")
    `);
    // ADD COLUMN has no IF NOT EXISTS on either supported dialect, so check
    // existence first. This avoids a noisy "duplicate column" error on every
    // upgraded deployment where the column was already added by a migration
    // or by the native SQLite schema initializer.
    if (!(await statementRecognitionRuleFieldNameColumnExists(client))) {
      await client.$executeRaw(Prisma.sql`
        ALTER TABLE "statement_recognition_rules" ADD COLUMN "fieldName" TEXT
      `);
    }
  } catch (error) {
    if (!isIgnorableFieldNameColumnEnsureError(error)) {
      console.error("[statement-recognition-rules] failed to ensure fieldName column", error);
    }
  } finally {
    fieldNameColumnChecked = true;
  }
}

async function statementRecognitionRuleFieldNameColumnExists(client: RawSqlClient): Promise<boolean> {
  const url = String(process.env.DATABASE_URL ?? "");
  const isSqlite = url === ":memory:" || url.startsWith("file:");
  if (isSqlite) {
    const rows = await client.$queryRaw<Array<{ name: string }>>(Prisma.sql`
      PRAGMA table_info("statement_recognition_rules")
    `);
    return rows.some((row) => row.name === "fieldName");
  }
  const rows = await client.$queryRaw<Array<{ exists: number }>>(Prisma.sql`
    SELECT 1 AS "exists"
    FROM information_schema.columns
    WHERE table_name = 'statement_recognition_rules' AND column_name = 'fieldName'
    LIMIT 1
  `);
  return rows.length > 0;
}

function normalizedRuleKeyword(value: string) {
  return normalizeStatementKeywordText(value);
}

function normalizedTransactionType(value?: string | null) {
  const type = cleanText(value);
  return type === "income" || type === "expense" ? type : "any";
}

function targetTypeOrNull(value: string): StatementRecognitionTargetType | null {
  return value === "category" || value === "institution" || value === "field" ? value : null;
}

export async function upsertStatementInstitutionRuleFromUserEdit(client: RawSqlClient, input: StatementInstitutionRuleInput) {
  const householdId = cleanText(input.householdId);
  const institutionId = cleanText(input.institutionId);
  const institutionName = cleanText(input.institutionName);
  const keyword = cleanText(extractStatementLearningKeyword(input.keyword));
  const normalizedKeyword = normalizedRuleKeyword(keyword);
  if (!householdId || !institutionId || !institutionName || !keyword || normalizedKeyword.length < 2) return false;

  const transactionType = normalizedTransactionType(input.transactionType);
  const source = cleanText(input.source) || "user_institution_edit";
  const id = `recog_${randomUUID()}`;
  const priority = 220;

  try {
    await ensureStatementRecognitionRuleFieldNameColumn(client);
    if (isSqliteRuntime()) {
      await client.$executeRaw(Prisma.sql`
        INSERT INTO "statement_recognition_rules" (
          "id", "householdId", "targetType", "transactionType", "keyword", "normalizedKeyword",
          "categoryId", "categoryName", "institutionId", "institutionName", "fieldName", "source", "priority",
          "isActive", "hitCount", "lastSeenAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${id}, ${householdId}, 'institution', ${transactionType}, ${keyword}, ${normalizedKeyword},
          ${null}, ${null}, ${institutionId}, ${institutionName}, ${null}, ${source}, ${priority},
          true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT ("householdId", "targetType", "transactionType", "normalizedKeyword")
        DO UPDATE SET
          "institutionId" = excluded."institutionId",
          "institutionName" = excluded."institutionName",
          "source" = excluded."source",
          "priority" = excluded."priority",
          "isActive" = true,
          "hitCount" = "hitCount" + 1,
          "lastSeenAt" = CURRENT_TIMESTAMP,
          "updatedAt" = CURRENT_TIMESTAMP
      `);
    } else {
      await client.$executeRaw(Prisma.sql`
        INSERT INTO "statement_recognition_rules" (
          "id", "householdId", "targetType", "transactionType", "keyword", "normalizedKeyword",
          "categoryId", "categoryName", "institutionId", "institutionName", "fieldName", "source", "priority",
          "isActive", "hitCount", "lastSeenAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${id}, ${householdId}, 'institution', ${transactionType}, ${keyword}, ${normalizedKeyword},
          ${null}, ${null}, ${institutionId}, ${institutionName}, ${null}, ${source}, ${priority},
          true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT ("householdId", "targetType", "transactionType", "normalizedKeyword")
        DO UPDATE SET
          "institutionId" = EXCLUDED."institutionId",
          "institutionName" = EXCLUDED."institutionName",
          "source" = EXCLUDED."source",
          "priority" = EXCLUDED."priority",
          "isActive" = true,
          "hitCount" = "statement_recognition_rules"."hitCount" + 1,
          "lastSeenAt" = CURRENT_TIMESTAMP,
          "updatedAt" = CURRENT_TIMESTAMP
      `);
    }
    return true;
  } catch (error) {
    if (isStatementRecognitionRuleTableMissing(error)) return false;
    console.error("[statement-recognition-rules] failed to learn institution rule", error);
    return false;
  }
}

export async function upsertStatementCategoryRecognitionRuleFromUserEdit(client: RawSqlClient, input: StatementCategoryRecognitionRuleInput) {
  const householdId = cleanText(input.householdId);
  const categoryId = cleanText(input.categoryId);
  const categoryName = cleanText(input.categoryName);
  const keyword = cleanText(extractStatementLearningKeyword(input.keyword));
  const normalizedKeyword = normalizedRuleKeyword(keyword);
  const transactionType = normalizedTransactionType(input.type);
  if (
    !householdId ||
    !categoryId ||
    !categoryName ||
    !keyword ||
    normalizedKeyword.length < 2 ||
    (transactionType !== "income" && transactionType !== "expense")
  ) {
    return false;
  }

  const source = cleanText(input.source) || "user_category_edit";
  const id = `recog_${randomUUID()}`;
  const priority = 230;

  try {
    await ensureStatementRecognitionRuleFieldNameColumn(client);
    if (isSqliteRuntime()) {
      await client.$executeRaw(Prisma.sql`
        INSERT INTO "statement_recognition_rules" (
          "id", "householdId", "targetType", "transactionType", "keyword", "normalizedKeyword",
          "categoryId", "categoryName", "institutionId", "institutionName", "fieldName", "source", "priority",
          "isActive", "hitCount", "lastSeenAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${id}, ${householdId}, 'category', ${transactionType}, ${keyword}, ${normalizedKeyword},
          ${categoryId}, ${categoryName}, ${null}, ${null}, ${null}, ${source}, ${priority},
          true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT ("householdId", "targetType", "transactionType", "normalizedKeyword")
        DO UPDATE SET
          "categoryId" = excluded."categoryId",
          "categoryName" = excluded."categoryName",
          "source" = excluded."source",
          "priority" = excluded."priority",
          "isActive" = true,
          "hitCount" = "hitCount" + 1,
          "lastSeenAt" = CURRENT_TIMESTAMP,
          "updatedAt" = CURRENT_TIMESTAMP
      `);
    } else {
      await client.$executeRaw(Prisma.sql`
        INSERT INTO "statement_recognition_rules" (
          "id", "householdId", "targetType", "transactionType", "keyword", "normalizedKeyword",
          "categoryId", "categoryName", "institutionId", "institutionName", "fieldName", "source", "priority",
          "isActive", "hitCount", "lastSeenAt", "createdAt", "updatedAt"
        )
        VALUES (
          ${id}, ${householdId}, 'category', ${transactionType}, ${keyword}, ${normalizedKeyword},
          ${categoryId}, ${categoryName}, ${null}, ${null}, ${null}, ${source}, ${priority},
          true, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT ("householdId", "targetType", "transactionType", "normalizedKeyword")
        DO UPDATE SET
          "categoryId" = EXCLUDED."categoryId",
          "categoryName" = EXCLUDED."categoryName",
          "source" = EXCLUDED."source",
          "priority" = EXCLUDED."priority",
          "isActive" = true,
          "hitCount" = "statement_recognition_rules"."hitCount" + 1,
          "lastSeenAt" = CURRENT_TIMESTAMP,
          "updatedAt" = CURRENT_TIMESTAMP
      `);
    }
    return true;
  } catch (error) {
    if (isStatementRecognitionRuleTableMissing(error)) return false;
    console.error("[statement-recognition-rules] failed to learn category rule", error);
    return false;
  }
}

export async function ensureDefaultStatementRecognitionRules(client: RawSqlClient, householdId: string) {
  const scopedHouseholdId = cleanText(householdId);
  if (!scopedHouseholdId) return 0;

  try {
    await ensureStatementRecognitionRuleFieldNameColumn(client);
    const categories = await client.$queryRaw<StatementCategoryRow[]>(Prisma.sql`
      SELECT "id", "type", "name"
      FROM "Category"
      WHERE "householdId" = ${scopedHouseholdId}
        AND "type" IN ('income', 'expense')
    `);
    const institutions = await client.$queryRaw<StatementInstitutionRow[]>(Prisma.sql`
      SELECT "id", "name", "shortName"
      FROM "Institution"
      WHERE "householdId" = ${scopedHouseholdId}
         OR "householdId" IS NULL
    `);
    const categoryIdByKey = new Map(categories.map((category) => [`${category.type}:${category.name}`, category.id]));
    const institutionIdByName = new Map<string, string>();
    for (const institution of institutions) {
      if (institution.name) institutionIdByName.set(institution.name, institution.id);
      if (institution.shortName) institutionIdByName.set(institution.shortName, institution.id);
    }

    let insertedOrSkipped = 0;
    for (const rule of DEFAULT_STATEMENT_RECOGNITION_RULES) {
      const targetType = rule.targetType;
      const transactionType = cleanText(rule.transactionType) || "any";
      const keyword = cleanText(rule.keyword);
      const normalizedKeyword = normalizedRuleKeyword(keyword);
      if (!keyword || normalizedKeyword.length < 2) continue;
      const categoryName = targetType === "category" ? cleanText(rule.categoryName) : "";
      const institutionName = targetType === "institution" ? cleanText(rule.institutionName) : "";
      const fieldName = targetType === "field" ? cleanText(rule.fieldName) : "";
      if (targetType === "category" && !categoryName) continue;
      if (targetType === "institution" && !institutionName) continue;
      if (targetType === "field" && !fieldName) continue;

      const id = `recog_${randomUUID()}`;
      const categoryId = categoryName ? categoryIdByKey.get(`${transactionType}:${categoryName}`) ?? null : null;
      const institutionId = institutionName ? institutionIdByName.get(institutionName) ?? null : null;
      if (targetType === "institution" && !institutionId) continue;
      const priority = Math.max(0, Math.floor(rule.priority ?? 100));

      await client.$executeRaw(Prisma.sql`
        INSERT INTO "statement_recognition_rules" (
          "id", "householdId", "targetType", "transactionType", "keyword", "normalizedKeyword",
          "categoryId", "categoryName", "institutionId", "institutionName", "fieldName", "source", "priority",
          "isActive", "hitCount", "createdAt", "updatedAt"
        )
        VALUES (
          ${id}, ${scopedHouseholdId}, ${targetType}, ${transactionType}, ${keyword}, ${normalizedKeyword},
          ${categoryId}, ${categoryName || null}, ${institutionId}, ${institutionName || null}, ${fieldName || null}, ${SYSTEM_DEFAULT_SOURCE}, ${priority},
          true, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT ("householdId", "targetType", "transactionType", "normalizedKeyword") DO NOTHING
      `);
      insertedOrSkipped += 1;
    }
    return insertedOrSkipped;
  } catch (error) {
    if (isStatementRecognitionRuleTableMissing(error)) return 0;
    console.error("[statement-recognition-rules] failed to seed default rules", error);
    return 0;
  }
}

export async function loadStatementRecognitionRuleSamples(
  client: RawSqlClient,
  householdId: string,
  take = 5000,
): Promise<StatementHistoricalCategorySample[]> {
  const scopedHouseholdId = cleanText(householdId);
  if (!scopedHouseholdId) return [];

  try {
    await ensureStatementRecognitionRuleFieldNameColumn(client);
    if (!defaultRulesSeeded.has(scopedHouseholdId)) {
      await ensureDefaultStatementRecognitionRules(client, scopedHouseholdId);
      defaultRulesSeeded.add(scopedHouseholdId);
    }
    const rows = await client.$queryRaw<StatementRecognitionRuleRow[]>(Prisma.sql`
      SELECT
        "targetType",
        "transactionType",
        "keyword",
        "normalizedKeyword",
        "institutionId",
        "categoryName",
        "institutionName",
        "fieldName",
        "source",
        "priority",
        "hitCount"
      FROM "statement_recognition_rules"
      WHERE "householdId" = ${scopedHouseholdId}
        AND "isActive" = true
      ORDER BY "priority" DESC, "hitCount" DESC, "updatedAt" DESC
      LIMIT ${Math.max(1, Math.min(10000, Math.floor(take)))}
    `);

    const samples: StatementHistoricalCategorySample[] = [];
    for (const row of rows) {
      const targetType = targetTypeOrNull(row.targetType);
      if (!targetType) continue;
      const keyword = cleanText(row.keyword);
      if (!keyword) continue;
      if (targetType === "institution" && !cleanText(row.institutionId)) continue;
      const transactionType = cleanText(row.transactionType) || "any";
      samples.push({
        targetType,
        transactionType,
        type: transactionType === "income" || transactionType === "expense" ? transactionType : "any",
        categoryName: targetType === "category" ? cleanText(row.categoryName) : "",
        institutionName: targetType === "institution" ? cleanText(row.institutionName) : null,
        fieldName: targetType === "field" ? cleanText(row.fieldName) : null,
        counterpartyInstitutionName: null,
        paymentChannelName: null,
        normalizedText: targetType === "category"
          ? normalizeStatementRecognitionText(keyword)
          : cleanText(row.normalizedKeyword),
        weight: Number(row.hitCount ?? 0),
        priority: Number(row.priority ?? 0),
        source: row.source === SYSTEM_DEFAULT_SOURCE ? "system_keyword" : "learned_rule",
        matchText: keyword,
        note: keyword,
      });
    }
    return samples;
  } catch (error) {
    if (isStatementRecognitionRuleTableMissing(error)) return [];
    console.error("[statement-recognition-rules] failed to load recognition rules", error);
    return [];
  }
}
