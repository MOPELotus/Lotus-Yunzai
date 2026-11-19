import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPng } from "@lotus-yunzai/skia";
import { FontLibrary, loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { starRailGachaThemeDirectory } from "./gacha-detail-source.ts";
import type { StarRailGachaSpecialModel } from "./gacha-special.ts";

interface SpecialCardOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
  readonly themeDirectory?: string;
  readonly genshinResourceDirectory?: string;
}

type Pool = StarRailGachaSpecialModel["pools"][number];
type FiveStar = Pool["fiveLog"][number];

const light = "#f5f6fb";
const ink = "#1e1f20";
const muted = "#7f858a";
const paper = "#fff";
const numberFont = '"StarRailSpecialNumber", "StarRailSpecialHan", sans-serif';
const hanFont = '"StarRailSpecialHan", sans-serif';
const defaultGenshinResources = fileURLToPath(new URL("../../data/starrail/genshin-theme", import.meta.url));

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

async function loadTheme(genshin: string, miao: string) {
  for (const [family, name] of [["StarRailSpecialNumber", "tttgbnumber.ttf"], ["StarRailSpecialHan", "HYWenHei-55W.ttf"]] as const) {
    const path = await canonicalAsset(genshin, `font/${name}`);
    if (!path) throw new Error("星铁特殊池记录的原版字体不可用。");
    try {
      FontLibrary.use(family, [path]);
    } catch {
      throw new Error("星铁特殊池记录的原版字体不可用。");
    }
  }

  const [banner, logo, star] = await Promise.all([
    image(miao, "meta-sr/character/common/imgs/banner.webp"),
    image(genshin, "StarRail/img/other/logo.png"),
    image(genshin, "img/other/bg5.png"),
  ]);
  if (!banner || !logo || !star) throw new Error("星铁特殊池记录的原版图片不可用。");
  return { banner, logo, star };
}

const themeCache = new Map<string, ReturnType<typeof loadTheme>>();

function themeAt(genshin: string, miao: string) {
  const key = `${genshin}\0${miao}`;
  let theme = themeCache.get(key);
  if (!theme) {
    theme = loadTheme(genshin, miao).catch((error: unknown) => {
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
  align: CanvasTextAlign = "left", family = hanFont, maxWidth?: number, weight = false) {
  ctx.font = `${weight ? "700 " : ""}${size}px ${family}`;
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

function shadow(ctx: Context, draw: () => void) {
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.15)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 5;
  draw();
  ctx.restore();
}

function drawHeader(ctx: Context, theme: Theme, pool: Pool, uid: string, x: number, y: number, width: number, crossPool: boolean) {
  const height = crossPool ? 95 : 100;
  const corners = [15, 50, 50, 15];
  shadow(ctx, () => panel(ctx, x, y, width, height, corners, light));
  ctx.save();
  shape(ctx, x, y, width, height, corners);
  ctx.clip();
  const bannerWidth = theme.banner.width * height / theme.banner.height;
  ctx.drawImage(theme.banner, x + width - bannerWidth, y, bannerWidth, height);
  ctx.restore();

  const idSize = crossPool ? 24 : 26;
  const drawSize = crossPool ? 20 : 22;
  text(ctx, `ID: ${uid}`, x + 20, y + (crossPool ? 31 : 32), idSize, "#000", "left", numberFont, width - 170);
  const draws = `${pool.allNum}抽`;
  text(ctx, draws, x + 20, y + (crossPool ? 68 : 72), drawSize, "#000", "left", numberFont, width - 250, true);
  const labelX = x + 26 + ctx.measureText(draws).width;
  const label = `${pool.typeName}池`;
  ctx.font = `700 12px ${hanFont}`;
  const badgeWidth = ctx.measureText(label).width + 14;
  const badgeY = y + (crossPool ? 60 : 64);
  if (pool.type === 2 && !crossPool) panel(ctx, labelX, badgeY, badgeWidth, 17, 9, "#75c895");
  text(ctx, label, labelX + 7, badgeY + 8.5, 12, "#555", "left", hanFont, undefined, true);
  ctx.drawImage(theme.logo, x + width - 125, y + 5, 115, theme.logo.height * 115 / theme.logo.width);
}

type Metric = readonly [label: string, value: number | undefined, unit?: string];

function metrics(pool: Pool): readonly (readonly Metric[])[] {
  // The API only supplies real five-star rows and aggregate counts. Extremes need the full visible list.
  const intervals = pool.fiveLog.flatMap(({ num }) => num === undefined ? [] : [num]);
  const extremesKnown = pool.shownNum === pool.fiveNum && intervals.length > 0;
  return [
    [["未出五星", pool.pity, "抽"], ["五星", pool.fiveNum, "个"],
      [pool.knownIntervals === pool.fiveNum ? "五星平均" : "已知五星平均", pool.fiveAvg, "抽"],
      ["已知UP", pool.upNum, "个"], ["最长已知间隔", extremesKnown ? Math.max(...intervals) : undefined, "抽"]],
    [["已知出金间隔", pool.knownIntervals, "条"], ["未归属抽数", pool.unknownDraws, "抽"],
      ["已知非UP", pool.notUpNum, "个"], ["UP未记录", pool.unknownUpNum, "个"],
      ["最短已知间隔", extremesKnown ? Math.min(...intervals) : undefined, "抽"]],
  ];
}

function drawMetrics(ctx: Context, pool: Pool, x: number, y: number, width: number) {
  for (const [row, line] of metrics(pool).entries()) {
    for (const [column, [label, value, unit]] of line.entries()) {
      const cell = (width - 20) / 5;
      const center = x + 10 + (column + 0.5) * cell;
      const top = y + 20 + row * 59;
      const amount = value === undefined ? "—" : String(value);
      const suffix = value === undefined ? "" : unit ?? "";
      ctx.font = `24px ${numberFont}`;
      const naturalWidth = ctx.measureText(amount).width;
      ctx.font = `12px ${hanFont}`;
      const unitWidth = ctx.measureText(suffix).width;
      const numberWidth = Math.min(naturalWidth, cell - unitWidth - 4);
      const left = center - (numberWidth + unitWidth) / 2;
      text(ctx, amount, left, top + 14, 24, ink, "left", numberFont, numberWidth);
      text(ctx, suffix, left + numberWidth, top + 18, 12);
      text(ctx, label, center, top + 35, 14, muted, "center", hanFont, cell - 4);
    }
  }
}

function dateRange(pool: Pool) {
  if (pool.firstTime && pool.lastTime) return `五星历史 ${pool.firstTime} ~ ${pool.lastTime}`;
  return pool.fiveNum ? "五星历史 · 日期未记录" : "五星历史 · 暂无记录";
}

function drawHistoryHeading(ctx: Context, pool: Pool, x: number, y: number, width: number) {
  const label = dateRange(pool);
  ctx.font = `15px ${hanFont}`;
  const textWidth = Math.min(ctx.measureText(label).width, width - 60);
  const barWidth = (width - textWidth) / 2 - 20;
  ctx.fillStyle = "#ebebeb";
  ctx.fillRect(x + 10, y + 15, barWidth, 2);
  ctx.fillRect(x + width - barWidth - 10, y + 15, barWidth, 2);
  text(ctx, label, x + width / 2, y + 14, 15, "#7d7d7d", "center", hanFont, textWidth);
}

function amountColors(row: FiveStar, pool: Pool): readonly [string, string] {
  if (row.num === undefined || pool.max === undefined) return ["#e4e7ed", "#606777"];
  if (row.num <= 10) return ["#ffeb73", "#6f4b00"];
  if (row.num < pool.max * 0.5) return ["#168b2c", paper];
  if (row.num < pool.max * 0.83) return ["#6939b7", paper];
  return ["#9d3333", paper];
}

function drawFiveStar(ctx: Context, row: FiveStar, pool: Pool, theme: Theme,
  portraits: ReadonlyMap<string, Image>, x: number, y: number) {
  shadow(ctx, () => panel(ctx, x, y, 70, 90, 7, "#af8256"));
  ctx.save();
  shape(ctx, x, y, 70, 90, 7);
  ctx.clip();
  ctx.drawImage(theme.star, x, y, 70, 70);
  const art = row.icon && portraits.get(row.icon);
  if (art) {
    const w = 70 * art.width / art.height;
    ctx.drawImage(art, x + (70 - w) / 2, y, w, 70);
  } else {
    text(ctx, row.abbr || row.name, x + 35, y + 35, 13, "#51351d", "center", hanFont, 65);
  }

  const [fill, color] = amountColors(row, pool);
  ctx.fillStyle = fill;
  ctx.fillRect(x, y + 70, 70, 20);
  text(ctx, row.num === undefined ? "—" : String(row.num), x + 35, y + 80, 16, color, "center", numberFont, 66);
  if (row.isUp === true) {
    panel(ctx, x + 48, y, 22, 16, [2, 0, 2, 2], "rgba(0,0,0,.80)");
    text(ctx, "UP", x + 59, y + 8, 12, paper, "center", numberFont);
  }
  ctx.restore();
}

type PositionedPool = { pool: Pool; x: number; y: number; width: number; columns: number; rows: number; note: string };

function positions(model: StarRailGachaSpecialModel) {
  const crossPool = model.poolName === "全部";
  const width = crossPool ? 1200 : 510;
  const header = crossPool ? 95 : 100;
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
      const historyHeight = rows ? rows * 100 : 30;
      rowHeight = Math.max(rowHeight, header + 20 + 175 + historyHeight + (note ? 22 : 0) + 10);
    }
    y += rowHeight;
  }
  return { panels: result, width, bottom: y, crossPool };
}

function drawPool(ctx: Context, p: PositionedPool, model: StarRailGachaSpecialModel, theme: Theme,
  portraits: ReadonlyMap<string, Image>, crossPool: boolean) {
  const { pool, x, y, width, columns, rows, note } = p;
  drawHeader(ctx, theme, pool, model.uid, x, y, width, crossPool);
  const top = y + (crossPool ? 115 : 120);
  const historyHeight = rows ? rows * 100 : 30;
  shadow(ctx, () => panel(ctx, x, top, width, 175 + historyHeight + (note ? 22 : 0), 15, paper));

  panel(ctx, x - 8, top - 10, 76, 23, [15, 0, 15, 15], "#d4b98c");
  text(ctx, "数据总览", x + 30, top + 1.5, 14, paper, "center");
  drawMetrics(ctx, pool, x, top, width);
  const historyTop = top + 138;
  drawHistoryHeading(ctx, pool, x + 10, historyTop, width - 10);

  if (!rows) {
    text(ctx, pool.fiveNum ? "本页无五星记录" : "暂无五星记录", x + width / 2, historyTop + 49, 14, muted, "center");
  }
  const stride = crossPool ? 90 : 78;
  const inset = crossPool ? 20 : 10;
  for (const [index, row] of pool.fiveLog.entries()) {
    drawFiveStar(ctx, row, pool, theme, portraits, x + inset + index % columns * stride,
      historyTop + 32 + Math.floor(index / columns) * 100);
  }
  if (note) text(ctx, note, x + width / 2, historyTop + 41 + historyHeight, 12, muted, "center", hanFont, width - 20);
}

export async function renderStarRailGachaSpecial(
  model: StarRailGachaSpecialModel,
  { mode = "auto", scale = 1.5, themeDirectory = starRailGachaThemeDirectory(),
    genshinResourceDirectory = Bun.env.LOTUS_STAR_RAIL_GACHA_GENSHIN_RESOURCES_DIR?.trim() || defaultGenshinResources }: SpecialCardOptions = {},
) {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("抽卡记录缩放比例须在 1 至 4 之间。");
  const { panels, width, bottom, crossPool } = positions(model);
  const page = model.pageInfo && model.pageInfo.total > 1 ? model.pageInfo : undefined;
  const height = bottom + (page ? 47 : 25);
  if (height > 24_000) throw new RangeError("星铁特殊池记录超出可渲染高度。");

  const [genshin, miao] = await Promise.all([
    realpath(genshinResourceDirectory).catch(() => undefined),
    realpath(themeDirectory).catch(() => undefined),
  ]);
  if (!genshin) throw new Error("星铁特殊池记录的原 Genshin 资源目录不可用。");
  if (!miao) throw new Error("星铁特殊池记录的原喵喵资源目录不可用。");
  const theme = await themeAt(genshin, miao);
  const icons = new Set(model.pools.flatMap(({ fiveLog }) => fiveLog.map(({ icon }) => icon))
    .filter((path): path is string => !!path && /^\/?meta-sr\/(?:character|weapon)\/.+\.(?:png|webp|jpe?g)$/iu.test(path)));
  const portraits = new Map<string, Image>();
  for (const path of icons) {
    const art = await image(miao, path);
    if (art) portraits.set(path, art);
  }

  const zoom = Math.min(scale, 24_000 / height);
  const pixelWidth = Math.round(width * zoom);
  const pixelHeight = Math.round(height * zoom);
  return renderPng(pixelWidth, pixelHeight, (ctx) => {
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    ctx.scale(zoom, zoom);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    for (const panel of panels) drawPool(ctx, panel, model, theme, portraits, crossPool);
    if (page) text(ctx, `第 ${page.page}/${page.total} 张 · ${crossPool ? "各池" : ""}第 ${page.from}~${page.to} 条五星记录`,
      width / 2, bottom + 9, 14, muted, "center");
    text(ctx, "Created By Lotus-Yunzai", width / 2 + 5, bottom + (page ? 29.5 : 7.5),
      12, "#7994a7", "center", numberFont);
  }, mode);
}
