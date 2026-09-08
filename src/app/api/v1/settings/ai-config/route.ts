import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { getOrCreateMasterKey, encrypt, decrypt, isEncrypted } from "@/lib/auth/encrypt";
import { normalizeAiApiMode } from "@/lib/ai/config";

export const runtime = "nodejs";

/**
 * AI channel/model configuration API (admin only).
 *
 * GET    /api/v1/settings/ai-config → list channels (with decrypted apiKey for admin review)
 * POST   /api/v1/settings/ai-config → create channel { name, channelType?, baseUrl, apiKey? }
 * PUT    /api/v1/settings/ai-config → update channel / add or remove models / set active model
 * Model payloads accept apiMode: "chat" (Chat Completions) or "responses" (Responses API).
 * DELETE /api/v1/settings/ai-config?id=… → delete channel
 */
async function requireAdmin(): Promise<NextResponse | null> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, code: "UNAUTHORIZED", error: "请先登录" }, { status: 401 });
  }
  if (!isAdmin(user)) {
    return NextResponse.json({ ok: false, code: "FORBIDDEN", error: "仅管理员可操作" }, { status: 403 });
  }
  return null;
}

export async function GET() {
  const auth = await requireAdmin();
  if (auth) return auth;

  const channels = await prisma.aiChannel.findMany({
    orderBy: { createdAt: "asc" },
    include: { AiModel: { orderBy: { createdAt: "asc" } } },
  });
  const masterKey = await getOrCreateMasterKey();
  const activeModel = await prisma.aiModel.findFirst({ where: { active: true } });
  // Decrypt apiKey in each channel before returning
  const decoded = channels.map(ch => ({
    ...ch,
    apiKey: ch.apiKey && isEncrypted(ch.apiKey) ? decrypt(ch.apiKey, masterKey) : ch.apiKey,
  }));
  return NextResponse.json({ ok: true, channels: decoded, activeModelId: activeModel?.id ?? null });
}

const ChannelSchema = z.object({
  name: z.string().min(1).max(80),
  channelType: z.string().min(1).max(20).optional(),
  baseUrl: z.string().min(4).max(300),
  apiKey: z.string().max(200).optional(),
});

export async function POST(req: Request) {
  const auth = await requireAdmin();
  if (auth) return auth;

  const body = (await req.json().catch(() => null)) as unknown;
  const parse = ChannelSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ ok: false, code: "MISSING_REQUIRED_FIELDS", error: "缺少必填字段" }, { status: 400 });
  }
  const masterKey = await getOrCreateMasterKey();
  const encryptedApiKey = parse.data.apiKey && !isEncrypted(parse.data.apiKey)
    ? encrypt(parse.data.apiKey, masterKey)
    : parse.data.apiKey;
  const created = await prisma.aiChannel.create({
    data: { name: parse.data.name, channelType: parse.data.channelType ?? "custom", baseUrl: parse.data.baseUrl, apiKey: encryptedApiKey } as any,
    include: { AiModel: true },
  });
  return NextResponse.json({ ok: true, channel: created });
}

export async function DELETE(req: Request) {
  const auth = await requireAdmin();
  if (auth) return auth;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ ok: false, code: "MISSING_ID", error: "缺少 id" }, { status: 400 });

  const existing = await prisma.aiChannel.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ ok: false, code: "CHANNEL_NOT_FOUND", error: "AI 渠道不存在" }, { status: 404 });

  await prisma.aiChannel.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

const ModelSchema = z.object({
  model: z.string().min(1).max(80),
  name: z.string().max(80).optional(),
  channelId: z.string(),
  vision: z.boolean().optional(),
  apiMode: z.enum(["chat", "responses"]).optional(),
});

export async function PUT(req: Request) {
  const auth = await requireAdmin();
  if (auth) return auth;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  // Update channel (channelId + name + channelType + baseUrl + apiKey)
  if (body && "channelId" in body && "baseUrl" in body) {
    const channelId = (body as any).channelId as string;
    const name = (body as any).name as string | undefined;
    const channelType = (body as any).channelType as string | undefined;
    const baseUrl = (body as any).baseUrl as string;
    const apiKey = (body as any).apiKey as string | undefined;
    const existing = await prisma.aiChannel.findUnique({ where: { id: channelId } });
    if (!existing) return NextResponse.json({ ok: false, code: "CHANNEL_NOT_FOUND", error: "AI 渠道不存在" }, { status: 404 });
    const masterKey = await getOrCreateMasterKey();
    const encryptedApiKey = apiKey !== undefined && !isEncrypted(apiKey) ? encrypt(apiKey, masterKey) : apiKey;
    const updated = await prisma.aiChannel.update({
      where: { id: channelId },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(channelType !== undefined ? { channelType } : {}),
        baseUrl,
        ...(apiKey !== undefined ? { apiKey: encryptedApiKey } : {}),
      } as any,
      include: { AiModel: true },
    });
    const decoded = { ...updated, apiKey: updated.apiKey && isEncrypted(updated.apiKey) ? decrypt(updated.apiKey, masterKey) : updated.apiKey };
    return NextResponse.json({ ok: true, channel: decoded });
  }

  // Add model
  if (body && "model" in body && "channelId" in body) {
    const parse = ModelSchema.safeParse(body);
    if (!parse.success) return NextResponse.json({ ok: false, code: "MISSING_REQUIRED_FIELDS", error: "缺少必填字段" }, { status: 400 });
    const created = await prisma.aiModel.create({
      data: { model: parse.data.model, name: parse.data.name, channelId: parse.data.channelId, vision: parse.data.vision ?? false, apiMode: normalizeAiApiMode(parse.data.apiMode) },
    });
    return NextResponse.json({ ok: true, model: created });
  }

  // Update model (updateModelId + model + name + vision + apiMode)
  if (body && "updateModelId" in body) {
    const updateModelId = (body as any).updateModelId as string;
    const model = (body as any).model as string | undefined;
    const name = (body as any).name as string | undefined;
    const vision = (body as any).vision as boolean | undefined;
    const apiMode = (body as any).apiMode as string | undefined;
    const modelExists = await prisma.aiModel.findUnique({ where: { id: updateModelId } });
    if (!modelExists) return NextResponse.json({ ok: false, code: "MODEL_NOT_FOUND", error: "AI 模型不存在" }, { status: 404 });
    const updated = await prisma.aiModel.update({
      where: { id: updateModelId },
      data: {
        ...(model !== undefined ? { model } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(vision !== undefined ? { vision } : {}),
        ...(apiMode !== undefined ? { apiMode: normalizeAiApiMode(apiMode) } : {}),
      },
    });
    return NextResponse.json({ ok: true, model: updated });
  }

  // Set active model
  if (body && "activeModelId" in body) {
    const activeModelId = (body as any).activeModelId as string;
    await prisma.aiModel.updateMany({ where: { active: true }, data: { active: false } });
    if (activeModelId) {
      await prisma.aiModel.update({ where: { id: activeModelId }, data: { active: true } });
    }
    return NextResponse.json({ ok: true });
  }

  // Delete model
  if (body && "deleteModelId" in body) {
    const deleteModelId = (body as any).deleteModelId as string;
    const modelExists = await prisma.aiModel.findUnique({ where: { id: deleteModelId } });
    if (!modelExists) return NextResponse.json({ ok: false, code: "MODEL_NOT_FOUND", error: "AI 模型不存在" }, { status: 404 });
    await prisma.aiModel.delete({ where: { id: deleteModelId } });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, code: "UNKNOWN_OPERATION", error: "未知操作" }, { status: 400 });
}