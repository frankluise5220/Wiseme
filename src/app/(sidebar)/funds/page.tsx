import { AccountKind, FundProductType } from "@prisma/client";
import { redirect } from "next/navigation";

import { getInvestmentAccountView } from "@/lib/account-kind-utils";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const dynamic = "force-dynamic";

export default async function FundsPage({
  searchParams,
}: {
  searchParams?: Promise<{ accountId?: string }>;
}) {
  const params = await searchParams;
  const requestedAccountId = typeof params?.accountId === "string" ? params.accountId.trim() : "";
  const ctx = await getHouseholdScope();

  const fundAccounts = await prisma.account.findMany({
    where: {
      kind: AccountKind.investment,
      investProductType: { in: [FundProductType.fund, FundProductType.money] },
      isActive: true,
      isPlaceholder: { not: true },
      ...ctx.hidFilter,
    },
    select: {
      id: true,
      investProductType: true,
    },
    orderBy: [{ name: "asc" }],
  });

  const selectedAccount = requestedAccountId
    ? fundAccounts.find((account) => account.id === requestedAccountId)
    : fundAccounts[0];

  if (!selectedAccount) {
    redirect("/investments");
  }

  redirect(`/?accountId=${encodeURIComponent(selectedAccount.id)}&view=${getInvestmentAccountView(selectedAccount)}`);
}
