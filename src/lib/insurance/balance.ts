import { prisma } from "@/lib/db/prisma";
import { isInsuranceBalanceMetric } from "@/lib/insurance/display";
import { insuranceCashValueDelta } from "@/lib/insurance/transaction";

function localDateKey(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function computeInsuranceAccountDisplayBalances(
  accountIds: string[],
  hidFilter?: { householdId?: string },
) {
  const result = new Map<string, number>();
  const normalizedAccountIds = accountIds.filter(Boolean);
  for (const accountId of normalizedAccountIds) {
    result.set(accountId, 0);
  }
  if (normalizedAccountIds.length === 0) return result;

  const products = await prisma.insuranceProduct.findMany({
    where: {
      ...(hidFilter ?? {}),
      accountId: { in: normalizedAccountIds },
    },
    select: {
      id: true,
      accountId: true,
      productType: true,
      accountingType: true,
      cashValueEnabled: true,
    },
  });

  const balanceProductIds = new Set(
    products
      .filter((product) => isInsuranceBalanceMetric(product.productType, product.accountingType, product.cashValueEnabled))
      .map((product) => product.id),
  );
  if (balanceProductIds.size === 0) return result;

  const entries = await prisma.insuranceTransaction.findMany({
    where: {
      ...(hidFilter ?? {}),
      deletedAt: null,
      insuranceProductId: { in: Array.from(balanceProductIds) },
    },
    select: {
      accountId: true,
      tradeDate: true,
      amount: true,
      action: true,
      insuranceProductId: true,
    },
  });

  const todayKey = localDateKey(new Date());
  const productAccountIdById = new Map(products.map((product) => [product.id, product.accountId]));
  for (const entry of entries) {
    if (localDateKey(entry.tradeDate) > todayKey) continue;
    const productId = entry.insuranceProductId ?? "";
    const accountId = productAccountIdById.get(productId);
    if (!accountId) continue;
    result.set(accountId, (result.get(accountId) ?? 0) + insuranceCashValueDelta(entry));
  }

  return result;
}
