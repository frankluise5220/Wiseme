import { prisma } from "@/lib/db/prisma";

type Db = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export async function resolveDefaultAccountGroupName(householdId: string) {
  const admin = await prisma.user.findFirst({
    where: { householdId, role: "admin" },
    select: { name: true },
    orderBy: { createdAt: "asc" },
  });
  const name = admin?.name?.trim();
  return name || "未指定";
}

export async function getOrCreateDefaultAccountGroupId(tx: Db, householdId: string) {
  const existing = await tx.accountGroup.findFirst({
    where: { householdId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true },
  });
  if (existing?.id) return existing.id;

  const name = await resolveDefaultAccountGroupName(householdId);
  const created = await tx.accountGroup.create({
    data: { name, householdId, sortOrder: 0 },
    select: { id: true },
  });
  return created.id;
}
