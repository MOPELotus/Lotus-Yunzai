import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { GachaLuck } from "@lotus-yunzai/gacha";
import { registerGachaThemeFont } from "./gacha-theme-fonts.ts";
import { renderPng } from "./index.ts";
import { loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";

export interface GachaDetailOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
  readonly themeDirectory: string;
}

const width = 740;
const frame = 15;
const inner = width - 2 * frame;
const ink = "#414e64";
const gold = "#d3bc8e";
const white = "#fff";
const muted = "#aaa";
const fontFamilies = new WeakMap<Context, { body: string; title: string }>();
const themeAssets = {
  sprite: "gacha/imgs/date-icon.webp",
  star: "common/item/bg5.png",
  empty: "gacha/imgs/no-avatar.webp",
} as const;
const statLabels = [
  ["allNum", "抽卡总数"], ["fiveNum", "金卡数"], ["wai", "歪 T.T"],
  ["fourNum", "紫卡数"], ["fiveAvg", "平均出金"],
] as const;

const games = {
  sr: {
    name: "星铁", background: "sr", face: "卡芙卡/imgs/face.webp", currency: "星琼", player: "开拓者", prefix: "*",
  },
  gs: {
    name: "原神", background: "hydro", face: "芭芭拉/imgs/face-q.webp", currency: "原石", player: "旅行者", prefix: "#",
  },
} as const;
type Game = keyof typeof games;

interface Row {
  readonly id: string | number;
  readonly date: string;
  readonly count: number;
  readonly countKnown?: false;
  readonly countAtLeast?: true;
  readonly isUp?: boolean;
}

type Stat = typeof statLabels[number][0] | "upYs";

interface GachaDetailModel {
  readonly uid: string;
  readonly recordArchive?: true;
  readonly face: { readonly name: string; readonly face?: string; readonly banner?: string };
  readonly poolName?: string;
  readonly gacha: {
    readonly stat: Readonly<Record<Stat, string | number>>;
    readonly items: Readonly<Record<string, { readonly name: string; readonly abbr: string; readonly img?: string; readonly star: number }>>;
    readonly fiveLog: readonly Row[];
    readonly luck?: GachaLuck;
    readonly shownNum?: number;
    readonly hiddenNum?: number;
    readonly unclassified?: number;
  };
  readonly pageInfo?: { readonly page: number; readonly total: number; readonly from: number; readonly to: number; readonly count: number };
}

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

async function loadTheme(root: string, game: Game) {
  const config = games[game];
  const fonts = [
    ["Han", "HYWH-65W.ttf"], ["Title", "NZBZ.ttf"], ["Number", "tttgbnumber.ttf"],
  ] as const;
  const aliases = {} as Record<typeof fonts[number][0], string>;
  for (const [family, filename] of fonts) {
    const asset = await themePath(root, `common/font/${filename}`);
    if (!asset) throw new Error(`${config.name}抽卡记录的原主题字体不可用。`);
    try {
      aliases[family] = registerGachaThemeFont(family, asset);
    } catch {
      throw new Error(`${config.name}抽卡记录的原主题字体不可用。`);
    }
  }

  const [background, face, banner, sprite, star, empty] = await Promise.all(
    [
      `common/bg/bg-${config.background}.webp`,
      `meta-${game}/character/${config.face}`,
      `meta-${game}/character/common/imgs/banner.webp`,
      themeAssets.sprite, themeAssets.star, themeAssets.empty,
    ].map((path) => themeImage(root, path)),
  );
  if (!background || !face || !banner || !sprite || !star || !empty) {
    throw new Error(`${config.name}抽卡记录的原主题图片不可用。`);
  }
  const { Number: number, Title: title, Han: han } = aliases;
  const families = { body: `${number}, ${han}, sans-serif`, title: `${number}, ${title}, ${han}, sans-serif` };
  return { background, face, banner, sprite, star, empty, families };
}

function originalTheme(root: string, game: Game) {
  const key = `${game}:${root}`;
  let theme = sharedThemes.get(key);
  if (!theme) {
    theme = loadTheme(root, game).catch((error: unknown) => {
      sharedThemes.delete(key);
      throw error;
    });
    sharedThemes.set(key, theme);
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

function font(ctx: Context, { size = 16, bold = false, title = false }: TextStyle) {
  const families = fontFamilies.get(ctx)!;
  return `${bold ? "700 " : ""}${size}px ${title ? families.title : families.body}`;
}

function paint(ctx: Context, value: string | number, x: number, y: number, style: TextStyle = {},
  align: CanvasTextAlign = "left", maxWidth?: number) {
  ctx.font = font(ctx, style);
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

function measure(ctx: Context, value: string, style: TextStyle) {
  ctx.font = font(ctx, style);
  return ctx.measureText(value).width;
}

function fittedText(ctx: Context, value: string, style: TextStyle, maxWidth: number) {
  if (measure(ctx, value, style) <= maxWidth) return value;
  let label = "";
  for (const character of value) {
    if (ctx.measureText(`${label}${character}…`).width > maxWidth) break;
    label += character;
  }
  return `${label}…`;
}

function paintFitted(ctx: Context, value: string, x: number, y: number, style: TextStyle & { size: number },
  minSize: number, maxWidth: number, align: CanvasTextAlign = "left") {
  const measured = measure(ctx, value, style);
  const size = measured > maxWidth ? Math.max(minSize, Math.floor(style.size * maxWidth / measured)) : style.size;
  const fittedStyle = { ...style, size };
  paint(ctx, fittedText(ctx, value, fittedStyle, maxWidth), x, y, fittedStyle, align, maxWidth);
}

interface Inline extends TextStyle {
  readonly value: string;
  readonly margin?: number;
}

function inline(ctx: Context, parts: readonly Inline[], x: number, y: number, centered = false) {
  const lengths = parts.map((part) => {
    ctx.font = font(ctx, part);
    return ctx.measureText(part.value).width + (part.margin ?? 0);
  });
  let left = centered ? x - lengths.reduce((sum, length) => sum + length, 0) / 2 : x;
  for (const [index, part] of parts.entries()) {
    paint(ctx, part.value, left + (part.margin ?? 0), y - ((part.size ?? 16) - 16) * 0.15, part);
    left += lengths[index]!;
  }
}

function paintBanner(ctx: Context, model: GachaDetailModel, theme: Theme, face: Image, banner: Image, game: Game) {
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

  const labels = [...statLabels, ["upYs", `UP${games[game].currency}`] as const];
  const stats = labels.flatMap(([key, title]) => model.gacha.stat[key] ? [{ title, value: model.gacha.stat[key] }] : []);
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
  const nameStyle = { color: ink, size: 24, bold: true };
  if (game === "gs" || model.recordArchive) paintFitted(ctx, model.face.name, 111, 58, nameStyle, 16, nameWidth);
  else paint(ctx, model.face.name, 111, 58, nameStyle, "left", nameWidth);
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

function luckTips(luck: GachaLuck) {
  return [
    ...(luck.fewSample ? ["样本较少，仅供参考"] : []),
    ...(luck.hasNewPool ? ["最新卡池数据暂未收录，新卡池中的UP判定可能不准，待卡池数据更新后即可恢复"] : []),
  ];
}

function paintLuck(ctx: Context, luck: GachaLuck, tips: readonly string[], y: number, h: number, game: Game) {
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
    { value: ` 的${games[game].player}`, size: 12, color: "#ccc" },
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
  ctx.font = font(ctx, { size: 12 });
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

function paintNotice(ctx: Context, y: number, game: Game, recordArchive?: true) {
  const prefix = games[game].prefix;
  const assets = recordArchive ? [
    ["本地逐抽档案 · ", "rgba(255,255,255,.90)"], ["*逐抽版本统计", gold], ["查看分期，", "rgba(255,255,255,.90)"],
    ["*逐抽全部记录", gold], ["查看六池", "rgba(255,255,255,.90)"],
  ] as const : [
    [`${prefix}抽卡帮助`, gold], ["查看用法，", "rgba(255,255,255,.90)"],
    [`${prefix}更新抽卡记录`, gold], ["更新抽卡信息，", "rgba(255,255,255,.90)"],
    [`${prefix}抽卡统计`, gold], [`${prefix}角色统计`, gold], ["可查看按卡池分析结果", "rgba(255,255,255,.90)"],
  ] as const;
  inline(ctx, assets.map(([value, color]) => ({ value, color, size: 13, margin: color === gold ? 4 : 0 })), width / 2, y, true);
}

function paintPageHead(ctx: Context, model: GachaDetailModel, page: NonNullable<GachaDetailModel["pageInfo"]>, game: Game) {
  panel(ctx, frame, 25, inner, 44, 30, "rgba(0,0,0,.50)");
  const nameStyle = { size: 20, bold: true };
  const subtitle = `#${model.uid} · ${model.poolName}池抽卡记录`;
  const pageLabel = `第 ${page.page}/${page.total} 张`;
  ctx.font = font(ctx, nameStyle);
  const nameWidth = Math.min(ctx.measureText(model.face.name).width, 235);
  ctx.font = font(ctx, {});
  const free = inner - 40 - nameWidth - ctx.measureText(subtitle).width - ctx.measureText(pageLabel).width;
  if (game === "gs" || model.recordArchive) paintFitted(ctx, model.face.name, 35, 47, nameStyle, 16, nameWidth || 235);
  else paint(ctx, model.face.name, 35, 47, nameStyle, "left", nameWidth || 235);
  paint(ctx, subtitle, 35 + nameWidth + Math.max(0, free / 2), 47, { color: "#ddd" });
  paint(ctx, pageLabel, 705, 47, { color: "#ffd484" }, "right");
}

function hasDate(previous: Row | undefined, row: Row) {
  return !previous || previous.date !== row.date;
}

function paintRows(ctx: Context, model: GachaDetailModel, theme: Theme, portraits: ReadonlyMap<string, Image>,
  top: number, height: number, more: string, game: Game) {
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
  const wideWeapon = game === "sr" && model.poolName === "光锥";
  const cap = wideWeapon || model.poolName === "武器" ? 80 : 90;
  // The old flex row shrinks its date and progress columns to fit the wider light-cone name.
  const dateWidth = wideWeapon ? 93.094 : 97;
  const iconX = wideWeapon ? 223.203 : 202;
  const process = iconX + 32;
  const maxBarWidth = inner + frame - process - 15 - (wideWeapon ? 0 : 1);
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
    const name = pity ? "已抽" : item?.abbr || item?.name || "未知";
    const nameWidth = iconX - frame - dateWidth - 5;
    const nameStyle = { color: row.isUp ? "#ffd484" : muted };
    if (game === "gs" || model.recordArchive) paintFitted(ctx, name, iconX - 5, y + 19, { ...nameStyle, size: 16 }, 12, nameWidth, "right");
    else paint(ctx, name, iconX - 5, y + 19, nameStyle, "right", nameWidth);
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
    if (row.countKnown === false) {
      paint(ctx, "—", process + 5, y + 19, { color: muted });
    } else {
      const tint = row.countAtLeast ? "rgba(204,204,204,.24)" : color;
      panel(ctx, process, y + 6, bar, 26, [0, 5, 5, 0], tint);
      paint(ctx, row.countAtLeast ? `≥${count}` : count, process + 5, y + 19, { color: row.countAtLeast ? white : ink });
    }
    if (row.isUp && !pity) {
      const badgeOffset = bar + (low ? 4 : -31);
      const badgeX = process + (row.countKnown === false ? 30 : row.countAtLeast ? Math.max(38, badgeOffset) : badgeOffset);
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

function pagingNote(model: GachaDetailModel, game: Game) {
  const { pageInfo, gacha, poolName = "角色" } = model;
  if (pageInfo) return `第 ${pageInfo.page}/${pageInfo.total} 张 · 第 ${pageInfo.from}~${pageInfo.to} 条，共 ${pageInfo.count} 条五星记录`;
  return gacha.hiddenNum
    ? `仅显示最近 ${gacha.shownNum} 条记录，更早的 ${gacha.hiddenNum} 条未显示（顶部统计包含全部记录），发送 ${games[game].prefix}${model.recordArchive ? "逐抽" : ""}${poolName}全部记录 查看全部`
    : "";
}

function portraitPath(path: string, game: Game) {
  return /^\/?meta-(gs|sr)\/(?:character|weapon)\/.+\.(?:png|webp|jpe?g)$/iu.exec(path)?.[1]?.toLowerCase() === game;
}

export async function renderGachaDetail(
  game: Game, model: GachaDetailModel,
  { mode = "auto", scale = 1.4, themeDirectory }: GachaDetailOptions,
) {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("抽卡记录缩放比例须在 1 至 4 之间。");
  const root = await realpath(themeDirectory).catch(() => undefined);
  if (!root) throw new Error(`${games[game].name}抽卡记录的原主题目录不可用。`);
  const theme = await originalTheme(root, game);
  const paths = new Set([
    model.face.face, model.face.banner,
    ...model.gacha.fiveLog.map(({ id }) => model.gacha.items[id]?.img),
  ].filter((path): path is string => !!path && portraitPath(path, game)));
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
  const more = [pagingNote(model, game), model.gacha.unclassified ? `${model.gacha.unclassified} 抽星级未辨认` : ""]
    .filter(Boolean).join(" · ");
  const rows = model.gacha.fiveLog;
  const rowsHeight = Math.max(16, rows.reduce((sum, row, index) => sum + 38 + (hasDate(rows[index - 1], row) ? 5 : 0), 0));
  const panelHeight = rowsHeight + (more ? 28 : 0);
  const bottom = top + panelHeight;
  const height = bottom + 47;
  if (height > 24_000) throw new RangeError(`${games[game].name}抽卡记录超出可渲染高度。`);
  const zoom = Math.min(scale, 24_000 / height);
  const pixelHeight = game === "gs" ? Math.round(height * zoom) : Math.ceil(height * zoom);

  return renderPng(Math.round(width * zoom), pixelHeight, (ctx) => {
    fontFamilies.set(ctx, theme.families);
    ctx.scale(zoom, zoom);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const bgZoom = Math.max(width / theme.background.width, height / theme.background.height);
    ctx.drawImage(theme.background, 0, 0, theme.background.width * bgZoom, theme.background.height * bgZoom);
    if (laterPage) {
      paintPageHead(ctx, model, laterPage, game);
    } else {
      paintBanner(ctx, model, theme, face, banner, game);
      if (luck) paintLuck(ctx, luck, tips, 125, luckHeight, game);
      paintNotice(ctx, top - 18, game, model.recordArchive);
    }
    paintRows(ctx, model, theme, images, top, panelHeight, more, game);
    ctx.save();
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 1;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    inline(ctx, [
      { value: "Lotus-Yunzai", color: "#90ee90", size: 14, bold: true },
    ], 375, bottom + 19, true);
    ctx.restore();
  }, mode);
}
