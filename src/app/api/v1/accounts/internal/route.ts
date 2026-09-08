import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { AccountKind } from "@prisma/client";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { computeInvestBalances } from "@/lib/invest-balance";
import { computeInsuranceAccountDisplayBalances } from "@/lib/insurance/balance";
import { computeAccountDisplayBalances } from "@/lib/server/account-balance";
import { computeDebtDisplaySummary } from "@/lib/server/debt-display-summary";
import { isDepositAccount, isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { creditCardDisplayBalanceFromCurrentCycle } from "@/lib/credit/billing";
import { buildAccountDisplayOption, type AccountLabelField } from "@/lib/account-display";
import { getServerAccountLabelFields } from "@/lib/server/account-label-fields";
import { convertCurrencyAmounts, getHouseholdBaseCurrency } from "@/lib/server/fx-rates";
import { normalizeCurrency } from "@/lib/currency";
import {
  countAccountsByCounterparty,
  countAccountsByInstitution,
  INSURANCE_PRODUCT_LINK_SELECT,
  withAccountCounts,
} from "@/lib/server/entity-account-counts";
import { loadAccountRecordCounts } from "@/lib/server/account-record-counts";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function normalizeReturnedAccountKind<T extends { kind: AccountKind; investProductType?: string | null }>(account: T): T {
  if (account.kind === AccountKind.investment && account.investProductType === "deposit") {
    return { ...account, kind: AccountKind.deposit };
  }
  return account;
}

function withAccountDisplayFields<T extends {
  id: string;
  name: string;
  kind: AccountKind;
  numberMasked?: string | null;
  groupId?: string | null;
  investProductType?: string | null;
  Institution?: { name: string | null; shortName?: string | null } | null;
  AccountGroup?: { id: string; name: string | null } | null;
}>(account: T, fields?: AccountLabelField[] | null) {
  const normalized = normalizeReturnedAccountKind(account);
  const display = buildAccountDisplayOption(normalized, undefined, { fields });
  return {
    ...normalized,
    label: display.selectorLabel || display.label,
    // Table cells render `listLabel`, which follows the configured display
    // fields (owner and account kind included).
    listLabel: display.listLabel,
    selectorLabel: display.selectorLabel,
    selectorCoreLabel: display.selectorCoreLabel,
    fullLabel: display.fullLabel,
    hoverTitle: display.hoverTitle,
    displaySubLabel: display.subLabel,
  };
}

/**
 * Fetches all data needed by the account settings page (filtered by the current household).
 * GET /api/v1/accounts/internal
 *
 * Query:
 * - balances=false returns only account/owner/institution base data without computing display balances.
 */
export async function GET(request: Request) {
  try {
    const includeBalances = request.url ? new URL(request.url).searchParams.get("balances") !== "false" : true;
    const accountLabelFields = await getServerAccountLabelFields();
    const ctx = await getHouseholdScope();
    const { householdId, hidFilter } = ctx;
    const baseCurrency = await getHouseholdBaseCurrency(householdId);

    const [accounts, groups, institutions, counterparties, users, insuranceProductLinks] = await Promise.all([
      prisma.account.findMany({
        where: { ...hidFilter },
        include: { Institution: true, Counterparty: true, AccountGroup: true, AccountAlias: true },
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
      }),
      prisma.accountGroup.findMany({
        where: hidFilter,
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      }),
      prisma.institution.findMany({ where: hidFilter, orderBy: { name: "asc" } }),
      prisma.counterparty.findMany({ where: hidFilter, orderBy: [{ type: "asc" }, { name: "asc" }] }),
      prisma.user.findMany({
        where: hidFilter,
        orderBy: { name: "asc" },
        // Return display fields only; never leak passwordHash
        select: { id: true, name: true, email: true, role: true, isSystem: true, householdId: true, createdAt: true },
      }),
      // Insurance product → account links, needed for the family member / insurer account counts.
      prisma.insuranceProduct.findMany({ where: hidFilter, select: INSURANCE_PRODUCT_LINK_SELECT }),
    ]);

    // Related-account counts shown next to institution / family member / counterparty names.
    const institutionsWithCounts = withAccountCounts(institutions, countAccountsByInstitution(accounts, insuranceProductLinks, institutions));
    const counterpartiesWithCounts = withAccountCounts(counterparties, countAccountsByCounterparty(accounts, counterparties));

    // Per-account record counts (active + soft-deleted) shown in the settings list.
    const recordCounts = await loadAccountRecordCounts(accounts.map((account) => account.id));
    const withRecordCounts = <T extends { id: string }>(account: T) => {
      const counts = recordCounts.get(account.id);
      return {
        ...account,
        recordCount: counts?.recordCount ?? 0,
        deletedRecordCount: counts?.deletedRecordCount ?? 0,
      };
    };

    if (!includeBalances) {
      return NextResponse.json({ ok: true, baseCurrency, accounts: accounts.map((account) => withRecordCounts(withAccountDisplayFields(account, accountLabelFields))), groups, institutions: institutionsWithCounts, counterparties: counterpartiesWithCounts, users });
    }

    // For investment accounts, use market value instead of raw balance
    const investBalByAccountId = await computeInvestBalances({ hidFilter, householdId: hidFilter.householdId ?? "", user: null });
    const cashDisplayBalanceByAccountId = await computeAccountDisplayBalances(
      accounts
        .filter((account) => !isPureInvestmentAccount(account))
        .map((account) => ({
          id: account.id,
          kind: account.kind,
          investProductType: account.investProductType,
          billingDay: account.billingDay,
        })),
      hidFilter,
    );
    const creditIds = accounts
      .filter((account) => account.kind === AccountKind.bank_credit && !!account.billingDay)
      .map((account) => account.id);
    const currentCreditCycles =
      creditIds.length > 0
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
    const insuranceAccountIds = accounts
      .filter((account) => account.kind === AccountKind.insurance)
      .map((account) => account.id);
    const insuranceDisplayBalanceByAccountId = await computeInsuranceAccountDisplayBalances(
      insuranceAccountIds,
      hidFilter,
    );
    const debtDisplaySummary = await computeDebtDisplaySummary(ctx);
    const enrichedAccounts = accounts.map((a) => {
      if (isPureInvestmentAccount(a)) {
        const detail = investBalByAccountId.get(a.id);
        if (detail) return { ...a, balance: detail.marketValue };
      }
      if (a.kind === AccountKind.insurance) {
        return { ...a, balance: insuranceDisplayBalanceByAccountId.get(a.id) ?? 0 };
      }
      if (isDepositAccount(a)) {
        const displayBalance = cashDisplayBalanceByAccountId.get(a.id);
        return displayBalance == null ? a : { ...a, balance: displayBalance };
      }
      if (a.kind === AccountKind.bank_credit && a.billingDay) {
        const creditDisplayBalance = currentCreditBalanceByAccountId.get(a.id);
        if (creditDisplayBalance != null) return { ...a, balance: creditDisplayBalance };
      }
      if (a.kind === AccountKind.loan || a.kind === AccountKind.settlement) {
        const debtDisplayBalance = debtDisplaySummary.balanceByAccountId.get(a.id);
        if (debtDisplayBalance != null) return { ...a, balance: debtDisplayBalance };
      }
      const displayBalance = cashDisplayBalanceByAccountId.get(a.id);
      return displayBalance == null ? a : { ...a, balance: displayBalance };
    });
    const conversion = await convertCurrencyAmounts({
      householdId,
      toCurrency: baseCurrency,
      refreshMissing: false,
      amounts: enrichedAccounts.map((account) => ({
        amount: Number(account.balance ?? 0),
        currency: account.currency,
      })),
    });
    const rateByCurrency = new Map(conversion.rates.map((rate) => [rate.fromCurrency, rate]));
    const convertedAccounts = enrichedAccounts.map((account) => {
      const currency = normalizeCurrency(account.currency);
      const rate = rateByCurrency.get(currency);
      const convertedBalance = rate?.rate == null ? null : Number(account.balance ?? 0) * rate.rate;
      return {
        ...account,
        convertedBalance,
        baseCurrency,
        fxRate: rate?.rate ?? null,
        fxRateDate: rate?.rateDate ?? null,
        fxRateMissing: rate?.missing ?? false,
      };
    });

    return NextResponse.json({
      ok: true,
      baseCurrency,
      totalConvertedBalance: conversion.total,
      missingFxCurrencies: conversion.missingCurrencies,
      rates: conversion.rates,
      accounts: convertedAccounts.map((account) => withRecordCounts(withAccountDisplayFields(account, accountLabelFields))),
      groups,
      institutions: institutionsWithCounts,
      counterparties: counterpartiesWithCounts,
      users,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "INTERNAL_ERROR", error: e instanceof Error ? e.message : "查询失败" },
      { status: 500 }
    );
  }
}
