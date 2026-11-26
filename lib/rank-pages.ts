export const groupRankPageSize = 30;
export interface RankPagination { readonly offset: number; readonly page: number; readonly total: number }
export async function renderRankPages<T>(rows: readonly T[],
  render: (rows: readonly T[], pagination: RankPagination) => Promise<{ readonly png: Uint8Array } | undefined>,
  signal: AbortSignal) {
  const nodes: { readonly type: "image"; readonly file: Uint8Array }[] = [];
  const total = Math.ceil(rows.length / groupRankPageSize);
  for (let offset = 0; offset < rows.length; offset += groupRankPageSize) {
    signal.throwIfAborted();
    const image = await render(rows.slice(offset, offset + groupRankPageSize), { offset, page: offset / groupRankPageSize + 1, total }).catch(() => undefined);
    if (!image) return;
    nodes.push({ type: "image", file: image.png });
  }
  signal.throwIfAborted();
  return nodes.length ? { type: "forward" as const, nodes } : undefined;
}
