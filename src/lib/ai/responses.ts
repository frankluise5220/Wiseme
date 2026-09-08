export type ChatContentPart = {
  type: string;
  text?: string;
  image_url?: { url?: string };
};

function toResponsesContent(content: string | ChatContentPart[]) {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "image_url") {
      return { type: "input_image", image_url: part.image_url?.url ?? "" };
    }
    return { type: "input_text", text: part.text ?? "" };
  });
}

export function buildResponsesRequestBody(params: {
  modelName: string;
  instructions?: string;
  userMessage: string | ChatContentPart[];
  temperature?: number;
  maxOutputTokens?: number;
}): Record<string, unknown> {
  const instructions = params.instructions?.trim() ?? "";
  return {
    model: params.modelName,
    ...(instructions ? { instructions } : {}),
    input: [{ role: "user", content: toResponsesContent(params.userMessage) }],
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(params.maxOutputTokens === undefined ? {} : { max_output_tokens: params.maxOutputTokens }),
  };
}

export function extractResponsesText(data: unknown): string {
  const response = data as { output_text?: unknown; output?: unknown } | null;
  if (typeof response?.output_text === "string") return response.output_text;
  if (!Array.isArray(response?.output)) return "";

  return response.output
    .map((item) => {
      const message = item as { type?: string; content?: unknown };
      if (message?.type !== "message") return "";
      if (typeof message.content === "string") return message.content;
      if (!Array.isArray(message.content)) return "";
      return message.content
        .map((part) => {
          const contentPart = part as { type?: string; text?: unknown };
          return contentPart?.type === "output_text" && typeof contentPart.text === "string"
            ? contentPart.text
            : "";
        })
        .join("");
    })
    .join("");
}
