import { NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { AccountKind, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { toStatementMonth } from "@/lib/date-utils";
import { normalizeDefaultCategoryHierarchyForHousehold, type CategorySnapshot, type ResolveCategorySnapshotInput } from "@/lib/default-categories";
import { defaultModel, localProvider } from "@/lib/ai/config";
import {
  createImportAccountIdentityConflictChecker,
  normalizeImportAccountMatchKey,
  parseImportAccountId,
  resolveImportAccountIdFromList,
  type ImportAccountIdentityConflict,
} from "@/lib/account-import-match";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { createManySkipDuplicatesCompat } from "@/lib/server/prisma-create-many";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { writeImportDebugLog } from "@/lib/server/import-debug-log";
import {
  beginImportRun,
  finishImportProgress,
  finishImportRun,
  startImportProgress,
  updateImportProgress,
  isImportCancelled,
  cancelImportProgress,
} from "@/lib/server/import-progress";
import { normalizeCurrency, resolveSameCurrencyTransfer } from "@/lib/currency";
import { ENTRY_ORIGIN_EXCEL_IMPORT, TRANSACTION_SOURCE_MANUAL } from "@/lib/transaction-semantics";
import { readableTagWhere } from "@/lib/server/tag-scope";
import {
  CREDIT_CARD_REPAYMENT_BUSINESS_TYPE,
  CREDIT_CARD_REPAYMENT_CATEGORY_NAME,
  isCreditCardRepaymentBusinessType,
  isCreditCardRepaymentImportSourceAccountKind,
  isCreditCardRepaymentTargetAccountKind,
  isCreditCardRepaymentTransfer,
} from "@/lib/transaction-semantics";
import { INCOME_EXPENSE_INSTITUTION_TYPES } from "@/lib/institution-rules";
import { upsertStatementCategoryRuleFromTx } from "@/lib/statement/category-rules";
import { upsertStatementInstitutionRuleFromUserEdit } from "@/lib/statement/recognition-rules";
import { prepareEntryUndo, saveEntryUndo } from "@/lib/server/entry-undo";
import { creditBillEffectiveDate } from "@/lib/credit/billing";

/**
 * POST /api/v1/record/ingest
 * Body: { items?: ParsedItem[], text?: string, import?: boolean, defaultAccountName?: string, traceId?: string }
 * Import items may carry `inflow`/`outflow` for account-side direction; an
 * expense refund should use `{ type: "expense", inflow: amount }`.
 * Import preview rows may carry `categoryUserEdited: true` only after the
 * user manually changes the category; confirmed income/expense edits are
 * learned into statement category rules and mirrored into
 * statement_recognition_rules(targetType="category") for future imports.
 * Import preview rows may carry `institutionUserEdited: true` only after the
 * user manually fills/selects a counterparty institution; unmatched
 * institutions are stored as blank because the field is optional.
 * Transfer items must carry matched `fromAccount` and `toAccount`; the server
 * rejects incomplete transfers instead of writing an empty counter account.
 * `businessType="credit_card_repayment"` stores a transfer categorized as
 * the "credit card repayment" category while requiring a debit-card/e-wallet source and credit-card target.
 * Response: { ok: true, items, imported, createdCount?, ids? } or { ok:false, code, error }.
 */
export const runtime = "nodejs";

type Db = typeof prisma | Prisma.TransactionClient;
type AccountLookupRow = {
  id: string;
  name: string;
  kind: AccountKind;
  billingDay: number | null;
  currency: string | null;
  numberMasked: string | null;
  Institution: { name: string | null; shortName?: string | null } | null;
  AccountGroup?: { name: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
};
type ImportContext = {
  householdId: string;
  accountMetaById: Map<string, { name: string; kind: AccountKind; billingDay: number | null; currency: string | null }>;
  accountLookupRows: AccountLookupRow[];
  accountIdentityConflictFor: (
    selectedAccount: AccountLookupRow | null | undefined,
    originalText: string | undefined,
  ) => ImportAccountIdentityConflict | null;
  categorySnapshotById: Map<string, CategorySnapshot>;
  categorySnapshotByKey: Map<string, CategorySnapshot>;
  tagIdByName: Map<string, string>;
  institutionIdByName: Map<string, string>;
  institutionNameById: Map<string, string>;
  defaultAccountGroupId: string | null;
};

type ImportFailureDetail = {
  rowIndex: number;
  type: string;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  category?: string;
  remark?: string;
  error: string;
  reasonKind?: "transaction_timeout";
};

class ImportItemError extends Error {
  detail: ImportFailureDetail;

  constructor(detail: ImportFailureDetail) {
    super(`第 ${detail.rowIndex + 1} 行导入失败：${detail.error}`);
    this.name = "ImportItemError";
    this.detail = detail;
  }
}

function compactImportText(value?: string | null, maxLength = 80) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function getImportTransactionTimeoutMs(itemCount: number) {
  if (itemCount <= 500) return 60_000;
  return Math.min(45 * 60_000, Math.max(2 * 60_000, itemCount * 350));
}

function isTransactionExpiredErrorMessage(message: string) {
  return /expired transaction/i.test(message) || /timeout for this transaction/i.test(message);
}

function buildImportFailureDetail(rowIndex: number, item: ParsedItem, error: unknown): ImportFailureDetail {
  const rawMessage = error instanceof Error ? error.message : String(error || "导入失败");
  const reasonKind = isTransactionExpiredErrorMessage(rawMessage) ? "transaction_timeout" : undefined;
  const message = reasonKind === "transaction_timeout"
    ? `数据库事务超时：写入进行到第 ${rowIndex + 1} 行附近时超过事务时限，整批已回滚。这不是第 ${rowIndex + 1} 行数据校验失败，而是服务端写库耗时过长。`
    : rawMessage;
  return {
    rowIndex,
    type: item.type,
    account: compactImportText(item.account),
    fromAccount: compactImportText(item.fromAccount),
    toAccount: compactImportText(item.toAccount),
    category: compactImportText(item.category),
    remark: compactImportText(item.remark ?? item.rawText),
    error: message,
    reasonKind,
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

function getProvidedApiKey(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const key = req.headers.get("x-api-key");
  return key?.trim() || null;
}

function requireApiKey(req: Request) {
  const required = (process.env.STATEMENT_API_KEY ?? "").trim();
  if (!required) return { ok: true as const };
  const provided = getProvidedApiKey(req);
  if (!provided || provided !== required) return { ok: false as const, code: "UNAUTHORIZED" as const };
  return { ok: true as const };
}

async function isInternalImportRequest(req: Request) {
  if (req.headers.get("x-internal-import") !== "batch-import") return false;
  await getHouseholdScope();
  return true;
}

const ParsedItemSchema = z.object({
  rawText: z.string(),
  type: z.enum(["expense", "income", "transfer", "investment"]),
  businessType: z.literal(CREDIT_CARD_REPAYMENT_BUSINESS_TYPE).nullable().optional(),
  date: z.string().optional(),
  postedAt: z.string().optional(),
  amount: z.number(),
  outflow: z.number().finite().min(0).optional(),
  inflow: z.number().finite().min(0).optional(),
  account: z.string().optional(),
  fromAccount: z.string().optional(),
  toAccount: z.string().optional(),
  importMode: z.enum(["normal", "credit_card"]).optional(),
  statementAccount: z.string().optional(),
  importSourceAccount: z.string().optional(),
  importSourceFromAccount: z.string().optional(),
  importSourceToAccount: z.string().optional(),
  importSourceStatementAccount: z.string().optional(),
  category: z.string().optional(),
  categoryUserEdited: z.boolean().optional(),
  institution: z.string().optional(),
  institutionUserEdited: z.boolean().optional(),
  tags: z.string().optional(),
  remark: z.string().optional(),
  secondRemark: z.string().optional(),
  counterparty: z.string().optional(),
});

type ParsedItem = z.infer<typeof ParsedItemSchema>;

function accountSideAmountForImportItem(item: ParsedItem) {
  const amountAbs = Math.abs(Number(item.amount ?? 0));
  const inflowAbs = Math.abs(Number(item.inflow ?? 0));
  const outflowAbs = Math.abs(Number(item.outflow ?? 0));
  if (inflowAbs > 0 && outflowAbs <= 0) return inflowAbs;
  if (outflowAbs > 0 && inflowAbs <= 0) return -outflowAbs;
  return item.type === "income" ? amountAbs : -amountAbs;
}

function parseDate(date?: string) {
  if (!date) return new Date();
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return new Date();
  return d;
}

function parseOptionalDateTime(value?: string) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normalizeAccountCell(value?: string) {
  const v = (value ?? "").trim();
  if (!v) return "";
  if (v === "无" || v === "-" || v.toLowerCase() === "none") return "";
  if (v === "未识别账户") return "";
  return v;
}

function pickAccountName(value?: string, defaultAccountName?: string) {
  const normalized = normalizeAccountCell(value);
  if (normalized) return normalized;
  const fallback = normalizeAccountCell(defaultAccountName);
  return fallback;
}

async function resolveAccountId(ctx: ImportContext, tx: Db, accountName?: string) {
  if (!accountName) return null;
  const normalizedTarget = normalizeImportAccountMatchKey(accountName);
  if (!normalizedTarget) return null;
  const resolved = resolveImportAccountIdFromList(accountName, ctx.accountLookupRows);
  if (resolved) return resolved;

  // Load all accounts with aliases for matching
  const accounts = await tx.account.findMany({
    where: { householdId: ctx.householdId, isActive: true },
    select: {
      id: true,
      name: true,
      kind: true,
      billingDay: true,
      currency: true,
      numberMasked: true,
      Institution: {
        select: {
          name: true,
          shortName: true,
        },
      },
      AccountGroup: { select: { name: true } },
      AccountAlias: { select: { alias: true } },
    },
  });

  for (const account of accounts) {
    ctx.accountMetaById.set(account.id, { name: account.name, kind: account.kind, billingDay: account.billingDay, currency: account.currency });
  }
  ctx.accountLookupRows = accounts;

  const retryResolved = resolveImportAccountIdFromList(accountName, accounts);
  if (retryResolved) return retryResolved;

  return null;
}

async function ensureDefaultAccountGroupId(ctx: ImportContext, tx: Db) {
  if (ctx.defaultAccountGroupId) return ctx.defaultAccountGroupId;
  const existing = await tx.accountGroup.findFirst({ where: { name: "未指定", householdId: ctx.householdId } });
  if (existing?.id) return existing.id;
  const legacy = await tx.accountGroup.findFirst({ where: { name: "默认", householdId: ctx.householdId } });
  if (legacy?.id) {
    try {
      await tx.accountGroup.update({ where: { id: legacy.id }, data: { name: "未指定" } });
    } catch {}
    ctx.defaultAccountGroupId = legacy.id;
    return legacy.id;
  }
  try {
    const created = await tx.accountGroup.create({
      data: {
        name: "未指定",
        sortOrder: 0,
        householdId: ctx.householdId,
      },
    });
    ctx.defaultAccountGroupId = created.id;
    return created.id;
  } catch {
    const retry = await tx.accountGroup.findFirst({ where: { name: "未指定", householdId: ctx.householdId } });
    ctx.defaultAccountGroupId = retry?.id ?? null;
    return retry?.id ?? null;
  }
}

async function ensureAccountId(ctx: ImportContext, tx: Db, accountName?: string) {
  const name = normalizeAccountCell(accountName);
  if (!name) return null;
  if (name === "未指定账户" || name === "空白") return null;
  const existingId = await resolveAccountId(ctx, tx, name);
  if (existingId) return existingId;
  const groupId = await ensureDefaultAccountGroupId(ctx, tx);
  if (!groupId) return null;
  try {
    const created = await tx.account.create({
      data: {
        name,
        groupId,
        householdId: ctx.householdId,
        currency: "CNY",
        kind: AccountKind.other,
        isActive: true,
      },
    });
    ctx.accountMetaById.set(created.id, { name: created.name, kind: created.kind, billingDay: created.billingDay, currency: created.currency });
    ctx.accountLookupRows.push({ id: created.id, name: created.name, kind: created.kind, billingDay: created.billingDay, currency: created.currency, numberMasked: created.numberMasked, Institution: null, AccountGroup: null });
    return created.id;
  } catch {
    return (await resolveAccountId(ctx, tx, name)) ?? null;
  }
}

function parseTagNames(tags?: string) {
  return Array.from(
    new Set(
      String(tags ?? "")
        .split(/[，,、；;]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function resolveTagIds(ctx: ImportContext, tags?: string) {
  const names = parseTagNames(tags);
  if (names.length === 0) return [];
  return names.map((name) => ctx.tagIdByName.get(name)).filter((id): id is string => Boolean(id));
}

function normalizeInstitutionMatchKey(value?: string) {
  return String(value ?? "")
    .trim()
    .replace(/[?.?\-?_\s]/g, "")
    .toLowerCase();
}

function resolveInstitutionId(ctx: ImportContext, institutionName?: string) {
  const raw = String(institutionName ?? "").trim();
  if (!raw) return null;
  return ctx.institutionIdByName.get(normalizeInstitutionMatchKey(raw)) ?? null;
}

function sourceKeywordForInstitutionLearning(item: ParsedItem) {
  return String(item.counterparty ?? item.remark ?? item.rawText ?? "").trim();
}

function categorySnapshotKey(name: string, type: string | null) {
  return `${type ?? ""}\u0000${name.trim()}`;
}

function resolveCategorySnapshotFromContext(
  ctx: ImportContext,
  input: ResolveCategorySnapshotInput,
): CategorySnapshot | null {
  const categoryId = String(input.categoryId ?? "").trim();
  if (categoryId) {
    const category = ctx.categorySnapshotById.get(categoryId);
    if (category && (!input.type || category.type === input.type)) return category;
  }

  const categoryName = String(input.categoryName ?? "").trim();
  if (!categoryName) return null;
  if (input.type) {
    const typed = ctx.categorySnapshotByKey.get(categorySnapshotKey(categoryName, input.type));
    if (typed) return typed;
  }
  return ctx.categorySnapshotByKey.get(categorySnapshotKey(categoryName, null)) ?? null;
}

async function learnUserEditedImportCategory(ctx: ImportContext, item: ParsedItem) {
  if (!item.categoryUserEdited) return false;
  if (item.type !== "income" && item.type !== "expense") return false;
  const category = resolveCategorySnapshotFromContext(ctx, {
    categoryName: item.category,
    type: item.type,
  });
  if (!category?.id || !category.name) return false;

  const counterpartyInstitutionId = resolveInstitutionId(ctx, item.institution);
  const counterpartyInstitutionName = counterpartyInstitutionId ? String(item.institution ?? "").trim() || null : null;
  return upsertStatementCategoryRuleFromTx(prisma, {
    householdId: ctx.householdId,
    type: item.type,
    categoryId: category.id,
    categoryName: category.name,
    counterpartyInstitutionName,
    paymentChannelName: null,
    source: "user_import_preview_edit",
    note: String(item.remark ?? item.rawText ?? "").trim(),
  });
}

async function learnUserEditedImportInstitution(ctx: ImportContext, item: ParsedItem) {
  if (!item.institutionUserEdited) return false;
  const institutionId = resolveInstitutionId(ctx, item.institution);
  if (!institutionId) return false;
  const institutionName = ctx.institutionNameById.get(institutionId) ?? String(item.institution ?? "").trim();
  const keyword = sourceKeywordForInstitutionLearning(item);
  if (!keyword) return false;
  return upsertStatementInstitutionRuleFromUserEdit(prisma, {
    householdId: ctx.householdId,
    institutionId,
    institutionName,
    keyword,
    transactionType: item.type === "income" || item.type === "expense" ? item.type : "any",
    source: "user_import_preview_institution_edit",
  });
}

async function attachTags(ctx: ImportContext, tx: Db, entryId: string, tags?: string) {
  const tagIds = resolveTagIds(ctx, tags);
  if (tagIds.length === 0) return;
  await createManySkipDuplicatesCompat(tx.entryTag, tagIds.map((tagId) => ({ entryId, tagId })));
}

function statementMonthForAccountMeta(
  ctx: ImportContext,
  accountId: string | null,
  date: Date,
  type?: string | null,
  postedAt?: Date | null,
) {
  if (!accountId) return null;
  const meta = ctx.accountMetaById.get(accountId);
  if (!meta) return null;
  if (meta.kind !== AccountKind.bank_credit && meta.kind !== AccountKind.loan) return null;
  if (!meta.billingDay) return null;
  return toStatementMonth(creditBillEffectiveDate({ type, date, postedAt }) ?? date, meta.billingDay);
}

async function accountMetaFor(ctx: ImportContext, tx: Db, accountId: string | null) {
  if (!accountId) return null;
  const cached = ctx.accountMetaById.get(accountId);
  if (cached) return cached;
  const account = await tx.account.findUnique({
    where: { id: accountId },
    select: { name: true, kind: true, billingDay: true, currency: true },
  });
  if (!account) return null;
  const meta = { name: account.name, kind: account.kind, billingDay: account.billingDay, currency: account.currency };
  ctx.accountMetaById.set(accountId, meta);
  return meta;
}

function accountLookupFor(ctx: ImportContext, accountId: string | null) {
  if (!accountId) return null;
  return ctx.accountLookupRows.find((account) => account.id === accountId) ?? null;
}

function assertImportAccountIdentity(
  ctx: ImportContext,
  accountId: string | null,
  originalText: string | undefined,
  fieldLabel: string,
) {
  const original = String(originalText ?? "").trim();
  if (!original || !accountId) return;
  const selected = accountLookupFor(ctx, accountId);
  const conflict = ctx.accountIdentityConflictFor(selected, original);
  if (!conflict) return;
  const selectedName = selected?.name ?? accountId;
  throw new Error(`${fieldLabel}“${selectedName}”与导入原始账户“${conflict.originalText}”不一致，请重新选择匹配账户`);
}

async function buildImportContext(): Promise<ImportContext> {
  const { householdId } = await getHouseholdScope();
  await normalizeDefaultCategoryHierarchyForHousehold(prisma, householdId);
  const [accounts, tags, institutions, categories, defaultGroup] = await Promise.all([
    prisma.account.findMany({
      where: { householdId, isActive: true },
      select: {
        id: true,
        name: true,
        kind: true,
        billingDay: true,
        currency: true,
        numberMasked: true,
        Institution: {
          select: {
            name: true,
            shortName: true,
          },
        },
        AccountGroup: { select: { name: true } },
        AccountAlias: { select: { alias: true } },
      },
    }),
    prisma.tag.findMany({
      where: readableTagWhere(householdId),
      select: { id: true, name: true },
    }),
    prisma.institution.findMany({
      where: { householdId, type: { in: [...INCOME_EXPENSE_INSTITUTION_TYPES] } },
      select: { id: true, name: true, shortName: true, type: true },
    }),
    prisma.category.findMany({
      where: {
        OR: [{ householdId }, { householdId: null }],
      },
      orderBy: [{ householdId: "desc" }, { id: "asc" }],
      select: { id: true, name: true, type: true },
    }),
    prisma.accountGroup.findFirst({
      where: { householdId, name: "未指定" },
      select: { id: true },
    }),
  ]);
  const accountLookupRows: AccountLookupRow[] = accounts;

  const ctx: ImportContext = {
    householdId,
    accountMetaById: new Map(),
    accountLookupRows,
    accountIdentityConflictFor: createImportAccountIdentityConflictChecker(accountLookupRows),
    categorySnapshotById: new Map(),
    categorySnapshotByKey: new Map(),
    tagIdByName: new Map(),
    institutionIdByName: new Map(),
    institutionNameById: new Map(),
    defaultAccountGroupId: defaultGroup?.id ?? null,
  };

  for (const account of accounts) {
    ctx.accountMetaById.set(account.id, { name: account.name, kind: account.kind, billingDay: account.billingDay, currency: account.currency });
  }
  for (const tag of tags) {
    ctx.tagIdByName.set(tag.name, tag.id);
  }
  for (const category of categories) {
    const snapshot: CategorySnapshot = { id: category.id, name: category.name, type: category.type };
    ctx.categorySnapshotById.set(category.id, snapshot);
    const typedKey = categorySnapshotKey(category.name, category.type);
    const anyKey = categorySnapshotKey(category.name, null);
    if (!ctx.categorySnapshotByKey.has(typedKey)) ctx.categorySnapshotByKey.set(typedKey, snapshot);
    if (!ctx.categorySnapshotByKey.has(anyKey)) ctx.categorySnapshotByKey.set(anyKey, snapshot);
  }
  for (const institution of institutions) {
    const fullName = String(institution.name ?? "").trim();
    const shortName = String(institution.shortName ?? "").trim();
    if (fullName) ctx.institutionIdByName.set(normalizeInstitutionMatchKey(fullName), institution.id);
    if (shortName) ctx.institutionIdByName.set(normalizeInstitutionMatchKey(shortName), institution.id);
    if (fullName) ctx.institutionNameById.set(institution.id, fullName);
  }

  return ctx;
}

// Data-only version — no DB writes, returns flat object for createMany
async function buildTransactionRow(ctx: ImportContext, item: ParsedItem, defaultAccountName?: string) {
  const date = parseDate(item.date);
  const counterpartyInstitutionId = resolveInstitutionId(ctx, item.institution);
  const counterpartyInstitutionName = counterpartyInstitutionId ? String(item.institution ?? "").trim() || null : null;
  const rawSecondNote = String(item.secondRemark ?? "").trim();
  const primaryNote = String(item.remark ?? item.rawText ?? "").trim();
  const transferDisplayNote = rawSecondNote || primaryNote || null;
  const shouldUseDoubleEntry = item.type === "transfer" || (item.type === "investment" && !!item.fromAccount && !!item.toAccount);
  if (shouldUseDoubleEntry) {
    const fromAccountName = normalizeAccountCell(item.fromAccount);
    const toAccountName = normalizeAccountCell(item.toAccount);
    if (item.type === "transfer" && (!fromAccountName || !toAccountName)) {
      throw new Error("转账缺少转出/转入账户");
    }
    const fromAccountId = await resolveAccountId(ctx, prisma, fromAccountName) ?? await ensureAccountId(ctx, prisma, fromAccountName);
    const toAccountId = await resolveAccountId(ctx, prisma, toAccountName) ?? await ensureAccountId(ctx, prisma, toAccountName);
    if (item.type === "transfer" && (!fromAccountId || !toAccountId)) {
      throw new Error("转账账户未匹配，不能导入");
    }
    const sourceAccountId = fromAccountId ?? null;
    const fromAccountMeta = sourceAccountId ? ctx.accountMetaById.get(sourceAccountId) ?? null : null;
    const toAccountMeta = toAccountId ? ctx.accountMetaById.get(toAccountId) ?? null : null;
    const sourceAccountName = fromAccountName && parseImportAccountId(fromAccountName) ? fromAccountMeta?.name ?? fromAccountName : fromAccountName;
    const targetAccountName = toAccountName && parseImportAccountId(toAccountName) ? toAccountMeta?.name ?? toAccountName : toAccountName;
    const stmtMonth = sourceAccountId ? statementMonthForAccountMeta(ctx, sourceAccountId, date) : null;
    const currency = normalizeCurrency(fromAccountMeta?.currency ?? toAccountMeta?.currency);
    const amountAbs = Math.abs(item.amount);
    return { type: "transfer", amount: -amountAbs, date, postedAt: null,
      accountId: sourceAccountId ?? toAccountId ?? "", accountName: sourceAccountName || "未指定账户",
      toAccountId, toAccountName: targetAccountName || null, categoryId: null, categoryName: null,
      note: item.remark ?? item.rawText, toNote: transferDisplayNote,
      statementMonth: stmtMonth, counterpartyInstitutionId, counterpartyInstitutionName,
      currency, householdId: ctx.householdId, fundCode: null, fundProductType: null, fundSubtype: null };
  }
  const accountName = pickAccountName(item.account, defaultAccountName);
  const accountId = await resolveAccountId(ctx, prisma, accountName) ?? await ensureAccountId(ctx, prisma, accountName);
  const meta = accountId ? ctx.accountMetaById.get(accountId ?? "") ?? null : null;
  const storedAccountName = accountName && parseImportAccountId(accountName) ? meta?.name ?? accountName : accountName;
  const amount = accountSideAmountForImportItem(item);
  const postedAt = item.type === "expense" || item.type === "income" ? (parseOptionalDateTime(item.postedAt) ?? date) : null;
  const cat = resolveCategorySnapshotFromContext(ctx, { categoryName: item.category, type: item.type === "income" ? "income" : item.type === "expense" ? "expense" : null });
  const stmtMonth2 = accountId ? statementMonthForAccountMeta(ctx, accountId, date, item.type, postedAt) : null;
  const currency2 = normalizeCurrency(meta?.currency);
  return { type: item.type, amount, date, postedAt,
    accountId: accountId ?? "", accountName: storedAccountName || "未识别账户",
    toAccountId: null, toAccountName: null, categoryId: cat?.id ?? null, categoryName: cat?.name ?? null,
    note: item.remark ?? item.rawText, toNote: null,
    statementMonth: stmtMonth2, counterpartyInstitutionId, counterpartyInstitutionName,
    currency: currency2, householdId: ctx.householdId, fundCode: null, fundProductType: null, fundSubtype: null };
}

async function createTransactionFromItem(ctx: ImportContext, tx: Db, item: ParsedItem, defaultAccountName?: string) {
  const date = parseDate(item.date);
  const counterpartyInstitutionId = resolveInstitutionId(ctx, item.institution);
  const counterpartyInstitutionName = counterpartyInstitutionId ? String(item.institution ?? "").trim() || null : null;
  const rawSecondNote = String(item.secondRemark ?? "").trim();
  const primaryNote = String(item.remark ?? item.rawText ?? "").trim();
  const transferDisplayNote = rawSecondNote || primaryNote || null;

  const shouldUseDoubleEntry =
    item.type === "transfer" ||
    (item.type === "investment" && !!item.fromAccount && !!item.toAccount);

  if (shouldUseDoubleEntry) {
    const fromAccountName = normalizeAccountCell(item.fromAccount);
    const toAccountName = normalizeAccountCell(item.toAccount);
    if (item.type === "transfer" && (!fromAccountName || !toAccountName)) {
      throw new Error("转账缺少转出/转入账户");
    }

    const requiresExistingAccounts = isCreditCardRepaymentBusinessType(item.businessType);
    const [fromAccountId, toAccountId] = await Promise.all([
      requiresExistingAccounts
        ? resolveAccountId(ctx, tx, fromAccountName)
        : ensureAccountId(ctx, tx, fromAccountName),
      requiresExistingAccounts
        ? resolveAccountId(ctx, tx, toAccountName)
        : ensureAccountId(ctx, tx, toAccountName),
    ]);

    if (item.type === "transfer" && (!fromAccountId || !toAccountId)) {
      throw new Error("转账账户未匹配，不能导入");
    }
    const sourceAccountId = fromAccountId ?? null;
    const fromStatementMonth = statementMonthForAccountMeta(ctx, sourceAccountId, date);
    const fromAccountMeta = await accountMetaFor(ctx, tx, sourceAccountId);
    const toAccountMeta = await accountMetaFor(ctx, tx, toAccountId);
    const sourceAccountName = fromAccountName
      ? (parseImportAccountId(fromAccountName) ? fromAccountMeta?.name ?? fromAccountName : fromAccountName)
      : (toAccountId ? "未指定账户" : "未识别账户");
    const targetAccountName = toAccountName
      ? (parseImportAccountId(toAccountName) ? toAccountMeta?.name ?? toAccountName : toAccountName)
      : null;
    if (isCreditCardRepaymentBusinessType(item.businessType)) {
      if (item.type !== "transfer") throw new Error("信用卡还款必须按转账记录保存");
      if (!isCreditCardRepaymentImportSourceAccountKind(fromAccountMeta?.kind)) {
        throw new Error("信用卡还款的付款账户必须是借记卡或电子钱包账户");
      }
      if (!isCreditCardRepaymentTargetAccountKind(toAccountMeta?.kind)) {
        throw new Error("信用卡还款的对手账户必须是信用卡账户");
      }
    }
    const repaymentCategory = isCreditCardRepaymentTransfer({
      type: item.type,
      accountKind: fromAccountMeta?.kind,
      toAccountKind: toAccountMeta?.kind,
    })
      ? resolveCategorySnapshotFromContext(ctx, {
          categoryName: CREDIT_CARD_REPAYMENT_CATEGORY_NAME,
          type: "transfer",
        })
      : null;
    assertImportAccountIdentity(ctx, sourceAccountId, item.importSourceFromAccount, "转出账户");
    assertImportAccountIdentity(ctx, toAccountId, item.importSourceToAccount, "转入账户");
    const transactionCurrency = item.type === "transfer" && fromAccountMeta && toAccountMeta
      ? resolveSameCurrencyTransfer(fromAccountMeta, toAccountMeta)
      : normalizeCurrency(fromAccountMeta?.currency ?? toAccountMeta?.currency);

    const amountAbs = Math.abs(item.amount);

    // For investment transactions, detect fund fields
    let fundCode: string | null = null;
    let fundSubtype: string | null = null;

    if (item.type === "investment") {
      const rawText = item.remark ?? item.rawText ?? "";
      const fundCodeMatch = rawText.match(/\b(\d{6})\b/);
      fundCode = fundCodeMatch ? fundCodeMatch[1] : null;
      const isRedeem = /赎回|卖出/.test(rawText);
      fundSubtype = isRedeem ? "redeem" : "buy";
    }

    const transaction = await tx.txRecord.create({
    data: {
      type: item.type as any,
      date,
      postedAt: null,
        amount: -amountAbs,
        accountId: sourceAccountId ?? toAccountId ?? "",
        accountName: sourceAccountName,
        toAccountId,
        toAccountName: targetAccountName,
        categoryId: repaymentCategory?.id ?? null,
        categoryName: repaymentCategory?.name ?? null,
        note: item.remark ?? item.rawText,
        toNote: transferDisplayNote,
        counterpartyInstitutionId,
        counterpartyInstitutionName,
        statementMonth: fromStatementMonth,
        householdId: ctx.householdId,
        currency: transactionCurrency,
      },
    });

    await attachTags(ctx, tx, transaction.id, item.tags);

    return transaction;
  }

  const accountName = pickAccountName(item.account, defaultAccountName);
  const accountId = await ensureAccountId(ctx, tx, accountName);
  const category = resolveCategorySnapshotFromContext(ctx, {
    categoryName: item.category,
    type: item.type === "income" ? "income" : item.type === "expense" ? "expense" : null,
  });
  const accountMeta = await accountMetaFor(ctx, tx, accountId);
  assertImportAccountIdentity(
    ctx,
    accountId,
    item.importSourceAccount || item.importSourceStatementAccount,
    "本账户",
  );
  const storedAccountName = accountName
    ? (parseImportAccountId(accountName) ? accountMeta?.name ?? accountName : accountName)
    : "未识别账户";

  const sign = item.type === "income" ? 1 : -1;
  const amount = sign * Math.abs(item.amount);
  const postedAt = item.type === "expense" || item.type === "income" ? (parseOptionalDateTime(item.postedAt) ?? date) : null;
  const statementMonth = statementMonthForAccountMeta(ctx, accountId, date, item.type, postedAt);

  // For investment transactions, detect fund fields
  let fundCode: string | null = null;
  let fundSubtype: string | null = null;

  if (item.type === "investment") {
    const rawText = item.remark ?? item.rawText ?? "";
    const fundCodeMatch = rawText.match(/\b(\d{6})\b/);
    fundCode = fundCodeMatch ? fundCodeMatch[1] : null;
    const isRedeem = /赎回|卖出/.test(rawText);
    fundSubtype = isRedeem ? "redeem" : "buy";
  }

  const transaction = await tx.txRecord.create({
    data: {
      type: item.type as any,
      date,
      postedAt,
      amount,
      accountId: accountId ?? (await ensureAccountId(ctx, tx, "未指定账户")) ?? "",
      accountName: storedAccountName,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      note: item.remark ?? item.rawText,
      toNote: null,
      counterpartyInstitutionId,
      counterpartyInstitutionName,
      statementMonth,
      householdId: ctx.householdId,
      currency: normalizeCurrency(accountMeta?.currency),
    },
  });

  await attachTags(ctx, tx, transaction.id, item.tags);

  return transaction;
}

function fallbackParse(text: string): ParsedItem[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  return lines.map((rawText) => {
    const dateMatch = rawText.match(/\b(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})\b/);
    const date = dateMatch
      ? `${dateMatch[1]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[3].padStart(2, "0")}`
      : undefined;

    const nums = rawText.match(/(\d+(?:\.\d+)?)/g) ?? [];
    const amount = nums.length ? Number(nums[nums.length - 1]) : 0;

    const isCreditCardRepayment = /信用卡还款|信用卡.*还款|还款.*信用卡/i.test(rawText);
    const isTransfer = isCreditCardRepayment || /转账|转入|转出|转给|转到|转\s*给|转\s*到|从.*到|从.*给/.test(rawText);
    if (isTransfer) {
      const fromMatch = rawText.match(/从([^，,\s]+?)(?:转|到|给)/);
      const toMatch = rawText.match(/(?:到|给)([^，,\s]+?)(?=\s+\d|[，,\s]|$)/);
      return {
        rawText,
        type: "transfer",
        businessType: isCreditCardRepayment ? CREDIT_CARD_REPAYMENT_BUSINESS_TYPE : null,
        date,
        amount,
        fromAccount: fromMatch?.[1],
        toAccount: toMatch?.[1],
        remark: rawText,
      };
    }

    const isIncome = /收入|工资|报销|退款|返现|返利/.test(rawText);
    return {
      rawText,
      type: isIncome ? "income" : "expense",
      date,
      amount,
      remark: rawText,
    };
  });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}


function lookupAccount(ctx: ImportContext, rawName?: string, defaultAccountName?: string): string | null {
  const name = normalizeAccountCell(rawName);
  if (!name) return null;
  if (name === "未指定账户" || name === "空白") return null;
  const directId = parseImportAccountId(name);
  if (directId && ctx.accountMetaById.has(directId)) return directId;
  const resolved = resolveImportAccountIdFromList(name, ctx.accountLookupRows);
  if (resolved) return resolved;
  // Fallback: try resolveAccountId (will load from DB once, then cache)
  return null; // pre-resolution already handled unmatched names
}

function getOrCreateDefaultAccount(ctx: ImportContext, defaultAccountName?: string): string | null {
  return lookupAccount(ctx, defaultAccountName || "未指定账户");
}

export async function POST(req: Request) {
  const internalImport = await isInternalImportRequest(req).catch(() => false);
  if (!internalImport && !requireApiKey(req).ok) {
    return NextResponse.json(
      { ok: false, code: "UNAUTHORIZED", error: "未授权" },
      { status: 401, headers: corsHeaders() },
    );
  }

  const body = (await req.json().catch(() => null)) as null | {
    text?: string;
    items?: unknown;
    import?: boolean;
    defaultAccountName?: string;
    traceId?: string;
  };

  const text = (body?.text ?? "").trim();
  const shouldImport = body?.import !== false;
  const defaultAccountName = body?.defaultAccountName;
  const traceId = String(body?.traceId ?? "").trim().slice(0, 80);
  const bodyItems = Array.isArray(body?.items)
    ? z.array(ParsedItemSchema).safeParse(body.items)
    : null;

  if (!text && !bodyItems?.success) {
    return NextResponse.json(
      { ok: false, code: "MISSING_TEXT_OR_ITEMS", error: "缺少 text 或 items" },
      { status: 400, headers: corsHeaders() },
    );
  }

  const model = localProvider(defaultModel);

  const system = [
    "你是家庭记账助手，负责把一段账单文本解析为结构化数据。",
    "输入可能是一整期账单的多行文本，每行可能是一条记录，也可能是一条记录的片段。",
    "输出必须严格符合给定的 JSON Schema。",
    "amount 始终为正数（绝对值）。",
    "type=transfer 时，必须给出 fromAccount 和 toAccount（尽量从文本推断）。",
    "信用卡还款输出 type=transfer、businessType=credit_card_repayment、category=信用卡还款，并把付款账户放在 fromAccount、信用卡放在 toAccount。",
    "type=investment 时，如果能识别资金从哪个账户流出、流入到哪个投资账户，尽量给出 fromAccount 和 toAccount。",
    "type=expense|income 时，尽量给出 account。",
    "date 尽量输出 YYYY-MM-DD；如果文本没有日期，可以省略。",
    "rawText 必须保留原始行文本。",
  ].join("\n");

  let items: ParsedItem[];
  let trace: string[] = [];

  if (bodyItems?.success) {
    items = bodyItems.data;
    trace = [
      "使用客户端预览数据导入",
      `解析条数：${items.length}`,
    ];
  } else {
    try {
      const { object } = await generateObject({
        model,
        schema: z.object({ items: z.array(ParsedItemSchema) }),
        system,
        prompt: text,
      });
      items = object.items;
      trace = [
        `输入字符数：${text.length}`,
        `解析条数：${items.length}`,
        `模型：${defaultModel}`,
      ];
    } catch {
      items = fallbackParse(text);
      trace = [
        `输入字符数：${text.length}`,
        `解析条数：${items.length}`,
        "模型调用失败，已使用规则解析",
      ];
    }
  }

  if (!shouldImport) {
    return NextResponse.json(
      { ok: true, items, imported: false, trace },
      { headers: corsHeaders() },
    );
  }

  startImportProgress(traceId, items.length);
  let importLockHouseholdId: string | null = null;
  let importLockAcquired = false;
  let importBatchId: string | null = null;

  try {
    updateImportProgress(traceId, {
      phase: "preparing",
      total: items.length,
      processed: 0,
      created: 0,
      currentRow: null,
    });
    const ctx = await buildImportContext();
    importLockHouseholdId = ctx.householdId;
    const importRun = beginImportRun(ctx.householdId, traceId, items.length);
    if (!importRun.ok) {
      const error = `已有一批导入正在写入（${importRun.active.itemCount} 条，traceId: ${importRun.active.traceId}），请等待完成后再导入`;
      const failureProgress = {
        ok: false,
        code: "IMPORT_BUSY",
        total: items.length,
        processed: 0,
        created: 0,
        currentRow: null,
        error,
        failedRow: null,
      };
      finishImportProgress(traceId, failureProgress);
      if (traceId) {
        await writeImportDebugLog({
          traceId,
          event: "server_import_rejected_busy",
          householdId: ctx.householdId,
          details: {
            itemCount: items.length,
            activeTraceId: importRun.active.traceId,
            activeItemCount: importRun.active.itemCount,
          },
        });
      }
      return NextResponse.json(
        { ok: false, code: "IMPORT_BUSY", error, trace },
        { status: 409, headers: corsHeaders() },
      );
    }
    importLockAcquired = true;
    const importBatch = await prisma.importBatch.create({
      data: {
        source: "excel_import",
        note: traceId ? `batch-import:${traceId}` : "batch-import",
        householdId: ctx.householdId,
      },
    });
    importBatchId = importBatch.id;
    const transactionTimeoutMs = getImportTransactionTimeoutMs(items.length);
    if (traceId) {
      await writeImportDebugLog({
        traceId,
        event: "server_import_started",
        householdId: ctx.householdId,
        details: {
          itemCount: items.length,
          source: bodyItems?.success ? "client_preview" : "text_parse",
          transactionTimeoutMs,
        },
      });
    }
// Pre-build all rows in memory, then batch-insert via createMany

    // Pre-resolve all unmatched debt account names BEFORE the loop
    // so the loop itself only does in-memory lookups
    const unmatchedNames = new Set<string>();
    for (const item of items) {
      const names: string[] = [];
      if (item.type === "transfer" || item.type === "investment") {
        if (item.fromAccount) names.push(normalizeAccountCell(item.fromAccount));
        if (item.toAccount) names.push(normalizeAccountCell(item.toAccount));
      } else {
        if (item.account) names.push(normalizeAccountCell(item.account));
      }
      for (const n of names) {
        if (!n || parseImportAccountId(n)) continue;
        if (resolveImportAccountIdFromList(n, ctx.accountLookupRows)) continue;
        unmatchedNames.add(n);
      }
    }
    if (unmatchedNames.size > 0) {
      // Batch-resolve debt accounts
      const counterpartyNames = [...unmatchedNames].map(name => {
        const m = name.match(/^(.+?)的往来款$/);
        return m?.[1]?.trim() || name.trim();
      }).filter(Boolean);
      const allCps = counterpartyNames.length > 0 ? await prisma.counterparty.findMany({
        where: { householdId: ctx.householdId, OR: [{ name: { in: counterpartyNames } }, { shortName: { in: counterpartyNames } }] },
        select: { id: true, name: true, shortName: true },
      }) : [];
      const cpByName = new Map<string, string>();
      for (const cp of allCps) { if (cp.name) cpByName.set(cp.name, cp.id); if (cp.shortName) cpByName.set(cp.shortName, cp.id); }
      // Create missing counterparties
      for (const cn of counterpartyNames) {
        if (!cpByName.has(cn)) {
          try { const nc = await prisma.counterparty.create({ data: { name: cn, householdId: ctx.householdId } }); cpByName.set(cn, nc.id); } catch {}
        }
      }
      // Find or create loan accounts
      const cpIds = [...new Set(cpByName.values())];
      const existingLoans = cpIds.length > 0 ? await prisma.account.findMany({
        where: { householdId: ctx.householdId, counterpartyId: { in: cpIds }, kind: { in: ["settlement", "loan"] }, isPlaceholder: { not: true } },
        select: { id: true, name: true, counterpartyId: true, billingDay: true, currency: true },
      }) : [];
      const loanByCpId = new Map<string, string>();
      for (const l of existingLoans) { if (l.counterpartyId && !loanByCpId.has(l.counterpartyId)) loanByCpId.set(l.counterpartyId, l.id); }
      const defaultGroup = await ensureDefaultAccountGroupId(ctx, prisma);
      for (const name of unmatchedNames) {
        const cn = (name.match(/^(.+?)的往来款$/) || [])[1] || name.trim();
        const cpId = cpByName.get(cn);
        if (!cpId) continue;
        let loanId = loanByCpId.get(cpId);
        if (!loanId && defaultGroup) {
          try {
            const nl = await prisma.account.create({ data: { name, kind: "settlement", debtDirection: "receivable", currency: "CNY", groupId: defaultGroup, counterpartyId: cpId, householdId: ctx.householdId, isActive: true } });
            loanId = nl.id; loanByCpId.set(cpId, loanId);
          } catch {}
        }
        if (loanId) {
          ctx.accountMetaById.set(loanId, { name, kind: "settlement", billingDay: null, currency: "CNY" });
          ctx.accountLookupRows.push({ id: loanId, name, kind: "settlement", billingDay: null, currency: "CNY", numberMasked: null, Institution: null, AccountGroup: null, AccountAlias: null });
        }
      }
    }
    // Now the loop can resolve all accounts purely from ctx.accountLookupRows
    
    // Build flat data from pre-resolved IDs (0 DB queries per row)
    const created: Array<{ accountId: string; toAccountId: string | null }> = [];
    const BATCH = 300;
    updateImportProgress(traceId, { phase: "writing", processed: 0, created: 0, currentRow: null });
    for (let batchStart = 0; batchStart < items.length; batchStart += BATCH) {
      if (isImportCancelled(traceId)) {
        if (importBatchId && created.length > 0) {
          const importedRecords = await prisma.txRecord.findMany({ where: { importBatchId, householdId: ctx.householdId, deletedAt: null } });
          const undo = await prepareEntryUndo(prisma, ctx.householdId, importedRecords.map((record) => record.id));
          await saveEntryUndo(prisma, await getHouseholdScope(), undo, "batch_create", "Batch import");
        }
        finishImportProgress(traceId, { ok: true, processed: created.length, created: created.length, error: "已取消" });
        finishImportRun(ctx.householdId, traceId);
        return NextResponse.json({ ok: true, imported: true, createdCount: created.length, cancelled: true, importBatchId, message: `已取消导入（已导入 ${created.length} 条记录）`, trace }, { headers: corsHeaders() });
      }
      const batchEnd = Math.min(batchStart + BATCH, items.length);
      const batchData: any[] = [];
      for (let i = batchStart; i < batchEnd; i++) {
        const item = items[i];
        const date = parseDate(item.date);
        const counterpartyInstitutionId = resolveInstitutionId(ctx, item.institution);
        const counterpartyInstitutionName = counterpartyInstitutionId ? String(item.institution ?? "").trim() || null : null;
        const note = item.remark ?? item.rawText ?? "";

        if (item.type === "transfer" || (item.type === "investment" && item.fromAccount && item.toAccount)) {
          const fromAccountName = normalizeAccountCell(item.fromAccount);
          const toAccountName = normalizeAccountCell(item.toAccount);
          if (item.type === "transfer" && (!fromAccountName || !toAccountName)) {
            throw new ImportItemError(buildImportFailureDetail(i, item, new Error("转账缺少转出/转入账户")));
          }
          const fromId = lookupAccount(ctx, item.fromAccount, defaultAccountName);
          const toId = lookupAccount(ctx, item.toAccount, defaultAccountName);
          if (item.type === "transfer" && (!fromId || !toId)) {
            throw new ImportItemError(buildImportFailureDetail(i, item, new Error("转账账户未匹配，不能导入")));
          }
          const sourceId = fromId || (item.type === "investment" && toId ? getOrCreateDefaultAccount(ctx, defaultAccountName) : "");
          const fromMeta = ctx.accountMetaById.get(sourceId ?? "") ?? null;
          const toMeta = ctx.accountMetaById.get(toId ?? "") ?? null;
          const fromName = fromId && fromMeta ? fromMeta.name : normalizeAccountCell(item.fromAccount);
          const toName = toId && toMeta ? toMeta.name : normalizeAccountCell(item.toAccount);
          const stmtMonth = sourceId ? statementMonthForAccountMeta(ctx, sourceId, date) : null;
          const currency = normalizeCurrency(fromMeta?.currency ?? toMeta?.currency);
          batchData.push({
            type: "transfer", amount: -Math.abs(item.amount), date, postedAt: null,
            accountId: sourceId || "", accountName: fromName || "未指定账户",
            toAccountId: toId || "", toAccountName: toName || null, categoryId: null, categoryName: null,
            note, toNote: String(item.secondRemark ?? "").trim() || note || null,
            statementMonth: stmtMonth, counterpartyInstitutionId, counterpartyInstitutionName,
            currency, householdId: ctx.householdId, importBatchId, source: TRANSACTION_SOURCE_MANUAL, entryOrigin: ENTRY_ORIGIN_EXCEL_IMPORT, fundCode: null, fundProductType: null, fundSubtype: null,
          });
          created.push({ accountId: sourceId || "", toAccountId: toId });
        } else {
          const accountName = pickAccountName(item.account, defaultAccountName);
          const accountId = lookupAccount(ctx, accountName, defaultAccountName);
          if (!accountId) {
            throw new ImportItemError(buildImportFailureDetail(i, item, new Error("Account is required and must match an existing account")));
          }
          const meta = ctx.accountMetaById.get(accountId ?? "") ?? null;
          const storedName = accountId && meta ? meta.name : accountName;
          const postedAt = item.type === "expense" || item.type === "income" ? (parseOptionalDateTime(item.postedAt) ?? date) : null;
          const cat = resolveCategorySnapshotFromContext(ctx, { categoryName: item.category, type: item.type === "income" ? "income" : item.type === "expense" ? "expense" : null });
          const stmtMonth = accountId ? statementMonthForAccountMeta(ctx, accountId, date, item.type, postedAt) : null;
          batchData.push({
            type: item.type, amount: accountSideAmountForImportItem(item), date, postedAt,
            accountId: accountId || "", accountName: storedName || "未识别账户",
            toAccountId: null, toAccountName: null, categoryId: cat?.id ?? null, categoryName: cat?.name ?? null,
            note, toNote: null,
            statementMonth: stmtMonth, counterpartyInstitutionId, counterpartyInstitutionName,
            currency: normalizeCurrency(meta?.currency), householdId: ctx.householdId, importBatchId, source: TRANSACTION_SOURCE_MANUAL, entryOrigin: ENTRY_ORIGIN_EXCEL_IMPORT,
            fundCode: null, fundProductType: null, fundSubtype: null,
          });
          created.push({ accountId: accountId || "", toAccountId: null });
        }
      }
      await prisma.txRecord.createMany({ data: batchData });
      let learnedCategoryRuleCount = 0;
      for (let i = batchStart; i < batchEnd; i++) {
        if (await learnUserEditedImportCategory(ctx, items[i])) learnedCategoryRuleCount += 1;
        await learnUserEditedImportInstitution(ctx, items[i]);
      }
      if (traceId && learnedCategoryRuleCount > 0) {
        await writeImportDebugLog({
          traceId,
          event: "category_rules_learned",
          householdId: ctx.householdId,
          details: {
            batchStart,
            batchEnd,
            learnedCategoryRuleCount,
          },
        });
      }
      updateImportProgress(traceId, { phase: "writing", processed: batchEnd, created: created.length, currentRow: batchEnd });
    }

    const accountIdsToRecalc = new Set<string>();
    for (const row of created) {
      if (row.accountId) accountIdsToRecalc.add(row.accountId);
      if (row.toAccountId) accountIdsToRecalc.add(row.toAccountId);
    }
    let recalculatedAccountCount = 0;
    const recalcFailedAccountIds: string[] = [];
    updateImportProgress(traceId, {
      phase: "recalculating",
      processed: created.length,
      created: created.length,
      currentRow: null,
    });
    for (const accountId of accountIdsToRecalc) {
      try {
        await recalcAndSaveAccountBalance(accountId);
        recalculatedAccountCount += 1;
      } catch {
        recalcFailedAccountIds.push(accountId);
      }
    }
    if (importBatchId && created.length > 0) {
      const importedRecords = await prisma.txRecord.findMany({
        where: { importBatchId, householdId: ctx.householdId, deletedAt: null },
      });
      const undo = await prepareEntryUndo(prisma, ctx.householdId, importedRecords.map((record) => record.id));
      const undoContext = await getHouseholdScope();
      await saveEntryUndo(prisma, undoContext, undo, "batch_create", "Batch import");
    }
    if (traceId) {
      await writeImportDebugLog({
        traceId,
        event: "server_import_succeeded",
        householdId: ctx.householdId,
        details: {
          itemCount: items.length,
          createdCount: created.length,
          recalculatedAccountCount,
          recalcFailedAccountCount: recalcFailedAccountIds.length,
        },
      });
    }
    finishImportProgress(traceId, {
      ok: true,
      total: items.length,
      processed: items.length,
      created: created.length,
      currentRow: null,
      error: null,
      failedRow: null,
    });

    // Client-side handles page refresh
    return NextResponse.json(
      {
        ok: true,
        items,
        imported: true,
        createdCount: created.length,
        importBatchId,
        ids: created.map((t) => t.accountId),
        recalculatedAccountCount,
        recalcFailedAccountCount: recalcFailedAccountIds.length,
        message: recalcFailedAccountIds.length > 0
          ? `已导入 ${created.length} 条记录，${recalcFailedAccountIds.length} 个账户余额稍后刷新`
          : `已导入 ${created.length} 条记录`,
        trace,
      },
      { headers: corsHeaders() },
    );
  } catch (e) {
    const error = e instanceof Error ? e.message : "导入失败";
    const failureDetail = e instanceof ImportItemError ? e.detail : null;
    const failureProgress = {
      ok: false,
      code: "IMPORT_FAILED",
      total: items.length,
      processed: failureDetail?.rowIndex ?? 0,
      created: 0,
      currentRow: failureDetail ? failureDetail.rowIndex + 1 : null,
      error,
      failedRow: failureDetail ? failureDetail.rowIndex + 1 : null,
    };
    finishImportProgress(traceId, failureProgress);
    if (traceId) {
      const scope = await getHouseholdScope().catch(() => null);
      if (scope) {
        await writeImportDebugLog({
          traceId,
          event: "server_import_failed",
          householdId: scope.householdId,
          userId: scope.user?.id ?? null,
          details: {
            itemCount: items.length,
            errorType: e instanceof Error ? e.name : "unknown",
            errorMessage: compactImportText(error, 140) ?? null,
            failedRow: failureDetail ? failureDetail.rowIndex + 1 : null,
          },
        });
      }
    }
    return NextResponse.json(
      {
        ok: false,
        code: "IMPORT_FAILED",
        error,
        failedRow: failureDetail,
        trace: failureDetail
          ? failureDetail.reasonKind === "transaction_timeout"
            ? [
                "失败类型：数据库事务超时",
                `执行位置：第 ${failureDetail.rowIndex + 1} 行附近`,
                "说明：预览校验并未发现这行数据本身错误，是服务端写库时间超过事务上限，整批已回滚。",
                `原因：${failureDetail.error}`,
              ]
            : [
                `失败行：第 ${failureDetail.rowIndex + 1} 行`,
                `类型：${failureDetail.type}`,
                `账户：${failureDetail.account ?? "-"}`,
                `转出：${failureDetail.fromAccount ?? "-"}`,
                `转入：${failureDetail.toAccount ?? "-"}`,
                `分类：${failureDetail.category ?? "-"}`,
                `原因：${failureDetail.error}`,
              ]
          : trace,
      },
      { status: 500, headers: corsHeaders() },
    );
  } finally {
    if (importLockAcquired && importLockHouseholdId) {
      finishImportRun(importLockHouseholdId, traceId);
    }
  }
}
