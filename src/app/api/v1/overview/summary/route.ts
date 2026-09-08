import { NextRequest, NextResponse } from "next/server";

import { computeOverviewSummary } from "@/lib/server/overview-summary";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { accountLabelFieldsFromRequest } from "@/lib/server/account-label-fields";
import { DISPLAY_LANGUAGE_COOKIE } from "@/lib/server/i18n";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/overview/summary
 *
 * Dashboard summary for daily accounts, credit cards, and compact investment overview.
 *
 * Response 200:
 * {
 *   ok: true,
 *   data: {
 * Per-row amounts stay in the account's own currency and carry a base-currency mirror
 * (`convertedBalance` / `convertedMarketValue` / `convertedCurrentBill` ...). All totals
 * (`netWorth`, `accountTypeTotals`, `investmentMarketValue`, ...) are already in the
 * household base currency (`baseCurrency`); amounts whose currency has no rate are left
 * out of those totals instead of being counted 1:1, and are listed in `missingFxCurrencies`.
 *
 *     netWorth: number,              // dailyNetWorth + investmentMarketValue + fixedAssetMarketValue + insuranceAsset
 *     dailyNetWorth: number,
 *     investmentMarketValue: number, // excludes fixed assets
 *     investmentCost: number,
 *     investmentFloatingPnL: number,
 *     investmentFloatingPnLRate: number,
 *     investmentAccountCount: number,
 *     fixedAssetAccountList: [{ accountId, name, assetType, marketValue, cost, floatingPnL, floatingPnLRate, currency, convertedMarketValue }],
 *     fixedAssetCount: number,
 *     fixedAssetMarketValue: number,
 *     fixedAssetCost: number,
 *     fixedAssetFloatingPnL: number,
 *     fixedAssetFloatingPnLRate: number,
 *     insuranceAsset: number,
 *     insuranceAccountCount: number,
 *     baseCurrency: string,
 *     missingFxCurrencies: string[],
 *     topPositions: [{ accountId, name, marketValue, floatingPnL, floatingPnLRate, currency, convertedMarketValue, convertedFloatingPnL }],
 *     monthIncome: number,
 *     monthExpense: number,
 *     dailyAssetDistribution: [{ kind, label, value, pct }],
 *     dailyAccountList: [{ id, name, kind, balance, groupName, institutionName, currency, convertedBalance, fxRate, fxRateDate, fxRateMissing }],
 *     debtAccountList: [{ id, name, kind, balance, groupName, institutionName, currency, convertedBalance, fxRate, fxRateDate, fxRateMissing }],
 *     creditAccountList: [{          // consolidated credit cards are returned once per bill storage group
 *       id, name, kind, balance, groupName, institutionName, currency, convertedBalance,
 *       fxRate, fxRateDate, fxRateMissing,
 *       creditLimit, availableLimit, billingDay, repaymentDay, creditBillMode,
 *       currentAmount, currentBill, paid, remain, dueDate,
 *       convertedCreditLimit, convertedCurrentBill, convertedPaid, convertedCurrentAmount
 *     }],
 *     creditUsedTotal: number,
 *     creditLimitTotal: number,
 *     creditAvailableTotal: number,
 *     creditCurrentAmountTotal: number,
 *     creditCurrentBillTotal: number
 *   }
 * }
 *
 * Backward-compatible aliases are also returned: netWorth, assetDistribution, accountList,
 * floatingPnL, totalCost, topPositions.
 *
 * Response 500: { ok: false, code: string, error: string }
 */
export async function GET(req: NextRequest) {
  try {
    const ctx = await getHouseholdScope();
    const raw = req.cookies.get(DISPLAY_LANGUAGE_COOKIE)?.value;
    const language = raw === "en-US" || raw === "ja-JP" ? raw : "zh-CN";
    const data = await computeOverviewSummary(ctx, undefined, language, {
      accountLabelFields: accountLabelFieldsFromRequest(req),
    });
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read overview summary";
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: message }, { status: 500 });
  }
}
