"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type ElementType, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  CreditCard,
  Database,
  HeartPulse,
  Home,
  Landmark,
  Loader2,
  ReceiptText,
  Shield,
  Users,
  WalletCards,
  X,
} from "lucide-react";
import { InitModal } from "@/components/InitModal";
import { FINANCE_DATA_CHANGED_EVENT } from "@/lib/client/refresh";
import { FIRST_USE_GUIDE_OPEN_EVENT } from "@/lib/client/onboardingGuide";
import { APP_PREFS_EVENT, getSidebarHideInitialDataPreference } from "@/lib/client/appPreferences";
import { useI18n } from "@/lib/i18n";

type OnboardingStatus = {
  householdId: string;
  householdName: string;
  defaultOwnerName: string | null;
  familyMemberCount: number;
  accountCount: number;
  cashLikeAccountCount: number;
  defaultMoneyAccountId: string | null;
  defaultMoneyAccountLabel: string | null;
  cashAccountCount: number;
  debitAccountCount: number;
  creditAccountCount: number;
  investmentAccountCount: number;
  insuranceAccountCount: number;
  settlementAccountCount: number;
  initializationEntryCount: number;
  transactionCount: number;
  fundHoldingCount: number;
  regularInvestPlanCount: number;
  shouldShowGuide: boolean;
};

type StepItem = {
  key: string;
  title: string;
  eyebrow: string;
  detail: string;
  done: boolean;
  optional?: boolean;
  icon: ElementType;
  actionLabel: string;
  action: { type: "initialData"; tab?: "balance" | "fund" } | { type: "route"; href: string };
  guide: {
    intro: string;
    why: string[];
    actions: string[];
    doneWhen: string[];
    tips?: string[];
  };
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dismissedKey(householdId: string) {
  return `mmh:first-use-guide:dismissed:${householdId}`;
}

function routeMatches(pathname: string | null, href: string) {
  const target = href.split("?")[0] || "/";
  if (!pathname) return false;
  if (target === "/") return pathname === "/";
  return pathname === target || pathname.startsWith(`${target}/`);
}

function canAutoOpenGuide(pathname: string | null) {
  return pathname === "/";
}

function StepGuidePanel({
  step,
  onAction,
  routeContentOpen,
  routeReady,
  routePending,
}: {
  step: StepItem;
  onAction: (step: StepItem) => void;
  routeContentOpen: boolean;
  routeReady: boolean;
  routePending: boolean;
}) {
  const { t } = useI18n();
  const ActiveIcon = step.icon;
  const isRouteStep = step.action.type === "route";
  const actionLabel = isRouteStep && routeContentOpen
    ? routeReady
      ? t("firstUseGuide.viewBelow")
      : t("firstUseGuide.openingShort")
    : step.actionLabel;

  return (
    <section className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 shadow-sm md:px-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${step.done ? "bg-emerald-50 text-emerald-600" : "bg-blue-50 text-blue-600"}`}>
          <ActiveIcon size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">{step.title}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{step.eyebrow}</span>
            {step.optional ? <span className="rounded bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500">{t("firstUseGuide.optional")}</span> : null}
            {step.done ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600"><CheckCircle2 size={14} />{t("firstUseGuide.ready")}</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400"><Circle size={14} />{t("firstUseGuide.pending")}</span>
            )}
          </div>
          <div className="mt-1 truncate text-xs text-slate-500" title={step.guide.intro}>{step.guide.intro}</div>
        </div>
        <button
          type="button"
          onClick={() => onAction(step)}
          disabled={isRouteStep && routePending && !routeReady}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-blue-600 px-3 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-wait disabled:bg-blue-400"
        >
          {isRouteStep && routePending && !routeReady ? <Loader2 size={14} className="animate-spin" /> : null}
          {actionLabel}
          {isRouteStep && routePending && !routeReady ? null : <ArrowRight size={14} />}
        </button>
      </div>

      {step.guide.tips?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {step.guide.tips.slice(0, 3).map((tip) => (
            <span key={tip} className="rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
              {tip}
            </span>
            ))}
        </div>
      ) : null}
    </section>
  );
}

function RouteContentPlaceholder({ step }: { step: StepItem }) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[260px] items-center justify-center rounded-lg border border-dashed border-slate-200 bg-white px-6 py-10 text-center shadow-sm">
      <div>
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-blue-500" />
        <div className="mt-3 text-sm font-medium text-slate-800">{t("firstUseGuide.openingTitle", { title: step.title })}</div>
        <div className="mt-1 text-xs leading-5 text-slate-500">{t("firstUseGuide.placeholderHint")}</div>
      </div>
    </div>
  );
}

export function FirstUseGuide({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { t, language } = useI18n();
  const guideRef = useRef<HTMLElement>(null);
  const manualOpenRef = useRef(false);
  const lastPathnameRef = useRef<string | null>(null);
  const prefetchedRoutesRef = useRef(new Set<string>());
  const [routePending, startRouteTransition] = useTransition();
  const [status, setStatus] = useState<OnboardingStatus | null>(null);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [initOpen, setInitOpen] = useState(false);
  const [initTab, setInitTab] = useState<"balance" | "fund">("balance");
  const [activeKey, setActiveKey] = useState("ledger");
  const [routeContentOpen, setRouteContentOpen] = useState(false);

  const scrollGuideIntoView = useCallback(() => {
    window.requestAnimationFrame(() => {
      guideRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }, []);

  const loadStatus = useCallback(async () => {
    if (getSidebarHideInitialDataPreference()) {
      manualOpenRef.current = false;
      setVisible(false);
      setRouteContentOpen(false);
      setLoading(false);
      return;
    }
    try {
      const res = await fetch("/api/v1/onboarding/status", { cache: "no-store" });
      const data = await res.json() as { ok?: boolean; data?: OnboardingStatus };
      if (!data.ok || !data.data) return;
      setStatus(data.data);
      const dismissedToday = localStorage.getItem(dismissedKey(data.data.householdId)) === todayKey();
      const shouldAutoShow = canAutoOpenGuide(pathname) && data.data.shouldShowGuide && !dismissedToday;
      const shouldShow = manualOpenRef.current || shouldAutoShow;
      setVisible(shouldShow);
      if (shouldShow && manualOpenRef.current) scrollGuideIntoView();
    } catch {
      // Non-fatal: onboarding should never block the ledger workspace.
    } finally {
      setLoading(false);
    }
  }, [pathname, scrollGuideIntoView]);

  const openGuide = useCallback(() => {
    if (getSidebarHideInitialDataPreference()) {
      manualOpenRef.current = false;
      setVisible(false);
      setRouteContentOpen(false);
      return;
    }
    manualOpenRef.current = true;
    setVisible(true);
    setRouteContentOpen(false);
    void loadStatus();
    scrollGuideIntoView();
  }, [loadStatus, scrollGuideIntoView]);

  useEffect(() => {
    setMounted(true);
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const refresh = () => { void loadStatus(); };
    const open = () => openGuide();
    window.addEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
    window.addEventListener(APP_PREFS_EVENT, refresh);
    window.addEventListener(FIRST_USE_GUIDE_OPEN_EVENT, open);
    return () => {
      window.removeEventListener(FINANCE_DATA_CHANGED_EVENT, refresh);
      window.removeEventListener(APP_PREFS_EVENT, refresh);
      window.removeEventListener(FIRST_USE_GUIDE_OPEN_EVENT, open);
    };
  }, [loadStatus, openGuide]);

  const prefetchStep = useCallback((step: StepItem) => {
    if (step.action.type !== "route") return;
    const href = step.action.href;
    if (prefetchedRoutesRef.current.has(href)) return;
    prefetchedRoutesRef.current.add(href);
    router.prefetch(href);
  }, [router]);

  const openRouteStep = useCallback((step: StepItem) => {
    if (step.action.type !== "route") return;
    const href = step.action.href;
    setRouteContentOpen(true);
    prefetchStep(step);
    startRouteTransition(() => {
      router.push(href);
    });
  }, [prefetchStep, router, startRouteTransition]);

  const handleStepAction = useCallback((step: StepItem) => {
    if (step.action.type === "initialData") {
      setRouteContentOpen(false);
      setInitTab(step.action.tab ?? "balance");
      setInitOpen(true);
      return;
    }
    openRouteStep(step);
  }, [openRouteStep]);

  const selectStep = useCallback((step: StepItem) => {
    setActiveKey(step.key);
    if (step.action.type === "route") {
      openRouteStep(step);
      return;
    }
    setRouteContentOpen(false);
  }, [openRouteStep]);

  const steps = useMemo<StepItem[]>(() => {
    const current = status ?? {
      householdId: "",
      householdName: "",
      defaultOwnerName: null,
      familyMemberCount: 0,
      accountCount: 0,
      cashLikeAccountCount: 0,
      defaultMoneyAccountId: null,
      defaultMoneyAccountLabel: null,
      cashAccountCount: 0,
      debitAccountCount: 0,
      creditAccountCount: 0,
      investmentAccountCount: 0,
      insuranceAccountCount: 0,
      settlementAccountCount: 0,
      initializationEntryCount: 0,
      transactionCount: 0,
      fundHoldingCount: 0,
      regularInvestPlanCount: 0,
      shouldShowGuide: false,
    };
    const resolvedHouseholdName = current.householdName || t("firstUseGuide.defaultHouseholdName");
    const ownerName = current.defaultOwnerName || resolvedHouseholdName;
    const hasBaseAccounts = current.cashAccountCount > 0 && current.debitAccountCount > 0 && current.creditAccountCount > 0;
    const hasInitialData = current.initializationEntryCount > 0 || current.fundHoldingCount > 0;
    const defaultMoneyAccountLabel = current.defaultMoneyAccountLabel || t("firstUseGuide.defaultMoneyAccount");
    const dailyActionHref = current.defaultMoneyAccountId
      ? `/?accountId=${encodeURIComponent(current.defaultMoneyAccountId)}&view=detail&guide=daily-table`
      : "/overview";

    return [
      {
        key: "ledger",
        title: t("firstUseGuide.step.ledger.title"),
        eyebrow: t("firstUseGuide.eyebrowStep", { n: 1 }),
        detail: resolvedHouseholdName,
        done: true,
        icon: Home,
        actionLabel: t("firstUseGuide.step.ledger.action"),
        action: { type: "route", href: "/settings/ledgers" },
        guide: {
          intro: t("firstUseGuide.step.ledger.intro", { name: resolvedHouseholdName }),
          why: [
            t("firstUseGuide.step.ledger.why0"),
            t("firstUseGuide.step.ledger.why1"),
            t("firstUseGuide.step.ledger.why2"),
          ],
          actions: [
            t("firstUseGuide.step.ledger.action0"),
            t("firstUseGuide.step.ledger.action1"),
            t("firstUseGuide.step.ledger.action2"),
          ],
          doneWhen: [
            t("firstUseGuide.step.ledger.done0", { name: resolvedHouseholdName }),
            t("firstUseGuide.step.ledger.done1"),
            t("firstUseGuide.step.ledger.done2"),
          ],
          tips: [
            t("firstUseGuide.step.ledger.tip0"),
            t("firstUseGuide.step.ledger.tip1"),
            t("firstUseGuide.step.ledger.tip2"),
          ],
        },
      },
      {
        key: "family",
        title: t("settings.familyMembers"),
        eyebrow: t("firstUseGuide.eyebrowStep", { n: 2 }),
        detail: t("firstUseGuide.step.family.detail", { name: ownerName }),
        done: current.familyMemberCount > 0,
        icon: Users,
        actionLabel: t("firstUseGuide.step.family.action"),
        action: { type: "route", href: "/settings/family-members" },
        guide: {
          intro: t("firstUseGuide.step.family.intro", { name: ownerName }),
          why: [
            t("firstUseGuide.step.family.why0"),
            t("firstUseGuide.step.family.why1"),
            t("firstUseGuide.step.family.why2"),
          ],
          actions: [
            t("firstUseGuide.step.family.action0", { name: ownerName }),
            t("firstUseGuide.step.family.action1"),
            t("firstUseGuide.step.family.action2"),
          ],
          doneWhen: [
            t("firstUseGuide.step.family.done0", { count: current.familyMemberCount.toLocaleString(language) }),
            t("firstUseGuide.step.family.done1"),
            t("firstUseGuide.step.family.done2"),
          ],
          tips: [
            t("firstUseGuide.step.family.tip0"),
            t("firstUseGuide.step.family.tip1"),
            t("firstUseGuide.step.family.tip2"),
          ],
        },
      },
      {
        key: "base-accounts",
        title: t("firstUseGuide.step.baseAccounts.title"),
        eyebrow: t("firstUseGuide.eyebrowStep", { n: 3 }),
        detail: hasBaseAccounts
          ? t("firstUseGuide.step.baseAccounts.detailDone", { name: ownerName })
          : t("firstUseGuide.step.baseAccounts.detailTodo"),
        done: hasBaseAccounts,
        icon: WalletCards,
        actionLabel: t("firstUseGuide.step.baseAccounts.action"),
        action: { type: "route", href: "/settings/accounts?guide=accounts" },
        guide: {
          intro: t("firstUseGuide.step.baseAccounts.intro"),
          why: [
            t("firstUseGuide.step.baseAccounts.why0"),
            t("firstUseGuide.step.baseAccounts.why1"),
            t("firstUseGuide.step.baseAccounts.why2"),
          ],
          actions: [
            current.cashAccountCount > 0
              ? t("firstUseGuide.step.baseAccounts.actionCashDone")
              : t("firstUseGuide.step.baseAccounts.actionCashTodo"),
            current.debitAccountCount > 0
              ? t("firstUseGuide.step.baseAccounts.actionDebitDone")
              : t("firstUseGuide.step.baseAccounts.actionDebitTodo"),
            current.creditAccountCount > 0
              ? t("firstUseGuide.step.baseAccounts.actionCreditDone")
              : t("firstUseGuide.step.baseAccounts.actionCreditTodo"),
            t("firstUseGuide.step.baseAccounts.action3"),
          ],
          doneWhen: [
            t("firstUseGuide.step.baseAccounts.done0"),
            t("firstUseGuide.step.baseAccounts.done1"),
            t("firstUseGuide.step.baseAccounts.done2"),
          ],
          tips: [
            t("firstUseGuide.step.baseAccounts.tip0"),
            t("firstUseGuide.step.baseAccounts.tip1"),
            t("firstUseGuide.step.baseAccounts.tip2"),
          ],
        },
      },
      {
        key: "investment",
        title: t("firstUseGuide.step.investment.title"),
        eyebrow: t("firstUseGuide.eyebrowStep", { n: 4 }),
        detail: current.investmentAccountCount > 0
          ? t("firstUseGuide.step.investment.detailDone", {
              accounts: current.investmentAccountCount.toLocaleString(language),
              funds: current.fundHoldingCount.toLocaleString(language),
            })
          : t("firstUseGuide.step.investment.detailTodo"),
        done: current.investmentAccountCount > 0 && hasInitialData,
        icon: Database,
        actionLabel: t("firstUseGuide.step.investment.action"),
        action: { type: "initialData", tab: "fund" },
        guide: {
          intro: t("firstUseGuide.step.investment.intro"),
          why: [
            t("firstUseGuide.step.investment.why0"),
            t("firstUseGuide.step.investment.why1"),
            t("firstUseGuide.step.investment.why2"),
          ],
          actions: [
            current.investmentAccountCount > 0
              ? t("firstUseGuide.step.investment.actionAccountCheck")
              : t("firstUseGuide.step.investment.actionAccountCreate"),
            current.fundHoldingCount > 0
              ? t("firstUseGuide.step.investment.actionHoldingCheck")
              : t("firstUseGuide.step.investment.actionHoldingCreate"),
            t("firstUseGuide.step.investment.action2"),
          ],
          doneWhen: [
            t("firstUseGuide.step.investment.done0", {
              accounts: current.investmentAccountCount.toLocaleString(language),
              funds: current.fundHoldingCount.toLocaleString(language),
            }),
            t("firstUseGuide.step.investment.done1"),
            t("firstUseGuide.step.investment.done2"),
          ],
          tips: [
            t("firstUseGuide.step.investment.tip0"),
            t("firstUseGuide.step.investment.tip1"),
            t("firstUseGuide.step.investment.tip2"),
          ],
        },
      },
      {
        key: "insurance",
        title: t("firstUseGuide.step.insurance.title"),
        eyebrow: t("firstUseGuide.eyebrowStep", { n: 5 }),
        detail: current.insuranceAccountCount > 0
          ? t("firstUseGuide.step.insurance.detailDone", { count: current.insuranceAccountCount.toLocaleString(language) })
          : t("firstUseGuide.step.insurance.detailTodo"),
        done: current.insuranceAccountCount > 0,
        optional: true,
        icon: Shield,
        actionLabel: t("firstUseGuide.step.insurance.action"),
        action: { type: "route", href: "/insurance" },
        guide: {
          intro: t("firstUseGuide.step.insurance.intro"),
          why: [
            t("firstUseGuide.step.insurance.why0"),
            t("firstUseGuide.step.insurance.why1"),
            t("firstUseGuide.step.insurance.why2"),
          ],
          actions: [
            t("firstUseGuide.step.insurance.action0"),
            t("firstUseGuide.step.insurance.action1"),
            t("firstUseGuide.step.insurance.action2"),
          ],
          doneWhen: [
            t("firstUseGuide.step.insurance.done0", { count: current.insuranceAccountCount.toLocaleString(language) }),
            t("firstUseGuide.step.insurance.done1"),
            t("firstUseGuide.step.insurance.done2"),
          ],
          tips: [
            t("firstUseGuide.step.insurance.tip0"),
            t("firstUseGuide.step.insurance.tip1"),
            t("firstUseGuide.step.insurance.tip2"),
          ],
        },
      },
      {
        key: "settlements",
        title: t("nav.liabilities"),
        eyebrow: t("firstUseGuide.eyebrowStep", { n: 6 }),
        detail: current.settlementAccountCount > 0
          ? t("firstUseGuide.step.settlements.detailDone", { count: current.settlementAccountCount.toLocaleString(language) })
          : t("firstUseGuide.step.settlements.detailTodo"),
        done: current.settlementAccountCount > 0,
        optional: true,
        icon: Landmark,
        actionLabel: t("firstUseGuide.step.settlements.action"),
        action: { type: "route", href: "/liabilities?guide=settlements" },
        guide: {
          intro: t("firstUseGuide.step.settlements.intro"),
          why: [
            t("firstUseGuide.step.settlements.why0"),
            t("firstUseGuide.step.settlements.why1"),
            t("firstUseGuide.step.settlements.why2"),
          ],
          actions: [
            t("firstUseGuide.step.settlements.action0"),
            t("firstUseGuide.step.settlements.action1"),
            t("firstUseGuide.step.settlements.action2"),
          ],
          doneWhen: [
            t("firstUseGuide.step.settlements.done0", { count: current.settlementAccountCount.toLocaleString(language) }),
            t("firstUseGuide.step.settlements.done1"),
            t("firstUseGuide.step.settlements.done2"),
          ],
          tips: [
            t("firstUseGuide.step.settlements.tip0"),
            t("firstUseGuide.step.settlements.tip1"),
            t("firstUseGuide.step.settlements.tip2"),
          ],
        },
      },
      {
        key: "daily",
        title: t("firstUseGuide.step.daily.title"),
        eyebrow: t("firstUseGuide.eyebrowLast"),
        detail: current.transactionCount > 0
          ? t("firstUseGuide.step.daily.detailDone", { count: current.transactionCount.toLocaleString(language) })
          : t("firstUseGuide.step.daily.detailTodo", { account: defaultMoneyAccountLabel }),
        done: current.transactionCount > 0,
        icon: ReceiptText,
        actionLabel: current.defaultMoneyAccountId ? t("firstUseGuide.step.daily.actionDetail") : t("firstUseGuide.step.daily.actionWorkspace"),
        action: { type: "route", href: dailyActionHref },
        guide: {
          intro: t("firstUseGuide.step.daily.intro", { account: defaultMoneyAccountLabel }),
          why: [
            t("firstUseGuide.step.daily.why0"),
            t("firstUseGuide.step.daily.why1"),
            t("firstUseGuide.step.daily.why2"),
          ],
          actions: [
            t("firstUseGuide.step.daily.action0"),
            t("firstUseGuide.step.daily.action1"),
            current.regularInvestPlanCount > 0
              ? t("firstUseGuide.step.daily.actionPlanDone", { count: current.regularInvestPlanCount.toLocaleString(language) })
              : t("firstUseGuide.step.daily.actionPlanTodo"),
          ],
          doneWhen: [
            t("firstUseGuide.step.daily.done0", { count: current.transactionCount.toLocaleString(language) }),
            t("firstUseGuide.step.daily.done1"),
            t("firstUseGuide.step.daily.done2"),
          ],
          tips: [
            t("firstUseGuide.step.daily.tip0"),
            t("firstUseGuide.step.daily.tip1"),
            t("firstUseGuide.step.daily.tip2"),
          ],
        },
      },
    ];
  }, [status, t, language]);

  useEffect(() => {
    if (!status) return;
    const firstOpen = steps.find((step) => !step.done && !step.optional) ?? steps[0];
    setActiveKey((current) => steps.some((step) => step.key === current) ? current : firstOpen.key);
  }, [status, steps]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => {
      steps.forEach(prefetchStep);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [prefetchStep, steps, visible]);

  useEffect(() => {
    const previousPathname = lastPathnameRef.current;
    lastPathnameRef.current = pathname;
    if (!visible || previousPathname == null || previousPathname === pathname) return;
    const activeStep = steps.find((step) => step.key === activeKey) ?? steps[0];
    if (routeContentOpen && activeStep?.action.type === "route" && routeMatches(pathname, activeStep.action.href)) return;
    manualOpenRef.current = false;
    setVisible(false);
    setRouteContentOpen(false);
  }, [activeKey, pathname, routeContentOpen, steps, visible]);

  if (!mounted || loading || !visible || !status) return <>{children}</>;

  const currentStatus = status;
  const requiredSteps = steps.filter((step) => !step.optional);
  const completedRequired = requiredSteps.filter((step) => step.done).length;
  const activeStep = steps.find((step) => step.key === activeKey) ?? steps[0];
  const activeRouteReady = activeStep.action.type !== "route" || routeMatches(pathname, activeStep.action.href);
  const routeStillLoading = routeContentOpen && activeStep.action.type === "route" && !activeRouteReady;

  function dismissToday() {
    manualOpenRef.current = false;
    localStorage.setItem(dismissedKey(currentStatus.householdId), todayKey());
    setVisible(false);
    setRouteContentOpen(false);
  }

  return (
    <section ref={guideRef} className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-50">
      <div className="shrink-0 border-b border-slate-200 bg-white px-3 py-3 shadow-sm md:px-5">
        <div className="mx-auto flex w-full max-w-[1280px] items-start gap-4">
          <div className="w-28 shrink-0 pt-0.5">
            <div className="text-sm font-semibold text-slate-900">{t("firstUseGuide.title")}</div>
            <div className="mt-1 text-xs leading-5 text-slate-500">
              {currentStatus.householdName ? `${currentStatus.householdName} · ` : ""}{completedRequired}/{requiredSteps.length}
            </div>
          </div>
          <div className="min-w-0 flex-1 overflow-x-auto pb-1">
            <div className="flex min-w-max items-start">
              {steps.map((step, index) => {
                const StepIcon = step.icon;
                const active = step.key === activeStep.key;
                const complete = step.done;
                return (
                  <div key={step.key} className="flex items-start">
                    <button
                      type="button"
                      onClick={() => selectStep(step)}
                      onMouseEnter={() => prefetchStep(step)}
                      onFocus={() => prefetchStep(step)}
                      title={t("firstUseGuide.stepTitleDetail", { title: step.title, detail: step.detail })}
                      className="group grid w-28 justify-items-center gap-1.5 text-center"
                    >
                      <span
                        className={`flex h-9 w-9 items-center justify-center rounded-full border transition-colors ${
                          active
                            ? "border-blue-600 bg-blue-600 text-white"
                            : complete
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-slate-200 bg-white text-slate-400 group-hover:border-blue-200 group-hover:text-blue-600"
                        }`}
                      >
                        <StepIcon size={17} />
                      </span>
                      <span className={`text-xs font-medium ${active ? "text-blue-700" : "text-slate-600"}`}>{step.title}</span>
                      <span className="text-[10px] text-slate-400">{step.eyebrow}</span>
                    </button>
                    {index < steps.length - 1 ? (
                      <div className={`mt-[18px] h-0.5 w-10 rounded-full ${complete ? "bg-emerald-200" : "bg-slate-200"}`} />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
          <button
            type="button"
            onClick={dismissToday}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            title={t("firstUseGuide.dismissToday")}
            aria-label={t("firstUseGuide.dismissToday")}
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-5">
        {routeContentOpen && activeStep.action.type === "route" ? (
          <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-3">
            <StepGuidePanel
              step={activeStep}
              onAction={handleStepAction}
              routeContentOpen={routeContentOpen}
              routeReady={activeRouteReady}
              routePending={routePending || routeStillLoading}
            />
            {activeRouteReady ? (
              <div className="min-h-0">
                {children}
              </div>
            ) : (
              <RouteContentPlaceholder step={activeStep} />
            )}
          </div>
        ) : (
        <div className="mx-auto grid w-full max-w-[1280px] gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
          <StepGuidePanel
            step={activeStep}
            onAction={handleStepAction}
            routeContentOpen={routeContentOpen}
            routeReady={activeRouteReady}
            routePending={routePending || routeStillLoading}
          />

          <aside className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold text-slate-700">{t("firstUseGuide.autoFundedStart")}</div>
            <div className="mt-3 grid gap-2">
              {[
                { labelKey: "firstUseGuide.aside.cashAccount", count: currentStatus.cashAccountCount, icon: WalletCards },
                { labelKey: "firstUseGuide.aside.debitCard", count: currentStatus.debitAccountCount, icon: Landmark },
                { labelKey: "firstUseGuide.aside.creditCard", count: currentStatus.creditAccountCount, icon: CreditCard },
                { labelKey: "firstUseGuide.step.investment.title", count: currentStatus.investmentAccountCount, icon: HeartPulse },
              ].map((item) => {
                const ItemIcon = item.icon;
                return (
                  <div key={item.labelKey} className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2 text-sm text-slate-700">
                      <ItemIcon size={16} className="shrink-0 text-slate-400" />
                      <span className="truncate">{t(item.labelKey)}</span>
                    </div>
                    <span className={`shrink-0 text-xs font-medium ${item.count > 0 ? "text-emerald-600" : "text-slate-400"}`}>
                      {item.count > 0 ? t("firstUseGuide.countUnits", { count: item.count.toLocaleString(language) }) : t("firstUseGuide.notCreated")}
                    </span>
                  </div>
                );
              })}
            </div>
          </aside>
        </div>
        )}
      </div>
      <InitModal open={initOpen} onOpenChange={setInitOpen} initialTab={initTab} />
    </section>
  );
}
