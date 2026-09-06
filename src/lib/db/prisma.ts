import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3WithSafeRollback } from "./sqlite-adapter";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaPool?: Pool;
};

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  if (connectionString === ":memory:" || connectionString.startsWith("file:")) {
    const adapter = new PrismaBetterSqlite3WithSafeRollback({
      url: connectionString,
    });
    return new PrismaClient({
      log: ["error"],
      adapter,
    });
  }

  const pool = globalForPrisma.prismaPool ?? new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX ?? 8),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 15_000),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000),
    keepAlive: true,
    keepAliveInitialDelayMillis: Number(process.env.PG_KEEPALIVE_INITIAL_DELAY_MS ?? 10_000),
  });
  globalForPrisma.prismaPool = pool;

  const adapter = new PrismaPg(pool);
  return new PrismaClient({
    log: ["error"],
    adapter,
  });
}

// In dev mode, webpack hot-reloading re-evaluates this module each time.
// With binary engine (PRISMA_CLIENT_ENGINE_TYPE="binary"), each PrismaClient
// spawns a separate query-engine child process. Without caching on globalThis,
// every hot reload creates a new PrismaClient -> a new node process, leading
// to hundreds of zombie processes that never get cleaned up.
// By caching on globalThis, we reuse the same PrismaClient across hot reloads.
export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
