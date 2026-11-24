import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCaptchaModels, type CaptchaModelProgress } from "../packages/captcha/index.ts";
import { ModelStore, type ModelAssetProgress } from "../packages/captcha/src/infrastructure/models.ts";

const asset = (id: string, value: string) => ({ id, file: `${id}.onnx`, size: Buffer.byteLength(value),
  sha256: createHash("sha256").update(value).digest("hex"), url: `https://fixture.invalid/${id}` });

test("模型初始化报告流式下载和缓存校验，完整SHA通过后才计入总完成量", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-model-progress-"));
  const assets = [asset("cached", "keep"), asset("downloaded", "abcdefgh")];
  let requests = 0;
  const events: CaptchaModelProgress[] = [];
  const fetchImpl = (async () => {
    requests++;
    let chunk = 0;
    return new Response(new ReadableStream({ async pull(stream) {
      await Bun.sleep(130);
      if (chunk === 4) { stream.close(); return; }
      stream.enqueue(Buffer.from("abcdefgh").subarray(chunk * 2, ++chunk * 2));
    } }));
  }) as unknown as typeof fetch;
  const store = new ModelStore(directory, assets, fetchImpl, join(directory, ".work"), true);
  const create = spyOn(ModelStore, "create").mockResolvedValue(store);
  try {
    await writeFile(join(directory, "cached.onnx"), "keep");
    await prepareCaptchaModels({ modelsDirectory: directory, onProgress: event => { events.push(event); } });
    expect(requests).toBe(1);
    const ready = events.filter(event => event.stage === "ready");
    expect(ready.map(event => [event.modelId, event.completed, event.completedBytes, event.totalBytes, event.cached]))
      .toEqual([["cached", 1, 4, 12, true], ["downloaded", 2, 12, 12, false]]);
    expect(events.some(event => event.stage === "verifying" && event.modelId === "cached")).toBe(true);
    const downloading = events.filter(event => event.stage === "downloading");
    expect(downloading.some(event => event.fileBytes! > 0 && event.fileBytes! < event.fileTotalBytes!)).toBe(true);
    expect(downloading.every(event => event.completed === 1 && event.completedBytes === 4)).toBe(true);
    expect(events.at(-1)?.stage).toBe("ready");
  } finally { create.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});

test("失败校验不发就绪，显示回调抛错不影响有效模型", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-model-failed-progress-"));
  const original = asset("model", "good");
  let valid = false;
  const store = new ModelStore(directory, [original], (async () => new Response(valid ? "good" : "bad!")) as unknown as typeof fetch,
    join(directory, ".work"), true);
  const create = spyOn(ModelStore, "create").mockResolvedValue(store);
  const events: CaptchaModelProgress[] = [];
  try {
    await expect(prepareCaptchaModels({ modelsDirectory: directory, onProgress: event => { events.push(event); } })).rejects.toThrow("checksum mismatch");
    expect(events.some(event => event.stage === "ready")).toBe(false);
    expect(events.every(event => event.completed === 0 && event.completedBytes === 0)).toBe(true);
    expect(await readdir(join(directory, ".work"))).toEqual([]);
    valid = true;
    await prepareCaptchaModels({ modelsDirectory: directory, onProgress() { throw Error("display failed"); } });
    expect(await store.valid("model")).toBe(true);
  } finally { create.mockRestore(); await rm(directory, { recursive: true, force: true }); }
});

test("取消模型下载后不报告完成且回收临时文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-model-cancel-progress-"));
  const controller = new AbortController(), events: ModelAssetProgress[] = [];
  const expected = asset("model", "abcdefgh");
  const store = new ModelStore(directory, [expected], (async (_url: string | URL | Request, init?: RequestInit) => {
    let chunk = 0;
    return new Response(new ReadableStream({ async pull(stream) {
      await Bun.sleep(130);
      if (init?.signal?.aborted) { stream.error(init.signal.reason); return; }
      if (chunk === 4) { stream.close(); return; }
      stream.enqueue(Buffer.from("abcdefgh").subarray(chunk * 2, ++chunk * 2));
    } }));
  }) as unknown as typeof fetch, join(directory, ".work"), true);
  try {
    await expect(store.get("model", controller.signal, event => {
      events.push(event);
      if (event.stage === "downloading" && event.bytes > 0 && event.bytes < event.totalBytes) controller.abort();
    })).rejects.toBeDefined();
    expect(events.at(-1)?.stage).toBe("downloading");
    expect(await Bun.file(join(directory, "model.onnx")).exists()).toBe(false);
    expect(await readdir(join(directory, ".work"))).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("模型连接或流中途被重置会有界重试，清理残片后才发布校验完整的文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-model-retry-"));
  const expected = asset("model", "abcdefgh");
  let calls = 0;
  const events: ModelAssetProgress[] = [];
  const store = new ModelStore(directory, [expected], (async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    if (calls === 2) {
      let sent = false;
      return new Response(new ReadableStream({ pull(controller) {
        if (!sent) { sent = true; controller.enqueue(Buffer.from("abc")); }
        else controller.error(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }));
      } }));
    }
    return new Response("abcdefgh");
  }) as unknown as typeof fetch, join(directory, ".work"), true);
  try {
    await store.get("model", undefined, event => events.push(event));
    expect(calls).toBe(3);
    expect(await store.valid("model")).toBe(true);
    expect(await readdir(join(directory, ".work"))).toEqual([]);
    expect(events.filter(event => event.stage === "downloading" && event.bytes === 0).map(event => event.attempt)).toEqual([1, 2, 3]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("模型非暂时HTTP错误不重试，退避等待中取消不再发请求", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lotus-model-retry-stop-"));
  const expected = asset("model", "abcdefgh");
  try {
    let calls = 0;
    const missing = new ModelStore(directory, [expected], (async () => {
      calls++; return new Response("missing", { status: 404 });
    }) as unknown as typeof fetch, undefined, true);
    await expect(missing.get("model")).rejects.toThrow("HTTP 404");
    expect(calls).toBe(1);
    const controller = new AbortController();
    const cancelled = new ModelStore(directory, [expected], (async () => {
      calls++; setTimeout(() => controller.abort(), 50);
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    }) as unknown as typeof fetch, undefined, true);
    await expect(cancelled.get("model", controller.signal)).rejects.toBeDefined();
    expect(calls).toBe(2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
