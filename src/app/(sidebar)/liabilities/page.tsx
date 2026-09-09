import { AccountKind } from "@prisma/client";
import { ArrowLeftRight, Building2, CreditCard, HandCoins, Landmark } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";

import { LiabilitiesGuideClient } from "@/components/LiabilitiesGuideClient";
import { buildAccountDisplayOption, normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { formatMoney } from "@/lib/format";
import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";
import { computeAccountDisplayBalances } from "@/lib/server/account-balance";
import { createDebtTransaction } from "@/lib/server/sidebar-actions/debt-actions";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { ACCOUNT_LABEL_FIELDS_COOKIE, accountLabelFieldsFromCookieValue } from "@/lib/server/account-label-fields";
import { getServerT } from "@/lib/server/i18n";

export const dynamic = "force-dynamic";

const DEBT_KINDS: AccountKind[] = [AccountKind.bank_credit, AccountKind.settlement, AccountKind.loan];

function yuan(value: number) {
  return `¥${formatMoney(value)}`;
}

function amountClass(value: number, intent: "payable" | "receivable" | "neutral" = "neutral") {
  if (value === 0) return "text-slate-500";
  if (intent === "receivable") return "text-emerald-700";
  if (intent === "payable") return "text-rose-700";
  return value > 0 ? "text-slate-900" : "text-slate-500";
}

function directionOf(kind: AccountKind, balance: number): "payable" | "receivable" {
  if (kind === AccountKind.bank_credit) return "payable";
  return balance >= 0 ? "receivable" : "payable";
}

function kindLabel(kind: AccountKind, t: (key: string) => string) {
  if (kind === AccountKind.bank_credit) return t("account.kind.bank_credit");
  if (kind === AccountKind.settlement) return t("account.kind.settlement");
  if (kind === AccountKind.loan) return t("account.kind.loan");
  return t("liabilities.debtAccount");
}

function dayLabel(day: number | null, t: (key: string, params?: Record<string, string | number>) => string) {
  return day ? t("liabilities.day", { day }) : t("liabilities.notSet");
}

type SmartSelectOptionLike = {
  id: string;
  label: string;
  subLabel?: string;
  title?: string;
  isHeader?: boolean;
  parentId?: string;
  kind?: string | null;
  debtDirection?: string | null;
  institutionId?: string | null;
  billingDay?: number | null;
  currency?: string | null;
};

function joinSubLabel(parts: Array<string | null | undefined>) {
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

export default async function LiabilitiesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = searchParams ? await searchParams : {};
  const guideMode = params.guide === "settlements";
  const t = await getServerT();
  const cookieStore = await cookies();
  const accountLabelFields = accountLabelFieldsFromCookieValue(cookieStore.get(ACCOUNT_LABEL_FIELDS_COOKIE)?.value);
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_label_template")?.value,
    creditCardLabelMode,
  );
  const { hidFilter } = await getHouseholdScope();
  const [allAccounts, counterparties, institutions, groups] = await Promise.all([
    prisma.account.findMany({
      where: { isActive: true, isPlaceholder: { not: true }, ...hidFilter },
      include: { AccountGroup: true, Institution: true, Counterparty: true },
      orderBy: [{ kind: "asc" }, { name: "asc" }],
    }),
    prisma.counterparty.findMany({
      where: hidFilter,
      orderBy: [{ type: "asc" }, { name: "asc" }],
    }),
    prisma.institution.findMany({
      where: hidFilter,
      orderBy: [{ type: "asc" }, { name: "asc" }],
    }),
    prisma.accountGroup.findMany({
      where: hidFilter,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
  ]);
  const accounts = allAccounts.filter((account) => DEBT_KINDS.includes(account.kind));
  const accountOptions = allAccounts.map((account) => {
    const display = buildAccountDisplayOption({
      id: account.id,
      name: account.name,
      kind: account.kind,
      numberMasked: account.numberMasked,
      groupId: account.groupId,
      investProductType: account.investProductType,
      Institution: account.Institution,
      AccountGroup: account.AccountGroup,
      Counterparty: account.Counterparty,
    }, creditCardLabelTemplate, { fields: accountLabelFields });
    return {
      id: account.id,
      name: account.name,
      kind: account.kind,
      label: display.selectorLabel,
      // Table cells render `listLabel`, which follows the configured display
      // fields; `label` stays the dropdown-shaped label.
      listLabel: display.listLabel,
      title: display.hoverTitle,
      hoverTitle: display.hoverTitle,
      groupId: display.groupId,
      groupName: display.groupName,
      institutionId: account.institutionId ?? "",
      institutionType: account.Institution?.type ?? "",
      counterpartyId: account.counterpartyId ?? "",
      debtDirection: account.debtDirection ?? null,
      billingDay: account.billingDay ?? null,
      subLabel: kindLabel(account.kind, t),
      currency: account.currency ?? "CNY",
    };
  });

  function buildAccountSSOptions(filter?: (account: typeof accountOptions[number]) => boolean): SmartSelectOptionLike[] {
    const filtered = filter ? accountOptions.filter(filter) : accountOptions;
    const grouped = filtered.filter((account) => account.groupId);
    const ungrouped = filtered.filter((account) => !account.groupId);
    const excludedGroupIds = new Set(groups.filter((group) => group.name === "未指定").map((group) => group.id));
    const groupHeaders: SmartSelectOptionLike[] = groups
      .filter((group) => group.name !== "未指定")
      .filter((group) => grouped.some((account) => account.groupId === group.id))
      .map((group) => ({ id: `group:${group.id}`, label: group.name, isHeader: true }));
    const groupedItems: SmartSelectOptionLike[] = grouped
      .filter((account) => !excludedGroupIds.has(account.groupId))
      .map((account) => ({
        id: account.id,
        label: account.label,
        subLabel: joinSubLabel([account.groupName, account.subLabel]),
        title: account.hoverTitle,
        parentId: `group:${account.groupId}`,
        kind: account.kind,
        debtDirection: account.debtDirection,
        institutionId: account.institutionId || null,
        billingDay: account.billingDay,
        currency: account.currency,
      }));
    const ungroupedItems: SmartSelectOptionLike[] = ungrouped.map((account) => ({
      id: account.id,
      label: account.label,
      subLabel: joinSubLabel([account.subLabel]),
      title: account.hoverTitle,
      kind: account.kind,
      debtDirection: account.debtDirection,
      institutionId: account.institutionId || null,
      billingDay: account.billingDay,
      currency: account.currency,
    }));
    return [...groupHeaders, ...groupedItems, ...ungroupedItems];
  }

  const loanDisplayBalanceByAccountId = await computeAccountDisplayBalances(
    accounts
      .filter((account) => account.kind === AccountKind.loan || account.kind === AccountKind.settlement)
      .map((account) => ({
        id: account.id,
        kind: account.kind,
        investProductType: account.investProductType,
        billingDay: account.billingDay,
      })),
    hidFilter,
  );
  const creditIds = accounts.filter((account) => account.kind === AccountKind.bank_credit && !!account.billingDay).map((account) => account.id);
  const currentCreditCycles = creditIds.length > 0
    ? await prisma.creditCardCycle.findMany({
        where: { accountId: { in: creditIds }, isCurrentCycle: true },
        select: { accountId: true, effectiveBill: true, cumulativeRemain: true, cumulativeOverpaid: true },
      })
    : [];
  const currentCreditBalanceByAccountId = new Map(
    currentCreditCycles.map((cycle) => [
      cycle.accountId,
      creditCardDisplayBalanceFromCurrentCycle(cycle),
    ]),
  );
  const debtObjectOptions: SmartSelectOptionLike[] = [
    ...(counterparties.length > 0
      ? [
          { id: "debt-counterparty-header", label: t("liabilities.counterparties"), isHeader: true },
          ...counterparties.map((counterparty) => ({
            id: `counterparty:${counterparty.id}`,
            label: counterparty.shortName?.trim() || counterparty.name,
            subLabel: counterparty.type === "person" ? t("institution.type.person") : t("institution.type.organization"),
          })),
        ]
      : []),
    ...(institutions.some((institution) =>
        institution.type === "bank" || institution.type === "debt" || institution.type === "organization" || institution.type === "other",
      )
      ? [
          { id: "debt-institution-source-header", label: t("liabilities.fromInstitution"), isHeader: true },
          ...institutions.filter((institution) =>
            institution.type === "bank" || institution.type === "debt" || institution.type === "organization" || institution.type === "other",
          ).map((institution) => ({
            id: `institution:${institution.id}`,
            label: institution.shortName?.trim() || institution.name,
            subLabel: t(`institution.type.${institution.type || "other"}`),
          })),
        ]
      : []),
  ];
  const debtTransferAccountSSOptions = buildAccountSSOptions((account) => (
    account.kind === AccountKind.bank_debit ||
    account.kind === AccountKind.cash ||
    account.kind === AccountKind.ewallet ||
    account.kind === AccountKind.bank_credit
  ));
  const debtTransferAccountList = accountOptions
    .filter((account) => (
      account.kind === AccountKind.bank_debit ||
      account.kind === AccountKind.cash ||
      account.kind === AccountKind.ewallet ||
      account.kind === AccountKind.bank_credit
    ))
    .map((account) => ({
      id: account.id,
      label: account.label,
      subLabel: joinSubLabel([account.groupName, account.subLabel]),
      kind: account.kind,
      institutionId: account.institutionId || null,
      institutionType: account.institutionType || null,
    }));
  const debtAccountOptions = allAccounts
    .filter((account) => (account.kind === AccountKind.loan || account.kind === AccountKind.settlement) && account.isActive)
    .map((account) => {
      const display = buildAccountDisplayOption({
        id: account.id,
        name: account.name,
        kind: account.kind,
        numberMasked: account.numberMasked,
        groupId: account.groupId,
        Institution: account.Institution,
        AccountGroup: account.AccountGroup,
        Counterparty: account.Counterparty,
      }, creditCardLabelTemplate, { fields: accountLabelFields });
      return {
        id: account.id,
        label: display.label,
        subLabel: account.Counterparty?.name ? t("liabilities.counterparty") : account.Institution?.name ? t("liabilities.institutionDeal") : t("account.kind.loan"),
        institutionId: account.institutionId ?? null,
        counterpartyId: account.counterpartyId ?? null,
        institutionType: account.Institution?.type ?? account.Counterparty?.type ?? null,
        isInstitutionLoan: !!account.institutionId && account.Institution?.type === "bank",
        debtDirection: account.debtDirection ?? null,
      };
    });
  const counterpartyGuideRows = counterparties.map((counterparty) => {
    const relatedAccounts = allAccounts.filter((account) => (account.kind === AccountKind.loan || account.kind === AccountKind.settlement) && account.counterpartyId === counterparty.id);
    const totals = relatedAccounts.reduce((acc, account) => {
      const balance = loanDisplayBalanceByAccountId.get(account.id) ?? toNumber(account.balance);
      if (balance >= 0) acc.receivable += Math.abs(balance);
      else acc.payable += Math.abs(balance);
      return acc;
    }, { payable: 0, receivable: 0 });
    return {
      id: counterparty.id,
      name: counterparty.name,
      shortName: counterparty.shortName,
      type: counterparty.type,
      accountCount: relatedAccounts.length,
      payable: totals.payable,
      receivable: totals.receivable,
    };
  });
  const nestedFieldData = {
    groupId: groups.filter((group) => group.name !== "未指定").map((group) => ({ id: group.id, name: group.name })),
    institutionId: institutions.map((institution) => ({ id: institution.id, name: institution.name, type: institution.type ?? "" })),
    counterpartyId: counterparties.map((counterparty) => ({
      id: counterparty.id,
      name: counterparty.shortName?.trim() || counterparty.name,
      type: counterparty.type ?? "organization",
    })),
  };

  if (guideMode) {
    return (
      <LiabilitiesGuideClient
        counterparties={counterpartyGuideRows}
        debtAccounts={debtAccountOptions}
        debtObjectOptions={debtObjectOptions}
        cashAccounts={debtTransferAccountList}
        cashAccountSSOptions={debtTransferAccountSSOptions}
        nestedFieldData={nestedFieldData}
        defaultCashAccountId={debtTransferAccountList[0]?.id ?? ""}
        action={createDebtTransaction}
      />
    );
  }

  const rows = accounts.map((account) => {
    const balance = account.kind === AccountKind.bank_credit
      ? currentCreditBalanceByAccountId.get(account.id) ?? toNumber(account.balance)
      : loanDisplayBalanceByAccountId.get(account.id) ?? toNumber(account.balance);
    const direction = directionOf(account.kind, balance);
    const amount = Math.abs(balance);
    const display = buildAccountDisplayOption({
      id: account.id,
      name: account.name,
      kind: account.kind,
      numberMasked: account.numberMasked,
      groupId: account.groupId,
      Institution: account.Institution,
      AccountGroup: account.AccountGroup,
      Counterparty: account.Counterparty,
    }, creditCardLabelTemplate, { fields: accountLabelFields });
    const institutionName = display.institutionName || t("liabilities.noCounterparty");
    const debtPersonKey = institutionName
      ? `institution:${account.institutionId ?? institutionName}`
      : `account:${account.id}`;
    return {
      id: account.id,
      name: display.label,
      hoverTitle: display.hoverTitle,
      shortName: account.name,
      kind: account.kind,
      direction,
      balance,
      amount,
      groupName: account.AccountGroup?.name?.trim() || t("investments.noOwner"),
      institutionName,
      billingDay: account.billingDay,
      repaymentDay: account.repaymentDay,
      creditLimit: account.creditLimit == null ? 0 : toNumber(account.creditLimit),
      numberMasked: account.numberMasked,
      debtPersonKey,
    };
  });

  const payableTotal = rows.filter((row) => row.direction === "payable").reduce((sum, row) => sum + row.amount, 0);
  const receivableTotal = rows.filter((row) => row.direction === "receivable").reduce((sum, row) => sum + row.amount, 0);
  const creditTotal = rows.filter((row) => row.kind === AccountKind.bank_credit).reduce((sum, row) => sum + row.amount, 0);
  const loanTotal = rows.filter((row) => row.kind === AccountKind.loan && row.direction === "payable").reduce((sum, row) => sum + row.amount, 0);

  const institutionRows = Array.from(
    rows.reduce((map, row) => {
      const current = map.get(row.institutionName) ?? {
        key: row.debtPersonKey,
        name: row.institutionName,
        payable: 0,
        receivable: 0,
        count: 0,
      };
      current.count += 1;
      if (row.direction === "receivable") current.receivable += row.amount;
      else current.payable += row.amount;
      map.set(row.institutionName, current);
      return map;
    }, new Map<string, { key: string; name: string; payable: number; receivable: number; count: number }>()),
  ).map(([, value]) => value).sort((a, b) => (b.payable + b.receivable) - (a.payable + a.receivable));

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-slate-50">
      <header className="page-header">
        <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-2 md:px-5">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900">{t("liabilities.title")}</div>
            <div className="text-xs text-slate-500">{t("liabilities.subtitle")}</div>
          </div>
          <Link href="/settings/accounts" className="primary-button page-action-button h-8 text-xs">
            {t("liabilities.manageAccounts")}
          </Link>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 md:px-5 md:py-5">
        <section className="panel-surface overflow-hidden">
          <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-5">
            <SummaryCard label={t("liabilities.netBalance")} value={receivableTotal - payableTotal} intent={receivableTotal >= payableTotal ? "receivable" : "payable"} />
            <SummaryCard label={t("liabilities.payableBalance")} value={payableTotal} intent="payable" />
            <SummaryCard label={t("liabilities.receivableBalance")} value={receivableTotal} intent="receivable" />
            <SummaryCard label={t("account.kind.bank_credit")} value={creditTotal} intent="payable" />
            <SummaryCard label={t("account.kind.loan")} value={loanTotal} intent="payable" />
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[0.85fr_1.25fr]">
          <div className="panel-surface">
            <div className="panel-header">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Building2 className="h-4 w-4 text-blue-500" />
                {t("liabilities.counterparties")}
              </div>
              <div className="text-xs text-slate-400">{t("liabilities.objectCount", { count: institutionRows.length })}</div>
            </div>
            <div className="divide-y divide-slate-100">
              {institutionRows.length > 0 ? (
                institutionRows.map((institution) => (
                  <Link key={institution.key} href={`/?view=debt&debtPerson=${encodeURIComponent(institution.key)}`} className="block px-4 py-3 hover:bg-slate-50">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold text-slate-800">{institution.name}</div>
                        <div className="mt-1 text-xs text-slate-400">{t("invest.accountCount", { count: institution.count })}</div>
                      </div>
                      <div className="text-right text-xs tabular-nums">
                        <div className={amountClass(institution.payable, "payable")}>{t("liabilities.owed", { amount: yuan(institution.payable) })}</div>
                        <div className={amountClass(institution.receivable, "receivable")}>{t("liabilities.receivable", { amount: yuan(institution.receivable) })}</div>
                      </div>
                    </div>
                  </Link>
                ))
              ) : (
                <div className="px-4 py-10 text-center text-sm text-slate-400">{t("liabilities.noCounterparties")}</div>
              )}
            </div>
          </div>

          <div className="panel-surface">
            <div className="panel-header">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <ArrowLeftRight className="h-4 w-4 text-cyan-500" />
                {t("liabilities.balanceList")}
              </div>
              <div className="text-xs text-slate-400">{t("liabilities.clickForDetail")}</div>
            </div>
            <div className="divide-y divide-slate-100">
              {rows.length > 0 ? (
                rows.map((row) => {
                  const Icon = row.kind === AccountKind.bank_credit ? CreditCard : HandCoins;
                  const href = row.kind === AccountKind.loan
                    ? `/?view=debt&debtPerson=${encodeURIComponent(row.debtPersonKey)}`
                    : `/?accountId=${row.id}&view=bill`;
                  return (
                    <Link key={row.id} href={href} title={row.hoverTitle} className="block px-4 py-4 hover:bg-slate-50">
                      <div className="flex items-start gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                          <Icon className="h-4 w-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-semibold text-slate-800" title={row.hoverTitle}>{row.name}</div>
                          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
                            <span className="rounded bg-slate-100 px-1.5 py-0.5">{kindLabel(row.kind, t)}</span>
                            <span className="rounded bg-slate-100 px-1.5 py-0.5">{row.groupName}</span>
                            <span
                              className={`rounded border px-1.5 py-0.5 ${
                                row.direction === "receivable"
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : "border-rose-200 bg-rose-50 text-rose-700"
                              }`}
                            >
                              {row.direction === "receivable" ? t("liabilities.lent") : t("liabilities.borrowed")}
                            </span>
                            <span>{t("liabilities.billingDayLabel", { day: dayLabel(row.billingDay, t) })}</span>
                            <span>{t("liabilities.repaymentDayLabel", { day: dayLabel(row.repaymentDay, t) })}</span>
                            {row.numberMasked ? <span>{t("liabilities.lastFour", { value: row.numberMasked })}</span> : null}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-xs text-slate-400">{row.direction === "receivable" ? t("liabilities.receivableBalance") : t("liabilities.payableBalance")}</div>
                          <div className={`mt-1 text-sm font-semibold tabular-nums ${amountClass(row.amount, row.direction)}`}>
                            {yuan(row.amount)}
                          </div>
                          {row.creditLimit > 0 ? <div className="mt-1 text-[11px] text-slate-400">{t("liabilities.creditLimit", { amount: yuan(row.creditLimit) })}</div> : null}
                        </div>
                      </div>
                    </Link>
                  );
                })
              ) : (
                <div className="px-4 py-10 text-center text-sm text-slate-400">
                  {t("liabilities.noAccounts")}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  intent,
}: {
  label: string;
  value: number;
  intent: "payable" | "receivable";
}) {
  const Icon = intent === "receivable" ? Landmark : CreditCard;
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/80 px-4 py-3">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className={`mt-2 text-base font-semibold tabular-nums ${amountClass(value, intent)}`}>{yuan(value)}</div>
    </div>
  );
}
