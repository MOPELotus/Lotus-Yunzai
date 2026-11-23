import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { registerGachaThemeFont } from "./gacha-theme-fonts.ts";
import { gachaBannerShadow } from "./gacha-banner-shadow.ts";
import { renderPng } from "./index.ts";
import { Canvas, loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";

export interface GachaVersionOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
  readonly themeDirectory: string;
  readonly avatar?: Uint8Array;
}

const width = 740;
const margin = 15;
const panelWidth = width - 2 * margin;
const gold = "#d3bc8e";
const ink = "#414e64";
const white = "#fff";
const muted = "#aaa";
const fontFamilies = new WeakMap<Context, string>();
const bannerStats = [
  ["totalNum", "抽卡总数"], ["star5Num", "金卡"], ["c5UpNum", "UP角色"], ["w5UpNum", "UP武器"],
  ["star4Num", "紫卡"], ["avgUpNum", "平均UP抽"],
] as const;
const groupStats = [
  ["totalNum", "总抽卡"], ["star5Num", "金卡"], ["upNum", "UP金卡"], ["c4Num", "紫角色"], ["w4Num", "紫武器"],
] as const;

const games = {
  sr: { label: "星铁", background: "sr", face: "卡芙卡/imgs/face.webp", columns: 7, cardWidth: 90, groupsTop: 146, prefix: "*" },
  gs: { label: "原神", background: "hydro", face: "芭芭拉/imgs/face-q.webp", columns: 9, cardWidth: 69, groupsTop: 162, prefix: "#" },
} as const;
type Game = keyof typeof games;

type Stats<Key extends string> = Readonly<Record<Key, number>>;
interface ItemCount {
  readonly id: string;
  readonly num: number;
  readonly star: number;
  readonly isUp: 0 | 1;
}
interface Group {
  readonly version: string;
  readonly half: string;
  readonly from: string;
  readonly to: string;
  readonly name: string;
  readonly items: readonly ItemCount[];
  readonly stats: Stats<typeof groupStats[number][0]>;
  readonly unassigned?: true;
}
interface GachaVersionModel {
  readonly uid: string;
  readonly recordArchive?: true;
  readonly face: { readonly name: string; readonly face?: string; readonly banner?: string };
  readonly poolName: string;
  readonly gacha: {
    readonly versionData: readonly Group[];
    readonly itemMap: Readonly<Record<string, { readonly name: string; readonly abbr: string; readonly img: string }>>;
    readonly totalStat: Stats<Exclude<typeof bannerStats[number][0], "avgUpNum">> & {
      readonly avgUpNum: string | 0;
      readonly unassignedDraws: number;
      readonly unclassifiedDraws?: number;
    };
    readonly isMix: boolean;
    readonly shownNum?: number;
    readonly hiddenNum?: number;
  };
  readonly pageInfo?: { readonly page: number; readonly total: number; readonly from: number; readonly to: number; readonly count: number };
}

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

async function readTheme(root: string, game: Game) {
  const config = games[game];
  const fonts = [
    ["Number", "tttgbnumber.ttf"], ["Han", "HYWH-65W.ttf"],
  ] as const;
  const aliases: string[] = [];
  for (const [name, file] of fonts) {
    const path = await assetPath(root, `common/font/${file}`);
    if (!path) throw new Error(`${config.label}版本统计的原主题字体不可用。`);
    try {
      aliases.push(registerGachaThemeFont(name, path));
    } catch {
      throw new Error(`${config.label}版本统计的原主题字体不可用。`);
    }
  }

  const [background, banner, face, four, five] = await Promise.all([
    `common/bg/bg-${config.background}.webp`, `meta-${game}/character/common/imgs/banner.webp`,
    `meta-${game}/character/${config.face}`, "common/item/bg4.png", "common/item/bg5.png",
  ].map((path) => readImage(root, path)));
  if (!background || !banner || !face || !five || (game === "gs" && !four)) {
    throw new Error(`${config.label}版本统计的原主题图片不可用。`);
  }
  return { background, banner, face, four, five, family: aliases.join(", ") + ", sans-serif" };
}

const themes = new Map<string, ReturnType<typeof readTheme>>();

function themeAt(root: string, game: Game) {
  const key = `${game}:${root}`;
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
  ctx.font = `${weight ? "700 " : ""}${size}px ${fontFamilies.get(ctx)!}`;
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

function drawNickname(ctx: Context, nickname: string, x: number, y: number, size: number, color: string, maxWidth: number) {
  ctx.font = `700 ${size}px ${fontFamilies.get(ctx)!}`;
  const width = ctx.measureText(nickname).width;
  if (width > maxWidth) size = Math.max(16, Math.floor(size * maxWidth / width));
  ctx.font = `700 ${size}px ${fontFamilies.get(ctx)!}`;
  if (ctx.measureText(nickname).width > maxWidth) {
    let fitted = "";
    for (const character of nickname) {
      if (ctx.measureText(`${fitted}${character}…`).width > maxWidth) break;
      fitted += character;
    }
    nickname = fitted + "…";
  }
  text(ctx, nickname, x, y, size, color, "left", maxWidth, true);
}

function richLine(ctx: Context, parts: readonly (readonly [string, string])[], x: number, y: number, size: number, weight = false) {
  ctx.font = `${weight ? "700 " : ""}${size}px ${fontFamilies.get(ctx)!}`;
  const widths = parts.map(([value]) => ctx.measureText(value).width);
  let left = x - widths.reduce((sum, value) => sum + value, 0) / 2;
  for (const [index, [value, color]] of parts.entries()) {
    text(ctx, value, left, y, size, color, "left", undefined, weight);
    left += widths[index]!;
  }
}

function drawBanner(ctx: Context, model: GachaVersionModel, theme: Theme,
  assets: ReadonlyMap<string, Image>, game: Game, avatar?: Image) {
  const hero = (model.face.banner && assets.get(model.face.banner)) || theme.banner;
  const icon = (model.face.face && assets.get(model.face.face)) || avatar || theme.face;
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
  const crop = Math.min(icon.width, icon.height);
  ctx.drawImage(icon, (icon.width - crop) / 2, (icon.height - crop) / 2, crop, crop, 29, 39, 64, 64);
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
  if (game === "gs" || model.recordArchive) drawNickname(ctx, model.face.name, 111, 58, 24, ink, nameWidth);
  else text(ctx, model.face.name, 111, 58, 24, ink, "left", nameWidth, true);
  text(ctx, `#${model.uid}`, 111, 86, 16, ink, "left", nameWidth);
  ctx.restore();
  if (!gauges.length) return;
  if (game === "gs") gachaBannerShadow(ctx, left, bandWidth);
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

function drawPageHead(ctx: Context, model: GachaVersionModel, page: NonNullable<GachaVersionModel["pageInfo"]>, game: Game) {
  rect(ctx, margin, 25, panelWidth, 45, 30, "rgba(0,0,0,.50)");
  const mid = `#${model.uid} · ${model.poolName}统计`;
  const marker = `第 ${page.page}/${page.total} 张`;
  ctx.font = `700 20px ${fontFamilies.get(ctx)!}`;
  const nameWidth = Math.min(ctx.measureText(model.face.name).width, 235);
  ctx.font = `16px ${fontFamilies.get(ctx)!}`;
  const free = panelWidth - 40 - nameWidth - ctx.measureText(mid).width - ctx.measureText(marker).width;
  if (game === "gs" || model.recordArchive) drawNickname(ctx, model.face.name, 35, 47, 20, white, nameWidth || 235);
  else text(ctx, model.face.name, 35, 47, 20, white, "left", nameWidth || 235, true);
  text(ctx, mid, 35 + nameWidth + Math.max(0, free / 2), 47, 16, "#ddd");
  text(ctx, marker, 705, 47, 16, "#ffd484", "right");
}

function cardName(model: GachaVersionModel, { id }: ItemCount) {
  const item = model.gacha.itemMap[id];
  const name = item?.name || "未知";
  return name.length > 4 ? item?.abbr || name : name;
}

function wrapCardName(ctx: Context, name: string, width: number) {
  const lines: string[] = [];
  let line = "";
  for (const character of name) {
    if (line && ctx.measureText(line + character).width > width) {
      lines.push(line);
      line = "";
    }
    line += character;
  }
  lines.push(line);
  return lines;
}

function layoutGroup(group: Group, model: GachaVersionModel, game: Game, measure: Context | undefined) {
  const { columns, cardWidth } = games[game];
  const items = group.items.filter(({ star }) => star === 4 || star === 5);
  const cards = [];
  let top = 65;
  for (let start = 0; start < items.length; start += columns) {
    const row = items.slice(start, start + columns).map((item, column) => {
      const name = cardName(model, item);
      const lines = measure ? wrapCardName(measure, name, cardWidth) : [name];
      return { item, lines, x: 27 + column * (cardWidth + 8), top, height: cardWidth + lines.length * 24 };
    });
    cards.push(...row);
    top += Math.max(...row.map(({ height }) => height)) + 8;
  }
  return { cards, height: top + 1 };
}
type GroupLayout = ReturnType<typeof layoutGroup>;

function drawGroup(ctx: Context, group: Group, model: GachaVersionModel, theme: Theme,
  images: ReadonlyMap<string, Image>, layout: GroupLayout, y: number, game: Game) {
  const h = layout.height;
  const side = games[game].cardWidth;
  const dated = !!group.from && !!group.to;
  const poolWidth = model.gacha.isMix ? 160 : 125;
  const titleWidth = dated ? 106 + poolWidth : 131;

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
    text(ctx, group.name, 120, y + 21, 16, gold, "left", poolWidth - 3);
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
    ctx.font = `12px ${fontFamilies.get(ctx)!}`;
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

  for (const card of layout.cards) {
    const { x, height, lines, item: row } = card;
    const top = y + card.top;
    const item = model.gacha.itemMap[row.id];
    const image = item?.img && images.get(item.img);
    ctx.save();
    ctx.shadowBlur = row.isUp ? 8 : 0;
    ctx.shadowColor = "#ffeb73";
    rect(ctx, x - 0.7, top - 0.7, side + 1.4, height + 1.4, 7, row.isUp ? "#fff100" : white);
    ctx.restore();
    rect(ctx, x, top, side, height, 6, white);
    ctx.save();
    shape(ctx, x, top, side, side, [6, 6, 10, 0]);
    ctx.clip();
    const star = row.star >= 5 ? theme.five : theme.four;
    if (star) {
      if (game === "gs") ctx.drawImage(star, x, top, side, side);
      else ctx.drawImage(star, x, top);
    }
    if (image) {
      const zoom = side / Math.max(image.width, image.height);
      const w = image.width * zoom;
      const h = image.height * zoom;
      ctx.drawImage(image, x + (side - w) / 2, top + (side - h) / 2, w, h);
    }
    ctx.font = `16px ${fontFamilies.get(ctx)!}`;
    const badgeWidth = Math.max(20, ctx.measureText(String(row.num)).width + 12);
    rect(ctx, x + side - badgeWidth, top + side - 22, badgeWidth, 22, [10, 0, 0, 0], row.isUp ? "#ffeb73" : "#333");
    text(ctx, row.num, x + side - badgeWidth / 2, top + side - 11, 16, row.isUp ? "#6f4b00" : white, "center");
    ctx.restore();
    for (const [index, line] of lines.entries()) {
      const nameWidth = game === "gs" ? side : side - 5;
      text(ctx, line, x + side / 2, top + side + 12 + index * 24, 14, row.isUp ? "#6f4b00" : "#000", "center", nameWidth);
    }
  }
  ctx.restore();
  shape(ctx, margin, y, panelWidth, h, 10);
  ctx.strokeStyle = "rgba(204,204,204,.30)";
  ctx.lineWidth = 0.7;
  ctx.stroke();
}

function drawNotice(ctx: Context, game: Game, recordArchive?: true, poolName?: string) {
  const light = "rgba(255,255,255,.90)";
  if (recordArchive) {
    if (poolName === "全部") {
      richLine(ctx, [
        ["本地逐抽档案 · 统计角色、光锥与常驻池，", light], ["*逐抽全部记录", gold], [" 查看六池", light],
      ], width / 2, 128, 13);
      return;
    }
    richLine(ctx, [
      ["本地逐抽档案 · ", light], ["*逐抽角色统计", gold], ["  ", light], ["*逐抽光锥统计", gold],
      ["  ", light], ["*逐抽常驻统计", gold], ["  ", light], ["*逐抽全部统计", gold],
    ], width / 2, 128, 13);
    return;
  }
  if (game === "gs") {
    richLine(ctx, [
      ["#角色统计/#武器统计", gold], [" 角色/武器池统计，  ", light],
      ["#常驻统计/#集录统计", gold], [" 常驻/集录池统计", light],
    ], width / 2, 128, 13);
    richLine(ctx, [
      ["#全部统计", gold], [" 全部抽卡统计，  ", light],
      ["#抽卡帮助", gold], [" 获取帮助", light],
    ], width / 2, 144, 13);
    return;
  }
  richLine(ctx, [
    ["*角色统计/*武器统计", gold], [" 角色/武器池统计，  ", light],
    ["*常驻统计", gold], [" 常驻池统计，  ", light],
    ["*全部统计", gold], [" 全部抽卡统计，  ", light],
    ["*抽卡帮助", gold], [" 获取帮助", light],
  ], width / 2, 128, 13);
}

function unassignedNotice(model: GachaVersionModel) {
  const { unassignedDraws, unclassifiedDraws, totalNum } = model.gacha.totalStat;
  const notes = [];
  if (unassignedDraws > 0) notes.push(`累计 ${totalNum} 抽 · 分期可确认 ${totalNum - unassignedDraws} 抽 · ${unassignedDraws} 抽未能归至期次`);
  if (unclassifiedDraws) notes.push(`${unclassifiedDraws} 抽星级未辨认`);
  return notes.join(" · ");
}

function pagingNote(model: GachaVersionModel, game: Game) {
  const { pageInfo, gacha, poolName } = model;
  if (pageInfo) return `第 ${pageInfo.page}/${pageInfo.total} 张 · 第 ${pageInfo.from}~${pageInfo.to} 期，共 ${pageInfo.count} 期卡池`;
  return gacha.hiddenNum
    ? `仅显示最近 ${gacha.shownNum} 期卡池，更早的 ${gacha.hiddenNum} 期未显示（顶部统计包含全部数据），发送 ${games[game].prefix}${model.recordArchive ? "逐抽" : ""}${poolName}全部统计 查看全部`
    : "";
}

export async function renderGachaVersion(
  game: Game, model: GachaVersionModel,
  { mode = "auto", scale = 4, themeDirectory, avatar }: GachaVersionOptions,
) {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("版本统计缩放比例须在 1 至 4 之间。");
  const config = games[game];
  const laterPage = model.pageInfo && model.pageInfo.page > 1 ? model.pageInfo : undefined;
  const note = laterPage ? "" : unassignedNotice(model);
  const paging = pagingNote(model, game);
  const groups = model.gacha.versionData;
  const top = laterPage ? 80 : config.groupsTop + (note ? 16 : 0);
  function dimensions(layouts: readonly GroupLayout[]) {
    const bottom = top + layouts.reduce((sum, layout) => sum + layout.height + 10, 0);
    const footer = bottom + (paging ? 38 : 0);
    const height = footer + 37;
    if (height > 24_000) throw new RangeError(`${config.label}版本统计超出可渲染高度。`);
    return { bottom, footer, height };
  }
  let layouts = groups.map((group) => layoutGroup(group, model, game, undefined));
  let { bottom, footer, height } = dimensions(layouts);
  const root = await realpath(themeDirectory).catch(() => undefined);
  if (!root) throw new Error(`${config.label}版本统计的原主题目录不可用。`);
  const theme = await themeAt(root, game);
  if (game === "gs") {
    // The scratch canvas measures text only. All visible graphics go through renderPng below.
    const measure = new Canvas(1, 1).getContext("2d");
    measure.font = `14px ${theme.family}`;
    layouts = groups.map((group) => layoutGroup(group, model, game, measure));
    ({ bottom, footer, height } = dimensions(layouts));
  }
  const paths = new Set([
    model.face.face, model.face.banner,
    ...layouts.flatMap(({ cards }) => cards.map(({ item }) => model.gacha.itemMap[item.id]?.img)),
  ].filter((path): path is string => !!path && /^\/?meta-(gs|sr)\/(?:character|weapon)\/.+\.(?:png|webp|jpe?g)$/iu.exec(path)?.[1]?.toLowerCase() === game));
  const images = new Map<string, Image>();
  for (const path of paths) {
    const image = await readImage(root, path);
    if (image) images.set(path, image);
  }
  const face = avatar && await loadImage(Buffer.from(avatar)).catch(() => undefined);
  const zoom = scale * (game === "gs" ? 1.4 : 1);
  return renderPng(Math.round(width * zoom), Math.round(height * zoom), (ctx) => {
    fontFamilies.set(ctx, theme.family);
    ctx.scale(zoom, zoom);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const bg = Math.max(width / theme.background.width, height / theme.background.height);
    ctx.drawImage(theme.background, 0, 0, theme.background.width * bg, theme.background.height * bg);

    if (laterPage) drawPageHead(ctx, model, laterPage, game);
    else {
      drawBanner(ctx, model, theme, images, game, face);
      drawNotice(ctx, game, model.recordArchive, model.poolName);
      if (note) text(ctx, note, width / 2, config.groupsTop - 2, 13, gold, "center", panelWidth - 16);
    }
    let y = top;
    for (const [index, group] of groups.entries()) {
      const layout = layouts[index]!;
      drawGroup(ctx, group, model, theme, images, layout, y, game);
      y += layout.height + 10;
    }
    if (paging) text(ctx, paging, width / 2, bottom + 16, 13, muted, "center", panelWidth - 16);
    ctx.save();
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 1;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    richLine(ctx, [
      ["Lotus-Yunzai", "#90ee90"],
    ], 375, footer + 8.5, 14, true);
    ctx.restore();
  }, mode, { renderScale: scale, allowHalfScale: scale === 4 });
}
