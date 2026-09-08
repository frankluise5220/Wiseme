import { prisma } from "@/lib/db/prisma";
import { getOrCreateDefaultAccountGroupId } from "@/lib/server/account-group-default";

type Db = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export async function resolveInsuranceOwnerGroupId(
  db: Db,
  householdId: string,
  ownerGroupId?: string | null,
) {
  const requested = ownerGroupId?.trim();
  if (requested) {
    const group = await db.accountGroup.findFirst({
      where: { id: requested, householdId },
      select: { id: true },
    });
    if (!group) throw new Error("投保人不存在");
    return group.id;
  }
  return getOrCreateDefaultAccountGroupId(db, householdId);
}

export async function findInsuranceAccountByOwner(
  db: Db,
  ownerGroupId: string,
  householdId: string,
  institutionId: string,
) {
  const normalizedInstitutionId = institutionId.trim();
  const exactAccount = await db.account.findFirst({
    where: {
      kind: "insurance",
      groupId: ownerGroupId,
      householdId,
      isActive: true,
      institutionId: normalizedInstitutionId,
    },
    include: {
      AccountGroup: { select: { id: true, name: true } },
      Institution: { select: { id: true, name: true, shortName: true } },
    },
  });
  if (exactAccount) return exactAccount;

  const genericAccounts = await db.account.findMany({
    where: {
      kind: "insurance",
      groupId: ownerGroupId,
      householdId,
      isActive: true,
      institutionId: null,
    },
    include: {
      AccountGroup: { select: { id: true, name: true } },
      Institution: { select: { id: true, name: true, shortName: true } },
    },
    orderBy: { id: "asc" },
    take: 2,
  });

  if (genericAccounts.length !== 1) return null;

  return db.account.update({
    where: { id: genericAccounts[0].id },
    data: { institutionId: normalizedInstitutionId },
    include: {
      AccountGroup: { select: { id: true, name: true } },
      Institution: { select: { id: true, name: true, shortName: true } },
    },
  });
}

export async function getOrCreateInsuranceAccount(
  db: Db,
  ownerGroupId: string,
  householdId: string,
  institutionId: string,
) {
  const normalizedInstitutionId = institutionId.trim();
  if (!normalizedInstitutionId) throw new Error("承保机构不存在");

  const existing = await findInsuranceAccountByOwner(db, ownerGroupId, householdId, normalizedInstitutionId);
  if (existing) return existing;

  const [group, institution] = await Promise.all([
    db.accountGroup.findFirst({
      where: { id: ownerGroupId, householdId },
      select: { id: true, name: true },
    }),
    db.institution.findFirst({
      where: { id: normalizedInstitutionId, householdId },
      select: { id: true, name: true, shortName: true },
    }),
  ]);

  if (!group) throw new Error("投保人不存在");
  if (!institution) throw new Error("承保机构不存在");

  const institutionLabel = institution.shortName?.trim() || institution.name.trim();
  const accountName = `${group.name}的${institutionLabel}`;

  return db.account.create({
    data: {
      name: accountName,
      kind: "insurance",
      groupId: group.id,
      householdId,
      isActive: true,
      currency: "CNY",
      institutionId: institution.id,
    },
    include: {
      AccountGroup: { select: { id: true, name: true } },
      Institution: { select: { id: true, name: true, shortName: true } },
    },
  });
}
