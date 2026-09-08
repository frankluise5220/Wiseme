import { inferKnownStatementMerchant } from "@/lib/statement/merchant-inference";

export type StatementImportItemLike = {
  rawText?: string | null;
  type: string;
  date?: string | null;
  amount?: number | null;
  inflow?: number | null;
  outflow?: number | null;
  account?: string | null;
  category?: string | null;
  counterparty?: string | null;
  institution?: string | null;
  remark?: string | null;
};

export type StatementCategoryOption = {
  name: string;
  type: string;
};

export type StatementHistoricalCategorySample = {
  targetType?: "category" | "institution" | "field" | null;
  fieldName?: string | null;
  transactionType?: string | null;
  type: string;
  categoryName: string;
  institutionName?: string | null;
  counterpartyInstitutionName: string | null;
  paymentChannelName: string | null;
  matchText?: string | null;
  normalizedText?: string | null;
  weight?: number | null;
  priority?: number | null;
  source?: "learned_rule" | "system_default" | "system_keyword" | "history";
  note: string | null;
};

function isPlaceholderText(value?: string | null) {
  const text = String(value ?? "").trim();
  return !text || /^[-—–]+$/.test(text) || text === "?";
}

function cleanOptionalText(value?: string | null) {
  const text = String(value ?? "").trim();
  return isPlaceholderText(text) ? undefined : text;
}

function positiveAmount(value: unknown) {
  const amount = Math.abs(Number(value ?? 0));
  return Number.isFinite(amount) ? amount : 0;
}

const LEARNING_KEYWORD_MAX_LENGTH = 120;
const LEARNING_PAYMENT_PREFIX_PATTERN =
  /^(?:支付宝付款|支付宝支付|支付宝|微信支付|微信|财付通|云闪付|银联商务|银联|京东支付|京东|拼多多支付|拼多多|美团支付|抖音支付|翼支付|网银在线|快捷支付|Apple Pay|APPLE PAY)[\s\-—–_:：/\\|]+/i;
const LEARNING_COMPANY_SUFFIXES = ["有限责任公司", "股份有限公司", "集团有限公司", "有限公司"];
const LEARNING_NOISE_TERMS = [
  "\u7ecf\u8425\u7801\u4ea4\u6613",
  "\u7ecf\u8425\u7801",
  "\u4ea4\u6613",
  "\u6d88\u8d39",
  "\u4ed8\u6b3e",
  "\u652f\u4ed8",
  "\u6536\u6b3e",
  "\u5165\u8d26",
  "\u8f6c\u8d26",
  "\u6263\u6b3e",
  "\u9000\u6b3e",
  "\u9000\u8d27",
  "\u51b2\u6b63",
  "\u64a4\u9500",
  "\u8d26\u5355",
  "\u660e\u7ec6",
  "\u5907\u6ce8",
  "\u652f\u4ed8\u5b9d",
  "\u5fae\u4fe1\u652f\u4ed8",
  "\u5fae\u4fe1",
  "\u8d22\u4ed8\u901a",
  "\u62fc\u591a\u591a",
  "\u4e91\u95ea\u4ed8",
  "\u94f6\u8054",
  "\u4eac\u4e1c",
  "\u7f8e\u56e2",
  "\u6296\u97f3\u652f\u4ed8",
  "\u7ffc\u652f\u4ed8",
  "\u7f51\u94f6\u5728\u7ebf",
  "Apple Pay",
  "APPLE PAY",
] as const;
const LEARNING_GENERIC_PREFIXES = new Set([
  "\u8d23\u4efb",
  "\u79d1\u6280",
  "\u4fe1\u606f",
  "\u7f51\u7edc",
  "\u5546\u8d38",
  "\u8d38\u6613",
  "\u5b9e\u4e1a",
  "\u96c6\u56e2",
  "\u7535\u5b50",
  "\u7269\u6d41",
  "\u670d\u52a1",
  "\u6295\u8d44",
  "\u53d1\u5c55",
  "\u91d1\u878d",
  "\u6587\u5316",
  "\u4f20\u5a92",
  "\u54a8\u8be2",
  "\u56fd\u9645",
]);
const LEARNING_TRAILING_NOISE_PATTERNS = [
  /可用额度[\s\S]*$/i,
  /可用余额[\s\S]*$/i,
  /账户余额[\s\S]*$/i,
  /当前余额[\s\S]*$/i,
  /交易后余额[\s\S]*$/i,
  /账单金额[\s\S]*$/i,
  /积分[\s\S]*$/i,
];
const LEARNING_SEGMENT_SEPARATOR_PATTERN = /[\r\n/\\|,\uff0c;\uff1b]+/;
const LEARNING_EMAIL_PATTERN = /\b[\w.+-]+\s*@\s*[\w.-]+(?:\s*\.\s*[A-Za-z]{2,})+\b/i;
const LEARNING_EXTERNAL_ID_PATTERN = /\b[A-Z]{1,8}\d{6,}\b/i;
const LEARNING_SUBJECT_HINT_PATTERN = /\u673a\u52a8\u8f66|\u767b\u8bb0\u8bc1\u4e66|\u8bc1\u4e66|\u6267\u7167|\u8bb8\u53ef\u8bc1|\u5de5\u672c\u8d39|\u8bfe\u7a0b|\u5b66\u8d39|\u4fdd\u9669|\u9152\u5e97|\u4f4f\u5bbf|\u623f\u578b|\u673a\u7968|\u8f66\u7968|\u505c\u8f66|\u5145\u7535/;
const LEARNING_ORGANIZATION_NOISE_PATTERN = /\u516c\u5b89|\u8d22\u653f|\u7a0e\u52a1|\u653f\u5e9c|\u59d4\u5458\u4f1a|\u7ba1\u7406\u603b\u961f|\u7ba1\u7406\u5c40|\u670d\u52a1\u4e2d\u5fc3/;
const LEARNING_GENERIC_SEGMENT_PATTERN = /^(?:\u6536\u94b1\u7801|\u626b\u4e8c\u7ef4\u7801|\u5feb\u6377|\u5e73\u53f0\u5546\u6237|\u5546\u6237|\u5e97)$/;

function cleanupMerchantName(value: string) {
  return String(value ?? "")
    .replace(/^[-—\s]+/, "")
    .replace(/[（(]\s*入账日(?:期)?\s*\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}\s*[)）]/g, "")
    .replace(/[（(]\s*特约\s*[)）]/g, "")
    .replace(/^(快捷|平台商户|商户)+[-—\s]*/, "")
    .replace(/^支付[-—\s]+/, "")
    .trim();
}

export function normalizeStatementRecognitionText(value?: string | null) {
  return cleanupMerchantName(String(value ?? ""))
    .replace(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?/g, " ")
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, " ")
    .replace(/付款尾号[:：]?\s*\d{2,8}/g, " ")
    .replace(/尾号[:：]?\s*\d{2,8}/g, " ")
    .replace(/\b\d{8}\b/g, " ")
    .replace(/[￥¥]?\d+(?:,\d{3})*(?:\.\d+)?/g, " ")
    .replace(/人民币|支付宝|微信支付|财付通|拼多多支付|京东支付|云闪付|银联|入账|交易|消费|付款|支付|退款|退货|退回|冲正|撤销/g, " ")
    .replace(/[()（）【】[\]{}《》<>、,，.;；:：/\\|~!！?？"'“”‘’+\-_=—\s]+/g, " ")
    .trim();
}

export function normalizeStatementKeywordText(value?: string | null) {
  return cleanupMerchantName(String(value ?? ""))
    .replace(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?/g, " ")
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, " ")
    .replace(/付款尾号[:：]?\s*\d{2,8}/g, " ")
    .replace(/尾号[:：]?\s*\d{2,8}/g, " ")
    .replace(/\b\d{8}\b/g, " ")
    .replace(/[￥¥]?\d+(?:,\d{3})*(?:\.\d+)?/g, " ")
    .replace(/[()（）【】[\]{}《》<>、,，.;；:：/\\|~!！?？"'“”‘’+\-_=—\s]+/g, " ")
    .trim()
    .toLowerCase();
}

function stripLearningPaymentPrefix(value: string) {
  let text = value.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = text.replace(LEARNING_PAYMENT_PREFIX_PATTERN, "").trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

function truncateBeforeCompanySuffix(value: string) {
  const cutIndexes = LEARNING_COMPANY_SUFFIXES
    .map((suffix) => {
      const index = value.indexOf(suffix);
      return index >= 0 ? index : -1;
    })
    .filter((index) => index >= 2);
  if (cutIndexes.length === 0) return value;
  return value.slice(0, Math.min(...cutIndexes));
}

function stripLearningTrailingNoise(value: string) {
  let text = value;
  for (const pattern of LEARNING_TRAILING_NOISE_PATTERNS) {
    text = text.replace(pattern, " ");
  }
  return text;
}

function stripLearningNoiseTerms(value: string) {
  let text = value;
  for (const term of LEARNING_NOISE_TERMS) {
    text = text.replace(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), " ");
  }
  return tidyLearningKeyword(text);
}

function isGenericLearningKeyword(value: string) {
  const text = tidyLearningKeyword(value);
  if (!text) return true;
  if (LEARNING_NOISE_TERMS.includes(text as (typeof LEARNING_NOISE_TERMS)[number])) return true;
  if (LEARNING_COMPANY_SUFFIXES.includes(text)) return true;
  if (LEARNING_GENERIC_PREFIXES.has(text)) return true;
  return false;
}

function tidyLearningKeyword(value: string) {
  return value
    .replace(new RegExp(LEARNING_EMAIL_PATTERN.source, "gi"), " ")
    .replace(new RegExp(LEARNING_EXTERNAL_ID_PATTERN.source, "gi"), " ")
    .replace(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?/g, " ")
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, " ")
    .replace(/付款尾号[:：]?\s*\d{2,8}/g, " ")
    .replace(/尾号[:：]?\s*\d{2,8}/g, " ")
    .replace(/\*{2,}\d*/g, " ")
    .replace(/\b\d{8,}\b/g, " ")
    .replace(/[￥¥]\s*\d+(?:,\d{3})*(?:\.\d+)?/g, " ")
    .replace(/\b(?:CNY|RMB|USD|JPY|HKD|EUR)\b/gi, " ")
    .replace(/^[\s\-—–_:：/\\|]+|[\s\-—–_:：/\\|]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanLearningCandidate(value: string) {
  let text = cleanupMerchantName(value).replace(/\s+/g, " ").trim();
  text = stripLearningPaymentPrefix(text);
  text = stripLearningTrailingNoise(text);
  text = tidyLearningKeyword(text);
  text = truncateBeforeCompanySuffix(text);
  text = text.replace(/\u5de5\u672c\u8d39(?:\u7b49)?\s*$/g, " ");
  text = stripLearningNoiseTerms(text);
  return tidyLearningKeyword(text);
}

function learningCandidateScore(raw: string, cleaned: string, index: number) {
  if (!cleaned || isGenericLearningKeyword(cleaned) || LEARNING_GENERIC_SEGMENT_PATTERN.test(cleaned)) {
    return Number.NEGATIVE_INFINITY;
  }
  const searchable = normalizeStatementKeywordText(cleaned);
  if (!searchable || /^\d+$/.test(searchable)) return Number.NEGATIVE_INFINITY;

  let score = Math.min(30, searchable.length * 2) - index;
  if (LEARNING_SUBJECT_HINT_PATTERN.test(raw) || LEARNING_SUBJECT_HINT_PATTERN.test(cleaned)) score += 45;
  if (LEARNING_ORGANIZATION_NOISE_PATTERN.test(cleaned) && !LEARNING_SUBJECT_HINT_PATTERN.test(cleaned)) score -= 25;
  if (LEARNING_EMAIL_PATTERN.test(raw)) score -= 40;
  if (LEARNING_EXTERNAL_ID_PATTERN.test(raw)) score -= 35;
  if (searchable.length > 48) score -= 15;
  if (/[A-Za-z]{3,}/.test(cleaned)) score += 8;
  return score;
}

export function extractStatementLearningKeyword(value?: string | null) {
  const source = cleanupMerchantName(String(value ?? ""))
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (isPlaceholderText(source)) return "";

  const candidates = source
    .split(LEARNING_SEGMENT_SEPARATOR_PATTERN)
    .map((raw, index) => {
      const cleaned = cleanLearningCandidate(raw);
      return { cleaned, score: learningCandidateScore(raw, cleaned, index) };
    })
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((a, b) => b.score - a.score);
  const text = candidates[0]?.cleaned || cleanLearningCandidate(source);

  if (isGenericLearningKeyword(text)) return "";
  const normalizedForMatch = normalizeStatementRecognitionText(text);
  const normalizedKeyword = normalizeStatementKeywordText(text);
  if (!text || (normalizedForMatch.length < 2 && normalizedKeyword.length < 2)) return "";
  return text.slice(0, LEARNING_KEYWORD_MAX_LENGTH);
}

function recognitionTokens(value?: string | null) {
  const normalized = normalizeStatementRecognitionText(value);
  if (!normalized) return [];
  const tokens = new Set<string>();
  const parts = normalized.split(/\s+/).map((part) => part.trim()).filter(Boolean);
  for (const part of parts.length > 0 ? parts : [normalized]) {
    if (part.length >= 2 && !/^\d+$/.test(part)) tokens.add(part);
    if (/[\u4e00-\u9fa5]/.test(part) && part.length >= 4) {
      for (let len = Math.min(8, part.length); len >= 4; len -= 1) {
        for (let i = 0; i <= part.length - len; i += 1) tokens.add(part.slice(i, i + len));
      }
    }
  }
  return [...tokens].filter((token) => token.length >= 2);
}

// Keep this list small. User-confirmed category learning is table-backed via
// statement_recognition_rules(targetType="category").
function fallbackCategoryKeywords(value: string) {
  const text = String(value ?? "").trim();
  if (!text) return [];
  const keywords = new Set<string>([text]);
  if (/水电燃气|电费|水费|燃气|国网|电力/.test(text)) {
    ["水电燃气", "生活缴费", "电费", "水费", "燃气", "国网", "电力"].forEach((item) => keywords.add(item));
  }
  if (/银行费用|信用卡费用|年费|账户管理费|银行卡费|信用卡费|制卡费|手续费/.test(text)) {
    ["银行费用", "信用卡费用", "年费", "账户管理费", "银行卡费", "信用卡费", "制卡费", "手续费"].forEach((item) => keywords.add(item));
  }
  if (/嘟嘟抓饭|抓饭|餐饮|外卖|美食|饭店|餐厅|咖啡|茶饮/.test(text)) {
    ["下馆子", "餐饮", "餐饮美食", "餐饮费", "外卖", "美食", "饭店", "餐厅", "咖啡", "茶饮", "嘟嘟抓饭", "抓饭"].forEach((item) => keywords.add(item));
  }
  if (/食品|生鲜|粮油|零食|食材|水果|蔬菜|肉类|熟食/.test(text)) {
    ["食品", "买菜食材", "餐饮美食", "零食饮料", "生鲜", "粮油", "零食", "食材", "水果", "蔬菜", "肉类", "熟食"].forEach((item) => keywords.add(item));
  }
  if (/快递|寄件|取件|顺丰|圆通|中通|韵达|申通/.test(text)) {
    ["快递物流", "快递", "寄件", "取件", "顺丰", "圆通", "中通", "韵达", "申通"].forEach((item) => keywords.add(item));
  }
  if (/停车场|停车费|停车/.test(text)) {
    ["停车费", "停车场", "停车"].forEach((item) => keywords.add(item));
  }
  if (/火车高铁|火车票|高铁票|中国铁路|铁路网络|12306|铁路/.test(text)) {
    ["火车高铁", "火车票", "高铁票", "中国铁路", "铁路网络", "12306", "铁路"].forEach((item) => keywords.add(item));
  }
  if (/江苏云快充|云快充|新能源.*充电|充电桩|充电站|充电/.test(text)) {
    ["充电", "云快充", "充电桩", "充电站"].forEach((item) => keywords.add(item));
  }
  if (/车品|汽车|汽配|洗车|停车|加油|轮胎|机油/.test(text)) {
    ["车品", "汽车", "汽配", "洗车", "停车", "加油", "轮胎", "机油"].forEach((item) => keywords.add(item));
  }
  if (/数码|电子|电脑|手机|电器|配件|电工/.test(text)) {
    ["数码", "电子", "电脑", "手机", "电器", "配件", "电工"].forEach((item) => keywords.add(item));
  }
  return [...keywords].filter(Boolean);
}

export function enrichKnownStatementMerchantForImport<T extends StatementImportItemLike>(item: T): T {
  const merchant = inferKnownStatementMerchant(item);
  const matchedInstitution = cleanOptionalText(merchant.institution);
  const matchedCounterparty = cleanOptionalText(merchant.counterparty);
  const shouldCarryCategory = item.type === "income" || item.type === "expense";
  const matchedCategory = shouldCarryCategory ? cleanOptionalText(merchant.category) : undefined;
  const existingCategory = shouldCarryCategory ? cleanOptionalText(item.category) : undefined;
  const preferMerchantRule = Boolean(
    matchedInstitution &&
    /拼多多|支付宝|微信|京东|淘宝|天猫|美团|云闪付/.test(matchedInstitution),
  );
  return {
    ...item,
    category: shouldCarryCategory
      ? preferMerchantRule
        ? existingCategory ?? matchedCategory ?? item.category
        : existingCategory || matchedCategory || item.category
      : undefined,
    institution: preferMerchantRule ? matchedInstitution ?? item.institution : cleanOptionalText(item.institution) || matchedInstitution || matchedCounterparty || item.institution,
    counterparty: preferMerchantRule ? matchedCounterparty ?? item.counterparty : cleanOptionalText(item.counterparty) || matchedCounterparty || item.counterparty,
    remark: cleanOptionalText(item.remark) ?? item.remark,
  } as T;
}

function refundPairMatchKey(item: StatementImportItemLike) {
  const structuredSource = [
    cleanOptionalText(item.remark),
    cleanOptionalText(item.counterparty),
    cleanOptionalText(item.institution),
  ].filter(Boolean).join(" ");
  const source = structuredSource || cleanOptionalText(item.rawText) || "";
  const normalized = normalizeStatementRecognitionText(source)
    .replace(/收入|支出|存入|转入|转出/g, "")
    .trim();
  return normalized.length >= 4 ? normalized : "";
}

function shouldKeepAsIncome(item: StatementImportItemLike) {
  const source = [item.remark, item.counterparty, item.institution, item.rawText]
    .map((value) => String(value ?? ""))
    .join(" ");
  return /工资|奖金|红包|利息|分红|报销|还款|转账|转入/i.test(source);
}

export function alignStatementIncomeRefunds<T extends StatementImportItemLike>(items: T[]): T[] {
  const expenseCandidates = items
    .filter((item) => item.type === "expense" && positiveAmount(item.outflow ?? item.amount) > 0)
    .map((item) => ({
      item,
      key: refundPairMatchKey(item),
      amount: positiveAmount(item.outflow ?? item.amount),
    }))
    .filter((candidate) => candidate.key);

  if (expenseCandidates.length === 0) return items;

  return items.map((item) => {
    const inflow = positiveAmount(item.inflow ?? item.amount);
    if (item.type !== "income" && item.type !== "expense") return item;
    if (inflow <= 0 || positiveAmount(item.outflow) > 0) return item;
    if (item.type === "income" && shouldKeepAsIncome(item)) return item;
    const key = refundPairMatchKey(item);
    if (!key) return item;
    const matchedExpense = expenseCandidates.find((candidate) => {
      if (candidate.key !== key) return false;
      if (candidate.item.account && item.account && candidate.item.account !== item.account) return false;
      return inflow <= candidate.amount;
    })?.item;
    if (!matchedExpense) return item;
    if (item.type === "expense") {
      return {
        ...item,
        category: item.category || matchedExpense.category,
        counterparty: item.counterparty || matchedExpense.counterparty,
        institution: item.institution || matchedExpense.institution,
      } as T;
    }
    return {
      ...item,
      type: "expense",
      amount: inflow,
      inflow,
      outflow: undefined,
      category: item.category || matchedExpense.category,
      counterparty: item.counterparty || matchedExpense.counterparty,
      institution: item.institution || matchedExpense.institution,
    } as T;
  });
}

// Whole-row learned templates ("2 支出 132.00 墨斗鱼·招行·9447 保险") always
// contain transaction-type words after normalization, and account display
// fragments joined with "·" also appear in most rows. They are not category
// evidence; exclude them so one template does not boost every expense for the
// same owner/account into the wrong category.
const CATEGORY_EVIDENCE_STOPWORD_TOKENS = new Set(["支出", "收入", "转账", "转入", "转出", "还款"]);

function matchHistoricalCategoryName(item: StatementImportItemLike, samples: StatementHistoricalCategorySample[]) {
  const type = item.type === "income" ? "income" : item.type === "expense" ? "expense" : "";
  if (!type) return undefined;

  const sourceParts = [
    cleanOptionalText(item.remark),
    cleanOptionalText(item.counterparty),
    cleanOptionalText(item.institution),
    cleanOptionalText(item.rawText),
  ];
  const source = sourceParts.filter(Boolean).join(" ");
  const sourceText = normalizeStatementRecognitionText(source);
  const sourceTokens = new Set(recognitionTokens(source));
  if (!sourceText && sourceTokens.size === 0) return undefined;

  const scores = new Map<string, number>();
  for (const sample of samples) {
    if ((sample.targetType ?? "category") !== "category") continue;
    if (sample.type !== type || !sample.categoryName) continue;
    const sampleSource = [sample.counterpartyInstitutionName, sample.paymentChannelName, sample.note].filter(Boolean).join(" ");
    const sampleText = cleanOptionalText(sample.normalizedText) || normalizeStatementRecognitionText(sampleSource);
    const sampleTokens = recognitionTokens(sample.matchText || sampleSource || sample.normalizedText);
    if (!sampleText && sampleTokens.length === 0) continue;

    let score = 0;
    if (sourceText && sampleText) {
      if (sourceText === sampleText) score += 40;
      else if (sourceText.includes(sampleText) || sampleText.includes(sourceText)) {
        score += Math.min(sourceText.length, sampleText.length) >= 4 ? 18 : 6;
      }
    }
    for (const token of sampleTokens) {
      if (CATEGORY_EVIDENCE_STOPWORD_TOKENS.has(token) || token.includes("·")) continue;
      if (sourceTokens.has(token)) score += Math.min(12, token.length * 2);
      else if (token.length >= 4 && sourceText.includes(token)) score += Math.min(10, token.length);
    }
    if (score < 12) continue;
    if (sample.source === "learned_rule") score += 20 + Math.min(30, Math.max(0, Number(sample.weight ?? 0)));
    else if (sample.source === "system_keyword") score += 12 + Math.min(20, Math.max(0, Number(sample.priority ?? 0)) / 10);
    else if (sample.source === "system_default") score += 8;
    scores.set(sample.categoryName, Math.max(scores.get(sample.categoryName) ?? 0, score));
  }

  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function matchExistingCategoryName(
  item: StatementImportItemLike,
  categories: StatementCategoryOption[],
  historicalSamples: StatementHistoricalCategorySample[] = [],
) {
  const type = item.type === "income" ? "income" : item.type === "expense" ? "expense" : "";
  if (!type) return undefined;
  const scopedCategories = categories.filter((category) => category.type === type);
  if (scopedCategories.length === 0) return undefined;

  // An explicit category already set by the parser (e.g. the CMB "分期"
  // section forcing "银行分期") is authoritative and must not be overridden
  // by the learning library. Only fall back to historical samples when the
  // parser did not provide a category that resolves to the ledger.
  const candidate = cleanOptionalText(item.category);
  if (candidate) {
    const exact = scopedCategories.find((category) => category.name === candidate);
    if (exact) return exact.name;
  }

  const historicalCategoryName = matchHistoricalCategoryName(item, historicalSamples);
  if (historicalCategoryName && scopedCategories.some((category) => category.name === historicalCategoryName)) {
    return historicalCategoryName;
  }

  const source = [
    cleanOptionalText(item.category),
    cleanOptionalText(item.remark),
    cleanOptionalText(item.counterparty),
    cleanOptionalText(item.institution),
    cleanOptionalText(item.rawText),
  ].filter(Boolean).join(" ");
  const keywords = fallbackCategoryKeywords(source);
  for (const keyword of keywords) {
    const matched = scopedCategories.find((category) => category.name === keyword);
    if (matched) return matched.name;
  }
  for (const keyword of keywords) {
    const matched = scopedCategories.find((category) => category.name.includes(keyword) || keyword.includes(category.name));
    if (matched) return matched.name;
  }
  return undefined;
}

export function alignStatementCategoriesToLedger<T extends StatementImportItemLike>(
  items: T[],
  categories: StatementCategoryOption[],
  historicalSamples: StatementHistoricalCategorySample[] = [],
) {
  return items.map((item) => {
    if (item.type !== "income" && item.type !== "expense") return item;
    const matchedCategoryName = matchExistingCategoryName(item, categories, historicalSamples);
    return {
      ...item,
      // Merchant inference may emit broad labels that do not exist in the ledger.
      // Only expose category names that resolve to the current category list.
      category: matchedCategoryName,
    } as T;
  });
}

function matchRecognitionInstitutionName(
  item: StatementImportItemLike,
  samples: StatementHistoricalCategorySample[] = [],
) {
  const source = [
    cleanOptionalText(item.institution),
    cleanOptionalText(item.counterparty),
    cleanOptionalText(item.remark),
    cleanOptionalText(item.rawText),
  ].filter(Boolean).join(" ");
  const sourceText = normalizeStatementKeywordText(source);
  if (!sourceText) return undefined;

  const scored = samples
    .filter((sample) => sample.targetType === "institution" && cleanOptionalText(sample.institutionName))
    .map((sample) => {
      const keyword = normalizeStatementKeywordText(sample.matchText || sample.normalizedText || sample.note);
      if (!keyword || keyword.length < 2) return null;
      let score = 0;
      if (sourceText === keyword) score += 60;
      else if (sourceText.includes(keyword) || keyword.includes(sourceText)) score += keyword.length >= 4 ? 30 : 14;
      if (score <= 0) return null;
      score += Math.min(50, Math.max(0, Number(sample.priority ?? 0)));
      score += Math.min(20, Math.max(0, Number(sample.weight ?? 0)));
      return { name: cleanOptionalText(sample.institutionName), score };
    })
    .filter((item): item is { name: string; score: number } => Boolean(item?.name))
    .sort((a, b) => b.score - a.score);

  return scored[0]?.name;
}

export function alignStatementRecognitionToLedger<T extends StatementImportItemLike>(
  items: T[],
  categories: StatementCategoryOption[],
  historicalSamples: StatementHistoricalCategorySample[] = [],
) {
  const categorized = alignStatementCategoriesToLedger(items, categories, historicalSamples);
  return categorized.map((item) => {
    const institutionName = matchRecognitionInstitutionName(item, historicalSamples);
    return {
      ...item,
      institution: institutionName ?? cleanOptionalText(item.institution) ?? item.institution,
    } as T;
  });
}
