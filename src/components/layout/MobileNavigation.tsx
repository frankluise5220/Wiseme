"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { MouseEvent } from "react";
import { useI18n } from "@/lib/i18n";
import {
  Home,
  Landmark,
  Plus,
  Settings,
  TrendingUp,
} from "lucide-react";

type TFunc = (key: string, params?: Record<string, string | number>) => string;

function navItems(t: TFunc) {
  return [
    { href: "/overview", label: t("mobileNav.overview"), icon: Home },
    { href: "/accounts", label: t("nav.accounts"), icon: Landmark },
    { href: "/investments", label: t("nav.investments"), icon: TrendingUp },
    { href: "/settings", label: t("mobileNav.profile"), icon: Settings },
  ] as const;
}

function openQuickEntry() {
  window.dispatchEvent(
    new CustomEvent("mmh:create-transaction:open", {
      detail: {
        requestId: `mobile-${Date.now()}`,
        source: "launcher",
        item: { type: "expense" },
      },
    }),
  );
}

function isLocalQuickEntryPage(pathname: string) {
  return pathname === "/" || pathname === "/overview" || pathname === "/transactions" || pathname.startsWith("/accounts/");
}

export function MobileNavigation() {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const navItemsList = navItems(t);
  const rootView = pathname === "/" ? searchParams.get("view") ?? "" : "";
  const isRootInvestmentView =
    rootView === "investfund" ||
    rootView === "investmoney" ||
    rootView === "investwealth" ||
    rootView === "investstock" ||
    rootView === "investproperty" ||
    rootView === "regularinvest";

  const isActive = (href: string) => {
    if (href === "/investments") return isRootInvestmentView || pathname.startsWith("/invest") || pathname.startsWith("/funds") || pathname.startsWith("/regular-invest");
    if (href === "/accounts") return pathname.startsWith("/accounts") || pathname.startsWith("/insurance") || pathname.startsWith("/liabilities");
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  function handleQuickEntry(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (isLocalQuickEntryPage(pathname)) {
      openQuickEntry();
      return;
    }
    router.push("/overview?quickEntry=1");
  }

  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-50 h-[calc(5.75rem+env(safe-area-inset-bottom))] pb-[env(safe-area-inset-bottom)] md:hidden">
        <div className="absolute inset-x-0 bottom-0 grid h-[calc(4.5rem+env(safe-area-inset-bottom))] grid-cols-[1fr_1fr_0.72fr_1fr_1fr] border-t border-slate-200 bg-white/97 px-1 pb-[env(safe-area-inset-bottom)] backdrop-blur">
          <MobileNavLink item={navItemsList[0]} active={isActive(navItemsList[0].href)} />
          <MobileNavLink item={navItemsList[1]} active={isActive(navItemsList[1].href) || (pathname === "/" && !isRootInvestmentView)} />
          <span aria-hidden="true" />
          <MobileNavLink item={navItemsList[2]} active={isActive(navItemsList[2].href)} />
          <MobileNavLink item={navItemsList[3]} active={isActive(navItemsList[3].href)} />
        </div>
        <button
          type="button"
          onClick={handleQuickEntry}
          className="absolute left-1/2 top-1 flex h-14 w-14 -translate-x-1/2 touch-manipulation items-center justify-center rounded-2xl bg-white shadow-[0_4px_18px_rgba(15,23,42,0.16)]"
          aria-label={t("txForm.addEntry")}
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-[0_8px_20px_rgba(79,70,229,0.28)]">
            <Plus size={25} />
          </span>
        </button>
      </nav>
    </>
  );
}

function MobileNavLink({ item, active }: { item: ReturnType<typeof navItems>[number]; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={`flex min-w-0 flex-col items-center justify-center gap-1 text-[11px] font-medium ${active ? "text-indigo-700" : "text-slate-500"}`}
    >
      <Icon size={21} />
      <span>{item.label}</span>
    </Link>
  );
}
