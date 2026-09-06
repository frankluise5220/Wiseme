import {
  defaultStockCurrencyForMarket,
  inferStockExchangeFromCode,
  normalizeStockCode,
  normalizeStockMarket,
} from "@/lib/stock/market";

export type StockIdentityResult = {
  market: string;
  stockCode: string;
  stockName: string;
  currency: string;
  exchange?: string | null;
  source: string;
} | null;

export type StockClosePriceResult = {
  market: string;
  stockCode: string;
  closePrice: number;
  priceDate: string;
  currency: string;
  exchange?: string | null;
  source: string;
} | null;

const headers = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: "https://quote.eastmoney.com/",
};

const EASTMONEY_SUGGEST_TOKEN = "D43BF722C8E33BD2A31608CF607B8F6D";

function eastmoneyCnSecidCandidates(stockCode: string, exchange?: string | null) {
  if (exchange === "SH") return [`1.${stockCode}`];
  if (exchange === "SZ" || exchange === "BJ") return [`0.${stockCode}`];
  return [`1.${stockCode}`, `0.${stockCode}`];
}

function normalizeStockName(value: unknown) {
  const name = String(value ?? "").trim();
  if (!name || name === "-" || name.length > 60) return null;
  return name;
}

function exchangeFromSecid(secid: string, fallback?: string | null) {
  if (secid.startsWith("1.")) return "SH";
  if (secid.startsWith("0.")) return fallback ?? null;
  return fallback ?? null;
}

function exchangeFromSuggestItem(item: Record<string, unknown>, fallback?: string | null) {
  const quoteId = String(item.QuoteID ?? item.quoteId ?? item.QuoteId ?? item.secid ?? item.Secid ?? "").trim();
  if (quoteId.startsWith("1.")) return "SH";
  if (quoteId.startsWith("0.")) return fallback ?? null;

  const marketText = String(item.SecurityTypeName ?? item.securityTypeName ?? item.JYS ?? item.jys ?? "").trim();
  if (/沪|上海|SH/i.test(marketText)) return "SH";
  if (/深|深圳|SZ/i.test(marketText)) return "SZ";
  if (/北|北京|BJ/i.test(marketText)) return "BJ";
  return fallback ?? null;
}

// Bound each quote request so a hung external call cannot stall an import
// (or any other flow) until a reverse-proxy gateway timeout kicks in.
const QUOTE_FETCH_TIMEOUT_MS = Number(process.env.STOCK_QUOTE_FETCH_TIMEOUT_MS ?? 10_000);

async function fetchJson(url: string) {
  const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(QUOTE_FETCH_TIMEOUT_MS) });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

async function fetchText(url: string) {
  const response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(QUOTE_FETCH_TIMEOUT_MS) });
  if (!response.ok) return null;
  return response.text().catch(() => null);
}

function collectObjects(value: unknown, result: Record<string, unknown>[] = []) {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, result);
    return result;
  }
  const record = value as Record<string, unknown>;
  result.push(record);
  for (const child of Object.values(record)) collectObjects(child, result);
  return result;
}

function codeFromSuggestItem(item: Record<string, unknown>) {
  return normalizeStockCode(
    item.Code
      ?? item.code
      ?? item.SecurityCode
      ?? item.securityCode
      ?? item.SECURITY_CODE
      ?? item.f12
      ?? item.stockCode,
  );
}

function nameFromSuggestItem(item: Record<string, unknown>) {
  return normalizeStockName(
    item.Name
      ?? item.name
      ?? item.SecurityName
      ?? item.securityName
      ?? item.SECURITY_NAME_ABBR
      ?? item.SECURITY_NAME
      ?? item.f14
      ?? item.stockName,
  );
}

function cnIdentity(params: {
  stockCode: string;
  stockName: string;
  exchange?: string | null;
  source: string;
}): NonNullable<StockIdentityResult> {
  return {
    market: "CN",
    stockCode: params.stockCode,
    stockName: params.stockName,
    currency: "CNY",
    exchange: params.exchange ?? inferStockExchangeFromCode("CN", params.stockCode),
    source: params.source,
  };
}

async function queryEastmoneyCnPushIdentity(stockCode: string, exchange?: string | null): Promise<StockIdentityResult> {
  for (const secid of eastmoneyCnSecidCandidates(stockCode, exchange)) {
    try {
      const data: any = await fetchJson(`https://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=f57,f58`)
        ?? await fetchJson(`http://push2.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=f57,f58`);
      const item = data?.data;
      if (normalizeStockCode(item?.f57) !== stockCode) continue;
      const stockName = normalizeStockName(item?.f58);
      if (!stockName) continue;
      return cnIdentity({
        stockCode,
        stockName,
        exchange: exchangeFromSecid(secid, exchange ?? inferStockExchangeFromCode("CN", stockCode)),
        source: "eastmoney-push2",
      });
    } catch {
      // Try the next secid candidate.
    }
  }
  return null;
}

async function queryEastmoneyCnSuggestIdentity(stockCode: string, exchange?: string | null): Promise<StockIdentityResult> {
  const query = encodeURIComponent(stockCode);
  const urls = [
    `https://searchapi.eastmoney.com/api/suggest/get?input=${query}&type=14&token=${EASTMONEY_SUGGEST_TOKEN}&count=10`,
    `http://searchapi.eastmoney.com/api/suggest/get?input=${query}&type=14&token=${EASTMONEY_SUGGEST_TOKEN}&count=10`,
  ];
  for (const url of urls) {
    try {
      const data = await fetchJson(url);
      for (const item of collectObjects(data)) {
        if (codeFromSuggestItem(item) !== stockCode) continue;
        const stockName = nameFromSuggestItem(item);
        if (!stockName) continue;
        return cnIdentity({
          stockCode,
          stockName,
          exchange: exchangeFromSuggestItem(item, exchange ?? inferStockExchangeFromCode("CN", stockCode)),
          source: "eastmoney-suggest",
        });
      }
    } catch {
      // Try the next Eastmoney suggest URL variant.
    }
  }
  return null;
}

async function queryEastmoneyCnPageIdentity(stockCode: string, exchange?: string | null): Promise<StockIdentityResult> {
  const inferredExchange = exchange ?? inferStockExchangeFromCode("CN", stockCode);
  const prefixes = inferredExchange === "SH"
    ? ["sh"]
    : inferredExchange === "SZ"
      ? ["sz"]
      : inferredExchange === "BJ"
        ? ["bj", "sz"]
        : ["sh", "sz", "bj"];
  for (const prefix of prefixes) {
    for (const protocol of ["https", "http"]) {
      try {
        const html = await fetchText(`${protocol}://quote.eastmoney.com/${prefix}${stockCode}.html`);
        if (!html) continue;
        const escapedCode = stockCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const patterns = [
          new RegExp(`<title[^>]*>\\s*([^<（(_\\-\\s]{2,30})\\s*[（(]\\s*${escapedCode}\\s*[）)]`, "i"),
          new RegExp(`["']SecurityName["']\\s*:\\s*["']([^"']{2,30})["']`, "i"),
          new RegExp(`["']f58["']\\s*:\\s*["']([^"']{2,30})["']`, "i"),
        ];
        for (const pattern of patterns) {
          const match = html.match(pattern);
          const stockName = normalizeStockName(match?.[1]);
          if (!stockName) continue;
          return cnIdentity({
            stockCode,
            stockName,
            exchange: prefix === "sh" ? "SH" : prefix === "bj" ? "BJ" : "SZ",
            source: "eastmoney-page",
          });
        }
      } catch {
        // Try the next quote page URL variant.
      }
    }
  }
  return null;
}

async function queryEastmoneyCnIdentity(stockCode: string, exchange?: string | null): Promise<StockIdentityResult> {
  return await queryEastmoneyCnPushIdentity(stockCode, exchange)
    ?? await queryEastmoneyCnSuggestIdentity(stockCode, exchange)
    ?? await queryEastmoneyCnPageIdentity(stockCode, exchange);
}

function parseEastmoneyKlineClose(row: unknown) {
  const parts = String(row ?? "").split(",");
  const priceDate = String(parts[0] ?? "").trim();
  const closePrice = Number(parts[2]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(priceDate)) return null;
  if (!Number.isFinite(closePrice) || closePrice <= 0) return null;
  return { priceDate, closePrice };
}

function normalizeEastmoneyKlineEndDate(value: unknown) {
  const raw = String(value ?? "").trim();
  if (/^\d{8}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.replace(/-/g, "");
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime())
    ? date.toISOString().slice(0, 10).replace(/-/g, "")
    : "20500101";
}

async function queryEastmoneyCnClose(
  stockCode: string,
  exchange: string | null | undefined,
  endDate: string,
  source: string,
): Promise<StockClosePriceResult> {
  for (const secid of eastmoneyCnSecidCandidates(stockCode, exchange)) {
    const params = new URLSearchParams({
      secid,
      fields1: "f1,f2,f3,f4,f5,f6",
      fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
      klt: "101",
      fqt: "1",
      end: endDate,
      lmt: "1",
    });
    try {
      const data: any = await fetchJson(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params.toString()}`)
        ?? await fetchJson(`http://push2his.eastmoney.com/api/qt/stock/kline/get?${params.toString()}`);
      const latest = Array.isArray(data?.data?.klines) ? data.data.klines[0] : null;
      const parsed = parseEastmoneyKlineClose(latest);
      if (!parsed) continue;
      return {
        market: "CN",
        stockCode,
        closePrice: parsed.closePrice,
        priceDate: parsed.priceDate,
        currency: "CNY",
        exchange: exchangeFromSecid(secid, exchange ?? inferStockExchangeFromCode("CN", stockCode)),
        source,
      };
    } catch {
      // Try the next secid candidate.
    }
  }
  return null;
}

async function queryEastmoneyCnLatestClose(stockCode: string, exchange?: string | null): Promise<StockClosePriceResult> {
  return queryEastmoneyCnClose(stockCode, exchange, "20500101", "eastmoney-kline");
}

async function queryEastmoneyCnCloseByDate(stockCode: string, dateRaw: unknown, exchange?: string | null): Promise<StockClosePriceResult> {
  return queryEastmoneyCnClose(stockCode, exchange, normalizeEastmoneyKlineEndDate(dateRaw), "eastmoney-kline-date");
}

export async function queryStockIdentity(marketRaw: unknown, stockCodeRaw: unknown): Promise<StockIdentityResult> {
  const market = normalizeStockMarket(marketRaw);
  const stockCode = normalizeStockCode(stockCodeRaw);
  if (!stockCode) return null;

  if (market === "CN") {
    return queryEastmoneyCnIdentity(stockCode, inferStockExchangeFromCode(market, stockCode));
  }

  return {
    market,
    stockCode,
    stockName: stockCode,
    currency: defaultStockCurrencyForMarket(market),
    exchange: null,
    source: "manual-code-fallback",
  };
}

export async function queryStockLatestClosePrice(marketRaw: unknown, stockCodeRaw: unknown, exchangeRaw?: unknown): Promise<StockClosePriceResult> {
  const market = normalizeStockMarket(marketRaw);
  const stockCode = normalizeStockCode(stockCodeRaw);
  const exchange = String(exchangeRaw ?? "").trim() || inferStockExchangeFromCode(market, stockCode);
  if (!stockCode) return null;

  if (market === "CN") {
    return queryEastmoneyCnLatestClose(stockCode, exchange);
  }

  return null;
}

export async function queryStockClosePriceByDate(marketRaw: unknown, stockCodeRaw: unknown, dateRaw: unknown, exchangeRaw?: unknown): Promise<StockClosePriceResult> {
  const market = normalizeStockMarket(marketRaw);
  const stockCode = normalizeStockCode(stockCodeRaw);
  const exchange = String(exchangeRaw ?? "").trim() || inferStockExchangeFromCode(market, stockCode);
  if (!stockCode) return null;

  if (market === "CN") {
    return queryEastmoneyCnCloseByDate(stockCode, dateRaw, exchange);
  }

  return null;
}

export type StockClosePriceListResult = {
  market: string;
  stockCode: string;
  currency: string;
  exchange?: string | null;
  source: string;
  items: Array<{ priceDate: string; closePrice: number }>;
} | null;

async function queryEastmoneyCnCloseList(
  stockCode: string,
  exchange: string | null | undefined,
  startDate: string,
  endDate: string,
  source: string,
): Promise<StockClosePriceListResult> {
  for (const secid of eastmoneyCnSecidCandidates(stockCode, exchange)) {
    const params = new URLSearchParams({
      secid,
      fields1: "f1,f2,f3,f4,f5,f6",
      fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
      klt: "101",
      fqt: "1",
      beg: startDate,
      end: endDate,
      lmt: "100000",
    });
    try {
      const data: any = await fetchJson(`https://push2his.eastmoney.com/api/qt/stock/kline/get?${params.toString()}`)
        ?? await fetchJson(`http://push2his.eastmoney.com/api/qt/stock/kline/get?${params.toString()}`);
      const klines = Array.isArray(data?.data?.klines) ? data.data.klines : [];
      const items = klines
        .map(parseEastmoneyKlineClose)
        .filter((item): item is { priceDate: string; closePrice: number } => item != null);
      if (items.length === 0) continue;
      return {
        market: "CN",
        stockCode,
        currency: "CNY",
        exchange: exchangeFromSecid(secid, exchange ?? inferStockExchangeFromCode("CN", stockCode)),
        source,
        items,
      };
    } catch {
      // Try the next secid candidate.
    }
  }
  return null;
}

export async function queryStockClosePriceList(
  marketRaw: unknown,
  stockCodeRaw: unknown,
  startDateRaw: unknown,
  endDateRaw: unknown,
  exchangeRaw?: unknown,
): Promise<StockClosePriceListResult> {
  const market = normalizeStockMarket(marketRaw);
  const stockCode = normalizeStockCode(stockCodeRaw);
  const exchange = String(exchangeRaw ?? "").trim() || inferStockExchangeFromCode(market, stockCode);
  if (!stockCode) return null;

  if (market === "CN") {
    return queryEastmoneyCnCloseList(
      stockCode,
      exchange,
      normalizeEastmoneyKlineEndDate(startDateRaw),
      normalizeEastmoneyKlineEndDate(endDateRaw),
      "eastmoney-kline-list",
    );
  }

  return null;
}