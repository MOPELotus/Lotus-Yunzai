import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas, FontLibrary, loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { nativeImageRasterScale, renderPng, type PngRender } from "./index.ts";

type Game = "gs" | "sr" | "zzz";
type TextValue = string | number | null;

export interface DailyNoteCardDetail {
  readonly label: string;
  readonly value?: TextValue;
  readonly note?: string;
}

export interface DailyNoteCardExpedition {
  readonly name: string;
  readonly remaining: string;
  readonly progress?: number;
  readonly avatars: readonly (string | undefined)[];
}

export interface DailyNoteCardItem {
  readonly game?: Game | "";
  readonly gameName?: string;
  readonly uid?: string | number;
  readonly ok: boolean;
  readonly detail?: string;
  readonly recovery?: string;
  readonly details?: readonly DailyNoteCardDetail[];
  readonly checkin?: "已签到" | "未签到" | "暂时无法核验";
  readonly expeditions?: readonly DailyNoteCardExpedition[];
  readonly error?: string;
  readonly data?: {
    readonly current_resin?: TextValue;
    readonly max_resin?: TextValue;
    readonly current_home_coin?: TextValue;
    readonly max_home_coin?: TextValue;
    readonly current_stamina?: TextValue;
    readonly max_stamina?: TextValue;
    readonly energy?: {
      readonly progress?: { readonly current?: TextValue; readonly max?: TextValue };
      readonly current?: TextValue;
      readonly max?: TextValue;
    };
  };
}

export interface DailyNoteCardModel {
  readonly generatedAt?: string;
  readonly groups: readonly { readonly name: string; readonly items: readonly DailyNoteCardItem[] }[];
}

export interface DailyNoteCardOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
  readonly resourceDirectory?: string;
  readonly avatarArtwork?: ReadonlyMap<string, Uint8Array>;
  readonly inlineImageByteLimit?: number;
  readonly signal?: AbortSignal;
}

// Lotus-ReFactor daily-note-summary, drawn from the original Genshin daily-note template.
const width = 480;
const inset = 16;
const panelWidth = width - 2 * inset;
const valueWidth = 148;
const labelWidth = panelWidth - valueWidth - 53;
const defaultResources = fileURLToPath(new URL("../../data/daily-note/resources", import.meta.url));
const detailIcons = new Map<string, Icon>([
  ["洞天宝钱", "洞天宝钱"], ["每日委托", "委托"], ["探索派遣", "派遣"], ["最快派遣", "派遣"],
  ["周本减半", "周本"], ["参量质变仪", "参量质变仪"],
]);

const icons = ["树脂", "洞天宝钱", "委托", "派遣", "周本", "参量质变仪"] as const;
type Icon = typeof icons[number];
type Row = DailyNoteCardDetail & { readonly icon?: Icon };

async function loadTheme(directory: string) {
  const alias = createHash("sha256").update(directory).digest("hex").slice(0, 12);
  const body = `DailyNoteBody${alias}`;
  const number = `DailyNoteNumber${alias}`;
  const miSans = `DailyNoteMiSans${alias}`;

  for (const [name, file] of [
    [body, "miao-theme/fonts/HYWH-65W.ttf"],
    [number, "source-templates/miao-stat/fonts/tttgbnumber.ttf"],
    [miSans, "fonts/MiSans-VF.ttf"],
  ] as const) {
    const fontPath = join(directory, file);
    if (!await Bun.file(fontPath).exists()) throw new Error(`体力卡原字体不可用：${file}`);
    FontLibrary.use(name, [fontPath]);
  }

  const images = new Map<Icon, Image>();
  await Promise.all(icons.map(async (icon) => {
    const file = join(directory, "source-templates/genshin/note-icons/gs", `${icon}.png`);
    images.set(icon, await loadImage(file));
  }));
  const textFont = `"${body}", "${miSans}", sans-serif`;
  return { images, textFont, numberFont: `"${number}", ${textFont}` };
}

const themes = new Map<string, ReturnType<typeof loadTheme>>();

function themeAt(directory: string) {
  let theme = themes.get(directory);
  if (!theme) {
    theme = loadTheme(directory).catch((error: unknown) => {
      themes.delete(directory);
      throw error;
    });
    themes.set(directory, theme);
  }
  return theme;
}

function primary(item: DailyNoteCardItem): Row {
  const data = item.data;
  const pair = (current?: TextValue, max?: TextValue) => current !== undefined ? `${current}/${max ?? "未记录"}` : "";
  switch (item.game) {
    case "gs": return { label: "原粹树脂", value: pair(data?.current_resin, data?.max_resin), icon: "树脂" };
    case "sr": return { label: "开拓力", value: pair(data?.current_stamina, data?.max_stamina) };
    case "zzz": {
      const energy = data?.energy?.progress ?? data?.energy;
      return { label: "电量", value: pair(energy?.current, energy?.max) };
    }
    default: return { label: item.gameName || "体力", value: "" };
  }
}

function makeRows(item: DailyNoteCardItem): Row[] {
  if (!item.ok) return [{ label: "查询失败", value: "失败", note: item.error || item.detail }];
  const first = primary(item);
  const recovery = item.recovery ?? item.detail?.split(" · ").find((part) => /^(回满|已回满)/u.test(part));
  const rows: Row[] = [{
    ...first, value: first.value || "查询成功", note: first.value ? recovery : item.detail,
  }];
  if (item.game === "gs" && item.data?.current_home_coin !== undefined) {
    rows.push({
      label: "洞天宝钱", icon: "洞天宝钱",
      value: `${item.data.current_home_coin}/${item.data.max_home_coin}`,
    });
  }
  for (const row of item.details ?? []) rows.push({ ...row, icon: detailIcons.get(row.label) });
  return rows;
}

function plainText(value: TextValue | undefined): string {
  return String(value ?? "").replace(/\\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function lines(ctx: Context, value: TextValue | undefined, available: number, size: number, font: string) {
  ctx.font = `${size}px ${font}`;
  return plainText(value).split(/\r?\n/u).flatMap((paragraph) => {
    const rows: string[] = [];
    let line = "";
    function append(token: string) {
      if (line && ctx.measureText(line + token).width > available) {
        rows.push(line);
        line = "";
      }
      line += token;
    }
    for (const token of paragraph.match(/[-+]?\d+(?:\.\d+)?%?|[A-Za-z][A-Za-z0-9.-]*|./gu) ?? []) {
      if (ctx.measureText(token).width <= available) append(token);
      else for (const character of token) append(character);
    }
    rows.push(line);
    return rows;
  });
}

function fitSize(ctx: Context, value: string, available: number, font: string, size: number, min: number) {
  ctx.font = `${size}px ${font}`;
  while (size > min && ctx.measureText(value).width > available) {
    size -= .5;
    ctx.font = `${size}px ${font}`;
  }
  return size;
}

function singleLine(ctx: Context, value: TextValue | undefined, available: number, font: string, size: number, min: number) {
  const text = plainText(value).replace(/\s*\n\s*/gu, " ");
  return { text, size: fitSize(ctx, text, available, font, size, min) };
}

function shape(ctx: Context, x: number, y: number, w: number, h: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
}

function rect(ctx: Context, x: number, y: number, w: number, h: number, color: string, radius = 0) {
  shape(ctx, x, y, w, h, radius);
  ctx.fillStyle = color;
  ctx.fill();
}

function textAt(ctx: Context, rows: readonly string[], x: number, y: number, font: string, color: string,
  size: number, leading: number, align: CanvasTextAlign = "left") {
  ctx.font = `${size}px ${font}`;
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
  ctx.textAlign = align;
  for (const [index, row] of rows.entries()) ctx.fillText(row, x, y + index * leading);
}

function paintIcon(ctx: Context, image: Image, x: number, y: number) {
  const scale = Math.min(25 / image.width, 25 / image.height);
  const w = image.width * scale;
  const h = image.height * scale;
  ctx.drawImage(image, x + (25 - w) / 2, y + (25 - h) / 2, w, h);
}

// StarRail-plugin 308a83d new_note uses a grey row, centered status, trailing portraits and a gold progress edge.
const expeditionHeight = 40;
const expeditionHeading = 34;
function paintExpeditions(ctx: Context, y: number, rows: readonly DailyNoteCardExpedition[], font: string,
  numberFont: string, avatars: ReadonlyMap<string, Image>) {
  const height = expeditionHeading + Math.max(1, rows.length) * (expeditionHeight + 5) + 4;
  rect(ctx, inset, y, panelWidth, height, "#e8e7e7", 5);
  textAt(ctx, ["委托状态"], inset + 10, y + 8, font, "#504c49", 16, 22);
  y += expeditionHeading;
  if (!rows.length) textAt(ctx, ["委托明细暂未返回"], width / 2, y + 5, font, "#5f5f5d", 14, 22, "center");
  for (const row of rows) {
    const x = inset + 7;
    const rowWidth = panelWidth - 14;
    rect(ctx, x, y, rowWidth, expeditionHeight, "#ccc");
    const name = singleLine(ctx, row.name, 151, font, 15, 12);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 8, y, 151, 35);
    ctx.clip();
    textAt(ctx, [name.text], x + 8, y + 9, font, "#504c49", name.size, 22);
    ctx.restore();
    const completed = row.progress === 1;
    const color = completed ? "#9c8d5c" : "#504c49";
    const status = singleLine(ctx, row.remaining, 111, numberFont, 13, 11);
    const badgeWidth = Math.ceil(ctx.measureText(status.text).width) + 10;
    shape(ctx, x + 213 - badgeWidth / 2, y + 7, badgeWidth, 21, 3);
    ctx.strokeStyle = color;
    ctx.stroke();
    textAt(ctx, [status.text], x + 213, y + 9, numberFont, color, status.size, 21, "center");
    row.avatars.forEach((url, index) => {
      const dx = x + rowWidth - 6 - (row.avatars.length - index) * 34;
      ctx.save();
      shape(ctx, dx, y + 3, 30, 30, 15);
      ctx.clip();
      const avatar = url ? avatars.get(url) : undefined;
      if (avatar) {
        const factor = Math.max(30 / avatar.width, 30 / avatar.height);
        const w = avatar.width * factor, h = avatar.height * factor;
        ctx.drawImage(avatar, dx + (30 - w) / 2, y + 3 + (30 - h) / 2, w, h);
      } else rect(ctx, dx, y + 3, 30, 30, "#e8e7e7");
      ctx.restore();
      shape(ctx, dx, y + 3, 30, 30, 15);
      ctx.strokeStyle = "#9c8d5c";
      ctx.stroke();
    });
    if (row.progress !== undefined) {
      rect(ctx, x, y + 35, rowWidth, 5, "#b8b8b8");
      rect(ctx, x, y + 35, rowWidth * row.progress, 5, "#ac9854");
    }
    y += expeditionHeight + 5;
  }
}

export async function renderDailyNoteCard(model: DailyNoteCardModel,
  { mode = "auto", scale = 4, resourceDirectory = defaultResources, avatarArtwork, inlineImageByteLimit, signal }: DailyNoteCardOptions = {}): Promise<PngRender> {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("体力卡缩放比例须在 1 至 4 之间。");

  const { images, textFont, numberFont } = await themeAt(await realpath(resourceDirectory));
  const avatars = new Map<string, Image>();
  await Promise.all([...(avatarArtwork ?? [])].map(async ([url, bytes]) => {
    const image = await loadImage(Buffer.from(bytes)).catch(() => undefined);
    if (image?.width && image.height) avatars.set(url, image);
  }));
  signal?.throwIfAborted();
  const ctx = new Canvas(1, 1).getContext("2d");
  let bottom = 12;
  const sections = model.groups.flatMap(({ name, items }) => items.map((item) => {
    const game = item.gameName || item.game;
    const heading = game ? `${name} · ${game} · UID ${item.uid || "未同步"}` : name;
    const checkin = item.game === "sr" ? item.checkin : undefined;
    const expeditions = item.game === "sr" ? item.expeditions : undefined;
    const title = singleLine(ctx, heading, width - (checkin ? 196 : 42), numberFont, 16, 12);
    const headingY = bottom;
    bottom += title.size * 1.5 + 9;
    const rows = makeRows(item).map((row) => {
      const height = Math.max(49, 37 + (row.note ? lines(ctx, row.note, labelWidth, 12, textFont).length : 0) * 17);
      const initialSize = fitSize(ctx, String(row.value ?? ""), valueWidth - 12, numberFont, 16, 12);
      return {
        icon: row.icon, height,
        label: lines(ctx, row.label, labelWidth, 14, numberFont),
        note: row.note ? lines(ctx, row.note, labelWidth, 12, numberFont) : [],
        value: singleLine(ctx, row.value, valueWidth - 12, numberFont, initialSize, 10),
      };
    });
    const panelY = bottom;
    const panelHeight = rows.reduce((sum, row) => sum + row.height, 0);
    bottom += panelHeight + 21;
    if (expeditions) bottom += expeditionHeading + Math.max(1, expeditions.length) * (expeditionHeight + 5) + 11;
    return { title, headingY, panelY, panelHeight, rows, checkin, expeditions };
  }));
  const footer = lines(ctx, `Lotus-Yunzai${model.generatedAt ? ` · ${model.generatedAt}` : ""}`, width - 30, 12, textFont);
  const height = Math.max(240, bottom + 50);
  function paint(drawing: Context, zoom: number) {
    drawing.scale(zoom, zoom);
    drawing.imageSmoothingEnabled = true;
    drawing.imageSmoothingQuality = "high";
    rect(drawing, 0, 0, width, 100000, "#f0eae3");
    for (const { title, headingY, panelY, panelHeight, rows, checkin, expeditions } of sections) {
      rect(drawing, inset, headingY - 3, 5, 24, "#d3bc8d", 1);
      textAt(drawing, [title.text], 26, headingY, numberFont, "#504c49", title.size, title.size * 1.5);
      if (checkin) {
        const color = checkin === "已签到" ? "#9c8d5c" : "#767676";
        shape(drawing, width - 146, headingY, 130, 21, 3);
        drawing.strokeStyle = color;
        drawing.stroke();
        const badge = singleLine(drawing, `今日米游社 ${checkin}`, 118, textFont, 12, 10);
        textAt(drawing, [badge.text], width - 81, headingY + 3, textFont, color, badge.size, 20, "center");
      }
      rect(drawing, inset, panelY, panelWidth, panelHeight, "#dfd8d1", 9);
      drawing.save();
      shape(drawing, inset + 1, panelY + 1, panelWidth - 2, panelHeight - 2, 8);
      drawing.clip();

      let y = panelY;
      for (const [index, row] of rows.entries()) {
        rect(drawing, inset + 1, y, panelWidth - valueWidth - 1, row.height, "#f5f1eb");
        rect(drawing, inset + panelWidth - valueWidth, y, valueWidth - 1, row.height, "#ece3d8");
        const image = row.icon && images.get(row.icon);
        if (image) paintIcon(drawing, image, inset + 8, y + 11);
        textAt(drawing, row.label, inset + 42, y + 7, numberFont, "#1e1f20", 14, 18);
        textAt(drawing, row.note, inset + 42, y + 27, numberFont, "#5f5f5d", 12, 17);
        textAt(drawing, [row.value.text], inset + panelWidth - valueWidth / 2, y + (row.height - 22) / 2,
          numberFont, "#504c49", row.value.size, 22, "center");
        y += row.height;
        if (index < rows.length - 1) rect(drawing, inset + 1, y - 1, panelWidth - 2, 1, "#dfd8d1");
      }
      drawing.restore();
      if (expeditions) paintExpeditions(drawing, panelY + panelHeight + 7, expeditions, textFont, numberFont, avatars);
    }
    textAt(drawing, footer, width / 2, bottom + 15, textFont, "#597487", 12, 18, "center");
  }

  function render(renderScale: number) {
    const zoom = 1.5 * renderScale;
    return renderPng(Math.round(width * zoom), Math.ceil(height * zoom), drawing => paint(drawing, zoom),
      mode, { renderScale, allowHalfScale: renderScale === 4 });
  }
  const fits = (image: PngRender) => inlineImageByteLimit === undefined || image.png.byteLength <= inlineImageByteLimit;
  const image = await render(scale);
  signal?.throwIfAborted();
  if (fits(image)) return image;
  if (scale === 4 && nativeImageRasterScale() === 4 && !image.reducedScaleReason) {
    const half = await render(2);
    signal?.throwIfAborted();
    if (fits(half)) return half;
  }
  throw new RangeError("体力卡超过当前会话的单图大小上限。");
}
