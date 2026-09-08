import MDBReader from "mdb-reader";
import type { CaizhiParsedBackup, CaizhiRawRow, CaizhiTableName } from "@/lib/importers/caizhi/types";

const JET4_HEADER = Buffer.from([0x00, 0x01, 0x00, 0x00, ...Buffer.from("Standard Jet DB\0", "ascii")]);

const requiredTables: CaizhiTableName[] = [
  "TBStdAcct",
  "TBAcctType",
  "TBAcctGroup",
  "TBCategory",
  "TBTransaction",
  "TBTransType",
  "TBCurrency",
];

function isJetDatabase(buffer: Buffer) {
  return buffer.subarray(4, 20).toString("ascii") === "Standard Jet DB\0";
}

function withMh8HeaderRestored(buffer: Buffer) {
  const restored = Buffer.from(buffer);
  JET4_HEADER.copy(restored, 0, 0, JET4_HEADER.length);
  return restored;
}

function openReader(buffer: Buffer, sourceFileName: string) {
  try {
    return { reader: new MDBReader(buffer), extractedFromMh8: false };
  } catch (directError) {
    if (isJetDatabase(buffer)) throw directError;
    try {
      return { reader: new MDBReader(withMh8HeaderRestored(buffer)), extractedFromMh8: true };
    } catch (restoredError) {
      const message = restoredError instanceof Error ? restoredError.message : String(restoredError);
      throw new Error(`Unable to read Caizhi backup ${sourceFileName}: ${message}`);
    }
  }
}

function getTableData(reader: MDBReader, name: CaizhiTableName): CaizhiRawRow[] {
  if (!reader.getTableNames().includes(name)) return [];
  return reader.getTable(name).getData() as CaizhiRawRow[];
}

export function parseCaizhiBackupBuffer(buffer: Buffer, sourceFileName: string): CaizhiParsedBackup {
  const { reader, extractedFromMh8 } = openReader(buffer, sourceFileName);
  const tableNames = reader.getTableNames();
  const missing = requiredTables.filter((name) => !tableNames.includes(name));
  if (missing.length > 0) {
    throw new Error(`Caizhi backup is missing required tables: ${missing.join(", ")}`);
  }

  return {
    sourceFileName,
    extractedFromMh8,
    tableNames,
    tables: {
      accounts: getTableData(reader, "TBStdAcct"),
      accountTypes: getTableData(reader, "TBAcctType"),
      accountGroups: getTableData(reader, "TBAcctGroup"),
      categories: getTableData(reader, "TBCategory"),
      transactions: getTableData(reader, "TBTransaction"),
      transactionTypes: getTableData(reader, "TBTransType"),
      currencies: getTableData(reader, "TBCurrency"),
    },
  };
}
