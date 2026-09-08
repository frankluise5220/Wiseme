declare module "pdf-parse" {
  export default function parsePdf(input: Buffer): Promise<{ text?: string; numpages?: number; info?: unknown; metadata?: unknown }>;
}
