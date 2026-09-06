import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  assertInstitutionDisplayNamesUnique,
  isInstitutionNameUniqueError,
} from "@/lib/server/institution-name-unique";
import { SettingsInstitutionsClient } from "./client";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";
import { loadInstitutionAccountCounts, withAccountCounts } from "@/lib/server/entity-account-counts";

export const dynamic = "force-dynamic";

async function updateInstitutionRow(formData: FormData) {
  "use server";

  const { householdId } = await getHouseholdScope();
  const institutionId = String(formData.get("institutionId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const shortName = String(formData.get("shortName") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  if (!institutionId || !name) return { ok: false, error: "Missing required fields" };

  try {
    await prisma.$transaction(async (tx) => {
      await assertInstitutionDisplayNamesUnique(tx, {
        householdId,
        name,
        shortName,
        excludeId: institutionId,
      });
      const updated = await tx.institution.updateMany({
        where: { id: institutionId, householdId },
        data: { name, shortName: shortName || null, type: type || null },
      });
      if (updated.count === 0) throw new Error("Institution not found");
    });
  } catch (error) {
    if (isInstitutionNameUniqueError(error)) return { ok: false, error: error.message };
    return { ok: false, error: error instanceof Error ? error.message : "Save failed" };
  }

  revalidateAfterSettingsChange();
  return { ok: true };
}

export default async function SettingsInstitutionsPage() {
  const { hidFilter } = await getHouseholdScope();
  const [institutions, accountCounts] = await Promise.all([
    prisma.institution.findMany({
      where: { ...hidFilter, type: { in: ["bank", "insurance", "brokerage", "fund_company", "payment", "other"] } },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    }),
    loadInstitutionAccountCounts(hidFilter),
  ]);

  return (
    <SettingsInstitutionsClient
      institutions={withAccountCounts(institutions, accountCounts).map(i => ({ id: i.id, name: i.name, shortName: i.shortName, type: i.type, accountCount: i.accountCount }))}
      updateAction={updateInstitutionRow}
      mode="institution"
    />
  );
}
