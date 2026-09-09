import type { SmartSelectOption } from "@/components/SmartSelect";
import { kindLabel } from "@/lib/account-kinds";
import { FIXED_ASSET_EXPENSE_CATEGORY_NAME, isFixedAssetAccountLike } from "@/lib/fixed-asset";

export type AccountDisplaySource = {
  id: string;
  name: string;
  kind: string;
  numberMasked?: string | null;
  groupId?: string | null;
  investProductType?: string | null;
  Institution?: { name: string | null; shortName?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
  /**
   * Linked counterparty of a loan/settlement account. Used to qualify
   * list/table labels when the account name does not already contain the
   * counterparty name; dropdown selectors keep the raw name.
   */
  Counterparty?: { name?: string | null; shortName?: string | null } | null;
};

export type CreditCardLabelMode = "short_last4" | "full_name";

/**
 * Selectable pieces of a non-sidebar account display label. The stored order is
 * the render order: the user builds the label by clicking fields in sequence.
 */
export const ACCOUNT_LABEL_FIELD_KEYS = [
  "owner",
  "institution",
  "institutionShort",
  "name",
  "last4",
  "kind",
] as const;

export type AccountLabelField = (typeof ACCOUNT_LABEL_FIELD_KEYS)[number];

export const ACCOUNT_LABEL_SEPARATOR = "·";
export const EMPTY_ACCOUNT_LABEL_FIELDS_VALUE = "__empty";

/**
 * Default selection matches the documented non-sidebar format:
 * account name · card last four, with the institution added only when the
 * account name does not already contain it.
 */
export const DEFAULT_ACCOUNT_LABEL_FIELDS: AccountLabelField[] = ["institutionShort", "name", "last4"];

/** Full and short institution fields are two faces of the same selector slot. */
const ACCOUNT_LABEL_FIELD_CONFLICTS: Record<string, AccountLabelField[]> = {
  institution: ["institutionShort"],
  institutionShort: ["institution"],
};

export function normalizeAccountLabelFields(
  input: unknown,
  fallback: AccountLabelField[] = DEFAULT_ACCOUNT_LABEL_FIELDS,
): AccountLabelField[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? // Field keys contain digits (`last4`), so split on separators only.
        // Splitting on "everything that is not a letter" silently drops `last4`.
        input.split(/[\s,;]+/)
      : null;
  if (!raw) return [...fallback];

  const result: AccountLabelField[] = [];
  for (const item of raw) {
    const key = String(item ?? "").trim() as AccountLabelField;
    if (!ACCOUNT_LABEL_FIELD_KEYS.includes(key)) continue;

    // Picking the full institution while the short institution is selected replaces it in place
    // instead of moving it to the end, so swapping the two faces of the
    // institution keeps the click order the user already built.
    let replaced = false;
    for (const conflict of ACCOUNT_LABEL_FIELD_CONFLICTS[key] ?? []) {
      const index = result.indexOf(conflict);
      if (index < 0) continue;
      if (!replaced) {
        result[index] = key;
        replaced = true;
      } else {
        result.splice(index, 1);
      }
    }
    if (replaced) continue;

    if (result.includes(key)) continue;
    result.push(key);
  }
  return result;
}

export function serializeAccountLabelFields(fields: AccountLabelField[]) {
  const normalized = normalizeAccountLabelFields(fields, []);
  return normalized.length === 0 ? EMPTY_ACCOUNT_LABEL_FIELDS_VALUE : normalized.join(",");
}

export function parseAccountLabelFields(value: unknown): AccountLabelField[] {
  if (typeof value !== "string" || !value.trim()) return [...DEFAULT_ACCOUNT_LABEL_FIELDS];
  if (value.trim() === EMPTY_ACCOUNT_LABEL_FIELDS_VALUE) return [];
  return normalizeAccountLabelFields(value);
}

export type AccountLabelRenderInput = {
  accountName: string;
  institution?: { name: string | null; shortName?: string | null } | null;
  numberMasked?: string | null;
  ownerName?: string | null;
  /**
   * Already-resolved account-kind text. `renderAccountLabel` stays free of i18n
   * wiring, so callers pass `kindLabel(kind, t)` when they have a translator.
   */
  kindLabelText?: string | null;
  fields?: AccountLabelField[] | null;
};

/**
 * Renders an account label from the configured field list. Repeated content is
 * merged: the institution is dropped when the account name already contains it,
 * the last four digits are dropped when the account name already shows them,
 * and identical fragments never repeat.
 */
export function renderAccountLabel(input: AccountLabelRenderInput) {
  const accountName = input.accountName.trim();
  const institutionShort = input.institution?.shortName?.trim() ?? "";
  const institutionFull = input.institution?.name?.trim() ?? "";
  const ownerName = input.ownerName?.trim() ?? "";
  const last4Raw = (input.numberMasked ?? "").trim();
  const last4 = last4Raw && accountName.includes(last4Raw) ? "" : last4Raw;
  const institutionSuppressed = accountNameContainsInstitution(accountName, input.institution);
  const fields = normalizeAccountLabelFields(input.fields);

  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (text: string) => {
    const value = text.trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    parts.push(value);
  };

  for (const field of fields) {
    if (field === "owner") {
      push(ownerName);
    } else if (field === "institution") {
      push(institutionSuppressed ? "" : institutionFull || institutionShort);
    } else if (field === "institutionShort") {
      push(institutionSuppressed ? "" : institutionShort || institutionFull);
    } else if (field === "name") {
      push(accountName);
    } else if (field === "last4") {
      push(last4);
    } else if (field === "kind") {
      push(input.kindLabelText ?? "");
    }
  }

  if (parts.length > 0) return parts.join(ACCOUNT_LABEL_SEPARATOR);
  return accountName || institutionShort || institutionFull || last4Raw || ownerName;
}

export const DEFAULT_CREDIT_CARD_LABEL_TEMPLATE = "{机构简称}·{信用卡后4位}";
export const FULL_NAME_CREDIT_CARD_LABEL_TEMPLATE = "{机构名称}·{信用卡名称}";
export const SIDEBAR_CREDIT_CARD_LABEL_TEMPLATE = "{机构简称}·{信用卡名称}·{信用卡后4位}";

export type AccountDisplayOption = {
  id: string;
  name: string;
  kind: string;
  label: string;
  /**
   * Label for data lists and table cells. It follows the configured display
   * fields exactly, so it includes the owner and the account kind when the user
   * selected them. Dropdowns keep using `selectorLabel`, which omits them
   * because the owner is already rendered as a group header and the account
   * kind as a sub-label.
   */
  listLabel: string;
  selectorLabel: string;
  selectorCoreLabel: string;
  groupId: string;
  groupName: string;
  institutionName: string;
  investProductType: string | null;
  subLabel: string;
  fullLabel: string;
  hoverTitle: string;
  /**
   * Hover title for table cells that render `listLabel`. It follows the
   * "hover shows what the cell does not show" rule: only the fields hidden by
   * the configured label (owner / account kind) are appended, and the full
   * label is used only when every configured field is already visible.
   */
  tableHoverTitle: string;
};

export type AccountTableDisplaySource = {
  name?: string | null;
  /**
   * Configured list/table label produced by `buildAccountDisplayOption`. It is
   * preferred over `selectorLabel`/`label` because those may be the
   * dropdown-oriented labels, which intentionally drop the owner and the
   * account kind.
   */
  listLabel?: string | null;
  label?: string | null;
  selectorLabel?: string | null;
  fullLabel?: string | null;
  hoverTitle?: string | null;
  tableHoverTitle?: string | null;
  title?: string | null;
  numberMasked?: string | null;
  Institution?: { name?: string | null; shortName?: string | null } | null;
};

function firstTrimmedText(parts: Array<string | null | undefined>) {
  for (const part of parts) {
    const text = part?.trim();
    if (text) return text;
  }
  return "";
}

function joinAccountSubLabel(parts: Array<string | null | undefined>) {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const text = part?.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result.join(" · ");
}

export function formatAccountHoverTitle(input: {
  label: string;
  groupName?: string | null;
  subLabel?: string | null;
}) {
  return joinAccountSubLabel([
    input.groupName?.trim() || "未设置所有人",
    input.label,
    input.subLabel,
  ]);
}

function accountUsesOwnerInDisplay(account: { kind?: string | null }) {
  return account.kind !== "loan";
}

function accountNameContainsInstitution(accountName: string, institution?: { name: string | null; shortName?: string | null } | null) {
  const account = accountName.trim();
  const institutionNames = [
    institution?.shortName?.trim(),
    institution?.name?.trim(),
  ].filter((name): name is string => Boolean(name));
  return institutionNames.some((name) => account === name || account.includes(name));
}

export function formatAccountDisplayName(accountName: string, institutionName?: string | null) {
  const account = accountName.trim();
  const institution = institutionName?.trim() ?? "";
  if (!institution) return account;
  if (!account || account === institution || account.includes(institution)) return account;
  return `${institution}·${account}`;
}

/**
 * Qualifies a loan/settlement account name with its linked counterparty name
 * when the account name does not already contain it, e.g. an account named
 * "current-account" with counterparty "Li Si" renders as "Li Si·current-account".
 * The containment check is case-insensitive and covers both the short and the
 * full counterparty names. Returns the trimmed account name unchanged when
 * there is no counterparty or the name already contains one of its names.
 */
export function counterpartyQualifiedAccountName(
  accountName: string,
  counterparty?: { name?: string | null; shortName?: string | null } | null,
): string {
  const name = accountName.trim();
  if (!name) return name;
  const counterpartyShort = counterparty?.shortName?.trim() || "";
  const counterpartyFull = counterparty?.name?.trim() || "";
  const counterpartyName = counterpartyShort || counterpartyFull;
  if (!counterpartyName) return name;
  const lowerName = name.toLocaleLowerCase();
  const contained = [counterpartyShort, counterpartyFull]
    .filter(Boolean)
    .some((candidate) => {
      const lowerCandidate = candidate.toLocaleLowerCase();
      return lowerCandidate.length > 0 && (lowerName === lowerCandidate || lowerName.includes(lowerCandidate));
    });
  if (contained) return name;
  return `${counterpartyName}${ACCOUNT_LABEL_SEPARATOR}${name}`;
}

export function formatDisplayInstitutionName(
  institution?: { name: string | null; shortName?: string | null } | null,
  preferShort = true,
) {
  const shortName = institution?.shortName?.trim() ?? "";
  const fullName = institution?.name?.trim() ?? "";
  if (preferShort && shortName) return shortName;
  return fullName || shortName;
}

export function formatAccountSelectorLabel(input: {
  accountName: string;
  institution?: { name: string | null; shortName?: string | null } | null;
  numberMasked?: string | null;
  fields?: AccountLabelField[] | null;
}) {
  // The default field list reproduces the historical selector label exactly, so
  // callers that do not pass a configuration keep their current output.
  return renderAccountLabel({
    accountName: input.accountName,
    institution: input.institution,
    numberMasked: input.numberMasked,
    fields: input.fields,
  });
}

export function formatAccountSelectorCoreLabel(input: {
  accountName: string;
  numberMasked?: string | null;
}) {
  const accountName = input.accountName.trim();
  const last4 = (input.numberMasked ?? "").trim();
  const parts = [accountName];
  if (last4 && !accountName.includes(last4)) parts.push(last4);
  return parts.filter(Boolean).join("·").trim() || accountName;
}

export function formatAccountTableLabel(
  account: AccountTableDisplaySource,
  fallback = "",
  fields?: AccountLabelField[] | null,
) {
  // `listLabel` is the configured label and wins when present. `selectorLabel`
  // is the dropdown label: it follows the configured institution/name/last-four
  // order but never contains the owner or the account kind, so preferring it
  // here silently dropped those two fields from every table.
  const provided = firstTrimmedText([account.listLabel, account.selectorLabel, account.label]);
  if (provided) return provided;
  const accountName = account.name?.trim();
  if (accountName) {
    return formatAccountSelectorLabel({
      accountName,
      institution: account.Institution
        ? {
            name: account.Institution.name ?? null,
            shortName: account.Institution.shortName ?? null,
          }
        : null,
      numberMasked: account.numberMasked,
      fields,
    });
  }
  return fallback.trim();
}

export function formatAccountTableTitle(
  account: AccountTableDisplaySource,
  fallback = "",
  fields?: AccountLabelField[] | null,
) {
  const visibleLabel = formatAccountTableLabel(account, fallback, fields);
  return firstTrimmedText([account.tableHoverTitle, account.hoverTitle, account.title, account.fullLabel, visibleLabel]);
}

export function formatOwnerQualifiedAccountLabel(input: {
  accountName: string;
  kind?: string | null;
  institution?: { name: string | null; shortName?: string | null } | null;
  numberMasked?: string | null;
  ownerName?: string | null;
}) {
  const ownerName = input.ownerName?.trim() ?? "";
  const accountLabel = formatAccountSelectorLabel({
    accountName: input.accountName,
    institution: input.institution,
    numberMasked: input.numberMasked,
  });
  const accountType = input.kind ? kindLabel(input.kind) : "";
  return [ownerName, accountLabel, accountType].filter(Boolean).join("·") || accountLabel;
}

export function creditCardLabelTemplateFromMode(mode: CreditCardLabelMode = "short_last4") {
  return mode === "full_name" ? FULL_NAME_CREDIT_CARD_LABEL_TEMPLATE : DEFAULT_CREDIT_CARD_LABEL_TEMPLATE;
}

export function normalizeCreditCardLabelTemplate(
  input: unknown,
  fallbackMode: CreditCardLabelMode = "short_last4",
) {
  const value = String(input ?? "").trim();
  if (!value) return creditCardLabelTemplateFromMode(fallbackMode);
  return value.slice(0, 120);
}

export function formatCreditCardDisplayName(input: {
  accountName: string;
  institution?: { name: string | null; shortName?: string | null } | null;
  numberMasked?: string | null;
  ownerName?: string | null;
  template?: string | null;
  mode?: CreditCardLabelMode;
  /** @deprecated Duplicate last-four suppression is now always on for credit cards. */
  suppressDuplicateLast4?: boolean;
}) {
  const accountName = input.accountName.trim();
  const shortInstitutionNameRaw = input.institution?.shortName?.trim() ?? "";
  const fullInstitutionName = input.institution?.name?.trim() ?? "";
  const shortInstitutionName = shortInstitutionNameRaw || fullInstitutionName;
  const institutionName = fullInstitutionName || shortInstitutionNameRaw;
  const ownerName = input.ownerName?.trim() ?? "";
  const last4Raw = (input.numberMasked ?? "").trim();
  const last4 = last4Raw && accountName.includes(last4Raw) ? "" : last4Raw;
  const template = normalizeCreditCardLabelTemplate(input.template, input.mode);

  const rendered = template
    .replaceAll("{机构简称}", shortInstitutionName)
    .replaceAll("{机构全称}", institutionName)
    .replaceAll("{机构名称}", institutionName)
    .replaceAll("{\u6240\u6709\u4eba}", ownerName)
    .replaceAll("{信用卡名称}", accountName)
    .replaceAll("{账户名称}", accountName)
    .replaceAll("{信用卡后4位}", last4)
    .replaceAll("{后4位}", last4)
    .replace(/[·]{2,}/g, "·")
    .replace(/(^[·\s]+|[·\s]+$)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (rendered) return rendered;

  if (input.mode === "short_last4") {
    if (shortInstitutionName && last4) return `${shortInstitutionName}·${last4}`;
    return accountName || shortInstitutionName || institutionName;
  }

  return formatAccountDisplayName(accountName, institutionName);
}

export function buildAccountDisplayOption(
  account: AccountDisplaySource,
  creditCardLabelTemplateOrMode: string | CreditCardLabelMode = DEFAULT_CREDIT_CARD_LABEL_TEMPLATE,
  options?: { suppressDuplicateCreditCardLast4?: boolean; fields?: AccountLabelField[] | null },
): AccountDisplayOption {
  // `fields` is the global "account display format" setting. Sidebar callers do
  // not pass it and keep the sidebar's own shape; every other list passes the
  // configured fields so all of them render identically.
  const labelFields = options?.fields ?? null;
  const isFixedAsset = isFixedAssetAccountLike(account);
  const institutionName = isFixedAsset ? "" : formatDisplayInstitutionName(account.Institution, true);
  const showOwner = accountUsesOwnerInDisplay(account);
  const groupId = showOwner ? account.groupId ?? account.AccountGroup?.id ?? "" : "";
  const groupName = showOwner ? account.AccountGroup?.name?.trim() ?? "" : "";
  // `creditCardLabelTemplateOrMode` is kept for call-site compatibility only.
  // The rendered label is now driven by `options.fields` (the account display
  // format setting), so the credit-card template string is no longer consumed
  // here; see `formatCreditCardDisplayName` for the retained template renderer.
  void creditCardLabelTemplateOrMode;

  // Insurance policies and fixed assets keep their product-name-only shape; the
  // institution/card-last-four expansion does not apply to them.
  // Loan/settlement accounts linked to a counterparty get the counterparty name
  // prefixed in list/table labels when the account name does not already
  // contain it. Dropdown selectors keep the raw name because the counterparty
  // is already rendered as a group header there.
  const accountDisplayName =
    (account.kind === "loan" || account.kind === "settlement")
      ? counterpartyQualifiedAccountName(account.name, account.Counterparty)
      : account.name.trim();
  const label =
    account.kind === "insurance" || isFixedAsset
      ? account.name.trim()
      : labelFields
        ? renderAccountLabel({
            accountName: accountDisplayName,
            institution: isFixedAsset ? null : account.Institution,
            numberMasked: account.numberMasked,
            ownerName: groupName,
            kindLabelText: kindLabel(account.kind),
            fields: labelFields,
          })
        : account.kind === "bank_credit"
          ? formatAccountSelectorLabel({
              accountName: account.name,
              institution: account.Institution,
              numberMasked: account.numberMasked,
            })
          : formatAccountDisplayName(accountDisplayName, institutionName);

  const selectorLabel = formatAccountSelectorLabel({
    accountName: account.name,
    institution: isFixedAsset ? null : account.Institution,
    numberMasked: account.numberMasked,
    fields: labelFields,
  });
  const selectorCoreLabel = formatAccountSelectorCoreLabel({
    accountName: account.name,
    numberMasked: account.numberMasked,
  });
  const ownerQualifiedLabel =
    account.kind === "bank_credit"
      ? label
      : isFixedAsset
        ? joinAccountSubLabel([groupName, account.name, FIXED_ASSET_EXPENSE_CATEGORY_NAME])
        : labelFields
          ? joinAccountSubLabel([
              // Owner and kind are already part of the configured label when
              // selected, so appending them again would repeat the text.
              labelFields.includes("owner") ? "" : groupName,
              label,
              labelFields.includes("kind") ? "" : kindLabel(account.kind),
            ])
          : formatOwnerQualifiedAccountLabel({
              accountName: accountDisplayName,
              kind: account.kind,
              institution: account.Institution,
              numberMasked: account.numberMasked,
              ownerName: groupName,
            });

  const subLabel = isFixedAsset ? FIXED_ASSET_EXPENSE_CATEGORY_NAME : kindLabel(account.kind);
  const hoverTitle = formatAccountHoverTitle({
    groupName,
    label: selectorLabel || label,
    subLabel,
  });
  // Table hover: show only what the configured label does not already show
  // (owner first, then the account kind). Loan/settlement accounts have no
  // AccountGroup owner — their counterparty is already merged into the
  // rendered account name. When both fields are already visible, fall back to
  // the full label so a truncated cell still reveals its whole text.
  const tableLabelFields = labelFields ?? DEFAULT_ACCOUNT_LABEL_FIELDS;
  const tableHoverParts: string[] = [];
  if (!tableLabelFields.includes("owner") && showOwner && groupName) {
    tableHoverParts.push(groupName);
  }
  if (!tableLabelFields.includes("kind") && subLabel) {
    tableHoverParts.push(subLabel);
  }
  const tableHoverTitle = tableHoverParts.length > 0
    ? joinAccountSubLabel(tableHoverParts)
    : (label || selectorLabel);

  return {
    id: account.id,
    name: account.name,
    kind: account.kind,
    label,
    // `label` already renders the configured fields, including the owner and
    // the account kind. Insurance policies and fixed assets stay name-only.
    listLabel: label,
    selectorLabel,
    selectorCoreLabel,
    groupId,
    groupName,
    institutionName,
    investProductType: account.investProductType ?? null,
    subLabel,
    fullLabel: ownerQualifiedLabel,
    hoverTitle,
    tableHoverTitle,
  };
}

export function buildGroupedAccountOptions(accounts: AccountDisplayOption[]): SmartSelectOption[] {
  const groups = new Map<string, { id: string; name: string }>();
  const grouped: AccountDisplayOption[] = [];
  const ungrouped: AccountDisplayOption[] = [];

  for (const account of accounts) {
    if (account.groupId && accountUsesOwnerInDisplay(account)) {
      groups.set(account.groupId, {
        id: account.groupId,
        name: account.groupName || "未命名所有人",
      });
      grouped.push(account);
    } else {
      ungrouped.push(account);
    }
  }

  const headers = Array.from(groups.values())
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
    .map((group) => ({ id: `group:${group.id}`, label: group.name, isHeader: true }));

  const groupedItems = grouped
    .sort((a, b) => (a.groupName + a.selectorLabel).localeCompare(b.groupName + b.selectorLabel, "zh-Hans-CN"))
    .map((account) => ({
      id: account.id,
      label: account.selectorLabel,
      subLabel: joinAccountSubLabel([account.subLabel]),
      title: account.hoverTitle,
      parentId: `group:${account.groupId}`,
    }));

  const ungroupedItems = ungrouped
    .sort((a, b) => a.selectorLabel.localeCompare(b.selectorLabel, "zh-Hans-CN"))
    .map((account) => ({
      id: account.id,
      label: account.selectorLabel,
      subLabel: joinAccountSubLabel([account.subLabel]),
      title: account.hoverTitle,
    }));

  return [...headers, ...groupedItems, ...ungroupedItems];
}

export function buildFlatAccountOptions(
  accounts: Array<Pick<AccountDisplayOption, "id" | "label" | "subLabel"> & {
    selectorLabel?: string;
    groupName?: string | null;
    institutionName?: string | null;
    hoverTitle?: string | null;
    title?: string | null;
    kind?: string | null;
    investProductType?: string | null;
    debtDirection?: string | null;
    institutionId?: string | null;
    currency?: string | null;
  }>,
): SmartSelectOption[] {
  return accounts.map((account) => ({
    id: account.id,
    label: account.selectorLabel ?? account.label,
    subLabel: joinAccountSubLabel([account.groupName, account.subLabel]),
    title: account.hoverTitle ?? account.title ?? formatAccountHoverTitle({
      groupName: accountUsesOwnerInDisplay(account) ? account.groupName : null,
      label: account.selectorLabel ?? account.label,
      subLabel: account.subLabel,
    }),
    kind: account.kind ?? null,
    investProductType: account.investProductType ?? null,
    debtDirection: account.debtDirection ?? null,
    institutionId: account.institutionId ?? null,
    currency: account.currency ?? null,
  }));
}
