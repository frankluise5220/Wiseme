export type StatementWorkbookSheetRows = {
  sheetName: string;
  rows: string[][];
};

export type NormalizedStatementWorkbookRows = {
  rows: string[][];
  sourceDataRowCount: number;
  includedSheetCount: number;
  profile: "alipay";
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

const ALIPAY_INSTITUTION = "\u652f\u4ed8\u5b9d";
const ALIPAY_PAYMENT_ACCOUNT_HEADERS = [
  "\u6536/\u4ed8\u6b3e\u65b9\u5f0f",
  "\u6536\u4ed8\u6b3e\u65b9\u5f0f",
  "\u4ed8\u6b3e\u65b9\u5f0f",
  "\u6536\u6b3e\u65b9\u5f0f",
  "\u652f\u4ed8\u65b9\u5f0f",
  "\u8d44\u91d1\u6e20\u9053",
  "\u6263\u6b3e\u65b9\u5f0f",
];

const ALIPAY_OWNER_HEADERS = [
  "\u59d3\u540d",
  "\u7528\u6237",
  "\u7528\u6237\u540d",
  "\u6240\u6709\u4eba",
  "\u8d26\u6237\u6240\u6709\u4eba",
  "\u8d26\u53f7\u59d3\u540d",
  "\u8d26\u6237\u540d",
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

function findAlipayHeaderRow(rows: string[][]) {
  for (const [index, row] of rows.slice(0, 25).entries()) {
    const timeIndex = findHeaderIndex(row, ["\u4ea4\u6613\u65f6\u95f4"]);
    const flowIndex = findHeaderIndex(row, ["\u6536/\u652f", "\u6536\u652f"]);
    const amountIndex = findHeaderIndex(row, ["\u91d1\u989d", "\u91d1\u989d\uff08\u5143\uff09", "\u91d1\u989d(\u5143)"]);
    const accountIndex = findHeaderIndex(row, ALIPAY_PAYMENT_ACCOUNT_HEADERS);
    const statusIndex = findHeaderIndex(row, ["\u4ea4\u6613\u72b6\u6001"]);
    if (timeIndex >= 0 && flowIndex >= 0 && amountIndex >= 0 && accountIndex >= 0 && statusIndex >= 0) {
      return index;
    }
  }
  return -1;
}

function normalizeAlipayDate(value: string) {
  const raw = cleanText(value).replace(/\s+/g, " ");
  const match = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/);
  if (!match) return raw;
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return raw;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseAmount(value: string) {
  const amount = Number(cleanText(value).replace(/[,\uff0c\uffe5\u00a5\s]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? String(amount) : "";
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
    !/\u8d26\u5355|\u5bfc\u51fa|\u8d77\u59cb|\u7ec8\u6b62|\u4ea4\u6613|\u65f6\u95f4|\u652f\u4ed8\u5b9d/.test(value);
}

function normalizeAlipayOwnerHint(value: string) {
  const hint = unwrapHeaderValue(value);
  return isUsefulOwnerHint(hint) ? hint : "";
}

function findAlipayOwnerHint(rows: string[][], headerRowIndex: number) {
  for (const row of rows.slice(0, headerRowIndex)) {
    for (let index = 0; index < row.length; index += 1) {
      const cell = cleanText(row[index]);
      if (!cell) continue;

      const directLabel = ALIPAY_OWNER_HEADERS.some((header) => normalizeHeader(cell) === normalizeHeader(header));
      if (directLabel) {
        const nextValue = normalizeAlipayOwnerHint(row.slice(index + 1).map(cleanText).find(Boolean) ?? "");
        if (nextValue) return nextValue;
      }

      const labelValueMatch = cell.match(/^([^:\uff1a]{1,16})[:\uff1a]\s*(.+)$/);
      if (!labelValueMatch) continue;
      const label = labelValueMatch[1] ?? "";
      const value = labelValueMatch[2] ?? "";
      const matchesOwnerLabel = ALIPAY_OWNER_HEADERS.some((header) => normalizeHeader(label) === normalizeHeader(header));
      if (!matchesOwnerLabel) continue;
      const hint = normalizeAlipayOwnerHint(value);
      if (hint) return hint;
    }
  }
  return "";
}

function isAlipayOwnedPaymentAccount(value: string) {
  const key = normalizeHeader(value).replace(/[.\u00b7\u2022\-_]/g, "");
  return /^(?:\u4f59\u989d|\u652f\u4ed8\u5b9d\u4f59\u989d|\u8d26\u6237\u4f59\u989d|\u4f59\u989d\u5b9d|\u82b1\u5457)$/.test(key);
}

function normalizePaymentAccount(value: string, ownerHint: string) {
  const raw = cleanText(value);
  if (!raw) return "";
  const [primary, ...rest] = raw.split(/[&\uff0b+]/).map((part) => part.trim()).filter(Boolean);
  if (primary && rest.join(" ").match(/\u7acb\u51cf|\u4f18\u60e0|\u7ea2\u5305|\u62b5\u6263/)) return primary;
  const normalized = /^\u82b1\u5457\u5206\u671f/.test(raw) ? "\u82b1\u5457" : raw;
  if (ownerHint && isAlipayOwnedPaymentAccount(normalized)) {
    return `${ownerHint}${ALIPAY_INSTITUTION}${normalized.replace(/^\u652f\u4ed8\u5b9d/, "")}`;
  }
  return normalized;
}

function isIgnoredStatus(value: string, flow: string) {
  if (/\u5931\u8d25|\u53d6\u6d88/.test(value)) return true;
  return flow === "\u6536\u5165" && /\u4ea4\u6613\u5173\u95ed|\u5df2\u5173\u95ed/.test(value);
}

function isRefundLikeText(value: string) {
  return /\u9000\u6b3e|\u9000\u8d27|\u9000\u56de|\u6d88\u8d39\u64a4\u9500|\u4ea4\u6613\u64a4\u9500|\u51b2\u6b63|\u64a4\u9500|Refund|Return|Reversal/i.test(value);
}

function isInvestmentLikeText(value: string) {
  return /\u6295\u8d44\u7406\u8d22|\u8682\u8681\u8d22\u5bcc|\u57fa\u91d1|\u7406\u8d22|\u4e70\u5165|\u5356\u51fa|\u8d4e\u56de|\u8f6c\u51fa\u81f3|\u4efd\u989d\u786e\u8ba4/.test(value);
}

function classifyAlipayFlow(params: {
  flow: string;
  category: string;
  status: string;
  description: string;
  remark: string;
  counterparty: string;
  counterpartyAccount: string;
}) {
  if (params.flow === "\u652f\u51fa") return { majorType: "\u652f\u51fa", outflow: true, inflow: false, requiresReview: false };
  if (params.flow === "\u6536\u5165") return { majorType: "\u6536\u5165", outflow: false, inflow: true, requiresReview: false };

  const source = [
    params.category,
    params.status,
    params.description,
    params.remark,
    params.counterparty,
    params.counterpartyAccount,
  ].join(" ");
  if (params.flow === "\u4e0d\u8ba1\u6536\u652f" && isRefundLikeText(source) && !isInvestmentLikeText(source)) {
    return { majorType: "\u652f\u51fa", outflow: false, inflow: true, requiresReview: false };
  }

  return null;
}

function fallbackAlipayFlow() {
  return { majorType: "\u652f\u51fa", outflow: true, inflow: false, requiresReview: true };
}

function readCell(row: string[], index: number) {
  return index >= 0 ? cleanText(row[index]) : "";
}

function normalizeAlipayCounterparty(value: string) {
  const normalized = cleanText(value).replace(/\/$/, "").trim();
  return /^[-\u2013\u2014?]+$/.test(normalized) ? "" : normalized;
}

function compactJoin(parts: Array<string | undefined>) {
  return parts.map((part) => cleanText(part)).filter(Boolean).join(" / ");
}

function normalizeRemarkComparisonText(value: string) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[\s/\\|,\uff0c.;\uff1b:\uff1a()[\]{}\uff08\uff09\u3010\u3011<>\u300a\u300b'"\u201c\u201d\u2018\u2019_-]+/g, "");
}

function containsRemarkPart(container: string, candidate: string) {
  const normalizedContainer = normalizeRemarkComparisonText(container);
  const normalizedCandidate = normalizeRemarkComparisonText(candidate);
  return Boolean(normalizedCandidate && normalizedContainer.includes(normalizedCandidate));
}

function buildAlipayVisibleRemark(params: {
  description: string;
  rawRemark: string;
  counterparty: string;
  counterpartyAccount: string;
  category: string;
}) {
  const parts = [params.description || params.rawRemark].filter(Boolean);
  for (const candidate of [params.counterparty, params.counterpartyAccount]) {
    if (!candidate || parts.some((part) => containsRemarkPart(part, candidate))) continue;
    parts.push(candidate);
  }
  return compactJoin(parts) || params.category;
}

function normalizeAlipaySheetRows(sheet: StatementWorkbookSheetRows) {
  const compactRows = sheet.rows.filter((row) => row.some((cell) => cleanText(cell)));
  const headerRowIndex = findAlipayHeaderRow(compactRows);
  if (headerRowIndex < 0) return null;

  const headers = compactRows[headerRowIndex] ?? [];
  const dataRows = compactRows.slice(headerRowIndex + 1);
  const ownerHint = findAlipayOwnerHint(compactRows, headerRowIndex);
  const timeIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u65f6\u95f4"]);
  const categoryIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u5206\u7c7b"]);
  const counterpartyIndex = (() => {
    const explicit = findHeaderIndex(headers, ["\u4ea4\u6613\u5bf9\u65b9"]);
    if (explicit >= 0) return explicit;
    const flowIndex = findHeaderIndex(headers, ["\u6536/\u652f", "\u6536\u652f"]);
    return categoryIndex >= 0 && flowIndex > categoryIndex + 1 ? categoryIndex + 1 : -1;
  })();
  const counterpartyAccountIndex = findHeaderIndex(headers, ["\u5bf9\u65b9\u8d26\u53f7"]);
  const descriptionIndex = findHeaderIndex(headers, ["\u5546\u54c1\u8bf4\u660e", "\u5546\u54c1\u540d\u79f0"]);
  const flowIndex = findHeaderIndex(headers, ["\u6536/\u652f", "\u6536\u652f"]);
  const amountIndex = findHeaderIndex(headers, ["\u91d1\u989d", "\u91d1\u989d\uff08\u5143\uff09", "\u91d1\u989d(\u5143)"]);
  const accountIndex = findHeaderIndex(headers, ALIPAY_PAYMENT_ACCOUNT_HEADERS);
  const statusIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u72b6\u6001"]);
  const orderIndex = findHeaderIndex(headers, ["\u4ea4\u6613\u8ba2\u5355\u53f7"]);
  const merchantOrderIndex = findHeaderIndex(headers, ["\u5546\u5bb6\u8ba2\u5355\u53f7"]);
  const remarkIndex = findHeaderIndex(headers, ["\u5907\u6ce8"]);

  const normalizedRows = dataRows.flatMap((row) => {
    const status = readCell(row, statusIndex);
    const flow = readCell(row, flowIndex);
    const amount = parseAmount(readCell(row, amountIndex));
    const date = normalizeAlipayDate(readCell(row, timeIndex));
    if (!date || !amount) return [];

    const rawAccount = readCell(row, accountIndex);
    const account = normalizePaymentAccount(rawAccount, ownerHint);
    const counterparty = normalizeAlipayCounterparty(readCell(row, counterpartyIndex));
    const category = readCell(row, categoryIndex);
    const description = readCell(row, descriptionIndex);
    const counterpartyAccount = normalizeAlipayCounterparty(readCell(row, counterpartyAccountIndex));
    const orderNo = readCell(row, orderIndex);
    const merchantOrderNo = readCell(row, merchantOrderIndex);
    const rawRemark = readCell(row, remarkIndex);
    const classifiedFlow = classifyAlipayFlow({
      flow,
      category,
      status,
      description,
      remark: rawRemark,
      counterparty,
      counterpartyAccount,
    }) ?? fallbackAlipayFlow();
    const requiresReview = classifiedFlow.requiresReview || isIgnoredStatus(status, flow);

    const visibleRemark = buildAlipayVisibleRemark({
      description,
      rawRemark,
      counterparty,
      counterpartyAccount,
      category,
    });
    const matchRemark = compactJoin([
      requiresReview ? `\u5bfc\u5165\u515c\u5e95:\u8bf7\u786e\u8ba4\u7c7b\u578b\u548c\u8d26\u6237` : "",
      flow && requiresReview ? `\u539f\u6536\u652f:${flow}` : "",
      counterparty ? `\u5546\u6237:${counterparty}` : "",
      rawRemark && !containsRemarkPart(visibleRemark, rawRemark) ? `\u539f\u5907\u6ce8:${rawRemark}` : "",
      rawAccount && rawAccount !== account ? `\u539f\u4ed8\u6b3e\u65b9\u5f0f:${rawAccount}` : "",
      counterpartyAccount ? `\u5bf9\u65b9\u8d26\u53f7:${counterpartyAccount}` : "",
      orderNo ? `\u652f\u4ed8\u5b9d\u8ba2\u5355:${orderNo}` : "",
      merchantOrderNo ? `\u5546\u5bb6\u8ba2\u5355:${merchantOrderNo}` : "",
      status && (flow === "\u4e0d\u8ba1\u6536\u652f" || !/^(\u4ea4\u6613\u6210\u529f|\u652f\u4ed8\u6210\u529f|\u9000\u6b3e\u6210\u529f|\u8fd8\u6b3e\u6210\u529f)$/.test(status)) ? `\u72b6\u6001:${status}` : "",
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
      ALIPAY_INSTITUTION,
      visibleRemark,
      matchRemark,
    ]];
  });

  return {
    rows: normalizedRows,
    sourceDataRowCount: dataRows.length,
  };
}

export function normalizeAlipayWorkbookRows(
  sheetRows: readonly StatementWorkbookSheetRows[],
): NormalizedStatementWorkbookRows | null {
  const normalizedSheets = sheetRows
    .map(normalizeAlipaySheetRows)
    .filter((sheet): sheet is { rows: string[][]; sourceDataRowCount: number } => Boolean(sheet));
  if (normalizedSheets.length === 0) return null;

  return {
    rows: [NORMALIZED_HEADERS, ...normalizedSheets.flatMap((sheet) => sheet.rows)],
    sourceDataRowCount: normalizedSheets.reduce((sum, sheet) => sum + sheet.sourceDataRowCount, 0),
    includedSheetCount: normalizedSheets.length,
    profile: "alipay",
  };
}
