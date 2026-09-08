export async function extractPdfText(content: Buffer) {
  if (!content.length) return "";
  const mod = await import("pdf-parse");
  const parsePdf = (mod.default ?? mod) as (input: Buffer) => Promise<{ text?: string }>;
  const result = await parsePdf(content);
  return String(result.text ?? "").replace(/\r\n/g, "\n").trim();
}
