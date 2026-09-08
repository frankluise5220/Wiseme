import { prisma } from "@/lib/db/prisma";

type Db = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

type ResolveAdvanceAccountInput = {
  householdId: string;
  cashAccountId: string;
  debtObjectId: string;
};

export async function resolveOrCreateAdvanceAccount(tx: Db, input: ResolveAdvanceAccountInput) {
  const cashAccount = await tx.account.findFirst({
    where: { id: input.cashAccountId, householdId: input.householdId, isActive: true },
    select: { id: true, currency: true },
  });
  if (!cashAccount) throw new Error("资金账户不存在或已停用");

  const refMatch = /^(counterparty|institution):(.+)$/.exec(input.debtObjectId);
  const sourceKind = refMatch?.[1] ?? "counterparty";
  const sourceId = refMatch?.[2] ?? input.debtObjectId;
  const counterparty = sourceKind === "counterparty"
    ? await tx.counterparty.findFirst({
        where: { id: sourceId, householdId: input.householdId },
        select: { id: true, name: true, shortName: true, sourceInstitutionId: true },
      })
    : null;
  const institution = !counterparty
    ? await tx.institution.findFirst({
        where: { id: sourceId, householdId: input.householdId, type: { in: ["person", "organization"] } },
        select: { id: true, name: true, shortName: true },
      })
    : null;
  if (!counterparty && !institution) throw new Error("请选择往来对象");

  const relationWhere = counterparty
    ? {
        OR: [
          { counterpartyId: counterparty.id },
          ...(counterparty.sourceInstitutionId ? [{ institutionId: counterparty.sourceInstitutionId }] : []),
        ],
      }
    : { institutionId: institution!.id };
  const existing = await tx.account.findFirst({
    where: {
      householdId: input.householdId,
      kind: { in: ["settlement", "loan"] },
      debtDirection: "receivable",
      isPlaceholder: { not: true },
      ...relationWhere,
    },
    orderBy: [{ isActive: "desc" }, { createdAt: "asc" }],
    select: { id: true, name: true, isActive: true },
  });
  const objectId = counterparty?.id ?? institution!.id;
  const objectName = counterparty?.shortName?.trim() || counterparty?.name || institution?.shortName?.trim() || institution!.name;
  if (existing) {
    const account = existing.isActive
      ? existing
      : await tx.account.update({ where: { id: existing.id }, data: { isActive: true, kind: "settlement" }, select: { id: true, name: true, isActive: true } });
    if (existing.isActive) {
      await tx.account.update({ where: { id: existing.id }, data: { kind: "settlement" } });
    }
    return { account, objectId, objectName };
  }

  const defaultGroup =
    (await tx.accountGroup.findFirst({
      where: { householdId: input.householdId, name: "未指定" },
      select: { id: true },
    })) ??
    (await tx.accountGroup.findFirst({
      where: { householdId: input.householdId },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true },
    }));
  if (!defaultGroup) throw new Error("未找到默认账户分组");

  const account = await tx.account.create({
    data: {
      name: objectName,
      kind: "settlement",
      debtDirection: "receivable",
      currency: cashAccount.currency,
      groupId: defaultGroup.id,
      counterpartyId: counterparty?.id ?? null,
      institutionId: institution?.id ?? null,
      householdId: input.householdId,
      isActive: true,
    },
    select: { id: true, name: true, isActive: true },
  });
  return { account, objectId, objectName };
}
