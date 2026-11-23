import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas, FontLibrary, loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { renderPng, type PngRender } from "./index.ts";

type Game = "gs" | "sr" | "zzz";
type TextValue = string | number | null;

export interface DailyNoteCardDetail {
  readonly label: string;
  readonly value?: TextValue;
  readonly note?: string;
}

export interface DailyNoteCardItem {
  readonly game?: Game | "";
  readonly gameName?: string;
  readonly uid?: string | number;
  readonly ok: boolean;
  readonly detail?: string;
  readonly details?: readonly DailyNoteCardDetail[];
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
  const recovery = item.detail?.split(" · ").find((part) => /^(回满|已回满)/u.test(part));
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

export async function renderDailyNoteCard(model: DailyNoteCardModel,
  { mode = "auto", scale = 4, resourceDirectory = defaultResources }: DailyNoteCardOptions = {}): Promise<PngRender> {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("体力卡缩放比例须在 1 至 4 之间。");

  const { images, textFont, numberFont } = await themeAt(await realpath(resourceDirectory));
  const ctx = new Canvas(1, 1).getContext("2d");
  let bottom = 12;
  const sections = model.groups.flatMap(({ name, items }) => items.map((item) => {
    const game = item.gameName || item.game;
    const heading = game ? `${name} · ${game} · UID ${item.uid || "未同步"}` : name;
    const title = singleLine(ctx, heading, width - 42, numberFont, 16, 12);
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
    return { title, headingY, panelY, panelHeight, rows };
  }));
  const footer = lines(ctx, `Lotus-Yunzai${model.generatedAt ? ` · ${model.generatedAt}` : ""}`, width - 30, 12, textFont);
  const height = Math.max(240, bottom + 50);
  const zoom = 1.5 * scale;

  return renderPng(Math.round(width * zoom), Math.ceil(height * zoom), (drawing) => {
    drawing.scale(zoom, zoom);
    drawing.imageSmoothingEnabled = true;
    drawing.imageSmoothingQuality = "high";
    rect(drawing, 0, 0, width, 100000, "#f0eae3");
    for (const { title, headingY, panelY, panelHeight, rows } of sections) {
      rect(drawing, inset, headingY - 3, 5, 24, "#d3bc8d", 1);
      textAt(drawing, [title.text], 26, headingY, numberFont, "#504c49", title.size, title.size * 1.5);
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
    }
    textAt(drawing, footer, width / 2, bottom + 15, textFont, "#597487", 12, 18, "center");
  }, mode, { renderScale: scale, allowHalfScale: scale === 4 });
}
