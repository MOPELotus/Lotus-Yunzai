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

test("模型阶段进度传给统一显示，正在校验的字节不等同于模型已就绪", async () => {
  const events: import("../lib/captcha/initialize.ts").CaptchaInitializationProgress[] = [];
  await initializeCaptchaModels(new URL("file:///tmp/captcha-progress-fixture/"), new AbortController().signal, {
    async prepare({ onProgress }) {
      onProgress({ modelId: "fixture", stage: "downloading", completed: 0, total: 2, fileBytes: 4, fileTotalBytes: 8 });
      onProgress({ modelId: "fixture", stage: "verifying", completed: 0, total: 2, fileBytes: 0, fileTotalBytes: 8 });
      onProgress({ modelId: "fixture", stage: "ready", completed: 1, total: 2, cached: false, fileBytes: 8, fileTotalBytes: 8 });
    },
    onProgress: event => { events.push(event); },
  });
  expect(events.find(event => event.stage.endsWith(":downloading")))
    .toMatchObject({ message: "验证码模型 1/2：fixture · 下载", completed: 4, total: 8, unit: "bytes" });
  expect(events.find(event => event.stage.endsWith(":verifying"))?.message).toContain("校验");
  expect(events.find(event => event.stage.endsWith(":ready")))
    .toMatchObject({ completed: 1, total: 2, unit: "个" });
  expect(events.at(-1)?.message).toContain("已就绪");
});
