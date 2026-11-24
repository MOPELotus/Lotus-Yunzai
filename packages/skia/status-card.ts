import { builtinFontFallback, prepareBuiltinFonts } from "./builtin-fonts.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPng, type PngRender } from "./index.ts";
import { Canvas, FontLibrary, loadImage, type CanvasRenderingContext2D as Context } from "skia-canvas";

export interface StatusCardOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
  readonly themeDirectory?: string;
  readonly timeZone?: string;
}

// Miao help/version-info, as drawn by Lotus-ReFactor's Skia status template.
const width = 600;
const panelWidth = 575;
const font = `"LotusStatusBody", "LotusStatusMiSans", ${builtinFontFallback}`;
const defaultTheme = fileURLToPath(new URL("../../data/atlas/theme", import.meta.url));

async function loadTheme(directory: string) {
  prepareBuiltinFonts();
  for (const [family, file] of [
    ["LotusStatusBody", "HYWH-65W.ttf"], ["LotusStatusMiSans", "MiSans-VF.ttf"],
  ] as const) {
    const direct = join(directory, "fonts", file);
    const candidates = file === "MiSans-VF.ttf" ? [direct, join(dirname(directory), "fonts", file)] : [direct];
    for (const filename of candidates) {
      if (!await Bun.file(filename).exists()) continue;
      FontLibrary.use(family, [filename]);
      break;
    }
  }
  return loadImage(join(directory, "bg", "bg-hydro.webp")).catch(() => undefined);
}

const themes = new Map<string, ReturnType<typeof loadTheme>>();

function themeImage(directory: string) {
  let image = themes.get(directory);
  if (!image) {
    image = loadTheme(directory);
    themes.set(directory, image);
  }
  return image;
}

function lines(ctx: Context, value: string, maxWidth: number, size: number) {
  ctx.font = `${size}px ${font}`;
  return value.split(/\r?\n/u).flatMap((text) => {
    const rows: string[] = [];
    let row = "";
    function add(token: string) {
      if (row && ctx.measureText(row + token).width > maxWidth) {
        rows.push(row);
        row = "";
      }
      row += token;
    }
    for (const token of text.match(/[-+]?\d+(?:\.\d+)?%?|[A-Za-z][A-Za-z0-9.-]*|./gu) ?? []) {
      if (ctx.measureText(token).width > maxWidth) Array.from(token).forEach(add);
      else add(token);
    }
    rows.push(row);
    return rows;
  });
}

function paintText(ctx: Context, rows: readonly string[], x: number, y: number,
  size: number, leading: number, color: string) {
  ctx.font = `${size}px ${font}`;
  ctx.textBaseline = "top";
  ctx.fillStyle = color;
  for (const [index, row] of rows.entries()) ctx.fillText(row, x, y + index * leading);
}

function localTime(date: Date, timeZone?: string) {
  if (timeZone) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
    const read = (key: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === key)?.value ?? "";
    return `${read("year")}-${read("month")}-${read("day")} ${read("hour")}:${read("minute")}:${read("second")}`;
  }
  const pad = (number: number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export async function renderStatusCard(title: string, lead: string, contents: readonly string[], at: Date,
  { mode = "auto", scale = 4, themeDirectory = Bun.env.LOTUS_ATLAS_THEME_DIR?.trim() || defaultTheme,
    timeZone }: StatusCardOptions = {}): Promise<PngRender> {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("抽卡卡片缩放比例须在 1 至 4 之间。");
  const background = await themeImage(themeDirectory);
  const metrics = new Canvas(1, 1);
  metrics.gpu = false;
  const measure = metrics.getContext("2d");
  const heading = lines(measure, title, panelWidth - 40, 20);
  const headingHeight = heading.length * 28 + 16;
  const rows = [lead, ...contents].map((value) => lines(measure, value, panelWidth - 65, 14));
  const panelHeight = headingHeight + rows.reduce((sum, row) => sum + row.length * 22 + 8, 0) + 20;
  const height = Math.max(240, 20 + panelHeight + 10 + 50);
  const zoom = (720 / width) * scale;
  const pixelWidth = Math.round(width * zoom);
  const pixelHeight = Math.ceil(height * zoom);
  return renderPng(pixelWidth, pixelHeight, (ctx) => {
    ctx.fillStyle = "#243344";
    ctx.fillRect(0, 0, pixelWidth, pixelHeight);
    ctx.scale(zoom, zoom);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (background) ctx.drawImage(background, 0, 0, width, height);

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(10, 20, panelWidth, panelHeight, 10);
    ctx.clip();
    ctx.fillStyle = "rgba(0,0,0,.50)";
    ctx.fillRect(10, 20, panelWidth, panelHeight);
    ctx.fillStyle = "rgba(0,0,0,.40)";
    ctx.fillRect(10, 20, panelWidth, headingHeight);
    paintText(ctx, heading, 30, 30, 20, 28, "#d3bc8e");
    let y = 20 + headingHeight + 10;
    for (const row of rows) {
      paintText(ctx, ["•"], 30, y, 14, 21, "#fff");
      paintText(ctx, row, 50, y, 14, 22, "#fff");
      y += row.length * 22 + 8;
    }
    ctx.restore();

    ctx.textAlign = "center";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
    paintText(ctx, [`Lotus-Yunzai · ${localTime(at, timeZone)}`], 300, 20 + panelHeight + 25, 12, 18, "#fff");
  }, mode, { renderScale: scale, allowHalfScale: scale === 4 });
}
