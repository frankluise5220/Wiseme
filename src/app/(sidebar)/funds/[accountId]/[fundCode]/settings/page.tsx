import { AccountKind } from "@prisma/client";
import { notFound } from "next/navigation";

import { FundProfileSettingsClient, type FundProfileSettingsData } from "@/components/FundProfileSettingsClient";
import type { SmartSelectOption } from "@/components/SmartSelect";
import { getInvestmentAccountView } from "@/lib/account-kind-utils";
import { prisma } from "@/lib/db/prisma";
import { fundTradingCalendarForProfile, getFundProfile } from "@/lib/fund/fundProfile";
import { getHouseholdScope } from "@/lib/server/household-scope";

export const dynamic = "force-dynamic";

export default async function FundProfileSettingsPage({
  params,
}: {
  params: Promise<{ accountId: string; fundCode: string }>;
}) {
  const { accountId, fundCode: rawFundCode } = await params;
  const fundCode = rawFundCode.trim();
  if (!/^\d{6}$/.test(fundCode)) notFound();

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
      name: true,
      investProductType: true,
      Institution: { select: { name: true, shortName: true } },
    },
  });
  if (!account) notFound();

  const [profile, holding, latestFundTransaction, latestLegacyTransaction, fundCompanyInstitutions] = await Promise.all([
    getFundProfile(fundCode),
    prisma.fundHolding.findFirst({
      where: { accountId: account.id, fundCode },
      select: { id: true },
    }),
    prisma.fundTransaction.findFirst({
      where: { fundAccountId: account.id, fundCode, deletedAt: null },
      select: { fundName: true },
      orderBy: [{ confirmDate: "desc" }, { createdAt: "desc" }],
    }),
    prisma.txRecord.findFirst({
      where: { householdId: ctx.householdId, deletedAt: null, fundCode, toAccountId: account.id },
      select: { fundName: true },
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    }),
    prisma.institution.findMany({
      where: { householdId: ctx.householdId, type: "fund_company" },
      select: { id: true, name: true, shortName: true, type: true },
      orderBy: { name: "asc" },
    }),
  ]);

  if (!holding && !latestFundTransaction && !latestLegacyTransaction) notFound();

  const profileData: FundProfileSettingsData = {
    fundCode,
    fundName: profile?.fundName ?? latestFundTransaction?.fundName ?? latestLegacyTransaction?.fundName ?? null,
    fundCompany: profile?.fundCompany ?? null,
    custodian: profile?.custodian ?? null,
    manager: profile?.manager ?? null,
    navDateOffset: profile?.navDateOffset ?? 0,
    tradingCalendar: profile ? fundTradingCalendarForProfile(profile) : "cn_fund",
  };
  const institutionName = account.Institution?.shortName?.trim() || account.Institution?.name?.trim() || null;
  const backQuery = new URLSearchParams({ accountId: account.id, view: getInvestmentAccountView(account), fundCode });

  return (
    <FundProfileSettingsClient
      account={{ id: account.id, name: account.name, institutionName }}
      profile={profileData}
      fundCompanyOptions={fundCompanyInstitutions.map((institution): SmartSelectOption => ({
        id: institution.id,
        label: institution.name,
        subLabel: institution.shortName?.trim() || undefined,
        kind: institution.type,
      }))}
      backHref={`/?${backQuery.toString()}`}
    />
  );
}
