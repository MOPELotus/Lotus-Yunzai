import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { initializeTerminalOwner } from "../lib/initialize-terminal-owner.ts";
import { readMasterPermissions } from "../lib/permissions.ts";

test("缺少主人配置时初始化仅授予stdin主人，重复运行和显式主人列表保持不变", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-stdin-owner-"));
  const root = pathToFileURL(dir + "/");
  try {
    expect(await initializeTerminalOwner(root, new AbortController().signal)).toBe(true);
    const permissions = await readMasterPermissions(root);
    expect(permissions.terminal).toBe(true);
    expect(permissions.isMaster(42, 42)).toBe(false);
    expect(await initializeTerminalOwner(root, new AbortController().signal)).toBe(false);
    const path = join(dir, "config/other.yaml");
    await writeFile(path, "# explicit disable\nmaster: []\n");
    expect(await initializeTerminalOwner(root, new AbortController().signal)).toBe(false);
    expect((await readMasterPermissions(root)).terminal).toBe(false);
    expect(await readFile(path, "utf8")).toBe("# explicit disable\nmaster: []\n");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("旧配置只有masterQQ时补入stdin仍保留QQ主人和访问控制，不创建遮蔽文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-legacy-stdin-owner-"));
  const root = pathToFileURL(dir + "/");
  try {
    await mkdir(join(dir, "config/config"), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "config/config/other.yaml"), "# 旧主人\nmasterQQ: ['42']\ndisablePrivate: true\nblackUser: [43]\ncustom: {keep: true}\n", { mode: 0o600 });
    expect(await initializeTerminalOwner(root, new AbortController().signal)).toBe(true);
    expect(await initializeTerminalOwner(root, new AbortController().signal)).toBe(false);
    const permissions = await readMasterPermissions(root);
    expect(permissions.terminal).toBe(true); expect(permissions.legacyMasterIds()).toEqual([42]);
    expect(await Bun.file(join(dir, "config/other.yaml")).exists()).toBe(false);
    expect(Bun.YAML.parse(await readFile(join(dir, "config/config/other.yaml"), "utf8")))
      .toEqual({ masterQQ: ["42"], master: ["stdin:stdin"], disablePrivate: true, blackUser: [43], custom: { keep: true } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("现代显式空主人配置优先，不能因旧路径有QQ主人而恢复被撤销的权限", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lotus-modern-owner-"));
  const root = pathToFileURL(dir + "/");
  try {
    await mkdir(join(dir, "config/config"), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "config/config/other.yaml"), "master: ['59904491:42','stdin:stdin']\n", { mode: 0o600 });
    const explicit = "# 已撤销主人权限\nmaster: []\n";
    await writeFile(join(dir, "config/other.yaml"), explicit, { mode: 0o600 });
    expect(await initializeTerminalOwner(root, new AbortController().signal)).toBe(false);
    const permissions = await readMasterPermissions(root);
    expect(permissions.terminal).toBe(false); expect(permissions.isMaster(59904491, 42)).toBe(false);
    expect(await readFile(join(dir, "config/other.yaml"), "utf8")).toBe(explicit);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
