import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { initializeCaptchaModels } from "../lib/captcha/initialize.ts";

test("整体初始化将模型准备交给内嵌模块，缓存属于当前部署并报告完成", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-captcha-init-"));
  try {
    const controller = new AbortController();
    const progress: string[] = [];
    let calls = 0;
    await initializeCaptchaModels(pathToFileURL(root + "/"), controller.signal, {
      async prepare(options) {
        calls++;
        expect(options.modelsDirectory).toBe(join(root, "data/captcha/models"));
        expect(options.signal).toBe(controller.signal);
        options.onProgress({ modelId: "fixture", completed: 1, total: 1 });
      },
      report: message => { progress.push(message); },
    });
    expect(calls).toBe(1);
    expect(progress.at(-1)).toContain("已就绪");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("模型准备失败或取消不能报告初始化成功", async () => {
  for (const mode of ["failed", "cancelled", "already-cancelled"] as const) {
    const controller = new AbortController(), progress: string[] = [];
    let calls = 0;
    if (mode === "already-cancelled") controller.abort();
    await expect(initializeCaptchaModels(new URL("file:///tmp/captcha-init-fixture/"), controller.signal, {
      async prepare() { calls++; if (mode === "cancelled") controller.abort(); else throw Error("download failed"); },
      report: message => { progress.push(message); },
    })).rejects.toBeDefined();
    expect(progress.some(message => message.includes("已就绪"))).toBe(false);
    expect(calls).toBe(mode === "already-cancelled" ? 0 : 1);
  }
});
