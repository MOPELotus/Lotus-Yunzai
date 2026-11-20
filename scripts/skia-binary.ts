import { createHash } from "node:crypto";
import { mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function downloadArchive(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const deadline = AbortSignal.timeout(90_000);
  for (let attempt = 1; ; attempt++) {
    let retryable = true;
    let failure: unknown;
    try {
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(45_000)]);
      const response = await fetch(url, { signal });
      if (response.ok) return new Uint8Array(await response.arrayBuffer());

      await response.body?.cancel().catch(() => undefined);
      retryable = response.status >= 500 || response.status === 408 || response.status === 429;
      failure = new Error(`Skia 发布资源返回 HTTP ${response.status}。`);
    } catch (error) {
      failure = error;
      if (attempt === 3 || deadline.aborted) {
        const curl = Bun.which("curl");
        if (!curl) throw error;

        // The same release asset is still verified against the package digest before installation.
        const download = Bun.spawn([
          curl, "--disable", "--fail", "--silent", "--location",
          "--proto", "=https", "--proto-redir", "=https",
          "--connect-timeout", "10", "--max-time", "30", "--retry", "2", "--retry-all-errors",
          "--retry-max-time", "40", url,
        ], { stdout: "pipe", stderr: "ignore" });
        const [code, bytes] = await Promise.all([download.exited, new Response(download.stdout).arrayBuffer()]);
        if (code === 0) return new Uint8Array(bytes);
      }
    }
    if (!retryable || attempt === 3 || deadline.aborted) throw failure;
    await Bun.sleep(500 * attempt);
  }
}

export async function recoverSkiaBinary(root: URL): Promise<boolean> {
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
    const bytes = await downloadArchive(url);
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest) {
      throw new Error("Skia 发布资源的 SHA-256 校验失败。");
    }
    const temp = await mkdtemp(fileURLToPath(new URL("lib/.lotus-skia-", directory)));
    try {
      const staged = join(temp, "skia.node");
      await writeFile(staged, Bun.gunzipSync(bytes));
      await rename(staged, fileURLToPath(binary));
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
    return true;
  }
  return false;
}
