import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas, FontLibrary, loadImage, type CanvasRenderingContext2D as Context, type Image } from "skia-canvas";
import { renderPng, type PngRender } from "./index.ts";

export interface PassportQrCardModel {
  readonly qrPng: Uint8Array;
  readonly title?: string;
  readonly subtitle?: string;
  readonly profileId?: string | number;
  readonly notice?: string;
  readonly generatedAt?: string;
  /** 旧版调用字段。原模板不绘制角标。 */
  readonly badge?: string;
}

export interface PassportQrCardOptions {
  readonly mode?: "auto" | "gpu" | "cpu";
  readonly scale?: number;
  readonly resourceDirectory?: string;
}

// Lotus-ReFactor qr-login, drawn from the original Miao help index theme.
const width = 830;
const cardWidth = width - 30;
const textWidth = cardWidth - 40;
const qrSize = 360;
const white = "#fff";
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const defaultResources = fileURLToPath(new URL("../../data/passport/resources", import.meta.url));

async function loadTheme(directory: string) {
  const alias = createHash("sha256").update(directory).digest("hex").slice(0, 12);
  const body = `PassportQrBody${alias}`;
  const title = `PassportQrTitle${alias}`;
  const miSans = `PassportQrMiSans${alias}`;

  for (const [name, file] of [
    [body, "miao-theme/fonts/HYWH-65W.ttf"],
    [title, "source-templates/miao-stat/fonts/NZBZ.ttf"],
    [miSans, "fonts/MiSans-VF.ttf"],
  ] as const) {
    const fontPath = join(directory, file);
    if (!await Bun.file(fontPath).exists()) throw new Error(`登录卡原字体不可用：${file}`);
    FontLibrary.use(name, [fontPath]);
  }

  const themePath = join(directory, "source-templates/miao/common/theme");
  const [background, foreground] = await Promise.all([
    loadImage(join(themePath, "bg-01.jpg")),
    loadImage(join(themePath, "main-01.png")),
  ]);
  const textFont = `"${body}", "${miSans}", sans-serif`;
  return { background, foreground, textFont, titleFont: `"${title}", ${textFont}` };
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

function pngBytes(value: Uint8Array): Buffer {
  const png = Buffer.from(value);
  if (png.length < 33 || !png.subarray(0, pngSignature.length).equals(pngSignature) ||
      png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR" ||
      png.readUInt32BE(16) === 0 || png.readUInt32BE(20) === 0) {
    throw new Error("登录二维码须为有效 PNG 图片。");
  }
  return png;
}

function lines(ctx: Context, value: string, available: number, size: number, font: string) {
  ctx.font = `${size}px ${font}`;
  const text = value.replace(/\\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim();
  return text.split(/\r?\n/u).flatMap((paragraph) => {
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

function shape(ctx: Context, x: number, y: number, w: number, h: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
}

function rect(ctx: Context, x: number, y: number, w: number, h: number, color: string, radius = 0) {
  shape(ctx, x, y, w, h, radius);
  ctx.fillStyle = color;
  ctx.fill();
}

function textAt(ctx: Context, rows: readonly string[], x: number, y: number, font: string, size: number,
  leading: number, { color = white, center = false, shadow = false } = {}) {
  ctx.save();
  ctx.font = `${size}px ${font}`;
  ctx.textBaseline = "top";
  ctx.textAlign = center ? "center" : "left";
  ctx.fillStyle = color;
  if (shadow) {
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 1;
    ctx.shadowOffsetY = 1;
  }
  for (const [index, row] of rows.entries()) ctx.fillText(row, x, y + index * leading);
  ctx.restore();
}

function paintImage(ctx: Context, img: Image, x: number, y: number, w: number, h: number, cover = false) {
  const scale = (cover ? Math.max : Math.min)(w / img.width, h / img.height);
  const drawnWidth = img.width * scale;
  const drawnHeight = img.height * scale;
  ctx.drawImage(img, x + (w - drawnWidth) / 2, y + (h - drawnHeight) / 2, drawnWidth, drawnHeight);
}

export async function renderPassportQrCard(model: PassportQrCardModel,
  { mode = "auto", scale = 4, resourceDirectory = defaultResources }: PassportQrCardOptions = {}): Promise<PngRender> {
  if (!Number.isFinite(scale) || scale < 1 || scale > 4) throw new RangeError("登录卡缩放比例须在 1 至 4 之间。");

  const png = pngBytes(model.qrPng);
  const { background, foreground, textFont, titleFont } = await themeAt(await realpath(resourceDirectory));
  const qr = await loadImage(png);
  const metrics = new Canvas(1, 1).getContext("2d");
  const title = lines(metrics, model.title || "扫码登录", textWidth, 50, titleFont);
  const subtitle = lines(metrics, model.subtitle || `profile ${model.profileId || 1}`, textWidth, 16, textFont);
  const notice = lines(metrics, model.notice || "请使用对应 App 扫码确认。", textWidth, 16, textFont);
  const footer = lines(metrics, `Lotus-Yunzai${model.generatedAt ? ` · ${model.generatedAt}` : ""}`, width - 30, 12, textFont);

  const headerHeight = title.length * 60 + subtitle.length * 24 + 41;
  const panelTop = 38 + headerHeight;
  const panelHeight = qrSize + notice.length * 24 + 98;
  const bottom = panelTop + panelHeight + 15;
  const height = Math.max(240, bottom + 50);
  const zoom = 720 / width * scale;

  return renderPng(Math.round(width * zoom), Math.ceil(height * zoom), (ctx) => {
    ctx.scale(zoom, zoom);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    rect(ctx, 0, 0, width, 100000, "#243344");
    paintImage(ctx, background, 0, 0, width, 1200, true);
    paintImage(ctx, foreground, 0, 0, width, 800);

    ctx.save();
    shape(ctx, 15, 38, cardWidth, headerHeight + panelHeight, 15);
    ctx.clip();
    rect(ctx, 15, 38, cardWidth, headerHeight, "rgba(15,20,31,.78)");
    textAt(ctx, title, 35, 54, titleFont, 50, 60, { shadow: true });
    textAt(ctx, subtitle, 35, 59 + title.length * 60, textFont, 16, 24, { shadow: true });
    rect(ctx, 15, panelTop, cardWidth, panelHeight, "rgba(0,0,0,.50)");
    rect(ctx, 15, panelTop, cardWidth, 48, "rgba(0,0,0,.40)");
    textAt(ctx, ["扫码确认"], 35, panelTop + 15, textFont, 18, 27, { color: "#d3bc8e" });
    rect(ctx, (width - qrSize) / 2 - 12, panelTop + 60, qrSize + 24, qrSize + 24, white, 5);
    paintImage(ctx, qr, (width - qrSize) / 2, panelTop + 72, qrSize, qrSize);
    textAt(ctx, notice, 35, panelTop + qrSize + 90, textFont, 16, 24);
    ctx.restore();
    textAt(ctx, footer, width / 2, bottom + 15, textFont, 12, 18, { center: true, shadow: true });
  }, mode);
}
