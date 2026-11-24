import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { recoverSkiaBinary, type SkiaProgress } from "./skia-binary.ts";

test("Skia 下载报告真实字节，并在校验和安装后才报告完成；观察者错误不影响恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-skia-progress-"));
  const packageDir = join(root, "node_modules/skia-canvas");
  const bytes = Bun.gzipSync(new TextEncoder().encode("synthetic native library"));
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(join(packageDir, "lib"), { recursive: true });
    await mkdir(join(root, "node_modules/detect-libc"), { recursive: true });
    await writeFile(join(root, "node_modules/detect-libc/index.js"), "exports.familySync = () => null;");
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const metadata = (digest: string) => JSON.stringify({ version: "3.0.0", prebuild: { [`${process.platform}-${process.arch}.gz`]: digest } });
    await writeFile(join(packageDir, "package.json"), metadata(digest));
    globalThis.fetch = (async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, 3));
      controller.enqueue(bytes.slice(3));
      controller.close();
    } }), { headers: { "content-length": String(bytes.length) } })) as unknown as typeof fetch;
    const events: SkiaProgress[] = [];
    expect(await recoverSkiaBinary(pathToFileURL(root + "/"), { onTaskProgress(event) {
      events.push(event);
      if (event.completed === 0) throw new Error("observer");
      return Promise.reject(new Error("async observer"));
    } })).toBe(true);
    expect(await readFile(join(packageDir, "lib/skia.node"), "utf8")).toBe("synthetic native library");
    const downloads = events.filter(event => event.stage === "skia-download");
    expect(downloads.at(-1)).toMatchObject({ completed: bytes.length, total: bytes.length, unit: "bytes" });
    expect(events.at(-1)?.stage).toBe("skia-ready");

    await rm(join(packageDir, "lib/skia.node"));
    await writeFile(join(packageDir, "package.json"), metadata("sha256:" + "0".repeat(64)));
    events.length = 0;
    await expect(recoverSkiaBinary(pathToFileURL(root + "/"), { onTaskProgress(event) { events.push(event); } })).rejects.toThrow("SHA-256");
    expect(events.some(event => event.stage === "skia-ready")).toBe(false);
    expect(await Bun.file(join(packageDir, "lib/skia.node")).exists()).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
