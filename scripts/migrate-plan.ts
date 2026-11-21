import { fileURLToPath } from "node:url";
import { planMigration } from "../lib/plugins/migration-plan.ts";

if (import.meta.main) {
  const [source, ...extra] = Bun.argv.slice(2);
  if (!source || source.startsWith("-") || extra.length) {
    console.error("用法：bun run migrate:plan <旧安装副本路径>");
    process.exitCode = 2;
  } else {
    try {
      const plan = await planMigration(source, fileURLToPath(new URL("../", import.meta.url)));
      console.log(JSON.stringify(plan, null, 2));
    } catch (error) {
      if (error instanceof Error && !("code" in error)) console.error(error.message);
      else console.error("迁移预检无法读取旧安装副本或目标安装。");
      process.exitCode = 1;
    }
  }
}
