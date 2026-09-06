"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AccountBatchImportButton } from "@/components/settings/AccountBatchImportButton";
import {
  fetchSettingsAccountData,
  getCachedSettingsAccountData,
  notifySettingsDataChanged,
  type SettingsAccountGroup,
  type SettingsCounterparty,
  type SettingsInstitution,
} from "@/lib/client/settingsCache";
import { normalizeCurrency } from "@/lib/currency";
import { useI18n } from "@/lib/i18n";

type BasicDataImportExportProps = {
  groups?: SettingsAccountGroup[];
  institutions?: SettingsInstitution[];
  counterparties?: SettingsCounterparty[];
  baseCurrency?: string;
  onImported?: () => void;
};

const BASIC_DATA_TABS = [
  { href: "/settings/family-members", labelKey: "settings.familyMembers" },
  { href: "/settings/counterparties", labelKey: "settings.counterparties" },
  { href: "/settings/institutions", labelKey: "settings.institutions" },
  { href: "/settings/tags", labelKey: "settings.tags" },
] as const;

function normalizeAccountData(data: Awaited<ReturnType<typeof fetchSettingsAccountData>>) {
  return {
    groups: data.groups ?? [],
    institutions: data.institutions ?? [],
    counterparties: data.counterparties ?? [],
    baseCurrency: normalizeCurrency(data.baseCurrency ?? "CNY"),
  };
}

/**
 * One component for the basic-data export template + import buttons ("导出模板"
 * and "导入基本资料"). Renders the buttons only — no label, no container — so it
 * can sit inline in a table toolbar next to other actions.
 */
export function BasicDataImportExport({
  groups,
  institutions,
  counterparties,
  baseCurrency,
  onImported,
}: BasicDataImportExportProps) {
  const { t } = useI18n();
  const hasProvidedData = Boolean(groups && institutions && counterparties && baseCurrency);
  const [loadedData, setLoadedData] = useState<ReturnType<typeof normalizeAccountData> | null>(() => {
    const cached = getCachedSettingsAccountData();
    return cached ? normalizeAccountData(cached) : null;
  });
  const [loadFailed, setLoadFailed] = useState(false);

  const resolvedData = useMemo(() => {
    if (hasProvidedData) {
      return {
        groups: groups ?? [],
        institutions: institutions ?? [],
        counterparties: counterparties ?? [],
        baseCurrency: normalizeCurrency(baseCurrency ?? "CNY"),
      };
    }
    return loadedData;
  }, [baseCurrency, counterparties, groups, hasProvidedData, institutions, loadedData]);

  const loadData = useCallback(async (force = false) => {
    try {
      const data = await fetchSettingsAccountData({ force });
      setLoadedData(normalizeAccountData(data));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    if (hasProvidedData) return;
    void loadData(false);
  }, [hasProvidedData, loadData]);

  const handleImported = useCallback(() => {
    void notifySettingsDataChanged({ scope: "all", reason: "basic-data:import", prefetch: true });
    void loadData(true);
    onImported?.();
  }, [loadData, onImported]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {resolvedData ? (
        <AccountBatchImportButton
          groups={resolvedData.groups}
          institutions={resolvedData.institutions}
          counterparties={resolvedData.counterparties}
          baseCurrency={resolvedData.baseCurrency}
          onImported={handleImported}
        />
      ) : (
        <span className={`text-xs ${loadFailed ? "text-red-500" : "text-slate-400"}`}>
          {loadFailed ? t("settings.basicDataImportExport.loadFailed") : t("settings.basicDataImportExport.loading")}
        </span>
      )}
    </div>
  );
}

export function BasicDataTabs() {
  const pathname = usePathname();
  const { t } = useI18n();

  return (
    <nav className="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm" aria-label={t("settings.basicDataSubmenu")}>
      {BASIC_DATA_TABS.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch={false}
            className={[
              "inline-flex h-8 items-center rounded-md px-3 text-xs font-medium transition-colors",
              active ? "bg-blue-50 text-blue-700 shadow-sm" : "text-slate-500 hover:bg-slate-50 hover:text-slate-800",
            ].join(" ")}
          >
            {t(item.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * The basic-data tabs row: page tabs on the left, the shared export-template +
 * import buttons on the right. The export/import feature covers all four basic
 * data tables at once, so it lives here — not inside each table's header.
 */
export function BasicDataSubmenuHeader({
  onImported,
  children,
}: {
  onImported?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <BasicDataTabs />
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {children}
        <BasicDataImportExport onImported={onImported} />
      </div>
    </div>
  );
}
