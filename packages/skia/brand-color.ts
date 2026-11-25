import type { CanvasRenderingContext2D as Context } from "skia-canvas";

type BrandColor = "#000" | "#fff";
const maxReadPixels = 262_144; // At most 1 MiB RGBA, restricted to the actual signature bounds.
const threshold = Math.sqrt(1.05 * .05) - .05;
const linear = (value: number) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;

/** Read the background underneath this text, before drawing it. Font/alignment must already be selected. */
export function brandTextColor(ctx: Context, value: string, x: number, y: number,
  maxWidth?: number, fallback: BrandColor = "#fff"): BrandColor {
  try {
    const metrics = ctx.measureText(value, maxWidth);
    const left = x - metrics.actualBoundingBoxLeft, right = x + metrics.actualBoundingBoxRight;
    const top = y - metrics.actualBoundingBoxAscent, bottom = y + metrics.actualBoundingBoxDescent;
    if (![left, right, top, bottom].every(Number.isFinite) || right <= left || bottom <= top) return fallback;
    const matrix = ctx.getTransform();
    const points = [[left, top], [right, top], [left, bottom], [right, bottom]].map(([px, py]) => ({
      x: matrix.a * px! + matrix.c * py! + matrix.e,
      y: matrix.b * px! + matrix.d * py! + matrix.f,
    }));
    let x0 = Math.max(0, Math.floor(Math.min(...points.map(p => p.x))));
    let y0 = Math.max(0, Math.floor(Math.min(...points.map(p => p.y))));
    let width = Math.min(ctx.canvas.width, Math.ceil(Math.max(...points.map(p => p.x)))) - x0;
    let height = Math.min(ctx.canvas.height, Math.ceil(Math.max(...points.map(p => p.y)))) - y0;
    if (width < 1 || height < 1) return fallback;
    if (width * height > maxReadPixels) {
      const ratio = Math.sqrt(maxReadPixels / (width * height));
      const w = Math.max(1, Math.floor(width * ratio)), h = Math.max(1, Math.floor(height * ratio));
      x0 += Math.floor((width - w) / 2); y0 += Math.floor((height - h) / 2);
      width = w; height = h;
    }
    const { data } = ctx.getImageData(x0, y0, width, height);
    const step = Math.max(1, Math.floor(data.length / 4 / 4096));
    let luminance = 0, count = 0;
    for (let offset = 0; offset + 3 < data.length; offset += step * 4) {
      const alpha = data[offset + 3]! / 255;
      const channel = (value: number) => linear(value / 255 * alpha + 1 - alpha);
      luminance += .2126 * channel(data[offset]!) + .7152 * channel(data[offset + 1]!) + .0722 * channel(data[offset + 2]!);
      count++;
    }
    return count ? luminance / count >= threshold ? "#000" : "#fff" : fallback;
  } catch {
    return fallback;
  }
}
