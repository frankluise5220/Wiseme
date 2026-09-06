import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isAdmin } from "@/lib/server/auth";
import {
  assertInstitutionDisplayNamesUnique,
  isInstitutionNameUniqueError,
} from "@/lib/server/institution-name-unique";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const shortName = typeof body?.shortName === "string" ? body.shortName.trim() : "";

  if (!name) {
    return NextResponse.json({ ok: false, code: "GROUP_NAME_REQUIRED", error: "Owner name is required." }, { status: 400 });
  }

  const { householdId } = await getHouseholdScope();

  const lastGroup = await prisma.accountGroup.findFirst({
    where: { householdId },
    orderBy: { sortOrder: "desc" },
  });
  const nextSortOrder = (lastGroup?.sortOrder ?? 0) + 1;

  const created = await prisma.accountGroup.create({
    data: { name, sortOrder: nextSortOrder, householdId },
  }).catch(() => null);

  if (!created) {
    return NextResponse.json({ ok: false, code: "CREATE_FAILED", error: "Failed to create owner." }, { status: 500 });
  }

  const existingFamilyMember = await prisma.institution.findFirst({
    where: {
      householdId,
      type: "family_member",
      OR: [
        { name: created.name },
        { shortName: created.name },
        ...(shortName ? [{ name: shortName }, { shortName }] : []),
      ],
    },
    select: { id: true },
  });
  if (existingFamilyMember && shortName) {
    try {
      await assertInstitutionDisplayNamesUnique(prisma, {
        householdId,
        name: created.name,
        shortName,
        excludeId: existingFamilyMember.id,
      });
      await prisma.institution.update({
        where: { id: existingFamilyMember.id },
        data: { name: created.name, shortName },
      });
    } catch (error) {
      if (!isInstitutionNameUniqueError(error)) console.warn("[account-group] family member short-name sync failed", error);
    }
  }
  if (!existingFamilyMember) {
    try {
      await assertInstitutionDisplayNamesUnique(prisma, { householdId, name: created.name, shortName });
      await prisma.institution.create({
        data: {
          householdId,
          type: "family_member",
          name: created.name,
          shortName: shortName || null,
        },
      });
    } catch (error) {
      if (!isInstitutionNameUniqueError(error)) console.warn("[account-group] family member sync failed", error);
    }
  }

  // Client-side handles page refresh
  revalidateAfterSettingsChange();
  return NextResponse.json({ ok: true, group: { id: created.id, name: created.name } });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const shortName = typeof body?.shortName === "string" ? body.shortName.trim() : "";

  if (!id || !name) {
    return NextResponse.json({ ok: false, code: "MISSING_REQUIRED_FIELDS", error: "Missing required fields." }, { status: 400 });
  }

  const { householdId, user } = await getHouseholdScope();

  const group = await prisma.accountGroup.findUnique({ where: { id } });
  if (!group) return NextResponse.json({ ok: false, code: "GROUP_NOT_FOUND", error: "Owner not found." }, { status: 404 });
  if (!isAdmin(user) && group.householdId !== householdId) return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Forbidden." }, { status: 403 });

  await prisma.accountGroup.update({ where: { id }, data: { name } });
  const legacyFamilyMember = await prisma.institution.findFirst({
    where: {
      householdId,
      type: "family_member",
      name: group.name,
    },
  });
  if (legacyFamilyMember) {
    try {
      await assertInstitutionDisplayNamesUnique(prisma, {
        householdId,
        name,
        shortName,
        excludeId: legacyFamilyMember.id,
      });
      await prisma.institution.update({
        where: { id: legacyFamilyMember.id },
        data: { name, shortName: shortName || null },
      });
    } catch (error) {
      if (!isInstitutionNameUniqueError(error)) console.warn("[account-group] family member rename sync failed", error);
    }
  } else {
    const existingFamilyMember = await prisma.institution.findFirst({
      where: {
        householdId,
        type: "family_member",
        OR: [{ name }, { shortName: name }],
      },
      select: { id: true },
    });
    if (!existingFamilyMember) {
      try {
        await assertInstitutionDisplayNamesUnique(prisma, { householdId, name, shortName });
        await prisma.institution.create({
          data: {
            householdId,
            type: "family_member",
            name,
            shortName: shortName || null,
          },
        });
      } catch (error) {
        if (!isInstitutionNameUniqueError(error)) console.warn("[account-group] family member create sync failed", error);
      }
    }
  }
  // Client-side handles page refresh
  revalidateAfterSettingsChange();
  return NextResponse.json({ ok: true });
}
