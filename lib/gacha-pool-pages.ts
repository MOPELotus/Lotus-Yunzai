/** Keep each pool intact in its own image. */
export function splitGachaPoolPages<Model extends object>(model: Model, key: "data" | "pools", rows: "fiveLog" | "list"): Model[] {
  const source = model as Record<string, unknown>;
  const pools = source[key];
  if (!Array.isArray(pools)) throw new TypeError("Missing gacha pool collection");
  return pools.filter(pool => Array.isArray(pool[rows]) && (pool[rows].length || ((source.pageInfo as { page?: number } | undefined)?.page ?? 1) === 1))
    .map(pool => ({ ...model, [key]: [pool] }));
}
