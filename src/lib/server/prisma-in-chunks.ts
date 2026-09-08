/**
 * SQLite limits each query to a fixed number of bound parameters
 * (SQLITE_MAX_VARIABLE_NUMBER defaults to 999). Each id in an `in` clause uses
 * one parameter, so several `in` clauses in the same query (for example an OR
 * containing repeated `{ in: ids }`) add up quickly for batch operations.
 */
export const IN_LIST_PARAM_LIMIT = 999;

/**
 * Target chunk size for each `in` clause. Keep enough headroom for queries
 * containing several `in` clauses over the same ids (for example 9 `in` clauses
 * in an OR). At 100 ids per chunk, 9 clauses produce 900 parameters, below 999.
 */
export const IN_CHUNK_SIZE = 100;

/**
 * Split an array into fixed-size chunks while preserving order.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
