import { afterEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const roots = new Set<string>();
const source = fileURLToPath(new URL("../", import.meta.url));
const index = JSON.stringify({ games: { gi: { locales: { zh: { pages: { weapon: {
  version: "7.2", recordCount: 1, records: { "1": { id: "1", name: "无锋剑", path: "items/1.json" } },
} } } } } } });

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lotus-startup-launcher-"));
  roots.add(root);
  const cwd = join(root, "checkout");
  await Promise.all(["lib", "plugins/atlas", "scripts", "config"].map((path) => mkdir(join(cwd, path), { recursive: true })));
  await Promise.all([
    ...["package.json", "scripts/launcher.ts", "scripts/startup.ts",
      "plugins/atlas/legacy-atlas-directory.ts", "plugins/atlas/snapshot-pointer.ts",
      "plugins/atlas/prepare-theme.ts", "plugins/atlas/theme-directories.ts"].map((path) =>
      copyFile(join(source, path), join(cwd, path))),
    ...["atlas-channel", "file-lock", "managed-exit"].map((name) => writeFile(join(cwd, "lib", `${name}.ts`),
      `export * from ${JSON.stringify(join(source, "lib", `${name}.ts`))};\n`)),
    writeFile(join(cwd, "plugins/atlas/catalog.ts"),
      `export { createAtlasRuntimeCatalog } from ${JSON.stringify(join(source, "plugins/atlas/catalog.ts"))};\n`),
    writeFile(join(cwd, "scripts/run-managed.ts"),
      'export async function runManaged() { console.log("fixture host ready"); return 0; }\n'),
    writeFile(join(cwd, "plugins/atlas/initialize-atlas.ts"), `
      import { appendFile, mkdir, symlink, writeFile } from "node:fs/promises";
      import { join } from "node:path";
      const [root, mode, cache, option, channel, ...extra] = Bun.argv.slice(2);
      if (!root || mode !== "--public" || !cache || option !== "--channel" ||
          channel !== "live" && channel !== "latest" || extra.length) process.exit(9);
      await mkdir(cache, { recursive: true });
      await appendFile(join(cache, "attempts"), channel + "\\n");
      if (Bun.env.FAIL_FIXTURE === "1") process.exit(8);
      if (Bun.env.WAIT_FIXTURE === "1") {
        while (!await Bun.file("allow-publication").exists()) await Bun.sleep(20);
      }
      await mkdir(join(root, "snapshots/52/data"), { recursive: true });
      await writeFile(join(root, "snapshots/52/data/map.json"), ${JSON.stringify(index)});
      await symlink("snapshots/52/data", join(root, "current"), "dir");
    `),
  ]);
  const config = join(cwd, "config/global.yaml");
  const attempts = join(cwd, "data/atlas-download/attempts");
  const start = (args: string[], env: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, "scripts/launcher.ts", ...args], {
      cwd, env: { PATH: process.env.PATH, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 4_000,
    });
    return Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  };
  return { cwd, config, attempts, start };
}

test("noninteractive first start requires a source choice before starting the host", async () => {
  const { config, attempts, start } = await fixture();
  const [code, output, error] = await start(["start"]);
  expect(code).toBe(1);
  expect(output).toBe("");
  expect(error).toContain("bun run init latest");
  expect(await Bun.file(config).exists()).toBe(false);
  expect(await Bun.file(attempts).exists()).toBe(false);
});

test("an already prepared installation starts without choosing a channel and rejects malformed YAML", async () => {
  const { cwd, config, attempts, start } = await fixture();
  const atlas = join(cwd, "data/atlas/data");
  await mkdir(atlas, { recursive: true });
  await writeFile(join(atlas, "map.json"), index);
  const [code, output, warning] = await start(["start"]);
  expect(code).toBe(0);
  expect(output).toContain("fixture host ready");
  expect(warning).toContain("缺少 12 个原主题文件");
  expect(await Bun.file(config).exists()).toBe(false);

  await writeFile(config, "atlas: [\n");
  const [invalid, , error] = await start(["start"]);
  expect(invalid).toBe(1);
  expect(error).toContain("无法读取 config/global.yaml");
  expect(await Bun.file(attempts).exists()).toBe(false);
});

test("an existing unusable index prevents startup without replacing legacy or explicit data", async () => {
  const { cwd, config, attempts, start } = await fixture();
  const atlas = join(cwd, "data/atlas/data");
  const override = join(cwd, "custom-atlas");
  await mkdir(atlas, { recursive: true });
  await mkdir(override);
  const invalid = "{}";
  await writeFile(join(atlas, "map.json"), invalid);
  await writeFile(join(override, "map.json"), "{");

  const [code, output, error] = await start(["start"]);
  expect(code).toBe(1);
  expect(output).not.toContain("fixture host ready");
  expect(error).toContain("图鉴索引不可用");
  const [customCode, customOutput, customError] = await start(["init", "live"], { LOTUS_ATLAS_DATA_DIR: override });
  expect(customCode).toBe(1);
  expect(customOutput).not.toContain("已就绪");
  expect(customError).toContain("LOTUS_ATLAS_DATA_DIR");
  expect(await Bun.file(config).exists()).toBe(false);
  expect(await Bun.file(attempts).exists()).toBe(false);
  expect(await readFile(join(atlas, "map.json"), "utf8")).toBe(invalid);
  expect(await readFile(join(override, "map.json"), "utf8")).toBe("{");

  await writeFile(join(override, "map.json"), index);
  const [repairedCode, repairedOutput] = await start(["start"], { LOTUS_ATLAS_DATA_DIR: "custom-atlas" });
  expect(repairedCode).toBe(0);
  expect(repairedOutput).toContain("fixture host ready");
  expect(await Bun.file(attempts).exists()).toBe(false);
});

test("first start retries incomplete preparation, preserves config, and reuses published data", async () => {
  const { config, attempts, start } = await fixture();
  await writeFile(config, "atlas:\n  update: true\n# unrelated settings\npermissions:\n  mode: partial\n");
  const [failed, , failure] = await start(["init", "live"], { FAIL_FIXTURE: "1" });
  expect(failed).toBe(1);
  expect(failure).toContain("下载记录已保留");
  const [started, output] = await start(["start"]);
  expect(started).toBe(0);
  expect(output).toContain("fixture host ready");
  expect((await start(["init", "latest"]))[0]).toBe(0);
  expect(await readFile(config, "utf8")).toContain("# unrelated settings");
  expect(Bun.YAML.parse(await readFile(config, "utf8"))).toEqual({
    atlas: { update: true, version_channel: "latest" },
    permissions: { mode: "partial" },
  });
  expect(await readFile(attempts, "utf8")).toBe("live\nlive\n");
});

test("simultaneous startup and initialization publish only once", async () => {
  const { cwd, attempts, start } = await fixture();
  const initialize = start(["init", "live"], { WAIT_FIXTURE: "1" });
  for (let attempt = 0; attempt < 50 && !await Bun.file(attempts).exists(); attempt++) await Bun.sleep(20);
  const firstStart = start(["start"]);
  await writeFile(join(cwd, "allow-publication"), "");
  const [[initStatus], [startStatus, output]] = await Promise.all([initialize, firstStart]);
  expect(initStatus).toBe(0);
  expect(startStatus).toBe(0);
  expect(output).toContain("fixture host ready");
  expect(await readFile(attempts, "utf8")).toBe("live\n");
});
