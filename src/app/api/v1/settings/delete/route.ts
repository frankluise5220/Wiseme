import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { recordDefaultCategoryDeletion } from "@/lib/default-categories";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { isAdmin } from "@/lib/server/auth";
import {
  deleteUnusedSyncedCounterpartiesForInstitution,
  deleteUnusedSyncedInstitutionForCounterparty,
} from "@/lib/server/counterparty-sync";
import { counterpartyLinkedAccountsWhere } from "@/lib/server/entity-account-counts";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";

export const runtime = "nodejs";

const BodySchema = z.object({
  entity: z.enum(["accountGroup", "account", "institution", "counterparty", "category"]),
  id: z.string().min(1),
});

export async function POST(req: Request) {
  const { householdId, user } = await getHouseholdScope();
  const body = (await req.json().catch(() => null)) as unknown;
  const parse = BodySchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "INVALID_PARAMETERS", error: "参数不正确" }, { status: 400 });
  }

  const { entity, id } = parse.data;

  if (entity === "accountGroup") {
    const group = await prisma.accountGroup.findUnique({ where: { id } });
    if (!group) return NextResponse.json({ ok: false, code: "ACCOUNT_GROUP_NOT_FOUND", error: "所有人不存在" }, { status: 404 });
    if (!isAdmin(user) && group.householdId && group.householdId !== householdId) return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
    const used = await prisma.account.count({ where: { groupId: id } });
    if (used > 0) return NextResponse.json({ ok: false, code: "GROUP_IN_USE", error: "已有账户属于该所有人，无法删除" }, { status: 409 });
    await prisma.accountGroup.delete({ where: { id } });
    revalidateAfterSettingsChange();
    // Client-side updates settings/account caches and broadcasts local change events.
    return NextResponse.json({ ok: true });
  }

  if (entity === "account") {
    const acc = await prisma.account.findUnique({ where: { id } });
    if (!acc) return NextResponse.json({ ok: false, code: "ACCOUNT_NOT_FOUND", error: "账户不存在" }, { status: 404 });
    if (!isAdmin(user) && acc.householdId && acc.householdId !== householdId) return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
    const used = await prisma.txRecord.count({ where: { accountId: id } });
    if (used > 0) return NextResponse.json({ ok: false, code: "ACCOUNT_IN_USE", error: "该账户已产生流水记录，无法删除" }, { status: 409 });
    await prisma.account.delete({ where: { id } });
    revalidateAfterSettingsChange();
    // Client-side updates settings/account caches and broadcasts local change events.
    return NextResponse.json({ ok: true });
  }

  if (entity === "institution") {
    const inst = await prisma.institution.findUnique({ where: { id } });
    if (!inst) return NextResponse.json({ ok: false, code: "INSTITUTION_NOT_FOUND", error: "机构不存在" }, { status: 404 });
    if (!isAdmin(user) && inst.householdId && inst.householdId !== householdId) return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
    const used = await prisma.account.count({ where: { institutionId: id } });
    if (used > 0) return NextResponse.json({ ok: false, code: "INSTITUTION_IN_USE", error: "已有账户使用该机构，无法删除" }, { status: 409 });
    // A family member's accounts live under the account group whose name matches the
    // member's name (same rule as the "关联账户" count in the settings list). Block
    // deletion while any non-placeholder account is still owned by this member.
    if (inst.type === "family_member" && inst.name) {
      const owned = await prisma.account.count({
        where: {
          householdId: inst.householdId ?? householdId,
          isPlaceholder: false,
          AccountGroup: { is: { name: inst.name } },
        },
      });
      if (owned > 0) return NextResponse.json({ ok: false, code: "INSTITUTION_IN_USE", error: `成员「${inst.name}」名下仍有 ${owned} 个账户，无法删除` }, { status: 409 });
    }
    await prisma.$transaction(async (tx) => {
      await deleteUnusedSyncedCounterpartiesForInstitution(tx, inst);
      await tx.institution.delete({ where: { id } });
    });
    revalidateAfterSettingsChange();
    // Client-side updates settings/account caches and broadcasts local change events.
    return NextResponse.json({ ok: true });
  }

  if (entity === "counterparty") {
    const counterparty = await prisma.counterparty.findUnique({ where: { id } });
    if (!counterparty) return NextResponse.json({ ok: false, code: "COUNTERPARTY_NOT_FOUND", error: "往来对象不存在" }, { status: 404 });
    if (!isAdmin(user) && counterparty.householdId !== householdId) return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
    // Same link rule as the "关联账户" count shown in the settings list: accounts may be
    // attached directly or through the mirrored institution (Counterparty.sourceInstitutionId).
    const used = await prisma.account.count({ where: counterpartyLinkedAccountsWhere(counterparty) });
    if (used > 0) return NextResponse.json({ ok: false, code: "COUNTERPARTY_IN_USE", error: "已有往来款使用该往来对象，无法删除" }, { status: 409 });
    await prisma.$transaction(async (tx) => {
      await deleteUnusedSyncedInstitutionForCounterparty(tx, counterparty);
      await tx.counterparty.delete({ where: { id } });
    });
    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true });
  }

  const category = await prisma.category.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      type: true,
      parentId: true,
      householdId: true,
      isSystem: true,
      Category: { select: { name: true } },
    },
  });
  if (!category) return NextResponse.json({ ok: false, code: "CATEGORY_NOT_FOUND", error: "类别不存在" }, { status: 404 });
  if (!isAdmin(user) && category.householdId && category.householdId !== householdId) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "越权操作" }, { status: 403 });
  }

  if (category.isSystem) {
    return NextResponse.json({ ok: false, code: "SYSTEM_CATEGORY_IMMUTABLE", error: "系统内置类别，无法删除" }, { status: 409 });
  }

  const [children, used] = await Promise.all([
    prisma.category.count({ where: { parentId: id } }),
    prisma.txRecord.count({
      where: {
        householdId,
        OR: [
          { categoryId: id },
          { categoryId: null, categoryName: category.name },
        ],
      },
    }),
  ]);

  if (children > 0) return NextResponse.json({ ok: false, code: "CATEGORY_HAS_CHILDREN", error: "该类别有子级，无法删除" }, { status: 409 });
  if (used > 0) return NextResponse.json({ ok: false, code: "CATEGORY_IN_USE", error: "该类别已产生流水记录，无法删除" }, { status: 409 });

  await prisma.$transaction(async (tx) => {
    await recordDefaultCategoryDeletion(tx, householdId, {
      type: category.type,
      name: category.name,
      parentName: category.Category?.name ?? null,
      isSystem: category.isSystem,
    });
    await tx.category.delete({ where: { id } });
  });
  revalidateAfterSettingsChange();
  // Client-side handles page refresh
  return NextResponse.json({ ok: true });
}
