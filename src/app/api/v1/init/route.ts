/**
 * API: POST /api/v1/init
 *
 * Initialization — batch-creates starting balances and fund holdings.
 *
 * Body:
 * {
 *   accountId: string,           // current investment account ID (optional, used for fund holdings)
 *   accountBalances: Array<{     // regular account balance initialization
 *     accountId: string;
 *     balance: number;           // positive = income direction, negative = expense direction
 *     date: string;              // ISO date
 *   }>;
 *   fundHoldings: Array<{        // fund holding initialization
 *     fundCode: string;
 *     units: number;
 *     avgCost: number;
 *     lastBuyDate: string;       // ISO date
 *     arrivalDate?: string;      // ISO date
 *     historicalProfit: number;  // historical realized profit/loss (positive = profit, negative = loss)
 *     investmentAccountId: string;
 *     cashAccountId?: string;
 *     regularInvest?: {          // regular investment plan (optional)
 *       amount: number;
 *       intervalUnit: string;    // day|week|biweek|month|year
 *       intervalValue: number;
 *       cashAccountId: string;
 *       confirmDays?: number;
 *       arrivalDays?: number;
 *       feeRate?: number;
 *     };
 *   }>;
 * }
 *
 * Response: { ok: true, message, details } or { ok: false, error }
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { TransactionType, AccountKind, FundCashFlowKind, FundSubtype, RegularInvestStatus } from "@prisma/client";
import { recalcFundPositions } from "@/lib/fund/recalcPosition";
import { createFundTransactionWithCashFlows } from "@/lib/fund/transactions";
import { ENTRY_ORIGIN_MANUAL } from "@/lib/transaction-semantics";
import { recalcAndSaveAccountBalance } from "@/lib/server/account-balance";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { logger } from "@/lib/logger";
import { setFundConfirmDaysInTx, setFundArrivalDaysInTx } from "@/lib/fund/confirmDays";
import { setFundFeeRateByDateInTx } from "@/lib/fund/feeRate";
import { BALANCE_INITIALIZATION_SOURCE, encodeBalanceReconcileTarget } from "@/lib/balance-reconcile";

export async function POST(req: NextRequest) {
  try {
    const { householdId, hidFilter } = await getHouseholdScope();
    const body = await req.json();
    const { accountBalances = [], fundHoldings = [], accountId: mainAccountId } = body;

    if (!accountBalances.length && !fundHoldings.length) {
      return NextResponse.json({ ok: false, code: "INIT_DATA_EMPTY", error: "请提供至少一条初始化记录" }, { status: 400 });
    }

    const results: string[] = [];

    await prisma.$transaction(async (tx) => {
      // === 1. Account balance initialization ===
      if (accountBalances.length > 0) {
        // Batch-fetch account info
        const balanceAccountIds = accountBalances.map((a: any) => a.accountId);
        const accounts = await tx.account.findMany({
          where: { id: { in: balanceAccountIds }, ...hidFilter },
        });
        const accountMap = new Map(accounts.map((a) => [a.id, a]));

        for (const item of accountBalances) {
          const acc = accountMap.get(item.accountId);
          if (!acc) {
            results.push(`账户 ${item.accountId} 不存在，跳过`);
            continue;
          }

          const balance = Number(item.balance ?? 0);
          if (!Number.isFinite(balance) || balance === 0) {
            results.push(`${acc.name} 余额为 0，跳过`);
            continue;
          }

          const date = item.date ? new Date(item.date) : new Date();
          const isCredit = acc.kind === AccountKind.bank_credit || acc.kind === AccountKind.loan || acc.kind === AccountKind.settlement;
          const targetBalance = isCredit ? -Math.abs(balance) : balance;

          // Check whether an initialization record already exists
          const existingInit = await tx.txRecord.findFirst({
            where: {
              accountId: acc.id,
              source: BALANCE_INITIALIZATION_SOURCE,
              deletedAt: null,
            },
          });
          if (existingInit) {
            results.push(`${acc.name} 已有初始化记录，跳过`);
            continue;
          }

          await tx.txRecord.create({
            data: {
              householdId,
              date,
              type: TransactionType.income,
              accountId: acc.id,
              accountName: acc.name,
              amount: 0,
              categoryName: "初始余额",
              source: BALANCE_INITIALIZATION_SOURCE,
              note: null,
              toNote: encodeBalanceReconcileTarget(targetBalance),
            },
          });

          // Recalculate the account balance
          await recalcAndSaveAccountBalance(acc.id).catch(logger.catchLog("recalc balance", "init"));

          results.push(`${acc.name} 初始余额: ${targetBalance.toFixed(2)} 元`);
        }
      }

      // === 2. Fund holding initialization ===
      if (fundHoldings.length > 0) {
        const investIds = [...new Set(fundHoldings.map((f: any) => f.investmentAccountId))].filter(Boolean) as string[];
        const investAccounts = await tx.account.findMany({
          where: { id: { in: investIds }, ...hidFilter },
        });
        const investAccountMap = new Map(investAccounts.map((a) => [a.id, a]));

        // Batch-fetch cash accounts
        const cashIds = [...new Set(fundHoldings.map((f: any) => f.cashAccountId).filter(Boolean))] as string[];
        const cashAccounts = cashIds.length > 0
          ? await tx.account.findMany({ where: { id: { in: cashIds } }, select: { id: true, name: true } })
          : [];
        const cashAccountMap = new Map(cashAccounts.map((a) => [a.id, a.name]));

        for (const item of fundHoldings) {
          const investAcc = investAccountMap.get(item.investmentAccountId);
          if (!investAcc) {
            results.push(`投资账户 ${item.investmentAccountId} 不存在，跳过`);
            continue;
          }

          const fundCode = item.fundCode;
          if (!fundCode || !item.units || !item.avgCost || !item.lastBuyDate) {
            results.push(`${fundCode || "未知"} 缺少必填字段，跳过`);
            continue;
          }

          const units = Math.abs(Number(item.units));
          const avgCost = Math.abs(Number(item.avgCost));
          const totalCost = units * avgCost;
          const historicalProfit = Number(item.historicalProfit ?? 0);
          const date = new Date(item.lastBuyDate);
          const arrivalDate = item.arrivalDate ? new Date(item.arrivalDate) : null;
          const cashAccName = item.cashAccountId ? (cashAccountMap.get(item.cashAccountId) ?? "资金账户") : "资金账户";

          // Create the buy business record; TxRecord only stores real cash-account cash flows.
          await createFundTransactionWithCashFlows(tx, {
            householdId,
            fundAccountId: investAcc.id,
            cashAccountId: item.cashAccountId ?? null,
            fundCode,
            fundName: fundCode,
            fundProductType: investAcc.investProductType ?? "fund",
            fundSubtype: FundSubtype.buy,
            source: "initialization",
            entryOrigin: ENTRY_ORIGIN_MANUAL,
            applyDate: date,
            confirmDate: date,
            arrivalDate: arrivalDate ?? date,
            grossAmount: totalCost,
            nav: avgCost,
            units,
            note: `[初始化]${fundCode} 持仓初始 ${units} 份`,
            cashFlows: item.cashAccountId
              ? [{
                  kind: FundCashFlowKind.buy_out,
                  date,
                  accountId: item.cashAccountId,
                  accountName: cashAccName,
                  amount: -totalCost,
                  source: "initialization",
                  note: `[初始化]${fundCode} 持仓初始 ${units} 份`,
                }]
              : [],
          });

          // If there is historical profit/loss, create a cash dividend record; recalcPositions accumulates it into historicalProfit
          if (historicalProfit !== 0) {
            const divAmount = Math.abs(historicalProfit);
            const cashId = item.cashAccountId ?? investAcc.id;
            const cashName = cashAccName;
            await createFundTransactionWithCashFlows(tx, {
              householdId,
              fundAccountId: investAcc.id,
              cashAccountId: item.cashAccountId ?? null,
              fundCode,
              fundName: fundCode,
              fundProductType: investAcc.investProductType ?? "fund",
              fundSubtype: FundSubtype.dividend_cash,
              source: "initialization",
              entryOrigin: ENTRY_ORIGIN_MANUAL,
              applyDate: date,
              confirmDate: date,
              arrivalDate: arrivalDate ?? date,
              grossAmount: divAmount,
              arrivalAmount: divAmount,
              realizedProfit: historicalProfit,
              note: `[初始化]${fundCode} 历史已实现${historicalProfit > 0 ? "盈利" : "亏损"}`,
              cashFlows: item.cashAccountId
                ? [{
                    kind: FundCashFlowKind.dividend_in,
                    date: arrivalDate ?? date,
                    accountId: cashId,
                    accountName: cashName,
                    amount: historicalProfit > 0 ? divAmount : -divAmount,
                    source: "initialization",
                    note: `[初始化]${fundCode} 历史已实现${historicalProfit > 0 ? "盈利" : "亏损"}`,
                  }]
                : [],
            });
          }

          // Recalculate positions
          await recalcFundPositions(investAcc.id, [fundCode]).catch(logger.catchLog("recalc positions", "init"));
          await recalcAndSaveAccountBalance(investAcc.id).catch(logger.catchLog("recalc invest balance", "init"));
          if (item.cashAccountId && item.cashAccountId !== investAcc.id) {
            await recalcAndSaveAccountBalance(item.cashAccountId).catch(logger.catchLog("recalc cash balance", "init"));
          }

          results.push(`${fundCode} 持仓: ${units}份 × ${avgCost}元 = ${totalCost.toFixed(2)} 元${historicalProfit ? `, 历史盈亏 ${historicalProfit.toFixed(2)}` : ""}`);

          // === 3. Create a regular investment plan (if any) ===
          if (item.regularInvest) {
            const ri = item.regularInvest;
            const riCashAcc = ri.cashAccountId
              ? await tx.account.findUnique({ where: { id: ri.cashAccountId }, select: { id: true, name: true } })
              : null;

            // Check whether a regular investment plan for this fund already exists
            const existingPlan = await tx.regularInvestPlan.findFirst({
              where: { accountId: investAcc.id, fundCode, householdId },
            });
            if (existingPlan) {
              results.push(`${fundCode} 定投计划已存在，跳过`);
            } else {
              const riTxDate = ri.txDate ? new Date(ri.txDate) : date;
              const riConfirmDate = ri.confirmDate ? new Date(ri.confirmDate) : riTxDate;
              const confirmDays = ri.tPlusN != null ? Number(ri.tPlusN) : 0;
              const arrivalDate = ri.arrivalDate ? new Date(ri.arrivalDate) : null;

              await tx.regularInvestPlan.create({
                data: {
                  householdId,
                  accountId: investAcc.id,
                  accountName: investAcc.name,
                  cashAccountId: riCashAcc?.id ?? null,
                  cashAccountName: riCashAcc?.name ?? null,
                  fundCode,
                  fundName: fundCode,
                  amount: Math.abs(Number(ri.amount)),
                  intervalUnit: ri.intervalUnit as any,
                  intervalValue: Number(ri.intervalValue) || 1,
                  startDate: riTxDate,
                  nextRunDate: riTxDate,
                  status: RegularInvestStatus.active,
                  feeRate: ri.feeRate != null ? Number(ri.feeRate) : null,
                  confirmDays,
                  arrivalDays: arrivalDate
                    ? Math.max(0, Math.round((arrivalDate.getTime() - riConfirmDate.getTime()) / 86400000))
                    : null,
                },
              });

              // Write confirm days and the fee rate library in sync
              if (investAcc.id) {
                await setFundConfirmDaysInTx(tx, investAcc.id, fundCode, confirmDays);
              }
              if (arrivalDate && investAcc.id) {
                const arrivalDays = Math.max(0, Math.round((arrivalDate.getTime() - riConfirmDate.getTime()) / 86400000));
                await setFundArrivalDaysInTx(tx, investAcc.id, fundCode, arrivalDays);
              }
              if (ri.feeRate != null && investAcc.id) {
                await setFundFeeRateByDateInTx(tx, investAcc.id, fundCode, Number(ri.feeRate), date, "buy");
              }

              results.push(`${fundCode} 定投计划已创建: 每${ri.intervalUnit === "year" ? "年" : ri.intervalUnit === "month" ? "月" : ri.intervalUnit === "week" ? "周" : ri.intervalUnit === "biweek" ? "双周" : "天"} ${ri.amount} 元`);
            }
          }
        }
      }
    });

    return NextResponse.json({
      ok: true,
      message: `初始化完成，共 ${results.length} 条记录`,
      details: results,
    });
  } catch (e) {
    console.error("[init] Error:", e);
    return NextResponse.json(
      { ok: false, code: "INIT_FAILED", error: e instanceof Error ? e.message : "初始化失败" },
      { status: 500 }
    );
  }
}
