import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { ensureInstitutionForCounterparty } from "@/lib/server/counterparty-sync";
import {
  assertCounterpartyDisplayNamesUnique,
  isCounterpartyNameUniqueError,
} from "@/lib/server/counterparty-name-unique";
import { isInstitutionNameUniqueError } from "@/lib/server/institution-name-unique";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const shortName = typeof body?.shortName === "string" ? body.shortName.trim() : "";
  const type = typeof body?.type === "string" ? body.type.trim() : "person";

  if (!name) {
    return NextResponse.json({ ok: false, code: "NAME_REQUIRED", error: "往来对象名称不能为空" }, { status: 400 });
  }

  const { householdId } = await getHouseholdScope();
  const safeType = type === "organization" ? "organization" : "person";

  let created: { id: string; name: string; shortName: string | null; type: string | null };
  try {
    created = await prisma.$transaction(async (tx) => {
      await assertCounterpartyDisplayNamesUnique(tx, { householdId, name, shortName });
      const counterparty = await tx.counterparty.create({
        data: {
          name,
          shortName: shortName || null,
          type: safeType,
          householdId,
        },
      });
      const institution = await ensureInstitutionForCounterparty(tx, counterparty);
      return {
        ...counterparty,
        sourceInstitutionId: institution?.id ?? counterparty.sourceInstitutionId,
      };
    });
  } catch (error) {
    if (isCounterpartyNameUniqueError(error)) {
      return NextResponse.json({ ok: false, code: "COUNTERPARTY_NAME_CONFLICT", error: error.message }, { status: error.status });
    }
    if (isInstitutionNameUniqueError(error)) {
      return NextResponse.json({ ok: false, code: "INSTITUTION_NAME_CONFLICT", error: error.message }, { status: error.status });
    }
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: "创建失败" }, { status: 500 });
  }

  revalidateAfterSettingsChange();

  return NextResponse.json({
    ok: true,
    counterparty: {
      id: created.id,
      name: created.name,
      shortName: created.shortName,
      type: created.type,
    },
  });
}
