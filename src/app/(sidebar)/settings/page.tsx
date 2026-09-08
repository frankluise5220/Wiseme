import Link from "next/link";
import { cookies } from "next/headers";

import { SettingsCatalogIcon } from "@/components/settings/SettingsCatalogIcon";
import { localizeSettingsCatalog } from "@/lib/settings/catalog";
import { getServerT } from "@/lib/server/i18n";

const BASIC_DATA_SECONDARY_IDS = new Set(["family-members", "counterparties", "institutions", "tags"]);
const BASIC_DATA_PRIMARY_HREF = "/settings/family-members";

export default async function SettingsPage() {
  const t = await getServerT();
  const cookieStore = await cookies();
  const hideDescriptions = cookieStore.get("sidebar_hide_initial_data")?.value === "true";
  const catalog = localizeSettingsCatalog(t, "web");
  const displayGroups = catalog.groups.map((group) => {
    if (group.id !== "master-data") return group;
    return {
      ...group,
      items: group.items.flatMap((item) => {
        if (item.id === "institutions") {
          return [{
            ...item,
            id: "basic-data",
            label: t("settings.basicDataSubmenu"),
            description: t("settings.basicDataSubmenu.desc"),
            icon: "database",
            webHref: BASIC_DATA_PRIMARY_HREF,
          }];
        }
        return BASIC_DATA_SECONDARY_IDS.has(item.id) ? [] : [item];
      }),
    };
  });

  // Desktop-app-only group. The /settings/desktop page and /api/desktop/config
  // only exist for the Windows Electron build; hide it on web/NAS/mobile.
  const isWindowsDesktop = process.env.MMH_DEPLOY_TARGET === "windows";
  const groupsWithDesktop = isWindowsDesktop
    ? [
        ...displayGroups,
        {
          id: "desktop",
          label: t("settings.group.desktop"),
          description: t("settings.group.desktop.desc"),
          items: [
            {
              id: "desktop-lan",
              label: t("settings.desktop.title"),
              description: t("settings.desktop.allowLanDesc"),
              icon: "globe",
              surfaces: ["web"] as const,
              webHref: "/settings/desktop",
            },
          ],
        },
      ]
    : displayGroups;

  return (
    <>
      <div className="h-full overflow-y-auto bg-slate-100 px-3 py-2 md:hidden">
        <div className="space-y-3 pb-4">
          <section className="rounded-2xl bg-gradient-to-br from-slate-950 to-indigo-700 px-4 py-4 text-white shadow-sm">
            <div className="text-lg font-semibold">{t("mobileNav.profile")}</div>
            {hideDescriptions ? null : <div className="mt-1 text-xs leading-5 text-indigo-100">{t("settings.catalogDescription")}</div>}
          </section>

          {groupsWithDesktop.map((group) => (
            <section key={group.id} className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
              <div className="border-b border-slate-100 px-3 py-2.5" title={hideDescriptions ? group.description : undefined}>
                <h3 className="text-sm font-semibold text-slate-950">{group.label}</h3>
              </div>
              <div className="divide-y divide-slate-100">
                {group.items.map((item) => {
                  if (!item.webHref) return null;
                  return (
                    <Link
                      key={item.id}
                      href={item.webHref}
                      prefetch={false}
                      className="flex min-h-14 items-center gap-3 px-3 py-2.5 active:bg-slate-50"
                    >
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600">
                        <SettingsCatalogIcon icon={item.icon} className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1" title={hideDescriptions ? item.description : undefined}>
                        <span className="block truncate text-sm font-medium text-slate-900">{item.label}</span>
                        {hideDescriptions ? null : <span className="mt-0.5 block truncate text-xs text-slate-500">{item.description}</span>}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>

      <div className="mx-auto hidden max-w-4xl space-y-3 md:block md:space-y-4">
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-4">
          <h2 className="text-sm font-semibold text-slate-800">{catalog.title}</h2>
          {hideDescriptions ? null : <p className="mt-1 text-xs text-slate-500">
            {t("settings.catalogDescription")}
          </p>}
        </div>

        {groupsWithDesktop.map((group) => (
          <section key={group.id} className="space-y-2">
            <div className="px-1" title={hideDescriptions ? group.description : undefined}>
              <h3 className="text-xs font-semibold text-slate-700">{group.label}</h3>
              {hideDescriptions ? null : <p className="mt-0.5 text-[11px] text-slate-500">{group.description}</p>}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {group.items.map((item) => {
                if (!item.webHref) return null;
                return (
                  <Link
                    key={item.id}
                    href={item.webHref}
                    prefetch={false}
                    className="group rounded-xl border border-slate-200 bg-white px-4 py-3 transition-colors hover:border-blue-200 hover:bg-blue-50/40"
                  >
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 transition-colors group-hover:bg-blue-100 group-hover:text-blue-600">
                        <SettingsCatalogIcon icon={item.icon} className="h-4 w-4" />
                      </span>
                      <span className="min-w-0" title={hideDescriptions ? item.description : undefined}>
                        <span className="block text-sm font-medium text-slate-800">{item.label}</span>
                        {hideDescriptions ? null : <span className="mt-0.5 block truncate text-xs text-slate-500">{item.description}</span>}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
