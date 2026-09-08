import { Prisma } from "@prisma/client";

type CreateManyDelegate<T> = {
  createMany(args: { data: T[] } | { data: T[]; skipDuplicates: true }): Promise<{ count: number }>;
  create(args: { data: T }): Promise<unknown>;
};

function isSqliteDatabaseUrl() {
  const url = process.env.DATABASE_URL ?? "";
  return url === ":memory:" || url.startsWith("file:");
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function createManySkipDuplicatesCompat<T>(
  delegate: CreateManyDelegate<T>,
  data: T[],
): Promise<{ count: number }> {
  if (data.length === 0) return { count: 0 };
  if (!isSqliteDatabaseUrl()) {
    return delegate.createMany({ data, skipDuplicates: true } as { data: T[]; skipDuplicates: true });
  }

  let count = 0;
  for (const item of data) {
    try {
      await delegate.create({ data: item });
      count += 1;
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
    }
  }
  return { count };
}
