import { Prisma } from "@prisma/client";
import {
  extractStatementLearningKeyword,
  normalizeStatementRecognitionText,
  type StatementHistoricalCategorySample,
} from "@/lib/statement/import-normalization";
import {
  ensureDefaultStatementRecognitionRules,
  loadStatementRecognitionRuleSamples,
  upsertStatementCategoryRecognitionRuleFromUserEdit,
} from "@/lib/statement/recognition-rules";

type RawSqlClient = {
  $executeRaw: (query: Prisma.Sql) => Promise<number>;
  $queryRaw: <T = unknown>(query: Prisma.Sql) => Promise<T>;
};

type StatementCategoryRuleInput = {
  householdId?: string | null;
  type?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  counterpartyInstitutionName?: string | null;
  paymentChannelName?: string | null;
  source?: string | null;
  note?: string | null;
};

export type StatementCategoryLearningRecord = {
  householdId?: string | null;
  type?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
  counterpartyInstitutionName?: string | null;
  paymentChannelName?: string | null;
  note?: string | null;
};

const LEARNABLE_TYPES = new Set(["income", "expense"]);
const MAX_TEXT_LENGTH = 500;

function cleanText(value?: string | null) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text || /^[-—–]+$/.test(text) || text === "?") return "";
  return text.slice(0, MAX_TEXT_LENGTH);
}

function buildRuleMatchText(input: Pick<StatementCategoryRuleInput, "note" | "counterpartyInstitutionName">) {
  return (
    extractStatementLearningKeyword(input.note) ||
    extractStatementLearningKeyword(input.counterpartyInstitutionName) ||
    ""
  );
}

export function normalizeStatementCategoryRuleText(input: Pick<StatementCategoryRuleInput, "note" | "counterpartyInstitutionName">) {
  return normalizeStatementRecognitionText(buildRuleMatchText(input));
}

export async function upsertStatementCategoryRuleFromTx(client: RawSqlClient, input: StatementCategoryRuleInput) {
  const householdId = cleanText(input.householdId);
  const type = cleanText(input.type);
  const categoryId = cleanText(input.categoryId);
  const categoryName = cleanText(input.categoryName);
  const keyword = buildRuleMatchText(input);
  if (!householdId || !LEARNABLE_TYPES.has(type) || !categoryId || !categoryName || !keyword) return false;

  return upsertStatementCategoryRecognitionRuleFromUserEdit(client, {
    householdId,
    type,
    categoryId,
    categoryName,
    keyword,
    source: cleanText(input.source) || "user_category_edit",
  });
}

export async function upsertStatementCategoryRuleFromSavedRecord(
  client: RawSqlClient,
  record: StatementCategoryLearningRecord,
  source = "user_category_edit",
) {
  return upsertStatementCategoryRuleFromTx(client, {
    householdId: record.householdId,
    type: record.type,
    categoryId: record.categoryId,
    categoryName: record.categoryName,
    counterpartyInstitutionName: record.counterpartyInstitutionName,
    paymentChannelName: record.paymentChannelName,
    note: record.note,
    source,
  });
}

export async function ensureDefaultStatementCategoryRules(client: RawSqlClient, householdId: string) {
  return ensureDefaultStatementRecognitionRules(client, householdId);
}

export async function loadStatementCategoryRuleSamples(
  client: RawSqlClient,
  householdId: string,
  take = 2000,
): Promise<StatementHistoricalCategorySample[]> {
  const samples = await loadStatementRecognitionRuleSamples(client, householdId, take);
  return samples.filter((sample) => sample.targetType === "category");
}
