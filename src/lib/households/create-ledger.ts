import type { Prisma, User } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { hashPassword } from "@/lib/auth/password";
import { createDefaultCategoriesForHousehold } from "@/lib/default-categories";
import { createDefaultInstitutionsForHousehold } from "@/lib/default-institutions";
import { getDefaultTradingCalendarForAccount } from "@/lib/fund/trading-calendar";
import { assertInstitutionDisplayNamesUnique } from "@/lib/server/institution-name-unique";

type LedgerWriter = typeof prisma | Prisma.TransactionClient;

export const LEDGER_CREATION_INVITE_CODE_KEY = "ledger_creation_invite_code";

export type CreateLedgerInput = {
  name: string;
  adminName: string;
  adminPassword: string;
  adminEmail?: string;
};

export async function createLedgerWithDefaults(
  writer: LedgerWriter,
  input: CreateLedgerInput,
  options?: { currentUser?: Pick<User, "id" | "role" | "isSystem"> | null },
) {
  const household = await writer.household.create({
    data: { name: input.name },
  });

  const defaultOwner = await writer.accountGroup.create({
    data: { name: input.adminName, householdId: household.id, sortOrder: 0 },
  });

  const existingFamilyMember = await writer.institution.findFirst({
    where: {
      householdId: household.id,
      type: "family_member",
      name: input.adminName,
    },
    select: { id: true },
  });
  if (!existingFamilyMember) {
    await assertInstitutionDisplayNamesUnique(writer, {
      householdId: household.id,
      name: input.adminName,
    });
    await writer.institution.create({
      data: {
        householdId: household.id,
        type: "family_member",
        name: input.adminName,
        shortName: null,
      },
    });
  }

  const defaultAccounts: Array<{
    name: string;
    kind: "cash" | "bank_debit" | "bank_credit" | "investment";
    investProductType?: "fund";
  }> = [
    { name: "现金账户", kind: "cash" },
    { name: "借记卡", kind: "bank_debit" },
    { name: "信用卡", kind: "bank_credit" },
    { name: "投资账户", kind: "investment", investProductType: "fund" },
  ];

  for (const account of defaultAccounts) {
    await writer.account.create({
      data: {
        name: account.name,
        kind: account.kind,
        debtDirection: account.kind === "bank_credit" ? "payable" : null,
        groupId: defaultOwner.id,
        investProductType: account.investProductType,
        tradingCalendar: getDefaultTradingCalendarForAccount(account.kind, account.investProductType) as any,
        householdId: household.id,
        isActive: true,
        currency: "CNY",
      },
    });
  }

  await createDefaultCategoriesForHousehold(writer, household.id);
  await createDefaultInstitutionsForHousehold(writer, household.id);

  const passwordHash = await hashPassword(input.adminPassword);
  const adminUser = await writer.user.create({
    data: {
      name: input.adminName,
      role: "admin",
      isSystem: false,
      passwordHash,
      email: input.adminEmail?.trim() ? input.adminEmail.trim() : null,
      householdId: household.id,
    },
  });

  if (options?.currentUser && options.currentUser.role !== "admin" && options.currentUser.isSystem !== true) {
    await writer.user.update({
      where: { id: options.currentUser.id },
      data: { householdId: household.id },
    });
  }

  return { household, adminUser, defaultOwner };
}
