import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { builtInDirectories } from "../lib/builtin-modules.ts";
import { createLocalGit } from "../lib/local-git.ts";
import { planLegacyPlugins } from "../lib/plugins/migration-plan.ts";

function within(base: string, path: string) {
  const local = relative(base, path);
  return !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
}

export async function planMigration(sourcePath: string, targetPath: string) {
  const [source, target] = await Promise.all([realpath(sourcePath), realpath(targetPath)]);
  const [sourceInfo, targetInfo] = await Promise.all([lstat(source), lstat(target)]);
  if (!sourceInfo.isDirectory() || !targetInfo.isDirectory()) throw new Error("旧安装副本与目标安装须为实体目录。");
  if (within(source, target) || within(target, source) ||
      (sourceInfo.dev === targetInfo.dev && sourceInfo.ino === targetInfo.ino)) {
    throw new Error("旧安装副本与目标安装须为独立目录，不能相同或互相包含。");
  }
  if (!(await lstat(join(source, "plugins"))).isDirectory()) {
    throw new Error("旧安装副本的 plugins 须为实体目录。");
  }
  const git = createLocalGit();
  if (!git) throw new Error("迁移预检需要 Git，以核对目标的内置插件。");
  const topLevel = (await git(target, ["rev-parse", "--show-toplevel"]))?.trimEnd();
  if (!topLevel || await realpath(topLevel) !== target) throw new Error("无法确认目标安装的 Git 工作区。");
  const tree = await git(target, ["ls-tree", "-z", "HEAD:plugins"]);
  if (tree === undefined) throw new Error("无法核对目标安装跟踪的插件目录。");
  const nativeDirectories = new Set(builtInDirectories.values());
  const protectedPaths = new Set<string>();
  for (const entry of tree.split("\0")) {
    const name = /^(?:040000|160000) [^ ]+ [^\t]+\t(.+)$/u.exec(entry)?.[1];
    if (name && nativeDirectories.has(name)) protectedPaths.add(`plugins/${name}`);
  }
  const plugins = await planLegacyPlugins(source, protectedPaths);
  return { version: 1, mode: "dry-run", scope: "legacy-plugins", source, target, plugins } as const;
}

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
