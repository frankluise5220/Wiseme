import crypto from "node:crypto";
import { BACKUP_FORMAT_VERSION } from "@/lib/server/backup";
import type { CaizhiConversionOptions, CaizhiConvertedBackup, CaizhiParsedBackup, CaizhiRawRow } from "@/lib/importers/caizhi/types";

const emptyBackupArrays = {
  systemSettings: [],
  accessKeys: [],
  aiChannels: [],
  aiModels: [],
  users: [],
  userSettings: [],
  institutions: [],
  counterparties: [],
  tags: [],
  insuranceProductMasters: [],
  wealthProducts: [],
  accountAliases: [],
  billOverrides: [],
  creditCardCycles: [],
  creditCardInstallmentPlans: [],
  fundConfirmDays: [],
  fundFeeRates: [],
  fundHoldings: [],
  preciousMetalTypes: [],
  preciousMetalUnits: [],
  preciousMetalHoldings: [],
  loanRateAdjustments: [],
  fundQueryApis: [],
  statementRecognitionRules: [],
  regularInvestPlans: [],
  fxRates: [],
  fxConversions: [],
  insuranceProducts: [],
  fundTransactions: [],
  fundTransactionCashFlows: [],
  insuranceTransactions: [],
  wealthTransactions: [],
  depositTransactions: [],
  preciousMetalTransactions: [],
  stockSecurities: [],
  stockHoldings: [],
  stockTransactions: [],
  stockPriceCache: [],
  stockFeeRules: [],
  stockMarketFeeRules: [],
  propertyAssets: [],
  propertyValuations: [],
  propertyTransactions: [],
  entryBusinessLinks: [],
  attachments: [],
  entryTags: [],
  emailAccounts: [],
};

function id(prefix: string, value: unknown) {
  const raw = String(value ?? crypto.randomUUID()).trim();
  return `${prefix}_${raw.replace(/[^A-Za-z0-9_-]+/g, "_")}`.slice(0, 64);
}

function text(value: unknown, fallback = "") {
  return value == null ? fallback : String(value).trim();
}

function numberValue(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function money(value: unknown) {
  return Math.round(numberValue(value) * 100) / 100;
}

function moneyString(value: unknown) {
  return money(value).toFixed(2);
}

function dateValue(value: unknown, fallback: Date) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = value == null ? null : new Date(String(value));
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

function accountKind(caizhiAccountType: unknown) {
  const type = Number(caizhiAccountType ?? 0);
  if (type === 1) return "cash";
  if (type === 2) return "bank_debit";
  if (type === 3) return "bank_credit";
  if (type === 5) return "deposit";
  if (type === 10 || type === 15 || type === 20) return "investment";
  if (type === 21) return "ewallet";
  if (type === 6 || type === 16 || type === 17 || type === 18 || type === 19) return "loan";
  if (type === 13) return "insurance";
  return "other";
}

function categoryType(caizhiCategoryType: unknown) {
  const type = Number(caizhiCategoryType ?? 0);
  if (type === 1) return "income";
  if (type === 2) return "expense";
  if (type === 3) return "investment";
  if (type === 4) return "transfer";
  return "expense";
}

function currencyCode(currencyId: unknown, currencyById: Map<number, CaizhiRawRow>) {
  const row = currencyById.get(Number(currencyId ?? 1));
  return text(row?.EnglishAbbr, "CNY") || "CNY";
}

function buildCategoryParentId(row: CaizhiRawRow, categoryIdByNid: Map<string, string>) {
  const parentNid = text(row.FID);
  if (parentNid && parentNid !== "0") return categoryIdByNid.get(parentNid) ?? null;
  const parentId = Number(row.ID1 ?? 0);
  if (parentId > 0) return id("cz_cat", parentId);
  return null;
}

function buildRemark(row: CaizhiRawRow, typeName: string) {
  const desc = text(row.Description);
  if (!typeName) return desc || null;
  return desc ? `${typeName}: ${desc}` : typeName;
}

function transactionKind(typeId: number, typeName: string) {
  if (typeId === 1 || typeId === 52) return "income";
  if (typeId === 2) return "expense";
  if (typeId === 4) return "transfer";
  if (/income|interest/i.test(typeName)) return "income";
  if (/expense|fee/i.test(typeName)) return "expense";
  return "transfer";
}

export function buildMmhBackupPayloadFromCaizhi(
  parsed: CaizhiParsedBackup,
  options: CaizhiConversionOptions = {},
): CaizhiConvertedBackup {
  const exportedAt = new Date();
  const householdId = `caizhi_${crypto.randomUUID().replace(/-/g, "")}`;
  const householdName = text(options.householdName, parsed.sourceFileName.replace(/\.[^.]+$/, "")) || "Caizhi Import";
  const defaultGroupId = id("cz_group", "default");

  const currencyById = new Map(parsed.tables.currencies.map((row) => [Number(row.ID ?? 0), row]));
  const typeNameById = new Map(parsed.tables.transactionTypes.map((row) => [Number(row.ID ?? 0), text(row.Name)]));
  const accountRows = parsed.tables.accounts.filter((row) => text(row.Name));
  const accountIdSet = new Set(accountRows.map((row) => id("cz_acct", row.ID)));
  const accountNameById = new Map(accountRows.map((row) => [id("cz_acct", row.ID), text(row.Name)]));

  const accountGroups = [
    {
      id: defaultGroupId,
      name: "Caizhi Accounts",
      sortOrder: 0,
      householdId,
      createdAt: exportedAt,
      updatedAt: exportedAt,
    },
  ];

  const accounts = accountRows.map((row, index) => ({
    id: id("cz_acct", row.ID),
    name: text(row.Name, `Account ${index + 1}`),
    balance: moneyString(row.LocalBala),
    kind: accountKind(row.AcctType),
    debtDirection: null,
    currency: currencyCode(row.CurrType, currencyById),
    isActive: Number(row.HideFlag ?? 0) !== 1 && Number(row.WriteOff ?? 0) !== 1,
    isPlaceholder: false,
    investProductType: null,
    creditLimit: null,
    billingDay: null,
    repaymentDay: null,
    creditBillMode: "separate",
    numberMasked: null,
    routeKey: null,
    note: text(row.Description) || null,
    householdId,
    institutionId: null,
    counterpartyId: null,
    userId: null,
    groupId: defaultGroupId,
    createdAt: dateValue(row.BuildDate, exportedAt),
    updatedAt: exportedAt,
    costBasisMethod: null,
    defaultConfirmDays: null,
    defaultArrivalDays: null,
    tradingCalendar: null,
    defaultFundQueryApiId: null,
    fundUnitsDecimals: 2,
  }));

  const validCategoryRows = parsed.tables.categories.filter((row) => text(row.CName) && Number(row.CType ?? 0) > 0);
  const categoryIdByNid = new Map(
    validCategoryRows
      .map((row) => [text(row.NID), id("cz_cat", row.ID)] as const)
      .filter(([nid]) => Boolean(nid)),
  );
  const categories = validCategoryRows.map((row) => ({
    id: id("cz_cat", row.ID),
    name: text(row.CName, "Imported Category"),
    type: categoryType(row.CType),
    icon: null,
    parentId: buildCategoryParentId(row, categoryIdByNid),
    householdId,
    isSystem: false,
  }));
  const categoryIdSet = new Set(categories.map((category) => category.id));
  const categoryNameById = new Map(categories.map((category) => [category.id, category.name]));

  const importBatchId = id("cz_batch", crypto.randomUUID());
  const importBatches = [{
    id: importBatchId,
    source: "caizhi_mh8",
    note: parsed.sourceFileName,
    rawText: null,
    householdId,
    createdAt: exportedAt,
  }];

  const dayOrderByDate = new Map<string, number>();
  const transactions: Record<string, unknown>[] = [];
  let skippedTransactions = 0;
  let unsupportedTransactions = 0;

  for (const row of parsed.tables.transactions) {
    const typeId = Number(row.TransType ?? 0);
    const typeName = typeNameById.get(typeId) ?? `Type ${typeId}`;
    const kind = transactionKind(typeId, typeName);
    const sourceAccountId = id("cz_acct", row.AcctNo1);
    const targetAccountId = id("cz_acct", row.AcctNo2);
    const fallbackAccountId = id("cz_acct", row.AcctNo3);
    const sum1 = money(row.Sum1);
    const sum2 = money(row.Sum2);
    const date = dateValue(row.TDate, exportedAt);
    const dateKey = date.toISOString().slice(0, 10);
    const dayOrder = dayOrderByDate.get(dateKey) ?? 0;
    dayOrderByDate.set(dateKey, dayOrder + 1);
    const categoryId = id("cz_cat", row.CategoryID);
    const hasCategory = categoryIdSet.has(categoryId);
    const common = {
      id: id("cz_tx", row.ID),
      date,
      postedAt: date,
      amount: "0.00",
      categoryId: hasCategory ? categoryId : null,
      categoryName: hasCategory ? categoryNameById.get(categoryId) ?? null : null,
      fundCode: null,
      fundProductType: null,
      metalTypeId: null,
      metalTypeName: null,
      metalUnitId: null,
      metalUnitName: null,
      metalQuantity: null,
      metalUnitPrice: null,
      metalFee: null,
      confirmDate: null,
      statementMonth: null,
      note: buildRemark(row, typeName),
      toNote: null,
      deletedAt: null,
      importBatchId,
      householdId,
      createdAt: dateValue(row.UpdateTime ?? row.CreateTime, exportedAt),
      updatedAt: dateValue(row.UpdateTime ?? row.CreateTime, exportedAt),
      dayOrder,
      currency: currencyCode(row.AssetID1, currencyById),
      paymentChannelId: null,
      paymentChannelName: null,
      counterpartyInstitutionId: null,
      counterpartyInstitutionName: null,
      status: "posted",
      fundArrivalAmount: null,
      fundArrivalDate: null,
      depositAnnualRate: null,
      depositInterest: null,
      depositSourceEntryId: null,
      fundSourceEntryId: null,
      debtPrincipalAmount: null,
      debtInterestAmount: null,
      debtFeeAmount: null,
      fundConfirmDate: null,
      fundFee: null,
      fundNav: null,
      fundSubtype: null,
      fundUnits: null,
      realizedProfit: null,
      regularInvestPlanId: null,
      creditCardInstallmentPlanId: null,
      installmentNo: null,
      installmentTotal: null,
      installmentPrincipal: null,
      installmentInterest: null,
      installmentRole: null,
      fundName: null,
      wealthProductId: null,
      insuranceProductId: null,
      insuranceAction: null,
      insuranceProductName: null,
      source: "import",
    };

    if ((kind === "income" || kind === "expense") && accountIdSet.has(sourceAccountId)) {
      const amount = Math.abs(sum1 || sum2);
      if (!(amount > 0)) {
        skippedTransactions += 1;
        continue;
      }
      transactions.push({
        ...common,
        type: kind,
        amount: amount.toFixed(2),
        accountId: sourceAccountId,
        accountName: accountNameById.get(sourceAccountId) ?? "",
        toAccountId: null,
        toAccountName: null,
      });
      continue;
    }

    const fromId = sum1 < 0 && accountIdSet.has(sourceAccountId)
      ? sourceAccountId
      : accountIdSet.has(fallbackAccountId)
        ? fallbackAccountId
        : sourceAccountId;
    const toId = sum2 > 0 && accountIdSet.has(targetAccountId)
      ? targetAccountId
      : sum1 > 0 && accountIdSet.has(sourceAccountId) && sourceAccountId !== fromId
        ? sourceAccountId
        : targetAccountId;
    const amount = Math.abs(sum1 || sum2);
    if (accountIdSet.has(fromId) && accountIdSet.has(toId) && fromId !== toId && amount > 0) {
      transactions.push({
        ...common,
        type: "transfer",
        amount: amount.toFixed(2),
        accountId: fromId,
        accountName: accountNameById.get(fromId) ?? "",
        toAccountId: toId,
        toAccountName: accountNameById.get(toId) ?? "",
      });
    } else {
      unsupportedTransactions += 1;
    }
  }

  const household = {
    id: householdId,
    name: householdName,
    baseCurrency: "CNY",
    createdAt: exportedAt,
    updatedAt: exportedAt,
  };

  const data = {
    ...emptyBackupArrays,
    household,
    accountGroups,
    categories,
    accounts,
    importBatches,
    transactions,
  };

  const counts = {
    users: 0,
    accounts: accounts.length,
    transactions: transactions.length,
    statementRecognitionRules: 0,
    categories: categories.length,
    tags: 0,
    institutions: 0,
    counterparties: 0,
    emailAccounts: 0,
    regularInvestPlans: 0,
    businessTransactions: 0,
    systemSettings: 0,
    accessKeys: 0,
    aiChannels: 0,
    aiModels: 0,
  };

  return {
    payload: {
      app: "MMH",
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt,
      exportedBy: null,
      scope: {
        householdId,
        householdName,
        backupScope: "household",
      },
      counts,
      data,
    },
    summary: {
      householdName,
      accounts: accounts.length,
      categories: categories.length,
      transactions: transactions.length,
      skippedTransactions,
      unsupportedTransactions,
      sourceFileName: parsed.sourceFileName,
    },
  };
}
