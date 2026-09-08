function cnExchangeFromMarketCode(value: string) {
  const normalized = value.trim().toUpperCase().replace(/[.\s-]/g, "_");
  if (normalized === "CN_SH" || normalized === "SH" || normalized === "SSE" || normalized === "XSHG") return "SH";
  if (normalized === "CN_SZ" || normalized === "SZ" || normalized === "SZSE" || normalized === "XSHE") return "SZ";
  if (normalized === "CN_BJ" || normalized === "BJ" || normalized === "BSE" || normalized === "XBJE") return "BJ";
  return null;
}

export function normalizeStockMarket(raw: unknown) {
  const value = String(raw ?? "").trim().toUpperCase();
  if (cnExchangeFromMarketCode(value)) return "CN";
  return value || "CN";
}

export function normalizeStockCode(raw: unknown) {
  return String(raw ?? "").trim().toUpperCase();
}

export function inferStockMarketFromCode(stockCodeRaw: unknown) {
  const stockCode = normalizeStockCode(stockCodeRaw);
  if (/^\d{6}$/.test(stockCode)) return "CN";
  if (/^\d{5}$/.test(stockCode)) return "HK";
  if (/^[A-Z][A-Z0-9.-]{0,9}$/.test(stockCode)) return "US";
  return "CN";
}

export function inferStockExchangeFromCode(marketRaw: unknown, stockCodeRaw: unknown) {
  const explicitExchange = cnExchangeFromMarketCode(String(marketRaw ?? ""));
  if (explicitExchange) return explicitExchange;
  const market = normalizeStockMarket(marketRaw);
  const stockCode = normalizeStockCode(stockCodeRaw);
  if (market !== "CN") return null;
  if (/^[69]/.test(stockCode)) return "SH";
  if (/^[023]/.test(stockCode)) return "SZ";
  if (/^(4|8|92)/.test(stockCode)) return "BJ";
  return null;
}

export function stockFeeRuleMarketKeys(marketRaw: unknown, stockCodeRaw: unknown) {
  const market = normalizeStockMarket(marketRaw);
  const exchange = inferStockExchangeFromCode(marketRaw, stockCodeRaw);
  const keys = exchange ? [`${market}_${exchange}`, market] : [market];
  return Array.from(new Set(keys.filter(Boolean)));
}

export function defaultStockCurrencyForMarket(marketRaw: unknown) {
  const market = normalizeStockMarket(marketRaw);
  if (market === "HK") return "HKD";
  if (market === "US") return "USD";
  return "CNY";
}

export function stockMarketLabel(marketRaw: unknown) {
  const market = normalizeStockMarket(marketRaw);
  if (market === "HK") return "港股";
  if (market === "US") return "美股";
  if (market === "CN" || market.startsWith("CN_")) return "A股";
  return market || "其他";
}
