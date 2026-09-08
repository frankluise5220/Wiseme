import { AccountKind, Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { computeLoanPrincipalBalancesAsOf } from "@/lib/server/account-balance";
import { ACTIVE_DEBT_EPSILON } from "@/lib/server/debt-view-data";

type CollateralClient = Prisma.TransactionClient | typeof prisma;

// 终态资产（已售出/已处置/已删除）不参与抵押状态联动，与 debt-actions 的
// syncCollateralAssetLink、recalcPropertyAssetsFromTransactions 的终态口径一致。
const NON_TERMINAL_ASSET_STATUS = { notIn: ["sold", "disposed", "deleted"] };

/**
 * 贷款结清后自动解除关联固定资产的抵押状态。
 *
 * 结清口径与债务视图一致：贷款本金余额（截至今天，未来日期的流水不计入）
 * |balance| <= ACTIVE_DEBT_EPSILON 视为已结清。对每个已结清的贷款账户，
 * 把仍关联到该账户的非终态固定资产重置为「正常」并清空抵押关联——
 * 这样资产可以立即再抵押给其他贷款（DebtTransactionModal 的可选资产过滤
 * 和服务端 COLLATERAL_ASSET_ALREADY_MORTGAGED 校验都只看 mortgageLoanAccountId）。
 *
 * 注意：解除后关联不可自动恢复（关联已被清空）。若之后删除还款流水使贷款
 * 重新出现欠款，或用同一贷款账户再次借入，需要用户重新选择抵押资产
 * （borrow_in 的 syncCollateralAssetLink 会重新建立关联）。
 */
export async function releaseMortgagedAssetsForSettledLoanAccounts(
  client: CollateralClient,
  params: {
    householdId: string;
    debtAccountIds: string[];
    asOfDate?: Date;
  },
) {
  const debtAccountIds = Array.from(new Set(params.debtAccountIds.filter(Boolean)));
  if (debtAccountIds.length === 0) return;

  const linkedAssets = await client.propertyAsset.findMany({
    where: {
      householdId: params.householdId,
      mortgageLoanAccountId: { in: debtAccountIds },
      deletedAt: null,
      status: NON_TERMINAL_ASSET_STATUS,
    },
    select: { id: true, mortgageLoanAccountId: true },
  });
  if (linkedAssets.length === 0) return;

  const linkedAccountIds = Array.from(
    new Set(linkedAssets.map((asset) => asset.mortgageLoanAccountId ?? "").filter(Boolean)),
  );
  const loanAccounts = await client.account.findMany({
    where: { householdId: params.householdId, id: { in: linkedAccountIds }, kind: AccountKind.loan },
    select: { id: true, kind: true },
  });
  if (loanAccounts.length === 0) return;

  const balances = await computeLoanPrincipalBalancesAsOf(
    loanAccounts,
    { householdId: params.householdId },
    params.asOfDate ?? new Date(),
    { client },
  );
  const settledAccountIds = loanAccounts
    .filter((account) => (balances.get(account.id) ?? 0) >= -ACTIVE_DEBT_EPSILON)
    .map((account) => account.id);
  if (settledAccountIds.length === 0) return;

  await client.propertyAsset.updateMany({
    where: {
      householdId: params.householdId,
      mortgageLoanAccountId: { in: settledAccountIds },
      deletedAt: null,
      status: NON_TERMINAL_ASSET_STATUS,
    },
    data: { status: "active", mortgageLoanAccountId: null },
  });
}
