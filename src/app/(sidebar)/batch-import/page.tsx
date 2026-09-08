"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { WorkBook } from "xlsx";
import { useRouter } from "next/navigation";
import { flushSync } from "react-dom";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig, type BatchReplaceOption } from "@/components/BatchReplacePopoverButton";
import { evaluateCalcInputExpression } from "@/components/CalcInput";
import { DateStepper } from "@/components/DateStepper";
import { SmartSelect, type SmartSelectOption } from "@/components/SmartSelect";
import { sortCategorySources } from "@/components/categorySmartSelect";
import { formatAccountSelectorLabel, formatAccountTableLabel, formatAccountTableTitle } from "@/lib/account-display";
import {
  IMPORT_ACCOUNT_ID_PREFIX,
  createImportAccountMatcher,
  createImportAccountIdentityConflictChecker,
  encodeImportAccountId,
  normalizeImportAccountMatchKey,
  parseImportAccountId,
} from "@/lib/account-import-match";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { fetchSettingsBootstrap } from "@/lib/client/settingsCache";
import { parseFlexibleDateToYmd } from "@/lib/date-utils";
import { systemCategoryLabel } from "@/lib/system-category-labels";
import { useI18n } from "@/lib/i18n";
import {
  SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE,
  STATEMENT_IMPORT_FIELD_HEADERS,
  buildStatementImportFieldHeaders,
  createStatementHeaderReader,
  matchStatementHeaderProfile,
  type StatementImportField,
} from "@/lib/statement/header-catalog";
import { normalizeAlipayWorkbookRows } from "@/lib/statement/alipay-template";
import { buildJdImportTemplate, normalizeJdWorkbookRows } from "@/lib/statement/jd-template";
import { buildWechatImportTemplate, normalizeWechatWorkbookRows } from "@/lib/statement/wechat-template";
import {
  inferSignedAmountInflowSign,
  isCreditCardCreditAdjustmentLikeText,
  isCreditCardRepaymentLikeText,
  isExpenseRefundLikeText,
  signedAmountDirection,
} from "@/lib/statement/amount-direction";
import {
  alignStatementIncomeRefunds,
  alignStatementRecognitionToLedger,
  enrichKnownStatementMerchantForImport,
  type StatementHistoricalCategorySample,
} from "@/lib/statement/import-normalization";
import { inferKnownStatementMerchant } from "@/lib/statement/merchant-inference";
import { statementPreviewCategorySyncKey } from "@/lib/statement/preview-category-sync";
import {
  CREDIT_CARD_REPAYMENT_BUSINESS_TYPE,
  CREDIT_CARD_REPAYMENT_CATEGORY_NAME,
  isCreditCardRepaymentBusinessType,
  isCreditCardRepaymentImportSourceAccountKind,
  isCreditCardRepaymentTargetAccountKind,
  type CreditCardRepaymentBusinessType,
} from "@/lib/transaction-semantics";
import { getAccountLabelFieldsPreference } from "@/lib/client/appPreferences";

type ParsedItem = {
  rawText: string;
  type: "expense" | "income" | "transfer" | "investment";
  businessType?: CreditCardRepaymentBusinessType | null;
  importMode?: BillImportMode;
  statementAccount?: string;
  date?: string;
  postedAt?: string;
  amount: number;
  outflow?: number;
  inflow?: number;
  account?: string;
  fromAccount?: string;
  toAccount?: string;
  importSourceAccount?: string;
  importSourceFromAccount?: string;
  importSourceToAccount?: string;
  importSourceStatementAccount?: string;
  category?: string;
  categoryUserEdited?: boolean;
  institution?: string;
  institutionUserEdited?: boolean;
  tags?: string;
  remark?: string;
  secondRemark?: string;
  counterparty?: string;
  transferDirection?: "in" | "out";
  importIgnoredCounterAccount?: string;
  importInvalidPostedAt?: string;
};

type FundImportUploadItem = {
  rawText: string;
  date: string;
  fundSubtype: string;
  cashAccount: string;
  fundAccount: string;
  fundCode: string;
  amount: number;
  units: number | null;
  nav: number | null;
  fee: number | null;
  feeRateInput?: number | null;
  confirmDate: string | null;
  arrivalDate: string | null;
  remark: string;
  source?: string;
};
type FundImportHeaderField = Exclude<keyof FundImportUploadItem, "rawText" | "source">;

type FundImportPreviewIssue = {
  level: "error" | "warning";
  code?: string;
  message: string;
};

type FundImportPreviewItem = FundImportUploadItem & {
  source: string;
  fundName: string | null;
  feeRate: number | null;
  confirmDays: number | null;
  arrivalDays: number | null;
  cashAccountId: string | null;
  fundAccountId: string | null;
  fundProductType: string | null;
  issues: FundImportPreviewIssue[];
};

type FundRuleEditorRow = {
  key: string;
  fundAccountId: string | null;
  fundAccount: string;
  fundCode: string;
  fundName: string;
  confirmDays: string;
  arrivalDays: string;
};

type ImportTemplate = {
  key: "normal" | "credit" | "fund" | "wechat" | "jd";
  title: string;
  description: string;
  status: string;
  filename: string;
  downloadFormat?: "csv" | "xlsx";
  sheetName?: string;
  headers: string[];
  exportHeaders?: string[];
  rows: string[][];
  footerRows?: string[][];
  fields: Array<{ name: string; label?: string; required: boolean; note: string }>;
  guideNotes?: string[];
};

type AccountOption = {
  id: string;
  name: string;
  kind: "cash" | "bank_debit" | "bank_credit" | string;
  label?: string | null;
  /** Table/list label that follows the configured display fields. */
  listLabel?: string | null;
  selectorLabel?: string | null;
  selectorCoreLabel?: string | null;
  fullLabel?: string | null;
  hoverTitle?: string | null;
  displaySubLabel?: string | null;
  numberMasked?: string | null;
  isActive?: boolean;
  Institution?: { id?: string; name: string | null; shortName?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
};

type BookCategory = { id: string; name: string; type: string; parentId?: string | null; sortOrder?: number; isSystem?: boolean };
type AccountPickerRole = "any" | "credit" | "repayment_source";
type PreviewType = ParsedItem["type"] | CreditCardRepaymentBusinessType;
type BillImportMode = "normal" | "credit_card";
type EditableCell = "date" | "type" | "outflow" | "inflow" | "account" | "counterAccount" | "category" | "institution" | "tags" | "remark";
type ReplaceField = EditableCell;
type ImportIssue = { idx: number; level: "error" | "warning"; message: string };
type TranslateFn = (key: string, params?: Record<string, string | number>) => string;
type NormalPreviewTableRow = { idx: number };
type FundPreviewTableRow = FundImportPreviewItem & { idx: number };
type FundImportKind = "normal" | "fund" | null;
type FundImportContext = {
  fundAccountId?: string;
  fundAccount?: string;
  fundCode?: string;
  fundName?: string;
};
type ImportCompletionState = {
  count: number;
  href: string | null;
  accountIds: string[];
  kind: "normal" | "fund";
  importBatchId?: string | null;
};
type ServerImportProgress = {
  total: number;
  processed: number;
  created: number;
  phase: "preparing" | "writing" | "recalculating" | "done" | "failed";
  currentRow: number | null;
  done: boolean;
  ok: boolean | null;
  error: string | null;
  failedRow: number | null;
};
type ImportFileParseResult = {
  rows: string[][];
  sourceDataRowCount: number;
  workbook?: {
    sheetCount: number;
    includedSheetCount: number;
  };
};
type ImportDebugDetails = Record<string, string | number | boolean | null>;

const BATCH_IMPORT_ITEMS_STORAGE_KEY = "batchImportItems:v2";
const LEGACY_BATCH_IMPORT_ITEMS_STORAGE_KEY = "batchImportItems";

function createImportTraceId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `import-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function postImportDebugLog(traceId: string, event: string, details: ImportDebugDetails = {}) {
  if (process.env.NODE_ENV !== "development") return;
  void fetch("/api/v1/debug/import-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ traceId, event, details }),
    keepalive: true,
  }).catch((error) => {
    console.warn("[batch-import] debug log upload failed", error);
  });
}

function normalizeFundImportContext(context?: FundImportContext | null): FundImportContext | null {
  const fundAccountId = String(context?.fundAccountId ?? "").trim();
  const fundAccount = String(context?.fundAccount ?? "").trim();
  const fundCode = String(context?.fundCode ?? "").trim();
  const fundName = String(context?.fundName ?? "").trim();
  if (!fundAccountId && !fundAccount && !fundCode && !fundName) return null;
  return {
    ...(fundAccountId ? { fundAccountId } : {}),
    ...(fundAccount ? { fundAccount } : {}),
    ...(fundCode ? { fundCode } : {}),
    ...(fundName ? { fundName } : {}),
  };
}

function fundIssueMessage(issue: FundImportPreviewIssue, t: TranslateFn) {
  if (issue.code === "MISSING_CASH_ACCOUNT" || issue.message === "MISSING_CASH_ACCOUNT") {
    return t("batchImport.fundPreview.missingCashAccount");
  }
  if (issue.code === "INVALID_FUND_CODE" || issue.message === "INVALID_FUND_CODE") {
    return t("batchImport.fundPreview.invalidFundCode");
  }
  return issue.message;
}

function buildCategorySmartSelectOptions(
  categories: BookCategory[],
  txType: ParsedItem["type"] | "all" | undefined,
  t: (key: string) => string,
): SmartSelectOption[] {
  const options: SmartSelectOption[] = [{ id: "", label: t("batchImport.uncategorized") }];
  const indent = "　";
  const categoryTypes = txType === "all"
    ? ["income", "expense"]
    : [txType === "income" ? "income" : "expense"];

  for (const categoryType of categoryTypes) {
    const typedCategories = categories.filter((category) => category.type === categoryType);
    const childrenByParentId = new Map<string | null, BookCategory[]>();
    for (const category of typedCategories) {
      const key = category.parentId ?? null;
      const list = childrenByParentId.get(key) ?? [];
      list.push(category);
      childrenByParentId.set(key, list);
    }
    for (const [parentId, list] of childrenByParentId) {
      childrenByParentId.set(parentId, sortCategorySources(list));
    }

    const headerId = `category-type:${categoryType}`;
    if (typedCategories.length > 0) {
      options.push({
        id: headerId,
        label: categoryType === "income" ? t("batchImport.incomeCategory") : t("batchImport.expenseCategory"),
        isHeader: true,
      });
    }
    const walk = (parentId: string | null, level: number, parentOptionId?: string) => {
      const children = childrenByParentId.get(parentId) ?? [];
      for (const category of children) {
        const hasChildren = (childrenByParentId.get(category.id) ?? []).length > 0;
        options.push({
          id: category.id,
          label: `${indent.repeat(level)}${systemCategoryLabel(category.name, t)}`,
          parentId: parentOptionId,
          isGroup: hasChildren,
        });
        walk(category.id, level + 1, category.id);
      }
    };
    walk(null, 0, headerId);
  }
  return options;
}
const FUND_CANONICAL_HEADERS = [
  "date",
  "fundSubtype",
  "cashAccount",
  "fundAccount",
  "fundCode",
  "amount",
  "feeRateInput",
  "fee",
  "nav",
  "units",
  "confirmDate",
  "arrivalDate",
  "remark",
] as const;
const FUND_FIELD_LABEL_KEYS: Record<(typeof FUND_CANONICAL_HEADERS)[number], string> = {
  date: "batchImport.template.fund.label.date",
  fundSubtype: "batchImport.template.fund.label.fundSubtype",
  cashAccount: "batchImport.template.fund.label.cashAccount",
  fundAccount: "batchImport.template.fund.label.fundAccount",
  fundCode: "batchImport.template.fund.label.fundCode",
  amount: "batchImport.template.fund.label.amount",
  feeRateInput: "batchImport.template.fund.label.feeRate",
  fee: "batchImport.template.fund.label.fee",
  nav: "batchImport.template.fund.label.nav",
  units: "batchImport.template.fund.label.units",
  confirmDate: "batchImport.template.fund.label.confirmDate",
  arrivalDate: "batchImport.template.fund.label.arrivalDate",
  remark: "batchImport.template.fund.label.remark",
};
const FUND_ACTION_HEADERS = {
  buy: "batchImport.template.fund.action.buy",
  redeem: "batchImport.template.fund.action.redeem",
  dividendCash: "batchImport.template.fund.action.dividendCash",
  dividendReinvest: "batchImport.template.fund.action.dividendReinvest",
} as const;
const FUND_LABEL_HEADER_SET = new Set([
  "日期",
  "基金动作",
  "资金账户",
  "基金账户",
  "基金代码",
  "金额",
  "手续费率",
  "手续费",
  "净值",
  "份额",
  "净值日期",
  "入账日期",
  "备注",
]);
const FUND_FIELD_ALIASES: Record<FundImportHeaderField, string[]> = {
  date: ["date", "日期", "交易日期", "申请日期", "Date", "日付"],
  fundSubtype: ["fundSubtype", "分类", "业务类型", "基金动作", "基金类型", "动作", "Fund Action", "Action", "基金アクション", "ファンド操作", "cash dividend", "dividend reinvest", "現金分配", "分配金再投資"],
  cashAccount: ["cashAccount", "资金账户", "现金账户", "付款账户", "cash account", "Cash Account", "資金口座"],
  fundAccount: ["fundAccount", "基金账户", "投资账户", "account", "fund account", "Fund Account", "ファンド口座"],
  fundCode: ["fundCode", "基金代码", "代码", "fund code", "Fund Code", "ファンドコード", "基金コード"],
  amount: ["amount", "金额", "发生金额", "Amount", "金額"],
  feeRateInput: ["feeRateInput", "feeRate", "手续费率", "费率", "Fee Rate", "Fee Rate (%)", "手数料率"],
  fee: ["fee", "手续费", "Fee", "手数料"],
  nav: ["nav", "净值", "成交净值", "NAV", "基準価額"],
  units: ["units", "份额", "确认份额", "Units", "口数"],
  confirmDate: ["confirmDate", "确认日期", "净值日期", "NAV Date", "基準価額日"],
  arrivalDate: ["arrivalDate", "入账日期", "到账日期", "Posting Date", "入帳日"],
  remark: ["remark", "备注", "说明", "Remark", "Note", "備考", "メモ"],
};

const replaceFieldLabelKeys: Record<ReplaceField, string> = {
  date: "batchImport.field.date",
  type: "batchImport.field.type",
  outflow: "batchImport.field.outflow",
  inflow: "batchImport.field.inflow",
  account: "batchImport.field.account",
  counterAccount: "batchImport.field.counterAccount",
  category: "batchImport.field.category",
  institution: "batchImport.field.institution",
  tags: "batchImport.field.tags",
  remark: "batchImport.field.remark",
};

function applyNumberExpression(currentValue: number, expression: string) {
  const computed = evaluateCalcInputExpression(expression, currentValue);
  return computed ?? Number.NaN;
}

function buildTemplates(t: (key: string, params?: Record<string, string | number>) => string): ImportTemplate[] {
  const fundHeaders = FUND_CANONICAL_HEADERS.map((header) => t(FUND_FIELD_LABEL_KEYS[header]));
  const normalHeaders = [
    t("detail.column.date"),
    t("detail.column.postedAt"),
    t("viewImport.activityType"),
    t("detail.column.outflow"),
    t("detail.column.inflow"),
    t("viewImport.account"),
    t("viewImport.counterAccount"),
    t("detail.column.category"),
    t("detail.column.counterparty"),
    t("detail.column.tags"),
    t("detail.column.remark"),
  ];
  return [
  {
    key: "normal",
    title: t("batchImport.template.normal.title"),
    description: t("batchImport.template.normal.description"),
    status: t("batchImport.template.normal.status"),
    filename: `${t("viewImport.billTemplateFile", { name: t("viewImport.import") })}.xlsx`,
    downloadFormat: "xlsx",
    sheetName: t("batchImport.sheet.template"),
    headers: normalHeaders,
    rows: [
      ["2026-06-08", "2026-06-09", t("transaction.type.expense"), "32.50", "", t("viewImport.sampleAccountDebit"), "", t("viewImport.sampleCategoryDining"), t("viewImport.sampleMerchantFastFood"), t("viewImport.sampleTagLunch"), t("viewImport.sampleRemarkLunch")],
      ["2026-06-08", "", t("transaction.type.income"), "", "1.28", t("viewImport.sampleAccountDebit"), "", t("viewImport.sampleCategoryInterestIncome"), t("viewImport.sampleAccountDebit"), t("viewImport.sampleTagInterest"), t("viewImport.sampleRemarkDemandInterest")],
      ["2026-06-08", "2026-06-08 23:30", t("transaction.type.expense"), "2.00", "", t("viewImport.sampleAccountDebit"), "", t("viewImport.sampleCategoryInterestIncome"), t("viewImport.sampleAccountDebit"), t("viewImport.sampleTagInterest"), t("batchImport.template.normal.sample.accountFeeRemark")],
      ["2026-06-08", "", t("transaction.type.transfer"), "1000.00", "", t("viewImport.sampleAccountDebit"), t("viewImport.sampleAccountCash"), "", "", t("viewImport.sampleAccountCash"), t("viewImport.sampleRemarkTransfer")],
      ["2026-06-20", "2026-06-20", t("transaction.type.transfer"), "", "108.00", t("batchImport.template.normal.sample.creditCardAccount"), t("viewImport.sampleAccountDebit"), "", "", "", t("viewImport.sampleRemarkCreditCardRepayment")],
      ["2026-06-05", "2026-06-06", t("transaction.type.expense"), "", "20.00", t("batchImport.template.normal.sample.creditCardAccount"), "", t("viewImport.sampleCategoryDining"), t("viewImport.sampleMerchantRestaurant"), "", t("viewImport.sampleRemarkCreditCardRefund")],
    ],
    fields: [
      { name: normalHeaders[0], required: true, note: t("batchImport.template.normal.field.date") },
      { name: normalHeaders[1], required: false, note: t("batchImport.template.normal.field.postedAt") },
      { name: normalHeaders[2], required: true, note: t("batchImport.template.normal.field.majorType") },
      { name: normalHeaders[3], required: false, note: t("batchImport.template.normal.field.outflow") },
      { name: normalHeaders[4], required: false, note: t("batchImport.template.normal.field.inflow") },
      { name: normalHeaders[5], required: true, note: t("batchImport.template.normal.field.account") },
      { name: normalHeaders[6], required: false, note: t("batchImport.template.normal.field.counterAccount") },
      { name: normalHeaders[7], required: false, note: t("batchImport.template.normal.field.category") },
      { name: normalHeaders[8], required: false, note: t("batchImport.template.normal.field.institution") },
      { name: normalHeaders[9], required: false, note: t("batchImport.template.normal.field.tags") },
      { name: normalHeaders[10], required: false, note: t("batchImport.template.normal.field.remark") },
    ],
    guideNotes: [
      t("batchImport.guide.currentSupport"),
      t("batchImport.guide.normalBill"),
    ],
  },
  buildWechatImportTemplate(t),
  buildJdImportTemplate(t),
  {
    key: "fund",
    title: t("batchImport.template.fund.title"),
    description: t("batchImport.template.fund.description"),
    status: t("batchImport.template.normal.status"),
    filename: `${t("batchImport.template.fund.filename")}.xlsx`,
    downloadFormat: "xlsx",
    sheetName: t("batchImport.sheet.template"),
    headers: fundHeaders,
    rows: [
      ["2026-06-03", t(FUND_ACTION_HEADERS.buy), t("batchImport.template.sample.cashAccount"), t("batchImport.template.sample.fundAccount"), "000001", "1000.00", "1", "", "1.3521", "738.99", "2026-06-04", "2026-06-04", ""],
      ["2026-06-10", t(FUND_ACTION_HEADERS.redeem), t("batchImport.template.sample.cashAccount"), t("batchImport.template.sample.fundAccount"), "000001", "500.00", "", "0.50", "1.3889", "360.00", "2026-06-11", "2026-06-12", ""],
      ["2026-06-15", t(FUND_ACTION_HEADERS.dividendCash), t("batchImport.template.sample.cashAccount"), t("batchImport.template.sample.fundAccount"), "000001", "300.00", "", "", "", "", "", "2026-06-16", ""],
      ["2026-06-18", t(FUND_ACTION_HEADERS.dividendReinvest), "", t("batchImport.template.sample.fundAccount"), "000001", "", "", "", "1.4200", "210.00", "2026-06-18", "", ""],
    ],
    footerRows: [
      [],
      [],
      [],
      ...(t("batchImport.guide.fundImportNotes") as unknown as string)
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t")),
    ],
    fields: [
      { name: "date", label: t("batchImport.template.fund.label.date"), required: true, note: t("batchImport.template.fund.field.date") },
      { name: "fundSubtype", label: t("batchImport.template.fund.label.fundSubtype"), required: true, note: t("batchImport.template.fund.field.fundSubtype") },
      { name: "cashAccount", label: t("batchImport.template.fund.label.cashAccount"), required: false, note: t("batchImport.template.fund.field.cashAccount") },
      { name: "fundAccount", label: t("batchImport.template.fund.label.fundAccount"), required: true, note: t("batchImport.template.fund.field.fundAccount") },
      { name: "fundCode", label: t("batchImport.template.fund.label.fundCode"), required: true, note: t("batchImport.template.fund.field.fundCode") },
      { name: "amount", label: t("batchImport.template.fund.label.amount"), required: false, note: t("batchImport.template.fund.field.amount") },
      { name: "feeRateInput", label: t("batchImport.template.fund.label.feeRate"), required: false, note: t("batchImport.template.fund.field.feeRate") },
      { name: "fee", label: t("batchImport.template.fund.label.fee"), required: false, note: t("batchImport.template.fund.field.fee") },
      { name: "nav", label: t("batchImport.template.fund.label.nav"), required: false, note: t("batchImport.template.fund.field.nav") },
      { name: "units", label: t("batchImport.template.fund.label.units"), required: false, note: t("batchImport.template.fund.field.units") },
      { name: "confirmDate", label: t("batchImport.template.fund.label.confirmDate"), required: false, note: t("batchImport.template.fund.field.confirmDate") },
      { name: "arrivalDate", label: t("batchImport.template.fund.label.arrivalDate"), required: false, note: t("batchImport.template.fund.field.arrivalDate") },
      { name: "remark", label: t("batchImport.template.fund.label.remark"), required: false, note: t("batchImport.template.fund.field.remark") },
    ],
    guideNotes: [(t("batchImport.guide.fundImportNotes") as unknown as string).split("\n")[0] ?? ""],
  },
  ];
}

function escapeCsvCell(value: string) {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function buildCsv(template: ImportTemplate) {
  const exportHeaders = template.exportHeaders ?? template.headers;
  return [exportHeaders, ...template.rows].map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
}

async function buildTemplateWorkbook(
  template: ImportTemplate,
  t: (key: string) => string,
) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const displayHeaders = template.fields.map((field) => field.label ?? field.name);
  const exportHeaders = template.exportHeaders ?? template.headers;
  const needsLabelRow =
    exportHeaders.length !== displayHeaders.length ||
    exportHeaders.some((header, index) => header !== displayHeaders[index]);
  const templateRows = [
    exportHeaders,
    ...(needsLabelRow ? [displayHeaders] : []),
    ...template.rows,
    ...(Array.isArray(template.footerRows) && template.footerRows.length > 0
      ? [["", ""], ...template.footerRows]
      : []),
  ];
  const templateSheet = XLSX.utils.aoa_to_sheet(templateRows);
  templateSheet["!cols"] = template.headers.map((header, index) => ({
    wch: Math.max(header.length, displayHeaders[index]?.length ?? 0, 14),
  }));
  XLSX.utils.book_append_sheet(workbook, templateSheet, template.sheetName ?? t("batchImport.sheet.template"));

  const noteRows = [
    [template.title],
    [template.description],
    ...(template.guideNotes ?? []).map((note) => [note]),
    [],
    [t("batchImport.sheet.noteTitle"), t("batchImport.sheet.noteContent")],
    [],
    [
      t("batchImport.sheet.fieldKey"),
      t("batchImport.sheet.displayLabel"),
      t("batchImport.sheet.requiredColumn"),
      t("batchImport.sheet.ruleColumn"),
    ],
    ...template.fields.map((field) => [
      field.label ?? field.name,
      "",
      field.required ? t("batchImport.required") : t("batchImport.optional"),
      field.note,
    ]),
  ];
  const noteSheet = XLSX.utils.aoa_to_sheet(noteRows);
  noteSheet["!cols"] = [{ wch: 20 }, { wch: 18 }, { wch: 10 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(workbook, noteSheet, t("batchImport.sheet.instructions"));
  return { XLSX, workbook };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function parseMoney(value: string) {
  const normalized = value.replace(/[,，￥¥\s]/g, "");
  if (!normalized) return 0;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.abs(amount) : 0;
}

function parseLooseNumber(value: string) {
  const normalized = value.replace(/[,，￥¥\s]/g, "");
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function parseFundFeeRateInput(value: string) {
  const raw = value.trim();
  if (!raw) return null;
  const rate = parseLooseNumber(raw.replace(/%/g, ""));
  return rate == null || rate < 0 ? null : rate;
}

function parseFundFeeInput(value: string) {
  const raw = value.trim();
  if (!raw) return { fee: null as number | null, feeRateInput: null as number | null };
  if (raw.includes("%")) {
    return {
      fee: null as number | null,
      feeRateInput: parseFundFeeRateInput(raw),
    };
  }
  const fee = parseLooseNumber(raw);
  return {
    fee: fee == null ? null : Math.abs(fee),
    feeRateInput: null as number | null,
  };
}

function normalizeFundHeaderText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function formatDateParts(year: number, month: number, day: number) {
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return "";
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function formatTimeParts(hour: number, minute: number, second: number | null) {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || (second != null && (second < 0 || second > 59))) return "";
  const time = `${pad2(hour)}:${pad2(minute)}`;
  return second == null ? time : `${time}:${pad2(second)}`;
}

function appendNormalizedTime(datePart: string, hourText?: string, minuteText?: string, secondText?: string) {
  if (!datePart || hourText == null || minuteText == null) return datePart;
  const timePart = formatTimeParts(Number(hourText), Number(minuteText), secondText == null ? null : Number(secondText));
  return timePart ? `${datePart} ${timePart}` : datePart;
}

function dateInputValue(value: string) {
  return value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? value;
}

function mergeDateInputWithExistingTime(dateValue: string, previousValue: string) {
  const timeSuffix = previousValue.match(/^\d{4}-\d{2}-\d{2}(\s+\d{1,2}:\d{2}(?::\d{2})?)$/)?.[1] ?? "";
  return `${dateValue}${timeSuffix}`;
}

function normalizeDateCell(value: string) {
  const raw = value.trim().replace(/\s+/g, " ");
  if (!raw) return "";

  const excelSerial = Number(raw);
  if (Number.isFinite(excelSerial) && excelSerial > 20000 && excelSerial < 80000) {
    const utc = Date.UTC(1899, 11, 30) + excelSerial * 86400000;
    const date = new Date(utc);
    const datePart = formatDateParts(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    const hour = date.getUTCHours();
    const minute = date.getUTCMinutes();
    const second = date.getUTCSeconds();
    return hour || minute || second ? `${datePart} ${formatTimeParts(hour, minute, second)}` : datePart;
  }

  const normalized = raw
    .replace(/[\u5e74\u6708]/g, "-")
    .replace(/[\u65e5\u53f7]/g, "")
    .replace(/[.\/]/g, "-")
    .trim();

  let match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    return appendNormalizedTime(formatDateParts(Number(match[1]), Number(match[2]), Number(match[3])), match[4], match[5], match[6]);
  }

  match = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const datePart = formatDateParts(Number(match[3]), Number(match[1]), Number(match[2]));
    if (datePart) {
      return appendNormalizedTime(datePart, match[4], match[5], match[6]);
    }
  }

  match = normalized.match(/^(\d{1,2})-(\d{1,2})-(\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (match) {
    const year = Number(match[3]);
    const datePart = formatDateParts(year >= 70 ? 1900 + year : 2000 + year, Number(match[1]), Number(match[2]));
    if (datePart) {
      return appendNormalizedTime(datePart, match[4], match[5], match[6]);
    }
  }

  match = normalized.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match) return formatDateParts(Number(match[1]), Number(match[2]), Number(match[3]));

  // Lenient fallback (e.g. "26-02-2026" day-first, "Jan 26, 2026"); date part only.
  return parseFlexibleDateToYmd(raw) ?? raw;
}

function normalizeOptionalDateCell(value: string) {
  const normalized = normalizeDateCell(value);
  return /^\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?$/.test(normalized) ? normalized : "";
}

function isExpenseRefundImportText(source: string) {
  return isExpenseRefundLikeText(source);
}

function inferBillType(source: string, inflow: number, outflow: number, counterAccount: string): ParsedItem["type"] {
  if (isExpenseRefundImportText(source)) return "expense";
  if (/结息|利息|派息|收入|収入|工资|給与|报销|返现|返利|credit/i.test(source)) return "income";
  if (/转入|转进|他行转入|账户转入|转出|转账|转给|转到|汇款|跨行转账|取现|还款|振替|返済|repayment|payment/i.test(source)) return "transfer";
  if (/installment/i.test(source)) return "expense";
  if (counterAccount) return "transfer";
  if (inflow > 0 && outflow <= 0) return "income";
  return "expense";
}

function parseMajorType(value: string): ParsedItem["type"] | null {
  const raw = value.trim();
  if (!raw) return null;
  if (/^(支出|expense|outflow|installment)$/.test(raw)) return "expense";
  if (/^(收入|income|inflow|refund|credit|収入)$/.test(raw)) return "income";
  if (/^(转账|transfer|信用卡还款|还款|repayment|payment|振替|クレジットカード返済)$/.test(raw)) return "transfer";
  if (/^(投资|investment|投資)$/.test(raw)) return "investment";
  return null;
}

function parseImportBusinessType(params: {
  majorTypeText: string;
  explicitType: string;
  account: string;
  counterAccount: string;
}): CreditCardRepaymentBusinessType | null {
  const explicit = `${params.majorTypeText} ${params.explicitType}`.trim();
  if (/信用卡还款|credit\s*card\s*(?:repayment|payment)/i.test(explicit)) {
    return CREDIT_CARD_REPAYMENT_BUSINESS_TYPE;
  }
  if (
    /^(还款|repayment|payment)$/i.test(explicit) &&
    /信用卡|贷记卡|credit\s*card/i.test(`${params.account} ${params.counterAccount}`)
  ) {
    return CREDIT_CARD_REPAYMENT_BUSINESS_TYPE;
  }
  return null;
}

function getPreviewType(item: Pick<ParsedItem, "type" | "businessType">): PreviewType {
  return isCreditCardRepaymentBusinessType(item.businessType)
    ? CREDIT_CARD_REPAYMENT_BUSINESS_TYPE
    : item.type;
}

function inferTransferDirection(source: string, inflow: number, outflow: number): "in" | "out" {
  if (/转入|转进|他行转入|账户转入|收款/.test(source)) return "in";
  if (/转出|转账|转给|转到|汇款|跨行转账|取现|还款/.test(source)) return "out";
  if (inflow > 0 && outflow <= 0) return "in";
  return "out";
}

function importCreditCardPaymentSourceHint(source: string) {
  const maskedTail = source.match(/\*{2,}(\d{4})(?!\d)/);
  if (maskedTail?.[1]) return `尾号${maskedTail[1]}`;
  const sourceTail = source.match(/(?:银联(?:入账|转账|代扣|支付)?|云闪付|自动(?:扣款|还款)|付款|扣款|还款|转账|代扣)[^\d]{0,18}(\d{4})(?![\d.])/);
  if (sourceTail?.[1]) return /银联入账|银联转账|银联代扣|银联支付|云闪付/i.test(source)
    ? `银联入账尾号${sourceTail[1]}`
    : `尾号${sourceTail[1]}`;
  return "";
}

function normalizeFlowFields(
  type: ParsedItem["type"],
  amountValue: number,
  inflowValue: number,
  outflowValue: number,
  transferDirection?: "in" | "out",
) {
  const amount = Math.abs(Number(amountValue || inflowValue || outflowValue) || 0);
  const inflow = Math.abs(Number(inflowValue) || 0);
  const outflow = Math.abs(Number(outflowValue) || 0);

  if (type === "income") {
    const nextAmount = amount || inflow;
    return { amount: nextAmount, inflow: nextAmount, outflow: 0 };
  }
  if (type === "expense") {
    const nextAmount = amount || outflow || inflow;
    if (inflow > 0 && outflow <= 0) return { amount: nextAmount, inflow: nextAmount, outflow: 0 };
    return { amount: nextAmount, inflow: 0, outflow: nextAmount };
  }
  if (type === "transfer") {
    const nextAmount = amount || inflow || outflow;
    if (transferDirection === "in") return { amount: nextAmount, inflow: nextAmount, outflow: 0 };
    if (transferDirection === "out") return { amount: nextAmount, inflow: 0, outflow: nextAmount };
  }
  return { amount, inflow, outflow };
}

function previewTransferDirectionFor(
  item: Pick<ParsedItem, "importMode" | "businessType" | "transferDirection" | "inflow" | "outflow">,
): "in" | "out" {
  if (item.importMode === "credit_card" && isCreditCardRepaymentBusinessType(item.businessType)) return "in";
  if (isCreditCardRepaymentBusinessType(item.businessType)) return "out";
  return item.transferDirection ?? ((item.inflow ?? 0) > 0 && (item.outflow ?? 0) <= 0 ? "in" : "out");
}

function directionalAccountValues(item: ParsedItem) {
  const direction = previewTransferDirectionFor(item);
  if (item.type === "transfer") {
    return {
      account: (direction === "in" ? item.toAccount : item.fromAccount) || item.account || "",
      counterAccount: (direction === "in" ? item.fromAccount : item.toAccount) || "",
      direction,
    };
  }
  return {
    account: item.account || "",
    counterAccount: "",
    direction,
  };
}

function accountPatchForPreviewTypeChange(
  item: ParsedItem,
  nextType: ParsedItem["type"],
  nextBusinessType: CreditCardRepaymentBusinessType | null,
) {
  const { account, counterAccount, direction } = directionalAccountValues(item);
  if (nextType === "transfer") {
    const nextDirection = nextBusinessType
      ? item.importMode === "credit_card" ? "in" : "out"
      : item.type === "income"
        ? "in"
        : item.type === "expense"
          ? "out"
          : direction;
    return nextDirection === "in"
      ? { transferDirection: "in" as const, toAccount: account, fromAccount: counterAccount }
      : { transferDirection: "out" as const, fromAccount: account, toAccount: counterAccount };
  }
  if (item.type !== "transfer") return {};
  return {
    account: nextType === "income"
      ? (item.toAccount || account)
      : (item.fromAccount || account),
    fromAccount: "",
    toAccount: "",
    transferDirection: undefined,
  };
}

function worksheetRows(XLSX: typeof import("xlsx"), workbook: WorkBook, sheetName: string): string[][] {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<Array<string | number | boolean | Date | null>>(sheet, {
    header: 1,
    raw: false,
    defval: "",
  }).map((row) => row.map((cell) => String(cell ?? "").trim()));
}

function importHeaderSignature(row: string[]) {
  return row.map(normalizeImportAccountMatchKey).join("|");
}

type StatementFieldHeaders = Record<StatementImportField, readonly string[]>;

function billHeaderScore(row: string[], fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS) {
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

function fundHeaderScore(row: string[]) {
  const index = buildFundHeaderIndex(row);
  let score = 0;
  if (index.has("date")) score += 4;
  if (index.has("fundAccount")) score += 4;
  if (index.has("fundCode")) score += 4;
  if (index.has("amount")) score += 4;
  if (index.has("fundSubtype")) score += 2;
  if (index.has("cashAccount")) score += 1;
  return score >= 11 ? score : 0;
}

function importHeaderScore(row: string[], fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS) {
  return Math.max(billHeaderScore(row, fieldHeaders), fundHeaderScore(row));
}

/** True when the parsed workbook rows carry fund-specific columns (fund code/account/amount). */
function looksLikeFundImportFile(rows: string[][]) {
  return fundHeaderScore(rows[0] ?? []) >= 11;
}

function trimWorkbookRowsToImportHeader(rows: string[][], fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS) {
  const compactRows = rows.filter((row) => row.some((cell) => cell.trim()));
  let bestIndex = 0;
  let bestScore = importHeaderScore(compactRows[0] ?? [], fieldHeaders);
  compactRows.slice(0, 25).forEach((row, index) => {
    const score = importHeaderScore(row, fieldHeaders);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestScore > 0 ? compactRows.slice(bestIndex) : compactRows;
}

function normalizeKnownPaymentWorkbookRows(
  rawSheetRows: Array<{ sheetName: string; rows: string[][] }>,
  sheetCount: number,
): ImportFileParseResult | null {
  const jdRows = normalizeJdWorkbookRows(rawSheetRows);
  if (jdRows) {
    return {
      rows: jdRows.rows,
      sourceDataRowCount: jdRows.sourceDataRowCount,
      workbook: {
        sheetCount,
        includedSheetCount: jdRows.includedSheetCount,
      },
    };
  }

  const alipayRows = normalizeAlipayWorkbookRows(rawSheetRows);
  if (alipayRows) {
    return {
      rows: alipayRows.rows,
      sourceDataRowCount: alipayRows.sourceDataRowCount,
      workbook: {
        sheetCount,
        includedSheetCount: alipayRows.includedSheetCount,
      },
    };
  }

  const wechatRows = normalizeWechatWorkbookRows(rawSheetRows);
  if (wechatRows) {
    return {
      rows: wechatRows.rows,
      sourceDataRowCount: wechatRows.sourceDataRowCount,
      workbook: {
        sheetCount,
        includedSheetCount: wechatRows.includedSheetCount,
      },
    };
  }

  return null;
}

function mergeWorkbookRows(
  XLSX: typeof import("xlsx"),
  workbook: WorkBook,
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
): ImportFileParseResult {
  const rawSheetRows = workbook.SheetNames
    .map((sheetName) => ({ sheetName, rows: worksheetRows(XLSX, workbook, sheetName) }))
    .filter((item) => item.rows.length > 0);

  const knownRows = normalizeKnownPaymentWorkbookRows(rawSheetRows, workbook.SheetNames.length);
  if (knownRows) return knownRows;

  const sheetRows = rawSheetRows
    .map((item) => ({ sheetName: item.sheetName, rows: trimWorkbookRowsToImportHeader(item.rows, fieldHeaders) }))
    .filter((item) => item.rows.length > 0);
  if (sheetRows.length === 0) {
    return { rows: [], sourceDataRowCount: 0, workbook: { sheetCount: workbook.SheetNames.length, includedSheetCount: 0 } };
  }

  const groups = new Map<string, typeof sheetRows>();
  for (const item of sheetRows) {
    const signature = importHeaderSignature(item.rows[0] ?? []);
    groups.set(signature, [...(groups.get(signature) ?? []), item]);
  }
  const selectedSheets = Array.from(groups.values()).sort((a, b) => {
    const aScore = importHeaderScore(a[0]?.rows[0] ?? [], fieldHeaders);
    const bScore = importHeaderScore(b[0]?.rows[0] ?? [], fieldHeaders);
    if (aScore !== bScore) return bScore - aScore;
    const aRows = a.reduce((sum, item) => sum + Math.max(0, item.rows.length - 1), 0);
    const bRows = b.reduce((sum, item) => sum + Math.max(0, item.rows.length - 1), 0);
    return bRows - aRows;
  })[0] ?? [];
  const primaryRows = selectedSheets[0]?.rows ?? [];
  const primarySecondSignature = importHeaderSignature(primaryRows[1] ?? []);
  const primaryHasSecondHeader = looksLikeFundLabelRow(primaryRows[1] ?? []);
  const mergedRows = [...primaryRows];

  for (const item of selectedSheets.slice(1)) {
    const hasSameSecondHeader = primaryHasSecondHeader && importHeaderSignature(item.rows[1] ?? []) === primarySecondSignature;
    mergedRows.push(...item.rows.slice(hasSameSecondHeader ? 2 : 1));
  }

  return {
    rows: mergedRows,
    sourceDataRowCount: selectedSheets.reduce((sum, item) => {
      const hasSameSecondHeader = primaryHasSecondHeader && importHeaderSignature(item.rows[1] ?? []) === primarySecondSignature;
      return sum + Math.max(0, item.rows.length - (hasSameSecondHeader ? 2 : 1));
    }, 0),
    workbook: {
      sheetCount: workbook.SheetNames.length,
      includedSheetCount: selectedSheets.length,
    },
  };
}

async function parseImportFile(
  file: File,
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
): Promise<ImportFileParseResult> {
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (ext === "xlsx" || ext === "xls") {
    const XLSX = await import("xlsx");
    const data = await file.arrayBuffer();
    return mergeWorkbookRows(XLSX, XLSX.read(data, { type: "array", cellDates: true }), fieldHeaders);
  }
  const rows = parseCsv(await file.text());
  const rawSheetRows = [{ sheetName: file.name, rows }];
  const knownRows = normalizeKnownPaymentWorkbookRows(rawSheetRows, 1);
  if (knownRows) return knownRows;
  const trimmedRows = trimWorkbookRowsToImportHeader(rows, fieldHeaders);
  return { rows: trimmedRows, sourceDataRowCount: Math.max(0, trimmedRows.length - 1) };
}

function waitForBrowserPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(resolve, 0);
      });
    });
  });
}

function buildFundHeaderIndex(headers: string[]) {
  const normalizedHeaders = headers.map(normalizeFundHeaderText);
  const map = new Map<FundImportHeaderField, number>();
  (Object.entries(FUND_FIELD_ALIASES) as Array<[FundImportHeaderField, string[]]>).forEach(([field, aliases]) => {
    const index = normalizedHeaders.findIndex((header) => aliases.some((alias) => normalizeFundHeaderText(alias) === header));
    if (index >= 0) map.set(field, index);
  });
  return map;
}

function hasLikelyFundHeaders(map: Map<FundImportHeaderField, number>) {
  return map.has("date") && map.has("fundAccount") && map.has("fundCode") && (map.has("amount") || map.has("units"));
}

function hasCanonicalFundHeaders(headers: string[]) {
  return headers.some((header) => FUND_CANONICAL_HEADERS.includes(header.trim() as (typeof FUND_CANONICAL_HEADERS)[number]));
}

function looksLikeFundLabelRow(headers: string[]) {
  return headers.some((header) => FUND_LABEL_HEADER_SET.has(header.trim()));
}

function normalizeFundActionText(value: string) {
  return value.trim().toLowerCase().replace(/[\s_\-（）()]+/g, "");
}

function normalizeFundImportAction(rawAction: string) {
  const action = normalizeFundActionText(rawAction);
  // 红利再投 / 再投 must be checked before 分红 so reinvest is not misread as cash dividend.
  if (action.includes("红利再投") || action.includes("再投") || action.includes("再投資") || action.includes("分配金再投資")) return "dividend_reinvest";
  if (action.includes("现金分红") || action.includes("分红") || action.includes("配当") || action.includes("現金分配")) return "dividend_cash";
  if (action.includes("定投") || action.includes("積立")) return "buy";
  if (action.includes("申购") || action.includes("買入") || action.includes("买入") || action.includes("購入")) return "buy";
  if (action.includes("赎回") || action.includes("贖回") || action.includes("卖出") || action.includes("解約")) return "redeem";
  if (["buy", "purchase", "subscribe", "regularinvest", "recurringinvest", "recurringbuy"].includes(action)) return "buy";
  if (["redeem", "redemption", "sell"].includes(action)) return "redeem";
  if (["dividendcash", "cashdividend"].includes(action)) return "dividend_cash";
  if (["dividendreinvest", "reinvestdividend"].includes(action)) return "dividend_reinvest";
  return "";
}

function fundRowsToItems(rows: string[][]): FundImportUploadItem[] {
  const firstRow = rows[0] ?? [];
  const secondRow = rows[1] ?? [];
  const firstHeaderIndex = buildFundHeaderIndex(firstRow);
  const secondHeaderIndex = buildFundHeaderIndex(secondRow);

  let headerIndex = firstHeaderIndex;
  let dataRows = rows.slice(1);

  if (hasCanonicalFundHeaders(firstRow)) {
    headerIndex = firstHeaderIndex;
    dataRows = rows.slice(looksLikeFundLabelRow(secondRow) ? 2 : 1);
  } else if (hasLikelyFundHeaders(firstHeaderIndex)) {
    headerIndex = firstHeaderIndex;
    dataRows = rows.slice(1);
  } else if (hasLikelyFundHeaders(secondHeaderIndex)) {
    headerIndex = secondHeaderIndex;
    dataRows = rows.slice(2);
  }

  const readField = (row: string[], field: FundImportHeaderField) => {
    const index = headerIndex.get(field);
    return index == null ? "" : String(row[index] ?? "").trim();
  };

  // The 业务类型 column (e.g. 定投申购 / 定投申购（智汇定投）) distinguishes
  // recurring buys from one-time purchases. It is not a fundSubtype header, so
  // locate it separately to derive the regular-invest source.
  const headerRow = headerIndex === firstHeaderIndex ? firstRow : secondRow;
  const normalizedHeaderRow = headerRow.map(normalizeFundHeaderText);
  const businessTypeIndex = normalizedHeaderRow.findIndex((header) => header === "业务类型" || header === "businesstype" || header === "transactiontype");
  const readBusinessType = (row: string[]) => businessTypeIndex < 0 ? "" : String(row[businessTypeIndex] ?? "").trim();

  return dataRows
    .filter((row) => row.some((cell) => String(cell ?? "").trim()))
    .filter((row) => {
      const bodyCells = row.map((cell) => String(cell ?? "").trim());
      return !(
        bodyCells.length >= 2 &&
        bodyCells[0] &&
        !/^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(bodyCells[0]) &&
        bodyCells.slice(1).every((cell) => !cell || /[A-Za-z\u4e00-\u9fff\u3040-\u30ff]/.test(cell)) &&
        !bodyCells.some((cell) => /^\d+(?:\.\d+)?%?$/.test(cell) || /^(buy|redeem|dividend_cash|dividend_reinvest)$/.test(normalizeFundImportAction(cell)) || /^(buy|redeem|cashdividend|dividendreinvest)$/.test(normalizeFundActionText(cell)))
      );
    })
    .map((row) => {
      const amount = parseLooseNumber(readField(row, "amount")) ?? 0;
      const parsedFee = parseFundFeeInput(readField(row, "fee"));
      const parsedFeeRate = parseFundFeeRateInput(readField(row, "feeRateInput"));
      const fundSubtype = normalizeFundImportAction(readField(row, "fundSubtype")) || readField(row, "fundSubtype");
      const businessType = readBusinessType(row);
      const source = businessType.includes("定投") || businessType.includes("積立") ? "regular_invest" : undefined;
      return {
        rawText: row.join(" "),
        date: normalizeDateCell(readField(row, "date")),
        fundSubtype,
        source,
        cashAccount: readField(row, "cashAccount"),
        fundAccount: readField(row, "fundAccount"),
        fundCode: readField(row, "fundCode"),
        amount,
        units: parseLooseNumber(readField(row, "units")),
        nav: parseLooseNumber(readField(row, "nav")),
        fee: parsedFee.fee,
        feeRateInput: parsedFee.fee == null ? (parsedFeeRate ?? parsedFee.feeRateInput) : null,
        confirmDate: normalizeDateCell(readField(row, "confirmDate")) || null,
        arrivalDate: normalizeDateCell(readField(row, "arrivalDate")) || null,
        remark: readField(row, "remark"),
      };
    });
}

function formatOptionalNumber(value: number | null | undefined, digits = 2) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function previewRowLabel(rowNums: number[], text: string, t: (key: string, params?: Record<string, string | number>) => string) {
  if (rowNums.length === 1) {
    return t("batchImport.previewRowLineSingle", { row: rowNums[0], text });
  }
  const rows = rowNums.slice(0, 10).join("、");
  const more = rowNums.length > 10 ? t("batchImport.previewRowLineMore", { count: rowNums.length }) : "";
  return t("batchImport.previewRowLineMany", { rows, more, text });
}

function getFundImportSubtypeLabel(subtype: string, source: string, t: (key: string) => string) {
  if (subtype === "buy_failed" && source === "regular_invest_refund") return t("batchImport.fundSubtype.refund");
  if (subtype === "buy_failed") return t("batchImport.fundSubtype.unfilledRefund");
  if (subtype === "buy" && source === "regular_invest") return t("fund.subtype.regular_invest");
  if (subtype === "buy") return t("fund.subtype.buy");
  if (subtype === "redeem") return t("fund.subtype.redeem");
  if (subtype === "dividend_cash") return t("fund.subtype.dividend_cash");
  if (subtype === "dividend_reinvest") return t("fund.subtype.dividend_reinvest");
  return subtype || "-";
}

function getFundImportSourceLabel(source: string, t: (key: string) => string) {
  if (source === "regular_invest") return t("batchImport.fundSource.regularInvest");
  if (source === "regular_invest_refund") return t("batchImport.fundSource.regularInvestRefund");
  if (source === "manual") return t("batchImport.fundSource.manual");
  if (source === "dividend") return t("batchImport.fundSource.dividend");
  return source || "-";
}

function buildFundRuleEditorRows(_items: FundImportPreviewItem[]) {
  return [];
}

function hasFundBlockingIssue(item: FundImportPreviewItem | undefined) {
  return !!item?.issues.some((issue) => issue.level === "error");
}

function selectableFundIndexes(items: FundImportPreviewItem[]) {
  return new Set(items.flatMap((item, index) => hasFundBlockingIssue(item) ? [] : [index]));
}

function serializeFundRuleOverrides(rows: FundRuleEditorRow[], t: (key: string) => string) {
  const invalidLabels: string[] = [];
  const overrides = rows.flatMap((row) => {
    const parseDays = (value: string, label: string) => {
      const trimmed = value.trim();
      if (!trimmed) return null;
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num < 0) {
        invalidLabels.push(`${row.fundCode} ${label}`);
        return null;
      }
      return Math.trunc(num);
    };
    const confirmDays = parseDays(row.confirmDays, t("batchImport.fundPreview.confirmDays"));
    const arrivalDays = parseDays(row.arrivalDays, t("batchImport.fundPreview.arrivalDays"));
    if (!row.fundCode || (!row.fundAccountId && !row.fundAccount.trim())) return [];
    return [{
      fundAccountId: row.fundAccountId,
      fundAccount: row.fundAccount,
      fundCode: row.fundCode,
      confirmDays,
      arrivalDays,
    }];
  });
  return { overrides, invalidLabels };
}

function normalRowsToItems(
  rows: string[][],
  importMode: BillImportMode,
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
): ParsedItem[] {
  const [headers = [], ...dataRows] = rows;
  const headerReader = createStatementHeaderReader(headers, fieldHeaders);
  const readAny = (row: string[], keys: readonly string[]) => headerReader.readAliases(row, keys);
  const normalizeCreditAccountValue = (value: string) => {
    const trimmed = value.trim();
    return /^\d{4}$/.test(trimmed) ? `信用卡${trimmed}` : trimmed;
  };
  const sourceAccountKeys = fieldHeaders.sourceAccount;
  const paymentAccountKeys = fieldHeaders.repaymentAccount;
  const creditAccountKeys = fieldHeaders.creditAccount;
  const transferCounterAccountKeys = fieldHeaders.transferCounterAccount;
  const statementAccounts = importMode === "credit_card"
    ? dataRows.map((row) => {
      const creditAccount = normalizeCreditAccountValue(readAny(row, creditAccountKeys));
      return creditAccount || readAny(row, sourceAccountKeys);
    }).filter(Boolean)
    : [];
  const unifiedStatementAccount = new Set(statementAccounts.map(normalizeImportAccountMatchKey)).size === 1
    ? statementAccounts[0] ?? ""
    : "";
  const signedAmountInflowSign = importMode === "credit_card"
    ? inferSignedAmountInflowSign(dataRows.map((row) => {
      const rawOutflowText = readAny(row, fieldHeaders.outflow);
      const rawInflowText = readAny(row, fieldHeaders.inflow);
      const hasExplicitFlow = parseMoney(rawInflowText) > 0 || parseMoney(rawOutflowText) > 0 || !!rawInflowText || !!rawOutflowText;
      if (hasExplicitFlow) return { amount: null, text: "" };
      const majorTypeText = readAny(row, fieldHeaders.majorType);
      const explicitType = readAny(row, fieldHeaders.explicitType);
      const category = readAny(row, fieldHeaders.category);
      const institution = readAny(row, fieldHeaders.institution);
      const remark = readAny(row, fieldHeaders.remark);
      const secondRemark = readAny(row, fieldHeaders.secondRemark);
      const sourceAccount = readAny(row, sourceAccountKeys);
      const paymentAccount = readAny(row, paymentAccountKeys);
      const creditAccount = normalizeCreditAccountValue(readAny(row, creditAccountKeys));
      const explicitCounterAccount = readAny(row, transferCounterAccountKeys);
      return {
        amount: parseLooseNumber(readAny(row, fieldHeaders.amount)),
        text: `${majorTypeText} ${explicitType} ${category} ${institution} ${remark} ${secondRemark} ${explicitCounterAccount} ${sourceAccount} ${paymentAccount} ${creditAccount} ${row.join(" ")}`,
      };
    }))
    : null;

  return dataRows.map((row) => {
    const date = normalizeDateCell(readAny(row, fieldHeaders.transactionDate));
    const rawPostedAt = readAny(row, fieldHeaders.postedAt);
    const postedAt = normalizeOptionalDateCell(rawPostedAt);
    const rawOutflowText = readAny(row, fieldHeaders.outflow);
    const rawInflowText = readAny(row, fieldHeaders.inflow);
    const rawAmountText = readAny(row, fieldHeaders.amount);
    const rawOutflow = parseMoney(rawOutflowText);
    const rawInflow = parseMoney(rawInflowText);
    const rawAmountSigned = parseLooseNumber(rawAmountText) ?? 0;
    const rawAmount = Math.abs(rawAmountSigned);
    const sourceAccount = readAny(row, sourceAccountKeys);
    const paymentAccount = readAny(row, paymentAccountKeys);
    const creditAccount = normalizeCreditAccountValue(readAny(row, creditAccountKeys));
    const explicitCounterAccount = readAny(row, transferCounterAccountKeys);
    const rowAccount = importMode === "credit_card"
      ? creditAccount || readAny(row, sourceAccountKeys)
      : sourceAccount || paymentAccount || creditAccount;
    const account = importMode === "credit_card" ? unifiedStatementAccount || rowAccount : rowAccount;
    const remark = readAny(row, fieldHeaders.remark);
    const category = readAny(row, fieldHeaders.category);
    const institution = readAny(row, fieldHeaders.institution);
    const tags = readAny(row, fieldHeaders.tags);
    const majorTypeText = readAny(row, fieldHeaders.majorType);
    const majorType = parseMajorType(majorTypeText);
    const explicitType = readAny(row, fieldHeaders.explicitType);
    // The "type" column may carry the user's explicit classification
    // (income/expense/transfer/investment). When it resolves to a concrete
    // type, prefer it over the looser major-type column.
    const explicitMajorType = parseMajorType(explicitType);
    const resolvedMajorType = explicitMajorType ?? majorType;
    let counterAccount = importMode === "credit_card"
      ? paymentAccount || explicitCounterAccount
      : explicitCounterAccount || ((sourceAccount || paymentAccount) && creditAccount ? creditAccount : "");
    const ignoredCounterAccount =
      importMode === "normal" &&
      explicitCounterAccount &&
      (resolvedMajorType === "income" || resolvedMajorType === "expense")
        ? explicitCounterAccount
        : "";
    if (ignoredCounterAccount) counterAccount = "";
    let businessType = parseImportBusinessType({
      majorTypeText,
      explicitType,
      account,
      counterAccount,
    });
    const secondRemark = readAny(row, fieldHeaders.secondRemark);
    const rowText = row.join(" ");
    let source = `${majorTypeText} ${majorType ?? ""} ${explicitType} ${category} ${institution} ${remark} ${secondRemark} ${counterAccount} ${account} ${rowText}`;
    const creditCardRepaymentLike = isCreditCardRepaymentLikeText(source) || /自动还款|自动扣款|银联转账|银联入账|云闪付|autopay/i.test(source);
    if (importMode === "credit_card" && !counterAccount.trim() && creditCardRepaymentLike) {
      counterAccount = importCreditCardPaymentSourceHint(source);
      source = `${majorTypeText} ${majorType ?? ""} ${explicitType} ${category} ${institution} ${remark} ${secondRemark} ${counterAccount} ${account} ${rowText}`;
    }
    const merchant = inferKnownStatementMerchant({ institution, remark, rawText: rowText });
    const resolvedCategory = category || merchant.category || "";
    const resolvedInstitution = institution || merchant.institution || "";
    const isExpenseRefund = isExpenseRefundImportText(source);
    const creditCardAdjustmentLike = isCreditCardCreditAdjustmentLikeText(source);
    const amountLooksIncome = !isExpenseRefund && (/结息|利息|派息|收入|工资|报销|返现|返利|贷方|贷记|入账|存入/.test(source) || creditCardAdjustmentLike);
    const hasExplicitFlow = rawInflow > 0 || rawOutflow > 0 || !!rawInflowText || !!rawOutflowText;
    const signedDirection = importMode === "credit_card" && !hasExplicitFlow
      ? signedAmountDirection(rawAmountSigned, signedAmountInflowSign)
      : null;
    const creditCardSignedInflow = importMode === "credit_card" && !hasExplicitFlow && rawAmount > 0 && signedDirection === "in";
    const creditCardSignedOutflow = importMode === "credit_card" && !hasExplicitFlow && rawAmount > 0 && signedDirection === "out";
    const rawInferredType = resolvedMajorType ?? (
      importMode === "credit_card" && !hasExplicitFlow && rawAmount > 0
        ? creditCardRepaymentLike ? "transfer" : creditCardSignedInflow && amountLooksIncome ? "income" : "expense"
        : inferBillType(
          source,
          rawInflow || (!hasExplicitFlow && rawAmountSigned > 0 && amountLooksIncome ? rawAmount : 0),
          rawOutflow || (!hasExplicitFlow && rawAmountSigned < 0 ? rawAmount : 0),
          counterAccount,
        )
    );
    // If type is transfer but the category explicitly says income and there is no
    // counter account, the transfer keyword likely describes how money arrived
    // rather than a true account-to-account transfer. Respect the category.
    const explicitFlowDirection: "in" | "out" | null =
      rawInflow > 0 && rawOutflow <= 0 ? "in"
      : rawOutflow > 0 && rawInflow <= 0 ? "out"
      : null;
    const creditStatementRepaymentCandidate =
      importMode === "credit_card" &&
      !businessType &&
      rawInferredType === "transfer" &&
      (explicitFlowDirection !== "out" || !hasExplicitFlow || creditCardSignedInflow) &&
      creditCardRepaymentLike;
    if (creditStatementRepaymentCandidate) {
      businessType = CREDIT_CARD_REPAYMENT_BUSINESS_TYPE;
    }
    let type: ParsedItem["type"] = rawInferredType;
    if (businessType) {
      type = "transfer";
    } else if (isExpenseRefund && rawInferredType !== "transfer") {
      type = "expense";
    } else if (creditCardSignedInflow && rawInferredType === "income") {
      type = "income";
    } else if (creditCardSignedInflow && rawInferredType !== "transfer") {
      type = "expense";
    } else if (creditCardSignedOutflow) {
      type = "expense";
    } else if (explicitFlowDirection === "in" && rawInferredType !== "transfer") {
      type = "income";
    } else if (explicitFlowDirection === "out" && rawInferredType !== "transfer") {
      type = "expense";
    } else if (rawInferredType === "transfer" && !counterAccount && /收入/.test(category)) {
      type = "income";
    }
    const onlyAmountFlow = !hasExplicitFlow && rawAmount > 0
      ? normalizeFlowFields(
        type,
        rawAmount,
        type === "income" || isExpenseRefund || creditCardSignedInflow ? rawAmount : 0,
        type === "income" || isExpenseRefund || creditCardSignedInflow ? 0 : rawAmount,
        type === "transfer"
          ? previewTransferDirectionFor({ importMode, businessType, transferDirection: creditCardSignedInflow ? "in" : "out", inflow: creditCardSignedInflow ? rawAmount : 0, outflow: creditCardSignedInflow ? 0 : rawAmount })
          : undefined,
      )
      : null;
    const inflow = onlyAmountFlow?.inflow ?? rawInflow;
    const outflow = onlyAmountFlow?.outflow ?? rawOutflow;
    const transferDirection = type === "transfer"
      ? businessType === CREDIT_CARD_REPAYMENT_BUSINESS_TYPE
        ? previewTransferDirectionFor({ importMode, businessType, transferDirection: "out", inflow, outflow })
        : explicitFlowDirection
          ? explicitFlowDirection
        : onlyAmountFlow
          ? "out"
          : inferTransferDirection(source, inflow, outflow)
      : undefined;
    const flow = normalizeFlowFields(
      type,
      onlyAmountFlow?.amount ?? (inflow > 0 ? inflow : outflow || rawAmount),
      inflow,
      outflow,
      transferDirection,
    );
    const previewFromAccount = type === "transfer"
      ? businessType === CREDIT_CARD_REPAYMENT_BUSINESS_TYPE && importMode === "credit_card"
        ? counterAccount
        : transferDirection === "in"
            ? counterAccount
            : account
      : "";
    const previewToAccount = type === "transfer"
      ? businessType === CREDIT_CARD_REPAYMENT_BUSINESS_TYPE && importMode === "credit_card"
        ? account
        : transferDirection === "in"
            ? account
            : counterAccount
      : "";

    return {
      rawText: row.join(" "),
      type,
      businessType,
      importMode,
      statementAccount: importMode === "credit_card" ? account : undefined,
      date,
      postedAt: type === "expense" || type === "income" ? postedAt : "",
      amount: flow.amount,
      outflow: flow.outflow,
      inflow: flow.inflow,
      account: type === "transfer" ? (importMode === "credit_card" ? account : "") : account,
      fromAccount: previewFromAccount,
      toAccount: previewToAccount,
      importSourceAccount: rowAccount || account,
      importSourceFromAccount: previewFromAccount,
      importSourceToAccount: previewToAccount,
      importSourceStatementAccount: importMode === "credit_card" ? rowAccount || account : "",
      category: isCreditCardRepaymentBusinessType(businessType)
        ? CREDIT_CARD_REPAYMENT_CATEGORY_NAME
        : type === "transfer" ? category : resolvedCategory,
      institution: type === "transfer" ? institution : resolvedInstitution,
      counterparty: merchant.counterparty || "",
      tags,
      remark,
      secondRemark: type === "transfer" ? (secondRemark || remark) : "",
      transferDirection,
      importIgnoredCounterAccount: ignoredCounterAccount || undefined,
      importInvalidPostedAt: rawPostedAt && !postedAt ? rawPostedAt : undefined,
    };
  }).filter((item) => item.date && item.amount > 0);
}

function detectBillImportMode(
  rows: string[][],
  isCreditAccount?: (value: string) => boolean,
  fieldHeaders: StatementFieldHeaders = STATEMENT_IMPORT_FIELD_HEADERS,
): BillImportMode {
  const [headers = [], ...dataRows] = rows;
  const normalizedHeaders = headers.map(normalizeImportAccountMatchKey);
  const headerReader = createStatementHeaderReader(headers, fieldHeaders);
  const spdbCreditCardIndexes = matchStatementHeaderProfile(headers, SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE);
  if (spdbCreditCardIndexes) {
    let validSampleRows = 0;
    for (const row of dataRows.slice(0, 20)) {
      const date = normalizeDateCell(String(row[spdbCreditCardIndexes.transactionDate] ?? ""));
      const amount = parseLooseNumber(String(row[spdbCreditCardIndexes.amount] ?? ""));
      const description = String(row[spdbCreditCardIndexes.description] ?? "").trim();
      const cardLast4 = String(row[spdbCreditCardIndexes.cardLast4] ?? "").trim();
      if (date && amount !== null && description && /^\d{4}$/.test(cardLast4)) validSampleRows++;
      if (validSampleRows >= SPDB_CREDIT_CARD_TRANSACTION_REPORT_PROFILE.minValidSampleRows) return "credit_card";
    }
  }
  const hasSourceAccountHeader = headerReader.hasField("sourceAccount");
  const hasPaymentAccountHeader = headerReader.hasField("repaymentAccount");
  const hasCreditAccountHeader = headerReader.hasField("creditAccount");
  const hasExplicitCounterHeader = headerReader.hasField("transferCounterAccount");
  if (hasExplicitCounterHeader || ((hasSourceAccountHeader || hasPaymentAccountHeader) && hasCreditAccountHeader)) return "normal";

  const legacyCreditSpecificHeaders = new Set([
    "statementmonth",
    "cardaccount",
    "installmentno",
    "installmenttotal",
    "账单月份",
    "分期期数",
  ]);
  if (normalizedHeaders.some((header) => legacyCreditSpecificHeaders.has(header))) return "credit_card";

  const accountHeaderIndex = headerReader.findIndex([
    ...fieldHeaders.sourceAccount,
    ...fieldHeaders.creditAccount,
  ]);
  if (accountHeaderIndex < 0) return "normal";
  const creditAccountHeaderIndex = headerReader.findFieldIndex("creditAccount");
  const accountHeaderIsCreditAccount = accountHeaderIndex === creditAccountHeaderIndex;

  const accountValues = dataRows
    .slice(0, 200)
    .map((row) => String(row[accountHeaderIndex] ?? "").trim())
    .filter(Boolean);
  const uniqueAccounts = new Set(accountValues.map(normalizeImportAccountMatchKey));
  const rawUnifiedAccount = accountValues[0] ?? "";
  const unifiedAccount = accountHeaderIsCreditAccount && /^\d{4}$/.test(rawUnifiedAccount)
    ? `信用卡${rawUnifiedAccount}`
    : rawUnifiedAccount;
  return accountValues.length > 0 && uniqueAccounts.size === 1 && (
    /信用卡|贷记卡|credit\s*card/i.test(unifiedAccount) || isCreditAccount?.(unifiedAccount)
  )
    ? "credit_card"
    : "normal";
}

function normalizeForStorage(item: ParsedItem): ParsedItem {
  const flow = normalizeFlowFields(
    item.type,
    item.amount || 0,
    item.inflow || 0,
    item.outflow || 0,
    item.transferDirection,
  );
  const outflow = flow.outflow;
  const inflow = flow.inflow;
  const amount = flow.amount;
  if (item.type !== "transfer") {
    return {
      ...item,
      businessType: null,
      amount,
      outflow,
      inflow,
      account: item.account || item.fromAccount || item.toAccount || "",
      fromAccount: "",
      toAccount: "",
      secondRemark: "",
      transferDirection: undefined,
    };
  }

  if (isCreditCardRepaymentBusinessType(item.businessType)) {
    const fromAccount = item.fromAccount?.trim() ?? "";
    const toAccount = (item.statementAccount || item.toAccount || item.account || "").trim();
    return {
      ...item,
      type: "transfer",
      amount,
      account: fromAccount,
      fromAccount,
      toAccount,
      secondRemark: item.secondRemark || item.remark || "",
      transferDirection: "out",
    };
  }

  const billAccount = (item.account || (item.transferDirection === "in" ? item.toAccount : item.fromAccount) || "").trim();
  const counterAccount = (item.transferDirection === "in" ? item.fromAccount : item.toAccount)?.trim() ?? "";
  const isBillInflow = inflow > 0 && outflow <= 0;
  const isBillOutflow = outflow > 0 && inflow <= 0;
  const direction = isCreditCardRepaymentBusinessType(item.businessType)
    ? "out"
    : isBillInflow
      ? "in"
      : isBillOutflow
        ? "out"
        : item.transferDirection;
  const fromAccount = direction === "in" ? counterAccount : billAccount;
  const toAccount = direction === "in" ? billAccount : counterAccount;

  return {
    ...item,
    type: "transfer",
    amount,
    account: fromAccount,
    fromAccount,
    toAccount,
    secondRemark: item.secondRemark || item.remark || "",
    transferDirection: direction,
  };
}

export default function BatchImportPage() {
  const router = useRouter();
  const importTraceIdRef = useRef(createImportTraceId());
  const handleFundFileRef = useRef<((file: File, context?: FundImportContext | null) => Promise<void>) | null>(null);
  const { t } = useI18n();
  const formatText = useCallback((key: Parameters<typeof t>[0], values?: Record<string, string | number>) => {
    let text = t(key) as string;
    if (!values) return text;
    for (const [name, value] of Object.entries(values)) {
      text = text.split(`{${name}}`).join(String(value));
    }
    return text;
  }, [t]);
  const replaceFieldLabels = useMemo<Record<ReplaceField, string>>(() => ({
    date: t(replaceFieldLabelKeys.date),
    type: t(replaceFieldLabelKeys.type),
    outflow: t(replaceFieldLabelKeys.outflow),
    inflow: t(replaceFieldLabelKeys.inflow),
    account: t(replaceFieldLabelKeys.account),
    counterAccount: t(replaceFieldLabelKeys.counterAccount),
    category: t(replaceFieldLabelKeys.category),
    institution: t(replaceFieldLabelKeys.institution),
    tags: t(replaceFieldLabelKeys.tags),
    remark: t(replaceFieldLabelKeys.remark),
  }), [t]);
  const visibleTemplates = useMemo<ImportTemplate[]>(() => buildTemplates(t), [t]);
  const typeOptions = useMemo(
    () => [
      { value: "", label: t("batchImport.selectType") },
      { value: "expense", label: t("transaction.type.expense") },
      { value: "income", label: t("transaction.type.income") },
      { value: "transfer", label: t("transaction.type.transfer") },
      { value: CREDIT_CARD_REPAYMENT_BUSINESS_TYPE, label: t("transaction.type.creditCardRepayment") },
    ],
    [t],
  );
  const getTypeLabel = useCallback(
    (item: Pick<ParsedItem, "type" | "businessType">) =>
      isCreditCardRepaymentBusinessType(item.businessType)
        ? t("transaction.type.creditCardRepayment")
        : item.type === "income"
        ? t("transaction.type.income")
        : item.type === "transfer"
          ? t("transaction.type.transfer")
          : item.type === "investment"
            ? t("transaction.type.investment")
            : t("transaction.type.expense"),
    [t],
  );
  const [items, setItems] = useState<ParsedItem[]>([]);
  const [fundUploadItems, setFundUploadItems] = useState<FundImportUploadItem[]>([]);
  const [fundPreviewItems, setFundPreviewItems] = useState<FundImportPreviewItem[]>([]);
  const [fundRuleRows, setFundRuleRows] = useState<FundRuleEditorRow[]>([]);
  const [fundRulesDirty, setFundRulesDirty] = useState(false);
  const [fundImportContext, setFundImportContext] = useState<FundImportContext | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [fundSelected, setFundSelected] = useState<Set<number>>(new Set());
  const [drafts, setDrafts] = useState<Record<number, Partial<ParsedItem>>>({});
  const [activeImportKind, setActiveImportKind] = useState<FundImportKind>(null);
  const [activeBillMode, setActiveBillMode] = useState<BillImportMode>("normal");
  const [importing, setImporting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [importedCount, setImportedCount] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [uploadDebug, setUploadDebug] = useState<string | null>(null);
  const [accountOptions, setAccountOptions] = useState<AccountOption[]>([]);
  const [bookCategories, setBookCategories] = useState<BookCategory[]>([]);
  const [bookCategoriesLoaded, setBookCategoriesLoaded] = useState(false);
  const [categoryRuleSamples, setCategoryRuleSamples] = useState<StatementHistoricalCategorySample[]>([]);
  const [categoryRuleSamplesLoaded, setCategoryRuleSamplesLoaded] = useState(false);
  const accountMatcherRef = useRef(createImportAccountMatcher<AccountOption>([]));
  const accountIdentityConflictRef = useRef(createImportAccountIdentityConflictChecker<AccountOption>([]));
  const refreshCategoryRuleSamples = useCallback(async () => {
    const res = await fetch("/api/v1/statement/recognition-rules", { cache: "no-store" });
    const data = await res.json().catch(() => null) as { samples?: StatementHistoricalCategorySample[] } | null;
    if (!res.ok || !Array.isArray(data?.samples)) {
      throw new Error(`Recognition rules request failed: ${res.status}`);
    }
    setCategoryRuleSamples(data.samples);
    setCategoryRuleSamplesLoaded(true);
    return data.samples;
  }, []);
  const statementFieldHeaders = useMemo(
    () => buildStatementImportFieldHeaders(categoryRuleSamples),
    [categoryRuleSamples],
  );
  const pendingFileChecked = true;
  const [importCompletion, setImportCompletion] = useState<ImportCompletionState | null>(null);
  const [editingCell, setEditingCell] = useState<{ idx: number; field: EditableCell } | null>(null);
  const [showImportIssuesOnly, setShowImportIssuesOnly] = useState(false);
  const [previewIssues, setPreviewIssues] = useState<ImportIssue[]>([]);
  const [previewValidationProgress, setPreviewValidationProgress] = useState<{ checked: number; total: number } | null>(null);
  const [importProgress, setImportProgress] = useState<ServerImportProgress | null>(null);

  useEffect(() => {
    try {
      sessionStorage.removeItem(LEGACY_BATCH_IMPORT_ITEMS_STORAGE_KEY);
      const data = sessionStorage.getItem(BATCH_IMPORT_ITEMS_STORAGE_KEY);
      const storedItems = data ? JSON.parse(data) as ParsedItem[] : [];
      if (Array.isArray(storedItems) && storedItems.length > 0) {
        setActiveImportKind("normal");
        setActiveBillMode(storedItems[0]?.importMode === "credit_card" ? "credit_card" : "normal");
        setItems(storedItems);
        setSelected(new Set());
      }
    } catch {
      sessionStorage.removeItem(BATCH_IMPORT_ITEMS_STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const startedAt = performance.now();
    postImportDebugLog(importTraceIdRef.current, "accounts_request_started");
    fetch("/api/v1/accounts/internal?balances=false")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled || !data?.ok || !Array.isArray(data.accounts)) return;
        const activeAccounts = data.accounts.filter((account: AccountOption) => account.isActive !== false);
        accountMatcherRef.current = createImportAccountMatcher(activeAccounts);
        accountIdentityConflictRef.current = createImportAccountIdentityConflictChecker(activeAccounts);
        setAccountOptions(data.accounts);
        postImportDebugLog(importTraceIdRef.current, "accounts_request_succeeded", {
          accountCount: data.accounts.length,
          durationMs: Math.round(performance.now() - startedAt),
        });
      })
      .catch((error) => {
        if (!cancelled) {
          postImportDebugLog(importTraceIdRef.current, "accounts_request_failed", {
            errorType: error instanceof Error ? error.name : "unknown",
            durationMs: Math.round(performance.now() - startedAt),
          });
          setUploadDebug(formatText("batchImport.accountLoadFailed", { reason: error instanceof Error ? error.message : String(error) }));
        }
      });
    return () => { cancelled = true; };
  }, [formatText]);

  useEffect(() => {
    let cancelled = false;
    fetchSettingsBootstrap()
      .then((bootstrap) => {
        if (cancelled) return;
        setBookCategories(Array.isArray(bootstrap.categories) ? bootstrap.categories as BookCategory[] : []);
        setBookCategoriesLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setBookCategories([]);
          setBookCategoriesLoaded(true);
        }
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    refreshCategoryRuleSamples()
      .then(() => {
        if (cancelled) return;
      })
      .catch(() => {
        if (!cancelled) {
          setCategoryRuleSamples([]);
          setCategoryRuleSamplesLoaded(true);
        }
    });
    return () => { cancelled = true; };
  }, [refreshCategoryRuleSamples]);

  const accountDisplayLabel = useCallback((account: AccountOption) => {
    const provided = formatAccountTableLabel(account, "", getAccountLabelFieldsPreference());
    if (provided) return provided;
    return formatAccountSelectorLabel({
      accountName: account.name,
      institution: account.Institution
        ? {
            name: account.Institution.name ?? null,
            shortName: account.Institution.shortName ?? null,
        }
        : null,
      numberMasked: account.numberMasked,
      fields: getAccountLabelFieldsPreference(),
    });
  }, []);

  const accountHoverTitle = useCallback((account: AccountOption) => {
    return formatAccountTableTitle(account, accountDisplayLabel(account), getAccountLabelFieldsPreference());
  }, [accountDisplayLabel]);

  const activeAccountOptions = useMemo(
    () => accountOptions.filter((account) => account.isActive !== false),
    [accountOptions],
  );
  const getAccountIdentityConflict = useMemo(
    () => accountIdentityConflictRef.current,
    [],
  );
  const getAccountMatch = useCallback((value: string) => accountMatcherRef.current(value.trim()), []);
  const findMatchedAccountId = useCallback((value: string): string | null => (
    getAccountMatch(value).account?.id ?? null
  ), [getAccountMatch]);

  const accountSmartSelectOptions = useMemo<SmartSelectOption[]>(
    () =>
      activeAccountOptions.map((account) => ({
        id: account.id,
        label: accountDisplayLabel(account),
        title: accountHoverTitle(account),
      })),
    [accountDisplayLabel, accountHoverTitle, activeAccountOptions],
  );
  const accountById = useMemo(() => new Map(accountOptions.map((account) => [account.id, account])), [accountOptions]);

  const accountMatchesPickerRole = useCallback((account: AccountOption | undefined, role: AccountPickerRole) => {
    if (!account) return false;
    if (role === "credit") return isCreditCardRepaymentTargetAccountKind(account.kind);
    if (role === "repayment_source") return isCreditCardRepaymentImportSourceAccountKind(account.kind);
    return true;
  }, []);

  const accountSmartSelectOptionsByRole = useCallback((role: AccountPickerRole) =>
    activeAccountOptions
      .filter((account) => accountMatchesPickerRole(account, role))
      .map((account) => ({
        id: account.id,
        label: accountDisplayLabel(account),
        title: accountHoverTitle(account),
      } satisfies SmartSelectOption)),
  [accountDisplayLabel, accountHoverTitle, accountMatchesPickerRole, activeAccountOptions]);

  const matchedAccountForText = useCallback((value: string) => {
    const matchedId = findMatchedAccountId(value);
    return matchedId ? accountById.get(matchedId) : undefined;
  }, [accountById, findMatchedAccountId]);

  const readableAccountText = useCallback((value: string) => {
    const current = value.trim();
    if (!current) return "";
    const directId = parseImportAccountId(current) || (accountById.has(current) ? current : "");
    const account = directId ? accountById.get(directId) : matchedAccountForText(current);
    return account ? accountDisplayLabel(account) : current;
  }, [accountById, accountDisplayLabel, matchedAccountForText]);

  const isCreditAccountText = useCallback((value: string) => {
    const current = value.trim();
    if (!current) return false;
    if (/信用卡|贷记卡/.test(current)) return true;
    return isCreditCardRepaymentTargetAccountKind(matchedAccountForText(current)?.kind);
  }, [matchedAccountForText]);

  const isCreditCardRepaymentItem = useCallback((item: ParsedItem) => {
    if (item.type !== "transfer") return false;
    if (isCreditCardRepaymentBusinessType(item.businessType)) return true;
    const text = [item.rawText, item.category, item.remark, item.secondRemark].filter(Boolean).join(" ");
    if (/信用卡还款|信用卡.*还款|还款.*信用卡/.test(text)) return true;
    if (item.importMode === "credit_card") {
      const statementAccount = matchedAccountForText(item.statementAccount || item.toAccount || item.account || "");
      const sourceAccount = matchedAccountForText(item.fromAccount ?? "");
      const isCardInflow = (item.inflow ?? 0) > 0 && (item.outflow ?? 0) <= 0;
      if (
        isCardInflow &&
        isCreditCardRepaymentTargetAccountKind(statementAccount?.kind) &&
        isCreditCardRepaymentImportSourceAccountKind(sourceAccount?.kind) &&
        /还款|自动还款|银联转账|云闪付|repayment|payment|autopay/i.test(text)
      ) {
        return true;
      }
    }
    return /还款/.test(text) && (
      isCreditAccountText(item.account ?? "") ||
      isCreditAccountText(item.fromAccount ?? "") ||
      isCreditAccountText(item.toAccount ?? "")
    );
  }, [isCreditAccountText, matchedAccountForText]);

  const accountPickerRoleForCell = useCallback((item: ParsedItem, cell: "account" | "counterAccount"): AccountPickerRole => {
    if (item.importMode === "credit_card") {
      if (cell === "account") return "credit";
      return isCreditCardRepaymentItem(item) ? "repayment_source" : "any";
    }
    if (!isCreditCardRepaymentItem(item)) return "any";
    return cell === "counterAccount" ? "credit" : "repayment_source";
  }, [isCreditCardRepaymentItem]);

  const previewAccountValuesForItem = useCallback((item: ParsedItem) => {
    if (item.importMode === "credit_card") {
      const account = (item.statementAccount || item.account || item.toAccount || "").trim();
      const counterAccount = isCreditCardRepaymentItem(item)
        ? (item.fromAccount ?? "").trim()
        : "";
      return { account, counterAccount };
    }
    const direction = previewTransferDirectionFor(item);
    return {
      account: item.type === "transfer"
        ? (direction === "in" ? item.toAccount : item.fromAccount) || ""
        : item.account || "",
      counterAccount: item.type === "transfer"
        ? (direction === "in" ? item.fromAccount : item.toAccount) || ""
        : "",
    };
  }, [isCreditCardRepaymentItem]);

  const accountSelectValue = useCallback((currentValue: string, role: AccountPickerRole = "any") => {
    const current = currentValue.trim();
    if (!current) return "";
    const matchedId = findMatchedAccountId(current);
    const matched = matchedId ? accountById.get(matchedId) : undefined;
    if (matchedId && accountMatchesPickerRole(matched, role)) return matchedId;
    return role === "any" ? `unmatched:${current}` : "";
  }, [accountById, accountMatchesPickerRole, findMatchedAccountId]);

  const accountSmartSelectOptionsFor = useCallback((currentValue: string, role: AccountPickerRole = "any") => {
    const current = currentValue.trim();
    const matchedId = findMatchedAccountId(current);
    const matched = matchedId ? accountById.get(matchedId) : undefined;
    const roleOptions = role === "any" ? accountSmartSelectOptions : accountSmartSelectOptionsByRole(role);
    if (!current || (matchedId && accountMatchesPickerRole(matched, role))) return roleOptions;
    if (role !== "any") return roleOptions;
    return [{
      id: `unmatched:${current}`,
      label: formatText("batchImport.unmatchedAccount", { value: current }),
      subLabel: t("batchImport.originalImportedValue"),
    }, ...roleOptions];
  }, [accountById, accountMatchesPickerRole, accountSmartSelectOptions, accountSmartSelectOptionsByRole, findMatchedAccountId, formatText, t]);

  const accountSelectTextById = useCallback((selectedId: string) => {
    if (!selectedId) return "";
    if (selectedId.startsWith(IMPORT_ACCOUNT_ID_PREFIX)) return selectedId;
    if (selectedId.startsWith("unmatched:")) return selectedId.slice("unmatched:".length);
    const account = accountById.get(selectedId);
    return account ? encodeImportAccountId(account.id) : "";
  }, [accountById]);

  const accountDisplayText = useCallback((value: string, role: AccountPickerRole = "any") => {
    const current = value.trim();
    if (!current) return "";
    const matchedId = findMatchedAccountId(current);
    const account = matchedId ? accountById.get(matchedId) : undefined;
    if (account && accountMatchesPickerRole(account, role)) return accountDisplayLabel(account);
    return readableAccountText(current);
  }, [accountById, accountDisplayLabel, accountMatchesPickerRole, findMatchedAccountId, readableAccountText]);

  const accountHref = useCallback((accountId: string) => {
    const account = accountById.get(accountId);
    const view = account?.kind === "bank_credit" ? "bill" : "detail";
    return `/?accountId=${encodeURIComponent(accountId)}&view=${view}`;
  }, [accountById]);

  const accountCellTitle = useCallback((value: string, role: AccountPickerRole = "any") => {
    const current = value.trim();
    if (!current) return t("batchImport.doubleClickToEdit");
    const matchedId = findMatchedAccountId(current);
    const account = matchedId ? accountById.get(matchedId) : undefined;
    const display = account && accountMatchesPickerRole(account, role)
      ? accountHoverTitle(account)
      : readableAccountText(current);
    return `${display}\n${t("batchImport.doubleClickToEdit")}`;
  }, [accountById, accountHoverTitle, accountMatchesPickerRole, findMatchedAccountId, readableAccountText, t]);

  const accountIdentityConflictMessage = useCallback((selectedText: string, originalText?: string) => {
    const selected = getAccountMatch(selectedText).account;
    const conflict = getAccountIdentityConflict(selected, originalText);
    if (!conflict) return "";
    return formatText("batchImport.issue.accountIdentityConflict", {
      account: selected ? accountDisplayLabel(selected) : readableAccountText(selectedText),
      original: readableAccountText(conflict.originalText),
    });
  }, [accountDisplayLabel, formatText, getAccountIdentityConflict, getAccountMatch, readableAccountText]);

  const accountIssueMessage = useCallback((
    value: string,
    keys: { unmatched: string; ambiguous: string },
  ) => {
    const current = value.trim();
    const match = getAccountMatch(current);
    if (match.ambiguousAccounts.length > 0) {
      return formatText(keys.ambiguous, {
        account: readableAccountText(current),
        count: match.ambiguousAccounts.length,
      });
    }
    return formatText(keys.unmatched, { account: readableAccountText(current) });
  }, [formatText, getAccountMatch, readableAccountText]);

  const accountStorageText = useCallback((value?: string, originalValue?: string) => {
    const current = String(value ?? "").trim();
    if (!current) return "";
    if (current.startsWith(IMPORT_ACCOUNT_ID_PREFIX)) return current;

    const original = String(originalValue ?? "").trim();
    const currentMatch = getAccountMatch(current).account;
    if (currentMatch && !getAccountIdentityConflict(currentMatch, original)) {
      return encodeImportAccountId(currentMatch.id);
    }

    const originalMatch = original ? getAccountMatch(original).account : null;
    if (originalMatch) return encodeImportAccountId(originalMatch.id);
    return currentMatch ? encodeImportAccountId(currentMatch.id) : current;
  }, [getAccountIdentityConflict, getAccountMatch]);

  const normalizeAccountFieldsForImport = useCallback((item: ParsedItem): ParsedItem => ({
    ...item,
    account: accountStorageText(item.account, item.importSourceAccount || item.importSourceStatementAccount),
    fromAccount: accountStorageText(item.fromAccount, item.importSourceFromAccount),
    toAccount: accountStorageText(item.toAccount, item.importSourceToAccount),
    statementAccount: accountStorageText(item.statementAccount, item.importSourceStatementAccount || item.importSourceAccount),
  }), [accountStorageText]);

  const downloadTemplate = useCallback(async (template: ImportTemplate) => {
    if (template.downloadFormat === "xlsx") {
      const { XLSX, workbook } = await buildTemplateWorkbook(template, t);
      XLSX.writeFile(workbook, template.filename, { compression: true });
      return;
    }
    const csv = `\uFEFF${buildCsv(template)}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = template.filename;
    link.click();
    URL.revokeObjectURL(url);
  }, [t]);

  const requestFundPreview = useCallback(async (
    sourceItems: FundImportUploadItem[],
    ruleRows: FundRuleEditorRow[],
    preserveSelection: boolean,
    fileInfo?: string,
    context?: FundImportContext | null,
  ) => {
    const { overrides, invalidLabels } = serializeFundRuleOverrides(ruleRows, t);
    if (invalidLabels.length > 0) {
      setMessage(formatText("batchImport.fundPreview.invalidRules", {
        items: invalidLabels.slice(0, 3).join("、"),
        more: invalidLabels.length > 3 ? t("batchImport.importValidationMore") : "",
      }));
      return false;
    }

    setUploading(true);
    await waitForBrowserPaint();
    try {
      const requestContext = normalizeFundImportContext(context ?? fundImportContext);
      const res = await fetch("/api/v1/fund/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "preview",
          items: sourceItems,
          overrides,
          ...(requestContext ? { context: requestContext } : {}),
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; items?: FundImportPreviewItem[] } | null;
      if (!res.ok || !data?.ok || !Array.isArray(data.items)) {
        throw new Error(data?.error || res.statusText || `HTTP ${res.status}`);
      }
      setFundPreviewItems(data.items);
      setFundRuleRows(buildFundRuleEditorRows(data.items));
      setFundRulesDirty(false);
      if (preserveSelection) {
        setFundSelected((prev) => new Set(Array.from(prev).filter((idx) => idx < data.items!.length && !hasFundBlockingIssue(data.items![idx]))));
      } else {
        setFundSelected(selectableFundIndexes(data.items));
      }
      setUploadDebug(null);
      setMessage(null);
      return true;
    } catch (error) {
      setFundPreviewItems([]);
      setFundRuleRows([]);
      setFundSelected(new Set());
      const reason = error instanceof Error ? error.message : String(error);
      setUploadDebug(formatText("batchImport.readFailedDebug", { reason: reason || t("batchImport.unknownError"), fileInfo: fileInfo || "" }));
      setMessage(formatText("batchImport.readFailedMessage", { reason: reason || t("batchImport.unknownError") }));
      return false;
    } finally {
      setUploading(false);
    }
  }, [formatText, fundImportContext, t]);

  const handleNormalCsvFile = useCallback(async (file: File) => {
    const traceId = createImportTraceId();
    importTraceIdRef.current = traceId;
    const startedAt = performance.now();
    postImportDebugLog(traceId, "file_selected", {
      importKind: "bill",
      extension: file.name.split(".").pop()?.toLowerCase() ?? "",
      sizeBytes: file.size,
    });
    const traceLabel = formatText("batchImport.debugTraceId", { traceId });
    const fileInfo = formatText("batchImport.fileInfo", {
      name: file.name,
      type: file.type || t("batchImport.fileTypeUnknown"),
      sizeKb: Math.round(file.size / 1024),
    });
    flushSync(() => {
      setActiveImportKind("normal");
      setUploadDebug(`${formatText("batchImport.fileSelectedStart", { fileInfo })}\n${traceLabel}`);
      setMessage(formatText("batchImport.readingFileName", { name: file.name }));
      setImportedCount(0);
      setUploading(true);
      setItems([]);
      setFundUploadItems([]);
      setFundPreviewItems([]);
      setFundRuleRows([]);
      setFundRulesDirty(false);
      setFundImportContext(null);
      setDrafts({});
      setSelected(new Set());
      setFundSelected(new Set());
      setShowImportIssuesOnly(false);
    });
    await waitForBrowserPaint();
    let routedToFund = false;
    try {
      const latestCategoryRuleSamples = await refreshCategoryRuleSamples().catch(() => categoryRuleSamples);
      const parseResult = await parseImportFile(file, statementFieldHeaders);
      const rows = parseResult.rows;
      if (looksLikeFundImportFile(rows)) {
        // A fund transaction workbook (fund code/account/amount columns) must go
        // through the fund recognition channel, not the bill channel.
        routedToFund = true;
        await handleFundFileRef.current?.(file);
        return;
      }
      const importMode = detectBillImportMode(rows, isCreditAccountText, statementFieldHeaders);
      setActiveBillMode(importMode);
      const workbookDetail = parseResult.workbook
        ? formatText("batchImport.workbookReadDetail", {
            sheetCount: parseResult.workbook.sheetCount,
            includedSheetCount: parseResult.workbook.includedSheetCount,
          })
        : "";
      setUploadDebug([
        formatText("batchImport.rowsRead", { count: rows.length, fileInfo }),
        workbookDetail,
        traceLabel,
      ].filter(Boolean).join("\n"));
      const parsedRows = normalRowsToItems(rows, importMode, statementFieldHeaders);
      const parsed = alignStatementRecognitionToLedger(
        alignStatementIncomeRefunds(parsedRows.map(enrichKnownStatementMerchantForImport)),
        bookCategories,
        latestCategoryRuleSamples,
      );
      const skippedCount = Math.max(0, parseResult.sourceDataRowCount - parsed.length);
      const recognitionDetail = formatText("batchImport.recognitionDetail", {
        sourceCount: parseResult.sourceDataRowCount,
        recognizedCount: parsed.length,
        skippedCount,
      });
      postImportDebugLog(traceId, "parse_completed", {
        importKind: "bill",
        billMode: importMode,
        sheetCount: parseResult.workbook?.sheetCount ?? 1,
        includedSheetCount: parseResult.workbook?.includedSheetCount ?? 1,
        mergedRowCount: rows.length,
        sourceDataRowCount: parseResult.sourceDataRowCount,
        recognizedCount: parsed.length,
        skippedCount,
        categoryRuleCount: latestCategoryRuleSamples.length,
        durationMs: Math.round(performance.now() - startedAt),
      });
      if (parsed.length === 0) {
        const headers = rows[0]?.join("、") || t("batchImport.headersNotRead");
        setItems([]);
        setFundUploadItems([]);
        setFundPreviewItems([]);
        setFundRuleRows([]);
        setFundRulesDirty(false);
        setFundImportContext(null);
        setDrafts({});
        setSelected(new Set());
        setFundSelected(new Set());
        setShowImportIssuesOnly(false);
        setUploadDebug(`${formatText("batchImport.noRecordsRecognizedDebug", { headers, fileInfo })}\n${workbookDetail}\n${recognitionDetail}\n${traceLabel}`.trim());
        setMessage(formatText("batchImport.noRecordsRecognizedMessage", { name: file.name, headers }));
        return;
      }
      sessionStorage.setItem(BATCH_IMPORT_ITEMS_STORAGE_KEY, JSON.stringify(parsed));
      setItems(parsed);
      setFundUploadItems([]);
      setFundPreviewItems([]);
      setFundRuleRows([]);
      setFundRulesDirty(false);
      setFundImportContext(null);
      setDrafts({});
      setSelected(new Set());
      setFundSelected(new Set());
      setEditingCell(null);
      setShowImportIssuesOnly(false);
      setUploadDebug(null);
      setMessage(null);
    } catch (error) {
      setItems([]);
      setFundUploadItems([]);
      setFundPreviewItems([]);
      setFundRuleRows([]);
      setFundRulesDirty(false);
      setFundImportContext(null);
      setDrafts({});
      setSelected(new Set());
      setFundSelected(new Set());
      const reason = error instanceof Error ? error.message : String(error);
      postImportDebugLog(traceId, "parse_failed", {
        importKind: "bill",
        errorType: error instanceof Error ? error.name : "unknown",
        durationMs: Math.round(performance.now() - startedAt),
      });
      setUploadDebug(`${formatText("batchImport.readFailedDebug", { reason: reason || t("batchImport.unknownError"), fileInfo })}\n${traceLabel}`);
      setMessage(formatText("batchImport.readFailedMessage", { reason: reason || t("batchImport.unknownError") }));
    } finally {
      if (!routedToFund) setUploading(false);
    }
  }, [bookCategories, categoryRuleSamples, formatText, isCreditAccountText, refreshCategoryRuleSamples, statementFieldHeaders, t]);

  const handleFundFile = useCallback(async (file: File, context?: FundImportContext | null) => {
    const traceId = createImportTraceId();
    importTraceIdRef.current = traceId;
    const startedAt = performance.now();
    const requestContext = normalizeFundImportContext(context);
    postImportDebugLog(traceId, "file_selected", {
      importKind: "fund",
      extension: file.name.split(".").pop()?.toLowerCase() ?? "",
      sizeBytes: file.size,
      hasFundContext: Boolean(requestContext?.fundAccountId || requestContext?.fundAccount),
    });
    const fileInfo = formatText("batchImport.fileInfo", {
      name: file.name,
      type: file.type || t("batchImport.fileTypeUnknown"),
      sizeKb: Math.round(file.size / 1024),
    });
    flushSync(() => {
      setActiveImportKind("fund");
      setUploadDebug(formatText("batchImport.fileSelectedStart", { fileInfo }));
      setMessage(formatText("batchImport.readingFileName", { name: file.name }));
      setUploading(true);
      setImporting(false);
      setImportedCount(0);
      setItems([]);
      setFundUploadItems([]);
      setFundPreviewItems([]);
      setFundRuleRows([]);
      setFundRulesDirty(false);
      setFundImportContext(requestContext);
      setDrafts({});
      setSelected(new Set());
      setFundSelected(new Set());
      setEditingCell(null);
      setShowImportIssuesOnly(false);
    });

    await waitForBrowserPaint();
    let previewRequested = false;
    try {
      const parseResult = await parseImportFile(file);
      const rows = parseResult.rows;
      const parsed = fundRowsToItems(rows);
      postImportDebugLog(traceId, "parse_completed", {
        importKind: "fund",
        sheetCount: parseResult.workbook?.sheetCount ?? 1,
        includedSheetCount: parseResult.workbook?.includedSheetCount ?? 1,
        mergedRowCount: rows.length,
        sourceDataRowCount: parseResult.sourceDataRowCount,
        recognizedCount: parsed.length,
        durationMs: Math.round(performance.now() - startedAt),
      });
      if (parsed.length === 0) {
        setUploadDebug(formatText("batchImport.noRecordsRecognizedDebug", {
          headers: rows[0]?.join("、") || t("batchImport.headersNotRead"),
          fileInfo,
        }));
        setMessage(formatText("batchImport.noRecordsRecognizedMessage", {
          name: file.name,
          headers: rows[0]?.join("、") || t("batchImport.headersNotRead"),
        }));
        return;
      }

      setFundUploadItems(parsed);
      previewRequested = true;
      await requestFundPreview(parsed, [], false, fileInfo, requestContext);
    } catch (error) {
      setFundUploadItems([]);
      setFundPreviewItems([]);
      setFundRuleRows([]);
      setFundRulesDirty(false);
      setFundImportContext(requestContext);
      setFundSelected(new Set());
      const reason = error instanceof Error ? error.message : String(error);
      postImportDebugLog(traceId, "parse_failed", {
        importKind: "fund",
        errorType: error instanceof Error ? error.name : "unknown",
        durationMs: Math.round(performance.now() - startedAt),
      });
      setUploadDebug(formatText("batchImport.readFailedDebug", { reason: reason || t("batchImport.unknownError"), fileInfo }));
      setMessage(formatText("batchImport.readFailedMessage", { reason: reason || t("batchImport.unknownError") }));
    } finally {
      if (!previewRequested) setUploading(false);
    }
  }, [formatText, requestFundPreview, t]);
  handleFundFileRef.current = handleFundFile;

  const handleApplyFundRules = useCallback(async () => {
    if (fundUploadItems.length === 0 || importing) return;
    await requestFundPreview(fundUploadItems, fundRuleRows, true);
  }, [fundUploadItems, fundRuleRows, importing, requestFundPreview]);

  const openCellEdit = useCallback((idx: number, field: EditableCell) => {
    setEditingCell({ idx, field });
  }, []);

  const closeCellEdit = useCallback(() => {
    setEditingCell(null);
  }, []);

  const updateDraft = useCallback((idx: number, field: string, value: unknown) => {
    setDrafts((prev) => ({
      ...prev,
      [idx]: {
        ...prev[idx],
        [field]: value,
        ...(field === "category" ? { categoryUserEdited: true } : {}),
        ...(field === "institution" ? { institutionUserEdited: true } : {}),
      },
    }));
  }, []);

  const getItem = useCallback((idx: number): ParsedItem => {
    const item = items[idx];
    const draft = drafts[idx] ?? {};
    const type = draft.type ?? item.type ?? "expense";
    const businessType = draft.businessType !== undefined ? draft.businessType : item.businessType;
    const transferDirection = previewTransferDirectionFor({
      ...item,
      ...draft,
      businessType,
      transferDirection: draft.transferDirection ?? item.transferDirection,
      inflow: Number(draft.inflow ?? item.inflow ?? 0),
      outflow: Number(draft.outflow ?? item.outflow ?? 0),
    });
    const flow = normalizeFlowFields(
      type,
      Number(draft.amount ?? item.amount ?? 0),
      Number(draft.inflow ?? item.inflow ?? 0),
      Number(draft.outflow ?? item.outflow ?? 0),
      transferDirection,
    );
    return {
      ...item,
      ...draft,
      type,
      businessType: type === "transfer" ? businessType : null,
      date: draft.date ?? item.date ?? "",
      account: draft.account ?? item.account ?? "",
      fromAccount: draft.fromAccount ?? item.fromAccount ?? "",
      toAccount: draft.toAccount ?? item.toAccount ?? "",
      amount: flow.amount,
      outflow: flow.outflow,
      inflow: flow.inflow,
      category: draft.category ?? item.category ?? "",
      institution: draft.institution ?? item.institution ?? "",
      tags: draft.tags ?? item.tags ?? "",
      remark: draft.remark ?? item.remark ?? "",
      secondRemark: type === "transfer" ? (draft.secondRemark ?? item.secondRemark ?? item.remark ?? "") : "",
      counterparty: draft.counterparty ?? item.counterparty ?? "",
      transferDirection,
      importIgnoredCounterAccount: item.importIgnoredCounterAccount,
      importInvalidPostedAt: item.importInvalidPostedAt,
    };
  }, [items, drafts]);

  const updateCategoryForMatchingRemarks = useCallback((idx: number, category: string) => {
    const sourceItem = getItem(idx);
    const sourceKey = statementPreviewCategorySyncKey(sourceItem);
    const matchingIndexes = sourceKey
      ? items.map((_, itemIndex) => itemIndex).filter((itemIndex) => statementPreviewCategorySyncKey(getItem(itemIndex)) === sourceKey)
      : [idx];
    const indexesToUpdate = matchingIndexes.filter((itemIndex) => (
      itemIndex === idx || String(getItem(itemIndex).category ?? "").trim() !== category.trim()
    ));

    setDrafts((prev) => {
      const next = { ...prev };
      for (const itemIndex of indexesToUpdate) {
        next[itemIndex] = {
          ...(next[itemIndex] ?? {}),
          category,
          categoryUserEdited: true,
        };
      }
      return next;
    });

    const propagatedCount = indexesToUpdate.filter((itemIndex) => itemIndex !== idx).length;
    if (propagatedCount > 0) {
      setMessage(formatText("statementImportPreview.sameRemarkCategoryApplied", { count: propagatedCount }));
    }
  }, [formatText, getItem, items]);

  const creditStatementAccount = useMemo(() => {
    if (activeBillMode !== "credit_card") return "";
    for (let idx = 0; idx < items.length; idx += 1) {
      const item = getItem(idx);
      const account = (item.statementAccount || item.account || item.toAccount || "").trim();
      if (account) return account;
    }
    return "";
  }, [activeBillMode, getItem, items.length]);

  const importCompletionTargetForRows = useCallback((indexes: number[]) => {
    const accountIds = new Set<string>();
    for (const idx of indexes) {
      const item = getItem(idx);
      const primaryAccount = previewAccountValuesForItem(item).account;
      const accountId = findMatchedAccountId(primaryAccount);
      if (accountId) accountIds.add(accountId);
    }
    const ids = Array.from(accountIds);
    return {
      accountIds: ids,
      href: ids.length === 1 ? accountHref(ids[0]) : null,
    };
  }, [accountHref, findMatchedAccountId, getItem, previewAccountValuesForItem]);

  const updateCreditStatementAccount = useCallback((value: string) => {
    setDrafts((prev) => {
      const next = { ...prev };
      items.forEach((item, idx) => {
        const current = { ...item, ...(prev[idx] ?? {}) } as ParsedItem;
        if (current.importMode !== "credit_card") return;
        const repayment = isCreditCardRepaymentItem(current);
        next[idx] = {
          ...(prev[idx] ?? {}),
          account: value,
          statementAccount: value,
          ...(repayment ? { toAccount: value, transferDirection: "in" as const } : {}),
        };
      });
      return next;
    });
  }, [isCreditCardRepaymentItem, items]);

  const selectedPreviewIndexes = useMemo(
    () => Array.from(selected).filter((idx) => idx >= 0 && idx < items.length).sort((a, b) => a - b),
    [items.length, selected],
  );
  const batchTargetIndexes = selectedPreviewIndexes;
  const importTargetIndexes = selectedPreviewIndexes;
  const importTargetCount = importTargetIndexes.length;

  const collectImportIssuesForIndex = useCallback((idx: number) => {
    const issues: ImportIssue[] = [];
    const item = normalizeAccountFieldsForImport(normalizeForStorage(getItem(idx)));
    const direction = item.transferDirection ?? ((item.inflow ?? 0) > 0 && (item.outflow ?? 0) <= 0 ? "in" : "out");
    const account = item.type === "transfer"
      ? (direction === "in" ? item.toAccount : item.fromAccount) || ""
      : item.account || "";
    const counterAccount = item.type === "transfer"
      ? (direction === "in" ? item.fromAccount : item.toAccount) || ""
      : "";
    if (!account.trim()) issues.push({ idx, level: "error", message: t("batchImport.issue.accountMissing") });
    else {
      const match = getAccountMatch(account);
      if (!match.account) {
        issues.push({
          idx,
          level: "error",
          message: accountIssueMessage(account, {
            unmatched: "batchImport.issue.accountUnmatched",
            ambiguous: "batchImport.issue.accountAmbiguous",
          }),
        });
      }
    }
    if (!Number.isFinite(item.amount) || item.amount <= 0) issues.push({ idx, level: "error", message: t("batchImport.issue.amountInvalid") });
    if (item.importInvalidPostedAt) {
      issues.push({
        idx,
        level: "warning",
        message: formatText("batchImport.issue.postedAtInvalid", { value: item.importInvalidPostedAt }),
      });
    }
    if (item.importIgnoredCounterAccount) {
      issues.push({
        idx,
        level: "warning",
        message: formatText("batchImport.issue.counterAccountIgnoredNonTransfer", { account: item.importIgnoredCounterAccount }),
      });
    }
    if (item.type === "transfer") {
      const fromConflict = accountIdentityConflictMessage(item.fromAccount ?? "", item.importSourceFromAccount);
      const toConflict = accountIdentityConflictMessage(item.toAccount ?? "", item.importSourceToAccount);
      if (fromConflict) issues.push({ idx, level: "error", message: fromConflict });
      if (toConflict) issues.push({ idx, level: "error", message: toConflict });
    } else {
      const accountConflict = accountIdentityConflictMessage(
        item.account ?? "",
        item.importSourceAccount || item.importSourceStatementAccount,
      );
      if (accountConflict) issues.push({ idx, level: "error", message: accountConflict });
    }
    if (item.importMode === "credit_card") {
      const statementAccount = matchedAccountForText(
        item.statementAccount || item.toAccount || item.account || "",
      );
      if (!isCreditCardRepaymentTargetAccountKind(statementAccount?.kind)) {
        issues.push({ idx, level: "error", message: t("batchImport.issue.creditStatementAccount") });
      }
    }
    if (item.type === "transfer" && counterAccount.trim()) {
      const counterMatch = getAccountMatch(counterAccount);
      if (!counterMatch.account) {
        issues.push({
          idx,
          level: "error",
          message: accountIssueMessage(counterAccount, {
            unmatched: "batchImport.issue.counterAccountUnmatched",
            ambiguous: "batchImport.issue.counterAccountAmbiguous",
          }),
        });
      }
    } else if (item.type === "transfer" && !counterAccount.trim()) {
      issues.push({ idx, level: "error", message: t("batchImport.issue.counterAccountMissing") });
    }
    if (isCreditCardRepaymentItem(item)) {
      const fromAccount = matchedAccountForText(item.fromAccount ?? "");
      const toAccount = matchedAccountForText(item.toAccount ?? "");
      if (!isCreditCardRepaymentImportSourceAccountKind(fromAccount?.kind)) {
        issues.push({ idx, level: "error", message: t("batchImport.issue.creditCardRepaymentSource") });
      }
      if (!isCreditCardRepaymentTargetAccountKind(toAccount?.kind)) {
        issues.push({ idx, level: "error", message: t("batchImport.issue.creditCardRepaymentTarget") });
      }
    }
    return issues;
  }, [accountIdentityConflictMessage, accountIssueMessage, formatText, getAccountMatch, getItem, isCreditCardRepaymentItem, matchedAccountForText, normalizeAccountFieldsForImport, t]);

  useEffect(() => {
    if (items.length === 0) {
      setPreviewIssues([]);
      setPreviewValidationProgress(null);
      return;
    }
    let cancelled = false;
    const total = items.length;
    const chunkSize = total > 3000 ? 120 : 240;
    const nextIssues: ImportIssue[] = [];
    let checked = 0;
    setPreviewIssues([]);
    setPreviewValidationProgress({ checked: 0, total });

    const runChunk = () => {
      if (cancelled) return;
      const end = Math.min(total, checked + chunkSize);
      for (let idx = checked; idx < end; idx += 1) {
        nextIssues.push(...collectImportIssuesForIndex(idx));
      }
      checked = end;
      if (checked < total) {
        setPreviewValidationProgress({ checked, total });
        window.setTimeout(runChunk, 0);
        return;
      }
      setPreviewIssues(nextIssues);
      setPreviewValidationProgress(null);
    };

    window.setTimeout(runChunk, 0);
    return () => {
      cancelled = true;
    };
  }, [collectImportIssuesForIndex, items.length]);

  const importIssues = useMemo(
    () => previewIssues.filter((issue) => selected.has(issue.idx)),
    [previewIssues, selected],
  );

  const importErrorIssues = useMemo(() => importIssues.filter((issue) => issue.level === "error"), [importIssues]);
  const importIssuesByRow = useMemo(() => {
    const map = new Map<number, ImportIssue[]>();
    for (const issue of importIssues) map.set(issue.idx, [...(map.get(issue.idx) ?? []), issue]);
    return map;
  }, [importIssues]);
  const importErrorRowIndexes = useMemo(() => {
    const set = new Set<number>();
    for (const issue of importErrorIssues) set.add(issue.idx);
    return set;
  }, [importErrorIssues]);
  const previewErrorIssues = useMemo(() => previewIssues.filter((issue) => issue.level === "error"), [previewIssues]);
  const previewWarningIssues = useMemo(() => previewIssues.filter((issue) => issue.level === "warning"), [previewIssues]);
  const previewIssuesByRow = useMemo(() => {
    const map = new Map<number, ImportIssue[]>();
    for (const issue of previewIssues) map.set(issue.idx, [...(map.get(issue.idx) ?? []), issue]);
    return map;
  }, [previewIssues]);
  const previewErrorRowIndexes = useMemo(() => {
    const set = new Set<number>();
    for (const issue of previewErrorIssues) set.add(issue.idx);
    return set;
  }, [previewErrorIssues]);
  const previewWarningRowIndexes = useMemo(() => {
    const set = new Set<number>();
    for (const issue of previewWarningIssues) set.add(issue.idx);
    return set;
  }, [previewWarningIssues]);
  const previewIssueRowIndexes = useMemo(() => {
    const set = new Set<number>(previewErrorRowIndexes);
    for (const idx of previewWarningRowIndexes) set.add(idx);
    return set;
  }, [previewErrorRowIndexes, previewWarningRowIndexes]);
  const previewWarningRowCount = previewWarningRowIndexes.size;
  const previewErrorRows = useMemo(() => (
    Array.from(previewErrorRowIndexes)
      .sort((a, b) => a - b)
      .map((idx) => ({
        idx,
        messages: (previewIssuesByRow.get(idx) ?? [])
          .filter((issue) => issue.level === "error")
          .map((issue) => issue.message),
      }))
  ), [previewErrorRowIndexes, previewIssuesByRow]);
  const previewWarningRows = useMemo(() => (
    Array.from(previewWarningRowIndexes)
      .sort((a, b) => a - b)
      .map((idx) => ({
        idx,
        messages: (previewIssuesByRow.get(idx) ?? [])
          .filter((issue) => issue.level === "warning")
          .map((issue) => issue.message),
      }))
  ), [previewIssuesByRow, previewWarningRowIndexes]);
  const importErrorRows = useMemo(() => (
    Array.from(importErrorRowIndexes)
      .sort((a, b) => a - b)
      .map((idx) => ({
        idx,
        messages: (importIssuesByRow.get(idx) ?? [])
          .filter((issue) => issue.level === "error")
          .map((issue) => issue.message),
      }))
  ), [importErrorRowIndexes, importIssuesByRow]);
  const normalPreviewRows = useMemo<NormalPreviewTableRow[]>(() => {
    const source = items
      .map((_, idx) => idx)
      .filter((idx) => !showImportIssuesOnly || previewIssueRowIndexes.has(idx));
    return [...source].sort((a, b) => {
      const aError = previewErrorRowIndexes.has(a);
      const bError = previewErrorRowIndexes.has(b);
      if (aError !== bError) return aError ? -1 : 1;
      const aWarning = previewWarningRowIndexes.has(a);
      const bWarning = previewWarningRowIndexes.has(b);
      if (aWarning !== bWarning) return aWarning ? -1 : 1;
      return a - b;
    }).map((idx) => ({ idx }));
  }, [items, previewErrorRowIndexes, previewIssueRowIndexes, previewWarningRowIndexes, showImportIssuesOnly]);
  const selectedNormalPreviewKeys = useMemo(
    () => new Set(Array.from(selected).map((idx) => String(idx))),
    [selected],
  );
  const fundPreviewRows = useMemo<FundPreviewTableRow[]>(
    () => fundPreviewItems.map((item, idx) => ({ ...item, idx })),
    [fundPreviewItems],
  );
  const selectedFundPreviewKeys = useMemo(
    () => new Set(Array.from(fundSelected).map((idx) => String(idx))),
    [fundSelected],
  );
  const previewErrorPreviewText = useMemo(() => {
    const groups: Map<string, number[]> = new Map();
    for (const row of previewErrorRows) {
      const text = row.messages.join("；");
      if (!groups.has(text)) groups.set(text, []);
      groups.get(text)!.push(row.idx + 1);
    }
    const parts: string[] = [];
    for (const [text, rowNums] of groups) {
      const label = previewRowLabel(rowNums, text, t);
      if (parts.length < 6) parts.push(label);
    }
    return parts.join("；");
  }, [previewErrorRows, t]);
  const previewWarningGrouped = useMemo(() => {
    const groups: Map<string, number[]> = new Map();
    for (const row of previewWarningRows) {
      const text = row.messages.join("；");
      if (!groups.has(text)) groups.set(text, []);
      groups.get(text)!.push(row.idx + 1);
    }
    return Array.from(groups.entries()).map(([text, rowNums]) => ({ text, rowNums }));
  }, [previewWarningRows]);
  const previewWarningGroupCount = previewWarningGrouped.length;
  const previewWarningPreviewText = useMemo(() => {
    const parts: string[] = [];
    for (const { text, rowNums } of previewWarningGrouped) {
      const label = previewRowLabel(rowNums, text, t);
      if (parts.length < 6) parts.push(label);
    }
    return parts.join("；");
  }, [previewWarningGrouped, t]);
  const categoryById = useMemo(() => new Map(bookCategories.map((category) => [category.id, category])), [bookCategories]);
  const categorySelectValue = useCallback((categoryName: string, txType?: ParsedItem["type"]) => {
    const name = categoryName.trim();
    if (!name) return "";
    const preferredType = txType === "income" ? "income" : "expense";
    const matched = bookCategories.find((category) => category.name === name && category.type === preferredType)
      ?? bookCategories.find((category) => category.name === name);
    return matched?.id ?? "";
  }, [bookCategories]);
  const categoryNameById = useCallback((categoryId: string) => {
    if (!categoryId) return "";
    return categoryById.get(categoryId)?.name ?? "";
  }, [categoryById]);
  const categoryReplaceOptions = useMemo<BatchReplaceOption[]>(
    () => buildCategorySmartSelectOptions(bookCategories, "all", t).map((option) => ({
      value: option.id,
      label: option.label,
      isHeader: option.isHeader,
      isGroup: option.isGroup,
      parentId: option.parentId,
      title: option.title,
    })),
    [bookCategories, t],
  );
  const previewValidationRunning = previewValidationProgress !== null;
  const importProgressPercent = useMemo(() => {
    if (!importProgress?.total) return 0;
    return Math.max(0, Math.min(100, Math.round((importProgress.processed / importProgress.total) * 100)));
  }, [importProgress]);
  const importProgressPhaseLabel = useMemo(() => {
    if (!importProgress) return "";
    switch (importProgress.phase) {
      case "preparing":
        return t("batchImport.importPhase.preparing");
      case "writing":
        return t("batchImport.importPhase.writing");
      case "recalculating":
        return t("batchImport.importPhase.recalculating");
      case "done":
        return t("batchImport.importPhase.done");
      case "failed":
        return t("batchImport.importPhase.failed");
      default:
        return "";
    }
  }, [importProgress, t]);
  const importProgressText = useMemo(() => {
    if (!importProgress) return "";
    return formatText("batchImport.importProgress", {
      phase: importProgressPhaseLabel,
      processed: importProgress.processed,
      total: importProgress.total,
      percent: importProgressPercent,
    });
  }, [formatText, importProgress, importProgressPercent, importProgressPhaseLabel]);

  const fundImportIssues = useMemo(() => (
    Array.from(fundSelected)
      .flatMap((idx) => (fundPreviewItems[idx]?.issues ?? []).map((issue) => ({
        idx,
        ...issue,
        message: fundIssueMessage(issue, t),
      })))
  ), [fundSelected, fundPreviewItems, t]);
  const fundImportErrorIssues = useMemo(() => fundImportIssues.filter((issue) => issue.level === "error"), [fundImportIssues]);
  const fundImportWarningIssues = useMemo(() => fundImportIssues.filter((issue) => issue.level === "warning"), [fundImportIssues]);
  const fundPreviewWarningGroups = useMemo(() => {
    const grouped = new Map<string, { message: string; count: number; rows: number[] }>();
    fundPreviewItems.forEach((item, idx) => {
      item.issues
        .filter((issue) => issue.level === "warning")
        .forEach((issue) => {
          const message = fundIssueMessage(issue, t);
          const current = grouped.get(message);
          if (current) {
            current.count += 1;
            current.rows.push(idx + 1);
          } else {
            grouped.set(message, { message, count: 1, rows: [idx + 1] });
          }
        });
    });
    return Array.from(grouped.values()).sort((a, b) => b.count - a.count || a.rows[0] - b.rows[0]);
  }, [fundPreviewItems, t]);
  const fundPreviewWarningSummary = useMemo(() => {
    if (fundPreviewWarningGroups.length === 0) return "";
    const main = fundPreviewWarningGroups
      .slice(0, 2)
      .map((group) => formatText("batchImport.fundPreview.warningCompactItem", {
        message: group.message,
        count: group.count,
      }))
      .join("；");
    const moreCount = fundPreviewWarningGroups.length - 2;
    return moreCount > 0
      ? `${main}；${formatText("batchImport.fundPreview.warningCompactMore", { count: moreCount })}`
      : main;
  }, [fundPreviewWarningGroups, formatText]);

  const applyReplaceToTargets = useCallback((replaceField: ReplaceField, replaceValue: string) => {
    const targetIndexes = [...batchTargetIndexes];
    if (targetIndexes.length === 0) throw new Error(t("batchImport.batchReplaceNoTarget"));
    const value = replaceValue.trim();
    const accountValue = replaceField === "account" || replaceField === "counterAccount"
      ? accountSelectTextById(value)
      : value;
    if (!accountValue && replaceField !== "counterAccount" && replaceField !== "category") throw new Error(t("batchImport.batchReplaceEmptyValue"));

    const nextDrafts = { ...drafts };
    let changed = 0;
    let invalid = 0;

    for (const idx of targetIndexes) {
      const item = { ...getItem(idx), ...(nextDrafts[idx] ?? {}) };
      const patch: Partial<ParsedItem> = {};
      const type = item.type ?? "expense";
      const direction = previewTransferDirectionFor(item);
      if (replaceField === "date") patch.date = value;
      else if (replaceField === "type") {
        const nextPreviewType = value as PreviewType;
        const nextType = nextPreviewType === CREDIT_CARD_REPAYMENT_BUSINESS_TYPE
          ? "transfer"
          : nextPreviewType;
        patch.type = nextType;
        patch.businessType = nextPreviewType === CREDIT_CARD_REPAYMENT_BUSINESS_TYPE
          ? CREDIT_CARD_REPAYMENT_BUSINESS_TYPE
          : null;
        Object.assign(
          patch,
          accountPatchForPreviewTypeChange(
            item,
            nextType,
            nextPreviewType === CREDIT_CARD_REPAYMENT_BUSINESS_TYPE ? CREDIT_CARD_REPAYMENT_BUSINESS_TYPE : null,
          ),
        );
        const flow = normalizeFlowFields(nextType, item.amount ?? 0, item.inflow ?? 0, item.outflow ?? 0, patch.transferDirection ?? direction);
        patch.amount = flow.amount;
        patch.inflow = flow.inflow;
        patch.outflow = flow.outflow;
      } else if (replaceField === "outflow" || replaceField === "inflow") {
        const currentNumber = replaceField === "outflow" ? item.outflow ?? 0 : item.inflow ?? 0;
        const nextNumber = applyNumberExpression(currentNumber, value);
        if (!Number.isFinite(nextNumber)) {
          invalid++;
          continue;
        }
        patch[replaceField] = nextNumber;
        if (type === "transfer" && nextNumber > 0) patch.transferDirection = replaceField === "inflow" ? "in" : "out";
        else if (replaceField === "inflow" && nextNumber > 0) {
          patch.type = "income";
          patch.businessType = null;
        } else if (replaceField === "outflow" && nextNumber > 0) {
          patch.type = "expense";
          patch.businessType = null;
        }
        const flow = normalizeFlowFields(
          patch.type ?? type,
          nextNumber || 0,
          replaceField === "inflow" ? nextNumber : item.inflow ?? 0,
          replaceField === "outflow" ? nextNumber : item.outflow ?? 0,
          patch.transferDirection ?? direction,
        );
        patch.amount = flow.amount;
        patch.inflow = flow.inflow;
        patch.outflow = flow.outflow;
      } else if (replaceField === "account") {
        patch.account = accountValue;
        if (item.importMode === "credit_card") {
          patch.statementAccount = accountValue;
          if (isCreditCardRepaymentItem(item)) {
            patch.toAccount = accountValue;
            patch.transferDirection = "in";
          }
        } else if (type === "transfer") {
          if (direction === "in") patch.toAccount = accountValue;
          else patch.fromAccount = accountValue;
        }
      } else if (replaceField === "counterAccount") {
        if (item.importMode === "credit_card" && isCreditCardRepaymentItem(item)) {
          patch.fromAccount = accountValue;
          patch.toAccount = item.statementAccount || item.account || item.toAccount || "";
          patch.transferDirection = "in";
        } else if (type === "transfer") {
          patch.transferDirection = direction;
          if (direction === "in") patch.fromAccount = accountValue;
          else patch.toAccount = accountValue;
        } else {
          invalid++;
          continue;
        }
      } else if (replaceField === "category") {
        patch.category = categoryNameById(value);
        patch.categoryUserEdited = true;
      } else if (replaceField === "institution") {
        patch.institution = value;
        patch.institutionUserEdited = true;
      }
      else if (replaceField === "remark") patch.remark = value;
      nextDrafts[idx] = { ...(nextDrafts[idx] ?? {}), ...patch };
      changed++;
    }

    setDrafts(nextDrafts);
    const invalidSuffix = invalid > 0 ? formatText("batchImport.batchReplaceInvalidCount", { count: invalid }) : "";
    const resultMessage = formatText("batchImport.batchReplaceResult", {
      count: changed,
      field: replaceFieldLabels[replaceField],
      invalidSuffix,
    });
    setMessage(resultMessage);
    setEditingCell(null);
    postImportDebugLog(importTraceIdRef.current, "batch_replace", {
      importKind: "bill",
      billMode: activeBillMode,
      field: replaceField,
      targetCount: targetIndexes.length,
      changedCount: changed,
      invalidCount: invalid,
    });
    return resultMessage;
  }, [accountSelectTextById, activeBillMode, batchTargetIndexes, categoryNameById, drafts, formatText, getItem, isCreditCardRepaymentItem, replaceFieldLabels, t]);

  const handleImport = useCallback(async () => {
    if (importing) return;
    if (previewValidationRunning) {
      setMessage(formatText("batchImport.previewChecking", {
        checked: previewValidationProgress?.checked ?? 0,
        total: previewValidationProgress?.total ?? items.length,
      }));
      return;
    }
    const selectedIndexes = importTargetIndexes;
    const selectedItems = selectedIndexes.map((idx) => normalizeAccountFieldsForImport(normalizeForStorage(getItem(idx))));
    const completionTarget = importCompletionTargetForRows(selectedIndexes);
    const missingCounterAccountCount = selectedItems.filter((item) => item.type === "transfer" && (!item.fromAccount?.trim() || !item.toAccount?.trim())).length;
    if (importErrorIssues.length > 0) {
      postImportDebugLog(importTraceIdRef.current, "validation_blocked", {
        importKind: "bill",
        billMode: activeBillMode,
        selectedCount: selectedItems.length,
        errorRowCount: importErrorRows.length,
        errorIssueCount: importErrorIssues.length,
        warningIssueCount: importIssues.length - importErrorIssues.length,
      });
      const preview = importErrorRows
        .slice(0, 5)
        .map((row) => formatText("batchImport.issueLine", { index: row.idx + 1, level: t("batchImport.levelError"), message: row.messages.join("；") }))
        .join("；");
      setMessage(formatText("batchImport.importValidationFailed", {
        count: importErrorRows.length,
        preview,
        more: importErrorRows.length > 5 ? t("batchImport.importValidationMore") : "",
      }));
      setUploadDebug(
        importIssues
          .map((issue) => formatText("batchImport.issueLine", { index: issue.idx + 1, level: issue.level === "error" ? t("batchImport.levelError") : t("batchImport.levelWarning"), message: issue.message }))
          .join("\n"),
      );
      return;
    }
    setImporting(true);
    setImportedCount(0);
    setImportCompletion(null);
    setMessage(formatText("batchImport.importingSelected", { count: selectedItems.length }));
    setUploadDebug(null);
    setImportProgress({
      total: selectedItems.length,
      processed: 0,
      created: 0,
      phase: "preparing",
      currentRow: null,
      done: false,
      ok: null,
      error: null,
      failedRow: null,
    });
    const importStartedAt = performance.now();
    const traceId = importTraceIdRef.current;
    const progressController = new AbortController();
    const pollImportProgress = async () => {
      const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
      while (!progressController.signal.aborted) {
        try {
          const progressRes = await fetch(`/api/v1/record/ingest/progress?traceId=${encodeURIComponent(traceId)}`, {
            cache: "no-store",
            signal: progressController.signal,
          });
          const progressData = await progressRes.json().catch(() => null) as { ok?: boolean; progress?: ServerImportProgress | null } | null;
          if (progressData?.ok && progressData.progress) {
            setImportProgress(progressData.progress);
            if (progressData.progress.done) break;
          }
        } catch {
          if (progressController.signal.aborted) break;
        }
        await sleep(1000);
      }
    };
    void pollImportProgress();
    postImportDebugLog(importTraceIdRef.current, "import_started", {
      importKind: "bill",
      billMode: activeBillMode,
      selectedCount: selectedItems.length,
      missingCounterAccountCount,
    });

    try {
      const res = await fetch("/api/v1/record/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Import": "batch-import" },
        body: JSON.stringify({ items: selectedItems, traceId }),
      });
      const data = await res.json().catch(() => null) as { error?: string; createdCount?: number; importBatchId?: string | null; trace?: string[]; failedRow?: { rowIndex?: number; error?: string } } | null;
      if (!res.ok || !data || data.error) {
        postImportDebugLog(importTraceIdRef.current, "import_failed", {
          importKind: "bill",
          billMode: activeBillMode,
          selectedCount: selectedItems.length,
          httpStatus: res.status,
          hasServerError: Boolean(data?.error),
          failedRow: typeof data?.failedRow?.rowIndex === "number" ? data.failedRow.rowIndex + 1 : null,
          serverError: data?.error ? data.error.slice(0, 160) : null,
          durationMs: Math.round(performance.now() - importStartedAt),
        });
        setImportedCount(0);
        setImporting(false);
        setImportProgress((current) => current
          ? { ...current, phase: "failed", done: true, ok: false, error: data?.error || res.statusText || `HTTP ${res.status}` }
          : null);
        setMessage(formatText("batchImport.importFailedRollback", { reason: data?.error || res.statusText || `HTTP ${res.status}` }));
        setUploadDebug(data?.trace?.join("\n") ?? data?.error ?? null);
        return;
      }
      const success = data.createdCount ?? selectedItems.length;
      postImportDebugLog(importTraceIdRef.current, "import_succeeded", {
        importKind: "bill",
        billMode: activeBillMode,
        selectedCount: selectedItems.length,
        createdCount: success,
        durationMs: Math.round(performance.now() - importStartedAt),
      });
      setImportedCount(success);
      setImporting(false);
      setImportProgress((current) => current
        ? { ...current, phase: "done", done: true, ok: true, processed: selectedItems.length, created: success, error: null }
        : null);
      setMessage(formatText("batchImport.importSuccess", {
        count: success,
        missingCounterAccountNote: "",
        redirectNote: "",
      }));
      setImportCompletion({
        count: success,
        href: completionTarget.href,
        accountIds: completionTarget.accountIds,
        kind: "normal",
        importBatchId: data.importBatchId ?? null,
      });
      sessionStorage.removeItem(BATCH_IMPORT_ITEMS_STORAGE_KEY);
    } catch (error) {
      postImportDebugLog(importTraceIdRef.current, "import_failed", {
        importKind: "bill",
        billMode: activeBillMode,
        selectedCount: selectedItems.length,
        errorType: error instanceof Error ? error.name : "unknown",
        durationMs: Math.round(performance.now() - importStartedAt),
      });
      setImportedCount(0);
      setImporting(false);
      setImportProgress((current) => current
        ? { ...current, phase: "failed", done: true, ok: false, error: error instanceof Error ? error.message : String(error) }
        : null);
      setMessage(formatText("batchImport.importFailedRollback", { reason: error instanceof Error ? error.message : String(error) }));
      return;
    } finally {
      progressController.abort();
    }
  }, [activeBillMode, formatText, getItem, importCompletionTargetForRows, importErrorIssues, importErrorRows, importIssues, importTargetIndexes, importing, items.length, normalizeAccountFieldsForImport, previewValidationProgress, previewValidationRunning, t]);

  const handleFundImport = useCallback(async () => {
    if (importing) return;
    const selectedIndexes = Array.from(fundSelected).sort((a, b) => a - b);
    const selectedItems = selectedIndexes.map((idx) => fundPreviewItems[idx]).filter(Boolean);
    if (selectedItems.length === 0) return;

    if (fundImportErrorIssues.length > 0) {
      const preview = fundImportErrorIssues
        .slice(0, 5)
        .map((issue) => formatText("batchImport.issueLine", {
          index: issue.idx + 1,
          level: t("batchImport.levelError"),
          message: issue.message,
        }))
        .join("；");
      setMessage(formatText("batchImport.importValidationFailed", {
        count: fundImportErrorIssues.length,
        preview,
        more: fundImportErrorIssues.length > 5 ? t("batchImport.importValidationMore") : "",
      }));
      setUploadDebug(
        fundImportIssues
          .map((issue) => formatText("batchImport.issueLine", {
            index: issue.idx + 1,
            level: issue.level === "error" ? t("batchImport.levelError") : t("batchImport.levelWarning"),
            message: issue.message,
          }))
          .join("\n"),
      );
      return;
    }

    setImporting(true);
    setImportedCount(0);
    setImportCompletion(null);
    setMessage(formatText("batchImport.fundImportingSelected", { count: selectedItems.length }));
    setUploadDebug(null);

    try {
      const { overrides, invalidLabels } = serializeFundRuleOverrides(fundRuleRows, t);
      if (invalidLabels.length > 0) {
        throw new Error(formatText("batchImport.fundPreview.invalidRules", {
          items: invalidLabels.slice(0, 3).join("、"),
          more: invalidLabels.length > 3 ? t("batchImport.importValidationMore") : "",
        }));
      }
      const requestContext = normalizeFundImportContext(fundImportContext);
      const res = await fetch("/api/v1/fund/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "import",
          items: selectedItems,
          overrides,
          ...(requestContext ? { context: requestContext } : {}),
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; createdCount?: number } | null;
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || res.statusText || `HTTP ${res.status}`);
      }
      const success = data.createdCount ?? selectedItems.length;
      setImportedCount(success);
      setMessage(formatText("batchImport.fundImportSuccess", {
        count: success,
        redirectNote: "",
      }));
      setImportCompletion({
        count: success,
        href: "/investments",
        accountIds: selectedItems.map((item) => item.fundAccountId).filter((id): id is string => Boolean(id)),
        kind: "fund",
      });
    } catch (error) {
      setMessage(formatText("batchImport.importFailedRollback", { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setImporting(false);
    }
  }, [importing, fundSelected, fundPreviewItems, fundImportErrorIssues, fundImportIssues, fundRuleRows, fundImportContext, formatText, t]);

  const handleCancel = useCallback(() => {
    sessionStorage.removeItem(BATCH_IMPORT_ITEMS_STORAGE_KEY);
    setActiveImportKind(null);
    setImporting(false);
    setUploading(false);
    setImportedCount(0);
    setItems([]);
    setFundUploadItems([]);
    setFundPreviewItems([]);
    setFundRuleRows([]);
    setFundRulesDirty(false);
    setFundImportContext(null);
    setSelected(new Set());
    setFundSelected(new Set());
    setDrafts({});
    setEditingCell(null);
    setShowImportIssuesOnly(false);
    setMessage(null);
    setUploadDebug(null);
    setImportProgress(null);
    setImportCompletion(null);
  }, []);

  const handleImportCompletionConfirm = useCallback(() => {
    const completion = importCompletion;
    if (!completion) return;
    dispatchFinanceDataChanged({
      reason: completion.kind === "fund" ? "fund-batch-import" : "batch-import",
      accountIds: completion.accountIds.length > 0 ? completion.accountIds : undefined,
    });
    const href = completion.href;
    handleCancel();
    if (href) {
      router.push(href);
    }
  }, [handleCancel, importCompletion, router]);

  const accountReplaceOptions = useMemo<BatchReplaceOption[]>(() => [
    { value: "", label: t("batchImport.unselected") },
    ...activeAccountOptions.map((account) => {
      const label = accountDisplayLabel(account);
      return {
        value: account.id,
        label,
        title: accountHoverTitle(account),
      };
    }),
  ], [accountDisplayLabel, accountHoverTitle, activeAccountOptions, t]);

  const replaceFields = useMemo<BatchReplaceFieldConfig<ReplaceField>[]>(() => [
    { value: "date", label: replaceFieldLabels.date, kind: "date" },
    {
      value: "type",
      label: replaceFieldLabels.type,
      kind: "select",
      options: typeOptions,
    },
    { value: "outflow", label: replaceFieldLabels.outflow, kind: "number", placeholder: t("batchImport.numberExpressionPlaceholder") },
    { value: "inflow", label: replaceFieldLabels.inflow, kind: "number", placeholder: t("batchImport.numberExpressionPlaceholder") },
    {
      value: "account",
      label: replaceFieldLabels.account,
      kind: "smartSelect",
      options: accountReplaceOptions,
      smartSelectBehavior: { search: true, density: "micro", dropdownMaxHeight: 180, minDropdownWidth: 156, resizableDropdown: true },
    },
    {
      value: "counterAccount",
      label: replaceFieldLabels.counterAccount,
      kind: "smartSelect",
      options: accountReplaceOptions,
      allowEmpty: true,
      smartSelectBehavior: { search: true, density: "micro", dropdownMaxHeight: 180, minDropdownWidth: 156, resizableDropdown: true },
    },
    {
      value: "category",
      label: replaceFieldLabels.category,
      kind: "smartSelect",
      options: categoryReplaceOptions,
      allowEmpty: true,
      smartSelectBehavior: {
        hierarchy: true,
        search: true,
        initialCollapsedAll: true,
        accordionGroups: true,
        selectableGroups: true,
        groupSelectOnDoubleClick: false,
        minDropdownWidth: 252,
        fitContent: true,
        dropdownMaxHeight: 180,
        density: "micro",
        expandedGroupColumns: 4,
        resizableDropdown: true,
      },
    },
    { value: "institution", label: replaceFieldLabels.institution, kind: "text", placeholder: t("batchImport.institutionPlaceholder") },
    { value: "remark", label: replaceFieldLabels.remark, kind: "text", placeholder: t("batchImport.replaceContentPlaceholder") },
  ], [accountReplaceOptions, categoryReplaceOptions, replaceFieldLabels, t, typeOptions]);

  const normalPreviewColumns = useMemo<AdvancedDataTableColumn<NormalPreviewTableRow>[]>(() => [
    {
      key: "status",
      label: "",
      width: 42,
      minWidth: 36,
      align: "center",
      filterText: (row) => {
        const rowIssues = previewIssuesByRow.get(row.idx) ?? [];
        if (rowIssues.some((issue) => issue.level === "error")) return t("batchImport.levelError");
        if (rowIssues.some((issue) => issue.level === "warning")) return t("batchImport.levelWarning");
        return t("batchImport.levelNormal");
      },
      render: (row) => {
        const rowIssues = previewIssuesByRow.get(row.idx) ?? [];
        const rowHasError = rowIssues.some((issue) => issue.level === "error");
        const rowHasWarning = rowIssues.some((issue) => issue.level === "warning");
        if (rowIssues.length === 0) return <span className="text-[11px] text-slate-400">{row.idx + 1}</span>;
        return (
          <span
            className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold leading-none text-white ${rowHasError ? "bg-red-500" : rowHasWarning ? "bg-amber-500" : "bg-slate-300"}`}
            title={rowIssues.map((issue) => issue.message).join("；")}
          >
            !
          </span>
        );
      },
    },
    {
      key: "date",
      label: t("batchImport.field.date"),
      width: 116,
      minWidth: 96,
      filterKind: "dateRange",
      filterText: (row) => getItem(row.idx).date || "-",
      sortValue: (row) => getItem(row.idx).date || "",
      render: (row) => {
        const idx = row.idx;
        const item = items[idx];
        const draft = drafts[idx] ?? {};
        const date = draft.date ?? item.date ?? "";
        const inputDate = dateInputValue(date);
        const editingField = editingCell?.idx === idx ? editingCell.field : null;
        return (
          <div className="whitespace-nowrap tabular-nums text-slate-700" onDoubleClick={() => openCellEdit(idx, "date")} title={t("batchImport.doubleClickToEdit")}>
            {editingField === "date" ? (
              <DateStepper
                value={inputDate}
                autoFocus
                onBlur={closeCellEdit}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Escape") closeCellEdit(); }}
                onChange={(value) => updateDraft(idx, "date", mergeDateInputWithExistingTime(value, date))}
                className="h-6 w-28 rounded border border-blue-300 px-1.5 text-xs focus:outline-none"
              />
            ) : date}
          </div>
        );
      },
    },
    {
      key: "postedAt",
      label: t("detail.column.postedAt"),
      width: 116,
      minWidth: 96,
      hideable: true,
      defaultHidden: true,
      filterKind: "dateRange",
      filterText: (row) => getItem(row.idx).postedAt || "-",
      sortValue: (row) => getItem(row.idx).postedAt || "",
      render: (row) => {
        const postedAt = getItem(row.idx).postedAt || "";
        return <span className="whitespace-nowrap tabular-nums text-slate-700">{postedAt || "-"}</span>;
      },
    },
    {
      key: "type",
      label: t("batchImport.field.type"),
      width: 96,
      minWidth: 78,
      filterText: (row) => getTypeLabel(getItem(row.idx)),
      render: (row) => {
        const idx = row.idx;
        const currentRowItem = getItem(idx);
        const editingField = editingCell?.idx === idx ? editingCell.field : null;
        return (
          <div className="whitespace-nowrap text-slate-700" onDoubleClick={() => openCellEdit(idx, "type")} title={t("batchImport.doubleClickToEdit")}>
            {editingField === "type" ? (
              <select
                value={getPreviewType(currentRowItem)}
                autoFocus
                onBlur={closeCellEdit}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Escape") closeCellEdit(); }}
                onChange={(event) => {
                  const nextPreviewType = event.target.value as PreviewType;
                  const nextType = nextPreviewType === CREDIT_CARD_REPAYMENT_BUSINESS_TYPE ? "transfer" : nextPreviewType;
                  const nextBusinessType = nextPreviewType === CREDIT_CARD_REPAYMENT_BUSINESS_TYPE ? CREDIT_CARD_REPAYMENT_BUSINESS_TYPE : null;
                  const accountPatch = accountPatchForPreviewTypeChange(currentRowItem, nextType, nextBusinessType);
                  updateDraft(idx, "type", nextType);
                  updateDraft(idx, "businessType", nextBusinessType);
                  for (const [field, value] of Object.entries(accountPatch)) updateDraft(idx, field, value);
                }}
                className="h-6 w-20 rounded border border-blue-300 px-1.5 text-xs focus:outline-none"
              >
                <option value="expense">{t("transaction.type.expense")}</option>
                <option value="income">{t("transaction.type.income")}</option>
                <option value="transfer">{t("transaction.type.transfer")}</option>
                <option value={CREDIT_CARD_REPAYMENT_BUSINESS_TYPE}>{t("transaction.type.creditCardRepayment")}</option>
              </select>
            ) : getTypeLabel(currentRowItem)}
          </div>
        );
      },
    },
    {
      key: "outflow",
      label: t("batchImport.field.outflow"),
      width: 112,
      minWidth: 92,
      align: "right",
      filterKind: "numberRange",
      filterText: (row) => {
        const item = items[row.idx];
        const draft = drafts[row.idx] ?? {};
        const type = draft.type ?? item.type ?? "expense";
        const businessType = draft.businessType !== undefined ? draft.businessType : item.businessType;
        const direction = previewTransferDirectionFor({
          ...item,
          ...draft,
          businessType,
          transferDirection: draft.transferDirection ?? item.transferDirection,
          inflow: Number(draft.inflow ?? item.inflow ?? 0),
          outflow: Number(draft.outflow ?? item.outflow ?? 0),
        });
        const outflow = normalizeFlowFields(type, Number(draft.amount ?? item.amount ?? 0), Number(draft.inflow ?? item.inflow ?? 0), Number(draft.outflow ?? item.outflow ?? 0), direction).outflow;
        return outflow ? outflow.toFixed(2) : "-";
      },
      filterNumber: (row) => {
        const item = items[row.idx];
        const draft = drafts[row.idx] ?? {};
        const type = draft.type ?? item.type ?? "expense";
        const businessType = draft.businessType !== undefined ? draft.businessType : item.businessType;
        const direction = previewTransferDirectionFor({
          ...item,
          ...draft,
          businessType,
          transferDirection: draft.transferDirection ?? item.transferDirection,
          inflow: Number(draft.inflow ?? item.inflow ?? 0),
          outflow: Number(draft.outflow ?? item.outflow ?? 0),
        });
        return normalizeFlowFields(type, Number(draft.amount ?? item.amount ?? 0), Number(draft.inflow ?? item.inflow ?? 0), Number(draft.outflow ?? item.outflow ?? 0), direction).outflow;
      },
      sortValue: (row) => {
        const item = items[row.idx];
        const draft = drafts[row.idx] ?? {};
        const type = draft.type ?? item.type ?? "expense";
        const businessType = draft.businessType !== undefined ? draft.businessType : item.businessType;
        const direction = previewTransferDirectionFor({
          ...item,
          ...draft,
          businessType,
          transferDirection: draft.transferDirection ?? item.transferDirection,
          inflow: Number(draft.inflow ?? item.inflow ?? 0),
          outflow: Number(draft.outflow ?? item.outflow ?? 0),
        });
        return normalizeFlowFields(type, Number(draft.amount ?? item.amount ?? 0), Number(draft.inflow ?? item.inflow ?? 0), Number(draft.outflow ?? item.outflow ?? 0), direction).outflow;
      },
      render: (row) => {
        const idx = row.idx;
        const item = items[idx];
        const draft = drafts[idx] ?? {};
        const type = draft.type ?? item.type ?? "expense";
        const businessType = draft.businessType !== undefined ? draft.businessType : item.businessType;
        const direction = previewTransferDirectionFor({
          ...item,
          ...draft,
          businessType,
          transferDirection: draft.transferDirection ?? item.transferDirection,
          inflow: Number(draft.inflow ?? item.inflow ?? 0),
          outflow: Number(draft.outflow ?? item.outflow ?? 0),
        });
        const outflow = normalizeFlowFields(type, Number(draft.amount ?? item.amount ?? 0), Number(draft.inflow ?? item.inflow ?? 0), Number(draft.outflow ?? item.outflow ?? 0), direction).outflow;
        const editingField = editingCell?.idx === idx ? editingCell.field : null;
        return (
          <div className="whitespace-nowrap text-right tabular-nums text-slate-700" onDoubleClick={() => openCellEdit(idx, "outflow")} title={t("batchImport.doubleClickToEdit")}>
            {editingField === "outflow" ? (
              <input
                type="number"
                value={outflow || ""}
                autoFocus
                onBlur={closeCellEdit}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Escape") closeCellEdit(); }}
                onChange={(event) => {
                  const next = parseFloat(event.target.value) || 0;
                  updateDraft(idx, "outflow", next);
                  updateDraft(idx, "amount", next || 0);
                  if (type === "transfer" && next > 0) updateDraft(idx, "transferDirection", "out");
                  else if (next > 0) updateDraft(idx, "type", "expense");
                }}
                className="h-6 w-24 rounded border border-blue-300 px-1.5 text-right text-xs tabular-nums focus:outline-none"
                step="0.01"
              />
            ) : outflow ? outflow.toFixed(2) : "-"}
          </div>
        );
      },
    },
    {
      key: "inflow",
      label: t("batchImport.field.inflow"),
      width: 112,
      minWidth: 92,
      align: "right",
      filterKind: "numberRange",
      filterText: (row) => {
        const item = items[row.idx];
        const draft = drafts[row.idx] ?? {};
        const type = draft.type ?? item.type ?? "expense";
        const businessType = draft.businessType !== undefined ? draft.businessType : item.businessType;
        const direction = previewTransferDirectionFor({
          ...item,
          ...draft,
          businessType,
          transferDirection: draft.transferDirection ?? item.transferDirection,
          inflow: Number(draft.inflow ?? item.inflow ?? 0),
          outflow: Number(draft.outflow ?? item.outflow ?? 0),
        });
        const inflow = normalizeFlowFields(type, Number(draft.amount ?? item.amount ?? 0), Number(draft.inflow ?? item.inflow ?? 0), Number(draft.outflow ?? item.outflow ?? 0), direction).inflow;
        return inflow ? inflow.toFixed(2) : "-";
      },
      filterNumber: (row) => {
        const item = items[row.idx];
        const draft = drafts[row.idx] ?? {};
        const type = draft.type ?? item.type ?? "expense";
        const businessType = draft.businessType !== undefined ? draft.businessType : item.businessType;
        const direction = previewTransferDirectionFor({
          ...item,
          ...draft,
          businessType,
          transferDirection: draft.transferDirection ?? item.transferDirection,
          inflow: Number(draft.inflow ?? item.inflow ?? 0),
          outflow: Number(draft.outflow ?? item.outflow ?? 0),
        });
        return normalizeFlowFields(type, Number(draft.amount ?? item.amount ?? 0), Number(draft.inflow ?? item.inflow ?? 0), Number(draft.outflow ?? item.outflow ?? 0), direction).inflow;
      },
      sortValue: (row) => {
        const item = items[row.idx];
        const draft = drafts[row.idx] ?? {};
        const type = draft.type ?? item.type ?? "expense";
        const businessType = draft.businessType !== undefined ? draft.businessType : item.businessType;
        const direction = previewTransferDirectionFor({
          ...item,
          ...draft,
          businessType,
          transferDirection: draft.transferDirection ?? item.transferDirection,
          inflow: Number(draft.inflow ?? item.inflow ?? 0),
          outflow: Number(draft.outflow ?? item.outflow ?? 0),
        });
        return normalizeFlowFields(type, Number(draft.amount ?? item.amount ?? 0), Number(draft.inflow ?? item.inflow ?? 0), Number(draft.outflow ?? item.outflow ?? 0), direction).inflow;
      },
      render: (row) => {
        const idx = row.idx;
        const item = items[idx];
        const draft = drafts[idx] ?? {};
        const type = draft.type ?? item.type ?? "expense";
        const businessType = draft.businessType !== undefined ? draft.businessType : item.businessType;
        const direction = previewTransferDirectionFor({
          ...item,
          ...draft,
          businessType,
          transferDirection: draft.transferDirection ?? item.transferDirection,
          inflow: Number(draft.inflow ?? item.inflow ?? 0),
          outflow: Number(draft.outflow ?? item.outflow ?? 0),
        });
        const inflow = normalizeFlowFields(type, Number(draft.amount ?? item.amount ?? 0), Number(draft.inflow ?? item.inflow ?? 0), Number(draft.outflow ?? item.outflow ?? 0), direction).inflow;
        const editingField = editingCell?.idx === idx ? editingCell.field : null;
        return (
          <div className="whitespace-nowrap text-right tabular-nums text-slate-700" onDoubleClick={() => openCellEdit(idx, "inflow")} title={t("batchImport.doubleClickToEdit")}>
            {editingField === "inflow" ? (
              <input
                type="number"
                value={inflow || ""}
                autoFocus
                onBlur={closeCellEdit}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Escape") closeCellEdit(); }}
                onChange={(event) => {
                  const next = parseFloat(event.target.value) || 0;
                  updateDraft(idx, "inflow", next);
                  updateDraft(idx, "amount", next || 0);
                  if (type === "transfer" && next > 0) updateDraft(idx, "transferDirection", "in");
                  else if (next > 0) updateDraft(idx, "type", "income");
                }}
                className="h-6 w-24 rounded border border-blue-300 px-1.5 text-right text-xs tabular-nums focus:outline-none"
                step="0.01"
              />
            ) : inflow ? inflow.toFixed(2) : "-"}
          </div>
        );
      },
    },
    {
      key: "account",
      label: t("batchImport.field.account"),
      width: 220,
      minWidth: 150,
      filterText: (row) => {
        const item = getItem(row.idx);
        const { account } = previewAccountValuesForItem(item);
        return accountDisplayText(account, accountPickerRoleForCell(item, "account")) || t("batchImport.emptyValue");
      },
      render: (row) => {
        const idx = row.idx;
        const item = items[idx];
        const draft = drafts[idx] ?? {};
        const type = draft.type ?? item.type ?? "expense";
        const currentRowItem = getItem(idx);
        const direction = previewTransferDirectionFor(currentRowItem);
        const { account } = previewAccountValuesForItem(currentRowItem);
        const accountPickerRole = accountPickerRoleForCell(currentRowItem, "account");
        const editingField = editingCell?.idx === idx ? editingCell.field : null;
        return (
          <div className="whitespace-nowrap text-slate-700" onDoubleClick={() => openCellEdit(idx, "account")} title={accountCellTitle(account, accountPickerRole)}>
            {editingField === "account" ? (
              <div className="w-80">
                <SmartSelect
                  mode="single"
                  value={accountSelectValue(account, accountPickerRole)}
                  onChange={(selectedId) => {
                    const value = accountSelectTextById(selectedId);
                    if (currentRowItem.importMode === "credit_card") {
                      updateCreditStatementAccount(value);
                      closeCellEdit();
                      return;
                    }
                    updateDraft(idx, "account", value);
                    if (type === "transfer") {
                      if (direction === "in") updateDraft(idx, "toAccount", value);
                      else updateDraft(idx, "fromAccount", value);
                    }
                    closeCellEdit();
                  }}
                  options={accountSmartSelectOptionsFor(account, accountPickerRole)}
                  placeholder={t("batchImport.unselected")}
                  behavior={{ hierarchy: false, search: true, clearable: true, density: "micro", dropdownMaxHeight: 180, minDropdownWidth: 156, resizableDropdown: true, autoOpen: true }}
                />
              </div>
            ) : account ? accountDisplayText(account, accountPickerRole) : <span className="text-red-500">{t("batchImport.unrecognized")}</span>}
          </div>
        );
      },
    },
    {
      key: "counterAccount",
      label: t("batchImport.field.counterAccount"),
      width: 220,
      minWidth: 150,
      hideable: true,
      filterText: (row) => {
        const item = getItem(row.idx);
        const { counterAccount } = previewAccountValuesForItem(item);
        return accountDisplayText(counterAccount, accountPickerRoleForCell(item, "counterAccount")) || t("batchImport.emptyValue");
      },
      render: (row) => {
        const idx = row.idx;
        const currentRowItem = getItem(idx);
        const direction = previewTransferDirectionFor(currentRowItem);
        const { counterAccount } = previewAccountValuesForItem(currentRowItem);
        const counterAccountPickerRole = accountPickerRoleForCell(currentRowItem, "counterAccount");
        const editingField = editingCell?.idx === idx ? editingCell.field : null;
        return (
          <div className="whitespace-nowrap text-slate-700" onDoubleClick={() => openCellEdit(idx, "counterAccount")} title={accountCellTitle(counterAccount, counterAccountPickerRole)}>
            {editingField === "counterAccount" ? (
              <div className="w-80">
                <SmartSelect
                  mode="single"
                  value={accountSelectValue(counterAccount, counterAccountPickerRole)}
                  onChange={(selectedId) => {
                    const value = accountSelectTextById(selectedId);
                    if (currentRowItem.importMode === "credit_card" && isCreditCardRepaymentItem(currentRowItem)) updateDraft(idx, "fromAccount", value);
                    else if (direction === "in") updateDraft(idx, "fromAccount", value);
                    else updateDraft(idx, "toAccount", value);
                    if (value.trim()) updateDraft(idx, "type", "transfer");
                    closeCellEdit();
                  }}
                  options={accountSmartSelectOptionsFor(counterAccount, counterAccountPickerRole)}
                  placeholder={t("batchImport.unselected")}
                  behavior={{ hierarchy: false, search: true, clearable: true, density: "micro", dropdownMaxHeight: 180, minDropdownWidth: 156, resizableDropdown: true, autoOpen: true }}
                />
              </div>
            ) : counterAccount ? accountDisplayText(counterAccount, counterAccountPickerRole) : <span className="text-slate-400">-</span>}
          </div>
        );
      },
    },
    {
      key: "category",
      label: t("batchImport.field.category"),
      width: 150,
      minWidth: 110,
      filterText: (row) => systemCategoryLabel(getItem(row.idx).category, t) || t("batchImport.emptyValue"),
      render: (row) => {
        const idx = row.idx;
        const item = items[idx];
        const draft = drafts[idx] ?? {};
        const category = draft.category ?? item.category ?? "";
        const editingField = editingCell?.idx === idx ? editingCell.field : null;
        return (
          <div className="w-full min-w-0 truncate text-slate-700" title={systemCategoryLabel(category, t) || t("batchImport.doubleClickToEdit")} onDoubleClick={() => openCellEdit(idx, "category")}>
            {editingField === "category" ? (
              <div className="w-full min-w-0">
                <SmartSelect
                  mode="single"
                  value={categorySelectValue(category, item.type)}
                  onChange={(categoryId) => {
                    updateCategoryForMatchingRemarks(idx, categoryNameById(categoryId));
                    closeCellEdit();
                  }}
                  options={buildCategorySmartSelectOptions(bookCategories, item.type, t)}
                  placeholder={t("batchImport.categoryPlaceholder")}
                  searchable
                  behavior={{
                    hierarchy: true,
                    search: true,
                    initialCollapsedAll: true,
                    accordionGroups: true,
                    selectableGroups: true,
                    groupSelectOnDoubleClick: false,
                    minDropdownWidth: 252,
                    fitContent: true,
                    dropdownMaxHeight: 180,
                    density: "micro",
                    expandedGroupColumns: 4,
                    resizableDropdown: true,
                    autoOpen: true,
                  }}
                />
              </div>
            ) : systemCategoryLabel(category, t) || <span className="text-slate-400">-</span>}
          </div>
        );
      },
    },
    {
      key: "institution",
      label: t("batchImport.field.institution"),
      width: 150,
      minWidth: 110,
      hideable: true,
      filterText: (row) => getItem(row.idx).institution || t("batchImport.emptyValue"),
      render: (row) => {
        const idx = row.idx;
        const item = items[idx];
        const draft = drafts[idx] ?? {};
        const institution = draft.institution ?? item.institution ?? "";
        const editingField = editingCell?.idx === idx ? editingCell.field : null;
        return (
          <div className="truncate text-slate-700" title={institution || t("batchImport.doubleClickToEdit")} onDoubleClick={() => openCellEdit(idx, "institution")}>
            {editingField === "institution" ? (
              <input
                type="text"
                value={institution}
                autoFocus
                onBlur={closeCellEdit}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Escape") closeCellEdit(); }}
                onChange={(event) => updateDraft(idx, "institution", event.target.value)}
                placeholder={t("batchImport.institutionPlaceholder")}
                className="h-6 w-36 rounded border border-blue-300 px-1.5 text-xs focus:outline-none"
              />
            ) : institution || <span className="text-slate-400">-</span>}
          </div>
        );
      },
    },
    {
      key: "tags",
      label: t("batchImport.field.tags"),
      width: 170,
      minWidth: 120,
      hideable: true,
      defaultHidden: true,
      filterText: (row) => getItem(row.idx).tags || t("batchImport.emptyValue"),
      render: (row) => {
        const idx = row.idx;
        const item = items[idx];
        const draft = drafts[idx] ?? {};
        const tags = draft.tags ?? item.tags ?? "";
        const editingField = editingCell?.idx === idx ? editingCell.field : null;
        return (
          <div className="truncate text-slate-700" title={tags || t("batchImport.doubleClickToEdit")} onDoubleClick={() => openCellEdit(idx, "tags")}>
            {editingField === "tags" ? (
              <input
                type="text"
                value={tags}
                autoFocus
                onBlur={closeCellEdit}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Escape") closeCellEdit(); }}
                onChange={(event) => updateDraft(idx, "tags", event.target.value)}
                placeholder={t("batchImport.tagsPlaceholder")}
                className="h-6 w-44 rounded border border-blue-300 px-1.5 text-xs focus:outline-none"
              />
            ) : tags || <span className="text-slate-400">-</span>}
          </div>
        );
      },
    },
    {
      key: "remark",
      label: t("batchImport.field.remark"),
      width: 260,
      minWidth: 160,
      filterText: (row) => {
        const item = getItem(row.idx);
        return (item.remark || item.counterparty || "").trim() || t("batchImport.emptyValue");
      },
      render: (row) => {
        const idx = row.idx;
        const item = items[idx];
        const draft = drafts[idx] ?? {};
        const remark = draft.remark ?? item.remark ?? item.counterparty ?? "";
        const editingField = editingCell?.idx === idx ? editingCell.field : null;
        return (
          <div className="truncate text-slate-700" title={remark || t("batchImport.doubleClickToEdit")} onDoubleClick={() => openCellEdit(idx, "remark")}>
            {editingField === "remark" ? (
              <input
                type="text"
                value={remark}
                autoFocus
                onBlur={closeCellEdit}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === "Escape") closeCellEdit(); }}
                onChange={(event) => updateDraft(idx, "remark", event.target.value)}
                placeholder={t("batchImport.remarkPlaceholder")}
                className="h-6 w-48 rounded border border-blue-300 px-1.5 text-xs focus:outline-none"
              />
            ) : remark || <span className="text-slate-400">-</span>}
          </div>
        );
      },
    },
  ], [
    accountCellTitle,
    accountDisplayText,
    accountPickerRoleForCell,
    accountPatchForPreviewTypeChange,
    accountSelectTextById,
    accountSelectValue,
    accountSmartSelectOptionsFor,
    bookCategories,
    categoryNameById,
    categorySelectValue,
    closeCellEdit,
    drafts,
    editingCell,
    getItem,
    getPreviewType,
    getTypeLabel,
    isCreditCardRepaymentItem,
    items,
    openCellEdit,
    previewAccountValuesForItem,
    previewIssuesByRow,
    t,
    updateCreditStatementAccount,
    updateCategoryForMatchingRemarks,
    updateDraft,
  ]);

  const fundPreviewColumns = useMemo<AdvancedDataTableColumn<FundPreviewTableRow>[]>(() => [
    {
      key: "status",
      label: "",
      width: 42,
      minWidth: 36,
      align: "center",
      filterText: (row) => row.issues.some((issue) => issue.level === "error") ? t("batchImport.levelError") : row.issues.some((issue) => issue.level === "warning") ? t("batchImport.levelWarning") : t("batchImport.levelNormal"),
      render: (row) => {
        const rowHasError = row.issues.some((issue) => issue.level === "error");
        const rowHasWarning = row.issues.some((issue) => issue.level === "warning");
        if (row.issues.length === 0) return <span className="text-[11px] text-slate-400">{row.idx + 1}</span>;
        return (
          <span
            className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold leading-none text-white ${rowHasError ? "bg-red-500" : rowHasWarning ? "bg-amber-500" : "bg-slate-300"}`}
            title={row.issues.map((issue) => fundIssueMessage(issue, t)).join("；")}
          >
            !
          </span>
        );
      },
    },
    { key: "date", label: t("batchImport.template.fund.label.date"), width: 112, minWidth: 92, filterKind: "dateRange", filterText: (row) => row.date || "-", sortValue: (row) => row.date || "", render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{row.date || "-"}</span> },
    { key: "fundSubtype", label: t("batchImport.template.fund.label.fundSubtype"), width: 116, minWidth: 92, filterText: (row) => getFundImportSubtypeLabel(row.fundSubtype, row.source, t), render: (row) => <span className="whitespace-nowrap text-slate-700">{getFundImportSubtypeLabel(row.fundSubtype, row.source, t)}</span> },
    { key: "cashAccount", label: t("batchImport.template.fund.label.cashAccount"), width: 180, minWidth: 130, filterText: (row) => row.cashAccount || "-", render: (row) => <span className="truncate text-slate-700" title={row.cashAccount || ""}>{row.cashAccount || "-"}</span> },
    { key: "fundAccount", label: t("batchImport.template.fund.label.fundAccount"), width: 180, minWidth: 130, filterText: (row) => row.fundAccount || "-", render: (row) => <span className="truncate text-slate-700" title={row.fundAccount || ""}>{row.fundAccount || "-"}</span> },
    { key: "fundCode", label: t("batchImport.template.fund.label.fundCode"), width: 96, minWidth: 76, filterText: (row) => row.fundCode || "-", render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{row.fundCode || "-"}</span> },
    { key: "fundName", label: t("batchImport.template.fund.label.fundName"), width: 220, minWidth: 150, filterText: (row) => row.fundName || "-", render: (row) => <span className="truncate text-slate-700" title={row.fundName || ""}>{row.fundName || "-"}</span> },
    { key: "amount", label: t("batchImport.template.fund.label.amount"), width: 116, minWidth: 90, align: "right", sortValue: (row) => row.amount, render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{formatOptionalNumber(row.amount, 2)}</span> },
    { key: "feeRate", label: t("batchImport.template.fund.label.feeRate"), width: 96, minWidth: 78, align: "right", sortValue: (row) => row.feeRate ?? 0, render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{row.feeRate != null ? `${row.feeRate.toFixed(4)}%` : "-"}</span> },
    { key: "fee", label: t("batchImport.template.fund.label.fee"), width: 96, minWidth: 76, align: "right", sortValue: (row) => row.fee ?? 0, render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{formatOptionalNumber(row.fee, 2)}</span> },
    { key: "nav", label: t("batchImport.template.fund.label.nav"), width: 96, minWidth: 78, align: "right", sortValue: (row) => row.nav ?? 0, render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{formatOptionalNumber(row.nav, 4)}</span> },
    { key: "units", label: t("batchImport.template.fund.label.units"), width: 116, minWidth: 90, align: "right", sortValue: (row) => row.units ?? 0, render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{formatOptionalNumber(row.units, 2)}</span> },
    { key: "confirmDate", label: t("batchImport.template.fund.label.confirmDate"), width: 112, minWidth: 92, filterKind: "dateRange", filterText: (row) => row.confirmDate || "-", sortValue: (row) => row.confirmDate || "", render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{row.confirmDate || "-"}</span> },
    { key: "arrivalDate", label: t("batchImport.template.fund.label.arrivalDate"), width: 112, minWidth: 92, filterKind: "dateRange", filterText: (row) => row.arrivalDate || "-", sortValue: (row) => row.arrivalDate || "", render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{row.arrivalDate || "-"}</span> },
    { key: "remark", label: t("batchImport.template.fund.label.remark"), width: 220, minWidth: 150, filterText: (row) => row.remark || "-", render: (row) => <span className="truncate text-slate-700" title={row.remark || ""}>{row.remark || "-"}</span> },
  ], [t]);

  const hasVisibleImportWork = activeImportKind !== null ||
    items.length > 0 ||
    fundPreviewItems.length > 0 ||
    uploading ||
    Boolean(message) ||
    Boolean(uploadDebug) ||
    Boolean(importCompletion);
  const showUploadProcessingOverlay = uploading && (
    (activeImportKind === "normal" && items.length === 0) ||
    (activeImportKind === "fund" && fundPreviewItems.length === 0)
  );

  useEffect(() => {
    if (!pendingFileChecked || hasVisibleImportWork) return;
    router.replace("/accounts");
  }, [hasVisibleImportWork, pendingFileChecked, router]);

  if (!hasVisibleImportWork) {
    return <div className="min-h-screen bg-slate-50" />;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="sticky top-0 z-10 bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between shadow-sm">
        <div className="flex items-center gap-4">
          <h1 className="text-lg font-semibold text-slate-800">{t("batchImport.pageTitle")}</h1>
          {items.length > 0 && (
            <span className="text-sm text-slate-500">
              {formatText("batchImport.selectedSummary", { selected: importTargetCount, total: items.length })}
              {previewErrorRows.length > 0 && <span className="ml-2 font-medium text-red-600">{formatText("batchImport.errorCount", { count: previewErrorRows.length })}</span>}
              {previewWarningRowCount > 0 && <span className="ml-2 font-medium text-amber-600">{formatText("batchImport.warningCount", { count: previewWarningRowCount })}</span>}
              {previewValidationRunning && (
                <span className="ml-2 font-medium text-blue-600">
                  {formatText("batchImport.previewChecking", {
                    checked: previewValidationProgress?.checked ?? 0,
                    total: previewValidationProgress?.total ?? items.length,
                  })}
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      {activeImportKind !== "fund" && message && (
        <div className="mx-4 mt-4 p-3 bg-blue-50 border border-blue-200 rounded-md text-blue-700 text-sm">
          {message}
        </div>
      )}

      {activeImportKind === "normal" && importProgress && (
        <div className="mx-4 mt-2 rounded-md border border-blue-100 bg-white px-3 py-2 text-xs text-slate-600">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span>{importProgressText}</span>
            <span className="font-medium text-slate-700">{importProgressPercent}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-blue-500 transition-[width] duration-300" style={{ width: `${importProgressPercent}%` }} />
          </div>
        </div>
      )}

      {activeImportKind !== "fund" && uploadDebug && (
        <div className="mx-4 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-md text-amber-800 text-sm">
          <div className="font-medium">{t("batchImport.uploadDebugTitle")}</div>
          <div className="mt-1 break-all">{uploadDebug}</div>
        </div>
      )}

      {uploading && !showUploadProcessingOverlay && (
        <div className="mx-4 mt-4 p-3 bg-blue-50 border border-blue-200 rounded-md text-blue-700 text-sm">
          {t("batchImport.loadingOverlay")}
        </div>
      )}

      {showUploadProcessingOverlay && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-900/45 px-4 py-6">
          <div role="status" aria-live="polite" className="w-full max-w-md rounded-xl border border-blue-200 bg-white p-5 text-sm shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-blue-200 border-t-blue-600" />
              <div className="min-w-0">
                <div className="text-base font-semibold text-slate-800">{t("batchImport.processingDataTitle")}</div>
                <div className="mt-1 whitespace-normal break-words leading-5 text-slate-600">{t("batchImport.loadingOverlay")}</div>
                <div className="mt-2 whitespace-normal break-words text-xs leading-5 text-slate-500">{t("batchImport.processingDataHint")}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {importCompletion && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/25 px-4 py-6">
          <div className="w-full max-w-md rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700 shadow-2xl">
            <div className="font-medium">{formatText("batchImport.importSuccessRedirect", { count: importCompletion.count })}</div>
            <div className="mt-1 text-xs text-green-600">{t("batchImport.importCompleteConfirmHint")}</div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={handleImportCompletionConfirm}
                className="rounded-md bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-700"
              >
                {importCompletion.href ? t("batchImport.importCompleteOpenAccount") : t("batchImport.importCompleteBackToStart")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="p-4 space-y-4">
        <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {visibleTemplates.map((template) => (
            <div key={template.key} className="bg-white rounded-lg border border-slate-200 p-4 flex flex-col gap-3">
              <div>
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-base font-semibold text-slate-800">{template.title}</h2>
                  <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">{template.status}</span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => downloadTemplate(template)}
                  className="px-3 py-1.5 text-sm rounded-md border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                >
                  {template.downloadFormat === "xlsx" ? t("batchImport.downloadXlsxTemplate") : t("batchImport.downloadCsvTemplate")}
                </button>
                {(template.key === "normal" || template.key === "wechat" || template.key === "jd") && (
                  <label className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 cursor-pointer inline-flex items-center">
                    {t("batchImport.uploadBillFile")}
                    <input
                      type="file"
                      accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                      className="sr-only"
                      onClick={() => {
                        setUploadDebug(t("batchImport.uploadControlClicked"));
                        setMessage(t("batchImport.filePickerOpened"));
                      }}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) {
                          setUploadDebug(t("batchImport.filePickerClosedNoFile"));
                          setMessage(t("batchImport.noFileSelected"));
                          return;
                        }
                        void handleNormalCsvFile(file);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                )}
                {template.key === "fund" && (
                  <label className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 cursor-pointer inline-flex items-center">
                    {t("batchImport.uploadFundFile")}
                    <input
                      type="file"
                      accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                      className="sr-only"
                      onClick={() => {
                        setUploadDebug(t("batchImport.uploadControlClicked"));
                        setMessage(t("batchImport.filePickerOpened"));
                      }}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) {
                          setUploadDebug(t("batchImport.filePickerClosedNoFile"));
                          setMessage(t("batchImport.noFileSelected"));
                          return;
                        }
                        void handleFundFile(file);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                )}
              </div>
            </div>
          ))}
        </section>
      </div>

      {activeImportKind === "normal" && (items.length > 0 || (uploading && !showUploadProcessingOverlay)) && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 p-4 flex items-center justify-center">
          <div data-smart-select-boundary className="h-[82vh] min-h-[420px] w-[80rem] min-w-[720px] max-w-[calc(100vw-2rem)] resize overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl flex flex-col">
            <div className="shrink-0 px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-800">{t("batchImport.previewTitle")}</div>
                <div className="text-xs text-slate-500 mt-1">{uploading ? t("batchImport.previewParsing") : t("batchImport.previewHint")}</div>
              </div>
              <button
                type="button"
                onClick={importCompletion ? handleImportCompletionConfirm : handleCancel}
                className="h-8 w-8 rounded-md border border-slate-300 text-slate-500 hover:bg-slate-50"
                aria-label={t("table.close")}
              >
                ×
              </button>
            </div>
            {message && (
              <div className="shrink-0 border-b border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-700">
                {message}
              </div>
            )}
            {importProgress && (
              <div className="shrink-0 border-b border-blue-100 bg-white px-4 py-2 text-xs text-slate-600">
                <div className="mb-1 flex items-center justify-between gap-3">
                  <span>{importProgressText}</span>
                  <span className="font-medium text-slate-700">{importProgressPercent}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-blue-500 transition-[width] duration-300" style={{ width: `${importProgressPercent}%` }} />
                </div>
              </div>
            )}
            {uploadDebug && (
              <div className="shrink-0 max-h-24 overflow-auto border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800 whitespace-pre-wrap">
                {uploadDebug}
              </div>
            )}
            <div className="shrink-0 border-b border-slate-200 bg-slate-50 px-4 py-3 space-y-3">
              {activeBillMode === "credit_card" ? (
                <div className="flex flex-wrap items-center gap-3 rounded-md border border-blue-100 bg-blue-50 px-3 py-2">
                  <span className="text-xs font-medium text-slate-700">{t("batchImport.creditMode.statementAccount")}</span>
                  <div className="w-80 max-w-full">
                    <SmartSelect
                      mode="single"
                      value={accountSelectValue(creditStatementAccount, "credit")}
                      onChange={(selectedId) => updateCreditStatementAccount(accountSelectTextById(selectedId))}
                      options={accountSmartSelectOptionsFor(creditStatementAccount, "credit")}
                      placeholder={t("batchImport.unselected")}
                      behavior={{ hierarchy: false, search: true, clearable: false, density: "micro", dropdownMaxHeight: 180, minDropdownWidth: 156, resizableDropdown: true }}
                    />
                  </div>
                  <span className="text-xs text-slate-500">{t("batchImport.creditMode.statementAccountHint")}</span>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                <span className="font-medium text-slate-700">
                  {showImportIssuesOnly ? t("batchImport.filterResult") : t("batchImport.recordTotal")}
                </span>
                <span>
                  {showImportIssuesOnly
                    ? formatText("batchImport.filteredCount", { filtered: normalPreviewRows.length, total: items.length })
                    : formatText("batchImport.totalCount", { total: items.length })}
                </span>
                {previewValidationRunning && (
                  <span className="rounded bg-blue-50 px-2 py-0.5 font-medium text-blue-700">
                    {formatText("batchImport.previewChecking", {
                      checked: previewValidationProgress?.checked ?? 0,
                      total: previewValidationProgress?.total ?? items.length,
                    })}
                  </span>
                )}
                {!previewValidationRunning && items.length > 0 && previewErrorRows.length === 0 && previewWarningRows.length === 0 && (
                  <span className="rounded bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
                    {t("batchImport.previewPassed")}
                  </span>
                )}
                {previewErrorRows.length > 0 && (
                  <span className="rounded bg-red-50 px-2 py-0.5 font-medium text-red-700">
                    {formatText("batchImport.previewBlockingBadge", { count: previewErrorRows.length })}
                  </span>
                )}
                {previewWarningRows.length > 0 && (
                  <span className="rounded bg-amber-50 px-2 py-0.5 font-medium text-amber-700">
                    {formatText("batchImport.previewWarningBadge", { count: previewWarningRows.length })}
                  </span>
                )}
                {previewIssueRowIndexes.size > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowImportIssuesOnly((value) => !value);
                    }}
                    className="h-8 px-2 rounded border border-amber-200 bg-white text-xs font-medium text-amber-700 hover:bg-amber-50"
                  >
                    {showImportIssuesOnly ? t("batchImport.showAllRows") : t("batchImport.showIssueRows")}
                  </button>
                )}
              </div>
              {previewErrorRows.length > 0 && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  <div className="font-semibold">{t("batchImport.previewBlockingHint")}</div>
                  <div className="mt-1 leading-5">
                    {previewErrorPreviewText}
                    {previewErrorRows.length > 6
                      ? formatText("batchImport.previewBlockingMore", { count: previewErrorRows.length - 6 })
                      : ""}
                  </div>
                </div>
              )}
              {previewWarningRows.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <div className="font-semibold">{t("batchImport.previewWarningHint")}</div>
                  <div className="mt-1 leading-5">
                    {previewWarningPreviewText}
                    {previewWarningGroupCount > 6
                      ? formatText("batchImport.previewWarningMore", { count: previewWarningGroupCount - 6 })
                      : ""}
                  </div>
                </div>
              )}
            </div>
            <div className="flex-1 min-h-0">
              <AdvancedDataTable
                storageKey="mmh_batch_import_normal_preview_table_v1"
                columns={normalPreviewColumns}
                rows={uploading ? [] : normalPreviewRows}
                rowKey={(row) => String(row.idx)}
                emptyText={uploading ? t("batchImport.previewParsing") : t("batchImport.noRecordsForFilter")}
                minTableWidth={1820}
                selectable
                selectAllScope="renderedRows"
                selectedKeys={selectedNormalPreviewKeys}
                onSelectionChange={(keys) => {
                  setSelected(new Set(Array.from(keys).map((key) => Number(key)).filter((idx) => Number.isInteger(idx))));
                }}
                batchActionSlot={(
                  <BatchReplacePopoverButton
                    fields={replaceFields}
                    targetCount={batchTargetIndexes.length}
                    targetLabel={t("batchImport.selectedTargetLabel")}
                    panelAlign="left"
                    disabledTitle={t("batchImport.selectFirstHint")}
                    buttonTitle={formatText("batchImport.batchEditTitle", { count: batchTargetIndexes.length })}
                    messageClassName="sr-only"
                    onApply={applyReplaceToTargets}
                  />
                )}
                toolbarTitle={t("batchImport.previewTitle")}
                toolbarRightContent={(
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    <span>{formatText("batchImport.selectedSummary", { selected: importTargetCount, total: items.length })}</span>
                    {showImportIssuesOnly ? <span>{formatText("batchImport.filteredCount", { filtered: normalPreviewRows.length, total: items.length })}</span> : null}
                  </div>
                )}
                rowClassName={(row) => {
                  const rowIssues = previewIssuesByRow.get(row.idx) ?? [];
                  const rowHasError = rowIssues.some((issue) => issue.level === "error");
                  const rowHasWarning = rowIssues.some((issue) => issue.level === "warning");
                  return rowHasError ? "bg-red-50 hover:bg-red-100/80" : rowHasWarning ? "bg-amber-50 hover:bg-amber-100/80" : "hover:bg-slate-50";
                }}
                fillHeight
                compactRows
                showFilters={false}
                sortable={false}
                resetDisplayStateOnMount
              />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3 text-xs">
                <span className="shrink-0 text-slate-500">{formatText("batchImport.selectedSummary", { selected: importTargetCount, total: items.length })}</span>
                {previewErrorRows.length > 0 ? <span className="shrink-0 font-medium text-red-600">{formatText("batchImport.errorCount", { count: previewErrorRows.length })}</span> : null}
                {previewWarningRowCount > 0 ? <span className="shrink-0 font-medium text-amber-600">{formatText("batchImport.warningCount", { count: previewWarningRowCount })}</span> : null}
              </div>
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={handleImport}
                  disabled={Boolean(importCompletion) || uploading || importing || previewValidationRunning || importTargetCount === 0 || importErrorIssues.length > 0}
                  className="h-9 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {importing ? t("batchImport.importing") : t("batchImport.confirmSelectedImport")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {activeImportKind === "fund" && (fundPreviewItems.length > 0 || (uploading && !showUploadProcessingOverlay)) && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 p-4 flex items-center justify-center">
          <div data-smart-select-boundary className="h-[82vh] min-h-[420px] w-[80rem] min-w-[720px] max-w-[calc(100vw-2rem)] resize overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl flex flex-col">
            <div className="shrink-0 px-4 py-3 border-b border-slate-200 flex items-center justify-between gap-3">
              <div>
                <div className="text-base font-semibold text-slate-800">{t("batchImport.previewFundTitle")}</div>
                <div className="text-xs text-slate-500 mt-1">
                  {uploading ? t("batchImport.previewParsing") : formatText("batchImport.previewFundHint", { count: fundPreviewItems.length })}
                </div>
              </div>
              <button
                type="button"
                onClick={importCompletion ? handleImportCompletionConfirm : handleCancel}
                className="h-8 w-8 rounded-md border border-slate-300 text-slate-500 hover:bg-slate-50"
                aria-label={t("table.close")}
              >
                ×
              </button>
            </div>
            {message && (
              <div className="shrink-0 border-b border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-700">
                {message}
              </div>
            )}
            {uploadDebug && (
              <div className="shrink-0 max-h-24 overflow-auto border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800 whitespace-pre-wrap">
                {uploadDebug}
              </div>
            )}
            <div className="shrink-0 border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
                <span className="font-medium text-slate-700">{formatText("batchImport.selectedSummary", { selected: fundSelected.size, total: fundPreviewItems.length })}</span>
                {fundImportErrorIssues.length > 0 && (
                  <span className="font-medium text-red-600">{formatText("batchImport.errorCount", { count: fundImportErrorIssues.length })}</span>
                )}
                {fundImportWarningIssues.length > 0 && (
                  <span className="font-medium text-amber-600">{formatText("batchImport.warningCount", { count: fundImportWarningIssues.length })}</span>
                )}
              </div>
              {fundRuleRows.length > 0 && (
                <div className="mt-3 rounded-lg border border-slate-200 bg-white">
                  <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2">
                    <div className="text-xs font-medium text-slate-700">{t("batchImport.fundPreview.ruleEditorTitle")}</div>
                    <button
                      type="button"
                      onClick={handleApplyFundRules}
                      disabled={uploading || importing || fundRuleRows.length === 0}
                      className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {fundRulesDirty ? t("batchImport.fundPreview.applyRulesDirty") : t("batchImport.fundPreview.applyRules")}
                    </button>
                  </div>
                  <div className="max-h-40 overflow-auto">
                    <div className="grid grid-cols-[minmax(140px,1.2fr)_96px_minmax(160px,1fr)_110px_110px] gap-x-3 gap-y-2 px-3 py-2 text-[11px] text-slate-500">
                      <div>{t("batchImport.template.fund.label.fundAccount")}</div>
                      <div>{t("batchImport.template.fund.label.fundCode")}</div>
                      <div>{t("batchImport.template.fund.label.fundName")}</div>
                      <div>{t("batchImport.fundPreview.confirmRuleHeader")}</div>
                      <div>{t("batchImport.fundPreview.arrivalRuleHeader")}</div>
                    </div>
                    <div className="space-y-2 border-t border-slate-100 px-3 py-2">
                      {fundRuleRows.map((row) => (
                        <div key={row.key} className="grid grid-cols-[minmax(140px,1.2fr)_96px_minmax(160px,1fr)_110px_110px] items-center gap-x-3 gap-y-2">
                          <div className="truncate text-xs text-slate-700" title={row.fundAccount}>{row.fundAccount}</div>
                          <div className="text-xs tabular-nums text-slate-700">{row.fundCode}</div>
                          <div className="truncate text-xs text-slate-700" title={row.fundName}>{row.fundName}</div>
                          <label className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
                            <span>T+</span>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={row.confirmDays}
                              onChange={(event) => {
                                const value = event.target.value;
                                setFundRuleRows((prev) => prev.map((item) => item.key === row.key ? { ...item, confirmDays: value } : item));
                                setFundRulesDirty(true);
                              }}
                              className="w-full bg-transparent text-right tabular-nums text-slate-700 outline-none"
                            />
                          </label>
                          <label className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
                            <span>T+</span>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={row.arrivalDays}
                              onChange={(event) => {
                                const value = event.target.value;
                                setFundRuleRows((prev) => prev.map((item) => item.key === row.key ? { ...item, arrivalDays: value } : item));
                                setFundRulesDirty(true);
                              }}
                              className="w-full bg-transparent text-right tabular-nums text-slate-700 outline-none"
                            />
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {fundPreviewWarningSummary && (
                <div className="mt-2 text-xs text-amber-700">
                  <span className="font-medium text-amber-800">{t("batchImport.fundPreview.warningSummaryTitle")}</span>
                  <span className="ml-1">{fundPreviewWarningSummary}</span>
                </div>
              )}
            </div>
            <div className="flex-1 min-h-0">
              <AdvancedDataTable
                storageKey="mmh_batch_import_fund_preview_table_v1"
                columns={fundPreviewColumns}
                rows={uploading ? [] : fundPreviewRows}
                rowKey={(row) => String(row.idx)}
                emptyText={uploading ? t("batchImport.previewParsing") : t("batchImport.noRecordsForFilter")}
                minTableWidth={1760}
                selectable
                selectAllScope="renderedRows"
                selectedKeys={selectedFundPreviewKeys}
                onSelectionChange={(keys) => {
                  setFundSelected(new Set(Array.from(keys).map((key) => Number(key)).filter((idx) => Number.isInteger(idx))));
                }}
                toolbarTitle={t("batchImport.previewFundTitle")}
                toolbarRightContent={(
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    <span>{formatText("batchImport.selectedSummary", { selected: fundSelected.size, total: fundPreviewItems.length })}</span>
                    {fundImportErrorIssues.length > 0 ? <span className="font-medium text-red-600">{formatText("batchImport.errorCount", { count: fundImportErrorIssues.length })}</span> : null}
                    {fundImportWarningIssues.length > 0 ? <span className="font-medium text-amber-600">{formatText("batchImport.warningCount", { count: fundImportWarningIssues.length })}</span> : null}
                  </div>
                )}
                rowClassName={(row) => {
                  const rowHasError = row.issues.some((issue) => issue.level === "error");
                  const rowHasWarning = row.issues.some((issue) => issue.level === "warning");
                  return rowHasError ? "bg-red-50 hover:bg-red-100/80" : rowHasWarning ? "bg-amber-50 hover:bg-amber-100/80" : "hover:bg-slate-50";
                }}
                fillHeight
                compactRows
                showFilters={false}
                sortable={false}
                showColumnVisibilityButton={false}
                resetDisplayStateOnMount
              />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3 text-xs">
                <span className="shrink-0 text-slate-500">{formatText("batchImport.selectedSummary", { selected: fundSelected.size, total: fundPreviewItems.length })}</span>
                {fundImportErrorIssues.length > 0 ? <span className="shrink-0 font-medium text-red-600">{formatText("batchImport.errorCount", { count: fundImportErrorIssues.length })}</span> : null}
                {fundImportWarningIssues.length > 0 ? <span className="shrink-0 font-medium text-amber-600">{formatText("batchImport.warningCount", { count: fundImportWarningIssues.length })}</span> : null}
              </div>
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={handleFundImport}
                  disabled={Boolean(importCompletion) || uploading || importing || fundSelected.size === 0 || fundImportErrorIssues.length > 0}
                  className="h-9 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {importing ? t("batchImport.importing") : formatText("batchImport.confirmImport", { count: fundSelected.size })}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
