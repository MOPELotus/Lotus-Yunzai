import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalOcr } from "../lib/local-ocr.ts";

test("本机 OCR 截止或连接退出时终止并回收识别子进程", async () => {
  const root = await mkdtemp(join(tmpdir(), "lotus-local-ocr-"));
  try {
    const executable = join(root, "tesseract");
    const pidPath = join(root, "pid");
    await writeFile(executable, `#!${process.execPath}
await Bun.write(${JSON.stringify(pidPath)}, String(process.pid));
await Bun.sleep(60_000);
`, { mode: 0o700 });
    async function noChild() {
      const pid = Number(await readFile(pidPath, "utf8"));
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
      await rm(pidPath);
    }
    const image = new Uint8Array([1]);
    const ocr = createLocalOcr(1_000);
    expect(await ocr.recognize(executable, image, new AbortController().signal)).toContain("识别超时");
    await noChild();

    const controller = new AbortController();
    const waiting = ocr.recognize(executable, image, controller.signal);
    for (let i = 0; i < 50 && !await Bun.file(pidPath).exists(); ++i) await Bun.sleep(10);
    expect(await Bun.file(pidPath).exists()).toBe(true);
    controller.abort();
    await waiting;
    await noChild();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 5_000);
