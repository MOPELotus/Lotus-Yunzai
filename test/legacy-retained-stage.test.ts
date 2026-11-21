import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stageRetainedLegacyPlugins } from "../lib/plugins/legacy-retained-stage.ts";
import { copyLocalPlugin } from "../lib/plugins/local-plugin-copy.ts";
import { planMigration } from "../lib/plugins/migration-plan.ts";

async function put(root: string, path: string, bytes: string, mode?: number) {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes, { mode });
}

async function fixture(run: (source: string, target: string, staging: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lotus-retained-stage-"));
  const source = join(root, "source");
  const target = join(root, "target");
  const staging = join(root, "staging");
  try {
    await mkdir(staging);
    await mkdir(join(source, "plugins"), { recursive: true });
    await put(target, "plugins/genshin/package.json", '{"name":"@lotus-yunzai/genshin"}');
    for (const args of [["init", "-q"], ["add", "plugins"],
      ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]]) {
      expect(Bun.spawnSync(["git", ...args], { cwd: target, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    }
    await run(source, target, staging);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test.skipIf(!Bun.which("git"))("暂存兼容外装和散装脚本，保留包内链接和模式，并单列真实浏览器依赖", () => fixture(async (source, target, staging) => {
  const config = "plugins/local/config/settings.yaml";
  const configBytes = "mode: existing\r\n";
  const entry = 'import puppeteer from "../../lib/puppeteer/puppeteer.js";\nconst level = <number>1;\nthrow new Error("must not execute");\n';
  await put(source, "plugins/local/package.json", JSON.stringify({
    name: "@fixture/local", lotusYunzai: { entry: "./index.ts" }, dependencies: { yaml: "^2" },
  }));
  await put(source, "plugins/local/index.ts", entry, 0o640);
  await put(source, config, configBytes, 0o640);
  await chmod(join(source, "plugins/local/config"), 0o750);
  await symlink("config/settings.yaml", join(source, "plugins/local/config-alias.yaml"));
  await put(source, "plugins/local/node_modules/dummy/index.js", 'import "playwright";');
  await put(source, "plugins/local/.env.local", "FIXTURE_SECRET=source-only");
  await put(source, "plugins/local/.git/config", '[remote "origin"]\nurl = https://example.invalid/owner/local.git\n');
  await put(source, "plugins/example.js", 'export const note = "puppeteer";\n', 0o744);
  await put(source, "plugins/manifest-browser/package.json", JSON.stringify({
    name: "@fixture/browser", optionalDependencies: { wrapper: "npm:playwright-core@1.2.3" },
  }));
  await put(source, "plugins/manifest-browser/index.js", "export {};");
  await put(source, "plugins/import-browser/index.js", 'const module = await import("@puppeteer/browsers");');
  await put(source, "plugins/require-browser.js", 'require("puppeteer-core/lib");');
  await put(source, "plugins/genshin/index.js", "export {};");
  await put(source, "plugins/OPQ-Plugin/index.js", 'throw new Error("must not execute");');
  await put(source, "plugins/miao-plugin/package.json", '{"name":"miao-plugin"}');
  const plan = await planMigration(source, target);

  const batch = await stageRetainedLegacyPlugins(plan, staging);
  expect(batch).toMatchObject({
    status: "published",
    retained: [
      { path: "plugins/example.js", dependencies: [] },
      { path: "plugins/local", dependencies: ["yaml"] },
    ],
    held: [
      { path: "plugins/import-browser", reason: "browser-dependency", dependencies: ["@puppeteer/browsers"] },
      { path: "plugins/manifest-browser", reason: "browser-dependency", dependencies: ["playwright-core"] },
      { path: "plugins/require-browser.js", reason: "browser-dependency", dependencies: ["puppeteer-core"] },
    ],
  });
  expect((await readdir(join(staging, "plugins"))).sort()).toEqual(["example.js", "local"]);
  expect(await readFile(join(staging, "plugins/local/index.ts"), "utf8")).toBe(entry);
  expect(await readFile(join(staging, config), "utf8")).toBe(configBytes);
  expect((await lstat(join(staging, config))).mode & 0o777).toBe(0o640);
  expect((await lstat(dirname(join(staging, config)))).mode & 0o777).toBe(0o750);
  expect((await lstat(join(staging, "plugins/example.js"))).mode & 0o777).toBe(0o744);
  expect(await readlink(join(staging, "plugins/local/config-alias.yaml"))).toBe("config/settings.yaml");
  for (const path of [".git", ".env.local", "node_modules"]) {
    await expect(lstat(join(staging, "plugins/local", path))).rejects.toMatchObject({ code: "ENOENT" });
  }
  expect(await readFile(join(source, config), "utf8")).toBe(configBytes);
  expect(await readdir(join(target, "plugins"))).toEqual(["genshin"]);
}));

test.skipIf(!Bun.which("git"))("越界链接或目标冲突不发布兼容暂存，并允许修正后重跑", () => fixture(async (source, target, staging) => {
  await put(source, "plugins/compatible/index.js", "export {};");
  await put(source, "outside.yaml", "outside: true\n");
  const link = join(source, "plugins/compatible", "outside.yaml");
  await symlink("../../outside.yaml", link);
  const plan = await planMigration(source, target);
  await expect(stageRetainedLegacyPlugins(plan, staging)).rejects.toThrow("包内复制的普通文件");
  expect(await readdir(staging)).toEqual([]);
  expect(await readlink(link)).toBe("../../outside.yaml");
  await rm(link);
  await put(target, "plugins/compatible/index.js", "existing");
  await expect(stageRetainedLegacyPlugins(plan, staging)).rejects.toThrow("目标已有插件路径");
  expect(await readFile(join(target, "plugins/compatible/index.js"), "utf8")).toBe("existing");
  await rm(join(target, "plugins/compatible"), { recursive: true });
  await expect(stageRetainedLegacyPlugins(plan, source)).rejects.toThrow("须与新旧安装独立");
  expect((await stageRetainedLegacyPlugins(plan, staging)).status).toBe("published");
}));

test.skipIf(!Bun.which("git"))("已归档散装入口只按相对路径剔除，其他脚本和数据保持原字节", () => fixture(async (source, _target, staging) => {
  const from = join(source, "plugins/mixed");
  await put(from, "apps/retired.js", "retired");
  await put(from, "apps/active.js", "active");
  await put(from, "data/retired.js", "same name, unrelated");
  await put(from, "data/settings.json", '{"original":true}\n');
  const to = join(staging, "mixed");
  await copyLocalPlugin(from, to, undefined, { exclude: new Set(["apps/retired.js"]) });
  await expect(lstat(join(to, "apps/retired.js"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(to, "apps/active.js"), "utf8")).toBe("active");
  expect(await readFile(join(to, "data/retired.js"), "utf8")).toBe("same name, unrelated");
  expect(await readFile(join(to, "data/settings.json"), "utf8")).toBe('{"original":true}\n');
  expect(await readFile(join(from, "apps/retired.js"), "utf8")).toBe("retired");
}));
