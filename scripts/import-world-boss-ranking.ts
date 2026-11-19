import { lockFile } from "../lib/file-lock.ts";
import { importWorldBossRanking } from "../plugins/genshin/world-boss-ranking-import.ts";

const args = process.argv.slice(2);
const apply = args[0] === "--apply";
const [sourceFile, authorizationFile, profileDirectory, destinationDirectory, ...extra] = apply ? args.slice(1) : args;
if (!sourceFile || !authorizationFile || !profileDirectory || !destinationDirectory || extra.length ||
    [sourceFile, authorizationFile, profileDirectory, destinationDirectory].some((value) => value.startsWith("--"))) {
  console.error("用法：bun scripts/import-world-boss-ranking.ts [--apply] <旧榜副本.json> <授权清单.json> <已导入档案目录> <摘要目录>");
  process.exit(2);
}

try {
  const report = await importWorldBossRanking({ sourceFile, authorizationFile, profileDirectory, destinationDirectory, apply }, lockFile);
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...report }));
  if (report.conflict || report.unverified || report.missing) process.exitCode = 1;
} catch {
  console.error("世界 BOSS 榜单导入失败，请检查副本、授权清单和目标目录。已导入的摘要可在重跑时复用。");
  process.exitCode = 1;
}
