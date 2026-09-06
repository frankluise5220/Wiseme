import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import {
  assertInstitutionDisplayNamesUnique,
  findReusableInstitutionDisplayNameOrphan,
  isInstitutionNameUniqueError,
} from "@/lib/server/institution-name-unique";
import { ensureCounterpartyForInstitution } from "@/lib/server/counterparty-sync";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

const VALID_INSTITUTION_TYPES = ["family_member", "person", "organization", "bank", "insurance", "brokerage", "fund_company", "payment", "debt", "other"] as const;

/**
 * GET /api/v1/institution?type=fund_company
 * Success: { ok: true, institutions: Array<{ id, name, shortName, type }> }
 */
export async function GET(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const requestedType = new URL(req.url).searchParams.get("type")?.trim() || "";
    const type = (VALID_INSTITUTION_TYPES as readonly string[]).includes(requestedType) ? requestedType : null;
    const institutions = await prisma.institution.findMany({
      where: { householdId, ...(type ? { type } : {}) },
      select: { id: true, name: true, shortName: true, type: true },
      orderBy: [{ type: "asc" }, { name: "asc" }],
    });
    return NextResponse.json({ ok: true, institutions });
  } catch (error) {
    return NextResponse.json(
      { ok: false, code: "FETCH_FAILED", error: error instanceof Error ? error.message : "Failed to fetch institutions." },
      { status: 500 },
    );
  }
}

/**
 * POST /api/v1/institution
 * Body: { name: string, shortName?: string, type?: string }
 * Success: { ok: true, institution: { id, name, shortName, type } }
 * Error: { ok: false, code, error }, including 409 when any institution full name or short name
 * in the current household already uses the submitted full name or short name.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const shortName = typeof body?.shortName === "string" ? body.shortName.trim() : "";
  const type = typeof body?.type === "string" ? body.type.trim() : "bank";

  if (!name) {
    return NextResponse.json({ ok: false, code: "NAME_REQUIRED", error: "Institution name is required." }, { status: 400 });
  }

  const { householdId } = await getHouseholdScope();

  const safeType = VALID_INSTITUTION_TYPES.includes(type as typeof VALID_INSTITUTION_TYPES[number]) ? type : "organization";

  try {
    const created = await prisma.$transaction(async (tx) => {
      const reusable = await findReusableInstitutionDisplayNameOrphan(tx, { householdId, name, shortName });
      await assertInstitutionDisplayNamesUnique(tx, {
        householdId,
        name,
        shortName,
        excludeId: reusable?.institution.id ?? null,
      });
      const data = { name, shortName: shortName || null, type: safeType, householdId };
      const institution = reusable
        ? await tx.institution.update({ where: { id: reusable.institution.id }, data })
        : await tx.institution.create({ data });
      await ensureCounterpartyForInstitution(tx, institution);
      return institution;
    });

    revalidateAfterSettingsChange();

    // Client-side handles page refresh
    return NextResponse.json({
      ok: true,
      institution: { id: created.id, name: created.name, shortName: created.shortName, type: created.type },
    });
  } catch (error) {
    if (isInstitutionNameUniqueError(error)) {
      return NextResponse.json({ ok: false, code: "INSTITUTION_NAME_CONFLICT", error: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: "Failed to create institution." }, { status: 500 });
  }
}
