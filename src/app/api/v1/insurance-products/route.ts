import { NextRequest, NextResponse } from "next/server";
import { FundSubtype, InsuranceAccountingType, InsuranceProductType, InsuranceStatus, Prisma } from "@prisma/client";

import { isInsuranceAccount } from "@/lib/account-kind-utils";
import { verifyPassword } from "@/lib/auth/password";
import { getOrCreateInsuranceAccount } from "@/lib/insurance/autoAccount";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { assertInstitutionDisplayNamesUnique } from "@/lib/server/institution-name-unique";

const PRODUCT_TYPES = new Set<InsuranceProductType>([
  "savings",
  "dividend",
  "annuity",
  "universal",
  "investment_linked",
  "critical_illness",
  "medical",
  "accident",
  "term_life",
  "whole_life",
  "other",
]);

const ACCOUNTING_TYPES = new Set<InsuranceAccountingType>(["asset", "protection", "hybrid"]);
const STATUSES = new Set<InsuranceStatus>(["active", "matured", "surrendered", "lapsed"]);

function parseMoney(value: unknown) {
  if (value == null || value === "") return null;
  const num = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(num) ? num : null;
}

function parseDecimal(value: unknown) {
  if (value == null || value === "") return null;
  const num = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(num) ? num : null;
}

function parseIntOrNull(value: unknown) {
  if (value == null || value === "") return null;
  const num = Number.parseInt(String(value).trim(), 10);
  return Number.isFinite(num) ? num : null;
}

function parseDate(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getProductMasterDelegate() {
  return (prisma as unknown as { insuranceProductMaster?: typeof prisma.insuranceProductMaster }).insuranceProductMaster;
}

function productMasterIdData(productMaster: { id: string } | null) {
  return productMaster ? { productMasterId: productMaster.id } : {};
}

function isFamilyMember(item: { type: string | null } | null) {
  return !!item && item.type === "family_member";
}

function insurancePlanMemoFilters(productIds: string[]) {
  return productIds.map((productId) => ({
    memo: { contains: `"insuranceProductId":"${productId}"` },
  }));
}

function insurancePremiumPlanTypeFilter(): Prisma.RegularInvestPlanWhereInput {
  return {
    OR: [
      { taskType: "insurance_premium" },
      { fundCode: "insurance_premium" },
      { memo: { contains: `"type":"insurance_premium"` } },
    ],
  };
}

function insurancePremiumPlanProductFilter(productIds: string[]): Prisma.RegularInvestPlanWhereInput {
  return {
    AND: [
      insurancePremiumPlanTypeFilter(),
      { OR: insurancePlanMemoFilters(productIds) },
    ],
  };
}

function insurancePremiumEntryFilter(): Prisma.TxRecordWhereInput {
  return {
    OR: [
      { insuranceAction: "premium" },
      {
        insuranceAction: null,
        OR: [{ fundSubtype: FundSubtype.buy }, { fundSubtype: null }],
      },
    ],
  };
}

function insuranceRefundEntryFilter(): Prisma.TxRecordWhereInput {
  return {
    OR: [
      { insuranceAction: "refund" },
      {
        insuranceAction: null,
        fundSubtype: { in: [FundSubtype.redeem, FundSubtype.switch_out] },
      },
    ],
  };
}

async function ensureFamilyMemberInstitution(input: {
  householdId: string;
  personId: string | null;
  personName: string | null;
}) {
  if (input.personId) {
    const existing = await prisma.institution.findFirst({
      where: {
        id: input.personId,
        householdId: input.householdId,
        type: "family_member",
      },
    });
    if (existing) return existing;
  }
  const normalizedName = String(input.personName ?? "").trim();
  if (!normalizedName) return null;
  const matched = await prisma.institution.findFirst({
    where: {
      householdId: input.householdId,
      type: "family_member",
      OR: [{ name: normalizedName }, { shortName: normalizedName }],
    },
  });
  if (matched) return matched;
  await assertInstitutionDisplayNamesUnique(prisma, {
    householdId: input.householdId,
    name: normalizedName,
  });
  return prisma.institution.create({
    data: {
      householdId: input.householdId,
      type: "family_member",
      name: normalizedName,
      shortName: null,
    },
  });
}

async function resolveInsuranceOwnerGroup(input: {
  ownerGroupId: string | null;
  policyholderPerson: { name: string } | null;
  householdId: string;
}) {
  if (input.ownerGroupId) {
    return prisma.accountGroup.findFirst({ where: { id: input.ownerGroupId, householdId: input.householdId } });
  }
  if (input.policyholderPerson?.name?.trim()) {
    const name = input.policyholderPerson.name.trim();
    const existing = await prisma.accountGroup.findFirst({ where: { name, householdId: input.householdId } });
    if (existing) return existing;
    return prisma.accountGroup.create({ data: { name, householdId: input.householdId } });
  }
  return prisma.accountGroup.findFirst({
    where: { householdId: input.householdId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

async function getOrCreateProductMaster(input: {
  householdId: string;
  institutionId: string;
  name: string;
  shortName: string | null;
  productType: InsuranceProductType;
  accountingType: InsuranceAccountingType;
  currency: string;
  note?: string | null;
}) {
  const productMaster = getProductMasterDelegate();
  if (!productMaster) {
    console.warn("insuranceProductMaster delegate is unavailable; skipping insurance product master sync");
    return null;
  }
  return productMaster.upsert({
    where: {
      householdId_institutionId_name_productType: {
        householdId: input.householdId,
        institutionId: input.institutionId,
        name: input.name,
        productType: input.productType,
      },
    },
    update: {
      shortName: input.shortName,
      accountingType: input.accountingType,
      currency: input.currency,
      note: input.note ?? null,
    },
    create: {
      householdId: input.householdId,
      institutionId: input.institutionId,
      name: input.name,
      shortName: input.shortName,
      productType: input.productType,
      accountingType: input.accountingType,
      currency: input.currency,
      note: input.note ?? null,
    },
  });
}

function serializeProductMaster(item: {
  id: string;
  name: string;
  shortName: string | null;
  productType: InsuranceProductType;
  accountingType: InsuranceAccountingType;
  currency: string;
  institutionId: string;
  note: string | null;
  Institution?: { name: string; shortName: string | null } | null;
}) {
  return {
    id: item.id,
    name: item.name,
    shortName: item.shortName,
    productType: item.productType,
    accountingType: item.accountingType,
    currency: item.currency,
    institutionId: item.institutionId,
    institutionName: item.Institution?.name ?? "",
    institutionShortName: item.Institution?.shortName ?? "",
    note: item.note,
    status: "active",
  };
}

export async function GET(req: NextRequest) {
  const { hidFilter } = await getHouseholdScope();
  const includeMasters = new URL(req.url).searchParams.get("includeMasters") === "1";

  const products = await prisma.insuranceProduct.findMany({
    where: hidFilter,
    include: {
      Account: { select: { id: true, name: true, institutionId: true, groupId: true } },
      Institution: { select: { id: true, name: true, shortName: true } },
      OwnerGroup: { select: { id: true, name: true } },
      PolicyholderPerson: { select: { id: true, name: true, shortName: true, type: true } },
      InsuredUser: { select: { id: true, name: true } },
      InsuredPerson: { select: { id: true, name: true, shortName: true, type: true } },
    },
    orderBy: [{ Institution: { name: "asc" } }, { name: "asc" }],
  });

  for (const item of products) {
    if (!item.institutionId) continue;
    const productMaster = await getOrCreateProductMaster({
      householdId: item.householdId,
      institutionId: item.institutionId,
      name: item.name,
      shortName: item.shortName,
      productType: item.productType,
      accountingType: item.accountingType,
      currency: item.currency,
      note: item.note,
    });
    if (productMaster && item.productMasterId !== productMaster.id) {
      await prisma.insuranceProduct.update({
        where: { id: item.id },
        data: { productMasterId: productMaster.id },
      });
    }
    if (!item.ownerGroupId) continue;
    if (item.Account?.institutionId && item.Account?.groupId === item.ownerGroupId) continue;
    const repairedAccount = await getOrCreateInsuranceAccount(prisma, item.ownerGroupId, item.householdId, item.institutionId);
    if (repairedAccount.id !== item.accountId) {
      await prisma.insuranceProduct.update({
        where: { id: item.id },
        data: { accountId: repairedAccount.id, ...productMasterIdData(productMaster) },
      });
      await prisma.txRecord.updateMany({
        where: { insuranceProductId: item.id, source: "insurance" },
        data: {
          toAccountId: repairedAccount.id,
          toAccountName: repairedAccount.name,
        },
      });
      await prisma.insuranceTransaction.updateMany({
        where: { insuranceProductId: item.id },
        data: { accountId: repairedAccount.id },
      });
    }
  }

  const refreshedProducts = await prisma.insuranceProduct.findMany({
    where: hidFilter,
    include: {
      Account: { select: { id: true, name: true } },
      ProductMaster: { select: { id: true, name: true, shortName: true } },
      Institution: { select: { id: true, name: true, shortName: true } },
      OwnerGroup: { select: { id: true, name: true } },
      PolicyholderPerson: { select: { id: true, name: true, shortName: true, type: true } },
      InsuredUser: { select: { id: true, name: true } },
      InsuredPerson: { select: { id: true, name: true, shortName: true, type: true } },
    },
    orderBy: [{ Institution: { name: "asc" } }, { name: "asc" }],
  });

  const productIds = refreshedProducts.map((item) => item.id);
  const [latestPremiumRows, activePremiumPlans] = await Promise.all([
    productIds.length > 0
      ? prisma.insuranceTransaction.groupBy({
          by: ["insuranceProductId"],
          where: {
            householdId: hidFilter.householdId ?? undefined,
            insuranceProductId: { in: productIds },
            action: { in: ["premium", "additional_premium"] },
            deletedAt: null,
          },
          _max: { tradeDate: true },
        })
      : Promise.resolve([]),
    productIds.length > 0
      ? prisma.regularInvestPlan.findMany({
        where: {
          householdId: hidFilter.householdId ?? undefined,
          ...insurancePremiumPlanTypeFilter(),
          status: { in: ["active", "paused"] },
        },
          select: { memo: true, nextRunDate: true },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve([]),
  ]);

  const latestPremiumDateByProductId = new Map(
    latestPremiumRows
      .filter((item) => item.insuranceProductId && item._max?.tradeDate)
      .map((item) => [item.insuranceProductId as string, item._max!.tradeDate!.toISOString().slice(0, 10)]),
  );
  const nextPlannedPremiumDateByProductId = new Map<string, string>();
  for (const plan of activePremiumPlans) {
    const memo = String(plan.memo ?? "");
    const match = memo.match(/\"insuranceProductId\":\"([^\"]+)\"/);
    const productId = match?.[1];
    if (!productId || nextPlannedPremiumDateByProductId.has(productId) || !plan.nextRunDate) continue;
    nextPlannedPremiumDateByProductId.set(productId, plan.nextRunDate.toISOString().slice(0, 10));
  }

  const response: {
    ok: true;
    products: Array<Record<string, unknown>>;
    masters?: Array<Record<string, unknown>>;
  } = {
    ok: true,
    products: refreshedProducts.map((item) => ({
      id: item.id,
      productMasterId: item.productMasterId,
      productMasterName: item.ProductMaster?.name ?? item.name,
      productMasterShortName: item.ProductMaster?.shortName ?? item.shortName,
      name: item.name,
      shortName: item.shortName,
      productType: item.productType,
      accountingType: item.accountingType,
      policyNo: item.policyNo,
      status: item.status,
      currency: item.currency,
      accountId: item.accountId,
      institutionId: item.institutionId,
      ownerGroupId: item.ownerGroupId,
      policyholderPersonId: item.policyholderPersonId,
      insuredUserId: item.insuredUserId,
      insuredPersonId: item.insuredPersonId,
      beneficiaryName: item.beneficiaryName,
      startDate: item.startDate?.toISOString().slice(0, 10) ?? null,
      effectiveDate: item.effectiveDate?.toISOString().slice(0, 10) ?? null,
      maturityDate: item.maturityDate?.toISOString().slice(0, 10) ?? null,
      premiumMode: item.premiumMode,
      premiumFrequencyMonths: item.premiumFrequencyMonths,
      premiumAmount: item.premiumAmount ? Number(item.premiumAmount) : null,
      paymentTermYears: item.paymentTermYears ? Number(item.paymentTermYears) : null,
      coverageTermYears: item.coverageTermYears ? Number(item.coverageTermYears) : null,
      coverageAmount: item.coverageAmount ? Number(item.coverageAmount) : null,
      cashValueEnabled: item.cashValueEnabled,
      note: item.note,
      latestPremiumDate: latestPremiumDateByProductId.get(item.id) ?? null,
      nextPlannedPremiumDate: nextPlannedPremiumDateByProductId.get(item.id) ?? null,
      accountName: item.Account?.name ?? "",
      institutionName: item.Institution?.name ?? "",
      institutionShortName: item.Institution?.shortName ?? "",
      ownerGroupName: item.OwnerGroup?.name ?? "",
      policyholderPersonName: item.PolicyholderPerson?.name ?? "",
      insuredUserName: item.InsuredUser?.name ?? "",
      insuredPersonName: item.InsuredPerson?.name ?? "",
    })),
  };

  if (includeMasters) {
    const masters = await prisma.insuranceProductMaster.findMany({
      where: hidFilter,
      include: {
        Institution: { select: { name: true, shortName: true } },
      },
      orderBy: [{ Institution: { name: "asc" } }, { name: "asc" }],
    });
    response.masters = masters.map(serializeProductMaster);
  }

  return NextResponse.json(response);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ ok: false, code: "INVALID_REQUEST_BODY", error: "无效的请求体" }, { status: 400 });
    }

    const name = String(body.name ?? "").trim();
    const requestedAccountId = String(body.accountId ?? "").trim() || null;
    const shortName = String(body.shortName ?? "").trim() || null;
    const productTypeRaw = String(body.productType ?? "other").trim() as InsuranceProductType;
    const accountingTypeRaw = String(body.accountingType ?? "asset").trim() as InsuranceAccountingType;
    const statusRaw = String(body.status ?? "active").trim() as InsuranceStatus;
    const policyNo = String(body.policyNo ?? "").trim() || null;
    const currency = String(body.currency ?? "CNY").trim() || "CNY";
    const institutionId = String(body.institutionId ?? "").trim() || null;
    const ownerGroupId = String(body.ownerGroupId ?? "").trim() || null;
    const policyholderPersonIdInput = String(body.policyholderPersonId ?? "").trim() || null;
    const policyholderPersonNameInput = String(body.policyholderPersonName ?? "").trim() || null;
    const insuredUserId = String(body.insuredUserId ?? "").trim() || null;
    const insuredPersonIdInput = String(body.insuredPersonId ?? "").trim() || null;
    const insuredPersonNameInput = String(body.insuredPersonName ?? "").trim() || null;
    const beneficiaryName = String(body.beneficiaryName ?? "").trim() || null;
    const premiumMode = String(body.premiumMode ?? "").trim() || null;
    const premiumFrequencyMonths = parseIntOrNull(body.premiumFrequencyMonths);
    const premiumAmount = parseMoney(body.premiumAmount);
    const paymentTermYears = parseDecimal(body.paymentTermYears);
    const coverageTermYears = parseDecimal(body.coverageTermYears);
    const coverageAmount = parseMoney(body.coverageAmount);
    const cashValueEnabled = body.cashValueEnabled === false ? false : true;
    const note = String(body.note ?? "").trim() || null;
    const mode = String(body.mode ?? "").trim() || null;
    const requestedProductMasterId = String(body.productMasterId ?? "").trim() || null;

    if (!name) {
      return NextResponse.json({ ok: false, code: "MISSING_PRODUCT_NAME", error: "保险产品名称不能为空" }, { status: 400 });
    }
    const productType = PRODUCT_TYPES.has(productTypeRaw) ? productTypeRaw : "other";
    const accountingType = ACCOUNTING_TYPES.has(accountingTypeRaw) ? accountingTypeRaw : "asset";
    const status = STATUSES.has(statusRaw) ? statusRaw : "active";

    const { hidFilter } = await getHouseholdScope();
    const householdId = hidFilter.householdId;

    if (mode === "master") {
      if (!institutionId) {
        return NextResponse.json({ ok: false, code: "MISSING_INSTITUTION", error: "请选择承保机构" }, { status: 400 });
      }
      const institution = await prisma.institution.findFirst({ where: { id: institutionId, ...hidFilter } });
      if (!institution) {
        return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_FOUND", error: "承保机构不存在" }, { status: 400 });
      }
      if (institution.type !== "insurance") {
        return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_INSURER", error: "承保机构必须是保险公司" }, { status: 400 });
      }
      const duplicateMaster = await prisma.insuranceProductMaster.findFirst({
        where: { householdId, institutionId, name, productType },
        include: { Institution: { select: { name: true, shortName: true } } },
      });
      if (duplicateMaster) {
        return NextResponse.json({ ok: false, code: "PRODUCT_EXISTS", error: "该保险产品已存在" }, { status: 409 });
      }
      const createdMaster = await prisma.insuranceProductMaster.create({
        data: {
          householdId,
          institutionId,
          name,
          shortName,
          productType,
          accountingType,
          currency,
          note,
        },
        include: {
          Institution: { select: { name: true, shortName: true } },
        },
      });
      return NextResponse.json({
        ok: true,
        productMaster: serializeProductMaster(createdMaster),
      });
    }

    const ownerGroupFromInput = ownerGroupId
      ? await prisma.accountGroup.findFirst({ where: { id: ownerGroupId, householdId } })
      : null;
    const ownerGroupName = ownerGroupFromInput?.name ?? null;
    const [institution, policyholderPerson, insuredPerson, insuredUser] = await Promise.all([
      institutionId ? prisma.institution.findFirst({ where: { id: institutionId, ...hidFilter } }) : Promise.resolve(null),
      ensureFamilyMemberInstitution({
        householdId,
        personId: policyholderPersonIdInput,
        personName: policyholderPersonNameInput || ownerGroupName,
      }),
      ensureFamilyMemberInstitution({
        householdId,
        personId: insuredPersonIdInput,
        personName: insuredPersonNameInput,
      }),
      insuredUserId ? prisma.user.findFirst({ where: { id: insuredUserId, ...hidFilter } }) : Promise.resolve(null),
    ]);
    const policyholderPersonId = policyholderPerson?.id ?? null;
    const insuredPersonId = insuredPerson?.id ?? null;
    const ownerGroup = await resolveInsuranceOwnerGroup({ ownerGroupId, policyholderPerson, householdId });

    if (!institutionId) {
      return NextResponse.json({ ok: false, code: "MISSING_INSTITUTION", error: "请选择承保机构" }, { status: 400 });
    }
    if (institutionId && !institution) {
      return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_FOUND", error: "承保机构不存在" }, { status: 400 });
    }
    if (institution && institution.type !== "insurance") {
      return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_INSURER", error: "承保机构必须是保险公司" }, { status: 400 });
    }
    if (policyholderPersonIdInput && !isFamilyMember(policyholderPerson)) {
      return NextResponse.json({ ok: false, code: "POLICYHOLDER_NOT_FAMILY_MEMBER", error: "投保人必须是家庭成员" }, { status: 400 });
    }
    if (insuredPersonIdInput && !isFamilyMember(insuredPerson)) {
      return NextResponse.json({ ok: false, code: "INSURED_NOT_FAMILY_MEMBER", error: "被保险人必须是家庭成员" }, { status: 400 });
    }
    if (!ownerGroup) {
      return NextResponse.json({ ok: false, code: "OWNER_GROUP_NOT_FOUND", error: "没有可用于归档保险账户的所有人" }, { status: 400 });
    }
    if (insuredUserId && !insuredUser) {
      return NextResponse.json({ ok: false, code: "INSURED_USER_NOT_FOUND", error: "被保险人不存在" }, { status: 400 });
    }

    const account = requestedAccountId
      ? await prisma.account.findFirst({ where: { id: requestedAccountId, ...hidFilter } })
      : await getOrCreateInsuranceAccount(prisma, ownerGroup.id, householdId, institutionId);

    if (!account) {
      return NextResponse.json({ ok: false, code: "INSURANCE_ACCOUNT_NOT_FOUND", error: "保险账户不存在" }, { status: 400 });
    }
    if (!isInsuranceAccount(account)) {
      return NextResponse.json({ ok: false, code: "INVALID_INSURANCE_ACCOUNT", error: "请选择保险账户" }, { status: 400 });
    }

    const duplicate = await prisma.insuranceProduct.findFirst({
      where: { householdId, accountId: account.id, name, policyNo },
    });
    if (duplicate) {
      return NextResponse.json({ ok: false, code: "PRODUCT_EXISTS", error: "该保险产品已存在" }, { status: 409 });
    }

    const productMaster = requestedProductMasterId
      ? await prisma.insuranceProductMaster.findFirst({
          where: { id: requestedProductMasterId, householdId },
        })
      : await getOrCreateProductMaster({
          householdId,
          institutionId,
          name,
          shortName,
          productType,
          accountingType,
          currency,
          note,
        });
    if (requestedProductMasterId && !productMaster) {
      return NextResponse.json({ ok: false, code: "PRODUCT_MASTER_NOT_FOUND", error: "保险产品主数据不存在" }, { status: 404 });
    }

    const created = await prisma.insuranceProduct.create({
      data: {
        name,
        shortName,
        ...productMasterIdData(productMaster),
        productType,
        accountingType,
        policyNo,
        status,
        currency,
        householdId,
        accountId: account.id,
        institutionId,
        ownerGroupId: ownerGroup.id,
        policyholderPersonId,
        insuredUserId: null,
        insuredPersonId,
        beneficiaryName,
        startDate: parseDate(body.startDate),
        effectiveDate: parseDate(body.effectiveDate),
        maturityDate: parseDate(body.maturityDate),
        premiumMode,
        premiumFrequencyMonths,
        premiumAmount,
        paymentTermYears,
        coverageTermYears,
        coverageAmount,
        cashValueEnabled,
        note,
      },
    });

    return NextResponse.json({
      ok: true,
      insuranceProduct: {
        id: created.id,
        productMasterId: productMaster?.id ?? null,
        productMasterName: productMaster?.name ?? created.name,
        productMasterShortName: productMaster?.shortName ?? created.shortName,
        name: created.name,
        shortName: created.shortName,
        productType: created.productType,
        accountingType: created.accountingType,
        policyNo: created.policyNo,
        status: created.status,
        currency: created.currency,
        accountId: created.accountId,
        institutionId: created.institutionId,
        ownerGroupId: created.ownerGroupId,
        policyholderPersonId: created.policyholderPersonId,
        insuredUserId: created.insuredUserId,
        insuredPersonId: created.insuredPersonId,
        beneficiaryName: created.beneficiaryName,
        startDate: created.startDate?.toISOString().slice(0, 10) ?? null,
        effectiveDate: created.effectiveDate?.toISOString().slice(0, 10) ?? null,
        maturityDate: created.maturityDate?.toISOString().slice(0, 10) ?? null,
        premiumMode: created.premiumMode,
        premiumFrequencyMonths: created.premiumFrequencyMonths,
        premiumAmount: created.premiumAmount ? Number(created.premiumAmount) : null,
        paymentTermYears: created.paymentTermYears ? Number(created.paymentTermYears) : null,
        coverageTermYears: created.coverageTermYears ? Number(created.coverageTermYears) : null,
        coverageAmount: created.coverageAmount ? Number(created.coverageAmount) : null,
        cashValueEnabled: created.cashValueEnabled,
        note: created.note,
        accountName: account.name,
        institutionName: institution?.name ?? "",
        institutionShortName: institution?.shortName ?? "",
        ownerGroupName: ownerGroup.name,
        policyholderPersonName: policyholderPerson?.name ?? "",
        insuredUserName: insuredUser?.name ?? "",
        insuredPersonName: insuredPerson?.name ?? "",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "创建保险产品失败";
    return NextResponse.json({ ok: false, code: "CREATE_FAILED", error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ ok: false, code: "INVALID_REQUEST_BODY", error: "无效的请求体" }, { status: 400 });
    }

    const id = String(body.id ?? "").trim();
    if (!id) {
      return NextResponse.json({ ok: false, code: "MISSING_PRODUCT_ID", error: "缺少保险产品ID" }, { status: 400 });
    }

    const name = String(body.name ?? "").trim();
    const requestedAccountId = String(body.accountId ?? "").trim() || null;
    const shortName = String(body.shortName ?? "").trim() || null;
    const productTypeRaw = String(body.productType ?? "other").trim() as InsuranceProductType;
    const accountingTypeRaw = String(body.accountingType ?? "asset").trim() as InsuranceAccountingType;
    const statusRaw = String(body.status ?? "active").trim() as InsuranceStatus;
    const policyNo = String(body.policyNo ?? "").trim() || null;
    const effectiveDate = parseDate(body.effectiveDate);
    const currency = String(body.currency ?? "CNY").trim() || "CNY";
    const institutionId = String(body.institutionId ?? "").trim() || null;
    const ownerGroupId = String(body.ownerGroupId ?? "").trim() || null;
    const policyholderPersonId = String(body.policyholderPersonId ?? "").trim() || null;
    const policyholderPersonName = String(body.policyholderPersonName ?? "").trim() || null;
    const insuredUserId = String(body.insuredUserId ?? "").trim() || null;
    const insuredPersonId = String(body.insuredPersonId ?? "").trim() || null;
    const insuredPersonName = String(body.insuredPersonName ?? "").trim() || null;
    const beneficiaryName = String(body.beneficiaryName ?? "").trim() || null;
    const premiumMode = String(body.premiumMode ?? "").trim() || null;
    const premiumFrequencyMonths = parseIntOrNull(body.premiumFrequencyMonths);
    const premiumAmount = parseMoney(body.premiumAmount);
    const paymentTermYears = parseDecimal(body.paymentTermYears);
    const coverageTermYears = parseDecimal(body.coverageTermYears);
    const coverageAmount = parseMoney(body.coverageAmount);
    const cashValueEnabled = body.cashValueEnabled === false ? false : true;
    const note = String(body.note ?? "").trim() || null;
    const mode = String(body.mode ?? "").trim() || null;

    const { hidFilter } = await getHouseholdScope();
    const householdId = hidFilter.householdId;

    if (mode === "policy") {
      const existingPolicy = await prisma.insuranceProduct.findFirst({
        where: { id, ...hidFilter },
      });
      if (!existingPolicy) {
        return NextResponse.json({ ok: false, code: "POLICY_NOT_FOUND", error: "保单不存在" }, { status: 404 });
      }

      const [policyholderPerson, insuredPerson] = await Promise.all([
        ensureFamilyMemberInstitution({
          householdId,
          personId: policyholderPersonId,
          personName: policyholderPersonName,
        }),
        ensureFamilyMemberInstitution({
          householdId,
          personId: insuredPersonId,
          personName: insuredPersonName,
        }),
      ]);

      if (policyholderPersonId && !isFamilyMember(policyholderPerson)) {
        return NextResponse.json({ ok: false, code: "POLICYHOLDER_NOT_FAMILY_MEMBER", error: "投保人必须是家庭成员" }, { status: 400 });
      }
      if (insuredPersonId && !isFamilyMember(insuredPerson)) {
        return NextResponse.json({ ok: false, code: "INSURED_NOT_FAMILY_MEMBER", error: "被保险人必须是家庭成员" }, { status: 400 });
      }

      const ownerGroup = await resolveInsuranceOwnerGroup({
        ownerGroupId: policyholderPerson ? null : existingPolicy.ownerGroupId,
        policyholderPerson,
        householdId,
      });
      if (!ownerGroup) {
        return NextResponse.json({ ok: false, code: "OWNER_GROUP_NOT_FOUND", error: "没有可用于归档保险账户的所有人" }, { status: 400 });
      }
      if (!existingPolicy.institutionId) {
        return NextResponse.json({ ok: false, code: "MISSING_INSTITUTION", error: "保单缺少承保机构" }, { status: 400 });
      }

      const account = await getOrCreateInsuranceAccount(
        prisma,
        ownerGroup.id,
        householdId,
        existingPolicy.institutionId,
      );

      const updatedPolicy = await prisma.insuranceProduct.update({
        where: { id },
        data: {
          accountId: account.id,
          ownerGroupId: ownerGroup.id,
          policyNo,
          policyholderPersonId: policyholderPerson?.id ?? null,
          insuredUserId: null,
          insuredPersonId: insuredPerson?.id ?? null,
          effectiveDate,
          paymentTermYears,
          coverageAmount,
        },
      });

      if (existingPolicy.accountId !== account.id) {
        await prisma.insuranceTransaction.updateMany({
          where: { householdId, insuranceProductId: id },
          data: { accountId: account.id },
        });
        await prisma.txRecord.updateMany({
          where: {
            householdId,
            source: "insurance",
            insuranceProductId: id,
            ...insuranceRefundEntryFilter(),
          },
          data: {
            accountId: account.id,
            accountName: account.name,
          },
        });
        await prisma.txRecord.updateMany({
          where: {
            householdId,
            source: "insurance",
            insuranceProductId: id,
            ...insurancePremiumEntryFilter(),
          },
          data: {
            toAccountId: account.id,
            toAccountName: account.name,
          },
        });
      }

      return NextResponse.json({
        ok: true,
        insuranceProduct: {
          id: updatedPolicy.id,
          accountId: updatedPolicy.accountId,
          ownerGroupId: updatedPolicy.ownerGroupId,
          policyNo: updatedPolicy.policyNo,
          policyholderPersonId: updatedPolicy.policyholderPersonId,
          insuredUserId: updatedPolicy.insuredUserId,
          insuredPersonId: updatedPolicy.insuredPersonId,
          effectiveDate: updatedPolicy.effectiveDate?.toISOString().slice(0, 10) ?? null,
          paymentTermYears: updatedPolicy.paymentTermYears ? Number(updatedPolicy.paymentTermYears) : null,
          coverageAmount: updatedPolicy.coverageAmount ? Number(updatedPolicy.coverageAmount) : null,
          accountName: account.name,
          ownerGroupName: ownerGroup.name,
          policyholderPersonName: policyholderPerson?.name ?? "",
          insuredPersonName: insuredPerson?.name ?? "",
        },
      });
    }

    if (!name) {
      return NextResponse.json({ ok: false, code: "MISSING_PRODUCT_NAME", error: "保险产品名称不能为空" }, { status: 400 });
    }
    if (!institutionId) {
      return NextResponse.json({ ok: false, code: "MISSING_INSTITUTION", error: "请选择承保机构" }, { status: 400 });
    }

    const productType = PRODUCT_TYPES.has(productTypeRaw) ? productTypeRaw : "other";
    const accountingType = ACCOUNTING_TYPES.has(accountingTypeRaw) ? accountingTypeRaw : "asset";
    const status = STATUSES.has(statusRaw) ? statusRaw : "active";

    if (mode === "master") {
      const existingMaster = await prisma.insuranceProductMaster.findFirst({
        where: { id, householdId },
        include: {
          Institution: { select: { name: true, shortName: true } },
        },
      });
      if (!existingMaster) {
        return NextResponse.json({ ok: false, code: "PRODUCT_NOT_FOUND", error: "保险产品不存在" }, { status: 404 });
      }
      const institution = await prisma.institution.findFirst({
        where: { id: institutionId, ...hidFilter },
      });
      if (!institution) {
        return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_FOUND", error: "承保机构不存在" }, { status: 400 });
      }
      if (institution.type !== "insurance") {
        return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_INSURER", error: "承保机构必须是保险公司" }, { status: 400 });
      }
      const duplicateMaster = await prisma.insuranceProductMaster.findFirst({
        where: {
          householdId,
          institutionId,
          name,
          productType,
          NOT: { id },
        },
      });
      if (duplicateMaster) {
        return NextResponse.json({ ok: false, code: "PRODUCT_EXISTS", error: "该保险产品已存在" }, { status: 409 });
      }
      const updatedMaster = await prisma.insuranceProductMaster.update({
        where: { id },
        data: {
          name,
          shortName,
          productType,
          accountingType,
          currency,
          institutionId,
          note,
        },
        include: {
          Institution: { select: { name: true, shortName: true } },
          _count: { select: { InsuranceProduct: true } },
        },
      });
      return NextResponse.json({
        ok: true,
        productMaster: {
          ...serializeProductMaster(updatedMaster),
          policyCount: updatedMaster._count.InsuranceProduct,
        },
      });
    }

    const existing = await prisma.insuranceProduct.findFirst({
      where: { id, ...hidFilter },
    });
    if (!existing) {
      return NextResponse.json({ ok: false, code: "PRODUCT_NOT_FOUND", error: "保险产品不存在" }, { status: 404 });
    }

    const [institution, policyholderPerson, insuredPerson, insuredUser] = await Promise.all([
      prisma.institution.findFirst({ where: { id: institutionId, ...hidFilter } }),
      ensureFamilyMemberInstitution({
        householdId,
        personId: policyholderPersonId,
        personName: policyholderPersonName,
      }),
      ensureFamilyMemberInstitution({
        householdId,
        personId: insuredPersonId,
        personName: insuredPersonName,
      }),
      insuredUserId ? prisma.user.findFirst({ where: { id: insuredUserId, ...hidFilter } }) : Promise.resolve(null),
    ]);
    const ownerGroup = await resolveInsuranceOwnerGroup({ ownerGroupId, policyholderPerson, householdId });

    if (!institution) {
      return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_FOUND", error: "承保机构不存在" }, { status: 400 });
    }
    if (institution.type !== "insurance") {
      return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_INSURER", error: "承保机构必须是保险公司" }, { status: 400 });
    }
    if (policyholderPersonId && !isFamilyMember(policyholderPerson)) {
      return NextResponse.json({ ok: false, code: "POLICYHOLDER_NOT_FAMILY_MEMBER", error: "投保人必须是家庭成员" }, { status: 400 });
    }
    if (insuredPersonId && !isFamilyMember(insuredPerson)) {
      return NextResponse.json({ ok: false, code: "INSURED_NOT_FAMILY_MEMBER", error: "被保险人必须是家庭成员" }, { status: 400 });
    }
    if (!ownerGroup) {
      return NextResponse.json({ ok: false, code: "OWNER_GROUP_NOT_FOUND", error: "没有可用于归档保险账户的所有人" }, { status: 400 });
    }
    if (insuredUserId && !insuredUser) {
      return NextResponse.json({ ok: false, code: "INSURED_USER_NOT_FOUND", error: "被保险人不存在" }, { status: 400 });
    }

    const account = requestedAccountId
      ? await prisma.account.findFirst({ where: { id: requestedAccountId, ...hidFilter } })
      : await getOrCreateInsuranceAccount(prisma, ownerGroup.id, householdId, institutionId);

    if (!account) {
      return NextResponse.json({ ok: false, code: "INSURANCE_ACCOUNT_NOT_FOUND", error: "保险账户不存在" }, { status: 400 });
    }
    if (!isInsuranceAccount(account)) {
      return NextResponse.json({ ok: false, code: "INVALID_INSURANCE_ACCOUNT", error: "请选择保险账户" }, { status: 400 });
    }

    const duplicate = await prisma.insuranceProduct.findFirst({
      where: {
        householdId,
        accountId: account.id,
        name,
        policyNo,
        NOT: { id },
      },
    });
    if (duplicate) {
      return NextResponse.json({ ok: false, code: "PRODUCT_EXISTS", error: "该保险产品已存在" }, { status: 409 });
    }

    const productMaster = await getOrCreateProductMaster({
      householdId,
      institutionId,
      name,
      shortName,
      productType,
      accountingType,
      currency,
      note,
    });

    const updated = await prisma.insuranceProduct.update({
      where: { id },
      data: {
        name,
        shortName,
        ...productMasterIdData(productMaster),
        productType,
        accountingType,
        policyNo,
        status,
        currency,
        accountId: account.id,
        institutionId,
        ownerGroupId: ownerGroup.id,
        policyholderPersonId,
        insuredUserId: null,
        insuredPersonId,
        beneficiaryName,
        startDate: parseDate(body.startDate),
        effectiveDate: parseDate(body.effectiveDate),
        maturityDate: parseDate(body.maturityDate),
        premiumMode,
        premiumFrequencyMonths,
        premiumAmount,
        paymentTermYears,
        coverageTermYears,
        coverageAmount,
        cashValueEnabled,
        note,
      },
    });

    if (existing.accountId !== account.id) {
      await prisma.insuranceTransaction.updateMany({
        where: { householdId, insuranceProductId: id },
        data: { accountId: account.id },
      });
      await prisma.txRecord.updateMany({
        where: {
          householdId,
          source: "insurance",
          insuranceProductId: id,
          ...insuranceRefundEntryFilter(),
        },
        data: {
          accountId: account.id,
          accountName: account.name,
        },
      });
      await prisma.txRecord.updateMany({
        where: {
          householdId,
          source: "insurance",
          insuranceProductId: id,
          ...insurancePremiumEntryFilter(),
        },
        data: {
          toAccountId: account.id,
          toAccountName: account.name,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      insuranceProduct: {
        id: updated.id,
        productMasterId: productMaster?.id ?? updated.productMasterId ?? null,
        productMasterName: productMaster?.name ?? updated.name,
        productMasterShortName: productMaster?.shortName ?? updated.shortName,
        name: updated.name,
        shortName: updated.shortName,
        productType: updated.productType,
        accountingType: updated.accountingType,
        policyNo: updated.policyNo,
        status: updated.status,
        currency: updated.currency,
        accountId: updated.accountId,
        institutionId: updated.institutionId,
        ownerGroupId: updated.ownerGroupId,
        policyholderPersonId: updated.policyholderPersonId,
        insuredUserId: updated.insuredUserId,
        insuredPersonId: updated.insuredPersonId,
        beneficiaryName: updated.beneficiaryName,
        startDate: updated.startDate?.toISOString().slice(0, 10) ?? null,
        effectiveDate: updated.effectiveDate?.toISOString().slice(0, 10) ?? null,
        maturityDate: updated.maturityDate?.toISOString().slice(0, 10) ?? null,
        premiumMode: updated.premiumMode,
        premiumFrequencyMonths: updated.premiumFrequencyMonths,
        premiumAmount: updated.premiumAmount ? Number(updated.premiumAmount) : null,
        paymentTermYears: updated.paymentTermYears ? Number(updated.paymentTermYears) : null,
        coverageTermYears: updated.coverageTermYears ? Number(updated.coverageTermYears) : null,
        coverageAmount: updated.coverageAmount ? Number(updated.coverageAmount) : null,
        cashValueEnabled: updated.cashValueEnabled,
        note: updated.note,
        accountName: account.name,
        institutionName: institution.name,
        institutionShortName: institution.shortName ?? "",
        ownerGroupName: ownerGroup.name,
        policyholderPersonName: policyholderPerson?.name ?? "",
        insuredUserName: insuredUser?.name ?? "",
        insuredPersonName: insuredPerson?.name ?? "",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "更新保险产品失败";
    return NextResponse.json({ ok: false, code: "UPDATE_FAILED", error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id")?.trim() || "";
    const mode = url.searchParams.get("mode")?.trim() || null;
    if (!id) {
      return NextResponse.json({ ok: false, code: "MISSING_PRODUCT_ID", error: "缺少保险产品ID" }, { status: 400 });
    }

    const { hidFilter, user } = await getHouseholdScope();
    const householdId = hidFilter.householdId;

    if (mode === "master") {
      const existingMaster = await prisma.insuranceProductMaster.findFirst({
        where: { id, householdId },
        select: { id: true, name: true },
      });
      if (!existingMaster) {
        return NextResponse.json({ ok: false, code: "PRODUCT_NOT_FOUND", error: "保险产品不存在" }, { status: 404 });
      }

      let body: { password?: string; cascade?: boolean } | null = null;
      try {
        body = await req.json();
      } catch {
        body = null;
      }
      const password = String(body?.password ?? "").trim();
      const cascade = body?.cascade === true;

      if (!password) {
        return NextResponse.json({ ok: false, code: "MISSING_PASSWORD", error: "请输入密码确认删除" }, { status: 400 });
      }
      if (!user) {
        return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "未登录" }, { status: 401 });
      }
      const currentUser = await prisma.user.findUnique({ where: { id: user.id } });
      if (!currentUser) {
        return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "用户不存在" }, { status: 401 });
      }
      if (currentUser.passwordHash) {
        const match = await verifyPassword(password, currentUser.passwordHash);
        if (!match) {
          return NextResponse.json({ ok: false, code: "INVALID_PASSWORD", error: "密码错误" }, { status: 401 });
        }
      } else {
        return NextResponse.json({ ok: false, code: "PASSWORD_NOT_SET", error: "请先设置密码" }, { status: 400 });
      }

      const linkedPolicies = await prisma.insuranceProduct.findMany({
        where: { householdId, productMasterId: id },
        select: { id: true },
      });
      const linkedPolicyIds = linkedPolicies.map((item) => item.id);
      const [txCount, businessTxCount, planCount] = linkedPolicyIds.length
        ? await Promise.all([
            prisma.txRecord.count({
              where: {
                householdId,
                insuranceProductId: { in: linkedPolicyIds },
                deletedAt: null,
              },
            }),
            prisma.insuranceTransaction.count({
              where: {
                householdId,
                insuranceProductId: { in: linkedPolicyIds },
                deletedAt: null,
              },
            }),
            prisma.regularInvestPlan.count({
              where: {
                householdId,
                ...insurancePremiumPlanProductFilter(linkedPolicyIds),
              },
            }),
          ])
        : [0, 0, 0];
      const linkedTxCount = Math.max(txCount, businessTxCount);

      if ((linkedPolicyIds.length > 0 || linkedTxCount > 0 || planCount > 0) && !cascade) {
        return NextResponse.json({
          ok: false,
          code: "PRODUCT_HAS_LINKED_DATA",
          error: `该保险产品已关联${linkedPolicyIds.length}个保单、${linkedTxCount}条记录、${planCount}个计划任务，请勾选“同时删除关联数据”后再确认`,
        }, { status: 409 });
      }

      await prisma.$transaction(async (tx) => {
        if (linkedPolicyIds.length > 0) {
          await tx.regularInvestPlan.deleteMany({
            where: {
              householdId,
              ...insurancePremiumPlanProductFilter(linkedPolicyIds),
            },
          });
          await tx.txRecord.deleteMany({
            where: {
              householdId,
              insuranceProductId: { in: linkedPolicyIds },
            },
          });
          await tx.insuranceTransaction.deleteMany({
            where: {
              householdId,
              insuranceProductId: { in: linkedPolicyIds },
            },
          });
          await tx.insuranceProduct.deleteMany({
            where: {
              householdId,
              id: { in: linkedPolicyIds },
            },
          });
        }
        await tx.insuranceProductMaster.delete({ where: { id } });
      });

      return NextResponse.json({ ok: true, data: { id } });
    }

    const existing = await prisma.insuranceProduct.findFirst({
      where: { id, ...hidFilter },
      select: { id: true, name: true },
    });
    if (!existing) {
      return NextResponse.json({ ok: false, code: "PRODUCT_NOT_FOUND", error: "保险产品不存在" }, { status: 404 });
    }

    const [txCount, businessTxCount, planCount] = await Promise.all([
      prisma.txRecord.count({
        where: {
          householdId: hidFilter.householdId ?? undefined,
          insuranceProductId: id,
          deletedAt: null,
        },
      }),
      prisma.insuranceTransaction.count({
        where: {
          householdId: hidFilter.householdId ?? undefined,
          insuranceProductId: id,
          deletedAt: null,
        },
      }),
      prisma.regularInvestPlan.count({
        where: {
          householdId: hidFilter.householdId ?? undefined,
          ...insurancePremiumPlanProductFilter([id]),
        },
      }),
    ]);
    const linkedTxCount = Math.max(txCount, businessTxCount);

    const hasLinkedPayments = linkedTxCount > 0;
    if (!hasLinkedPayments) {
      await prisma.$transaction(async (tx) => {
        if (planCount > 0) {
          await tx.regularInvestPlan.deleteMany({
            where: {
              householdId: hidFilter.householdId ?? undefined,
              ...insurancePremiumPlanProductFilter([id]),
            },
          });
        }
        await tx.insuranceProduct.delete({ where: { id } });
      });
      return NextResponse.json({ ok: true, data: { id } });
    }

    let body: { password?: string; cascade?: boolean } | null = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    const password = String(body?.password ?? "").trim();
    const cascade = body?.cascade === true;

    if (!password) {
      return NextResponse.json({
        ok: false,
        code: "DELETE_PASSWORD_REQUIRED",
        error: `该保单已有${linkedTxCount}条缴费记录，需输入密码并确认删除全部记录`,
        needPassword: true,
      }, { status: 409 });
    }
    if (!cascade) {
      return NextResponse.json({
        ok: false,
        code: "DELETE_CONFIRMATION_REQUIRED",
        error: "请确认是否删除全部记录",
      }, { status: 409 });
    }

    if (!user) {
      return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "未登录" }, { status: 401 });
    }
    const currentUser = await prisma.user.findUnique({ where: { id: user.id } });
    if (!currentUser) {
      return NextResponse.json({ ok: false, code: "USER_NOT_FOUND", error: "用户不存在" }, { status: 401 });
    }
    if (currentUser.passwordHash) {
      const match = await verifyPassword(password, currentUser.passwordHash);
      if (!match) {
        return NextResponse.json({ ok: false, code: "INVALID_PASSWORD", error: "密码错误" }, { status: 401 });
      }
    } else {
      return NextResponse.json({ ok: false, code: "PASSWORD_NOT_SET", error: "请先设置密码" }, { status: 400 });
    }

    await prisma.$transaction(async (tx) => {
      if (planCount > 0) {
        await tx.regularInvestPlan.deleteMany({
          where: {
            householdId: hidFilter.householdId ?? undefined,
            ...insurancePremiumPlanProductFilter([id]),
          },
        });
      }
      await tx.txRecord.deleteMany({
        where: {
          householdId: hidFilter.householdId ?? undefined,
          insuranceProductId: id,
        },
      });
      await tx.insuranceTransaction.deleteMany({
        where: {
          householdId: hidFilter.householdId ?? undefined,
          insuranceProductId: id,
        },
      });
      await tx.insuranceProduct.delete({ where: { id } });
    });
    return NextResponse.json({ ok: true, data: { id } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "删除保险产品失败";
    return NextResponse.json({ ok: false, code: "DELETE_FAILED", error: message }, { status: 500 });
  }
}
