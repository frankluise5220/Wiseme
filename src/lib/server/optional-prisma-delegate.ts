type FindManyDelegate<Row> = {
  findMany: (args?: unknown) => Promise<Row[]>;
};

type DeleteManyDelegate = {
  deleteMany: (args?: unknown) => Promise<unknown>;
};

type CreateManyDelegate = {
  createMany: (args: { data: Record<string, unknown>[] }) => Promise<unknown>;
};

export type OptionalPrismaRestoreDelegate = DeleteManyDelegate & CreateManyDelegate;

export function getOptionalPrismaDelegate<T extends object>(client: unknown, delegateName: string): T | null {
  if (!client || typeof client !== "object") return null;
  const delegate = (client as Record<string, unknown>)[delegateName];
  if (!delegate || typeof delegate !== "object") return null;
  return delegate as T;
}

export function isMissingOptionalPrismaModelError(error: unknown, tableNames: string[] = []) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Cannot read properties of undefined")) return true;
  if (message.includes("P2021") || message.includes("P2022")) return true;
  if (message.includes("does not exist") || message.includes("not exist") || message.includes("no such table")) {
    return tableNames.length === 0 || tableNames.some((name) => message.includes(name));
  }
  return false;
}

export async function optionalPrismaFindMany<Row>(
  client: unknown,
  delegateName: string,
  args: unknown,
  options: { tableNames?: string[] } = {},
) {
  const delegate = getOptionalPrismaDelegate<FindManyDelegate<Row>>(client, delegateName);
  if (!delegate || typeof delegate.findMany !== "function") return [];
  try {
    return await delegate.findMany(args);
  } catch (error) {
    if (isMissingOptionalPrismaModelError(error, options.tableNames)) return [];
    throw error;
  }
}

export async function optionalPrismaDeleteMany(
  client: unknown,
  delegateName: string,
  args: unknown,
  options: { tableNames?: string[] } = {},
) {
  const delegate = getOptionalPrismaDelegate<DeleteManyDelegate>(client, delegateName);
  if (!delegate || typeof delegate.deleteMany !== "function") return false;
  try {
    await delegate.deleteMany(args);
    return true;
  } catch (error) {
    if (isMissingOptionalPrismaModelError(error, options.tableNames)) return false;
    throw error;
  }
}
