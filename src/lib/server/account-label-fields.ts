// Server-side reader for the "account display format" setting.
// The cookie name mirrors `ACCOUNT_LABEL_FIELDS_COOKIE` in
// `src/lib/client/appPreferences.ts`; that module is client-only, so the value
// is repeated here instead of imported (same pattern as `src/lib/server/i18n.ts`).
import { cookies } from "next/headers";

import {
  DEFAULT_ACCOUNT_LABEL_FIELDS,
  parseAccountLabelFields,
  type AccountLabelField,
} from "@/lib/account-display";

export const ACCOUNT_LABEL_FIELDS_COOKIE = "mmh_account_label_fields";

export function accountLabelFieldsFromCookieValue(value: string | undefined): AccountLabelField[] {
  if (value === undefined) return [...DEFAULT_ACCOUNT_LABEL_FIELDS];
  return parseAccountLabelFields(value);
}

export async function getServerAccountLabelFields(): Promise<AccountLabelField[]> {
  const store = await cookies();
  return accountLabelFieldsFromCookieValue(store.get(ACCOUNT_LABEL_FIELDS_COOKIE)?.value);
}

type CookieReader = { cookies: { get: (name: string) => { value?: string } | undefined } };

/** Route-handler flavour: reads the preference from an incoming request. */
export function accountLabelFieldsFromRequest(req: CookieReader): AccountLabelField[] {
  return accountLabelFieldsFromCookieValue(req.cookies.get(ACCOUNT_LABEL_FIELDS_COOKIE)?.value);
}
