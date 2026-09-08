export type CaizhiRawRow = Record<string, unknown>;

export type CaizhiTableName =
  | "TBStdAcct"
  | "TBAcctType"
  | "TBAcctGroup"
  | "TBCategory"
  | "TBTransaction"
  | "TBTransType"
  | "TBCurrency";

export type CaizhiParsedBackup = {
  sourceFileName: string;
  extractedFromMh8: boolean;
  tables: {
    accounts: CaizhiRawRow[];
    accountTypes: CaizhiRawRow[];
    accountGroups: CaizhiRawRow[];
    categories: CaizhiRawRow[];
    transactions: CaizhiRawRow[];
    transactionTypes: CaizhiRawRow[];
    currencies: CaizhiRawRow[];
  };
  tableNames: string[];
};

export type CaizhiConversionOptions = {
  householdName?: string | null;
};

export type CaizhiConversionSummary = {
  householdName: string;
  accounts: number;
  categories: number;
  transactions: number;
  skippedTransactions: number;
  unsupportedTransactions: number;
  sourceFileName: string;
};

export type CaizhiConvertedBackup = {
  payload: {
    app: "MMH";
    formatVersion: number;
    exportedAt: Date;
    exportedBy: null;
    scope: {
      householdId: string;
      householdName: string;
      backupScope: "household";
    };
    counts: Record<string, number>;
    data: Record<string, unknown>;
  };
  summary: CaizhiConversionSummary;
};
