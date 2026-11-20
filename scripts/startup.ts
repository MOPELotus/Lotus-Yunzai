import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { AtlasChannel } from "../lib/atlas-channel.ts";

async function askAtlasChannel(signal: AbortSignal): Promise<AtlasChannel> {
  if (!process.stdin.isTTY) {
    throw new Error("还未选择图鉴版本来源。请先运行 bun run init latest 或 bun run init live。");
  }
  const input = createInterface({ input: process.stdin, output: process.stderr });
  const interactive = new AbortController();
  input.once("close", () => interactive.abort(new Error("已取消初始化。")));
  try {
    console.log("[初始化] 请选择图鉴版本来源。1. 最新版（含预览资料） 2. 正式版");
    for (;;) {
      const answer = (await input.question("图鉴版本 [1/2，默认 1] ", {
        signal: AbortSignal.any([signal, interactive.signal]),
      })).trim().toLowerCase();
      if (answer === "" || answer === "1" || answer === "latest") return "latest";
      if (answer === "2" || answer === "live") return "live";
    }
  } finally {
    input.close();
  }
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function atlasReady(directory: string): Promise<boolean> {
  const override = Bun.env.LOTUS_ATLAS_DATA_DIR;
  if (override) {
    if (!await stat(join(override, "map.json")).then((entry) => entry.isFile()).catch((error: unknown) => {
      if (!missing(error)) throw error;
      return false;
    })) throw new Error("LOTUS_ATLAS_DATA_DIR 指定的目录缺少可读取的 map.json。");
    return true;
  }

  const { discoverRuntimeAtlasDataDirectory } = await import("../plugins/atlas/legacy-atlas-directory.ts");
  const { AtlasSnapshotReset } = await import("../plugins/atlas/snapshot-pointer.ts");
  let root: string;
  try {
    ({ root } = await discoverRuntimeAtlasDataDirectory(directory));
  } catch (error) {
    if (missing(error) || error instanceof AtlasSnapshotReset) return false;
    throw error;
  }
  if (!(await stat(join(root, "map.json"))).isFile()) throw new Error("图鉴目录缺少可读取的 map.json。");
  return true;
}

async function loadStartupConfig(root: URL) {
  if (!await Bun.file(new URL("plugins/atlas/initialize-atlas.ts", root)).exists()) {
    throw new Error("图鉴模块尚未安装。请先运行 bun run bootstrap。");
  }
  try {
    return await import("../lib/atlas-channel.ts");
  } catch {
    throw new Error("启动依赖尚未就绪。请先运行 bun run bootstrap。");
  }
}

export async function prepareStartup(root: URL, requested: AtlasChannel | undefined, signal: AbortSignal) {
  const { persistAtlasChannel, readAtlasChannel } = await loadStartupConfig(root);
  const previous = await readAtlasChannel(root);
  const channel = requested ?? previous ?? await askAtlasChannel(signal);
  if (previous !== channel) {
    await persistAtlasChannel(root, channel, previous, signal);
  }
  signal.throwIfAborted();
  const directory = fileURLToPath(new URL("data/atlas/", root));
  if (await atlasReady(directory)) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  console.log(`[初始化] 正在准备${channel === "live" ? "正式版" : "最新版"}图鉴。`);
  const download = Bun.spawn([
    process.execPath, "plugins/atlas/initialize-atlas.ts", directory,
    "--public", fileURLToPath(new URL("data/atlas-download/", root)), "--channel", channel,
  ], {
    cwd: fileURLToPath(root), stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });
  const stop = () => download.kill("SIGTERM");
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    const exit = await download.exited;
    signal.throwIfAborted();
    if (exit !== 0 || !await atlasReady(directory)) {
      throw new Error("图鉴初始化失败。下载记录已保留，可重新运行 bun run init。");
    }
  } finally {
    signal.removeEventListener("abort", stop);
  }
}
