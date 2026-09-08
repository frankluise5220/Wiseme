import { normalizeCurrency } from "@/lib/currency";
import { isDisplayZeroMoney } from "@/lib/format";

export type AccountCurrencyDisplayMode = "converted" | "original";

export type AccountCurrencyDisplayInput = {
  balance?: number | string | null;
  convertedBalance?: number | string | null;
  currency?: string | null;
  baseCurrency?: string | null;
  fxRateMissing?: boolean | null;
};

export type AccountCurrencyDisplayValue = {
  value: number | null;
  currency: string;
  missingFxRate: boolean;
};

function finiteNumberOrNull(value: number | string | null | undefined) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function resolveAccountCurrencyDisplayValue(
  account: AccountCurrencyDisplayInput,
  fallbackBaseCurrency = "CNY",
  mode: AccountCurrencyDisplayMode = "converted",
): AccountCurrencyDisplayValue {
  const baseCurrency = normalizeCurrency(fallbackBaseCurrency);
  const sourceCurrency = normalizeCurrency(account.currency ?? baseCurrency);
  const targetCurrency = normalizeCurrency(account.baseCurrency ?? baseCurrency);
  const balance = finiteNumberOrNull(account.balance) ?? 0;

  if (mode === "original") {
    return {
      value: balance,
      currency: sourceCurrency,
      missingFxRate: Boolean(account.fxRateMissing),
    };
  }

  if (sourceCurrency === targetCurrency) {
    return { value: balance, currency: targetCurrency, missingFxRate: false };
  }

  const convertedBalance = finiteNumberOrNull(account.convertedBalance);
  if (convertedBalance != null) {
    return { value: convertedBalance, currency: targetCurrency, missingFxRate: false };
  }

  if (isDisplayZeroMoney(balance)) {
    return { value: 0, currency: targetCurrency, missingFxRate: false };
  }

  return { value: null, currency: targetCurrency, missingFxRate: true };
}
