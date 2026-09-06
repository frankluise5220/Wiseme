// Shared fetch for /api/v1/accounts/internal WITH balances.
//
// Several components (sidebar, page-header balance) listen to the same
// FINANCE_DATA_CHANGED_EVENT with slightly different debounce timers
// (~80ms vs ~100ms). Without coalescing, a single save triggers 2-3
// concurrent calls, and each call recomputes every household balance from
// the full transaction history server-side — one of the main reasons
// saving an entry feels slow on large datasets.
//
// In-flight coalescing only: results are never cached, so consumers always
// observe balances that are as fresh as the latest request.

export type InternalAccountBalancesPayload = {
  ok?: boolean;
  baseCurrency?: string;
  totalConvertedBalance?: number;
  missingFxCurrencies?: string[];
  accounts?: Array<Record<string, unknown>>;
} | null;

let inFlight: Promise<InternalAccountBalancesPayload> | null = null;

export function fetchInternalAccountBalances(): Promise<InternalAccountBalancesPayload> {
  if (inFlight) return inFlight;
  const request = (async () => {
    try {
      const res = await fetch("/api/v1/accounts/internal", { cache: "no-store" });
      const contentType = res.headers.get("content-type") || "";
      if (!res.ok || !contentType.includes("application/json")) return null;
      return (await res.json()) as InternalAccountBalancesPayload;
    } catch {
      return null;
    } finally {
      inFlight = null;
    }
  })();
  inFlight = request;
  return request;
}
