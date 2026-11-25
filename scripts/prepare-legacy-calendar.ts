import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { prepareLegacyCalendar } from "../plugins/guides/calendar-schedule.ts";

async function syncDirectory(path: string) {
  const directory = await open(path, constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

async function existingBundle(path: string, files: Readonly<Record<string, string>>): Promise<boolean> {
  const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (!metadata) return false;
  const conflict = () => new Error($t("scripts.prepare-legacy-calendar.text_1f27536cc7"));
  if (!metadata.isDirectory()) throw conflict();
  const names = await readdir(path);
  if (names.length !== Object.keys(files).length || names.some((name) => !Object.hasOwn(files, name))) throw conflict();
  for (const [name, content] of Object.entries(files)) {
    const file = await open(join(path, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      const expected = Buffer.from(content);
      if (!stat.isFile() || stat.size !== expected.length || !(await file.readFile()).equals(expected)) throw conflict();
    } finally { await file.close(); }
  }
  return true;
}

async function exportBundle(parent: string, files: Readonly<Record<string, string>>) {
  const directory = await realpath(parent);
  const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const path = join(directory, `calendar-${hash}`);
  if (await existingBundle(path, files)) return { directory: path, changed: false };

  const staging = await mkdtemp(join(directory, ".calendar-export-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = await open(join(staging, name), "wx", 0o600);
      try {
        await file.writeFile(content);
        await file.sync();
      } finally { await file.close(); }
    }
    await syncDirectory(staging);
    try { await rename(staging, path); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EEXIST" && code !== "ENOTEMPTY") || !await existingBundle(path, files)) throw error;
      return { directory: path, changed: false };
    }
    await syncDirectory(directory);
    return { directory: path, changed: true };
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

const args = process.argv.slice(2);
const exporting = args[0] === "--export";
const [parent, snapshot] = exporting ? args.slice(1) : [undefined, args[0]];
if (!snapshot || snapshot.startsWith("--") || (exporting ? !parent || parent.startsWith("--") || args.length !== 3 : args.length !== 1)) {
  console.error($t("scripts.prepare-legacy-calendar.text_7582c71be9"));
  process.exit(2);
}

try {
  const { counts, files } = await prepareLegacyCalendar(snapshot);
  const result = parent ? await exportBundle(parent, files) : { changed: false };
  console.log(JSON.stringify({ mode: exporting ? "export" : "dry-run", ...counts, ...result }));
} catch (error) {
  console.error(error instanceof SyntaxError ? $t("scripts.prepare-legacy-calendar.text_3a79247f51")
    : error instanceof Error && !("code" in error) ? error.message : $t("scripts.prepare-legacy-calendar.text_abf691c134"));
  process.exitCode = 1;
}
