import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { AtlasChannel } from "../lib/atlas-channel.ts";
import type { ImageRenderPreset } from "../lib/startup-render-preset.ts";

async function askStartupOptions(chooseAtlas: boolean, chooseRender: boolean, signal: AbortSignal):
  Promise<{ channel?: AtlasChannel; renderPreset?: ImageRenderPreset }> {
  if (!chooseAtlas && !chooseRender) return {};
  if (!process.stdin.isTTY) {
    if (chooseAtlas) throw new Error("还未选择图鉴版本来源。请先运行 bun run init latest 或 bun run init live。");
    return { renderPreset: "standard" };
  }
  const input = createInterface({ input: process.stdin, output: process.stderr });
  const interactive = new AbortController();
  input.once("close", () => interactive.abort(new Error("已取消初始化。")));
  const questionSignal = AbortSignal.any([signal, interactive.signal]);
  try {
    let channel: AtlasChannel | undefined;
    let renderPreset: ImageRenderPreset | undefined;
    if (chooseAtlas) {
      console.log("[初始化] 请选择图鉴版本来源。1. 最新版（含预览资料） 2. 正式版");
      while (!channel) {
        const answer = (await input.question("图鉴版本 [1/2，默认 1] ", { signal: questionSignal })).trim().toLowerCase();
        if (answer === "" || answer === "1" || answer === "latest") channel = "latest";
        if (answer === "2" || answer === "live") channel = "live";
      }
    }
    if (chooseRender) {
      console.log("[初始化] 请选择图片渲染档位。1. 标准配置（4×，效果更好，较慢） 2. 低配配置（1×，适合低资源或无独显）");
      while (!renderPreset) {
        const answer = (await input.question("图片渲染档位 [1/2，默认 1] ", { signal: questionSignal })).trim().toLowerCase();
        if (answer === "" || answer === "1" || answer === "standard") renderPreset = "standard";
        if (answer === "2" || answer === "low") renderPreset = "low";
      }
    }
    return { channel, renderPreset };
  } finally {
    input.close();
  }
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function atlasReady(directory: string): Promise<boolean> {
  const override = Bun.env.LOTUS_ATLAS_DATA_DIR;
  if (!override) {
    const { discoverRuntimeAtlasDataDirectory } = await import("../plugins/atlas/legacy-atlas-directory.ts");
    const { AtlasSnapshotReset } = await import("../plugins/atlas/snapshot-pointer.ts");
    try {
      await discoverRuntimeAtlasDataDirectory(directory);
    } catch (error) {
      if (missing(error) || error instanceof AtlasSnapshotReset) return false;
      throw error;
    }
  }

  const { createAtlasRuntimeCatalog } = await import("../plugins/atlas/catalog.ts");
  const data = override ? resolve(directory, "../..", override) : undefined;
  try {
    await createAtlasRuntimeCatalog(directory, data).read();
  } catch (cause) {
    throw new Error(override ? "LOTUS_ATLAS_DATA_DIR 指定的图鉴索引不可用，请检查该目录的 map.json。"
      : "图鉴索引不可用，请检查 data/atlas 或旧部署中的 map.json。", { cause });
  }
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

async function prepareThemes(root: URL, signal: AbortSignal, firstSetup: boolean) {
  const { prepareAtlasTheme } = await import("../plugins/atlas/prepare-theme.ts");
  const { copied, missing } = await prepareAtlasTheme(root, {
    override: Bun.env.LOTUS_ATLAS_THEME_DIR, source: Bun.env.LOTUS_ATLAS_THEME_SOURCE_DIR, signal,
  });
  if (copied.length) console.log(`[图鉴] 已从本地恢复 ${copied.length} 个原主题文件。`);
  if (missing.length) {
    console.warn(`[图鉴] 缺少 ${missing.length} 个原主题文件。可在 data/atlas/theme/ 放入已获授权的素材后重启，或用 LOTUS_ATLAS_THEME_DIR 选定已有主题。`);
  }

  if (await Bun.file(new URL("plugins/genshin/wish-calendar.ts", root)).exists()) {
    const { prepareGenshinWishCalendar } = await import("../plugins/genshin/wish-calendar.ts");
    const wishCalendar = await prepareGenshinWishCalendar(root, { signal, download: firstSetup });
    if (wishCalendar === "installed") console.log("[原神] 已准备原祈愿日历。");
    if (wishCalendar === "missing" && firstSetup) {
      console.warn("[原神] 原祈愿日历暂不可用，可运行 bun run init 重试。");
    }
  }

  if (await Bun.file(new URL("plugins/starrail/challenge-theme.ts", root)).exists()) {
    const { prepareStarRailChallengeTheme } = await import("../plugins/starrail/challenge-theme.ts");
    const starrail = await prepareStarRailChallengeTheme(root, {
      override: Bun.env.LOTUS_STAR_RAIL_CHALLENGE_THEME_DIR, signal, download: firstSetup,
    });
    if (starrail.templates || starrail.portraits) {
      console.log(`[星铁] 已恢复 ${starrail.templates} 个原挑战模板文件和 ${starrail.portraits} 张本地原头像。`);
    }
    if (starrail.missing.length) console.warn(`[星铁] 缺少 ${starrail.missing.length} 个原挑战模板文件，可运行 bun run init 补齐。`);
  }
}

export async function prepareStartup(root: URL, requested: AtlasChannel | undefined, signal: AbortSignal, initialize = requested !== undefined) {
  const { persistAtlasChannel, readAtlasChannel } = await loadStartupConfig(root);
  if (await Bun.file(new URL("config/server.yaml", root)).exists()) {
    const { prepareMigratedOneBot } = await import("../lib/migrated-onebot-setup.ts");
    if (await prepareMigratedOneBot(root, Bun.env, initialize, signal)) {
      console.log("[初始化] 已生成 OneBot 接入令牌。请用 config/server.yaml 的 onebot_token 配置网关连接。");
    }
  }
  const previous = await readAtlasChannel(root);
  const directory = fileURLToPath(new URL("data/atlas/", root));
  const ready = await atlasReady(directory);
  signal.throwIfAborted();
  const { needsInitialRenderPreset, persistInitialRenderPreset } = await import("../lib/startup-render-preset.ts");
  const options = await askStartupOptions(!ready && requested === undefined && previous === null,
    (!ready || initialize) && await needsInitialRenderPreset(root), signal);
  if (options.renderPreset) await persistInitialRenderPreset(root, options.renderPreset, signal);
  if (!ready || requested !== undefined) {
    const channel = requested ?? previous ?? options.channel!;
    if (previous !== channel) {
      await persistAtlasChannel(root, channel, previous, { signal, canWrite: () => true });
    }
    signal.throwIfAborted();
    if (!ready) await initializePublicAtlas(root, directory, channel, signal);
  }
  await prepareThemes(root, signal, !ready || initialize);
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const initialize = args[0] === "--initialize";
  const [channel, ...remaining] = initialize ? args.slice(1) : args;
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("启动操作已中止。"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (remaining.length || (channel !== undefined && channel !== "live" && channel !== "latest")) {
      throw new Error("图鉴版本来源须为正式版 live 或最新版 latest。");
    }
    await prepareStartup(new URL("../", import.meta.url), channel, controller.signal, initialize || channel !== undefined);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "初始化失败。");
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

async function initializePublicAtlas(root: URL, directory: string, channel: AtlasChannel, signal: AbortSignal) {
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
