import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { renderPng } from "@lotus-yunzai/skia";
import { FontLibrary, loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { starRailGachaThemeDirectory } from "./gacha-detail-source.ts";
import type { StarRailGachaVersionModel } from "./gacha-version.ts";

interface VersionCardOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
  readonly themeDirectory?: string;
}

type Group = StarRailGachaVersionModel["gacha"]["versionData"][number];

const width = 740;
const margin = 15;
const panelWidth = width - 2 * margin;
const gold = "#d3bc8e";
const ink = "#414e64";
const white = "#fff";
const muted = "#aaa";
const family = '"StarRailVersionNumber", "StarRailVersionHan", sans-serif';
const bannerStats = [
  ["totalNum", "抽卡总数"], ["star5Num", "金卡"], ["c5UpNum", "UP角色"], ["w5UpNum", "UP武器"],
  ["star4Num", "紫卡"], ["avgUpNum", "平均UP抽"],
] as const;
const groupStats = [
  ["totalNum", "总抽卡"], ["star5Num", "金卡"], ["upNum", "UP金卡"], ["c4Num", "紫角色"], ["w4Num", "紫武器"],
] as const;

async function assetPath(root: string, path: string) {
  const local = path.replace(/^\//u, "");
  if (!local.split("/").every((part) => part && part !== "." && part !== ".." && !/[\\\0]/u.test(part))) return;
  const resolved = await realpath(join(root, local)).catch(() => undefined);
  return resolved?.startsWith(root + sep) ? resolved : undefined;
}

async function readImage(root: string, path: string) {
  const name = await assetPath(root, path);
  if (!name) return;
  try {
    const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (info.isFile() && info.size <= 8 * 1024 * 1024) return await loadImage(await handle.readFile());
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function readTheme(root: string) {
  const fonts = [
    ["StarRailVersionNumber", "tttgbnumber.ttf"], ["StarRailVersionHan", "HYWH-65W.ttf"],
  ] as const;
  for (const [name, file] of fonts) {
    const path = await assetPath(root, `common/font/${file}`);
    if (!path) throw new Error("星铁版本统计的原主题字体不可用。");
    try {
      FontLibrary.use(name, [path]);
    } catch {
      throw new Error("星铁版本统计的原主题字体不可用。");
    }
  }

  const [background, banner, face, four, five] = await Promise.all([
    "common/bg/bg-sr.webp", "meta-sr/character/common/imgs/banner.webp",
    "meta-sr/character/卡芙卡/imgs/face.webp", "common/item/bg4.png", "common/item/bg5.png",
  ].map((path) => readImage(root, path)));
  if (!background || !banner || !face || !five) throw new Error("星铁版本统计的原主题图片不可用。");
  return { background, banner, face, four, five };
}

const themes = new Map<string, ReturnType<typeof readTheme>>();

function themeAt(root: string) {
  let theme = themes.get(root);
  if (!theme) {
    theme = readTheme(root).catch((error: unknown) => {
      themes.delete(root);
      throw error;
    });
    themes.set(root, theme);
  }
  return theme;
}

type Theme = Awaited<ReturnType<typeof readTheme>>;

function shape(ctx: Context, x: number, y: number, w: number, h: number, corners: number | number[]) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, corners);
}

function rect(ctx: Context, x: number, y: number, w: number, h: number, corners: number | number[], color: string) {
  shape(ctx, x, y, w, h, corners);
  ctx.fillStyle = color;
  ctx.fill();
}

function text(ctx: Context, value: string | number, x: number, y: number, size = 16, color = white,
  align: CanvasTextAlign = "left", maxWidth?: number, weight = false) {
  ctx.font = `${weight ? "700 " : ""}${size}px ${family}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = align;
  ctx.fillStyle = color;
  if (weight) {
    ctx.strokeStyle = color;
    ctx.lineWidth = size * 0.022;
    ctx.strokeText(String(value), x, y, maxWidth);
  }
  ctx.fillText(String(value), x, y, maxWidth);
}

function richLine(ctx: Context, parts: readonly (readonly [string, string])[], x: number, y: number, size: number, weight = false) {
  ctx.font = `${weight ? "700 " : ""}${size}px ${family}`;
  const widths = parts.map(([value]) => ctx.measureText(value).width);
  let left = x - widths.reduce((sum, value) => sum + value, 0) / 2;
  for (const [index, [value, color]] of parts.entries()) {
    text(ctx, value, left, y, size, color, "left", undefined, weight);
    left += widths[index]!;
  }
}

function drawBanner(ctx: Context, model: StarRailGachaVersionModel, theme: Theme, assets: ReadonlyMap<string, Image>) {
  const hero = (model.face.banner && assets.get(model.face.banner)) || theme.banner;
  const icon = (model.face.face && assets.get(model.face.face)) || theme.face;
  ctx.save();
  shape(ctx, margin, 25, panelWidth, 90, 50);
  ctx.clip();
  ctx.fillStyle = "#f0ece4";
  ctx.fillRect(margin, 25, panelWidth, 90);
  const bannerWidth = hero.width * 90 / hero.height;
  ctx.drawImage(hero, margin + panelWidth - bannerWidth, 25, bannerWidth, 90);
  ctx.restore();

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.55)";
  ctx.shadowBlur = 5;
  rect(ctx, 26, 36, 70, 70, 35, white);
  ctx.restore();
  ctx.save();
  shape(ctx, 29, 39, 64, 64, 32);
  ctx.clip();
  ctx.drawImage(theme.five, 29, 39, 64, 64);
  ctx.drawImage(icon, 29, 39, icon.width * 64 / icon.height, 64);
  ctx.restore();

  const gauges = bannerStats.flatMap(([key, label]) => model.gacha.totalStat[key]
    ? [{ label, value: model.gacha.totalStat[key] }] : []).map((stat, index, rows) => ({
    ...stat, width: index === 0 || index === rows.length - 1 ? 80 : 75,
    offset: (index === 0 ? 5 : 0) - (index === rows.length - 1 ? 5 : 0),
  }));
  const bandWidth = gauges.reduce((sum, stat) => sum + stat.width, 0);
  let left = 709 - bandWidth;
  const nameWidth = Math.max(60, left - 122);
  ctx.save();
  ctx.shadowColor = "#f0ece4";
  ctx.shadowBlur = 3;
  text(ctx, model.face.name, 111, 58, 24, ink, "left", nameWidth, true);
  text(ctx, `#${model.uid}`, 111, 86, 16, ink, "left", nameWidth);
  ctx.restore();
  if (!gauges.length) return;
  ctx.save();
  shape(ctx, left, 41, bandWidth, 58, 29);
  ctx.clip();
  for (const [index, stat] of gauges.entries()) {
    ctx.fillStyle = index % 2 ? "rgba(220,220,220,.50)" : "rgba(255,255,255,.65)";
    ctx.fillRect(left, 41, stat.width, 58);
    const x = left + stat.width / 2 + stat.offset;
    text(ctx, stat.value, x, 61, 22, "#1e1f20", "center", stat.width - 10, true);
    text(ctx, stat.label, x, 82.5, 14, ink, "center");
    left += stat.width;
  }
  ctx.restore();
}

function drawPageHead(ctx: Context, model: StarRailGachaVersionModel, page: NonNullable<StarRailGachaVersionModel["pageInfo"]>) {
  rect(ctx, margin, 25, panelWidth, 45, 30, "rgba(0,0,0,.50)");
  const mid = `#${model.uid} · ${model.poolName}统计`;
  const marker = `第 ${page.page}/${page.total} 张`;
  ctx.font = `700 20px ${family}`;
  const nameWidth = Math.min(ctx.measureText(model.face.name).width, 235);
  ctx.font = `16px ${family}`;
  const free = panelWidth - 40 - nameWidth - ctx.measureText(mid).width - ctx.measureText(marker).width;
  text(ctx, model.face.name, 35, 47, 20, white, "left", nameWidth || 235, true);
  text(ctx, mid, 35 + nameWidth + Math.max(0, free / 2), 47, 16, "#ddd");
  text(ctx, marker, 705, 47, 16, "#ffd484", "right");
}

function cardRows(group: Group) {
  return Math.ceil(group.items.length / 7);
}

function drawGroup(ctx: Context, group: Group, model: StarRailGachaVersionModel, theme: Theme,
  images: ReadonlyMap<string, Image>, y: number) {
  const h = 66 + cardRows(group) * 122;
  const dated = !!group.from && !!group.to;
  const titleWidth = dated ? 231 : 131;

  ctx.save();
  ctx.shadowColor = "rgba(50,50,50,.80)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;
  rect(ctx, margin, y, panelWidth, h, 10, "rgba(0,0,0,.50)");
  ctx.restore();
  ctx.save();
  shape(ctx, margin, y, panelWidth, h, 10);
  ctx.clip();
  ctx.fillStyle = "rgba(0,0,0,.20)";
  ctx.fillRect(margin, y, panelWidth, 56);
  ctx.fillStyle = "rgba(0,0,0,.80)";
  ctx.fillRect(margin, y, titleWidth, 56);
  ctx.fillStyle = "rgba(255,255,255,.30)";
  ctx.fillRect(margin + titleWidth - 1, y, 1, 56);
  ctx.fillStyle = "rgba(255,255,255,.10)";
  ctx.fillRect(margin, y + 56, panelWidth, 0.7);

  if (dated) {
    text(ctx, `${group.version} ${group.half}`, 105, y + 28, 20, gold, "right", 88, true);
    ctx.fillStyle = gold;
    ctx.fillRect(112, y + 22, 1, 15);
    text(ctx, group.name, 120, y + 21, 16, gold, "left", 122);
    text(ctx, `${group.from}~${group.to}`, 120, y + 39, 12, "#888", "left", 122);
  } else {
    text(ctx, group.version, 80, y + 28, 20, gold, "center", 122, true);
  }

  const values = groupStats.flatMap(([name, label]) => {
    const value = group.stats[name];
    if (!value) return [];
    if (name !== "totalNum") return [{ value, label }];
    if (group.unassigned) return [{ value, label: "收录抽数" }];
    return [{ value, label: dated && model.gacha.totalStat.unassignedDraws ? "可确认抽数" : label }];
  });
  let left = margin + titleWidth + 20;
  for (const [index, { label, value }] of values.entries()) {
    ctx.font = `12px ${family}`;
    const statWidth = Math.max(60, ctx.measureText(label).width + 30);
    const center = left + 10 + (statWidth - 30) / 2;
    text(ctx, value, center, y + 22.5, 22, "#ffde9d", "center");
    text(ctx, label, center, y + 42, 12, "#888", "center");
    if (index < values.length - 1) {
      ctx.fillStyle = gold;
      ctx.fillRect(left + statWidth - 7, y + 22, 1, 15);
    }
    left += statWidth;
  }

  for (const [index, row] of group.items.entries()) {
    const x = 27 + index % 7 * 98;
    const top = y + 65 + Math.floor(index / 7) * 122;
    const item = model.gacha.itemMap[row.id];
    const image = item?.img && images.get(item.img);
    ctx.save();
    ctx.shadowBlur = row.isUp ? 8 : 0;
    ctx.shadowColor = "#ffeb73";
    rect(ctx, x - 0.7, top - 0.7, 91.4, 115.4, 7, row.isUp ? "#fff100" : white);
    ctx.restore();
    rect(ctx, x, top, 90, 114, 6, white);
    ctx.save();
    shape(ctx, x, top, 90, 90, [6, 6, 10, 0]);
    ctx.clip();
    const star = row.star >= 5 ? theme.five : theme.four;
    if (star) ctx.drawImage(star, x, top);
    if (image) {
      const zoom = 90 / Math.max(image.width, image.height);
      const w = image.width * zoom;
      const h = image.height * zoom;
      ctx.drawImage(image, x + (90 - w) / 2, top + (90 - h) / 2, w, h);
    }
    ctx.font = `16px ${family}`;
    const badgeWidth = Math.max(20, ctx.measureText(String(row.num)).width + 12);
    rect(ctx, x + 90 - badgeWidth, top + 68, badgeWidth, 22, [10, 0, 0, 0], row.isUp ? "#ffeb73" : "#333");
    text(ctx, row.num, x + 90 - badgeWidth / 2, top + 79, 16, row.isUp ? "#6f4b00" : white, "center");
    ctx.restore();
    const name = item?.name || "未知";
    text(ctx, name.length > 4 ? item?.abbr || name : name, x + 45, top + 102, 14, row.isUp ? "#6f4b00" : "#000", "center", 85);
  }
  ctx.restore();
  shape(ctx, margin, y, panelWidth, h, 10);
  ctx.strokeStyle = "rgba(204,204,204,.30)";
  ctx.lineWidth = 0.7;
  ctx.stroke();
}

function drawNotice(ctx: Context) {
  const light = "rgba(255,255,255,.90)";
  richLine(ctx, [
    ["*角色统计/*武器统计", gold], [" 角色/武器池统计，  ", light],
    ["*常驻统计", gold], [" 常驻池统计，  ", light],
    ["*全部统计", gold], [" 全部抽卡统计，  ", light],
    ["*抽卡帮助", gold], [" 获取帮助", light],
  ], width / 2, 128, 13);
}

function unassignedNotice(model: StarRailGachaVersionModel) {
  const { unassignedDraws, totalNum } = model.gacha.totalStat;
  return unassignedDraws > 0
    ? `累计 ${totalNum} 抽 · 分期可确认 ${totalNum - unassignedDraws} 抽 · ${unassignedDraws} 抽未能归至期次`
    : "";
}

function pagingNote(model: StarRailGachaVersionModel) {
  const { pageInfo, gacha, poolName } = model;
  if (pageInfo) return `第 ${pageInfo.page}/${pageInfo.total} 张 · 第 ${pageInfo.from}~${pageInfo.to} 期，共 ${pageInfo.count} 期卡池`;
  return gacha.hiddenNum
    ? `仅显示最近 ${gacha.shownNum} 期卡池，更早的 ${gacha.hiddenNum} 期未显示（顶部统计包含全部数据），发送 *${poolName}全部统计 查看全部`
    : "";
}

export async function renderStarRailGachaVersion(
  model: StarRailGachaVersionModel,
  { mode = "auto", scale = 1.4, themeDirectory = starRailGachaThemeDirectory() }: VersionCardOptions = {},
) {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("版本统计缩放比例须在 1 至 4 之间。");
  const laterPage = model.pageInfo && model.pageInfo.page > 1 ? model.pageInfo : undefined;
  const note = laterPage ? "" : unassignedNotice(model);
  const paging = pagingNote(model);
  const groups = model.gacha.versionData;
  const top = laterPage ? 80 : note ? 162 : 146;
  const bottom = top + groups.reduce((sum, group) => sum + 76 + cardRows(group) * 122, 0);
  const footer = bottom + (paging ? 38 : 0);
  const height = footer + 37;
  if (height > 24_000) throw new RangeError("星铁版本统计超出可渲染高度。");
  const root = await realpath(themeDirectory).catch(() => undefined);
  if (!root) throw new Error("星铁版本统计的原主题目录不可用。");
  const theme = await themeAt(root);
  const paths = new Set([
    model.face.face, model.face.banner,
    ...groups.flatMap(({ items }) => items.map(({ id }) => model.gacha.itemMap[id]?.img)),
  ].filter((path): path is string => !!path && /^\/?meta-sr\/(?:character|weapon)\/.+\.(?:png|webp|jpe?g)$/iu.test(path)));
  const images = new Map<string, Image>();
  for (const path of paths) {
    const image = await readImage(root, path);
    if (image) images.set(path, image);
  }
  const zoom = Math.min(scale, 24_000 / height);
  return renderPng(Math.round(width * zoom), Math.round(height * zoom), (ctx) => {
    ctx.scale(zoom, zoom);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const bg = Math.max(width / theme.background.width, height / theme.background.height);
    ctx.drawImage(theme.background, 0, 0, theme.background.width * bg, theme.background.height * bg);

    if (laterPage) drawPageHead(ctx, model, laterPage);
    else {
      drawBanner(ctx, model, theme, images);
      drawNotice(ctx);
      if (note) text(ctx, note, width / 2, 144, 13, gold, "center", panelWidth - 16);
    }
    let y = top;
    for (const group of groups) {
      drawGroup(ctx, group, model, theme, images, y);
      y += 76 + cardRows(group) * 122;
    }
    if (paging) text(ctx, paging, width / 2, bottom + 16, 13, muted, "center", panelWidth - 16);
    ctx.save();
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 1;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    richLine(ctx, [
      ["Yunzai-Fork", "#ffd700"], [" & ", white], ["Miao-Plugin-Fork", "#ffd700"], [" By ", white], ["Lotus", "#90ee90"],
    ], 375, footer + 8.5, 14, true);
    ctx.restore();
  }, mode);
}
