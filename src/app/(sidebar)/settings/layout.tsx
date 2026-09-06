"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronRight, Loader2, Settings } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { SettingsCatalogIcon } from "@/components/settings/SettingsCatalogIcon";
import { getSettingsItemsForSurface, localizeSettingsItem } from "@/lib/settings/catalog";

const BASIC_DATA_SECONDARY_IDS = new Set(["family-members", "counterparties", "institutions", "tags"]);
const BASIC_DATA_SECONDARY_HREFS = new Set(["/settings/family-members", "/settings/counterparties", "/settings/institutions", "/settings/tags"]);
const BASIC_DATA_PRIMARY_HREF = "/settings/family-members";
const rawNavItems = getSettingsItemsForSurface("web").filter((item) => item.webHref);
const navItems = rawNavItems.flatMap((item) => {
  if (item.id === "institutions") {
    return [{
      ...item,
      id: "basic-data",
      label: "Basic Data",
      description: "Family members, counterparties, institutions, and tags",
      icon: "database",
      webHref: BASIC_DATA_PRIMARY_HREF,
    }];
  }
  return BASIC_DATA_SECONDARY_IDS.has(item.id) ? [] : [item];
});

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const { t } = useI18n();

  useEffect(() => {
    setPendingHref(null);
  }, [pathname]);

  return (
    <div className="flex-1 flex min-h-0 min-w-0">
      {/* Left navigation */}
      <nav className="hidden w-44 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="h-12 flex items-center px-4 border-b border-slate-100 shrink-0">
          <Settings className="w-4 h-4 text-slate-500 mr-2" />
          <span className="font-semibold text-sm text-slate-800">{t("nav.settings")}</span>
        </div>
        <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
          {navItems.map((item) => {
            const href = item.webHref ?? "/settings";
            const localized = localizeSettingsItem(t, item);
            const pending = pendingHref === href && pathname !== href;
            const active = pathname === href || pending || (item.id === "basic-data" && BASIC_DATA_SECONDARY_HREFS.has(pathname));
            return (
              <Link
                key={item.id}
                href={href}
                prefetch={false}
                onClick={() => {
                  if (pathname !== href) setPendingHref(href);
                }}
                className={`h-9 px-3 rounded-md text-sm flex items-center gap-2.5 transition-colors ${
                  active
                    ? "bg-blue-50 text-blue-700 font-medium"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-800"
                }`}
              >
                <SettingsCatalogIcon icon={item.icon} className={`w-4 h-4 shrink-0 ${active ? "text-blue-500" : "text-slate-400"}`} />
                <span className="truncate">{localized.label}</span>
                {pending ? (
                  <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-blue-400" />
                ) : active ? (
                  <ChevronRight className="w-3.5 h-3.5 ml-auto text-blue-400" />
                ) : null}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Right content */}
      <div className="flex-1 min-w-0 overflow-auto bg-slate-50">
        <div className="p-3 md:p-4">
          {children}
        </div>
      </div>
    </div>
  );
}
