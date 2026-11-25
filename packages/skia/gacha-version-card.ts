import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("skia", messageCatalog.messages);
import { brandTextColor } from "./brand-color.ts";
import { builtinFontFallback } from "./builtin-fonts.ts";
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
  readonly qFace?: boolean;
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
  ["totalNum", $t("gacha-version-card.text_fe61382ff1")], ["star5Num", $t("gacha-version-card.text_90d84ceb1d")], ["c5UpNum", $t("gacha-version-card.text_4c69a80f18")], ["w5UpNum", $t("gacha-version-card.text_a4a1d95560")],
  ["star4Num", $t("gacha-version-card.text_07a28178b3")], ["avgUpNum", $t("gacha-version-card.text_94f7b3e1d4")],
] as const;
const groupStats = [
  ["totalNum", $t("gacha-version-card.text_55d4a18530")], ["star5Num", $t("gacha-version-card.text_90d84ceb1d")], ["upNum", $t("gacha-version-card.text_aa4a459a6b")], ["c4Num", $t("gacha-version-card.text_6b407943c9")], ["w4Num", $t("gacha-version-card.text_9a455954b1")],
] as const;

const games = {
  sr: { label: $t("gacha-version-card.text_a2927891f0"), background: "sr", face: $t("gacha-version-card.text_6cc5e43b1b"), columns: 7, cardWidth: 90, groupsTop: 146, prefix: "*" },
  gs: { label: $t("gacha-version-card.text_d1597c51ed"), background: "hydro", face: $t("gacha-version-card.text_ef09301bf5"), columns: 9, cardWidth: 69, groupsTop: 162, prefix: "#" },
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

async function readTheme(root: string, game: Game, qFace: boolean) {
  const config = games[game];
  const fonts = [
    ["Number", "tttgbnumber.ttf"], ["Han", "HYWH-65W.ttf"],
  ] as const;
  const aliases: string[] = [];
  for (const [name, file] of fonts) {
    const path = await assetPath(root, `common/font/${file}`);
    if (!path) throw new Error($t("gacha-version-card.text_0b72e021d2", { "label": config.label }));
    try {
      aliases.push(registerGachaThemeFont(name, path));
    } catch {
      throw new Error($t("gacha-version-card.text_0b72e021d2", { "label": config.label }));
    }
  }

  const [background, banner, regularFace, four, five] = await Promise.all([
    `common/bg/bg-${config.background}.webp`, `meta-${game}/character/common/imgs/banner.webp`,
    `meta-${game}/character/${config.face}/imgs/face.webp`, "common/item/bg4.png", "common/item/bg5.png",
  ].map((path) => readImage(root, path)));
  const preferred = qFace ? await readImage(root, `meta-${game}/character/${config.face}/imgs/face-q.webp`) : undefined;
  const face = preferred ?? regularFace ?? await readImage(root, "gacha/imgs/no-avatar.webp");
  if (!background || !banner || !face || !five || (game === "gs" && !four)) {
    throw new Error($t("gacha-version-card.text_965472f277", { "label": config.label }));
  }
  return { background, banner, face, four, five, family: aliases.join(", ") + ", " + builtinFontFallback };
}

const themes = new Map<string, ReturnType<typeof readTheme>>();

function themeAt(root: string, game: Game, qFace: boolean) {
  const key = `${game}:${qFace}:${root}`;
  let theme = themes.get(key);
  if (!theme) {
    theme = readTheme(root, game, qFace).catch((error: unknown) => {
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
  align: CanvasTextAlign = "left", maxWidth?: number, weight = false, footer = false) {
  ctx.font = `${weight ? "700 " : ""}${size}px ${fontFamilies.get(ctx)!}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = align;
  ctx.fillStyle = footer ? brandTextColor(ctx, String(value), x, y, maxWidth) : color;
  if (weight) {
    ctx.strokeStyle = ctx.fillStyle;
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

function richLine(ctx: Context, parts: readonly (readonly [string, string])[], x: number, y: number, size: number, weight = false, footer = false) {
  ctx.font = `${weight ? "700 " : ""}${size}px ${fontFamilies.get(ctx)!}`;
  const widths = parts.map(([value]) => ctx.measureText(value).width);
  let left = x - widths.reduce((sum, value) => sum + value, 0) / 2;
  for (const [index, [value, color]] of parts.entries()) {
    text(ctx, value, left, y, size, color, "left", undefined, weight, footer);
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
  const mid = $t("gacha-version-card.text_bdb4b2fc9d", { "uid": model.uid, "poolName": model.poolName });
  const marker = $t("gacha-version-card.text_dc8941f893", { "page": page.page, "total": page.total });
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
  const name = item?.name || $t("gacha-version-card.text_4d8c1c5b42");
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
    if (group.unassigned) return [{ value, label: $t("gacha-version-card.text_c82087af4d") }];
    return [{ value, label: dated && model.gacha.totalStat.unassignedDraws ? $t("gacha-version-card.text_dba78395fa") : label }];
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
        [$t("gacha-version-card.text_7978eaa374"), light], [$t("gacha-version-card.text_8167384877"), gold], [$t("gacha-version-card.text_9bad52ad6f"), light],
      ], width / 2, 128, 13);
      return;
    }
    richLine(ctx, [
      [$t("gacha-version-card.text_2a53e47907"), light], [$t("gacha-version-card.text_a74acdd089"), gold], ["  ", light], [$t("gacha-version-card.text_a5e40e2d62"), gold],
      ["  ", light], [$t("gacha-version-card.text_44316c25aa"), gold], ["  ", light], [$t("gacha-version-card.text_e9555fcf84"), gold],
    ], width / 2, 128, 13);
    return;
  }
  if (game === "gs") {
    richLine(ctx, [
      ["#角色统计/#武器统计", gold], [$t("gacha-version-card.text_b557a2e1db"), light],
      ["#常驻统计/#集录统计", gold], [$t("gacha-version-card.text_f8193439ad"), light],
    ], width / 2, 128, 13);
    richLine(ctx, [
      ["#全部统计", gold], [$t("gacha-version-card.text_3397e42ea1"), light],
      ["#抽卡帮助", gold], [$t("gacha-version-card.text_7ccceb76c3"), light],
    ], width / 2, 144, 13);
    return;
  }
  richLine(ctx, [
    [$t("gacha-version-card.text_0eb5dc0d75"), gold], [$t("gacha-version-card.text_b557a2e1db"), light],
    [$t("gacha-version-card.text_f93b41cd84"), gold], [$t("gacha-version-card.text_1bff9db816"), light],
    [$t("gacha-version-card.text_ea0fa7c627"), gold], [$t("gacha-version-card.text_3397e42ea1"), light],
    [$t("gacha-version-card.text_da78aac178"), gold], [$t("gacha-version-card.text_7ccceb76c3"), light],
  ], width / 2, 128, 13);
}

function unassignedNotice(model: GachaVersionModel) {
  const { unassignedDraws, unclassifiedDraws, totalNum } = model.gacha.totalStat;
  const notes = [];
  if (unassignedDraws > 0) notes.push($t("gacha-version-card.text_1a6ad19554", { "totalNum": totalNum, "value2": totalNum - unassignedDraws, "unassignedDraws": unassignedDraws }));
  if (unclassifiedDraws) notes.push($t("gacha-version-card.text_e1a9a10145", { "unclassifiedDraws": unclassifiedDraws }));
  return notes.join(" · ");
}

function pagingNote(model: GachaVersionModel, game: Game) {
  const { pageInfo, gacha, poolName } = model;
  if (pageInfo) return $t("gacha-version-card.text_84c666ec41", { "page": pageInfo.page, "total": pageInfo.total, "from": pageInfo.from, "to": pageInfo.to, "count": pageInfo.count });
  return gacha.hiddenNum
    ? $t("gacha-version-card.text_83a8704549", { "shownNum": gacha.shownNum, "hiddenNum": gacha.hiddenNum, "prefix": games[game].prefix, "value4": model.recordArchive ? $t("gacha-version-card.text_4dbd45ce46") : "", "poolName": poolName })
    : "";
}

export async function renderGachaVersion(
  game: Game, model: GachaVersionModel,
  { mode = "auto", scale = 4, themeDirectory, avatar, qFace = true }: GachaVersionOptions,
) {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError($t("gacha-version-card.text_3ac360ee98"));
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
    if (height > 24_000) throw new RangeError($t("gacha-version-card.text_ee0ed776e0", { "label": config.label }));
    return { bottom, footer, height };
  }
  let layouts = groups.map((group) => layoutGroup(group, model, game, undefined));
  let { bottom, footer, height } = dimensions(layouts);
  const root = await realpath(themeDirectory).catch(() => undefined);
  if (!root) throw new Error($t("gacha-version-card.text_10ab28c5db", { "label": config.label }));
  const theme = await themeAt(root, game, qFace);
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
      [$t("gacha-version-card.text_3867834e77"), "#fff"],
    ], 375, footer + 8.5, 14, true, true);
    ctx.restore();
  }, mode, { renderScale: scale, allowHalfScale: scale === 4 });
}
