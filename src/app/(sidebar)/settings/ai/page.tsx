import { prisma } from "@/lib/db/prisma";
import { decrypt, getOrCreateMasterKey, isEncrypted } from "@/lib/auth/encrypt";
import { getCurrentUser, isAdmin } from "@/lib/server/auth";
import { redirect } from "next/navigation";
import AISettingsClient, { type InitialAiChannel } from "./client";

export const dynamic = "force-dynamic";

async function loadInitialAiConfig(): Promise<{
  channels: InitialAiChannel[];
  activeModelId: string | null;
}> {
  const [channels, activeModel] = await Promise.all([
    prisma.aiChannel.findMany({
      orderBy: { createdAt: "asc" },
      include: { AiModel: { orderBy: { createdAt: "asc" } } },
    }),
    prisma.aiModel.findFirst({ where: { active: true }, select: { id: true } }),
  ]);

  const masterKey = await getOrCreateMasterKey();
  return {
    activeModelId: activeModel?.id ?? null,
    channels: channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      channelType: channel.channelType,
      baseUrl: channel.baseUrl,
      apiKey: channel.apiKey && isEncrypted(channel.apiKey) ? decrypt(channel.apiKey, masterKey) : channel.apiKey ?? "",
      AiModel: channel.AiModel.map((model) => ({
        id: model.id,
        name: model.name,
        model: model.model,
        vision: model.vision,
        apiMode: model.apiMode,
        active: model.active,
      })),
    })),
  };
}

export default async function AISettingsPage() {
  const user = await getCurrentUser();
  if (!isAdmin(user)) {
    redirect("/overview");
  }
  const initial = await loadInitialAiConfig().catch(() => ({ channels: [], activeModelId: null }));

  return (
    <AISettingsClient
      initialChannels={initial.channels}
      initialActiveModelId={initial.activeModelId}
    />
  );
}
