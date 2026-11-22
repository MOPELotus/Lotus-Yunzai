import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { loadImage, type CanvasRenderingContext2D as Context } from "skia-canvas";
import { drawInfoText, infoCardColors, type InfoCardOptions } from "./info-card.ts";
import { registerGachaThemeFont } from "./gacha-theme-fonts.ts";

const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const quantity = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

export interface GenshinSummaryCardOptions extends InfoCardOptions {
  readonly miaoResourceDirectory?: string;
}

const originalFonts = [
  ["Han", "HYWH-65W.ttf"], ["Number", "tttgbnumber.ttf"], ["Title", "NZBZ.ttf"],
] as const;
const registered = new Map<string, string>();

export async function genshinSummaryOptions({ miaoResourceDirectory, ...options }: GenshinSummaryCardOptions): Promise<InfoCardOptions> {
  if (!miaoResourceDirectory || options.typography) return options;
  const root = await realpath(miaoResourceDirectory).catch(() => undefined);
  if (!root) return options;
  const [han, number, title] = await Promise.all(originalFonts.map(async ([scope, filename]) => {
    const file = await realpath(join(root, "common", "font", filename)).catch(() => undefined);
    if (!file?.startsWith(root + sep)) return;
    const alias = registered.get(file);
    if (alias) return alias;
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile() || info.size <= 0 || info.size > 8 * 1024 * 1024) return;
    try {
      const loaded = registerGachaThemeFont(scope, file);
      registered.set(file, loaded);
      return loaded;
    } catch {
      return;
    }
  }));
  if (!han && !number && !title) return options;
  const fallback = '"LotusInfoText", "LotusInfoMiSans", sans-serif';
  return { ...options, typography: {
    body: [number, han, fallback].filter(Boolean).join(", "),
    title: [number, title, han, fallback].filter(Boolean).join(", "),
  } };
}

export function quantityText(value: number) {
  return quantity.format(value);
}

export function summaryBox(ctx: Context, x: number, y: number, width: number, height: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 12);
  ctx.fillStyle = infoCardColors.tile;
  ctx.fill();
}

export function summarySection(ctx: Context, heading: readonly string[], x: number, y: number, width: number) {
  drawInfoText(ctx, heading, x, y, { size: 22, leading: 32, color: infoCardColors.gold });
  ctx.fillStyle = infoCardColors.rule;
  ctx.fillRect(x, y + heading.length * 32 + 1, width, 1);
}

export async function summaryIcon(ctx: Context, source: Uint8Array | undefined, x: number, y: number, size: number,
  fallback: string) {
  let icon;
  if (source) {
    const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    if (bytes.subarray(0, 8).equals(pngSignature) ||
        bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
      icon = await loadImage(bytes).catch(() => undefined);
    }
  }
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, 10);
  ctx.clip();
  ctx.fillStyle = "rgba(12,26,42,.45)";
  ctx.fillRect(x, y, size, size);
  if (icon && icon.width > 0 && icon.height > 0) {
    const fit = (size - 6) / Math.max(icon.width, icon.height);
    const width = icon.width * fit;
    const height = icon.height * fit;
    ctx.drawImage(icon, x + (size - width) / 2, y + (size - height) / 2, width, height);
  } else {
    drawInfoText(ctx, [fallback], x + size / 2, y + (size - 15) / 2,
      { size: 15, color: infoCardColors.muted, align: "center" });
  }
  ctx.restore();
}
