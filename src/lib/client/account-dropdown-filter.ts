"use client";

import { getAccountDropdownRestrictTypePreference } from "./appPreferences";

/**
 * Applies an account-style ("type") restriction to an account list, unless the
 * "账户下拉菜单限制类型" setting is turned off.
 *
 * When the setting is enabled (default) it behaves just like `items.filter(predicate)`,
 * preserving the current per-dropdown kind restrictions. When the user disables it,
 * EVERY account dropdown shows all accounts regardless of kind / product type, so the
 * predicate is ignored and the full list is returned.
 *
 * Only the type-style predicate should be passed in (kind / investProductType /
 * debtDirection ...). Predicates that are not about account type — e.g. skipping a
 * placeholder, hiding inactive accounts, or excluding a single already-selected
 * account — must NOT be routed through this helper, because they must keep applying
 * even when the setting is off.
 */
export function restrictAccountsByType<T extends { kind?: string | null }>(
  items: readonly T[],
  predicate: (account: T) => boolean,
): T[] {
  if (!getAccountDropdownRestrictTypePreference()) return items.slice();
  return items.filter(predicate);
}
