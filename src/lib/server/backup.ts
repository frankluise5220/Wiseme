import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db/prisma";
import { normalizeAiApiMode } from "@/lib/ai/config";
import { EMAIL_IMPORT_KEYWORD_SETTING_PREFIX } from "@/lib/mail/email-import-settings";
import { upsertEntryBusinessCashFlowLink } from "@/lib/server/entry-business-link";
import {
  getOptionalPrismaDelegate,
  optionalPrismaDeleteMany,
  optionalPrismaFindMany,
  type OptionalPrismaRestoreDelegate,
} from "@/lib/server/optional-prisma-delegate";
import { createManySkipDuplicatesCompat } from "@/lib/server/prisma-create-many";
import { extractStatementLearningKeyword, normalizeStatementKeywordText } from "@/lib/statement/import-normalization";
import { DEFAULT_SESSION_DAYS, normalizeSessionDays } from "@/lib/session-days";
import type { CurrentUser } from "@/lib/server/auth";

export const BACKUP_FORMAT_VERSION = 4;
const ENCRYPTED_BACKUP_PACKAGE_VERSION = 3;
const ENCRYPTED_BACKUP_ALGORITHM = "aes-256-gcm";
const BACKUP_PACKAGE_KEY_SETTING = "backup_package_encryption_key";
const BACKUP_PASSPHRASE_KEY_SOURCE = "passphrase";
const BACKUP_PASSPHRASE_KDF = "pbkdf2-sha256";
const BACKUP_PASSPHRASE_KDF_ITERATIONS = 210_000;

type ExportedBy = Pick<CurrentUser, "id" | "name" | "role"> | null;
export type BackupScope = "system" | "household";
type BackupPackageEncryptionOptions = {
  passphrase?: string | null;
};

export type HouseholdBackupPayload = Awaited<ReturnType<typeof buildHouseholdBackupPayload>>;
export type RestoreHouseholdBackupProgress = {
  stage: "preparing" | "clearing" | "importing" | "restoring" | "finalizing" | "done";
  percent: number;
  label: string;
  detail?: string;
};

function safeFilePart(value: string) {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "mmh"
  );
}

function toIsoString(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function toSheetCellValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) {
    return value.map((item) => toSheetCellValue(item)).join(", ");
  }
  if (value && typeof value === "object") {
    if (typeof (value as { toJSON?: () => unknown }).toJSON === "function") {
      return toSheetCellValue((value as { toJSON: () => unknown }).toJSON());
    }
    return JSON.stringify(value);
  }
  return value;
}

function toPlainRecord<T extends Record<string, unknown>>(record: T) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      return [key, toSheetCellValue(value)];
    }),
  ) as Record<string, unknown>;
}

function summaryRows(payload: HouseholdBackupPayload) {
  return [
    { field: "app", value: payload.app },
    { field: "formatVersion", value: payload.formatVersion },
    { field: "exportedAt", value: toIsoString(payload.exportedAt) },
    { field: "householdName", value: payload.scope.householdName },
    { field: "householdId", value: payload.scope.householdId },
    { field: "exportedBy", value: payload.exportedBy?.name ?? "" },
    { field: "users", value: payload.counts.users },
    { field: "accounts", value: payload.counts.accounts },
    { field: "transactions", value: payload.counts.transactions },
    { field: "statementRecognitionRules", value: payload.counts.statementRecognitionRules },
    { field: "categories", value: payload.counts.categories },
    { field: "tags", value: payload.counts.tags },
    { field: "institutions", value: payload.counts.institutions },
    { field: "counterparties", value: payload.counts.counterparties },
    { field: "emailAccounts", value: payload.counts.emailAccounts },
    { field: "fundQueryApis", value: payload.counts.fundQueryApis },
    { field: "regularInvestPlans", value: payload.counts.regularInvestPlans },
    { field: "businessTransactions", value: payload.counts.businessTransactions },
    { field: "systemSettings", value: payload.counts.systemSettings },
    { field: "accessKeys", value: payload.counts.accessKeys },
    { field: "aiChannels", value: payload.counts.aiChannels },
    { field: "aiModels", value: payload.counts.aiModels },
    { field: "fundNavCaches", value: payload.counts.fundNavCaches },
    { field: "fundSnapshots", value: payload.counts.fundSnapshots },
    { field: "stockBrokerageCatalogs", value: payload.counts.stockBrokerageCatalogs },
    { field: "distillLogs", value: payload.counts.distillLogs },
    { field: "commandTestResults", value: payload.counts.commandTestResults },
    { field: "commandAliases", value: payload.counts.commandAliases },
  ];
}

function sheetRows<T extends Record<string, unknown>>(records: T[]) {
  return records.map((record) => toPlainRecord(record));
}

function omitRecordFields<T extends Record<string, unknown>>(records: T[], fields: Set<string>) {
  return records.map((record) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !fields.has(key))) as Record<string, unknown>,
  );
}

function buildAccountNameById(payload: HouseholdBackupPayload) {
  return new Map(payload.data.accounts.map((account) => [String(account.id), String(account.name ?? "")]));
}

function withGeneratedAccountNames(
  records: Record<string, unknown>[],
  accountNameById: Map<string, string>,
  fields: Array<{ idKey: string; nameKey: string }>,
) {
  return records.map((record) => {
    const next = { ...record };
    for (const field of fields) {
      const id = record[field.idKey] == null ? "" : String(record[field.idKey]);
      if (id && accountNameById.has(id)) {
        next[field.nameKey] = accountNameById.get(id) ?? "";
      }
    }
    return next;
  });
}

function backupText(value: unknown, fallback = "") {
  return value == null ? fallback : String(value);
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null;
}

function backupDate(value: unknown) {
  return value ? new Date(String(value)) : new Date();
}

function cleanedRestoredKeyword(value: unknown, source: string) {
  const raw = backupText(value).trim();
  if (!raw || source === "system_default") return raw;
  return extractStatementLearningKeyword(raw) || raw;
}

function restoredStatementRecognitionRule(
  item: Record<string, unknown>,
  householdId: string,
  importedCategories: Set<string>,
  importedInstitutions: Set<string>,
  categoryNameById = new Map<string, string>(),
) {
  const targetType = backupText(item.targetType, "category");
  if (targetType !== "category" && targetType !== "institution" && targetType !== "field") return null;

  const source = backupText(item.source, "system_default");
  const transactionType = backupText(item.transactionType ?? item.type, "any");
  const keyword = cleanedRestoredKeyword(item.keyword ?? item.matchText, source);
  if (!keyword) return null;

  const normalizedKeyword = cleanedRestoredKeyword(item.normalizedKeyword ?? item.normalizedText ?? keyword, source)
    || normalizeStatementKeywordText(keyword);
  if (!normalizedKeyword) return null;

  const categoryId = item.categoryId && importedCategories.has(String(item.categoryId)) ? String(item.categoryId) : null;
  const categoryName = categoryId
    ? categoryNameById.get(categoryId) ?? backupText(item.categoryName)
    : item.categoryName == null ? null : String(item.categoryName);
  const institutionId = item.institutionId && importedInstitutions.has(String(item.institutionId)) ? String(item.institutionId) : null;
  if (targetType === "category" && !backupText(item.categoryName) && !categoryId) return null;
  if (targetType === "institution" && !backupText(item.institutionName) && !institutionId) return null;
  if (targetType === "field" && !backupText(item.fieldName)) return null;

  return {
    id: backupText(item.id, crypto.randomUUID()),
    householdId,
    targetType,
    transactionType,
    keyword,
    normalizedKeyword,
    categoryId,
    categoryName,
    institutionId,
    institutionName: item.institutionName == null ? null : String(item.institutionName),
    fieldName: item.fieldName == null ? null : String(item.fieldName),
    source,
    priority: Number(item.priority ?? (targetType === "category" ? 230 : 100)),
    isActive: item.isActive == null ? true : Boolean(item.isActive),
    hitCount: Number(item.hitCount ?? 0),
    lastSeenAt: item.lastSeenAt ? new Date(String(item.lastSeenAt)) : null,
    createdAt: backupDate(item.createdAt),
    updatedAt: backupDate(item.updatedAt),
  };
}

function restoredLegacyStatementCategoryRule(
  item: Record<string, unknown>,
  householdId: string,
  importedCategories: Set<string>,
  categoryNameById = new Map<string, string>(),
) {
  const source = backupText(item.source, "user_category_edit");
  const keyword = cleanedRestoredKeyword(item.matchText, source);
  if (!keyword) return null;
  const normalizedKeyword = cleanedRestoredKeyword(item.normalizedText ?? keyword, source) || normalizeStatementKeywordText(keyword);
  if (!normalizedKeyword) return null;
  const categoryId = item.categoryId && importedCategories.has(String(item.categoryId)) ? String(item.categoryId) : null;
  const categoryName = categoryId
    ? categoryNameById.get(categoryId) ?? backupText(item.categoryName)
    : backupText(item.categoryName);
  if (!backupText(item.categoryName) && !categoryId) return null;

  return {
    id: `recog_legacy_${backupText(item.id, crypto.randomUUID())}`,
    householdId,
    targetType: "category",
    transactionType: backupText(item.type, "expense"),
    keyword,
    normalizedKeyword,
    categoryId,
    categoryName,
    institutionId: null,
    institutionName: null,
    fieldName: null,
    source,
    priority: source === "system_default" ? 100 : 230,
    isActive: true,
    hitCount: Number(item.hitCount ?? 1),
    lastSeenAt: item.lastSeenAt ? new Date(String(item.lastSeenAt)) : null,
    createdAt: backupDate(item.createdAt),
    updatedAt: backupDate(item.updatedAt),
  };
}

const TRANSACTION_EXPORT_LABELS: Record<string, string> = {
  id: "记录ID",
  date: "日期",
  createdAt: "创建时间",
  updatedAt: "更新时间",
  dayOrder: "同日顺序",
  type: "类型",
  amount: "金额",
  accountId: "账户ID",
  accountName: "账户名称",
  toAccountId: "对向账户ID",
  toAccountName: "对向账户名称",
  categoryId: "分类ID",
  categoryName: "分类",
  note: "备注",
  toNote: "转账显示备注",
  counterpartyInstitutionId: "收支机构ID",
  counterpartyInstitutionName: "收支机构",
  statementMonth: "账单月份",
  source: "来源",
  fundCode: "基金代码",
  fundName: "基金名称",
  fundProductType: "产品类型",
  fundSubtype: "产品动作",
  fundUnits: "份额",
  fundNav: "净值",
  fundFee: "手续费",
  fundConfirmDate: "确认日期",
  fundArrivalDate: "到账日期",
  fundArrivalAmount: "到账金额",
  depositAnnualRate: "年化利率",
  depositInterest: "利息",
  depositSourceEntryId: "关联存单ID",
  insuranceProductId: "保险产品ID",
  householdId: "账簿ID",
  deletedAt: "删除时间",
};

function labelTransactionRows(records: Record<string, unknown>[]) {
  return records.map((record) => {
    const plain = toPlainRecord(record);
    return Object.fromEntries(
      Object.entries(plain).map(([key, value]) => [TRANSACTION_EXPORT_LABELS[key] ?? key, value]),
    );
  });
}

function restoreError(message: string): never {
  throw new Error(message);
}

function ensureArray(value: unknown, label: string) {
  if (!Array.isArray(value)) {
    restoreError(`备份文件格式错误：${label} 不是数组`);
  }
  return value as Array<Record<string, unknown>>;
}

function ensureObject(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    restoreError(`备份文件格式错误：${label} 不是对象`);
  }
  return value as Record<string, unknown>;
}

function isLegacyFundProductType(value: unknown) {
  const productType = String(value ?? "");
  return !productType || productType === "fund" || productType === "money" || productType === "money_fund";
}

function normalizeLegacyFundProductType(value: unknown) {
  const productType = String(value ?? "");
  return productType === "money" || productType === "money_fund" ? "money" : "fund";
}

function normalizeLegacyFundSubtype(value: unknown) {
  const subtype = String(value ?? "buy");
  return subtype || "buy";
}

function isLegacyFundCashReceipt(item: Record<string, unknown>) {
  const subtype = normalizeLegacyFundSubtype(item.fundSubtype);
  return subtype === "redeem" || subtype === "switch_out" || subtype === "dividend_cash";
}

function isLegacyFundRefundRow(item: Record<string, unknown>) {
  return normalizeLegacyFundSubtype(item.fundSubtype) === "buy_failed" && String(item.source ?? "") === "regular_invest_refund";
}

function legacyFundAccountIdOf(item: Record<string, unknown>) {
  if (isLegacyFundCashReceipt(item) || isLegacyFundRefundRow(item)) return String(item.accountId ?? "");
  return String(item.toAccountId ?? item.accountId ?? "");
}

function legacyFundCashAccountIdOf(item: Record<string, unknown>, importedAccounts: Set<string>) {
  const raw = isLegacyFundCashReceipt(item) || isLegacyFundRefundRow(item) ? item.toAccountId : item.accountId;
  const id = raw == null ? "" : String(raw);
  return id && importedAccounts.has(id) ? id : null;
}

function legacyFundCashFlowKindOf(item: Record<string, unknown>) {
  const subtype = normalizeLegacyFundSubtype(item.fundSubtype);
  if (isLegacyFundRefundRow(item)) return "refund_in";
  if (subtype === "buy" || subtype === "buy_failed") return "buy_out";
  if (subtype === "redeem" || subtype === "switch_out") return "redeem_in";
  if (subtype === "dividend_cash") return "dividend_in";
  if (subtype === "dividend_reinvest") return "dividend_reinvest_internal";
  if (subtype === "switch_in") return "switch_in";
  return "other";
}

function absDecimalString(value: unknown) {
  const amount = Math.abs(Number(String(value ?? "0")));
  return Number.isFinite(amount) ? String(amount) : "0";
}

function legacyDate(value: unknown) {
  return value == null || value === "" ? null : new Date(String(value));
}

function normalizeRecordDates(record: Record<string, unknown>, nullDateKeys = new Set<string>()) {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const lowerKey = key.toLowerCase();
    const isDateField = key === "date" || lowerKey.endsWith("date") || lowerKey.endsWith("at");
    if (isDateField) {
      if (value == null || value === "") {
        normalized[key] = nullDateKeys.has(key) ? null : value;
      } else {
        normalized[key] = new Date(String(value));
      }
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

async function createManyRecords(
  delegate: unknown,
  records: Record<string, unknown>[],
  nullDateKeys = new Set<string>(),
) {
  if (records.length === 0) return;
  const target = delegate as { createMany: (args: { data: Record<string, unknown>[] }) => Promise<unknown> };
  await target.createMany({ data: records.map((record) => normalizeRecordDates(record, nullDateKeys)) });
}

const RESTORE_CREATE_MANY_BATCH_SIZE = 500;

type RawExecuteClient = {
  $executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
};

async function createMappedRecordsInChunks<T>(
  delegate: unknown,
  records: T[],
  mapper: (record: T) => Record<string, unknown> | null,
  options: {
    batchSize?: number;
    nullDateKeys?: Set<string>;
    afterChunk?: (completed: number, total: number) => void | Promise<void>;
    fastInsert?: (records: Record<string, unknown>[]) => Promise<void>;
  } = {},
) {
  if (records.length === 0) return;
  const batchSize = options.batchSize ?? RESTORE_CREATE_MANY_BATCH_SIZE;
  const nullDateKeys = options.nullDateKeys ?? new Set<string>();
  const target = delegate as { createMany: (args: { data: Record<string, unknown>[] }) => Promise<unknown> };
  let completed = 0;
  let batch: Record<string, unknown>[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const normalized = batch.map((record) => normalizeRecordDates(record, nullDateKeys));
    if (options.fastInsert) {
      await options.fastInsert(normalized);
    } else {
      await target.createMany({ data: normalized });
    }
    batch = [];
    await options.afterChunk?.(completed, records.length);
  };

  for (const record of records) {
    completed += 1;
    const mapped = mapper(record);
    if (mapped) {
      batch.push(mapped);
    }
    if (batch.length >= batchSize) {
      await flush();
    }
  }
  await flush();
}

type RestoredCategoryRecord = {
  id: string;
  name: string;
  type: string;
  icon: string | null;
  parentId: string | null;
  householdId: string;
  isSystem: boolean;
};

function buildRestoredCategoryBatches(items: Record<string, unknown>[], householdId: string) {
  const records: RestoredCategoryRecord[] = [];
  const seenIds = new Set<string>();

  for (const item of items) {
    const id = backupText(item.id).trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);

    const parentId = backupText(item.parentId).trim();
    records.push({
      id,
      name: backupText(item.name).trim() || "未命名分类",
      type: backupText(item.type, "expense"),
      icon: item.icon == null ? null : String(item.icon),
      parentId: parentId || null,
      householdId,
      isSystem: Boolean(item.isSystem),
    });
  }

  const recordIds = new Set(records.map((record) => record.id));
  for (const record of records) {
    if (record.parentId === record.id || !recordIds.has(record.parentId ?? "")) {
      record.parentId = null;
    }
  }

  const recordById = new Map(records.map((record) => [record.id, record]));
  const usedNames = new Set<string>();
  for (const record of records) {
    let candidateName = record.name;
    if (usedNames.has(candidateName)) {
      const parentName = record.parentId ? recordById.get(record.parentId)?.name.trim() : "";
      const baseName = `${parentName || "分类"}·${record.name}`;
      let suffix = 2;
      candidateName = baseName;
      while (usedNames.has(candidateName)) {
        candidateName = `${baseName}（${suffix}）`;
        suffix += 1;
      }
    }
    record.name = candidateName;
    usedNames.add(candidateName);
  }

  const pending = new Map(records.map((record) => [record.id, record]));
  const inserted = new Set<string>();
  const batches: RestoredCategoryRecord[][] = [];

  while (pending.size > 0) {
    const batch: RestoredCategoryRecord[] = [];
    for (const record of pending.values()) {
      if (!record.parentId || inserted.has(record.parentId)) {
        batch.push(record);
      }
    }

    if (batch.length === 0) {
      const firstPending = pending.values().next().value;
      if (!firstPending) break;
      firstPending.parentId = null;
      continue;
    }

    batches.push(batch);
    for (const record of batch) {
      pending.delete(record.id);
      inserted.add(record.id);
    }
  }

  return batches;
}

function isSqliteRuntime() {
  const url = String(process.env.DATABASE_URL ?? "");
  return url === ":memory:" || url.startsWith("file:");
}

const TRANSACTION_RESTORE_COLUMNS = [
  { name: "id", select: 'x."id"' },
  { name: "date", select: "NULLIF(x.\"date\", '')::timestamptz" },
  { name: "postedAt", select: "NULLIF(x.\"postedAt\", '')::timestamptz" },
  { name: "type", select: 'x."type"::"TransactionType"' },
  { name: "amount", select: "NULLIF(x.\"amount\", '')::numeric" },
  { name: "accountId", select: 'x."accountId"' },
  { name: "accountName", select: 'x."accountName"' },
  { name: "toAccountId", select: 'x."toAccountId"' },
  { name: "toAccountName", select: 'x."toAccountName"' },
  { name: "categoryId", select: 'x."categoryId"' },
  { name: "categoryName", select: 'x."categoryName"' },
  { name: "fundCode", select: 'x."fundCode"' },
  { name: "fundProductType", select: 'x."fundProductType"::"FundProductType"' },
  { name: "metalTypeId", select: 'x."metalTypeId"' },
  { name: "metalTypeName", select: 'x."metalTypeName"' },
  { name: "metalUnitId", select: 'x."metalUnitId"' },
  { name: "metalUnitName", select: 'x."metalUnitName"' },
  { name: "metalQuantity", select: "NULLIF(x.\"metalQuantity\", '')::numeric" },
  { name: "metalUnitPrice", select: "NULLIF(x.\"metalUnitPrice\", '')::numeric" },
  { name: "metalFee", select: "NULLIF(x.\"metalFee\", '')::numeric" },
  { name: "confirmDate", select: "NULLIF(x.\"confirmDate\", '')::timestamptz" },
  { name: "statementMonth", select: 'x."statementMonth"' },
  { name: "note", select: 'x."note"' },
  { name: "toNote", select: 'x."toNote"' },
  { name: "deletedAt", select: "NULLIF(x.\"deletedAt\", '')::timestamptz" },
  { name: "importBatchId", select: 'x."importBatchId"' },
  { name: "householdId", select: 'x."householdId"' },
  { name: "createdAt", select: "NULLIF(x.\"createdAt\", '')::timestamptz" },
  { name: "updatedAt", select: "NULLIF(x.\"updatedAt\", '')::timestamptz" },
  { name: "dayOrder", select: "NULLIF(x.\"dayOrder\", '')::integer" },
  { name: "currency", select: 'x."currency"' },
  { name: "paymentChannelId", select: 'x."paymentChannelId"' },
  { name: "paymentChannelName", select: 'x."paymentChannelName"' },
  { name: "counterpartyInstitutionId", select: 'x."counterpartyInstitutionId"' },
  { name: "counterpartyInstitutionName", select: 'x."counterpartyInstitutionName"' },
  { name: "status", select: 'x."status"::"TransactionStatus"' },
  { name: "fundArrivalAmount", select: "NULLIF(x.\"fundArrivalAmount\", '')::numeric" },
  { name: "fundArrivalDate", select: "NULLIF(x.\"fundArrivalDate\", '')::timestamptz" },
  { name: "depositAnnualRate", select: "NULLIF(x.\"depositAnnualRate\", '')::numeric" },
  { name: "depositInterest", select: "NULLIF(x.\"depositInterest\", '')::numeric" },
  { name: "depositSourceEntryId", select: 'x."depositSourceEntryId"' },
  { name: "fundSourceEntryId", select: 'x."fundSourceEntryId"' },
  { name: "debtPrincipalAmount", select: "NULLIF(x.\"debtPrincipalAmount\", '')::numeric" },
  { name: "debtInterestAmount", select: "NULLIF(x.\"debtInterestAmount\", '')::numeric" },
  { name: "debtFeeAmount", select: "NULLIF(x.\"debtFeeAmount\", '')::numeric" },
  { name: "fundConfirmDate", select: "NULLIF(x.\"fundConfirmDate\", '')::timestamptz" },
  { name: "fundFee", select: "NULLIF(x.\"fundFee\", '')::numeric" },
  { name: "fundNav", select: "NULLIF(x.\"fundNav\", '')::numeric" },
  { name: "fundSubtype", select: 'x."fundSubtype"::"FundSubtype"' },
  { name: "fundUnits", select: "NULLIF(x.\"fundUnits\", '')::numeric" },
  { name: "realizedProfit", select: "NULLIF(x.\"realizedProfit\", '')::numeric" },
  { name: "regularInvestPlanId", select: 'x."regularInvestPlanId"' },
  { name: "creditCardInstallmentPlanId", select: 'x."creditCardInstallmentPlanId"' },
  { name: "installmentNo", select: "NULLIF(x.\"installmentNo\", '')::integer" },
  { name: "installmentTotal", select: "NULLIF(x.\"installmentTotal\", '')::integer" },
  { name: "installmentPrincipal", select: "NULLIF(x.\"installmentPrincipal\", '')::numeric" },
  { name: "installmentInterest", select: "NULLIF(x.\"installmentInterest\", '')::numeric" },
  { name: "installmentRole", select: 'x."installmentRole"' },
  { name: "fundName", select: 'x."fundName"' },
  { name: "wealthProductId", select: 'x."wealthProductId"' },
  { name: "insuranceProductId", select: 'x."insuranceProductId"' },
  { name: "insuranceAction", select: 'x."insuranceAction"' },
  { name: "insuranceProductName", select: 'x."insuranceProductName"' },
  { name: "source", select: 'x."source"' },
] as const;

const TRANSACTION_RESTORE_INSERT_SQL = `INSERT INTO "transactions" (${TRANSACTION_RESTORE_COLUMNS
  .map((column) => `"${column.name}"`)
  .join(", ")}) SELECT ${TRANSACTION_RESTORE_COLUMNS.map((column) => column.select).join(", ")} FROM jsonb_to_recordset($1::jsonb) AS x(${TRANSACTION_RESTORE_COLUMNS
  .map((column) => `"${column.name}" text`)
  .join(", ")})`;

async function insertTransactionsViaJson(delegate: RawExecuteClient, records: Record<string, unknown>[]) {
  if (records.length === 0) return;
  await delegate.$executeRawUnsafe(TRANSACTION_RESTORE_INSERT_SQL, JSON.stringify(records));
}

const SQLITE_STOCK_RESTORE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS "stock_securities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "stockCode" TEXT NOT NULL,
    "stockName" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "exchange" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_securities_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "stock_holdings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "securityId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "stockCode" TEXT NOT NULL,
    "stockName" TEXT,
    "quantity" DECIMAL NOT NULL DEFAULT 0,
    "avgCost" DECIMAL NOT NULL DEFAULT 0,
    "cost" DECIMAL NOT NULL DEFAULT 0,
    "latestPrice" DECIMAL,
    "marketValue" DECIMAL NOT NULL DEFAULT 0,
    "historicalProfit" DECIMAL NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_holdings_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "stock_holdings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "stock_holdings_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "stock_securities"("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "stock_transactions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdId" TEXT NOT NULL,
    "stockAccountId" TEXT NOT NULL,
    "cashAccountId" TEXT,
    "cashEntryId" TEXT,
    "securityId" TEXT,
    "market" TEXT NOT NULL,
    "stockCode" TEXT NOT NULL,
    "stockName" TEXT,
    "action" TEXT NOT NULL,
    "source" TEXT DEFAULT 'manual',
    "tradeDate" DATETIME NOT NULL,
    "settleDate" DATETIME,
    "grossAmount" DECIMAL NOT NULL,
    "netAmount" DECIMAL,
    "quantity" DECIMAL,
    "price" DECIMAL,
    "fee" DECIMAL,
    "commission" DECIMAL,
    "stampTax" DECIMAL,
    "transferFee" DECIMAL,
    "exchangeFee" DECIMAL,
    "regulatoryFee" DECIMAL,
    "otherFee" DECIMAL,
    "realizedProfit" DECIMAL,
    "externalLinkId" TEXT,
    "brokerTradeId" TEXT,
    "note" TEXT,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_transactions_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "stock_transactions_stockAccountId_fkey" FOREIGN KEY ("stockAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "stock_transactions_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "stock_transactions_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "stock_securities"("id") ON DELETE SET NULL ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "stock_price_cache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "securityId" TEXT,
    "market" TEXT NOT NULL,
    "stockCode" TEXT NOT NULL,
    "priceDate" DATETIME NOT NULL,
    "closePrice" DECIMAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_price_cache_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "stock_securities"("id") ON DELETE SET NULL ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "stock_fee_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "securityId" TEXT,
    "market" TEXT,
    "stockCode" TEXT,
    "feeType" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'both',
    "rate" DECIMAL,
    "amount" DECIMAL,
    "minAmount" DECIMAL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "effectiveDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_fee_rules_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "stock_fee_rules_securityId_fkey" FOREIGN KEY ("securityId") REFERENCES "stock_securities"("id") ON DELETE SET NULL ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "stock_market_fee_rules" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdId" TEXT,
    "market" TEXT NOT NULL,
    "stockCode" TEXT,
    "feeType" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'both',
    "rate" DECIMAL,
    "amount" DECIMAL,
    "minAmount" DECIMAL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "effectiveDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'system',
    "sourceUrl" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stock_market_fee_rules_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "stock_brokerage_catalog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "aliases" TEXT,
    "registryCode" TEXT,
    "officialWebsite" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "sourceUrl" TEXT,
    "sourceUpdatedAt" DATETIME,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "stock_securities_householdId_market_stockCode_key" ON "stock_securities"("householdId", "market", "stockCode")`,
  `CREATE INDEX IF NOT EXISTS "stock_securities_householdId_stockName_idx" ON "stock_securities"("householdId", "stockName")`,
  `CREATE INDEX IF NOT EXISTS "stock_securities_market_stockCode_idx" ON "stock_securities"("market", "stockCode")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "stock_holdings_accountId_securityId_key" ON "stock_holdings"("accountId", "securityId")`,
  `CREATE INDEX IF NOT EXISTS "stock_holdings_householdId_accountId_idx" ON "stock_holdings"("householdId", "accountId")`,
  `CREATE INDEX IF NOT EXISTS "stock_holdings_accountId_idx" ON "stock_holdings"("accountId")`,
  `CREATE INDEX IF NOT EXISTS "stock_holdings_securityId_idx" ON "stock_holdings"("securityId")`,
  `CREATE INDEX IF NOT EXISTS "stock_holdings_market_stockCode_idx" ON "stock_holdings"("market", "stockCode")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "stock_transactions_cashEntryId_key" ON "stock_transactions"("cashEntryId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "stock_transactions_householdId_stockAccountId_externalLinkId_key" ON "stock_transactions"("householdId", "stockAccountId", "externalLinkId")`,
  `CREATE INDEX IF NOT EXISTS "stock_transactions_householdId_stockAccountId_tradeDate_idx" ON "stock_transactions"("householdId", "stockAccountId", "tradeDate")`,
  `CREATE INDEX IF NOT EXISTS "stock_transactions_cashAccountId_tradeDate_idx" ON "stock_transactions"("cashAccountId", "tradeDate")`,
  `CREATE INDEX IF NOT EXISTS "stock_transactions_securityId_tradeDate_idx" ON "stock_transactions"("securityId", "tradeDate")`,
  `CREATE INDEX IF NOT EXISTS "stock_transactions_market_stockCode_tradeDate_idx" ON "stock_transactions"("market", "stockCode", "tradeDate")`,
  `CREATE INDEX IF NOT EXISTS "stock_transactions_brokerTradeId_idx" ON "stock_transactions"("brokerTradeId")`,
  `CREATE INDEX IF NOT EXISTS "stock_transactions_deletedAt_idx" ON "stock_transactions"("deletedAt")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "stock_price_cache_market_stockCode_priceDate_key" ON "stock_price_cache"("market", "stockCode", "priceDate")`,
  `CREATE INDEX IF NOT EXISTS "stock_price_cache_securityId_priceDate_idx" ON "stock_price_cache"("securityId", "priceDate")`,
  `CREATE INDEX IF NOT EXISTS "stock_price_cache_priceDate_idx" ON "stock_price_cache"("priceDate")`,
  `CREATE INDEX IF NOT EXISTS "stock_fee_rules_accountId_feeType_direction_idx" ON "stock_fee_rules"("accountId", "feeType", "direction")`,
  `CREATE INDEX IF NOT EXISTS "stock_fee_rules_accountId_securityId_feeType_direction_idx" ON "stock_fee_rules"("accountId", "securityId", "feeType", "direction")`,
  `CREATE INDEX IF NOT EXISTS "stock_fee_rules_accountId_market_stockCode_feeType_direction_idx" ON "stock_fee_rules"("accountId", "market", "stockCode", "feeType", "direction")`,
  `CREATE INDEX IF NOT EXISTS "stock_fee_rules_effectiveDate_idx" ON "stock_fee_rules"("effectiveDate")`,
  `CREATE INDEX IF NOT EXISTS "stock_market_fee_rules_householdId_market_stockCode_feeType_direction_idx" ON "stock_market_fee_rules"("householdId", "market", "stockCode", "feeType", "direction")`,
  `CREATE INDEX IF NOT EXISTS "stock_market_fee_rules_market_stockCode_feeType_direction_idx" ON "stock_market_fee_rules"("market", "stockCode", "feeType", "direction")`,
  `CREATE INDEX IF NOT EXISTS "stock_market_fee_rules_effectiveDate_idx" ON "stock_market_fee_rules"("effectiveDate")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "stock_brokerage_catalog_name_key" ON "stock_brokerage_catalog"("name")`,
  `CREATE INDEX IF NOT EXISTS "stock_brokerage_catalog_shortName_idx" ON "stock_brokerage_catalog"("shortName")`,
  `CREATE INDEX IF NOT EXISTS "stock_brokerage_catalog_registryCode_idx" ON "stock_brokerage_catalog"("registryCode")`,
  `CREATE INDEX IF NOT EXISTS "stock_brokerage_catalog_isActive_idx" ON "stock_brokerage_catalog"("isActive")`,
] as const;

const SQLITE_PROPERTY_RESTORE_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS "property_assets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "mortgageLoanAccountId" TEXT,
    "name" TEXT NOT NULL,
    "propertyType" TEXT,
    "address" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "purchaseDate" DATETIME,
    "purchasePrice" DECIMAL,
    "cost" DECIMAL NOT NULL DEFAULT 0,
    "marketValue" DECIMAL NOT NULL DEFAULT 0,
    "latestValuationDate" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'active',
    "note" TEXT,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "property_assets_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "property_assets_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "property_assets_mortgageLoanAccountId_fkey" FOREIGN KEY ("mortgageLoanAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "property_valuations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdId" TEXT NOT NULL,
    "propertyAssetId" TEXT NOT NULL,
    "valuationDate" DATETIME NOT NULL,
    "marketValue" DECIMAL NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "property_valuations_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "property_valuations_propertyAssetId_fkey" FOREIGN KEY ("propertyAssetId") REFERENCES "property_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "property_transactions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "householdId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "cashAccountId" TEXT,
    "cashEntryId" TEXT,
    "propertyAssetId" TEXT NOT NULL,
    "action" TEXT NOT NULL DEFAULT 'purchase',
    "source" TEXT DEFAULT 'manual',
    "tradeDate" DATETIME NOT NULL,
    "settlementDate" DATETIME,
    "amount" DECIMAL NOT NULL,
    "fee" DECIMAL,
    "tax" DECIMAL,
    "realizedProfit" DECIMAL,
    "note" TEXT,
    "deletedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "property_transactions_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "Household"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "property_transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "property_transactions_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "property_transactions_propertyAssetId_fkey" FOREIGN KEY ("propertyAssetId") REFERENCES "property_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "property_transactions_cashEntryId_fkey" FOREIGN KEY ("cashEntryId") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS "property_assets_householdId_accountId_idx" ON "property_assets"("householdId", "accountId")`,
  `CREATE INDEX IF NOT EXISTS "property_assets_householdId_mortgageLoanAccountId_idx" ON "property_assets"("householdId", "mortgageLoanAccountId")`,
  `CREATE INDEX IF NOT EXISTS "property_assets_householdId_status_idx" ON "property_assets"("householdId", "status")`,
  `CREATE INDEX IF NOT EXISTS "property_assets_accountId_idx" ON "property_assets"("accountId")`,
  `CREATE INDEX IF NOT EXISTS "property_assets_deletedAt_idx" ON "property_assets"("deletedAt")`,
  `CREATE INDEX IF NOT EXISTS "property_valuations_householdId_valuationDate_idx" ON "property_valuations"("householdId", "valuationDate")`,
  `CREATE INDEX IF NOT EXISTS "property_valuations_propertyAssetId_valuationDate_idx" ON "property_valuations"("propertyAssetId", "valuationDate")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "property_transactions_cashEntryId_key" ON "property_transactions"("cashEntryId") WHERE "cashEntryId" IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS "property_transactions_householdId_accountId_tradeDate_idx" ON "property_transactions"("householdId", "accountId", "tradeDate")`,
  `CREATE INDEX IF NOT EXISTS "property_transactions_cashAccountId_tradeDate_idx" ON "property_transactions"("cashAccountId", "tradeDate")`,
  `CREATE INDEX IF NOT EXISTS "property_transactions_propertyAssetId_tradeDate_idx" ON "property_transactions"("propertyAssetId", "tradeDate")`,
  `CREATE INDEX IF NOT EXISTS "property_transactions_deletedAt_idx" ON "property_transactions"("deletedAt")`,
] as const;

function quoteSqliteIdent(value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error("Unsafe SQLite schema identifier");
  }
  return `"${value}"`;
}

async function ensureSqliteColumn(tableName: string, columnName: string, definition: string) {
  const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info(${quoteSqliteIdent(tableName)})`);
  if (columns.length === 0 || columns.some((column) => column.name === columnName)) return;
  await prisma.$executeRawUnsafe(`ALTER TABLE ${quoteSqliteIdent(tableName)} ADD COLUMN ${quoteSqliteIdent(columnName)} ${definition}`);
}

type SqliteSchemaBackfillResult = {
  skippedColumns: string[];
};

function nativeInitSqlCandidates() {
  const candidates = new Set<string>();
  if (process.env.PRISMA_SCHEMA_PATH) {
    candidates.add(path.join(path.dirname(process.env.PRISMA_SCHEMA_PATH), "native-init.sql"));
  }
  candidates.add(path.join(process.cwd(), "prisma", "native-init.sql"));
  candidates.add(path.join(process.cwd(), "server", "prisma", "native-init.sql"));
  if (process.argv[1]) {
    candidates.add(path.join(path.dirname(process.argv[1]), "prisma", "native-init.sql"));
  }
  return [...candidates];
}

function findNativeInitSqlPath() {
  return nativeInitSqlCandidates().find((candidate) => fs.existsSync(candidate)) ?? null;
}

function splitSqlStatements(sql: string) {
  const statements: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    current += char;
    if (quote) {
      if (char === quote) {
        if (next === quote) {
          current += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ";") {
      const statement = current.slice(0, -1).trim();
      if (statement) statements.push(statement);
      current = "";
    }
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

function splitSqlListItems(value: string) {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const next = value[i + 1];
    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) {
          current += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      const item = current.trim();
      if (item) items.push(item);
      current = "";
      continue;
    }
    current += char;
  }
  const tail = current.trim();
  if (tail) items.push(tail);
  return items;
}

function createTableNameFromStatement(statement: string) {
  const match = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([^"\s(]+)"?/i.exec(statement.trim());
  return match ? match[1] : "";
}

function createIndexTableNameFromStatement(statement: string) {
  const match = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"?[^"\s(]+"?\s+ON\s+"?([^"\s(]+)"?/i.exec(statement.trim());
  return match ? match[1] : "";
}

function createIndexStatementIfMissing(statement: string) {
  const trimmed = statement.trim();
  if (/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+/i.test(trimmed)) return trimmed;
  if (/^CREATE\s+UNIQUE\s+INDEX\s+/i.test(trimmed)) {
    return trimmed.replace(/^CREATE\s+UNIQUE\s+INDEX\s+/i, "CREATE UNIQUE INDEX IF NOT EXISTS ");
  }
  return trimmed.replace(/^CREATE\s+INDEX\s+/i, "CREATE INDEX IF NOT EXISTS ");
}

function createTableBodyFromStatement(statement: string) {
  const trimmed = statement.trim();
  const start = trimmed.indexOf("(");
  if (start < 0) return "";
  let body = "";
  let quote: string | null = null;
  let depth = 1;
  for (let i = start + 1; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    const next = trimmed[i + 1];
    if (quote) {
      body += char;
      if (char === quote) {
        if (next === quote) {
          body += next;
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      body += char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      body += char;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return body;
      body += char;
      continue;
    }
    body += char;
  }
  return "";
}

function createTableColumnDefinitionsFromStatement(statement: string) {
  const columns: Array<{ name: string; definition: string }> = [];
  for (const item of splitSqlListItems(createTableBodyFromStatement(statement))) {
    const trimmed = item.trim();
    if (!trimmed || /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/i.test(trimmed)) continue;
    const quoted = /^"([^"]+)"\s+([\s\S]+)$/.exec(trimmed);
    if (quoted) {
      columns.push({ name: quoted[1], definition: quoted[2].trim() });
      continue;
    }
    const bare = /^([A-Za-z_][A-Za-z0-9_]*)\s+([\s\S]+)$/.exec(trimmed);
    if (bare) columns.push({ name: bare[1], definition: bare[2].trim() });
  }
  return columns;
}

function canAddColumnFromCreateTableDefinition(definition: string) {
  const upper = definition.toUpperCase();
  if (/\bPRIMARY\s+KEY\b|\bUNIQUE\b/.test(upper)) return false;
  if (/\bGENERATED\b|\bAS\s*\(/.test(upper)) return false;
  if (/\bNOT\s+NULL\b/.test(upper) && !/\bDEFAULT\b/.test(upper)) return false;
  if (/\bDEFAULT\s+(?:CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP)\b/.test(upper)) return false;
  if (/\bDEFAULT\s*\(/.test(upper)) return false;
  return true;
}

async function sqliteTableExists(tableName: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    tableName,
  );
  return rows.length > 0;
}

async function sqliteTableSql(tableName: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ sql: string | null }>>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    tableName,
  );
  return rows[0]?.sql ?? "";
}

async function sqliteTableHasBrokenTxRecordCashEntryFk(tableName: string) {
  const sql = await sqliteTableSql(tableName);
  return /REFERENCES\s+"TxRecord"\s*\(\s*"id"\s*\)/i.test(sql);
}

async function rebuildSqliteTableWithoutBrokenTxRecordCashEntryFk(
  tableName: string,
  createSql: string,
) {
  if (!(await sqliteTableHasBrokenTxRecordCashEntryFk(tableName))) return;
  const tempName = `${tableName}__txrecord_fk_fix`;
  const columns = [...(await sqliteColumnNames(tableName))];
  if (columns.length === 0) return;
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS ${quoteSqliteIdent(tempName)}`);
  await prisma.$executeRawUnsafe(
    `ALTER TABLE ${quoteSqliteIdent(tableName)} RENAME TO ${quoteSqliteIdent(tempName)}`,
  );
  await prisma.$executeRawUnsafe(createSql.replace(/CREATE TABLE IF NOT EXISTS/i, "CREATE TABLE"));
  const quotedColumns = columns.map((column) => quoteSqliteIdent(column)).join(", ");
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${quoteSqliteIdent(tableName)} (${quotedColumns}) SELECT ${quotedColumns} FROM ${quoteSqliteIdent(tempName)}`,
  );
  await prisma.$executeRawUnsafe(`DROP TABLE ${quoteSqliteIdent(tempName)}`);
}

async function sqliteColumnNames(tableName: string) {
  const columns = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info(${quoteSqliteIdent(tableName)})`);
  return new Set(columns.map((column) => column.name));
}

async function sqliteIndexColumnsExist(tableName: string, columnNames: string[]) {
  if (!columnNames.length) return true;
  const existing = await sqliteColumnNames(tableName);
  return columnNames.every((columnName) => existing.has(columnName));
}

function createIndexColumnNamesFromStatement(statement: string) {
  const match = /\(([^()]*)\)\s*(?:WHERE\s+.*)?$/i.exec(statement.trim());
  if (!match) return [];
  const names: string[] = [];
  for (const item of splitSqlListItems(match[1])) {
    const normalized = item.trim().replace(/\s+(?:ASC|DESC)\s*$/i, "");
    const quoted = /^"([^"]+)"$/.exec(normalized);
    if (quoted) {
      names.push(quoted[1]);
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
      names.push(normalized);
      continue;
    }
    return [];
  }
  return names;
}

async function applyNativeInitSqlSchemaBackfillForRestore(): Promise<SqliteSchemaBackfillResult> {
  const sqlPath = findNativeInitSqlPath();
  const result: SqliteSchemaBackfillResult = { skippedColumns: [] };
  if (!sqlPath) return result;

  const statements = splitSqlStatements(fs.readFileSync(sqlPath, "utf8"));
  for (const statement of statements) {
    if (!/^CREATE\s+TABLE\s+/i.test(statement)) continue;
    const tableName = createTableNameFromStatement(statement);
    if (!tableName || await sqliteTableExists(tableName)) continue;
    await prisma.$executeRawUnsafe(statement);
  }

  for (const statement of statements) {
    if (!/^CREATE\s+TABLE\s+/i.test(statement)) continue;
    const tableName = createTableNameFromStatement(statement);
    if (!tableName || !(await sqliteTableExists(tableName))) continue;
    const existingColumns = await sqliteColumnNames(tableName);
    for (const column of createTableColumnDefinitionsFromStatement(statement)) {
      if (existingColumns.has(column.name)) continue;
      const label = `${tableName}.${column.name}`;
      if (!canAddColumnFromCreateTableDefinition(column.definition)) {
        result.skippedColumns.push(label);
        continue;
      }
      try {
        await ensureSqliteColumn(tableName, column.name, column.definition);
        existingColumns.add(column.name);
      } catch {
        result.skippedColumns.push(label);
      }
    }
  }

  for (const statement of statements) {
    if (!/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+/i.test(statement)) continue;
    const tableName = createIndexTableNameFromStatement(statement);
    if (!tableName || !(await sqliteTableExists(tableName))) continue;
    if (!(await sqliteIndexColumnsExist(tableName, createIndexColumnNamesFromStatement(statement)))) continue;
    try {
      await prisma.$executeRawUnsafe(createIndexStatementIfMissing(statement));
    } catch {
      // Compatible indexes are best-effort during restore preflight; data safety is guarded by table/column checks.
    }
  }

  return result;
}

export async function ensureSqliteRestoreCompatibilitySchema() {
  if (!isSqliteRuntime()) return;
  const propertyTransactionsCreateSql = SQLITE_PROPERTY_RESTORE_SCHEMA_SQL.find((statement) =>
    /CREATE TABLE IF NOT EXISTS "property_transactions"/i.test(statement),
  );
  if (propertyTransactionsCreateSql) {
    await rebuildSqliteTableWithoutBrokenTxRecordCashEntryFk(
      "property_transactions",
      propertyTransactionsCreateSql,
    );
  }
  for (const statement of [...SQLITE_STOCK_RESTORE_SCHEMA_SQL, ...SQLITE_PROPERTY_RESTORE_SCHEMA_SQL]) {
    await prisma.$executeRawUnsafe(statement);
  }
  const nativeSchemaBackfill = await applyNativeInitSqlSchemaBackfillForRestore();
  if (nativeSchemaBackfill.skippedColumns.length > 0) {
    restoreError(`当前 SQLite 数据库缺少无法自动补齐的字段：${nativeSchemaBackfill.skippedColumns.join("、")}。请先升级到包含显式数据库迁移的版本后再恢复。`);
  }
  await ensureSqliteColumn("UserSettings", "sessionDays", "INTEGER NOT NULL DEFAULT 30");
  await ensureSqliteColumn("entry_business_links", "stockTransactionId", "TEXT");
  await ensureSqliteColumn("entry_business_links", "propertyTransactionId", "TEXT");
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "entry_business_links_stockTransactionId_idx" ON "entry_business_links"("stockTransactionId")`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "entry_business_links_propertyTransactionId_idx" ON "entry_business_links"("propertyTransactionId")`,
  );
}

function decodeBackupPackageKey(value: string) {
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    restoreError("当前系统备份加密密钥格式错误，无法处理加密备份");
  }
  return key;
}

async function getOrCreateBackupPackageKey() {
  const existing = await prisma.systemSetting.findUnique({ where: { key: BACKUP_PACKAGE_KEY_SETTING } });
  if (existing?.value) {
    return decodeBackupPackageKey(existing.value);
  }

  const generatedValue = crypto.randomBytes(32).toString("base64");
  try {
    const created = await prisma.systemSetting.create({
      data: { key: BACKUP_PACKAGE_KEY_SETTING, value: generatedValue },
    });
    return decodeBackupPackageKey(created.value);
  } catch {
    const retry = await prisma.systemSetting.findUnique({ where: { key: BACKUP_PACKAGE_KEY_SETTING } });
    if (retry?.value) {
      return decodeBackupPackageKey(retry.value);
    }
    restoreError("当前系统无法创建备份加密密钥");
  }
}

async function getBackupPackageKey() {
  const existing = await prisma.systemSetting.findUnique({ where: { key: BACKUP_PACKAGE_KEY_SETTING } });
  if (!existing?.value) {
    restoreError("当前系统缺少备份解密密钥，无法恢复该加密备份");
  }
  return decodeBackupPackageKey(existing.value);
}

function normalizeBackupPassphrase(value: string | null | undefined) {
  const passphrase = String(value ?? "").trim();
  return passphrase || null;
}

function deriveBackupPassphraseKey(passphrase: string, salt: Buffer, iterations: number) {
  return new Promise<Buffer>((resolve, reject) => {
    crypto.pbkdf2(passphrase, salt, iterations, 32, "sha256", (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(key);
    });
  });
}

function backupPassphraseIterations(value: unknown) {
  const iterations = Number(value ?? BACKUP_PASSPHRASE_KDF_ITERATIONS);
  if (!Number.isInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) {
    restoreError("备份加密参数错误");
  }
  return iterations;
}

function decodeBackupPassphraseSalt(value: unknown) {
  const salt = Buffer.from(String(value ?? ""), "base64");
  if (salt.length < 16) {
    restoreError("备份加密参数错误");
  }
  return salt;
}

async function getBackupEncryptionKey(options: BackupPackageEncryptionOptions = {}) {
  const passphrase = normalizeBackupPassphrase(options.passphrase);
  if (passphrase) {
    const salt = crypto.randomBytes(16);
    const iterations = BACKUP_PASSPHRASE_KDF_ITERATIONS;
    const key = await deriveBackupPassphraseKey(passphrase, salt, iterations);
    return {
      key,
      metadata: {
        keySource: BACKUP_PASSPHRASE_KEY_SOURCE,
        kdf: BACKUP_PASSPHRASE_KDF,
        iterations,
        salt: salt.toString("base64"),
      },
    };
  }

  const key = await getOrCreateBackupPackageKey();
  return {
    key,
    metadata: {
      keySource: BACKUP_PACKAGE_KEY_SETTING,
    },
  };
}

async function getBackupDecryptionKey(
  encryption: Record<string, unknown>,
  options: BackupPackageEncryptionOptions = {},
) {
  const keySource = String(encryption.keySource ?? "");
  if (keySource === BACKUP_PASSPHRASE_KEY_SOURCE) {
    if (String(encryption.kdf ?? "") !== BACKUP_PASSPHRASE_KDF) {
      restoreError("不支持的备份加密口令格式");
    }
    const passphrase = normalizeBackupPassphrase(options.passphrase);
    if (!passphrase) {
      restoreError("请输入备份加密口令，或输入创建备份时使用的用户密码");
    }
    return deriveBackupPassphraseKey(
      passphrase,
      decodeBackupPassphraseSalt(encryption.salt),
      backupPassphraseIterations(encryption.iterations),
    );
  }

  if (keySource === BACKUP_PACKAGE_KEY_SETTING) {
    try {
      return await getBackupPackageKey();
    } catch (error) {
      if (error instanceof Error && error.message.includes("缺少备份解密密钥")) {
        restoreError("这是旧版系统密钥加密备份，当前系统缺少原备份解密密钥；请在创建该备份的系统重新导出新版口令备份，或恢复包含该密钥的旧环境。");
      }
      throw error;
    }
  }

  restoreError("不支持的备份加密密钥来源");
}

export async function encryptBackupPayload(
  payload: HouseholdBackupPayload,
  options: BackupPackageEncryptionOptions = {},
) {
  const iv = crypto.randomBytes(12);
  const { key, metadata } = await getBackupEncryptionKey(options);
  const cipher = crypto.createCipheriv(ENCRYPTED_BACKUP_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);

  return {
    app: "MMH" as const,
    packageType: "encrypted-backup" as const,
    packageVersion: ENCRYPTED_BACKUP_PACKAGE_VERSION,
    encrypted: true,
    exportedAt: payload.exportedAt,
    scope: payload.scope,
    encryption: {
      algorithm: ENCRYPTED_BACKUP_ALGORITHM,
      ...metadata,
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    },
    ciphertext: ciphertext.toString("base64"),
  };
}

export async function decryptBackupPackage(
  raw: unknown,
  options: BackupPackageEncryptionOptions = {},
) {
  const packageObject = ensureObject(raw, "payload");
  if (packageObject.encrypted !== true) return raw;
  if (packageObject.app !== "MMH" || packageObject.packageType !== "encrypted-backup") {
    restoreError("这不是 MMH 加密备份文件");
  }

  const encryption = ensureObject(packageObject.encryption, "encryption");
  if (encryption.algorithm !== ENCRYPTED_BACKUP_ALGORITHM) {
    restoreError("不支持的备份加密格式");
  }

  const key = await getBackupDecryptionKey(encryption, options);
  try {
    const iv = Buffer.from(String(encryption.iv ?? ""), "base64");
    const authTag = Buffer.from(String(encryption.authTag ?? ""), "base64");
    const ciphertext = Buffer.from(String(packageObject.ciphertext ?? ""), "base64");
    const decipher = crypto.createDecipheriv(ENCRYPTED_BACKUP_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return JSON.parse(plaintext) as unknown;
  } catch {
    if (String(encryption.keySource ?? "") === BACKUP_PASSPHRASE_KEY_SOURCE) {
      restoreError("备份加密口令不匹配。请检查创建备份时填写的加密口令；如果备份来自其他系统或其他用户，请输入该加密口令。若备份时未单独设置，则使用创建备份时的用户密码。");
    }
    restoreError("备份文件无法解密或已损坏");
  }
}

export async function encryptBackupBytes(
  bytes: Buffer,
  scope: HouseholdBackupPayload["scope"],
  exportedAt: Date,
  options: BackupPackageEncryptionOptions = {},
) {
  const iv = crypto.randomBytes(12);
  const { key, metadata } = await getBackupEncryptionKey(options);
  const cipher = crypto.createCipheriv(ENCRYPTED_BACKUP_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);

  return {
    app: "MMH" as const,
    packageType: "encrypted-sqlite-backup" as const,
    packageVersion: ENCRYPTED_BACKUP_PACKAGE_VERSION,
    encrypted: true,
    exportedAt,
    scope,
    encryption: {
      algorithm: ENCRYPTED_BACKUP_ALGORITHM,
      ...metadata,
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    },
    ciphertext: ciphertext.toString("base64"),
  };
}

export async function decryptBackupBytes(
  raw: unknown,
  options: BackupPackageEncryptionOptions = {},
): Promise<Buffer> {
  const packageObject = ensureObject(raw, "payload");
  if (packageObject.encrypted !== true) {
    restoreError("这不是 MMH 加密备份文件");
  }
  if (packageObject.app !== "MMH" || packageObject.packageType !== "encrypted-sqlite-backup") {
    restoreError("这不是 MMH 数据库备份文件");
  }

  const encryption = ensureObject(packageObject.encryption, "encryption");
  if (encryption.algorithm !== ENCRYPTED_BACKUP_ALGORITHM) {
    restoreError("不支持的备份加密格式");
  }

  const key = await getBackupDecryptionKey(encryption, options);
  try {
    const iv = Buffer.from(String(encryption.iv ?? ""), "base64");
    const authTag = Buffer.from(String(encryption.authTag ?? ""), "base64");
    const ciphertext = Buffer.from(String(packageObject.ciphertext ?? ""), "base64");
    const decipher = crypto.createDecipheriv(ENCRYPTED_BACKUP_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    if (String(encryption.keySource ?? "") === BACKUP_PASSPHRASE_KEY_SOURCE) {
      restoreError("备份加密口令不匹配。请检查创建备份时填写的加密口令；如果备份来自其他系统或其他用户，请输入该加密口令。若备份时未单独设置，则使用创建备份时的用户密码。");
    }
    restoreError("备份文件无法解密或已损坏");
  }
}

const RESTORABLE_HOUSEHOLD_SETTING_PREFIXES = [
  "category_hierarchy_normalized:",
  "category_deleted_default_templates:",
  EMAIL_IMPORT_KEYWORD_SETTING_PREFIX,
];
const RESTORABLE_GLOBAL_SYSTEM_SETTING_KEYS = new Set([
  "access_password",
  "api_key_encryption_master",
  "backup_package_encryption_key",
  "ledger_creation_invite_code",
  "resend_config",
]);

function householdSystemSettingKeys(householdId: string) {
  return RESTORABLE_HOUSEHOLD_SETTING_PREFIXES.map((prefix) => `${prefix}${householdId}`);
}

function settingsForBackup(
  settings: Array<{ key: string }>,
  backupScope: BackupScope,
) {
  if (backupScope === "system") return settings;
  return settings.filter((setting) =>
    RESTORABLE_GLOBAL_SYSTEM_SETTING_KEYS.has(setting.key) ||
    RESTORABLE_HOUSEHOLD_SETTING_PREFIXES.some((prefix) => setting.key.startsWith(prefix)),
  );
}

function remapHouseholdSystemSettingKey(key: string, sourceHouseholdId: string, targetHouseholdId: string) {
  for (const prefix of RESTORABLE_HOUSEHOLD_SETTING_PREFIXES) {
    if (key === `${prefix}${sourceHouseholdId}` || key === `${prefix}${targetHouseholdId}`) {
      return `${prefix}${targetHouseholdId}`;
    }
  }
  return null;
}

export function buildBackupFileName(householdName: string, exportedAt: Date, format: "json" | "xlsx" | "mmh-backup") {
  const suffix = format;
  return `${safeFilePart(householdName)}-backup-${exportedAt.toISOString().replace(/[:.]/g, "-")}.${suffix}`;
}

export function buildTableExportFileName(householdName: string, exportedAt: Date) {
  return `${safeFilePart(householdName)}-table-export-${exportedAt.toISOString().replace(/[:.]/g, "-")}.xlsx`;
}

export async function buildHouseholdBackupPayload(
  householdId: string,
  exportedBy: ExportedBy,
  options: { ensureBackupPackageKey?: boolean; backupScope?: BackupScope } = {},
) {
  const backupScope: BackupScope = options.backupScope === "system" ? "system" : "household";
  const isSystemBackup = backupScope === "system";
  const household = await prisma.household.findUnique({
    where: { id: householdId },
  });
  if (!household) {
    restoreError("当前账簿不存在");
  }

  if (options.ensureBackupPackageKey !== false) {
    await getOrCreateBackupPackageKey();
  }

  const [
    users,
    accountGroups,
    institutions,
    counterparties,
    categories,
    tags,
    insuranceProductMasters,
    wealthProducts,
    accounts,
    regularInvestPlans,
    creditCardInstallmentPlans,
    loanRateAdjustments,
    fundQueryApis,
    statementRecognitionRules,
    importBatches,
    transactions,
    emailAccounts,
    preciousMetalTypes,
    preciousMetalUnits,
    fxRates,
    fxConversions,
    insuranceProducts,
    fundTransactions,
    fundTransactionCashFlows,
    insuranceTransactions,
    wealthTransactions,
    depositTransactions,
    preciousMetalTransactions,
    stockSecurities,
    stockHoldings,
    stockTransactions,
    stockPriceCache,
    stockFeeRules,
    stockMarketFeeRules,
    propertyAssets,
    propertyValuations,
    propertyTransactions,
    entryBusinessLinks,
    fundNavCaches,
    stockBrokerageCatalogs,
    distillLogs,
    commandTestResults,
    commandAliases,
    systemSettings,
    accessKeys,
    aiChannels,
    aiModels,
  ] = await Promise.all([
    isSystemBackup
      ? prisma.user.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    prisma.accountGroup.findMany({ where: { householdId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    prisma.institution.findMany({ where: { householdId }, orderBy: [{ name: "asc" }] }),
    prisma.counterparty.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.category.findMany({ where: { householdId }, orderBy: [{ type: "asc" }, { name: "asc" }] }),
    prisma.tag.findMany({ where: { householdId }, orderBy: [{ name: "asc" }] }),
    prisma.insuranceProductMaster.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.wealthProduct.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.account.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.regularInvestPlan.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.creditCardInstallmentPlan.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.loanRateAdjustment.findMany({ where: { householdId }, orderBy: [{ effectiveDate: "asc" }] }),
    prisma.fundQueryApi.findMany({
      where: isSystemBackup
        ? { OR: [{ householdId }, { householdId: null }] }
        : { householdId },
      orderBy: [{ createdAt: "asc" }],
    }),
    prisma.statementRecognitionRule.findMany({ where: { householdId }, orderBy: [{ priority: "desc" }, { hitCount: "desc" }, { updatedAt: "desc" }] }),
    prisma.importBatch.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.txRecord.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.emailAccount.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.preciousMetalType.findMany({ where: { householdId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.preciousMetalUnit.findMany({ where: { householdId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.fxRate.findMany({ where: { householdId }, orderBy: [{ rateDate: "asc" }] }),
    prisma.fxConversion.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.insuranceProduct.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.fundTransaction.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.fundTransactionCashFlow.findMany({
      where: { FundTransaction: { householdId } },
      orderBy: [{ createdAt: "asc" }],
    }),
    prisma.insuranceTransaction.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.wealthTransaction.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.depositTransaction.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    prisma.preciousMetalTransaction.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    optionalPrismaFindMany<Record<string, unknown>>(
      prisma,
      "stockSecurity",
      { where: { householdId }, orderBy: [{ market: "asc" }, { stockCode: "asc" }] },
      { tableNames: ["stock_securities"] },
    ),
    optionalPrismaFindMany<Record<string, unknown>>(
      prisma,
      "stockHolding",
      { where: { householdId }, orderBy: [{ accountId: "asc" }, { market: "asc" }, { stockCode: "asc" }] },
      { tableNames: ["stock_holdings"] },
    ),
    optionalPrismaFindMany<Record<string, unknown>>(
      prisma,
      "stockTransaction",
      { where: { householdId }, orderBy: [{ createdAt: "asc" }] },
      { tableNames: ["stock_transactions"] },
    ),
    optionalPrismaFindMany<Record<string, unknown>>(
      prisma,
      "stockPriceCache",
      { where: { StockSecurity: { is: { householdId } } }, orderBy: [{ priceDate: "asc" }, { market: "asc" }, { stockCode: "asc" }] },
      { tableNames: ["stock_price_cache", "stock_securities"] },
    ),
    optionalPrismaFindMany<Record<string, unknown>>(
      prisma,
      "stockFeeRule",
      { where: { Account: { householdId } }, orderBy: [{ accountId: "asc" }, { effectiveDate: "asc" }] },
      { tableNames: ["stock_fee_rules"] },
    ),
    optionalPrismaFindMany<Record<string, unknown>>(
      prisma,
      "stockMarketFeeRule",
      { where: { householdId }, orderBy: [{ market: "asc" }, { effectiveDate: "asc" }] },
      { tableNames: ["stock_market_fee_rules"] },
    ),
    optionalPrismaFindMany<Record<string, unknown>>(
      prisma,
      "propertyAsset",
      { where: { householdId }, orderBy: [{ createdAt: "asc" }] },
      { tableNames: ["property_assets"] },
    ),
    optionalPrismaFindMany<Record<string, unknown>>(
      prisma,
      "propertyValuation",
      { where: { householdId }, orderBy: [{ valuationDate: "asc" }, { createdAt: "asc" }] },
      { tableNames: ["property_valuations"] },
    ),
    optionalPrismaFindMany<Record<string, unknown>>(
      prisma,
      "propertyTransaction",
      { where: { householdId }, orderBy: [{ createdAt: "asc" }] },
      { tableNames: ["property_transactions"] },
    ),
    prisma.entryBusinessLink.findMany({ where: { householdId }, orderBy: [{ createdAt: "asc" }] }),
    isSystemBackup
      ? prisma.fundNavCache.findMany({ orderBy: [{ fundCode: "asc" }, { navDate: "asc" }] })
      : Promise.resolve([]),
    isSystemBackup
      ? optionalPrismaFindMany<Record<string, unknown>>(
          prisma,
          "stockBrokerageCatalog",
          { orderBy: [{ name: "asc" }] },
          { tableNames: ["stock_brokerage_catalog"] },
        )
      : Promise.resolve([]),
    isSystemBackup
      ? prisma.distillLog.findMany({ orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    isSystemBackup
      ? prisma.commandTestResult.findMany({ orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    isSystemBackup
      ? prisma.commandAlias.findMany({ orderBy: [{ category: "asc" }, { key: "asc" }] })
      : Promise.resolve([]),
    prisma.systemSetting.findMany({ orderBy: [{ key: "asc" }] }),
    prisma.accessKey.findMany({ orderBy: [{ createdAt: "asc" }] }),
    prisma.aiChannel.findMany({ orderBy: [{ createdAt: "asc" }] }),
    prisma.aiModel.findMany({ orderBy: [{ createdAt: "asc" }] }),
  ]);
  const exportedSystemSettings = settingsForBackup(systemSettings, backupScope);

  const userIds = users.map((item) => item.id);
  const accountIds = accounts.map((item) => item.id);

  const [
    userSettings,
    accountAliases,
    billOverrides,
    creditCardCycles,
    fundConfirmDays,
    fundFeeRates,
    fundHoldings,
    preciousMetalHoldings,
    fundSnapshots,
    attachments,
    entryTags,
  ] = await Promise.all([
    userIds.length > 0
      ? prisma.userSettings.findMany({ where: { userId: { in: userIds } }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.accountAlias.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.billOverride.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.creditCardCycle.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.fundConfirmDays.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.fundFeeRate.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ createdAt: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.fundHolding.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ accountId: "asc" }, { fundCode: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.preciousMetalHolding.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ accountId: "asc" }, { metalTypeName: "asc" }] })
      : Promise.resolve([]),
    accountIds.length > 0
      ? prisma.fundSnapshot.findMany({ where: { accountId: { in: accountIds } }, orderBy: [{ accountId: "asc" }, { snapshotDate: "asc" }] })
      : Promise.resolve([]),
    prisma.attachment.findMany({ where: { transactions: { householdId } }, orderBy: [{ createdAt: "asc" }] }),
    prisma.entryTag.findMany({
      where: { transactions: { householdId } },
      orderBy: [{ entryId: "asc" }, { tagId: "asc" }],
    }),
  ]);

  const exportedAt = new Date();

  return {
    app: "MMH" as const,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt,
    exportedBy: isSystemBackup ? exportedBy : null,
    scope: {
      householdId: household.id,
      householdName: household.name,
      backupScope,
    },
    counts: {
      users: users.length,
      accounts: accounts.length,
      transactions: transactions.length,
      statementRecognitionRules: statementRecognitionRules.length,
      categories: categories.length,
      tags: tags.length,
      institutions: institutions.length,
      counterparties: counterparties.length,
      emailAccounts: emailAccounts.length,
      fundQueryApis: fundQueryApis.length,
      regularInvestPlans: regularInvestPlans.length,
      businessTransactions:
        fundTransactions.length +
        insuranceTransactions.length +
        wealthTransactions.length +
        depositTransactions.length +
        preciousMetalTransactions.length +
        stockTransactions.length +
        propertyTransactions.length,
      systemSettings: exportedSystemSettings.length,
      accessKeys: accessKeys.length,
      aiChannels: aiChannels.length,
      aiModels: aiModels.length,
      fundNavCaches: fundNavCaches.length,
      fundSnapshots: fundSnapshots.length,
      stockBrokerageCatalogs: stockBrokerageCatalogs.length,
      distillLogs: distillLogs.length,
      commandTestResults: commandTestResults.length,
      commandAliases: commandAliases.length,
    },
    data: {
      household,
      systemSettings: exportedSystemSettings,
      accessKeys,
      aiChannels,
      aiModels,
      users,
      userSettings,
      accountGroups,
      institutions,
      counterparties,
      categories,
      tags,
      insuranceProductMasters,
      wealthProducts,
      accounts,
      accountAliases,
      billOverrides,
      creditCardCycles,
      creditCardInstallmentPlans,
      fundConfirmDays,
      fundFeeRates,
      fundHoldings,
      preciousMetalTypes,
      preciousMetalUnits,
      preciousMetalHoldings,
      loanRateAdjustments,
      fundQueryApis,
      statementRecognitionRules,
      regularInvestPlans,
      importBatches,
      transactions,
      fxRates,
      fxConversions,
      insuranceProducts,
      fundTransactions,
      fundTransactionCashFlows,
      insuranceTransactions,
      wealthTransactions,
      depositTransactions,
      preciousMetalTransactions,
      stockSecurities,
      stockHoldings,
      stockTransactions,
      stockPriceCache,
      stockFeeRules,
      stockMarketFeeRules,
      propertyAssets,
      propertyValuations,
      propertyTransactions,
      entryBusinessLinks,
      fundNavCaches,
      fundSnapshots,
      stockBrokerageCatalogs,
      distillLogs,
      commandTestResults,
      commandAliases,
      attachments,
      entryTags,
      emailAccounts,
    },
  };
}

export async function buildHouseholdBackupWorkbook(payload: HouseholdBackupPayload) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();

  const sheets: Array<[string, Record<string, unknown>[]]> = [
    ["Summary", summaryRows(payload)],
    ["SystemSettings", sheetRows(payload.data.systemSettings)],
    ["Users", sheetRows(payload.data.users)],
    ["UserSettings", sheetRows(payload.data.userSettings)],
    ["AccountGroups", sheetRows(payload.data.accountGroups)],
    ["Institutions", sheetRows(payload.data.institutions)],
    ["Counterparties", sheetRows(payload.data.counterparties)],
    ["Categories", sheetRows(payload.data.categories)],
    ["Tags", sheetRows(payload.data.tags)],
    ["InsuranceProductMasters", sheetRows(payload.data.insuranceProductMasters)],
    ["WealthProducts", sheetRows(payload.data.wealthProducts)],
    ["Accounts", sheetRows(payload.data.accounts)],
    ["AccountAliases", sheetRows(payload.data.accountAliases)],
    ["BillOverrides", sheetRows(payload.data.billOverrides)],
    ["CreditCardCycles", sheetRows(payload.data.creditCardCycles)],
    ["CreditCardInstallmentPlans", sheetRows(payload.data.creditCardInstallmentPlans)],
    ["FundConfirmDays", sheetRows(payload.data.fundConfirmDays)],
    ["FundFeeRates", sheetRows(payload.data.fundFeeRates)],
    ["FundHoldings", sheetRows(payload.data.fundHoldings)],
    ["PreciousMetalTypes", sheetRows(payload.data.preciousMetalTypes)],
    ["PreciousMetalUnits", sheetRows(payload.data.preciousMetalUnits)],
    ["PreciousMetalHoldings", sheetRows(payload.data.preciousMetalHoldings)],
    ["LoanRateAdjustments", sheetRows(payload.data.loanRateAdjustments)],
    ["FundQueryApis", sheetRows(payload.data.fundQueryApis)],
    ["StatementRecognitionRules", sheetRows(payload.data.statementRecognitionRules)],
    ["RegularInvestPlans", sheetRows(payload.data.regularInvestPlans)],
    ["ImportBatches", sheetRows(payload.data.importBatches)],
    ["Transactions", labelTransactionRows(payload.data.transactions as Record<string, unknown>[])],
    ["FxRates", sheetRows(payload.data.fxRates)],
    ["FxConversions", sheetRows(payload.data.fxConversions)],
    ["InsuranceProducts", sheetRows(payload.data.insuranceProducts)],
    ["FundTransactions", sheetRows(payload.data.fundTransactions)],
    ["FundTransactionCashFlows", sheetRows(payload.data.fundTransactionCashFlows)],
    ["InsuranceTransactions", sheetRows(payload.data.insuranceTransactions)],
    ["WealthTransactions", sheetRows(payload.data.wealthTransactions)],
    ["DepositTransactions", sheetRows(payload.data.depositTransactions)],
    ["PreciousMetalTransactions", sheetRows(payload.data.preciousMetalTransactions)],
    ["StockSecurities", sheetRows(payload.data.stockSecurities)],
    ["StockHoldings", sheetRows(payload.data.stockHoldings)],
    ["StockTransactions", sheetRows(payload.data.stockTransactions)],
    ["StockPriceCache", sheetRows(payload.data.stockPriceCache)],
    ["StockFeeRules", sheetRows(payload.data.stockFeeRules)],
    ["StockMarketFeeRules", sheetRows(payload.data.stockMarketFeeRules)],
    ["PropertyAssets", sheetRows(payload.data.propertyAssets)],
    ["PropertyValuations", sheetRows(payload.data.propertyValuations)],
    ["PropertyTransactions", sheetRows(payload.data.propertyTransactions)],
    ["EntryBusinessLinks", sheetRows(payload.data.entryBusinessLinks)],
    ["FundNavCache", sheetRows(payload.data.fundNavCaches)],
    ["FundSnapshots", sheetRows(payload.data.fundSnapshots)],
    ["StockBrokerageCatalog", sheetRows(payload.data.stockBrokerageCatalogs)],
    ["DistillLogs", sheetRows(payload.data.distillLogs)],
    ["CommandTestResults", sheetRows(payload.data.commandTestResults)],
    ["CommandAliases", sheetRows(payload.data.commandAliases)],
    ["Attachments", sheetRows(payload.data.attachments)],
    ["EntryTags", sheetRows(payload.data.entryTags)],
    ["EmailAccounts", sheetRows(payload.data.emailAccounts)],
  ];

  for (const [sheetName, rows] of sheets) {
    const worksheet = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ empty: "" }]);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  }

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export async function buildHouseholdTableExportWorkbook(payload: HouseholdBackupPayload) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const accountNameById = buildAccountNameById(payload);
  const tableTransactions = withGeneratedAccountNames(
    payload.data.transactions as Record<string, unknown>[],
    accountNameById,
    [
      { idKey: "accountId", nameKey: "accountName" },
      { idKey: "toAccountId", nameKey: "toAccountName" },
    ],
  );
  const tableRegularInvestPlans = withGeneratedAccountNames(
    payload.data.regularInvestPlans as Record<string, unknown>[],
    accountNameById,
    [
      { idKey: "accountId", nameKey: "accountName" },
      { idKey: "cashAccountId", nameKey: "cashAccountName" },
    ],
  );

  const sheets: Array<[string, Record<string, unknown>[]]> = [
    ["Summary", summaryRows(payload)],
    ["Users", sheetRows(omitRecordFields(payload.data.users, new Set(["passwordHash"])))],
    ["AccountGroups", sheetRows(payload.data.accountGroups)],
    ["Institutions", sheetRows(payload.data.institutions)],
    ["Counterparties", sheetRows(payload.data.counterparties)],
    ["Categories", sheetRows(payload.data.categories)],
    ["Tags", sheetRows(payload.data.tags)],
    ["InsuranceProductMasters", sheetRows(payload.data.insuranceProductMasters)],
    ["WealthProducts", sheetRows(payload.data.wealthProducts)],
    ["Accounts", sheetRows(payload.data.accounts)],
    ["AccountAliases", sheetRows(payload.data.accountAliases)],
    ["BillOverrides", sheetRows(payload.data.billOverrides)],
    ["CreditCardCycles", sheetRows(payload.data.creditCardCycles)],
    ["CreditCardInstallmentPlans", sheetRows(payload.data.creditCardInstallmentPlans)],
    ["FundConfirmDays", sheetRows(payload.data.fundConfirmDays)],
    ["FundFeeRates", sheetRows(payload.data.fundFeeRates)],
    ["FundHoldings", sheetRows(payload.data.fundHoldings)],
    ["PreciousMetalTypes", sheetRows(payload.data.preciousMetalTypes)],
    ["PreciousMetalUnits", sheetRows(payload.data.preciousMetalUnits)],
    ["PreciousMetalHoldings", sheetRows(payload.data.preciousMetalHoldings)],
    ["LoanRateAdjustments", sheetRows(payload.data.loanRateAdjustments)],
    ["FundQueryApis", sheetRows(payload.data.fundQueryApis)],
    ["StatementRecognitionRules", sheetRows(payload.data.statementRecognitionRules)],
    ["RegularInvestPlans", sheetRows(tableRegularInvestPlans)],
    ["ImportBatches", sheetRows(payload.data.importBatches)],
    ["Transactions", labelTransactionRows(tableTransactions)],
    ["FxRates", sheetRows(payload.data.fxRates)],
    ["FxConversions", sheetRows(payload.data.fxConversions)],
    ["InsuranceProducts", sheetRows(payload.data.insuranceProducts)],
    ["FundTransactions", sheetRows(payload.data.fundTransactions)],
    ["FundTransactionCashFlows", sheetRows(payload.data.fundTransactionCashFlows)],
    ["InsuranceTransactions", sheetRows(payload.data.insuranceTransactions)],
    ["WealthTransactions", sheetRows(payload.data.wealthTransactions)],
    ["DepositTransactions", sheetRows(payload.data.depositTransactions)],
    ["PreciousMetalTransactions", sheetRows(payload.data.preciousMetalTransactions)],
    ["StockSecurities", sheetRows(payload.data.stockSecurities)],
    ["StockHoldings", sheetRows(payload.data.stockHoldings)],
    ["StockTransactions", sheetRows(payload.data.stockTransactions)],
    ["StockPriceCache", sheetRows(payload.data.stockPriceCache)],
    ["StockFeeRules", sheetRows(payload.data.stockFeeRules)],
    ["StockMarketFeeRules", sheetRows(payload.data.stockMarketFeeRules)],
    ["PropertyAssets", sheetRows(payload.data.propertyAssets)],
    ["PropertyValuations", sheetRows(payload.data.propertyValuations)],
    ["PropertyTransactions", sheetRows(payload.data.propertyTransactions)],
    ["EntryBusinessLinks", sheetRows(payload.data.entryBusinessLinks)],
    ["Attachments", sheetRows(payload.data.attachments)],
    ["EntryTags", sheetRows(payload.data.entryTags)],
  ];

  for (const [sheetName, rows] of sheets) {
    const worksheet = XLSX.utils.json_to_sheet(rows.length > 0 ? rows : [{ empty: "" }]);
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  }

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function parseBackupPayload(raw: unknown) {
  const payload = ensureObject(raw, "payload");
  if (payload.app !== "MMH") {
    restoreError("这不是 MMH 备份文件");
  }
  const data = ensureObject(payload.data, "data");
  const scope = ensureObject(payload.scope, "scope");

  return {
    app: String(payload.app),
    formatVersion: Number(payload.formatVersion ?? 0),
    exportedAt: payload.exportedAt,
    exportedBy: payload.exportedBy ?? null,
    scope: {
      householdId: String(scope.householdId ?? ""),
      householdName: String(scope.householdName ?? "恢复账簿"),
      backupScope: scope.backupScope === "household" ? "household" : "system",
    },
    counts: ensureObject(payload.counts ?? {}, "counts"),
    data: {
      household: ensureObject(data.household ?? {}, "data.household"),
      systemSettings: ensureArray(data.systemSettings ?? [], "data.systemSettings"),
      accessKeys: ensureArray(data.accessKeys ?? [], "data.accessKeys"),
      aiChannels: ensureArray(data.aiChannels ?? [], "data.aiChannels"),
      aiModels: ensureArray(data.aiModels ?? [], "data.aiModels"),
      users: ensureArray(data.users ?? [], "data.users"),
      userSettings: ensureArray(data.userSettings ?? [], "data.userSettings"),
      accountGroups: ensureArray(data.accountGroups ?? [], "data.accountGroups"),
      institutions: ensureArray(data.institutions ?? [], "data.institutions"),
      counterparties: ensureArray(data.counterparties ?? [], "data.counterparties"),
      categories: ensureArray(data.categories ?? [], "data.categories"),
      tags: ensureArray(data.tags ?? [], "data.tags"),
      insuranceProductMasters: ensureArray(data.insuranceProductMasters ?? [], "data.insuranceProductMasters"),
      wealthProducts: ensureArray(data.wealthProducts ?? [], "data.wealthProducts"),
      accounts: ensureArray(data.accounts ?? [], "data.accounts"),
      accountAliases: ensureArray(data.accountAliases ?? [], "data.accountAliases"),
      billOverrides: ensureArray(data.billOverrides ?? [], "data.billOverrides"),
      creditCardCycles: ensureArray(data.creditCardCycles ?? [], "data.creditCardCycles"),
      creditCardInstallmentPlans: ensureArray(data.creditCardInstallmentPlans ?? [], "data.creditCardInstallmentPlans"),
      fundConfirmDays: ensureArray(data.fundConfirmDays ?? [], "data.fundConfirmDays"),
      fundFeeRates: ensureArray(data.fundFeeRates ?? [], "data.fundFeeRates"),
      fundHoldings: ensureArray(data.fundHoldings ?? [], "data.fundHoldings"),
      preciousMetalTypes: ensureArray(data.preciousMetalTypes ?? [], "data.preciousMetalTypes"),
      preciousMetalUnits: ensureArray(data.preciousMetalUnits ?? [], "data.preciousMetalUnits"),
      preciousMetalHoldings: ensureArray(data.preciousMetalHoldings ?? [], "data.preciousMetalHoldings"),
      loanRateAdjustments: ensureArray(data.loanRateAdjustments ?? [], "data.loanRateAdjustments"),
      fundQueryApis: ensureArray(data.fundQueryApis ?? [], "data.fundQueryApis"),
      statementRecognitionRules: ensureArray(data.statementRecognitionRules ?? [], "data.statementRecognitionRules"),
      statementCategoryRules: ensureArray(data.statementCategoryRules ?? [], "data.statementCategoryRules"),
      regularInvestPlans: ensureArray(data.regularInvestPlans ?? [], "data.regularInvestPlans"),
      importBatches: ensureArray(data.importBatches ?? [], "data.importBatches"),
      transactions: ensureArray(data.transactions ?? [], "data.transactions"),
      fxRates: ensureArray(data.fxRates ?? [], "data.fxRates"),
      fxConversions: ensureArray(data.fxConversions ?? [], "data.fxConversions"),
      insuranceProducts: ensureArray(data.insuranceProducts ?? [], "data.insuranceProducts"),
      fundTransactions: ensureArray(data.fundTransactions ?? [], "data.fundTransactions"),
      fundTransactionCashFlows: ensureArray(data.fundTransactionCashFlows ?? [], "data.fundTransactionCashFlows"),
      insuranceTransactions: ensureArray(data.insuranceTransactions ?? [], "data.insuranceTransactions"),
      wealthTransactions: ensureArray(data.wealthTransactions ?? [], "data.wealthTransactions"),
      depositTransactions: ensureArray(data.depositTransactions ?? [], "data.depositTransactions"),
      preciousMetalTransactions: ensureArray(data.preciousMetalTransactions ?? [], "data.preciousMetalTransactions"),
      stockSecurities: ensureArray(data.stockSecurities ?? [], "data.stockSecurities"),
      stockHoldings: ensureArray(data.stockHoldings ?? [], "data.stockHoldings"),
      stockTransactions: ensureArray(data.stockTransactions ?? [], "data.stockTransactions"),
      stockPriceCache: ensureArray(data.stockPriceCache ?? [], "data.stockPriceCache"),
      stockFeeRules: ensureArray(data.stockFeeRules ?? [], "data.stockFeeRules"),
      stockMarketFeeRules: ensureArray(data.stockMarketFeeRules ?? [], "data.stockMarketFeeRules"),
      propertyAssets: ensureArray(data.propertyAssets ?? [], "data.propertyAssets"),
      propertyValuations: ensureArray(data.propertyValuations ?? [], "data.propertyValuations"),
      propertyTransactions: ensureArray(data.propertyTransactions ?? [], "data.propertyTransactions"),
      entryBusinessLinks: ensureArray(data.entryBusinessLinks ?? [], "data.entryBusinessLinks"),
      fundNavCaches: ensureArray(data.fundNavCaches ?? [], "data.fundNavCaches"),
      fundSnapshots: ensureArray(data.fundSnapshots ?? [], "data.fundSnapshots"),
      stockBrokerageCatalogs: ensureArray(data.stockBrokerageCatalogs ?? [], "data.stockBrokerageCatalogs"),
      distillLogs: ensureArray(data.distillLogs ?? [], "data.distillLogs"),
      commandTestResults: ensureArray(data.commandTestResults ?? [], "data.commandTestResults"),
      commandAliases: ensureArray(data.commandAliases ?? [], "data.commandAliases"),
      attachments: ensureArray(data.attachments ?? [], "data.attachments"),
      entryTags: ensureArray(data.entryTags ?? [], "data.entryTags"),
      emailAccounts: ensureArray(data.emailAccounts ?? [], "data.emailAccounts"),
    },
  };
}

export async function restoreHouseholdBackup(
  rawPayload: unknown,
  options: {
    householdId: string;
    fallbackAdmin?: {
      name: string;
      role: string;
      isSystem: boolean;
      email?: string | null;
      passwordHash?: string | null;
    } | null;
    onProgress?: (progress: RestoreHouseholdBackupProgress) => void | Promise<void>;
  },
) {
  const reportProgress = async (progress: RestoreHouseholdBackupProgress) => {
    await options.onProgress?.(progress);
  };
  await reportProgress({ stage: "preparing", percent: 45, label: "读取备份", detail: "正在校验备份结构" });
  const payload = parseBackupPayload(rawPayload);
  const data = payload.data;
  const householdId = options.householdId;
  await reportProgress({ stage: "preparing", percent: 48, label: "兼容检查", detail: "正在检查数据库表结构" });
  await ensureSqliteRestoreCompatibilitySchema();
  await reportProgress({ stage: "preparing", percent: 50, label: "准备导入", detail: "正在建立恢复索引" });

  const isSystemRestore = payload.scope.backupScope !== "household";
  const importedUsers = data.users.map((item) => String(item.id));
  const importedUserSet = new Set(importedUsers);
  const importedAccountGroups = new Set(data.accountGroups.map((item) => String(item.id)));
  const importedInstitutions = new Set(data.institutions.map((item) => String(item.id)));
  const importedCounterparties = new Set(data.counterparties.map((item) => String(item.id)));
  const importedFundQueryApis = new Set(data.fundQueryApis.map((item) => String(item.id)));
  const importedAccounts = new Set(data.accounts.map((item) => String(item.id)));
  const restoredCategoryBatches = buildRestoredCategoryBatches(data.categories, householdId);
  const restoredCategories = restoredCategoryBatches.flat();
  const importedCategories = new Set(restoredCategories.map((item) => item.id));
  const restoredCategoryNameById = new Map(restoredCategories.map((item) => [item.id, item.name]));
  const importedImportBatches = new Set(data.importBatches.map((item) => String(item.id)));
  const importedTransactions = new Set(data.transactions.map((item) => String(item.id)));
  const importedTags = new Set(data.tags.map((item) => String(item.id)));
  const importedInsuranceProductMasters = new Set(data.insuranceProductMasters.map((item) => String(item.id)));
  const importedInsuranceProducts = new Set(data.insuranceProducts.map((item) => String(item.id)));
  const importedWealthProducts = new Set(data.wealthProducts.map((item) => String(item.id)));
  const importedCreditCardInstallmentPlans = new Set(data.creditCardInstallmentPlans.map((item) => String(item.id)));
  const importedPreciousMetalTypes = new Set(data.preciousMetalTypes.map((item) => String(item.id)));
  const importedPreciousMetalUnits = new Set(data.preciousMetalUnits.map((item) => String(item.id)));
  const importedFundTransactions = new Set(data.fundTransactions.map((item) => String(item.id)));
  const importedStockSecurities = new Set(data.stockSecurities.map((item) => String(item.id)));
  const importedStockTransactions = new Set(
    data.stockTransactions
      .filter(
        (item) =>
          importedAccounts.has(String(item.stockAccountId)) &&
          (!item.cashAccountId || importedAccounts.has(String(item.cashAccountId))) &&
          (!item.securityId || importedStockSecurities.has(String(item.securityId))),
      )
      .map((item) => String(item.id)),
  );
  const importedPropertyAssets = new Set(
    data.propertyAssets
      .filter((item) => importedAccounts.has(String(item.accountId)))
      .map((item) => String(item.id)),
  );
  const importedPropertyTransactions = new Set(
    data.propertyTransactions
      .filter(
        (item) =>
          importedAccounts.has(String(item.accountId)) &&
          importedPropertyAssets.has(String(item.propertyAssetId)) &&
          (!item.cashAccountId || importedAccounts.has(String(item.cashAccountId))),
      )
      .map((item) => String(item.id)),
  );
  const importedInsuranceTransactions = new Set(data.insuranceTransactions.map((item) => String(item.id)));
  const importedWealthTransactions = new Set(data.wealthTransactions.map((item) => String(item.id)));
  const importedDepositTransactions = new Set(data.depositTransactions.map((item) => String(item.id)));
  const importedPreciousMetalTransactions = new Set(data.preciousMetalTransactions.map((item) => String(item.id)));
  const importedAiChannels = new Set(data.aiChannels.map((item) => String(item.id)));
  const hasIndependentFundTransactions = data.fundTransactions.length > 0;
  const isSplitFundProjection = (item: Record<string, unknown>) => {
    const productType = String(item.fundProductType ?? "");
    return (
      item.fundCode != null && isLegacyFundProductType(item.fundProductType)
    ) || (
      hasIndependentFundTransactions &&
      (
      productType === "fund" ||
      productType === "money" ||
      productType === "money_fund"
      )
    );
  };
  const legacyFundRows = hasIndependentFundTransactions
    ? []
    : data.transactions.filter((item) => (
        item.fundCode != null &&
        isLegacyFundProductType(item.fundProductType) &&
        importedAccounts.has(String(item.accountId))
      ));
  const legacyMainFundRows = legacyFundRows.filter((item) => !isLegacyFundRefundRow(item));
  const legacyMainFundIds = new Set(legacyMainFundRows.map((item) => String(item.id)));
  const legacyRefundRows = legacyFundRows.filter((item) => (
    isLegacyFundRefundRow(item) &&
    item.fundSourceEntryId != null &&
    legacyMainFundIds.has(String(item.fundSourceEntryId))
  ));
  const backupContainsPropertyData =
    data.propertyAssets.length > 0 ||
    data.propertyValuations.length > 0 ||
    data.propertyTransactions.length > 0;
  const backupContainsStockData =
    data.stockSecurities.length > 0 ||
    data.stockHoldings.length > 0 ||
    data.stockTransactions.length > 0 ||
    data.stockPriceCache.length > 0 ||
    data.stockFeeRules.length > 0 ||
    data.stockMarketFeeRules.length > 0 ||
    data.entryBusinessLinks.some((item) => item.stockTransactionId != null);

  await prisma.$transaction(async (tx) => {
    await reportProgress({ stage: "clearing", percent: 55, label: "清空当前账簿", detail: "正在移除当前账簿旧数据" });
    const currentUsers = await tx.user.findMany({
      where: { householdId },
      select: { id: true },
    });
    const currentAccounts = await tx.account.findMany({
      where: { householdId },
      select: { id: true },
    });

    const currentUserIds = currentUsers.map((item) => item.id);
    const currentAccountIds = currentAccounts.map((item) => item.id);
    const propertyAssetDelegate = getOptionalPrismaDelegate<OptionalPrismaRestoreDelegate>(tx, "propertyAsset");
    const propertyValuationDelegate = getOptionalPrismaDelegate<OptionalPrismaRestoreDelegate>(tx, "propertyValuation");
    const propertyTransactionDelegate = getOptionalPrismaDelegate<OptionalPrismaRestoreDelegate>(tx, "propertyTransaction");

    if (isSystemRestore) {
      await tx.systemSetting.deleteMany({});
      await tx.accessKey.deleteMany({});
      await tx.aiModel.deleteMany({});
      await tx.aiChannel.deleteMany({});
    } else {
      await tx.systemSetting.deleteMany({ where: { key: { in: householdSystemSettingKeys(householdId) } } });
    }
    await tx.attachment.deleteMany({ where: { transactions: { householdId } } });
    await tx.entryTag.deleteMany({ where: { transactions: { householdId } } });
    await tx.entryBusinessLink.deleteMany({ where: { householdId } });
    await tx.fundTransactionCashFlow.deleteMany({ where: { FundTransaction: { householdId } } });
    await tx.fxConversion.deleteMany({ where: { householdId } });
    await tx.fundTransaction.deleteMany({ where: { householdId } });
    await tx.insuranceTransaction.deleteMany({ where: { householdId } });
    await tx.wealthTransaction.deleteMany({ where: { householdId } });
    await tx.depositTransaction.deleteMany({ where: { householdId } });
    await tx.preciousMetalTransaction.deleteMany({ where: { householdId } });
    const stockTransactionsDeleted = await optionalPrismaDeleteMany(
      tx,
      "stockTransaction",
      { where: { householdId } },
      { tableNames: ["stock_transactions"] },
    );
    const propertyTransactionsDeleted = await optionalPrismaDeleteMany(
      tx,
      "propertyTransaction",
      { where: { householdId } },
      { tableNames: ["property_transactions"] },
    );
    const propertyValuationsDeleted = await optionalPrismaDeleteMany(
      tx,
      "propertyValuation",
      { where: { householdId } },
      { tableNames: ["property_valuations"] },
    );
    const propertyAssetsDeleted = await optionalPrismaDeleteMany(
      tx,
      "propertyAsset",
      { where: { householdId } },
      { tableNames: ["property_assets"] },
    );
    if (
      backupContainsPropertyData &&
      (!propertyTransactionsDeleted || !propertyValuationsDeleted || !propertyAssetsDeleted)
    ) {
      restoreError("当前系统版本不支持房产数据，请先更新并完成数据库迁移后再恢复。");
    }
    const stockPriceCacheDeleted = await optionalPrismaDeleteMany(
      tx,
      "stockPriceCache",
      { where: { StockSecurity: { is: { householdId } } } },
      { tableNames: ["stock_price_cache", "stock_securities"] },
    );
    const stockFeeRulesDeleted = await optionalPrismaDeleteMany(
      tx,
      "stockFeeRule",
      { where: { Account: { householdId } } },
      { tableNames: ["stock_fee_rules"] },
    );
    const stockMarketFeeRulesDeleted = await optionalPrismaDeleteMany(
      tx,
      "stockMarketFeeRule",
      { where: { householdId } },
      { tableNames: ["stock_market_fee_rules"] },
    );
    const stockHoldingsDeleted = await optionalPrismaDeleteMany(
      tx,
      "stockHolding",
      { where: { householdId } },
      { tableNames: ["stock_holdings"] },
    );
    const stockSecuritiesDeleted = await optionalPrismaDeleteMany(
      tx,
      "stockSecurity",
      { where: { householdId } },
      { tableNames: ["stock_securities"] },
    );
    if (
      backupContainsStockData &&
      (
        !stockTransactionsDeleted ||
        !stockPriceCacheDeleted ||
        !stockFeeRulesDeleted ||
        !stockMarketFeeRulesDeleted ||
        !stockHoldingsDeleted ||
        !stockSecuritiesDeleted
      )
    ) {
      restoreError("当前系统版本不支持股票数据，请先更新并完成数据库迁移后再恢复。");
    }
    await tx.creditCardInstallmentPlan.deleteMany({ where: { householdId } });
    await tx.loanRateAdjustment.deleteMany({ where: { householdId } });

    if (currentAccountIds.length > 0) {
      await tx.fundSnapshot.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.regularInvestPlan.deleteMany({
        where: {
          OR: [{ householdId }, { accountId: { in: currentAccountIds } }, { cashAccountId: { in: currentAccountIds } }],
        },
      });
      await tx.fundHolding.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.preciousMetalHolding.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await optionalPrismaDeleteMany(
        tx,
        "stockHolding",
        { where: { accountId: { in: currentAccountIds } } },
        { tableNames: ["stock_holdings"] },
      );
      await optionalPrismaDeleteMany(
        tx,
        "stockFeeRule",
        { where: { accountId: { in: currentAccountIds } } },
        { tableNames: ["stock_fee_rules"] },
      );
      await tx.fundConfirmDays.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.fundFeeRate.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.billOverride.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.creditCardCycle.deleteMany({ where: { accountId: { in: currentAccountIds } } });
      await tx.accountAlias.deleteMany({ where: { accountId: { in: currentAccountIds } } });
    }

    await tx.undoOperation.deleteMany({ where: { householdId } });
    await tx.txRecord.deleteMany({ where: { householdId } });
    await tx.account.deleteMany({ where: { householdId } });
    await tx.insuranceProduct.deleteMany({ where: { householdId } });
    await tx.insuranceProductMaster.deleteMany({ where: { householdId } });
    await tx.wealthProduct.deleteMany({ where: { householdId } });
    await tx.importBatch.deleteMany({ where: { householdId } });
    if (isSystemRestore) {
      await tx.fundQueryApi.deleteMany({ where: { OR: [{ householdId }, { householdId: null }] } });
    } else {
      await tx.fundQueryApi.deleteMany({ where: { householdId } });
    }
    await tx.preciousMetalType.deleteMany({ where: { householdId } });
    await tx.preciousMetalUnit.deleteMany({ where: { householdId } });
    await tx.fxRate.deleteMany({ where: { householdId } });
    await tx.emailAccount.deleteMany({ where: { householdId } });
    await tx.tag.deleteMany({ where: { householdId } });
    await tx.statementRecognitionRule.deleteMany({ where: { householdId } });
    await tx.category.deleteMany({ where: { householdId } });
    await tx.counterparty.deleteMany({ where: { householdId } });
    await tx.institution.deleteMany({ where: { householdId } });
    await tx.accountGroup.deleteMany({ where: { householdId } });

    if (isSystemRestore) {
      if (currentUserIds.length > 0) {
        await tx.userSettings.deleteMany({ where: { userId: { in: currentUserIds } } });
        await tx.passwordResetToken.deleteMany({ where: { userId: { in: currentUserIds } } });
      }
      await tx.user.deleteMany({ where: { householdId } });
    } else {
      for (const id of currentUserIds) {
        importedUserSet.add(id);
      }
    }
    if (isSystemRestore) {
      await tx.fundNavCache.deleteMany({});
      await tx.commandAlias.deleteMany({});
      await optionalPrismaDeleteMany(
        tx,
        "stockBrokerageCatalog",
        {},
        { tableNames: ["stock_brokerage_catalog"] },
      );
      await tx.distillLog.deleteMany({});
      await tx.commandTestResult.deleteMany({});
    }
    await reportProgress({ stage: "importing", percent: 60, label: "导入基础数据", detail: "正在写入用户、账户和分类" });

    await tx.household.update({
      where: { id: householdId },
      data: {
        name: String(data.household.name ?? payload.scope.householdName ?? "恢复账簿"),
        baseCurrency: String(data.household.baseCurrency ?? "CNY"),
      },
    });

    for (const item of data.systemSettings) {
      const rawKey = String(item.key ?? "");
      const key = remapHouseholdSystemSettingKey(rawKey, payload.scope.householdId, householdId) ?? rawKey;
      if (!key) continue;
      const value = String(item.value ?? "");
      await tx.systemSetting.upsert({
        where: { key },
        create: { key, value, updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date() },
        update: { value, updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date() },
      });
    }

    for (const item of data.accessKeys) {
      const id = String(item.id ?? "");
      if (!id) continue;
      const record = {
        id,
        name: String(item.name ?? ""),
        key: String(item.key ?? ""),
        createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
        updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
      };
      await tx.accessKey.upsert({
        where: { id },
        create: record,
        update: {
          name: record.name,
          key: record.key,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      });
    }

    for (const item of data.aiChannels) {
      const id = String(item.id ?? "");
      if (!id) continue;
      const record = {
        id,
        name: String(item.name ?? ""),
        channelType: String(item.channelType ?? "custom"),
        baseUrl: String(item.baseUrl ?? ""),
        apiKey: item.apiKey == null ? null : String(item.apiKey),
        createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
        updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
      };
      await tx.aiChannel.upsert({
        where: { id },
        create: record,
        update: {
          name: record.name,
          channelType: record.channelType,
          baseUrl: record.baseUrl,
          apiKey: record.apiKey,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      });
    }

    for (const item of data.aiModels.filter((model) => importedAiChannels.has(String(model.channelId)))) {
      const id = String(item.id ?? "");
      if (!id) continue;
      const record = {
        id,
        model: String(item.model ?? ""),
        name: item.name == null ? null : String(item.name),
        channelId: String(item.channelId),
        vision: Boolean(item.vision),
        apiMode: normalizeAiApiMode(item.apiMode == null ? undefined : String(item.apiMode)),
        active: Boolean(item.active),
        createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
        updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
      };
      await tx.aiModel.upsert({
        where: { id },
        create: record,
        update: {
          model: record.model,
          name: record.name,
          channelId: record.channelId,
          vision: record.vision,
          apiMode: record.apiMode,
          active: record.active,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        },
      });
    }

    if (isSystemRestore && data.fundNavCaches.length > 0) {
      await createManyRecords(tx.fundNavCache, data.fundNavCaches);
    }

    if (isSystemRestore && data.stockBrokerageCatalogs.length > 0) {
      const stockBrokerageCatalogDelegate = getOptionalPrismaDelegate<OptionalPrismaRestoreDelegate>(
        tx,
        "stockBrokerageCatalog",
      );
      if (!stockBrokerageCatalogDelegate) {
        restoreError("当前系统版本不支持证券公司目录数据，请先升级后再恢复。");
      }
      await createManyRecords(stockBrokerageCatalogDelegate, data.stockBrokerageCatalogs);
    }

    if (isSystemRestore && data.distillLogs.length > 0) {
      await createManyRecords(tx.distillLog, data.distillLogs);
    }

    if (isSystemRestore && data.commandTestResults.length > 0) {
      await createManyRecords(tx.commandTestResult, data.commandTestResults);
    }

    if (isSystemRestore && data.commandAliases.length > 0) {
      await createManyRecords(tx.commandAlias, data.commandAliases);
    }

    if (data.users.length > 0) {
      await tx.user.createMany({
        data: data.users.map((item) => ({
          id: String(item.id),
          name: String(item.name ?? "user"),
          email: item.email == null ? null : String(item.email),
          role: String(item.role ?? "user"),
          isSystem: Boolean(item.isSystem),
          passwordHash: item.passwordHash == null ? null : String(item.passwordHash),
          householdId,
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      });
    }

    if (data.userSettings.length > 0) {
      await tx.userSettings.createMany({
        data: data.userSettings
          .filter((item) => importedUserSet.has(String(item.userId)))
          .map((item) => ({
            id: String(item.id),
            userId: String(item.userId),
            emailHost: item.emailHost == null ? null : String(item.emailHost),
            emailPort: item.emailPort == null ? null : Number(item.emailPort),
            emailSecure: item.emailSecure == null ? true : Boolean(item.emailSecure),
            emailUser: item.emailUser == null ? null : String(item.emailUser),
            emailPassword: item.emailPassword == null ? null : String(item.emailPassword),
            emailMailbox: item.emailMailbox == null ? "INBOX" : String(item.emailMailbox),
            smtpHost: item.smtpHost == null ? null : String(item.smtpHost),
            smtpPort: item.smtpPort == null ? null : Number(item.smtpPort),
            smtpSecure: item.smtpSecure == null ? true : Boolean(item.smtpSecure),
            smtpUser: item.smtpUser == null ? null : String(item.smtpUser),
            smtpPass: item.smtpPass == null ? null : String(item.smtpPass),
            smtpFrom: item.smtpFrom == null ? null : String(item.smtpFrom),
            resendApiKey: item.resendApiKey == null ? null : String(item.resendApiKey),
            resendFrom: item.resendFrom == null ? null : String(item.resendFrom),
            passwordResetEnabled: item.passwordResetEnabled == null ? true : Boolean(item.passwordResetEnabled),
            sessionDays: normalizeSessionDays(item.sessionDays, DEFAULT_SESSION_DAYS),
            colorScheme: item.colorScheme == null ? "red_up_green_down" : String(item.colorScheme),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      });
    }

    if (data.accountGroups.length > 0) {
      await tx.accountGroup.createMany({
        data: data.accountGroups.map((item) => ({
          id: String(item.id),
          name: String(item.name ?? ""),
          sortOrder: Number(item.sortOrder ?? 0),
          householdId,
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      });
    }

    if (data.institutions.length > 0) {
      await tx.institution.createMany({
        data: data.institutions.map((item) => ({
          id: String(item.id),
          name: String(item.name ?? ""),
          shortName: item.shortName == null ? null : String(item.shortName),
          type: item.type == null ? null : String(item.type),
          householdId,
        })),
      });
    }

    if (data.counterparties.length > 0) {
      await createManyRecords(
        tx.counterparty,
        data.counterparties.map((item) => ({
          ...item,
          householdId,
          sourceInstitutionId:
            item.sourceInstitutionId && importedInstitutions.has(String(item.sourceInstitutionId))
              ? String(item.sourceInstitutionId)
              : null,
        })),
      );
    }

    for (const categoryBatch of restoredCategoryBatches) {
      await tx.category.createMany({ data: categoryBatch });
    }

    if (data.tags.length > 0) {
      await tx.tag.createMany({
        data: data.tags.map((item) => ({
          id: String(item.id),
          name: String(item.name ?? ""),
          color: item.color == null ? null : String(item.color),
          householdId,
        })),
      });
    }

    const statementRecognitionRules = [
      ...data.statementRecognitionRules
        .map((item) =>
          restoredStatementRecognitionRule(
            item,
            householdId,
            importedCategories,
            importedInstitutions,
            restoredCategoryNameById,
          )
        )
        .filter(isPresent),
      ...data.statementCategoryRules
        .map((item) => restoredLegacyStatementCategoryRule(item, householdId, importedCategories, restoredCategoryNameById))
        .filter(isPresent),
    ];
    if (statementRecognitionRules.length > 0) {
      await createManySkipDuplicatesCompat(tx.statementRecognitionRule, statementRecognitionRules);
    }

    if (data.insuranceProductMasters.length > 0) {
      await createManyRecords(
        tx.insuranceProductMaster,
        data.insuranceProductMasters
          .filter((item) => importedInstitutions.has(String(item.institutionId)))
          .map((item) => ({ ...item, householdId })),
      );
    }

    if (data.wealthProducts.length > 0) {
      await createManyRecords(
        tx.wealthProduct,
        data.wealthProducts.map((item) => ({
          ...item,
          householdId,
          institutionId:
            item.institutionId && importedInstitutions.has(String(item.institutionId))
              ? String(item.institutionId)
              : null,
        })),
      );
    }

    if (data.fundQueryApis.length > 0) {
      await tx.fundQueryApi.createMany({
        data: data.fundQueryApis.map((item) => ({
          id: String(item.id),
          name: String(item.name ?? ""),
          code: String(item.code ?? ""),
          baseUrl: String(item.baseUrl ?? ""),
          apiKey: item.apiKey == null ? null : String(item.apiKey),
          priority: Number(item.priority ?? 0),
          isActive: item.isActive == null ? true : Boolean(item.isActive),
          householdId: isSystemRestore && item.householdId == null ? null : householdId,
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      });
    }

    if (data.preciousMetalTypes.length > 0) {
      await createManySkipDuplicatesCompat(
        tx.preciousMetalType,
        data.preciousMetalTypes.map((item) => ({
          id: String(item.id),
          code: String(item.code ?? ""),
          name: String(item.name ?? ""),
          shortName: item.shortName == null ? null : String(item.shortName),
          sortOrder: Number(item.sortOrder ?? 0),
          isActive: item.isActive == null ? true : Boolean(item.isActive),
          isSystem: Boolean(item.isSystem),
          householdId,
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      );
    }

    if (data.preciousMetalUnits.length > 0) {
      await createManySkipDuplicatesCompat(
        tx.preciousMetalUnit,
        data.preciousMetalUnits.map((item) => ({
          id: String(item.id),
          code: String(item.code ?? ""),
          name: String(item.name ?? ""),
          symbol: item.symbol == null ? null : String(item.symbol),
          decimals: Number(item.decimals ?? 3),
          sortOrder: Number(item.sortOrder ?? 0),
          isActive: item.isActive == null ? true : Boolean(item.isActive),
          isSystem: Boolean(item.isSystem),
          householdId,
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      );
    }

    if (data.accounts.length > 0) {
      await tx.account.createMany({
        data: data.accounts.map((item) => ({
          id: String(item.id),
          name: String(item.name ?? ""),
          balance: item.balance == null ? "0" : String(item.balance),
          kind: String(item.kind ?? "other") as never,
          debtDirection: item.debtDirection == null ? null : (String(item.debtDirection) as never),
          currency: item.currency == null ? "CNY" : String(item.currency),
          isActive: item.isActive == null ? true : Boolean(item.isActive),
          isPlaceholder: item.isPlaceholder == null ? false : Boolean(item.isPlaceholder),
          investProductType: item.investProductType == null ? null : (String(item.investProductType) as never),
          creditLimit: item.creditLimit == null ? null : String(item.creditLimit),
          billingDay: item.billingDay == null ? null : Number(item.billingDay),
          repaymentDay: item.repaymentDay == null ? null : Number(item.repaymentDay),
          creditBillMode: item.creditBillMode == null ? "separate" : (String(item.creditBillMode) as never),
          numberMasked: item.numberMasked == null ? null : String(item.numberMasked),
          routeKey: item.routeKey == null ? null : String(item.routeKey),
          note: item.note == null ? null : String(item.note),
          usageCount: Number(item.usageCount ?? 0),
          lastUsedAt: item.lastUsedAt == null ? null : new Date(String(item.lastUsedAt)),
          householdId,
          institutionId:
            item.institutionId && importedInstitutions.has(String(item.institutionId)) ? String(item.institutionId) : null,
          counterpartyId:
            item.counterpartyId && importedCounterparties.has(String(item.counterpartyId)) ? String(item.counterpartyId) : null,
          userId: item.userId && importedUserSet.has(String(item.userId)) ? String(item.userId) : null,
          groupId:
            item.groupId && importedAccountGroups.has(String(item.groupId))
              ? String(item.groupId)
              : restoreError(`备份文件缺少账户分组：${String(item.groupId ?? "")}`),
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          costBasisMethod: item.costBasisMethod == null ? null : (String(item.costBasisMethod) as never),
          defaultConfirmDays: item.defaultConfirmDays == null ? null : Number(item.defaultConfirmDays),
          defaultArrivalDays: item.defaultArrivalDays == null ? null : Number(item.defaultArrivalDays),
          tradingCalendar: item.tradingCalendar == null ? null : (String(item.tradingCalendar) as never),
          defaultFundQueryApiId:
            item.defaultFundQueryApiId && importedFundQueryApis.has(String(item.defaultFundQueryApiId))
              ? String(item.defaultFundQueryApiId)
              : null,
          fundUnitsDecimals: item.fundUnitsDecimals == null ? 2 : Number(item.fundUnitsDecimals),
        })),
      });
    }

    if (data.accountAliases.length > 0) {
      await tx.accountAlias.createMany({
        data: data.accountAliases
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            alias: String(item.alias ?? ""),
            accountId: String(item.accountId),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      });
    }

    if (data.fundSnapshots.length > 0) {
      await createManyRecords(
        tx.fundSnapshot,
        data.fundSnapshots.filter((item) => importedAccounts.has(String(item.accountId))),
      );
    }

    if (data.billOverrides.length > 0) {
      await tx.billOverride.createMany({
        data: data.billOverrides
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            statementMonth: String(item.statementMonth ?? ""),
            amount: item.amount == null ? "0" : String(item.amount),
            note: item.note == null ? null : String(item.note),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      });
    }

    if (data.creditCardCycles.length > 0) {
      await tx.creditCardCycle.createMany({
        data: data.creditCardCycles
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            statementMonth: String(item.statementMonth ?? ""),
            periodStart: new Date(String(item.periodStart)),
            periodEnd: new Date(String(item.periodEnd)),
            dueDate: item.dueDate == null ? null : new Date(String(item.dueDate)),
            expenseAbs: item.expenseAbs == null ? "0" : String(item.expenseAbs),
            income: item.income == null ? "0" : String(item.income),
            paid: item.paid == null ? "0" : String(item.paid),
            rawBill: item.rawBill == null ? "0" : String(item.rawBill),
            effectiveBill: item.effectiveBill == null ? "0" : String(item.effectiveBill),
            cumulativeRemain: item.cumulativeRemain == null ? "0" : String(item.cumulativeRemain),
            cumulativeOverpaid: item.cumulativeOverpaid == null ? "0" : String(item.cumulativeOverpaid),
            isCurrentCycle: item.isCurrentCycle == null ? false : Boolean(item.isCurrentCycle),
            isLocked: item.isLocked == null ? false : Boolean(item.isLocked),
            lockSource: item.lockSource == null ? null : String(item.lockSource),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      });
    }

    if (data.fundConfirmDays.length > 0) {
      await tx.fundConfirmDays.createMany({
        data: data.fundConfirmDays
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            fundCode: String(item.fundCode ?? ""),
            days: Number(item.days ?? 0),
            redeemCostDays: Number(item.redeemCostDays ?? 1),
            arrivalDays: Number(item.arrivalDays ?? 0),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
            effectiveDate: item.effectiveDate ? new Date(String(item.effectiveDate)) : new Date(),
          })),
      });
    }

    if (data.fundFeeRates.length > 0) {
      await tx.fundFeeRate.createMany({
        data: data.fundFeeRates
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            fundCode: String(item.fundCode ?? ""),
            rate: item.rate == null ? "0" : String(item.rate),
            effectiveDate: item.effectiveDate ? new Date(String(item.effectiveDate)) : new Date(),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
            feeType: String(item.feeType ?? "buy") as never,
          })),
      });
    }

    if (data.fundHoldings.length > 0) {
      await tx.fundHolding.createMany({
        data: data.fundHoldings
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            fundCode: String(item.fundCode ?? ""),
            fundName: item.fundName == null ? null : String(item.fundName),
            units: item.units == null ? "0" : String(item.units),
            avgCost: item.avgCost == null ? "0" : String(item.avgCost),
            cost: item.cost == null ? "0" : String(item.cost),
            nav: item.nav == null ? null : String(item.nav),
            pendingCost: item.pendingCost == null ? "0" : String(item.pendingCost),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
            historicalProfit: item.historicalProfit == null ? "0" : String(item.historicalProfit),
          })),
      });
    }

    if (data.stockSecurities.length > 0) {
      await createManySkipDuplicatesCompat(
        tx.stockSecurity,
        data.stockSecurities.map((item) => ({
          id: String(item.id),
          householdId,
          market: String(item.market ?? "CN"),
          stockCode: String(item.stockCode ?? ""),
          stockName: String(item.stockName ?? item.stockCode ?? ""),
          currency: item.currency == null ? "CNY" : String(item.currency),
          exchange: item.exchange == null ? null : String(item.exchange),
          isActive: item.isActive == null ? true : Boolean(item.isActive),
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      );
    }

    if (data.stockHoldings.length > 0) {
      await createManySkipDuplicatesCompat(
        tx.stockHolding,
        data.stockHoldings
          .filter((item) => importedAccounts.has(String(item.accountId)) && importedStockSecurities.has(String(item.securityId)))
          .map((item) => ({
            id: String(item.id),
            householdId,
            accountId: String(item.accountId),
            securityId: String(item.securityId),
            market: String(item.market ?? "CN"),
            stockCode: String(item.stockCode ?? ""),
            stockName: item.stockName == null ? null : String(item.stockName),
            quantity: item.quantity == null ? "0" : String(item.quantity),
            avgCost: item.avgCost == null ? "0" : String(item.avgCost),
            cost: item.cost == null ? "0" : String(item.cost),
            latestPrice: item.latestPrice == null ? null : String(item.latestPrice),
            marketValue: item.marketValue == null ? "0" : String(item.marketValue),
            historicalProfit: item.historicalProfit == null ? "0" : String(item.historicalProfit),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      );
    }

    if (data.stockPriceCache.length > 0) {
      await createManySkipDuplicatesCompat(
        tx.stockPriceCache,
        data.stockPriceCache
          .filter((item) => !item.securityId || importedStockSecurities.has(String(item.securityId)))
          .map((item) => ({
            id: String(item.id),
            securityId: item.securityId && importedStockSecurities.has(String(item.securityId)) ? String(item.securityId) : null,
            market: String(item.market ?? "CN"),
            stockCode: String(item.stockCode ?? ""),
            priceDate: item.priceDate ? new Date(String(item.priceDate)) : new Date(),
            closePrice: item.closePrice == null ? "0" : String(item.closePrice),
            currency: item.currency == null ? "CNY" : String(item.currency),
            source: item.source == null ? "manual" : String(item.source),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      );
    }

    if (data.stockFeeRules.length > 0) {
      await createManySkipDuplicatesCompat(
        tx.stockFeeRule,
        data.stockFeeRules
          .filter((item) => importedAccounts.has(String(item.accountId)) && (!item.securityId || importedStockSecurities.has(String(item.securityId))))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            securityId: item.securityId && importedStockSecurities.has(String(item.securityId)) ? String(item.securityId) : null,
            market: item.market == null ? null : String(item.market),
            stockCode: item.stockCode == null ? null : String(item.stockCode),
            feeType: String(item.feeType ?? "commission") as never,
            direction: String(item.direction ?? "both") as never,
            rate: item.rate == null ? null : String(item.rate),
            amount: item.amount == null ? null : String(item.amount),
            minAmount: item.minAmount == null ? null : String(item.minAmount),
            currency: item.currency == null ? "CNY" : String(item.currency),
            effectiveDate: item.effectiveDate ? new Date(String(item.effectiveDate)) : new Date(),
            source: item.source == null ? "manual" : String(item.source),
            note: item.note == null ? null : String(item.note),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      );
    }

    if (data.stockMarketFeeRules.length > 0) {
      await createManySkipDuplicatesCompat(
        tx.stockMarketFeeRule,
        data.stockMarketFeeRules.map((item) => ({
          id: String(item.id),
          householdId,
          market: String(item.market ?? "CN"),
          stockCode: item.stockCode == null ? null : String(item.stockCode),
          feeType: String(item.feeType ?? "commission") as never,
          direction: String(item.direction ?? "both") as never,
          rate: item.rate == null ? null : String(item.rate),
          amount: item.amount == null ? null : String(item.amount),
          minAmount: item.minAmount == null ? null : String(item.minAmount),
          currency: item.currency == null ? "CNY" : String(item.currency),
          effectiveDate: item.effectiveDate ? new Date(String(item.effectiveDate)) : new Date(),
          source: item.source == null ? "manual" : String(item.source),
          sourceUrl: item.sourceUrl == null ? null : String(item.sourceUrl),
          note: item.note == null ? null : String(item.note),
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      );
    }

    if (data.preciousMetalHoldings.length > 0) {
      await createManySkipDuplicatesCompat(
        tx.preciousMetalHolding,
        data.preciousMetalHoldings
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            householdId,
            metalTypeId: String(item.metalTypeId ?? ""),
            metalTypeName: String(item.metalTypeName ?? ""),
            metalUnitId: String(item.metalUnitId ?? ""),
            metalUnitName: String(item.metalUnitName ?? ""),
            quantity: item.quantity == null ? "0" : String(item.quantity),
            avgCost: item.avgCost == null ? "0" : String(item.avgCost),
            cost: item.cost == null ? "0" : String(item.cost),
            unitPrice: item.unitPrice == null ? null : String(item.unitPrice),
            marketValue: item.marketValue == null ? "0" : String(item.marketValue),
            historicalProfit: item.historicalProfit == null ? "0" : String(item.historicalProfit),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          })),
      );
    }

    if (propertyAssetDelegate) {
      await createManyRecords(
        propertyAssetDelegate,
        data.propertyAssets
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            ...item,
            householdId,
            accountId: String(item.accountId),
            name: String(item.name ?? ""),
            currency: item.currency == null ? "CNY" : String(item.currency),
            purchasePrice: item.purchasePrice == null ? null : String(item.purchasePrice),
            cost: item.cost == null ? "0" : String(item.cost),
            marketValue: item.marketValue == null ? "0" : String(item.marketValue),
            status: item.status == null ? "active" : String(item.status),
          })),
        new Set(["purchaseDate", "latestValuationDate", "deletedAt"]),
      );
    }

    if (propertyValuationDelegate) {
      await createManyRecords(
        propertyValuationDelegate,
        data.propertyValuations
          .filter((item) => importedPropertyAssets.has(String(item.propertyAssetId)))
          .map((item) => ({
            ...item,
            householdId,
            propertyAssetId: String(item.propertyAssetId),
            marketValue: item.marketValue == null ? "0" : String(item.marketValue),
            source: item.source == null ? "manual" : String(item.source),
          })),
      );
    }

    await createManyRecords(
      tx.fxRate,
      data.fxRates.map((item) => ({ ...item, householdId })),
    );

    await createManyRecords(
      tx.insuranceProduct,
      data.insuranceProducts
        .filter((item) => importedAccounts.has(String(item.accountId)))
        .map((item) => ({
          ...item,
          householdId,
          productMasterId:
            item.productMasterId && importedInsuranceProductMasters.has(String(item.productMasterId))
              ? String(item.productMasterId)
              : null,
          institutionId:
            item.institutionId && importedInstitutions.has(String(item.institutionId))
              ? String(item.institutionId)
              : null,
          ownerGroupId:
            item.ownerGroupId && importedAccountGroups.has(String(item.ownerGroupId))
              ? String(item.ownerGroupId)
              : null,
          policyholderPersonId:
            item.policyholderPersonId && importedInstitutions.has(String(item.policyholderPersonId))
              ? String(item.policyholderPersonId)
              : null,
          insuredUserId:
            item.insuredUserId && importedUserSet.has(String(item.insuredUserId))
              ? String(item.insuredUserId)
              : null,
          insuredPersonId:
            item.insuredPersonId && importedInstitutions.has(String(item.insuredPersonId))
              ? String(item.insuredPersonId)
              : null,
        })),
      new Set(["startDate", "effectiveDate", "maturityDate"]),
    );

    const installmentSourceEntries = new Map(
      data.creditCardInstallmentPlans.map((item) => [String(item.id), item.sourceEntryId]),
    );
    await createManyRecords(
      tx.creditCardInstallmentPlan,
      data.creditCardInstallmentPlans
        .filter((item) => importedAccounts.has(String(item.accountId)))
        .map((item) => ({ ...item, householdId, sourceEntryId: null })),
    );

    if (data.importBatches.length > 0) {
      await tx.importBatch.createMany({
        data: data.importBatches.map((item) => ({
          id: String(item.id),
          source: item.source == null ? null : String(item.source),
          note: item.note == null ? null : String(item.note),
          rawText: item.rawText == null ? null : String(item.rawText),
          householdId,
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
        })),
      });
    }
    await reportProgress({ stage: "importing", percent: 68, label: "导入交易明细", detail: "正在写入交易记录" });

    if (data.transactions.length > 0) {
      await createMappedRecordsInChunks(
        tx.txRecord,
        data.transactions,
        (item) => {
            if (!importedAccounts.has(String(item.accountId))) return null;
            const categoryId = item.categoryId && importedCategories.has(String(item.categoryId))
              ? String(item.categoryId)
              : null;
            return {
              id: String(item.id),
              date: new Date(String(item.date)),
              postedAt: item.postedAt == null ? null : new Date(String(item.postedAt)),
              type: String(item.type ?? "expense") as never,
              amount: item.amount == null ? "0" : String(item.amount),
              accountId: String(item.accountId),
              accountName: String(item.accountName ?? ""),
              toAccountId: item.toAccountId && importedAccounts.has(String(item.toAccountId)) ? String(item.toAccountId) : null,
              toAccountName: item.toAccountName == null ? null : String(item.toAccountName),
              categoryId,
              categoryName: categoryId
                ? restoredCategoryNameById.get(categoryId) ?? (item.categoryName == null ? null : String(item.categoryName))
                : item.categoryName == null ? null : String(item.categoryName),
              fundCode: null,
              fundProductType: isSplitFundProjection(item) || item.fundProductType == null ? null : (String(item.fundProductType) as never),
              metalTypeId:
                item.metalTypeId && importedPreciousMetalTypes.has(String(item.metalTypeId))
                  ? String(item.metalTypeId)
                  : null,
              metalTypeName: item.metalTypeName == null ? null : String(item.metalTypeName),
              metalUnitId:
                item.metalUnitId && importedPreciousMetalUnits.has(String(item.metalUnitId))
                  ? String(item.metalUnitId)
                  : null,
              metalUnitName: item.metalUnitName == null ? null : String(item.metalUnitName),
              metalQuantity: item.metalQuantity == null ? null : String(item.metalQuantity),
              metalUnitPrice: item.metalUnitPrice == null ? null : String(item.metalUnitPrice),
              metalFee: item.metalFee == null ? null : String(item.metalFee),
              confirmDate: item.confirmDate == null ? null : new Date(String(item.confirmDate)),
              statementMonth: item.statementMonth == null ? null : String(item.statementMonth),
              note: item.note == null ? null : String(item.note),
              toNote: item.toNote == null ? null : String(item.toNote),
              deletedAt: item.deletedAt == null ? null : new Date(String(item.deletedAt)),
              importBatchId:
                item.importBatchId && importedImportBatches.has(String(item.importBatchId)) ? String(item.importBatchId) : null,
              householdId,
              createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
              updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
              dayOrder: Number(item.dayOrder ?? 0),
              currency: item.currency == null ? "CNY" : String(item.currency),
              paymentChannelId: item.paymentChannelId == null ? null : String(item.paymentChannelId),
              paymentChannelName: item.paymentChannelName == null ? null : String(item.paymentChannelName),
              counterpartyInstitutionId:
                item.counterpartyInstitutionId && importedInstitutions.has(String(item.counterpartyInstitutionId))
                  ? String(item.counterpartyInstitutionId)
                  : null,
              counterpartyInstitutionName:
                item.counterpartyInstitutionName == null ? null : String(item.counterpartyInstitutionName),
              status: String(item.status ?? "posted") as never,
              fundArrivalAmount: isSplitFundProjection(item) || item.fundArrivalAmount == null ? null : String(item.fundArrivalAmount),
              fundArrivalDate: isSplitFundProjection(item) || item.fundArrivalDate == null ? null : new Date(String(item.fundArrivalDate)),
              depositAnnualRate: item.depositAnnualRate == null ? null : String(item.depositAnnualRate),
              depositInterest: item.depositInterest == null ? null : String(item.depositInterest),
              depositSourceEntryId:
                item.depositSourceEntryId && importedTransactions.has(String(item.depositSourceEntryId))
                  ? String(item.depositSourceEntryId)
                  : null,
              fundSourceEntryId:
                item.fundSourceEntryId && importedTransactions.has(String(item.fundSourceEntryId))
                  ? String(item.fundSourceEntryId)
                  : null,
              debtPrincipalAmount: item.debtPrincipalAmount == null ? null : String(item.debtPrincipalAmount),
              debtInterestAmount: item.debtInterestAmount == null ? null : String(item.debtInterestAmount),
              debtFeeAmount: item.debtFeeAmount == null ? null : String(item.debtFeeAmount),
              fundConfirmDate: isSplitFundProjection(item) || item.fundConfirmDate == null ? null : new Date(String(item.fundConfirmDate)),
              fundFee: isSplitFundProjection(item) || item.fundFee == null ? null : String(item.fundFee),
              fundNav: isSplitFundProjection(item) || item.fundNav == null ? null : String(item.fundNav),
              fundSubtype: isSplitFundProjection(item) || item.fundSubtype == null ? null : (String(item.fundSubtype) as never),
              fundUnits: isSplitFundProjection(item) || item.fundUnits == null ? null : String(item.fundUnits),
              realizedProfit: item.realizedProfit == null ? null : String(item.realizedProfit),
              regularInvestPlanId: item.regularInvestPlanId == null ? null : String(item.regularInvestPlanId),
              creditCardInstallmentPlanId:
                item.creditCardInstallmentPlanId && importedCreditCardInstallmentPlans.has(String(item.creditCardInstallmentPlanId))
                  ? String(item.creditCardInstallmentPlanId)
                  : null,
              installmentNo: item.installmentNo == null ? null : Number(item.installmentNo),
              installmentTotal: item.installmentTotal == null ? null : Number(item.installmentTotal),
              installmentPrincipal: item.installmentPrincipal == null ? null : String(item.installmentPrincipal),
              installmentInterest: item.installmentInterest == null ? null : String(item.installmentInterest),
              installmentRole: item.installmentRole == null ? null : String(item.installmentRole),
              fundName: isSplitFundProjection(item) || item.fundName == null ? null : String(item.fundName),
              wealthProductId:
                item.wealthProductId && importedWealthProducts.has(String(item.wealthProductId))
                  ? String(item.wealthProductId)
                  : null,
              insuranceProductId:
                item.insuranceProductId && importedInsuranceProducts.has(String(item.insuranceProductId))
                  ? String(item.insuranceProductId)
                  : null,
              insuranceAction: item.insuranceAction == null ? null : String(item.insuranceAction),
              insuranceProductName: item.insuranceProductName == null ? null : String(item.insuranceProductName),
              source: item.source == null ? null : String(item.source),
              entryOrigin: item.entryOrigin == null ? "manual" : String(item.entryOrigin),
            };
          },
        {
          ...(isSqliteRuntime()
            ? {}
            : {
                batchSize: Math.max(data.transactions.length, 1),
                fastInsert: (batch: Record<string, unknown>[]) =>
                  insertTransactionsViaJson(tx as RawExecuteClient, batch),
              }),
          afterChunk: async (completed, total) => {
            const percent = 68 + Math.round((Math.min(completed, total) / Math.max(total, 1)) * 12);
            await reportProgress({
              stage: "importing",
              percent,
              label: "导入交易明细",
              detail: `正在写入交易记录 ${Math.min(completed, total)} / ${total}`,
            });
          },
        },
      );
    }

    if (legacyMainFundRows.length > 0) {
      const legacyFundTransactions: Record<string, unknown>[] = legacyMainFundRows
        .flatMap((item) => {
          const fundAccountId = legacyFundAccountIdOf(item);
          if (!fundAccountId || !importedAccounts.has(fundAccountId)) return [];
          const cashAccountId = legacyFundCashAccountIdOf(item, importedAccounts);
          const subtype = normalizeLegacyFundSubtype(item.fundSubtype);
          const cashReceipt = isLegacyFundCashReceipt(item);
          return [{
            id: String(item.id),
            householdId,
            fundAccountId,
            cashAccountId,
            cashEntryId: importedTransactions.has(String(item.id)) ? String(item.id) : null,
            fundCode: String(item.fundCode),
            fundName: item.fundName == null ? null : String(item.fundName),
            fundProductType: normalizeLegacyFundProductType(item.fundProductType),
            fundSubtype: subtype,
            source: item.source == null ? null : String(item.source),
            applyDate: new Date(String(item.date)),
            confirmDate: legacyDate(item.fundConfirmDate),
            arrivalDate: legacyDate(item.fundArrivalDate),
            grossAmount: absDecimalString(item.amount),
            refundAmount: "0",
            arrivalAmount: item.fundArrivalAmount == null && !cashReceipt ? null : absDecimalString(item.fundArrivalAmount ?? item.amount),
            fee: item.fundFee == null ? null : String(item.fundFee),
            nav: item.fundNav == null ? null : String(item.fundNav),
            units: item.fundUnits == null ? null : String(item.fundUnits),
            realizedProfit: item.realizedProfit == null ? null : String(item.realizedProfit),
            regularInvestPlanId: item.regularInvestPlanId == null ? null : String(item.regularInvestPlanId),
            note: item.note == null ? null : String(item.note),
            deletedAt: legacyDate(item.deletedAt),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
          }];
        });

      await createManyRecords(
        tx.fundTransaction,
        legacyFundTransactions,
        new Set(["confirmDate", "arrivalDate", "deletedAt"]),
      );
      for (const item of legacyFundTransactions) importedFundTransactions.add(String(item.id));

      const legacyCashFlows = [
        ...legacyMainFundRows
          .filter((item) => legacyMainFundIds.has(String(item.id)))
          .map((item) => ({
            id: `cff_${String(item.id)}`,
            fundTransactionId: String(item.id),
            txRecordId: String(item.id),
            kind: legacyFundCashFlowKindOf(item),
            amount: absDecimalString(item.fundArrivalAmount ?? item.amount),
            flowDate: isLegacyFundCashReceipt(item)
              ? legacyDate(item.fundArrivalDate) ?? new Date(String(item.date))
              : new Date(String(item.date)),
            accountId: legacyFundCashAccountIdOf(item, importedAccounts),
          })),
        ...legacyRefundRows.map((item) => ({
          id: `cfr_${String(item.id)}`,
          fundTransactionId: String(item.fundSourceEntryId),
          txRecordId: String(item.id),
          kind: "refund_in",
          amount: absDecimalString(item.fundArrivalAmount ?? item.amount),
          flowDate: legacyDate(item.fundArrivalDate) ?? new Date(String(item.date)),
          accountId: legacyFundCashAccountIdOf(item, importedAccounts),
        })),
      ].filter((item) => importedFundTransactions.has(String(item.fundTransactionId)));

      await createManyRecords(tx.fundTransactionCashFlow, legacyCashFlows);

      const refundSummary = new Map<string, { amount: number; arrivalDate: Date | null }>();
      for (const refund of legacyRefundRows) {
        const sourceId = String(refund.fundSourceEntryId);
        if (!importedFundTransactions.has(sourceId)) continue;
        const current = refundSummary.get(sourceId) ?? { amount: 0, arrivalDate: null };
        current.amount += Number(absDecimalString(refund.fundArrivalAmount ?? refund.amount));
        const arrivalDate = legacyDate(refund.fundArrivalDate) ?? legacyDate(refund.date);
        if (arrivalDate && (!current.arrivalDate || arrivalDate > current.arrivalDate)) current.arrivalDate = arrivalDate;
        refundSummary.set(sourceId, current);
      }
      for (const [fundTransactionId, summary] of refundSummary.entries()) {
        await tx.fundTransaction.updateMany({
          where: { id: fundTransactionId, householdId },
          data: {
            refundAmount: String(summary.amount),
            arrivalDate: summary.arrivalDate,
          },
        });
      }

      for (const flow of legacyCashFlows) {
        await upsertEntryBusinessCashFlowLink(tx, {
          householdId,
          cashEntryId: String(flow.txRecordId),
          fundTransactionId: String(flow.fundTransactionId),
          businessType: "fund",
          cashFlowDirection: String(flow.kind) === "buy_out" ? "outflow" : String(flow.kind) === "dividend_reinvest_internal" ? "internal" : "inflow",
          source: "backup_restore_legacy",
          note: "Restored legacy fund cash flow link",
          metadata: {
            splitRecord: true,
            independentBusinessTransaction: true,
            restoredFromLegacyTxRecord: true,
          },
        });
      }
    }

    for (const [planId, sourceEntryId] of installmentSourceEntries.entries()) {
      if (sourceEntryId && importedTransactions.has(String(sourceEntryId))) {
        await tx.creditCardInstallmentPlan.updateMany({
          where: { id: planId, householdId },
          data: { sourceEntryId: String(sourceEntryId) },
        });
      }
    }

    await createManyRecords(
      tx.fxConversion,
      data.fxConversions
        .filter(
          (item) =>
            importedTransactions.has(String(item.fromEntryId)) &&
            importedTransactions.has(String(item.toEntryId)) &&
            importedAccounts.has(String(item.fromAccountId)) &&
            importedAccounts.has(String(item.toAccountId)),
        )
        .map((item) => ({ ...item, householdId })),
    );

    await createManyRecords(
      tx.fundTransaction,
      data.fundTransactions
        .filter((item) => importedAccounts.has(String(item.fundAccountId)))
        .map((item) => ({
          ...item,
          householdId,
          cashAccountId:
            item.cashAccountId && importedAccounts.has(String(item.cashAccountId))
              ? String(item.cashAccountId)
              : null,
          cashEntryId:
            item.cashEntryId && importedTransactions.has(String(item.cashEntryId))
              ? String(item.cashEntryId)
              : null,
          regularInvestPlanId: item.regularInvestPlanId == null ? null : String(item.regularInvestPlanId),
        })),
      new Set(["confirmDate", "arrivalDate", "deletedAt"]),
    );

    await createManyRecords(
      tx.insuranceTransaction,
      data.insuranceTransactions
        .filter(
          (item) =>
            importedAccounts.has(String(item.accountId)) &&
            importedInsuranceProducts.has(String(item.insuranceProductId)),
        )
        .map((item) => ({
          ...item,
          householdId,
          cashAccountId:
            item.cashAccountId && importedAccounts.has(String(item.cashAccountId))
              ? String(item.cashAccountId)
              : null,
          cashEntryId:
            item.cashEntryId && importedTransactions.has(String(item.cashEntryId))
              ? String(item.cashEntryId)
              : null,
        })),
      new Set(["postedAt", "arrivalDate", "deletedAt"]),
    );

    await createManyRecords(
      tx.wealthTransaction,
      data.wealthTransactions
        .filter((item) => importedAccounts.has(String(item.accountId)))
        .map((item) => ({
          ...item,
          householdId,
          cashAccountId:
            item.cashAccountId && importedAccounts.has(String(item.cashAccountId))
              ? String(item.cashAccountId)
              : null,
          cashEntryId:
            item.cashEntryId && importedTransactions.has(String(item.cashEntryId))
              ? String(item.cashEntryId)
              : null,
          wealthProductId:
            item.wealthProductId && importedWealthProducts.has(String(item.wealthProductId))
              ? String(item.wealthProductId)
              : null,
        })),
      new Set(["confirmDate", "arrivalDate", "deletedAt"]),
    );

    await createManyRecords(
      tx.depositTransaction,
      data.depositTransactions
        .filter((item) => importedAccounts.has(String(item.accountId)))
        .map((item) => ({
          ...item,
          householdId,
          cashAccountId:
            item.cashAccountId && importedAccounts.has(String(item.cashAccountId))
              ? String(item.cashAccountId)
              : null,
          cashEntryId:
            item.cashEntryId && importedTransactions.has(String(item.cashEntryId))
              ? String(item.cashEntryId)
              : null,
          sourceDepositTransactionId:
            item.sourceDepositTransactionId && importedDepositTransactions.has(String(item.sourceDepositTransactionId))
              ? String(item.sourceDepositTransactionId)
              : null,
        })),
      new Set(["maturityDate", "arrivalDate", "deletedAt"]),
    );

    await createManyRecords(
      tx.preciousMetalTransaction,
      data.preciousMetalTransactions
        .filter(
          (item) =>
            importedAccounts.has(String(item.accountId)) &&
            importedPreciousMetalTypes.has(String(item.metalTypeId)) &&
            importedPreciousMetalUnits.has(String(item.metalUnitId)),
        )
        .map((item) => ({
          ...item,
          householdId,
          cashAccountId:
            item.cashAccountId && importedAccounts.has(String(item.cashAccountId))
              ? String(item.cashAccountId)
              : null,
          cashEntryId:
            item.cashEntryId && importedTransactions.has(String(item.cashEntryId))
              ? String(item.cashEntryId)
              : null,
        })),
      new Set(["deletedAt"]),
    );

    await createManyRecords(
      tx.stockTransaction,
      data.stockTransactions
        .filter(
          (item) =>
            importedAccounts.has(String(item.stockAccountId)) &&
            (!item.cashAccountId || importedAccounts.has(String(item.cashAccountId))) &&
            (!item.securityId || importedStockSecurities.has(String(item.securityId))),
        )
        .map((item) => ({
          ...item,
          householdId,
          stockAccountId: String(item.stockAccountId),
          cashAccountId:
            item.cashAccountId && importedAccounts.has(String(item.cashAccountId))
              ? String(item.cashAccountId)
              : null,
          cashEntryId:
            item.cashEntryId && importedTransactions.has(String(item.cashEntryId))
              ? String(item.cashEntryId)
              : null,
          securityId:
            item.securityId && importedStockSecurities.has(String(item.securityId))
              ? String(item.securityId)
              : null,
          market: String(item.market ?? "CN"),
          stockCode: String(item.stockCode ?? ""),
          stockName: item.stockName == null ? null : String(item.stockName),
          action: String(item.action ?? "buy") as never,
          source: item.source == null ? "manual" : String(item.source),
          grossAmount: item.grossAmount == null ? "0" : String(item.grossAmount),
          netAmount: item.netAmount == null ? null : String(item.netAmount),
          quantity: item.quantity == null ? null : String(item.quantity),
          price: item.price == null ? null : String(item.price),
          fee: item.fee == null ? null : String(item.fee),
          commission: item.commission == null ? null : String(item.commission),
          stampTax: item.stampTax == null ? null : String(item.stampTax),
          transferFee: item.transferFee == null ? null : String(item.transferFee),
          exchangeFee: item.exchangeFee == null ? null : String(item.exchangeFee),
          regulatoryFee: item.regulatoryFee == null ? null : String(item.regulatoryFee),
          otherFee: item.otherFee == null ? null : String(item.otherFee),
          realizedProfit: item.realizedProfit == null ? null : String(item.realizedProfit),
          externalLinkId: item.externalLinkId == null ? null : String(item.externalLinkId),
          brokerTradeId: item.brokerTradeId == null ? null : String(item.brokerTradeId),
          note: item.note == null ? null : String(item.note),
        })),
      new Set(["settleDate", "deletedAt"]),
    );

    if (propertyTransactionDelegate) {
      await createManyRecords(
        propertyTransactionDelegate,
        data.propertyTransactions
          .filter(
            (item) =>
              importedAccounts.has(String(item.accountId)) &&
              importedPropertyAssets.has(String(item.propertyAssetId)) &&
              (!item.cashAccountId || importedAccounts.has(String(item.cashAccountId))),
          )
          .map((item) => ({
            ...item,
            householdId,
            accountId: String(item.accountId),
            cashAccountId:
              item.cashAccountId && importedAccounts.has(String(item.cashAccountId))
                ? String(item.cashAccountId)
                : null,
            cashEntryId:
              item.cashEntryId && importedTransactions.has(String(item.cashEntryId))
                ? String(item.cashEntryId)
                : null,
            propertyAssetId: String(item.propertyAssetId),
            action: String(item.action ?? "purchase") as never,
            source: item.source == null ? "manual" : String(item.source),
            amount: item.amount == null ? "0" : String(item.amount),
            fee: item.fee == null ? null : String(item.fee),
            tax: item.tax == null ? null : String(item.tax),
            realizedProfit: item.realizedProfit == null ? null : String(item.realizedProfit),
            note: item.note == null ? null : String(item.note),
          })),
        new Set(["settlementDate", "deletedAt"]),
      );
    }

    await createManyRecords(
      tx.fundTransactionCashFlow,
      data.fundTransactionCashFlows
        .filter(
          (item) =>
            importedFundTransactions.has(String(item.fundTransactionId)) &&
            importedTransactions.has(String(item.txRecordId)),
        )
        .map((item) => ({
          ...item,
          accountId:
            item.accountId && importedAccounts.has(String(item.accountId))
              ? String(item.accountId)
              : null,
        })),
    );

    await reportProgress({ stage: "importing", percent: 86, label: "导入关联数据", detail: "正在写入交易关联和附件" });

    await createManyRecords(
      tx.entryBusinessLink,
      data.entryBusinessLinks.map((item) => ({
        ...item,
        householdId,
        cashEntryId:
          item.cashEntryId && importedTransactions.has(String(item.cashEntryId))
            ? String(item.cashEntryId)
            : null,
        businessEntryId:
          item.businessEntryId && importedTransactions.has(String(item.businessEntryId))
            ? String(item.businessEntryId)
            : null,
        fundTransactionId:
          item.fundTransactionId && importedFundTransactions.has(String(item.fundTransactionId))
            ? String(item.fundTransactionId)
            : null,
        insuranceTransactionId:
          item.insuranceTransactionId && importedInsuranceTransactions.has(String(item.insuranceTransactionId))
            ? String(item.insuranceTransactionId)
            : null,
        wealthTransactionId:
          item.wealthTransactionId && importedWealthTransactions.has(String(item.wealthTransactionId))
            ? String(item.wealthTransactionId)
            : null,
        depositTransactionId:
          item.depositTransactionId && importedDepositTransactions.has(String(item.depositTransactionId))
            ? String(item.depositTransactionId)
            : null,
        preciousMetalTransactionId:
          item.preciousMetalTransactionId && importedPreciousMetalTransactions.has(String(item.preciousMetalTransactionId))
            ? String(item.preciousMetalTransactionId)
            : null,
        ...(item.stockTransactionId && importedStockTransactions.has(String(item.stockTransactionId))
          ? { stockTransactionId: String(item.stockTransactionId) }
          : {}),
        ...(item.propertyTransactionId && importedPropertyTransactions.has(String(item.propertyTransactionId))
          ? { propertyTransactionId: String(item.propertyTransactionId) }
          : {}),
      })),
      new Set(["deletedAt"]),
    );

    if (data.attachments.length > 0) {
      await createMappedRecordsInChunks(
        tx.attachment,
        data.attachments,
        (item) =>
          importedTransactions.has(String(item.entryId))
            ? {
            id: String(item.id),
            name: item.name == null ? null : String(item.name),
            mimeType: item.mimeType == null ? null : String(item.mimeType),
            url: item.url == null ? null : String(item.url),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            entryId: String(item.entryId),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
              }
            : null,
      );
    }

    if (data.entryTags.length > 0) {
      await createMappedRecordsInChunks(
        tx.entryTag,
        data.entryTags,
        (item) =>
          importedTransactions.has(String(item.entryId)) && importedTags.has(String(item.tagId))
            ? {
            entryId: String(item.entryId),
            tagId: String(item.tagId),
              }
            : null,
      );
    }

    if (data.regularInvestPlans.length > 0) {
      await tx.regularInvestPlan.createMany({
        data: data.regularInvestPlans
          .filter((item) => importedAccounts.has(String(item.accountId)))
          .map((item) => ({
            id: String(item.id),
            accountId: String(item.accountId),
            cashAccountId:
              item.cashAccountId && importedAccounts.has(String(item.cashAccountId)) ? String(item.cashAccountId) : null,
            fundCode: String(item.fundCode ?? ""),
            fundName: item.fundName == null ? null : String(item.fundName),
            amount: item.amount == null ? "0" : String(item.amount),
            intervalUnit: String(item.intervalUnit ?? "month") as never,
            intervalValue: Number(item.intervalValue ?? 1),
            nextRunDate: new Date(String(item.nextRunDate)),
            lastRunDate: item.lastRunDate == null ? null : new Date(String(item.lastRunDate)),
            feeRate: item.feeRate == null ? null : String(item.feeRate),
            confirmDays: item.confirmDays == null ? null : Number(item.confirmDays),
            arrivalDays: item.arrivalDays == null ? 2 : Number(item.arrivalDays),
            createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
            updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
            accountName: String(item.accountName ?? ""),
            cashAccountName: item.cashAccountName == null ? null : String(item.cashAccountName),
            endDate: item.endDate == null ? null : new Date(String(item.endDate)),
            executedRuns: Number(item.executedRuns ?? 0),
            fundProductType: item.fundProductType == null ? null : (String(item.fundProductType) as never),
            taskType: item.taskType == null ? null : String(item.taskType),
            planName: item.planName == null ? null : String(item.planName),
            targetName: item.targetName == null ? null : String(item.targetName),
            insuranceProductName: item.insuranceProductName == null ? null : String(item.insuranceProductName),
            memo: item.memo == null ? null : String(item.memo),
            startDate: new Date(String(item.startDate)),
            status: String(item.status ?? "active") as never,
            totalRuns: item.totalRuns == null ? null : Number(item.totalRuns),
            executionDay: item.executionDay == null ? null : Number(item.executionDay),
            secondaryExecutionDay: item.secondaryExecutionDay == null ? null : Number(item.secondaryExecutionDay),
            skipPendingPreceding: item.skipPendingPreceding == null ? true : Boolean(item.skipPendingPreceding),
            householdId,
          })),
      });
    }

    await createManyRecords(
      tx.loanRateAdjustment,
      data.loanRateAdjustments
        .filter((item) => importedAccounts.has(String(item.accountId)))
        .map((item) => ({
          ...item,
          householdId,
          regularInvestPlanId:
            item.regularInvestPlanId && data.regularInvestPlans.some((plan) => String(plan.id) === String(item.regularInvestPlanId))
              ? String(item.regularInvestPlanId)
              : null,
        })),
    );

    if (data.emailAccounts.length > 0) {
      await tx.emailAccount.createMany({
        data: data.emailAccounts.map((item) => ({
          id: String(item.id),
          householdId,
          label: String(item.label ?? ""),
          username: String(item.username ?? ""),
          imapHost: String(item.imapHost ?? ""),
          imapPort: Number(item.imapPort ?? 993),
          imapSecure: item.imapSecure == null ? true : Boolean(item.imapSecure),
          outboundType: String(item.outboundType ?? "smtp"),
          smtpHost: item.smtpHost == null ? null : String(item.smtpHost),
          smtpPort: item.smtpPort == null ? null : Number(item.smtpPort),
          smtpSecure: item.smtpSecure == null ? null : Boolean(item.smtpSecure),
          smtpFrom: item.smtpFrom == null ? null : String(item.smtpFrom),
          resendApiKey: item.resendApiKey == null ? null : String(item.resendApiKey),
          resendFrom: item.resendFrom == null ? null : String(item.resendFrom),
          password: String(item.password ?? ""),
          mailbox: item.mailbox == null ? "INBOX" : String(item.mailbox),
          createdAt: item.createdAt ? new Date(String(item.createdAt)) : new Date(),
          updatedAt: item.updatedAt ? new Date(String(item.updatedAt)) : new Date(),
        })),
      });
    }

    const hasAdmin = await tx.user.count({ where: { householdId, role: "admin" } });
    if (!hasAdmin && options.fallbackAdmin) {
      await tx.user.create({
        data: {
          name: options.fallbackAdmin.name,
          role: options.fallbackAdmin.role || "admin",
          isSystem: options.fallbackAdmin.isSystem,
          email: options.fallbackAdmin.email ?? null,
          passwordHash: options.fallbackAdmin.passwordHash ?? null,
          householdId,
        },
      });
    }
  }, { maxWait: 10_000, timeout: 300_000 });

  await reportProgress({ stage: "finalizing", percent: 96, label: "收尾处理", detail: "正在刷新恢复后的加密缓存" });
  const { clearMasterKeyCache } = await import("@/lib/auth/encrypt");
  clearMasterKeyCache();
  await reportProgress({ stage: "done", percent: 100, label: "恢复完成", detail: "备份数据已写入当前账簿" });

  return {
    householdName: payload.scope.householdName,
    counts: {
      users: data.users.length,
      accounts: data.accounts.length,
      transactions: data.transactions.length,
      statementRecognitionRules: data.statementRecognitionRules.length + data.statementCategoryRules.length,
      categories: importedCategories.size,
      tags: data.tags.length,
      institutions: data.institutions.length,
      emailAccounts: data.emailAccounts.length,
      regularInvestPlans: data.regularInvestPlans.length,
    },
  };
}
