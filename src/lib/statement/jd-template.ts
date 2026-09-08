import type { StatementWorkbookSheetRows } from "@/lib/statement/alipay-template";

export type NormalizedJdWorkbookRows = {
  rows: string[][];
  sourceDataRowCount: number;
  includedSheetCount: number;
  profile: "jd";
};

export type JdImportTemplate = {
  key: "jd";
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

const JD_INSTITUTION = "\u4eac\u4e1c";
const JD_IOU = "\u4eac\u4e1c\u767d\u6761";
const JD_PETTY_CASH = "\u4eac\u4e1c\u5c0f\u91d1\u5e93";

const JD_AMOUNT_HEADERS = [
  "\u91d1\u989d",
  "\u91d1\u989d(\u5143)",
  "\u91d1\u989d\uff08\u5143\uff09",
];

const JD_PAYMENT_ACCOUNT_HEADERS = [
  "\u6536/\u4ed8\u6b3e\u65b9\u5f0f",
  "\u6536\u4ed8\u6b3e\u65b9\u5f0f",
  "\u4ed8\u6b3e\u65b9\u5f0f",
  "\u6536\u6b3e\u65b9\u5f0f",
  "\u8d44\u91d1\u6e20\u9053",
  "\u6263\u6b3e\u65b9\u5f0f",
];

const JD_FLOW_HEADERS = [
  "\u6536/\u652f",
  "\u6536\uff0f\u652f",
  "\u6536\u652f",
];

const JD_OWNER_HEADERS = [
  "\u4eac\u4e1c\u8d26\u53f7\u540d",
  "\u8d26\u53f7\u540d",
  "\u7528\u6237",
  "\u7528\u6237\u540d",
  "\u6240\u6709\u4eba",
  "\u8d26\u6237\u6240\u6709\u4eba",
  "\u59d3\u540d",
];

function cleanText(value: unknown) {
  return String(value ?? "").replace(/^\ufeff/, "").trim();
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

function stripJdAmountStatusText(value: string) {
  return cleanText(value).replace(/[\uff08(]\s*\u5df2\u5168\u989d\u9000\u6b3e\s*[\uff09)]/g, "");
}

function parseAmount(value: string) {
  const amount = Number(stripJdAmountStatusText(value).replace(/[,\uff0c\uffe5\u00a5\s]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? String(amount) : "";
}

function normalizeJdDate(value: string) {
  const raw = cleanText(value).replace(/\s+/g, " ");
  const match = raw.match(/^(\d{4})[/.\-\u5e74](\d{1,2})[/.\-\u6708](\d{1,2})\u65e5?(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/);
  if (!match) {
    const shortDateMatch = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/);
    if (!shortDateMatch) return raw;
    const shortYear = shortDateMatch[3] ?? "";
    const year = shortYear.length === 2 ? 2000 + Number(shortYear) : Number(shortYear);
    const month = Number(shortDateMatch[1]);
    const day = Number(shortDateMatch[2]);
    if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return raw;
    const datePart = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const timePart = shortDateMatch[4]?.trim();
    return timePart ? `${datePart} ${timePart}` : datePart;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return raw;
  const datePart = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const timePart = match[4]?.trim();
  return timePart ? `${datePart} ${timePart}` : datePart;
}

function normalizeJdText(value: string) {
  const normalized = cleanText(value);
  if (!normalized || normalized === "/" || /^[-\u2013\u2014?]+$/.test(normalized)) return "";
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
    !/\u8d26\u5355|\u5bfc\u51fa|\u8d77\u59cb|\u7ec8\u6b62|\u4ea4\u6613|\u65f6\u95f4|\u4eac\u4e1c/.test(value);
}

function normalizeJdOwnerHint(value: string) {
  const hint = unwrapHeaderValue(value);
  return isUsefulOwnerHint(hint) ? hint : "";
}

function findJdOwnerHint(rows: string[][], headerRowIndex: number) {
  for (const row of rows.slice(0, headerRowIndex)) {
    for (let index = 0; index < row.length; index += 1) {
      const cell = cleanText(row[index]);
      if (!cell) continue;

      const directLabel = JD_OWNER_HEADERS.some((header) => normalizeHeader(cell) === normalizeHeader(header));
      if (directLabel) {
        const nextValue = normalizeJdOwnerHint(row.slice(index + 1).map(cleanText).find(Boolean) ?? "");
        if (nextValue) return nextValue;
      }

      const labelValueMatch = cell.match(/^([^:\uff1a]{1,16})[:\uff1a]\s*(.+)$/);
      if (!labelValueMatch) continue;
      const label = labelValueMatch[1] ?? "";
      const value = labelValueMatch[2] ?? "";
      const matchesOwnerLabel = JD_OWNER_HEADERS.some((header) => normalizeHeader(label) === normalizeHeader(header));
      if (!matchesOwnerLabel) continue;
      const hint = normalizeJdOwnerHint(value);
      if (hint) return hint;
    }
  }
  return "";
}

function normalizeRemarkComparisonText(value: string) {
  return normalizeHeader(value)
    .replace(/[\s/\\|,\uff0c.;\uff1b:\uff1a()[\]{}\uff08\uff09\u3010\u3011<>\u300a\u300b'"\u201c\u201d\u2018\u2019_\-]+/g, "");
}

function stripJdRefundPrefix(value: string) {
  return normalizeJdText(value)
    .replace(/^\u9000\u6b3e[\s_\-\u2013\u2014:：]*/, "")
    .trim();
}

function remarkCategoryKeys(value: string) {
  const keys = new Set<string>();
  for (const candidate of [value, stripJdRefundPrefix(value)]) {
    const key = normalizeRemarkComparisonText(candidate);
    if (key) keys.add(key);
  }
  return Array.from(keys);
}

function isJdManualPaymentAccount(value: string) {
  const key = normalizeHeader(value).replace(/[.\u00b7\u2022\-_]/g, "");
  return key.includes("\u5fae\u4fe1\u652f\u4ed8") || key === "\u5fae\u4fe1" || key.includes("\u4e91\u95ea\u4ed8");
}

function isJdOwnedPaymentAccount(value: string) {
  const key = normalizeHeader(value).replace(/[.\u00b7\u2022\-_]/g, "");
  return [
    "\u4eac\u4e1c\u5c0f\u91d1\u5e93",
    "\u5c0f\u91d1\u5e93",
    "\u4eac\u4e1c\u767d\u6761",
    "\u767d\u6761",
    "\u4eac\u4e1c\u94b1\u5305",
    "\u4eac\u4e1c\u91d1\u878d",
  ].some((alias) => key === normalizeHeader(alias));
}

function normalizeJdPaymentAccount(value: string, ownerHint: string) {
  const raw = normalizeJdText(value);
  if (!raw || isJdManualPaymentAccount(raw)) return "";
  if (ownerHint && isJdOwnedPaymentAccount(raw)) return `${ownerHint}${raw}`;
  return raw;
}

function isIgnoredJdStatus(value: string) {
  return /\u5931\u8d25|\u53d6\u6d88|\u5173\u95ed/.test(value);
}

function isJdRefundSuccess(source: string) {
  return /\u9000\u6b3e\u6210\u529f|\u9000\u6b3e|\u9000\u8d27|\u9000\u56de/.test(source);
}

function isJdFullRefundedAmount(value: string) {
  return /[\uff08(]\s*\u5df2\u5168\u989d\u9000\u6b3e\s*[\uff09)]/.test(value);
}

function isJdRepaymentSuccess(source: string) {
  return /\u8fd8\u6b3e\u6210\u529f|\u6210\u529f\u8fd8\u6b3e|\u4fe1\u7528\u5361\u8fd8\u6b3e|\u8fd8\u6b3e\u5165\u8d26/.test(source);
}

function jdInternalTransferDirection(source: string): "in" | "out" | null {
  const hasTransferIn = /\u8f6c\u5165/.test(source);
  const hasTransferOut = /\u8f6c\u51fa/.test(source);
  if (hasTransferIn === hasTransferOut) return null;
  return hasTransferIn ? "in" : "out";
}

function classifyJdRow(params: {
  flow: string;
  status: string;
  description: string;
  rawRemark: string;
  category: string;
}) {
  const source = compactJoin([params.flow, params.status, params.description, params.rawRemark, params.category]);
  if (isJdRefundSuccess(source)) return { majorType: "\u652f\u51fa", outflow: false, inflow: true, negativeAmount: true, transfer: false, requiresReview: false };
  if (params.flow === "\u6536\u5165") return { majorType: "\u6536\u5165", outflow: false, inflow: true, negativeAmount: false, transfer: false, requiresReview: false };
  if (params.flow === "\u652f\u51fa") return { majorType: "\u652f\u51fa", outflow: true, inflow: false, negativeAmount: false, transfer: false, requiresReview: false };
  if (params.flow === "\u4e0d\u8ba1\u6536\u652f" && isJdRepaymentSuccess(source)) {
    return { majorType: "\u8f6c\u8d26", outflow: true, inflow: false, negativeAmount: false, transfer: true, requiresReview: false };
  }
  return null;
}

function fallbackJdFlow() {
  return { majorType: "\u652f\u51fa", outflow: true, inflow: false, negativeAmount: false, transfer: false, requiresReview: true };
}

function findJdHeaderRow(rows: string[][]) {
  for (const [index, row] of rows.slice(0, 60).entries()) {
    const timeIndex = findHeaderIndex(row, ["\u4ea4\u6613\u65f6\u95f4"]);
    const merchantIndex = findHeaderIndex(row, ["\u5546\u6237\u540d\u79f0"]);
    const descriptionIndex = findHeaderIndex(row, ["\u4ea4\u6613\u8bf4\u660e"]);
    const amountIndex = findHeaderIndex(row, JD_AMOUNT_HEADERS);
    const accountIndex = findHeaderIndex(row, JD_PAYMENT_ACCOUNT_HEADERS);
    const flowIndex = findHeaderIndex(row, JD_FLOW_HEADERS);
    if (timeIndex >= 0 && merchantIndex >= 0 && descriptionIndex >= 0 && amountIndex >= 0 && accountIndex >= 0 && flowIndex >= 0) {
      return index;
    }
  }
  return -1;
}

function buildExpenseCategoryByRemark(dataRows: string[][], indexes: {
  descriptionIndex: number;
  flowIndex: number;
  amountIndex: number;
  categoryIndex: number;
  statusIndex: number;
  remarkIndex: number;
}) {
  const map = new Map<string, string>();
  for (const row of dataRows) {
    const description = normalizeJdText(readCell(row, indexes.descriptionIndex));
    const flow = readCell(row, indexes.flowIndex);
    const rawAmount = readCell(row, indexes.amountIndex);
    const category = normalizeJdText(readCell(row, indexes.categoryIndex));
    const status = readCell(row, indexes.statusIndex);
    const rawRemark = readCell(row, indexes.remarkIndex);
    const source = compactJoin([flow, status, description, rawRemark, category]);
    if (category && !isJdRefundSuccess(source) && (flow === "\u652f\u51fa" || isJdFullRefundedAmount(rawAmount))) {
      for (const key of remarkCategoryKeys(description)) map.set(key, category);
    }
  }
  return map;
}

function normalizeJdSheetRows(sheet: StatementWorkbookSheetRows) {
  const compactRows = sheet.rows.filter((row) => row.some((cell) => cleanText(cell)));
  const headerRowIndex = findJdHeaderRow(compactRows);
  if (headerRowIndex < 0) return null;

  const headers = compactRows[headerRowIndex] ?? [];
  const dataRows = compactRows.slice(headerRowIndex + 1);
  const ownerHint = findJdOwnerHint(compactRows, headerRowIndex);
  const timeIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u65f6\u95f4"]);
  const merchantIndex = findHeaderIndex(headers, ["\u5546\u6237\u540d\u79f0"]);
  const descriptionIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u8bf4\u660e"]);
  const amountIndex = findHeaderIndex(headers, JD_AMOUNT_HEADERS);
  const accountIndex = findHeaderIndex(headers, JD_PAYMENT_ACCOUNT_HEADERS);
  const statusIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u72b6\u6001"]);
  const flowIndex = findHeaderIndex(headers, JD_FLOW_HEADERS);
  const categoryIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u5206\u7c7b"]);
  const orderIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u8ba2\u5355\u53f7"]);
  const merchantOrderIndex = findHeaderIndex(headers, ["\u5546\u5bb6\u8ba2\u5355\u53f7"]);
  const remarkIndex = findHeaderIndex(headers, ["\u5907\u6ce8"]);
  const expenseCategoryByRemark = buildExpenseCategoryByRemark(dataRows, {
    descriptionIndex,
    flowIndex,
    amountIndex,
    categoryIndex,
    statusIndex,
    remarkIndex,
  });

  const normalizedRows = dataRows.flatMap((row) => {
    const status = readCell(row, statusIndex);
    const flow = readCell(row, flowIndex);
    const amount = parseAmount(readCell(row, amountIndex));
    const date = normalizeJdDate(readCell(row, timeIndex));
    if (!date || !amount) return [];

    const merchant = normalizeJdText(readCell(row, merchantIndex));
    const description = normalizeJdText(readCell(row, descriptionIndex));
    const rawRemark = normalizeJdText(readCell(row, remarkIndex));
    const rawCategory = normalizeJdText(readCell(row, categoryIndex));
    const rawAccount = readCell(row, accountIndex);
    const account = normalizeJdPaymentAccount(rawAccount, ownerHint);
    const internalTransferDirection = account && merchant
      ? jdInternalTransferDirection(compactJoin([description, rawRemark]))
      : null;
    const classifiedFlow = internalTransferDirection
      ? {
          majorType: "\u8f6c\u8d26",
          outflow: internalTransferDirection === "out",
          inflow: internalTransferDirection === "in",
          negativeAmount: false,
          transfer: true,
          requiresReview: false,
        }
      : classifyJdRow({ flow, status, description, rawRemark, category: rawCategory }) ?? fallbackJdFlow();
    const requiresReview = classifiedFlow.requiresReview || isIgnoredJdStatus(status);

    // Keep a usable payment account on fallback rows so review does not erase
    // information that can already be matched during preview.
    const transferAccount = internalTransferDirection ? merchant : account;
    const transferCounterAccount = internalTransferDirection ? account : merchant;
    const matchedExpenseCategory = remarkCategoryKeys(description)
      .map((key) => expenseCategoryByRemark.get(key))
      .find(Boolean);
    const category = classifiedFlow.transfer ? "" : matchedExpenseCategory || rawCategory;
    const orderNo = readCell(row, orderIndex);
    const merchantOrderNo = readCell(row, merchantOrderIndex);
    const visibleRemark = description || rawRemark || merchant || rawCategory;
    const matchRemark = compactJoin([
      requiresReview ? `\u5bfc\u5165\u515c\u5e95:\u8bf7\u786e\u8ba4\u7c7b\u578b${account ? "" : "\u548c\u8d26\u6237"}` : "",
      flow && requiresReview ? `\u539f\u6536\u652f:${flow}` : "",
      merchant ? `\u5546\u6237:${merchant}` : "",
      rawRemark && rawRemark !== visibleRemark ? `\u539f\u5907\u6ce8:${rawRemark}` : "",
      rawAccount && rawAccount !== account ? `\u539f\u4ed8\u6b3e\u65b9\u5f0f:${rawAccount}` : "",
      orderNo ? `\u4eac\u4e1c\u8ba2\u5355:${orderNo}` : "",
      merchantOrderNo ? `\u5546\u5bb6\u8ba2\u5355:${merchantOrderNo}` : "",
      status && status !== "\u4ea4\u6613\u6210\u529f" ? `\u72b6\u6001:${status}` : "",
    ]);
    const amountCell = classifiedFlow.negativeAmount ? `-${amount}` : amount;

    return [[
      date,
      classifiedFlow.majorType,
      classifiedFlow.outflow ? amount : "",
      classifiedFlow.inflow ? amount : "",
      amountCell,
      transferAccount,
      classifiedFlow.transfer ? transferCounterAccount : "",
      category,
      JD_INSTITUTION,
      visibleRemark,
      matchRemark,
    ]];
  });

  return {
    rows: normalizedRows,
    sourceDataRowCount: dataRows.length,
  };
}

export function normalizeJdWorkbookRows(
  sheetRows: readonly StatementWorkbookSheetRows[],
): NormalizedJdWorkbookRows | null {
  const normalizedSheets = sheetRows
    .map(normalizeJdSheetRows)
    .filter((sheet): sheet is { rows: string[][]; sourceDataRowCount: number } => Boolean(sheet));
  if (normalizedSheets.length === 0) return null;

  return {
    rows: [NORMALIZED_HEADERS, ...normalizedSheets.flatMap((sheet) => sheet.rows)],
    sourceDataRowCount: normalizedSheets.reduce((sum, sheet) => sum + sheet.sourceDataRowCount, 0),
    includedSheetCount: normalizedSheets.length,
    profile: "jd",
  };
}

export function buildJdImportTemplate(t: (key: string, params?: Record<string, string | number>) => string): JdImportTemplate {
  return {
    key: "jd",
    title: t("batchImport.template.jd.title"),
    description: t("batchImport.template.jd.description"),
    status: t("batchImport.template.normal.status"),
    filename: t("batchImport.template.jd.filename") + ".xlsx",
    downloadFormat: "xlsx",
    sheetName: t("batchImport.sheet.template"),
    headers: [
      "\u4ea4\u6613\u65f6\u95f4",
      "\u5546\u6237\u540d\u79f0",
      "\u4ea4\u6613\u8bf4\u660e",
      "\u91d1\u989d",
      "\u6536/\u4ed8\u6b3e\u65b9\u5f0f",
      "\u4ea4\u6613\u72b6\u6001",
      "\u6536/\u652f",
      "\u4ea4\u6613\u5206\u7c7b",
      "\u4ea4\u6613\u8ba2\u5355\u53f7",
      "\u5546\u5bb6\u8ba2\u5355\u53f7",
      "\u5907\u6ce8",
    ],
    rows: [
      [
        "2026-06-17 12:05:57",
        t("batchImport.template.sample.jdMerchant"),
        t("batchImport.template.sample.jdPhoneOrder"),
        "5299.00",
        JD_IOU,
        "\u4ea4\u6613\u6210\u529f",
        "\u652f\u51fa",
        t("batchImport.template.sample.jdDigitalCategory"),
        "JD202606170001",
        "MJD202606170001",
        "",
      ],
      [
        "2026-06-18 03:47:54",
        JD_PETTY_CASH,
        t("batchImport.template.sample.jdPettyCashIncome"),
        "0.07",
        JD_PETTY_CASH,
        "\u4ea4\u6613\u6210\u529f",
        "\u6536\u5165",
        JD_PETTY_CASH.replace(JD_INSTITUTION, ""),
        "JD202606180002",
        "MJD202606180002",
        "",
      ],
      [
        "2026-06-20 09:30:00",
        JD_IOU,
        t("batchImport.template.sample.jdRepaymentSuccess"),
        "500.00",
        t("viewImport.sampleAccountDebit"),
        "\u8fd8\u6b3e\u6210\u529f",
        "\u4e0d\u8ba1\u6536\u652f",
        JD_IOU.replace(JD_INSTITUTION, ""),
        "JD202606200003",
        "MJD202606200003",
        "",
      ],
      [
        "2026-06-21 10:10:00",
        t("batchImport.template.sample.jdMerchant"),
        t("batchImport.template.sample.jdPhoneOrder"),
        "99.00",
        JD_IOU,
        "\u9000\u6b3e\u6210\u529f",
        "\u4e0d\u8ba1\u6536\u652f",
        t("batchImport.template.sample.jdDigitalCategory"),
        "JD202606210004",
        "MJD202606210004",
        "",
      ],
    ],
    fields: [
      { name: "transactionTime", label: t("batchImport.template.jd.label.transactionTime"), required: true, note: t("batchImport.template.jd.field.transactionTime") },
      { name: "merchantName", label: t("batchImport.template.jd.label.merchantName"), required: true, note: t("batchImport.template.jd.field.merchantName") },
      { name: "description", label: t("batchImport.template.jd.label.description"), required: true, note: t("batchImport.template.jd.field.description") },
      { name: "amount", label: t("batchImport.template.jd.label.amount"), required: true, note: t("batchImport.template.jd.field.amount") },
      { name: "paymentAccount", label: t("batchImport.template.jd.label.paymentAccount"), required: true, note: t("batchImport.template.jd.field.paymentAccount") },
      { name: "status", label: t("batchImport.template.jd.label.status"), required: false, note: t("batchImport.template.jd.field.status") },
      { name: "flow", label: t("batchImport.template.jd.label.flow"), required: true, note: t("batchImport.template.jd.field.flow") },
      { name: "category", label: t("batchImport.template.jd.label.category"), required: false, note: t("batchImport.template.jd.field.category") },
      { name: "orderNo", label: t("batchImport.template.jd.label.orderNo"), required: false, note: t("batchImport.template.jd.field.orderNo") },
      { name: "merchantOrderNo", label: t("batchImport.template.jd.label.merchantOrderNo"), required: false, note: t("batchImport.template.jd.field.merchantOrderNo") },
      { name: "remark", label: t("batchImport.template.jd.label.remark"), required: false, note: t("batchImport.template.jd.field.remark") },
    ],
    guideNotes: [
      t("batchImport.guide.currentSupport"),
      t("batchImport.guide.jdBill"),
    ],
  };
}
