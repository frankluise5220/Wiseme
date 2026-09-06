import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { SettingsInstitutionsClient } from "../institutions/client";
import { ensureInstitutionForCounterparty } from "@/lib/server/counterparty-sync";
import {
  assertCounterpartyDisplayNamesUnique,
  isCounterpartyNameUniqueError,
} from "@/lib/server/counterparty-name-unique";
import { isInstitutionNameUniqueError } from "@/lib/server/institution-name-unique";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";
import { loadCounterpartyAccountCounts, withAccountCounts } from "@/lib/server/entity-account-counts";

export const dynamic = "force-dynamic";

async function updateCounterpartyRow(formData: FormData) {
  "use server";

  const { householdId } = await getHouseholdScope();
  const counterpartyId = String(formData.get("institutionId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const shortName = String(formData.get("shortName") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  if (!counterpartyId || !name) return { ok: false, error: "Missing required fields" };

  const safeType = ["person", "organization"].includes(type) ? type : "person";
  const existing = await prisma.counterparty.findFirst({ where: { id: counterpartyId, householdId } });
  if (!existing) return { ok: false, error: "Counterparty not found" };

  try {
    await prisma.$transaction(async (tx) => {
      await assertCounterpartyDisplayNamesUnique(tx, {
        householdId,
        name,
        shortName,
        excludeId: counterpartyId,
      });
      const updated = await tx.counterparty.update({
        where: { id: counterpartyId },
        data: { name, shortName: shortName || null, type: safeType },
      });
      await ensureInstitutionForCounterparty(tx, updated);
    });
  } catch (error) {
    if (isCounterpartyNameUniqueError(error)) return { ok: false, error: error.message };
    if (isInstitutionNameUniqueError(error)) return { ok: false, error: error.message };
    return { ok: false, error: error instanceof Error ? error.message : "Save failed" };
  }

  revalidateAfterSettingsChange();
  revalidatePath("/settings/counterparties");
  return { ok: true };
}

export default async function SettingsCounterpartiesPage() {
  const { hidFilter } = await getHouseholdScope();
  const [counterparties, accountCounts] = await Promise.all([
    prisma.counterparty.findMany({
      where: hidFilter,
      orderBy: [{ type: "asc" }, { name: "asc" }],
    }),
    loadCounterpartyAccountCounts(hidFilter),
  ]);

  return (
    <SettingsInstitutionsClient
      institutions={withAccountCounts(counterparties, accountCounts).map(i => ({ id: i.id, name: i.name, shortName: i.shortName, type: i.type, accountCount: i.accountCount }))}
      updateAction={updateCounterpartyRow}
      mode="counterparty"
    />
  );
}
