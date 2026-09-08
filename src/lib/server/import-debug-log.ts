import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { logger } from "@/lib/logger";

export type ImportDebugValue = string | number | boolean | null;

export type ImportDebugEntry = {
  traceId: string;
  event: string;
  householdId: string;
  userId?: string | null;
  details: Record<string, ImportDebugValue>;
};

const LOG_CONTEXT = "batch-import";

export async function writeImportDebugLog(entry: ImportDebugEntry) {
  if (process.env.NODE_ENV !== "development") return;

  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  logger.info(line, LOG_CONTEXT);

  try {
    const logDirectory = path.join(process.cwd(), ".codex-logs");
    await mkdir(logDirectory, { recursive: true });
    await appendFile(path.join(logDirectory, "batch-import.debug.log"), `${line}\n`, "utf8");
  } catch (error) {
    logger.warn("开发调试日志文件写入失败", LOG_CONTEXT, error);
  }
}
