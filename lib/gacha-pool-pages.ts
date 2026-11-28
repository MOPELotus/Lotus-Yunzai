/** Split content rather than lowering raster density. Pool statistics remain unchanged. */
export function splitGachaPoolPages<Model extends object>(model: Model, key: "data" | "pools", rows: "fiveLog" | "list", pageSize = 12): Model[] {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError("Invalid gacha page size");
  const source = model as Record<string, unknown>;
  const pools = source[key];
  if (!Array.isArray(pools)) throw new TypeError("Missing gacha pool collection");
  const pages: Model[] = [];
  for (const pool of pools) {
    const entries: readonly unknown[] = Array.isArray(pool[rows]) ? pool[rows] : [];
    if (!entries.length && ((source.pageInfo as { page?: number } | undefined)?.page ?? 1) > 1) continue;
    for (let start = 0; start < Math.max(1, entries.length); start += pageSize) {
      const slice = entries.slice(start, start + pageSize);
      pages.push({ ...model, [key]: [{ ...pool, [rows]: slice,
        ...(rows === "fiveLog" && "shownNum" in pool ? { shownNum: slice.length, hiddenNum: Math.max(0, pool.fiveNum - slice.length) } : {}),
      }] });
    }
  }
  return pages;
}

export function subdivideGachaPage<Page extends { model: object }>(pages: Page[], page: number, key: "data" | "pools", rows: "fiveLog" | "list") {
  const current = pages[page - 1];
  const pools = current && (current.model as Record<string, unknown>)[key];
  if (!Array.isArray(pools) || pools.length !== 1 || !Array.isArray(pools[0]?.[rows]) || pools[0][rows].length <= 1) return;
  const pieces = splitGachaPoolPages(current!.model, key, rows, Math.ceil(pools[0][rows].length / 2));
  pages.splice(page - 1, 1, ...pieces.map(model => ({ ...current!, model })));
  return pages.length;
}
