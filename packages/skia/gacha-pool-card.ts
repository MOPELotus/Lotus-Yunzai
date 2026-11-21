// The layout follows Miao's gacha/gacha-info template and its common element styles.
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { registerGachaThemeFont } from "./gacha-theme-fonts.ts";
import { renderPng } from "./index.ts";

interface PoolItem {
  readonly name: string;
  readonly abbr?: string;
  readonly img?: string;
  readonly star?: 4 | 5;
}

interface PoolGroup {
  readonly title: string;
  readonly star: 4 | 5;
  readonly rows: readonly (readonly PoolItem[])[];
}

interface Pool {
  readonly version: string;
  readonly half: string;
  readonly from: string;
  readonly to: string;
  readonly isMix: boolean;
  readonly groups: readonly PoolGroup[];
}

export interface GachaPoolCardModel {
  readonly game: "gs" | "sr";
  readonly pools: readonly Pool[];
  readonly reprint?: { readonly up: boolean; readonly days: number; readonly text: string };
}

const width = 740;
const panelX = 25;
const panelWidth = 685;
const rowWidth = panelWidth - 20;
const gold = "#d3bc8e";
const element = { gs: "hydro", sr: "sr" } as const;
type Game = GachaPoolCardModel["game"];

async function assetPath(root: string, name: string) {
  const path = name.replace(/^\//u, "");
  if (!path.split("/").every(part => part && part !== "." && part !== ".." && !/[\\\0]/u.test(part))) return;
  const file = await realpath(join(root, path)).catch(() => undefined);
  return file?.startsWith(root + sep) ? file : undefined;
}

async function readImage(root: string, name: string) {
  const file = await assetPath(root, name);
  if (!file) return;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (info.isFile() && info.size <= 8 * 1024 * 1024) return await loadImage(await handle.readFile());
    } finally {
      await handle.close();
    }
  } catch {
    return;
  }
}

async function readTheme(root: string, game: Game) {
  const [background, texture, four, five, han, number] = await Promise.all([
    readImage(root, `common/bg/bg-${element[game]}.webp`), readImage(root, "common/cont/card-bg.png"),
    readImage(root, "common/item/bg4.png"), readImage(root, "common/item/bg5.png"),
    assetPath(root, "common/font/HYWH-65W.ttf"), assetPath(root, "common/font/tttgbnumber.ttf"),
  ]);
  if (!background || !texture || !four || !five || !han || !number) throw new Error("旧卡池图卡主题不完整。");
  const fontFamily = `${registerGachaThemeFont("Number", number)}, ${registerGachaThemeFont("Han", han)}, sans-serif`;
  return { background, texture, stars: { 4: four, 5: five }, fontFamily };
}

type Theme = Awaited<ReturnType<typeof readTheme>>;
const themes = new Map<string, Promise<Theme>>();

function readCardsTheme(root: string, game: Game) {
  const key = `${game}\0${root}`;
  let theme = themes.get(key);
  if (!theme) {
    theme = readTheme(root, game).catch((error: unknown) => {
      themes.delete(key);
      throw error;
    });
    themes.set(key, theme);
  }
  return theme;
}

function rowTileWidth(row: readonly PoolItem[]) {
  return Math.min(76, rowWidth / Math.max(1, row.length) - 8);
}

function itemName(item: PoolItem) {
  return item.name.length > 4 ? item.abbr || item.name : item.name;
}

function sizePool(pool: Pool) {
  const caption = pool.isMix ? 43.484375 : 42;
  const content = 16 + pool.groups.reduce((sum, group, index) =>
    sum + (index ? 4 : 0) + 6 + group.rows.reduce((rows, row) => rows + rowTileWidth(row) + 28, 0), 0);
  return { caption, height: caption + content };
}

function round(ctx: Context, x: number, y: number, w: number, h: number, radius: number | number[]) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
}

function text(ctx: Context, text: string, x: number, y: number, family: string, size: number, color: string,
  { center = false, bold = false }: { center?: boolean; bold?: boolean } = {}) {
  ctx.font = `${bold ? "700 " : ""}${size}px ${family}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = center ? "center" : "left";
  ctx.fillStyle = color;
  if (bold) {
    ctx.strokeStyle = color;
    ctx.lineWidth = size * 0.024;
    ctx.strokeText(text, x, y);
  }
  ctx.fillText(text, x, y);
  return ctx.measureText(text).width;
}

function portrait(ctx: Context, art: Image, x: number, y: number, size: number) {
  const scale = size / Math.max(art.width, art.height);
  const w = art.width * scale;
  const h = art.height * scale;
  ctx.drawImage(art, x + (size - w) / 2, y + (size - h) / 2, w, h);
}

function drawItem(ctx: Context, item: PoolItem, star: 4 | 5, art: Image | undefined, x: number, y: number, size: number, theme: Theme) {
  ctx.save();
  round(ctx, x, y, size, size + 10, [5, 5, 12, 0]);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.35)";
  ctx.lineWidth = 0.7;
  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = 3;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.clip();
  const bg = theme.stars[item.star ?? star];
  for (let h = 0; h < size + 10; h += bg.height) {
    for (let w = 0; w < size; w += bg.width) ctx.drawImage(bg, x + w, y + h);
  }
  if (art) portrait(ctx, art, x, y, size);
  ctx.restore();

  round(ctx, x, y + size, size, 20, 3);
  ctx.fillStyle = "white";
  ctx.fill();
  ctx.save();
  ctx.clip();
  const label = itemName(item);
  ctx.font = `13px ${theme.fontFamily}`;
  let visible = label;
  if (ctx.measureText(label).width > size - 4) {
    const characters = [...label];
    while (characters.length && ctx.measureText(characters.join("") + "…").width > size - 4) characters.pop();
    visible = characters.join("") + "…";
  }
  text(ctx, visible, x + size / 2, y + size + 10, theme.fontFamily, 13, "black", { center: true });
  ctx.restore();
}

function drawPool(ctx: Context, pool: Pool, y: number, theme: Theme, arts: ReadonlyMap<string, Image>) {
  const { caption, height } = sizePool(pool);
  ctx.save();
  round(ctx, panelX, y, panelWidth, height, 10);
  ctx.strokeStyle = "rgba(204, 204, 204, 0.5)";
  ctx.lineWidth = 0.8;
  ctx.shadowColor = "rgba(50, 50, 50, 0.8)";
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;
  ctx.shadowBlur = 4;
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.clip();
  const textureWidth = theme.texture.width * height / theme.texture.height;
  for (let x = 0; x < panelWidth; x += textureWidth) {
    ctx.drawImage(theme.texture, panelX + x, y, textureWidth, height);
  }
  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.fillRect(panelX, y, panelWidth, caption);
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  ctx.fillRect(panelX, y + caption, panelWidth, height - caption);
  ctx.fillStyle = "rgba(255, 255, 255, 0.32)";
  ctx.fillRect(panelX, y + caption - 0.3, panelWidth, 0.6);

  const name = [pool.version, pool.half].filter(Boolean).join(" ");
  const nameWidth = text(ctx, name, panelX + 20, y + 21, theme.fontFamily, 20, gold, { bold: true });
  let dateX = panelX + 20 + nameWidth + 12;
  if (pool.isMix) {
    const mixX = dateX - 6;
    round(ctx, mixX, y + 14, 30, 17, 3);
    ctx.fillStyle = "#ffeb73";
    ctx.fill();
    text(ctx, "mix", mixX + 15, y + 22.5, theme.fontFamily, 12, "#6f4b00", { center: true });
    dateX += 36;
  }
  if (pool.from || pool.to) text(ctx, `${pool.from || "未知"} - ${pool.to || "未知"}`, dateX, y + 24, theme.fontFamily, 12, "#aaa");

  let top = y + caption + 6;
  for (const [index, group] of pool.groups.entries()) {
    top += (index ? 4 : 0) + 3;
    for (const row of group.rows) {
      const size = rowTileWidth(row);
      for (const [column, item] of row.entries()) {
        const x = panelX + 14 + column * (size + 8);
        drawItem(ctx, item, group.star, item.img ? arts.get(item.img) : undefined, x, top + 4, size, theme);
      }
      top += size + 28;
    }
    top += 3;
  }
  ctx.restore();
}

export async function renderGachaPoolCard(model: GachaPoolCardModel, { themeDirectory, mode = "auto" }: {
  readonly themeDirectory: string;
  readonly mode?: "auto" | "gpu" | "cpu";
}) {
  const root = await realpath(themeDirectory).catch(() => undefined);
  if (!root) throw new Error("旧卡池主题目录不可用。");
  if (!model.pools.length || model.pools.some(pool => pool.groups.some(group => group.rows.some(row => row.length > 8)))) {
    throw new Error("卡池图卡数据无效。");
  }
  const theme = await readCardsTheme(root, model.game);
  const paths = new Set(model.pools.flatMap(pool => pool.groups.flatMap(group => group.rows.flatMap(row => row.map(item => item.img))))
    .filter((path): path is string => !!path && /^\/?meta-(gs|sr)\/(?:character|weapon)\/.+\.(?:webp|png|jpe?g)$/iu
      .exec(path)?.[1]?.toLowerCase() === model.game));
  const arts = new Map<string, Image>();
  for (const path of paths) {
    const image = await readImage(root, path);
    if (image) arts.set(path, image);
  }

  const poolTop = 25 + (model.reprint ? 38 : 0);
  const poolHeight = model.pools.reduce((height, pool, index) => height + sizePool(pool).height + (index ? 5 : 0), 0);
  const footerY = poolTop + poolHeight + 10;
  const height = footerY + 37;
  const scale = 4;
  return renderPng(Math.round(width * scale), Math.round(height * scale), ctx => {
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const ratio = Math.max(width / theme.background.width, height / theme.background.height);
    ctx.drawImage(theme.background, 0, 0, theme.background.width * ratio, theme.background.height * ratio);
    if (model.reprint) text(ctx, model.reprint.text, 35, 37, theme.fontFamily, 16, model.reprint.up ? "#3ddc84" : "#ff5a5a", { bold: true });
    let y = poolTop;
    for (const pool of model.pools) {
      drawPool(ctx, pool, y, theme, arts);
      y += sizePool(pool).height + 5;
    }
    ctx.shadowColor = "black";
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    ctx.shadowBlur = 1;
    text(ctx, "Created By Lotus-Yunzai", 375, footerY + 8.5, theme.fontFamily, 14, "white", { center: true });
  }, mode, { allowHalfScale: scale === 4 });
}
