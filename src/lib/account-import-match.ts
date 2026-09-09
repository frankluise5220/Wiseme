export type ImportAccountKind = "bank_debit" | "bank_credit" | "loan" | "cash" | "ewallet" | "investment" | "other" | string;

export type ImportAccountMatchSource = {
  id: string;
  name: string;
  kind?: ImportAccountKind | null;
  numberMasked?: string | null;
  Institution?: { name?: string | null; shortName?: string | null } | null;
  AccountGroup?: { name?: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
};

export type ImportAccountMatchResult<T extends ImportAccountMatchSource> = {
  account: T | null;
  ambiguousAccounts: T[];
  targetKind: ImportAccountKind | null;
  targetBankNames: string[];
};

export type ImportOwnedMoneyAccountCandidate = {
  originalName: string;
  accountName: string;
  ownerName: string;
  kind: "bank_debit" | "cash" | "ewallet" | "investment";
  investProductType?: "fund" | "money" | "wealth";
  institutionName?: string;
  institutionDisplayName?: string;
  numberMasked?: string;
};

export type ImportAccountIdentityConflictKind =
  | "account"
  | "ambiguous"
  | "kind"
  | "last4"
  | "bank";

export type ImportAccountIdentityConflict = {
  kind: ImportAccountIdentityConflictKind;
  originalText: string;
  selectedAccountId?: string;
  matchedAccountId?: string;
};

export const IMPORT_ACCOUNT_ID_PREFIX = "account-id:";

export function encodeImportAccountId(accountId: string) {
  return `${IMPORT_ACCOUNT_ID_PREFIX}${accountId}`;
}


const DEBT_ACCOUNT_NAME_RE = /^(.+?)的往来款$/;

/** Extract counterparty name from "XX的往来款". Returns null on no match. */
export function parseDebtAccountName(v: string): string | null {
  const m = v.trim().match(DEBT_ACCOUNT_NAME_RE);
  return m?.[1]?.trim() ?? null;
}
export function parseImportAccountId(value?: string) {
  const text = String(value ?? "").trim();
  return text.startsWith(IMPORT_ACCOUNT_ID_PREFIX) ? text.slice(IMPORT_ACCOUNT_ID_PREFIX.length).trim() : "";
}

const BANK_ALIASES: Array<{ canonical: string; aliases: string[] }> = [
  { canonical: "支付宝", aliases: ["Alipay"] },
  { canonical: "微信", aliases: ["微信支付", "WeChat", "WeChat Pay"] },
  { canonical: "\u4eac\u4e1c", aliases: ["\u4eac\u4e1c\u91d1\u878d", "\u767d\u6761", "\u4eac\u4e1c\u652f\u4ed8"] },
  { canonical: "银联", aliases: ["云闪付", "银联支付"] },
  { canonical: "工商银行", aliases: ["中国工商银行", "工行"] },
  { canonical: "农业银行", aliases: ["中国农业银行", "农行"] },
  { canonical: "中国银行", aliases: ["中行"] },
  { canonical: "建设银行", aliases: ["中国建设银行", "建行"] },
  { canonical: "交通银行", aliases: ["交行"] },
  { canonical: "招商银行", aliases: ["招行", "招商"] },
  { canonical: "中信银行", aliases: ["中信"] },
  { canonical: "光大银行", aliases: ["中国光大银行", "光大"] },
  { canonical: "华夏银行", aliases: ["华夏"] },
  { canonical: "民生银行", aliases: ["中国民生银行", "民生"] },
  { canonical: "广发银行", aliases: ["广发"] },
  { canonical: "邮储银行", aliases: ["中国邮政储蓄银行", "邮政储蓄银行", "邮政银行", "邮储"] },
  { canonical: "浦发银行", aliases: ["上海浦东发展银行", "浦发"] },
  { canonical: "兴业银行", aliases: ["兴业"] },
  { canonical: "平安银行", aliases: ["平安"] },
  { canonical: "农商银行", aliases: ["农村商业银行", "农村信用社", "农信社", "农信", "江苏农信", "江苏农商", "省农信"] },
];

const ACCOUNT_KIND_ALIASES: Array<{ kind: ImportAccountKind; aliases: string[] }> = [
  { kind: "bank_credit", aliases: ["信用卡", "贷记卡"] },
  { kind: "bank_debit", aliases: ["储蓄卡", "借记卡", "银行卡", "\u4e00\u5361\u901a"] },
  { kind: "ewallet", aliases: ["\u7535\u5b50\u94b1\u5305", "\u94b1\u5305", "\u96f6\u94b1\u8d26\u6237", "\u4eac\u4e1c\u5c0f\u91d1\u5e93", "\u5c0f\u91d1\u5e93"] },
  { kind: "cash", aliases: ["现金", "现金账户"] },
  { kind: "investment", aliases: ["投资账户", "投资", "基金", "基金账户", "货币基金", "货币基金账户", "理财", "理财账户"] },
  { kind: "settlement", aliases: ["往来款"] },
];

const ACCOUNT_KIND_SEPARATOR_WORDS = [
  "\u4fe1\u7528\u5361",
  "\u8d37\u8bb0\u5361",
  "\u50a8\u84c4\u5361",
  "\u501f\u8bb0\u5361",
  "\u94f6\u884c\u5361",
];

const ACCOUNT_SCHEDULE_SUFFIX_RE = /(?:[\/／\\-]\s*\d{1,2}){2}$/;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeImportAccountMatchKey(value?: string | null) {
  return String(value ?? "")
    .trim()
    .replace(/[·•\-—_\s()[\]（）【】\u7684]/g, "")
    .toLowerCase();
}

export function extractImportAccountLast4(value?: string) {
  const matches = Array.from(String(value ?? "").matchAll(/\d{4}(?!\d)/g));
  return matches.length > 0 ? matches[matches.length - 1][0] : "";
}

export function isImportPaymentTailHint(value?: string | null) {
  return /^(?:付款|扣款|还款)?尾号[:：]?\s*\d{2,8}$/.test(String(value ?? "").trim());
}

export function isImportPaymentTailSourceHint(value?: string | null) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (isImportPaymentTailHint(text)) return true;
  if (/信用卡.*尾号|尾号\s*\d{2,8}.*信用卡|贷记卡.*尾号|尾号\s*\d{2,8}.*贷记卡/.test(text)) return false;
  return /(?:付款|扣款|还款|银联转账|银联入账|自动扣款|自动还款|转账).*尾号[:：]?\s*\d{2,8}/.test(text);
}

export function isImportUnionPayDebitTailSourceHint(value?: string | null) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  return /银联入账|银联转账|银联代扣|银联支付|云闪付/i.test(text) && /\d{4}(?!\d)/.test(text);
}

function isBareLast4Hint(value?: string | null) {
  return /^\d{4}$/.test(String(value ?? "").trim());
}

function accountLast4(account: ImportAccountMatchSource) {
  const fromMasked = extractImportAccountLast4(account.numberMasked ?? "");
  if (fromMasked) return fromMasked;
  const fromName = extractImportAccountLast4(account.name);
  if (fromName) return fromName;
  for (const alias of account.AccountAlias ?? []) {
    const fromAlias = extractImportAccountLast4(alias.alias);
    if (fromAlias) return fromAlias;
  }
  return "";
}

function accountBankKeys(account: ImportAccountMatchSource) {
  return [
    account.Institution?.name ?? "",
    account.Institution?.shortName ?? "",
    ...inferBankNames(account.name),
    ...expandBankName(account.Institution?.name ?? ""),
    ...expandBankName(account.Institution?.shortName ?? ""),
  ].map(normalizeImportAccountMatchKey).filter(Boolean);
}

function accountOwnerNames(account: ImportAccountMatchSource) {
  if (account.kind === "loan" || account.kind === "settlement") return [];
  return [account.AccountGroup?.name ?? ""]
    .map((name) => name.trim())
    .filter(Boolean);
}

function accountOwnerKeys(account: ImportAccountMatchSource) {
  return accountOwnerNames(account).map(normalizeImportAccountMatchKey).filter(Boolean);
}

function stripLeadingImportOwner(value: string, ownerName: string) {
  const pattern = new RegExp(`^\\s*(?:\\u6240\\u6709\\u4eba\\s*[:\\uff1a]?\\s*)?${escapeRegExp(ownerName)}(?:\\s*\\u7684|[\\s·•_\\-—/／\\\\()[\\]\\uff08\\uff09\\u3010\\u3011:\\uff1a]+)?\\s*`);
  return value.replace(pattern, "").trim();
}

function stripImportAccountScheduleSuffix(value: string) {
  return value.replace(ACCOUNT_SCHEDULE_SUFFIX_RE, "").trim();
}

function stripImportOwnerFieldPrefix(value: string) {
  return value.replace(/^\s*\u6240\u6709\u4eba\s*[:\uff1a]?\s*/, "").trim();
}

function stripLeadingInstitutionName(value: string, institutionNames: string[]) {
  let next = value.trim();
  for (const institutionName of institutionNames.sort((a, b) => b.length - a.length)) {
    if (!institutionName) continue;
    next = next.replace(new RegExp(`^\\s*${escapeRegExp(institutionName)}(?:\\s*\\u7684|[\\s·•_\\-—/／\\\\()[\\]\\uff08\\uff09\\u3010\\u3011:\\uff1a]+)?\\s*`), "").trim();
  }
  return next;
}

function inferBankDisplayName(value: string, canonicalName?: string) {
  const key = normalizeImportAccountMatchKey(value);
  if (!key) return canonicalName;
  for (const item of BANK_ALIASES) {
    const variants = [item.canonical, ...item.aliases]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const matched = variants.find((variant) => key.includes(normalizeImportAccountMatchKey(variant)));
    if (matched) return matched;
  }
  return canonicalName;
}
function inferOwnedInvestmentProductType(value: string): ImportOwnedMoneyAccountCandidate["investProductType"] | null {
  if (/\u8d27\u5e01\u57fa\u91d1/.test(value)) return "money";
  if (/\u7406\u8d22/.test(value)) return "wealth";
  if (/\u57fa\u91d1/.test(value)) return "fund";
  return null;
}
export function parseImportOwnedMoneyAccountCandidate(
  value: string | undefined | null,
  ownerNames: string[],
): ImportOwnedMoneyAccountCandidate | null {
  const raw = stripImportAccountScheduleSuffix(String(value ?? "").trim());
  if (!raw) return null;
  const ownerSearchText = stripImportOwnerFieldPrefix(raw);
  const rawKey = normalizeImportAccountMatchKey(ownerSearchText);
  const ownerName = ownerNames
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .find((name) => {
      const ownerKey = normalizeImportAccountMatchKey(name);
      return ownerKey && rawKey.startsWith(ownerKey) && rawKey.length > ownerKey.length;
    });
  if (!ownerName) return null;

  const accountPart = stripLeadingImportOwner(ownerSearchText, ownerName);
  if (!accountPart) return null;
  const inferredKind = inferAccountKind(accountPart);
  if (inferredKind === "bank_credit") return null;
  const bankNames = inferBankNames(accountPart);
  const bankDisplayName = inferBankDisplayName(accountPart, bankNames[0]);
  const last4 = extractImportAccountLast4(accountPart);
  const hasBankHint = bankNames.length > 0;
  const investProductType = inferOwnedInvestmentProductType(accountPart);
  const kind = inferredKind === "cash" || inferredKind === "ewallet" || inferredKind === "bank_debit"
    ? inferredKind
    : inferredKind === "investment" && investProductType
      ? "investment"
      : hasBankHint && last4
        ? "bank_debit"
        : null;
  if (kind !== "bank_debit" && kind !== "cash" && kind !== "ewallet" && kind !== "investment") return null;

  const withoutInstitution = stripLeadingInstitutionName(accountPart, bankNames);
  const fallbackName = kind === "bank_debit"
    ? "\u501f\u8bb0\u5361"
    : kind === "ewallet"
      ? "\u7535\u5b50\u94b1\u5305"
      : kind === "investment"
        ? investProductType === "wealth"
          ? "\u7406\u8d22"
          : investProductType === "money"
            ? "\u8d27\u5e01\u57fa\u91d1"
            : "\u57fa\u91d1"
        : "\u73b0\u91d1";
  const accountName = withoutInstitution || fallbackName;
  return {
    originalName: raw,
    accountName,
    ownerName,
    kind,
    investProductType: kind === "investment" ? investProductType ?? "fund" : undefined,
    institutionName: kind === "bank_debit" || kind === "ewallet" || kind === "investment" ? bankNames[0] : undefined,
    institutionDisplayName: kind === "bank_debit" || kind === "ewallet" || kind === "investment" ? bankDisplayName : undefined,
    numberMasked: kind === "bank_debit" ? last4 || undefined : undefined,
  };
}

function bankKeyMatchesAccount(account: ImportAccountMatchSource, targetBankNames: string[]) {
  const targetBankKeys = targetBankNames.map(normalizeImportAccountMatchKey).filter(Boolean);
  if (targetBankKeys.length === 0) return true;
  const bankKeys = accountBankKeys(account);
  return targetBankKeys.some((targetBankKey) =>
    bankKeys.some((bankKey) => bankKey.includes(targetBankKey) || targetBankKey.includes(bankKey)),
  );
}

export function getImportAccountIdentityConflict<T extends ImportAccountMatchSource>(
  selectedAccount: T | null | undefined,
  originalText: string | undefined,
  accounts: T[],
): ImportAccountIdentityConflict | null {
  return createImportAccountIdentityConflictChecker(accounts)(selectedAccount, originalText);
}

export function createImportAccountIdentityConflictChecker<T extends ImportAccountMatchSource>(accounts: T[]) {
  const matchImportAccount = createImportAccountMatcher(accounts);
  return (
    selectedAccount: T | null | undefined,
    originalText: string | undefined,
  ): ImportAccountIdentityConflict | null => {
  const original = String(originalText ?? "").trim();
  if (!original || !selectedAccount) return null;

  const directAccountId = parseImportAccountId(original);
  if (directAccountId) {
    return directAccountId === selectedAccount.id
      ? null
      : { kind: "account", originalText: original, selectedAccountId: selectedAccount.id, matchedAccountId: directAccountId };
  }

  const match = matchImportAccount(original);
  if (match.account) {
    return match.account.id === selectedAccount.id
      ? null
      : { kind: "account", originalText: original, selectedAccountId: selectedAccount.id, matchedAccountId: match.account.id };
  }

  if (match.ambiguousAccounts.length > 0) {
    return match.ambiguousAccounts.some((account) => account.id === selectedAccount.id)
      ? null
      : { kind: "ambiguous", originalText: original, selectedAccountId: selectedAccount.id };
  }

  if (match.targetKind && selectedAccount.kind && selectedAccount.kind !== match.targetKind) {
    return { kind: "kind", originalText: original, selectedAccountId: selectedAccount.id };
  }

  const originalLast4 = extractImportAccountLast4(original);
  const selectedLast4 = accountLast4(selectedAccount);
  if (originalLast4 && selectedLast4 && originalLast4 !== selectedLast4) {
    return { kind: "last4", originalText: original, selectedAccountId: selectedAccount.id };
  }

  if (match.targetBankNames.length > 0 && !bankKeyMatchesAccount(selectedAccount, match.targetBankNames)) {
    return { kind: "bank", originalText: original, selectedAccountId: selectedAccount.id };
  }

  return null;
  };
}

// Bare bank-name match keys ("招商银行"/"招行"/"招商", etc.). Account-side
// candidates still generate them so bank-only statement cells can match by
// institution, but composite input text must not collapse to these keys.
const BARE_BANK_NAME_MATCH_KEYS = new Set(
  BANK_ALIASES.flatMap((item) => [item.canonical, ...item.aliases])
    .map((name) => normalizeImportAccountMatchKey(name))
    .filter(Boolean),
);

export function buildImportAccountInputCandidates(value?: string) {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const candidates = expandImportAccountName(raw);
  // Composite inputs such as "张四·招行·8848" must not generate bare bank-name
  // exact candidates; otherwise they can exactly match every account at that
  // bank and turn an identifiable account into a false ambiguous match.
  // Preserve the old behavior only when the input itself is a bare bank name.
  if (BARE_BANK_NAME_MATCH_KEYS.has(normalizeImportAccountMatchKey(raw))) return candidates;
  return candidates.filter(
    (candidate) => !BARE_BANK_NAME_MATCH_KEYS.has(normalizeImportAccountMatchKey(candidate)),
  );
}

export function buildImportAccountCandidates(account: ImportAccountMatchSource) {
  const candidates = new Set<string>();
  const institutionNames = [
    account.Institution?.name?.trim() ?? "",
    account.Institution?.shortName?.trim() ?? "",
    ...inferBankNames(account.name),
  ].filter(Boolean);
  const ownerNames = accountOwnerNames(account);
  const accountNames = [account.name.trim(), ...accountKindNames(account.kind)];
  const last4 = accountLast4(account);
  const kindNames = accountKindNames(account.kind);

  for (const name of accountNames) {
    candidates.add(name);
    for (const ownerName of ownerNames) {
      candidates.add(`${ownerName}${name}`);
      candidates.add(`${ownerName}·${name}`);
      candidates.add(`${name}(${ownerName})`);
      candidates.add(`${name}·${ownerName}`);
      if (last4) {
        candidates.add(`${ownerName}${name}${last4}`);
        candidates.add(`${ownerName}${name}(${last4})`);
        candidates.add(`${ownerName}·${name}·${last4}`);
        candidates.add(`${name}(${ownerName})${last4}`);
        candidates.add(`${name}·${ownerName}·${last4}`);
      }
    }
    for (const institutionName of institutionNames) {
      candidates.add(`${institutionName}${name}`);
      candidates.add(`${institutionName}·${name}`);
      for (const kindName of kindNames) {
        candidates.add(`${institutionName}${name}${kindName}`);
        candidates.add(`${institutionName}·${name}·${kindName}`);
      }
      if (last4) {
        candidates.add(`${institutionName}${name}${last4}`);
        candidates.add(`${institutionName}${name}(${last4})`);
        candidates.add(`${institutionName}·${name}·${last4}`);
        for (const kindName of kindNames) {
          candidates.add(`${institutionName}${name}${last4}${kindName}`);
          candidates.add(`${institutionName}·${name}·${last4}·${kindName}`);
        }
      }
      for (const expandedInstitution of expandBankName(institutionName)) {
        candidates.add(`${expandedInstitution}${name}`);
        if (last4) candidates.add(`${expandedInstitution}${name}(${last4})`);
      }
      for (const ownerName of ownerNames) {
        candidates.add(`${institutionName}${name}(${ownerName})`);
        candidates.add(`${institutionName}·${name}(${ownerName})`);
        candidates.add(`${institutionName}${name}·${ownerName}`);
        candidates.add(`${institutionName}·${name}·${ownerName}`);
        candidates.add(`${ownerName}${institutionName}${name}`);
        candidates.add(`${ownerName}·${institutionName}·${name}`);
        candidates.add(`${ownerName}${institutionName}·${name}`);
        candidates.add(`${ownerName}·${institutionName}${name}`);
        for (const kindName of kindNames) {
          candidates.add(`${ownerName}${institutionName}${name}${kindName}`);
          candidates.add(`${ownerName}·${institutionName}·${name}·${kindName}`);
          candidates.add(`${ownerName}${institutionName}·${name}·${kindName}`);
          candidates.add(`${ownerName}·${institutionName}${name}${kindName}`);
        }
        if (last4) {
          candidates.add(`${ownerName}${institutionName}${name}${last4}`);
          candidates.add(`${ownerName}${institutionName}${name}(${last4})`);
          candidates.add(`${ownerName}·${institutionName}·${name}·${last4}`);
          candidates.add(`${institutionName}${name}(${ownerName})${last4}`);
          candidates.add(`${institutionName}·${name}(${ownerName})·${last4}`);
          for (const kindName of kindNames) {
            candidates.add(`${ownerName}${institutionName}${name}${last4}${kindName}`);
            candidates.add(`${ownerName}·${institutionName}·${name}·${last4}·${kindName}`);
          }
        }
        for (const expandedInstitution of expandBankName(institutionName)) {
          candidates.add(`${ownerName}${expandedInstitution}${name}`);
          candidates.add(`${ownerName}·${expandedInstitution}·${name}`);
          if (last4) candidates.add(`${ownerName}${expandedInstitution}${name}(${last4})`);
        }
      }
    }
    if (last4) {
      candidates.add(`${name}${last4}`);
      candidates.add(`${name}(${last4})`);
    }
  }

  if (account.AccountAlias) {
    for (const alias of account.AccountAlias) {
      for (const expanded of expandImportAccountName(alias.alias)) candidates.add(expanded);
    }
  }

  for (const value of [...candidates]) {
    for (const expanded of expandImportAccountName(value)) candidates.add(expanded);
  }

  return Array.from(candidates).filter(Boolean);
}

export function resolveImportAccountIdFromList(
  accountName: string | undefined,
  accounts: ImportAccountMatchSource[],
): string | null {
  return resolveImportAccountFromList(accountName, accounts)?.id ?? null;
}

export function createImportAccountMatcher<T extends ImportAccountMatchSource>(accounts: T[]) {
  const indexed = accounts.map((account) => ({
    account,
    last4: accountLast4(account),
    keys: buildImportAccountCandidates(account).map(normalizeImportAccountMatchKey).filter(Boolean),
    ownerKeys: accountOwnerKeys(account),
    bankKeys: [
      account.Institution?.name ?? "",
      account.Institution?.shortName ?? "",
      ...inferBankNames(account.name),
      ...expandBankName(account.Institution?.name ?? ""),
      ...expandBankName(account.Institution?.shortName ?? ""),
    ].map(normalizeImportAccountMatchKey).filter(Boolean),
  }));

  function bankKeyMatches(item: (typeof indexed)[number], targetBankKeys: string[]) {
    if (targetBankKeys.length === 0) return true;
    return targetBankKeys.some((targetBankKey) =>
      item.bankKeys.some((bankKey) => bankKey.includes(targetBankKey) || targetBankKey.includes(bankKey)),
    );
  }

  function ownerKeyMatches(item: (typeof indexed)[number], targetOwnerKeys: string[]) {
    if (targetOwnerKeys.length === 0) return true;
    return targetOwnerKeys.some((targetOwnerKey) => item.ownerKeys.includes(targetOwnerKey));
  }

  function inferTargetOwnerKeys(raw: string) {
    const rawText = raw.trim();
    const rawKey = normalizeImportAccountMatchKey(rawText);
    const ownerKeys = new Set<string>();
    for (const item of indexed) {
      for (const ownerKey of item.ownerKeys) {
        if (!ownerKey || rawKey === ownerKey || !rawKey.startsWith(ownerKey)) continue;
        const ownerName = accountOwnerNames(item.account).find((name) => normalizeImportAccountMatchKey(name) === ownerKey);
        if (!ownerName) continue;
        const ownerPrefix = new RegExp(`^\\s*(?:所有人\\s*[:：]?\\s*)?${escapeRegExp(ownerName)}(?:\\s*的|[\\s·•_\\-—/／\\\\()[\\]（）【】:：]|$)`);
        const restKey = rawKey.slice(ownerKey.length);
        const restHasAccountHint =
          inferBankNames(restKey).length > 0 ||
          inferAccountKind(restKey) !== null ||
          ACCOUNT_KIND_SEPARATOR_WORDS.some((word) => restKey.includes(normalizeImportAccountMatchKey(word)));
        if (ownerPrefix.test(rawText) || (restKey && restHasAccountHint)) ownerKeys.add(ownerKey);
      }
    }
    return Array.from(ownerKeys);
  }

  function result(
    account: T | null,
    ambiguousMatches: Array<(typeof indexed)[number]>,
    criteria: {
      targetKind: ImportAccountKind | null;
      targetBankNames: string[];
    },
  ): ImportAccountMatchResult<T> {
    const ambiguousAccounts = Array.from(new Map(ambiguousMatches.map((item) => [item.account.id, item.account])).values());
    return {
      account,
      ambiguousAccounts,
      targetKind: criteria.targetKind,
      targetBankNames: criteria.targetBankNames,
    };
  }

  function hasCompatibleLast4(item: (typeof indexed)[number], targetLast4: string) {
    return !targetLast4 || !item.last4 || item.last4 === targetLast4;
  }

  function pickUnique(matches: Array<(typeof indexed)[number]>, criteria: {
    last4: string;
    targetKind: ImportAccountKind | null;
    targetBankKeys: string[];
    targetOwnerKeys: string[];
  }) {
    let narrowed = matches;
    if (criteria.last4) narrowed = narrowed.filter((item) => item.last4 === criteria.last4);
    if (criteria.targetKind) narrowed = narrowed.filter((item) => !item.account.kind || item.account.kind === criteria.targetKind);
    if (criteria.targetBankKeys.length > 0) narrowed = narrowed.filter((item) => bankKeyMatches(item, criteria.targetBankKeys));
    if (criteria.targetOwnerKeys.length > 0) narrowed = narrowed.filter((item) => ownerKeyMatches(item, criteria.targetOwnerKeys));
    return narrowed.length === 1 ? narrowed[0].account : null;
  }

  function pickPaymentTailSource(matches: Array<(typeof indexed)[number]>) {
    const score = (item: (typeof indexed)[number]) => {
      const kind = item.account.kind;
      if (kind === "bank_debit") return 100;
      if (kind === "cash") return 90;
      if (kind === "ewallet") return 85;
      if (kind === "deposit") return 50;
      if (kind === "bank_credit") return 20;
      if (kind === "investment") return -50;
      if (kind === "loan" || kind === "settlement") return -60;
      return 0;
    };
    const ranked = matches
      .map((item) => ({ item, score: score(item) }))
      .sort((a, b) => b.score - a.score);
    if (ranked.length === 0) return null;
    const topScore = ranked[0].score;
    const topMatches = ranked.filter((item) => item.score === topScore);
    return topMatches.length === 1 ? topMatches[0].item.account : null;
  }

  function pickUnionPayDebitSource(matches: Array<(typeof indexed)[number]>) {
    const debitMatches = matches.filter((item) => item.account.kind === "bank_debit");
    if (debitMatches.length === 1) return debitMatches[0].account;
    return null;
  }

  function pickAlipayBalanceProduct(raw: string) {
    const key = normalizeImportAccountMatchKey(raw);
    if (!key || key.includes(normalizeImportAccountMatchKey("余利宝"))) return null;
    const isGenericAlipayInvestment =
      key.includes(normalizeImportAccountMatchKey("支付宝投资类")) ||
      key.endsWith(normalizeImportAccountMatchKey("支付宝投资")) ||
      key.includes(normalizeImportAccountMatchKey("支付宝理财类")) ||
      key.endsWith(normalizeImportAccountMatchKey("支付宝理财"));
    if (!key.includes(normalizeImportAccountMatchKey("余额宝")) && !isGenericAlipayInvestment) return null;

    const alipayKeys = expandBankName("支付宝").map(normalizeImportAccountMatchKey).filter(Boolean);
    const yuebaoKey = normalizeImportAccountMatchKey("余额宝");
    const matches = indexed.filter((item) => {
      if (item.account.kind && item.account.kind !== "ewallet") return false;
      if (!bankKeyMatches(item, alipayKeys)) return false;
      return item.keys.some((candidateKey) => candidateKey === yuebaoKey || candidateKey.includes(yuebaoKey));
    });
    return matches.length === 1 ? matches[0].account : null;
  }

  function pickUniqueThirdPartyPaymentProduct(raw: string) {
    const key = normalizeImportAccountMatchKey(raw);
    if (!key) return null;
    const productGroups = [
      {
        bank: "\u5fae\u4fe1",
        aliases: ["\u5fae\u4fe1\u96f6\u94b1\u901a", "\u5fae\u4fe1\u96f6\u94b1\u5b9d", "\u96f6\u94b1\u901a", "\u96f6\u94b1\u5b9d"],
      },
      {
        bank: "\u5fae\u4fe1",
        aliases: ["\u5fae\u4fe1\u96f6\u94b1", "\u96f6\u94b1"],
        excludes: ["\u96f6\u94b1\u901a", "\u96f6\u94b1\u5b9d"],
      },
      {
        bank: "\u652f\u4ed8\u5b9d",
        aliases: ["\u652f\u4ed8\u5b9d\u4f59\u989d\u5b9d", "\u4f59\u989d\u5b9d"],
      },
      {
        bank: "\u652f\u4ed8\u5b9d",
        aliases: ["\u652f\u4ed8\u5b9d\u4f59\u989d", "\u8d26\u6237\u4f59\u989d", "\u4f59\u989d"],
        excludes: ["\u4f59\u989d\u5b9d"],
      },
      {
        bank: "\u652f\u4ed8\u5b9d",
        aliases: ["\u652f\u4ed8\u5b9d\u82b1\u5457", "\u82b1\u5457"],
      },
      {
        bank: "\u4eac\u4e1c",
        aliases: ["\u4eac\u4e1c\u5c0f\u91d1\u5e93", "\u5c0f\u91d1\u5e93"],
        targetKind: "ewallet",
      },
      {
        bank: "\u4eac\u4e1c\u91d1\u878d",
        aliases: ["\u4eac\u4e1c\u767d\u6761", "\u767d\u6761"],
      },
    ];

    for (const group of productGroups) {
      const aliasKeys = group.aliases.map(normalizeImportAccountMatchKey).filter(Boolean);
      if (!aliasKeys.some((aliasKey) => key.includes(aliasKey))) continue;
      const excludeKeys = (group.excludes ?? []).map(normalizeImportAccountMatchKey).filter(Boolean);
      if (excludeKeys.some((excludeKey) => key.includes(excludeKey))) continue;

      const bankKeys = expandBankName(group.bank).map(normalizeImportAccountMatchKey).filter(Boolean);
      const matches = indexed.filter((item) =>
        (!group.targetKind || item.account.kind === group.targetKind) &&
        bankKeyMatches(item, bankKeys) &&
        item.keys.some((candidateKey) => aliasKeys.includes(candidateKey)),
      );
      if (matches.length === 1) return matches[0].account;
      if (matches.length > 1) return null;
    }

    return null;
  }

  return (accountName: string | undefined): ImportAccountMatchResult<T> => {
    const raw = String(accountName ?? "").trim();
    if (!raw) return result(null, [], { targetKind: null, targetBankNames: [] });

    const targetKind = inferAccountKind(raw);
    const targetBankNames = inferBankNames(raw);
    const targetBankKeys = targetBankNames.map(normalizeImportAccountMatchKey);
    const targetOwnerKeys = inferTargetOwnerKeys(raw);

    const directAccountId = parseImportAccountId(raw);
    if (directAccountId) {
      return result(indexed.find((item) => item.account.id === directAccountId)?.account ?? null, [], { targetKind, targetBankNames });
    }

    const targetKeys = buildImportAccountInputCandidates(raw).map(normalizeImportAccountMatchKey).filter(Boolean);
    if (targetKeys.length === 0) return result(null, [], { targetKind, targetBankNames });

    const last4 = extractImportAccountLast4(raw);

    for (const targetKey of targetKeys) {
      const exactMatches = indexed.filter((item) => item.keys.includes(targetKey));
      const compatibleExactMatches = exactMatches.filter((item) => hasCompatibleLast4(item, last4));
      if (compatibleExactMatches.length > 0) {
        const narrowed = pickUnique(compatibleExactMatches, { last4, targetKind, targetBankKeys, targetOwnerKeys });
        if (narrowed) return result(narrowed, [], { targetKind, targetBankNames });
        if (
          compatibleExactMatches.length === 1 &&
          (!targetKind || !compatibleExactMatches[0].account.kind || compatibleExactMatches[0].account.kind === targetKind)
        ) {
          return result(compatibleExactMatches[0].account, [], { targetKind, targetBankNames });
        }
        if (!targetKind && compatibleExactMatches.length > 1 && isImportUnionPayDebitTailSourceHint(raw)) {
          const paymentSource = pickUnionPayDebitSource(compatibleExactMatches);
          if (paymentSource) return result(paymentSource, [], { targetKind, targetBankNames });
        }
        if (!targetKind && compatibleExactMatches.length > 1 && isBareLast4Hint(raw)) {
          const paymentSource = pickPaymentTailSource(compatibleExactMatches);
          if (paymentSource) return result(paymentSource, [], { targetKind, targetBankNames });
        }
        if (!targetKind && compatibleExactMatches.length > 1) {
          return result(null, compatibleExactMatches, { targetKind, targetBankNames });
        }
      }
    }

    // "XX的往来款" pattern: try to match extracted counterparty name directly
    // against loan account names, bypassing kind-alias partial matching.
    if (targetKind === "settlement") {
      const counterpartyName = parseDebtAccountName(raw);
      if (counterpartyName) {
        const cKey = normalizeImportAccountMatchKey(counterpartyName);
        if (cKey) {
          const loanMatches = indexed.filter(
            (item) => (item.account.kind === "settlement" || item.account.kind === "loan") && item.keys.includes(cKey),
          );
          if (loanMatches.length === 1) {
            return result(loanMatches[0].account, [], { targetKind, targetBankNames });
          }
        }
      }
    }

    if (last4) {
      const byLast4 = indexed.filter((item) => {
        if (item.last4 !== last4) return false;
        if (targetKind && item.account.kind && targetKind !== item.account.kind) return false;
        if (!ownerKeyMatches(item, targetOwnerKeys)) return false;
        return bankKeyMatches(item, targetBankKeys);
      });
      if (byLast4.length === 1) return result(byLast4[0].account, [], { targetKind, targetBankNames });
      if (byLast4.length > 1 && isImportUnionPayDebitTailSourceHint(raw)) {
        const paymentSource = pickUnionPayDebitSource(byLast4);
        if (paymentSource) return result(paymentSource, [], { targetKind, targetBankNames });
      }
      if (byLast4.length > 1 && isImportPaymentTailSourceHint(raw)) {
        const paymentSource = pickPaymentTailSource(byLast4);
        if (paymentSource) return result(paymentSource, [], { targetKind, targetBankNames });
      }
      if (byLast4.length > 1 && !targetKind && isBareLast4Hint(raw)) {
        const paymentSource = pickPaymentTailSource(byLast4);
        if (paymentSource) return result(paymentSource, [], { targetKind, targetBankNames });
      }
      if (byLast4.length > 1) return result(null, byLast4, { targetKind, targetBankNames });
    }

    const alipayBalanceProduct = pickAlipayBalanceProduct(raw);
    if (alipayBalanceProduct) return result(alipayBalanceProduct, [], { targetKind, targetBankNames });

    const uniqueThirdPartyPaymentProduct = pickUniqueThirdPartyPaymentProduct(raw);
    if (uniqueThirdPartyPaymentProduct) {
      return result(uniqueThirdPartyPaymentProduct, [], { targetKind, targetBankNames });
    }

    if (targetKind && targetBankKeys.length > 0) {
      const byBankAndKind = indexed.filter((item) => {
        if (item.account.kind !== targetKind) return false;
        if (!hasCompatibleLast4(item, last4)) return false;
        if (!ownerKeyMatches(item, targetOwnerKeys)) return false;
        return bankKeyMatches(item, targetBankKeys);
      });
      if (byBankAndKind.length === 1) return result(byBankAndKind[0].account, [], { targetKind, targetBankNames });
      if (byBankAndKind.length > 1) return result(null, byBankAndKind, { targetKind, targetBankNames });
    }

    for (const targetKey of targetKeys) {
      const partialMatches = indexed.filter((item) =>
        item.keys.some((key) => key.length >= 3 && (targetKey.includes(key) || key.includes(targetKey))),
      );
      const compatiblePartialMatches = partialMatches.filter((item) => {
        if (!hasCompatibleLast4(item, last4)) return false;
        if (targetKind && item.account.kind && item.account.kind !== targetKind) return false;
        if (targetBankKeys.length > 0 && !bankKeyMatches(item, targetBankKeys)) return false;
        if (!ownerKeyMatches(item, targetOwnerKeys)) return false;
        return true;
      });
      if (compatiblePartialMatches.length === 1) {
        return result(compatiblePartialMatches[0].account, [], { targetKind, targetBankNames });
      }
      if (compatiblePartialMatches.length > 1) {
        const narrowed = pickUnique(compatiblePartialMatches, { last4, targetKind, targetBankKeys, targetOwnerKeys });
        if (narrowed) return result(narrowed, [], { targetKind, targetBankNames });
        return result(null, compatiblePartialMatches, { targetKind, targetBankNames });
      }
    }

    return result(null, [], { targetKind, targetBankNames });
  };
}

export function createImportAccountResolver<T extends ImportAccountMatchSource>(accounts: T[]) {
  const matchImportAccount = createImportAccountMatcher(accounts);
  return (accountName: string | undefined): T | null => {
    return matchImportAccount(accountName).account;
  };
}

export function resolveImportAccountFromList<T extends ImportAccountMatchSource>(
  accountName: string | undefined,
  accounts: T[],
): T | null {
  return createImportAccountResolver(accounts)(accountName);
}

function accountKindNames(kind?: ImportAccountKind | null) {
  if (kind === "bank_credit") return ["信用卡"];
  if (kind === "bank_debit") return ["储蓄卡", "借记卡"];
  if (kind === "ewallet") return ["电子钱包", "钱包"];
  if (kind === "cash") return ["现金"];
  if (kind === "investment") return ["投资账户", "投资"];
  if (kind === "loan" || kind === "settlement") return [];
  return [];
}

function inferAccountKind(value: string): ImportAccountKind | null {
  const key = normalizeImportAccountMatchKey(value);
  for (const item of ACCOUNT_KIND_ALIASES) {
    if (item.aliases.some((alias) => key.includes(normalizeImportAccountMatchKey(alias)))) return item.kind;
  }
  return null;
}

function inferBankNames(value: string) {
  const key = normalizeImportAccountMatchKey(value);
  const names = new Set<string>();
  for (const item of BANK_ALIASES) {
    const variants = [item.canonical, ...item.aliases];
    if (variants.some((variant) => key.includes(normalizeImportAccountMatchKey(variant)))) {
      for (const variant of variants) names.add(variant);
    }
  }
  return Array.from(names);
}

export function expandImportBankName(value: string) {
  const key = normalizeImportAccountMatchKey(value);
  const names = new Set<string>();
  if (value.trim()) names.add(value.trim());
  for (const item of BANK_ALIASES) {
    const variants = [item.canonical, ...item.aliases];
    if (variants.some((variant) => key.includes(normalizeImportAccountMatchKey(variant)))) {
      for (const variant of variants) names.add(variant);
    }
  }
  return Array.from(names);
}

function expandBankName(value: string) {
  return expandImportBankName(value);
}

function stripAccountKindSeparatorWords(value: string) {
  const names = new Set<string>();
  for (const word of ACCOUNT_KIND_SEPARATOR_WORDS) {
    const normalizedWord = normalizeImportAccountMatchKey(word);
    const key = normalizeImportAccountMatchKey(value);
    if (!normalizedWord || !key.includes(normalizedWord)) continue;
    const next = value.replaceAll(word, "").trim();
    if (next) names.add(next);
  }
  return Array.from(names);
}

function expandImportAccountName(value: string) {
  const trimmed = value.trim();
  const withoutScheduleSuffix = stripImportAccountScheduleSuffix(trimmed);
  const names = new Set<string>([trimmed]);
  if (withoutScheduleSuffix && withoutScheduleSuffix !== trimmed) names.add(withoutScheduleSuffix);
  const last4 = extractImportAccountLast4(value);
  const kinds = new Set<string>();
  const banks = inferBankNames(value);
  const kind = inferAccountKind(value);
  if (kind === "bank_credit") kinds.add("信用卡");
  if (kind === "bank_debit") {
    kinds.add("储蓄卡");
    kinds.add("借记卡");
  }
  if (kind === "ewallet") {
    kinds.add("电子钱包");
    kinds.add("钱包");
  }
  if (kind === "cash") kinds.add("现金");
  if (kind === "investment") kinds.add("投资账户");
  if (kind === "loan" || kind === "settlement") {}

  for (const kindName of kinds) {
    const normalizedKindName = normalizeImportAccountMatchKey(kindName);
    const withoutKind = Array.from(names)
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => ({ name, key: normalizeImportAccountMatchKey(name) }))
      .filter((item) => item.key.endsWith(normalizedKindName))
      .map((item) => item.name.slice(0, Math.max(0, item.name.length - kindName.length)).trim());
    for (const name of withoutKind) {
      if (name) names.add(name);
    }
  }

  for (const bank of banks) {
    names.add(bank);
    for (const cardKind of kinds) {
      names.add(`${bank}${cardKind}`);
      if (last4) {
        names.add(`${bank}${cardKind}${last4}`);
        names.add(`${bank}${cardKind}(${last4})`);
      }
    }
  }

  for (const name of [...names]) {
    for (const stripped of stripAccountKindSeparatorWords(name)) names.add(stripped);
  }

  return Array.from(names).filter(Boolean);
}
