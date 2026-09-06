import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { hashAccessKey, storedAccessKeyPreview } from "@/lib/server/access-key-auth";

export const runtime = "nodejs";

/**
 * API Key management endpoint (admin only).
 *
 * GET   /api/v1/settings/access-keys        → Lists API keys with masked previews only
 * POST  /api/v1/settings/access-keys        → Creates { name, key }; stores only a hash
 * DELETE /api/v1/settings/access-keys?id=…  → Deletes the specified key
 */
async function requireAdmin(): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "Sign in first." }, { status: 401 }) };
  }
  if (!isAdmin(user)) {
    return { ok: false, response: NextResponse.json({ ok: false, code: "ADMIN_REQUIRED", error: "Administrator permission is required." }, { status: 403 }) };
  }
  return { ok: true };
}

export async function GET() {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const keys = await prisma.accessKey.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, key: true, createdAt: true },
  });

  return NextResponse.json({
    ok: true,
    keys: keys.map((key) => ({
      id: key.id,
      name: key.name,
      keyPreview: storedAccessKeyPreview(key.key),
      createdAt: key.createdAt,
    })),
  });
}

const CreateSchema = z.object({
  name: z.string().min(1).max(80),
  key: z.string().min(16).max(200),
});

export async function POST(req: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => null)) as unknown;
  const parse = CreateSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json(
      { ok: false, code: "INVALID_REQUEST", error: "Name and a strong access key are required." },
      { status: 400 },
    );
  }

  const { name, key } = parse.data;
  const hashedKey = await hashAccessKey(key);

  const created = await prisma.accessKey.create({
    data: { name, key: hashedKey },
    select: { id: true, name: true, key: true, createdAt: true },
  });

  return NextResponse.json({
    ok: true,
    key: {
      id: created.id,
      name: created.name,
      keyPreview: storedAccessKeyPreview(created.key),
      createdAt: created.createdAt,
    },
  });
}

export async function DELETE(req: Request) {
  const auth = await requireAdmin();
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";

  if (!id) {
    return NextResponse.json({ ok: false, code: "MISSING_ID", error: "Missing id." }, { status: 400 });
  }

  const existing = await prisma.accessKey.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ ok: false, code: "ACCESS_KEY_NOT_FOUND", error: "API key was not found." }, { status: 404 });
  }

  await prisma.accessKey.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
