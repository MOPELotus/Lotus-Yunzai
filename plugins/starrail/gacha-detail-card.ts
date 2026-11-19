import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { renderPng } from "@lotus-yunzai/skia";
import { Canvas, FontLibrary, loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { starRailGachaThemeDirectory } from "./gacha-detail-source.ts";
import type { StarRailGachaDetailModel } from "./gacha-detail.ts";

interface GachaDetailOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
  readonly themeDirectory?: string;
}

const width = 740;
const frame = 15;
const inner = width - 2 * frame;
const ink = "#414e64";
const gold = "#d3bc8e";
const white = "#fff";
const muted = "#aaa";
const bodyFont = '"StarRailGachaNumber", "StarRailGachaHan", sans-serif';
const titleFont = '"StarRailGachaNumber", "StarRailGachaTitle", "StarRailGachaHan", sans-serif';
const miaoAssets = {
  background: "common/bg/bg-sr.webp",
  face: "meta-sr/character/卡芙卡/imgs/face.webp",
  banner: "meta-sr/character/common/imgs/banner.webp",
  sprite: "gacha/imgs/date-icon.webp",
  star: "common/item/bg5.png",
  empty: "gacha/imgs/no-avatar.webp",
} as const;
const statLabels = [
  ["allNum", "抽卡总数"], ["fiveNum", "金卡数"], ["wai", "歪 T.T"],
  ["fourNum", "紫卡数"], ["fiveAvg", "平均出金"], ["upYs", "UP星琼"],
] as const;

async function themePath(root: string, path: string): Promise<string | undefined> {
  const local = path.replace(/^\//u, "");
  if (!local.split("/").every((part) => part && part !== "." && part !== ".." && !/[\\\0]/u.test(part))) return;
  const resolved = await realpath(join(root, local)).catch(() => undefined);
  return resolved?.startsWith(root + sep) ? resolved : undefined;
}

async function themeImage(root: string, path: string): Promise<Image | undefined> {
  const local = await themePath(root, path);
  if (!local) return;
  try {
    const file = await open(local, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return;
      return await loadImage(await file.readFile());
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

const sharedThemes = new Map<string, ReturnType<typeof loadTheme>>();

async function loadTheme(root: string) {
  const fonts = [
    ["StarRailGachaHan", "HYWH-65W.ttf"], ["StarRailGachaTitle", "NZBZ.ttf"], ["StarRailGachaNumber", "tttgbnumber.ttf"],
  ] as const;
  for (const [family, filename] of fonts) {
    const asset = await themePath(root, `common/font/${filename}`);
    if (!asset) throw new Error("星铁抽卡记录的原主题字体不可用。");
    try {
      FontLibrary.use(family, [asset]);
    } catch {
      throw new Error("星铁抽卡记录的原主题字体不可用。");
    }
  }

  const [background, face, banner, sprite, star, empty] = await Promise.all(
    Object.values(miaoAssets).map((path) => themeImage(root, path)),
  );
  if (!background || !face || !banner || !sprite || !star || !empty) {
    throw new Error("星铁抽卡记录的原主题图片不可用。");
  }
  return { background, face, banner, sprite, star, empty };
}

function originalTheme(root: string) {
  let theme = sharedThemes.get(root);
  if (!theme) {
    theme = loadTheme(root).catch((error: unknown) => {
      sharedThemes.delete(root);
      throw error;
    });
    sharedThemes.set(root, theme);
  }
  return theme;
}

type Theme = Awaited<ReturnType<typeof loadTheme>>;

function round(ctx: Context, x: number, y: number, w: number, h: number, radius: number | number[]) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
}

function panel(ctx: Context, x: number, y: number, w: number, h: number, radius: number | number[], fill: string) {
  round(ctx, x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
}

interface TextStyle {
  readonly color?: string;
  readonly size?: number;
  readonly bold?: boolean;
  readonly title?: boolean;
}

function font({ size = 16, bold = false, title = false }: TextStyle) {
  return `${bold ? "700 " : ""}${size}px ${title ? titleFont : bodyFont}`;
}

function paint(ctx: Context, value: string | number, x: number, y: number, style: TextStyle = {},
  align: CanvasTextAlign = "left", maxWidth?: number) {
  ctx.font = font(style);
  ctx.textBaseline = "middle";
  ctx.textAlign = align;
  ctx.fillStyle = style.color ?? white;
  if (style.bold) {
    // The original web fonts ship regular faces and Chromium synthesizes their heavy weight.
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = (style.size ?? 16) * 0.022;
    if (maxWidth === undefined) ctx.strokeText(String(value), x, y);
    else ctx.strokeText(String(value), x, y, maxWidth);
  }
  if (maxWidth === undefined) ctx.fillText(String(value), x, y);
  else ctx.fillText(String(value), x, y, maxWidth);
}

interface Inline extends TextStyle {
  readonly value: string;
  readonly margin?: number;
}

function inline(ctx: Context, parts: readonly Inline[], x: number, y: number, centered = false) {
  const lengths = parts.map((part) => {
    ctx.font = font(part);
    return ctx.measureText(part.value).width + (part.margin ?? 0);
  });
  let left = centered ? x - lengths.reduce((sum, length) => sum + length, 0) / 2 : x;
  for (const [index, part] of parts.entries()) {
    paint(ctx, part.value, left + (part.margin ?? 0), y - ((part.size ?? 16) - 16) * 0.15, part);
    left += lengths[index]!;
  }
}

function paintBanner(ctx: Context, model: StarRailGachaDetailModel, theme: Theme, face: Image, banner: Image) {
  const y = 25;
  ctx.save();
  round(ctx, frame, y, inner, 90, 50);
  ctx.clip();
  ctx.fillStyle = "#f0ece4";
  ctx.fillRect(frame, y, inner, 90);
  const bannerWidth = banner.width * 90 / banner.height;
  ctx.drawImage(banner, frame + inner - bannerWidth, y, bannerWidth, 90);
  ctx.restore();

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.55)";
  ctx.shadowBlur = 5;
  panel(ctx, 26, 36, 70, 70, 35, white);
  ctx.restore();
  ctx.save();
  round(ctx, 29, 39, 64, 64, 32);
  ctx.clip();
  ctx.drawImage(theme.star, 29, 39, 64, 64);
  ctx.drawImage(face, 29, 39, face.width * 64 / face.height, 64);
  ctx.restore();

  const stats = statLabels.flatMap(([key, title]) => model.gacha.stat[key] ? [{ title, value: model.gacha.stat[key] }] : []);
  const right = frame + inner - 16;
  let statWidth = 0;
  const gauges = stats.map(({ title, value }, index) => {
    const first = index === 0;
    const last = index === stats.length - 1;
    const total = first || last ? 80 : 75;
    statWidth += total;
    return { title, value, total, offset: (first ? 5 : 0) - (last ? 5 : 0) };
  });
  const nameWidth = Math.max(80, right - statWidth - 122);
  ctx.save();
  ctx.shadowColor = "#f0ece4";
  ctx.shadowBlur = 3;
  paint(ctx, model.face.name, 111, 58, { color: ink, size: 24, bold: true }, "left", nameWidth);
  paint(ctx, `#${model.uid}`, 111, 86, { color: ink, size: 16 }, "left", nameWidth);
  ctx.restore();
  if (!stats.length) return;

  let left = right - statWidth;
  ctx.save();
  round(ctx, left, 41, statWidth, 58, 29);
  ctx.clip();
  for (const [index, item] of gauges.entries()) {
    ctx.fillStyle = index % 2 ? "rgba(220,220,220,.50)" : "rgba(255,255,255,.65)";
    ctx.fillRect(left, 41, item.total, 58);
    const x = left + item.total / 2 + item.offset;
    paint(ctx, item.value, x, 61, { color: "#1e1f20", size: 22, bold: true }, "center", item.total - 15);
    paint(ctx, item.title, x, 82.5, { color: ink, size: 14 }, "center");
    left += item.total;
  }
  ctx.restore();
}

type Luck = NonNullable<StarRailGachaDetailModel["gacha"]["luck"]>;

function luckTips(luck: Luck) {
  return [
    ...(luck.fewSample ? ["样本较少，仅供参考"] : []),
    ...(luck.hasNewPool ? ["最新卡池数据暂未收录，新卡池中的UP判定可能不准，待卡池数据更新后即可恢复"] : []),
  ];
}

function paintLuck(ctx: Context, luck: Luck, tips: readonly string[], y: number, h: number) {
  const color = /^#[\da-f]{6}$/iu.test(luck.color) ? luck.color : "#e4c46a";
  const contentHeight = (luck.isUpPool ? 85 : 69) + tips.length * 21;
  const detailTop = y + (h - contentHeight) / 2;
  ctx.save();
  round(ctx, frame, y, inner, h, 12);
  ctx.clip();
  ctx.fillStyle = "rgba(0,0,0,.50)";
  ctx.fillRect(frame, y, inner, h);
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.fillRect(frame, y, 170, h);
  ctx.fillStyle = color;
  ctx.fillRect(182, y, 3, h);
  paint(ctx, "欧皇度", 98.5, y + 20, { size: 13, color: "#bbb" }, "center");
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.8)";
  ctx.shadowBlur = 6;
  paint(ctx, luck.title, 98.5, y + 51, { size: 34, title: true, color }, "center", 147);
  ctx.restore();
  inline(ctx, [
    { value: "运气超过 ", size: 12, color: "#ccc" },
    { value: `${luck.percent}%`, size: 12, bold: true, color },
    { value: " 的开拓者", size: 12, color: "#ccc" },
  ], 98.5, y + 81, true);

  const headline = luck.isUpPool ? [
    { value: "UP平均 ", size: 15, color: "#ddd" },
    { value: String(luck.upAvg), size: 20, bold: true, color },
    { value: " 抽", size: 15, color: "#ddd" },
    { value: `期望 ${luck.upExpect} 抽（含歪）`, size: 13, color: muted, margin: 8 },
  ] : [
    { value: "平均出金 ", size: 15, color: "#ddd" },
    { value: String(luck.fiveAvg), size: 20, bold: true, color },
    { value: " 抽", size: 15, color: "#ddd" },
    { value: `期望 ${luck.fiveExpect} 抽`, size: 13, color: muted, margin: 8 },
  ];
  inline(ctx, headline, 200, detailTop + 13);
  const cells: readonly (readonly [string | number, string, string?])[] = luck.isUpPool ? [
    [luck.fiveAvg, `平均出金 · 期望${luck.fiveExpect}`, `超过${luck.fivePercent}%`],
    ...(luck.smallNum > 0 ? [[`${luck.noWaiRate}%`, `小保底不歪 ${luck.smallWin}/${luck.smallNum} · 期望${luck.upRate}%`, `超过${luck.winPercent}%`] as const] : []),
    [luck.bigNum, "大保底"], [luck.maxUpStreak, "最多连UP"], [luck.maxWaiStreak, "最多连歪"],
  ] : [[luck.desc, `${Number(luck.fiveAvg) <= Number(luck.fiveExpect) ? "出金快于" : "出金慢于"}理论期望`]];
  ctx.font = font({ size: 12 });
  const widths = cells.map(([, label]) => ctx.measureText(String(label)).width + 8);
  const extra = (510 - widths.reduce((sum, value) => sum + value, 0)) / cells.length;
  let left = 200;
  for (const [index, [value, label, detail]] of cells.entries()) {
    const w = widths[index]! + extra;
    const x = left + w / 2;
    paint(ctx, String(value), x, detailTop + 42.5, { size: 18, bold: true }, "center", w - 8);
    paint(ctx, String(label), x, detailTop + 61, { size: 12, color: muted }, "center", w - 8);
    if (detail) paint(ctx, detail, x, detailTop + 77, { size: 12, color }, "center", w - 8);
    left += w;
  }
  for (const [index, tip] of tips.entries()) paint(ctx, tip, 200, detailTop + contentHeight - (tips.length - index) * 21 + 13, {
    size: 12, color: "#f0b37e",
  }, "left", 510);
  ctx.restore();
}

function paintNotice(ctx: Context, y: number) {
  const assets = [
    ["*抽卡帮助", gold], ["查看用法，", "rgba(255,255,255,.90)"],
    ["*更新抽卡记录", gold], ["更新抽卡信息，", "rgba(255,255,255,.90)"],
    ["*抽卡统计", gold], ["*角色统计", gold], ["可查看按卡池分析结果", "rgba(255,255,255,.90)"],
  ] as const;
  inline(ctx, assets.map(([value, color]) => ({ value, color, size: 13, margin: color === gold ? 4 : 0 })), width / 2, y, true);
}

function paintPageHead(ctx: Context, model: StarRailGachaDetailModel, page: NonNullable<StarRailGachaDetailModel["pageInfo"]>) {
  panel(ctx, frame, 25, inner, 44, 30, "rgba(0,0,0,.50)");
  const nameStyle = { size: 20, bold: true };
  const subtitle = `#${model.uid} · ${model.poolName}池抽卡记录`;
  const pageLabel = `第 ${page.page}/${page.total} 张`;
  ctx.font = font(nameStyle);
  const nameWidth = Math.min(ctx.measureText(model.face.name).width, 235);
  ctx.font = font({});
  const free = inner - 40 - nameWidth - ctx.measureText(subtitle).width - ctx.measureText(pageLabel).width;
  paint(ctx, model.face.name, 35, 47, nameStyle, "left", nameWidth || 235);
  paint(ctx, subtitle, 35 + nameWidth + Math.max(0, free / 2), 47, { color: "#ddd" });
  paint(ctx, pageLabel, 705, 47, { color: "#ffd484" }, "right");
}

type Row = StarRailGachaDetailModel["gacha"]["fiveLog"][number];

function hasDate(previous: Row | undefined, row: Row) {
  return !previous || previous.date !== row.date;
}

function paintRows(ctx: Context, model: StarRailGachaDetailModel, theme: Theme, portraits: ReadonlyMap<string, Image>,
  top: number, height: number, more: string) {
  ctx.save();
  ctx.shadowColor = "rgba(50,50,50,.80)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;
  panel(ctx, frame, top, inner, height, 10, "rgba(0,0,0,.10)");
  ctx.restore();
  ctx.save();
  round(ctx, frame, top, inner, height, 10);
  ctx.clip();
  let y = top;
  const isWeapon = model.poolName === "光锥";
  const cap = isWeapon ? 80 : 90;
  // The old flex row shrinks its date and progress columns to fit the wider light-cone name.
  const dateWidth = isWeapon ? 93.094 : 97;
  const iconX = isWeapon ? 223.203 : 202;
  const process = iconX + 32;
  const maxBarWidth = inner + frame - process - 15 - (isWeapon ? 0 : 1);
  const rows = model.gacha.fiveLog;
  for (const [index, row] of rows.entries()) {
    const showDate = hasDate(rows[index - 1], row);
    if (showDate) y += 5;
    ctx.fillStyle = "rgba(0,0,0,.40)";
    ctx.fillRect(frame, y, inner, 38);
    ctx.fillStyle = "rgba(0,0,0,.80)";
    ctx.fillRect(frame, y, dateWidth, 38);
    const spriteTop = index === 0 ? 0 : showDate ? 38 : 71.25;
    const ratio = theme.sprite.width / 23.75;
    ctx.drawImage(theme.sprite, 0, spriteTop * ratio, theme.sprite.width, 43 * ratio, 20, y, 23.75, 43);
    if (showDate) paint(ctx, row.date, 43.75, y + 19);

    const item = model.gacha.items[row.id];
    const pity = String(row.id) === "888";
    const portrait = pity ? theme.empty : item?.img ? portraits.get(item.img) : undefined;
    paint(ctx, pity ? "已抽" : item?.abbr || item?.name || "未知", iconX - 5, y + 19,
      { color: row.isUp ? "#ffd484" : muted }, "right", iconX - frame - dateWidth - 5);
    if (item?.star === 5 || pity) {
      ctx.save();
      round(ctx, iconX, y + 3, 32, 32, 5);
      ctx.clip();
      ctx.drawImage(theme.star, iconX, y + 3, 32, 32);
      ctx.restore();
    }
    if (portrait) {
      const w = portrait.width * 32 / portrait.height;
      ctx.drawImage(portrait, iconX + (32 - w) / 2, y + 3, w, 32);
    }

    const count = Math.max(0, row.count);
    const low = count <= 10;
    const good = !low && count < cap * 0.5;
    const color = low ? "#ffeb73" : good ? "#168b2c" : count < cap * 0.83 ? "#6939b7" : "#9d3333";
    const ink = low ? "#6f4b00" : white;
    const minimum = low ? 18 : good ? maxBarWidth * 0.13 : 0;
    const bar = Math.min(maxBarWidth, Math.max(minimum, count / cap * maxBarWidth));
    panel(ctx, process, y + 6, bar, 26, [0, 5, 5, 0], color);
    paint(ctx, count, process + 5, y + 19, { color: ink });
    if (row.isUp && !pity) {
      const badgeX = process + bar + (low ? 4 : -31);
      panel(ctx, badgeX, y + 9, 26, 18, 15, "#ffeb73");
      paint(ctx, "UP", badgeX + 13, y + 18, { color: "#6f4b00", size: 12, bold: true }, "center");
    }
    y += 38;
  }
  if (more) paint(ctx, more, width / 2, y + 16, { size: 13, color: muted }, "center", inner - 20);
  ctx.restore();
  round(ctx, frame, top, inner, height, 10);
  ctx.strokeStyle = "rgba(204,204,204,.30)";
  ctx.lineWidth = 0.7;
  ctx.stroke();
}

function pagingNote(model: StarRailGachaDetailModel) {
  const { pageInfo, gacha, poolName = "角色" } = model;
  if (pageInfo) return `第 ${pageInfo.page}/${pageInfo.total} 张 · 第 ${pageInfo.from}~${pageInfo.to} 条，共 ${pageInfo.count} 条五星记录`;
  return gacha.hiddenNum
    ? `仅显示最近 ${gacha.shownNum} 条记录，更早的 ${gacha.hiddenNum} 条未显示（顶部统计包含全部记录），发送 *${poolName}全部记录 查看全部`
    : "";
}

function portraitPath(path: string) {
  return /^\/?meta-sr\/(?:character|weapon)\/.+\.(?:png|webp|jpe?g)$/iu.test(path);
}

export async function renderStarRailGachaDetail(
  model: StarRailGachaDetailModel,
  { mode = "auto", scale = 1.4, themeDirectory = starRailGachaThemeDirectory() }: GachaDetailOptions = {},
) {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("抽卡记录缩放比例须在 1 至 4 之间。");
  const root = await realpath(themeDirectory).catch(() => undefined);
  if (!root) throw new Error("星铁抽卡记录的原主题目录不可用。");
  const theme = await originalTheme(root);
  const paths = new Set([
    model.face.face, model.face.banner,
    ...model.gacha.fiveLog.map(({ id }) => model.gacha.items[id]?.img),
  ].filter((path): path is string => !!path && portraitPath(path)));
  const images = new Map<string, Image>();
  for (const path of paths) {
    const image = await themeImage(root, path);
    if (image) images.set(path, image);
  }

  const face = (model.face.face && images.get(model.face.face)) || theme.face;
  const banner = (model.face.banner && images.get(model.face.banner)) || theme.banner;
  const laterPage = model.pageInfo && model.pageInfo.page > 1 ? model.pageInfo : undefined;
  const luck = laterPage ? undefined : model.gacha.luck;
  const tips = luck ? luckTips(luck) : [];
  const luckHeight = Math.max(101, (luck?.isUpPool ? 109 : 93) + tips.length * 21);
  const top = laterPage ? 80 : luck ? 156 + luckHeight : 146;
  const more = pagingNote(model);
  const rows = model.gacha.fiveLog;
  const rowsHeight = Math.max(16, rows.reduce((sum, row, index) => sum + 38 + (hasDate(rows[index - 1], row) ? 5 : 0), 0));
  const panelHeight = rowsHeight + (more ? 28 : 0);
  const bottom = top + panelHeight;
  const height = bottom + 47;
  if (height > 24_000) throw new RangeError("星铁抽卡记录超出可渲染高度。");
  const zoom = Math.min(scale, 24_000 / height);

  return renderPng(Math.round(width * zoom), Math.ceil(height * zoom), (ctx) => {
    ctx.scale(zoom, zoom);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const bgZoom = Math.max(width / theme.background.width, height / theme.background.height);
    ctx.drawImage(theme.background, 0, 0, theme.background.width * bgZoom, theme.background.height * bgZoom);
    if (laterPage) {
      paintPageHead(ctx, model, laterPage);
    } else {
      paintBanner(ctx, model, theme, face, banner);
      if (luck) paintLuck(ctx, luck, tips, 125, luckHeight);
      paintNotice(ctx, top - 18);
    }
    paintRows(ctx, model, theme, images, top, panelHeight, more);
    ctx.save();
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 1;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    inline(ctx, [
      { value: "Yunzai-Fork", color: "#ffd700", size: 14, bold: true },
      { value: " & ", size: 14 },
      { value: "Miao-Plugin-Fork", color: "#ffd700", size: 14, bold: true },
      { value: " By ", size: 14 },
      { value: "Lotus", color: "#90ee90", size: 14, bold: true },
    ], 375, bottom + 19, true);
    ctx.restore();
  }, mode);
}
