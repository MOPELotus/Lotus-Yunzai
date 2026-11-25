import { builtinFontFallback, prepareBuiltinFonts } from "./builtin-fonts.ts";
import { builtinResourceDirectory } from "../../lib/builtin-resources.ts";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { FontLibrary, loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { nativeImageRasterScale, renderPng, type PngRender } from "./index.ts";

export interface DailyNoteReminderCardModel {
  readonly game: "gs" | "sr" | "zzz";
  readonly current: number;
  readonly max: number;
}

export interface DailyNoteReminderCardOptions {
  readonly resourceDirectory?: string;
  readonly inlineImageByteLimit?: number;
  readonly mode?: "auto" | "gpu" | "cpu";
}

type Game = DailyNoteReminderCardModel["game"];
type Theme = {
  readonly background: Image;
  readonly icon?: Image;
  readonly labelFont: string;
  readonly numberFont: string;
};

const designs = {
  gs: {
    width: 568, height: 314,
    background: "genshin/img/dailyNote/bg/bg.png", icon: "genshin/img/dailyNote/树脂.png",
    labelFont: "MiSans-Regular.ttf", numberFont: "HYWenHei.ttf", paint: paintGenshin,
  },
  sr: {
    width: 600, height: 271,
    background: "StarRail/img/dailyNote/bg.png", icon: undefined,
    labelFont: "HYWenHei-55W.ttf", numberFont: "tttgbnumber.ttf", paint: paintStarRail,
  },
  zzz: {
    width: 320, height: 319,
    background: "ZZZero/img/dailyNote/bg.png", icon: "ZZZero/img/dailyNote/电池.png",
    labelFont: "HYWenHei-55W.ttf", numberFont: "ZZZ.ttf", paint: paintZenless,
  },
} as const;

const themes = new Map<string, Promise<Theme>>();
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function originalAsset(directory: string, relative: string) {
  let path = directory;
  const parts = relative.split("/");
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const entry = await lstat(path);
    if (!(index === parts.length - 1 ? entry.isFile() && entry.size <= 32 * 1024 * 1024 : entry.isDirectory())) {
      throw new Error("群体力原素材路径无效。");
    }
  }
  if (await realpath(path) !== path) throw new Error("群体力原素材路径无效。");
  return path;
}

async function originalPng(directory: string, relative: string) {
  const bytes = await readFile(await originalAsset(directory, relative));
  if (bytes.length < 24 || !bytes.subarray(0, pngSignature.length).equals(pngSignature) ||
      bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16_777_216) {
    throw new Error("群体力原素材不是 PNG。");
  }
  return loadImage(bytes);
}

async function loadTheme(directory: string, game: Game): Promise<Theme> {
  prepareBuiltinFonts();
  const design = designs[game];
  const [background, icon] = await Promise.all([
    originalPng(directory, design.background),
    design.icon ? originalPng(directory, design.icon) : undefined,
  ]);
  const suffix = createHash("sha256").update(directory).digest("hex").slice(0, 12);
  const labelFont = `DailyReminderLabel${game}${suffix}`;
  const numberFont = `DailyReminderNumber${game}${suffix}`;
  const [labelFile, numberFile] = await Promise.all([
    originalAsset(directory, `fonts/${design.labelFont}`),
    originalAsset(directory, `fonts/${design.numberFont}`),
  ]);
  FontLibrary.use(labelFont, [labelFile]);
  FontLibrary.use(numberFont, [numberFile]);
  return { background, icon, labelFont, numberFont };
}

function themeAt(directory: string, game: Game) {
  const key = `${directory}\0${game}`;
  let theme = themes.get(key);
  if (!theme) {
    theme = loadTheme(directory, game).catch((error: unknown) => {
      themes.delete(key);
      throw error;
    });
    themes.set(key, theme);
  }
  return theme;
}

function rounded(ctx: Context, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function fillRounded(ctx: Context, x: number, y: number, width: number, height: number, radius: number, color: string) {
  rounded(ctx, x, y, width, height, radius);
  ctx.fillStyle = color;
  ctx.fill();
}

function text(ctx: Context, value: string, x: number, y: number, size: number, font: string, color: string) {
  ctx.font = `${size}px "${font}", ${builtinFontFallback}`;
  ctx.fillStyle = color;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(value, x, y);
}

function ratio(ctx: Context, model: DailyNoteReminderCardModel, theme: Theme,
  x: number, y: number, width: number, size: number, color: string, suffixColor: string,
) {
  const current = String(model.current);
  const suffix = `/${model.max}`;
  ctx.font = `${size}px "${theme.numberFont}", ${builtinFontFallback}`;
  const mainWidth = ctx.measureText(current).width;
  ctx.font = `${Math.round(size * 0.66)}px "${theme.numberFont}", ${builtinFontFallback}`;
  const suffixWidth = ctx.measureText(suffix).width;
  const fit = Math.min(1, width / (mainWidth + suffixWidth));
  text(ctx, current, x, y, size * fit, theme.numberFont, color);
  text(ctx, suffix, x + mainWidth * fit, y, Math.round(size * 0.66) * fit, theme.numberFont, suffixColor);
}

function paintGenshin(ctx: Context, model: DailyNoteReminderCardModel, theme: Theme) {
  ctx.drawImage(theme.background, 0, 0, 568, 314);
  if (theme.icon) ctx.drawImage(theme.icon, 71, 135, 51, 51);
  text(ctx, "原神", 136, 113, 21, theme.labelFont, "#6e583a");
  text(ctx, "原粹树脂", 136, 167, 26, theme.labelFont, "#444444");
  ratio(ctx, model, theme, 293, 169, 192, 42, model.current >= 159 ? "#b5342a" : "#a9843f", "#715833");
  text(ctx, "Lotus-Yunzai", 79, 264, 13, theme.labelFont, "#000");
}

function paintStarRail(ctx: Context, model: DailyNoteReminderCardModel, theme: Theme) {
  // Use the upper part of the original 1200 × 1835 sheet around its stamina section.
  ctx.drawImage(theme.background, 0, 0, theme.background.width, theme.background.height * 542 / 1835, 0, 0, 600, 271);
  fillRounded(ctx, 49, 97, 502, 128, 6, "#e5e5e5");
  text(ctx, "星穹铁道", 79, 90, 27, theme.labelFont, "#302b25");
  text(ctx, "开拓力", 79, 155, 24, theme.labelFont, "#25221d");
  ratio(ctx, model, theme, 191, 161, 284, 48, "#a26d3a", "#302b25");
  fillRounded(ctx, 79, 183, 441, 10, 5, "#a1a1a1");
  if (model.current > 0) {
    fillRounded(ctx, 79, 183, 441 * Math.min(1, model.current / model.max), 10, 5, "#b47f4c");
  }
  text(ctx, "Lotus-Yunzai", 79, 242, 13, theme.labelFont, "#000");
}

function paintZenless(ctx: Context, model: DailyNoteReminderCardModel, theme: Theme) {
  // Retain the left stamina panel, with the right task panel outside the crop.
  rounded(ctx, 0, 0, 320, 319, 20);
  ctx.save();
  ctx.clip();
  ctx.drawImage(theme.background, 0, 0, theme.background.width * 320 / 800, theme.background.height * 319 / 376, 0, 0, 320, 319);
  if (theme.icon) ctx.drawImage(theme.icon, 42, 113, 90, 90);
  text(ctx, "绝区零", 42, 48, 27, theme.labelFont, "#ffffff");
  text(ctx, "电量", 146, 143, 24, theme.labelFont, "#ffffff");
  ratio(ctx, model, theme, 146, 198, 145, 46, model.current >= model.max ? "#91d85b" : "#ffab26", "#ffffff");
  text(ctx, "Lotus-Yunzai", 42, 275, 13, theme.labelFont, "#ffffff");
  ctx.restore();
}

export async function renderDailyNoteReminderCard(model: DailyNoteReminderCardModel,
  { resourceDirectory = Bun.env.LOTUS_DAILY_NOTE_REMINDER_THEME_DIR?.trim() || builtinResourceDirectory("core/daily-note-reminder"), inlineImageByteLimit = Infinity, mode = "auto" }: DailyNoteReminderCardOptions = {},
): Promise<(PngRender & { readonly scale: 4 | 2 | 1 }) | undefined> {
  const { game, current, max } = model;
  if (!resourceDirectory || !(inlineImageByteLimit > 0) || !Object.hasOwn(designs, game)
    || !Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(max) || max < 1) return;

  try {
    const directory = resolve(resourceDirectory);
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) return;
    const design = designs[game];
    const theme = await themeAt(directory, game);
    const scales = nativeImageRasterScale() === 4 ? [4, 2] as const : [1] as const;
    for (const scale of scales) {
      const result = await renderPng(design.width * scale, design.height * scale, context => {
        context.scale(scale, scale);
        design.paint(context, model, theme);
      }, mode, { renderScale: scale });
      if (result.png.byteLength <= inlineImageByteLimit) return { ...result, scale };
    }
  } catch {
    // Optional image. The reminder caller retains the same values in its text reply.
  }
}
