import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { registerGachaThemeFont } from "./gacha-theme-fonts.ts";
import { renderPng } from "./index.ts";

export interface GachaSpecialCardOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
  readonly themeDirectory: string;
  readonly genshinResourceDirectory: string;
}

export type GachaSpecialMetric = readonly [label: string, value: number | string | undefined, unit?: string];

interface FiveStar {
  readonly name: string;
  readonly abbr?: string;
  readonly icon?: string;
  readonly num?: number;
  readonly isUp?: boolean;
}

interface Pool {
  readonly type: number;
  readonly typeName: string;
  readonly allNum: number;
  readonly fiveNum: number;
  readonly firstTime?: string;
  readonly lastTime?: string;
  readonly max?: number;
  readonly fiveLog: readonly FiveStar[];
  readonly shownNum?: number;
  readonly hiddenNum?: number;
  readonly metrics: readonly (readonly GachaSpecialMetric[])[];
}

interface GachaSpecialView {
  readonly uid: string;
  readonly crossPool: boolean;
  readonly pools: readonly Pool[];
  readonly pageInfo?: { readonly page: number; readonly total: number; readonly from: number; readonly to: number };
}

const games = {
  sr: {
    label: "星铁", banner: "meta-sr/character/common/imgs/banner.webp", logo: "StarRail/img/other/logo.png",
    logoWidth: 115, logoRight: 10, logoTop: 5, historyEmpty: 30,
  },
  gs: {
    label: "原神", banner: "meta-gs/character/闲云/imgs/banner.webp", logo: "img/other/原神.png",
    logoWidth: 97, logoRight: 15, logoTop: 1, historyEmpty: 0,
  },
} as const;
type Game = keyof typeof games;

const light = "#f5f6fb";
const ink = "#1e1f20";
const muted = "#7f858a";
const paper = "#fff";
const fontFamilies = new WeakMap<Context, { han: string; number: string; wenHei: string }>();

async function canonicalAsset(root: string, source: string) {
  const path = source.replace(/^\//u, "");
  if (!path.split("/").every((part) => part && part !== "." && part !== ".." && !/[\\\0]/u.test(part))) return;
  const actual = await realpath(join(root, path)).catch(() => undefined);
  return actual?.startsWith(root + sep) ? actual : undefined;
}

async function image(root: string, source: string) {
  const path = await canonicalAsset(root, source);
  if (!path) return;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (stat.isFile() && stat.size <= 8 * 1024 * 1024) return await loadImage(await file.readFile());
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

async function loadTheme(genshin: string, characterTheme: string, game: Game) {
  const config = games[game];
  const aliases: string[] = [];
  for (const [family, name] of [["Number", "tttgbnumber.ttf"], ["Han", "HYWenHei-55W.ttf"]] as const) {
    const path = await canonicalAsset(genshin, `font/${name}`);
    if (!path) throw new Error(`${config.label}特殊池记录的原版字体不可用。`);
    try {
      aliases.push(registerGachaThemeFont(family, path));
    } catch {
      throw new Error(`${config.label}特殊池记录的原版字体不可用。`);
    }
  }

  const [banner, logo, star] = await Promise.all([
    image(characterTheme, config.banner),
    image(genshin, config.logo),
    image(genshin, "img/other/bg5.png"),
  ]);
  if (!banner || !logo || !star) throw new Error(`${config.label}特殊池记录的原版图片不可用。`);
  const wenHei = aliases[1] + ", sans-serif";
  const han = game === "gs" ? 'PingFangSC-Medium, "PingFang SC", "Droid Sans Fallback", sans-serif' : wenHei;
  return { banner, logo, star, fonts: { han, number: aliases[0] + ", " + han, wenHei } };
}

const themeCache = new Map<string, ReturnType<typeof loadTheme>>();

function themeAt(genshin: string, characterTheme: string, game: Game) {
  const key = `${game}\0${genshin}\0${characterTheme}`;
  let theme = themeCache.get(key);
  if (!theme) {
    theme = loadTheme(genshin, characterTheme, game).catch((error: unknown) => {
      themeCache.delete(key);
      throw error;
    });
    themeCache.set(key, theme);
  }
  return theme;
}

type Theme = Awaited<ReturnType<typeof loadTheme>>;

function shape(ctx: Context, x: number, y: number, w: number, h: number, corners: number | number[]) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, corners);
}

function panel(ctx: Context, x: number, y: number, w: number, h: number, corners: number | number[], fill: string) {
  shape(ctx, x, y, w, h, corners);
  ctx.fillStyle = fill;
  ctx.fill();
}

function text(ctx: Context, value: string, x: number, y: number, size: number, color = ink,
  align: CanvasTextAlign = "left", family: "han" | "number" | "wenHei" = "han", maxWidth?: number, weight = false) {
  const fonts = fontFamilies.get(ctx)!;
  ctx.font = `${weight ? "700 " : ""}${size}px ${fonts[family]}`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.save();
  ctx.translate(x, y);
  if (maxWidth !== undefined) {
    const naturalWidth = ctx.measureText(value).width;
    if (naturalWidth > maxWidth) ctx.scale(maxWidth / naturalWidth, 1);
  }
  if (weight) {
    ctx.strokeStyle = color;
    ctx.lineWidth = size * 0.023;
    ctx.strokeText(value, 0, 0);
  }
  ctx.fillText(value, 0, 0);
  ctx.restore();
}

function shadow(ctx: Context, game: Game, draw: () => void) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.15)";
  const scale = game === "gs" ? ctx.getTransform().a : 1;
  ctx.shadowBlur = 10 * scale;
  ctx.shadowOffsetY = 5 * scale;
  draw();
  ctx.restore();
}

function headerHeight(game: Game, crossPool: boolean) {
  return game === "sr" && !crossPool ? 100 : 95;
}

function drawHeader(ctx: Context, theme: Theme, pool: Pool, uid: string, x: number, y: number, width: number,
  crossPool: boolean, game: Game) {
  const config = games[game];
  const height = headerHeight(game, crossPool);
  const compact = height === 95;
  const corners = [15, 50, 50, 15];
  shadow(ctx, game, () => panel(ctx, x, y, width, height, corners, light));
  ctx.save();
  shape(ctx, x, y, width, height, corners);
  ctx.clip();
  const bannerWidth = theme.banner.width * height / theme.banner.height;
  ctx.drawImage(theme.banner, x + width - bannerWidth, y, bannerWidth, height);
  ctx.restore();

  const idSize = compact ? 24 : 26;
  const drawSize = compact ? 20 : 22;
  text(ctx, `ID: ${uid}`, x + 20, y + (compact ? 31 : 32), idSize, "#000", "left", "number", width - 170);
  const draws = `${pool.allNum}抽`;
  text(ctx, draws, x + 20, y + (compact ? 68 : 72), drawSize, "#000", "left", "number", width - 250, true);
  const labelX = x + 26 + ctx.measureText(draws).width;
  const label = `${pool.typeName}池`;
  ctx.font = `700 12px ${fontFamilies.get(ctx)!.han}`;
  const badgeWidth = ctx.measureText(label).width + 14;
  const badgeY = y + (compact ? 60 : 64);
  // The original Genshin overview uses the same label_301 style for each pool.
  const badge = game === "gs" ? (crossPool ? "#eb6a4b" : undefined) : pool.type === 2 && !crossPool ? "#75c895" : undefined;
  if (badge) panel(ctx, labelX, badgeY, badgeWidth, 17, 9, badge);
  text(ctx, label, labelX + 7, badgeY + 8.5, 12, "#555", "left", "han", undefined, true);
  ctx.drawImage(theme.logo, x + width - config.logoRight - config.logoWidth, y + config.logoTop,
    config.logoWidth, theme.logo.height * config.logoWidth / theme.logo.width);
}

function drawMetrics(ctx: Context, pool: Pool, x: number, y: number, width: number, game: Game) {
  const labelOffset = game === "gs" ? 38 : 35;
  for (const [row, line] of pool.metrics.entries()) {
    for (const [column, [label, value, unit]] of line.entries()) {
      const cell = (width - 20) / 5;
      const center = x + 10 + (column + 0.5) * cell;
      const top = y + 20 + row * 59;
      const amount = value === undefined ? "—" : String(value);
      const suffix = value === undefined ? "" : unit ?? "";
      ctx.font = `24px ${fontFamilies.get(ctx)!.number}`;
      const naturalWidth = ctx.measureText(amount).width;
      ctx.font = `12px ${fontFamilies.get(ctx)!.han}`;
      const unitWidth = ctx.measureText(suffix).width;
      const numberWidth = Math.min(naturalWidth, cell - unitWidth - 4);
      const left = center - (numberWidth + unitWidth) / 2;
      text(ctx, amount, left, top + 14, 24, ink, "left", "number", numberWidth);
      text(ctx, suffix, left + numberWidth, top + 18, 12);
      text(ctx, label, center, top + labelOffset, 14, muted, "center", "han", cell - 4);
    }
  }
}

function dateRange(pool: Pool) {
  if (pool.firstTime && pool.lastTime) return `五星历史 ${pool.firstTime} ~ ${pool.lastTime}`;
  return pool.fiveNum ? "五星历史 · 日期未记录" : "五星历史 · 暂无记录";
}

function drawHistoryHeading(ctx: Context, pool: Pool, x: number, y: number, width: number) {
  const label = dateRange(pool);
  ctx.font = `15px ${fontFamilies.get(ctx)!.wenHei}`;
  const textWidth = Math.min(ctx.measureText(label).width, width - 60);
  const barWidth = (width - textWidth) / 2 - 20;
  ctx.fillStyle = "#ebebeb";
  ctx.fillRect(x + 10, y + 15, barWidth, 2);
  ctx.fillRect(x + width - barWidth - 10, y + 15, barWidth, 2);
  text(ctx, label, x + width / 2, y + 14, 15, "#7d7d7d", "center", "wenHei", textWidth);
}

function amountColors(row: FiveStar, pool: Pool): readonly [string, string] {
  if (row.num === undefined || pool.max === undefined) return ["#e4e7ed", "#606777"];
  if (row.num <= 10) return ["#ffeb73", "#6f4b00"];
  if (row.num < pool.max * 0.5) return ["#168b2c", paper];
  if (row.num < pool.max * 0.83) return ["#6939b7", paper];
  return ["#9d3333", paper];
}

function drawFiveStar(ctx: Context, row: FiveStar, pool: Pool, theme: Theme, game: Game,
  portraits: ReadonlyMap<string, Image>, x: number, y: number) {
  shadow(ctx, game, () => panel(ctx, x, y, 70, 90, 7, "#af8256"));
  ctx.save();
  shape(ctx, x, y, 70, 90, 7);
  ctx.clip();
  ctx.drawImage(theme.star, x, y, 70, 70);
  const art = row.icon && portraits.get(row.icon);
  if (art) {
    const w = 70 * art.width / art.height;
    ctx.drawImage(art, x + (70 - w) / 2, y, w, 70);
  } else {
    text(ctx, row.abbr || row.name, x + 35, y + 35, 13, "#51351d", "center", "han", 65);
  }

  const [fill, color] = amountColors(row, pool);
  ctx.fillStyle = fill;
  ctx.fillRect(x, y + 70, 70, 20);
  text(ctx, row.num === undefined ? "—" : String(row.num), x + 35, y + 80, 16, color, "center", "number", 66);
  if (row.isUp === true) {
    panel(ctx, x + 48, y, 22, 16, [2, 0, 2, 2], "rgba(0,0,0,.80)");
    text(ctx, "UP", x + 59, y + 8, 12, paper, "center", "number");
  }
  ctx.restore();
}

type PositionedPool = { pool: Pool; x: number; y: number; width: number; columns: number; rows: number; note: string };

function historyHeight(rows: number, game: Game) {
  return rows ? rows * 100 : games[game].historyEmpty;
}

function positions(model: GachaSpecialView, game: Game) {
  const { crossPool } = model;
  const width = crossPool ? 1200 : 510;
  const header = headerHeight(game, crossPool);
  const lineWidth = crossPool ? 2 : 1;
  let y = 20;
  const result: PositionedPool[] = [];

  for (let start = 0; start < model.pools.length; start += lineWidth) {
    const line = model.pools.slice(start, start + lineWidth);
    const panelWidth = crossPool ? line.length === 2 ? 555 : 1140 : 480;
    let rowHeight = 0;
    for (const [index, pool] of line.entries()) {
      const columns = Math.floor((panelWidth - 10) / (crossPool ? 90 : 78));
      const rows = Math.ceil(pool.fiveLog.length / columns);
      const x = crossPool ? 30 + index * 585 : 15;
      const note = !model.pageInfo && pool.hiddenNum
        ? `仅显示最近 ${pool.shownNum} 条五星记录，另有 ${pool.hiddenNum} 条` : "";
      result.push({ pool, x, y, width: panelWidth, columns, rows, note });
      rowHeight = Math.max(rowHeight, header + 20 + 175 + historyHeight(rows, game) + (note ? 22 : 0) + 10);
    }
    y += rowHeight;
  }
  return { panels: result, width, bottom: y, crossPool };
}

function drawPool(ctx: Context, p: PositionedPool, model: GachaSpecialView, theme: Theme,
  portraits: ReadonlyMap<string, Image>, crossPool: boolean, game: Game) {
  const { pool, x, y, width, columns, rows, note } = p;
  drawHeader(ctx, theme, pool, model.uid, x, y, width, crossPool, game);
  const top = y + headerHeight(game, crossPool) + 20;
  const cardsHeight = historyHeight(rows, game);
  shadow(ctx, game, () => panel(ctx, x, top, width, 175 + cardsHeight + (note ? 22 : 0), 15, paper));

  panel(ctx, x - 8, top - 10, 76, 23, [15, 0, 15, 15], "#d4b98c");
  text(ctx, "数据总览", x + 30, top + 1.5, 14, paper, "center", "wenHei");
  drawMetrics(ctx, pool, x, top, width, game);
  const historyTop = top + 138;
  drawHistoryHeading(ctx, pool, x + 10, historyTop, width - 10);

  if (!rows && cardsHeight) {
    text(ctx, pool.fiveNum ? "本页无五星记录" : "暂无五星记录", x + width / 2, historyTop + 49, 14, muted, "center");
  }
  const stride = crossPool ? 90 : 78;
  const inset = crossPool ? 20 : 10;
  for (const [index, row] of pool.fiveLog.entries()) {
    drawFiveStar(ctx, row, pool, theme, game, portraits, x + inset + index % columns * stride,
      historyTop + 32 + Math.floor(index / columns) * 100);
  }
  if (note) text(ctx, note, x + width / 2, historyTop + 41 + cardsHeight, 12, muted, "center", "han", width - 20);
}

export async function renderGachaSpecialCard(
  game: Game, model: GachaSpecialView,
  { mode = "auto", scale = 4, themeDirectory, genshinResourceDirectory }: GachaSpecialCardOptions,
) {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("抽卡记录缩放比例须在 1 至 4 之间。");
  const { panels, width, bottom, crossPool } = positions(model, game);
  const page = model.pageInfo && model.pageInfo.total > 1 ? model.pageInfo : undefined;
  const height = bottom + (page ? 47 : 25);
  if (height > 24_000) throw new RangeError(`${games[game].label}特殊池记录超出可渲染高度。`);

  const [genshin, characterTheme] = await Promise.all([
    realpath(genshinResourceDirectory).catch(() => undefined),
    realpath(themeDirectory).catch(() => undefined),
  ]);
  if (!genshin) throw new Error(`${games[game].label}特殊池记录的原 Genshin 资源目录不可用。`);
  if (!characterTheme) throw new Error(`${games[game].label}特殊池记录的原版角色资源目录不可用。`);
  const theme = await themeAt(genshin, characterTheme, game);
  const icons = new Set(model.pools.flatMap(({ fiveLog }) => fiveLog.map(({ icon }) => icon))
    .filter((path): path is string => !!path && /^\/?meta-(gs|sr)\/(?:character|weapon)\/.+\.(?:png|webp|jpe?g)$/iu.exec(path)?.[1]?.toLowerCase() === game));
  const portraits = new Map<string, Image>();
  for (const path of icons) {
    const art = await image(characterTheme, path);
    if (art) portraits.set(path, art);
  }

  const zoom = scale * (game === "gs" ? 1.5 : 1);
  const pixelWidth = Math.round(width * zoom);
  const pixelHeight = Math.round(height * zoom);
  return renderPng(pixelWidth, pixelHeight, (ctx) => {
    fontFamilies.set(ctx, theme.fonts);
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    ctx.scale(zoom, zoom);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    for (const panel of panels) drawPool(ctx, panel, model, theme, portraits, crossPool, game);
    if (page) text(ctx, `第 ${page.page}/${page.total} 张 · ${crossPool ? "各池" : ""}第 ${page.from}~${page.to} 条五星记录`,
      width / 2, bottom + 9, 14, muted, "center");
    text(ctx, "Created By Lotus-Yunzai", width / 2 + 5, bottom + (page ? 29.5 : 7.5),
      12, "#7994a7", "center", "number");
  }, mode, { renderScale: scale, allowHalfScale: scale === 4 });
}
