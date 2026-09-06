import type { AccountKind, Prisma } from "@prisma/client";

type AccountIdentityStore = {
  account: {
    findMany(args: {
      where: Prisma.AccountWhereInput;
      select: {
        id: true;
        name: true;
        kind: true;
        numberMasked: true;
        Institution: { select: { name: true; shortName: true } };
        AccountGroup: { select: { name: true } };
      };
    }): Promise<Array<{
      id: string;
      name: string;
      kind: string;
      numberMasked: string | null;
      Institution: { name: string | null; shortName: string | null } | null;
      AccountGroup: { name: string | null } | null;
    }>>;
  };
};

export class AccountIdentityUniqueError extends Error {
  status = 409;

  constructor(message: string) {
    super(message);
    this.name = "AccountIdentityUniqueError";
  }
}

export function isAccountIdentityUniqueError(error: unknown): error is AccountIdentityUniqueError {
  return error instanceof AccountIdentityUniqueError;
}

export function accountSupportsNumberMasked(kind: string | null | undefined) {
  return kind === "bank_debit" || kind === "bank_credit";
}

function normalizeText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeComparable(value: unknown) {
  return normalizeText(value).toLowerCase();
}

function normalizeTail(value: unknown) {
  return normalizeText(value).replace(/\s+/g, "");
}

function extractTailFromName(name: unknown) {
  const value = normalizeText(name);
  const match = value.match(/[（(]?\s*([0-9A-Za-z]{4})\s*[）)]?$/);
  return match?.[1] ? normalizeTail(match[1]) : "";
}

function identityTail(name: unknown, numberMasked: unknown) {
  return normalizeTail(numberMasked) || extractTailFromName(name);
}

function kindLabel(kind: string) {
  const labels: Record<string, string> = {
    cash: "现金",
    bank_debit: "借记卡",
    bank_credit: "信用卡",
    ewallet: "电子钱包",
    deposit: "存款",
    investment: "投资",
    loan: "债务/债权",
    insurance: "保险",
    other: "其他",
  };
  return labels[kind] ?? kind;
}

function formatAccountIdentity(account: {
  name: string;
  kind: string;
  numberMasked?: string | null;
  Institution?: { name: string | null; shortName: string | null } | null;
  AccountGroup?: { name: string | null } | null;
}) {
  const owner = account.kind === "loan" || account.kind === "settlement" ? "" : account.AccountGroup?.name?.trim() || "";
  const institution = account.Institution?.shortName?.trim() || account.Institution?.name?.trim() || "";
  const tailOrName = identityTail(account.name, account.numberMasked) || account.name.trim();
  return [owner, institution, tailOrName, kindLabel(account.kind)].filter(Boolean).join("·");
}

export async function assertAccountIdentityUnique(
  store: AccountIdentityStore,
  input: {
    householdId: string;
    groupId: string;
    institutionId: string | null;
    counterpartyId?: string | null;
    kind: string;
    name: unknown;
    numberMasked?: unknown;
    excludeId?: string | null;
  },
) {
  const name = normalizeText(input.name);
  if (!name) throw new AccountIdentityUniqueError("账户名称不能为空");

  const kind = normalizeText(input.kind);
  const tail = accountSupportsNumberMasked(kind) ? identityTail(name, input.numberMasked) : "";
  const candidates = await store.account.findMany({
    where: {
      householdId: input.householdId,
      groupId: input.groupId,
      institutionId: input.institutionId,
      ...(input.counterpartyId !== undefined ? { counterpartyId: input.counterpartyId } : {}),
      kind: kind as AccountKind,
      isPlaceholder: { not: true },
      ...(input.excludeId ? { id: { not: input.excludeId } } : {}),
    },
    select: {
      id: true,
      name: true,
      kind: true,
      numberMasked: true,
      Institution: { select: { name: true, shortName: true } },
      AccountGroup: { select: { name: true } },
    },
  });

  const normalizedName = normalizeComparable(name);
  const conflict = candidates.find((account) => {
    const accountTail = accountSupportsNumberMasked(account.kind)
      ? identityTail(account.name, account.numberMasked)
      : "";
    if (tail && accountTail) return normalizeComparable(accountTail) === normalizeComparable(tail);
    return normalizeComparable(account.name) === normalizedName;
  });

  if (conflict) {
    throw new AccountIdentityUniqueError(`账户“${formatAccountIdentity(conflict)}”已存在`);
  }
}
