import { createHash } from "node:crypto";
import { mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SkiaProgress {
  stage: string;
  message: string;
  completed?: number;
  total?: number;
  unit?: string;
}
interface RecoveryOptions { onTaskProgress?: (event: SkiaProgress) => unknown }
function report(options: RecoveryOptions, event: SkiaProgress) {
  try { void Promise.resolve(options.onTaskProgress?.(event)).catch(() => undefined); } catch {}
}
async function readArchive(stream: ReadableStream<Uint8Array>, options: RecoveryOptions, total?: number): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let completed = 0;
  const update = () => report(options, { stage: "skia-download", message: "正在下载 Skia 原生库", completed, total, unit: "bytes" });
  update();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      completed += value.byteLength;
      update();
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(completed);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function downloadArchive(url: string, options: RecoveryOptions): Promise<Uint8Array<ArrayBuffer>> {
  const deadline = AbortSignal.timeout(90_000);
  for (let attempt = 1; ; attempt++) {
    report(options, { stage: "skia-request", message: `正在获取 Skia 原生库（尝试 ${attempt}/3）` });
    let retryable = true;
    let failure: unknown;
    try {
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(45_000)]);
      const response = await fetch(url, { signal });
      if (response.ok) {
        const length = Number(response.headers.get("content-length"));
        const total = !response.headers.get("content-encoding") && length > 0 && Number.isFinite(length) ? length : undefined;
        if (response.body) return await readArchive(response.body, options, total);
        return new Uint8Array(await response.arrayBuffer());
      }

      await response.body?.cancel().catch(() => undefined);
      retryable = response.status >= 500 || response.status === 408 || response.status === 429;
      failure = new Error(`Skia 发布资源返回 HTTP ${response.status}。`);
    } catch (error) {
      failure = error;
      if (attempt === 3 || deadline.aborted) {
        const curl = Bun.which("curl");
        if (!curl) throw error;

        // The same release asset is still verified against the package digest before installation.
        report(options, { stage: "skia-fallback", message: "正在使用备用下载方式获取 Skia 原生库" });
        const download = Bun.spawn([
          curl, "--disable", "--fail", "--silent", "--location",
          "--proto", "=https", "--proto-redir", "=https",
          "--connect-timeout", "10", "--max-time", "30", "--retry", "2", "--retry-all-errors",
          "--retry-max-time", "40", url,
        ], { stdout: "pipe", stderr: "ignore" });
        const [code, bytes] = await Promise.all([download.exited, readArchive(download.stdout, options)]);
        if (code === 0) return new Uint8Array(bytes);
      }
    }
    if (!retryable || attempt === 3 || deadline.aborted) throw failure;
    await Bun.sleep(500 * attempt);
  }
}

export async function recoverSkiaBinary(root: URL, options: RecoveryOptions = {}): Promise<boolean> {
  report(options, { stage: "skia-check", message: "正在核对 Skia 原生库" });
  for (const path of ["packages/skia/node_modules/skia-canvas/", "node_modules/skia-canvas/"]) {
    const directory = new URL(path, root);
    const metadata = new URL("package.json", directory);
    if (!await Bun.file(metadata).exists()) continue;

    const binary = new URL("lib/skia.node", directory);
    if (await Bun.file(binary).exists()) return false;

    const { version, prebuild } = await Bun.file(metadata).json();
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) return false;
    const { familySync } = createRequire(await realpath(metadata))("detect-libc") as { familySync: () => string | null };
    const target = [process.platform, process.arch, familySync()].filter(Boolean).join("-");
    const artifact = `${target}.gz`;
    const digest = prebuild?.[artifact];
    if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest)) return false;

    const url = `https://github.com/samizdatco/skia-canvas/releases/download/v${version}/${artifact}`;
    const bytes = await downloadArchive(url, options);
    report(options, { stage: "skia-verify", message: "正在校验 Skia 发布资源 SHA-256", completed: 0, total: bytes.byteLength, unit: "bytes" });
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest) {
      throw new Error("Skia 发布资源的 SHA-256 校验失败。");
    }
    report(options, { stage: "skia-verify", message: "Skia 发布资源 SHA-256 校验通过", completed: bytes.byteLength, total: bytes.byteLength, unit: "bytes" });
    report(options, { stage: "skia-extract", message: "正在解压并安装已校验的 Skia 原生库" });
    const temp = await mkdtemp(fileURLToPath(new URL("lib/.lotus-skia-", directory)));
    try {
      const staged = join(temp, "skia.node");
      await writeFile(staged, Bun.gunzipSync(bytes));
      await rename(staged, fileURLToPath(binary));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    report(options, { stage: "skia-ready", message: "Skia 原生库下载、校验及安装完成" });
    return true;
  }
  return false;
}
