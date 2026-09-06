export const STOCK_ACCOUNT_INSTITUTION_ERROR = "Stock accounts must use a brokerage institution";
export const ACCOUNT_INSTITUTION_REQUIRED_ERROR = "This account type requires an institution";
export const ACCOUNT_INSTITUTION_TYPE_ERROR = "Institution type does not match the account type";

export function isStockInvestmentAccount(kind: string | null | undefined, investProductType: string | null | undefined) {
  return kind === "investment" && investProductType === "stock";
}

export function isStockAccountInstitutionType(type: string | null | undefined) {
  return type === "brokerage";
}

// Consumer loans use financial institutions; counterparty debt units are settlement owners.
export function isConsumerLoanInstitutionType(type: string | null | undefined) {
  return !!type && ["bank", "debt"].includes(type);
}

export function allowedInstitutionTypesForAccount(
  kind: string | null | undefined,
  investProductType: string | null | undefined,
  options?: { includeLegacyDebtInstitution?: boolean },
) {
  const accountKind = kind ?? "";
  const productType = investProductType ?? "";
  if (accountKind === "fixed_asset" || productType === "property") return [];
  if (accountKind === "bank_credit" || accountKind === "bank_debit" || accountKind === "deposit") return ["bank"];
  if (accountKind === "ewallet") return ["payment"];
  if (accountKind === "insurance") return ["insurance"];
  if (accountKind === "loan") {
    return options?.includeLegacyDebtInstitution ? ["bank", "debt", "payment", "other"] : ["bank", "debt"];
  }
  if (accountKind === "settlement") {
    return options?.includeLegacyDebtInstitution ? ["person", "organization"] : [];
  }
  if (accountKind === "investment") {
    if (productType === "stock") return ["brokerage"];
    if (productType === "fund" || productType === "money") return ["bank", "brokerage", "fund_company", "payment"];
    if (productType === "wealth" || productType === "deposit") return ["bank"];
    if (productType === "metal") return ["bank", "brokerage", "other"];
    return ["other"];
  }
  if (accountKind === "cash") return [];
  return ["bank", "payment", "other"];
}

export function accountRequiresInstitution(kind: string | null | undefined, investProductType: string | null | undefined) {
  const accountKind = kind ?? "";
  const productType = investProductType ?? "";
  if (accountKind === "fixed_asset" || productType === "property") return false;
  return accountKind === "bank_credit" ||
    accountKind === "bank_debit" ||
    accountKind === "ewallet" ||
    accountKind === "deposit" ||
    accountKind === "investment" ||
    accountKind === "insurance";
}

export function accountInstitutionTypeIsAllowed(
  kind: string | null | undefined,
  investProductType: string | null | undefined,
  institutionType: string | null | undefined,
  options?: { includeLegacyDebtInstitution?: boolean },
) {
  if (!institutionType) return false;
  return allowedInstitutionTypesForAccount(kind, investProductType, options).includes(institutionType);
}
