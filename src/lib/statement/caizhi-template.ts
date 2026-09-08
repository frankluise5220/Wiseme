/**
 * 财智8 账单明细（.xls/.xlsx）→ MMH 标准账单导入格式
 *
 * 转换规则（用户指定）：
 * 1. 活动类型含 "|"（转出|X / 转入|X / 借出|X 等）→ 收支大类=转账，对向账户=|右侧，分类留空
 * 2. 活动类型不含 "|"：
 *    - 有流入 → 收入，分类=活动类型原文
 *    - 有流出 → 支出，分类=活动类型原文
 * 3. 余额调整行剔除（余额初始化应由 MMH「余额校准」处理，导入为收入会污染统计）
 *
 * 输入：SheetJS 解析后的 string[][]（不含表头行）
 * 输出：MMH 标准账单格式 string[][]（不含表头）
 */
export type CaizhiWorkbookSheetRows = {
  sheetName: string;
  rows: string[][];
};

export type NormalizedCaizhiWorkbookRows = {
  rows: string[][];
  sourceDataRowCount: number;
  includedSheetCount: number;
  profile: "caizhi";
  /** 被剔除的余额调整行（用于给用户提示） */
  balanceAdjustRows: string[][];
};

// MMH 标准表头（与通用模板/支付宝/微信保持一致）
const NORMALIZED_HEADERS = [
  "日期",
  "入账日期",
  "收支大类",
  "流出",
  "流入",
  "账户",
  "对向账户",
  "分类",
  "收支机构",
  "标签",
  "备注",
];

const CAIZHI_HEADER_ALIASES: Record<string, CaizhiColumnKey | "skip"> = {
  // 标准列名
  "日期": "date",
  "交易日期": "date",
  "流入": "inflow",
  "支出": "outflow",
  "活动类型": "activityType",
  "备注": "remark",
  // 可能的别名
  "入账日期": "skip",
  "收支大类": "skip",
  "流出": "skip",
  "流入金额": "inflow",
  "流出金额": "outflow",
  "类型": "activityType",
  "交易类型": "activityType",
};

type CaizhiColumnIndex = {
  date: number;
  inflow: number;
  outflow: number;
  activityType: number;
  remark: number;
};

type CaizhiColumnKey = keyof CaizhiColumnIndex;

const CAIZHI_COLUMN_INDEX: CaizhiColumnIndex = {
  date: -1,
  inflow: -1,
  outflow: -1,
  activityType: -1,
  remark: -1,
};

const BALANCE_ADJUST_KEYWORDS = [
  "余额调整",
  "余额初始化",
  "期初余额",
  "结息",
];

const TRANSFER_PREFIXES = new Set([
  "转入",
  "转出",
  "借出",
  "借入",
  "收回",
  "返还",
  "开放式基金赎回",
  "开放式基金申购",
  "基金赎回",
  "基金申购",
]);

function normalizeHeader(value: string): string {
  return String(value ?? "").trim().replace(/\s+/g, "");
}

function cleanText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  return String(value).trim();
}

function parseAmount(value: unknown): number | null {
  const raw = cleanText(value).replace(/,/g, "").replace(/¥/g, "").trim();
  if (!raw) return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function isBalanceAdjust(activityType: string): boolean {
  const act = activityType.trim();
  return BALANCE_ADJUST_KEYWORDS.some((kw) => act.includes(kw));
}

function normalizeDate(value: unknown): string {
  const raw = cleanText(value);
  if (!raw) return "";
  // 支持多种格式：2026/9/3, 2026-09-03, 2026年9月3日
  const slashMatch = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (slashMatch) {
    return `${slashMatch[1]}-${slashMatch[2].padStart(2, "0")}-${slashMatch[3].padStart(2, "0")}`;
  }
  const hyphenMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (hyphenMatch) {
    return `${hyphenMatch[1]}-${hyphenMatch[2].padStart(2, "0")}-${hyphenMatch[3].padStart(2, "0")}`;
  }
  const cnMatch = raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})/);
  if (cnMatch) {
    return `${cnMatch[1]}-${cnMatch[2].padStart(2, "0")}-${cnMatch[3].padStart(2, "0")}`;
  }
  return raw.slice(0, 10);
}

function buildCaizhiHeaderIndex(headerRow: string[]): CaizhiColumnIndex | null {
  const result = { date: -1, inflow: -1, outflow: -1, activityType: -1, remark: -1 };
  let foundCount = 0;

  for (let i = 0; i < headerRow.length; i++) {
    const normalized = normalizeHeader(headerRow[i]);
    if (!normalized || normalized === "skip") continue;

    const alias = CAIZHI_HEADER_ALIASES[normalized];
    if (!alias || alias === "skip") continue;

    if (alias in result) {
      (result as Record<string, number>)[alias] = i;
      foundCount++;
    }
  }

  // 必须有 date 和 (inflow 或 outflow) 以及 activityType
  if (result.date < 0 || result.activityType < 0) return null;
  if (result.inflow < 0 && result.outflow < 0) return null;
  return result;
}

function normalizeCaizhiRow(
  row: string[],
  colIdx: CaizhiColumnIndex,
  accountName: string,
): string[] | null {
  const date = normalizeDate(row[colIdx.date]);
  if (!date) return null;

  const activityType = cleanText(row[colIdx.activityType]);
  if (!activityType) return null;

  // 余额调整行剔除
  if (isBalanceAdjust(activityType)) return null;

  const remark = cleanText(row[colIdx.remark]);
  const inflowRaw = colIdx.inflow >= 0 ? parseAmount(row[colIdx.inflow]) : null;
  const outflowRaw = colIdx.outflow >= 0 ? parseAmount(row[colIdx.outflow]) : null;

  // 流入/流出必须有一个有效
  const hasInflow = inflowRaw !== null && inflowRaw > 0;
  const hasOutflow = outflowRaw !== null && outflowRaw > 0;
  if (!hasInflow && !hasOutflow) return null;

  if (activityType.includes("|")) {
    // 转账：收支大类=转账，对向账户=|右侧，分类留空
    const [, counterAccountRaw] = activityType.split("|");
    const counterAccount = counterAccountRaw?.trim() ?? "";
    const outflow = hasOutflow ? String(outflowRaw) : "";
    const inflow = hasInflow ? String(inflowRaw) : "";
    return [date, "", "转账", outflow, inflow, accountName, counterAccount, "", "", "", remark];
  }

  if (hasInflow) {
    // 收入
    return [date, "", "收入", "", String(inflowRaw), accountName, "", activityType, "", "", remark];
  }

  // 支出
  return [date, "", "支出", String(outflowRaw), "", accountName, "", activityType, "", "", remark];
}

/**
 * 从 SheetJS 解析后的工作簿 sheets 中检测并提取财智8数据。
 * 返回 { rows, sourceDataRowCount, includedSheetCount, profile, balanceAdjustRows }
 */
export function normalizeCaizhiWorkbookRows(
  sheets: CaizhiWorkbookSheetRows[],
  accountName: string,
): NormalizedCaizhiWorkbookRows | undefined {
  const resultRows: string[][] = [];
  const balanceAdjustRows: string[][] = [];
  let includedSheetCount = 0;
  let totalDataRows = 0;

  for (const sheet of sheets) {
    const dataRows = sheet.rows;
    if (dataRows.length === 0) continue;

    const headerIdx = buildCaizhiHeaderIndex(dataRows[0]);
    if (!headerIdx) continue;

    includedSheetCount++;
    const dataStart = 1; // 跳过表头行

    for (let r = dataStart; r < dataRows.length; r++) {
      const row = dataRows[r];
      // 跳过全空行
      if (!row.some((cell) => cleanText(cell))) continue;

      totalDataRows++;

      const activityType = cleanText(row[headerIdx.activityType]);
      if (!activityType) continue;

      if (isBalanceAdjust(activityType)) {
        balanceAdjustRows.push([
          normalizeDate(row[headerIdx.date]),
          activityType,
          cleanText(row[headerIdx.inflow] ?? row[headerIdx.outflow] ?? ""),
          cleanText(row[headerIdx.remark]),
        ]);
        continue;
      }

      const normalized = normalizeCaizhiRow(row, headerIdx, accountName);
      if (normalized) resultRows.push(normalized);
    }
  }

  if (includedSheetCount === 0) return undefined;

  return {
    rows: resultRows,
    sourceDataRowCount: totalDataRows,
    includedSheetCount,
    profile: "caizhi",
    balanceAdjustRows,
  };
}

/**
 * 检测给定表头行是否为财智8格式。
 * 特征：含 日期/流入/流出/活动类型（可能有别名）
 */
export function detectCaizhiHeaders(headerRow: string[]): boolean {
  const normalized = headerRow.map(normalizeHeader);
  const hasDate = normalized.some((h) => h === "日期" || h === "交易日期");
  const hasInflow = normalized.some(
    (h) => h === "流入" || h === "流入金额",
  );
  const hasOutflow = normalized.some(
    (h) => h === "流出" || h === "流出金额" || h === "支出",
  );
  const hasActivityType = normalized.some(
    (h) => h === "活动类型" || h === "类型" || h === "交易类型",
  );
  // 至少需要日期 + (流入或流出) + 活动类型
  return hasDate && hasActivityType && (hasInflow || hasOutflow);
}
