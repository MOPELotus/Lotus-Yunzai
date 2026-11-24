import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInitializationComplete, beginInitialization, finishInitialization } from "../lib/initialization-state.ts";

test("中断或失败的完整初始化不能因图鉴已存在而直接启动；成功才解除阻挡", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-init-state-"));
  const root = Bun.pathToFileURL(directory + "/");
  try {
    await assertInitializationComplete(root);
    const first = await beginInitialization(root);
    await Bun.write(new URL("data/atlas/data/map.json", root), "{}");
    await expect(assertInitializationComplete(root)).rejects.toThrow("完整初始化尚未完成");
    const retry = await beginInitialization(root);
    await finishInitialization(root, first);
    await expect(assertInitializationComplete(root)).rejects.toThrow("完整初始化尚未完成");
    await finishInitialization(root, retry);
    await assertInitializationComplete(root);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
