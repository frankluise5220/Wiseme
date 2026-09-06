// Server-side reader for the "账户下拉限制类型" (restrict account types in dropdowns)
// setting. The cookie name mirrors `ACCOUNT_DROPDOWN_RESTRICT_TYPE_COOKIE` in
// `src/lib/client/appPreferences.ts`; that module is client-only, so the value is
// repeated here instead of imported (same pattern as `src/lib/server/account-label-fields.ts`).
import { cookies } from "next/headers";

export const ACCOUNT_DROPDOWN_RESTRICT_TYPE_COOKIE = "mmh_account_dropdown_restrict_type";

export function accountDropdownRestrictTypeFromCookieValue(value: string | undefined): boolean {
  if (value === undefined) return true;
  return value === "true" || value === "1";
}

export async function getServerAccountDropdownRestrictType(): Promise<boolean> {
  const store = await cookies();
  return accountDropdownRestrictTypeFromCookieValue(store.get(ACCOUNT_DROPDOWN_RESTRICT_TYPE_COOKIE)?.value);
}

type CookieReader = { cookies: { get: (name: string) => { value?: string } | undefined } };

/** Route-handler flavour: reads the preference from a request's cookies. */
export function accountDropdownRestrictTypeFromRequest(req: CookieReader): boolean {
  return accountDropdownRestrictTypeFromCookieValue(req.cookies.get(ACCOUNT_DROPDOWN_RESTRICT_TYPE_COOKIE)?.value);
}
