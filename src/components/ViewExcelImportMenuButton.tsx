"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ChevronDown, Download, FileSpreadsheet, MailSearch, Upload } from "lucide-react";
import { CreditBillMailImportDialog } from "@/components/CreditBillMailImportButton";
import { FundImportPreviewDialog, type FundImportDialogContext } from "@/components/FundImportPreviewDialog";
import { StatementImportPreviewDialog, type StatementImportPreviewItem } from "@/components/StatementImportPreviewDialog";
import { StockImportPreviewDialog, type StockImportDialogContext, type StockImportUploadItem } from "@/components/StockImportPreviewDialog";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { parseFlexibleDateToYmd } from "@/lib/date-utils";
import {
  dropTemplateSampleRows,
  findTemplateGuideTitleRowIndex,
  findTemplateSampleColumnIndex,
  rowsBeforeTemplateGuide,
} from "@/lib/import-template-sample";
import { useI18n } from "@/lib/i18n";
import {
  STATEMENT_IMPORT_FIELD_HEADERS,
  buildStatementImportFieldHeaders,
  createStatementHeaderReader,
} from "@/lib/statement/header-catalog";
import {
  alignStatementRecognitionToLedger,
  type StatementHistoricalCategorySample,
} from "@/lib/statement/import-normalization";
import {
  hasImportableStatementRows,
  normalizeStatementExcelParsedItems,
  parseStatementExcelFile,
  parseStatementTemplateRows,
  readStatementWorkbookRowsAndText,
} from "@/lib/statement/excel-preview";

type ViewExcelImportExportItem = {
  label: string;
  href?: string;
  download?: string;
  onClick?: () => void;
};

type ExportCellValue = string | number | boolean | null | undefined;

type ViewExcelImportMailImportSpec = {
  accountId?: string;
  accountName: string;
};

type ViewExcelRangeExportSpec = {
  rows: ExportCellValue[][];
  filename: string;
  sheetName?: string;
  title?: string;
  description?: string;
  dateColumnIndex?: number;
};

type ViewExcelImportMenuButtonBaseProps = {
  exportItems?: ViewExcelImportExportItem[];
  className?: string;
  dataBasicDetailImport?: boolean;
  mailImport?: ViewExcelImportMailImportSpec;
  excelExport?: ViewExcelRangeExportSpec;
};

type ViewExcelImportMenuButtonProps =
  | ({
      kind: "normal";
      accountId: string;
      accountName: string;
    } & ViewExcelImportMenuButtonBaseProps)
  | ({
      kind: "fund";
      accountId: string;
      fundAccountName: string;
      fundCode?: string;
      fundName?: string;
    } & ViewExcelImportMenuButtonBaseProps)
  | ({
      kind: "stock";
      accountId: string;
      stockAccountName: string;
    } & ViewExcelImportMenuButtonBaseProps);

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

/** 字段填写范围里的一个取值；gloss 会写在说明列做补充说明。 */
type TemplateGuideValue = {
  value: string;
  gloss?: string;
};

type TemplateGuideRow = {
  /** 与表头一致的字段显示名 */
  label: string;
  /** 填写范围；有值时每个取值单独占一行 */
  values?: TemplateGuideValue[];
  /** 说明文字；不要重复写「必填 / 选填」，模板会自动补前缀 */
  note: string;
  /** 必填字段：表头与说明区字段名标红 */
  required?: boolean;
  /** 用特殊颜色突出该字段（如总费用，突出其覆盖其他费用的行为） */
  highlight?: boolean;
};

type TemplateSpec = {
  filename: string;
  sheetName: string;
  headers: string[];
  requiredHeaderIndexes?: number[];
  /** 突出字段的表头列索引（用特殊颜色标记，提醒用户注意） */
  highlightHeaderIndexes?: number[];
  /** 示例数据，导出时样板行列填「是」，导入时会被跳过 */
  sampleRows: string[][];
  /** 说明区里除了通用提示外的补充说明，每条一行 */
  introNotes: string[];
  guideRows: TemplateGuideRow[];
};

const NORMAL_HEADER_KEYS = [
  "detail.column.date",
  "detail.column.postedAt",
  "viewImport.activityType",
  "detail.column.outflow",
  "detail.column.inflow",
  "viewImport.account",
  "viewImport.counterAccount",
  "detail.column.category",
  "detail.column.counterparty",
  "detail.column.tags",
  "detail.column.remark",
] as const;
const FUND_HEADER_KEYS = [
  "detail.column.date",
  "viewImport.fundSubtype",
  "viewImport.cashAccount",
  "viewImport.fundAccount",
  "viewImport.fundCode",
  "viewImport.amount",
  "viewImport.feeRate",
  "viewImport.fee",
  "viewImport.nav",
  "viewImport.units",
  "viewImport.navDate",
  "detail.column.postedAt",
  "detail.column.tags",
  "detail.column.remark",
] as const;
const STOCK_HEADER_KEYS = [
  "detail.column.date",
  "stockTx.settleDateLabel",
  "viewImport.stockAccount",
  "depositShell.colAction",
  "reports.stock.market",
  "stockTx.stockCodeLabel",
  "stockHoldingReport.colQuantity",
  "stockPanel.colPrice",
  "stockPanel.colGrossAmount",
  "stockTx.netAmountLabel",
  "viewImport.bankAccount",
  "stockPanel.colFee",
  "stockFee.feeType.commission",
  "stockFee.feeType.stamp_tax",
  "stockFee.feeType.transfer_fee",
  "stockFee.feeType.exchange_fee",
  "stockFee.feeType.regulatory_fee",
  "stockFee.feeType.other",
  "detail.column.tags",
  "detail.column.remark",
] as const;

type StockImportItem = StockImportUploadItem;
type StockImportHeaderField = Exclude<keyof StockImportItem, "rawText" | "stockName" | "stockAccountId" | "accountId" | "bankAccountId" | "cashAccountId" | "exchange">;

type ImportCategoryOption = {
  name: string;
  type: string;
};

function localizedHeaders(keys: readonly string[], t: TranslateFn) {
  return keys.map((key) => t(key));
}

function safeFileNamePart(value: string, fallback: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "_").trim() || fallback;
}

function templateFor(props: ViewExcelImportMenuButtonProps, t: TranslateFn): TemplateSpec {
  if (props.kind === "stock") {
    const stockAccountName = props.stockAccountName || t("stockPanel.stockAccountTitle");
    return {
      filename: `${t("viewImport.stockTemplateFile", { name: safeFileNamePart(stockAccountName, t("viewImport.import")) })}.xlsx`,
      sheetName: t("viewImport.sheetStockTransactions"),
      headers: localizedHeaders(STOCK_HEADER_KEYS, t),
      requiredHeaderIndexes: [0, 2, 3, 5, 6],
      highlightHeaderIndexes: [6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17],
      introNotes: [t("viewImport.notesIntroStock"), t("viewImport.notesRecognitionStock")],
      sampleRows: [
        ["2026-06-08", "2026-06-08", stockAccountName, t("stockPanel.action.buy"), "CN_SH", "600519", "100", "1580.00", "", "", "", "5.00", "3.00", "", "1.00", "0.50", "0.50", "", t("viewImport.sampleTagInvest"), t("viewImport.sampleRemarkStockBuy")],
        ["2026-06-20", "2026-06-20", stockAccountName, t("stockPanel.action.sell"), "CN_SZ", "000001", "50", "12.00", "", "", "", "10.00", "3.00", "", "1.00", "0.50", "0.50", "5.00", "", t("viewImport.sampleRemarkStockSell")],
        ["2026-06-25", "2026-06-25", stockAccountName, t("viewImport.stockActionBankTransfer"), "", "", "", "", "10000.00", "", t("viewImport.sampleStockBankAccount"), "", "", "", "", "", "", "", "", t("viewImport.sampleRemarkStockTransferIn")],
        ["2026-06-30", "2026-06-30", stockAccountName, t("stockPanel.action.dividend"), "CN_SH", "600519", "", "", "300.00", "300.00", "", "", "", "", "", "", "", "", "", t("viewImport.sampleRemarkStockDividend")],
      ],
      guideRows: [
        { label: t("detail.column.date"), note: t("viewImport.notesDate"), required: true },
        { label: t("stockTx.settleDateLabel"), note: t("viewImport.notesStockSettleDate") },
        { label: t("viewImport.stockAccount"), note: t("viewImport.notesStockAccount"), required: true },
        {
          label: t("depositShell.colAction"),
          note: t("viewImport.notesStockAction"),
          required: true,
          values: [
            { value: t("stockPanel.action.buy") },
            { value: t("stockPanel.action.sell") },
            { value: t("stockPanel.action.dividend") },
            { value: t("stockPanel.action.bonus_share") },
            { value: t("stockPanel.action.split_share") },
            { value: t("stockPanel.action.merge_share") },
            { value: t("stockPanel.action.fee_adjustment") },
            { value: t("stockPanel.action.tax_adjustment") },
            { value: t("viewImport.stockActionBankTransfer") },
          ],
        },
        {
          label: t("reports.stock.market"),
          note: t("viewImport.notesStockMarket"),
          values: [
            { value: "CN_SH", gloss: t("stockFee.scope.CN_SH") },
            { value: "CN_SZ", gloss: t("stockFee.scope.CN_SZ") },
            { value: "CN_BJ", gloss: t("stockFee.scope.CN_BJ") },
            { value: "CN", gloss: t("viewImport.stockMarketGloss.auto") },
            { value: "HK", gloss: t("viewImport.stockMarketGloss.hk") },
            { value: "US", gloss: t("viewImport.stockMarketGloss.us") },
          ],
        },
        { label: t("stockTx.stockCodeLabel"), note: t("viewImport.notesStockCode"), required: true },
        { label: t("stockHoldingReport.colQuantity"), note: t("viewImport.notesStockQuantity"), required: true, highlight: true },
        { label: t("stockPanel.colPrice"), note: t("viewImport.notesStockPrice"), highlight: true },
        { label: t("stockPanel.colGrossAmount"), note: t("viewImport.notesStockAmount"), highlight: true },
        { label: t("stockTx.netAmountLabel"), note: t("viewImport.notesStockNetAmount"), highlight: true },
        { label: t("viewImport.bankAccount"), note: t("viewImport.notesStockBankAccount") },
        { label: t("stockPanel.colFee"), note: t("viewImport.notesStockFees"), highlight: true },
        { label: t("stockFee.feeType.commission"), note: t("viewImport.notesStockFeeComponent") },
        { label: t("stockFee.feeType.stamp_tax"), note: t("viewImport.notesStockFeeComponent") },
        { label: t("stockFee.feeType.transfer_fee"), note: t("viewImport.notesStockFeeComponent") },
        { label: t("stockFee.feeType.exchange_fee"), note: t("viewImport.notesStockFeeComponent") },
        { label: t("stockFee.feeType.regulatory_fee"), note: t("viewImport.notesStockFeeComponent") },
        { label: t("stockFee.feeType.other"), note: t("viewImport.notesStockFeeComponent") },
        { label: t("detail.column.tags"), note: t("viewImport.notesTags") },
        { label: t("detail.column.remark"), note: t("viewImport.notesRemark") },
      ],
    };
  }

  if (props.kind === "fund") {
    const fundAccountName = props.fundAccountName || t("viewImport.fundAccount");
    const fundCode = props.fundCode || "000001";
    return {
      filename: `${t("viewImport.fundTemplateFile", { name: safeFileNamePart(fundAccountName, t("viewImport.import")) })}.xlsx`,
      sheetName: t("viewImport.sheetFundTransactions"),
      headers: localizedHeaders(FUND_HEADER_KEYS, t),
      requiredHeaderIndexes: [0, 1, 2, 3, 4, 5],
      introNotes: [t("viewImport.notesIntroFund"), t("viewImport.notesRecognitionFund")],
      sampleRows: [
        ["2026-06-03", t("viewImport.fundActionBuy"), t("viewImport.sampleAccountDebit"), fundAccountName, fundCode, "1000.00", "1", "", "1.3521", "738.99", "2026-06-04", "2026-06-04", t("viewImport.sampleTagInvest"), ""],
        ["2026-06-10", t("viewImport.fundActionRedeem"), t("viewImport.sampleAccountDebit"), fundAccountName, fundCode, "500.00", "", "0.50", "1.3889", "360.00", "2026-06-11", "2026-06-12", "", ""],
        ["2026-06-15", t("viewImport.fundActionDividendCash"), t("viewImport.sampleAccountDebit"), fundAccountName, fundCode, "300.00", "", "", "", "", "", "2026-06-16", "", ""],
        ["2026-06-18", t("viewImport.fundActionDividendReinvest"), "", fundAccountName, fundCode, "", "", "", "1.4200", "210.00", "2026-06-18", "", "", ""],
      ],
      guideRows: [
        { label: t("detail.column.date"), note: t("viewImport.notesDate"), required: true },
        {
          label: t("viewImport.fundSubtype"),
          note: t("viewImport.notesFundSubtype"),
          required: true,
          values: [
            { value: t("viewImport.fundActionBuy") },
            { value: t("viewImport.fundActionRecurringBuy") },
            { value: t("viewImport.fundActionRedeem") },
            { value: t("viewImport.fundActionDividendCash") },
            { value: t("viewImport.fundActionDividendReinvest") },
          ],
        },
        { label: t("viewImport.cashAccount"), note: t("viewImport.notesCashAccount"), required: true },
        { label: t("viewImport.fundAccount"), note: t("viewImport.notesFundAccount"), required: true },
        { label: t("viewImport.fundCode"), note: t("viewImport.notesFundCode"), required: true },
        { label: t("viewImport.amount"), note: t("viewImport.notesFundAmount"), required: true },
        { label: t("viewImport.feeRate"), note: t("viewImport.notesFundFeeRate") },
        { label: t("viewImport.fee"), note: t("viewImport.notesFundFee") },
        { label: t("viewImport.nav"), note: t("viewImport.notesFundNav") },
        { label: t("viewImport.units"), note: t("viewImport.notesFundUnits") },
        { label: t("viewImport.navDate"), note: t("viewImport.notesFundConfirmDate") },
        { label: t("detail.column.postedAt"), note: t("viewImport.notesFundArrivalDate") },
        { label: t("detail.column.tags"), note: t("viewImport.notesTags") },
        { label: t("detail.column.remark"), note: t("viewImport.notesRemark") },
      ],
    };
  }

  const accountName = props.accountName || t("viewImport.currentAccount");
  const creditCardAliases = splitImportAliases(t("viewImport.creditCardAccountAliases"));
  const isCreditCardTemplate = creditCardAliases.some((alias) => accountName.toLowerCase().includes(alias.toLowerCase()));
  return {
    filename: `${t("viewImport.billTemplateFile", { name: safeFileNamePart(accountName, t("viewImport.import")) })}.xlsx`,
    sheetName: t("viewImport.sheetBillRecords"),
    headers: localizedHeaders(NORMAL_HEADER_KEYS, t),
    requiredHeaderIndexes: [0, 2, 3, 4, 5],
    introNotes: [t("viewImport.notesIntroNormal"), t("viewImport.notesRecognitionNormal")],
    sampleRows: isCreditCardTemplate
      ? [
        ["2026-06-08", "2026-06-09", t("transaction.type.expense"), "32.50", "", accountName, "", t("viewImport.sampleCategoryDining"), t("viewImport.sampleMerchantFastFood"), t("viewImport.sampleTagLunch"), t("viewImport.sampleRemarkCreditCardSpend")],
        ["2026-06-05", "2026-06-06", t("transaction.type.expense"), "", "20.00", accountName, "", t("viewImport.sampleCategoryDining"), t("viewImport.sampleMerchantRestaurant"), "", t("viewImport.sampleRemarkCreditCardRefund")],
        ["2026-06-20", "2026-06-20", t("transaction.type.transfer"), "", "108.00", accountName, t("viewImport.sampleAccountDebit"), "", "", "", t("viewImport.sampleRemarkCreditCardRepayment")],
      ]
      : [
        ["2026-06-08", "2026-06-09", t("transaction.type.expense"), "32.50", "", accountName, "", t("viewImport.sampleCategoryDining"), t("viewImport.sampleMerchantFastFood"), t("viewImport.sampleTagLunch"), t("viewImport.sampleRemarkLunch")],
        ["2026-06-08", "", t("transaction.type.income"), "", "1.28", accountName, "", t("viewImport.sampleCategoryInterestIncome"), "", t("viewImport.sampleTagInterest"), t("viewImport.sampleRemarkDemandInterest")],
        ["2026-06-20", "", t("transaction.type.transfer"), "1000.00", "", accountName, t("viewImport.sampleAccountCash"), "", "", "", t("viewImport.sampleRemarkTransfer")],
      ],
    guideRows: [
      { label: t("detail.column.date"), note: t("viewImport.notesDate"), required: true },
      { label: t("detail.column.postedAt"), note: t("viewImport.notesPostedAt") },
      {
        label: t("viewImport.activityType"),
        note: t("viewImport.notesActivityType"),
        required: true,
        values: [
          { value: t("transaction.type.expense") },
          { value: t("transaction.type.income") },
          { value: t("transaction.type.transfer") },
        ],
      },
      { label: t("detail.column.outflow"), note: t("viewImport.notesOutflow"), required: true },
      { label: t("detail.column.inflow"), note: t("viewImport.notesInflow"), required: true },
      { label: t("viewImport.account"), note: t("viewImport.notesAccount"), required: true },
      { label: t("viewImport.counterAccount"), note: t("viewImport.notesCounterAccount") },
      { label: t("detail.column.category"), note: t("viewImport.notesCategory") },
      { label: t("detail.column.counterparty"), note: t("viewImport.notesCounterparty") },
      { label: t("detail.column.tags"), note: t("viewImport.notesTags") },
      { label: t("detail.column.remark"), note: t("viewImport.notesRemark") },
    ],
  };
}

export async function exportViewImportTemplate(spec: TemplateSpec, t: TranslateFn) {
  const XLSX = await import("xlsx-js-style");
  const workbook = XLSX.utils.book_new();
  const layout = buildTemplateLayout(spec, t);
  const sheet = XLSX.utils.aoa_to_sheet(layout.rows);
  applyTemplateColumnWidths(sheet, layout);
  const noteEndColumn = applyTemplateGuideMerges(sheet, layout);
  styleTemplateSheet(XLSX, sheet, layout, noteEndColumn);
  applyTemplateGuideRowHeights(sheet, layout);
  XLSX.utils.book_append_sheet(workbook, sheet, spec.sheetName);
  XLSX.writeFile(workbook, spec.filename, { compression: true });
}

type StyledXlsxModule = typeof import("xlsx-js-style");
type StyledWorksheet = ReturnType<StyledXlsxModule["utils"]["aoa_to_sheet"]>;
type ExcelCellStyle = Record<string, unknown>;
type SheetMergeRange = { s: { r: number; c: number }; e: { r: number; c: number } };

/** 说明区结构：样板行之后空一行，再依次是标题行、通用提示行、补充说明行、字段表头行。 */
const GUIDE_NOTE_COLUMN_START = 2;
const GUIDE_NOTE_COLUMN_SPAN = 5;
const GUIDE_NOTE_COLUMN_END = GUIDE_NOTE_COLUMN_START + GUIDE_NOTE_COLUMN_SPAN - 1;
const GUIDE_MIN_COLUMN_COUNT = GUIDE_NOTE_COLUMN_END + 1;
const GUIDE_NOTICE_ROW_HEIGHT = 42;
const GUIDE_INTRO_ROW_HEIGHT = 30;
// 说明区一行文本的磅值；用于按内容估算说明体（body）行高，避免长说明被截断只显示一行。
const GUIDE_BODY_LINE_HEIGHT = 15;
type TemplateLayout = {
  rows: string[][];
  columnCount: number;
  headerCount: number;
  dataRowCount: number;
  guideStartRow: number;
  guideHeaderRow: number;
  introRowHeights: number[];
  requiredHeaderIndexes: Set<number>;
  highlightHeaderIndexes: Set<number>;
  requiredGuideLabels: Set<string>;
  highlightGuideLabels: Set<string>;
  sampleColumnIndex: number;
};

function guideWideRow(cells: string[], columnCount: number) {
  return [...cells, ...Array.from({ length: Math.max(0, columnCount - cells.length) }, () => "")];
}

function buildTemplateLayout(spec: TemplateSpec, t: TranslateFn): TemplateLayout {
  const headerRow = [...spec.headers, t("settings.accounts.import.sampleRow")];
  const sampleMark = t("settings.accounts.import.sampleRowYes");
  const dataRows = [headerRow, ...spec.sampleRows.map((row) => [...row, sampleMark])];
  const columnCount = Math.max(headerRow.length, GUIDE_MIN_COLUMN_COUNT);
  const introRows = [
    t("viewImport.sheetGuideTitleCombined"),
    t("settings.accounts.import.guideNoRepeatImport"),
    ...spec.introNotes,
  ];
  const guideStartRow = dataRows.length + 1;
  const guideHeaderRow = guideStartRow + introRows.length;
  const rows: string[][] = [
    ...dataRows.map((row) => guideWideRow(row, columnCount)),
    guideWideRow([], columnCount),
    ...introRows.map((text) => guideWideRow([text], columnCount)),
    guideWideRow(
      [
        t("settings.accounts.import.guideField"),
        t("settings.accounts.import.guideValue"),
        t("settings.accounts.import.guideNote"),
      ],
      columnCount,
    ),
  ];
  const requiredGuideLabels = new Set<string>();
  const highlightGuideLabels = new Set<string>();
  for (const guide of spec.guideRows) {
    const values = guide.values ?? [];
    const required = guide.required === true;
    if (required) requiredGuideLabels.add(guide.label);
    if (guide.highlight === true) highlightGuideLabels.add(guide.label);
    const prefix = values.length > 0
      ? t(required ? "settings.accounts.import.requiredEnumGuide" : "settings.accounts.import.optionalEnumGuide")
      : required
        ? t("settings.accounts.import.requiredFieldGuide")
        : "";
    // 字段名行同时承载第一个取值：这样「几个选填项就合并几行」，与基础资料模板一致。
    const firstValue = values[0];
    rows.push(guideWideRow(
      [guide.label, firstValue?.value ?? "", [prefix, guide.note, firstValue?.gloss].filter(Boolean).join(" ")],
      columnCount,
    ));
    // 其余取值每个单独一行，避免挤在一个单元格里。
    for (const item of values.slice(1)) {
      rows.push(guideWideRow(["", item.value, item.gloss ?? ""], columnCount));
    }
  }
  return {
    rows,
    columnCount,
    headerCount: headerRow.length,
    dataRowCount: dataRows.length,
    guideStartRow,
    guideHeaderRow,
    introRowHeights: [
      GUIDE_NOTICE_ROW_HEIGHT,
      GUIDE_NOTICE_ROW_HEIGHT,
      ...spec.introNotes.map(() => GUIDE_INTRO_ROW_HEIGHT),
    ],
    requiredHeaderIndexes: new Set(spec.requiredHeaderIndexes ?? []),
    highlightHeaderIndexes: new Set(spec.highlightHeaderIndexes ?? []),
    requiredGuideLabels,
    highlightGuideLabels,
    sampleColumnIndex: headerRow.length - 1,
  };
}

function templateNoteEndColumn(layout: TemplateLayout) {
  return Math.min(GUIDE_NOTE_COLUMN_END, layout.columnCount - 1);
}

const templateBorder = {
  top: { style: "thin", color: { rgb: "E2E8F0" } },
  bottom: { style: "thin", color: { rgb: "E2E8F0" } },
  left: { style: "thin", color: { rgb: "E2E8F0" } },
  right: { style: "thin", color: { rgb: "E2E8F0" } },
};

const templateHeaderStyle: ExcelCellStyle = {
  fill: { patternType: "solid", fgColor: { rgb: "E2E8F0" } },
  font: { bold: true, color: { rgb: "1F2937" } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: templateBorder,
};

const templateRequiredHeaderStyle: ExcelCellStyle = {
  fill: { patternType: "solid", fgColor: { rgb: "FCE4D6" } },
  font: { bold: true, color: { rgb: "C00000" } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: templateBorder,
};

// 突出字段（数量、价格/成交金额/净金额、总费用等）：灰绿色填充，深绿字。
const templateHighlightHeaderStyle: ExcelCellStyle = {
  fill: { patternType: "solid", fgColor: { rgb: "C9E4CA" } },
  font: { bold: true, color: { rgb: "1B5E20" } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: templateBorder,
};

// 既是必填又是突出字段（如数量）：保留红色字强调必填，同时用灰绿底色提醒。
const templateRequiredHighlightHeaderStyle: ExcelCellStyle = {
  fill: { patternType: "solid", fgColor: { rgb: "C9E4CA" } },
  font: { bold: true, color: { rgb: "C00000" } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: templateBorder,
};

const templateSampleHeaderStyle: ExcelCellStyle = {
  fill: { patternType: "solid", fgColor: { rgb: "FEF3C7" } },
  font: { bold: true, color: { rgb: "92400E" } },
  alignment: { horizontal: "center", vertical: "center", wrapText: true },
  border: templateBorder,
};

const templateSampleValueStyle: ExcelCellStyle = {
  fill: { patternType: "solid", fgColor: { rgb: "FFFBEB" } },
  font: { italic: true, color: { rgb: "92400E" } },
  alignment: { horizontal: "center", vertical: "center" },
  border: templateBorder,
};

const templateGuideIntroStyle = (isTitle: boolean): ExcelCellStyle => ({
  fill: { patternType: "solid", fgColor: { rgb: "DBEAFE" } },
  font: { bold: isTitle, color: { rgb: isTitle ? "1F2937" : "374151" } },
  alignment: { horizontal: "left", vertical: "center", wrapText: true },
  border: templateBorder,
});

const templateGuideHeaderStyle: ExcelCellStyle = {
  fill: { patternType: "solid", fgColor: { rgb: "E2E8F0" } },
  font: { bold: true, color: { rgb: "1F2937" } },
  alignment: { horizontal: "left", vertical: "center", wrapText: true },
  border: templateBorder,
};

function templateGuideBodyStyle(
  columnIndex: number,
  required: boolean,
  highlight: boolean,
  mergedLabel: boolean,
  mergedNote: boolean,
): ExcelCellStyle {
  const isFieldLabel = columnIndex === 0;
  const isNoteColumn = columnIndex >= GUIDE_NOTE_COLUMN_START;
  // 特殊颜色：突出字段（数量、价格/成交金额/净金额、总费用等）的字段名与说明都标灰绿色。
  // 既必填又突出时，字段名用红色（强调必填）其余（说明）用灰绿。
  const isRequiredLabel = required && isFieldLabel;
  const fontColor = isRequiredLabel ? "C02626" : highlight ? "1B5E20" : required && isFieldLabel ? "C00000" : "374151";
  const bold = (isFieldLabel && (required || highlight)) || (isNoteColumn && highlight);
  return {
    font: { bold, color: { rgb: fontColor } },
    alignment: {
      horizontal: isFieldLabel && mergedLabel ? "left" : undefined,
      // 字段名或说明跨行合并时垂直居中，单个取值行仍顶部对齐，与基础资料模板一致。
      vertical: (isFieldLabel && mergedLabel) || (isNoteColumn && mergedNote) ? "center" : isNoteColumn ? "top" : "center",
      wrapText: true,
    },
    border: templateBorder,
  };
}

function setTemplateCellStyle(
  XLSX: StyledXlsxModule,
  sheet: StyledWorksheet,
  rowIndex: number,
  columnIndex: number,
  style: ExcelCellStyle,
) {
  const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
  const cell = sheet[address] ?? (sheet[address] = { t: "s", v: "" });
  cell.s = style;
}

function applyTemplateColumnWidths(sheet: StyledWorksheet, layout: TemplateLayout) {
  const noteEndColumn = templateNoteEndColumn(layout);
  sheet["!cols"] = Array.from({ length: layout.columnCount }, (_, columnIndex) => {
    const isNoteColumn = columnIndex >= GUIDE_NOTE_COLUMN_START && columnIndex <= noteEndColumn;
    // 说明列 / 一般列取紧凑宽度；取值列（第 1 列，含入账日期等）适中。
    const defaultWidth = isNoteColumn ? 16 : columnIndex === 1 ? 20 : 12;
    const contentWidth = Math.max(
      ...layout.rows.map((row) => String(row[columnIndex] ?? "").split("\n").reduce((max, item) => Math.max(max, item.length + 2), 0)),
    );
    return { wch: Math.max(defaultWidth, Math.min(30, contentWidth)) };
  });
}

function applyTemplateGuideMerges(sheet: StyledWorksheet, layout: TemplateLayout) {
  const { rows, guideStartRow, guideHeaderRow } = layout;
  const noteEndColumn = templateNoteEndColumn(layout);
  const merges = sheet["!merges"] ?? [];
  for (let rowIndex = guideStartRow; rowIndex < guideHeaderRow; rowIndex += 1) {
    merges.push({ s: { r: rowIndex, c: 0 }, e: { r: rowIndex, c: noteEndColumn } });
  }
  // 按字段块分组：字段名有内容的行作为块起点，块覆盖该字段名行及其取值行。
  const blocks: Array<{ start: number; end: number }> = [];
  let fieldStartRow = guideHeaderRow;
  for (let rowIndex = fieldStartRow + 1; rowIndex <= rows.length; rowIndex += 1) {
    const startsNextField = rowIndex === rows.length || Boolean(String(rows[rowIndex]?.[0] ?? "").trim());
    if (!startsNextField) continue;
    blocks.push({ start: fieldStartRow, end: rowIndex - 1 });
    fieldStartRow = rowIndex;
  }
  const isNoteEmpty = (row: number) => !String(rows[row]?.[GUIDE_NOTE_COLUMN_START] ?? "").trim();
  for (const block of blocks) {
    const isMultiRow = block.end > block.start;
    const hasLabel = Boolean(String(rows[block.start]?.[0] ?? "").trim());
    if (isMultiRow && hasLabel) {
      // 字段名跨取值行纵向合并（收支大类、基金大类、股票动作等枚举字段）。
      merges.push({ s: { r: block.start, c: 0 }, e: { r: block.end, c: 0 } });
      // 取值行若没有各自的补充说明，说明区也整体纵向跨行合并，并垂直居中。
      let hasPerRowNote = false;
      for (let r = block.start + 1; r <= block.end; r += 1) {
        if (!isNoteEmpty(r)) { hasPerRowNote = true; break; }
      }
      if (!hasPerRowNote) {
        merges.push({ s: { r: block.start, c: GUIDE_NOTE_COLUMN_START }, e: { r: block.end, c: noteEndColumn } });
        continue;
      }
    }
    // 否则（单行字段，或取值行带各自补充说明如股票市场），说明区按行横向填充。
    for (let rowIndex = block.start; rowIndex <= block.end; rowIndex += 1) {
      merges.push({ s: { r: rowIndex, c: GUIDE_NOTE_COLUMN_START }, e: { r: rowIndex, c: noteEndColumn } });
    }
  }
  sheet["!merges"] = merges;
  return noteEndColumn;
}

function mergedTemplateGuideLabelRows(sheet: StyledWorksheet) {
  const startRows = new Set<number>();
  for (const merge of (sheet["!merges"] ?? []) as SheetMergeRange[]) {
    if (merge.s.c === 0 && merge.e.c === 0 && merge.e.r > merge.s.r) startRows.add(merge.s.r);
  }
  return startRows;
}

/** 说明列中纵向跨行合并的起始行（用于垂直居中）。 */
function mergedTemplateGuideNoteRows(sheet: StyledWorksheet) {
  const startRows = new Set<number>();
  for (const merge of (sheet["!merges"] ?? []) as SheetMergeRange[]) {
    if (merge.s.c >= GUIDE_NOTE_COLUMN_START && merge.s.r < merge.e.r) startRows.add(merge.s.r);
  }
  return startRows;
}

function styleTemplateSheet(
  XLSX: StyledXlsxModule,
  sheet: StyledWorksheet,
  layout: TemplateLayout,
  noteEndColumn: number,
) {
  const { rows, guideStartRow, guideHeaderRow, requiredHeaderIndexes, highlightHeaderIndexes, requiredGuideLabels, highlightGuideLabels, sampleColumnIndex } = layout;

  for (let columnIndex = 0; columnIndex < layout.headerCount; columnIndex += 1) {
    const style = columnIndex === sampleColumnIndex
      ? templateSampleHeaderStyle
      : highlightHeaderIndexes.has(columnIndex)
        ? (requiredHeaderIndexes.has(columnIndex) ? templateRequiredHighlightHeaderStyle : templateHighlightHeaderStyle)
        : requiredHeaderIndexes.has(columnIndex)
          ? templateRequiredHeaderStyle
          : templateHeaderStyle;
    setTemplateCellStyle(XLSX, sheet, 0, columnIndex, style);
  }
  for (let rowIndex = 1; rowIndex < layout.dataRowCount; rowIndex += 1) {
    setTemplateCellStyle(XLSX, sheet, rowIndex, sampleColumnIndex, templateSampleValueStyle);
  }

  for (let rowIndex = guideStartRow; rowIndex < guideHeaderRow; rowIndex += 1) {
    const style = templateGuideIntroStyle(rowIndex === guideStartRow);
    for (let columnIndex = 0; columnIndex <= noteEndColumn; columnIndex += 1) {
      setTemplateCellStyle(XLSX, sheet, rowIndex, columnIndex, style);
    }
  }
  for (let columnIndex = 0; columnIndex <= noteEndColumn; columnIndex += 1) {
    setTemplateCellStyle(XLSX, sheet, guideHeaderRow, columnIndex, templateGuideHeaderStyle);
  }

  const mergedLabelRows = mergedTemplateGuideLabelRows(sheet);
  const mergedNoteRows = mergedTemplateGuideNoteRows(sheet);
  let currentFieldRequired = false;
  let currentFieldHighlight = false;
  for (let rowIndex = guideHeaderRow + 1; rowIndex < rows.length; rowIndex += 1) {
    const label = String(rows[rowIndex]?.[0] ?? "").trim();
    if (label) {
      currentFieldRequired = requiredGuideLabels.has(label);
      currentFieldHighlight = highlightGuideLabels.has(label);
    }
    for (let columnIndex = 0; columnIndex <= noteEndColumn; columnIndex += 1) {
      setTemplateCellStyle(
        XLSX,
        sheet,
        rowIndex,
        columnIndex,
        templateGuideBodyStyle(columnIndex, currentFieldRequired, currentFieldHighlight, mergedLabelRows.has(rowIndex), mergedNoteRows.has(rowIndex)),
      );
    }
  }
}

function applyTemplateGuideRowHeights(sheet: StyledWorksheet, layout: TemplateLayout) {
  // 合并单元格不会自动撑高，说明区标题与提示行需要显式行高；说明体（body）行也按内容估算，
  // 避免成交金额等长说明只显示一行。
  const heights = sheet["!rows"] ?? [];
  layout.introRowHeights.forEach((height, index) => {
    heights[layout.guideStartRow + index] = { hpt: height };
  });
  const guideCols = sheet["!cols"] ?? [];
  const wch = (columnIndex: number) => guideCols[columnIndex]?.wch ?? 8;
  const noteEnd = templateNoteEndColumn(layout);
  const noteWidth = Array.from({ length: noteEnd - GUIDE_NOTE_COLUMN_START + 1 }, (_, i) => GUIDE_NOTE_COLUMN_START + i)
    .reduce((sum, c) => sum + wch(c), 0);
  // 文本宽度统一以 wch 单位计量：中文/全角按 2，其余按 1。行宽为一格能容纳的 wch 数。
  const textUnits = (text: string) => {
    let units = 0;
    for (const ch of String(text ?? "")) units += /[\u3000-\u9fff\uff00-\uffef\u3400-\u4dbf]/.test(ch) ? 2 : 1;
    return units;
  };
  // 一行（磅）；文本确实换行时才按 N 行抬行高。
  const lineHeight = GUIDE_BODY_LINE_HEIGHT + 4;
  const calcLines = (width: number, text: string) => {
    if (!text) return 1;
    const charsPerLine = Math.max(2, Math.floor(width));
    return Math.max(1, Math.ceil(textUnits(text) / charsPerLine));
  };
  const setHeight = (row: number, lines: number) => {
    const h = Math.max(1, Math.min(lines, 8)) * lineHeight;
    heights[row] = { hpt: h };
  };
  const isNoteEmpty = (row: number) => !String(layout.rows[row]?.[GUIDE_NOTE_COLUMN_START] ?? "").trim();
  // 字段块分组：字段名行 + 取值行（与 applyTemplateGuideMerges 一致）。
  const blocks: Array<{ start: number; end: number }> = [];
  let fieldStartRow = layout.guideHeaderRow;
  for (let rowIndex = fieldStartRow + 1; rowIndex <= layout.rows.length; rowIndex += 1) {
    const startsNextField = rowIndex === layout.rows.length || Boolean(String(layout.rows[rowIndex]?.[0] ?? "").trim());
    if (!startsNextField) continue;
    blocks.push({ start: fieldStartRow, end: rowIndex - 1 });
    fieldStartRow = rowIndex;
  }
  const labelWidth = (text: string, width: number) => (text ? calcLines(width, text) : 1);
  for (const block of blocks) {
    const start = block.start;
    const rowCount = block.end - block.start + 1;
    const label = String(layout.rows[start]?.[0] ?? "").trim();
    const labelValue = String(layout.rows[start]?.[1] ?? "").trim();
    const blockNote = String(layout.rows[start]?.[GUIDE_NOTE_COLUMN_START] ?? "").trim();
    const hasLabel = Boolean(label);
    const baseLine = Math.max(labelWidth(label, wch(0)), labelWidth(labelValue, wch(1)));
    if (rowCount === 1) {
      // 单行字段（如成交金额）：说明按行横向合并，需按说明实际换行行数定高。
      const lines = Math.max(baseLine, labelWidth(blockNote, noteWidth));
      setHeight(start, lines);
      continue;
    }
    // 多取值行：取值行是否各自带独立说明（如股票「市场」）。
    let hasPerRowNote = false;
    for (let r = start + 1; r <= block.end; r += 1) {
      if (!isNoteEmpty(r)) { hasPerRowNote = true; break; }
    }
    if (hasPerRowNote) {
      // 每行独立计高。
      for (let r = start; r <= block.end; r += 1) {
        const l = String(layout.rows[r]?.[0] ?? "").trim();
        const v = String(layout.rows[r]?.[1] ?? "").trim();
        const n = String(layout.rows[r]?.[GUIDE_NOTE_COLUMN_START] ?? "").trim();
        const lines = Math.max(labelWidth(l, wch(0)), labelWidth(v, wch(1)), labelWidth(n, noteWidth));
        setHeight(r, lines);
      }
    } else {
      // 说明整块纵向合并到字段名行：只在字段名行按说明换行数定高，取值行保持默认紧凑高度。
      const noteLines = calcLines(noteWidth, blockNote);
      const labelLines = Math.max(baseLine, hasLabel ? noteLines : 1);
      setHeight(start, labelLines);
      // 取值行保持默认高度（不显式设置），避免整列被拉高。
    }
  }
  // 单行字段若未命中（说明为空等），给一行基准高度即可，不特殊处理。
  sheet["!rows"] = heights;
}

export async function exportRowsToXlsx(rows: ExportCellValue[][], filename: string, sheetName: string) {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows.map((row) => row.map((cell) => cell ?? "")));
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  sheet["!cols"] = Array.from({ length: columnCount }, (_, columnIndex) => {
    const width = Math.max(
      10,
      Math.min(
        36,
        ...rows.map((row) => String(row[columnIndex] ?? "").length + 2),
      ),
    );
    return { wch: width };
  });
  XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
  XLSX.writeFile(workbook, filename, { compression: true });
}

export async function exportNormalAccountImportTemplate(accountName: string, t: TranslateFn) {
  await exportViewImportTemplate(templateFor({ kind: "normal", accountId: "", accountName }, t), t);
}

function normalizeHeaderText(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeCellText(value: unknown) {
  return String(value ?? "").trim();
}

function parseOptionalNumber(value: unknown) {
  const raw = normalizeCellText(value).replace(/,/g, "");
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function parseDateCell(value: unknown) {
  return parseFlexibleDateToYmd(value) ?? "";
}

const STOCK_FIELDS = [
  "tradeDate",
  "settleDate",
  "stockAccount",
  "action",
  "market",
  "stockCode",
  "quantity",
  "price",
  "grossAmount",
  "netAmount",
  "bankAccount",
  "fee",
  "commission",
  "stampTax",
  "transferFee",
  "exchangeFee",
  "regulatoryFee",
  "otherFee",
  "tags",
  "note",
] as const satisfies readonly StockImportHeaderField[];

const STOCK_FIELD_ALIAS_KEYS: Record<StockImportHeaderField, string> = {
  tradeDate: "viewImport.stockAlias.tradeDate",
  settleDate: "viewImport.stockAlias.settleDate",
  stockAccount: "viewImport.stockAlias.stockAccount",
  action: "viewImport.stockAlias.action",
  market: "viewImport.stockAlias.market",
  stockCode: "viewImport.stockAlias.stockCode",
  quantity: "viewImport.stockAlias.quantity",
  price: "viewImport.stockAlias.price",
  grossAmount: "viewImport.stockAlias.grossAmount",
  netAmount: "viewImport.stockAlias.netAmount",
  bankAccount: "viewImport.stockAlias.bankAccount",
  fee: "viewImport.stockAlias.fee",
  commission: "viewImport.stockAlias.commission",
  stampTax: "viewImport.stockAlias.stampTax",
  transferFee: "viewImport.stockAlias.transferFee",
  exchangeFee: "viewImport.stockAlias.exchangeFee",
  regulatoryFee: "viewImport.stockAlias.regulatoryFee",
  otherFee: "viewImport.stockAlias.otherFee",
  tags: "viewImport.stockAlias.tags",
  note: "viewImport.stockAlias.note",
};

function splitImportAliases(value: string) {
  return value.split("|").map((item) => item.trim()).filter(Boolean);
}

function buildStockHeaderIndex(headers: unknown[], t: TranslateFn) {
  const aliases = new Map<string, StockImportHeaderField>();
  STOCK_FIELDS.forEach((field, index) => {
    aliases.set(normalizeHeaderText(field), field);
    aliases.set(normalizeHeaderText(STOCK_HEADER_KEYS[index]), field);
    aliases.set(normalizeHeaderText(t(STOCK_HEADER_KEYS[index])), field);
    splitImportAliases(t(STOCK_FIELD_ALIAS_KEYS[field])).forEach((alias) => aliases.set(normalizeHeaderText(alias), field));
  });
  const normalizedHeaders = headers.map(normalizeHeaderText);
  const map = new Map<StockImportHeaderField, number>();
  normalizedHeaders.forEach((header, index) => {
    if (!header) return;
    const field = aliases.get(header);
    if (field && !map.has(field)) map.set(field, index);
  });
  return map;
}

type DetectedImportKind = "statement" | "fund" | "stock";

const FUND_DETECT_HEADER_KEYS = {
  date: ["date", "detail.column.date", "batchImport.template.fund.label.date", "交易日期", "申请日期"],
  fundSubtype: ["fundSubtype", "viewImport.fundSubtype", "batchImport.template.fund.label.fundSubtype", "分类", "业务类型", "基金类型", "动作", "现金分红", "红利再投"],
  cashAccount: ["cashAccount", "viewImport.cashAccount", "batchImport.template.fund.label.cashAccount", "现金账户", "付款账户"],
  fundAccount: ["fundAccount", "viewImport.fundAccount", "batchImport.template.fund.label.fundAccount", "投资账户"],
  fundCode: ["fundCode", "viewImport.fundCode", "batchImport.template.fund.label.fundCode", "代码"],
  amount: ["amount", "viewImport.amount", "batchImport.template.fund.label.amount", "发生金额"],
  units: ["units", "viewImport.units", "batchImport.template.fund.label.units", "确认份额"],
  nav: ["nav", "viewImport.nav", "batchImport.template.fund.label.nav", "成交净值"],
  feeRate: ["feeRate", "feeRateInput", "viewImport.feeRate", "batchImport.template.fund.label.feeRate"],
  fee: ["fee", "viewImport.fee", "batchImport.template.fund.label.fee", "手数料"],
  confirmDate: ["confirmDate", "viewImport.navDate", "batchImport.template.fund.label.confirmDate"],
  arrivalDate: ["arrivalDate", "detail.column.postedAt", "batchImport.template.fund.label.arrivalDate", "入帳日"],
} as const;

function hasDetectedHeader(normalizedHeaders: Set<string>, keys: readonly string[], t: TranslateFn) {
  return keys.some((key) => normalizedHeaders.has(normalizeHeaderText(key)) || normalizedHeaders.has(normalizeHeaderText(t(key))));
}

function fundHeaderDetectionScore(headers: unknown[], t: TranslateFn) {
  const normalizedHeaders = new Set(headers.map(normalizeHeaderText).filter(Boolean));
  const hasDate = hasDetectedHeader(normalizedHeaders, FUND_DETECT_HEADER_KEYS.date, t);
  const hasFundSubtype = hasDetectedHeader(normalizedHeaders, FUND_DETECT_HEADER_KEYS.fundSubtype, t);
  const hasFundAccount = hasDetectedHeader(normalizedHeaders, FUND_DETECT_HEADER_KEYS.fundAccount, t);
  const hasFundCode = hasDetectedHeader(normalizedHeaders, FUND_DETECT_HEADER_KEYS.fundCode, t);
  const hasAmount = hasDetectedHeader(normalizedHeaders, FUND_DETECT_HEADER_KEYS.amount, t);
  const hasUnits = hasDetectedHeader(normalizedHeaders, FUND_DETECT_HEADER_KEYS.units, t);
  if (!hasDate || !hasFundAccount || !hasFundCode || (!hasAmount && !hasUnits)) return 0;
  let score = 0;
  if (hasDate) score += 4;
  if (hasFundAccount) score += 4;
  if (hasFundCode) score += 4;
  if (hasAmount) score += 4;
  if (hasFundSubtype) score += 2;
  if (hasUnits) score += 2;
  if (hasDetectedHeader(normalizedHeaders, FUND_DETECT_HEADER_KEYS.cashAccount, t)) score += 1;
  if (hasDetectedHeader(normalizedHeaders, FUND_DETECT_HEADER_KEYS.nav, t)) score += 1;
  if (hasDetectedHeader(normalizedHeaders, FUND_DETECT_HEADER_KEYS.feeRate, t)) score += 1;
  if (hasDetectedHeader(normalizedHeaders, FUND_DETECT_HEADER_KEYS.fee, t)) score += 1;
  if (hasDetectedHeader(normalizedHeaders, FUND_DETECT_HEADER_KEYS.confirmDate, t)) score += 1;
  if (hasDetectedHeader(normalizedHeaders, FUND_DETECT_HEADER_KEYS.arrivalDate, t)) score += 1;
  return score;
}

function stockHeaderDetectionScore(headers: unknown[], t: TranslateFn) {
  const index = buildStockHeaderIndex(headers, t);
  if (!index.has("tradeDate") || !index.has("action") || (!index.has("stockCode") && !index.has("bankAccount"))) return 0;
  let score = 0;
  if (index.has("tradeDate")) score += 4;
  if (index.has("action")) score += 4;
  if (index.has("stockCode")) score += 4;
  if (index.has("stockAccount")) score += 1;
  if (index.has("market")) score += 2;
  if (index.has("quantity")) score += 2;
  if (index.has("price")) score += 2;
  if (index.has("grossAmount")) score += 2;
  if (index.has("bankAccount")) score += 1;
  if (index.has("fee")) score += 1;
  return score;
}

function statementHeaderDetectionScore(headers: unknown[]) {
  const reader = createStatementHeaderReader(headers.map((header) => String(header ?? "")), buildStatementImportFieldHeaders());
  const hasDate = reader.hasField("transactionDate");
  const hasAmount = reader.hasField("amount") || reader.hasField("outflow") || reader.hasField("inflow");
  const hasStatementContext = reader.hasField("sourceAccount")
    || reader.hasField("transferCounterAccount")
    || reader.hasField("majorType")
    || reader.hasField("explicitType")
    || reader.hasField("category")
    || reader.hasField("institution");
  if (!hasDate || !hasAmount || !hasStatementContext) return 0;
  let score = 0;
  if (reader.hasField("transactionDate")) score += 4;
  if (reader.hasField("amount")) score += 3;
  if (reader.hasField("outflow")) score += 3;
  if (reader.hasField("inflow")) score += 3;
  if (reader.hasField("sourceAccount")) score += 3;
  if (reader.hasField("transferCounterAccount")) score += 2;
  if (reader.hasField("majorType")) score += 2;
  if (reader.hasField("explicitType")) score += 2;
  if (reader.hasField("postedAt")) score += 1;
  if (reader.hasField("category")) score += 1;
  if (reader.hasField("institution")) score += 1;
  if (reader.hasField("tags")) score += 1;
  if (reader.hasField("remark")) score += 1;
  return score;
}

async function detectImportFileKind(file: File, t: TranslateFn): Promise<DetectedImportKind> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  let bestKind: DetectedImportKind = "statement";
  let bestScore = 0;
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
    for (const row of rows.slice(0, 8)) {
      const statementScore = statementHeaderDetectionScore(row ?? []);
      if (statementScore > bestScore) {
        bestKind = "statement";
        bestScore = statementScore;
      }
      const stockScore = stockHeaderDetectionScore(row ?? [], t);
      if (stockScore > bestScore) {
        bestKind = "stock";
        bestScore = stockScore;
      }
      const fundScore = fundHeaderDetectionScore(row ?? [], t);
      if (fundScore > bestScore) {
        bestKind = "fund";
        bestScore = fundScore;
      }
    }
  }
  return bestScore > 0 ? bestKind : "statement";
}

function normalizeStockImportAction(raw: string, t: TranslateFn) {
  const value = normalizeHeaderText(raw);
  if (!value) return "";
  const candidates: Array<[string, string[]]> = [
    ["buy", ["buy", t("stockPanel.action.buy"), ...splitImportAliases(t("viewImport.stockActionAlias.buy"))]],
    ["sell", ["sell", t("stockPanel.action.sell"), ...splitImportAliases(t("viewImport.stockActionAlias.sell"))]],
    ["dividend", ["dividend", t("stockPanel.action.dividend"), ...splitImportAliases(t("viewImport.stockActionAlias.dividend"))]],
    ["bonus_share", ["bonus_share", "bonus share", t("stockPanel.action.bonus_share"), ...splitImportAliases(t("viewImport.stockActionAlias.bonus_share"))]],
    ["split_share", ["split_share", "split", t("stockPanel.action.split_share"), ...splitImportAliases(t("viewImport.stockActionAlias.split_share"))]],
    ["merge_share", ["merge_share", "merge", t("stockPanel.action.merge_share"), ...splitImportAliases(t("viewImport.stockActionAlias.merge_share"))]],
    ["fee_adjustment", ["fee_adjustment", "fee adjustment", t("stockPanel.action.fee_adjustment"), ...splitImportAliases(t("viewImport.stockActionAlias.fee_adjustment"))]],
    ["tax_adjustment", ["tax_adjustment", "tax adjustment", t("stockPanel.action.tax_adjustment"), ...splitImportAliases(t("viewImport.stockActionAlias.tax_adjustment"))]],
    ["bank_transfer", ["bank_transfer", t("viewImport.stockActionBankTransfer"), ...splitImportAliases(t("viewImport.stockActionAlias.bank_transfer"))]],
  ];
  for (const [action, labels] of candidates) {
    if (labels.some((label) => normalizeHeaderText(label) === value)) return action;
  }
  return "";
}

async function parseStockImportFile(file: File, t: TranslateFn): Promise<StockImportItem[]> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  let bestRows: unknown[][] = [];
  let bestHeaderRow: unknown[] = [];
  let bestHeader = new Map<StockImportHeaderField, number>();
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
    for (let index = 0; index < Math.min(rows.length, 8); index++) {
      const header = buildStockHeaderIndex(rows[index] ?? [], t);
      const score = ["tradeDate", "action"].filter((field) => header.has(field as StockImportHeaderField)).length + (header.has("stockCode") || header.has("bankAccount") ? 1 : 0) + header.size / 100;
      if (score > 2 && score > (bestHeader.has("tradeDate") ? 2 : 0) + bestHeader.size / 100) {
        bestHeader = header;
        bestHeaderRow = rows[index] ?? [];
        bestRows = rows.slice(index + 1);
      }
    }
  }
  if (!bestHeader.has("tradeDate") || !bestHeader.has("action") || (!bestHeader.has("stockCode") && !bestHeader.has("bankAccount"))) return [];
  // 模板自带的样板行与底部字段说明区都不是真实数据。
  const guideTitleRowIndex = findTemplateGuideTitleRowIndex(bestRows, t("settings.accounts.import.sheetGuideTitle"));
  const sampleColumnIndex = findTemplateSampleColumnIndex(bestHeaderRow);
  const dataRows = dropTemplateSampleRows(rowsBeforeTemplateGuide(bestRows, guideTitleRowIndex), sampleColumnIndex);
  const readField = (row: unknown[], field: StockImportHeaderField) => {
    const index = bestHeader.get(field);
    return index == null ? "" : normalizeCellText(row[index]);
  };
  const unsupportedActions = new Set<string>();
  const items = dataRows.map((row) => {
    const rawAction = readField(row, "action");
    const action = normalizeStockImportAction(rawAction, t);
    const tradeDate = parseDateCell(row[bestHeader.get("tradeDate") ?? -1]);
    const stockAccount = readField(row, "stockAccount");
    const stockCode = readField(row, "stockCode");
    const bankAccount = readField(row, "bankAccount");
    if (tradeDate && (stockCode || bankAccount) && rawAction && !action) unsupportedActions.add(rawAction);
    return {
      rawText: row.map((cell) => normalizeCellText(cell)).filter(Boolean).join(" "),
      tradeDate,
      settleDate: bestHeader.has("settleDate") ? parseDateCell(row[bestHeader.get("settleDate") ?? -1]) || null : null,
      stockAccount,
      action,
      market: readField(row, "market"),
      stockCode,
      quantity: parseOptionalNumber(row[bestHeader.get("quantity") ?? -1]),
      price: parseOptionalNumber(row[bestHeader.get("price") ?? -1]),
      grossAmount: parseOptionalNumber(row[bestHeader.get("grossAmount") ?? -1]),
      netAmount: parseOptionalNumber(row[bestHeader.get("netAmount") ?? -1]),
      bankAccount,
      fee: parseOptionalNumber(row[bestHeader.get("fee") ?? -1]),
      commission: parseOptionalNumber(row[bestHeader.get("commission") ?? -1]),
      stampTax: parseOptionalNumber(row[bestHeader.get("stampTax") ?? -1]),
      transferFee: parseOptionalNumber(row[bestHeader.get("transferFee") ?? -1]),
      exchangeFee: parseOptionalNumber(row[bestHeader.get("exchangeFee") ?? -1]),
      regulatoryFee: parseOptionalNumber(row[bestHeader.get("regulatoryFee") ?? -1]),
      otherFee: parseOptionalNumber(row[bestHeader.get("otherFee") ?? -1]),
      note: readField(row, "note") || null,
      tags: readField(row, "tags") || null,
    };
  });
  if (unsupportedActions.size > 0) {
    throw new Error(t("viewImport.stockUnsupportedAction", { action: Array.from(unsupportedActions).join(", ") }));
  }
  return items.filter((item) => item.tradeDate && item.action && (item.stockCode || (item.action === "bank_transfer" && item.bankAccount)));
}

function parseExportDate(value: unknown) {
  const text = String(value ?? "").trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function exportDateBounds(rows: ExportCellValue[][], dateColumnIndex: number) {
  const dates = rows.slice(1).map((row) => parseExportDate(row[dateColumnIndex])).filter(Boolean).sort();
  return {
    start: dates[0] ?? "",
    end: dates[dates.length - 1] ?? "",
  };
}

function filenameWithDateRange(filename: string, start: string, end: string, fallback: string) {
  const suffix = start && end ? `${start}_${end}` : start || end || fallback;
  return filename.replace(/\.xlsx$/i, `-${suffix}.xlsx`);
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

function statementDefaultAccountName(props: ViewExcelImportMenuButtonProps) {
  return props.kind === "normal" ? props.accountName : "";
}

function fundImportContextFromProps(props: ViewExcelImportMenuButtonProps): FundImportDialogContext | null {
  if (props.kind !== "fund") return null;
  return {
    fundAccountId: props.accountId,
    fundAccount: props.fundAccountName,
    fundCode: props.fundCode,
    fundName: props.fundName,
  };
}

function stockImportContextFromProps(props: ViewExcelImportMenuButtonProps): StockImportDialogContext | null {
  if (props.kind !== "stock") return null;
  return {
    stockAccountId: props.accountId,
    stockAccountName: props.stockAccountName,
  };
}

export function ViewExcelImportMenuButton(props: ViewExcelImportMenuButtonProps) {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [mailImportOpen, setMailImportOpen] = useState(false);
  const [excelExportOpen, setExcelExportOpen] = useState(false);
  const [excelExportStart, setExcelExportStart] = useState("");
  const [excelExportEnd, setExcelExportEnd] = useState("");
  const [excelExportError, setExcelExportError] = useState("");
  const [busy, setBusy] = useState(false);
  const [processingFile, setProcessingFile] = useState(false);
  const [status, setStatus] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewItems, setPreviewItems] = useState<StatementImportPreviewItem[]>([]);
  const [fundPreviewFile, setFundPreviewFile] = useState<File | null>(null);
  const [fundPreviewContext, setFundPreviewContext] = useState<FundImportDialogContext | null>(null);
  const [stockPreviewOpen, setStockPreviewOpen] = useState(false);
  const [stockPreviewItems, setStockPreviewItems] = useState<StockImportUploadItem[]>([]);
  const [stockPreviewContext, setStockPreviewContext] = useState<StockImportDialogContext | null>(null);
  const [recognitionSamples, setRecognitionSamples] = useState<StatementHistoricalCategorySample[]>([]);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (props.kind !== "normal") return;
    let cancelled = false;
    fetch("/api/v1/statement/recognition-rules")
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setRecognitionSamples(Array.isArray(data?.samples) ? data.samples : []);
      })
      .catch(() => {
        if (!cancelled) setRecognitionSamples([]);
      });
    return () => { cancelled = true; };
  }, [props.kind]);

  async function refreshRecognitionSamples() {
    const res = await fetch("/api/v1/statement/recognition-rules", { cache: "no-store" });
    const data = await res.json().catch(() => null) as { samples?: StatementHistoricalCategorySample[] } | null;
    if (!res.ok || !Array.isArray(data?.samples)) {
      throw new Error(t("viewImport.recognitionFailed"));
    }
    setRecognitionSamples(data.samples);
    return data.samples;
  }

  async function loadImportCategories() {
    const res = await fetch("/api/v1/category", { cache: "no-store" });
    const data = await res.json().catch(() => null) as { categories?: ImportCategoryOption[] } | null;
    if (!res.ok || !Array.isArray(data?.categories)) return [];
    return data.categories;
  }

  async function handleExportTemplate() {
    setOpen(false);
    setBusy(true);
    try {
      await exportViewImportTemplate(templateFor(props, t), t);
    } catch (error) {
      setStatus(t("viewImport.failed", { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  }

  async function handleImportFile(file: File) {
    flushSync(() => {
      setOpen(false);
      setBusy(true);
      setProcessingFile(true);
      setStatus(t("viewImport.importing"));
    });
    await waitForBrowserPaint();
    try {
      const detectedKind = await detectImportFileKind(file, t);

      if (detectedKind === "stock") {
        const items = await parseStockImportFile(file, t);
        if (items.length === 0) throw new Error(t("viewImport.noRows"));
        setStockPreviewContext(stockImportContextFromProps(props));
        setStockPreviewItems(items);
        setStockPreviewOpen(true);
        setStatus(t("viewImport.recognizedCount", { count: items.length }));
        return;
      }

      if (detectedKind === "fund") {
        setFundPreviewContext(fundImportContextFromProps(props));
        setFundPreviewFile(file);
        setStatus("");
        return;
      }

      {
        // 财智8检测：文件名含 "财智" → 走财智专用通道
        const isCaizhiFile = /财智/.test(file.name);

        if (isCaizhiFile) {
          const { rows, caizhiRows } = await readStatementWorkbookRowsAndText(file, STATEMENT_IMPORT_FIELD_HEADERS);
          if (!caizhiRows || caizhiRows.length === 0) {
            throw new Error(t("viewImport.noRows"));
          }
          const MMH_STANDARD_HEADERS = [
            "日期", "入账日期", "收支大类", "流出", "流入", "账户", "对向账户",
            "分类", "收支机构", "标签", "备注",
          ];
          const headerPrefixedRows = [MMH_STANDARD_HEADERS, ...caizhiRows];
          const localItems = normalizeStatementExcelParsedItems(
            parseStatementTemplateRows(
              headerPrefixedRows,
              statementDefaultAccountName(props),
              STATEMENT_IMPORT_FIELD_HEADERS,
              t("settings.accounts.import.sheetGuideTitle"),
            )
          );
          const items = localItems.filter((item) => item.date && Number(item.amount) > 0);
          if (items.length === 0) throw new Error(t("viewImport.noRows"));
          setPreviewItems(items);
          setPreviewOpen(true);
          setStatus(t("viewImport.recognizedCount", { count: items.length }));
          return;
        }

        // 普通文件：走原有京东/支付宝/微信/标准模板链路
        const latestRecognitionSamples = await refreshRecognitionSamples().catch(() => recognitionSamples);
        const categories = await loadImportCategories();
        const latestFieldHeaders = buildStatementImportFieldHeaders(latestRecognitionSamples);
        const { localItems, preferServerRecognition, text } = await parseStatementExcelFile(
          file,
          statementDefaultAccountName(props),
          latestFieldHeaders,
          t("settings.accounts.import.sheetGuideTitle"),
        );
        let serverError: unknown = null;
        const serverItems = preferServerRecognition || !hasImportableStatementRows(localItems)
          ? await parseByServer(text).catch((error) => {
            serverError = error;
            return [] as StatementImportPreviewItem[];
          })
          : [];
        const parsedItems = hasImportableStatementRows(serverItems)
          ? serverItems
          : hasImportableStatementRows(localItems)
            ? localItems
            : [];
        if (parsedItems.length === 0 && serverError) throw serverError;
        const recognizedItems = alignStatementRecognitionToLedger(
          parsedItems,
          categories,
          latestRecognitionSamples,
        );
        const items = recognizedItems.filter((item) => item.date && Number(item.amount) > 0);
        if (items.length === 0) throw new Error(t("viewImport.noRows"));
        setPreviewItems(items);
        setPreviewOpen(true);
        setStatus(t("viewImport.recognizedCount", { count: items.length }));
        return;
      }
    } catch (error) {
      setStatus(t("viewImport.failed", { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
      setProcessingFile(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function parseByServer(text: string) {
    const res = await fetch("/api/v1/statement/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; items?: StatementImportPreviewItem[] } | null;
    if (!res.ok || !data?.ok) throw new Error(data?.error || t("viewImport.recognitionFailed"));
    return Array.isArray(data.items) ? data.items : [];
  }

  async function confirmImport(
    items: StatementImportPreviewItem[],
    options?: { createDebtAccounts?: boolean; forceCreateOwnedMoneyAccounts?: boolean },
  ) {
    if (items.length === 0) return;
    setBusy(true);
    setStatus(t("viewImport.importingBills"));
    try {
      const res = await fetch("/api/v1/statement/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items,
          defaultAccountName: statementDefaultAccountName(props),
          autoCreateAccounts: false,
          createDebtAccounts: options?.createDebtAccounts === true,
          forceCreateOwnedMoneyAccounts: options?.forceCreateOwnedMoneyAccounts === true,
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; createdCount?: number; skippedCount?: number; errors?: Array<{ error?: string }> } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error || data?.errors?.[0]?.error || t("creditBill.importFailed"));
      const createdCount = data.createdCount ?? 0;
      const skippedCount = data.skippedCount ?? 0;
      setStatus(t("creditBill.importExcelSuccess", { created: createdCount, skipped: skippedCount }));
      setPreviewOpen(false);
      setPreviewItems([]);
      dispatchFinanceDataChanged({ reason: "statement-excel-import", accountIds: [props.accountId] });
    } catch (error) {
      setStatus(t("viewImport.failed", { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  }

  function openExcelExportDialog() {
    const spec = props.excelExport;
    if (!spec) return;
    const dateColumnIndex = spec.dateColumnIndex ?? 0;
    const bounds = exportDateBounds(spec.rows, dateColumnIndex);
    setOpen(false);
    setExcelExportStart(bounds.start);
    setExcelExportEnd(bounds.end);
    setExcelExportError("");
    setExcelExportOpen(true);
  }

  async function handleExcelExport() {
    const spec = props.excelExport;
    if (!spec || busy) return;
    const dateColumnIndex = spec.dateColumnIndex ?? 0;
    if (excelExportStart && excelExportEnd && excelExportStart > excelExportEnd) {
      setExcelExportError(t("viewImport.dateRangeInvalid"));
      return;
    }
    const [header = [], ...bodyRows] = spec.rows;
    const filteredRows = bodyRows.filter((row) => {
      const date = parseExportDate(row[dateColumnIndex]);
      if (!date) return false;
      if (excelExportStart && date < excelExportStart) return false;
      if (excelExportEnd && date > excelExportEnd) return false;
      return true;
    });
    if (filteredRows.length === 0) {
      setExcelExportError(t("viewImport.noRowsInRange"));
      return;
    }
    setBusy(true);
    setExcelExportError("");
    try {
      await exportRowsToXlsx(
        [header, ...filteredRows],
        filenameWithDateRange(spec.filename, excelExportStart, excelExportEnd, t("creditBill.all")),
        spec.sheetName ?? t("viewImport.details"),
      );
      setExcelExportOpen(false);
      setStatus(t("viewImport.exportedCount", { count: filteredRows.length }));
    } catch (error) {
      setExcelExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={menuRef} className={["relative inline-flex items-center", props.className ?? ""].filter(Boolean).join(" ")}>
      {processingFile ? (
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
      ) : null}
      <button
        type="button"
        data-basic-detail-import={props.dataBasicDetailImport ? true : undefined}
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
        className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600 hover:bg-blue-50 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
        title={t("viewImport.title")}
      >
        <Upload className="h-3.5 w-3.5" />
        {t("creditBill.importMenu")}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open ? (
        <div className="absolute right-0 top-8 z-50 w-44 overflow-hidden rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          {props.excelExport ? (
            <button
              type="button"
              onClick={openExcelExportDialog}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              {t("viewImport.exportExcel")}
            </button>
          ) : null}
          {props.exportItems?.map((item) => item.href ? (
            <a
              key={`${item.label}:${item.href}`}
              href={item.href}
              download={item.download}
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" />
              {item.label}
            </a>
          ) : (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setOpen(false);
                item.onClick?.();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
            >
              <Download className="h-3.5 w-3.5" />
              {item.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void handleExportTemplate()}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
          >
            <Download className="h-3.5 w-3.5" />
            {t("creditBill.exportTemplate")}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              inputRef.current?.click();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" />
            {t("creditBill.importExcel")}
          </button>
          {props.mailImport ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setMailImportOpen(true);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
            >
              <MailSearch className="h-3.5 w-3.5" />
              {t("creditBill.importMail")}
            </button>
          ) : null}
        </div>
      ) : null}
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void handleImportFile(file);
        }}
      />
      {props.mailImport ? (
        <CreditBillMailImportDialog
          open={mailImportOpen}
          onClose={() => setMailImportOpen(false)}
          accountId={props.mailImport.accountId ?? props.accountId}
          accountName={props.mailImport.accountName}
        />
      ) : null}
      <StatementImportPreviewDialog
        open={previewOpen}
        title={t("viewImport.previewTitle")}
        description={t("viewImport.previewDescription")}
        items={previewItems}
        defaultAccountName={statementDefaultAccountName(props)}
        busy={busy}
        onClose={() => setPreviewOpen(false)}
        onConfirm={confirmImport}
      />
      <FundImportPreviewDialog
        open={Boolean(fundPreviewFile)}
        file={fundPreviewFile}
        context={fundPreviewContext}
        onClose={() => {
          setFundPreviewFile(null);
          setFundPreviewContext(null);
        }}
        onImported={({ count }) => {
          setStatus(t("batchImport.fundImportSuccess", { count, redirectNote: "" }));
        }}
      />
      <StockImportPreviewDialog
        open={stockPreviewOpen}
        items={stockPreviewItems}
        context={stockPreviewContext}
        onClose={() => {
          setStockPreviewOpen(false);
          setStockPreviewItems([]);
          setStockPreviewContext(null);
        }}
        onImported={({ created, skipped }) => {
          setStatus(t("viewImport.stockImportSuccess", { created, skipped }));
        }}
      />
      {props.excelExport && excelExportOpen ? (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-slate-900/25 px-4">
          <div className="w-full max-w-md overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="text-sm font-semibold text-slate-800">{props.excelExport.title ?? t("viewImport.exportExcel")}</div>
              <div className="mt-1 text-xs text-slate-500">
                {props.excelExport.description ?? t("viewImport.exportDescription")}
              </div>
            </div>
            <div className="space-y-3 px-4 py-4">
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">{t("viewImport.exportStartDate")}</span>
                <input
                  type="date"
                  value={excelExportStart}
                  onChange={(event) => setExcelExportStart(event.target.value)}
                  className="form-input"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-slate-600">{t("viewImport.exportEndDate")}</span>
                <input
                  type="date"
                  value={excelExportEnd}
                  onChange={(event) => setExcelExportEnd(event.target.value)}
                  className="form-input"
                />
              </label>
              {excelExportError ? <div className="rounded bg-red-50 px-3 py-2 text-xs text-red-700">{excelExportError}</div> : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-3">
              <button type="button" onClick={() => setExcelExportOpen(false)} className="secondary-button h-8 px-3 text-xs" disabled={busy}>
                {t("common.cancel")}
              </button>
              <button type="button" onClick={() => void handleExcelExport()} className="primary-button h-8 px-3 text-xs" disabled={busy}>
                {busy ? t("viewImport.exporting") : t("viewImport.export")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {status ? <span className="ml-2 max-w-64 truncate text-xs text-slate-500" title={status}>{status}</span> : null}
    </div>
  );
}
