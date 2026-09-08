type AccountCurrencyLike = {
  readonly name?: string | null;
  readonly currency?: string | null;
};

export const CURRENCY_OPTIONS = [
  { value: "CNY" },
  { value: "USD" },
  { value: "JPY" },
  { value: "EUR" },
  { value: "HKD" },
  { value: "GBP" },
  { value: "KRW" },
  { value: "SGD" },
  { value: "TWD" },
  { value: "AUD" },
  { value: "CAD" },
  { value: "CHF" },
  { value: "THB" },
  { value: "MYR" },
  { value: "VND" },
  { value: "INR" },
  { value: "PHP" },
  { value: "IDR" },
  { value: "MOP" },
] as const;

export type SystemCurrencyCode = (typeof CURRENCY_OPTIONS)[number]["value"];

/**
 * Country (Chinese) → ISO currency code mapping.
 * Used to auto-suggest a currency code when the user fills in the country field.
 * Extend this map as needed; it's a fallback / hint, not authoritative.
 */
export const COUNTRY_TO_CURRENCY: Record<string, string> = {
  // Asia
  中国: "CNY",
  中国大陆: "CNY",
  大陆: "CNY",
  香港: "HKD",
  中国香港: "HKD",
  澳门: "MOP",
  中国澳门: "MOP",
  台湾: "TWD",
  中国台湾: "TWD",
  日本: "JPY",
  韩国: "KRW",
  南韩: "KRW",
  朝鲜: "KPW",
  新加坡: "SGD",
  马来西亚: "MYR",
  泰国: "THB",
  越南: "VND",
  印度: "INR",
  菲律宾: "PHP",
  印尼: "IDR",
  印度尼西亚: "IDR",
  土耳其: "TRY",
  以色列: "ILS",
  哈萨克斯坦: "KZT",
  // Europe
  欧盟: "EUR",
  欧元区: "EUR",
  德国: "EUR",
  法国: "EUR",
  意大利: "EUR",
  西班牙: "EUR",
  荷兰: "EUR",
  比利时: "EUR",
  奥地利: "EUR",
  葡萄牙: "EUR",
  希腊: "EUR",
  英国: "GBP",
  瑞士: "CHF",
  瑞典: "SEK",
  挪威: "NOK",
  丹麦: "DKK",
  波兰: "PLN",
  捷克: "CZK",
  匈牙利: "HUF",
  罗马尼亚: "RON",
  俄罗斯: "RUB",
  乌克兰: "UAH",
  // Americas
  美国: "USD",
  加拿大: "CAD",
  墨西哥: "MXN",
  巴西: "BRL",
  阿根廷: "ARS",
  智利: "CLP",
  哥伦比亚: "COP",
  秘鲁: "PEN",
  // Oceania
  澳大利亚: "AUD",
  新西兰: "NZD",
  // Middle East / Africa
  沙特阿拉伯: "SAR",
  阿联酋: "AED",
  卡塔尔: "QAR",
  科威特: "KWD",
  巴林: "BHD",
  阿曼: "OMR",
  南非: "ZAR",
  埃及: "EGP",
  尼日利亚: "NGN",
  肯尼亚: "KES",
  澳大利亚元: "AUD",
};

export function normalizeCurrency(value: unknown) {
  const text = String(value ?? "CNY").trim().toUpperCase();
  return text || "CNY";
}

export function normalizeOptionalCurrency(value: unknown) {
  if (value == null) return null;
  const text = String(value).trim().toUpperCase();
  return text || null;
}

export function resolveSameCurrencyTransfer(fromAccount: AccountCurrencyLike, toAccount: AccountCurrencyLike) {
  const fromCurrency = normalizeCurrency(fromAccount.currency);
  const toCurrency = normalizeCurrency(toAccount.currency);
  if (fromCurrency !== toCurrency) {
    const fromName = fromAccount.name?.trim() || "source account";
    const toName = toAccount.name?.trim() || "target account";
    throw new Error(
      `Standard transfers only support accounts with the same currency. ${fromName} is ${fromCurrency}, ${toName} is ${toCurrency}; use the currency exchange or cross-currency transfer flow for different currencies.`
    );
  }
  return fromCurrency;
}
