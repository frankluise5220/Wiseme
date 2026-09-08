import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { z } from "zod";
import { getHouseholdScope } from "@/lib/server/household-scope";
import { revalidateAfterSettingsChange } from "@/lib/server/revalidate";
import { loadReadableTagsByRecentUse } from "@/lib/server/tag-scope";

export const runtime = "nodejs";

/**
 * GET /api/v1/tags
 * Returns tags readable in the active household: current-household tags plus global/system tags.
 * Response: { ok: true, tags } or { ok: false, code, error }.
 *
 * POST /api/v1/tags
 * Body: { name: string, color?: string }. Creates a current-household tag.
 *
 * PUT /api/v1/tags
 * Body: { id: string, name: string, color?: string }. Updates a readable tag's display fields.
 *
 * DELETE /api/v1/tags?id=...
 * Deletes a current-household tag or a global/system tag when it exists.
 */
export async function GET() {
  try {
    const { householdId } = await getHouseholdScope();
    const tags = await loadReadableTagsByRecentUse(householdId);
    return NextResponse.json({ ok: true, tags });
  } catch {
    return NextResponse.json({ ok: false, code: "INTERNAL_ERROR", error: "Failed to fetch tags" }, { status: 500 });
  }
}

const CreateSchema = z.object({
  name: z.string().min(1).max(40),
  color: z.string().optional(),
});

const UpdateSchema = CreateSchema.extend({
  id: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "NAME_REQUIRED", error: "Name is required (1-40 characters)" }, { status: 400 });
  }

  const { hidFilter } = await getHouseholdScope();
  const { name, color } = parsed.data;
  const tag = await prisma.tag.create({ data: { name, color: color || null, ...hidFilter } });
  revalidateAfterSettingsChange();
  // Client-side handles page refresh
  return NextResponse.json({ ok: true, tag });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "NAME_REQUIRED", error: "Name is required (1-40 characters)" }, { status: 400 });
  }

  const { householdId } = await getHouseholdScope();
  const existing = await prisma.tag.findUnique({ where: { id: parsed.data.id } });
  if (!existing) return NextResponse.json({ ok: false, code: "TAG_NOT_FOUND", error: "Tag not found" }, { status: 404 });
  if (householdId && existing.householdId && existing.householdId !== householdId) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Forbidden" }, { status: 403 });
  }

  const tag = await prisma.tag.update({
    where: { id: parsed.data.id },
    data: {
      name: parsed.data.name.trim(),
      color: parsed.data.color || null,
    },
  });
  revalidateAfterSettingsChange();
  return NextResponse.json({ ok: true, tag });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ ok: false, code: "MISSING_ID", error: "Missing id" }, { status: 400 });

  const { householdId } = await getHouseholdScope();
  const existing = await prisma.tag.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ ok: false, code: "TAG_NOT_FOUND", error: "Tag not found" }, { status: 404 });
  if (householdId && existing.householdId && existing.householdId !== householdId) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "Forbidden" }, { status: 403 });
  }

  await prisma.tag.delete({ where: { id } });
  revalidateAfterSettingsChange();
  // Client-side handles page refresh
  return NextResponse.json({ ok: true });
}
