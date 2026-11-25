import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { assertInitializationComplete } from "../lib/initialization-state.ts";
import { installTerminalLogging } from "../lib/terminal-log-format.ts";
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
    if (chooseAtlas && !allowDefaultChannel) throw new Error($t("scripts.startup.text_4f3b58cb1a"));
    return { ...(chooseAtlas && { channel: "latest" }), renderPreset: "standard" };
  }
  const input = createInterface({ input: process.stdin, output: process.stderr });
  const interactive = new AbortController();
  input.once("close", () => interactive.abort(new Error($t("scripts.startup.text_8fe6a53281"))));
  const questionSignal = AbortSignal.any([signal, interactive.signal]);
  try {
    let channel: AtlasChannel | undefined;
    let renderPreset: ImageRenderPreset | undefined;
    if (chooseAtlas) {
      console.log($t("scripts.startup.text_b5976b3874"));
      while (!channel) {
        const answer = (await input.question($t("scripts.startup.text_2a67e19b6c"), { signal: questionSignal })).trim().toLowerCase();
        if (answer === "" || answer === "1" || answer === "latest") channel = "latest";
        if (answer === "2" || answer === "live") channel = "live";
      }
    }
    if (chooseRender) {
      console.log($t("scripts.startup.text_e51d8e3853"));
      while (!renderPreset) {
        const answer = (await input.question($t("scripts.startup.text_9d845edcd7"), { signal: questionSignal })).trim().toLowerCase();
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
    throw new Error(override ? $t("scripts.startup.text_57a3fb750c")
      : $t("scripts.startup.text_a4972860dd"), { cause });
  }
  return "ready";
}

async function loadStartupConfig(root: URL) {
  if (!await Bun.file(new URL("plugins/atlas/initialize-atlas.ts", root)).exists()) {
    throw new Error($t("scripts.startup.text_f501375b62"));
  }
  try {
    return await import("../lib/atlas-channel.ts");
  } catch {
    throw new Error($t("scripts.startup.text_92e77cd095"));
  }
}

async function prepareThemes(root: URL, signal: AbortSignal, firstSetup: boolean) {
  const prepare = <T>(message: string, task: (onProgress: InitializationProgressCallback) => Promise<T>) =>
    firstSetup ? runInitializationStage(message, task, { signal }) : task(() => {});
  const { prepareAtlasTheme } = await import("../plugins/atlas/prepare-theme.ts");
  const { copied, missing } = await prepare($t("scripts.startup.text_ef9cfcdeee"), onProgress => prepareAtlasTheme(root, {
    override: Bun.env.LOTUS_ATLAS_THEME_DIR, source: Bun.env.LOTUS_ATLAS_THEME_SOURCE_DIR, signal, onProgress, download: firstSetup,
  }));
  if (copied.length) console.log($t("scripts.startup.text_6fcf238dd1", { "length": copied.length }));
  if (missing.length) {
    if (firstSetup) throw new Error($t("scripts.startup.text_6cdbc75fa3", { "value1": missing.join("、") }));
    console.warn($t("scripts.startup.text_0fc81dc230", { "length": missing.length }));
  }

  const { prepareDailyNoteTheme } = await import("../lib/daily-note-theme.ts");
  const dailyNote = await prepare($t("scripts.startup.text_fc32208434"), onProgress => prepareDailyNoteTheme(root, {
    override: Bun.env.LOTUS_DAILY_NOTE_RESOURCES, signal, download: firstSetup, onProgress,
  })).catch((cause: unknown) => {
    signal.throwIfAborted();
    if (firstSetup) throw new Error($t("scripts.startup.text_89356968ea"), { cause });
    console.warn($t("scripts.startup.text_af83b5fa5b"));
  });
  signal.throwIfAborted();
  if (dailyNote === "installed") console.log($t("scripts.startup.text_a4dfcbc4d2"));
  if (firstSetup && (dailyNote === "missing" || dailyNote === "incomplete")) throw new Error($t("scripts.startup.text_5fc3f25ebe"));
  if (dailyNote === "incomplete") {
    console.warn($t("scripts.startup.text_1350779414"));
  }
  if (dailyNote === "missing" && firstSetup) console.warn($t("scripts.startup.text_cdd97b27e8"));

  if (await Bun.file(new URL("plugins/zzz/tuning-detail-card.ts", root)).exists()) {
    const { prepareZzzTuningTheme } = await import("../lib/zzz-tuning-theme.ts");
    const zzzTuning = await prepare($t("scripts.startup.text_1609cc265f"), onProgress => prepareZzzTuningTheme(root, {
      override: Bun.env.LOTUS_ZZZ_GACHA_THEME_DIR?.trim(), signal, download: firstSetup, onProgress,
    })).catch((cause: unknown) => {
      signal.throwIfAborted();
      if (firstSetup) throw new Error($t("scripts.startup.text_a271099cce"), { cause });
      console.warn($t("scripts.startup.text_5a3e39206d"));
    });
    signal.throwIfAborted();
    if (zzzTuning === "installed") console.log($t("scripts.startup.text_147f390599"));
    if (firstSetup && (zzzTuning === "missing" || zzzTuning === "incomplete")) throw new Error($t("scripts.startup.text_44c47db5e8"));
    if (zzzTuning === "incomplete") {
      console.warn($t("scripts.startup.text_815d344983"));
    }
    if (zzzTuning === "missing" && firstSetup) console.warn($t("scripts.startup.text_e1e2822694"));
  }

  if (await Bun.file(new URL("plugins/genshin/wish-calendar.ts", root)).exists()) {
    const { prepareGenshinWishCalendar } = await import("../plugins/genshin/wish-calendar.ts");
    const wishCalendar = await prepare($t("scripts.startup.text_a2c0b96419"), onProgress => prepareGenshinWishCalendar(root, { signal, download: firstSetup, onProgress }));
    if (wishCalendar === "installed") console.log($t("scripts.startup.text_c539681728"));
    if (wishCalendar === "missing" && firstSetup) {
      throw new Error($t("scripts.startup.text_0547c4b57c"));
    }
  }

  if (await Bun.file(new URL("plugins/starrail/challenge-theme.ts", root)).exists()) {
    const { prepareStarRailChallengeTheme } = await import("../plugins/starrail/challenge-theme.ts");
    const starrail = await prepare($t("scripts.startup.text_88b30e8715"), onProgress => prepareStarRailChallengeTheme(root, {
      override: Bun.env.LOTUS_STAR_RAIL_CHALLENGE_THEME_DIR, signal, download: firstSetup, onProgress,
    }));
    if (starrail.templates || starrail.portraits) {
      console.log($t("scripts.startup.text_01e1e5e258", { "templates": starrail.templates, "portraits": starrail.portraits }));
    }
    if (firstSetup && starrail.missing.length) throw new Error($t("scripts.startup.text_14e08f95ef", { "value1": starrail.missing.join("、") }));
    if (starrail.missing.length) console.warn($t("scripts.startup.text_b99661feab", { "length": starrail.missing.length }));
  }
  if (await Bun.file(new URL("plugins/starrail/simulation/reincarnation-theme.ts", root)).exists()) {
    const { prepareStarRailReincarnationTheme } = await import("../plugins/starrail/simulation/reincarnation-theme.ts");
    const relife = await prepare($t("scripts.startup.text_e27bd2c080"), onProgress => prepareStarRailReincarnationTheme(root, {
      override: Bun.env.LOTUS_STAR_RAIL_WARP_THEME_DIR, signal, download: firstSetup, onProgress,
    }));
    if (relife.installed) console.log($t("scripts.startup.text_4f0aebd2e2", { "installed": relife.installed }));
    if (relife.missing.length && firstSetup) throw new Error($t("scripts.startup.text_fe3863c183", { "value1": relife.missing.join("、") }));
  }
}

export async function prepareStartup(root: URL, requested: AtlasChannel | undefined, signal: AbortSignal, initialize = requested !== undefined) {
  if (!initialize) await assertInitializationComplete(root);
  const { persistAtlasChannel, readAtlasChannel } = await loadStartupConfig(root);
  if (await Bun.file(new URL("config/server.yaml", root)).exists()) {
    const { prepareMigratedOneBot } = await import("../lib/migrated-onebot-setup.ts");
    if (await prepareMigratedOneBot(root, Bun.env, initialize, signal)) {
      console.log($t("scripts.startup.text_8b1e9a8b55"));
    }
  }
  const previous = await readAtlasChannel(root);
  const directory = fileURLToPath(new URL("data/atlas/", root));
  const { readLotusGlobalConfig } = await import("../lib/lotus-global-config.ts");
  const { defaultAtlasLocale, parseAtlasLocale } = await import("../plugins/atlas/locale.ts");
  const config = await readLotusGlobalConfig(root);
  const locale = parseAtlasLocale((config.atlas as { locale?: unknown } | undefined)?.locale) ?? defaultAtlasLocale;
  const atlas = await (initialize ? runInitializationStage($t("scripts.startup.text_212142057d"), () => atlasReadiness(directory, locale), { signal })
    : atlasReadiness(directory, locale));
  signal.throwIfAborted();
  if (atlas === "reset" && !initialize && requested === undefined) {
    console.warn($t("scripts.startup.text_1578f61be2"));
    await prepareThemes(root, signal, false);
    return;
  }
  const ready = atlas === "ready";
  if (!ready && !initialize) throw new Error($t("scripts.startup.text_4f3b58cb1a"));
  const { initializeTerminalOwner } = await import("../lib/initialize-terminal-owner.ts");
  if (await initializeTerminalOwner(root, signal)) console.info($t("scripts.startup.text_9adf004c60"));
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
  if (initialize && await Bun.file(new URL("lib/managed-valkey.ts", root)).exists()) {
    const { initializeValkey } = await import("../lib/managed-valkey.ts");
    await runInitializationStage($t("scripts.startup.text_d0a9256265"), progress => initializeValkey(root, signal,
      message => progress({ stage: "valkey", message })), { signal });
  }
  if (initialize) {
    const { initializeRuntimeResources } = await import("../lib/initialize-resources.ts");
    await initializeRuntimeResources(root, signal, config);
  }
}

if (import.meta.main) {
  installTerminalLogging();
  const args = Bun.argv.slice(2);
  const initialize = args[0] === "--initialize";
  const [channel, ...remaining] = initialize ? args.slice(1) : args;
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error($t("scripts.startup.text_5893b8086e")));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (remaining.length || (channel !== undefined && channel !== "live" && channel !== "latest")) {
      throw new Error($t("scripts.startup.text_a1a4368363"));
    }
    await prepareStartup(new URL("../", import.meta.url), channel, controller.signal, initialize || channel !== undefined);
  } catch (error) {
    console.error(error instanceof Error ? error.message : $t("scripts.startup.text_8e1582eb80"));
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
  console.log($t("scripts.startup.text_6ec22d49c0", { "value1": channel === "live" ? $t("scripts.startup.text_93a48223a5") : $t("scripts.startup.text_1f41bacb06") }));
  const workspace = fileURLToPath(new URL("data/atlas-download/", root));
  const failure = $t("scripts.startup.text_16feda2cc7");
  const progress = createInitializationProgress($t("scripts.startup.text_06169ded8b"), { signal });
  progress.update({ stage: "atlas", message: $t("scripts.startup.text_0e26e4684f", { "value1": channel === "live" ? $t("scripts.startup.text_93a48223a5") : $t("scripts.startup.text_1f41bacb06") }) });
  try {
    const result = await initializeAtlasFromPublic(directory, workspace, signal, channel, {
      locale, publication: atlasUpdatePublicationOptions(config), onProgress: progress.update,
    }).catch((cause: unknown) => {
      signal.throwIfAborted();
      if (cause instanceof Error) console.warn($t("scripts.startup.text_8f0de28055", { "message": cause.message }));
      throw new Error(failure, { cause });
    });
    signal.throwIfAborted();
    if (result.status === "prepared") {
      throw new Error($t("scripts.startup.text_3126ef8174", { "version": result.version }));
    }
    if (result.status === "invalid" && result.issues[0]) console.warn($t("scripts.startup.text_0ce96f2ce5", { "value1": result.issues[0] }));
    progress.update({ stage: "readiness", message: $t("scripts.startup.text_3107dea983") });
    if (await atlasReadiness(directory, locale) !== "ready") throw new Error(failure);
    progress.complete($t("scripts.startup.text_4a1b408bb7"));
  } catch (error) {
    progress.fail(signal.aborted ? $t("scripts.startup.text_1d95c3d3c8") : $t("scripts.startup.text_7b8cc5db15"));
    throw error;
  } finally { progress.close(); }
}
