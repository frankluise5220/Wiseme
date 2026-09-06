"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import { BatchReplacePopoverButton, type BatchReplaceFieldConfig } from "@/components/BatchReplacePopoverButton";
import { evaluateCalcInputExpression } from "@/components/CalcInput";
import { SmartSelect } from "@/components/SmartSelect";
import {
  buildAccountDisplayOption,
  buildGroupedAccountOptions,
  type AccountDisplayOption,
} from "@/lib/account-display";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { fetchSettingsBootstrap } from "@/lib/client/settingsCache";
import { addTradingDaysUtc } from "@/lib/date-utils";
import { useI18n } from "@/lib/i18n";
import { getAccountLabelFieldsPreference } from "@/lib/client/appPreferences";
import { restrictAccountsByType } from "@/lib/client/account-dropdown-filter";

export type StockImportUploadItem = {
  rawText?: string;
  tradeDate: string;
  settleDate?: string | null;
  stockAccount?: string;
  stockAccountId?: string | null;
  accountId?: string | null;
  action: string;
  market?: string;
  exchange?: string | null;
  stockCode: string;
  stockName?: string;
  quantity?: number | null;
  price?: number | null;
  grossAmount?: number | null;
  netAmount?: number | null;
  bankAccount?: string;
  bankAccountId?: string | null;
  cashAccountId?: string | null;
  fee?: number | null;
  commission?: number | null;
  stampTax?: number | null;
  transferFee?: number | null;
  exchangeFee?: number | null;
  regulatoryFee?: number | null;
  otherFee?: number | null;
  note?: string | null;
  tags?: string | null;
};

export type StockImportDialogContext = {
  stockAccountId: string;
  stockAccountName?: string;
};

type StockImportPreviewIssue = {
  level: "error" | "warning";
  code?: string;
  message: string;
};

type StockImportCalculatedField =
  | "price"
  | "grossAmount"
  | "netAmount"
  | "fee"
  | "commission"
  | "stampTax"
  | "transferFee"
  | "exchangeFee"
  | "regulatoryFee"
  | "otherFee"
  | "totalFee"
  | "cashAmount";

type StockImportPreviewItem = StockImportUploadItem & {
  stockAccountId: string;
  stockAccountName: string;
  stockName: string | null;
  securityId: string | null;
  bankAccount: string;
  bankAccountId: string | null;
  cashAccountId: string | null;
  totalFee: number;
  cashAmount: number;
  calculatedFields?: StockImportCalculatedField[];
  duplicate: boolean;
  issues: StockImportPreviewIssue[];
};

type StockPreviewTableRow = StockImportPreviewItem & { idx: number };
type StockPreviewBatchEditField = "fee" | "settleDate" | "stockAccount" | "bankAccount";
type StockPreviewEditField =
  | "tradeDate"
  | "settleDate"
  | "stockAccount"
  | "action"
  | "market"
  | "stockCode"
  | "quantity"
  | "price"
  | "grossAmount"
  | "netAmount"
  | "bankAccount"
  | "fee"
  | "commission"
  | "stampTax"
  | "transferFee"
  | "exchangeFee"
  | "regulatoryFee"
  | "otherFee"
  | "note"
  | "tags";
type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

type BookAccount = {
  id: string;
  name: string;
  kind: string;
  numberMasked?: string | null;
  groupId?: string | null;
  investProductType?: string | null;
  Institution?: { name?: string | null; shortName?: string | null } | null;
  AccountGroup?: { id: string; name?: string | null } | null;
};

type Props = {
  open: boolean;
  items: StockImportUploadItem[];
  context: StockImportDialogContext | null;
  onClose: () => void;
  onImported?: (result: { created: number; skipped: number; accountIds: string[] }) => void;
};

function formatText(t: TranslateFn, key: string, values?: Record<string, string | number>) {
  let text = t(key);
  if (!values) return text;
  for (const [name, value] of Object.entries(values)) {
    text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

function formatOptionalNumber(value: number | null | undefined, digits = 2) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "-";
}

function stockIssueMessage(issue: StockImportPreviewIssue, t: TranslateFn) {
  const key = issue.code ? `viewImport.stockPreview.issue.${issue.code}` : "";
  if (key) {
    const translated = t(key);
    if (translated && translated !== key) return translated;
  }
  return issue.message || issue.code || "-";
}

function stockActionLabel(action: string, t: TranslateFn) {
  if (action === "bank_transfer") return t("viewImport.stockActionBankTransfer");
  const key = `stockPanel.action.${action}`;
  const label = t(key);
  return label === key ? action || "-" : label;
}

function stockImportMarketLabel(market: string, t: TranslateFn) {
  const value = market || "CN";
  const key = `stockFee.scope.${value}`;
  const label = t(key);
  return label === key ? value : `${label} (${value})`;
}

function stockImportMarketDisplayValue(market: string | undefined, exchange: string | null | undefined) {
  const normalizedExchange = String(exchange ?? "").trim().toUpperCase();
  if ((market || "CN") === "CN" && ["SH", "SZ", "BJ"].includes(normalizedExchange)) {
    return `CN_${normalizedExchange}`;
  }
  return market || "CN";
}

function selectableIndexes(items: StockImportPreviewItem[]) {
  return new Set(items.map((_, index) => index));
}

function isValidDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function applyStockSettleDateOffset(item: StockImportUploadItem, value: string) {
  const offset = evaluateCalcInputExpression(value, 0);
  if (offset == null || !Number.isInteger(offset) || offset < 0) return undefined;
  const tradeDate = String(item.tradeDate ?? "").trim();
  if (!isValidDate(tradeDate)) return undefined;
  return addTradingDaysUtc(tradeDate, offset);
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function parseDraftNumber(value: string) {
  const text = value.trim();
  if (!text) return null;
  const parsed = Number(text.replace(/[,，￥¥\s]/g, ""));
  return Number.isFinite(parsed) ? Math.abs(parsed) : null;
}

function isBuySellAction(action: string) {
  return action === "buy" || action === "sell";
}

function isCashLikeAccount(account: BookAccount) {
  return account.kind === "cash" || account.kind === "bank_debit" || account.kind === "ewallet";
}

function isStockAccount(account: BookAccount) {
  return account.kind === "investment" && account.investProductType === "stock";
}

const STOCK_PREVIEW_ACTIONS = [
  "buy",
  "sell",
  "dividend",
  "bonus_share",
  "split_share",
  "merge_share",
  "fee_adjustment",
  "tax_adjustment",
  "bank_transfer",
] as const;

const STOCK_PREVIEW_MARKETS = ["CN_SH", "CN_SZ", "CN_BJ", "CN", "HK", "US"] as const;

const STOCK_PREVIEW_COMPONENT_FEE_FIELDS = [
  "commission",
  "stampTax",
  "transferFee",
  "exchangeFee",
  "regulatoryFee",
  "otherFee",
] as const;

const STOCK_PREVIEW_FIELD_LABEL_KEYS: Record<StockPreviewEditField, string> = {
  tradeDate: "detail.column.date",
  settleDate: "stockTx.settleDateLabel",
  stockAccount: "viewImport.stockAccount",
  action: "depositShell.colAction",
  market: "reports.stock.market",
  stockCode: "stockTx.stockCodeLabel",
  quantity: "stockHoldingReport.colQuantity",
  price: "stockPanel.colPrice",
  grossAmount: "stockPanel.colGrossAmount",
  netAmount: "stockTx.netAmountLabel",
  bankAccount: "viewImport.bankAccount",
  fee: "stockPanel.colFee",
  commission: "stockFee.feeType.commission",
  stampTax: "stockFee.feeType.stamp_tax",
  transferFee: "stockFee.feeType.transfer_fee",
  exchangeFee: "stockFee.feeType.exchange_fee",
  regulatoryFee: "stockFee.feeType.regulatory_fee",
  otherFee: "stockFee.feeType.other",
  note: "detail.column.remark",
  tags: "detail.column.tags",
};

export function StockImportPreviewDialog({ open, items, context, onClose, onImported }: Props) {
  const { t } = useI18n();
  const [uploadItems, setUploadItems] = useState<StockImportUploadItem[]>([]);
  const [previewItems, setPreviewItems] = useState<StockImportPreviewItem[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ imported: number; total: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [debugMessage, setDebugMessage] = useState<string | null>(null);
  const [editingCell, setEditingCell] = useState<{ idx: number; field: StockPreviewEditField } | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [draftOriginalValue, setDraftOriginalValue] = useState("");
  const [bookAccounts, setBookAccounts] = useState<BookAccount[]>([]);
  const skipNextEditCommitRef = useRef(false);

  const previewRows = useMemo<StockPreviewTableRow[]>(
    () => previewItems.map((item, idx) => ({ ...item, idx })),
    [previewItems],
  );
  const selectedKeys = useMemo(() => new Set(Array.from(selected).map((idx) => String(idx))), [selected]);
  const importIssues = useMemo(() => (
    Array.from(selected)
      .flatMap((idx) => (previewItems[idx]?.issues ?? []).map((issue) => ({
        idx,
        ...issue,
        message: stockIssueMessage(issue, t),
      })))
  ), [previewItems, selected, t]);
  const errorIssues = useMemo(() => importIssues.filter((issue) => issue.level === "error"), [importIssues]);
  const allImportIssues = useMemo(() => (
    previewItems.flatMap((item, idx) => item.issues.map((issue) => ({
      idx,
      ...issue,
      message: stockIssueMessage(issue, t),
    })))
  ), [previewItems, t]);
  const allErrorIssues = useMemo(() => allImportIssues.filter((issue) => issue.level === "error"), [allImportIssues]);
  const allWarningIssues = useMemo(() => allImportIssues.filter((issue) => issue.level === "warning"), [allImportIssues]);
  const previewErrorText = useMemo(() => {
    if (allErrorIssues.length === 0) return "";
    const preview = allErrorIssues
      .slice(0, 6)
      .map((rowIssue) => formatText(t, "batchImport.issueLine", {
        index: rowIssue.idx + 1,
        level: t("batchImport.levelError"),
        message: rowIssue.message,
      }))
      .join("; ");
    const more = allErrorIssues.length > 6
      ? formatText(t, "batchImport.previewBlockingMore", { count: allErrorIssues.length - 6 })
      : "";
    return `${preview}${more}`;
  }, [allErrorIssues, t]);
  const previewWarningText = useMemo(() => {
    if (allWarningIssues.length === 0) return "";
    const preview = allWarningIssues
      .slice(0, 4)
      .map((rowIssue) => formatText(t, "batchImport.issueLine", {
        index: rowIssue.idx + 1,
        level: t("batchImport.levelWarning"),
        message: rowIssue.message,
      }))
      .join("; ");
    const more = allWarningIssues.length > 4
      ? formatText(t, "batchImport.previewWarningMore", { count: allWarningIssues.length - 4 })
      : "";
    return `${preview}${more}`;
  }, [allWarningIssues, t]);
  const stockAccountDisplayOptions = useMemo<AccountDisplayOption[]>(
    () => restrictAccountsByType(bookAccounts, isStockAccount)
      .map((account) => buildAccountDisplayOption({
        ...account,
        Institution: account.Institution
          ? {
              name: account.Institution.name ?? null,
              shortName: account.Institution.shortName ?? null,
            }
          : null,
        AccountGroup: account.AccountGroup
          ? {
              id: account.AccountGroup.id,
              name: account.AccountGroup.name ?? null,
            }
          : null,
      }, undefined, { fields: getAccountLabelFieldsPreference() }))
      .sort((a, b) => a.selectorLabel.localeCompare(b.selectorLabel, "zh-Hans-CN")),
    [bookAccounts],
  );
  const stockAccountDisplayById = useMemo(
    () => new Map(stockAccountDisplayOptions.map((account) => [account.id, account])),
    [stockAccountDisplayOptions],
  );
  const stockAccountOptions = useMemo(() => buildGroupedAccountOptions(stockAccountDisplayOptions), [stockAccountDisplayOptions]);
  const stockAccountBatchOptions = useMemo(
    () => stockAccountOptions.map((option) => ({
      value: option.id,
      label: option.label,
      subLabel: option.subLabel,
      title: option.title,
      color: option.color,
      isHeader: option.isHeader,
      isGroup: option.isGroup,
      parentId: option.parentId,
      kind: option.kind,
      investProductType: option.investProductType,
      institutionId: option.institutionId,
      currency: option.currency,
    })),
    [stockAccountOptions],
  );
  const bankAccountDisplayOptions = useMemo<AccountDisplayOption[]>(
    () => restrictAccountsByType(bookAccounts, isCashLikeAccount)
      .map((account) => buildAccountDisplayOption({
        ...account,
        Institution: account.Institution
          ? {
              name: account.Institution.name ?? null,
              shortName: account.Institution.shortName ?? null,
            }
          : null,
        AccountGroup: account.AccountGroup
          ? {
              id: account.AccountGroup.id,
              name: account.AccountGroup.name ?? null,
            }
          : null,
      }, undefined, { fields: getAccountLabelFieldsPreference() }))
      .sort((a, b) => a.selectorLabel.localeCompare(b.selectorLabel, "zh-Hans-CN")),
    [bookAccounts],
  );
  const bankAccountDisplayById = useMemo(
    () => new Map(bankAccountDisplayOptions.map((account) => [account.id, account])),
    [bankAccountDisplayOptions],
  );
  const bankAccountOptions = useMemo(() => buildGroupedAccountOptions(bankAccountDisplayOptions), [bankAccountDisplayOptions]);
  const bankAccountBatchOptions = useMemo(
    () => bankAccountOptions.map((option) => ({
      value: option.id,
      label: option.label,
      subLabel: option.subLabel,
      title: option.title,
      color: option.color,
      isHeader: option.isHeader,
      isGroup: option.isGroup,
      parentId: option.parentId,
      kind: option.kind,
      investProductType: option.investProductType,
      institutionId: option.institutionId,
      currency: option.currency,
    })),
    [bankAccountOptions],
  );

  const requestPreview = useCallback(async (sourceItems: StockImportUploadItem[], preserveSelection: boolean) => {
    setUploading(true);
    try {
      const res = await fetch("/api/v1/stocks/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "preview",
          context: context ?? null,
          items: sourceItems,
        }),
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; items?: StockImportPreviewItem[] } | null;
      if (!res.ok || !data?.ok || !Array.isArray(data.items)) {
        throw new Error(data?.error || res.statusText || `HTTP ${res.status}`);
      }
      setPreviewItems(data.items);
      setSelected((prev) => preserveSelection
        ? new Set(Array.from(prev).filter((idx) => idx < data.items!.length))
        : selectableIndexes(data.items!));
      setDebugMessage(null);
      setMessage(null);
      return true;
    } catch (error) {
      setPreviewItems([]);
      setSelected(new Set());
      const reason = error instanceof Error ? error.message : String(error);
      setDebugMessage(reason || t("batchImport.unknownError"));
      setMessage(formatText(t, "viewImport.stockPreview.previewFailed", { reason: reason || t("batchImport.unknownError") }));
      return false;
    } finally {
      setUploading(false);
    }
  }, [context, t]);

  useEffect(() => {
    if (!open) {
      setUploadItems([]);
      setPreviewItems([]);
      setSelected(new Set());
      setUploading(false);
      setImporting(false);
      setMessage(null);
      setDebugMessage(null);
      setEditingCell(null);
      setDraftValue("");
      setDraftOriginalValue("");
      return;
    }
    const nextItems = items.map((item) => ({ ...item }));
    setUploadItems(nextItems);
    setPreviewItems([]);
    setSelected(new Set());
    setEditingCell(null);
    setDraftValue("");
    setDraftOriginalValue("");
    setMessage(formatText(t, "viewImport.stockPreview.parsing", { count: nextItems.length }));
    void requestPreview(nextItems, false);
  }, [items, open, requestPreview, t]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchSettingsBootstrap()
      .then((bootstrap) => {
        if (cancelled) return;
        setBookAccounts(Array.isArray(bootstrap.accounts) ? bootstrap.accounts as BookAccount[] : []);
      })
      .catch(() => {
        if (cancelled) return;
        setBookAccounts([]);
      });
    return () => { cancelled = true; };
  }, [open]);

  const previewReplaceFields = useMemo<BatchReplaceFieldConfig<StockPreviewBatchEditField>[]>(() => [
    {
      value: "fee",
      label: t("stockPanel.colFee"),
      kind: "number",
      placeholder: t("batchImport.numberExpressionPlaceholder"),
    },
    {
      value: "settleDate",
      label: t("viewImport.stockPreview.settleDateOffset"),
      kind: "number",
      placeholder: t("batchImport.fundPreview.dateOffsetPlaceholder"),
    },
    {
      value: "stockAccount",
      label: t("viewImport.stockAccount"),
      kind: "smartSelect",
      options: stockAccountBatchOptions,
      placeholder: t("viewImport.stockPreview.stockAccountPlaceholder"),
      smartSelectBehavior: {
        search: true,
        hierarchy: true,
        clearable: true,
        minDropdownWidth: 260,
        fitContent: true,
        dropdownMaxHeight: 260,
        density: "micro",
        resizableDropdown: true,
      },
    },
    {
      value: "bankAccount",
      label: t("viewImport.bankAccount"),
      kind: "smartSelect",
      options: bankAccountBatchOptions,
      placeholder: t("viewImport.stockPreview.bankAccountPlaceholder"),
      smartSelectBehavior: {
        search: true,
        hierarchy: true,
        clearable: true,
        minDropdownWidth: 260,
        fitContent: true,
        dropdownMaxHeight: 260,
        density: "micro",
        resizableDropdown: true,
      },
    },
  ], [bankAccountBatchOptions, stockAccountBatchOptions, t]);

  const applyPreviewReplace = useCallback(async (field: StockPreviewBatchEditField, value: string) => {
    const selectedIndexes = new Set(Array.from(selected).filter((idx) => uploadItems[idx]));
    if (selectedIndexes.size === 0) throw new Error(t("viewImport.stockPreview.selectRowsFirst"));
    let changed = 0;
    let invalid = 0;
    const nextUploadItems = uploadItems.map((item, index) => {
      if (!selectedIndexes.has(index)) return item;
      if (field === "fee") {
        const current = previewItems[index]?.fee ?? item.fee ?? 0;
        const nextFee = evaluateCalcInputExpression(value, current);
        if (nextFee == null || nextFee < 0) {
          invalid += 1;
          return item;
        }
        changed += 1;
        return { ...item, fee: Number(nextFee.toFixed(2)) };
      }
      if (field === "settleDate") {
        const nextDate = applyStockSettleDateOffset(item, value);
        if (nextDate === undefined) {
          invalid += 1;
          return item;
        }
        changed += 1;
        return { ...item, settleDate: nextDate };
      }
      if (field === "stockAccount") {
        const account = stockAccountDisplayById.get(value);
        if (!account) {
          invalid += 1;
          return item;
        }
        changed += 1;
        return {
          ...item,
          stockAccount: account.selectorLabel,
          stockAccountId: account.id,
          accountId: account.id,
        };
      }
      const account = bankAccountDisplayById.get(value);
      if (!account) {
        invalid += 1;
        return item;
      }
      changed += 1;
      return {
        ...item,
        bankAccount: account.selectorLabel,
        bankAccountId: account.id,
        cashAccountId: account.id,
      };
    });
    setUploadItems(nextUploadItems);
    await requestPreview(nextUploadItems, true);
    const fieldLabel = field === "fee"
      ? t("stockPanel.colFee")
      : field === "settleDate"
        ? t("viewImport.stockPreview.settleDateOffset")
        : field === "stockAccount"
          ? t("viewImport.stockAccount")
          : t("viewImport.bankAccount");
    const invalidSuffix = invalid > 0 ? t("viewImport.stockPreview.invalidRowsSkipped", { count: invalid }) : "";
    return t("viewImport.stockPreview.batchReplaceResult", { count: changed, field: fieldLabel, invalidSuffix });
  }, [bankAccountDisplayById, previewItems, requestPreview, selected, stockAccountDisplayById, t, uploadItems]);

  const handleImport = useCallback(async () => {
    if (importing) return;
    const selectedIndexes = Array.from(selected).sort((a, b) => a - b);
    const selectedItems = selectedIndexes.map((idx) => previewItems[idx]).filter(Boolean);
    if (selectedItems.length === 0) return;
    if (errorIssues.length > 0) {
      const preview = errorIssues
        .slice(0, 5)
        .map((rowIssue) => formatText(t, "batchImport.issueLine", {
          index: rowIssue.idx + 1,
          level: t("batchImport.levelError"),
          message: rowIssue.message,
        }))
        .join("; ");
      setMessage(formatText(t, "batchImport.importValidationFailed", {
        count: errorIssues.length,
        preview,
        more: errorIssues.length > 5 ? t("batchImport.importValidationMore") : "",
      }));
      return;
    }

    setImporting(true);
    setMessage(formatText(t, "viewImport.stockPreview.importingSelected", { count: selectedItems.length }));
    setDebugMessage(null);
    setImportProgress({ imported: 0, total: selectedItems.length });
    let created = 0;
    let skipped = 0;
    let importedRows = 0;
    const accountIds = new Set<string>();
    // Submit in ~10 sequential batches so each request finishes well before
    // reverse-proxy timeouts on slow NAS deployments; the server skips rows
    // whose externalLinkId already exists, so completed batches are stable.
    const IMPORT_BATCH_SIZE = Math.max(1, Math.ceil(selectedItems.length / 10));
    try {
      for (let start = 0; start < selectedItems.length; start += IMPORT_BATCH_SIZE) {
        const batchItems = selectedItems.slice(start, start + IMPORT_BATCH_SIZE);
        setImportProgress({ imported: importedRows, total: selectedItems.length });
        const res = await fetch("/api/v1/stocks/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "import",
            context: context ?? null,
            items: batchItems,
          }),
        });
        const data = await res.json().catch(() => null) as { ok?: boolean; error?: string; createdCount?: number; skippedCount?: number; accountIds?: string[] } | null;
        if (!res.ok || !data?.ok) {
          throw new Error(data?.error || res.statusText || `HTTP ${res.status}`);
        }
        created += data.createdCount ?? 0;
        skipped += data.skippedCount ?? 0;
        for (const id of Array.isArray(data.accountIds) ? data.accountIds : []) accountIds.add(id);
        importedRows += batchItems.length;
      }
      const effectiveAccountIds = accountIds.size > 0
        ? Array.from(accountIds)
        : [context?.stockAccountId].filter((id): id is string => Boolean(id));
      dispatchFinanceDataChanged({ reason: "stock-excel-import", accountIds: effectiveAccountIds });
      onImported?.({ created, skipped, accountIds: effectiveAccountIds });
      onClose();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (created + skipped > 0) {
        setMessage(formatText(t, "viewImport.stockPreview.importPartialFailed", {
          imported: created,
          remaining: selectedItems.length - importedRows,
          reason,
        }));
      } else {
        setMessage(formatText(t, "batchImport.importFailedRollback", { reason }));
      }
    } finally {
      setImporting(false);
      setImportProgress(null);
    }
  }, [context, errorIssues, importing, onClose, onImported, previewItems, selected, t, setImportProgress]);

  const patchUploadItem = useCallback(async (idx: number, patch: Partial<StockImportUploadItem>) => {
    const nextUploadItems = uploadItems.map((item, index) => index === idx ? { ...item, ...patch } : item);
    setUploadItems(nextUploadItems);
    setEditingCell(null);
    setDraftValue("");
    setDraftOriginalValue("");
    await requestPreview(nextUploadItems, true);
  }, [requestPreview, uploadItems]);

  const editFieldLabel = useCallback((field: StockPreviewEditField) => t(STOCK_PREVIEW_FIELD_LABEL_KEYS[field]), [t]);

  const editTitle = useCallback(
    (field: StockPreviewEditField, extra?: string) => {
      const base = t("statementImportPreview.doubleClickEdit", { field: editFieldLabel(field) });
      return extra ? `${base}\n${extra}` : base;
    },
    [editFieldLabel, t],
  );

  function draftValueFromRow(row: StockPreviewTableRow, field: StockPreviewEditField) {
    switch (field) {
      case "tradeDate": return row.tradeDate || "";
      case "settleDate": return row.settleDate || "";
      case "stockAccount": return row.stockAccountName || row.stockAccount || "";
      case "action": return row.action || "";
      case "market": return row.market || "";
      case "stockCode": return row.stockCode || "";
      case "quantity": return row.quantity == null ? "" : String(row.quantity);
      case "price": return row.price == null ? "" : String(row.price);
      case "grossAmount": return row.grossAmount == null ? "" : String(row.grossAmount);
      case "netAmount": return row.netAmount == null ? "" : String(row.netAmount);
      case "bankAccount": return row.bankAccount || "";
      case "fee": return row.fee == null ? (row.totalFee ? String(row.totalFee) : "") : String(row.fee);
      case "commission": return row.commission == null ? "" : String(row.commission);
      case "stampTax": return row.stampTax == null ? "" : String(row.stampTax);
      case "transferFee": return row.transferFee == null ? "" : String(row.transferFee);
      case "exchangeFee": return row.exchangeFee == null ? "" : String(row.exchangeFee);
      case "regulatoryFee": return row.regulatoryFee == null ? "" : String(row.regulatoryFee);
      case "otherFee": return row.otherFee == null ? "" : String(row.otherFee);
      case "note": return row.note || "";
      case "tags": return row.tags || "";
      default: return "";
    }
  }

  const beginCellEdit = useCallback((row: StockPreviewTableRow, field: StockPreviewEditField) => {
    if (uploading || importing) return;
    if (field === "grossAmount" && isBuySellAction(row.action)) return;
    skipNextEditCommitRef.current = false;
    const nextDraftValue = draftValueFromRow(row, field);
    setEditingCell({ idx: row.idx, field });
    setDraftValue(nextDraftValue);
    setDraftOriginalValue(nextDraftValue);
  }, [importing, uploading]);

  const commitDraftEdit = useCallback(async () => {
    if (skipNextEditCommitRef.current) {
      skipNextEditCommitRef.current = false;
      return;
    }
    const current = editingCell;
    if (!current) return;
    const value = draftValue.trim();
    if (value === draftOriginalValue.trim()) {
      setEditingCell(null);
      setDraftValue("");
      setDraftOriginalValue("");
      return;
    }
    let patch: Partial<StockImportUploadItem> | null = null;
    switch (current.field) {
      case "tradeDate":
        patch = { tradeDate: value };
        break;
      case "settleDate":
        patch = { settleDate: value || null };
        break;
      case "stockAccount":
        patch = { stockAccount: value, stockAccountId: null, accountId: null };
        break;
      case "action":
        patch = { action: value };
        break;
      case "market":
        patch = { market: value || undefined };
        break;
      case "stockCode":
        patch = { stockCode: value };
        break;
      case "quantity":
        patch = { quantity: parseDraftNumber(value) };
        break;
      case "price":
        patch = { price: parseDraftNumber(value) };
        break;
      case "grossAmount":
        patch = { grossAmount: parseDraftNumber(value) };
        break;
      case "netAmount":
        patch = { netAmount: parseDraftNumber(value) };
        break;
      case "fee": {
        const fee = parseDraftNumber(value);
        patch = fee == null
          ? { fee: null }
          : {
              fee,
              commission: null,
              stampTax: null,
              transferFee: null,
              exchangeFee: null,
              regulatoryFee: null,
              otherFee: null,
            };
        break;
      }
      case "commission":
        patch = { commission: parseDraftNumber(value), fee: null };
        break;
      case "stampTax":
        patch = { stampTax: parseDraftNumber(value), fee: null };
        break;
      case "transferFee":
        patch = { transferFee: parseDraftNumber(value), fee: null };
        break;
      case "exchangeFee":
        patch = { exchangeFee: parseDraftNumber(value), fee: null };
        break;
      case "regulatoryFee":
        patch = { regulatoryFee: parseDraftNumber(value), fee: null };
        break;
      case "otherFee":
        patch = { otherFee: parseDraftNumber(value), fee: null };
        break;
      case "note":
        patch = { note: value || null };
        break;
      case "tags":
        patch = { tags: value || null };
        break;
      case "bankAccount":
        patch = { bankAccount: value, bankAccountId: null };
        break;
      default:
        patch = null;
    }
    if (!patch) {
      setEditingCell(null);
      setDraftValue("");
      setDraftOriginalValue("");
      return;
    }
    await patchUploadItem(current.idx, patch);
  }, [draftOriginalValue, draftValue, editingCell, patchUploadItem]);

  function cancelDraftEdit() {
    skipNextEditCommitRef.current = true;
    setEditingCell(null);
    setDraftValue("");
    setDraftOriginalValue("");
  }

  function stopCellEvent(event: ReactMouseEvent<HTMLElement>) {
    event.stopPropagation();
  }

  function editableCellProps(row: StockPreviewTableRow, field: StockPreviewEditField) {
    return {
      "data-row-double-click-ignore": true,
      onMouseDown: stopCellEvent,
      onClick: stopCellEvent,
      onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
        event.stopPropagation();
        beginCellEdit(row, field);
      },
    };
  }

  function editableInputProps(field: StockPreviewEditField) {
    return {
      "data-row-double-click-ignore": true,
      autoFocus: true,
      onMouseDown: stopCellEvent,
      onClick: stopCellEvent,
      onDoubleClick: stopCellEvent,
      onFocus: (event: ReactFocusEvent<HTMLInputElement>) => event.currentTarget.select(),
      onChange: (event: ReactChangeEvent<HTMLInputElement>) => setDraftValue(event.target.value),
      onBlur: () => void commitDraftEdit(),
      onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") cancelDraftEdit();
      },
      className: [
        "h-7 rounded-md border border-blue-200 bg-white px-2 text-xs outline-none",
        field === "note" || field === "stockCode" || field === "tags" ? "w-full" : "w-24",
        field === "quantity" || field === "price" || field === "grossAmount" || field === "netAmount" || field === "fee" || STOCK_PREVIEW_COMPONENT_FEE_FIELDS.includes(field as typeof STOCK_PREVIEW_COMPONENT_FEE_FIELDS[number])
          ? "text-right tabular-nums"
          : "",
      ].filter(Boolean).join(" "),
    };
  }

  function renderTextCell(row: StockPreviewTableRow, field: StockPreviewEditField, value: string | null | undefined, className = "text-slate-700") {
    const isEditing = editingCell?.idx === row.idx && editingCell.field === field;
    if (isEditing) {
      return (
        <input
          type={field === "tradeDate" || field === "settleDate" ? "date" : "text"}
          value={draftValue}
          {...editableInputProps(field)}
        />
      );
    }
    return (
      <span
        className={`block min-h-5 w-full truncate cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100 ${className}`}
        title={editTitle(field)}
        {...editableCellProps(row, field)}
      >
        {cleanText(value) || "-"}
      </span>
    );
  }

  function renderNumberCell(
    row: StockPreviewTableRow,
    field: StockPreviewEditField,
    value: number | null | undefined,
    digits = 2,
    calculatedField?: StockImportCalculatedField,
    editable = true,
  ) {
    const isEditing = editable && editingCell?.idx === row.idx && editingCell.field === field;
    if (isEditing) {
      return (
        <input
          type="text"
          inputMode="decimal"
          value={draftValue}
          {...editableInputProps(field)}
        />
      );
    }
    const calculated = calculatedField ? row.calculatedFields?.includes(calculatedField) ?? false : false;
    return (
      <span
        className={`block min-h-5 w-full rounded px-1 py-0.5 text-right tabular-nums ${editable ? "cursor-pointer hover:bg-slate-100" : ""} ${calculated ? "italic text-slate-500" : "text-slate-700"}`}
        title={editable ? editTitle(field, calculated ? t("viewImport.calculatedValue") : undefined) : (calculated ? t("viewImport.calculatedValue") : undefined)}
        {...(editable ? editableCellProps(row, field) : {})}
      >
        {formatOptionalNumber(value, digits)}
      </span>
    );
  }

  function renderActionCell(row: StockPreviewTableRow) {
    if (editingCell?.idx === row.idx && editingCell.field === "action") {
      return (
        <select
          data-row-double-click-ignore
          autoFocus
          className="h-7 w-full rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
          value={row.action}
          onMouseDown={stopCellEvent}
          onClick={stopCellEvent}
          onDoubleClick={stopCellEvent}
          onBlur={() => setEditingCell(null)}
          onChange={(event) => void patchUploadItem(row.idx, { action: event.target.value })}
        >
          {STOCK_PREVIEW_ACTIONS.map((action) => (
            <option key={action} value={action}>{stockActionLabel(action, t)}</option>
          ))}
        </select>
      );
    }
    return renderTextCell(row, "action", stockActionLabel(row.action, t));
  }

  function renderMarketCell(row: StockPreviewTableRow) {
    const currentMarket = stockImportMarketDisplayValue(row.market, row.exchange);
    const marketOptions = Array.from(new Set([currentMarket, ...STOCK_PREVIEW_MARKETS].filter(Boolean)));
    if (editingCell?.idx === row.idx && editingCell.field === "market") {
      return (
        <select
          data-row-double-click-ignore
          autoFocus
          className="h-7 w-full rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
          value={currentMarket}
          onMouseDown={stopCellEvent}
          onClick={stopCellEvent}
          onDoubleClick={stopCellEvent}
          onBlur={() => setEditingCell(null)}
          onChange={(event) => void patchUploadItem(row.idx, { market: event.target.value })}
        >
          {marketOptions.map((market) => <option key={market} value={market}>{stockImportMarketLabel(market, t)}</option>)}
        </select>
      );
    }
    return renderTextCell(row, "market", stockImportMarketLabel(currentMarket, t));
  }

  function renderStockAccountCell(row: StockPreviewTableRow) {
    const display = stockAccountDisplayById.get(row.stockAccountId ?? "")?.selectorLabel
      ?? row.stockAccountName
      ?? row.stockAccount
      ?? "";
    if (editingCell?.idx === row.idx && editingCell.field === "stockAccount") {
      return (
        <div data-row-double-click-ignore onMouseDown={stopCellEvent} onClick={stopCellEvent} onDoubleClick={stopCellEvent}>
          <SmartSelect
            mode="single"
            value={row.stockAccountId ?? ""}
            onChange={(accountId) => {
              const account = stockAccountDisplayById.get(accountId);
              void patchUploadItem(row.idx, {
                stockAccountId: accountId || null,
                accountId: accountId || null,
                stockAccount: account?.selectorLabel ?? "",
              });
            }}
            options={stockAccountOptions}
            placeholder={t("viewImport.stockPreview.stockAccountPlaceholder")}
            behavior={{
              search: true,
              hierarchy: true,
              clearable: true,
              minDropdownWidth: 240,
              fitContent: true,
              dropdownMaxHeight: 220,
              density: "micro",
              resizableDropdown: true,
              autoOpen: true,
              onDropdownClose: () => setEditingCell(null),
            }}
          />
        </div>
      );
    }
    return (
      <span
        className="block min-h-5 w-full truncate cursor-pointer rounded px-1 py-0.5 text-slate-700 hover:bg-slate-100"
        title={row.stockAccountId ? stockAccountDisplayById.get(row.stockAccountId)?.hoverTitle ?? display : editTitle("stockAccount")}
        {...editableCellProps(row, "stockAccount")}
      >
        {display || "-"}
      </span>
    );
  }

  function renderBankAccountCell(row: StockPreviewTableRow) {
    if (editingCell?.idx === row.idx && editingCell.field === "bankAccount") {
      return (
        <div data-row-double-click-ignore onMouseDown={stopCellEvent} onClick={stopCellEvent} onDoubleClick={stopCellEvent}>
          <SmartSelect
            mode="single"
            value={row.bankAccountId ?? ""}
            onChange={(accountId) => {
              const account = bankAccountDisplayById.get(accountId);
              void patchUploadItem(row.idx, {
                bankAccountId: accountId || null,
                bankAccount: account?.selectorLabel ?? "",
              });
            }}
            options={bankAccountOptions}
            placeholder={t("viewImport.stockPreview.bankAccountPlaceholder")}
            behavior={{
              search: true,
              hierarchy: true,
              clearable: true,
              minDropdownWidth: 240,
              fitContent: true,
              dropdownMaxHeight: 220,
              density: "micro",
              resizableDropdown: true,
              autoOpen: true,
              onDropdownClose: () => setEditingCell(null),
            }}
          />
        </div>
      );
    }
    return (
      <span
        className="block min-h-5 w-full truncate cursor-pointer rounded px-1 py-0.5 text-slate-700 hover:bg-slate-100"
        title={row.bankAccountId ? bankAccountDisplayById.get(row.bankAccountId)?.hoverTitle ?? row.bankAccount : editTitle("bankAccount")}
        {...editableCellProps(row, "bankAccount")}
      >
        {row.bankAccount || "-"}
      </span>
    );
  }

  const columns = useMemo<AdvancedDataTableColumn<StockPreviewTableRow>[]>(() => [
    {
      key: "status",
      label: "",
      width: 42,
      minWidth: 36,
      align: "center",
      filterText: (row) => row.issues.some((item) => item.level === "error") ? t("batchImport.levelError") : row.issues.some((item) => item.level === "warning") ? t("batchImport.levelWarning") : t("batchImport.levelNormal"),
      render: (row) => {
        const rowHasError = row.issues.some((item) => item.level === "error");
        const rowHasWarning = row.issues.some((item) => item.level === "warning");
        if (row.issues.length === 0) return <span className="text-[11px] text-slate-400">{row.idx + 1}</span>;
        return (
          <span
            className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold leading-none text-white ${rowHasError ? "bg-red-500" : rowHasWarning ? "bg-amber-500" : "bg-slate-300"}`}
            title={row.issues.map((item) => stockIssueMessage(item, t)).join("; ")}
          >
            !
          </span>
        );
      },
    },
    { key: "stockAccount", label: t("viewImport.stockAccount"), width: 180, minWidth: 130, filterText: (row) => row.stockAccountName || row.stockAccount || "-", render: renderStockAccountCell },
    { key: "tradeDate", label: t("detail.column.date"), width: 112, minWidth: 92, filterKind: "dateRange", filterText: (row) => row.tradeDate || "-", sortValue: (row) => row.tradeDate || "", render: (row) => renderTextCell(row, "tradeDate", row.tradeDate, "tabular-nums text-slate-700") },
    { key: "settleDate", label: t("stockTx.settleDateLabel"), width: 112, minWidth: 92, filterKind: "dateRange", filterText: (row) => row.settleDate || "-", sortValue: (row) => row.settleDate || "", render: (row) => renderTextCell(row, "settleDate", row.settleDate, "tabular-nums text-slate-700") },
    { key: "action", label: t("depositShell.colAction"), width: 116, minWidth: 92, filterText: (row) => stockActionLabel(row.action, t), render: renderActionCell },
    { key: "market", label: t("reports.stock.market"), width: 112, minWidth: 86, filterText: (row) => stockImportMarketLabel(stockImportMarketDisplayValue(row.market, row.exchange), t), render: renderMarketCell },
    { key: "stockCode", label: t("stockTx.stockCodeLabel"), width: 96, minWidth: 76, filterText: (row) => row.stockCode || "-", render: (row) => renderTextCell(row, "stockCode", row.stockCode, "tabular-nums text-slate-700") },
    { key: "stockName", label: t("stockTx.stockNameLabel"), width: 200, minWidth: 140, filterText: (row) => row.stockName || "-", render: (row) => <span className="truncate text-slate-700" title={row.stockName || ""}>{row.stockName || "-"}</span> },
    { key: "quantity", label: t("stockHoldingReport.colQuantity"), width: 116, minWidth: 92, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.quantity, 2), filterNumber: (row) => row.quantity, sortValue: (row) => row.quantity ?? 0, render: (row) => renderNumberCell(row, "quantity", row.quantity, 2) },
    { key: "price", label: t("stockPanel.colPrice"), width: 96, minWidth: 78, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.price, 4), filterNumber: (row) => row.price, sortValue: (row) => row.price ?? 0, render: (row) => renderNumberCell(row, "price", row.price, 4, "price") },
    { key: "grossAmount", label: t("stockPanel.colGrossAmount"), width: 116, minWidth: 92, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.grossAmount, 2), filterNumber: (row) => row.grossAmount, sortValue: (row) => row.grossAmount ?? 0, render: (row) => renderNumberCell(row, "grossAmount", row.grossAmount, 2, "grossAmount", !isBuySellAction(row.action)) },
    { key: "netAmount", label: t("stockTx.netAmountLabel"), width: 116, minWidth: 92, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.netAmount, 2), filterNumber: (row) => row.netAmount, sortValue: (row) => row.netAmount ?? 0, render: (row) => renderNumberCell(row, "netAmount", row.netAmount, 2, "netAmount") },
    { key: "bankAccount", label: t("viewImport.bankAccount"), width: 180, minWidth: 130, filterText: (row) => row.bankAccount || "-", render: renderBankAccountCell },
    { key: "totalFee", label: t("stockPanel.colFee"), width: 96, minWidth: 78, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.totalFee, 2), filterNumber: (row) => row.totalFee, sortValue: (row) => row.totalFee ?? 0, render: (row) => renderNumberCell(row, "fee", row.totalFee, 2, "totalFee") },
    { key: "commission", label: t("stockFee.feeType.commission"), width: 92, minWidth: 74, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.commission, 2), filterNumber: (row) => row.commission, sortValue: (row) => row.commission ?? 0, render: (row) => renderNumberCell(row, "commission", row.commission, 2, "commission") },
    { key: "stampTax", label: t("stockFee.feeType.stamp_tax"), width: 92, minWidth: 74, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.stampTax, 2), filterNumber: (row) => row.stampTax, sortValue: (row) => row.stampTax ?? 0, render: (row) => renderNumberCell(row, "stampTax", row.stampTax, 2, "stampTax") },
    { key: "transferFee", label: t("stockFee.feeType.transfer_fee"), width: 92, minWidth: 74, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.transferFee, 2), filterNumber: (row) => row.transferFee, sortValue: (row) => row.transferFee ?? 0, render: (row) => renderNumberCell(row, "transferFee", row.transferFee, 2, "transferFee") },
    { key: "exchangeFee", label: t("stockFee.feeType.exchange_fee"), width: 92, minWidth: 74, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.exchangeFee, 2), filterNumber: (row) => row.exchangeFee, sortValue: (row) => row.exchangeFee ?? 0, render: (row) => renderNumberCell(row, "exchangeFee", row.exchangeFee, 2, "exchangeFee") },
    { key: "regulatoryFee", label: t("stockFee.feeType.regulatory_fee"), width: 92, minWidth: 74, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.regulatoryFee, 2), filterNumber: (row) => row.regulatoryFee, sortValue: (row) => row.regulatoryFee ?? 0, render: (row) => renderNumberCell(row, "regulatoryFee", row.regulatoryFee, 2, "regulatoryFee") },
    { key: "otherFee", label: t("stockFee.feeType.other"), width: 92, minWidth: 74, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.otherFee, 2), filterNumber: (row) => row.otherFee, sortValue: (row) => row.otherFee ?? 0, render: (row) => renderNumberCell(row, "otherFee", row.otherFee, 2, "otherFee") },
    { key: "cashAmount", label: t("viewImport.stockPreview.cashAmount"), width: 116, minWidth: 92, align: "right", filterKind: "numberRange", filterText: (row) => formatOptionalNumber(row.cashAmount, 2), filterNumber: (row) => row.cashAmount, sortValue: (row) => row.cashAmount ?? 0, render: (row) => renderNumberCell(row, "netAmount", row.cashAmount, 2, "cashAmount", false) },
    { key: "note", label: t("detail.column.remark"), width: 220, minWidth: 150, filterText: (row) => row.note || "-", render: (row) => renderTextCell(row, "note", row.note) },
    { key: "tags", label: t("detail.column.tags"), width: 150, minWidth: 110, filterText: (row) => row.tags || "-", render: (row) => renderTextCell(row, "tags", row.tags) },
  ], [bankAccountDisplayById, bankAccountOptions, draftValue, editingCell, importing, patchUploadItem, stockAccountDisplayById, stockAccountOptions, t, uploading]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/40 p-4">
      <div data-batch-popover-boundary data-smart-select-boundary className="flex h-[82vh] min-h-[420px] w-[82rem] min-w-[720px] max-w-[calc(100vw-2rem)] resize flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
        <div className="shrink-0 border-b border-slate-200 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-base font-semibold text-slate-800">{t("viewImport.stockPreview.title")}</div>
              <div className="mt-1 text-xs text-slate-500">
                {uploading ? t("batchImport.previewParsing") : formatText(t, "viewImport.stockPreview.hint", { count: previewItems.length })}
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={importing}
              className="h-8 w-8 rounded-md border border-slate-300 text-slate-500 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={t("table.close")}
            >
              ×
            </button>
          </div>
        </div>
        {message ? (
          <div className="shrink-0 border-b border-blue-100 bg-blue-50 px-4 py-2 text-sm text-blue-700">
            {message}
          </div>
        ) : null}
        {importProgress && importProgress.total > 0 ? (
          <div className="shrink-0 border-b border-blue-100 bg-blue-50 px-4 py-2">
            <div className="flex h-2 overflow-hidden rounded-full bg-blue-100">
              <div
                className="h-full bg-blue-600 transition-all duration-200"
                style={{ width: `${Math.max(2, Math.round((importProgress.imported / importProgress.total) * 100))}%` }}
              />
            </div>
            <div className="mt-1 text-xs text-blue-700">
              {formatText(t, "viewImport.stockPreview.importingProgress", { imported: importProgress.imported, total: importProgress.total })}
            </div>
          </div>
        ) : null}
        {debugMessage ? (
          <div className="max-h-24 shrink-0 overflow-auto whitespace-pre-wrap border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800">
            {debugMessage}
          </div>
        ) : null}
        <div className="shrink-0 border-b border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <span className="font-medium text-slate-700">{formatText(t, "batchImport.selectedSummary", { selected: selected.size, total: previewItems.length })}</span>
            {allErrorIssues.length > 0 ? (
              <span className="font-medium text-red-600">{formatText(t, "batchImport.errorCount", { count: allErrorIssues.length })}</span>
            ) : null}
            {allWarningIssues.length > 0 ? (
              <span className="font-medium text-amber-600">{formatText(t, "batchImport.warningCount", { count: allWarningIssues.length })}</span>
            ) : null}
            <span className="italic text-slate-500">{t("viewImport.calculatedValueHint")}</span>
          </div>
          {previewErrorText ? (
            <div className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <div className="font-semibold text-red-800">{t("batchImport.previewBlockingHint")}</div>
              <div className="mt-1 leading-5">{previewErrorText}</div>
            </div>
          ) : null}
          {previewWarningText ? (
            <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              <div className="font-semibold text-amber-800">{t("batchImport.previewWarningHint")}</div>
              <div className="mt-1 leading-5">{previewWarningText}</div>
            </div>
          ) : null}
        </div>
        <div className="min-h-0 flex-1">
          <AdvancedDataTable
            storageKey="mmh_stock_import_preview_dialog_table_v1"
            columns={columns}
            rows={uploading ? [] : previewRows}
            rowKey={(row) => String(row.idx)}
            emptyText={uploading ? t("batchImport.previewParsing") : t("batchImport.noRecordsForFilter")}
            minTableWidth={2360}
            selectable
            selectAllScope="renderedRows"
            selectedKeys={selectedKeys}
            onSelectionChange={(keys) => {
              setSelected(new Set(Array.from(keys)
                .map((key) => Number(key))
                .filter((idx) => Number.isInteger(idx) && previewItems[idx])));
            }}
            batchActionSlot={(
              <BatchReplacePopoverButton
                fields={previewReplaceFields}
                targetCount={selectedKeys.size}
                targetLabel={t("viewImport.stockPreview.batchTarget")}
                panelAlign="left"
                disabledTitle={t("viewImport.stockPreview.selectRowsFirst")}
                buttonTitle={t("viewImport.stockPreview.batchEditSelected", { count: selectedKeys.size })}
                messageClassName="max-w-52 truncate text-xs text-blue-600"
                onApply={applyPreviewReplace}
              >
                {t("viewImport.stockPreview.batchEditHint")}
              </BatchReplacePopoverButton>
            )}
            toolbarTitle={t("viewImport.stockPreview.title")}
            toolbarRightContent={(
              <div className="flex items-center gap-3 text-xs text-slate-500">
                <span>{formatText(t, "batchImport.selectedSummary", { selected: selected.size, total: previewItems.length })}</span>
                <span className="italic">{t("viewImport.calculatedValueHint")}</span>
                {allErrorIssues.length > 0 ? <span className="font-medium text-red-600">{formatText(t, "batchImport.errorCount", { count: allErrorIssues.length })}</span> : null}
                {allWarningIssues.length > 0 ? <span className="font-medium text-amber-600">{formatText(t, "batchImport.warningCount", { count: allWarningIssues.length })}</span> : null}
              </div>
            )}
            rowClassName={(row) => {
              const rowHasError = row.issues.some((issue) => issue.level === "error");
              const rowHasWarning = row.issues.some((issue) => issue.level === "warning");
              return rowHasError ? "bg-red-50 hover:bg-red-100/80" : rowHasWarning ? "bg-amber-50 hover:bg-amber-100/80" : "hover:bg-slate-50";
            }}
            fillHeight
            compactRows
            showFilters
            sortable
            showColumnVisibilityButton={false}
            resetDisplayStateOnMount
          />
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3 text-xs">
            <span className="shrink-0 text-slate-500">{formatText(t, "batchImport.selectedSummary", { selected: selected.size, total: previewItems.length })}</span>
            {allErrorIssues.length > 0 ? <span className="shrink-0 font-medium text-red-600">{formatText(t, "batchImport.errorCount", { count: allErrorIssues.length })}</span> : null}
            {allWarningIssues.length > 0 ? <span className="shrink-0 font-medium text-amber-600">{formatText(t, "batchImport.warningCount", { count: allWarningIssues.length })}</span> : null}
          </div>
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => void handleImport()}
              disabled={uploading || importing || selected.size === 0 || errorIssues.length > 0}
              className="h-9 rounded-md bg-blue-600 px-4 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {importing ? t("batchImport.importing") : formatText(t, "batchImport.confirmImport", { count: selected.size })}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
