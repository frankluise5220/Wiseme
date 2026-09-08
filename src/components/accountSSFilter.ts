"use client";

import { useCallback, useMemo, useState } from "react";
import type { SmartSelectOption } from "./SmartSelect";

/**
 * Account-type buckets for cycling account SmartSelect dropdowns.
 *
 * The dropdown's cycle button (Repeat icon) filters the dropdown to one bucket
 * at a time, cycling through: 资金账户 → 投资账户 → 信用卡 → 其他账户.
 */
export type AccountTypeBucket = "fund" | "invest" | "credit" | "other";

/** Buckets in the canonical cycle order (empty selection "全部" sits before these). */
export const ACCOUNT_TYPE_BUCKET_ORDER: ReadonlyArray<AccountTypeBucket> = [
  "fund",
  "invest",
  "credit",
  "other",
];

// Kind membership per bucket.
const FUND_KINDS = new Set(["cash", "bank_debit", "ewallet", "deposit"]);
const INVEST_KINDS = new Set(["investment"]);
const CREDIT_KINDS = new Set(["bank_credit"]);

/** Maps an account kind to its bucket, or null for unknown/missing kind. */
export function accountTypeBucketOfKind(kind?: string | null): AccountTypeBucket | null {
  if (!kind) return null;
  if (FUND_KINDS.has(kind)) return "fund";
  if (INVEST_KINDS.has(kind)) return "invest";
  if (CREDIT_KINDS.has(kind)) return "credit";
  return "other";
}

export const ACCOUNT_TYPE_BUCKET_LABEL_KEYS: Record<AccountTypeBucket, string> = {
  fund: "accountTypeBucket.fund",
  invest: "accountTypeBucket.invest",
  credit: "accountTypeBucket.credit",
  other: "accountTypeBucket.other",
};

/**
 * Shared account SmartSelect filtering driven by the account-type cycle.
 *
 * The cycle button now rotates 资金账户 / 投资账户 / 信用卡 / 其他账户, and the
 * dropdown only shows accounts of the selected type ("全部" shows everything).
 *
 * The optional second argument is a *controlled* type filter value used to keep
 * several dropdowns in the same dialog in sync (e.g. a transfer target following
 * the selected account's type). When omitted the filter is held locally.
 *
 * `typeFilterLabel` is a resolver producing the display name for a bucket (returns
 * "全部" for the empty value). Pass the localized label so the cycle button's
 * tooltip shows a type name instead of a person's name.
 */
export function useAccountSSFilter(
  accountSSOptions?: SmartSelectOption[],
  controlledTypeFilter?: AccountTypeBucket | "",
  typeFilterLabel?: (bucket: AccountTypeBucket | "") => string,
) {
  const [internalTypeFilter, setInternalTypeFilter] = useState<AccountTypeBucket | "">("");
  const typeFilter = controlledTypeFilter ?? internalTypeFilter;
  const setTypeFilter = useCallback((next: AccountTypeBucket | "") => {
    if (controlledTypeFilter === undefined) setInternalTypeFilter(next);
  }, [controlledTypeFilter]);

  const typeFilterLabelText = useMemo(
    () => (typeFilterLabel ? typeFilterLabel(typeFilter) : typeFilter || "全部"),
    [typeFilter, typeFilterLabel],
  );

  // Buckets that actually exist among the selectable accounts, in canonical order.
  const availableTypeBuckets = useMemo(() => {
    const present = new Set<AccountTypeBucket>();
    for (const option of accountSSOptions ?? []) {
      if (option.isHeader || option.isGroup) continue;
      const bucket = accountTypeBucketOfKind(option.kind);
      if (bucket) present.add(bucket);
    }
    return ACCOUNT_TYPE_BUCKET_ORDER.filter((bucket) => present.has(bucket));
  }, [accountSSOptions]);

  // Cycle the current type filter to the next bucket (or back to "全部").
  const cycleTypeFilter = useCallback(() => {
    const buckets = availableTypeBuckets;
    if (buckets.length === 0) return;
    if (!typeFilter) {
      setTypeFilter(buckets[0]);
      return;
    }
    const idx = buckets.indexOf(typeFilter);
    if (idx < 0) {
      setTypeFilter(buckets[0]);
      return;
    }
    if (idx === buckets.length - 1) {
      setTypeFilter("");
      return;
    }
    setTypeFilter(buckets[idx + 1]);
  }, [typeFilter, availableTypeBuckets]);

  // Filter the dropdown to the selectable accounts of the current type bucket.
  const filteredOptions = useMemo(() => {
    return accountSSOptions?.filter((option) => {
      if (option.isHeader) return false;
      if (!typeFilter) return true;
      return accountTypeBucketOfKind(option.kind) === typeFilter;
    });
  }, [accountSSOptions, typeFilter]);

  const visibleOptionIds = useMemo(
    () => (filteredOptions ? new Set(filteredOptions.map((option) => option.id)) : undefined),
    [filteredOptions],
  );

  return {
    ownerFilter: typeFilter,
    ownerFilterLabel: typeFilterLabelText,
    cycleOwnerFilter: cycleTypeFilter,
    typeFilter,
    setTypeFilter,
    typeFilterLabel: typeFilterLabelText,
    cycleTypeFilter,
    filteredOptions,
    visibleOptionIds,
    availableTypeBuckets,
  };
}
