"use server";

import { FundSubtype } from "@prisma/client";
import { getFundArrivalDays, getFundConfirmDays } from "@/lib/fund/confirmDays";
import { getFundFeeRateByDate } from "@/lib/fund/feeRate";
import { getAccountFundUnitsDecimals, roundFundUnits } from "@/lib/fund/unit-precision";
import { calculateConfirmedBuyUnits } from "@/lib/fund/refund-link";
import { ensureFundTransactionCashFlowLinks, findFundTransactionForEntryId } from "@/lib/fund/transactions";
import { getFundNav } from "@/lib/fund/navCache";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { toNumber, addWorkdaysUtc } from "@/lib/date-utils";
import { prisma } from "@/lib/db/prisma";

function ymdUtc(d: Date) {
  return d.toISOString().slice(0, 10);
}

export async function fillFundNavFromCache(formData: FormData) {
  const entryId = String(formData.get("entryId") ?? "").trim();
  if (!entryId) return { ok: false as const, error: "缺少 entryId" };

  try {
    const fundTransaction = await findFundTransactionForEntryId(prisma, { id: entryId });

    if (!fundTransaction || fundTransaction.deletedAt) return { ok: false as const, error: "基金记录不存在" };
    if (!fundTransaction.fundCode) return { ok: false as const, error: "该记录无基金代码" };

    const isRedeemFill = fundTransaction.fundSubtype === "redeem" || fundTransaction.fundSubtype === "switch_out";
    const investmentAccId = fundTransaction.fundAccountId;
    if (!investmentAccId) return { ok: false as const, error: "该记录没有关联投资账户" };

    const applyDate = ymdUtc(fundTransaction.applyDate);
    const confirmDate = fundTransaction.confirmDate
      ? ymdUtc(fundTransaction.confirmDate)
      : addWorkdaysUtc(applyDate, await getFundConfirmDays(investmentAccId, fundTransaction.fundCode));
    const navDate = new Date(`${confirmDate}T00:00:00.000Z`);
    const navData = await getFundNav(fundTransaction.fundCode, navDate, investmentAccId);

    if (!navData) {
      return { ok: false as const, error: `API 未能获取 ${fundTransaction.fundCode} 在 ${confirmDate} 的净值，确认日期可能是非交易日，或基金查询API未配置` };
    }
    if (!navData.dateMatch) {
      return { ok: false as const, error: `${fundTransaction.fundCode} 在 ${confirmDate} 无净值，该日期可能是非交易日，请检查确认日期是否正确` };
    }

    const nav = navData.nav;
    const amount = Math.abs(toNumber(fundTransaction.grossAmount));

    // Look up the fee rate from the fee rate store (by confirm date)
    const arrivalDays = await getFundArrivalDays(investmentAccId, fundTransaction.fundCode);
    const arrivalDateStr = arrivalDays > 0 ? addWorkdaysUtc(confirmDate, arrivalDays) : confirmDate;
    const arrivalDate = new Date(Date.UTC(parseInt(arrivalDateStr.slice(0, 4)), parseInt(arrivalDateStr.slice(5, 7)) - 1, parseInt(arrivalDateStr.slice(8, 10))));
    const feeType = isRedeemFill ? "redeem" : "buy";
    const feeRateRaw = await getFundFeeRateByDate(investmentAccId, fundTransaction.fundCode, navDate, feeType);
    const feeRate = feeRateRaw / 100;
    const fundUnitsDecimals = await getAccountFundUnitsDecimals(investmentAccId);
    const refundAmount = fundTransaction.fundSubtype === FundSubtype.buy ? Math.abs(toNumber(fundTransaction.refundAmount)) : 0;
    const confirmedAmount = fundTransaction.fundSubtype === FundSubtype.buy
      ? Math.max(0, amount - refundAmount)
      : amount;
    const fee = confirmedAmount * feeRate;
    const units = isRedeemFill
      ? (nav * (1 - feeRate) > 0 ? roundFundUnits(amount / (nav * (1 - feeRate)), fundUnitsDecimals) : null)
      : calculateConfirmedBuyUnits({
          grossAmount: amount,
          refundAmount,
          fee,
          nav,
          roundUnits: (value) => roundFundUnits(value, fundUnitsDecimals),
        });

    // Update NAV, confirm date, fee, and units
    const updateData: {
      confirmDate: Date;
      nav: number;
      fee: number;
      units?: number;
      fundName?: string;
      arrivalDate?: Date;
    } = {
      confirmDate: navDate,
      nav,
      fee,
      arrivalDate,
    };
    if (units != null) {
      updateData.units = units;
    }
    if (navData.name) {
      updateData.fundName = navData.name;
    }

    await prisma.$transaction(async (tx) => {
      await tx.fundTransaction.update({
        where: { id: fundTransaction.id },
        data: updateData,
      });
      await ensureFundTransactionCashFlowLinks(tx, [fundTransaction.id]);
    });

    await recalcFundPositions(investmentAccId, [fundTransaction.fundCode]).catch(() => {});
    // revalidation handled by FundShell optimistic update

    return { ok: true as const, nav, units, fee, confirmDate, arrivalDate: arrivalDateStr };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : "获取净值失败" };
  }
}
