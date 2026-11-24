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
