import type { StatementWorkbookSheetRows } from "@/lib/statement/alipay-template";

/**
 * Normalized row layout produced by the WeChat bill template.
 * Mirrors the Alipay template layout so downstream preview/import
 * pipelines can consume both without changes:
 * [0]  \u65e5\u671f (date, may include time portion)
 * [1]  \u6536\u652f\u5927\u7c7b (majorType)
 * [2]  \u6d41\u51fa (outflow)
 * [3]  \u6d41\u5165 (inflow)
 * [4]  \u91d1\u989d (amount)
 * [5]  \u8d26\u6237 (account)
 * [6]  \u5bf9\u5411\u8d26\u6237 (counter account)
 * [7]  \u5206\u7c7b (category)
 * [8]  \u6536\u652f\u673a\u6784 (institution)
 * [9]  \u5907\u6ce8 (visible remark)
 * [10] \u7b2c\u4e8c\u5907\u6ce8 (match remark)
 */
export type NormalizedWechatWorkbookRows = {
  rows: string[][];
  sourceDataRowCount: number;
  includedSheetCount: number;
  profile: "wechat";
};

export type WechatImportTemplate = {
  key: "wechat";
  title: string;
  description: string;
  status: string;
  filename: string;
  downloadFormat: "xlsx";
  sheetName: string;
  headers: string[];
  rows: string[][];
  fields: Array<{ name: string; label: string; required: boolean; note: string }>;
  guideNotes: string[];
};

const NORMALIZED_HEADERS = [
  "\u65e5\u671f",
  "\u6536\u652f\u5927\u7c7b",
  "\u6d41\u51fa",
  "\u6d41\u5165",
  "\u91d1\u989d",
  "\u8d26\u6237",
  "\u5bf9\u5411\u8d26\u6237",
  "\u5206\u7c7b",
  "\u6536\u652f\u673a\u6784",
  "\u5907\u6ce8",
  "\u7b2c\u4e8c\u5907\u6ce8",
];

const WECHAT_INSTITUTION = "\u5fae\u4fe1";
const WECHAT_DEFAULT_ACCOUNT = "\u5fae\u4fe1\u96f6\u94b1";

const WECHAT_AMOUNT_HEADERS = [
  "\u91d1\u989d",
  "\u91d1\u989d(\u5143)",
  "\u91d1\u989d\uff08\u5143\uff09",
];

const WECHAT_FLOW_HEADERS = [
  "\u6536/\u652f",
  "\u6536\uff0f\u652f",
  "\u6536\u652f",
];

const WECHAT_OWNER_HEADERS = [
  "\u5fae\u4fe1\u6635\u79f0",
  "\u6635\u79f0",
  "\u7528\u6237",
  "\u7528\u6237\u540d",
  "\u6240\u6709\u4eba",
  "\u8d26\u6237\u6240\u6709\u4eba",
  "\u59d3\u540d",
];

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeHeader(value: string) {
  return cleanText(value).replace(/\s+/g, "").replace(/[\uff1a:]/g, "").toLowerCase();
}

function findHeaderIndex(headers: readonly string[], aliases: readonly string[]) {
  const normalizedHeaders = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const index = normalizedHeaders.indexOf(normalizeHeader(alias));
    if (index >= 0) return index;
  }
  return -1;
}

function readCell(row: string[], index: number) {
  return index >= 0 ? cleanText(row[index]) : "";
}

function compactJoin(parts: Array<string | undefined>) {
  return parts.map((part) => cleanText(part)).filter(Boolean).join(" / ");
}

function parseAmount(value: string) {
  const amount = Number(cleanText(value).replace(/[,\uff0c\uffe5\u00a5\s]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? String(amount) : "";
}

/**
 * Normalize a WeChat transaction time cell into YYYY-MM-DD,
 * preserving the time portion (HH:mm[:ss]) when present.
 */
function normalizeWechatDate(value: string) {
  const raw = cleanText(value).replace(/\s+/g, " ");
  const match = raw.match(/^(\d{4})[/.\-\u5e74](\d{1,2})[/.\-\u6708](\d{1,2})\u65e5?(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/);
  if (!match) return raw;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return raw;
  const datePart = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const timePart = match[4]?.trim();
  return timePart ? `${datePart} ${timePart}` : datePart;
}

/**
 * Normalize a WeChat text cell. The value "/" means "no data" in WeChat
 * bill exports and should be treated as empty.
 */
function normalizeWechatText(value: string) {
  const normalized = cleanText(value);
  if (!normalized || normalized === "/") return "";
  return normalized;
}

function unwrapHeaderValue(value: string) {
  return cleanText(value)
    .replace(/^[\s\[\(\uff08\u3010\u3014]+/, "")
    .replace(/[\s\]\)\uff09\u3011\u3015]+$/, "")
    .trim();
}

function isUsefulOwnerHint(value: string) {
  if (!value || value.length > 40) return false;
  return !/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(value) &&
    !/\u8d26\u5355|\u5bfc\u51fa|\u8d77\u59cb|\u7ec8\u6b62|\u4ea4\u6613|\u65f6\u95f4/.test(value);
}

function normalizeWechatOwnerHint(value: string) {
  const hint = unwrapHeaderValue(value);
  return isUsefulOwnerHint(hint) ? hint : "";
}

function findWechatOwnerHint(rows: string[][], headerRowIndex: number) {
  for (const row of rows.slice(0, headerRowIndex)) {
    for (let index = 0; index < row.length; index += 1) {
      const cell = cleanText(row[index]);
      if (!cell) continue;

      const directLabel = WECHAT_OWNER_HEADERS.some((header) => normalizeHeader(cell) === normalizeHeader(header));
      if (directLabel) {
        const nextValue = normalizeWechatOwnerHint(readCell(row, index + 1));
        if (nextValue) return nextValue;
      }

      const labelValueMatch = cell.match(/^([^:\uff1a]{1,16})[:\uff1a]\s*(.+)$/);
      if (!labelValueMatch) continue;
      const label = labelValueMatch[1] ?? "";
      const value = labelValueMatch[2] ?? "";
      const matchesOwnerLabel = WECHAT_OWNER_HEADERS.some((header) => normalizeHeader(label) === normalizeHeader(header));
      if (!matchesOwnerLabel) continue;
      const hint = normalizeWechatOwnerHint(value);
      if (hint) return hint;
    }
  }
  return "";
}

function buildWechatVisibleRemark(transactionType: string, counterparty: string, product: string, rawRemark: string) {
  const parts = [transactionType, counterparty, product].filter(Boolean);
  if (rawRemark && !parts.some((part) => part.includes(rawRemark) || rawRemark.includes(part))) {
    parts.push(rawRemark);
  }
  return compactJoin(parts);
}

function isWechatBalanceAccountText(value: string) {
  const key = normalizeHeader(value).replace(/[.\u00b7\u2022\-_]/g, "");
  return !key || key === "/" || key === "\u96f6\u94b1" || key === "\u5fae\u4fe1\u96f6\u94b1";
}

/**
 * Normalize the payment method column into an account name. When the value
 * is "/" (unspecified), default to the WeChat balance account.
 */
function normalizeWechatPaymentAccount(value: string, ownerHint: string) {
  const raw = cleanText(value);
  if (isWechatBalanceAccountText(raw)) {
    return ownerHint ? `${ownerHint}${WECHAT_DEFAULT_ACCOUNT}` : WECHAT_DEFAULT_ACCOUNT;
  }
  return raw;
}

/**
 * Returns true for rows that should be skipped because the transaction
 * was fully refunded or returned by the counterparty.
 */
function isIgnoredWechatStatus(value: string) {
  return /\u5df2\u5168\u989d\u9000\u6b3e|\u5df2\u9000\u8fd8/.test(value);
}

function classifyWechatFlow(flow: string) {
  if (/^(\u6536\u5165|income|inflow|\u53ce\u5165)$/i.test(flow)) return { majorType: "\u6536\u5165", outflow: false, inflow: true, requiresReview: false };
  if (/^(\u652f\u51fa|expense|outflow|\u652f\u6255\u3044|\u652f\u6255)$/i.test(flow)) return { majorType: "\u652f\u51fa", outflow: true, inflow: false, requiresReview: false };
  return null;
}

function fallbackWechatFlow() {
  return { majorType: "\u652f\u51fa", outflow: true, inflow: false, requiresReview: true };
}

function findWechatHeaderRow(rows: string[][]) {
  for (const [index, row] of rows.slice(0, 25).entries()) {
    const timeIndex = findHeaderIndex(row, ["\u4ea4\u6613\u65f6\u95f4"]);
    const flowIndex = findHeaderIndex(row, WECHAT_FLOW_HEADERS);
    const amountIndex = findHeaderIndex(row, WECHAT_AMOUNT_HEADERS);
    const accountIndex = findHeaderIndex(row, ["\u652f\u4ed8\u65b9\u5f0f"]);
    const statusIndex = findHeaderIndex(row, ["\u5f53\u524d\u72b6\u6001", "\u4ea4\u6613\u72b6\u6001"]);
    if (timeIndex >= 0 && flowIndex >= 0 && amountIndex >= 0 && accountIndex >= 0 && statusIndex >= 0) {
      return index;
    }
  }
  return -1;
}

function normalizeWechatSheetRows(sheet: StatementWorkbookSheetRows) {
  const compactRows = sheet.rows.filter((row) => row.some((cell) => cleanText(cell)));
  const headerRowIndex = findWechatHeaderRow(compactRows);
  if (headerRowIndex < 0) return null;

  const headers = compactRows[headerRowIndex] ?? [];
  const dataRows = compactRows.slice(headerRowIndex + 1);
  const ownerHint = findWechatOwnerHint(compactRows, headerRowIndex);
  const timeIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u65f6\u95f4"]);
  const counterpartyIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u5bf9\u65b9"]);
  const productIndex = findHeaderIndex(headers, ["\u5546\u54c1", "\u5546\u54c1\u8bf4\u660e", "\u5546\u54c1\u540d\u79f0"]);
  const flowIndex = findHeaderIndex(headers, WECHAT_FLOW_HEADERS);
  const amountIndex = findHeaderIndex(headers, WECHAT_AMOUNT_HEADERS);
  const accountIndex = findHeaderIndex(headers, ["\u652f\u4ed8\u65b9\u5f0f"]);
  const statusIndex = findHeaderIndex(headers, ["\u5f53\u524d\u72b6\u6001", "\u4ea4\u6613\u72b6\u6001"]);
  const transactionTypeIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u7c7b\u578b"]);
  const orderIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u5355\u53f7"]);
  const merchantOrderIndex = findHeaderIndex(headers, ["\u5546\u6237\u5355\u53f7"]);
  const remarkIndex = findHeaderIndex(headers, ["\u5907\u6ce8"]);

  const normalizedRows = dataRows.flatMap((row) => {
    const status = readCell(row, statusIndex);
    const flow = readCell(row, flowIndex);
    const amount = parseAmount(readCell(row, amountIndex));
    const date = normalizeWechatDate(readCell(row, timeIndex));
    if (!date || !amount) return [];

    const classifiedFlow = classifyWechatFlow(flow) ?? fallbackWechatFlow();
    const requiresReview = classifiedFlow.requiresReview || isIgnoredWechatStatus(status);

    const counterparty = normalizeWechatText(readCell(row, counterpartyIndex));
    const product = normalizeWechatText(readCell(row, productIndex));
    const transactionType = normalizeWechatText(readCell(row, transactionTypeIndex));
    const rawRemark = normalizeWechatText(readCell(row, remarkIndex));
    const account = normalizeWechatPaymentAccount(readCell(row, accountIndex), ownerHint);
    const orderNo = readCell(row, orderIndex);
    const merchantOrderNo = readCell(row, merchantOrderIndex);

    const visibleRemark = buildWechatVisibleRemark(transactionType, counterparty, product, rawRemark);
    const matchRemark = compactJoin([
      requiresReview ? `\u5bfc\u5165\u515c\u5e95:\u8bf7\u786e\u8ba4\u7c7b\u578b\u548c\u8d26\u6237` : "",
      flow && requiresReview ? `\u539f\u6536\u652f:${flow}` : "",
      rawRemark && !visibleRemark.includes(rawRemark) ? `\u539f\u59cb\u5907\u6ce8:${rawRemark}` : "",
      orderNo ? `\u5fae\u4fe1\u5355\u53f7:${orderNo}` : "",
      merchantOrderNo ? `\u5546\u6237\u5355\u53f7:${merchantOrderNo}` : "",
      status && (requiresReview || !/\u5df2\u5168\u989d\u9000\u6b3e|\u5df2\u9000\u8fd8/.test(status)) ? `\u72b6\u6001:${status}` : "",
    ]);

    return [[
      date,
      classifiedFlow.majorType,
      classifiedFlow.outflow ? amount : "",
      classifiedFlow.inflow ? amount : "",
      amount,
      requiresReview ? "" : account,
      "",
      "",
      WECHAT_INSTITUTION,
      visibleRemark,
      matchRemark,
    ]];
  });

  return {
    rows: normalizedRows,
    sourceDataRowCount: dataRows.length,
  };
}

export function normalizeWechatWorkbookRows(
  sheetRows: readonly StatementWorkbookSheetRows[],
): NormalizedWechatWorkbookRows | null {
  const normalizedSheets = sheetRows
    .map(normalizeWechatSheetRows)
    .filter((sheet): sheet is { rows: string[][]; sourceDataRowCount: number } => Boolean(sheet));
  if (normalizedSheets.length === 0) return null;

  return {
    rows: [NORMALIZED_HEADERS, ...normalizedSheets.flatMap((sheet) => sheet.rows)],
    sourceDataRowCount: normalizedSheets.reduce((sum, sheet) => sum + sheet.sourceDataRowCount, 0),
    includedSheetCount: normalizedSheets.length,
    profile: "wechat",
  };
}


export function buildWechatImportTemplate(t: (key: string, params?: Record<string, string | number>) => string): WechatImportTemplate {
  return {
    key: "wechat",
    title: t("batchImport.template.wechat.title"),
    description: t("batchImport.template.wechat.description"),
    status: t("batchImport.template.normal.status"),
    filename: t("batchImport.template.wechat.filename") + ".xlsx",
    downloadFormat: "xlsx",
    sheetName: t("batchImport.sheet.template"),
    headers: [
      "\u4ea4\u6613\u65f6\u95f4",
      "\u6536/\u652f",
      "\u91d1\u989d(\u5143)",
      "\u652f\u4ed8\u65b9\u5f0f",
      "\u5f53\u524d\u72b6\u6001",
      "\u4ea4\u6613\u7c7b\u578b",
      "\u4ea4\u6613\u5bf9\u65b9",
      "\u5546\u54c1",
      "\u5907\u6ce8",
      "\u4ea4\u6613\u5355\u53f7",
      "\u5546\u6237\u5355\u53f7",
    ],
    rows: [
      [
        "2026-06-08 08:12:30",
        "\u652f\u51fa",
        "32.50",
        t("batchImport.template.sample.wechatBalance"),
        "\u652f\u4ed8\u6210\u529f",
        "\u5546\u6237\u6d88\u8d39",
        t("viewImport.sampleMerchantFastFood"),
        t("viewImport.sampleRemarkLunch"),
        t("viewImport.sampleRemarkLunch"),
        "WX202606080001",
        "M202606080001",
      ],
      [
        "2026-06-09 12:30:00",
        "\u6536\u5165",
        "100.00",
        t("batchImport.template.sample.wechatBalance"),
        "\u5df2\u5165\u8d26",
        "\u7ea2\u5305",
        t("batchImport.template.sample.wechatFriend"),
        t("batchImport.template.sample.wechatRedPacket"),
        t("viewImport.sampleRemarkTransfer"),
        "WX202606090002",
        "M202606090002",
      ],
      [
        "2026-06-10 18:00:00",
        "\u652f\u51fa",
        "108.00",
        t("batchImport.template.sample.wechatBalance"),
        "\u5df2\u5168\u989d\u9000\u6b3e",
        "\u5546\u6237\u6d88\u8d39",
        t("viewImport.sampleMerchantRestaurant"),
        t("batchImport.template.sample.wechatRefund"),
        t("viewImport.sampleRemarkCreditCardRefund"),
        "WX202606100003",
        "M202606100003",
      ],
    ],
    fields: [
      { name: "transactionTime", label: t("batchImport.template.wechat.label.transactionTime"), required: true, note: t("batchImport.template.wechat.field.transactionTime") },
      { name: "flow", label: t("batchImport.template.wechat.label.flow"), required: true, note: t("batchImport.template.wechat.field.flow") },
      { name: "amount", label: t("batchImport.template.wechat.label.amount"), required: true, note: t("batchImport.template.wechat.field.amount") },
      { name: "paymentAccount", label: t("batchImport.template.wechat.label.paymentAccount"), required: true, note: t("batchImport.template.wechat.field.paymentAccount") },
      { name: "status", label: t("batchImport.template.wechat.label.status"), required: false, note: t("batchImport.template.wechat.field.status") },
      { name: "transactionType", label: t("batchImport.template.wechat.label.transactionType"), required: false, note: t("batchImport.template.wechat.field.transactionType") },
      { name: "counterparty", label: t("batchImport.template.wechat.label.counterparty"), required: true, note: t("batchImport.template.wechat.field.counterparty") },
      { name: "product", label: t("batchImport.template.wechat.label.product"), required: false, note: t("batchImport.template.wechat.field.product") },
      { name: "remark", label: t("batchImport.template.wechat.label.remark"), required: false, note: t("batchImport.template.wechat.field.remark") },
      { name: "orderNo", label: t("batchImport.template.wechat.label.orderNo"), required: false, note: t("batchImport.template.wechat.field.orderNo") },
      { name: "merchantOrderNo", label: t("batchImport.template.wechat.label.merchantOrderNo"), required: false, note: t("batchImport.template.wechat.field.merchantOrderNo") },
    ],
    guideNotes: [
      t("batchImport.guide.currentSupport"),
      t("batchImport.guide.wechatBill"),
    ],
  };
}
