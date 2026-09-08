import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { z } from "zod";
import { FundCashFlowKind, FundSubtype } from "@prisma/client";
import { toNumber, toStatementMonth } from "@/lib/date-utils";
import { getLatestFundNav } from "@/lib/fund/navCache";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { createFundTransactionWithCashFlows } from "@/lib/fund/transactions";
import { logger } from "@/lib/logger";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { normalizeCurrency, resolveSameCurrencyTransfer } from "@/lib/currency";
import { assertInstitutionDisplayNamesUnique } from "@/lib/server/institution-name-unique";
import { findRecentTransactionDuplicate } from "@/lib/server/transaction-dedupe";
import { createImportAccountMatcher } from "@/lib/account-import-match";
import { enrichAiParsedItems } from "@/lib/statement/ai-import-enrichment";
import type { ParsedItem } from "@/lib/ai/parser";
import { isSpendableAccount } from "@/lib/account-kind-utils";
import { ENTRY_ORIGIN_AI_IMPORT } from "@/lib/transaction-semantics";
import { creditBillEffectiveDate } from "@/lib/credit/billing";

export const runtime = "nodejs";

/** Extract fund code from rawText, remark, counterparty, category — returns 6-digit code or null */
function extractFundCode(item: { rawText?: string; remark?: string; counterparty?: string; category?: string }): string | null {
  const sources = [item.rawText, item.remark, item.counterparty, item.category].filter(Boolean) as string[];
  // Try explicit fund code prefix patterns first
  for (const src of sources) {
    const m = src.match(/(?:基金[:\s]*|fund[:\s]*|code[:\s]*)?(\d{6})/i);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Detect fundProductType from fund code prefix */
function detectFundProductType(code: string): string {
  const prefix = code.charAt(0);
  if (prefix === "5") return "money_fund";
  return "fund";
}

/** Detect fundSubtype from text keywords */
function detectFundSubtype(rawText: string, remark?: string): string {
  const combined = `${rawText} ${remark ?? ""}`;
  if (/赎回|卖出/.test(combined)) return "redeem";
  if (/分红|红利/.test(combined) && !/红利转投/.test(combined)) return "dividend_cash";
  if (/红利转投|红利再投/.test(combined)) return "dividend_reinvest";
  return "buy";
}

const ItemSchema = z.object({
  rawText: z.string(),
  type: z.enum(["expense", "income", "transfer", "investment"]),
  date: z.string().optional(),
  postedAt: z.string().nullable().optional(),
  amount: z.number(),
  accountId: z.string().nullable().optional(),
  account: z.string().optional(),
  fromAccount: z.string().optional(),
  toAccount: z.string().optional(),
  categoryId: z.string().nullable().optional(),
  category: z.string().optional(),
  institutionId: z.string().nullable().optional(),
  institution: z.string().optional(),
  remark: z.string().optional(),
  counterparty: z.string().optional(),
});

const BodySchema = z.object({
  items: z.array(ItemSchema),
  defaultAccountName: z.string().optional(),
  accountId: z.string().optional(),
  fundContext: z.object({
    accountId: z.string(),
    cashAccountId: z.string().optional(),
    fundCode: z.string(),
    fundName: z.string().optional(),
    fundProductType: z.string().optional(),
  }).optional(),
});

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as unknown;
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "INVALID_PARAMS", error: "参数格式不正确" }, { status: 400 });
  }

  const scope = await getHouseholdScope();
  if (!scope.user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }
  const { hidFilter, householdId } = scope;

  const { items, defaultAccountName, accountId: requestAccountId, fundContext } = parsed.data;
  if (!items?.length) {
    return NextResponse.json({ ok: false, code: "NOTHING_TO_IMPORT", error: "没有可导入的记录" }, { status: 400 });
  }

  const normalizedItems = await enrichAiParsedItems(
    prisma,
    householdId,
    hidFilter,
    items.map((item) => ({
      ...item,
      postedAt: item.postedAt ?? undefined,
      accountId: item.accountId ?? undefined,
      account: item.account ?? undefined,
      fromAccount: item.fromAccount ?? undefined,
      toAccount: item.toAccount ?? undefined,
      categoryId: item.categoryId ?? undefined,
      category: item.category ?? undefined,
      institutionId: item.institutionId ?? undefined,
      institution: item.institution ?? undefined,
      remark: item.remark ?? undefined,
      counterparty: item.counterparty ?? undefined,
    }) as ParsedItem),
  );

  const [accounts, categories, groups, users, institutions] = await Promise.all([
    prisma.account.findMany({
      where: { ...hidFilter },
      include: { Institution: true, AccountGroup: true, AccountAlias: true },
      orderBy: { name: "asc" },
    }),
    prisma.category.findMany({ where: { ...hidFilter }, orderBy: { name: "asc" } }),
    prisma.accountGroup.findMany({ where: { ...hidFilter }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.user.findMany({ orderBy: { name: "asc" } }),
    prisma.institution.findMany({ where: { ...hidFilter }, orderBy: { name: "asc" } }),
  ]);

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const accountByName = new Map(
    accounts.map((a) => [`${a.Institution?.name ?? ""}·${a.name}`.replace(/^·/, ""), a]),
  );
  const accountByAlias = new Map<string, (typeof accounts)[number]>();
  const requestAccount = requestAccountId ? accountById.get(requestAccountId) ?? null : null;
  const canUseAsDefaultSpendableAccount = (account: (typeof accounts)[number] | null | undefined) =>
    !!account && account.isActive && account.isPlaceholder !== true && isSpendableAccount(account);
  const defaultSpendableAccount = canUseAsDefaultSpendableAccount(requestAccount)
    ? requestAccount
    : accounts.find(canUseAsDefaultSpendableAccount) ?? null;
  const matchImportAccount = createImportAccountMatcher(accounts);

  for (const account of accounts) {
    for (const alias of account.AccountAlias ?? []) {
      accountByAlias.set(alias.alias.toLowerCase(), account);
    }
  }

  const BANK_KEYWORD_MAP: Record<string, string[]> = {
    "工商银行": ["工商", "工行", "ICBC"],
    "农业银行": ["农业", "农行", "ABC"],
    "中国银行": ["中国银行", "中行", "BOC"],
    "建设银行": ["建设", "建行", "CCB"],
    "交通银行": ["交通", "交行", "BOCOM"],
    "招商银行": ["招商", "招行", "CMB"],
    "中信银行": ["中信", "CITIC"],
    "光大银行": ["光大", "CEB"],
    "华夏银行": ["华夏", "HXB"],
    "民生银行": ["民生", "CMBC"],
    "广发银行": ["广发", "CGB"],
    "平安银行": ["平安", "PAB"],
    "兴业银行": ["兴业", "CIB"],
    "浦发银行": ["浦发", "SPDB"],
    "邮储银行": ["邮储", "邮政储蓄", "PSBC"],
    "北京银行": ["北京银行", "BOB"],
    "上海银行": ["上海银行", "BOS"],
    "江苏银行": ["江苏银行", "BOJ"],
    "南京银行": ["南京银行", "BONJ"],
    "宁波银行": ["宁波银行", "BONB"],
    "徽商银行": ["徽商", "HUISHANG"],
    "浙商银行": ["浙商", "CZB"],
    "渤海银行": ["渤海", "CBHB"],
    "恒丰银行": ["恒丰", "HFB"],
    "花旗银行": ["花旗", "CITI"],
    "汇丰银行": ["汇丰", "HSBC"],
    "渣打银行": ["渣打", "SCB"],
    "东亚银行": ["东亚", "BEA"],
    "星展银行": ["星展", "DBS"],
    "华侨银行": ["华侨", "OCBC"],
    "大华银行": ["大华", "UOB"],
    "泰隆银行": ["泰隆"],
    "网商银行": ["网商", "MYbank"],
    "微众银行": ["微众", "WeBank"],
    "百信银行": ["百信", "AIbank"],
    "新网银行": ["新网", "XWbank"],
  };

  function extractBankKeyword(text: string) {
    for (const [standard, aliases] of Object.entries(BANK_KEYWORD_MAP)) {
      for (const alias of aliases) {
        if (text.includes(alias)) return standard;
      }
    }
    return "";
  }

  function institutionMatchesBankKey(account: (typeof accounts)[number], bankKey: string) {
    if (!bankKey) return true;
    const inst = (account.Institution?.name ?? "").trim();
    const accName = account.name.trim();
    const aliases = BANK_KEYWORD_MAP[bankKey] ?? [];
    return inst.includes(bankKey) || accName.includes(bankKey) || aliases.some((al) => inst.includes(al) || accName.includes(al));
  }

  function extractCreditCardTail(text: string | undefined) {
    const clean = String(text ?? "").trim();
    if (!clean) return "";
    const direct = clean.match(/尾号\s*([0-9]{4})(?=.*信用卡)|信用卡.*?尾号\s*([0-9]{4})/);
    if (direct?.[1] || direct?.[2]) return direct[1] ?? direct[2] ?? "";
    const compact = clean.match(/\b([0-9]{4})\b(?=.*信用卡)|信用卡.*?\b([0-9]{4})\b/);
    return compact?.[1] ?? compact?.[2] ?? "";
  }

  function accountTailMatches(account: (typeof accounts)[number], tail: string) {
    if (!tail) return false;
    const masked = String(account.numberMasked ?? "").replace(/\D/g, "");
    const nameDigits = String(account.name ?? "").replace(/\D/g, "");
    return masked.endsWith(tail) || nameDigits.endsWith(tail);
  }

  function findCreditAccountFromText(text: string | undefined) {
    const tail = extractCreditCardTail(text);
    if (!tail) return null;
    const bankKey = extractBankKeyword(String(text ?? ""));
    const candidates = accounts.filter((a) => a.kind === "bank_credit" && accountTailMatches(a, tail));
    const narrowedByBank = bankKey ? candidates.filter((a) => institutionMatchesBankKey(a, bankKey)) : candidates;
    if (requestAccount && requestAccount.kind === "bank_credit" && accountTailMatches(requestAccount, tail)) {
      if (!bankKey || institutionMatchesBankKey(requestAccount, bankKey)) return requestAccount;
    }
    return narrowedByBank[0] ?? candidates[0] ?? null;
  }

  const allRawText = normalizedItems.map((x) => `${x.rawText ?? ""} ${x.remark ?? ""} ${x.counterparty ?? ""}`).join(" ");
  const statementIssuer = extractBankKeyword(allRawText);
  const preferredCreditAccount = findCreditAccountFromText(allRawText) ?? (statementIssuer
    ? accounts.find((a) => a.kind === "bank_credit" && ((a.Institution?.name ?? "").includes(statementIssuer) || a.name.includes(statementIssuer))) ?? null
    : null);
  const isCreditStatement = preferredCreditAccount !== null;

  function shouldLearnAlias(alias: string, account: { id: string; name: string }) {
    if (!alias || alias.length < 2) return false;
    if (accountByAlias.has(alias.toLowerCase())) return false;
    if (accountByName.has(alias)) return false;
    if (alias === account.name) return false;
    return true;
  }


  function findAccount(name: string | undefined) {
    if (!name) return null;
    const clean = name.trim();
    const creditByTail = findCreditAccountFromText(clean);
    if (creditByTail) return creditByTail;

    const sharedMatch = matchImportAccount(clean).account;
    if (sharedMatch) return sharedMatch;

    const exact = accountByName.get(clean);
    if (exact) return exact;

    const aliasHit = accountByAlias.get(clean.toLowerCase());
    if (aliasHit) return aliasHit;

    const lower = clean.toLowerCase();
    const bankKey = extractBankKeyword(clean);
    const wantsCredit = /信用卡/.test(clean);

    const candidates = accounts.filter((a) =>
      a.name.toLowerCase().includes(lower) ||
      (a.numberMasked ?? "").toLowerCase().includes(lower) ||
      (a.Institution?.name ?? "").toLowerCase().includes(lower) ||
      lower.includes(a.name.toLowerCase()) ||
      (!!a.numberMasked && lower.includes(a.numberMasked.toLowerCase())) ||
      `${a.Institution?.name ?? ""}·${a.name}`.toLowerCase().includes(lower),
    );

    const narrowedByBank = bankKey
      ? candidates.filter((a) => institutionMatchesBankKey(a, bankKey))
      : candidates;

    const narrowedByKind = wantsCredit
      ? narrowedByBank.filter((a) => a.kind === "bank_credit")
      : narrowedByBank;

    const matched = narrowedByKind[0] ?? narrowedByBank[0] ?? candidates[0] ?? null;

    if (matched && shouldLearnAlias(clean, matched)) {
      try {
        prisma.accountAlias.upsert({
          where: { alias_accountId: { alias: clean, accountId: matched.id } },
          create: { alias: clean, accountId: matched.id },
          update: {},
        }).catch(() => null);
        accountByAlias.set(clean.toLowerCase(), matched);
      } catch { /* ignore */ }
    }

    return matched;
  }

  const firstAccount = accounts[0] ?? null;

  function shouldAutoCreateAccount(label: string | undefined) {
    const t = (label ?? "").trim();
    if (!t) return false;
    if (t.length > 60) return false;
    if (/花园茶楼|京东|美团|饿了么|超市|餐厅|饭店/.test(t) && !/信用卡|银行卡|招行|交行|中信|农商行|花呗|余额宝|一卡通|支付宝|微信/.test(t)) {
      return false;
    }
    return /招行|招商|交通|交行|中信|光大|华夏|民生|浦发|兴业|广发|平安|邮储|工行|工商银行|农行|农业银行|建行|建设银行|中国银行|中行|农商行|农信|农商|信用卡|借记|储蓄|一卡通|花呗|白条|余额宝|支付宝|微信|云闪付|银联|银行卡|京东金融|美团月付|抖音支付|小米支付/.test(t);
  }

  function normalizeInstitutionName(text: string) {
    if (/招行|招商/.test(text)) return "招商银行";
    if (/交行|交通/.test(text)) return "交通银行";
    if (/工行|工商银行/.test(text)) return "工商银行";
    if (/农行|农业银行/.test(text)) return "农业银行";
    if (/建行|建设银行/.test(text)) return "建设银行";
    if (/中行|中国银行/.test(text)) return "中国银行";
    if (/光大/.test(text)) return "光大银行";
    if (/华夏/.test(text)) return "华夏银行";
    if (/民生/.test(text)) return "民生银行";
    if (/浦发/.test(text)) return "浦发银行";
    if (/兴业/.test(text)) return "兴业银行";
    if (/广发/.test(text)) return "广发银行";
    if (/平安/.test(text)) return "平安银行";
    if (/邮储/.test(text)) return "邮储银行";
    if (/中信/.test(text)) return "中信银行";
    if (/农商行|农商银行|农信|农商/.test(text)) return "农商银行";
    if (/花呗|余额宝|支付宝/.test(text)) return "支付宝";
    if (/微信/.test(text)) return "微信";
    if (/白条|京东/.test(text)) return "京东金融";
    if (/云闪付|银联/.test(text)) return "银联";
    if (/美团月付/.test(text)) return "美团";
    if (/抖音支付/.test(text)) return "抖音支付";
    if (/小米支付/.test(text)) return "小米支付";
    return "";
  }

  function inferAccountKind(text: string) {
    const t = text.trim();
    if (/现金/.test(t)) return "cash";
    if (/信用卡/.test(t)) return "bank_credit";
    if (/花呗|白条|美团月付|抖音支付/.test(t)) return "loan";
    if (/余额宝|支付宝|微信|云闪付|小米支付/.test(t)) return "ewallet";
    if (/储蓄|借记|一卡通/.test(t)) return "bank_debit";
    if (/基金|理财|证券|股票/.test(t)) return "investment";
    return "bank_debit";
  }

  function pickGroupId(kind: string) {
    const byName = (re: RegExp) => groups.find((g) => re.test(g.name))?.id ?? null;
    if (kind === "cash") return byName(/现金/) ?? groups[0]?.id ?? null;
    if (kind === "bank_credit") return byName(/信用卡/) ?? byName(/银行/) ?? groups[0]?.id ?? null;
    if (kind === "bank_debit") return byName(/银行|存款/) ?? groups[0]?.id ?? null;
    if (kind === "ewallet") return byName(/第三方|储值|支付/) ?? groups[0]?.id ?? null;
    if (kind === "investment") return byName(/投资/) ?? groups[0]?.id ?? null;
    if (kind === "loan") return byName(/负债|贷款|借/) ?? groups[0]?.id ?? null;
    return groups[0]?.id ?? null;
  }

  function inferCounterparty(item: z.infer<typeof ItemSchema>) {
    const raw = `${item.counterparty ?? ""} ${item.remark ?? ""} ${item.rawText ?? ""}`.trim();
    if (!raw) return undefined;
    if (/支付宝/.test(raw)) return "支付宝";
    if (/微信/.test(raw)) return "微信";
    if (/银联/.test(raw)) return "银联";
    if (/云闪付/.test(raw)) return "云闪付";
    if (/京东/.test(raw)) return "京东";
    if (/美团/.test(raw)) return "美团";
    return item.counterparty?.trim() || undefined;
  }

  function findCounterpartyInstitution(name: string | undefined) {
    const clean = String(name ?? "").trim();
    if (!clean) return null;
    return institutions.find((inst) => inst.name === clean || inst.shortName === clean) ??
      institutions.find((inst) => clean.includes(inst.name) || (!!inst.shortName && clean.includes(inst.shortName))) ??
      null;
  }

  function enrichRemark(item: z.infer<typeof ItemSchema>) {
    const parts: string[] = [];
    if (item.remark?.trim()) parts.push(item.remark.trim());
    const raw = item.rawText ?? "";
    const payTail = raw.match(/(?:付款|扣款|还款|银联转账|银联入账|自动扣款|自动还款|转账)?\s*尾号[:：]?\s*(\d{2,8})/);
    if (payTail) parts.push(`付款尾号:${payTail[1]}`);
    if (/银联入账/.test(raw) && !parts.some((p) => p.includes("银联入账"))) parts.push("银联入账");
    return parts.join(" / ") || undefined;
  }

  async function ensureDefaultGroupId() {
    const id = groups[0]?.id ?? null;
    if (id) return id;
    const created = await prisma.accountGroup.create({
      data: {
        name: "默认",
        sortOrder: 0,
        householdId,
      },
    });
    groups.push(created);
    return created.id;
  }

  async function ensureInstitutionId(instName: string) {
    const name = instName.trim();
    if (!name) return null;
    const found = await prisma.institution.findFirst({
      where: {
        ...hidFilter,
        OR: [{ name }, { shortName: name }],
      },
    });
    if (found) return found.id;
    await assertInstitutionDisplayNamesUnique(prisma, { householdId, name });
    const created = await prisma.institution.create({
      data: { name, householdId },
    });
    return created.id;
  }

  function resolveUserId(label: string) {
    const m = label.match(/^(.+?)的/);
    if (!m?.[1]) return null;
    const name = m[1]!.trim();
    if (!name) return null;
    return users.find((u) => u.name === name)?.id ?? null;
  }

  function stripOwnerPrefix(label: string) {
    const t = label.trim();
    const m = t.match(/^(.+?)的(.+)$/);
    if (m?.[2]) return m[2]!.trim();
    return t;
  }

  async function ensureAccount(label: string | undefined) {
    const raw = (label ?? "").trim();
    if (!raw) return null;
    const existing = findAccount(raw);
    if (existing) return existing;
    if (!shouldAutoCreateAccount(raw)) return null;

    const name = stripOwnerPrefix(raw);
    const kind = inferAccountKind(raw);
    const groupId = pickGroupId(kind) ?? (await ensureDefaultGroupId());
    const institutionName = normalizeInstitutionName(raw);
    const institutionId = institutionName ? await ensureInstitutionId(institutionName) : null;
    const userId = resolveUserId(raw);

    const created = await prisma.account.create({
      data: {
        name: name || raw,
        kind: kind as any,
        currency: "CNY",
        isActive: true,
        groupId,
        householdId,
        institutionId: institutionId ?? undefined,
        userId: userId ?? undefined,
      },
      include: { Institution: true, AccountGroup: true, AccountAlias: true },
    });

    accounts.push(created);
    accountById.set(created.id, created);
    const key = `${created.Institution?.name ?? ""}·${created.name}`.replace(/^·/, "");
    accountByName.set(key, created);
    createdAccounts.push({
      id: created.id,
      name: created.name,
      kind: created.kind,
      institutionName: created.Institution?.name ?? (institutionName || null),
    });
    return created;
  }

  function findCategory(type: string, path: string | undefined, categoryId?: string | null) {
    const id = String(categoryId ?? "").trim();
    if (id) {
      const byId = categories.find((category) => category.id === id && category.type === type);
      if (byId) return byId;
    }
    if (!path) return null;
    const parts = path.split(".").map((p) => p.trim()).filter(Boolean);
    let current: (typeof categories)[number] | null = null;
    let found = false;
    for (const part of parts) {
      if (!current) {
        current = categories.find((c) => c.type === type && c.name === part && !c.parentId) ?? null;
      } else {
        current = categories.find((c) => c.type === type && c.name === part && c.parentId === current!.id) ?? null;
      }
      if (!current) break;
      found = true;
    }
    if (found && current) return current;
    const exactMatches = categories.filter((category) => category.type === type && category.name === path.trim());
    return exactMatches.length === 1 ? exactMatches[0] : null;
  }

  function upsertTag(name: string, householdId: string | undefined) {
    return prisma.tag.upsert({
      where: { id: name },
      create: { id: name, name, householdId },
      update: {},
    });
  }

  let createdCount = 0;
  const errors: Array<{ index: number; rawText: string; error: string }> = [];
  const createdAccounts: Array<{ id: string; name: string; kind: string; institutionName?: string | null }> = [];
  const defaultAcc = (defaultAccountName ?? "").trim();
  const defaultContextAccount = (() => {
    const account = findAccount(defaultAcc);
    return canUseAsDefaultSpendableAccount(account) ? account : null;
  })();

  // Resolve fund name from nav cache for batch fund operations
  let resolvedFundName: string | null = null;
  if (fundContext?.fundCode) {
    try {
      const latestNav = await getLatestFundNav(fundContext.fundCode);
      if (latestNav?.name && latestNav.name !== fundContext.fundCode) {
        resolvedFundName = latestNav.name;
      }
    } catch { /* best effort */ }
  }

  for (let i = 0; i < normalizedItems.length; i++) {
    const item = normalizedItems[i]!;
    try {
      const itemAmount = toNumber(item.amount);
      const entryAmount = Math.abs(itemAmount);
      const isExpenseRefund = item.type === "expense" && itemAmount < 0;
      if (entryAmount === 0) {
        errors.push({ index: i, rawText: item.rawText.slice(0, 60), error: "金额为 0，跳过" });
        continue;
      }

      const rawDate = item.date?.trim();
      const date = rawDate
        ? new Date(rawDate.replace(/\//g, "-"))
        : new Date();

      const rawPostedAt = item.postedAt?.trim();
      const postedAt = item.type === "expense" || item.type === "income"
        ? (rawPostedAt ? new Date(rawPostedAt.replace(/\//g, "-")) : new Date(date))
        : null;
      if (Number.isNaN(date.getTime()) || (postedAt && Number.isNaN(postedAt.getTime()))) {
        errors.push({ index: i, rawText: item.rawText.slice(0, 60), error: "日期格式无效，无法导入" });
        continue;
      }

      const normalizedCounterparty = inferCounterparty(item);
      const normalizedInstitution = item.institution?.trim() || normalizedCounterparty;
      const normalizedRemark = enrichRemark(item);
      let didCreate = false;

      // Fast path: fund view batch creation — skip account resolution entirely
      if (item.type === "investment" && fundContext) {
        const fundAcc = accountById.get(fundContext.accountId);
        if (!fundAcc) {
          errors.push({ index: i, rawText: item.rawText.slice(0, 60), error: "基金账户不存在" });
          continue;
        }
        const cashAcc = fundContext.cashAccountId ? accountById.get(fundContext.cashAccountId) : null;
        const isRedeem = /赎回|卖出/.test(item.rawText);
        const fundSubtypeValue = isRedeem ? "redeem" : "buy";
        const productType = fundContext.fundProductType ?? (fundContext.fundCode?.startsWith("5") ? "money_fund" : "fund");

        const statementMonth =
          (fundAcc.kind === "bank_credit" || fundAcc.kind === "loan") && fundAcc.billingDay ? toStatementMonth(date, fundAcc.billingDay) : null;

        await createFundTransactionWithCashFlows(prisma, {
          householdId,
          fundAccountId: fundAcc.id,
          cashAccountId: cashAcc?.id ?? null,
          fundCode: fundContext.fundCode,
          fundName: resolvedFundName ?? fundContext.fundCode,
          fundProductType: productType,
          fundSubtype: fundSubtypeValue as FundSubtype,
          source: "ai_recognition",
          entryOrigin: ENTRY_ORIGIN_AI_IMPORT,
          applyDate: date,
          grossAmount: entryAmount,
          cashFlows: cashAcc ? [{
            kind: fundSubtypeValue === "redeem" ? FundCashFlowKind.redeem_in : FundCashFlowKind.buy_out,
            date,
            accountId: cashAcc.id,
            accountName: cashAcc.name,
            amount: fundSubtypeValue === "redeem" ? entryAmount : -entryAmount,
            currency: normalizeCurrency(cashAcc.currency ?? fundAcc.currency),
            source: "ai_recognition",
            note: normalizedRemark,
          }] : [],
          note: normalizedRemark,
        });
        createdCount++;
        continue;
      }

      if (item.type === "transfer") {
        const from =
          findAccount(item.fromAccount) ??
          (await ensureAccount(item.fromAccount)) ??
          findAccount(defaultAcc) ??
          (await ensureAccount(defaultAcc));
        const to =
          findAccount(item.toAccount) ??
          (await ensureAccount(item.toAccount)) ??
          findAccount(defaultAcc) ??
          (await ensureAccount(defaultAcc));
        if (!from || !to) {
          errors.push({ index: i, rawText: item.rawText.slice(0, 60), error: "转账缺少账户，至少需要两个账户" });
          continue;
        }
        const fromStatementMonth =
          (from.kind === "bank_credit" || from.kind === "loan") && from.billingDay ? toStatementMonth(date, from.billingDay) : null;
        const transferCurrency = resolveSameCurrencyTransfer(from, to);
        await prisma.txRecord.create({
          data: {
            type: item.type as any,
            status: "posted",
            date,
            amount: -entryAmount,
            accountId: from.id,
            accountName: from.name,
            toAccountId: to.id,
            toAccountName: to.name,
            note: normalizedRemark,
            statementMonth: fromStatementMonth,
            householdId,
            currency: transferCurrency,
            source: "ai_recognition",
            entryOrigin: ENTRY_ORIGIN_AI_IMPORT,
          },
        });
        didCreate = true;
      } else if (item.type === "investment") {
        const from =
          findAccount(item.fromAccount) ??
          (await ensureAccount(item.fromAccount)) ??
          findAccount(defaultAcc) ??
          (await ensureAccount(defaultAcc)) ??
          firstAccount;
        const to =
          findAccount(item.toAccount) ??
          (await ensureAccount(item.toAccount)) ??
          findAccount(defaultAcc) ??
          (await ensureAccount(defaultAcc)) ??
          firstAccount;

        const rawText = item.rawText ?? "";
        const fundCode = extractFundCode({ rawText, remark: item.remark, counterparty: item.counterparty, category: item.category });
        const investAccount = [from, to].find(a => a?.kind === "investment") ?? null;
        const cashAccount = [from, to].find(a => a?.kind !== "investment") ?? null;
        const fundSubtypeValue = detectFundSubtype(rawText, item.remark);
        const productType = (fundCode ? detectFundProductType(fundCode) : "fund") as any;

        // Look up fund name from nav cache if we have a fund code
        let fundName: string | null = null;
        if (fundCode) {
          try {
            const latestNav = await getLatestFundNav(fundCode);
            fundName = latestNav?.name ?? null;
          } catch { /* nav lookup best-effort */ }
        }

        if (!from || !to) {
          const single = from ?? to ?? firstAccount;
          if (!single) {
            errors.push({ index: i, rawText: item.rawText.slice(0, 60), error: "缺少账户，请先添加账户" });
            continue;
          }
          const statementMonth =
            (single.kind === "bank_credit" || single.kind === "loan") && single.billingDay ? toStatementMonth(date, single.billingDay) : null;

          await prisma.txRecord.create({
            data: {
              type: "investment" as any,
              status: "posted",
              date,
              amount: -entryAmount,
              accountId: single.id,
              accountName: single.name,
              toAccountId: single.kind === "investment" ? single.id : null,
              toAccountName: single.kind === "investment" ? single.name : null,
              note: normalizedRemark,
              statementMonth,
              householdId,
              currency: normalizeCurrency(single.currency),
              source: "ai_recognition",
              entryOrigin: ENTRY_ORIGIN_AI_IMPORT,

            },
          });
          didCreate = true;
        } else {
          const fromStatementMonth =
            (from.kind === "bank_credit" || from.kind === "loan") && from.billingDay ? toStatementMonth(date, from.billingDay) : null;

          await prisma.txRecord.create({
            data: {
              type: "investment" as any,
              status: "posted",
              date,
              amount: -entryAmount,
              accountId: from.id,
              accountName: from.name,
              toAccountId: to.id,
              toAccountName: to.name,
              note: normalizedRemark,
              statementMonth: fromStatementMonth,
              householdId,
              currency: normalizeCurrency(cashAccount?.currency ?? from.currency),
              source: "ai_recognition",
              entryOrigin: ENTRY_ORIGIN_AI_IMPORT,

            },
          });
          didCreate = true;
        }
      } else {
        const account =
          (item.accountId ? accountById.get(item.accountId) ?? null : null) ??
          findCreditAccountFromText(`${item.account ?? ""} ${item.rawText ?? ""} ${item.remark ?? ""}`) ??
          (isCreditStatement ? preferredCreditAccount : null) ??
          findAccount(item.account) ??
          defaultSpendableAccount ??
          defaultContextAccount ??
          (item.type === "expense" || item.type === "income" ? null : firstAccount);

        if (!account && item.account?.trim()) {
          throw new Error(`无法匹配账户"${item.account}"，请手动指定目标账户`);
        }
        if (!account) {
          errors.push({ index: i, rawText: item.rawText.slice(0, 60), error: "缺少账户，请先添加账户" });
          continue;
        }

        // User confirmation = positive example: persist alias + mark distillation log
        if (item.account && item.account.trim() !== `${account.Institution?.name ?? ""}·${account.name}`.replace(/^·/, "")) {
          try {
            await prisma.accountAlias.upsert({
              where: { alias_accountId: { alias: item.account.trim(), accountId: account.id } },
              create: { alias: item.account.trim(), accountId: account.id },
              update: {},
            });
          } catch { /* alias already exists */ }
        }

        // Mark the most recent DistillLog as user-confirmed
        try {
          const recent = await prisma.distillLog.findFirst({
            where: { source: "chat", success: true, userConfirmed: null },
            orderBy: { createdAt: "desc" },
          });
          if (recent) {
            await prisma.distillLog.update({
              where: { id: recent.id },
              data: { userConfirmed: true, confirmedAt: new Date() },
            });
          }
        } catch { /* ignore */ }
        const category = findCategory(item.type, item.category, item.categoryId);
        const counterpartyInstitution = item.institutionId
          ? institutions.find((institution) => institution.id === item.institutionId) ?? null
          : findCounterpartyInstitution(normalizedInstitution);
        const statementMonth =
          (account.kind === "bank_credit" || account.kind === "loan") && account.billingDay
            ? toStatementMonth(creditBillEffectiveDate({ type: item.type, date, postedAt }) ?? date, account.billingDay)
            : null;
        const entryData: Record<string, unknown> = {
          type: item.type as any,
          status: "posted",
          date,
          postedAt,
          amount: item.type === "expense" ? (isExpenseRefund ? entryAmount : -entryAmount) : entryAmount,
          accountId: account.id,
          accountName: account.name,
          note: normalizedRemark,
          statementMonth,
          householdId,
          currency: normalizeCurrency(account.currency),
          source: "ai_recognition",
          entryOrigin: ENTRY_ORIGIN_AI_IMPORT,
          counterpartyInstitutionId: counterpartyInstitution?.id ?? null,
          counterpartyInstitutionName: counterpartyInstitution?.name ?? normalizedInstitution ?? null,
        };
        if (category) {
          entryData.categoryId = category.id;
          entryData.categoryName = category.name;
        }
        await prisma.$transaction(async (tx) => {
          const duplicate = await findRecentTransactionDuplicate(tx, {
            householdId,
            type: item.type as any,
            date,
            accountId: account.id,
            amount: entryData.amount as number,
            categoryId: category?.id ?? null,
            note: normalizedRemark ?? null,
            source: "ai_recognition",
          });
          if (duplicate) return;
          await tx.txRecord.create({ data: entryData as any });
          didCreate = true;
        });
      }
      if (didCreate) createdCount++;
    } catch (e) {
      errors.push({ index: i, rawText: item.rawText.slice(0, 60), error: e instanceof Error ? e.message : "写入失败" });
    }
  }

  if (createdCount > 0) {
    // Recalculate positions so the fundHolding table updates immediately
    if (fundContext?.accountId) {
      await recalcFundPositions(fundContext.accountId).catch(logger.catchLog("操作失败", "route.ts"));
    }
    // Client-side handles page refresh
  }

  return NextResponse.json({
    ok: true,
    createdCount,
    skippedCount: errors.length,
    createdAccounts,
    errors: errors.length > 0 ? errors : undefined,
  });
}
