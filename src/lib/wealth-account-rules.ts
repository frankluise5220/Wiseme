const THIRD_PARTY_INSTITUTION_TYPES = new Set(["payment", "ewallet"]);

export function isThirdPartyWealthInstitutionType(type: string | null | undefined) {
  return THIRD_PARTY_INSTITUTION_TYPES.has(String(type ?? "").trim());
}

export function isWealthAccountAllowedForCashAccount(input: {
  cashGroupId: string;
  cashInstitutionId?: string | null;
  wealthGroupId: string;
  wealthInstitutionId?: string | null;
  wealthInstitutionType?: string | null;
}) {
  if (input.cashGroupId !== input.wealthGroupId) return false;
  if (input.cashInstitutionId && input.cashInstitutionId === input.wealthInstitutionId) return true;
  return isThirdPartyWealthInstitutionType(input.wealthInstitutionType);
}
