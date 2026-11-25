import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

interface Entry {
  readonly time: number;
  readonly status: "started" | "finished";
}

async function readJournal(path: string, modern: boolean): Promise<Map<string, Entry>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error($t("scripts.export-preview-redeem-history.text_c15290ad89"));
    const data: unknown = JSON.parse(await file.readFile("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error($t("scripts.export-preview-redeem-history.text_a067e29333"));
    const entries = new Map<string, Entry>();
    for (const [key, value] of Object.entries(data)) {
      if (modern && key === "__lotusPreviewJournalVersion" && value === 1) continue;
      if (!/^[a-f0-9]{64}$/u.test(key) || !value || typeof value !== "object" ||
          !Number.isSafeInteger(value.time) || value.time < 0 || !["started", "finished"].includes(value.status)) {
        throw new Error($t("scripts.export-preview-redeem-history.text_98bb7c7f2c"));
      }
      const { time, status } = value;
      entries.set(key, { time, status });
    }
    return entries;
  } finally {
    await file.close();
  }
}

async function writeNewJournal(path: string, entries: ReadonlyMap<string, Entry>) {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(`${JSON.stringify(Object.fromEntries(entries))}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    // Publish a complete file only if the destination is still absent.
    await link(temporary, path);
    const parent = await open(directory, constants.O_DIRECTORY);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await unlink(temporary);
  }
}

const [current, previous, destination, ...extra] = process.argv.slice(2);
if (!current || !previous || !destination || extra.length) {
  console.error($t("scripts.export-preview-redeem-history.text_c0cb3cda6b"));
  process.exit(2);
}

try {
  const [recent, old] = await Promise.all([readJournal(current, true), previous === "-"
    ? new Map<string, Entry>() : readJournal(previous, false)]);
  let added = 0;
  for (const [key, entry] of recent) {
    if (old.has(key)) continue;
    old.set(key, entry);
    added++;
  }
  await writeNewJournal(resolve(destination), old);
  console.log(JSON.stringify({ preserved: old.size - added, added, total: old.size }));
} catch {
  console.error($t("scripts.export-preview-redeem-history.text_e708d1ea04"));
  process.exitCode = 1;
}
