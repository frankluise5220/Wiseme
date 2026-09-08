import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getApiHouseholdScope } from "@/lib/server/api-auth";

export const runtime = "nodejs";

function corsHeaders() {
  return {
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  } as const;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function GET(req: Request) {
  let scope;
  try {
    scope = await getApiHouseholdScope(req);
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "UNAUTHORIZED", error: e instanceof Error ? e.message : "未授权" },
      { status: 401, headers: corsHeaders() },
    );
  }

  const url = new URL(req.url);
  const accountName = (url.searchParams.get("accountName") ?? "").trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? "200") || 200, 1), 1000);
  const matchedAccountIds = accountName
    ? (
        await prisma.account.findMany({
          where: { ...scope.hidFilter, name: accountName },
          select: { id: true },
        })
      ).map((account) => account.id)
    : [];
  const where = {
    ...scope.hidFilter,
    ...(accountName
      ? matchedAccountIds.length > 0
        ? { OR: [{ accountId: { in: matchedAccountIds } }, { toAccountId: { in: matchedAccountIds } }] }
        : { id: "__no_matching_account__" }
      : {}),
  };

  const entries = await prisma.txRecord.findMany({
    where,
    include: {
      account: { include: { Institution: { select: { name: true } } } },
      toAccount: { include: { Institution: { select: { name: true } } } },
      CreditCardInstallmentPlan: { select: { sourceType: true, sourceStatementMonth: true } },
    },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: limit,
  });

  const items = entries.map((e) => ({
    id: e.id,
    transactionId: e.id,
    date: e.date.toISOString(),
    postedAt: e.postedAt ? e.postedAt.toISOString() : null,
    type: e.type,
    amount: e.amount,
    accountId: e.accountId,
    accountName: e.account?.name ?? e.accountName,
    accountKind: e.account?.kind ?? null,
    accountInstitutionName: e.account?.Institution?.name ?? "",
    toAccountId: e.toAccountId,
    toAccountName: e.toAccount?.name ?? e.toAccountName,
    toAccountKind: e.toAccount?.kind ?? null,
    toAccountInstitutionName: e.toAccount?.Institution?.name ?? "",
    categoryName: e.categoryName,
    note: e.note,
    creditCardInstallmentPlanId: e.creditCardInstallmentPlanId,
    installmentNo: e.installmentNo,
    installmentTotal: e.installmentTotal,
    installmentPrincipal: e.installmentPrincipal,
    installmentInterest: e.installmentInterest,
    installmentRole: e.installmentRole,
    installmentSourceType: e.CreditCardInstallmentPlan?.sourceType ?? null,
    installmentSourceStatementMonth: e.CreditCardInstallmentPlan?.sourceStatementMonth ?? null,
    counterparty: null,
    sourceText: null,
  }));

  return NextResponse.json(
    {
      ok: true,
      items,
    },
    { headers: corsHeaders() },
  );
}
