import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readUpdateHistory } from "../lib/update-history.ts";

const binary = Bun.which("git");
const fixedDate = "2026-01-03T10:21:30+08:00";

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync([binary!, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c",
    `core.hooksPath=${devNull}`, "-c", "protocol.file.allow=always", ...args], {
    cwd, env: { PATH: process.env.PATH, GIT_AUTHOR_DATE: fixedDate, GIT_COMMITTER_DATE: fixedDate,
      GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trimEnd();
}

async function fixture(run: (directory: string, root: URL) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "lotus-update-history-"));
  try {
    await run(directory, pathToFileURL(`${directory}/`));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function repository(cwd: string, title?: string) {
  await mkdir(cwd, { recursive: true });
  git(cwd, "init", "-q");
  if (title) git(cwd, "commit", "--allow-empty", "-qm", title);
}

test.skipIf(!binary)("读取本地根历史，沿用提交者时区与旧格式，脱敏并过滤 Merge branch", () => fixture(async (directory, root) => {
  await repository(directory);
  expect(await readUpdateHistory(root, new Map())).toEqual({ name: "Lotus-Yunzai", lines: [] });
  git(directory, "commit", "--allow-empty", "-qm", "最早一条");
  git(directory, "commit", "--allow-empty", "-qm", "Merge branch 'irrelevant'");
  git(directory, "commit", "--allow-empty", "-qm", "\x1b[31m更新\x1b[0m token=fixture-secret");
  git(directory, "notes", "add", "-m", "不应展示的备注");
  git(directory, "remote", "add", "origin", "https://fixture-user:fixture-password@example.invalid/private");
  expect(await readUpdateHistory(root, new Map())).toEqual({
    name: "Lotus-Yunzai", lines: ["[2026-01-03 10:21:30] 更新 token=[已隐藏]", "[2026-01-03 10:21:30] 最早一条"],
  });
}));

test.skipIf(!binary)("插件先匹配目录与包名，再兼容旧后缀，只查询已加载的独立 checkout", () => fixture(async (directory, root) => {
  await repository(directory, "根不应回退");
  const plugins = join(directory, "plugins");
  const directories = new Map([
    ["插件-Plugin", { path: join(plugins, "插件-Plugin"), packageName: "@fixture/upper" }],
    ["插件-plugin", { path: join(plugins, "插件-plugin"), packageName: "@fixture/lower" }],
    ["ordinary", { path: join(plugins, "ordinary"), packageName: "ordinary" }],
    ["symlink", { path: join(plugins, "symlink"), packageName: "symlink" }],
  ]);
  await repository(directories.get("插件-Plugin")!.path, "大写后缀");
  await repository(directories.get("插件-plugin")!.path, "小写后缀");
  await repository(join(plugins, "rejected-plugin"), "拒载模块历史");
  await mkdir(directories.get("ordinary")!.path);
  await symlink(directories.get("插件-plugin")!.path, directories.get("symlink")!.path);

  expect(await readUpdateHistory(root, directories, " 插件 ")).toEqual({ name: "插件-Plugin", lines: ["[2026-01-03 10:21:30] 大写后缀"] });
  expect(await readUpdateHistory(root, directories, "@fixture/lower")).toEqual({ name: "插件-plugin", lines: ["[2026-01-03 10:21:30] 小写后缀"] });
  const exact = { path: join(plugins, "插件"), packageName: "exact" };
  await repository(exact.path, "精确插件");
  directories.set("插件", exact);
  expect(await readUpdateHistory(root, directories, "插件")).toEqual({ name: "插件", lines: ["[2026-01-03 10:21:30] 精确插件"] });
  for (const name of ["rejected", "rejected-plugin", "ordinary", "symlink", "../", "--all"]) {
    expect(await readUpdateHistory(root, directories, name)).toBeUndefined();
  }
  expect(await readUpdateHistory(pathToFileURL(`${plugins}/`), new Map())).toBeUndefined();
}));

test.skipIf(!binary)("内置子模块只读根 HEAD 的固定提交，不用当前模块 HEAD 或根暂存索引", () => fixture(async (directory, root) => {
  await repository(directory, "根提交");
  const source = join(directory, "fixture-source");
  await repository(source, "固定提交");
  git(directory, "submodule", "add", "--quiet", source, "plugins/group");
  git(directory, "commit", "-qm", "固定内置模块");
  const checkout = join(directory, "plugins/group");
  const directories = new Map([["group", { path: checkout, packageName: "@lotus-yunzai/group" }]]);
  expect(await readUpdateHistory(root, directories, "group")).toEqual({ name: "group", lines: ["[2026-01-03 10:21:30] 固定提交"] });

  git(checkout, "commit", "--allow-empty", "-qm", "未固定的新提交");
  git(directory, "add", "plugins/group");
  expect(await readUpdateHistory(root, directories, "@lotus-yunzai/group")).toEqual({
    name: "group", lines: ["[2026-01-03 10:21:30] 固定提交"], pinnedMismatch: true,
  });

  git(directory, "update-index", "--cacheinfo", `160000,${"1".repeat(40)},plugins/group`);
  git(directory, "commit", "-qm", "固定到本地未安装的对象");
  expect(await readUpdateHistory(root, directories, "group")).toBeUndefined();
}));
