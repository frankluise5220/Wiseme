"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AdvancedDataTable, type AdvancedDataTableColumn } from "@/components/AdvancedDataTable";
import type { BatchReplaceFieldConfig, BatchReplaceOption } from "@/components/BatchReplacePopoverButton";
import { evaluateCalcInputExpression } from "@/components/CalcInput";
import { DateStepper } from "@/components/DateStepper";
import { SettingsActionButton, SettingsPrimaryAddButton } from "@/components/settings/SettingsPageScaffold";
import type { SmartSelectOption } from "@/components/SmartSelect";
import { StatementImportPreviewDialog, type StatementImportPreviewItem } from "@/components/StatementImportPreviewDialog";
import { sortCategorySources } from "@/components/categorySmartSelect";
import { useAccountSSFilter } from "@/components/accountSSFilter";
import { buildAccountDisplayOption, buildGroupedAccountOptions, formatAccountTableLabel, formatAccountTableTitle } from "@/lib/account-display";
import { createImportAccountResolver, encodeImportAccountId, parseImportAccountId } from "@/lib/account-import-match";
import {
  getColorSchemeFromCookie,
  importPreviewFlowAmountColorFor,
  importPreviewFlowAmountTextFor,
} from "@/lib/client/colors";
import { createImportTraceId, postImportDebugLog } from "@/lib/client/importDebugLog";
import { showChoiceDialog } from "@/lib/client/confirm-dialog";
import { dispatchFinanceDataChanged } from "@/lib/client/refresh";
import { fetchSettingsBootstrap } from "@/lib/client/settingsCache";
import { DEFAULT_EMAIL_IMPORT_KEYWORD, normalizeEmailImportKeyword } from "@/lib/mail/email-import-settings";
import { inferKnownStatementMerchant } from "@/lib/statement/merchant-inference";
import {
  formatStatementMoneyAmount as formatMoneyAmount,
  statementMoneyNumber as moneyNumber,
  uniqueStatementInfoTexts,
} from "@/lib/statement/preview-meta";
import { useI18n } from "@/lib/i18n";
import { getAccountLabelFieldsPreference } from "@/lib/client/appPreferences";

type I18nT = (key: string, params?: Record<string, string | number>) => string;

type BatchReplacePopoverButtonComponent = typeof import("@/components/BatchReplacePopoverButton").BatchReplacePopoverButton;
type SmartSelectComponent = typeof import("@/components/SmartSelect").SmartSelect;

const BatchReplacePopoverButton = dynamic(
  () => import("@/components/BatchReplacePopoverButton").then((mod) => mod.BatchReplacePopoverButton),
  { ssr: false },
) as BatchReplacePopoverButtonComponent;
const SmartSelect = dynamic(
  () => import("@/components/SmartSelect").then((mod) => mod.SmartSelect),
  { ssr: false },
) as SmartSelectComponent;

const MAIL_SEARCH_LIMIT = 50;

function dateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayDateString() {
  return dateInputValue(new Date());
}

function monthAgoDateString() {
  const date = new Date();
  date.setMonth(date.getMonth() - 1);
  return dateInputValue(date);
}

const EMAIL_PROVIDER_PRESETS = (t: I18nT) => [
  { key: "qq", label: t("settings.email.providerQq"), imapHost: "imap.qq.com", imapPort: "993", smtpHost: "smtp.qq.com", smtpPort: "465" },
  { key: "163", label: t("settings.email.provider163"), imapHost: "imap.163.com", imapPort: "993", smtpHost: "smtp.163.com", smtpPort: "465" },
  { key: "126", label: t("settings.email.provider126"), imapHost: "imap.126.com", imapPort: "993", smtpHost: "smtp.126.com", smtpPort: "465" },
  { key: "sohu", label: t("settings.email.providerSohu"), imapHost: "imap.sohu.com", imapPort: "993", smtpHost: "smtp.sohu.com", smtpPort: "465" },
  { key: "sina", label: t("settings.email.providerSina"), imapHost: "imap.sina.com", imapPort: "993", smtpHost: "smtp.sina.com", smtpPort: "465" },
  { key: "gmail", label: t("settings.email.providerGmail"), imapHost: "imap.gmail.com", imapPort: "993", smtpHost: "smtp.gmail.com", smtpPort: "587" },
];

type Account = {
  id: string;
  label: string;
  username: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpFrom: string | null;
  mailbox: string;
  createdAt: string;
};

type BookAccount = {
  id: string;
  name: string;
  kind: string;
  label?: string | null;
  /** Table/list label that follows the configured display fields. */
  listLabel?: string | null;
  selectorLabel?: string | null;
  selectorCoreLabel?: string | null;
  fullLabel?: string | null;
  hoverTitle?: string | null;
  displaySubLabel?: string | null;
  institutionId?: string | null;
  userId?: string | null;
  groupId?: string | null;
  investProductType?: string | null;
  numberMasked?: string | null;
  creditLimit?: string | number | null;
  billingDay?: number | null;
  repaymentDay?: number | null;
  Institution?: { id?: string; name?: string | null; shortName?: string | null; type?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
  AccountAlias?: Array<{ alias: string }> | null;
};
type BookInstitution = { id: string; name: string; shortName?: string | null; type?: string | null };
type BookUser = { id: string; name: string };
type BookCategory = { id: string; name: string; type: string; parentId?: string | null };
type BookLookups = {
  accounts: BookAccount[];
  institutions: BookInstitution[];
  users: BookUser[];
  categories: BookCategory[];
};
type MailItem = { uid: number; subject: string; from: string; date: string; hash?: string };
type MailAttachment = { id: string; filename: string; contentType: string; size: number; text?: string; parseError?: string };
type MailDetail = { uid: number; subject: string; from: string; date: string; text: string; html: string; attachments?: MailAttachment[]; hash?: string };
type MailListMeta = {
  total: number;
  scanned: number;
  matched: number;
  limited: number;
  hasKeyword: boolean;
  scanLimit: number;
  sinceDate: string;
  endDate: string;
  searchMode?: "imap" | "scan";
  timingMs?: {
    connect?: number;
    list?: number;
    total?: number;
  };
};
type ParsedItemMeta = {
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
  templateLocked?: boolean;
};
type ParsedItem = {
  rawText: string; type: "expense" | "income" | "transfer" | "investment";
  date?: string; amount: number; inflow?: number; outflow?: number; account?: string; fromAccount?: string; toAccount?: string; category?: string; remark?: string; counterparty?: string; institution?: string; postedDate?: string; currency?: string; transferDirection?: "in" | "out";
  _meta?: ParsedItemMeta;
};
type ImportPreviewEditableCell = "date" | "postedDate" | "type" | "account" | "counterAccount" | "category" | "institution" | "inflow" | "outflow" | "amount" | "remark";
type ImportPreviewItem = {
  key: string;
  item: ParsedItem;
  ready: boolean;
  missingFields: string[];
  matchedAccountId?: string;
  selectedAccountId?: string;
};
type ImportPreviewState = {
  items: ImportPreviewItem[];
  selectedKeys: Set<string>;
  selectAll: boolean;
  statementAccountId?: string;
};
type LockedStatementBill = {
  accountId?: string | null;
  billAccountIds?: string[] | null;
  statementMonth?: string | null;
  amount?: number | string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  dueDate?: string | null;
};
type ImportCompleteState = {
  created: number;
  skipped: number;
  accountId: string | null;
  lockedStatementBills: LockedStatementBill[];
};
const IMPORT_PREVIEW_FIELD_LABELS = (t: I18nT): Record<ImportPreviewEditableCell, string> => ({
  date: t("initModal.ri.txDate"),
  postedDate: t("detail.column.postedAt"),
  type: t("batchImport.field.type"),
  account: t("batchImport.field.account"),
  counterAccount: t("batchImport.field.counterAccount"),
  category: t("batchImport.field.category"),
  institution: t("batchImport.field.institution"),
  inflow: t("batchImport.field.inflow"),
  outflow: t("batchImport.field.outflow"),
  amount: t("stats.amount"),
  remark: t("batchImport.field.remark"),
});
const PREVIEW_TYPE_OPTIONS = (t: I18nT): Array<{ value: ParsedItem["type"]; label: string }> => [
  { value: "expense", label: t("transaction.type.expense") },
  { value: "income", label: t("transaction.type.income") },
  { value: "transfer", label: t("transaction.type.transfer") },
  { value: "investment", label: t("transaction.type.investment") },
];

function buildBookAccountDisplayOption(account: BookAccount) {
  return buildAccountDisplayOption({
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
  }, undefined, { fields: getAccountLabelFieldsPreference() });
}

function isPlaceholderText(value?: string | null) {
  const text = String(value ?? "").trim();
  return !text || /^[-—–]+$/.test(text) || text === "?";
}

function cleanOptionalText(value?: string | null) {
  const text = String(value ?? "").trim();
  return isPlaceholderText(text) ? undefined : text;
}

function normalizeDateOnlyText(value?: string | null) {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  // Matches Chinese date formats such as 2024-01-05 or 2024/1/5 as well as -/. separators.
  const match = raw.match(/^(\d{4})[-\/.\u5e74](\d{1,2})[-\/.\u6708](\d{1,2})(?:\u65e5)?/);
  if (!match) return raw.slice(0, 10);
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function inferKnownMerchant(item: ParsedItem) {
  return inferKnownStatementMerchant(item);
}

function shouldTreatAsTransfer(item: ParsedItem) {
  const source = [item.remark, item.counterparty, item.category, item.rawText]
    .map((value) => cleanOptionalText(value))
    .filter(Boolean)
    .join(" ");
  // "分期还款"/"分期付款" are installment payments, not card repayments —
  // the word "还款" there must not flip them to transfer.
  if (/分期还款|分期付款/.test(source)) return false;
  // Matches Chinese transfer/repayment keywords in user-entered remark text.
  return /\u8f6c\u8d26|\u8f6c\u5e10|\u8fd8\u6b3e|\u4fe1\u7528\u5361\u8fd8\u6b3e/.test(source);
}

function mailDebugDetails(mail: Partial<MailItem & MailDetail> | null | undefined, emailAccountId?: string | null) {
  return {
    importKind: "credit_bill_mail",
    source: "settings_email",
    emailAccountId: emailAccountId ?? null,
    uid: mail?.uid ?? null,
    from: mail?.from ?? "",
    mailDate: mail?.date ?? "",
    subject: mail?.subject ?? "",
    mailHash: mail?.hash ?? "",
  };
}

type AccountCreateDraft = {
  rowKey: string;
  name: string;
  kind: "bank_credit" | "bank_debit" | "cash" | "ewallet" | "other";
  institutionName: string;
  institutionId: string;
  ownerName: string;
  userId: string;
  numberMasked: string;
  creditLimit: string;
  billingDay: string;
  repaymentDay: string;
};

export function EmailSettingsPanel({ embedded = false, onStatementPreviewOpened, onStatementPreviewClosed }: { embedded?: boolean; onStatementPreviewOpened?: () => void; onStatementPreviewClosed?: () => void }) {
  const { t } = useI18n();
  const importPreviewFieldLabels = useMemo(() => IMPORT_PREVIEW_FIELD_LABELS(t), [t]);
  const previewTypeOptions = useMemo(() => PREVIEW_TYPE_OPTIONS(t), [t]);
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showAccountModal, setShowAccountModal] = useState(false);

  // Email account form
  const [providerKey, setProviderKey] = useState("");
  const [label, setLabel] = useState("");
  const [username, setUsername] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapSecure, setImapSecure] = useState(true);
  const [password, setPassword] = useState("");
  const [mailbox, setMailbox] = useState("INBOX");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("465");
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [smtpFrom, setSmtpFrom] = useState("");

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  // Mail operations
  const [mailItems, setMailItems] = useState<MailItem[]>([]);
  const [loadingMails, setLoadingMails] = useState(false);
  const [selectedMail, setSelectedMail] = useState<MailDetail | null>(null);
  const [mailContent, setMailContent] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parsedItems, setParsedItems] = useState<ParsedItem[]>([]);
  const [importPreview, setImportPreview] = useState<ImportPreviewState | null>(null);
  const [bookAccounts, setBookAccounts] = useState<BookAccount[]>([]);
  const [bookInstitutions, setBookInstitutions] = useState<BookInstitution[]>([]);
  const [bookUsers, setBookUsers] = useState<BookUser[]>([]);
  const [bookCategories, setBookCategories] = useState<BookCategory[]>([]);
  const bookLookupsRef = useRef<BookLookups>({ accounts: [], institutions: [], users: [], categories: [] });
  const [accountDraft, setAccountDraft] = useState<AccountCreateDraft | null>(null);
  const [savingAccountDraft, setSavingAccountDraft] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importComplete, setImportComplete] = useState<ImportCompleteState | null>(null);
  const [mailStartDate, setMailStartDate] = useState(() => monthAgoDateString());
  const [mailEndDate, setMailEndDate] = useState(() => todayDateString());
  const [mailKeyword, setMailKeyword] = useState(DEFAULT_EMAIL_IMPORT_KEYWORD);
  const [mailKeywordDraft, setMailKeywordDraft] = useState(DEFAULT_EMAIL_IMPORT_KEYWORD);
  const [savingMailKeyword, setSavingMailKeyword] = useState(false);
  const [mailListHint, setMailListHint] = useState("");
  const [accountTested, setAccountTested] = useState(false);
  const [editingPreviewCell, setEditingPreviewCell] = useState<{ rowKey: string; field: ImportPreviewEditableCell } | null>(null);
  const mailImportTraceIdRef = useRef(createImportTraceId("settings-email-mail"));

  useEffect(() => {
    const controller = new AbortController();
    void initializeEmailSettings(controller.signal);
    return () => controller.abort();
  }, []);

  async function initializeEmailSettings(signal?: AbortSignal) {
    // Warm the book lookups (accounts/institutions/categories) in the
    // background so the first mail import does not block on a full
    // /settings/bootstrap round-trip before opening the preview dialog.
    void loadBookLookups();
    await loadMailImportSettings(signal);
    if (!signal?.aborted) await loadAccounts(signal);
  }

  async function loadMailImportSettings(signal?: AbortSignal) {
    try {
      const res = await fetch("/api/v1/settings/email-import", { signal });
      const data = await res.json() as { ok?: boolean; data?: { keyword?: string | null } };
      if (data.ok) {
        const nextKeyword = normalizeEmailImportKeyword(data.data?.keyword);
        setMailKeyword(nextKeyword);
        setMailKeywordDraft(nextKeyword);
        return nextKeyword;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return DEFAULT_EMAIL_IMPORT_KEYWORD;
    }
    setMailKeyword(DEFAULT_EMAIL_IMPORT_KEYWORD);
    setMailKeywordDraft(DEFAULT_EMAIL_IMPORT_KEYWORD);
    return DEFAULT_EMAIL_IMPORT_KEYWORD;
  }

  async function loadAccounts(signal?: AbortSignal) {
    setLoadingAccounts(true);
    try {
      const res = await fetch("/api/v1/settings/email-accounts", { signal });
      const data = await res.json();
      if (data.ok) {
        const nextAccounts: Account[] = Array.isArray(data.accounts) ? data.accounts : [];
        setAccounts(nextAccounts);
        if (nextAccounts.length === 1 && selectedId !== nextAccounts[0].id) {
          const onlyAccount = nextAccounts[0];
          setSelectedId(onlyAccount.id);
        }
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    } finally {
      if (!signal?.aborted) setLoadingAccounts(false);
    }
  }

  async function loadBookLookups() {
    try {
      const bootstrap = await fetchSettingsBootstrap();
      const lookups: BookLookups = {
        accounts: Array.isArray(bootstrap.accounts) ? bootstrap.accounts as BookAccount[] : [],
        institutions: Array.isArray(bootstrap.institutions) ? bootstrap.institutions : [],
        users: Array.isArray(bootstrap.users) ? bootstrap.users : [],
        categories: Array.isArray(bootstrap.categories) ? bootstrap.categories : [],
      };
      bookLookupsRef.current = lookups;
      setBookAccounts(lookups.accounts);
      setBookInstitutions(lookups.institutions);
      setBookUsers(lookups.users);
      setBookCategories(lookups.categories);
      return lookups;
    } catch {}
    return bookLookupsRef.current;
  }

  function resetForm() {
    setEditingId(null); setProviderKey(""); setLabel(""); setUsername(""); setImapHost(""); setImapPort("993");
    setImapSecure(true); setPassword(""); setMailbox("INBOX");
    setSmtpHost(""); setSmtpPort("465"); setSmtpSecure(true); setSmtpFrom("");
    setTestResult("");
    setAccountTested(false);
  }

  function openCreateAccountModal() {
    resetForm();
    setError("");
    setInfo("");
    setShowAccountModal(true);
  }

  function closeAccountModal() {
    setShowAccountModal(false);
    resetForm();
  }

  function applyProviderPreset(key: string) {
    setProviderKey(key);
    const preset = EMAIL_PROVIDER_PRESETS(t).find((item) => item.key === key);
    if (!preset) return;
    setLabel((current) => current || preset.label);
    setImapHost(preset.imapHost);
    setImapPort(preset.imapPort);
    setImapSecure(true);
    setSmtpHost(preset.smtpHost);
    setSmtpPort(preset.smtpPort);
    setSmtpSecure(preset.smtpPort === "465");
    setSmtpFrom((current) => current || username.trim());
  }

  function editAccount(account: Account) {
    setEditingId(account.id);
    setShowAccountModal(true);
    setProviderKey("");
    setLabel(account.label);
    setUsername(account.username);
    setImapHost(account.imapHost);
    setImapPort(String(account.imapPort ?? 993));
    setImapSecure(account.imapSecure);
    setPassword("");
    setMailbox(account.mailbox || "INBOX");
    setSmtpHost(account.smtpHost ?? "");
    setSmtpPort(String(account.smtpPort ?? 465));
    setSmtpSecure(account.smtpPort == null ? true : account.smtpPort === 465);
    setSmtpFrom(account.smtpFrom ?? account.username);
    setTestResult("");
    setAccountTested(false);
    setError("");
    setInfo(t("settings.email.editAccountHint"));
  }

  function buildAccountBody(requirePassword: boolean) {
    const trimmedUsername = username.trim();
    const body: Record<string, unknown> = {
      accountId: editingId ?? undefined,
      label: label.trim(),
      username: trimmedUsername,
      imapHost: imapHost.trim(),
      imapPort: Number(imapPort) || 993,
      imapSecure,
      mailbox: mailbox.trim() || "INBOX",
      outboundType: "smtp",
      smtpHost: smtpHost.trim(),
      smtpPort: Number(smtpPort) || 465,
      smtpSecure,
      smtpFrom: (smtpFrom.trim() || trimmedUsername),
    };
    if (password.trim() || requirePassword) body.password = password.trim();
    return body;
  }

  async function runAccountConnectionTest(body: Record<string, unknown>) {
    const res = await fetch("/api/v1/settings/email-accounts/test", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? t("settings.email.testFailed"));
    return Array.isArray(data.results) ? data.results.join("; ") : t("settings.email.testPassed");
  }

  async function saveAccount() {
    if (!label.trim() || !username.trim() || !imapHost.trim() || (!editingId && !password.trim())) {
      setError(editingId ? t("settings.email.fillRequiredEdit") : t("settings.email.fillRequiredCreate"));
      return;
    }
    setSaving(true); setError(""); setInfo(""); setTestResult("");
    try {
      const body = buildAccountBody(!editingId);
      const res = await fetch("/api/v1/settings/email-accounts", {
        method: editingId ? "PUT" : "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editingId ? { id: editingId, ...body } : body),
      });
      const data = await res.json();
      if (data.ok) {
        setInfo(t("settings.email.accountSaved"));
        closeAccountModal();
        loadAccounts();
      } else {
        setError(data.error ?? t("settings.accounts.saveFailed"));
      }
    } catch (e) { setError(e instanceof Error ? e.message : t("settings.passwordRecovery.networkError")); }
    finally { setSaving(false); }
  }

  async function deleteAccount(id: string) {
    if (!confirm(t("settings.email.deleteConfirm"))) return;
    try {
      await fetch("/api/v1/settings/email-accounts", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (selectedId === id) { setSelectedId(null); setMailItems([]); setSelectedMail(null); }
      loadAccounts();
    } catch {}
  }

  async function testConnection() {
    if (!imapHost.trim() || !username.trim() || (!editingId && !password.trim())) {
      setError(editingId ? t("settings.email.imapRequiredEdit") : t("settings.email.imapRequiredCreate")); return;
    }
    setTesting(true); setTestResult(""); setError("");
    try {
      const message = await runAccountConnectionTest(buildAccountBody(!editingId));
      setTestResult(t("settings.email.testPassedDetail", { detail: message }));
      setAccountTested(true);
    } catch (e) { setError(e instanceof Error ? e.message : t("settings.passwordRecovery.networkError")); }
    finally { setTesting(false); }
  }

  async function saveMailKeyword() {
    const keyword = normalizeEmailImportKeyword(mailKeywordDraft);
    setSavingMailKeyword(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/v1/settings/email-import", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyword }),
      });
      const data = await res.json() as { ok?: boolean; data?: { keyword?: string | null }; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? t("settings.accounts.saveFailed"));
        return;
      }
      const savedKeyword = normalizeEmailImportKeyword(data.data?.keyword);
      setMailKeyword(savedKeyword);
      setMailKeywordDraft(savedKeyword);
      setInfo(t("settings.email.keywordSaved"));
    } catch (error) {
      setError(error instanceof Error ? error.message : t("settings.passwordRecovery.networkError"));
    } finally {
      setSavingMailKeyword(false);
    }
  }

  function buildMailListHint(meta: MailListMeta | undefined, itemCount: number, keyword: string) {
    if (!meta) return "";
    const timing = typeof meta.timingMs?.total === "number"
      ? t("settings.email.timingSeconds", { seconds: (meta.timingMs.total / 1000).toFixed(1) })
      : "";
    const scopeParams = { start: meta.sinceDate, end: meta.endDate, date: meta.endDate };
    const scope = meta.searchMode === "imap"
      ? (meta.sinceDate && meta.endDate
        ? t("settings.email.mailSearchRange", scopeParams)
        : meta.sinceDate
          ? t("settings.email.mailSearchSince", { date: meta.sinceDate })
          : meta.endDate
            ? t("settings.email.mailSearchUntil", { date: meta.endDate })
            : t("settings.email.mailboxSearch"))
      : (meta.sinceDate && meta.endDate
        ? t("settings.email.scanRange", scopeParams)
        : meta.sinceDate
          ? t("settings.email.scanSince", { date: meta.sinceDate })
          : meta.endDate
            ? t("settings.email.scanUntil", { date: meta.endDate })
            : t("settings.email.scanRecent", { limit: meta.scanLimit }));
    const hasKeyword = Boolean(keyword.trim());
    if (itemCount > 0) {
      return hasKeyword
        ? t("settings.email.scanMatched", { scope, scanned: meta.scanned, keyword, matched: meta.matched, itemCount, timing })
        : t("settings.email.scanListed", { scope, scanned: meta.scanned, itemCount, timing });
    }
    return hasKeyword
      ? t("settings.email.scanNoMatch", { scope, scanned: meta.scanned, keyword, timing })
      : t("settings.email.scanNoMail", { scope, scanned: meta.scanned, timing });
  }

  async function listMails(accountId = selectedId, keywordOverride?: string) {
    if (!accountId) return;
    const activeKeyword = normalizeEmailImportKeyword(keywordOverride ?? mailKeywordDraft);
    const sinceDate = mailStartDate.trim() || undefined;
    const endDate = mailEndDate.trim() || undefined;
    if (sinceDate && endDate && sinceDate > endDate) {
      setError(t("settings.email.invalidDateRange"));
      return;
    }
    setLoadingMails(true); setError(""); setSelectedMail(null); setMailListHint(""); setParsedItems([]); setImportPreview(null); setImportComplete(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const traceId = createImportTraceId("settings-email-mail");
    const startedAt = performance.now();
    mailImportTraceIdRef.current = traceId;
    postImportDebugLog(traceId, "email_list_started", {
      importKind: "credit_bill_mail",
      source: "settings_email",
      emailAccountId: accountId,
      keyword: activeKeyword,
      scanLimit: MAIL_SEARCH_LIMIT,
      sinceDate: sinceDate ?? null,
      endDate: endDate ?? null,
    });
    try {
      const res = await fetch("/api/v1/email/imap/list", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          limit: MAIL_SEARCH_LIMIT,
          scanLimit: MAIL_SEARCH_LIMIT,
          sinceDate,
          endDate,
          keyword: activeKeyword,
        }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (data.ok) {
        setMailItems(data.items);
        setMailListHint(buildMailListHint(data.meta, Array.isArray(data.items) ? data.items.length : 0, activeKeyword));
        postImportDebugLog(traceId, "email_list_succeeded", {
          importKind: "credit_bill_mail",
          source: "settings_email",
          emailAccountId: accountId,
          matchedCount: Array.isArray(data.items) ? data.items.length : 0,
          scannedCount: Number(data.meta?.scanned ?? 0),
          totalCount: Number(data.meta?.total ?? 0),
          durationMs: Math.round(performance.now() - startedAt),
        });
      }
      else {
        postImportDebugLog(traceId, "email_list_failed", {
          importKind: "credit_bill_mail",
          source: "settings_email",
          emailAccountId: accountId,
          httpStatus: res.status,
          errorMessage: data.error ?? t("creditBill.readFailed"),
          durationMs: Math.round(performance.now() - startedAt),
        });
        setError(data.error ?? t("creditBill.readFailed"));
      }
    } catch (e) {
      postImportDebugLog(traceId, "email_list_failed", {
        importKind: "credit_bill_mail",
        source: "settings_email",
        emailAccountId: accountId,
        errorType: e instanceof Error ? e.name : "unknown",
        errorMessage: e instanceof Error ? e.message : String(e),
        durationMs: Math.round(performance.now() - startedAt),
      });
      setError(e instanceof DOMException && e.name === "AbortError" ? t("settings.email.readTimeoutHint") : t("settings.passwordRecovery.networkError"));
    }
    finally {
      clearTimeout(timer);
      setLoadingMails(false);
    }
  }

  function buildStatementParseContent(mail: MailDetail | null, fallbackContent = "") {
    const attachmentText = mail?.attachments
      ?.filter((attachment) => attachment.text?.trim())
      .map((attachment) => `\u3010\u9644\u4ef6\uff1a${attachment.filename || "\u672a\u547d\u540d PDF"}\u3011\n${attachment.text!.trim()}`)
      .join("\n\n");
    return [mail?.html?.trim() || fallbackContent.trim(), attachmentText]
      .filter((part) => part && part.trim())
      .join("\n\n");
  }

  async function fetchMail(uid: number, autoParse = false) {
    if (!selectedId) return;
    setLoadingMails(true); setError(""); setParsedItems([]); setImportPreview(null); setImportComplete(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const traceId = createImportTraceId("settings-email-mail");
    const startedAt = performance.now();
    const listedMail = mailItems.find((item) => item.uid === uid);
    mailImportTraceIdRef.current = traceId;
    postImportDebugLog(traceId, "email_fetch_started", mailDebugDetails(listedMail ?? { uid }, selectedId));
    try {
      const res = await fetch("/api/v1/email/imap/fetch", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: selectedId, uid }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (data.ok) {
        const nextMail = { ...data.item, hash: listedMail?.hash } as MailDetail;
        const content = buildStatementParseContent(nextMail, nextMail.text || nextMail.html || "");
        setSelectedMail(nextMail);
        setMailContent(nextMail.text || nextMail.html || "");
        postImportDebugLog(traceId, "email_fetch_succeeded", {
          ...mailDebugDetails(nextMail, selectedId),
          contentLength: content.length,
          attachmentCount: Array.isArray(nextMail.attachments) ? nextMail.attachments.length : 0,
          durationMs: Math.round(performance.now() - startedAt),
        });
        if (autoParse) await parseMail(nextMail, true);
      } else {
        postImportDebugLog(traceId, "email_fetch_failed", {
          ...mailDebugDetails(listedMail ?? { uid }, selectedId),
          httpStatus: res.status,
          errorMessage: data.error ?? t("settings.email.fetchFailed"),
          durationMs: Math.round(performance.now() - startedAt),
        });
        setError(data.error ?? t("settings.email.fetchFailed"));
      }
    } catch (e) {
      postImportDebugLog(traceId, "email_fetch_failed", {
        ...mailDebugDetails(listedMail ?? { uid }, selectedId),
        errorType: e instanceof Error ? e.name : "unknown",
        errorMessage: e instanceof Error ? e.message : String(e),
        durationMs: Math.round(performance.now() - startedAt),
      });
      setError(e instanceof DOMException && e.name === "AbortError" ? t("settings.email.fetchTimeoutHint") : t("settings.passwordRecovery.networkError"));
    }
    finally {
      clearTimeout(timer);
      setLoadingMails(false);
    }
  }

  async function parseMail(mail = selectedMail, autoOpenPreview = false) {
    const sourceContent = buildStatementParseContent(mail, mail === selectedMail ? mailContent : (mail?.text || mail?.html || ""));
    const traceId = mailImportTraceIdRef.current || createImportTraceId("settings-email-mail");
    const startedAt = performance.now();
    if (!sourceContent) {
      postImportDebugLog(traceId, "email_parse_blocked", {
        ...mailDebugDetails(mail, selectedId),
        reason: "empty_content",
      });
      setError(t("settings.email.emptyMailContent"));
      return;
    }
    setParsing(true); setError("");
    setImportComplete(null);
    postImportDebugLog(traceId, "email_parse_started", {
      ...mailDebugDetails(mail, selectedId),
      contentLength: sourceContent.length,
      attachmentCount: Array.isArray(mail?.attachments) ? mail.attachments.length : 0,
    });
    try {
      // Kick off the book lookups in parallel with the parse request so the
      // preview dialog is not blocked on a full /settings/bootstrap round-trip.
      const bookLookupsPromise = autoOpenPreview ? loadBookLookups() : Promise.resolve(bookLookupsRef.current);
      const res = await fetch("/api/v1/statement/parse", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sourceContent }),
      });
      const data = await res.json();
      if (data.ok) {
        const items = Array.isArray(data.items) ? data.items.map(normalizeItemForImport) : [];
        setParsedItems(items);
        postImportDebugLog(traceId, "email_parse_succeeded", {
          ...mailDebugDetails(mail, selectedId),
          recognizedCount: Array.isArray(data.items) ? data.items.length : 0,
          importableCount: items.filter(isRowReadyForImport).length,
          durationMs: Math.round(performance.now() - startedAt),
        });
        if (autoOpenPreview) {
          if (items.length > 0) {
            await bookLookupsPromise;
            openImportPreview(items);
            // The outer credit-card mail dialog can now close; the statement
            // preview dialog lives at a higher z-index and stays visible.
            onStatementPreviewOpened?.();
          }
          else setError(t("settings.email.noBillItems"));
        }
      }
      else {
        postImportDebugLog(traceId, "email_parse_failed", {
          ...mailDebugDetails(mail, selectedId),
          httpStatus: res.status,
          errorMessage: data.error ?? t("settings.email.parseFailed"),
          durationMs: Math.round(performance.now() - startedAt),
        });
        setError(data.error ?? t("settings.email.parseFailed"));
      }
    } catch (e) {
      postImportDebugLog(traceId, "email_parse_failed", {
        ...mailDebugDetails(mail, selectedId),
        errorType: e instanceof Error ? e.name : "unknown",
        errorMessage: e instanceof Error ? e.message : String(e),
        durationMs: Math.round(performance.now() - startedAt),
      });
      setError(t("settings.passwordRecovery.networkError"));
    }
    finally { setParsing(false); }
  }

  async function importItems(
    confirmedItems?: StatementImportPreviewItem[],
    options?: { createDebtAccounts?: boolean; forceCreateOwnedMoneyAccounts?: boolean },
  ) {
    if (importComplete) return;
    const sourceItems = confirmedItems?.length
      ? confirmedItems
      : importPreview
      ? importPreview.items
          .filter((row) => importPreview.selectedKeys.has(row.key) && row.ready)
          .map((row) => {
            const statementAccountName = selectedPreviewAccountName(row) ?? row.item.account;
            if (row.item.type === "transfer") {
              return {
                ...row.item,
                account: statementAccountName,
                fromAccount: transferCounterAccountName(row.item),
                toAccount: statementAccountName,
              };
            }
            return { ...row.item, account: statementAccountName };
          })
      : parsedItems;
    if (!sourceItems.length) return;
    const selectedAccountIds = confirmedItems?.length
      ? Array.from(new Set(confirmedItems.flatMap((item) => [
          parseImportAccountId(item.account),
          parseImportAccountId(item.fromAccount),
          parseImportAccountId(item.toAccount),
        ]).filter(Boolean)))
      : importPreview
      ? Array.from(new Set(importPreview.items
          .filter((row) => importPreview.selectedKeys.has(row.key) && row.ready)
          .map((row) => row.selectedAccountId ?? row.matchedAccountId ?? importPreview.statementAccountId)
          .filter((id): id is string => Boolean(id))))
      : [];
    const targetAccountId = selectedAccountIds.length === 1 ? selectedAccountIds[0] : null;
    setImporting(true); setError("");
    setImportComplete(null);
    const traceId = mailImportTraceIdRef.current || createImportTraceId("settings-email-mail");
    const startedAt = performance.now();
    const mailSource = selectedMail && selectedId
      ? {
          emailAccountId: selectedId,
          uid: selectedMail.uid,
          hash: selectedMail.hash,
          subject: selectedMail.subject,
          from: selectedMail.from,
          date: selectedMail.date,
        }
      : undefined;
    postImportDebugLog(traceId, "email_import_started", {
      ...mailDebugDetails(selectedMail, selectedId),
      selectedCount: sourceItems.length,
    });
    try {
      let conflictPolicy: "overwrite" | "keep" | undefined;
      let res: Response | null = null;
      let data: any = null;
      // The import API pre-checks manual records in the same statement period.
      // On MANUAL_RECORD_CONFLICT, ask the user to overwrite or keep; cancel aborts.
      for (;;) {
        res = await fetch("/api/v1/statement/import", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: sourceItems,
            autoCreateAccounts: false,
            createDebtAccounts: options?.createDebtAccounts === true,
            forceCreateOwnedMoneyAccounts: options?.forceCreateOwnedMoneyAccounts === true,
            mailSource,
            manualRecordConflictPolicy: conflictPolicy,
          }),
        });
        data = await res.json();
        if (data.ok || data.code !== "MANUAL_RECORD_CONFLICT") break;
        postImportDebugLog(traceId, "email_import_manual_conflict", {
          ...mailDebugDetails(selectedMail, selectedId),
          conflictCount: Number(data.conflict?.total ?? 0),
        });
        const conflictCount = Number(data.conflict?.total ?? 0);
        setImporting(false);
        const choice = await showChoiceDialog<"overwrite" | "keep">({
          title: t("settings.email.manualConflictTitle"),
          message: t("settings.email.manualConflictMessage", { count: conflictCount }),
          choices: [
            { value: "keep", label: t("settings.email.manualConflictKeep") },
            { value: "overwrite", label: t("settings.email.manualConflictOverwrite"), tone: "danger" },
          ],
          cancelLabel: t("common.cancel"),
        });
        if (!choice) {
          postImportDebugLog(traceId, "email_import_cancelled", {
            ...mailDebugDetails(selectedMail, selectedId),
            reason: "manual_record_conflict_cancelled",
          });
          return;
        }
        conflictPolicy = choice;
        setImporting(true);
      }
      if (data.ok) {
        const lockedAccountIds = Array.isArray(data.lockedStatementBills)
          ? data.lockedStatementBills.flatMap((item: any) => Array.isArray(item.billAccountIds) ? item.billAccountIds : [item.accountId]).filter(Boolean)
          : [];
        const refreshAccountIds = Array.from(new Set([...(targetAccountId ? [targetAccountId] : []), ...lockedAccountIds]));
        const createdCount = data.createdCount ?? 0;
        const skippedCount = data.skippedCount ?? 0;
        const deletedManualCount = Number(data.deletedManualRecordCount ?? 0);
        postImportDebugLog(traceId, "email_import_succeeded", {
          ...mailDebugDetails(selectedMail, selectedId),
          selectedCount: sourceItems.length,
          createdCount,
          skippedCount,
          deletedManualRecordCount: deletedManualCount,
          importBatchId: data.importBatchId ?? null,
          durationMs: Math.round(performance.now() - startedAt),
        });
        setInfo(deletedManualCount > 0
          ? t("settings.email.importCompleteWithOverwrite", { created: createdCount, skipped: skippedCount, deleted: deletedManualCount })
          : t("settings.email.importCompleteInfo", { created: createdCount, skipped: skippedCount }));
        if ((data.skippedCount ?? 0) > 0) {
          const firstError = Array.isArray(data.errors) ? data.errors[0]?.error : "";
          setError(firstError ? t("settings.email.skippedWithError", { count: data.skippedCount, error: firstError }) : t("settings.email.skippedCheck", { count: data.skippedCount }));
        }
        setImportComplete({
          created: createdCount,
          skipped: skippedCount,
          accountId: refreshAccountIds.length === 1 ? refreshAccountIds[0] : targetAccountId,
          lockedStatementBills: Array.isArray(data.lockedStatementBills) ? data.lockedStatementBills : [],
        });
        setImportPreview(null);
        setParsedItems([]);
        dispatchFinanceDataChanged({ reason: "email-bill-import", accountIds: refreshAccountIds.length > 0 ? refreshAccountIds : undefined });
      }
      else {
        postImportDebugLog(traceId, "email_import_failed", {
          ...mailDebugDetails(selectedMail, selectedId),
          selectedCount: sourceItems.length,
          httpStatus: res?.status,
          errorMessage: data.error ?? t("settings.email.importFailed"),
          durationMs: Math.round(performance.now() - startedAt),
        });
        setError(data.error ?? t("settings.email.importFailed"));
      }
    } catch (e) {
      postImportDebugLog(traceId, "email_import_failed", {
        ...mailDebugDetails(selectedMail, selectedId),
        selectedCount: sourceItems.length,
        errorType: e instanceof Error ? e.name : "unknown",
        errorMessage: e instanceof Error ? e.message : String(e),
        durationMs: Math.round(performance.now() - startedAt),
      });
      setError(t("settings.passwordRecovery.networkError"));
    }
    finally { setImporting(false); }
  }

  function confirmImportComplete() {
    const targetAccountId = importComplete?.accountId ?? null;
    setParsedItems([]);
    setImportPreview(null);
    setImportComplete(null);
    dispatchFinanceDataChanged({ reason: "email-bill-import", accountIds: targetAccountId ? [targetAccountId] : undefined });
    if (targetAccountId) {
      const account = bookAccounts.find((item) => item.id === targetAccountId);
      const view = account?.kind === "bank_credit" ? "bill" : "detail";
      router.push(`/?accountId=${encodeURIComponent(targetAccountId)}&view=${view}`);
    }
  }

  const selectedAccount = accounts.find(a => a.id === selectedId);
  const normalizedMailKeywordDraft = normalizeEmailImportKeyword(mailKeywordDraft);
  const mailKeywordDirty = normalizedMailKeywordDraft !== mailKeyword;

  function selectAccountForMail(accountId: string) {
    setSelectedId(accountId);
    setMailItems([]);
    setMailListHint("");
    setSelectedMail(null);
    setParsedItems([]);
    setImportPreview(null);
  }

  function buildMailPreviewHtml(mail: MailDetail) {
    const html = mail.html?.trim();
    if (html) {
      return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>html,body{margin:0;padding:12px;background:#fff;color:#0f172a;font:13px/1.5 sans-serif;}img{max-width:100%;height:auto;}table{max-width:100%;}a{color:#2563eb;}</style></head><body>${html}</body></html>`;
    }
    const escaped = (mail.text || t("settings.email.noContent"))
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:12px;background:#fff;color:#334155;font:12px/1.6 ui-monospace,Consolas,monospace;white-space:pre-wrap;}</style></head><body>${escaped}</body></html>`;
  }

  function isRowReadyForImport(item: ParsedItem) {
    const amountAbs = Math.abs(item.amount ?? 0);
    if (!Number.isFinite(amountAbs) || amountAbs <= 0) return false;
    if (item.type === "transfer") {
      const counterAccount = cleanOptionalText(item.fromAccount) || cleanOptionalText(item.toAccount);
      return !!(counterAccount && (cleanOptionalText(item.account) || item._meta?.institutionName));
    }
    return !!(item.account?.trim() || item._meta?.institutionName);
  }

  function getMissingFields(item: ParsedItem) {
    const missing: string[] = [];
    if (!item.date?.trim()) missing.push(t("initModal.ri.txDate"));
    if (!(item.amount > 0)) missing.push(t("stats.amount"));
    if (item.type === "transfer") {
      if (!item.account?.trim() && !item.toAccount?.trim() && !item._meta?.institutionName) missing.push(t("batchImport.field.account"));
      if (!cleanOptionalText(item.fromAccount) && !cleanOptionalText(item.toAccount)) missing.push(t("batchImport.field.counterAccount"));
    } else if (!item.account?.trim() && !item._meta?.institutionName) {
      missing.push(t("batchImport.field.account"));
    }
    return missing;
  }

  function accountNameFromId(accountId?: string | null) {
    if (!accountId) return undefined;
    return bookAccounts.find((account) => account.id === accountId)?.name;
  }

  function accountIdFromName(accountName: string) {
    const name = cleanOptionalText(accountName);
    if (!name) return undefined;
    const nameKey = normalizedKey(name);
    const resolver = createImportAccountResolver(bookAccounts);
    const found = resolver(name);
    if (found?.id) return found.id;
    const fallback = bookAccounts.find((account) => normalizedKey(account.name) === nameKey);
    return fallback?.id;
  }

  function isDebitOrEwalletAccount(account: BookAccount) {
    return account.kind === "bank_debit" || account.kind === "ewallet";
  }

  function transferCounterAccountName(item: ParsedItem) {
    return cleanOptionalText(item.fromAccount) || cleanOptionalText(item.toAccount);
  }

  function getPreviewMissingFields(item: ParsedItem, hasResolvedAccount: boolean) {
    const missing = getMissingFields(item);
    if (!hasResolvedAccount) missing.push(t("batchImport.field.account"));
    if (item.type === "transfer") {
      const counterAccount = transferCounterAccountName(item);
      if (!counterAccount || !accountIdFromName(counterAccount)) missing.push(t("batchImport.field.counterAccount"));
    }
    return Array.from(new Set(missing));
  }

  function isPreviewRowReady(item: ParsedItem, hasResolvedAccount: boolean) {
    return isRowReadyForImport(item) && getPreviewMissingFields(item, hasResolvedAccount).length === 0;
  }

  function guessDebitTransferAccountName(item: ParsedItem) {
    const source = [item.remark, item.counterparty, item.category, item.rawText]
      .map((value) => cleanOptionalText(value))
      .filter(Boolean)
      .join(" ");
    const sourceKey = normalizedKey(source);
    if (!sourceKey) return undefined;

    const debitAccounts = bookAccounts.filter(isDebitOrEwalletAccount);
    for (const account of debitAccounts) {
      const accountKeys = [
        account.name,
        stripOwnerPrefix(account.name),
        account.Institution?.name,
        account.Institution?.shortName,
      ].map(normalizedKey).filter((key) => key.length >= 2);
      if (accountKeys.some((key) => sourceKey.includes(key))) return account.name;
    }

    const digitSource = source.replace(/\D/g, "");
    const last4Matches = debitAccounts.filter((account) => {
      const last4 = String(account.numberMasked ?? "").replace(/\D/g, "");
      return last4.length >= 4 && digitSource.includes(last4);
    });
    if (last4Matches.length === 1) return last4Matches[0].name;

    const institutionMatches = debitAccounts.filter((account) => {
      const institutionKeys = [account.Institution?.name, account.Institution?.shortName]
        .map(normalizedKey)
        .filter((key) => key.length >= 2);
      return institutionKeys.some((key) => sourceKey.includes(key));
    });
    return institutionMatches.length === 1 ? institutionMatches[0].name : undefined;
  }

  function openDebitAccountDraft(rowKey: string) {
    setAccountDraft({
      rowKey,
      name: "",
      kind: "bank_debit",
      institutionName: "",
      institutionId: "",
      ownerName: "",
      userId: "",
      numberMasked: "",
      creditLimit: "",
      billingDay: "",
      repaymentDay: "",
    });
  }

  function primaryAccountNameForItem(item: ParsedItem, row?: ImportPreviewItem) {
    return (row ? selectedPreviewAccountName(row) : null) ?? cleanOptionalText(item.account) ?? cleanOptionalText(item.fromAccount);
  }

  function previewTransferDirection(item: ParsedItem): "in" | "out" {
    const inflow = Math.abs(Number(item.inflow ?? 0)) || 0;
    const outflow = Math.abs(Number(item.outflow ?? 0)) || 0;
    const text = [item.rawText, item.remark, item.fromAccount, item.toAccount].filter(Boolean).join(" ");
    if (
      item.type === "transfer" &&
      outflow <= 0 &&
      /\u94f6\u8054\u5165\u8d26|\u94f6\u8054\u8f6c\u8d26|\u8fd8\u6b3e|\u81ea\u52a8\u6263\u6b3e|\u81ea\u52a8\u8fd8\u6b3e|repayment|payment|autopay/i.test(text)
    ) {
      return "in";
    }
    if (item.transferDirection === "in" || item.transferDirection === "out") return item.transferDirection;
    return inflow > 0 && outflow <= 0 ? "in" : "out";
  }

  function normalizeTransferFlow(item: ParsedItem): ParsedItem {
    if (item.type !== "transfer") return item;
    const inflow = Math.abs(Number(item.inflow ?? 0)) || 0;
    const outflow = Math.abs(Number(item.outflow ?? 0)) || 0;
    const amount = Math.abs(Number(item.amount ?? 0)) || inflow || outflow;
    const direction = previewTransferDirection(item);
    return {
      ...item,
      amount,
      transferDirection: direction,
      inflow: direction === "in" ? inflow || amount || undefined : undefined,
      outflow: direction === "out" ? outflow || amount || undefined : undefined,
    };
  }

  function amountPatchForPreviewItem(item: ParsedItem, nextAmount: number): Partial<ParsedItem> {
    const amount = Math.abs(Number(nextAmount) || 0);
    if (item.type === "transfer") {
      return previewTransferDirection(item) === "in"
        ? { amount, inflow: amount, outflow: undefined, transferDirection: "in" }
        : { amount, inflow: undefined, outflow: amount, transferDirection: "out" };
    }
    const isAccountInflow = item.type === "income" || (Number(item.inflow ?? 0) > 0 && Number(item.outflow ?? 0) <= 0);
    return isAccountInflow
      ? { amount, inflow: amount, outflow: undefined }
      : { amount, inflow: undefined, outflow: amount };
  }

  function flowAmountPatchForPreviewItem(item: ParsedItem, side: "inflow" | "outflow", nextAmount: number): Partial<ParsedItem> {
    const amount = Math.abs(Number(nextAmount) || 0);
    if (item.type === "transfer") {
      return side === "inflow"
        ? { amount, inflow: amount, outflow: undefined, transferDirection: "in" }
        : { amount, inflow: undefined, outflow: amount, transferDirection: "out" };
    }
    return side === "inflow"
      ? { type: "income", amount, inflow: amount, outflow: undefined }
      : { type: "expense", amount, inflow: undefined, outflow: amount };
  }

  function normalizeItemForImport(item: ParsedItem): ParsedItem {
    const merchant = inferKnownMerchant(item);
    const remark = cleanOptionalText(item.remark);
    const treatAsTransfer = item.type === "transfer" || shouldTreatAsTransfer(item);
    const date = item.date?.trim() || undefined;
    const postedDate = normalizeDateOnlyText(item.postedDate) ?? normalizeDateOnlyText(date);
    const amount = Math.abs(Number(item.amount ?? 0)) || 0;
    const inflow = Math.abs(Number(item.inflow ?? 0)) || 0;
    const outflow = Math.abs(Number(item.outflow ?? 0)) || 0;
    return normalizeTransferFlow({
      rawText: item.rawText,
      type: treatAsTransfer ? "transfer" : item.type,
      date,
      amount,
      inflow: inflow || undefined,
      outflow: outflow || undefined,
      transferDirection: item.transferDirection,
      account: cleanOptionalText(item.account),
      fromAccount: treatAsTransfer ? (cleanOptionalText(item.fromAccount) || guessDebitTransferAccountName(item)) : cleanOptionalText(item.fromAccount),
      toAccount: treatAsTransfer ? undefined : cleanOptionalText(item.toAccount),
      category: treatAsTransfer
        ? undefined
        : merchant.category === "\u5145\u7535"
          ? item.type === "expense" ? merchant.category : undefined
          : cleanOptionalText(item.category) || merchant.category,
      remark,
      counterparty: treatAsTransfer ? cleanOptionalText(item.counterparty) : cleanOptionalText(item.counterparty) || merchant.counterparty,
      institution: treatAsTransfer ? cleanOptionalText(item.institution) : cleanOptionalText(item.institution) || merchant.institution,
      postedDate,
      _meta: item._meta ? {
        institutionName: cleanOptionalText(item._meta.institutionName),
        ownerName: cleanOptionalText(item._meta.ownerName),
        cardNumberMasked: cleanOptionalText(item._meta.cardNumberMasked),
        statementCurrency: cleanOptionalText(item._meta.statementCurrency),
        creditLimit: item._meta.creditLimit,
        billingDay: item._meta.billingDay,
        repaymentDay: item._meta.repaymentDay,
        statementAmount: item._meta.statementAmount,
        statementPeriodStart: item._meta.statementPeriodStart,
        statementPeriodEnd: item._meta.statementPeriodEnd,
        statementDueDate: item._meta.statementDueDate,
        templateLocked: item._meta.templateLocked,
      } : undefined,
    });
  }

  function openImportPreview(items: ParsedItem[]) {
    const normalizedItems = items.map((item) => ({
      ...item,
      postedDate: normalizeDateOnlyText(item.postedDate) ?? normalizeDateOnlyText(item.date),
    }));
    const baseRows = normalizedItems.map((item, index) => ({
      key: `mail-${index}-${item.date ?? ""}-${item.amount ?? 0}`,
      item,
      ready: false,
      missingFields: getMissingFields(item),
      ...resolvePreviewAccount(item),
    }));
    const accountIds = Array.from(new Set(baseRows.map((row) => row.selectedAccountId ?? row.matchedAccountId).filter(Boolean)));
    const statementAccountId = accountIds.length === 1 ? accountIds[0] : undefined;
    const rows = baseRows.map((row) => ({
      ...row,
      selectedAccountId: row.selectedAccountId ?? statementAccountId,
      matchedAccountId: row.matchedAccountId ?? statementAccountId,
      ready: isPreviewRowReady(row.item, Boolean(row.selectedAccountId || row.matchedAccountId || statementAccountId)),
      missingFields: getPreviewMissingFields(row.item, Boolean(row.selectedAccountId || row.matchedAccountId || statementAccountId)),
    }));
    setImportPreview({
      items: rows,
      selectedKeys: new Set(rows.filter((row) => row.ready).map((row) => row.key)),
      selectAll: rows.length > 0 && rows.every((row) => row.ready),
      statementAccountId,
    });
  }

  const importPreviewStatementInfoTexts = useMemo(() => uniqueStatementInfoTexts(parsedItems), [parsedItems]);

  const importCompleteLockedBills = useMemo(() => {
    if (!importComplete?.lockedStatementBills?.length) return [];
    return importComplete.lockedStatementBills.map((item) => {
      const accountId = item.billAccountIds?.[0] ?? item.accountId ?? null;
      return {
        accountId,
        statementMonth: item.statementMonth ?? "",
        amount: moneyNumber(item.amount),
        periodStart: item.periodStart ?? "",
        periodEnd: item.periodEnd ?? "",
        dueDate: item.dueDate ?? "",
      };
    });
  }, [importComplete?.lockedStatementBills]);

  const statementPreviewItems = useMemo<StatementImportPreviewItem[]>(() => {
    if (!importPreview) return [];
    return importPreview.items.map((row) => {
      const accountId = row.selectedAccountId ?? row.matchedAccountId ?? importPreview.statementAccountId;
      return accountId ? { ...row.item, account: encodeImportAccountId(accountId) } : row.item;
    });
  }, [importPreview]);

  const renderLegacyImportPreview: boolean = false;

  function updatePreviewRow(rowKey: string, patch: Partial<ParsedItem>, accountId?: string | null) {
    if (!importPreview) return;
    const nextItems = importPreview.items.map((row) =>
      row.key === rowKey ? recomputePreviewRow(row, patch, accountId) : row
    );
    setImportPreview(recomputePreviewState(nextItems));
    setParsedItems(nextItems.map((row) => row.item));
  }

  function normalizedKey(value?: string | null) {
    return String(value ?? "").trim().replace(/[·•\-—_\s()[\]（）【】]/g, "").toLowerCase();
  }

  function isCreditStatement(item: ParsedItem) {
    return Boolean(item._meta?.institutionName || item._meta?.cardNumberMasked || /\u4fe1\u7528\u5361/.test(accountLabel(item)));
  }

  function resolvePreviewAccount(item: ParsedItem) {
    const accountsForMatch = bookLookupsRef.current.accounts;
    const label = accountLabel(item);
    const credit = isCreditStatement(item);
    const last4 = String(item._meta?.cardNumberMasked ?? "").trim();
    const bank = item._meta?.institutionName;
    const resolver = createImportAccountResolver(accountsForMatch);
    const candidates = Array.from(new Set([
      label,
      item.account,
      stripOwnerPrefix(label),
      bank && `${bank}\u4fe1\u7528\u5361`,
      bank && last4 ? `${bank}\u4fe1\u7528\u5361(${last4})` : "",
      bank && last4 ? `${bank}\u4fe1\u7528\u5361${last4}` : "",
    ].filter((value): value is string => Boolean(value?.trim()))));
    let found: BookAccount | null = null;
    for (const candidate of candidates) {
      const matched = resolver(candidate);
      if (!matched) continue;
      if (credit && matched.kind !== "bank_credit") continue;
      found = matched;
      break;
    }
    return { matchedAccountId: found?.id, selectedAccountId: found?.id };
  }

  function stripOwnerPrefix(value: string) {
    const match = value.trim().match(/^(.+?)\u7684(.+)$/);
    return match?.[2]?.trim() || value.trim();
  }

  function recomputePreviewState(items: ImportPreviewItem[]): ImportPreviewState {
    const selectedKeys = new Set(items.filter((row) => row.ready).map((row) => row.key));
    const accountIds = Array.from(new Set(items.map((row) => row.selectedAccountId ?? row.matchedAccountId).filter(Boolean)));
    return {
      items,
      selectedKeys,
      selectAll: items.length > 0 && selectedKeys.size === items.length,
      statementAccountId: accountIds.length === 1 ? accountIds[0] : importPreview?.statementAccountId,
    };
  }

  const selectedPreviewAccountName = useCallback((row: ImportPreviewItem) => {
    const accountId = row.selectedAccountId ?? row.matchedAccountId ?? importPreview?.statementAccountId;
    return bookAccounts.find((account) => account.id === accountId)?.name ?? null;
  }, [bookAccounts, importPreview?.statementAccountId]);
  const previewAccountDisplayOptions = useMemo(
    () => bookAccounts
      .map((account) => buildBookAccountDisplayOption(account))
      .sort((a, b) => a.selectorLabel.localeCompare(b.selectorLabel, "zh-Hans-CN")),
    [bookAccounts],
  );
  const previewAccountDisplayById = useMemo(
    () => new Map(previewAccountDisplayOptions.map((account) => [account.id, account])),
    [previewAccountDisplayOptions],
  );
  const previewAccountDisplayLabelById = useCallback((accountId?: string | null) => {
    if (!accountId) return null;
    const account = previewAccountDisplayById.get(accountId);
    return account ? formatAccountTableLabel(account, "", getAccountLabelFieldsPreference()) || null : null;
  }, [previewAccountDisplayById]);
  const previewAccountDisplayTitleById = useCallback((accountId?: string | null) => {
    if (!accountId) return null;
    const account = previewAccountDisplayById.get(accountId);
    return account ? formatAccountTableTitle(account, "", getAccountLabelFieldsPreference()) || null : null;
  }, [previewAccountDisplayById]);
  const selectedPreviewAccountDisplayLabel = useCallback((row: ImportPreviewItem) => {
    const accountId = row.selectedAccountId ?? row.matchedAccountId ?? importPreview?.statementAccountId;
    return previewAccountDisplayLabelById(accountId);
  }, [importPreview?.statementAccountId, previewAccountDisplayLabelById]);
  const selectedPreviewAccountDisplayTitle = useCallback((row: ImportPreviewItem) => {
    const accountId = row.selectedAccountId ?? row.matchedAccountId ?? importPreview?.statementAccountId;
    return previewAccountDisplayTitleById(accountId);
  }, [importPreview?.statementAccountId, previewAccountDisplayTitleById]);

  const hasImportPreview = importPreview !== null;
  const previewAccountReplaceOptions = useMemo<BatchReplaceOption[]>(() => {
    if (!hasImportPreview) return [{ value: "", label: t("batchImport.unselected") }];
    return [
      { value: "", label: t("batchImport.unselected") },
      ...previewAccountDisplayOptions
        .map((account) => ({ value: account.id, label: formatAccountTableLabel(account, "", getAccountLabelFieldsPreference()), title: formatAccountTableTitle(account, "", getAccountLabelFieldsPreference()) })),
    ];
  }, [hasImportPreview, previewAccountDisplayOptions, t]);
  const previewDebitAccountReplaceOptions = useMemo<BatchReplaceOption[]>(() => {
    if (!hasImportPreview) return [{ value: "", label: t("batchImport.unselected") }];
    return [
      { value: "", label: t("batchImport.unselected") },
      ...previewAccountDisplayOptions
        .map((account) => ({ value: account.id, label: formatAccountTableLabel(account, "", getAccountLabelFieldsPreference()), title: formatAccountTableTitle(account, "", getAccountLabelFieldsPreference()) })),
    ];
  }, [hasImportPreview, previewAccountDisplayOptions, t]);
  const previewDebitAccountDisplayOptions = useMemo(
    () => {
      if (!hasImportPreview) return [];
      return previewAccountDisplayOptions;
    },
    [hasImportPreview, previewAccountDisplayOptions],
  );
  const previewDebitAccountOptions = useMemo<SmartSelectOption[]>(
    () => {
      if (!hasImportPreview) return [];
      const displayById = new Map(previewDebitAccountDisplayOptions.map((account) => [account.id, account]));
      return buildGroupedAccountOptions(previewDebitAccountDisplayOptions).map((option) => {
        if (option.isHeader) return option;
        const account = displayById.get(option.id);
        return {
          ...option,
          subLabel: undefined,
          title: account ? formatAccountTableTitle(account, "", getAccountLabelFieldsPreference()) : option.title,
        };
      });
    },
    [hasImportPreview, previewDebitAccountDisplayOptions],
  );
  const {
    ownerFilterLabel: previewDebitOwnerFilterLabel,
    cycleOwnerFilter: cyclePreviewDebitOwnerFilter,
    filteredOptions: previewDebitAccountFilteredOptions,
    visibleOptionIds: previewDebitVisibleOptionIds,
  } = useAccountSSFilter(previewDebitAccountOptions);
  const displayPreviewDebitAccountOptions = useMemo(() => {
    const source = previewDebitAccountFilteredOptions?.length ? previewDebitAccountFilteredOptions : previewDebitAccountOptions;
    if (!previewDebitVisibleOptionIds) return source;
    return source.filter((option) => option.isHeader || previewDebitVisibleOptionIds.has(option.id));
  }, [previewDebitAccountFilteredOptions, previewDebitAccountOptions, previewDebitVisibleOptionIds]);
  const previewCategoryById = useMemo(
    () => new Map(bookCategories.map((category) => [category.id, category])),
    [bookCategories],
  );
  const previewCategorySelectValue = useCallback((categoryName: string | undefined, txType: ParsedItem["type"]) => {
    const name = String(categoryName ?? "").trim();
    if (!name) return "";
    const categoryType = txType === "income" ? "income" : "expense";
    const matched = bookCategories.find((category) => category.name === name && category.type === categoryType)
      ?? bookCategories.find((category) => category.name === name);
    return matched?.id ?? "";
  }, [bookCategories]);
  const previewCategoryNameById = useCallback((categoryId: string) => {
    if (!categoryId) return "";
    return previewCategoryById.get(categoryId)?.name ?? "";
  }, [previewCategoryById]);
  const previewCategoryReplaceOptions = useMemo<BatchReplaceOption[]>(() => {
    if (!hasImportPreview) return [];
    const typeLabels: Record<string, string> = { expense: t("stats.expenseCategories"), income: t("statementImportPreview.incomeCategories") };
    const options: BatchReplaceOption[] = [{ value: "", label: t("statementImportPreview.clearCategory") }];
    const indent = "\u3000";

    for (const type of ["expense", "income"]) {
      const typedCategories = bookCategories.filter((category) => category.type === type);
      if (typedCategories.length === 0) continue;
      const childrenByParentId = new Map<string | null, typeof typedCategories>();
      for (const category of typedCategories) {
        const key = category.parentId ?? null;
        const list = childrenByParentId.get(key) ?? [];
        list.push(category);
        childrenByParentId.set(key, list);
      }
      for (const [parentId, list] of childrenByParentId) {
        childrenByParentId.set(parentId, sortCategorySources(list));
      }

      const headerId = `preview-category-type:${type}`;
      options.push({ value: headerId, label: typeLabels[type] ?? type, isHeader: true });

      function walk(parentId: string | null, level: number, parentOptionId: string) {
        const children = childrenByParentId.get(parentId) ?? [];
        for (const child of children) {
          const hasChildren = (childrenByParentId.get(child.id) ?? []).length > 0;
          options.push({
            value: child.id,
            label: `${indent.repeat(level)}${child.name}`,
            subLabel: typeLabels[type] ?? type,
            parentId: parentOptionId,
            isGroup: hasChildren,
          });
          if (hasChildren) walk(child.id, level + 1, child.id);
        }
      }

      walk(null, 0, headerId);
    }

    return options;
  }, [bookCategories, hasImportPreview, t]);
  const previewCategorySmartSelectOptionsFor = useCallback((txType: ParsedItem["type"]): SmartSelectOption[] => {
    const categoryType = txType === "income" ? "income" : "expense";
    const typedCategories = bookCategories.filter((category) => category.type === categoryType);
    const childrenByParentId = new Map<string | null, typeof typedCategories>();
    for (const category of typedCategories) {
      const key = category.parentId ?? null;
      const list = childrenByParentId.get(key) ?? [];
      list.push(category);
      childrenByParentId.set(key, list);
    }
    for (const [parentId, list] of childrenByParentId) {
      childrenByParentId.set(parentId, sortCategorySources(list));
    }

    const options: SmartSelectOption[] = [{ id: "", label: t("statementImportPreview.clearCategory") }];
    function walk(parentId: string | null, level: number, parentOptionId?: string) {
      const children = childrenByParentId.get(parentId) ?? [];
      for (const child of children) {
        const hasChildren = (childrenByParentId.get(child.id) ?? []).length > 0;
        options.push({
          id: child.id,
          label: `${"\u3000".repeat(level)}${child.name}`,
          parentId: parentOptionId,
          isGroup: hasChildren,
        });
        if (hasChildren) walk(child.id, level + 1, child.id);
      }
    }
    walk(null, 0);
    return options;
  }, [bookCategories, t]);
  const previewReplaceFields = useMemo<BatchReplaceFieldConfig<ImportPreviewEditableCell>[]>(() => {
    if (!hasImportPreview) return [];
    return [
      { value: "date", label: importPreviewFieldLabels.date, kind: "text", placeholder: t("statementImportPreview.datePlaceholder") },
      { value: "postedDate", label: importPreviewFieldLabels.postedDate, kind: "date", placeholder: "YYYY-MM-DD" },
      {
        value: "type",
        label: importPreviewFieldLabels.type,
        kind: "select",
        options: [
          { value: "", label: t("batchImport.selectType") },
          ...previewTypeOptions,
        ],
      },
      {
        value: "account",
        label: importPreviewFieldLabels.account,
        kind: "smartSelect",
        options: previewAccountReplaceOptions,
        smartSelectBehavior: { search: true, density: "micro", dropdownMaxHeight: 180, minDropdownWidth: 156, resizableDropdown: true },
      },
      {
        value: "counterAccount",
        label: importPreviewFieldLabels.counterAccount,
        kind: "smartSelect",
        options: previewDebitAccountReplaceOptions,
        smartSelectBehavior: { search: true, density: "micro", dropdownMaxHeight: 180, minDropdownWidth: 156, resizableDropdown: true },
      },
      {
        value: "category",
        label: importPreviewFieldLabels.category,
        kind: "smartSelect",
        options: previewCategoryReplaceOptions,
        placeholder: t("statementImportPreview.selectCategory"),
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
      { value: "institution", label: importPreviewFieldLabels.institution, kind: "text", placeholder: t("statementImportPreview.institutionPlaceholder") },
      { value: "outflow", label: importPreviewFieldLabels.outflow, kind: "number", placeholder: t("statementImportPreview.amountExpressionPlaceholder") },
      { value: "inflow", label: importPreviewFieldLabels.inflow, kind: "number", placeholder: t("statementImportPreview.amountExpressionPlaceholder") },
      { value: "amount", label: importPreviewFieldLabels.amount, kind: "number", placeholder: t("statementImportPreview.amountExpressionPlaceholder") },
      { value: "remark", label: importPreviewFieldLabels.remark, kind: "text", placeholder: t("statementImportPreview.remarkPlaceholder") },
    ];
  }, [hasImportPreview, importPreviewFieldLabels, previewTypeOptions, previewAccountReplaceOptions, previewCategoryReplaceOptions, previewDebitAccountReplaceOptions, t]);

  const previewDebitAccountIdFromName = useCallback((accountName: string) => {
    return accountIdFromName(accountName);
  }, [bookAccounts]);

  const previewDebitAccountDisplayLabelByName = useCallback((accountName: string) => {
    const accountId = previewDebitAccountIdFromName(accountName);
    if (!accountId) return cleanOptionalText(accountName) || null;
    return previewAccountDisplayLabelById(accountId) || cleanOptionalText(accountName) || null;
  }, [previewAccountDisplayLabelById, previewDebitAccountIdFromName]);

  function recomputePreviewRow(row: ImportPreviewItem, itemPatch: Partial<ParsedItem>, accountId?: string | null): ImportPreviewItem {
    let item = { ...row.item, ...itemPatch };
    if ("postedDate" in itemPatch) {
      item.postedDate = normalizeDateOnlyText(itemPatch.postedDate);
    }
    if ("date" in itemPatch && !("postedDate" in itemPatch)) {
      const previousDate = normalizeDateOnlyText(row.item.date);
      const previousPostedDate = normalizeDateOnlyText(row.item.postedDate);
      const nextDate = normalizeDateOnlyText(itemPatch.date);
      if (!previousPostedDate || previousPostedDate === previousDate) {
        item.postedDate = nextDate;
      }
    }
    if (itemPatch.type === "transfer") {
      item = {
        ...item,
        account: item.account || primaryAccountNameForItem(item, row),
        fromAccount: item.fromAccount || undefined,
        toAccount: undefined,
      };
    } else if (itemPatch.type) {
      item = {
        ...item,
        account: item.account || item.fromAccount || primaryAccountNameForItem(item, row),
        fromAccount: undefined,
        toAccount: undefined,
      };
    }
    item = normalizeTransferFlow(item);
    const resolved = accountId === undefined
      ? (row.selectedAccountId || row.matchedAccountId ? { selectedAccountId: row.selectedAccountId, matchedAccountId: row.matchedAccountId } : resolvePreviewAccount(item))
      : { selectedAccountId: accountId || undefined, matchedAccountId: accountId || undefined };
    const hasResolvedAccount = Boolean(resolved.selectedAccountId || resolved.matchedAccountId || importPreview?.statementAccountId);
    const missingFields = getPreviewMissingFields(item, hasResolvedAccount);
    const ready = isPreviewRowReady(item, hasResolvedAccount);
    return {
      ...row,
      item,
      ...resolved,
      missingFields,
      ready,
    };
  }

  function applyPreviewReplace(field: ImportPreviewEditableCell, value: string) {
    if (!importPreview) throw new Error(t("settings.email.noImportPreview"));
    const selectedPreviewKeys = Array.from(importPreview.selectedKeys);
    if (selectedPreviewKeys.length === 0) throw new Error(t("stockPanel.error.selectRowsFirst"));
    let changed = 0;
    let invalid = 0;
    const nextItems = importPreview.items.map((row) => {
      if (!importPreview.selectedKeys.has(row.key)) return row;
      if (field === "amount" || field === "inflow" || field === "outflow") {
        const currentValue = field === "amount"
          ? row.item.amount
          : Number(row.item[field] ?? 0) || 0;
        const computed = evaluateCalcInputExpression(value, currentValue);
        if (computed == null) {
          invalid++;
          return row;
        }
        changed++;
        return field === "amount"
          ? recomputePreviewRow(row, amountPatchForPreviewItem(row.item, computed))
          : recomputePreviewRow(row, flowAmountPatchForPreviewItem(row.item, field, computed));
      }
      changed++;
      if (field === "type") return recomputePreviewRow(row, { type: value as ParsedItem["type"] });
      if (field === "account") {
        const nextName = accountNameFromId(value) ?? undefined;
        return recomputePreviewRow(row, { account: nextName }, value || null);
      }
      if (field === "counterAccount") {
        const nextName = accountNameFromId(value) ?? undefined;
        const direction = previewTransferDirection(row.item);
        return recomputePreviewRow(row, direction === "in"
          ? { fromAccount: nextName, transferDirection: "in", inflow: row.item.inflow || row.item.amount, outflow: undefined }
          : { toAccount: nextName, transferDirection: "out", outflow: row.item.outflow || row.item.amount, inflow: undefined });
      }
      if (field === "category") {
        const nextName = value ? previewCategoryById.get(value)?.name ?? value : undefined;
        return recomputePreviewRow(row, { category: nextName });
      }
      return recomputePreviewRow(row, { [field]: value || undefined } as Partial<ParsedItem>);
    });
    setImportPreview(recomputePreviewState(nextItems));
    setParsedItems(nextItems.map((row) => row.item));
    const invalidSuffix = invalid > 0 ? t("statementImportPreview.invalidAmountSkipped", { count: invalid }) : "";
    return t("statementImportPreview.batchReplaceResult", { count: changed, field: importPreviewFieldLabels[field], invalidSuffix });
  }

  function updatePreviewAccount(rowKey: string, accountId: string) {
    if (!importPreview) return;
    const target = importPreview.items.find((row) => row.key === rowKey);
    const account = bookAccounts.find((item) => item.id === accountId);
    if (!target || !account) return;
    const targetLabel = accountLabel(target.item);
    const nextItems = importPreview.items.map((row) => {
      if (accountLabel(row.item) !== targetLabel) return row;
      const item = { ...row.item, account: account.name };
      const missingFields = getPreviewMissingFields(item, true);
      const ready = isPreviewRowReady(item, true);
      return { ...row, item, selectedAccountId: account.id, matchedAccountId: account.id, missingFields, ready };
    });
    setImportPreview(recomputePreviewState(nextItems));
    setParsedItems((current) => current.map((item) => accountLabel(item) === targetLabel ? { ...item, account: account.name } : item));
  }

  function applyPreviewAccountFromCreated(rowKey: string, account: BookAccount) {
    if (!importPreview) return;
    const target = importPreview.items.find((row) => row.key === rowKey);
    if (!target) return;
    const targetLabel = accountLabel(target.item);
    const nextItems = importPreview.items.map((row) => {
      if (accountLabel(row.item) !== targetLabel) return row;
      const item = { ...row.item, account: account.name };
      const missingFields = getPreviewMissingFields(item, true);
      const ready = isPreviewRowReady(item, true);
      return { ...row, item, selectedAccountId: account.id, matchedAccountId: account.id, missingFields, ready };
    });
    setImportPreview(recomputePreviewState(nextItems));
    setParsedItems((current) => current.map((item) => accountLabel(item) === targetLabel ? { ...item, account: account.name } : item));
  }

  function clearPreviewAccount(rowKey: string) {
    if (!importPreview) return;
    const target = importPreview.items.find((row) => row.key === rowKey);
    if (!target) return;
    const targetLabel = accountLabel(target.item);
    const nextItems = importPreview.items.map((row) => {
      if (accountLabel(row.item) !== targetLabel) return row;
      const item = { ...row.item, account: undefined };
      return {
        ...row,
        item,
        selectedAccountId: undefined,
        matchedAccountId: undefined,
        ready: false,
        missingFields: getPreviewMissingFields(item, false),
      };
    });
    setImportPreview(recomputePreviewState(nextItems));
  }

  function openAccountDraft(row: ImportPreviewItem) {
    const item = row.item;
    const bankName = item._meta?.institutionName ?? "";
    const ownerName = item._meta?.ownerName ?? "";
    const institution = bookLookupsRef.current.institutions.find((inst) => normalizedKey(inst.name) === normalizedKey(bankName) || normalizedKey(inst.shortName) === normalizedKey(bankName));
    const user = bookLookupsRef.current.users.find((u) => normalizedKey(u.name) === normalizedKey(ownerName));
    setAccountDraft({
      rowKey: row.key,
      name: item.account || accountLabel(item),
      kind: isCreditStatement(item) ? "bank_credit" : "bank_debit",
      institutionName: bankName,
      institutionId: institution?.id ?? "",
      ownerName,
      userId: user?.id ?? "",
      numberMasked: item._meta?.cardNumberMasked ?? "",
      creditLimit: item._meta?.creditLimit != null ? String(item._meta.creditLimit) : "",
      billingDay: item._meta?.billingDay != null ? String(item._meta.billingDay) : "",
      repaymentDay: item._meta?.repaymentDay != null ? String(item._meta.repaymentDay) : "",
    });
  }

  async function ensureInstitutionForDraft(draft: AccountCreateDraft) {
    if (draft.institutionId) return draft.institutionId;
    const name = draft.institutionName.trim();
    if (!name) return "";
    const existing = bookInstitutions.find((inst) => normalizedKey(inst.name) === normalizedKey(name) || normalizedKey(inst.shortName) === normalizedKey(name));
    if (existing) return existing.id;
    const res = await fetch("/api/v1/institution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, shortName: name, type: "bank" }),
    });
    const data = await res.json();
    if (!data.ok && res.status !== 409) throw new Error(data.error ?? t("settings.email.createInstitutionFailed"));
    if (data.ok && data.institution) {
      setBookInstitutions((current) => [...current, data.institution]);
      return data.institution.id;
    }
    const lookups = await loadBookLookups();
    const retry = lookups.institutions.find((inst) => normalizedKey(inst.name) === normalizedKey(name));
    return retry?.id ?? "";
  }

  async function createAccountFromDraft() {
    if (!accountDraft?.name.trim()) return;
    setSavingAccountDraft(true); setError("");
    try {
      const institutionId = await ensureInstitutionForDraft(accountDraft);
      const res = await fetch("/api/v1/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: accountDraft.name.trim(),
          kind: accountDraft.kind,
          institutionId: institutionId || undefined,
          userId: accountDraft.userId || undefined,
          numberMasked: accountDraft.numberMasked.trim() || undefined,
          creditLimit: accountDraft.creditLimit.trim() || undefined,
          billingDay: accountDraft.billingDay.trim() || undefined,
          repaymentDay: accountDraft.repaymentDay.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? t("settings.email.createAccountFailed"));
      const created: BookAccount = data.account;
      setBookAccounts((current) => [...current, created]);
      setAccountDraft(null);
      applyPreviewAccountFromCreated(accountDraft.rowKey, created);
      await loadBookLookups();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.email.createAccountFailed"));
    } finally {
      setSavingAccountDraft(false);
    }
  }

  function typeLabel(type: ParsedItem["type"]) {
    if (type === "income") return t("transaction.type.income");
    if (type === "transfer") return t("transaction.type.transfer");
    if (type === "investment") return t("transaction.type.investment");
    return t("transaction.type.expense");
  }

  function accountLabel(item: ParsedItem) {
    if (item.account) return item.account;
    const bank = item._meta?.institutionName;
    const last4 = item._meta?.cardNumberMasked;
    if (bank) return `${bank}\u4fe1\u7528\u5361${last4 ? `(${last4})` : ""}`;
    return t("settings.email.unrecognizedAccount");
  }

  const importPreviewColumns: AdvancedDataTableColumn<ImportPreviewItem>[] = [
    {
      key: "date",
      label: importPreviewFieldLabels.date,
      width: 100,
      minWidth: 84,
      filterKind: "dateRange",
      filterText: (row) => row.item.date?.trim() || t("settings.email.emptyFilter"),
      sortValue: (row) => row.item.date || "",
      render: (row) => <span className="whitespace-nowrap tabular-nums text-slate-700">{row.item.date || "-"}</span>,
    },
    {
      key: "postedDate",
      label: importPreviewFieldLabels.postedDate,
      width: 110,
      minWidth: 96,
      filterKind: "dateRange",
      filterText: (row) => normalizeDateOnlyText(row.item.postedDate) || t("settings.email.emptyFilter"),
      sortValue: (row) => normalizeDateOnlyText(row.item.postedDate) || "",
      render: (row) => {
        const item = row.item;
        return (
          <div className="whitespace-nowrap tabular-nums text-slate-500" onDoubleClick={() => setEditingPreviewCell({ rowKey: row.key, field: "postedDate" })}>
            {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "postedDate" ? (
              <DateStepper
                autoFocus
                className="h-8 rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
                value={normalizeDateOnlyText(item.postedDate) ?? ""}
                onBlur={() => setEditingPreviewCell(null)}
                onChange={(value) => {
                  updatePreviewRow(row.key, { postedDate: value || undefined });
                  setEditingPreviewCell(null);
                }}
              />
            ) : (
              <span className="cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={t("statementImportPreview.doubleClickEdit", { field: t("detail.column.postedAt") })}>{normalizeDateOnlyText(item.postedDate) || "-"}</span>
            )}
          </div>
        );
      },
    },
    {
      key: "type",
      label: importPreviewFieldLabels.type,
      width: 72,
      minWidth: 60,
      filterText: (row) => typeLabel(row.item.type),
      render: (row) => {
        const item = row.item;
        return (
          <div className="whitespace-nowrap text-slate-700" onDoubleClick={() => setEditingPreviewCell({ rowKey: row.key, field: "type" })}>
            {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "type" ? (
              <select
                autoFocus
                className="h-8 rounded-md border border-blue-200 bg-white px-2 text-xs outline-none"
                value={item.type}
                onBlur={() => setEditingPreviewCell(null)}
                onChange={(e) => {
                  updatePreviewRow(row.key, { type: e.target.value as ParsedItem["type"] });
                  setEditingPreviewCell(null);
                }}
              >
                {previewTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : (
              <span className="cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={t("statementImportPreview.doubleClickEdit", { field: t("batchImport.field.type") })}>{typeLabel(item.type)}</span>
            )}
          </div>
        );
      },
    },
    {
      key: "account",
      label: importPreviewFieldLabels.account,
      width: 190,
      minWidth: 140,
      filterText: (row) => selectedPreviewAccountDisplayLabel(row) || accountLabel(row.item) || t("settings.email.emptyFilter"),
      render: (row) => {
        const item = row.item;
        const accountId = row.selectedAccountId ?? row.matchedAccountId ?? importPreview?.statementAccountId ?? "";
        const displayLabel = selectedPreviewAccountDisplayLabel(row) ?? accountLabel(item);
        const displayTitle = selectedPreviewAccountDisplayTitle(row) ?? accountLabel(item);
        return (
          <div className="min-w-[180px] text-slate-700" onDoubleClick={() => setEditingPreviewCell({ rowKey: row.key, field: "account" })}>
            {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "account" ? (
              <SmartSelect
                mode="single"
                value={accountId}
                onChange={(selectedId) => {
                  if (selectedId) updatePreviewAccount(row.key, selectedId);
                  else clearPreviewAccount(row.key);
                  setEditingPreviewCell(null);
                }}
                options={displayPreviewDebitAccountOptions}
                placeholder={t("statementImportPreview.selectAccount")}
                onCreateClick={() => openAccountDraft(row)}
                createLabel={t("settings.accounts.add")}
                onCycleOwnerFilter={cyclePreviewDebitOwnerFilter}
                ownerFilterLabel={previewDebitOwnerFilterLabel}
                behavior={{
                  search: true,
                  hierarchy: true,
                  clearable: true,
                  cycleSelectionWithArrowKeys: true,
                  minDropdownWidth: 216,
                  dropdownMaxHeight: 180,
                  density: "micro",
                  resizableDropdown: true,
                  autoOpen: true,
                  onDropdownClose: () => setEditingPreviewCell(null),
                }}
              />
            ) : (
              <span className="block truncate cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={displayTitle}>
                {displayLabel || "-"}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "counterAccount",
      label: importPreviewFieldLabels.counterAccount,
      width: 160,
      minWidth: 120,
      filterText: (row) => cleanOptionalText(row.item.fromAccount) || cleanOptionalText(row.item.toAccount) || t("settings.email.emptyFilter"),
      render: (row) => {
        const item = row.item;
        if (item.type !== "transfer") return <span className="text-slate-400">-</span>;
        return (
          <div className="min-w-[170px] space-y-1" onDoubleClick={() => setEditingPreviewCell({ rowKey: row.key, field: "counterAccount" })}>
            {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "counterAccount" ? (
              <SmartSelect
                mode="single"
                value={previewDebitAccountIdFromName(item.fromAccount ?? item.toAccount ?? "") ?? ""}
                onChange={(accountId) => {
                  const nextName = accountNameFromId(accountId);
                  const direction = previewTransferDirection(item);
                  const nextItems = importPreview!.items.map((previewRow) =>
                    previewRow.key === row.key
                      ? recomputePreviewRow(previewRow, direction === "in"
                        ? { fromAccount: nextName, transferDirection: "in", inflow: item.inflow || item.amount, outflow: undefined }
                        : { toAccount: nextName, transferDirection: "out", outflow: item.outflow || item.amount, inflow: undefined })
                      : previewRow
                  );
                  setImportPreview(recomputePreviewState(nextItems));
                  setParsedItems(nextItems.map((previewRow) => previewRow.item));
                  setEditingPreviewCell(null);
                }}
                options={displayPreviewDebitAccountOptions}
                placeholder={t("statementImportPreview.selectCounterAccount")}
                onCreateClick={() => openDebitAccountDraft(row.key)}
                createLabel={t("settings.accounts.add")}
                onCycleOwnerFilter={cyclePreviewDebitOwnerFilter}
                ownerFilterLabel={previewDebitOwnerFilterLabel}
                behavior={{
                  search: true,
                  hierarchy: true,
                  clearable: true,
                  cycleSelectionWithArrowKeys: true,
                  minDropdownWidth: 216,
                  dropdownMaxHeight: 180,
                  density: "micro",
                  resizableDropdown: true,
                  autoOpen: true,
                  onDropdownClose: () => setEditingPreviewCell(null),
                }}
              />
            ) : (
              <span className="block truncate cursor-pointer rounded px-1 py-0.5 text-slate-700 hover:bg-slate-100" title={t("statementImportPreview.doubleClickEdit", { field: t("batchImport.field.counterAccount") })}>
                {previewDebitAccountDisplayLabelByName(cleanOptionalText(item.fromAccount) || cleanOptionalText(item.toAccount) || "") || cleanOptionalText(item.fromAccount) || cleanOptionalText(item.toAccount) || "-"}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "category",
      label: importPreviewFieldLabels.category,
      width: 98,
      minWidth: 80,
      filterText: (row) => row.item.category?.trim() || t("settings.email.emptyFilter"),
      render: (row) => {
        const item = row.item;
        return (
          <div className="w-full min-w-0 truncate whitespace-nowrap text-slate-700" onDoubleClick={() => setEditingPreviewCell({ rowKey: row.key, field: "category" })}>
            {editingPreviewCell?.rowKey === row.key && editingPreviewCell.field === "category" ? (
              <div className="w-full min-w-0">
                <SmartSelect
                  mode="single"
                  value={previewCategorySelectValue(item.category, item.type)}
                  onChange={(categoryId) => {
                    updatePreviewRow(row.key, { category: previewCategoryNameById(categoryId) || undefined });
                    setEditingPreviewCell(null);
                  }}
                  options={previewCategorySmartSelectOptionsFor(item.type)}
                  placeholder={t("statementImportPreview.selectCategory")}
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
                    showGroupCounts: false,
                    onDropdownClose: () => setEditingPreviewCell(null),
                  }}
                />
              </div>
            ) : (
              <span className="cursor-pointer rounded px-1 py-0.5 hover:bg-slate-100" title={t("statementImportPreview.doubleClickEdit", { field: t("batchImport.field.category") })}>{item.category || "-"}</span>
            )}
          </div>
        );
      },
    },
    {
      key: "institution",
      label: importPreviewFieldLabels.institution,
      width: 108,
      minWidth: 90,
      filterText: (row) => row.item.institution?.trim() || t("settings.email.emptyFilter"),
      render: (row) => <span className="block truncate text-slate-700" title={row.item.institution || "-"}>{row.item.institution || "-"}</span>,
    },
    {
      key: "inflow",
      label: importPreviewFieldLabels.inflow,
      width: 82,
      minWidth: 70,
      truncate: true,
      align: "right",
      filterKind: "numberRange",
      filterText: (row) => importPreviewFlowAmountTextFor(row.item, "inflow"),
      filterNumber: (row) => row.item.inflow ?? (row.item.type === "income" ? row.item.amount : 0),
      sortValue: (row) => row.item.inflow ?? (row.item.type === "income" ? row.item.amount : 0),
      render: (row) => <span className={`whitespace-nowrap tabular-nums ${importPreviewFlowAmountColorFor(row.item, "inflow", getColorSchemeFromCookie(typeof document === "undefined" ? null : document.cookie))}`}>{importPreviewFlowAmountTextFor(row.item, "inflow")}</span>,
    },
    {
      key: "outflow",
      label: importPreviewFieldLabels.outflow,
      width: 82,
      minWidth: 70,
      truncate: true,
      align: "right",
      filterKind: "numberRange",
      filterText: (row) => importPreviewFlowAmountTextFor(row.item, "outflow"),
      filterNumber: (row) => row.item.outflow ?? (row.item.type === "expense" && !row.item.inflow ? row.item.amount : 0),
      sortValue: (row) => row.item.outflow ?? (row.item.type === "expense" && !row.item.inflow ? row.item.amount : 0),
      render: (row) => <span className={`whitespace-nowrap tabular-nums ${importPreviewFlowAmountColorFor(row.item, "outflow", getColorSchemeFromCookie(typeof document === "undefined" ? null : document.cookie))}`}>{importPreviewFlowAmountTextFor(row.item, "outflow")}</span>,
    },
    {
      key: "remark",
      label: importPreviewFieldLabels.remark,
      width: 230,
      minWidth: 160,
      filterText: (row) => (row.item.remark || row.item.rawText || "").trim() || t("settings.email.emptyFilter"),
      render: (row) => <span className="block truncate text-slate-600" title={row.item.remark || row.item.rawText}>{row.item.remark || row.item.rawText}</span>,
    },
    {
      key: "status",
      label: t("statementImportPreview.status"),
      width: 88,
      minWidth: 72,
      filterText: (row) => row.ready ? t("statementImportPreview.importable") : row.missingFields.includes(t("batchImport.field.account")) ? t("statementImportPreview.missingFields", { fields: t("batchImport.field.account") }) : t("statementImportPreview.missingFields", { fields: row.missingFields.join("\u3001") || t("statementImportPreview.field") }),
      render: (row) => row.ready ? (
        <span className="text-[11px] text-slate-400">-</span>
      ) : (
        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700">
          {row.missingFields.includes(t("batchImport.field.account")) ? t("settings.email.selectOrCreateAccount") : t("statementImportPreview.missingFields", { fields: row.missingFields.join("\u3001") })}
        </span>
      ),
    },
  ];

  function formatAttachmentSize(size: number) {
    if (!Number.isFinite(size) || size <= 0) return "";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  return (
    <div className="space-y-4">
      {!embedded && <h2 className="text-sm font-semibold text-slate-800">{t("settings.email.title")}</h2>}

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>}
      {info && <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-700">{info}</div>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[210px_minmax(0,1fr)]">
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-slate-800">{t("settings.emailAccounts")}</div>
            <SettingsPrimaryAddButton onClick={openCreateAccountModal}>{t("settings.email.add")}</SettingsPrimaryAddButton>
          </div>
          <div className="max-h-[220px] space-y-2 overflow-y-auto pr-1">
            {loadingAccounts ? (
              <div className="rounded-md border border-dashed border-slate-200 px-3 py-8 text-center text-xs text-slate-400">{t("settings.email.loadingAccounts")}</div>
            ) : accounts.length > 0 ? accounts.map(acc => (
              <div key={acc.id} className={`flex items-center gap-2 rounded-md border px-2.5 py-2 ${selectedId === acc.id ? "border-blue-300 bg-blue-50" : "border-slate-200 hover:bg-slate-50"}`}>
                <button className="min-w-0 flex-1 text-left" onClick={() => selectAccountForMail(acc.id)}>
                  <div className="truncate text-sm font-medium text-slate-800">{acc.label}</div>
                  <div className="truncate text-[11px] text-slate-500">{acc.username}</div>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <SettingsActionButton
                    label={t("settings.email.editAccount")}
                    variant="edit"
                    onClick={(e) => { e.stopPropagation(); editAccount(acc); }}
                  />
                  <SettingsActionButton
                    label={t("settings.email.deleteAccount")}
                    variant="delete"
                    onClick={(e) => { e.stopPropagation(); deleteAccount(acc.id); }}
                  />
                </div>
              </div>
            )) : (
              <div className="rounded-md border border-dashed border-slate-200 px-3 py-8 text-center text-xs text-slate-400">{t("settings.email.noAccounts")}</div>
            )}
          </div>
        </div>
        <div className="min-h-[520px] rounded-lg border border-slate-200 bg-white p-4">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
            <div className="overflow-hidden rounded-md border border-slate-200">
              <div className="border-b border-slate-100 bg-slate-50 p-2">
                <div className="mb-2 text-sm font-medium text-slate-800">{selectedAccount ? selectedAccount.label : t("settings.email.mailReading")}</div>
                <div className="grid grid-cols-[minmax(0,1fr)_58px] items-center gap-2">
                  <label className="flex h-8 min-w-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600">
                    <span className="shrink-0 text-slate-500">{t("settings.email.keywordPrefix")}</span>
                    <input
                      aria-label={t("settings.email.keywordInputLabel")}
                      className="min-w-0 flex-1 bg-transparent text-xs text-slate-700 outline-none"
                      value={mailKeywordDraft}
                      onChange={(e) => setMailKeywordDraft(e.target.value)}
                      placeholder={t("settings.email.keywordPlaceholder")}
                    />
                  </label>
                  <button className="h-8 rounded-md border border-slate-200 bg-white px-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50" onClick={saveMailKeyword} disabled={!mailKeywordDirty || savingMailKeyword}>
                    {savingMailKeyword ? t("settings.email.saving") : t("common.save")}
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_92px] items-center gap-2">
                  <label className="flex h-8 min-w-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600">
                    <span className="shrink-0 text-slate-500">{t("settings.email.dateStart")}</span>
                    <input
                      aria-label={t("settings.email.startDateInputLabel")}
                      className="min-w-0 flex-1 bg-transparent text-xs text-slate-700 outline-none"
                      type="date"
                      value={mailStartDate}
                      onChange={(e) => setMailStartDate(e.target.value)}
                    />
                  </label>
                  <label className="flex h-8 min-w-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-xs text-slate-600">
                    <span className="shrink-0 text-slate-500">{t("settings.email.dateEnd")}</span>
                    <input
                      aria-label={t("settings.email.endDateInputLabel")}
                      className="min-w-0 flex-1 bg-transparent text-xs text-slate-700 outline-none"
                      type="date"
                      value={mailEndDate}
                      onChange={(e) => setMailEndDate(e.target.value)}
                    />
                  </label>
                  <button className="h-8 rounded-md bg-blue-600 text-xs text-white hover:bg-blue-700 disabled:opacity-50" onClick={() => listMails()} disabled={!selectedAccount || loadingMails}>
                    {loadingMails ? t("settings.email.readingMails") : t("settings.email.fetchMails")}
                  </button>
                </div>
                <div className="text-[11px] leading-5 text-slate-500">{t("settings.email.searchLimitHint", { limit: MAIL_SEARCH_LIMIT })}</div>
                {mailListHint && <div className="text-[11px] leading-5 text-blue-600">{mailListHint}</div>}
              </div>
              <div className="max-h-[430px] overflow-auto divide-y divide-slate-100">
                {mailItems.map(m => (
                  <button key={m.uid} className={`w-full text-left px-2.5 py-2 text-xs ${selectedMail?.uid === m.uid ? "bg-blue-50" : "hover:bg-slate-50"}`}
                    onClick={() => fetchMail(m.uid)}>
                    <div className="truncate font-medium text-slate-800">{m.subject || t("settings.email.noSubject")}</div>
                    <div className="truncate text-[11px] text-slate-500">{m.from}</div>
                    <div className="mt-0.5 text-[10px] text-slate-400">{m.date}</div>
                  </button>
                ))}
                {mailItems.length === 0 && !loadingMails && (
                  <div className="px-3 py-10 text-xs text-slate-500">{selectedAccount ? t("settings.email.clickToFetch") : t("settings.email.selectAccountFirst")}</div>
                )}
              </div>
            </div>

            <div className="space-y-3">
              {selectedMail ? (
                <>
                  <div className="text-xs text-slate-500">
                    {t("settings.email.senderDate", { from: selectedMail.from, date: selectedMail.date })}
                  </div>
                  <iframe
                    className="h-[360px] w-full rounded-md border border-slate-200 bg-white"
                    sandbox="allow-popups allow-popups-to-escape-sandbox"
                    srcDoc={buildMailPreviewHtml(selectedMail)}
                    title={t("settings.email.mailPreviewTitle")}
                  />
                  {selectedMail.attachments && selectedMail.attachments.length > 0 && (
                    <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
                      <div className="mb-1 text-xs font-medium text-slate-700">{t("settings.email.attachments")}</div>
                      <div className="space-y-1.5">
                        {selectedMail.attachments.map((attachment) => (
                          <div key={attachment.id} className="rounded border border-slate-100 bg-white px-2 py-1.5 text-xs text-slate-600">
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate font-medium text-slate-700">{attachment.filename || t("settings.email.unnamedAttachment")}</span>
                              <span className="shrink-0 text-slate-400">{formatAttachmentSize(attachment.size)}</span>
                            </div>
                            {attachment.text ? (
                              <div className="mt-0.5 text-emerald-700">{t("settings.email.pdfTextExtracted")}</div>
                            ) : attachment.parseError ? (
                              <div className="mt-0.5 text-amber-700">{attachment.parseError}</div>
                            ) : (
                              <div className="mt-0.5 text-slate-400">{attachment.contentType || t("settings.email.attachments")}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <button className="h-8 px-3 rounded-md bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-50" onClick={() => parseMail(selectedMail, true)} disabled={parsing}>
                      {parsing ? t("settings.email.recognizing") : t("settings.email.importBill")}
                    </button>
                  </div>
                </>
              ) : (
                <div className="rounded-md border border-dashed border-slate-200 px-3 py-10 text-center text-sm text-slate-400">{t("settings.email.selectMailHint")}</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <StatementImportPreviewDialog
        open={Boolean(importPreview)}
        title={t("viewImport.previewTitle")}
        description={t("settings.email.recognizedItems", { count: statementPreviewItems.length })}
        items={statementPreviewItems}
        defaultAccountName=""
        busy={importing}
        onClose={() => {
          if (!importing) {
            setImportPreview(null);
            onStatementPreviewClosed?.();
          }
        }}
        onConfirm={importItems}
      />

      {importComplete && !importPreview && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 px-4 py-6">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div className="text-sm font-semibold text-slate-800">{t("batchImport.importPhase.done")}</div>
              <div className="mt-0.5 text-xs text-slate-500">{t("settings.email.createdSkipped", { created: importComplete.created, skipped: importComplete.skipped })}</div>
            </div>
            <div className="space-y-2 px-4 py-4 text-xs text-slate-600">
              {importCompleteLockedBills.length > 0 ? (
                <div>
                  {t("settings.email.locked")}{importCompleteLockedBills.map((item) => {
                    const accountText = previewAccountDisplayLabelById(item.accountId) ?? t("settings.email.billAccount");
                    const amountText = formatMoneyAmount(item.amount);
                    const periodText = item.periodStart || item.periodEnd ? t("settings.email.periodRange", { start: item.periodStart || "?", end: item.periodEnd || "?" }) : "";
                    const dueText = item.dueDate ? t("settings.email.dueDate", { date: item.dueDate }) : "";
                    return [item.statementMonth || t("settings.email.unknownMonth"), accountText, amountText, periodText, dueText].filter(Boolean).join(" · ");
                  }).join("；")}
                </div>
              ) : (
                <div>{t("settings.email.importDoneConfirm")}</div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3">
              <button className="h-9 rounded-md bg-green-600 px-4 text-sm text-white hover:bg-green-700" onClick={confirmImportComplete}>
                {importComplete.accountId ? t("settings.email.confirmOpenAccount") : t("settings.email.confirmBackHome")}
              </button>
            </div>
          </div>
        </div>
      )}

      {renderLegacyImportPreview && importPreview && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 px-4 py-6">
          <div data-smart-select-boundary className="flex h-[82vh] min-h-[420px] w-full min-w-0 max-w-6xl resize flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">{t("viewImport.previewTitle")}</div>
                <div className="mt-0.5 text-xs text-slate-500">
                  {t("settings.email.previewDescription", { count: importPreview.items.length })}
                </div>
              </div>
              <button className="h-8 w-8 rounded-md border border-slate-300 text-slate-500 hover:bg-white" onClick={() => importComplete ? confirmImportComplete() : setImportPreview(null)}>×</button>
            </div>

            <div className="min-h-0 flex-1">
              <AdvancedDataTable
                storageKey="mmh_settings_email_statement_import_preview_table_v2"
                columns={importPreviewColumns}
                rows={importPreview.items}
                rowKey={(row) => row.key}
                emptyText={t("settings.email.noFilteredRows")}
                minTableWidth={1120}
                selectable
                selectedKeys={importPreview.selectedKeys}
                onSelectionChange={(keys) => {
                  const readyKeys = new Set(importPreview.items.filter((row) => row.ready).map((row) => row.key));
                  const selectedKeys = new Set(Array.from(keys).filter((key) => readyKeys.has(key)));
                  setImportPreview({
                    ...importPreview,
                    selectedKeys,
                    selectAll: importPreview.items.length > 0 && importPreview.items.filter((row) => row.ready).every((row) => selectedKeys.has(row.key)),
                  });
                }}
                batchActionSlot={(
                  <BatchReplacePopoverButton
                    fields={previewReplaceFields}
                    targetCount={importPreview.selectedKeys.size}
                    targetLabel={t("stockPanel.selected")}
                    panelAlign="left"
                    disabledTitle={t("stockPanel.error.selectRowsFirst")}
                    buttonTitle={t("statementImportPreview.batchEditSelected", { count: importPreview.selectedKeys.size })}
                    messageClassName="sr-only"
                    onApply={applyPreviewReplace}
                  />
                )}
                toolbarTitle={t("viewImport.previewTitle")}
                toolbarRightContent={(
                  <div className="flex items-center gap-3 text-xs text-slate-500">
                    {importPreviewStatementInfoTexts.length > 0 && (
                      <span>
                        {t("statementImportPreview.statementInfo", { texts: importPreviewStatementInfoTexts.join(" / ") })}
                      </span>
                    )}
                    {importPreview.statementAccountId && (
                      <span>
                        {t("settings.email.accountInfo", { account: previewAccountDisplayLabelById(importPreview.statementAccountId) ?? t("settings.email.matchedAccount") })}
                      </span>
                    )}
                    <span>{t("settings.email.totalItems", { count: importPreview.items.length })}</span>
                    <span>{t("statementImportPreview.willImport", { count: importPreview.selectedKeys.size })}</span>
                  </div>
                )}
                rowClassName={(row) => importPreview.selectedKeys.has(row.key) ? "bg-blue-50/40" : row.ready ? "bg-white" : "bg-amber-50/40"}
                fillHeight
                compactRows
                showFilters={false}
                sortable={false}
                showColumnVisibilityButton={false}
                resetDisplayStateOnMount
              />
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-4 py-3">
              <div className="text-xs text-slate-500">
                {importComplete ? (
                  importCompleteLockedBills.length > 0 ? (
                    <span className="space-y-1">
                      <span className="block">{t("settings.email.importDoneConfirm")}</span>
                      <span className="block">
                        {t("settings.email.locked")}{importCompleteLockedBills.map((item) => {
                          const accountText = previewAccountDisplayLabelById(item.accountId) ?? t("settings.email.billAccount");
                          const amountText = formatMoneyAmount(item.amount);
                          const periodText = item.periodStart || item.periodEnd ? t("settings.email.periodRange", { start: item.periodStart || "?", end: item.periodEnd || "?" }) : "";
                          const dueText = item.dueDate ? t("settings.email.dueDate", { date: item.dueDate }) : "";
                          return [item.statementMonth || t("settings.email.unknownMonth"), accountText, amountText, periodText, dueText].filter(Boolean).join(" · ");
                        }).join("；")}
                      </span>
                    </span>
                  ) : t("settings.email.importDoneConfirm")
                ) : t("statementImportPreview.willImport", { count: importPreview.selectedKeys.size })}
              </div>
              <div className="flex items-center justify-end">
                {importComplete ? (
                  <button className="h-9 px-4 rounded-md bg-green-600 text-white text-sm hover:bg-green-700" onClick={confirmImportComplete}>
                    {importComplete.accountId ? t("settings.email.confirmOpenAccount") : t("settings.email.confirmBackHome")}
                  </button>
                ) : (
                  <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed" onClick={() => void importItems()} disabled={importing || importPreview.selectedKeys.size === 0 || importPreview.items.some((row) => importPreview.selectedKeys.has(row.key) && !row.ready)}>
                    {importing ? t("settings.email.importing") : t("creditBill.confirmImport", { count: importPreview.selectedKeys.size })}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {accountDraft && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 px-4 py-6">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">{t("settings.email.createAccountFromBill")}</div>
                <div className="mt-1 text-xs text-slate-500">{t("settings.email.createAccountFromBillDesc")}</div>
              </div>
              <button className="h-8 w-8 rounded-md border border-slate-300 text-slate-500 hover:bg-slate-50" onClick={() => setAccountDraft(null)}>×</button>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <label className="text-xs text-slate-500">
                {t("entityForm.accountNameLabel")}
                <input className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none" value={accountDraft.name} onChange={(e) => setAccountDraft((current) => current ? { ...current, name: e.target.value } : current)} />
              </label>
              <label className="text-xs text-slate-500">
                {t("entityForm.accountTypeLabel")}
                <select className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={accountDraft.kind} onChange={(e) => setAccountDraft((current) => current ? { ...current, kind: e.target.value as AccountCreateDraft["kind"] } : current)}>
                  <option value="bank_credit">{t("account.kind.bank_credit")}</option>
                  <option value="bank_debit">{t("account.kind.bank_savings")}</option>
                  <option value="ewallet">{t("account.kind.ewallet")}</option>
                  <option value="cash">{t("account.kind.cash")}</option>
                  <option value="other">{t("account.kind.other")}</option>
                </select>
              </label>
              <label className="text-xs text-slate-500">
                {t("settings.accounts.institution")}
                <select
                  className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none"
                  value={accountDraft.institutionId}
                  onChange={(e) => {
                    const institution = bookInstitutions.find((item) => item.id === e.target.value);
                    setAccountDraft((current) => current ? { ...current, institutionId: e.target.value, institutionName: institution?.name ?? current.institutionName } : current);
                  }}
                >
                  <option value="">{t("settings.email.newOrNoInstitution")}</option>
                  {bookInstitutions.map((institution) => (
                    <option key={institution.id} value={institution.id}>{institution.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-500">
                {t("settings.email.newInstitutionName")}
                <input className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none" value={accountDraft.institutionName} onChange={(e) => setAccountDraft((current) => current ? { ...current, institutionName: e.target.value, institutionId: "" } : current)} placeholder={t("settings.email.institutionNamePlaceholder")} />
              </label>
              <label className="text-xs text-slate-500">
                {t("settings.accounts.owner")}
                <select className="mt-1 h-9 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={accountDraft.userId} onChange={(e) => setAccountDraft((current) => current ? { ...current, userId: e.target.value } : current)}>
                  <option value="">{accountDraft.ownerName ? t("settings.email.detectedOwner", { name: accountDraft.ownerName }) : t("regularInvest.notSpecified")}</option>
                  {bookUsers.map((user) => (
                    <option key={user.id} value={user.id}>{user.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-500">
                {t("settings.email.lastFour")}
                <input className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none" value={accountDraft.numberMasked} onChange={(e) => setAccountDraft((current) => current ? { ...current, numberMasked: e.target.value } : current)} placeholder={t("settings.email.lastFourPlaceholder")} />
              </label>
              {accountDraft.kind === "bank_credit" && (
                <>
                  <label className="text-xs text-slate-500">
                    {t("settings.email.creditLimit")}
                    <input className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none" value={accountDraft.creditLimit} onChange={(e) => setAccountDraft((current) => current ? { ...current, creditLimit: e.target.value } : current)} />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-xs text-slate-500">
                      {t("settings.accounts.billingDayLabel")}
                      <input className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none" value={accountDraft.billingDay} onChange={(e) => setAccountDraft((current) => current ? { ...current, billingDay: e.target.value } : current)} />
                    </label>
                    <label className="text-xs text-slate-500">
                      {t("settings.accounts.repaymentDayLabel")}
                      <input className="mt-1 h-9 w-full rounded-md border border-slate-200 px-3 text-sm outline-none" value={accountDraft.repaymentDay} onChange={(e) => setAccountDraft((current) => current ? { ...current, repaymentDay: e.target.value } : current)} />
                    </label>
                  </div>
                </>
              )}
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button className="h-9 px-4 rounded-md border border-slate-300 text-sm hover:bg-slate-50" onClick={() => setAccountDraft(null)}>{t("common.cancel")}</button>
              <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={createAccountFromDraft} disabled={savingAccountDraft || !accountDraft.name.trim()}>
                {savingAccountDraft ? t("settings.email.creating") : t("settings.email.createAndUse")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAccountModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 px-4 py-6">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-xl border border-slate-200 bg-white p-4 shadow-xl">
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-slate-800">{editingId ? t("settings.email.editAccountTitle") : t("settings.email.addAccountTitle")}</div>
                <div className="mt-1 text-xs text-slate-500">{t("settings.email.testFirstHint")}</div>
              </div>
              <button className="h-8 w-8 rounded-md border border-slate-300 text-slate-500 hover:bg-slate-50" onClick={closeAccountModal}>×</button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <select className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={providerKey} onChange={(e) => applyProviderPreset(e.target.value)}>
                <option value="">{t("settings.email.selectTemplate")}</option>
                {EMAIL_PROVIDER_PRESETS(t).map((preset) => (
                  <option key={preset.key} value={preset.key}>{preset.label}</option>
                ))}
              </select>
              <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("settings.email.labelPlaceholder")} />
              <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={username} onChange={(e) => { setUsername(e.target.value); if (!smtpFrom.trim()) setSmtpFrom(e.target.value); }} placeholder={t("settings.email.usernamePlaceholder")} autoComplete="username" />
              <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder={t("settings.email.imapHostPlaceholder")} />
              <div className="flex gap-2">
                <input className="h-9 w-24 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={imapPort} onChange={(e) => setImapPort(e.target.value)} placeholder={t("settings.fundApi.port")} />
                <label className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 flex items-center gap-2">
                  <input type="checkbox" checked={imapSecure} onChange={(e) => setImapSecure(e.target.checked)} />TLS
                </label>
              </div>
              <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={editingId ? t("settings.email.passwordPlaceholderEdit") : t("settings.email.passwordPlaceholder")} type="password" autoComplete="new-password" />
              <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={mailbox} onChange={(e) => setMailbox(e.target.value)} placeholder={t("settings.email.mailboxPlaceholder")} />
            </div>

            <div className="mt-3 pt-3 border-t border-slate-100">
              <div className="text-xs font-medium text-slate-500 mb-2">{t("settings.email.smtpSection")}</div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder={t("settings.email.smtpHostPlaceholder")} />
                <input className="h-9 w-24 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={smtpPort} onChange={(e) => { setSmtpPort(e.target.value); setSmtpSecure(e.target.value === "465"); }} placeholder={t("settings.fundApi.port")} />
                <input className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none" value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} placeholder={t("settings.email.smtpFromPlaceholder")} />
              </div>
              <div className="mt-2 text-xs text-slate-500">
                {t("settings.email.smtpHint")}
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button className="h-9 px-4 rounded-md border border-slate-300 text-sm hover:bg-slate-50" onClick={closeAccountModal}>{t("common.cancel")}</button>
              <button className="h-9 px-4 rounded-md border border-slate-300 text-sm hover:bg-slate-50 disabled:opacity-50" onClick={testConnection} disabled={testing}>{testing ? t("settings.email.testing") : t("settings.email.testConnection")}</button>
              <button className="h-9 px-4 rounded-md bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-50" onClick={saveAccount} disabled={saving}>{saving ? t("settings.email.saving") : editingId ? t("settings.email.saveChanges") : t("common.save")}</button>
            </div>
            {testResult && <div className="mt-2 text-xs text-emerald-700">{testResult}</div>}
            {!accountTested && <div className="mt-2 text-xs text-slate-500">{t("settings.email.recommendTestFirst")}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
