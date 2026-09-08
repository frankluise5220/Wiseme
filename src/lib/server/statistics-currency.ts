import { normalizeCurrency } from "@/lib/currency";
import { prisma } from "@/lib/db/prisma";
import { convertCurrencyAmounts, getHouseholdBaseCurrency } from "@/lib/server/fx-rates";

type StatisticCurrencySource = { accountId: string; currency?: string | null };

/**
 * Account currency + original statistic amount + latest stored FX rate + household
 * base currency -> converted statistic items -> period/category/tag/detail totals.
 * Derive financial results in their original currency before conversion. No writes
 * or external rate refreshes occur here; missing-rate amounts stay out of totals.
 */
export async function buildStatisticsCurrencyConverter(
  householdId: string,
  entries: readonly StatisticCurrencySource[],
) {
  const accountIds = Array.from(new Set(entries.map((entry) => entry.accountId).filter(Boolean)));
  const [baseCurrency, accounts] = await Promise.all([
    getHouseholdBaseCurrency(householdId),
    prisma.account.findMany({
      where: { householdId, id: { in: accountIds } },
      select: { id: true, currency: true },
    }),
  ]);
  // Include inactive accounts: their historical transactions still belong in reports.
  const currencyById = new Map(accounts.map((account) => [account.id, account.currency]));
  const currencyOf = (entry: StatisticCurrencySource) =>
    normalizeCurrency(currencyById.get(entry.accountId) ?? entry.currency);
  const currencies = Array.from(new Set(entries.map(currencyOf)));
  const { rates, missingCurrencies } = await convertCurrencyAmounts({
    householdId,
    amounts: currencies.map((currency) => ({ amount: 0, currency })),
    toCurrency: baseCurrency,
  });
  const rateByCurrency = new Map(rates.map((rate) => [rate.fromCurrency, rate.rate]));
  const convert = (entry: StatisticCurrencySource, amount: number) => {
    const currency = currencyOf(entry);
    const rate = currency === baseCurrency ? 1 : rateByCurrency.get(currency);
    return rate == null ? null : amount * rate;
  };

  return {
    baseCurrency,
    missingFxCurrencies: missingCurrencies,
    convert,
    convertItems<T extends { amount: number }>(entry: StatisticCurrencySource, items: T[]): T[] {
      return items.flatMap((item) => {
        const amount = convert(entry, item.amount);
        return amount == null ? [] : [{ ...item, amount }];
      });
    },
  };
}
