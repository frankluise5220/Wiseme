import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { normalizeDefaultCategoryHierarchyForHousehold } from "@/lib/default-categories";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { getApiHouseholdScope } from "@/lib/server/api-auth";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";
import { categoryOrderBy } from "@/lib/category-order";

export const runtime = "nodejs";

/**
 * GET /api/v1/category
 * Returns the category list (supports a tree structure).
 *
 * Query params:
 *   type? - optional filter: "expense" | "income" | "advance" | "transfer" | "investment"
 *
 * Response: { ok: true, categories: [{ id, name, type, parentId, sortOrder, isSystem }] }
 */
export async function GET(req: Request) {
  try {
    let householdId = "";
    let hidFilter: { householdId: string };

    // Try cookie auth first, fall back to X-Api-Key
    try {
      const ctx = await getHouseholdScope();
      householdId = ctx.householdId;
      hidFilter = ctx.hidFilter;
    } catch {
      const ctx = await getApiHouseholdScope(req);
      householdId = ctx.householdId;
      hidFilter = ctx.hidFilter;
    }

    await normalizeDefaultCategoryHierarchyForHousehold(prisma, householdId);

    const url = new URL(req.url);
    const typeFilter = url.searchParams.get("type")?.trim();

    const where: Record<string, unknown> = { ...hidFilter };
    if (typeFilter && !["expense", "income", "advance", "transfer", "investment"].includes(typeFilter)) {
      return NextResponse.json({ ok: true, categories: [] });
    }
    if (typeFilter) {
      where.type = typeFilter;
    }

    const categories = await prisma.category.findMany({
      where,
      orderBy: categoryOrderBy(),
      select: { id: true, name: true, type: true, parentId: true, sortOrder: true, isSystem: true },
    });

    return NextResponse.json({ ok: true, categories });
  } catch (e) {
    console.error("GET /api/v1/category error:", e);
    return NextResponse.json({ ok: false, code: "FETCH_FAILED", error: "查询失败" }, { status: 500 });
  }
}

const CATEGORY_TYPES = ["expense", "income", "advance", "transfer", "investment"] as const;
const RESERVED_CATEGORY_NAMES = new Set(["支出", "收入", "代付", "转账", "投资"]);

async function findDuplicateCategoryName(
  householdId: string,
  name: string,
  exceptId?: string,
) {
  return prisma.category.findFirst({
    where: {
      householdId,
      name,
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true },
  });
}

function isDuplicateCategoryNameError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * POST /api/v1/category
 * Creates a new category.
 *
 * Body: { name: string, type?: "expense" | "income" | "advance" | "transfer" | "investment", parentId?: string }
 * - When parentId is present, the category type is inherited from the parent category.
 * - Category name must be globally unique within the same household, regardless of income/expense type or parent.
 * - "expense", "income", "advance", "transfer", "investment" are category type roots and cannot be written as regular category names.
 * - Built-in business categories (investment profit, investment loss, repayment, loan, etc.) are shown in the same category tree for statistics linkage; they cannot be renamed, moved, or deleted.
 *
 * Response: { ok: true, category: { id, name, type, parentId, isSystem } }
 */
export async function POST(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const name = String(body.name ?? "").trim();
    const requestedType = String(body.type ?? "expense").trim();
    const parentId = String(body.parentId ?? "").trim() || null;

    if (!name || name.length > 50) {
      return NextResponse.json({ ok: false, code: "INVALID_CATEGORY_NAME", error: "分类名称不合法（1-50字）" }, { status: 400 });
    }
    if (RESERVED_CATEGORY_NAMES.has(name)) {
      return NextResponse.json({ ok: false, code: "RESERVED_CATEGORY_NAME", error: "支出、收入、代付、转账、投资是分类根目录，不能作为普通分类名称" }, { status: 400 });
    }
    if (!CATEGORY_TYPES.includes(requestedType as typeof CATEGORY_TYPES[number])) {
      return NextResponse.json({ ok: false, code: "INVALID_CATEGORY_TYPE", error: "分类类型不正确" }, { status: 400 });
    }

    let type = requestedType;
    if (parentId) {
      const parent = await prisma.category.findFirst({
        where: { id: parentId, householdId },
        select: { type: true },
      });
      if (!parent) {
        return NextResponse.json({ ok: false, code: "PARENT_CATEGORY_NOT_FOUND", error: "上级分类不存在" }, { status: 404 });
      }
      type = parent.type;
    }

    const duplicate = await findDuplicateCategoryName(householdId, name);
    if (duplicate) {
      return NextResponse.json({ ok: false, code: "CATEGORY_NAME_EXISTS", error: "分类名称已存在" }, { status: 409 });
    }

    const lastSibling = await prisma.category.findFirst({
      where: { householdId, type, parentId, isSystem: false },
      orderBy: [{ sortOrder: "desc" }, { name: "desc" }, { id: "desc" }],
      select: { sortOrder: true },
    });
    const category = await prisma.category.create({
      data: { name, type, parentId, householdId, sortOrder: (lastSibling?.sortOrder ?? -1) + 1, isSystem: false },
      select: { id: true, name: true, type: true, parentId: true, sortOrder: true, isSystem: true },
    });

    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, category });
  } catch (e) {
    if (isDuplicateCategoryNameError(e)) {
      return NextResponse.json({ ok: false, code: "CATEGORY_NAME_EXISTS", error: "分类名称已存在" }, { status: 409 });
    }
    console.error("POST /api/v1/category error:", e);
    return NextResponse.json({ ok: false, code: "CREATE_FAILED", error: "创建失败" }, { status: 500 });
  }
}

/**
 * PUT /api/v1/category
 * Updates the category name or moves the category in the hierarchy.
 *
 * Body: { id: string, name?: string, parentId?: string | null, orderedIds?: string[] }
 * - When name is present, the category name is updated.
 * - When parentId is present, the whole category node moves; child categories move with it.
 * - parentId empty/null means moving to the root of the current type.
 * - Moving across income/expense types is not allowed; moving under itself or its own descendants is not allowed.
 * - Category name must be globally unique within the same household, regardless of income/expense type or parent.
 * - System built-in categories cannot be renamed or moved, but user subcategories may be created under them.
 * - Renaming also updates categoryName on existing entries so old records stop showing the old name.
 * - orderedIds reorders user sibling categories. System categories do not participate in the order and remain after user categories.
 *
 * Response: { ok: true, category: { id, name, type, parentId, isSystem } }
 */
export async function PUT(req: NextRequest) {
  try {
    const { householdId } = await getHouseholdScope();
    const body = await req.json().catch(() => ({}));
    const id = String(body.id ?? "").trim();
    const hasName = Object.prototype.hasOwnProperty.call(body, "name");
    const hasParentId = Object.prototype.hasOwnProperty.call(body, "parentId");
    const hasOrderedIds = Array.isArray(body.orderedIds);
    const requestedName = hasName ? String(body.name ?? "").trim() : "";
    const requestedParentId = hasParentId ? String(body.parentId ?? "").trim() || null : undefined;
    const requestedOrderedIds = hasOrderedIds ? body.orderedIds.filter((value: unknown): value is string => typeof value === "string" && Boolean(value.trim())).map((value: string) => value.trim()) : [];

    if (!id) {
      return NextResponse.json({ ok: false, code: "MISSING_CATEGORY_ID", error: "缺少分类 ID" }, { status: 400 });
    }
    if (!hasName && !hasParentId && !hasOrderedIds) {
      return NextResponse.json({ ok: false, code: "MISSING_UPDATE_CONTENT", error: "缺少修改内容" }, { status: 400 });
    }
    if (hasName && (!requestedName || requestedName.length > 50)) {
      return NextResponse.json({ ok: false, code: "INVALID_CATEGORY_NAME", error: "分类名称不合法（1-50字）" }, { status: 400 });
    }
    if (hasName && RESERVED_CATEGORY_NAMES.has(requestedName)) {
      return NextResponse.json({ ok: false, code: "RESERVED_CATEGORY_NAME", error: "支出、收入、代付、转账、投资是分类根目录，不能作为普通分类名称" }, { status: 400 });
    }

    const current = await prisma.category.findFirst({
      where: { id, householdId },
      select: { id: true, name: true, type: true, parentId: true, sortOrder: true, isSystem: true },
    });
    if (!current) {
      return NextResponse.json({ ok: false, code: "CATEGORY_NOT_FOUND", error: "分类不存在" }, { status: 404 });
    }
    const name = hasName ? requestedName : current.name;
    const parentId = hasParentId ? requestedParentId : current.parentId;
    const nameChanged = hasName && name !== current.name;
    const parentChanged = hasParentId && parentId !== current.parentId;

    if (current.isSystem && (nameChanged || parentChanged || hasOrderedIds)) {
      return NextResponse.json({ ok: false, code: "SYSTEM_CATEGORY_IMMUTABLE", error: "系统内置类别，无法修改" }, { status: 409 });
    }

    if (parentId === id) {
      return NextResponse.json({ ok: false, code: "INVALID_PARENT_SELF", error: "不能移动到自身下面" }, { status: 400 });
    }

    if (parentId) {
      const parent = await prisma.category.findFirst({
        where: { id: parentId, householdId },
        select: { id: true, type: true, parentId: true },
      });
      if (!parent) {
        return NextResponse.json({ ok: false, code: "PARENT_CATEGORY_NOT_FOUND", error: "上级分类不存在" }, { status: 404 });
      }
      if (parent.type !== current.type) {
        return NextResponse.json({ ok: false, code: "CROSS_TYPE_MOVE_NOT_ALLOWED", error: "不能跨收支类型移动分类" }, { status: 400 });
      }

      let cursor: string | null = parent.parentId;
      while (cursor) {
        if (cursor === id) {
          return NextResponse.json({ ok: false, code: "INVALID_PARENT_DESCENDANT", error: "不能移动到自己的子分类下面" }, { status: 400 });
        }
        const ancestor = await prisma.category.findFirst({
          where: { id: cursor, householdId },
          select: { parentId: true },
        });
        cursor = ancestor?.parentId ?? null;
      }
    }

    const duplicate = await findDuplicateCategoryName(householdId, name, id);
    if (duplicate) {
      return NextResponse.json({ ok: false, code: "CATEGORY_NAME_EXISTS", error: "分类名称已存在" }, { status: 409 });
    }

    if (hasOrderedIds) {
      if (nameChanged || parentChanged || requestedOrderedIds.length === 0) {
        return NextResponse.json({ ok: false, code: "INVALID_REORDER_REQUEST", error: "排序请求不正确" }, { status: 400 });
      }
      const siblings = await prisma.category.findMany({
        where: { householdId, type: current.type, parentId: current.parentId },
        orderBy: [{ isSystem: "asc" }, { sortOrder: "asc" }, { name: "asc" }, { id: "asc" }],
        select: { id: true, sortOrder: true, isSystem: true },
      });
      const siblingIds = siblings.map((sibling) => sibling.id);
      const sameIds = siblingIds.length === requestedOrderedIds.length
        && siblingIds.every((siblingId) => requestedOrderedIds.includes(siblingId));
      if (!sameIds) {
        return NextResponse.json({ ok: false, code: "INVALID_REORDER_REQUEST", error: "排序范围不正确" }, { status: 400 });
      }
      for (let index = 0; index < siblings.length; index += 1) {
        if (siblings[index]?.isSystem && requestedOrderedIds[index] !== siblings[index]?.id) {
          return NextResponse.json({ ok: false, code: "SYSTEM_CATEGORY_IMMUTABLE", error: "系统内置类别，无法调整顺序" }, { status: 409 });
        }
      }
      const category = await prisma.$transaction(async (tx) => {
        for (let index = 0; index < requestedOrderedIds.length; index += 1) {
          if (siblings[index]?.isSystem) continue;
          await tx.category.update({
            where: { id: requestedOrderedIds[index] },
            data: { sortOrder: index },
          });
        }
        return tx.category.findUniqueOrThrow({
          where: { id },
          select: { id: true, name: true, type: true, parentId: true, sortOrder: true, isSystem: true },
        });
      });
      revalidateAfterSettingsChange();
      return NextResponse.json({ ok: true, category });
    }

    const category = await prisma.$transaction(async (tx) => {
      const nextParentSortOrder = parentChanged
        ? (await tx.category.findFirst({
            where: { householdId, type: current.type, parentId, isSystem: false },
            orderBy: [{ sortOrder: "desc" }, { name: "desc" }, { id: "desc" }],
            select: { sortOrder: true },
          }))?.sortOrder ?? -1
        : current.sortOrder;
      const updated = await tx.category.update({
        where: { id },
        data: {
          ...(hasName && name !== current.name ? { name } : {}),
          ...(hasParentId && parentId !== current.parentId ? { parentId } : {}),
          ...(parentChanged ? { sortOrder: nextParentSortOrder + 1 } : {}),
        },
        select: { id: true, name: true, type: true, parentId: true, sortOrder: true, isSystem: true },
      });
      if (hasName && name !== current.name) {
        await tx.txRecord.updateMany({
          where: { householdId, categoryId: id },
          data: { categoryName: name },
        });
      }
      return updated;
    });

    revalidateAfterSettingsChange();
    return NextResponse.json({ ok: true, category });
  } catch (e) {
    if (isDuplicateCategoryNameError(e)) {
      return NextResponse.json({ ok: false, code: "CATEGORY_NAME_EXISTS", error: "分类名称已存在" }, { status: 409 });
    }
    console.error("PUT /api/v1/category error:", e);
    return NextResponse.json({ ok: false, code: "UPDATE_FAILED", error: "修改失败" }, { status: 500 });
  }
}
