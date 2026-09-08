type HouseholdLike = {
  id?: string | null;
  name?: string | null;
};

export function looksLikeInternalHouseholdId(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return /^c[a-z0-9]{8,}$/i.test(trimmed);
}

export function getHouseholdDisplayName(household: HouseholdLike | null | undefined, fallback = "默认账簿") {
  const id = household?.id?.trim() ?? "";
  const name = household?.name?.trim() ?? "";

  if (name && name !== id && !looksLikeInternalHouseholdId(name)) {
    return name;
  }

  return fallback;
}
