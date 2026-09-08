import rawCatalog from "../../../shared/settings/catalog.json";

export type SettingsSurface = "web" | "android";

export type SettingsCatalogItem = {
  id: string;
  label: string;
  description: string;
  icon: string;
  surfaces: SettingsSurface[];
  webHref?: string;
  androidRoute?: string;
  preferenceKeys?: string[];
  apiRefs?: string[];
};

export type SettingsCatalogGroup = {
  id: string;
  label: string;
  description: string;
  items: SettingsCatalogItem[];
};

export type SettingsCatalog = {
  schemaVersion: number;
  id: string;
  title: string;
  description: string;
  groups: SettingsCatalogGroup[];
};

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;

export const settingsCatalog = rawCatalog as SettingsCatalog;

export function getSettingsCatalogForSurface(surface: SettingsSurface): SettingsCatalog {
  return {
    ...settingsCatalog,
    groups: settingsCatalog.groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => item.surfaces.includes(surface)),
      }))
      .filter((group) => group.items.length > 0),
  };
}

export function getSettingsItemsForSurface(surface: SettingsSurface) {
  return getSettingsCatalogForSurface(surface).groups.flatMap((group) => group.items);
}

export function findSettingsItem(id: string, surface?: SettingsSurface) {
  const groups = surface ? getSettingsCatalogForSurface(surface).groups : settingsCatalog.groups;
  for (const group of groups) {
    const item = group.items.find((entry) => entry.id === id);
    if (item) return item;
  }
  return null;
}

// ── Web localization ─────────────────────────────────────────────────────────
// The shared catalog JSON keeps human-readable Chinese labels so Android and
// the /api/v1/settings/catalog contract stay stable. Web rendering maps each
// catalog id to an i18n key and falls back to the raw label when a key is
// missing. Every key referenced here exists in all three catalogs (zh-CN,
// en-US, ja-JP) in src/lib/i18n-core.ts.

const SETTINGS_TITLE_KEY = "settings.catalogTitle";

const SETTINGS_GROUP_LABEL_KEYS: Record<string, string> = {
  profile: "settings.group.profile",
  "master-data": "settings.group.masterData",
  automation: "settings.group.automation",
  display: "settings.group.display",
  system: "settings.group.system",
  feedback: "settings.group.feedback",
};

const SETTINGS_GROUP_DESCRIPTION_KEYS: Record<string, string> = {
  profile: "settings.group.profile.desc",
  "master-data": "settings.group.masterData.desc",
  automation: "settings.group.automation.desc",
  display: "settings.group.display.desc",
  system: "settings.group.system.desc",
  feedback: "settings.group.feedback.desc",
};

const SETTINGS_ITEM_LABEL_KEYS: Record<string, string> = {
  ledgers: "settings.ledgers",
  users: "settings.users",
  accounts: "settings.accounts",
  institutions: "settings.institutions",
  counterparties: "settings.counterparties",
  "family-members": "settings.familyMembers",
  categories: "settings.categories",
  tags: "settings.tags",
  email: "settings.emailAccounts",
  "password-recovery": "settings.passwordRecovery",
  ai: "settings.aiModels",
  api: "settings.externalApi",
  "fund-api": "settings.fundApi",
  display: "settings.display",
  database: "settings.database",
  "system-update": "settings.systemUpdate",
  feedback: "settings.feedback",
  sponsor: "settings.sponsor",
};

const SETTINGS_ITEM_DESCRIPTION_KEYS: Record<string, string> = {
  server: "settings.item.server.desc",
  ledgers: "settings.item.ledgers.desc",
  users: "settings.item.users.desc",
  accounts: "settings.item.accounts.desc",
  institutions: "settings.item.institutions.desc",
  counterparties: "settings.item.counterparties.desc",
  "family-members": "settings.item.family-members.desc",
  categories: "settings.item.categories.desc",
  tags: "settings.item.tags.desc",
  email: "settings.item.email.desc",
  "password-recovery": "settings.item.password-recovery.desc",
  ai: "settings.item.ai.desc",
  api: "settings.item.api.desc",
  "fund-api": "settings.item.fund-api.desc",
  display: "settings.item.display.desc",
  "color-scheme": "settings.item.color-scheme.desc",
  database: "settings.item.database.desc",
  "system-update": "settings.item.system-update.desc",
  feedback: "settings.item.feedback.desc",
  sponsor: "settings.item.sponsor.desc",
};

function localize(t: TranslateFn, key: string | undefined, fallback: string): string {
  return key ? t(key) : fallback;
}

export function localizeSettingsItem(t: TranslateFn, item: SettingsCatalogItem): SettingsCatalogItem {
  return {
    ...item,
    label: localize(t, SETTINGS_ITEM_LABEL_KEYS[item.id], item.label),
    description: localize(t, SETTINGS_ITEM_DESCRIPTION_KEYS[item.id], item.description),
  };
}

export function localizeSettingsGroup(t: TranslateFn, group: SettingsCatalogGroup): SettingsCatalogGroup {
  return {
    ...group,
    label: localize(t, SETTINGS_GROUP_LABEL_KEYS[group.id], group.label),
    description: localize(t, SETTINGS_GROUP_DESCRIPTION_KEYS[group.id], group.description),
    items: group.items.map((item) => localizeSettingsItem(t, item)),
  };
}

export function localizeSettingsCatalog(t: TranslateFn, surface: SettingsSurface): SettingsCatalog {
  const catalog = getSettingsCatalogForSurface(surface);
  return {
    ...catalog,
    title: localize(t, SETTINGS_TITLE_KEY, catalog.title),
    groups: catalog.groups.map((group) => localizeSettingsGroup(t, group)),
  };
}
