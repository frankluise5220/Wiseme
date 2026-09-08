import { Prisma, StockFeeType, StockTradeDirection } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { normalizeStockCode, normalizeStockMarket, stockFeeRuleMarketKeys } from "@/lib/stock/market";

type TxClient = Prisma.TransactionClient | typeof prisma;

const STOCK_FEE_TYPES = [
  StockFeeType.commission,
  StockFeeType.stamp_tax,
  StockFeeType.transfer_fee,
  StockFeeType.exchange_fee,
  StockFeeType.regulatory_fee,
  StockFeeType.platform_fee,
  StockFeeType.other,
] as const;

const OFFICIAL_CN_A_SHARE_FEE_DEFAULTS: Array<{
  market: string;
  feeType: StockFeeType;
  direction: StockTradeDirection;
  rate: number;
  effectiveDate: string;
  sourceUrl: string;
  note: string;
}> = [
  {
    market: "CN_SH",
    feeType: StockFeeType.stamp_tax,
    direction: StockTradeDirection.sell,
    rate: 0.0005,
    effectiveDate: "2023-08-28",
    sourceUrl: "https://one.sse.com.cn/onething/gptz/",
    note: "沪市A股印花税，向出让方单边征收。",
  },
  {
    market: "CN_SH",
    feeType: StockFeeType.regulatory_fee,
    direction: StockTradeDirection.both,
    rate: 0.00002,
    effectiveDate: "2023-08-28",
    sourceUrl: "https://one.sse.com.cn/onething/gptz/",
    note: "沪市A股证管费，双向收取。",
  },
  {
    market: "CN_SH",
    feeType: StockFeeType.exchange_fee,
    direction: StockTradeDirection.both,
    rate: 0.0000341,
    effectiveDate: "2023-08-28",
    sourceUrl: "https://one.sse.com.cn/onething/gptz/",
    note: "沪市A股证券交易经手费，双向收取。",
  },
  {
    market: "CN_SH",
    feeType: StockFeeType.transfer_fee,
    direction: StockTradeDirection.both,
    rate: 0.00001,
    effectiveDate: "2022-04-29",
    sourceUrl: "https://one.sse.com.cn/onething/gptz/",
    note: "沪市A股过户费，双向收取。",
  },
  {
    market: "CN_SZ",
    feeType: StockFeeType.stamp_tax,
    direction: StockTradeDirection.sell,
    rate: 0.0005,
    effectiveDate: "2023-08-28",
    sourceUrl: "https://fgk.chinatax.gov.cn/zcfgk/c102416/c5211343/content.html",
    note: "深市A股印花税，向出让方单边征收。",
  },
  {
    market: "CN_SZ",
    feeType: StockFeeType.regulatory_fee,
    direction: StockTradeDirection.both,
    rate: 0.00002,
    effectiveDate: "2023-08-28",
    sourceUrl: "https://www.szse.cn/marketServices/deal/payFees/",
    note: "深市A股证券交易监管费，双向收取。",
  },
  {
    market: "CN_SZ",
    feeType: StockFeeType.exchange_fee,
    direction: StockTradeDirection.both,
    rate: 0.0000341,
    effectiveDate: "2023-08-28",
    sourceUrl: "https://www.szse.cn/marketServices/deal/payFees/",
    note: "深市A股证券交易经手费，双向收取。",
  },
  {
    market: "CN_SZ",
    feeType: StockFeeType.transfer_fee,
    direction: StockTradeDirection.both,
    rate: 0.00001,
    effectiveDate: "2022-04-29",
    sourceUrl: "https://one.sse.com.cn/onething/gptz/",
    note: "A股过户费，双向收取。",
  },
];

export type StockFeeDraft = {
  fee: number | null;
  commission: number | null;
  stampTax: number | null;
  transferFee: number | null;
  exchangeFee: number | null;
  regulatoryFee: number | null;
  otherFee: number | null;
};

export function normalizeStockFeeType(raw: unknown): StockFeeType {
  const value = String(raw ?? "").trim();
  return Object.values(StockFeeType).includes(value as StockFeeType)
    ? (value as StockFeeType)
    : StockFeeType.commission;
}

export function normalizeStockTradeDirection(raw: unknown): StockTradeDirection {
  const value = String(raw ?? "").trim();
  return Object.values(StockTradeDirection).includes(value as StockTradeDirection)
    ? (value as StockTradeDirection)
    : StockTradeDirection.both;
}

function parseOptionalNumber(raw: unknown) {
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function directionFilter(direction: StockTradeDirection) {
  return direction === StockTradeDirection.both
    ? [StockTradeDirection.both]
    : [direction, StockTradeDirection.both];
}

function ruleSpecificityScore(rule: {
  securityId?: string | null;
  market?: string | null;
  stockCode?: string | null;
  direction: StockTradeDirection;
  effectiveDate: Date;
}, params: {
  securityId?: string | null;
  marketKeys: string[];
  stockCode?: string | null;
  direction: StockTradeDirection;
}) {
  let score = 0;
  if (params.securityId && rule.securityId === params.securityId) score += 100;
  if (rule.market && params.marketKeys.includes(rule.market) && rule.stockCode && rule.stockCode === params.stockCode) score += 80;
  if (rule.market && params.marketKeys.includes(rule.market) && !rule.stockCode) score += 60;
  if (!rule.securityId && !rule.market && !rule.stockCode) score += 10;
  if (params.direction !== StockTradeDirection.both && rule.direction === params.direction) score += 5;
  return score;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function dateUtc(raw: string) {
  return new Date(`${raw}T00:00:00.000Z`);
}

function calculateFeeFromRule(rule: {
  rate?: Prisma.Decimal | number | null;
  amount?: Prisma.Decimal | number | null;
  minAmount?: Prisma.Decimal | number | null;
} | null, grossAmount: number) {
  if (!rule || grossAmount <= 0) return null;
  const amount = rule.amount == null ? null : Number(rule.amount);
  const rate = rule.rate == null ? null : Number(rule.rate);
  const minAmount = rule.minAmount == null ? null : Number(rule.minAmount);
  const base = amount != null
    ? amount
    : rate != null
      ? grossAmount * rate
      : 0;
  const value = minAmount != null ? Math.max(base, minAmount) : base;
  return Number.isFinite(value) ? roundMoney(Math.max(0, value)) : null;
}

export function totalStockFeeDraft(fees: Partial<StockFeeDraft>) {
  return roundMoney(
    Math.max(0, Number(fees.fee ?? 0)) +
    Math.max(0, Number(fees.commission ?? 0)) +
    Math.max(0, Number(fees.stampTax ?? 0)) +
    Math.max(0, Number(fees.transferFee ?? 0)) +
    Math.max(0, Number(fees.exchangeFee ?? 0)) +
    Math.max(0, Number(fees.regulatoryFee ?? 0)) +
    Math.max(0, Number(fees.otherFee ?? 0)),
  );
}

export async function upsertStockMarketFeeDefaultRules(client: TxClient = prisma) {
  let updatedCount = 0;
  for (const item of OFFICIAL_CN_A_SHARE_FEE_DEFAULTS) {
    const existing = await client.stockMarketFeeRule.findFirst({
      where: {
        householdId: null,
        market: item.market,
        stockCode: null,
        feeType: item.feeType,
        direction: item.direction,
        source: "official_default",
      },
      orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }],
    });
    const data = {
      householdId: null,
      market: item.market,
      stockCode: null,
      feeType: item.feeType,
      direction: item.direction,
      rate: item.rate,
      amount: null,
      minAmount: null,
      currency: "CNY",
      effectiveDate: dateUtc(item.effectiveDate),
      source: "official_default",
      sourceUrl: item.sourceUrl,
      note: item.note,
    };
    if (existing) {
      await client.stockMarketFeeRule.update({ where: { id: existing.id }, data });
    } else {
      await client.stockMarketFeeRule.create({ data });
    }
    updatedCount += 1;
  }
  return updatedCount;
}

export async function getStockFeeRuleByDate(
  params: {
    accountId: string;
    feeType: StockFeeType | string;
    tradeDate: Date;
    direction?: StockTradeDirection | string | null;
    securityId?: string | null;
    market?: string | null;
    stockCode?: string | null;
  },
  client: TxClient = prisma,
) {
  const feeType = normalizeStockFeeType(params.feeType);
  const direction = normalizeStockTradeDirection(params.direction);
  const market = params.market ? normalizeStockMarket(params.market) : null;
  const stockCode = params.stockCode ? normalizeStockCode(params.stockCode) : null;
  const marketKeys = market ? stockFeeRuleMarketKeys(market, stockCode) : [];
  const directions = directionFilter(direction);

  const rules = await client.stockFeeRule.findMany({
    where: {
      accountId: params.accountId,
      feeType,
      direction: { in: directions },
      effectiveDate: { lte: params.tradeDate },
      OR: [
        ...(params.securityId ? [{ securityId: params.securityId }] : []),
        ...(marketKeys.length > 0 && stockCode
          ? marketKeys.map((marketKey) => ({ market: marketKey, stockCode }))
          : []),
        ...(marketKeys.length > 0
          ? marketKeys.map((marketKey) => ({ market: marketKey, stockCode: null }))
          : []),
        { securityId: null, market: null, stockCode: null },
      ],
    },
    orderBy: [{ effectiveDate: "desc" }, { securityId: "desc" }, { stockCode: "desc" }],
  });

  return rules
    .map((rule) => ({
      rule,
      score: ruleSpecificityScore(rule, { securityId: params.securityId, marketKeys, stockCode, direction }),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.rule.effectiveDate.getTime() - a.rule.effectiveDate.getTime())
    [0]?.rule ?? null;
}

export async function getStockMarketFeeRuleByDate(
  params: {
    householdId?: string | null;
    feeType: StockFeeType | string;
    tradeDate: Date;
    direction?: StockTradeDirection | string | null;
    market?: string | null;
    stockCode?: string | null;
  },
  client: TxClient = prisma,
) {
  const feeType = normalizeStockFeeType(params.feeType);
  const direction = normalizeStockTradeDirection(params.direction);
  const market = params.market ? normalizeStockMarket(params.market) : null;
  const stockCode = params.stockCode ? normalizeStockCode(params.stockCode) : null;
  const marketKeys = market ? stockFeeRuleMarketKeys(market, stockCode) : [];
  const directions = directionFilter(direction);
  if (marketKeys.length === 0) return null;

  const householdScopes = params.householdId
    ? [{ householdId: params.householdId }, { householdId: null }]
    : [{ householdId: null }];

  const rules = await client.stockMarketFeeRule.findMany({
    where: {
      OR: householdScopes,
      feeType,
      direction: { in: directions },
      effectiveDate: { lte: params.tradeDate },
      AND: [{
        OR: [
          ...(stockCode ? marketKeys.map((marketKey) => ({ market: marketKey, stockCode })) : []),
          ...marketKeys.map((marketKey) => ({ market: marketKey, stockCode: null })),
        ],
      }],
    },
    orderBy: [{ effectiveDate: "desc" }, { stockCode: "desc" }],
  });

  return rules
    .map((rule) => ({
      rule,
      score: ruleSpecificityScore(rule, { marketKeys, stockCode, direction }),
      householdScore: params.householdId && rule.householdId === params.householdId ? 1 : 0,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) =>
      b.score - a.score
      || b.householdScore - a.householdScore
      || b.rule.effectiveDate.getTime() - a.rule.effectiveDate.getTime()
    )
    [0]?.rule ?? null;
}

export async function calculateStockTransactionFeesByDate(
  params: {
    accountId: string;
    tradeDate: Date;
    grossAmount: number;
    direction: StockTradeDirection | string;
    securityId?: string | null;
    market?: string | null;
    stockCode?: string | null;
    overrides?: Partial<StockFeeDraft>;
  },
  client: TxClient = prisma,
): Promise<StockFeeDraft> {
  const grossAmount = Number.isFinite(params.grossAmount) ? Math.max(0, params.grossAmount) : 0;
  const direction = normalizeStockTradeDirection(params.direction);
  const account = await client.account.findUnique({
    where: { id: params.accountId },
    select: { householdId: true },
  });
  const result: StockFeeDraft = {
    fee: params.overrides?.fee ?? null,
    commission: params.overrides?.commission ?? null,
    stampTax: params.overrides?.stampTax ?? null,
    transferFee: params.overrides?.transferFee ?? null,
    exchangeFee: params.overrides?.exchangeFee ?? null,
    regulatoryFee: params.overrides?.regulatoryFee ?? null,
    otherFee: params.overrides?.otherFee ?? null,
  };

  let computedOtherFee = 0;
  let hasComputedOtherFee = false;
  for (const feeType of STOCK_FEE_TYPES) {
    if (feeType === StockFeeType.commission && result.commission != null) continue;
    if (feeType === StockFeeType.stamp_tax && result.stampTax != null) continue;
    if (feeType === StockFeeType.transfer_fee && result.transferFee != null) continue;
    if (feeType === StockFeeType.exchange_fee && result.exchangeFee != null) continue;
    if (feeType === StockFeeType.regulatory_fee && result.regulatoryFee != null) continue;
    if ((feeType === StockFeeType.platform_fee || feeType === StockFeeType.other) && result.otherFee != null) continue;

    const accountRule = await getStockFeeRuleByDate({
      accountId: params.accountId,
      feeType,
      direction,
      tradeDate: params.tradeDate,
      securityId: params.securityId,
      market: params.market,
      stockCode: params.stockCode,
    }, client);
    const rule = accountRule ?? await getStockMarketFeeRuleByDate({
      householdId: account?.householdId ?? null,
      feeType,
      direction,
      tradeDate: params.tradeDate,
      market: params.market,
      stockCode: params.stockCode,
    }, client);
    const amount = calculateFeeFromRule(rule, grossAmount);
    if (amount == null) continue;

    if (feeType === StockFeeType.commission) result.commission = amount;
    else if (feeType === StockFeeType.stamp_tax) result.stampTax = amount;
    else if (feeType === StockFeeType.transfer_fee) result.transferFee = amount;
    else if (feeType === StockFeeType.exchange_fee) result.exchangeFee = amount;
    else if (feeType === StockFeeType.regulatory_fee) result.regulatoryFee = amount;
    else {
      computedOtherFee += amount;
      hasComputedOtherFee = true;
    }
  }

  if (result.otherFee == null && hasComputedOtherFee) result.otherFee = roundMoney(computedOtherFee);
  return result;
}

export async function setStockFeeRule(
  params: {
    accountId: string;
    feeType: StockFeeType | string;
    direction?: StockTradeDirection | string | null;
    rate?: unknown;
    amount?: unknown;
    minAmount?: unknown;
    effectiveDate?: Date | null;
    securityId?: string | null;
    market?: string | null;
    stockCode?: string | null;
    currency?: string | null;
    source?: string | null;
    note?: string | null;
  },
  client: TxClient = prisma,
) {
  const feeType = normalizeStockFeeType(params.feeType);
  const direction = normalizeStockTradeDirection(params.direction);
  const rate = parseOptionalNumber(params.rate);
  const amount = parseOptionalNumber(params.amount);
  const minAmount = parseOptionalNumber(params.minAmount);
  const effectiveDate = params.effectiveDate ?? new Date();
  const market = params.market ? normalizeStockMarket(params.market) : null;
  const stockCode = params.stockCode ? normalizeStockCode(params.stockCode) : null;
  const currency = String(params.currency ?? "CNY").trim().toUpperCase() || "CNY";

  if (rate == null && amount == null) {
    throw new Error("请填写费率或固定金额");
  }

  return client.stockFeeRule.create({
    data: {
      accountId: params.accountId,
      securityId: params.securityId ?? null,
      market,
      stockCode,
      feeType,
      direction,
      rate,
      amount,
      minAmount,
      currency,
      effectiveDate,
      source: String(params.source ?? "manual").trim() || "manual",
      note: String(params.note ?? "").trim() || null,
    },
  });
}
