export type I18nT = (key: string, params?: Record<string, string | number>) => string;

// Catalog keys for account-kind labels; keep in sync with the account.kind.* entries in i18n-core.ts.
const KIND_LABEL_KEYS: Record<string, string> = {
  cash: "account.kind.cash",
  bank_debit: "account.kind.bank_debit",
  bank_credit: "account.kind.bank_credit",
  ewallet: "account.kind.ewallet",
  deposit: "account.kind.deposit",
  investment: "account.kind.investment",
  fixed_asset: "account.kind.fixed_asset",
  settlement: "account.kind.settlement",
  loan: "account.kind.loan",
  insurance: "account.kind.insurance",
  other: "account.kind.other",
  bank_savings: "account.kind.bank_savings",
};

// Legacy account-kind labels kept as data for callers without a `t` function
// (server pages and shared libs). New code should pass `t` to kindLabel().
const KIND_LABEL_FALLBACK: Record<string, string> = {
  cash: "现金",
  bank_debit: "借记卡",
  bank_credit: "信用卡",
  ewallet: "电子钱包",
  deposit: "存款",
  investment: "投资",
  fixed_asset: "固定资产",
  settlement: "往来款",
  loan: "贷款",
  insurance: "保险",
  other: "其他",
  bank_savings: "储蓄卡",
};

export function kindLabel(k: string, t?: I18nT): string {
  const key = KIND_LABEL_KEYS[k];
  if (t && key) return t(key);
  return KIND_LABEL_FALLBACK[k] || k;
}

// Catalog keys for investment-product-category labels; keep in sync with the
// investment.product.* entries in i18n-core.ts.
const INVEST_PRODUCT_TYPE_LABEL_KEYS: Record<string, string> = {
  fund: "investment.product.fund",
  money: "investment.product.money",
  wealth: "investment.product.wealth",
  metal: "investment.product.metal",
  stock: "investment.product.stock",
  property: "investment.product.property",
};

// Legacy investment-product-category labels as fallback data for callers
// without a `t` function (server pages and shared libs).
const INVEST_PRODUCT_TYPE_LABEL_FALLBACK: Record<string, string> = {
  fund: "开放式基金",
  money: "货币基金",
  wealth: "银行理财",
  metal: "贵金属",
  stock: "股票",
  property: "固定资产",
};

export function investProductTypeLabel(p: string | null, t?: I18nT): string {
  const key = INVEST_PRODUCT_TYPE_LABEL_KEYS[p ?? ""];
  if (t && key) return t(key);
  return INVEST_PRODUCT_TYPE_LABEL_FALLBACK[p ?? ""] ?? t?.("account.kind.investment") ?? "投资";
}

export function kindColor(k: string): string {
  if (k === "bank_credit") return "bg-amber-50 text-amber-700 border-amber-200";
  if (k === "bank_debit") return "bg-slate-50 text-slate-700 border-slate-200";
  if (k === "ewallet") return "bg-blue-50 text-blue-700 border-blue-200";
  if (k === "cash") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (k === "deposit") return "bg-cyan-50 text-cyan-700 border-cyan-200";
  if (k === "investment") return "bg-purple-50 text-purple-700 border-purple-200";
  if (k === "fixed_asset") return "bg-orange-50 text-orange-700 border-orange-200";
  if (k === "loan" || k === "settlement") return "bg-red-50 text-red-700 border-red-200";
  if (k === "insurance") return "bg-indigo-50 text-indigo-700 border-indigo-200";
  return "bg-slate-50 text-slate-700 border-slate-200";
}

export function kindHex(k: string): string {
  if (k === "bank_credit") return "#F59E0B";
  if (k === "bank_debit") return "#94A3B8";
  if (k === "ewallet") return "#3B82F6";
  if (k === "cash") return "#10B981";
  if (k === "deposit") return "#06B6D4";
  if (k === "investment") return "#8B5CF6";
  if (k === "fixed_asset") return "#F97316";
  if (k === "loan" || k === "settlement") return "#EF4444";
  if (k === "insurance") return "#6366F1";
  return "#64748B";
}

export function kindIconName(k: string): string {
  if (k === "bank_credit") return "credit-card";
  if (k === "bank_debit") return "landmark";
  if (k === "ewallet") return "wallet";
  if (k === "cash") return "banknote";
  if (k === "deposit") return "piggy-bank";
  if (k === "investment") return "piggy-bank";
  if (k === "fixed_asset") return "building-2";
  if (k === "loan") return "building-2";
  if (k === "settlement") return "hand-coins";
  if (k === "insurance") return "shield";
  return "building-2";
}

// Catalog keys for institution-type labels; keep in sync with the institution.type.* entries in i18n-core.ts.
const INSTITUTION_TYPE_LABEL_KEYS: Record<string, string> = {
  family_member: "institution.type.family_member",
  person: "institution.type.person",
  organization: "institution.type.organization",
  bank: "institution.type.bank",
  insurance: "institution.type.insurance",
  brokerage: "institution.type.brokerage",
  fund_company: "institution.type.fund_company",
  payment: "institution.type.payment",
  debt: "institution.type.debt",
  other: "institution.type.other",
};

// Legacy institution-type labels kept as data for callers without a `t` function.
const INSTITUTION_TYPE_LABEL_FALLBACK: Record<string, string> = {
  family_member: "家庭成员",
  person: "往来人员",
  organization: "往来组织",
  bank: "银行",
  insurance: "保险公司",
  brokerage: "证券",
  fund_company: "Fund Company",
  payment: "第三方支付",
  debt: "债权债务",
  other: "其他",
};

export function institutionTypeLabel(type: string | null, t?: I18nT): string {
  const key = INSTITUTION_TYPE_LABEL_KEYS[type ?? "other"];
  if (t && key) return t(key);
  return INSTITUTION_TYPE_LABEL_FALLBACK[type ?? "other"] ?? type ?? INSTITUTION_TYPE_LABEL_FALLBACK.other;
}

export function institutionTypeIconName(t: string | null): string {
  if (t === "bank") return "landmark";
  if (t === "insurance") return "shield";
  if (t === "brokerage") return "building-2";
  if (t === "fund_company") return "building-2";
  if (t === "payment") return "credit-card";
  if (t === "debt") return "hand-coins";
  return "building-2";
}

export const kindOrder: string[] = [
  "cash",
  "bank_debit",
  "bank_credit",
  "ewallet",
  "deposit",
  "investment",
  "fixed_asset",
  "insurance",
  "settlement",
  "loan",
  "other",
];
