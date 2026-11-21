import { realpath, stat } from "node:fs/promises";
import { lockFile } from "../lib/file-lock.ts";
import { prepareZzzGachaHandback } from "../plugins/zzz/gacha-handback.ts";
import { containsPath, publishGachaExport } from "./legacy-gacha-output.ts";

const maxOutputBytes = 32 * 1024 * 1024;

async function checkedDirectory(path: string) {
  const actual = await realpath(path);
  if (!(await stat(actual)).isDirectory()) throw new Error("离线交还须使用目录。");
  return actual;
}

const args = process.argv.slice(2);
const exporting = args[0] === "--export";
const [parent, managed, legacy, qq, uid, region] = exporting ? args.slice(1) : [undefined, ...args];
if (!managed || !legacy || !qq || !uid || !region || args.length !== (exporting ? 7 : 5) ||
    [parent, managed, legacy, qq, uid, region].some(value => value?.startsWith("--")) ||
    !/^[1-9]\d{0,18}$/u.test(qq) || !/^[1-9]\d{7,9}$/u.test(uid) || (exporting && !parent)) {
  console.error("用法：bun scripts/prepare-legacy-zzz-gacha.ts [--export <独立导出目录>] <新版逐抽根副本> <旧版 Yunzai 根目录副本> <QQ> <UID> <区服>");
  process.exit(2);
}

try {
  const [managedRoot, legacyRoot, output] = await Promise.all([
    checkedDirectory(managed), checkedDirectory(legacy), parent ? checkedDirectory(parent) : undefined,
  ]);
  if (containsPath(managedRoot, legacyRoot) || containsPath(legacyRoot, managedRoot) ||
      (output && (containsPath(managedRoot, output) || containsPath(legacyRoot, output) ||
        containsPath(output, managedRoot) || containsPath(output, legacyRoot)))) {
    throw new Error("新旧逐抽输入和导出目录须分别独立。");
  }
  const { document, counts } = await prepareZzzGachaHandback({ managed: managedRoot, legacy: legacyRoot, qq, uid, region }, lockFile);
  const content = Buffer.from(JSON.stringify(document, null, 2) + "\n");
  if (content.length > maxOutputBytes) throw new Error("交还文件超过可导出大小。");
  const result = output ? await publishGachaExport(output, "zzz", content) : { written: false };
  console.log(JSON.stringify({ mode: exporting ? "export" : "dry-run", format: "ZZZ-Plugin 2057599", counts, ...result }));
} catch (error) {
  console.error(error instanceof Error && (!("code" in error) || ["corrupt", "io", "invalid-input"].includes(String(error.code)))
    ? error.message : "无法读取绝区零逐抽副本或写入独立导出目录。");
  process.exitCode = 1;
}
