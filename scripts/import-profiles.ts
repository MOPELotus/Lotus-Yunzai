import { importProfiles } from "../packages/account/index.ts";

const args = process.argv.slice(2);
const apply = args[0] === "--apply";
const [source, destination, ...extra] = apply ? args.slice(1) : args;
if (!source || !destination || extra.length || source.startsWith("--") || destination.startsWith("--")) {
  console.error("用法：bun scripts/import-profiles.ts [--apply] <旧档案副本目录> <目标档案目录>");
  process.exit(2);
}

try {
  const report = await importProfiles(source, destination, apply);
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...report }));
  if (report.conflict || report.invalid) process.exitCode = 1;
} catch {
  console.error("档案导入失败，请检查来源和目标目录。已成功导入的文件可在重跑时复用。");
  process.exitCode = 1;
}
