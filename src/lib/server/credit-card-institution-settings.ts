import { AccountKind, type CreditBillMode, type Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";

type AccountWriter = typeof prisma | Prisma.TransactionClient;

const CREDIT_BILL_MODE_SEPARATE: CreditBillMode = "separate";
const CREDIT_BILL_MODE_CONSOLIDATED: CreditBillMode = "consolidated";

export type CreditCardInstitutionDefaults = {
  billingDay: number | null;
  repaymentDay: number | null;
  repaymentOffsetDays: number | null;
  creditLimit: string | null;
  creditBillMode: CreditBillMode;
};

export function normalizeCreditBillMode(value: unknown): CreditBillMode {
  return String(value ?? "").trim() === CREDIT_BILL_MODE_CONSOLIDATED
    ? CREDIT_BILL_MODE_CONSOLIDATED
    : CREDIT_BILL_MODE_SEPARATE;
}

export async function getCreditCardInstitutionDefaults(
  writer: AccountWriter,
  householdId: string,
  institutionId: string | null | undefined,
  excludeAccountId?: string,
): Promise<CreditCardInstitutionDefaults | null> {
  if (!institutionId) return null;
  const accounts = await writer.account.findMany({
    where: {
      householdId,
      institutionId,
      kind: AccountKind.bank_credit,
      isActive: true,
      ...(excludeAccountId ? { NOT: { id: excludeAccountId } } : {}),
    },
    select: {
      billingDay: true,
      repaymentDay: true,
      repaymentOffsetDays: true,
      creditLimit: true,
      creditBillMode: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
  });
  if (accounts.length === 0) return null;
  const template = [...accounts].sort((a, b) => {
    const completeness = (row: typeof a) =>
      Number(row.billingDay != null) + Number(row.repaymentDay != null) + Number(row.repaymentOffsetDays != null) + Number(row.creditLimit != null);
    return completeness(b) - completeness(a) || b.updatedAt.getTime() - a.updatedAt.getTime();
  })[0];
  return {
    billingDay: template.billingDay,
    repaymentDay: template.repaymentDay,
    repaymentOffsetDays: template.repaymentOffsetDays,
    creditLimit: template.creditLimit?.toString() ?? null,
    creditBillMode: template.creditBillMode,
  };
}

export async function syncCreditCardInstitutionSettings(
  writer: AccountWriter,
  input: {
    householdId: string;
    institutionId: string | null | undefined;
    billingDay: number | null;
    repaymentDay: number | null;
    repaymentOffsetDays: number | null;
    creditBillMode: CreditBillMode;
  },
) {
  if (!input.institutionId) return;
  await writer.account.updateMany({
    where: {
      householdId: input.householdId,
      institutionId: input.institutionId,
      kind: AccountKind.bank_credit,
    },
    data: {
      billingDay: input.billingDay,
      repaymentDay: input.repaymentDay,
      repaymentOffsetDays: input.repaymentOffsetDays,
      creditBillMode: input.creditBillMode,
    },
  });
}

export async function getCreditBillAccountIds(
  writer: AccountWriter,
  account: {
    id: string;
    householdId: string;
    institutionId: string | null;
    kind: AccountKind;
    creditBillMode: CreditBillMode;
  },
) {
  if (
    account.kind !== AccountKind.bank_credit ||
    account.creditBillMode !== CREDIT_BILL_MODE_CONSOLIDATED ||
    !account.institutionId
  ) {
    return [account.id];
  }
  const rows = await writer.account.findMany({
    where: {
      householdId: account.householdId,
      institutionId: account.institutionId,
      kind: AccountKind.bank_credit,
      creditBillMode: CREDIT_BILL_MODE_CONSOLIDATED,
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.length > 0 ? rows.map((row) => row.id) : [account.id];
}
