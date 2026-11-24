import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { AtlasLocale } from "../plugins/atlas/locale.ts";
import type { AtlasChannel } from "../lib/atlas-channel.ts";
import type { ImageRenderPreset } from "../lib/startup-render-preset.ts";
import { createInitializationProgress, runInitializationStage, type InitializationProgressCallback } from "../lib/initialization-progress.ts";

async function askStartupOptions(chooseAtlas: boolean, chooseRender: boolean, signal: AbortSignal, allowDefaultChannel = false):
  Promise<{ channel?: AtlasChannel; renderPreset?: ImageRenderPreset }> {
  if (!chooseAtlas && !chooseRender) return {};
  if (!process.stdin.isTTY) {
    if (chooseAtlas && !allowDefaultChannel) throw new Error("尚未完成初始化，请先运行 bun run bootstrap。");
    return { ...(chooseAtlas && { channel: "latest" }), renderPreset: "standard" };
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

async function atlasReadiness(directory: string, locale: AtlasLocale): Promise<"ready" | "missing" | "reset"> {
  const override = Bun.env.LOTUS_ATLAS_DATA_DIR;
  if (!override) {
    const { discoverRuntimeAtlasDataDirectory } = await import("../plugins/atlas/legacy-atlas-directory.ts");
    const { AtlasSnapshotReset } = await import("../plugins/atlas/snapshot-pointer.ts");
    try {
      await discoverRuntimeAtlasDataDirectory(directory);
    } catch (error) {
      if (missing(error)) return "missing";
      if (error instanceof AtlasSnapshotReset) return "reset";
      throw error;
    }
  }

  const { createAtlasRuntimeCatalog } = await import("../plugins/atlas/catalog.ts");
  const data = override ? resolve(directory, "../..", override) : undefined;
  try {
    const { atlasLocales } = await import("../plugins/atlas/locale.ts");
    try {
      await createAtlasRuntimeCatalog(directory, data, locale).read();
    } catch (error) {
      if (override) throw error;
      const others = (Object.keys(atlasLocales) as AtlasLocale[]).filter(language => language !== locale);
      await Promise.any(others.map(language => createAtlasRuntimeCatalog(directory, data, language).read()));
    }
  } catch (cause) {
    throw new Error(override ? "LOTUS_ATLAS_DATA_DIR 指定的图鉴索引不可用，请检查该目录的 map.json。"
      : "图鉴索引不可用，请检查 data/atlas 或旧部署中的 map.json。", { cause });
  }
  return "ready";
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
  const prepare = <T>(message: string, task: (onProgress: InitializationProgressCallback) => Promise<T>) =>
    firstSetup ? runInitializationStage(message, task, { signal }) : task(() => {});
  const { prepareAtlasTheme } = await import("../plugins/atlas/prepare-theme.ts");
  const { copied, missing } = await prepare("准备图鉴主题", onProgress => prepareAtlasTheme(root, {
    override: Bun.env.LOTUS_ATLAS_THEME_DIR, source: Bun.env.LOTUS_ATLAS_THEME_SOURCE_DIR, signal, onProgress,
  }));
  if (copied.length) console.log(`[图鉴] 已从本地恢复 ${copied.length} 个原主题文件。`);
  if (missing.length) {
    console.warn(`[图鉴] 缺少 ${missing.length} 个原主题文件。可在 data/atlas/theme/ 放入已获授权的素材后重启，或用 LOTUS_ATLAS_THEME_DIR 选定已有主题。`);
  }

  const { prepareDailyNoteTheme } = await import("../lib/daily-note-theme.ts");
  const dailyNote = await prepare("准备体力便笺素材", onProgress => prepareDailyNoteTheme(root, {
    override: Bun.env.LOTUS_DAILY_NOTE_RESOURCES, signal, download: firstSetup, onProgress,
  })).catch(() => {
    signal.throwIfAborted();
    console.warn("[体力] 原便笺主题读取或写入失败。体力查询将使用文字回执，请检查项目下的 data/daily-note/resources。");
  });
  signal.throwIfAborted();
  if (dailyNote === "installed") console.log("[体力] 已准备三游原便笺主题。");
  if (dailyNote === "incomplete") {
    console.warn("[体力] 本地原便笺主题不完整。可将原字体和图标补齐到 data/daily-note/resources，或设置 LOTUS_DAILY_NOTE_RESOURCES 指向完整主题。");
  }
  if (dailyNote === "missing" && firstSetup) console.warn("[体力] 原便笺主题暂不可用，可重新运行 bun run bootstrap 重试。");

  if (await Bun.file(new URL("plugins/zzz/tuning-detail-card.ts", root)).exists()) {
    const { prepareZzzTuningTheme } = await import("../lib/zzz-tuning-theme.ts");
    const zzzTuning = await prepare("准备绝区零调频素材", onProgress => prepareZzzTuningTheme(root, {
      override: Bun.env.LOTUS_ZZZ_GACHA_THEME_DIR?.trim(), signal, download: firstSetup, onProgress,
    })).catch(() => {
      signal.throwIfAborted();
      console.warn("[绝区零] 调频原主题读写失败，请检查 data/zzz/gacha-theme 的文件权限。");
    });
    signal.throwIfAborted();
    if (zzzTuning === "installed") console.log("[绝区零] 已准备原调频与逐抽主题。");
    if (zzzTuning === "incomplete") {
      console.warn("[绝区零] 本地调频原主题不完整。可补齐 data/zzz/gacha-theme，或设置 LOTUS_ZZZ_GACHA_THEME_DIR 指向完整主题。");
    }
    if (zzzTuning === "missing" && firstSetup) console.warn("[绝区零] 调频原主题暂不可用，可重新运行 bun run bootstrap 重试。");
  }

  if (await Bun.file(new URL("plugins/genshin/wish-calendar.ts", root)).exists()) {
    const { prepareGenshinWishCalendar } = await import("../plugins/genshin/wish-calendar.ts");
    const wishCalendar = await prepare("准备原神祈愿日历", onProgress => prepareGenshinWishCalendar(root, { signal, download: firstSetup, onProgress }));
    if (wishCalendar === "installed") console.log("[原神] 已准备原祈愿日历。");
    if (wishCalendar === "missing" && firstSetup) {
      console.warn("[原神] 原祈愿日历暂不可用，可重新运行 bun run bootstrap 重试。");
    }
  }

  if (await Bun.file(new URL("plugins/starrail/challenge-theme.ts", root)).exists()) {
    const { prepareStarRailChallengeTheme } = await import("../plugins/starrail/challenge-theme.ts");
    const starrail = await prepare("准备星铁挑战素材", onProgress => prepareStarRailChallengeTheme(root, {
      override: Bun.env.LOTUS_STAR_RAIL_CHALLENGE_THEME_DIR, signal, download: firstSetup, onProgress,
    }));
    if (starrail.templates || starrail.portraits) {
      console.log(`[星铁] 已恢复 ${starrail.templates} 个原挑战模板文件和 ${starrail.portraits} 张本地原头像。`);
    }
    if (starrail.missing.length) console.warn(`[星铁] 缺少 ${starrail.missing.length} 个原挑战模板文件，可重新运行 bun run bootstrap 补齐。`);
  }
  if (await Bun.file(new URL("plugins/starrail/simulation/reincarnation-theme.ts", root)).exists()) {
    const { prepareStarRailReincarnationTheme } = await import("../plugins/starrail/simulation/reincarnation-theme.ts");
    const relife = await prepare("准备星铁转生素材", onProgress => prepareStarRailReincarnationTheme(root, {
      override: Bun.env.LOTUS_STAR_RAIL_WARP_THEME_DIR, signal, download: firstSetup, onProgress,
    }));
    if (relife.installed) console.log(`[星铁] 已恢复 ${relife.installed} 个原转生主题文件。`);
    if (relife.missing.length && firstSetup) console.warn(`[星铁] 缺少 ${relife.missing.length} 个原转生主题文件，可重新运行 bun run bootstrap 补齐。`);
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
  const { readLotusGlobalConfig } = await import("../lib/lotus-global-config.ts");
  const { defaultAtlasLocale, parseAtlasLocale } = await import("../plugins/atlas/locale.ts");
  const config = await readLotusGlobalConfig(root);
  const locale = parseAtlasLocale((config.atlas as { locale?: unknown } | undefined)?.locale) ?? defaultAtlasLocale;
  const atlas = await (initialize ? runInitializationStage("核对现有图鉴", () => atlasReadiness(directory, locale), { signal })
    : atlasReadiness(directory, locale));
  signal.throwIfAborted();
  if (atlas === "reset" && !initialize && requested === undefined) {
    console.warn("[图鉴] 保持重置状态。可运行 bun run bootstrap 或使用 #全量更新图鉴 恢复。");
    await prepareThemes(root, signal, false);
    return;
  }
  const ready = atlas === "ready";
  const { needsInitialRenderPreset, persistInitialRenderPreset } = await import("../lib/startup-render-preset.ts");
  const options = await askStartupOptions(!ready && requested === undefined && previous === null,
    (!ready || initialize) && await needsInitialRenderPreset(root), signal, initialize);
  if (options.renderPreset) await persistInitialRenderPreset(root, options.renderPreset, signal);
  if (!ready || requested !== undefined) {
    const channel = requested ?? previous ?? options.channel!;
    if (previous !== channel) {
      await persistAtlasChannel(root, channel, previous, { signal, canWrite: () => true });
    }
    signal.throwIfAborted();
    if (!ready) await initializePublicAtlas(root, directory, channel, signal, locale, config.atlas);
  }
  await prepareThemes(root, signal, !ready || initialize);
  if ((!ready || initialize) && await Bun.file(new URL("packages/captcha/index.ts", root)).exists()) {
    const { initializeCaptchaModels } = await import("../lib/captcha/initialize.ts");
    await initializeCaptchaModels(root, signal);
  }
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

async function initializePublicAtlas(root: URL, directory: string, channel: AtlasChannel, signal: AbortSignal, locale: AtlasLocale,
  config: unknown) {
  const { initializeAtlasFromPublic } = await import("../plugins/atlas/initialize-atlas.ts");
  const { atlasUpdatePublicationOptions } = await import("../plugins/atlas/update-policy.ts");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  console.log(`[初始化] 正在准备${channel === "live" ? "正式版" : "最新版"}图鉴。`);
  const workspace = fileURLToPath(new URL("data/atlas-download/", root));
  const failure = "图鉴初始化失败。下载记录已保留，可重新运行 bun run bootstrap。";
  const progress = createInitializationProgress("图鉴", { signal });
  progress.update({ stage: "atlas", message: `准备${channel === "live" ? "正式版" : "最新版"}图鉴` });
  try {
    const result = await initializeAtlasFromPublic(directory, workspace, signal, channel, {
      locale, publication: atlasUpdatePublicationOptions(config), onProgress: progress.update,
    }).catch((cause: unknown) => {
      signal.throwIfAborted();
      if (cause instanceof Error) console.warn(`[图鉴] ${cause.message}`);
      throw new Error(failure, { cause });
    });
    signal.throwIfAborted();
    if (result.status === "prepared") {
      throw new Error(`图鉴候选已保存至第 ${result.version} 版。当前关闭了图鉴同步，启用同步后再运行 bun run bootstrap。`);
    }
    if (result.status === "invalid" && result.issues[0]) console.warn(`[图鉴] ${result.issues[0]}`);
    progress.update({ stage: "readiness", message: "核对图鉴发布结果" });
    if (await atlasReadiness(directory, locale) !== "ready") throw new Error(failure);
    progress.complete("图鉴已准备完成");
  } catch (error) {
    progress.fail(signal.aborted ? "图鉴准备已中止" : "图鉴准备失败，下载记录已保留");
    throw error;
  } finally { progress.close(); }
}
