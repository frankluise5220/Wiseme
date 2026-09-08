declare module "better-sqlite3" {
  interface BackupProgress {
    totalPages: number;
    remainingPages: number;
  }

  interface BackupOptions {
    attached?: string;
    progress?: (progress: BackupProgress) => number | void;
  }

  interface Options {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
  }

  class Database {
    constructor(filename: string, options?: Options);
    backup(destination: string, options?: BackupOptions): Promise<BackupProgress>;
    prepare(sql: string): {
      get(...params: unknown[]): Record<string, unknown> | undefined;
      all(...params: unknown[]): Record<string, unknown>[];
      run(...params: unknown[]): unknown;
    };
    exec(sql: string): void;
    close(): void;
    pragma(name: string, options?: { simple?: boolean }): unknown;
  }

  export default Database;
}
