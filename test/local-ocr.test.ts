import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkHostPackages } from "./host-fixture.ts";

test("本机 OCR 截止或连接退出时终止并回收识别子进程", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-local-ocr-"));
  try {
    await Promise.all([mkdir(join(root, "lib")), mkdir(join(root, "i18n")), linkHostPackages(root)]);
    await copyFile(new URL("../i18n/zh-CN.json", import.meta.url), join(root, "i18n/zh-CN.json"));
    const module = join(root, "lib/local-ocr.ts");
    await copyFile(new URL("../lib/local-ocr.ts", import.meta.url), module);
    const { createLocalOcr } = await import(module) as typeof import("../lib/local-ocr.ts");
    const pidPath = join(root, "pid");
    await writeFile(join(root, "lib/local-ocr-worker.ts"), `
await Bun.write(${JSON.stringify(pidPath)}, String(process.pid));
for (;;) {}
`);
    async function noChild() {
      const pid = Number(await readFile(pidPath, "utf8"));
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
      await rm(pidPath);
    }
    const image = new Uint8Array([1]);
    const ocr = createLocalOcr(1_000);
    expect(await ocr.recognize(image, new AbortController().signal)).toContain("识别超时");
    await noChild();

    const controller = new AbortController();
    const waiting = ocr.recognize(image, controller.signal);
    for (let i = 0; i < 50 && !await Bun.file(pidPath).exists(); ++i) await Bun.sleep(10);
    expect(await Bun.file(pidPath).exists()).toBe(true);
    controller.abort();
    await waiting;
    await noChild();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 5_000);
