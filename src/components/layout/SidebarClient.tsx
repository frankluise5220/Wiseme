"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useEffect, useMemo, useRef, useCallback, startTransition } from "react";
import {
  LayoutDashboard,
  Users,
  CalendarClock,
  ChevronDown,
  Repeat,
  EyeOff,
  Landmark,
  Home,
  BarChart3,
  CreditCard,
  Compass,
  Shield,
  PanelLeftClose,
  PanelLeftOpen,
  UserRound,
  Table2,
  LogOut,
  MessageSquare,
} from "lucide-react";
import { MmhLogo } from "@/components/MmhLogo";
import { LedgerSwitcher } from "../LedgerSwitcher";
import { NewLedgerSetupCheck } from "../NewLedgerSetupCheck";
import { DailyTaskCheck } from "../DailyTaskCheck";
import { LanguageSwitcher } from "../LanguageSwitcher";
import { formatCurrencyMoney, isDisplayZeroMoney, roundDisplayNumber } from "@/lib/format";
import { resolveAccountCurrencyDisplayValue } from "@/lib/account-currency-display";
import { buildAccountDisplayOption, SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE } from "@/lib/account-display";
import { FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";
import { fetchInternalAccountBalances } from "@/lib/client/account-balances-fetch";
import {
  APP_PREFS_EVENT,
  getAppPreferences,
  getSidebarCollapsedPreference,
  getSidebarGroupPreference,
  getSidebarHideZeroPreference,
  getSidebarOwnerFilterPreference,
  getSidebarShowFixedAssetsPreference,
  setSidebarCollapsedPreference,
  setSidebarGroupPreference,
  setSidebarHideZeroPreference,
  setSidebarOwnerFilterPreference,
} from "@/lib/client/appPreferences";
import { useI18n } from "@/lib/i18n";
import { recordRecentAccount, sortByAccountUsage, useAccountUsage } from "@/lib/client/recentAccounts";
import { UndoLastOperationButton } from "@/components/UndoLastOperationButton";
import { getInvestmentAccountView, resolveLoanType } from "@/lib/account-kind-utils";
import { FIXED_ASSET_TYPES } from "@/lib/fixed-asset";
import { LOAN_TYPES, type LoanTypeValue } from "@/lib/loan-type";
import { dispatchFirstUseGuideOpen } from "@/lib/client/onboardingGuide";

type AccountItem = {
  id?: string | null;
  name: string;
  label: string;
  shortLabel?: string;
  hoverTitle?: string;
  balance: number;
  convertedBalance?: number | null;
  currency?: string | null;
  baseCurrency?: string | null;
  fxRateMissing?: boolean;
  kind: string;
  groupName?: string;
  institution?: string;
  institutionId?: string | null;
  institutionType?: string | null;
  counterpartyId?: string | null;
  isConsumerLoan?: boolean;
  loanType?: string | null;
  investProductType?: string;
  fixedAssetType?: string | null;
  children?: AccountItem[];
};

type SidebarSubgroup = {
  key: string;
  label: string;
  accounts: AccountItem[];
  total: number;
  href?: string;
};

type SidebarSection = {
  kind: string;
  label: string;
  accounts: AccountItem[];
  total: number;
  subgroups: SidebarSubgroup[];
};

function normalizeSidebarItemKind(item: Pick<AccountItem, "kind" | "investProductType">) {
  if (item.kind === "investment" && item.investProductType === "deposit") return "deposit";
  if (item.kind === "investment" && item.investProductType === "money") return "investment_money";
  if (item.kind === "investment" && item.investProductType === "wealth") return "investment_wealth";
  if (item.kind === "investment" && item.investProductType === "stock") return "investment_stock";
  if (item.kind === "investment" && item.investProductType === "property") return "investment_property";
  if (item.kind === "investment" && item.investProductType === "fund") return "investment_fund";
  return item.kind;
}

function normalizeSidebarAccountItem(item: AccountItem): AccountItem {
  return {
    ...item,
    kind: normalizeSidebarItemKind(item),
  };
}

const ASSET_KINDS = ["cash", "bank_debit", "ewallet", "deposit"];
const CREDIT_KINDS = ["bank_credit"];
const INVEST_KINDS = ["investment", "investment_fund", "investment_money", "investment_wealth", "investment_stock"];
const FIXED_ASSET_SUMMARY_KIND = "fixed_asset_summary";
const FIXED_ASSET_SUMMARY_ID = "__fixed_assets__";
const FIXED_ASSET_SECTION = "fixed_assets";
const LOAN_SECTION = "loans";
const LIABILITY_SECTION = "liabilities";
const FIXED_ASSET_KINDS = [FIXED_ASSET_SUMMARY_KIND];
const INSURANCE_KINDS = ["insurance"];
const LOAN_KINDS = ["loan"];
const LIABILITY_KINDS = ["loan_summary"];
const ASSET_SUBGROUPS: Array<{ key: string; label: string; kinds: string[] }> = [
  { key: "cash_like", label: "现金", kinds: ["cash"] },
  { key: "bank_debit_like", label: "借记卡", kinds: ["bank_debit"] },
  { key: "ewallet_like", label: "电子钱包", kinds: ["ewallet"] },
  { key: "deposit_like", label: "存款", kinds: ["deposit"] },
];
const SECTION_ICON: Record<string, React.ElementType> = {
  资产: Landmark,
  信用卡: CreditCard,
  投资: BarChart3,
  [FIXED_ASSET_SECTION]: Home,
  保险: Shield,
  [LOAN_SECTION]: Landmark,
  [LIABILITY_SECTION]: Users,
};
const KIND_SORT_ORDER = new Map<string, number>([
  ["cash", 10],
  ["bank_debit", 20],
  ["ewallet", 30],
  ["deposit", 40],
  ["investment", 50],
  ["investment_money", 51],
  ["investment_fund", 52],
  ["investment_wealth", 53],
  ["investment_stock", 54],
  ["investment_property", 55],
  [FIXED_ASSET_SUMMARY_KIND, 56],
  ["insurance", 55],
  ["bank_credit", 60],
  ["loan_summary", 70],
  ["settlement", 71],
  ["loan", 71],
  ["other", 99],
]);
const SIDEBAR_USAGE_SORT_MIN_GROUP_SIZE = 10;

function isSidebarSettlementLoan(item: AccountItem) {
  return item.kind === "settlement" || (item.kind === "loan" && !!item.counterpartyId);
}

function isSidebarLoanItem(item: AccountItem) {
  return item.kind === "loan" && !isSidebarSettlementLoan(item);
}

function loanSubgroupKey(loanType: LoanTypeValue) {
  return `debt_loan_${loanType}`;
}

function loanTypeForSidebarItem(item: AccountItem): LoanTypeValue {
  return resolveLoanType(item) ?? "home";
}

function isLoanTypeSidebarItem(type: LoanTypeValue) {
  return (item: AccountItem) => isSidebarLoanItem(item) && loanTypeForSidebarItem(item) === type;
}

function isOwnerScopedSidebarItem(item: AccountItem) {
  return item.kind !== "loan" && item.kind !== "loan_summary" && item.kind !== FIXED_ASSET_SUMMARY_KIND && item.kind !== "investment_property" && !isSidebarSettlementLoan(item);
}

function fixedAssetTypeLabel(type: string, t: (key: string, params?: Record<string, string | number>) => string) {
  const key = `fixedAsset.type.${type}`;
  const label = t(key);
  return label && label !== key ? label : t("txForm.fixedAssetToggle");
}

function normalizeSidebarItems(items: AccountItem[], t: (key: string, params?: Record<string, string | number>) => string) {
  const normalizedItems = items.map(normalizeSidebarAccountItem);
  const propertyItems = normalizedItems.filter((item) => item.kind === "investment_property");
  // 按账户的 fixedAssetType 分组，每个类别生成一个小类节点，下面挂对应账户。
  const fixedAssetGroups: AccountItem[] = propertyItems.length > 0
    ? FIXED_ASSET_TYPES.map((type) => {
        const children = propertyItems.filter((item) => (item.fixedAssetType ?? "property") === type);
        if (children.length === 0) return null;
        const label = fixedAssetTypeLabel(type, t);
        const baseCurrency = children.find((item) => item.baseCurrency)?.baseCurrency ?? children[0]?.currency ?? null;
        const convertedValues = children.map((item) => item.convertedBalance).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
        const convertedBalance = convertedValues.length === children.length
          ? convertedValues.reduce((sum, value) => sum + value, 0)
          : null;
        return {
          id: `${FIXED_ASSET_SUMMARY_ID}:${type}`,
          name: label,
          label,
          shortLabel: label,
          hoverTitle: label,
          balance: convertedBalance ?? children.reduce((sum, item) => sum + item.balance, 0),
          convertedBalance,
          currency: convertedBalance == null ? children[0]?.currency ?? baseCurrency : baseCurrency,
          baseCurrency,
          fxRateMissing: convertedBalance == null && children.some((item) => item.fxRateMissing),
          kind: FIXED_ASSET_SUMMARY_KIND,
          groupName: undefined,
          institution: label,
          children,
        } as AccountItem;
      }).filter((item): item is AccountItem => item !== null)
    : [];
  const normalized = fixedAssetGroups.length > 0
    ? [...normalizedItems.filter((item) => item.kind !== "investment_property"), ...fixedAssetGroups]
    : normalizedItems;
  const settlementChildren = normalized.filter(isSidebarSettlementLoan);
  if (settlementChildren.length === 0) return normalized;
  const normalizedWithoutSettlementChildren = normalized.filter((item) => !isSidebarSettlementLoan(item));
  const convertedValues = settlementChildren
    .map((item) => item.convertedBalance)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const allConverted = convertedValues.length === settlementChildren.length;
  const convertedBalance = allConverted ? convertedValues.reduce((sum, value) => sum + value, 0) : null;
  const baseCurrency = settlementChildren.find((item) => item.baseCurrency)?.baseCurrency ?? settlementChildren[0]?.currency ?? null;
  const settlementSummary: AccountItem = {
    id: "__settlement_summary__",
    name: t("sidebar.section.liabilities"),
    label: t("sidebar.section.liabilities"),
    shortLabel: t("sidebar.section.liabilities"),
    hoverTitle: t("sidebar.debt.counterpartySummary"),
    balance: convertedBalance ?? settlementChildren.reduce((sum, item) => sum + item.balance, 0),
    convertedBalance,
    currency: convertedBalance == null ? settlementChildren[0]?.currency ?? baseCurrency : baseCurrency,
    baseCurrency,
    fxRateMissing: convertedBalance == null && settlementChildren.some((item) => item.fxRateMissing),
    kind: "loan_summary",
    groupName: undefined,
    institution: t("sidebar.debt.counterpartySummary"),
    children: settlementChildren,
  };
  return [...normalizedWithoutSettlementChildren, settlementSummary];
}

function getSidebarItemSignature(item: AccountItem): string {
  const childSignature = item.children?.map(getSidebarItemSignature).join("\u0002") ?? "";
  return [
    item.id ?? "",
    item.name,
    item.label,
    item.shortLabel ?? "",
    item.hoverTitle ?? "",
    item.balance,
    item.convertedBalance ?? "",
    item.currency ?? "",
    item.baseCurrency ?? "",
    item.fxRateMissing ? "1" : "0",
    item.kind,
    item.groupName ?? "",
    item.institution ?? "",
    item.institutionId ?? "",
    item.institutionType ?? "",
    item.counterpartyId ?? "",
    item.isConsumerLoan ? "1" : "0",
    item.loanType ?? "",
    item.investProductType ?? "",
    item.fixedAssetType ?? "",
    childSignature,
  ].join("\u0001");
}

function toSidebarAccountItem(a: any, t: (key: string, params?: Record<string, string | number>) => string, creditCardSidebarLabelTemplate = SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE): AccountItem {
  const convertedBalance = a.convertedBalance == null ? null : Number(a.convertedBalance);
  const display = buildAccountDisplayOption({
    id: a.id,
    name: a.name,
    kind: a.kind,
    numberMasked: a.numberMasked,
    groupId: a.groupId ?? "",
    investProductType: a.investProductType ?? null,
    Institution: a.Institution ?? null,
    AccountGroup: a.AccountGroup ?? null,
  }, creditCardSidebarLabelTemplate);
  return {
    id: a.id,
    name: a.name,
    label: display.label,
    shortLabel: display.selectorCoreLabel,
    hoverTitle: display.hoverTitle,
    balance: Number(a.balance ?? 0),
    convertedBalance: convertedBalance != null && Number.isFinite(convertedBalance) ? convertedBalance : null,
    currency: a.currency ?? null,
    baseCurrency: a.baseCurrency ?? null,
    fxRateMissing: !!a.fxRateMissing,
    kind: a.kind,
    groupName: a.AccountGroup?.name?.trim() || display.groupName || t("batchImport.ownerUnset"),
    institution: a.Institution?.name?.trim() || display.institutionName || undefined,
    institutionId: a.institutionId ?? null,
    institutionType: a.Institution?.type ?? a.institutionType ?? null,
    counterpartyId: a.counterpartyId ?? null,
    isConsumerLoan: a.isConsumerLoan === true,
    loanType: a.loanType ?? null,
    investProductType: a.investProductType || undefined,
    fixedAssetType: a.fixedAssetType ?? null,
  };
}

export function SidebarClient({
  items: initialItems,
  household,
  isRedUp,
  user,
  initialPreferences,
}: {
  items: AccountItem[];
  household: { id: string; name: string; baseCurrency?: string | null } | null;
  isRedUp: boolean;
  user: { id: string; name: string; role: string } | null;
  initialPreferences?: {
    sidebarOwnerFilter: string;
    sidebarHideZero: boolean;
    sidebarHideInitialData: boolean;
    sidebarShowFixedAssets: boolean;
    sidebarCollapsed: boolean;
    sidebarGroupBy: "kind" | "institution";
  };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const currentAppUrl = useMemo(() => {
    const query = searchParams.toString();
    return query ? `${pathname}?${query}` : pathname;
  }, [pathname, searchParams]);
  const selectedAccountId = (searchParams.get("accountId") ?? "").trim();
  const selectedAccount = (searchParams.get("account") ?? "").trim();
  const selectedView = (searchParams.get("view") ?? "").trim();
  const selectedFixedAssetType = (searchParams.get("fixedAssetType") ?? "").trim();
  const selectedDebtLoanTypeRaw = (searchParams.get("debtLoanType") ?? "").trim();
  const selectedDebtLoanType = LOAN_TYPES.includes(selectedDebtLoanTypeRaw as LoanTypeValue)
    ? selectedDebtLoanTypeRaw as LoanTypeValue
    : null;
  const isRootInvestmentView =
    pathname === "/" &&
    (selectedView === "investfund" ||
      selectedView === "investmoney" ||
      selectedView === "investwealth" ||
      selectedView === "investstock" ||
      selectedView === "investproperty" ||
      selectedView === "regularinvest");

  const [selectedOwnerFilter, setSelectedOwnerFilter] = useState(() => initialPreferences?.sidebarOwnerFilter ?? getSidebarOwnerFilterPreference());
  const [hideZero, setHideZero] = useState(() => initialPreferences?.sidebarHideZero ?? getSidebarHideZeroPreference());
  const [showFixedAssets, setShowFixedAssets] = useState(() => initialPreferences?.sidebarShowFixedAssets ?? getSidebarShowFixedAssetsPreference());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => initialPreferences?.sidebarCollapsed ?? getSidebarCollapsedPreference());
  const [sidebarGroupBy, setSidebarGroupBy] = useState<"kind" | "institution">(() => initialPreferences?.sidebarGroupBy ?? getSidebarGroupPreference());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [collapsedAssetSubgroupKeys, setCollapsedAssetSubgroupKeys] = useState<Set<string>>(new Set());
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [pendingSettings, setPendingSettings] = useState(false);
  const [hideFirstUseGuide, setHideFirstUseGuide] = useState(() => initialPreferences?.sidebarHideInitialData ?? getAppPreferences().sidebarHideInitialData);
  const [items, setItems] = useState(() => normalizeSidebarItems(initialItems, t));
  const accountUsage = useAccountUsage();
  const ledgerSwitcherAnchorRef = useRef<HTMLButtonElement>(null);
  const userMenuAnchorRef = useRef<HTMLButtonElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const initializedSectionsRef = useRef(false);
  const initializedAssetSubgroupsRef = useRef(false);
  const prefetchedHrefRef = useRef<Set<string>>(new Set());
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [userMenuPosition, setUserMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const householdId = household?.id ?? "";
  const ownerOptions = useMemo(
    () => Array.from(new Set(items.flatMap((item) => (item.children?.length ? item.children : [item])
      .filter(isOwnerScopedSidebarItem)
      .map((child) => child.groupName || t("batchImport.ownerUnset")))))
      .filter((name) => name !== "未指定")
      .sort((a, b) => a.localeCompare(b, "zh-Hans-CN")),
    [items, t],
  );

  const updateUserMenuPosition = useCallback(() => {
    const anchor = userMenuAnchorRef.current;
    if (!anchor || typeof window === "undefined") return;
    const rect = anchor.getBoundingClientRect();
    const menuWidth = 160;
    const rawLeft = sidebarCollapsed ? rect.right + 8 : rect.left;
    const rawTop = sidebarCollapsed ? rect.top : rect.bottom + 6;
    const left = Math.min(Math.max(rawLeft, 8), Math.max(8, window.innerWidth - menuWidth - 8));
    const top = Math.min(Math.max(rawTop, 8), Math.max(8, window.innerHeight - 112));
    setUserMenuPosition({ top, left });
  }, [sidebarCollapsed]);

  function toggleUserMenu() {
    if (userMenuOpen) {
      setUserMenuOpen(false);
      return;
    }
    setSwitcherOpen(false);
    updateUserMenuPosition();
    setUserMenuOpen(true);
  }

  async function handleLogout() {
    setSwitcherOpen(false);
    setUserMenuOpen(false);
    setLoggingOut(true);
    try {
      const res = await fetch("/api/v1/auth/logout", {
        method: "POST",
        cache: "no-store",
      });
      const data = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!res.ok || data?.ok !== true) {
        throw new Error(data?.error || `Logout API returned ${res.status}`);
      }
      window.location.assign("/login");
    } catch (error) {
      window.alert(error instanceof Error ? `${t("sidebarClient.logoutFailed")}: ${error.message}` : t("sidebarClient.logoutFailed"));
      setLoggingOut(false);
    }
  }

  useEffect(() => {
    if (!userMenuOpen) return;
    updateUserMenuPosition();
    function handlePointerDown(event: MouseEvent | PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (userMenuAnchorRef.current?.contains(target)) return;
      if (userMenuRef.current?.contains(target)) return;
      setUserMenuOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setUserMenuOpen(false);
    }
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updateUserMenuPosition);
    window.addEventListener("scroll", updateUserMenuPosition, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updateUserMenuPosition);
      window.removeEventListener("scroll", updateUserMenuPosition, true);
    };
  }, [updateUserMenuPosition, userMenuOpen]);

  // Refresh items when fund data changes (debounced)
  // Only updates items whose data actually changed to minimize React re-renders
  const sidebarRefreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const sidebarRefreshBusy = useRef(false);
  const sidebarRefreshPending = useRef(false);

  useEffect(() => {
    startTransition(() => {
      setItems(normalizeSidebarItems(initialItems, t));
    });
  }, [initialItems, t]);

  useEffect(() => {
    setCollapsedSections(new Set());
    setCollapsedAssetSubgroupKeys(new Set());
    initializedSectionsRef.current = false;
    initializedAssetSubgroupsRef.current = false;
  }, [householdId]);

  useEffect(() => {
    const debouncedRefresh = () => {
      if (sidebarRefreshTimer.current) clearTimeout(sidebarRefreshTimer.current);
      sidebarRefreshTimer.current = setTimeout(async () => {
        if (sidebarRefreshBusy.current) {
          sidebarRefreshPending.current = true;
          return;
        }
        sidebarRefreshBusy.current = true;
        try {
          const data = await fetchInternalAccountBalances();
          const freshAccounts = data?.ok && Array.isArray(data.accounts) ? data.accounts : null;
          if (freshAccounts) {
            startTransition(() => {
              setItems(prev => {
                const fresh: AccountItem[] = normalizeSidebarItems(freshAccounts
                  .filter((a: any) => a.isActive !== false)
                  .map((a: any) => toSidebarAccountItem(a, t, getAppPreferences().creditCardSidebarLabelTemplate)), t);
                // Merge: only update items whose data actually changed
                // Unchanged items keep their object reference → React skips re-render
                let changed = false;
                const next = prev.map(p => {
                  const f = fresh.find(f => f.id === p.id);
                  if (f && getSidebarItemSignature(p) !== getSidebarItemSignature(f)) {
                    changed = true;
                    return f;
                  }
                  return p;
                });
                // Handle newly created accounts
                for (const f of fresh) {
                  if (!prev.some(p => p.id === f.id)) {
                    next.push(f);
                    changed = true;
                  }
                }
                if (next.length !== fresh.length) {
                  return fresh;
                }
                return changed ? next : prev;
              });
            });
          }
        } catch {
        } finally {
          sidebarRefreshBusy.current = false;
          if (sidebarRefreshPending.current) {
            sidebarRefreshPending.current = false;
            debouncedRefresh();
          }
        }
      }, 100);
    };
    const onFinanceChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ balanceChanged?: boolean }>).detail;
      // Remark-only edits do not change balances: skip the sidebar refresh.
      if (detail?.balanceChanged === false) return;
      debouncedRefresh();
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, onFinanceChanged);
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, onFinanceChanged);
      if (sidebarRefreshTimer.current) clearTimeout(sidebarRefreshTimer.current);
      sidebarRefreshPending.current = false;
    };
  }, [householdId, t]);

  useEffect(() => {
    const applyPrefs = () => {
      const prefs = getAppPreferences();
      setSelectedOwnerFilter(prefs.sidebarOwnerFilter);
      setHideZero(prefs.sidebarHideZero);
      setShowFixedAssets(prefs.sidebarShowFixedAssets);
      setHideFirstUseGuide(prefs.sidebarHideInitialData);
      setSidebarCollapsed(prefs.sidebarCollapsed);
      setSidebarGroupBy(getSidebarGroupPreference());
    };
    applyPrefs();
    window.addEventListener(APP_PREFS_EVENT, applyPrefs as EventListener);
    return () => window.removeEventListener(APP_PREFS_EVENT, applyPrefs as EventListener);
  }, []);

  useEffect(() => {
    if (pathname.startsWith("/settings")) setPendingSettings(false);
  }, [pathname]);

  useEffect(() => {
    if (pathname === "/" && selectedAccountId) recordRecentAccount(selectedAccountId);
  }, [pathname, selectedAccountId]);

  useEffect(() => {
    const clearPrefetchMarkers = () => {
      prefetchedHrefRef.current.clear();
    };
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, clearPrefetchMarkers);
    window.addEventListener(APP_PREFS_EVENT, clearPrefetchMarkers);
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, clearPrefetchMarkers);
      window.removeEventListener(APP_PREFS_EVENT, clearPrefetchMarkers);
    };
  }, []);

  const prefetchRoute = useCallback((href: string) => {
    if (!href || href === currentAppUrl) return;
    const prefetched = prefetchedHrefRef.current;
    if (prefetched.has(href)) return;
    if (prefetched.size > 80) prefetched.clear();
    prefetched.add(href);

    const run = () => {
      try {
        router.prefetch(href);
      } catch {
        prefetched.delete(href);
      }
    };
    if (typeof window !== "undefined" && window.requestIdleCallback) {
      window.requestIdleCallback(run, { timeout: 250 });
    } else if (typeof window !== "undefined") {
      window.setTimeout(run, 40);
    }
  }, [currentAppUrl, router]);

  function cycleOwnerFilter() {
    const cycle = ["", ...ownerOptions];
    const current = getSidebarOwnerFilterPreference();
    const currentIndex = cycle.indexOf(current);
    const next = cycle[(currentIndex + 1 + cycle.length) % cycle.length] ?? "";
    setSelectedOwnerFilter(next);
    setSidebarOwnerFilterPreference(next);
  }

  function toggleHideZero() {
    const next = !hideZero;
    setHideZero(next);
    setSidebarHideZeroPreference(next);
  }

  function toggleSidebarCollapsed() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    setSidebarCollapsedPreference(next);
    if (next) setSwitcherOpen(false);
  }

  function cycleSidebarGroupBy() {
    const next = sidebarGroupBy === "kind" ? "institution" : "kind";
    setSidebarGroupBy(next);
    setSidebarGroupPreference(next);
  }

  function toggleSection(key: string) {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function openOnlySection(key: string) {
    setCollapsedSections(prev => {
      if (!prev.has(key)) {
        const next = new Set(prev);
        next.add(key);
        return next;
      }
      return new Set(sections.map((section) => section.kind).filter((sectionKey) => sectionKey !== key));
    });
  }

  const navItemCls = (href: string, forceActive = false) =>
    `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all duration-200 ${
      forceActive || (href === "/" ? pathname === "/" : pathname.startsWith(href))
        ? "sidebar-item-active"
        : "text-slate-600 hover:bg-white hover:text-slate-900"
    }`;

  const accountLinkCls = (active: boolean) =>
    `flex items-center justify-between rounded-lg px-3 py-1.5 text-xs transition-all duration-200 ${
      active
        ? "border border-blue-100 bg-blue-50/80 text-slate-900 shadow-sm"
        : "border border-transparent text-slate-600 hover:border-slate-100 hover:bg-white hover:text-slate-900"
    }`;

  const balCls = (n: number) => {
    const rounded = roundDisplayNumber(n);
    return rounded > 0 ? (isRedUp ? "text-red-700" : "text-emerald-800") : rounded < 0 ? (isRedUp ? "text-emerald-800" : "text-red-700") : "text-foreground/40";
  };
  const baseCurrency = household?.baseCurrency || "CNY";
  const resolveSidebarBalance = useCallback((item: AccountItem) => {
    const resolved = resolveAccountCurrencyDisplayValue(item, baseCurrency, "converted");
    return {
      ...resolved,
      value: resolved.value == null
        ? null
        : roundDisplayNumber(item.kind === "bank_credit" ? -resolved.value : resolved.value),
    };
  }, [baseCurrency]);
  const displayBalanceValue = useCallback((item: AccountItem) => resolveSidebarBalance(item).value, [resolveSidebarBalance]);
  const displayBalance = useCallback((item: AccountItem) => displayBalanceValue(item) ?? 0, [displayBalanceValue]);
  const formatSidebarBalance = useCallback((item: AccountItem) => {
    const resolved = resolveSidebarBalance(item);
    return resolved.value == null ? t("sidebar.balance.missingFxRate") : formatCurrencyMoney(resolved.value, resolved.currency);
  }, [resolveSidebarBalance, t]);
  const displaySectionTotal = (_kind: string, value: number) => roundDisplayNumber(value);
  const itemBalanceCls = (item: AccountItem) => {
    const value = displayBalanceValue(item);
    return value == null ? "text-amber-700" : balCls(value);
  };
  const sectionBalanceCls = (kind: string, value: number) => balCls(displaySectionTotal(kind, value));
  const sectionLabel = (label: string) => {
    if (label === "资产") return t("sidebar.section.fundingAccounts");
    if (label === "信用卡") return t("sidebar.section.creditCards");
    if (label === "投资") return t("sidebar.section.investments");
    if (label === FIXED_ASSET_SECTION) return t("sidebar.section.fixedAssets");
    if (label === "保险") return t("sidebar.section.insurance");
    if (label === LOAN_SECTION) return t("sidebar.section.loans");
    if (label === LIABILITY_SECTION) return t("sidebar.section.liabilities");
    return label;
  };
  const assetSubgroupLabel = (label: string) => {
    if (label === "现金") return t("sidebar.kind.cash");
    if (label === "借记卡") return t("sidebar.kind.bankDebit");
    if (label === "电子钱包") return t("sidebar.kind.ewallet");
    if (label === "定期") return t("sidebar.kind.deposit");
    if (label === "其他资产") return t("sidebar.kind.other");
    return label;
  };
  const inlineKindLabel = (kind: string) => {
    if (kind === "cash") return t("sidebar.kind.cash");
    if (kind === "bank_debit") return t("sidebar.kind.bankDebit");
    if (kind === "ewallet") return t("sidebar.kind.ewallet");
    if (kind === "deposit") return t("sidebar.kind.deposit");
    if (kind === "investment" || kind === "investment_fund") return t("sidebar.kind.investment");
    if (kind === "investment_money") return t("sidebar.kind.moneyFund");
    if (kind === "investment_wealth") return t("sidebar.kind.wealth");
    if (kind === "investment_stock") return t("investment.product.stock");
    if (kind === "investment_property") return t("investment.product.property");
    if (kind === FIXED_ASSET_SUMMARY_KIND) return t("sidebar.section.fixedAssets");
    if (kind === "insurance") return t("sidebar.kind.insurance");
    if (kind === "bank_credit") return t("sidebar.kind.creditCard");
    if (kind === "loan_summary") return t("sidebar.section.liabilities");
    if (kind === "settlement") return t("account.kind.settlement");
    if (kind === "loan") return t("account.kind.loan");
    return t("sidebar.kind.other");
  };
  const collapsedNavCls = (active: boolean) =>
    `flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200 ${
      active
        ? "bg-blue-50 text-blue-600 shadow-sm"
        : "text-slate-500 hover:bg-white hover:text-slate-900"
    }`;

  // Restore and Refine Grouping logic
  const visibleItems = useMemo(() => {
    const passesCommonVisibility = (item: AccountItem) => {
      const visibleBalance = displayBalanceValue(item);
      if (visibleBalance != null && item.kind === "loan" && item.institutionType === "bank" && isDisplayZeroMoney(visibleBalance)) return false;
      if (visibleBalance != null && hideZero && isDisplayZeroMoney(visibleBalance)) return false;
      if (selectedOwnerFilter && isOwnerScopedSidebarItem(item) && (item.groupName || t("batchImport.ownerUnset")) !== selectedOwnerFilter) return false;
      return true;
    };
    const isVisibleLeaf = (item: AccountItem) => {
      if (isSidebarSettlementLoan(item)) return false;
      return passesCommonVisibility(item);
    };
    return items.flatMap((item) => {
      if (item.kind === FIXED_ASSET_SUMMARY_KIND && item.children?.length) {
        if (!showFixedAssets) return [];
        const children = item.children.filter(passesCommonVisibility);
        if (children.length === 0) return [];
        const convertedValues = children
          .map(displayBalanceValue)
          .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
        const allConverted = convertedValues.length === children.length;
        const convertedTotal = convertedValues.reduce((sum, value) => sum + value, 0);
        return [{
          ...item,
          children,
          balance: allConverted
            ? convertedTotal
            : children.reduce((sum, child) => sum + child.balance, 0),
          convertedBalance: allConverted ? convertedTotal : null,
          currency: allConverted ? baseCurrency : children[0]?.currency ?? baseCurrency,
          baseCurrency,
          fxRateMissing: !allConverted,
        }];
      }
      if (item.kind !== "loan_summary" || !item.children?.length) {
        return isVisibleLeaf(item) ? [item] : [];
      }
      const children = item.children.filter(passesCommonVisibility);
      if (children.length === 0) return [];
      const childrenTotal = children.reduce((sum, child) => sum + displayBalance(child), 0);
      return [{
        ...item,
        children,
        balance: childrenTotal,
        convertedBalance: childrenTotal,
        currency: baseCurrency,
        baseCurrency,
      }];
    });
  }, [items, hideZero, selectedOwnerFilter, showFixedAssets, baseCurrency, displayBalance, displayBalanceValue, t]);

  const sections = useMemo(() => {
    const sortAccountsByUsage = (accounts: AccountItem[]) =>
      accounts.length >= SIDEBAR_USAGE_SORT_MIN_GROUP_SIZE
        ? sortByAccountUsage(accounts, accountUsage)
        : accounts;
    const compareAccountUsage = (a: AccountItem, b: AccountItem) => {
      const aStat = a.id ? accountUsage[a.id] : undefined;
      const bStat = b.id ? accountUsage[b.id] : undefined;
      const countDiff = (bStat?.count ?? 0) - (aStat?.count ?? 0);
      if (countDiff !== 0) return countDiff;
      const recencyDiff = (bStat?.lastUsedAt ?? 0) - (aStat?.lastUsedAt ?? 0);
      if (recencyDiff !== 0) return recencyDiff;
      return a.label.localeCompare(b.label, "zh-Hans-CN");
    };
    const buildLoanSubgroups = (loanItems: AccountItem[]): SidebarSubgroup[] => {
      return LOAN_TYPES.map((loanType) => {
        const accounts = sortAccountsByUsage(loanItems.filter(isLoanTypeSidebarItem(loanType)));
        return {
          key: loanSubgroupKey(loanType),
          label: t(`loan.type.${loanType}`),
          accounts,
          total: accounts.reduce((sum, account) => sum + displayBalance(account), 0),
          href: `/?view=debt&debtLoanType=${loanType}`,
        };
      }).filter((subgroup) => subgroup.accounts.length > 0);
    };
    const buildDebtSections = (): SidebarSection[] => {
      const loanItems = visibleItems.filter(isSidebarLoanItem);
      const liabilityItems = visibleItems.filter((item) => item.kind === "loan_summary");
      const debtSections: SidebarSection[] = [];
      if (liabilityItems.length > 0) {
        debtSections.push({
          kind: LIABILITY_SECTION,
          label: LIABILITY_SECTION,
          accounts: sortAccountsByUsage(liabilityItems),
          total: liabilityItems.reduce((sum, account) => sum + displayBalance(account), 0),
          subgroups: [],
        });
      }
      if (loanItems.length > 0) {
        debtSections.push({
          kind: LOAN_SECTION,
          label: LOAN_SECTION,
          accounts: sortAccountsByUsage(loanItems),
          total: loanItems.reduce((sum, account) => sum + displayBalance(account), 0),
          subgroups: buildLoanSubgroups(loanItems),
        });
      }
      return debtSections;
    };
    if (sidebarGroupBy === "institution") {
      const debtKinds = new Set(["loan", "loan_summary"]);
      const map = new Map<string, SidebarSection>();
      for (const item of visibleItems) {
        if (debtKinds.has(item.kind)) continue;
        const label = item.kind === FIXED_ASSET_SUMMARY_KIND
          ? FIXED_ASSET_SECTION
          : item.institution?.trim() || t("insurance.noInstitution");
        const key = `institution:${label}`;
        const existing = map.get(key);
        if (existing) {
          existing.accounts.push(item);
          existing.total += displayBalance(item);
        } else {
          map.set(key, {
            kind: key,
            label,
            accounts: [item],
            total: displayBalance(item),
            subgroups: [],
          });
        }
      }
      const institutionSections = Array.from(map.values())
        .map((section) => ({
          ...section,
          accounts: section.accounts.length >= SIDEBAR_USAGE_SORT_MIN_GROUP_SIZE
            ? [...section.accounts].sort((a, b) => {
                const kindDiff = (KIND_SORT_ORDER.get(a.kind) ?? 999) - (KIND_SORT_ORDER.get(b.kind) ?? 999);
                if (kindDiff !== 0) return kindDiff;
                return compareAccountUsage(a, b);
              })
            : section.accounts,
        }))
        .sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
      return [...institutionSections, ...buildDebtSections()];
    }

    const groups = [
      { label: "资产", kinds: ASSET_KINDS },
      { label: "信用卡", kinds: CREDIT_KINDS },
      { label: "投资", kinds: INVEST_KINDS },
      { label: FIXED_ASSET_SECTION, kinds: FIXED_ASSET_KINDS },
      { label: "保险", kinds: INSURANCE_KINDS },
      { label: LIABILITY_SECTION, kinds: LIABILITY_KINDS },
      { label: LOAN_SECTION, kinds: LOAN_KINDS },
    ];
    return groups.map(g => {
      const filtered = visibleItems.filter(it => g.kinds.includes(it.kind) || (g.label === "投资" && it.kind.startsWith("investment_") && it.kind !== "investment_property"));
      const subgroups =
        g.label === "资产"
          ? (() => {
              const subgroupItems = ASSET_SUBGROUPS.map((subgroup) => {
                const accounts = sortAccountsByUsage(filtered.filter((item) => subgroup.kinds.includes(item.kind)));
                return {
                  key: subgroup.key,
                  label: subgroup.label,
                  accounts,
                  total: accounts.reduce((sum, account) => sum + displayBalance(account), 0),
                };
              }).filter((subgroup) => subgroup.accounts.length > 0);
              const coveredKinds = new Set(ASSET_SUBGROUPS.flatMap((subgroup) => subgroup.kinds));
              const fallbackAccounts = sortAccountsByUsage(filtered.filter((item) => !coveredKinds.has(item.kind)));
              if (fallbackAccounts.length > 0) {
                subgroupItems.push({
                  key: "other_asset",
                  label: "其他资产",
                  accounts: fallbackAccounts,
                  total: fallbackAccounts.reduce((sum, account) => sum + displayBalance(account), 0),
                });
              }
              return subgroupItems;
            })()
          : g.label === LOAN_SECTION
            ? buildLoanSubgroups(filtered)
          : [];
      return {
        kind: g.label, label: g.label, accounts: sortAccountsByUsage(filtered),
        total: filtered.reduce((s, a) => s + displayBalance(a), 0),
        subgroups,
      };
    }).filter(s => s.accounts.length > 0);
  }, [visibleItems, sidebarGroupBy, accountUsage, displayBalance, t]);

  const selectedDebtPerson = (searchParams.get("debtPerson") ?? "").trim();
  const debtPersonKeyFor = (item: AccountItem) => item.id ? `account:${item.id}` : "";
  const isDebtAccountSelected = (item: AccountItem) =>
    pathname === "/" && selectedView === "debt" && debtPersonKeyFor(item) === selectedDebtPerson;

  function isAccountItemActive(item: AccountItem) {
    if (pathname !== "/") return false;
    if (item.kind === "loan_summary") {
      return selectedView === "debt" && (!selectedDebtPerson || (item.children?.some(isDebtAccountSelected) ?? false));
    }
    if (item.kind === "loan" || item.kind === "settlement") return isDebtAccountSelected(item) || (!!item.id && selectedAccountId === item.id && selectedView === "debt");
    if (item.kind === FIXED_ASSET_SUMMARY_KIND) {
      if (selectedFixedAssetType) {
        const itemType = item.id?.startsWith(`${FIXED_ASSET_SUMMARY_ID}:`)
          ? item.id.slice(FIXED_ASSET_SUMMARY_ID.length + 1)
          : "";
        return selectedView === "investproperty" && itemType === selectedFixedAssetType;
      }
      return selectedView === "investproperty" && !selectedAccountId && !selectedAccount;
    }
    return item.id ? selectedAccountId === item.id : !selectedAccountId && selectedAccount === item.name;
  }

  const activeSectionKind = sections.find((section) => {
    if (
      pathname === "/" &&
      selectedView === "debt" &&
      selectedDebtLoanType &&
      section.kind === LOAN_SECTION &&
      section.subgroups.some((subgroup) => subgroup.key === loanSubgroupKey(selectedDebtLoanType))
    ) {
      return true;
    }
    return section.accounts.some(isAccountItemActive);
  })?.kind ?? sections[0]?.kind ?? "";

  const activeSubgroupKey = (() => {
    if (sidebarGroupBy !== "kind") return "";
    if (pathname === "/" && selectedView === "debt" && selectedDebtLoanType) {
      const key = loanSubgroupKey(selectedDebtLoanType);
      const loanSection = sections.find((section) => section.kind === LOAN_SECTION);
      if (loanSection?.subgroups.some((subgroup) => subgroup.key === key)) return key;
    }
    const groupedSection = sections.find((section) => section.accounts.some(isAccountItemActive) && section.subgroups?.length);
    if (!groupedSection?.subgroups?.length) return "";
    return groupedSection.subgroups.find((subgroup) => subgroup.accounts.some(isAccountItemActive))?.key ?? groupedSection.subgroups[0]?.key ?? "";
  })();

  useEffect(() => {
    if (initializedSectionsRef.current || sections.length === 0) return;
    initializedSectionsRef.current = true;
    const openKey = activeSectionKind || sections[0]?.kind;
    if (!openKey) return;
    setCollapsedSections(new Set(sections.map((section) => section.kind).filter((key) => key !== openKey)));
  }, [sections, activeSectionKind]);

  useEffect(() => {
    if (sidebarGroupBy !== "kind") {
      if (collapsedAssetSubgroupKeys.size > 0) setCollapsedAssetSubgroupKeys(new Set());
      initializedAssetSubgroupsRef.current = false;
      return;
    }
    const groupedSections = sections.filter((section) => section.subgroups?.length);
    if (groupedSections.length === 0) {
      if (collapsedAssetSubgroupKeys.size > 0) setCollapsedAssetSubgroupKeys(new Set());
      initializedAssetSubgroupsRef.current = false;
      return;
    }
    if (!initializedAssetSubgroupsRef.current) {
      initializedAssetSubgroupsRef.current = true;
      const openKeys = new Set(
        groupedSections.flatMap((section) => {
          const openKey = section.kind === activeSectionKind
            ? activeSubgroupKey
            : section.subgroups?.[0]?.key ?? "";
          return openKey ? [openKey] : [];
        }),
      );
      setCollapsedAssetSubgroupKeys(new Set(groupedSections.flatMap((section) => section.subgroups?.map((subgroup) => subgroup.key) ?? []).filter((key) => !openKeys.has(key))));
      return;
    }
    const subgroupKeys = new Set(groupedSections.flatMap((section) => section.subgroups?.map((subgroup) => subgroup.key) ?? []));
    let changed = false;
    const nextCollapsed = new Set<string>();
    for (const key of collapsedAssetSubgroupKeys) {
      if (subgroupKeys.has(key)) nextCollapsed.add(key);
      else changed = true;
    }
    if (changed) setCollapsedAssetSubgroupKeys(nextCollapsed);
  }, [sections, activeSubgroupKey, activeSectionKind, collapsedAssetSubgroupKeys, sidebarGroupBy]);

  function toggleAssetSubgroup(key: string) {
    setCollapsedAssetSubgroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function focusAssetSubgroup(key: string, allKeys: string[]) {
    setCollapsedAssetSubgroupKeys((prev) => {
      if (!prev.has(key)) {
        const next = new Set(prev);
        next.add(key);
        return next;
      }
      return new Set(allKeys.filter((groupKey) => groupKey !== key));
    });
  }

  const userMenu = userMenuOpen && userMenuPosition ? (
    <div
      ref={userMenuRef}
      className="fixed z-[1200] w-40 overflow-hidden rounded-lg border border-slate-200 bg-white text-sm shadow-lg shadow-slate-900/12"
      style={{ top: userMenuPosition.top, left: userMenuPosition.left }}
      role="menu"
      aria-label={t("sidebarClient.userMenu")}
    >
      <div className="border-b border-slate-100 px-3 py-2">
        <div className="text-[10px] font-medium text-slate-400">{t("sidebarClient.currentUser")}</div>
        <div className="mt-0.5 truncate text-xs font-semibold text-slate-800" title={user?.name || t("sidebarClient.user")}>
          {user?.name || t("sidebarClient.user")}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void handleLogout()}
        disabled={loggingOut}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
        role="menuitem"
      >
        <LogOut size={14} />
        <span>{loggingOut ? t("sidebarClient.loggingOut") : t("sidebarClient.logout")}</span>
      </button>
    </div>
  ) : null;

  if (sidebarCollapsed) {
    return (
      <>
        <aside className="flex h-screen w-16 shrink-0 flex-col items-center overflow-hidden border-r border-slate-200/80 bg-white/84 px-2 py-3 backdrop-blur-xl transition-[width] duration-200">
          <div className="flex shrink-0 flex-col items-center gap-1">
            <button
              ref={ledgerSwitcherAnchorRef}
              type="button"
              onClick={() => setSwitcherOpen((open) => !open)}
              className="mb-1 flex h-12 w-12 items-center justify-center rounded-2xl transition-colors hover:bg-slate-100"
              title={t("ledgerSwitch.switchLedger")}
            >
              <MmhLogo size={32} />
            </button>
            <button
              ref={userMenuAnchorRef}
              type="button"
              onClick={toggleUserMenu}
              className={collapsedNavCls(userMenuOpen)}
              title={user?.name ? t("sidebarClient.userMenuWithName", { name: user.name }) : t("sidebarClient.userMenu")}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
            >
              <UserRound size={18} />
            </button>
            <LanguageSwitcher />
            <button
              onClick={toggleSidebarCollapsed}
              className="flex h-10 w-10 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-white hover:text-slate-900"
              title={t("common.expand")}
            >
              <PanelLeftOpen size={18} />
            </button>
            <LedgerSwitcher
              current={household}
              anchorRef={ledgerSwitcherAnchorRef}
              open={switcherOpen}
              onOpenChange={setSwitcherOpen}
            />
          </div>

          <nav className="mt-5 flex min-h-0 flex-1 flex-col items-center gap-1">
          <Link href="/overview" className={collapsedNavCls(pathname.startsWith("/overview"))} title={t("nav.overview")}>
            <LayoutDashboard size={18} />
          </Link>
          <Link href="/regular-invest" className={collapsedNavCls(pathname.startsWith("/regular-invest"))} title={t("nav.scheduledTasks")}>
            <CalendarClock size={18} />
          </Link>
          <Link href="/reports" className={collapsedNavCls(pathname.startsWith("/reports"))} title={t("nav.reports")}>
            <Table2 size={18} />
          </Link>
          {!hideFirstUseGuide ? (
            <button
              type="button"
              onClick={dispatchFirstUseGuideOpen}
              className={collapsedNavCls(false)}
              title={t("nav.firstUseGuide")}
            >
              <Compass size={18} />
            </button>
          ) : null}
          <Link href="/accounts" className={collapsedNavCls(pathname.startsWith("/accounts") || (pathname === "/" && !isRootInvestmentView))} title={t("nav.accounts")}>
            <Landmark size={18} />
          </Link>
          <Link
            href="/accounts?tab=credit"
            className={collapsedNavCls(pathname.startsWith("/accounts") && searchParams.get("tab") === "credit")}
            title={t("nav.creditCards")}
          >
            <CreditCard size={18} />
          </Link>
          <Link href="/investments" className={collapsedNavCls(isRootInvestmentView || pathname.startsWith("/investments") || pathname.startsWith("/invest") || pathname.startsWith("/funds"))} title={t("nav.investments")}>
            <BarChart3 size={18} />
          </Link>
          <Link href="/liabilities" className={collapsedNavCls(pathname.startsWith("/liabilities"))} title={t("nav.liabilities")}>
            <Landmark size={18} />
          </Link>
        </nav>

          <UndoLastOperationButton compact />

          <NewLedgerSetupCheck />
          <DailyTaskCheck />
        </aside>
        {userMenu}
      </>
    );
  }

  return (
    <>
    <aside className="flex h-screen w-72 shrink-0 flex-col overflow-hidden border-r border-slate-200/80 bg-white/84 backdrop-blur-xl transition-[width] duration-200">
      {/* Fixed Header */}
      <div className="shrink-0 px-4 pb-2 pt-4">
        <div className="flex items-center gap-1">
          <button
            ref={ledgerSwitcherAnchorRef}
            type="button"
            onClick={() => setSwitcherOpen((open) => !open)}
            className="flex h-9 w-9 items-center justify-center rounded-2xl transition-colors hover:bg-slate-100"
            title={t("ledgerSwitch.switchLedger")}
          >
            <MmhLogo size={26} />
          </button>
          <button
            ref={userMenuAnchorRef}
            type="button"
            onClick={toggleUserMenu}
            className={`flex h-7 min-w-0 max-w-[92px] items-center gap-1 rounded-md px-1.5 text-xs font-medium transition-colors ${userMenuOpen ? "bg-slate-100 text-slate-800" : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"}`}
            title={user?.name ? t("sidebarClient.userMenuWithName", { name: user.name }) : t("sidebarClient.userMenu")}
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
          >
            <UserRound size={15} className="shrink-0" />
            <span className="truncate">{user?.name || t("sidebarClient.user")}</span>
            <ChevronDown size={12} className={`shrink-0 transition-transform ${userMenuOpen ? "rotate-180" : ""}`} />
          </button>
          <div className="flex shrink-0 items-center gap-0.5">
            <UndoLastOperationButton
              compact
              iconSize={15}
              className="flex h-7 w-6 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:text-slate-300"
            />
            <Link
              href="/settings/feedback"
              className="flex h-7 w-6 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800"
              title={t("settings.feedback.buttonTitle")}
              aria-label={t("settings.feedback.buttonTitle")}
            >
              <MessageSquare size={15} />
            </Link>
          </div>
          <div className="ml-auto flex items-center justify-end gap-1">
            <LanguageSwitcher />
            <button
              onClick={toggleSidebarCollapsed}
              className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              title={t("common.collapse")}
            >
              <PanelLeftClose size={18} />
            </button>
          </div>
        </div>
        <LedgerSwitcher
          current={household}
          anchorRef={ledgerSwitcherAnchorRef}
          open={switcherOpen}
          onOpenChange={setSwitcherOpen}
        />
      </div>

      {/* Main Body (Accounts scroll, bottom nav pinned) */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4">
        <div className="shrink-0">
          <nav className="space-y-1">
            <Link href="/overview" className={navItemCls("/overview")}>
              <LayoutDashboard size={18} />
              <span className="font-medium">{t("nav.overview")}</span>
            </Link>
            <Link href="/regular-invest" className={navItemCls("/regular-invest")}>
              <CalendarClock size={18} />
              <span className="font-medium">{t("nav.scheduledTasks")}</span>
            </Link>
            <Link href="/reports" className={navItemCls("/reports")}>
              <Table2 size={18} />
              <span className="font-medium">{t("nav.reports")}</span>
            </Link>
            {!hideFirstUseGuide ? (
              <button
                type="button"
                onClick={dispatchFirstUseGuideOpen}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-slate-600 transition-all duration-200 hover:bg-white hover:text-slate-900"
              >
                <Compass size={18} />
                <span className="font-medium">{t("nav.firstUseGuide")}</span>
              </button>
            ) : null}
          </nav>
        </div>

        <div className="mt-5 mb-3 flex shrink-0 items-center justify-between px-2">
          <div className="min-w-0">
            <button
              type="button"
              onClick={cycleOwnerFilter}
              className="truncate text-[11px] font-medium tracking-[0.08em] text-slate-400 transition-colors hover:text-slate-600"
              title={`${t("sidebar.ownerFilterTitle")}：${selectedOwnerFilter || t("common.all")}`}
            >
              {`${t("common.account")}·${selectedOwnerFilter || t("common.all")}`}
            </button>
          </div>
          <div className="flex items-center gap-1">
            <button type="button"
              onClick={cycleSidebarGroupBy}
              className={`rounded-md p-1 transition-colors ${sidebarGroupBy === "institution" ? "bg-slate-100 text-slate-600" : "text-slate-300 hover:bg-slate-50 hover:text-slate-500"}`}
              title={`${t("sidebar.ownerFilterTitle")}：${sidebarGroupBy === "kind" ? t("sidebar.groupByKind") : t("sidebar.groupByInstitution")}`}
            >
              <Repeat size={14} />
            </button>
            <button onClick={toggleHideZero} className={`rounded-md p-1.5 text-xs transition-colors ${hideZero ? "bg-slate-100 text-slate-600" : "text-slate-300 hover:bg-slate-50 hover:text-slate-500"}`} title={t("sidebar.hideZero")}>
              <EyeOff size={14} />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-x-hidden overflow-y-scroll custom-scrollbar [scrollbar-gutter:stable]">
          <nav className="space-y-1">
            <div className="space-y-2">
              {sections.map((sec) => {
                const collapsed = collapsedSections.has(sec.kind);
                const SectionIcon = SECTION_ICON[sec.label] ?? Landmark;
                const sidebarGroups: SidebarSubgroup[] = sec.subgroups?.length
                  ? sec.subgroups
                  : [{ key: `${sec.kind}_default`, label: "", accounts: sec.accounts, total: sec.total }];
                return (
                  <div key={sec.kind}>
                    <div
                      className="sticky top-0 z-10 flex w-full items-center rounded-lg bg-white/92 px-3 py-2 backdrop-blur transition-all duration-200 hover:bg-white group"
                    >
                      <button
                        type="button"
                        onClick={() => openOnlySection(sec.kind)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-semibold text-slate-800"
                      >
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                          <SectionIcon size={14} />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{sectionLabel(sec.label)}</span>
                        <span className={`text-xs font-semibold tabular-nums ${sectionBalanceCls(sec.kind, sec.total)}`}>
                          {formatCurrencyMoney(displaySectionTotal(sec.kind, sec.total), baseCurrency)}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleSection(sec.kind)}
                        className="ml-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-300 transition-all duration-200 hover:bg-white hover:text-slate-500"
                        title={collapsed ? t("common.expand") : t("common.collapse")}
                      >
                        <ChevronDown
                          size={18}
                          className={collapsed ? "-rotate-90" : ""}
                        />
                      </button>
                    </div>
                    {!collapsed && (
                      <div className="mt-1 space-y-1">
                        {sidebarGroups.map((group) => {
                          const hasSubgroups = !!sec.subgroups?.length;
                          const isLoanTypeNode = sec.kind === LOAN_SECTION && !!group.href;
                          const subgroupCollapsed = !isLoanTypeNode && hasSubgroups && collapsedAssetSubgroupKeys.has(group.key);
                          const loanTypeActive = isLoanTypeNode && pathname === "/" && selectedView === "debt" && group.key === (selectedDebtLoanType ? loanSubgroupKey(selectedDebtLoanType) : "");
                          const subgroupLabel = sec.kind === "资产" ? assetSubgroupLabel(group.label) : group.label;
                          return (
                            <div key={group.key} className="space-y-1">
                              {isLoanTypeNode && group.href ? (
                                <Link
                                  href={group.href}
                                  prefetch={false}
                                  scroll={false}
                                  title={group.label}
                                  onMouseEnter={() => prefetchRoute(group.href ?? "")}
                                  onFocus={() => prefetchRoute(group.href ?? "")}
                                  onTouchStart={() => prefetchRoute(group.href ?? "")}
                                  className={`ml-3 flex items-center justify-between rounded-lg border-l px-3 py-1.5 pl-2.5 text-xs transition-all duration-200 ${
                                    loanTypeActive
                                      ? "border-blue-100 bg-blue-50/80 text-slate-900 shadow-sm"
                                      : "border-slate-100 text-slate-600 hover:border-slate-200 hover:bg-white hover:text-slate-900"
                                  }`}
                                >
                                  <span className="min-w-0 flex-1 truncate font-medium">{group.label}</span>
                                  <span className={`shrink-0 pl-2 text-[11px] font-medium tabular-nums ${sectionBalanceCls(sec.kind, group.total)}`}>
                                    {formatCurrencyMoney(displaySectionTotal(sec.kind, group.total), baseCurrency)}
                                  </span>
                                </Link>
                              ) : group.label ? (
                                <button
                                  type="button"
                                  onClick={() => focusAssetSubgroup(group.key, sec.subgroups?.map((subgroup) => subgroup.key) ?? [group.key])}
                                  className="flex w-full items-center gap-1.5 rounded-md px-3 py-0.5 text-left hover:bg-slate-50/80"
                                >
                                  <div className="text-[10px] font-medium text-slate-400">{subgroupLabel}</div>
                                  <div className="h-px flex-1 bg-slate-100" />
                                  <div className={`text-[10px] font-medium tabular-nums ${sectionBalanceCls(sec.kind, group.total)}`}>
                                    {formatCurrencyMoney(displaySectionTotal(sec.kind, group.total), baseCurrency)}
                                  </div>
                                  {hasSubgroups ? (
                                    <ChevronDown
                                      size={14}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        toggleAssetSubgroup(group.key);
                                      }}
                                      className={`shrink-0 text-slate-300 transition-transform ${subgroupCollapsed ? "-rotate-90" : ""}`}
                                    />
                                  ) : null}
                                </button>
                              ) : null}
                              {!isLoanTypeNode && (!hasSubgroups || !group.label || !subgroupCollapsed) && group.accounts.map((it, index) => {
                                const active = isAccountItemActive(it);
                                const href = (() => {
                                  if (it.kind === FIXED_ASSET_SUMMARY_KIND) {
                                    const type = it.id?.startsWith(`${FIXED_ASSET_SUMMARY_ID}:`)
                                      ? it.id.slice(FIXED_ASSET_SUMMARY_ID.length + 1)
                                      : "";
                                    const q = new URLSearchParams();
                                    q.set("view", "investproperty");
                                    if (type) q.set("fixedAssetType", type);
                                    return `/?${q.toString()}`;
                                  }
                                  if (it.kind === "loan_summary") return "/?view=debt";
                                  if (it.kind === "loan" || it.kind === "settlement") {
                                    const q = new URLSearchParams();
                                    q.set("view", "debt");
                                    const debtPersonKey = debtPersonKeyFor(it);
                                    if (debtPersonKey) q.set("debtPerson", debtPersonKey);
                                    return `/?${q.toString()}`;
                                  }
                                  const q = new URLSearchParams();
                                  if (it.id) q.set("accountId", it.id);
                                  else q.set("account", it.name);
                                  const view = it.kind.startsWith("investment")
                                    ? getInvestmentAccountView(it)
                                    : it.kind === "deposit"
                                      ? "deposit"
                                      : it.kind === "insurance"
                                        ? "insurance"
                                        : (it.kind === "bank_credit" ? "bill" : "detail");
                                  q.set("view", view);
                                  return `/?${q.toString()}`;
                                })();
                                const itemTitle = it.hoverTitle ?? [isSidebarSettlementLoan(it) ? "" : it.groupName, it.label, inlineKindLabel(it.kind)].filter(Boolean).join(" · ");
                                return (
                                  <Link
                                    key={`${group.key}:${it.id}:${it.name}`}
                                    href={href}
                                    prefetch={false}
                                    scroll={false}
                                    title={itemTitle}
                                    onMouseEnter={() => prefetchRoute(href)}
                                    onFocus={() => prefetchRoute(href)}
                                    onTouchStart={() => prefetchRoute(href)}
                                    className={`${accountLinkCls(active)} ${group.label ? "ml-3 pl-2.5 border-l border-slate-100 rounded-l-none" : ""} ${index > 0 ? "border-t border-slate-100/90" : ""}`}
                                  >
                                    <span className="min-w-0 flex-1 pr-2">
                                      <span className="text-fade-right block min-w-0" title={itemTitle}>
                                      {sidebarGroupBy === "institution" && it.kind !== "loan_summary"
                                        ? it.kind === FIXED_ASSET_SUMMARY_KIND
                                          ? it.label
                                        : it.kind === "insurance"
                                          ? (it.shortLabel || it.label)
                                          : `${inlineKindLabel(it.kind)}·${it.shortLabel || it.label}`
                                        : it.label}
                                      </span>
                                    </span>
                                    <span className={`shrink-0 pl-2 text-[11px] font-medium tabular-nums ${itemBalanceCls(it)}`}>{formatSidebarBalance(it)}</span>
                                  </Link>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </nav>
        </div>

        <div className="mt-4 shrink-0 space-y-1 border-t border-slate-200 pt-4">
          <Link
            href="/settings"
            prefetch={false}
            onMouseEnter={() => prefetchRoute("/settings")}
            onFocus={() => prefetchRoute("/settings")}
            onClick={() => {
              if (!pathname.startsWith("/settings")) setPendingSettings(true);
            }}
            className={navItemCls("/settings", pendingSettings)}
          >
            <Users size={18} />
            <span className="font-medium">{t("nav.settings")}</span>
            {pendingSettings ? (
              <span className="ml-auto h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
            ) : null}
          </Link>
        </div>
      </div>

      <NewLedgerSetupCheck />
      <DailyTaskCheck />
    </aside>
    {userMenu}
    </>
  );
}
