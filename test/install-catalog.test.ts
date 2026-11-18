import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installRejection, normalizeApprovedInstall, normalizeInstallCatalog, readInstallCatalog } from "../lib/install-catalog.ts";

const commit = "0123456789abcdef".repeat(2) + "89abcdef";
const source = { directory: "sample-plugin", url: "https://example.invalid/Owner/Sample.git", branch: "release/v1", revision: commit };
const second = { ...source, directory: "other-plugin", url: "https://example.invalid/Owner/Other" };

test("旧 TRSS 名录保留原始来源，缺少本机许可时全部只供参考", () => {
  const catalog = normalizeInstallCatalog();
  expect(catalog.list).toHaveLength(24);
  expect(catalog.list).toContainEqual({ name: "Atlas", url: "https://gitee.com/Nwflower/atlas", approved: false });
  expect(catalog.list).toContainEqual({ name: "TRSS-Plugin", url: "https://git.trss.me/TRSS-Plugin", approved: false });
  for (const entry of catalog.list) expect(catalog.resolve(entry.name)).toBeUndefined();
  expect(catalog.resolve("TRSS")).toBeUndefined();
});

test("本地批准项使用完整固定提交，支持扩展别名及旧后缀", () => {
  const catalog = normalizeInstallCatalog({ plugins: {
    "Sample-Plugin": { ...source, url: "HTTPS://EXAMPLE.INVALID:443/Owner/Sample.git/", branch: "release/v1.2",
      revision: commit.toUpperCase(), aliases: ["群工具", "SampleExtension"] },
    DF: { ...second, url: "https://gitee.com/DenFengLai/DF-Plugin", directory: "DF-Plugin" },
  } });
  const plugin = { ...source, name: "Sample", branch: "release/v1.2" };
  for (const alias of ["Sample", "Sample-Plugin", "Sample-plugin", "群工具", "SampleExtension"]) {
    expect(catalog.resolve(alias)).toEqual(plugin);
  }
  expect(catalog.resolve("sample")).toBeUndefined();
  expect(catalog.resolve("Sample-plugin-Plugin")).toBeUndefined();
  expect(catalog.list).toContainEqual({ name: "Sample", url: source.url, approved: true });
  expect(catalog.list).toContainEqual({ name: "DF-Plugin", url: "https://gitee.com/DenFengLai/DF-Plugin", approved: true });
  expect(catalog.list.filter((item) => item.approved)).toHaveLength(2);
});

test("审核要求合法仓库 HTTPS 地址、短分支、独立目录及完整 SHA", () => {
  const entry = { ...source, name: "Sample" };
  expect(normalizeApprovedInstall(entry)).toEqual(entry);
  expect(normalizeApprovedInstall({ ...entry, revision: "a".repeat(64) })?.revision).toHaveLength(64);
  expect(normalizeApprovedInstall({ ...entry, url: "https://git.trss.me/Yunzai-Telegram-Plugin" })?.url)
    .toBe("https://git.trss.me/Yunzai-Telegram-Plugin");
  expect(installRejection("https://git.trss.me/TRSS-Plugin", "sample")).toContain("公共账号服务和游戏模块");
  const invalidUrls = [
    "http://example.invalid/Owner/Sample", "ssh://example.invalid/Owner/Sample", "https:example.invalid/Owner/Sample",
    "https:///example.invalid/Owner/Sample", "https://name:password@example.invalid/Owner/Sample",
    "https://@example.invalid/Owner/Sample", "https://example.invalid/Owner/Sample?access=secret",
    "https://example.invalid/Owner/Sample?", "https://example.invalid/Owner/Sample#",
    "https://example.invalid/Group/Owner/Sample",
    "https://example.invalid/Other/../Owner/Sample", "https://example.invalid/Owner/%2e%2e",
    "https://example.invalid/Owner/Sample%2Fother", "https://example.invalid\\Owner/Sample",
  ];
  for (const url of invalidUrls) expect(normalizeApprovedInstall({ ...entry, url })).toBeUndefined();
  for (const branch of ["", "-main", "refs/heads/main", "/main", "main/", "a//b", "a/.b", "a/b.lock", "a/b.", "a..b",
    "a@{b", "main\n", "a:b", "a?", "a b", "main^{commit}"]) {
    expect(normalizeApprovedInstall({ ...entry, branch })).toBeUndefined();
  }
  for (const directory of ["..", "../data", "a/b", "a\\b", ".git", "node_modules", "node_modules/side", "Group", "system", "a\n"]) {
    expect(normalizeApprovedInstall({ ...entry, directory })).toBeUndefined();
  }
  for (const revision of ["HEAD", commit.slice(1), commit + "x", commit + "\n", 1234]) {
    expect(normalizeApprovedInstall({ ...entry, revision })).toBeUndefined();
  }
  expect(normalizeApprovedInstall({ ...entry, name: "插件" })).toBeUndefined();
});

test("拒绝重复仓库身份、大小写等价目录和短名别名冲突", () => {
  const duplicates = [
    { Sample: source, Other: { ...second, url: "https://mirror.invalid/owner/SAMPLE/" } },
    { Sample: source, Other: { ...second, directory: "SAMPLE-PLUGIN" } },
    { Sample: source, "sample-plugin": second },
    { Sample: { ...source, aliases: ["Other-Plugin"] }, Other: second },
    { Sample: { ...source, aliases: ["x", "X-Plugin"] } },
    { Sample: { ...source, aliases: "not-an-array" } },
    { Sample: { ...source, aliases: ["https://example.invalid/a/b"] } },
    { Sample: { ...source, rev: commit } },
  ];
  for (const plugins of duplicates) expect(() => normalizeInstallCatalog({ plugins })).toThrow("配置无效");
});

test("按本地配置优先级读取，拒绝重复 YAML 键和错误主配置，不回退到下层许可", async () => {
  const temp = await mkdtemp(join(tmpdir(), "lotus-install-catalog-"));
  const root = pathToFileURL(temp + "/");
  try {
    expect((await readInstallCatalog(root)).resolve("Sample")).toBeUndefined();
    await mkdir(join(temp, "config/config"), { recursive: true });
    await writeFile(join(temp, "config/config/install.yaml"), JSON.stringify({ plugins: { Sample: source } }));
    expect((await readInstallCatalog(root)).resolve("Sample")?.revision).toBe(commit);

    const primary = join(temp, "config/install.yaml");
    await writeFile(primary, JSON.stringify({ plugins: { Other: second } }));
    const configured = await readInstallCatalog(root);
    expect(configured.resolve("Other")?.directory).toBe("other-plugin");
    expect(configured.resolve("Sample")).toBeUndefined();
    await writeFile(primary, `plugins:\n  Sample: ${JSON.stringify(source)}\n  Sample: ${JSON.stringify(source)}\n`);
    await expect(readInstallCatalog(root)).rejects.toThrow("无法读取 config/install.yaml");
    await writeFile(primary, `plugins:\n  Sample: &entry ${JSON.stringify(source)}\n  Other: *entry\n`);
    await expect(readInstallCatalog(root)).rejects.toThrow("无法读取 config/install.yaml");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
