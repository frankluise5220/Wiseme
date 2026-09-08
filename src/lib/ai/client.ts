// LLM communication: fetch, classify, and account context building

import { prisma } from "@/lib/db/prisma";
import { joinBaseUrl } from "@/lib/http";
import { CLASSIFY_PROMPT } from "@/lib/ai/prompts";
import { normalizeAiApiMode, type AiApiMode } from "@/lib/ai/config";
import { buildResponsesRequestBody, extractResponsesText } from "@/lib/ai/responses";

export function modelSupportsVision(modelName: string): boolean {
  const lower = modelName.toLowerCase();
  return [
    "gpt-4o",
    "gpt-4-turbo",
    "gpt-4-vision",
    "claude-3",
    "claude-3.5",
    "claude-3.7",
    "gemini-1.5",
    "gemini-2",
    "gemini-pro-vision",
    "qwen-vl",
    "qwen2-vl",
    "vision",
  ].some((m) => lower.includes(m)) || lower.includes("vision") || lower.includes("vl") || lower.includes("gemma3");
}

export async function buildAccountContextText(householdId?: string) {
  try {
    const accounts = await prisma.account.findMany({
      where: { isActive: true, ...(householdId ? { householdId } : {}) },
      include: { Institution: true },
      orderBy: [{ name: "asc" }],
      take: 300,
    });

    let aliases: Array<{ alias: string; account: { id: string; name: string; Institution: { name: string } | null } }> = [];
    try {
      const aliasModel = (prisma as any).accountAlias;
      if (aliasModel?.findMany) {
        aliases = await aliasModel.findMany({
          where: householdId ? { Account: { householdId } } : undefined,
          include: { Account: { include: { Institution: true } } },
          orderBy: [{ alias: "asc" }],
          take: 1000,
        });
      }
    } catch {
      aliases = [];
    }

    const canonical = accounts.map((a) => {
      const label = a.Institution?.name ? `${a.Institution.name}·${a.name}` : a.name;
      const masked = a.numberMasked ? `|尾号=${a.numberMasked}` : "";
      return `${a.id}|${label}${masked}`;
    });

    const aliasLines = aliases
      .map((x) => {
        const target = x.account.Institution?.name ? `${x.account.Institution.name}·${x.account.name}` : x.account.name;
        return `${x.alias} => ${x.account.id}|${target}`;
      })
      .slice(0, 300);

    const categories = await prisma.category.findMany({
      where: householdId ? { householdId } : undefined,
      select: { id: true, name: true, type: true, parentId: true },
      orderBy: [{ type: "asc" }, { name: "asc" }],
      take: 1000,
    });
    const categoryById = new Map(categories.map((category) => [category.id, category]));
    const categoryPath = (category: (typeof categories)[number]) => {
      const parts = [category.name];
      let parentId = category.parentId;
      let guard = 0;
      while (parentId && guard++ < 8) {
        const parent = categoryById.get(parentId);
        if (!parent) break;
        parts.unshift(parent.name);
        parentId = parent.parentId;
      }
      return parts.join(".");
    };
    const categoryLines = categories.map((category) =>
      `${category.id}|${category.type}|${categoryPath(category)}`,
    );

    const institutions = await prisma.institution.findMany({
      where: householdId ? { householdId } : undefined,
      select: { id: true, name: true, shortName: true },
      orderBy: [{ name: "asc" }],
      take: 500,
    });

    const lines = [
      `可用账户（严格优先匹配以下标准账户名）：${canonical.join("、") || "（暂无）"}`,
      `账户别名映射（命中别名时应归一到右侧标准账户）：${aliasLines.join("；") || "（暂无）"}`,
      `可用分类（格式为 categoryId|type|层级路径，只能从中选择）：${categoryLines.join("；") || "（暂无）"}`,
      `可用收支机构（格式为 institutionId|名称|简称，只能从中选择；未匹配时保留用户原文）：${institutions.map((item) => `${item.id}|${item.name}|${item.shortName ?? ""}`).join("；") || "（暂无）"}`,
    ];

    return lines.join("\n");
  } catch {
    return "可用账户列表暂时无法加载，请按实际账户名称匹配。";
  }
}

export type Classification = { inputType: string; confidence: number; reason: string };

export function extractInputType(raw: string): Classification | null {
  for (const pat of [/```json\s*([\s\S]*?)\s*```/i, /```\s*([\s\S]*?)\s*```/, /(\{[\s\S]*\})/]) {
    const m = raw.match(pat);
    if (m) {
      try {
        const obj = JSON.parse(m[1] ?? m[0]);
        if (obj?.inputType) return obj;
      } catch { continue; }
    }
  }
  try {
    const obj = JSON.parse(raw);
    if (obj?.inputType) return obj;
  } catch { return null; }
  return null;
}

export async function classifyInput(
  userText: string,
  model: string,
  base: string,
  key: string,
  ollamaMode: boolean,
  apiMode: AiApiMode = "chat",
  imageDataUrl?: string,
): Promise<Classification | null> {
  if (!userText || imageDataUrl) return null;
  try {
    const promptContent = `输入内容：${userText.slice(0, 500)}`;
    if (ollamaMode) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (key) headers.Authorization = `Bearer ${key}`;
      const body = {
        model,
        stream: false,
        messages: [
          { role: "system", content: CLASSIFY_PROMPT },
          { role: "user", content: promptContent },
        ],
      };
      const r = await fetch(`${base}/api/chat`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!r.ok) return null;
      const d = await r.json().catch(() => null);
      const content = (d as any)?.message?.content ?? "";
      return extractInputType(content);
    } else {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (key) headers.Authorization = `Bearer ${key}`;
      const body = apiMode === "responses"
        ? buildResponsesRequestBody({ modelName: model, instructions: CLASSIFY_PROMPT, userMessage: promptContent })
        : {
            model,
            messages: [
              { role: "system", content: CLASSIFY_PROMPT },
              { role: "user", content: promptContent },
            ],
          };
      const r = await fetch(`${base}${apiMode === "responses" ? "/v1/responses" : "/v1/chat/completions"}`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!r.ok) return null;
      const d = await r.json().catch(() => null);
      const content = apiMode === "responses"
        ? extractResponsesText(d)
        : (d as any)?.choices?.[0]?.message?.content ?? "";
      return extractInputType(content);
    }
  } catch {
    return null;
  }
}

/** Unified LLM chat call. Handles both Ollama and OpenAI-compatible APIs. */
export async function callLlmChat(params: {
  modelName: string;
  baseUrl: string;
  apiKey: string;
  isOllama: boolean;
  systemPrompt: string;
  userMessage: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  ollamaImages?: string[];
  temperature?: number;
  apiMode?: AiApiMode;
}): Promise<string> {
  const { modelName, baseUrl, apiKey, isOllama, systemPrompt, userMessage, ollamaImages, temperature } = params;
  const apiMode = normalizeAiApiMode(params.apiMode);
  const cleanUrl = baseUrl.replace(/\/$/, "");
  const temp = temperature ?? 0.1;

  if (isOllama) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = (apiKey ?? "").trim();
    if (key) headers.Authorization = `Bearer ${key}`;

    const ollamaBody: Record<string, unknown> = {
      model: modelName,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        typeof userMessage === "string"
          ? { role: "user", content: userMessage }
          : { role: "user", content: typeof (userMessage as any)?.[0]?.text === "string" ? (userMessage as any)[0].text : "", images: ollamaImages ?? [] },
      ],
    };

    const llmRes = await fetch(joinBaseUrl(cleanUrl, "/api/chat"), {
      method: "POST",
      headers,
      body: JSON.stringify(ollamaBody),
    });

    if (!llmRes.ok) {
      const errText = await llmRes.text().catch(() => "");
      throw new Error(`LLM 调用失败 (${llmRes.status}): ${errText.slice(0, 300)}`);
    }

    const llmData = (await llmRes.json().catch(() => null)) as
      | { message?: { content?: string | null } }
      | { response?: string | null }
      | null;

    return (llmData as any)?.message?.content ?? (llmData as any)?.response ?? "";
  } else {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = (apiKey ?? "").trim();
    if (key) headers.Authorization = `Bearer ${key}`;

    const llmBody: Record<string, unknown> = apiMode === "responses"
      ? buildResponsesRequestBody({
          modelName,
          instructions: systemPrompt,
          userMessage,
          temperature: temp,
        })
      : {
          model: modelName,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          temperature: temp,
        };

    const llmRes = await fetch(joinBaseUrl(cleanUrl, apiMode === "responses" ? "/v1/responses" : "/v1/chat/completions"), {
      method: "POST",
      headers,
      body: JSON.stringify(llmBody),
    });

    if (!llmRes.ok) {
      const errText = await llmRes.text().catch(() => "");
      throw new Error(`LLM 调用失败 (${llmRes.status}): ${errText.slice(0, 300)}`);
    }

    const llmData = (await llmRes.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      error?: { message?: string };
    } | null;

    if (llmData?.error) {
      throw new Error(`LLM 错误: ${llmData.error.message ?? "未知错误"}`);
    }

    return apiMode === "responses"
      ? extractResponsesText(llmData)
      : llmData?.choices?.[0]?.message?.content ?? "";
  }
}
