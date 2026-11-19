import { Database } from "bun:sqlite";
import { link, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const maxLines = 4096;
const maxCacheBytes = 4 * 1024 * 1024;

function clean(value: unknown) {
  return typeof value === "string" ? value.replace(/<[^>]+>/gu, "").replace(/\s+/gu, " ").trim() : "";
}

async function cachedLines(file: URL) {
  try {
    const input = Bun.file(file);
    if (!await input.exists() || input.size > maxCacheBytes) return [];
    const { lines } = await input.json();
    return Array.isArray(lines) ? lines.slice(0, maxLines).map(clean).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function contentLines(value: unknown): string[] {
  if (typeof value !== "string") return [];
  let content: unknown;
  try { content = JSON.parse(value); } catch { content = value; }
  const items = Array.isArray(content) ? content : [typeof content === "string" ? content : value];
  return items.flatMap(line => typeof line === "string" ? line.replace(/\r/gu, "\n").split(/(?<=[。！？!?；;])\s*|\n+/u)
    .map(clean).filter(Boolean) : []);
}

async function databaseLines(file: URL) {
  if (!await Bun.file(file).exists()) return [];
  const db = new Database(fileURLToPath(file), { readonly: true });
  try {
    const rows = db.query<{ title: string; author?: string; dynasty?: string; content: string }, []>(`
      SELECT p.title, p.content, a.name AS author, d.name AS dynasty
      FROM poems_zh_hans p
      LEFT JOIN authors_zh_hans a ON a.id = p.author_id
      LEFT JOIN dynasties_zh_hans d ON d.id = p.dynasty_id
      WHERE p.content IS NOT NULL AND p.content != '' ORDER BY random() LIMIT 1200
    `).iterate();
    const lines: string[] = [];
    for (const row of rows) {
      const dynasty = clean(row.dynasty);
      const title = clean(row.title);
      const source = [dynasty && `[${dynasty}]`, clean(row.author), title && `《${title}》`].filter(Boolean).join(" ");
      lines.push(...contentLines(row.content).map(line => source ? `${line} —— ${source}` : line));
      if (lines.length >= maxLines) break;
    }
    return lines.slice(0, maxLines);
  } finally {
    db.close();
  }
}

export async function loadImagePreviews(root: URL): Promise<readonly string[]> {
  const target = new URL("data/image-previews/lines.json", root);
  const current = await cachedLines(target);
  if (current.length) return current;
  const legacy = new URL("temp/Lotus-Plugin/poetry/", root);
  const cache = await cachedLines(new URL("lines.json", legacy));
  const lines = cache.length ? cache : await databaseLines(new URL("poetry.db", legacy)).catch(() => []);
  if (!lines.length) return lines;
  const staged = new URL(`.lines-${crypto.randomUUID()}.tmp`, target);
  try {
    const content = JSON.stringify({ lines });
    if (Buffer.byteLength(content) <= maxCacheBytes) {
      await mkdir(new URL("./", target), { recursive: true });
      await writeFile(staged, content, { flag: "wx", mode: 0o600 });
      await link(staged, target);
    }
  } catch {
    // An existing cache or a read-only deployment can still use the source lines.
  } finally {
    await rm(staged, { force: true }).catch(() => undefined);
  }
  return lines;
}
