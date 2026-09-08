export const FIXED_ASSET_EXPENSE_CATEGORY_NAME = "\u56fa\u5b9a\u8d44\u4ea7";
export const FIXED_ASSET_INVEST_PRODUCT_TYPE = "property";
export const FIXED_ASSET_ACCOUNT_KIND = "fixed_asset";

export const FIXED_ASSET_TYPES = [
  "property",
  "vehicle",
  "equipment",
  "furniture",
  "collectible",
  "other",
] as const;

export type FixedAssetType = (typeof FIXED_ASSET_TYPES)[number];

export function isFixedAssetType(value: string | null | undefined): value is FixedAssetType {
  return FIXED_ASSET_TYPES.includes(value as FixedAssetType);
}

export function normalizeFixedAssetType(value: unknown): FixedAssetType {
  return isFixedAssetType(String(value ?? "").trim()) ? (String(value ?? "").trim() as FixedAssetType) : "property";
}

export type FixedAssetAccountLike = {
  kind?: string | null;
  investProductType?: string | null;
};

export function isFixedAssetExpenseCategoryName(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  const leaf = raw.includes(".") ? raw.split(".").pop() ?? raw : raw;
  return leaf.trim() === FIXED_ASSET_EXPENSE_CATEGORY_NAME;
}

export function isFixedAssetExpenseCategoryPath(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  return raw.split(".").some((part) => part.trim() === FIXED_ASSET_EXPENSE_CATEGORY_NAME);
}

export function isFixedAssetAccountLike(account: FixedAssetAccountLike | null | undefined) {
  return account?.kind === FIXED_ASSET_ACCOUNT_KIND || (account?.kind === "investment" && account.investProductType === FIXED_ASSET_INVEST_PRODUCT_TYPE);
}

export function userFacingAccountKind(account: FixedAssetAccountLike | null | undefined): string {
  return isFixedAssetAccountLike(account) ? FIXED_ASSET_ACCOUNT_KIND : (account?.kind ?? "other");
}
