import crypto from "crypto";

export type InsuranceLookupResult = {
  title: string;
  url: string;
  snippet: string;
  source: string;
  structuredName?: string | null;
  structuredInstitutionName?: string | null;
  structuredStatus?: string | null;
  structuredSaleDate?: string | null;
  structuredTermsNo?: string | null;
};

export type InsuranceOfficialProduct = {
  name: string;
  institutionName: string;
  status: string;
  saleDate: string | null;
  termsNo: string | null;
  source: string;
};

export type InsuranceProductCandidate = {
  name: string;
  institutionName: string | null;
  productType: string | null;
  status: string | null;
  saleDate: string | null;
  termsNo: string | null;
  source: string;
  sourceType: "official" | "crawled" | "search";
  url: string | null;
  confidence: "low" | "medium" | "high";
  reason: string;
};

export type InsuranceLookupSuggestion = {
  productType: string | null;
  institutionName: string | null;
  confidence: "low" | "medium" | "high";
  reason: string;
};

export type InsuranceProductLookup = {
  query: string;
  institutionName: string | null;
  candidates: InsuranceProductCandidate[];
  officialProducts: InsuranceOfficialProduct[];
  officialSources: InsuranceLookupResult[];
  webResults: InsuranceLookupResult[];
  crawledPages: InsuranceLookupResult[];
  suggestion: InsuranceLookupSuggestion;
  searchedAt: string;
};

const OFFICIAL_QUERY_URL = "https://tiaokuan.iachina.cn/";
const OFFICIAL_API_BASE_URL = "https://tiaokuan.iachina.cn/sinopipi";
const IA_CHINA_CONSUMER_ENTRY =
  "https://www.iachina.cn/art/2017/6/29/art_71_45682.html";
const IA_CHINA_AES_KEY = "0d36c68466e06b99";
const IA_CHINA_AES_IV = "0840e274812143f5";

const PRODUCT_TYPE_RULES: Array<{ productType: string; keywords: string[] }> = [
  { productType: "critical_illness", keywords: ["重疾", "重大疾病"] },
  { productType: "medical", keywords: ["医疗", "住院", "百万医疗"] },
  { productType: "accident", keywords: ["意外"] },
  { productType: "annuity", keywords: ["年金", "养老"] },
  { productType: "term_life", keywords: ["定期寿", "定寿"] },
  { productType: "whole_life", keywords: ["终身寿", "增额终身寿"] },
  { productType: "universal", keywords: ["万能"] },
  { productType: "investment_linked", keywords: ["投连", "投资连结"] },
  { productType: "dividend", keywords: ["分红"] },
  { productType: "savings", keywords: ["两全", "储蓄", "教育金"] },
];

const INSTITUTION_HINTS = [
  "中国平安",
  "平安人寿",
  "中国人寿",
  "太平洋人寿",
  "中国太保",
  "泰康人寿",
  "新华保险",
  "太平人寿",
  "友邦保险",
  "中信保诚",
  "招商信诺",
  "阳光人寿",
  "大家人寿",
  "富德生命",
  "工银安盛",
  "中意人寿",
  "国华人寿",
  "百年人寿",
  "信泰人寿",
  "弘康人寿",
];

const OFFICIAL_PRODUCT_CATEGORY: Record<string, string> = {
  annuity: "PubNewProdTypeCode_01",
  critical_illness: "PubNewProdTypeCode_02",
  medical: "PubNewProdTypeCode_02",
  accident: "PubNewProdTypeCode_03",
};

const DEFAULT_OFFICIAL_CATEGORIES = [
  "PubNewProdTypeCode_00",
  "PubNewProdTypeCode_02",
  "PubNewProdTypeCode_01",
  "PubNewProdTypeCode_03",
];

function textOf(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();
}

function htmlToPlainText(html: string) {
  return textOf(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "\n")
      .replace(/<style[\s\S]*?<\/style>/gi, "\n")
      .replace(/<(br|p|div|li|tr|td|th|h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<\/(p|div|li|tr|td|th|h[1-6])>/gi, "\n"),
  )
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function encryptIaChinaToken(input: string) {
  const cipher = crypto.createCipheriv(
    "aes-128-cbc",
    Buffer.from(IA_CHINA_AES_KEY),
    Buffer.from(IA_CHINA_AES_IV),
  );
  cipher.setAutoPadding(false);
  const raw = Buffer.from(input, "utf8");
  const padLength = (16 - (raw.length % 16)) % 16;
  const padded = Buffer.concat([raw, Buffer.alloc(padLength)]);
  return Buffer.concat([cipher.update(padded), cipher.final()])
    .toString("base64")
    .replace(/\+/g, "_");
}

function decryptIaChinaPayload(input: string) {
  const decipher = crypto.createDecipheriv(
    "aes-128-cbc",
    Buffer.from(IA_CHINA_AES_KEY),
    Buffer.from(IA_CHINA_AES_IV),
  );
  decipher.setAutoPadding(false);
  return Buffer.concat([
    decipher.update(Buffer.from(input.replace(/_/g, "+"), "base64")),
    decipher.final(),
  ]).toString("utf8").replace(/\0+$/g, "");
}

function buildIaChinaHeaders() {
  const seed = `${Date.now()}${Array.from({ length: 13 }, () => Math.floor(Math.random() * 10)).join("")}`;
  return {
    Authorization: encryptIaChinaToken(seed),
    identity: encryptIaChinaToken(seed),
    "Content-Type": "application/json;charset=UTF-8",
    Accept: "application/json, text/plain, */*",
    "User-Agent": "MMH insurance product lookup",
  };
}

function tagValue(itemXml: string, tag: string) {
  const matched = itemXml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return matched ? textOf(matched[1] ?? "") : "";
}

function hostnameOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function parseBingRss(xml: string): InsuranceLookupResult[] {
  return Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/gi))
    .map((match) => {
      const itemXml = match[1] ?? "";
      const url = tagValue(itemXml, "link");
      return {
        title: tagValue(itemXml, "title"),
        url,
        snippet: tagValue(itemXml, "description"),
        source: hostnameOf(url),
      };
    })
    .filter((item) => item.title && item.url)
    .slice(0, 8);
}

function inferProductType(text: string) {
  const normalized = text.toLowerCase();
  return PRODUCT_TYPE_RULES.find((rule) =>
    rule.keywords.some((keyword) => normalized.includes(keyword.toLowerCase())),
  )?.productType ?? null;
}

function inferInstitutionName(text: string) {
  return INSTITUTION_HINTS.find((name) => text.includes(name)) ?? null;
}

function normalizeCandidateKey(name: string, institutionName?: string | null) {
  return `${name.replace(/\s+/g, "").toLowerCase()}__${String(institutionName ?? "").replace(/\s+/g, "").toLowerCase()}`;
}

function simplifyCandidateName(text: string, query: string) {
  const cleaned = textOf(text)
    .replace(/^(产品名称|保险产品名称|险种名称|保险名称)\s*[:：]\s*/g, "")
    .replace(/[|｜].*$/g, "")
    .replace(/[-_].*?(官网|网站|平台|首页).*$/g, "")
    .replace(/(保险条款|条款|产品介绍|保险产品|投保须知|保费测算|怎么样|好吗|官网|首页)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(/[，,。；;：:（）()【】\[\]<>《》]/).map((part) => part.trim()).filter(Boolean);
  return parts.find((part) => part.includes(query)) ?? (cleaned.includes(query) ? cleaned : "");
}

function extractLabeledValue(text: string, labels: string[], maxLength = 80) {
  for (const label of labels) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matched = text.match(new RegExp(`${escapedLabel}\\s*[:：]\\s*([^\\n。；;]{2,${maxLength}})`, "i"));
    const value = matched?.[1]?.replace(/\s+/g, " ").trim();
    if (value) return value;
  }
  return null;
}

function extractDateLikeValue(text: string, labels: string[]) {
  const labeled = extractLabeledValue(text, labels, 40);
  return labeled?.match(/\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/)?.[0]?.replace(/[年月/.]/g, "-").replace(/日$/, "") ?? null;
}

function extractTermsNo(text: string) {
  return extractLabeledValue(text, ["条款编号", "条款号", "备案编号", "产品备案号", "备案号"], 60);
}

function extractNameNearQuery(text: string, query: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const labeled = extractLabeledValue(text, ["保险产品名称", "产品名称", "险种名称", "保险名称"], 100);
  if (labeled?.includes(query)) return simplifyCandidateName(labeled, query);
  const line = lines.find((item) => item.includes(query) && /保险|产品|条款|计划|方案|合同/.test(item));
  if (!line) return null;
  return simplifyCandidateName(line, query) || null;
}

function confidenceForStructuredCandidate(sourceType: InsuranceProductCandidate["sourceType"], text: string) {
  if (sourceType === "official") return "high";
  const hasProductWord = /保险|重疾|医疗|意外|年金|寿|两全|万能|分红|投连/.test(text);
  const hasInstitution = !!inferInstitutionName(text);
  return hasProductWord && hasInstitution ? "medium" : "low";
}

function resultToCandidate(
  result: InsuranceLookupResult,
  query: string,
  requestedInstitutionName: string | null,
  sourceType: "crawled" | "search",
): InsuranceProductCandidate | null {
  const combined = `${result.title}\n${result.snippet}`;
  const name = result.structuredName || simplifyCandidateName(result.title, query) || simplifyCandidateName(result.snippet, query);
  if (!name || !name.includes(query)) return null;
  const productType = inferProductType(combined);
  const institutionName = result.structuredInstitutionName ?? inferInstitutionName(combined) ?? requestedInstitutionName;
  const confidence = result.structuredName && (institutionName || result.structuredTermsNo || result.structuredStatus)
    ? "medium"
    : confidenceForStructuredCandidate(sourceType, combined);
  return {
    name,
    institutionName,
    productType,
    status: result.structuredStatus ?? null,
    saleDate: result.structuredSaleDate ?? null,
    termsNo: result.structuredTermsNo ?? null,
    source: result.source,
    sourceType,
    url: result.url,
    confidence,
    reason: result.structuredName
      ? "从公开页面字段整理，需人工核对。"
      : sourceType === "crawled"
        ? "从公开页面标题/摘要整理，需人工核对。"
        : "从搜索结果标题/摘要整理，需人工核对。",
  };
}

function buildCandidates(
  query: string,
  requestedInstitutionName: string | null,
  officialProducts: InsuranceOfficialProduct[],
  crawledPages: InsuranceLookupResult[],
  webResults: InsuranceLookupResult[],
): InsuranceProductCandidate[] {
  const candidates: InsuranceProductCandidate[] = [
    ...officialProducts.map((item): InsuranceProductCandidate => ({
      name: item.name,
      institutionName: item.institutionName || requestedInstitutionName,
      productType: inferProductType(item.name),
      status: item.status || null,
      saleDate: item.saleDate,
      termsNo: item.termsNo,
      source: item.source,
      sourceType: "official",
      url: OFFICIAL_QUERY_URL,
      confidence: "high",
      reason: "来自中国保险行业协会公开产品库。",
    })),
    ...crawledPages
      .map((item) => resultToCandidate(item, query, requestedInstitutionName, "crawled"))
      .filter((item): item is InsuranceProductCandidate => !!item),
    ...webResults
      .map((item) => resultToCandidate(item, query, requestedInstitutionName, "search"))
      .filter((item): item is InsuranceProductCandidate => !!item),
  ];

  const deduped = new Map<string, InsuranceProductCandidate>();
  for (const candidate of candidates) {
    const key = normalizeCandidateKey(candidate.name, candidate.institutionName);
    const existing = deduped.get(key);
    if (!existing || candidate.confidence === "high" || (candidate.confidence === "medium" && existing.confidence === "low")) {
      deduped.set(key, candidate);
    }
  }
  const rank: Record<InsuranceProductCandidate["confidence"], number> = { high: 0, medium: 1, low: 2 };
  return Array.from(deduped.values())
    .sort((a, b) => rank[a.confidence] - rank[b.confidence] || a.name.localeCompare(b.name, "zh-Hans-CN"))
    .slice(0, 8);
}

function buildSuggestion(
  query: string,
  results: InsuranceLookupResult[],
  officialProducts: InsuranceOfficialProduct[],
): InsuranceLookupSuggestion {
  const officialText = officialProducts.flatMap((item) => [item.name, item.institutionName]).join("\n");
  const combined = officialText || [
    query,
    ...results.flatMap((item) => [item.title, item.snippet]),
  ].join("\n");
  const productType = inferProductType(combined);
  const institutionName = officialProducts[0]?.institutionName ?? inferInstitutionName(combined);
  const confidence = officialProducts.length > 0 ? "high" : productType || institutionName ? "medium" : "low";
  return {
    productType,
    institutionName,
    confidence,
    reason: officialProducts.length > 0
      ? "已从中国保险行业协会公开产品库查到候选，请打开官方入口核对条款详情。"
      : productType || institutionName
      ? "根据产品名称和搜索结果标题/摘要轻量推断，请以官方条款为准。"
      : "未从名称或摘要中识别出明确类型/机构，请手动确认。",
  };
}

function officialCategoryForQuery(query: string) {
  const productType = inferProductType(query);
  return productType ? OFFICIAL_PRODUCT_CATEGORY[productType] ?? "PubNewProdTypeCode_00" : "PubNewProdTypeCode_00";
}

function officialCategoriesForQuery(query: string) {
  const first = officialCategoryForQuery(query);
  return [first, ...DEFAULT_OFFICIAL_CATEGORIES.filter((item) => item !== first)].slice(0, 3);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lookupOfficialProductListByCategory(
  query: string,
  category: string,
  institutionName?: string | null,
): Promise<{ products: InsuranceOfficialProduct[]; rateLimited: boolean }> {
  const body = {
    tagdata: "03",
    insperdtype: "",
    processnode: "",
    instype: "",
    prodpaytype: "",
    cplbone: category,
    cplbtow: "",
    cplbthree: "",
    salestatus: "",
    cplbfour: "",
    sjlxone: "",
    sjlxtow: "",
    sjlxthree: "",
    proddesicode: "",
    prodtypecode: category,
    prodname: query,
    inscomname: institutionName?.trim() ?? "",
    insitemcode: "",
    filltype: "",
    specialattri: "",
    insperd: "",
    pageNum: 1,
    pageSize: 8,
  };

  try {
    const response = await fetch(`${OFFICIAL_API_BASE_URL}/prodtermsinfo/selectConsumerList`, {
      method: "POST",
      cache: "no-store",
      headers: buildIaChinaHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) return { products: [], rateLimited: false };
    const json = await response.json().catch(() => null) as { code?: string | number; data?: string; msg?: string } | null;
    if (String(json?.code) === "405") return { products: [], rateLimited: true };
    if (String(json?.code) !== "200" || !json?.data) return { products: [], rateLimited: false };
    const payload = JSON.parse(decryptIaChinaPayload(json.data)) as {
      records?: Array<{
        prodname?: string;
        inscomname?: string;
        salestatus?: string;
        saledate?: string;
        termsno?: string;
      }>;
    };
    const products = (payload.records ?? []).map((item) => ({
      name: String(item.prodname ?? ""),
      institutionName: String(item.inscomname ?? ""),
      status: String(item.salestatus ?? ""),
      saleDate: item.saledate ? String(item.saledate) : null,
      termsNo: item.termsno ? String(item.termsno) : null,
      source: "中国保险行业协会产品信息库",
    })).filter((item) => item.name);
    return { products, rateLimited: false };
  } catch (error) {
    console.warn("official insurance product lookup failed", error);
    return { products: [], rateLimited: false };
  }
}

async function lookupOfficialProductList(query: string, institutionName?: string | null): Promise<InsuranceOfficialProduct[]> {
  const found: InsuranceOfficialProduct[] = [];
  const seen = new Set<string>();
  for (const [index, category] of officialCategoriesForQuery(query).entries()) {
    if (index > 0) await sleep(900);
    const { products, rateLimited } = await lookupOfficialProductListByCategory(query, category, institutionName);
    for (const product of products) {
      const key = normalizeCandidateKey(product.name, product.institutionName);
      if (!seen.has(key)) {
        seen.add(key);
        found.push(product);
      }
    }
    if (found.length > 0 || rateLimited) break;
  }
  if (found.length === 0 && institutionName?.trim()) {
    // Official institution names can be more specific than local labels.
    // Retry by product name only so an exact product name can still surface the real insurer.
    return lookupOfficialProductList(query, null);
  }
  return found.slice(0, 8);
}

function parseHtmlSummary(html: string, fallbackUrl: string, query: string): InsuranceLookupResult {
  const title = textOf(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const description = textOf(
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["'][^>]*>/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["'][^>]*>/i)?.[1] ??
      "",
  );
  const plainText = htmlToPlainText(html);
  return {
    title: title || hostnameOf(fallbackUrl) || fallbackUrl,
    url: fallbackUrl,
    snippet: description || plainText.slice(0, 180),
    source: hostnameOf(fallbackUrl),
    structuredName: extractNameNearQuery(plainText, query) ?? null,
    structuredInstitutionName: extractLabeledValue(plainText, ["承保机构", "承保公司", "保险公司", "发行公司", "公司名称"], 80),
    structuredStatus: extractLabeledValue(plainText, ["销售状态", "产品状态", "状态"], 30),
    structuredSaleDate: extractDateLikeValue(plainText, ["发布日期", "上市时间", "销售日期", "生效日期", "备案日期"]),
    structuredTermsNo: extractTermsNo(plainText),
  };
}

async function crawlPublicResultPages(results: InsuranceLookupResult[], query: string): Promise<InsuranceLookupResult[]> {
  const targets = results
    .map((item) => item.url)
    .filter((url) => /^https?:\/\//i.test(url))
    .slice(0, 3);

  const crawled: InsuranceLookupResult[] = [];
  for (const url of targets) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
        headers: {
          "User-Agent": "MMH insurance product lookup crawler",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.includes("text/html")) continue;
      const html = (await response.text()).slice(0, 240_000);
      const parsed = parseHtmlSummary(html, url, query);
      parsed.structuredName = extractNameNearQuery(
        `${parsed.title}\n${parsed.snippet}\n${htmlToPlainText(html)}`,
        query,
      ) ?? parsed.structuredName;
      crawled.push(parsed);
    } catch {
      // Public pages may reject crawlers; keep lookup usable through other sources.
    } finally {
      clearTimeout(timer);
    }
  }
  return crawled;
}

export function buildOfficialInsuranceSources(query: string): InsuranceLookupResult[] {
  return [
    {
      title: "中国保险行业协会人身保险产品信息库",
      url: OFFICIAL_QUERY_URL,
      snippet: `官方消费者查询入口。请在页面内用“${query}”核对产品名称、公司与条款，部分详情需要验证码查看。`,
      source: "tiaokuan.iachina.cn",
    },
    {
      title: "中国保险行业协会消费者查询说明",
      url: IA_CHINA_CONSUMER_ENTRY,
      snippet: "中国保险行业协会公开的人身保险产品信息库入口说明。",
      source: "iachina.cn",
    },
  ];
}

export async function lookupInsuranceProductByName(
  query: string,
  options: { institutionName?: string | null } = {},
): Promise<InsuranceProductLookup> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("保险产品名称不能为空");
  }

  const institutionName = options.institutionName?.trim() || null;
  const searchUrl = new URL("https://cn.bing.com/search");
  searchUrl.searchParams.set("format", "rss");
  searchUrl.searchParams.set("q", `${institutionName ? `${institutionName} ` : ""}${trimmed} 保险 条款 产品 保险公司`);

  const officialProducts = await lookupOfficialProductList(trimmed, institutionName);
  let webResults: InsuranceLookupResult[] = [];
  try {
    const response = await fetch(searchUrl, {
      cache: "no-store",
      headers: {
        "User-Agent": "MMH insurance product lookup",
        Accept: "application/rss+xml, application/xml, text/xml",
      },
    });
    if (response.ok) {
      webResults = parseBingRss(await response.text());
    }
  } catch (error) {
    console.warn("insurance product web lookup failed", error);
  }
  const crawledPages = await crawlPublicResultPages(webResults, trimmed);
  const candidates = buildCandidates(trimmed, institutionName, officialProducts, crawledPages, webResults);

  return {
    query: trimmed,
    institutionName,
    candidates,
    officialProducts,
    officialSources: buildOfficialInsuranceSources(trimmed),
    webResults,
    crawledPages,
    suggestion: buildSuggestion(trimmed, [...webResults, ...crawledPages], officialProducts),
    searchedAt: new Date().toISOString(),
  };
}
