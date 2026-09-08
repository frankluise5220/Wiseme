import { AccountKind } from "@prisma/client";
import { notFound, redirect } from "next/navigation";

import { getInvestmentAccountView } from "@/lib/account-kind-utils";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const dynamic = "force-dynamic";

export default async function FundDetailPage({ params }: { params: Promise<{ accountId: string; fundCode: string }> }) {
  const { accountId, fundCode } = await params;
  const ctx = await getHouseholdScope();
  const account = await prisma.account.findFirst({
    where: {
      id: accountId,
      kind: AccountKind.investment,
      isPlaceholder: { not: true },
      ...ctx.hidFilter,
    },
    select: {
      id: true,
      investProductType: true,
    },
  });
  if (!account) notFound();

  const query = new URLSearchParams();
  query.set("accountId", account.id);
  query.set("view", getInvestmentAccountView(account));
  query.set("fundCode", fundCode);
  redirect(`/?${query.toString()}`);
}
