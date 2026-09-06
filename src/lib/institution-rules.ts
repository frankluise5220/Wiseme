export const INCOME_EXPENSE_INSTITUTION_TYPES = ["bank", "payment"] as const;

const incomeExpenseInstitutionTypeSet = new Set<string>(INCOME_EXPENSE_INSTITUTION_TYPES);

export function isIncomeExpenseInstitutionType(type: string | null | undefined) {
  return incomeExpenseInstitutionTypeSet.has(String(type ?? "").trim());
}

export function filterIncomeExpenseInstitutions<T extends { type?: string | null }>(items: T[]) {
  return items.filter((item) => isIncomeExpenseInstitutionType(item.type));
}
