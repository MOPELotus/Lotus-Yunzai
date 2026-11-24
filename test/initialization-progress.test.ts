import { expect, test } from "bun:test";
import { createInitializationProgress, runInitializationStage } from "../lib/initialization-progress.ts";

test("redirected progress throttles samples, preserves stage boundaries and real completion", () => {
  const lines: string[] = [];
  let time = 0;
  const progress = createInitializationProgress("测试", { isTTY: false, write: line => lines.push(line), now: () => time });
  try {
    progress.update({ stage: "download", message: "下载", completed: 1, total: 10 });
    progress.update({ stage: "download", message: "下载", completed: 2, total: 10 });
    expect(lines).toHaveLength(1);
    time = 2100;
    progress.update({ stage: "download", message: "下载", completed: 5, total: 10 });
    progress.update({ stage: "download", message: "下载", completed: 10, total: 10 });
    progress.update({ stage: "verify", message: "校验" });
    expect(lines.join("")).toContain("50% 5/10项");
    expect(lines.join("")).toContain("100% 10/10项");
    expect(lines.at(-1)).toContain("校验");
    expect(lines.join("")).not.toContain("\x1b");
    progress.complete("就绪");
    expect(lines.at(-1)).toContain("就绪 · 耗时2秒");
    progress.update({ stage: "late", message: "不得出现" });
    expect(lines.join("")).not.toContain("不得出现");
  } finally { progress.close(); }
});

test("TTY renders bytes and does not invent percentages for unknown totals", () => {
  const lines: string[] = [];
  const progress = createInitializationProgress("测试", { isTTY: true, write: text => lines.push(text) });
  progress.update({ stage: "unknown", message: "读取", completed: 2048, unit: "bytes" });
  expect(lines.join("")).toContain("2.0 KiB");
  expect(lines.join("")).not.toContain("%");
  progress.update({ stage: "known", message: "下载", completed: 1024, total: 2048, unit: "bytes" });
  expect(lines.join("")).toContain("50% 1.0 KiB/2.0 KiB");
  progress.close();
  expect(lines.at(-1)).toBe("\n");
});

test("long silent phases emit heartbeat and stop after cancellation", async () => {
  const lines: string[] = [];
  const controller = new AbortController();
  const progress = createInitializationProgress("测试", { isTTY: false, heartbeatMs: 100, signal: controller.signal,
    write: text => lines.push(text) });
  progress.update({ stage: "scan", message: "扫描" });
  await Bun.sleep(240);
  expect(lines.length).toBeGreaterThan(1);
  controller.abort();
  expect(lines.at(-1)).toContain("已中止");
  const count = lines.length;
  await Bun.sleep(150);
  expect(lines).toHaveLength(count);
});

test("reporting failures cannot break preparation and failed tasks never claim completion", async () => {
  expect(await runInitializationStage("准备", async () => 42, { write: () => { throw Error("broken output"); } })).toBe(42);
  const lines: string[] = [];
  await expect(runInitializationStage("准备", async () => { throw Error("network failed"); }, {
    isTTY: false, write: text => lines.push(text),
  })).rejects.toThrow("network failed");
  expect(lines.join("")).toContain("准备失败");
  expect(lines.join("")).not.toContain("准备完成");
});
