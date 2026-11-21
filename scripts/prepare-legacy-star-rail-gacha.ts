import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { lockFile } from "../lib/file-lock.ts";
import { createStarRailGachaRecordArchive } from "../plugins/starrail/gacha-record-archive.ts";

const maxOutputBytes = 32 * 1024 * 1024;

function inside(directory: string, path: string) {
  const child = relative(directory, path);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(".." + sep));
}

async function publish(parent: string, content: Buffer) {
  const hash = createHash("sha256").update(content).digest("hex");
  const path = join(parent, `starrail-${hash}.json`);
  const staged = join(parent, `.starrail-export-${randomUUID()}.tmp`);
  const handle = await open(staged, "wx", 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(staged, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await existing.stat();
        if (!info.isFile() || info.size !== content.length || !(await existing.readFile()).equals(content)) {
          throw new Error("已有导出文件内容不一致，请选另一个独立目录。");
        }
      } finally {
        await existing.close();
      }
      return { path, written: false };
    }
    const directory = await open(parent, constants.O_DIRECTORY);
    try { await directory.sync(); } finally { await directory.close(); }
    return { path, written: true };
  } finally {
    await unlink(staged);
  }
}

const args = process.argv.slice(2);
const exporting = args[0] === "--export";
const [parent, managed, legacy, qq, uid, timezone] = exporting ? args.slice(1) : [undefined, ...args];
if (!managed || !legacy || !qq || !uid || !timezone || args.length !== (exporting ? 7 : 5) ||
    [parent, managed, legacy, qq, uid, timezone].some(value => value?.startsWith("--")) ||
    !/^[+-]?\d+(?:\.\d+)?$/u.test(timezone) || (exporting && !parent)) {
  console.error("用法：bun scripts/prepare-legacy-star-rail-gacha.ts [--export <独立导出目录>] <新版逐抽根副本> <旧 srJson 根副本> <QQ> <UID> <旧记录时区偏移>");
  process.exit(2);
}

try {
  const [managedRoot, legacyRoot, output] = await Promise.all([realpath(managed), realpath(legacy), parent && realpath(parent)]);
  if (inside(managedRoot, legacyRoot) || inside(legacyRoot, managedRoot) ||
      (output && (inside(managedRoot, output) || inside(legacyRoot, output)))) {
    throw new Error("新旧逐抽输入和导出目录须分别独立。");
  }
  const archive = createStarRailGachaRecordArchive({ directory: managedRoot, legacyDirectory: legacyRoot }, lockFile);
  const { document, format, counts } = await archive.prepareLegacyHandback({ qq, uid }, Number(timezone));
  const content = Buffer.from(JSON.stringify(document, null, 2) + "\n");
  if (content.length > maxOutputBytes) throw new Error("交还文件超过可导出大小。");
  const result = output ? await publish(output, content) : { written: false };
  console.log(JSON.stringify({ mode: exporting ? "export" : "dry-run", format, counts, ...result }));
} catch (error) {
  console.error(error instanceof Error && (!("code" in error) || ["corrupt", "conflict"].includes(String(error.code)))
    ? error.message : "无法读取星铁逐抽副本或写入独立导出目录。");
  process.exitCode = 1;
}
