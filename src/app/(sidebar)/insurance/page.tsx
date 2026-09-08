import { cookies } from "next/headers";
import Link from "next/link";
import { Shield, Building2, UserRound, ArrowDownLeft, ArrowUpRight } from "lucide-react";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { buildAccountDisplayOption, normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { formatMoney } from "@/lib/format";
import { toNumber } from "@/lib/date-utils";
import { amountToneClass as amountClass } from "@/lib/client/colors";
import { getInsuranceDisplayTypeLabel, getInsuranceMetricLabel, getInsuranceMetricMode, type InsuranceMetricMode } from "@/lib/insurance/display";
import { getInsuranceAction, insuranceCashValueDelta, isInsuranceRefund } from "@/lib/insurance/transaction";
import { ACCOUNT_LABEL_FIELDS_COOKIE, accountLabelFieldsFromCookieValue } from "@/lib/server/account-label-fields";
import { getServerT } from "@/lib/server/i18n";
import { TopEntryLauncher } from "@/components/TopEntryLauncher";

export const dynamic = "force-dynamic";

type InsuranceRow = {
  id: string;
  name: string;
  policyNo: string | null;
  startDateLabel: string | null;
  typeLabel: string;
  displayTypeLabel: string;
  metricMode: InsuranceMetricMode;
  cashValueLabel: string;
  cashValue: number | null;
  coverageAmount: number | null;
  totalPremium: number;
  statusLabel: string;
  frequencyLabel: string;
  paymentTermYears: number | null;
  coverageTermYears: number | null;
  institutionName: string;
  ownerName: string;
  policyholderName: string;
  insuredPersonName: string;
  accountId: string;
  accountLabel: string;
  accountHoverTitle: string;
  buyCount: number;
  redeemCount: number;
  entries: Array<{
    id: string;
    date: Date;
    insuranceAction: string | null;
    insuranceProductName: string | null;
    fundSubtype: string | null;
    accountName: string | null;
    toAccountName: string | null;
    note: string | null;
    amount: unknown;
  }>;
};

function metricClass(mode: InsuranceMetricMode, value: number) {
  return mode === "coverage" ? "text-slate-700" : amountClass(value);
}

function productTypeLabel(type: string | null, t: (key: string) => string) {
  switch (type) {
    case "savings": return t("insuranceProduct.type.savings");
    case "dividend": return t("insuranceProduct.type.dividend");
    case "annuity": return t("insuranceProduct.type.annuity");
    case "universal": return t("insuranceProduct.type.universal");
    case "investment_linked": return t("insuranceProduct.type.investment_linked");
    case "critical_illness": return t("insuranceProduct.type.critical_illness");
    case "medical": return t("insuranceProduct.type.medical");
    case "accident": return t("insuranceProduct.type.accident");
    case "term_life": return t("insuranceProduct.type.term_life");
    case "whole_life": return t("insuranceProduct.type.whole_life");
    default: return t("insuranceProduct.type.default");
  }
}

export default async function InsurancePage() {
  const t = await getServerT();
  const { hidFilter } = await getHouseholdScope();
  const cookieStore = await cookies();
  const accountLabelFields = accountLabelFieldsFromCookieValue(cookieStore.get(ACCOUNT_LABEL_FIELDS_COOKIE)?.value);
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_label_template")?.value,
    creditCardLabelMode,
  );

  const products = await prisma.insuranceProduct.findMany({
    where: hidFilter,
    include: {
      Account: { include: { AccountGroup: true, Institution: true } },
      Institution: true,
      OwnerGroup: true,
      PolicyholderPerson: true,
      InsuredUser: true,
      InsuredPerson: true,
    },
    orderBy: [{ Institution: { name: "asc" } }, { name: "asc" }],
  });

  const productIds = products.map((item) => item.id);
  const insuranceAccountIds = Array.from(new Set(products.map((item) => item.accountId)));
  const entries = insuranceAccountIds.length > 0
    ? await prisma.txRecord.findMany({
        where: {
          ...hidFilter,
          deletedAt: null,
          type: "investment",
          source: "insurance",
          OR: [
            { accountId: { in: insuranceAccountIds } },
            { toAccountId: { in: insuranceAccountIds } },
            ...(productIds.length > 0 ? [{ insuranceProductId: { in: productIds } }] : []),
          ],
        },
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      })
    : [];
  const accountById = new Map(products.map((product) => [product.Account.id, product.Account]));
  const lapsedStatusLabel = t("insuranceShell.status.lapsed");

  const rows: InsuranceRow[] = products.map((product) => {
    const account = accountById.get(product.accountId) ?? product.Account;
    const display = buildAccountDisplayOption({
      id: account.id,
      name: account.name,
      kind: account.kind,
      numberMasked: account.numberMasked,
      groupId: account.groupId,
      investProductType: account.investProductType,
      Institution: account.Institution,
      AccountGroup: account.AccountGroup,
    }, creditCardLabelTemplate, { fields: accountLabelFields });

    const relatedEntries = entries.filter((entry) => entry.insuranceProductId === product.id);
    const balance = relatedEntries.reduce((sum, entry) => sum + insuranceCashValueDelta(entry), 0);
    const metricMode = getInsuranceMetricMode(
      product.productType ?? null,
      product.accountingType ?? null,
      product.cashValueEnabled ?? null,
    );
    const coverageAmount = Number(product.coverageAmount ?? 0);
    const totalPremium = relatedEntries
      .filter((entry) => !isInsuranceRefund(entry))
      .reduce((sum, entry) => sum + Math.abs(toNumber(entry.amount)), 0);
    const premiumCount = relatedEntries.filter((entry) => getInsuranceAction(entry) === "premium").length;
    const refundCount = relatedEntries.filter((entry) => getInsuranceAction(entry) === "refund").length;

    return {
      id: product.id,
      name: product.name,
      policyNo: product.policyNo ?? null,
      startDateLabel: product.startDate ? product.startDate.toISOString().slice(0, 10) : null,
      typeLabel: productTypeLabel(product.productType ?? null, t),
      displayTypeLabel: getInsuranceDisplayTypeLabel(metricMode),
      metricMode,
      cashValueLabel: getInsuranceMetricLabel(metricMode),
      cashValue: metricMode === "coverage" ? null : balance,
      coverageAmount,
      totalPremium,
      statusLabel:
        product.status === "matured"
          ? t("insuranceShell.status.matured")
          : product.status === "surrendered"
            ? t("insuranceShell.status.surrendered")
            : product.status === "lapsed"
              ? t("insuranceShell.status.lapsed")
              : t("insuranceShell.status.active"),
      frequencyLabel:
        product.premiumFrequencyMonths === 1
          ? t("insuranceShell.frequency.monthly")
          : product.premiumFrequencyMonths === 3
            ? t("insuranceShell.frequency.quarterly")
            : product.premiumFrequencyMonths === 6
              ? t("insuranceShell.frequency.semiannual")
              : product.premiumFrequencyMonths === 12
                ? t("insuranceShell.frequency.annual")
                : product.premiumFrequencyMonths === 999999
                  ? t("insuranceShell.frequency.single")
                  : "-",
      paymentTermYears: product.paymentTermYears ? Number(product.paymentTermYears) : null,
      coverageTermYears: product.coverageTermYears ? Number(product.coverageTermYears) : null,
      institutionName: product.Institution?.name?.trim() || account.Institution?.name?.trim() || t("insurance.noInstitution"),
      ownerName: product.OwnerGroup?.name?.trim() || account.AccountGroup?.name?.trim() || t("insurance.noOwner"),
      policyholderName: product.PolicyholderPerson?.name?.trim() || product.OwnerGroup?.name?.trim() || "",
      insuredPersonName: product.InsuredPerson?.name?.trim() || product.InsuredUser?.name?.trim() || "",
      accountId: account.id,
      accountLabel: display.label,
      accountHoverTitle: display.hoverTitle,
      buyCount: premiumCount,
      redeemCount: refundCount,
      entries: relatedEntries,
    };
  }).filter((row) => row.entries.length > 0 || row.statusLabel !== lapsedStatusLabel || row.coverageAmount !== 0 || row.cashValue !== 0);

  const grouped = Array.from(
    rows.reduce((map, row) => {
      const key = `${row.institutionName}__${row.ownerName}`;
      const current = map.get(key) ?? {
        key,
        institutionName: row.institutionName,
        ownerName: row.ownerName,
        rows: [] as InsuranceRow[],
      };
      current.rows.push(row);
      map.set(key, current);
      return map;
    }, new Map<string, { key: string; institutionName: string; ownerName: string; rows: InsuranceRow[] }>()),
  )
    .map(([, value]) => value)
    .sort((a, b) => {
      const inst = a.institutionName.localeCompare(b.institutionName, "zh-Hans-CN");
      if (inst !== 0) return inst;
      return a.ownerName.localeCompare(b.ownerName, "zh-Hans-CN");
    });

  const totalBalance = rows.reduce((sum, row) => sum + (row.cashValue ?? 0), 0);
  const totalBuy = rows.reduce((sum, row) => sum + row.buyCount, 0);
  const totalRedeem = rows.reduce((sum, row) => sum + row.redeemCount, 0);

  return (
    <div className="flex-1 min-h-0 overflow-auto bg-slate-50">
      <header className="page-header">
        <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 px-4 py-2 md:px-5">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900">{t("insurance.page.title")}</div>
            <div className="text-xs text-slate-500">{t("insurance.page.subtitle")}</div>
          </div>
          <TopEntryLauncher defaultAction="insurance" />
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-4 md:px-5 md:py-5">
        <section className="panel-surface overflow-hidden">
          <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
            <SummaryCard label={t("insurance.summary.products")} value={String(rows.length)} />
            <SummaryCard label={t("insurance.summary.amountPolicies")} value={formatMoney(totalBalance)} valueClass={amountClass(totalBalance)} />
            <SummaryCard label={t("insurance.summary.renewals")} value={String(totalBuy)} />
            <SummaryCard label={t("insurance.summary.refunds")} value={String(totalRedeem)} />
          </div>
        </section>

        <section className="grid grid-cols-1 gap-4 xl:grid-cols-[0.95fr_1.25fr]">
          <div className="panel-surface overflow-hidden">
            <div className="panel-header">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Building2 className="h-4 w-4 text-blue-500" />
                {t("insurance.groupTitle")}
              </div>
              <div className="text-xs text-slate-400">{t("insurance.groupSubtitle")}</div>
            </div>
            <div className="divide-y divide-slate-100">
              {grouped.length > 0 ? grouped.map((group) => (
                <div key={group.key} className="px-4 py-3">
                  <div className="text-sm font-semibold text-slate-800">{group.institutionName}</div>
                  <div className="mt-2 space-y-2">
                    <div className="flex items-center gap-2 pl-3 text-xs text-slate-500">
                      <UserRound className="h-3.5 w-3.5" />
                      {group.ownerName}
                    </div>
                    <div className="space-y-1 pl-6">
                      {group.rows.map((row) => (
                        <Link
                          key={row.id}
                          href={`/?accountId=${row.accountId}&view=insurance`}
                          title={row.accountHoverTitle}
                          className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                        >
                          <span className="min-w-0 flex-1 truncate" title={row.accountHoverTitle}>{row.accountLabel || row.name}</span>
                          <span className={`tabular-nums font-medium ${metricClass(row.metricMode, row.cashValue ?? 0)}`}>
                            {row.cashValue != null ? formatMoney(row.cashValue) : "-"}
                          </span>
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              )) : (
                <div className="px-4 py-10 text-center text-sm text-slate-400">{t("insurance.emptyProducts")}</div>
              )}
            </div>
          </div>

          <div className="panel-surface overflow-hidden">
            <div className="panel-header">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <Shield className="h-4 w-4 text-cyan-500" />
                {t("insurance.listTitle")}
              </div>
              <div className="text-xs text-slate-400">{t("insurance.listSubtitle")}</div>
            </div>
            <div className="divide-y divide-slate-100">
              {rows.length > 0 ? rows.map((row) => (
                <div key={row.id} className="px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-slate-800">
                        {row.name}
                        <span className="ml-2 text-xs font-normal text-slate-500">{row.displayTypeLabel} · {row.typeLabel}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
                        {row.policyNo ? <span className="rounded bg-slate-100 px-1.5 py-0.5">{t("insurance.policyNo", { policyNo: row.policyNo })}</span> : null}
                        {row.startDateLabel ? <span className="rounded bg-slate-100 px-1.5 py-0.5">{t("insurance.startDate", { date: row.startDateLabel })}</span> : null}
                        <span className="rounded bg-slate-100 px-1.5 py-0.5">{row.institutionName}</span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5">{t("insurance.policyholder", { name: row.policyholderName || row.ownerName })}</span>
                        {row.insuredPersonName ? <span className="rounded bg-slate-100 px-1.5 py-0.5">{t("insurance.insured", { name: row.insuredPersonName })}</span> : null}
                        <span className="rounded bg-slate-100 px-1.5 py-0.5">{row.statusLabel}</span>
                        <span>{t("insurance.frequency", { label: row.frequencyLabel })}</span>
                        <span>{t("insurance.premium", { amount: formatMoney(row.totalPremium) })}</span>
                        <span>{t("insurance.account", { label: row.accountLabel })}</span>
                        <span>{t("insurance.renewalCount", { count: row.buyCount })}</span>
                        <span>{t("insurance.refundCount", { count: row.redeemCount })}</span>
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-sm font-semibold tabular-nums">
                      <div className={metricClass(row.metricMode, row.cashValue ?? 0)}>
                        {row.cashValue != null ? formatMoney(row.cashValue) : "-"}
                      </div>
                      <div className="text-[10px] font-normal text-slate-400">{row.cashValueLabel}</div>
                      <div className="mt-1 text-slate-700">
                        {row.coverageAmount != null ? formatMoney(row.coverageAmount) : "-"}
                      </div>
                      <div className="text-[10px] font-normal text-slate-400">{t("insurance.coverage")}</div>
                    </div>
                  </div>

                  <div className="mt-3 overflow-auto">
                    <table className="w-full table-fixed border-separate border-spacing-0">
                      <thead>
                        <tr>
                          <th className="border-b border-slate-200 px-2 py-2 text-left text-xs font-semibold text-slate-600">{t("insurance.col.date")}</th>
                          <th className="border-b border-slate-200 px-2 py-2 text-left text-xs font-semibold text-slate-600">{t("insurance.col.action")}</th>
                          <th className="border-b border-slate-200 px-2 py-2 text-left text-xs font-semibold text-slate-600">{t("insurance.col.cashAccount")}</th>
                          <th className="border-b border-slate-200 px-2 py-2 text-left text-xs font-semibold text-slate-600">{t("insurance.col.note")}</th>
                          <th className="border-b border-slate-200 px-2 py-2 text-right text-xs font-semibold text-slate-600">{t("insurance.col.amount")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {row.entries.length > 0 ? row.entries.map((entry) => {
                          const action = getInsuranceAction(entry);
                          const isRefund = action === "refund";
                          const cashLabel =
                            isRefund
                              ? (entry.toAccountName ?? "-")
                              : (entry.accountName ?? "-");
                          const amount = isRefund
                            ? Math.abs(toNumber(entry.amount))
                            : toNumber(entry.amount);
                          const displayAmount = isRefund ? amount : -Math.abs(amount);
                          return (
                            <tr key={entry.id} className="hover:bg-slate-50">
                              <td className="border-b border-slate-100 px-2 py-2 text-xs text-slate-700 tabular-nums">{entry.date.toISOString().slice(0, 10)}</td>
                              <td className="border-b border-slate-100 px-2 py-2 text-xs text-slate-700">
                                <span className="inline-flex items-center gap-1">
                                  {isRefund ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownLeft className="h-3 w-3" />}
                                  {isRefund ? t("insuranceShell.entryType.refund") : t("insuranceShell.renewal")}
                                </span>
                              </td>
                              <td className="border-b border-slate-100 px-2 py-2 text-xs text-slate-600">{cashLabel}</td>
                              <td className="max-w-[280px] truncate border-b border-slate-100 px-2 py-2 text-xs text-slate-600" title={entry.note ?? ""}>
                                {entry.note || "-"}
                              </td>
                              <td className={`border-b border-slate-100 px-2 py-2 text-right text-xs font-semibold tabular-nums ${amountClass(displayAmount)}`}>
                                {formatMoney(displayAmount)}
                              </td>
                            </tr>
                          );
                        }) : (
                          <tr>
                            <td className="px-2 py-6 text-center text-xs text-slate-400" colSpan={5}>{t("insurance.emptyEntries")}</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )) : (
                <div className="px-4 py-10 text-center text-sm text-slate-400">{t("insurance.emptyPolicies")}</div>
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
  valueClass = "text-slate-900",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/80 px-4 py-3">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-sm font-semibold tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
