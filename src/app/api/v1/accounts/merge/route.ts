import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { invalidateCreditCardCycleCacheForAccountIds } from "@/lib/server/credit-card-cycle-cache";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";
import { isFixedAssetAccountLike } from "@/lib/fixed-asset";

export const runtime = "nodejs";

/**
 * POST /api/v1/accounts/merge
 * Body: { keepId, mergeId }
 *
 * Merges two accounts of the same household. All records referencing the
 * merged account (transactions on both sides, fund/insurance/wealth/deposit/
 * metal/stock/property transactions, regular-invest plans, credit-card
 * installment plans, fx conversions, loan rate adjustments, insurance
 * products, property assets, aliases) are re-pointed to the kept account;
 * per-account derived/config rows (holdings, snapshots, cycles, overrides)
 * are dropped; then the merged account is deleted. Nothing else is changed.
 */
function normalizeMergeKind(account: { kind: string; investProductType?: string | null }): string {
  if (isFixedAssetAccountLike(account)) return "fixed_asset";
  if (account.kind === "deposit" || (account.kind === "investment" && account.investProductType === "deposit")) {
    return "deposit";
  }
  return account.kind;
}

export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => null) as { keepId?: string; mergeId?: string } | null;
    const keepId = String(body?.keepId ?? "").trim();
    const mergeId = String(body?.mergeId ?? "").trim();
    if (!keepId || !mergeId) {
      return NextResponse.json({ ok: false, code: "MISSING_ID", error: "Missing keepId or mergeId" }, { status: 400 });
    }
    if (keepId === mergeId) {
      return NextResponse.json({ ok: false, code: "SAME_ACCOUNT", error: "不能合并同一个账户" }, { status: 400 });
    }

    const [keep, merged] = await Promise.all([
      prisma.account.findUnique({ where: { id: keepId } }),
      prisma.account.findUnique({ where: { id: mergeId } }),
    ]);
    if (!keep || !merged) {
      return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "账户不存在" }, { status: 404 });
    }
    // Both accounts must belong to the caller's household.
    if (keep.householdId !== householdId || merged.householdId !== householdId) {
      return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
    }

    // Same-kind precondition, using the user-facing normalized kind so that
    // legacy deposit accounts (kind=investment + investProductType=deposit)
    // and fixed-asset accounts (kind=investment + investProductType=property)
    // compare as their user-facing types.
    const keepKind = normalizeMergeKind(keep);
    const mergeKind = normalizeMergeKind(merged);
    if (keepKind !== mergeKind) {
      return NextResponse.json({ ok: false, code: "KIND_MISMATCH", error: "只能合并相同类型的账户" }, { status: 400 });
    }
    if (keepKind === "investment" && (keep.investProductType ?? "") !== (merged.investProductType ?? "")) {
      return NextResponse.json({ ok: false, code: "INVEST_TYPE_MISMATCH", error: "两个投资账户的产品类型不同" }, { status: 400 });
    }
    if (keepKind === "loan" && (keep.debtDirection ?? "") !== (merged.debtDirection ?? "")) {
      return NextResponse.json({ ok: false, code: "DEBT_DIRECTION_MISMATCH", error: "两个往来账户的借贷方向不同" }, { status: 400 });
    }
    if (keep.groupId !== merged.groupId) {
      return NextResponse.json({ ok: false, code: "OWNER_MISMATCH", error: "两个账户的所有人不同" }, { status: 400 });
    }
    if ((keep.institutionId ?? "") !== (merged.institutionId ?? "")) {
      return NextResponse.json({ ok: false, code: "INSTITUTION_MISMATCH", error: "两个账户的机构不同" }, { status: 400 });
    }
    if (keep.currency !== merged.currency) {
      return NextResponse.json({ ok: false, code: "CURRENCY_MISMATCH", error: "两个账户的币种不同" }, { status: 400 });
    }

    const lastUsedAt = [keep.lastUsedAt, merged.lastUsedAt]
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

    await prisma.$transaction(async (tx) => {
      // 1. Transactions: re-point both sides and refresh denormalized names.
      await tx.txRecord.updateMany({
        where: { accountId: mergeId },
        data: { accountId: keepId, accountName: keep.name },
      });
      await tx.txRecord.updateMany({
        where: { toAccountId: mergeId },
        data: { toAccountId: keepId, toAccountName: keep.name },
      });
      // 1b. Transfers that used to move money between the two duplicates are
      // no-ops once both legs live on the kept account; drop them.
      await tx.txRecord.deleteMany({ where: { accountId: keepId, toAccountId: keepId } });

      // 2. Business transaction tables (business-side and cash-side fields).
      await tx.fundTransaction.updateMany({ where: { fundAccountId: mergeId }, data: { fundAccountId: keepId } });
      await tx.fundTransaction.updateMany({ where: { cashAccountId: mergeId }, data: { cashAccountId: keepId } });
      await tx.fundTransactionCashFlow.updateMany({ where: { accountId: mergeId }, data: { accountId: keepId } });
      await tx.insuranceTransaction.updateMany({ where: { accountId: mergeId }, data: { accountId: keepId } });
      await tx.insuranceTransaction.updateMany({ where: { cashAccountId: mergeId }, data: { cashAccountId: keepId } });
      await tx.wealthTransaction.updateMany({ where: { accountId: mergeId }, data: { accountId: keepId } });
      await tx.wealthTransaction.updateMany({ where: { cashAccountId: mergeId }, data: { cashAccountId: keepId } });
      await tx.depositTransaction.updateMany({ where: { accountId: mergeId }, data: { accountId: keepId } });
      await tx.depositTransaction.updateMany({ where: { cashAccountId: mergeId }, data: { cashAccountId: keepId } });
      await tx.preciousMetalTransaction.updateMany({ where: { accountId: mergeId }, data: { accountId: keepId } });
      await tx.preciousMetalTransaction.updateMany({ where: { cashAccountId: mergeId }, data: { cashAccountId: keepId } });
      await tx.stockTransaction.updateMany({ where: { stockAccountId: mergeId }, data: { stockAccountId: keepId } });
      await tx.stockTransaction.updateMany({ where: { cashAccountId: mergeId }, data: { cashAccountId: keepId } });
      await tx.propertyTransaction.updateMany({ where: { accountId: mergeId }, data: { accountId: keepId } });
      await tx.propertyTransaction.updateMany({ where: { cashAccountId: mergeId }, data: { cashAccountId: keepId } });
      await tx.fxConversion.updateMany({ where: { fromAccountId: mergeId }, data: { fromAccountId: keepId } });
      await tx.fxConversion.updateMany({ where: { toAccountId: mergeId }, data: { toAccountId: keepId } });
      await tx.loanRateAdjustment.updateMany({ where: { accountId: mergeId }, data: { accountId: keepId } });

      // 2b. Scheduled plans (recurring invest / transfers / repayments).
      // cashAccountId has no cascade rule, so re-point it explicitly.
      await tx.regularInvestPlan.updateMany({ where: { accountId: mergeId }, data: { accountId: keepId } });
      await tx.regularInvestPlan.updateMany({ where: { cashAccountId: mergeId }, data: { cashAccountId: keepId } });

      // 2c. Credit-card installment plans must be moved BEFORE the account is
      // deleted: deleting the account would cascade-delete the plans, and each
      // plan cascades back into its (already moved) installment entries.
      await tx.creditCardInstallmentPlan.updateMany({ where: { accountId: mergeId }, data: { accountId: keepId } });

      // 3. Insurance products: re-point; dedupe against the kept account by
      // (name, policyNo) so the unique key cannot conflict.
      const mergedInsuranceProducts = await tx.insuranceProduct.findMany({ where: { accountId: mergeId } });
      for (const product of mergedInsuranceProducts) {
        const keptProduct = await tx.insuranceProduct.findFirst({
          where: { householdId, accountId: keepId, name: product.name, policyNo: product.policyNo ?? null },
          select: { id: true },
        });
        if (keptProduct) {
          await tx.insuranceTransaction.updateMany({
            where: { insuranceProductId: product.id },
            data: { insuranceProductId: keptProduct.id },
          });
          await tx.insuranceProduct.delete({ where: { id: product.id } });
        } else {
          await tx.insuranceProduct.update({ where: { id: product.id }, data: { accountId: keepId } });
        }
      }

      // 4. Property assets belong to the kept account after the merge.
      await tx.propertyAsset.updateMany({ where: { accountId: mergeId }, data: { accountId: keepId } });

      // 5. Aliases follow the kept account; drop aliases the kept account
      // already has so the (alias, accountId) unique key cannot conflict.
      const keptAliases = await tx.accountAlias.findMany({ where: { accountId: keepId }, select: { alias: true } });
      const keptAliasSet = new Set(keptAliases.map((row) => row.alias.trim().toLowerCase()));
      const mergedAliases = await tx.accountAlias.findMany({ where: { accountId: mergeId } });
      for (const alias of mergedAliases) {
        if (keptAliasSet.has(alias.alias.trim().toLowerCase())) {
          await tx.accountAlias.delete({ where: { id: alias.id } });
        } else {
          await tx.accountAlias.update({ where: { id: alias.id }, data: { accountId: keepId } });
        }
      }

      // 6. Per-account derived/config rows cannot be moved (per-account unique
      // keys); they are recomputable from the moved transactions or belong to
      // the merged card only.
      await tx.billOverride.deleteMany({ where: { accountId: mergeId } });
      await tx.creditCardBillingDay.deleteMany({ where: { accountId: mergeId } });
      await tx.creditCardCycle.deleteMany({ where: { accountId: mergeId } });
      await tx.fundConfirmDays.deleteMany({ where: { accountId: mergeId } });
      await tx.fundFeeRate.deleteMany({ where: { accountId: mergeId } });
      await tx.fundHolding.deleteMany({ where: { accountId: mergeId } });
      await tx.fundSnapshot.deleteMany({ where: { accountId: mergeId } });
      await tx.preciousMetalHolding.deleteMany({ where: { accountId: mergeId } });
      await tx.stockHolding.deleteMany({ where: { accountId: mergeId } });
      await tx.stockFeeRule.deleteMany({ where: { accountId: mergeId } });

      // 7. Usage statistics carry over, then the merged account is removed.
      await tx.account.delete({ where: { id: mergeId } });
      await tx.account.update({
        where: { id: keepId },
        data: {
          usageCount: { increment: merged.usageCount },
          ...(lastUsedAt ? { lastUsedAt } : {}),
        },
      });
    });

    // Balances are derived from transactions: recompute the kept account so the
    // moved history is reflected immediately. The merged account is gone.
    await recalcAndSaveAccountBalance(keepId).catch((error) => {
      console.error("[accounts/merge] recalc balance failed", error);
    });
    if (keep.kind === "bank_credit") {
      invalidateCreditCardCycleCacheForAccountIds([keepId]);
    }
    revalidateAfterSettingsChange();

    return NextResponse.json({ ok: true, keepId, mergedId: mergeId });
  } catch (e) {
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: e instanceof Error ? e.message : "合并失败" }, { status: 500 });
  }
}
