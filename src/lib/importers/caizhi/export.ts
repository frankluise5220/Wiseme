import { buildBackupFileName, encryptBackupPayload, type HouseholdBackupPayload } from "@/lib/server/backup";
import { buildMmhBackupPayloadFromCaizhi } from "@/lib/importers/caizhi/mapper";
import { parseCaizhiBackupBuffer } from "@/lib/importers/caizhi/parser";
import type { CaizhiConversionOptions, CaizhiConversionSummary } from "@/lib/importers/caizhi/types";

export type CaizhiBackupExportResult = {
  fileName: string;
  json: string;
  summary: CaizhiConversionSummary;
};

export async function convertCaizhiBackupToMmhBackup(
  buffer: Buffer,
  sourceFileName: string,
  passphrase: string,
  options: CaizhiConversionOptions = {},
): Promise<CaizhiBackupExportResult> {
  const trimmedPassphrase = passphrase.trim();
  if (!trimmedPassphrase) {
    throw new Error("Backup passphrase is required for converted MMH backup files");
  }

  const parsed = parseCaizhiBackupBuffer(buffer, sourceFileName);
  const converted = buildMmhBackupPayloadFromCaizhi(parsed, options);
  const encryptedPayload = await encryptBackupPayload(converted.payload as HouseholdBackupPayload, { passphrase: trimmedPassphrase });
  const fileName = buildBackupFileName(
    converted.payload.scope.householdName,
    converted.payload.exportedAt,
    "mmhbackup",
  );

  return {
    fileName,
    json: JSON.stringify(encryptedPayload, null, 2),
    summary: converted.summary,
  };
}
