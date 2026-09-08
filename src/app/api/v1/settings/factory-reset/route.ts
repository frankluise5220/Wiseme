import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { verifyPassword } from "@/lib/auth/password";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";

export const runtime = "nodejs";

/**
 * POST /api/v1/settings/factory-reset
 *
 * System initialization deletes all ledgers, users, business records, and local
 * settings, returning the deployment to first-use setup state.
 *
 * Security requirements:
 * - The current signed-in user must be an administrator.
 * - The request must submit that user's current password.
 * Body: { password: string }
 */
export async function POST(req: NextRequest) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Please sign in first." }, { status: 401 });
  }
  if (!isAdmin(currentUser)) {
    return NextResponse.json({ ok: false, code: "ADMIN_REQUIRED", error: "Administrator permission is required." }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { password?: string } | null;
  const password = (body?.password ?? "").trim();
  if (!password) {
    return NextResponse.json({ ok: false, code: "PASSWORD_REQUIRED", error: "Current user password is required." }, { status: 400 });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: currentUser.id },
    select: { passwordHash: true },
  });
  if (!dbUser?.passwordHash) {
    return NextResponse.json({ ok: false, code: "PASSWORD_NOT_SET", error: "Current user password is not set." }, { status: 400 });
  }
  const matched = await verifyPassword(password, dbUser.passwordHash);
  if (!matched) {
    return NextResponse.json({ ok: false, code: "INVALID_PASSWORD", error: "Current user password is incorrect." }, { status: 401 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.entryBusinessLink.deleteMany();
    await tx.fundTransactionCashFlow.deleteMany();
    await tx.fxConversion.deleteMany();
    await tx.entryTag.deleteMany();
    await tx.attachment.deleteMany();

    await tx.creditCardInstallmentPlan.deleteMany();
    await tx.loanRateAdjustment.deleteMany();
    await tx.regularInvestPlan.deleteMany();

    await tx.fundTransaction.deleteMany();
    await tx.insuranceTransaction.deleteMany();
    await tx.wealthTransaction.deleteMany();
    await tx.depositTransaction.deleteMany();
    await tx.preciousMetalTransaction.deleteMany();
    await tx.stockTransaction.deleteMany();
    await tx.propertyTransaction.deleteMany();

    await tx.txRecord.deleteMany();

    await tx.propertyValuation.deleteMany();
    await tx.propertyAsset.deleteMany();
    await tx.insuranceProduct.deleteMany();
    await tx.insuranceProductMaster.deleteMany();
    await tx.wealthProduct.deleteMany();

    await tx.fundHolding.deleteMany();
    await tx.fundSnapshot.deleteMany();
    await tx.fundConfirmDays.deleteMany();
    await tx.fundFeeRate.deleteMany();
    await tx.preciousMetalHolding.deleteMany();
    await tx.stockHolding.deleteMany();
    await tx.stockFeeRule.deleteMany();

    await tx.billOverride.deleteMany();
    await tx.creditCardCycle.deleteMany();
    await tx.accountAlias.deleteMany();

    await tx.stockPriceCache.deleteMany();
    await tx.stockSecurity.deleteMany();
    await tx.stockMarketFeeRule.deleteMany();

    await tx.preciousMetalType.deleteMany();
    await tx.preciousMetalUnit.deleteMany();

    await tx.account.deleteMany();
    await tx.accountGroup.deleteMany();

    await tx.statementRecognitionRule.deleteMany();
    await tx.category.updateMany({ data: { parentId: null } });
    await tx.category.deleteMany();
    await tx.counterparty.deleteMany();
    await tx.institution.deleteMany();
    await tx.importBatch.deleteMany();
    await tx.fundQueryApi.deleteMany();
    await tx.fxRate.deleteMany();
    await tx.emailAccount.deleteMany();
    await tx.tag.deleteMany();

    await tx.userSettings.deleteMany();
    await tx.passwordResetToken.deleteMany();
    await tx.user.deleteMany();
    await tx.household.deleteMany();

    await tx.undoOperation.deleteMany();
    await tx.distillLog.deleteMany();
    await tx.commandTestResult.deleteMany();
    await tx.commandAlias.deleteMany();
    await tx.fundNavCache.deleteMany();
    await tx.stockBrokerageCatalog.deleteMany();
    await tx.systemSetting.deleteMany();
    await tx.accessKey.deleteMany();
    await tx.aiModel.deleteMany();
    await tx.aiChannel.deleteMany();
  }, { timeout: 60_000 });

  return NextResponse.json({ ok: true });
}
