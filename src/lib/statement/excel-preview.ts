import { parseFlexibleDateToYmd } from "@/lib/date-utils";
import {
  dropTemplateSampleRows,
  findTemplateGuideTitleRowIndex,
  findTemplateSampleColumnIndex,
  rowsBeforeTemplateGuide,
} from "@/lib/import-template-sample";
import {
  inferSignedAmountInflowSign,
  isCreditCardRepaymentLikeText,
  isExpenseRefundLikeText,
  signedAmountDirection,
} from "@/lib/statement/amount-direction";
import {
  STATEMENT_IMPORT_FIELD_HEADERS,
  SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE,
  createStatementHeaderReader,
  matchStatementHeaderProfile,
  type StatementImportField,
} from "@/lib/statement/header-catalog";
import { normalizeAlipayWorkbookRows } from "@/lib/statement/alipay-template";
import { normalizeCaizhiWorkbookRows, detectCaizhiHeaders, type CaizhiWorkbookSheetRows } from "@/lib/statement/caizhi-template";
import { normalizeJdWorkbookRows } from "@/lib/statement/jd-template";
import { normalizeWechatWorkbookRows } from "@/lib/statement/wechat-template";
import {
  alignStatementIncomeRefunds,
  enrichKnownStatementMerchantForImport,
} from "@/lib/statement/import-normalization";

export type StatementExcelPreviewItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  date?: string;
  amount: number;
  inflow?: number;
  outflow?: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  transferDirection?: "in" | "out";
  category?: string;
  categoryUserEdited?: boolean;
  remark?: string;
  counterparty?: string;
  institution?: string;
  institutionUserEdited?: boolean;
  postedDate?: string;
  currency?: string;
  _meta?: {
    institutionName?: string;
    ownerName?: string;
    cardNumberMasked?: string;
    statementCurrency?: string;
    minimumPayment?: number;
    creditLimit?: number;
    billingDay?: number;
    repaymentDay?: number;
    statementAmount?: number;
    statementPeriodStart?: string;
    statementPeriodEnd?: string;
    statementDueDate?: string;
  };
};

type StatementFieldHeaders = Record<StatementImportField, readonly string[]>;

function formatDateCell(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const datePart = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
    const hour = value.getHours();
    const minute = value.getMinutes();
    const second = value.getSeconds();
    if (hour || minute || second) {
      return `${datePart} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
    }
    return datePart;
  }
  return String(value ?? "").trim();
}

function normalizeHeader(value: string) {
  return value.replace(/\s+/g, "").replace(/[：:]/g, "").trim().toLowerCase();
}

function normalizeDate(value: string) {
  const raw = value.trim().replace(/\s+/g, " ");
  if (!raw) return "";
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const timeMatch = raw.match(/\s+(\d{1,2}:\d{2}(?::\d{2})?)$/);
  const match = raw
    .replace(/[\u5e74\u6708]/g, "-")
    .replace(/[\u65e5\u53f7]/g, "")
    .match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/);
  if (match) {
    const datePart = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    return timeMatch ? `${datePart} ${timeMatch[1]}` : datePart;
  }
  // Lenient fallback (e.g. "26-02-2026" day-first); re-append time if present.
  const fallback = parseFlexibleDateToYmd(raw);
  return fallback ? (timeMatch ? `${fallback} ${timeMatch[1]}` : fallback) : raw.slice(0, 10);
}

function parseAmount(value: string) {
  const normalized = value.replace(/[,，￥¥\s]/g, "");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function parsePositiveAmountCell(row: string[], index: number) {
  if (index < 0) return 0;
  const raw = String(row[index] ?? "").trim();
  if (!raw) return 0;
  const parsed = parseAmount(raw);
  return parsed === null ? 0 : Math.abs(parsed);
}

function rowText(row: string[]) {
  return row.filter(Boolean).join(" ");
}

export function hasImportableStatementRows(items: StatementExcelPreviewItem[]) {
  return items.some((item) => item.date && Number(item.amount) > 0);
}

function cardAccountHint(institutionName: string | undefined, defaultAccountName: string, last4: string) {
  const cardTail = last4.trim();
  if (!cardTail) return defaultAccountName;
  const bankName = String(institutionName ?? "").trim();
  if (bankName) return `${bankName}信用卡(${cardTail})`;
  const defaultName = defaultAccountName.trim();
  if (!defaultName) return `信用卡(${cardTail})`;
  if (defaultName.includes(cardTail)) return defaultName;
  return `${defaultName}(${cardTail})`;
}

export function isKnownCreditCardStatementRows(rows: string[][]) {
  for (const [index, row] of rows.entries()) {
    const indexes = matchStatementHeaderProfile(row, SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE);
    if (!indexes) continue;
    let validRows = 0;
    for (const sampleRow of rows.slice(index + 1, index + 21)) {
      const date = normalizeDate(sampleRow[indexes.transactionDate] ?? "");
      const amount = parseAmount(sampleRow[indexes.amount] ?? "");
      const description = String(sampleRow[indexes.description] ?? "").trim();
      const cardLast4 = String(sampleRow[indexes.cardLast4] ?? "").trim();
      if (date && amount !== null && amount !== 0 && description && /^\d{4}$/.test(cardLast4)) validRows += 1;
      if (validRows >= SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE.minValidSampleRows) return true;
    }
  }
  return false;
}

export function normalizeStatementExcelParsedItems(items: StatementExcelPreviewItem[]) {
  return alignStatementIncomeRefunds(items.map(enrichKnownStatementMerchantForImport));
}

function statementHeaderScore(row: string[], fieldHeaders: StatementFieldHeaders) {
  const reader = createStatementHeaderReader(row, fieldHeaders);
  let score = 0;
  if (reader.hasField("transactionDate")) score += 4;
  if (reader.hasField("amount")) score += 4;
  if (reader.hasField("sourceAccount")) score += 3;
  if (reader.hasField("majorType")) score += 2;
  if (reader.hasField("explicitType")) score += 2;
  if (reader.hasField("creditAccount")) score += 2;
  if (reader.hasField("repaymentAccount")) score += 1;
  if (reader.hasField("transferCounterAccount")) score += 1;
  if (reader.hasField("category")) score += 1;
  if (reader.hasField("institution")) score += 1;
  if (reader.hasField("remark")) score += 1;
  return score >= 8 ? score : 0;
}

function trimRowsToStatementHeader(rows: string[][], fieldHeaders: StatementFieldHeaders) {
  const compactRows = rows.filter((row) => row.some((cell) => cell.trim()));
  let bestIndex = 0;
  let bestScore = statementHeaderScore(compactRows[0] ?? [], fieldHeaders);
  compactRows.slice(0, 25).forEach((row, index) => {
    const score = statementHeaderScore(row, fieldHeaders);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestScore > 0 ? compactRows.slice(bestIndex) : compactRows;
}

function headerSignature(row: string[]) {
  return row.map(normalizeHeader).join("|");
}

function mergeStatementWorkbookRows(
  sheetRows: Array<{ sheetName: string; rows: string[][] }>,
  fieldHeaders: StatementFieldHeaders,
) {
  const trimmedSheets = sheetRows
    .map((sheet) => ({ ...sheet, rows: trimRowsToStatementHeader(sheet.rows, fieldHeaders) }))
    .filter((sheet) => sheet.rows.length > 0);
  if (trimmedSheets.length === 0) return [] as string[][];

  const groups = new Map<string, typeof trimmedSheets>();
  for (const sheet of trimmedSheets) {
    const signature = headerSignature(sheet.rows[0] ?? []);
    groups.set(signature, [...(groups.get(signature) ?? []), sheet]);
  }

  const selectedSheets = Array.from(groups.values()).sort((a, b) => {
    const aScore = statementHeaderScore(a[0]?.rows[0] ?? [], fieldHeaders);
    const bScore = statementHeaderScore(b[0]?.rows[0] ?? [], fieldHeaders);
    if (aScore !== bScore) return bScore - aScore;
    const aRows = a.reduce((sum, sheet) => sum + Math.max(0, sheet.rows.length - 1), 0);
    const bRows = b.reduce((sum, sheet) => sum + Math.max(0, sheet.rows.length - 1), 0);
    return bRows - aRows;
  })[0] ?? [];

  const [firstSheet, ...restSheets] = selectedSheets;
  const mergedRows = [...(firstSheet?.rows ?? [])];
  for (const sheet of restSheets) mergedRows.push(...sheet.rows.slice(1));
  return mergedRows;
}

export function parseStatementTemplateRows(
  rows: string[][],
  defaultAccountName: string,
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
  /** 模板说明区标题行文案；传入后会截断标题行以下的所有说明行 */
  guideTitle = "",
): StatementExcelPreviewItem[] {
  const [headers = [], ...rawDataRows] = rows;
  // 模板自带的样板行和底部字段说明区都不是真实账单数据。
  const guideTitleRowIndex = findTemplateGuideTitleRowIndex(rawDataRows, guideTitle);
  const sampleColumnIndex = findTemplateSampleColumnIndex(headers);
  const dataRows = dropTemplateSampleRows(rowsBeforeTemplateGuide(rawDataRows, guideTitleRowIndex), sampleColumnIndex);
  const spdbIndexes = matchStatementHeaderProfile(headers, SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE);
  const knownInstitutionName = spdbIndexes ? SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE.institutionName : undefined;
  const reader = createStatementHeaderReader(headers, fieldHeaders);
  const dateIndex = spdbIndexes?.transactionDate ?? reader.findFieldIndex("transactionDate");
  const typeIndex = reader.findIndex([...fieldHeaders.explicitType, ...fieldHeaders.majorType]);
  const plainAccountIndex = reader.findFieldIndex("sourceAccount");
  const legacyCardIndex = spdbIndexes?.cardLast4 ?? reader.findFieldIndex("creditAccount");
  const accountIndex = plainAccountIndex >= 0 ? plainAccountIndex : legacyCardIndex;
  const legacyCardAccountMode = plainAccountIndex < 0 && legacyCardIndex >= 0;
  const counterIndex = reader.findIndex([...fieldHeaders.transferCounterAccount, ...fieldHeaders.repaymentAccount]);
  const outflowIndex = reader.findFieldIndex("outflow");
  const inflowIndex = reader.findFieldIndex("inflow");
  const amountIndex = spdbIndexes?.amount ?? reader.findFieldIndex("amount");
  const categoryIndex = reader.findFieldIndex("category");
  const merchantIndex = reader.findFieldIndex("institution");
  const tagsIndex = reader.findFieldIndex("tags");
  const remarkIndex = spdbIndexes?.description ?? reader.findFieldIndex("remark");
  const postedIndex = spdbIndexes?.postingDate ?? reader.findFieldIndex("postedAt");

  if (dateIndex < 0 || (amountIndex < 0 && inflowIndex < 0 && outflowIndex < 0)) return [];

  const signedAmountInflowSign = inferSignedAmountInflowSign(dataRows.flatMap((row) => {
    const rawInflowText = inflowIndex >= 0 ? String(row[inflowIndex] ?? "").trim() : "";
    const rawOutflowText = outflowIndex >= 0 ? String(row[outflowIndex] ?? "").trim() : "";
    const hasExplicitFlow =
      parsePositiveAmountCell(row, inflowIndex) > 0 ||
      parsePositiveAmountCell(row, outflowIndex) > 0 ||
      !!rawInflowText ||
      !!rawOutflowText;
    if (hasExplicitFlow) return [];
    const typeText = String(row[typeIndex] ?? "").trim();
    const category = String(row[categoryIndex] ?? "").trim();
    const institution = String(row[merchantIndex] ?? "").trim();
    const remark = String(row[remarkIndex] ?? "").trim();
    return [{
      amount: amountIndex >= 0 ? parseAmount(row[amountIndex] ?? "") : null,
      text: `${typeText} ${category} ${institution} ${remark} ${rowText(row)}`,
    }];
  }));

  return dataRows.flatMap<StatementExcelPreviewItem>((row) => {
    const date = normalizeDate(row[dateIndex] ?? "");
    if (!date) return [];

    const typeText = String(row[typeIndex] ?? "").trim().toLowerCase();
    const rawOutflow = parsePositiveAmountCell(row, outflowIndex);
    const rawInflow = parsePositiveAmountCell(row, inflowIndex);
    const rawOutflowText = outflowIndex >= 0 ? String(row[outflowIndex] ?? "").trim() : "";
    const rawInflowText = inflowIndex >= 0 ? String(row[inflowIndex] ?? "").trim() : "";
    const hasExplicitFlow = rawInflow > 0 || rawOutflow > 0 || !!rawInflowText || !!rawOutflowText;
    const amountSigned = amountIndex >= 0 ? parseAmount(row[amountIndex] ?? "") : null;
    const amount = amountSigned === null
      ? rawInflow || rawOutflow
      : Math.abs(amountSigned) || rawInflow || rawOutflow;
    if (amount === 0) return [];
    const explicitDirection: "in" | "out" | null =
      rawInflow > 0 && rawOutflow <= 0 ? "in"
      : rawOutflow > 0 && rawInflow <= 0 ? "out"
      : null;
    const signedDirection = hasExplicitFlow ? explicitDirection : signedAmountDirection(amountSigned, signedAmountInflowSign);
    const rawAccountValue = accountIndex >= 0 ? String(row[accountIndex] ?? "").trim() : defaultAccountName;
    const contextAccount = accountIndex < 0 ? defaultAccountName : "";
    const cardLast4 = legacyCardAccountMode ? rawAccountValue.match(/\d{4}(?!\d)/)?.[0] ?? "" : "";
    const accountValue = legacyCardAccountMode
      ? cardAccountHint(knownInstitutionName, defaultAccountName, cardLast4)
      : rawAccountValue;
    const counterAccount = counterIndex >= 0 ? String(row[counterIndex] ?? "").trim() : "";
    const category = String(row[categoryIndex] ?? "").trim();
    const institution = String(row[merchantIndex] ?? "").trim();
    const tags = tagsIndex >= 0 ? String(row[tagsIndex] ?? "").trim() : "";
    const remark = String(row[remarkIndex] ?? "").trim() || tags || rowText(row);
    const postedDate = postedIndex >= 0 ? normalizeDate(row[postedIndex] ?? "") : undefined;
    const sourceText = `${typeText} ${category} ${institution} ${remark} ${rowText(row)}`;
    const isRepayment = /转账|transfer|振替/.test(typeText) || isCreditCardRepaymentLikeText(sourceText);
    const isRefund = isExpenseRefundLikeText(sourceText);
    const isSignedInflow = signedDirection === "in";
    const isIncome = !isRefund && (/income|收入|収入/.test(typeText) || isSignedInflow);

    if (isRepayment) {
      const accountIsCurrent = normalizeHeader(accountValue) === normalizeHeader(defaultAccountName);
      const counterIsCurrent = normalizeHeader(counterAccount) === normalizeHeader(defaultAccountName);
      const accountSideIsPrimary = legacyCardAccountMode || accountIsCurrent || !counterIsCurrent;
      const transferIsInflow = explicitDirection
        ? explicitDirection === "in"
        : isCreditCardRepaymentLikeText(sourceText) || signedDirection !== "out";
      const fromAccount = transferIsInflow
        ? accountSideIsPrimary ? counterAccount : accountValue
        : accountSideIsPrimary ? (accountValue || contextAccount) : (counterAccount || contextAccount);
      const toAccount = transferIsInflow
        ? accountSideIsPrimary ? (accountValue || contextAccount) : (counterAccount || contextAccount)
        : accountSideIsPrimary ? counterAccount : accountValue;
      return [{
        rawText: rowText(row),
        type: "transfer" as const,
        date,
        amount,
        inflow: transferIsInflow ? amount : undefined,
        outflow: transferIsInflow ? undefined : amount,
        account: transferIsInflow ? toAccount : fromAccount,
        fromAccount,
        toAccount,
        transferDirection: transferIsInflow ? "in" as const : "out" as const,
        institution,
        remark,
        postedDate,
        _meta: cardLast4 || knownInstitutionName ? {
          institutionName: knownInstitutionName,
          cardNumberMasked: cardLast4 || undefined,
        } : undefined,
      }];
    }

    const account = accountValue || contextAccount;
    const resolvedType = explicitDirection === "out" ? "expense" : isIncome ? "income" : "expense";
    const accountSideInflow = explicitDirection
      ? explicitDirection === "in"
      : isIncome || isRefund;
    return [{
      rawText: rowText(row),
      type: resolvedType,
      date,
      amount,
      inflow: accountSideInflow ? amount : undefined,
      outflow: accountSideInflow ? undefined : amount,
      account,
      category,
      institution,
      counterparty: institution || undefined,
      remark,
      postedDate,
      _meta: cardLast4 || knownInstitutionName ? {
        institutionName: knownInstitutionName,
        cardNumberMasked: cardLast4 || undefined,
      } : undefined,
    }];
  });
}

export type ReadStatementWorkbookResult = {
  rows: string[][];
  text: string;
  /** 如果检测为财智8格式，则为标准化后的行；否则 undefined */
  caizhiRows?: string[][];
};

/**
 * 尝试从文件名中提取财智8导出的账户名。
 * 格式：「XXX的YYY_明细_YYYY-MM-DD.xls」
 */
function guessCaizhiAccountNameFromFilename(filename: string): string {
  const match = filename.match(/^(.+?)的(.+?)_明细_/);
  if (match) return `${match[1]}的${match[2]}`;
  const noExt = filename.replace(/\.(xls|xlsx)$/i, "");
  return noExt || "财智账户";
}

export async function readStatementWorkbookRowsAndText(
  file: File,
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
): Promise<ReadStatementWorkbookResult> {
  const XLSX = await import("xlsx");
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: "array", cellDates: true });
  const sheetRows = workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Array<string | number | boolean | Date | null>>(sheet, {
      header: 1,
      defval: "",
      raw: false,
      dateNF: "yyyy-mm-dd",
    }).map((row) => row.map(formatDateCell).map((cell) => cell.trim()));
    return { sheetName, rows };
  });

  const jdRows = normalizeJdWorkbookRows(sheetRows);
  const alipayRows = normalizeAlipayWorkbookRows(sheetRows);
  const wechatRows = normalizeWechatWorkbookRows(sheetRows);

  // 优先检测财智8格式（需要从文件名猜账户名）
  const accountNameFromFile = guessCaizhiAccountNameFromFilename(file.name);
  const caizhiRows = normalizeCaizhiWorkbookRows(sheetRows as CaizhiWorkbookSheetRows[], accountNameFromFile);

  const rows = caizhiRows?.rows
    ?? jdRows?.rows
    ?? alipayRows?.rows
    ?? wechatRows?.rows
    ?? mergeStatementWorkbookRows(sheetRows, fieldHeaders);

  const text = sheetRows
    .flatMap((sheet) => sheet.rows.filter((row) => row.some(Boolean)))
    .map((row) => row.join("\t"))
    .join("\n");

  return {
    rows,
    text,
    caizhiRows: caizhiRows?.rows,
  };
}

export async function parseStatementExcelFile(
  file: File,
  defaultAccountName: string,
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
  guideTitle = "",
) {
  const { rows, text } = await readStatementWorkbookRowsAndText(file, fieldHeaders);
  const localItems = normalizeStatementExcelParsedItems(
    parseStatementTemplateRows(rows, defaultAccountName, fieldHeaders, guideTitle),
  );
  return {
    rows,
    text,
    localItems,
    preferServerRecognition: isKnownCreditCardStatementRows(rows),
  };
}
