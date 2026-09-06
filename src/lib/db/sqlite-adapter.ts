import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

/** Compensate for Prisma 7.8 discarding a late-started transaction via rollback() alone. */
export class PrismaBetterSqlite3WithSafeRollback extends PrismaBetterSqlite3 {
  override async connect() {
    const adapter = await super.connect();
    const startTransaction = adapter.startTransaction.bind(adapter);
    adapter.startTransaction = async (...args) => {
      const transaction = await startTransaction(...args);
      if (transaction.options.usePhantomQuery) return transaction;

      const executeRaw = transaction.executeRaw.bind(transaction);
      const rollback = transaction.rollback.bind(transaction);
      let closed = false;
      transaction.executeRaw = async (query) => {
        const result = await executeRaw(query);
        if (query.sql === "COMMIT" || query.sql === "ROLLBACK") closed = true;
        return result;
      };
      transaction.rollback = async () => {
        try {
          // Normal closure sends SQL first. Startup timeout skips that SQL; the
          // adapter's rollback only unlocks its mutex, leaving SQLite in BEGIN.
          if (!closed) await transaction.executeRaw({ sql: "ROLLBACK", args: [], argTypes: [] });
        } finally {
          await rollback();
        }
      };
      return transaction;
    };
    return adapter;
  }
}
