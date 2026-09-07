import { AccountKind, TransactionType } from "@prisma/client";

import {
  buildAccountDisplayOption,
  DEFAULT_CREDIT_CARD_LABEL_TEMPLATE,
  type AccountLabelField,
} from "@/lib/account-display";
import { normalizeCurrency } from "@/lib/currency";
import { toNumber } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";
import { isFixedAssetAccountLike } from "@/lib/fixed-asset";
import { translate } from "@/lib/i18n-core";
import { computeInvestBalances } from "@/lib/invest-balance";
import { computeInsuranceAccountDisplayBalances } from "@/lib/insurance/balance";
import { computeAccountDisplayBalances } from "@/lib/server/account-balance";
import { computeDebtDisplaySummary } from "@/lib/server/debt-display-summary";
import { getConversionRate, getHouseholdBaseCurrency, type ConversionRate } from "@/lib/server/fx-rates";
import type { HouseholdContext } from "@/lib/server/household-scope";
import { isLegacyDepositAccount, isPureInvestmentAccount } from "@/lib/account-kind-utils";
import { getIncomeExpenseStatisticAmount } from "@/lib/transaction-statistics";
import type { DisplayLanguage } from "@/lib/client/appPreferences";
import { isLoanOrSettlementAccountKind } from "@/lib/debt";

export const DAILY_KIND_ORDER: string[] = [
  AccountKind.cash,
  AccountKind.bank_debit,
  AccountKind.ewallet,
  "deposit",
  AccountKind.other,
];

export type AssetDistributionItem = {
  kind: string;
  label: string;
  value: number;
  pct: number;
};

export type AccountListRow = {
  id: string;
  name: string;
  kind: string;
  /** Display balance in the account's own currency. */
  balance: number;
  groupName: string;
  institutionName: string;
  /** Currency the account is denominated in. */
  currency: string;
  /** Same balance restated in the household base currency; null when no rate is available. */
  convertedBalance: number | null;
  /** Rate used for the conversion; null when the rate is missing. */
  fxRate: number | null;
  fxRateDate: string | null;
  /** True when the account currency differs from the base currency and no rate was available. */
  fxRateMissing: boolean;
};

export type CreditAccountRow = AccountListRow & {
  creditLimit: number;
  availableLimit: number;
  billingDay: number | null;
  repaymentDay: number | null;
  repaymentOffsetDays: number | null;
  creditBillMode: "separate" | "consolidated";
  currentAmount: number;
  currentBill: number;
  paid: number;
  remain: number;
  dueDate: string | null;
  /** Base-currency mirrors; null when the card's currency has no rate. */
  convertedCreditLimit: number | null;
  convertedCurrentBill: number | null;
  convertedPaid: number | null;
  convertedCurrentAmount: number | null;
};

export type AccountTypeTotals = {
  cash: number;
  bankDebit: number;
  ewallet: number;
  deposit: number;
  investmentMarketValue: number;
  investmentCost: number;
  investmentFloatingPnL: number;
  fixedAssetMarketValue: number;
  fixedAssetCost: number;
  creditUsed: number;
  creditLimit: number;
  creditAvailable: number;
  creditCurrentAmount: number;
  creditCurrentBill: number;
  loan: number;
  loanReceivable: number;
  insuranceAsset: number;
  other: number;
  liquidAssets: number;
  liabilities: number;
  dailyNetWorth: number;
  totalNetWorth: number;
};

export type FixedAssetRow = {
  accountId: string;
  name: string;
  assetType: string | null;
  groupName: string;
  /** Market value in the account's own currency. */
  marketValue: number;
  cost: number;
  floatingPnL: number;
  floatingPnLRate: number;
  currency: string;
  /** Market value restated in the household base currency; null when no rate is available. */
  convertedMarketValue: number | null;
  fxRate: number | null;
  fxRateDate: string | null;
  fxRateMissing: boolean;
};

export type TopPositionRow = {
  accountId?: string;
  investProductType?: string | null;
  fundCode: string;
  name: string;
  /** Values in the account's own currency. */
  marketValue: number;
  floatingPnL: number;
  floatingPnLRate: number;
  currency?: string;
  /** Base-currency mirrors; null when the account currency has no rate. */
  convertedMarketValue?: number | null;
  convertedFloatingPnL?: number | null;
  fxRate?: number | null;
  fxRateMissing?: boolean;
};

export type OverviewSummary = {
  netWorth: number;
  floatingPnL: number;
  totalCost: number;
  monthIncome: number;
  monthExpense: number;
  assetDistribution: AssetDistributionItem[];
  accountList: AccountListRow[];
  topPositions: TopPositionRow[];
  investmentAccountList: TopPositionRow[];
  investmentAccountCount: number;
  insuranceAccountCount: number;
  dailyNetWorth: number;
  dailyAssetDistribution: AssetDistributionItem[];
  dailyAccountList: AccountListRow[];
  creditAccountList: CreditAccountRow[];
  debtAccountList: AccountListRow[];
  accountTypeTotals: AccountTypeTotals;
  creditUsedTotal: number;
  creditLimitTotal: number;
  creditAvailableTotal: number;
  creditCurrentAmountTotal: number;
  creditCurrentBillTotal: number;
  investmentMarketValue: number;
  investmentCost: number;
  investmentFloatingPnL: number;
  investmentFloatingPnLRate: number;
  fixedAssetAccountList: FixedAssetRow[];
  fixedAssetCount: number;
  fixedAssetMarketValue: number;
  fixedAssetCost: number;
  fixedAssetFloatingPnL: number;
  fixedAssetFloatingPnLRate: number;
  insuranceAsset: number;
  baseCurrency: string;
  missingFxCurrencies: string[];
};

function dateToIso(date: Date | null | undefined) {
  return date ? date.toISOString().slice(0, 10) : null;
}

export type FxConverter = {
  baseCurrency: string;
  /** Restate an amount into the base currency; null when no rate is available (never 1:1). */
  convert: (amount: number, currency?: string | null) => number | null;
  /** Same as convert, but missing-rate amounts collapse to 0 so they stay out of totals. */
  convertForTotal: (amount: number, currency?: string | null) => number;
  rateOf: (currency?: string | null) => ConversionRate | null;
  isMissing: (currency?: string | null) => boolean;
  missingCurrencies: string[];
};

/**
 * Build a converter that restates amounts into the household base currency.
 *
 * Overview numbers sit side by side and are summed into one net worth, so they have to
 * share a currency. Accounts keep their own currency, so every balance is converted with
 * the household FX rate. When a rate is missing the amount is reported as `null` and kept
 * out of the totals instead of being silently treated as if 1 unit equalled 1 unit.
 */
async function buildFxConverter(householdId: string, currencies: Iterable<string | null | undefined>): Promise<FxConverter> {
  const baseCurrency = await getHouseholdBaseCurrency(householdId);
  const sources = Array.from(new Set(Array.from(currencies).map((currency) => normalizeCurrency(currency))));
  const rateRows = await Promise.all(
    sources.map((fromCurrency) =>
      getConversionRate({ householdId, fromCurrency, toCurrency: baseCurrency }),
    ),
  );
  const rateByCurrency = new Map(rateRows.map((row) => [row.fromCurrency, row]));

  const rateOf = (currency?: string | null) => {
    const from = normalizeCurrency(currency);
    if (from === baseCurrency) {
      return { fromCurrency: from, toCurrency: baseCurrency, rate: 1, rateDate: null, source: "same_currency", missing: false } satisfies ConversionRate;
    }
    const row = rateByCurrency.get(from);
    if (!row || row.rate == null || !Number.isFinite(row.rate)) return null;
    return row;
  };

  const convert = (amount: number, currency?: string | null) => {
    const rate = rateOf(currency)?.rate;
    return rate == null ? null : amount * rate;
  };

  return {
    baseCurrency,
    convert,
    convertForTotal: (amount, currency) => convert(amount, currency) ?? 0,
    rateOf,
    isMissing: (currency?: string | null) => rateOf(currency) == null,
    missingCurrencies: Array.from(new Set(rateRows.filter((row) => row.rate == null).map((row) => row.fromCurrency))),
  };
}

function buildDistribution(rows: AccountListRow[], language: DisplayLanguage) {
  const totals = new Map<string, number>();
  for (const kind of DAILY_KIND_ORDER) totals.set(kind, 0);

  for (const row of rows) {
    totals.set(row.kind, (totals.get(row.kind) ?? 0) + (row.convertedBalance ?? 0));
  }

  const totalAbs = Array.from(totals.values()).reduce((sum, value) => sum + Math.abs(value), 0);

  return DAILY_KIND_ORDER
    .filter((kind) => totals.get(kind) !== 0)
    .map((kind) => {
      const value = totals.get(kind) ?? 0;
      return {
        kind,
        label: translate(language, `account.kind.${kind}`),
        value,
        pct: totalAbs > 0 ? (Math.abs(value) / totalAbs) * 100 : 0,
      };
    })
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

export async function computeOverviewSummary(
  ctx: HouseholdContext,
  creditCardLabelTemplate: string = DEFAULT_CREDIT_CARD_LABEL_TEMPLATE,
  language: DisplayLanguage = "zh-CN",
  options?: { accountLabelFields?: AccountLabelField[] | null },
): Promise<OverviewSummary> {
  const { hidFilter } = ctx;
  const accountLabelFields = options?.accountLabelFields ?? null;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const accounts = await prisma.account.findMany({
    where: { isActive: true, isPlaceholder: { not: true }, ...hidFilter },
    select: {
      id: true,
      name: true,
      kind: true,
      groupId: true,
      balance: true,
      currency: true,
      fixedAssetType: true,
      creditLimit: true,
      billingDay: true,
      repaymentDay: true,
      repaymentOffsetDays: true,
      creditBillMode: true,
      institutionId: true,
      numberMasked: true,
      investProductType: true,
      Institution: { select: { name: true, shortName: true } },
      AccountGroup: { select: { name: true } },
    },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });

  const fx = await buildFxConverter(
    ctx.householdId,
    accounts.map((account) => account.currency),
  );

  const currencyOf = (account: { currency?: string | null }) => normalizeCurrency(account.currency);

  const legacyDepositAccounts = accounts.filter(isLegacyDepositAccount);
  const pureInvestmentAccounts = accounts.filter(isPureInvestmentAccount);
  // Fixed assets are stored as investment + property accounts for compatibility, but they
  // are shown in their own overview card instead of being mixed into the investment totals.
  const fixedAssetAccounts = pureInvestmentAccounts.filter(isFixedAssetAccountLike);
  const investmentOnlyAccounts = pureInvestmentAccounts.filter((account) => !isFixedAssetAccountLike(account));
  const creditAccounts = accounts.filter((account) => account.kind === AccountKind.bank_credit);
  const debtAccounts = accounts.filter((account) => isLoanOrSettlementAccountKind(account.kind));
  const insuranceAccounts = accounts.filter((account) => account.kind === AccountKind.insurance);

  const dailyBaseAccounts = accounts.filter(
    (account) =>
      !isPureInvestmentAccount(account) &&
      !isLegacyDepositAccount(account) &&
      account.kind !== AccountKind.bank_credit &&
      !isLoanOrSettlementAccountKind(account.kind) &&
      account.kind !== AccountKind.insurance,
  );

  const dailyAccounts = [
    ...dailyBaseAccounts.map((account) => ({ ...account, summaryKind: account.kind as string })),
    ...legacyDepositAccounts.map((account) => ({ ...account, summaryKind: "deposit" })),
  ];
  const dailyAccountIds = dailyAccounts.map((account) => account.id);
  const dailyCurrencyByAccountId = new Map(dailyAccounts.map((account) => [account.id, currencyOf(account)]));
  const dailyAndDebtDisplayBalanceByAccountId = await computeAccountDisplayBalances(
    [...dailyAccounts, ...debtAccounts].map((account) => ({
      id: account.id,
      kind: account.kind,
      investProductType: account.investProductType,
      billingDay: account.billingDay,
    })),
    hidFilter,
  );
  const debtDisplaySummary = await computeDebtDisplaySummary(ctx, fx);

  let monthIncome = 0;
  let monthExpense = 0;

  if (dailyAccountIds.length > 0) {
    const monthEntries = await prisma.txRecord.findMany({
      where: {
        deletedAt: null,
        ...hidFilter,
        date: { gte: monthStart, lt: monthEnd },
        OR: [{ accountId: { in: dailyAccountIds } }, { toAccountId: { in: dailyAccountIds } }],
      },
      select: { type: true, amount: true, accountId: true, toAccountId: true },
    });

    for (const entry of monthEntries) {
      const amount = toNumber(entry.amount);
      const isToDaily = dailyAccountIds.includes(entry.toAccountId ?? "");
      const isFromDaily = dailyAccountIds.includes(entry.accountId);
      const convertFor = (value: number, accountId: string | null | undefined) =>
        fx.convertForTotal(value, dailyCurrencyByAccountId.get(accountId ?? ""));

      if (entry.type === TransactionType.income && isToDaily) {
        monthIncome += convertFor(getIncomeExpenseStatisticAmount(entry.type, amount), entry.toAccountId);
      } else if (entry.type === TransactionType.expense && isFromDaily) {
        monthExpense += convertFor(getIncomeExpenseStatisticAmount(entry.type, amount), entry.accountId);
      } else if (entry.type === TransactionType.transfer) {
        if (isToDaily && !isFromDaily) monthIncome += Math.abs(convertFor(amount, entry.toAccountId));
        if (isFromDaily && !isToDaily) monthExpense += Math.abs(convertFor(amount, entry.accountId));
      }
    }
  }

  const dailyAccountList: AccountListRow[] = dailyAccounts.map((account) => {
    const display = buildAccountDisplayOption(
      {
        id: account.id,
        name: account.name,
        kind: account.kind,
        numberMasked: account.numberMasked,
        groupId: account.groupId,
        investProductType: account.investProductType,
        Institution: account.Institution,
        AccountGroup: account.AccountGroup ? { id: "", name: account.AccountGroup.name } : null,
      },
      creditCardLabelTemplate,
      { fields: accountLabelFields },
    );

    const accountCurrency = currencyOf(account);
    const balance =
      dailyAndDebtDisplayBalanceByAccountId.get(account.id) ?? toNumber(account.balance);
    const rate = fx.rateOf(accountCurrency);

    return {
      id: account.id,
      name: display.label,
      kind: account.summaryKind,
      balance,
      groupName: account.AccountGroup?.name?.trim() || translate(language, "invest.noOwner"),
      institutionName: display.institutionName,
      currency: accountCurrency,
      convertedBalance: fx.convert(balance, accountCurrency),
      fxRate: rate?.rate ?? null,
      fxRateDate: rate?.rateDate ?? null,
      fxRateMissing: fx.isMissing(accountCurrency),
    };
  });

  const consolidatedInstitutionIds = Array.from(new Set(
    creditAccounts
      .filter((account) => account.creditBillMode === "consolidated" && !!account.institutionId)
      .map((account) => account.institutionId!),
  ));
  const consolidatedGroupAccounts = consolidatedInstitutionIds.length > 0
    ? await prisma.account.findMany({
        where: {
          ...hidFilter,
          kind: AccountKind.bank_credit,
          creditBillMode: "consolidated",
          institutionId: { in: consolidatedInstitutionIds },
        },
        select: { id: true, institutionId: true },
        orderBy: { id: "asc" },
      })
    : [];
  const consolidatedStorageIdByInstitutionId = new Map<string, string>();
  for (const account of consolidatedGroupAccounts) {
    if (account.institutionId && !consolidatedStorageIdByInstitutionId.has(account.institutionId)) {
      consolidatedStorageIdByInstitutionId.set(account.institutionId, account.id);
    }
  }
  const creditStorageIdByAccountId = new Map(
    creditAccounts.map((account) => {
      if (account.creditBillMode !== "consolidated" || !account.institutionId) {
        return [account.id, account.id] as const;
      }
      const storageId = consolidatedStorageIdByInstitutionId.get(account.institutionId) ?? account.id;
      return [account.id, storageId] as const;
    }),
  );
  const creditIds = Array.from(new Set(creditStorageIdByAccountId.values()));
  const currentCycles =
    creditIds.length > 0
      ? await prisma.creditCardCycle.findMany({
          where: { accountId: { in: creditIds }, isCurrentCycle: true },
          select: { accountId: true, expenseAbs: true, income: true, effectiveBill: true, paid: true, cumulativeRemain: true, cumulativeOverpaid: true, dueDate: true },
        })
      : [];
  const cycleByAccountId = new Map(currentCycles.map((cycle) => [cycle.accountId, cycle]));

  const creditAccountsByStorageId = new Map<string, typeof creditAccounts>();
  for (const account of creditAccounts) {
    const storageId = creditStorageIdByAccountId.get(account.id) ?? account.id;
    const list = creditAccountsByStorageId.get(storageId) ?? [];
    list.push(account);
    creditAccountsByStorageId.set(storageId, list);
  }
  const creditAccountList: CreditAccountRow[] = Array.from(creditAccountsByStorageId.entries()).map(([storageId, groupAccounts]) => {
    const storageAccount = groupAccounts.find((account) => account.id === storageId) ?? groupAccounts[0];
    const isConsolidatedGroup =
      groupAccounts.length > 1 ||
      (storageAccount.creditBillMode === "consolidated" && !!storageAccount.institutionId);
    const display = buildAccountDisplayOption(
      {
        id: storageAccount.id,
        name: storageAccount.name,
        kind: storageAccount.kind,
        numberMasked: storageAccount.numberMasked,
        groupId: storageAccount.groupId,
        Institution: storageAccount.Institution,
        AccountGroup: storageAccount.AccountGroup ? { id: "", name: storageAccount.AccountGroup.name } : null,
      },
      creditCardLabelTemplate,
      { fields: accountLabelFields },
    );
    const groupCurrency = currencyOf(storageAccount);
    const groupRate = fx.rateOf(groupCurrency);
    const convert = (amount: number) => fx.convert(amount, groupCurrency);
    const creditLimit = groupAccounts.reduce((sum, account) => sum + toNumber(account.creditLimit), 0);
    const cycle = cycleByAccountId.get(storageId);
    const balance = cycle
      ? toNumber(cycle.cumulativeRemain) - toNumber(cycle.cumulativeOverpaid)
      : groupAccounts.reduce((sum, account) => sum + toNumber(account.balance), 0);
    const currentAmount = toNumber(cycle?.expenseAbs) - toNumber(cycle?.income);
    const institutionName = display.institutionName;
    const consolidatedInstitutionName =
      storageAccount.Institution?.name?.trim() ||
      storageAccount.Institution?.shortName?.trim() ||
      institutionName;

    return {
      id: storageId,
      name: isConsolidatedGroup && consolidatedInstitutionName ? consolidatedInstitutionName : display.label,
      kind: storageAccount.kind,
      balance,
      groupName: storageAccount.AccountGroup?.name?.trim() || translate(language, "invest.noOwner"),
      institutionName: isConsolidatedGroup ? consolidatedInstitutionName : institutionName,
      currency: groupCurrency,
      convertedBalance: convert(balance),
      fxRate: groupRate?.rate ?? null,
      fxRateDate: groupRate?.rateDate ?? null,
      fxRateMissing: fx.isMissing(groupCurrency),
      creditLimit,
      availableLimit: Math.max(0, creditLimit - Math.max(0, balance)),
      currentAmount,
      billingDay: storageAccount.billingDay,
      repaymentDay: storageAccount.repaymentDay,
      repaymentOffsetDays: storageAccount.repaymentOffsetDays,
      creditBillMode: isConsolidatedGroup ? "consolidated" : storageAccount.creditBillMode,
      currentBill: toNumber(cycle?.effectiveBill),
      paid: toNumber(cycle?.paid),
      remain: toNumber(cycle?.cumulativeRemain),
      dueDate: dateToIso(cycle?.dueDate),
      // Base-currency mirrors of the amounts this card renders; null when the rate is missing.
      convertedCreditLimit: convert(creditLimit),
      convertedCurrentBill: convert(toNumber(cycle?.effectiveBill)),
      convertedPaid: convert(toNumber(cycle?.paid)),
      convertedCurrentAmount: convert(currentAmount),
    };
  });

  const debtAccountList: AccountListRow[] = debtAccounts.map((account) => {
    const display = buildAccountDisplayOption(
      {
        id: account.id,
        name: account.name,
        kind: account.kind,
        numberMasked: account.numberMasked,
        groupId: account.groupId,
        Institution: account.Institution,
        AccountGroup: account.AccountGroup ? { id: "", name: account.AccountGroup.name } : null,
      },
      creditCardLabelTemplate,
      { fields: accountLabelFields },
    );
    const accountCurrency = currencyOf(account);
    const balance =
      debtDisplaySummary.balanceByAccountId.get(account.id) ??
      dailyAndDebtDisplayBalanceByAccountId.get(account.id) ??
      toNumber(account.balance);
    const rate = fx.rateOf(accountCurrency);

    return {
      id: account.id,
      name: display.label,
      kind: account.kind,
      balance,
      groupName: display.groupName,
      institutionName: display.institutionName,
      currency: accountCurrency,
      convertedBalance: fx.convert(balance, accountCurrency),
      fxRate: rate?.rate ?? null,
      fxRateDate: rate?.rateDate ?? null,
      fxRateMissing: fx.isMissing(accountCurrency),
    };
  });

  // Aggregates are base-currency sums: amounts without a rate contribute 0 instead of
  // being added at face value, so a missing FX rate can never inflate net worth.
  const sumConverted = (rows: AccountListRow[], predicate: (row: AccountListRow) => boolean) =>
    rows.filter(predicate).reduce((sum, row) => sum + (row.convertedBalance ?? 0), 0);

  const cash = sumConverted(dailyAccountList, (account) => account.kind === AccountKind.cash);
  const bankDebit = sumConverted(dailyAccountList, (account) => account.kind === AccountKind.bank_debit);
  const ewallet = sumConverted(dailyAccountList, (account) => account.kind === AccountKind.ewallet);
  const deposit = sumConverted(dailyAccountList, (account) => account.kind === "deposit");
  const other = sumConverted(dailyAccountList, (account) => account.kind === AccountKind.other);

  const loan = debtDisplaySummary.totalPayable;
  const loanReceivable = debtDisplaySummary.totalReceivable;

  const creditUsedTotal = creditAccountList.reduce((sum, account) => sum + Math.max(0, account.convertedBalance ?? 0), 0);
  const creditLimitTotal = creditAccountList.reduce((sum, account) => sum + (account.convertedCreditLimit ?? 0), 0);
  const creditAvailableTotal = Math.max(0, creditLimitTotal - creditUsedTotal);
  const creditCurrentAmountTotal = creditAccountList.reduce((sum, account) => sum + (account.convertedCurrentAmount ?? 0), 0);
  const creditCurrentBillTotal = creditAccountList.reduce((sum, account) => sum + (account.convertedCurrentBill ?? 0), 0);

  const liquidAssets = cash + bankDebit + ewallet + deposit + Math.max(0, other);
  const liabilities = loan + creditUsedTotal;
  const dailyNetWorth = liquidAssets + loanReceivable + Math.min(0, other) - liabilities;
  const dailyAssetDistribution = buildDistribution(dailyAccountList, language);

  const investBalByAccountId = await computeInvestBalances(ctx);
  const investmentAccountList: TopPositionRow[] = investmentOnlyAccounts
    .map((account) => {
      const detail = investBalByAccountId.get(account.id);
      const accountCurrency = currencyOf(account);
      const marketValue = detail?.marketValue ?? 0;
      const totalCost = detail?.totalCost ?? 0;
      const floatingPnL = detail?.floatingPnL ?? 0;
      const display = buildAccountDisplayOption(
        {
          id: account.id,
          name: account.name,
          kind: account.kind,
          numberMasked: account.numberMasked,
          groupId: account.groupId,
          investProductType: account.investProductType,
          Institution: account.Institution,
          AccountGroup: account.AccountGroup ? { id: "", name: account.AccountGroup.name } : null,
        },
        creditCardLabelTemplate,
        { fields: accountLabelFields },
      );
      return {
        accountId: account.id,
        investProductType: account.investProductType,
        fundCode: "",
        name: display.label,
        marketValue,
        floatingPnL,
        floatingPnLRate: totalCost > 0 ? floatingPnL / totalCost : 0,
        currency: accountCurrency,
        convertedMarketValue: fx.convert(marketValue, accountCurrency),
        convertedFloatingPnL: fx.convert(floatingPnL, accountCurrency),
        fxRate: fx.rateOf(accountCurrency)?.rate ?? null,
        fxRateMissing: fx.isMissing(accountCurrency),
      };
    })
    .sort((a, b) => (b.convertedMarketValue ?? 0) - (a.convertedMarketValue ?? 0));

  const investmentMarketValue = investmentAccountList.reduce((sum, row) => sum + (row.convertedMarketValue ?? 0), 0);
  const investmentCost = investmentOnlyAccounts.reduce(
    (sum, account) => sum + fx.convertForTotal(investBalByAccountId.get(account.id)?.totalCost ?? 0, currencyOf(account)),
    0,
  );
  const investmentFloatingPnL = investmentAccountList.reduce((sum, row) => sum + (row.convertedFloatingPnL ?? 0), 0);
  const investmentFloatingPnLRate = investmentCost > 0 ? investmentFloatingPnL / investmentCost : 0;

  const fixedAssetAccountList: FixedAssetRow[] = fixedAssetAccounts
    .map((account) => {
      const detail = investBalByAccountId.get(account.id);
      const accountCurrency = currencyOf(account);
      const marketValue = detail?.marketValue ?? 0;
      const cost = detail?.totalCost ?? 0;
      const floatingPnL = detail?.floatingPnL ?? 0;
      const rate = fx.rateOf(accountCurrency);
      const display = buildAccountDisplayOption(
        {
          id: account.id,
          name: account.name,
          kind: account.kind,
          numberMasked: account.numberMasked,
          groupId: account.groupId,
          investProductType: account.investProductType,
          Institution: account.Institution,
          AccountGroup: account.AccountGroup ? { id: "", name: account.AccountGroup.name } : null,
        },
        creditCardLabelTemplate,
        { fields: accountLabelFields },
      );
      return {
        accountId: account.id,
        name: display.label,
        assetType: account.fixedAssetType ?? null,
        groupName: account.AccountGroup?.name?.trim() || translate(language, "invest.noOwner"),
        marketValue,
        cost,
        floatingPnL,
        floatingPnLRate: cost > 0 ? floatingPnL / cost : 0,
        currency: accountCurrency,
        convertedMarketValue: fx.convert(marketValue, accountCurrency),
        fxRate: rate?.rate ?? null,
        fxRateDate: rate?.rateDate ?? null,
        fxRateMissing: fx.isMissing(accountCurrency),
      };
    })
    .sort((a, b) => (b.convertedMarketValue ?? 0) - (a.convertedMarketValue ?? 0));

  const fixedAssetMarketValue = fixedAssetAccountList.reduce((sum, row) => sum + (row.convertedMarketValue ?? 0), 0);
  const fixedAssetCost = fixedAssetAccounts.reduce(
    (sum, account) => sum + fx.convertForTotal(investBalByAccountId.get(account.id)?.totalCost ?? 0, currencyOf(account)),
    0,
  );
  const fixedAssetFloatingPnL = fixedAssetMarketValue - fixedAssetCost;
  const fixedAssetFloatingPnLRate = fixedAssetCost > 0 ? fixedAssetFloatingPnL / fixedAssetCost : 0;

  const insuranceDisplayBalanceByAccountId = await computeInsuranceAccountDisplayBalances(
    insuranceAccounts.map((account) => account.id),
    hidFilter,
  );
  const insuranceAsset = insuranceAccounts.reduce(
    (sum, account) => sum + fx.convertForTotal(insuranceDisplayBalanceByAccountId.get(account.id) ?? 0, currencyOf(account)),
    0,
  );
  const totalNetWorth = dailyNetWorth + investmentMarketValue + fixedAssetMarketValue + insuranceAsset;

  const accountTypeTotals: AccountTypeTotals = {
    cash,
    bankDebit,
    ewallet,
    deposit,
    investmentMarketValue,
    investmentCost,
    investmentFloatingPnL,
    fixedAssetMarketValue,
    fixedAssetCost,
    creditUsed: creditUsedTotal,
    creditLimit: creditLimitTotal,
    creditAvailable: creditAvailableTotal,
    creditCurrentAmount: creditCurrentAmountTotal,
    creditCurrentBill: creditCurrentBillTotal,
    loan,
    loanReceivable,
    insuranceAsset,
    other,
    liquidAssets,
    liabilities,
    dailyNetWorth,
    totalNetWorth,
  };

  return {
    netWorth: totalNetWorth,
    floatingPnL: investmentFloatingPnL,
    totalCost: investmentCost,
    monthIncome,
    monthExpense,
    assetDistribution: dailyAssetDistribution,
    accountList: dailyAccountList,
    topPositions: investmentAccountList.slice(0, 5),
    investmentAccountList,
    investmentAccountCount: investmentOnlyAccounts.length,
    insuranceAccountCount: insuranceAccounts.length,
    dailyNetWorth,
    dailyAssetDistribution,
    dailyAccountList,
    creditAccountList,
    debtAccountList,
    accountTypeTotals,
    creditUsedTotal,
    creditLimitTotal,
    creditAvailableTotal,
    creditCurrentAmountTotal,
    creditCurrentBillTotal,
    investmentMarketValue,
    investmentCost,
    investmentFloatingPnL,
    investmentFloatingPnLRate,
    fixedAssetAccountList,
    fixedAssetCount: fixedAssetAccounts.length,
    fixedAssetMarketValue,
    fixedAssetCost,
    fixedAssetFloatingPnL,
    fixedAssetFloatingPnLRate,
    insuranceAsset,
    baseCurrency: fx.baseCurrency,
    missingFxCurrencies: fx.missingCurrencies,
  };
}
