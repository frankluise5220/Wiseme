import { cookies } from "next/headers";

import { OverviewDashboard } from "@/components/OverviewDashboard";
import { MobileTransactionForm } from "@/components/mobile/MobileTransactionForm";
import { normalizeCreditCardLabelTemplate } from "@/lib/account-display";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { ACCOUNT_LABEL_FIELDS_COOKIE, accountLabelFieldsFromCookieValue } from "@/lib/server/account-label-fields";
import { getServerDisplayLanguage } from "@/lib/server/i18n";
import { computeInsuranceOverviewSummary } from "@/lib/server/insurance-overview-summary";
import { computeOverviewSummary } from "@/lib/server/overview-summary";
import { prisma } from "@/lib/db/prisma";
import { categoryOrderBy } from "@/lib/category-order";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const ctx = await getHouseholdScope();
  const cookieStore = await cookies();
  const accountLabelFields = accountLabelFieldsFromCookieValue(cookieStore.get(ACCOUNT_LABEL_FIELDS_COOKIE)?.value);
  const language = await getServerDisplayLanguage();
  const isRedUp = (cookieStore.get("colorScheme")?.value ?? "red_up_green_down") === "red_up_green_down";
  const creditCardLabelMode = cookieStore.get("mmh_credit_card_label_mode")?.value === "full_name" ? "full_name" : "short_last4";
  const creditCardLabelTemplate = normalizeCreditCardLabelTemplate(
    cookieStore.get("mmh_credit_card_label_template")?.value,
    creditCardLabelMode,
  );
  const [summary, insuranceOverview, accounts, categories] = await Promise.all([
    computeOverviewSummary(ctx, creditCardLabelTemplate, language, { accountLabelFields }),
    computeInsuranceOverviewSummary(ctx),
    prisma.account.findMany({
      where: { ...ctx.hidFilter, isActive: true, isPlaceholder: { not: true } },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        kind: true,
        numberMasked: true,
        groupId: true,
        investProductType: true,
        Institution: { select: { name: true, shortName: true } },
        AccountGroup: { select: { id: true, name: true } },
      },
    }),
    prisma.category.findMany({
      where: { ...ctx.hidFilter, type: { in: ["expense", "income"] } },
      orderBy: categoryOrderBy(),
      select: { id: true, name: true, type: true, sortOrder: true, isSystem: true },
    }),
  ]);

  return (
    <>
    <OverviewDashboard
      netWorth={summary.netWorth}
      accountTypeTotals={summary.accountTypeTotals}
      assetDistribution={summary.dailyAssetDistribution}
      monthIncome={summary.monthIncome}
      monthExpense={summary.monthExpense}
      accountList={summary.dailyAccountList}
      creditAccountList={summary.creditAccountList}
      debtAccountList={summary.debtAccountList}
      topPositions={summary.topPositions}
      investmentAccountCount={summary.investmentAccountCount}
      insuranceAccountCount={summary.insuranceAccountCount}
      investmentMarketValue={summary.investmentMarketValue}
      investmentCost={summary.investmentCost}
      investmentFloatingPnL={summary.investmentFloatingPnL}
      investmentFloatingPnLRate={summary.investmentFloatingPnLRate}
      fixedAssetAccountList={summary.fixedAssetAccountList}
      fixedAssetCount={summary.fixedAssetCount}
      fixedAssetMarketValue={summary.fixedAssetMarketValue}
      fixedAssetCost={summary.fixedAssetCost}
      fixedAssetFloatingPnL={summary.fixedAssetFloatingPnL}
      fixedAssetFloatingPnLRate={summary.fixedAssetFloatingPnLRate}
      insuranceOverview={insuranceOverview}
      baseCurrency={summary.baseCurrency}
      missingFxCurrencies={summary.missingFxCurrencies}
      isRedUp={isRedUp}
    />
    <div className="md:hidden">
      <MobileTransactionForm
        accounts={accounts.map((account) => ({ ...account, kind: String(account.kind) }))}
        categories={categories}
      />
    </div>
    </>
  );
}
