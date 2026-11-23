import { Canvas, loadImage, type CanvasRenderingContext2D, type EngineDetails } from "skia-canvas";
import { encodeBandedPng, ImageSizeLimitError } from "./banded-png.ts";
import { markGeneratedImage } from "./generated-image.ts";

export { ImageSizeLimitError };

type RenderMode = "auto" | "gpu" | "cpu";
type ImageRenderPreset = "standard" | "low";
type Draw = (context: CanvasRenderingContext2D) => void | Promise<void>;
const singleSurfaceDimension = 32_768;
const maxImagePixels = 256_000_000;
const maxImageDimension = 1_048_576;
const tileSize = 8_192;
const bleed = 128;
const bandBudgetBytes = 32 * 1024 * 1024;
let pendingBandedRender = Promise.resolve();
let imageRenderPreset: ImageRenderPreset = "standard";

export function setImageRenderPreset(value: unknown): void {
  imageRenderPreset = value === "low" ? "low" : "standard";
}

export function nativeImageRasterScale(): 1 | 4 {
  return imageRenderPreset === "low" ? 1 : 4;
}

export interface PngRender {
  readonly png: Buffer;
  readonly engine: EngineDetails;
  readonly fallbackReason?: string;
  readonly reducedScaleReason?: string;
}

class BackendError extends Error {}

function checkEngine(canvas: Canvas, mode: "gpu" | "cpu"): EngineDetails {
  const engine = canvas.engine;
  if (mode === "gpu" &&
      (engine.renderer !== "GPU" || !engine.device || /llvmpipe|lavapipe|swiftshader|software/iu.test(engine.device))) {
    throw new BackendError(engine.error || "Skia 未启用物理 GPU。");
  }
  if (mode === "cpu" && engine.renderer !== "CPU") {
    throw new BackendError("Skia 未启用 CPU 后端。");
  }
  return engine;
}

async function* readBands(canvas: Canvas, width: number, height: number, mode: "gpu" | "cpu") {
  const stride = width * 4;
  const bandHeight = Math.max(1, Math.min(tileSize, Math.floor(bandBudgetBytes / stride)));
  for (let top = 0; top < height; top += bandHeight) {
    const rows = Math.min(bandHeight, height - top);
    const above = Math.min(top, bleed);
    const below = Math.min(height - top - rows, bleed);
    const band = Buffer.allocUnsafe(stride * rows);
    for (let left = 0; left < width; left += tileSize) {
      const columns = Math.min(tileSize, width - left);
      const before = Math.min(left, bleed);
      const after = Math.min(width - left - columns, bleed);
      const tileWidth = columns + before + after;
      const tileHeight = rows + above + below;
      let raw: Buffer;
      try {
        const tile = new Canvas(tileWidth, tileHeight);
        tile.gpu = mode === "gpu";
        tile.getContext("2d").drawCanvas(canvas, before - left, above - top);
        raw = await tile.toBuffer("raw", { colorType: "rgba", premultiplied: false });
        checkEngine(tile, mode);
        if (raw.length !== tileWidth * tileHeight * 4) throw new Error("图像分带的像素尺寸不匹配。");
      } catch (error) {
        if (error instanceof BackendError) throw error;
        throw new BackendError(`Skia ${mode.toUpperCase()} 分带导出失败。`, { cause: error });
      }
      for (let row = 0; row < rows; row++) {
        const input = ((above + row) * tileWidth + before) * 4;
        raw.copy(band, row * stride + left * 4, input, input + columns * 4);
      }
    }
    yield band;
  }
}

function createSurface(width: number, height: number, mode: "gpu" | "cpu") {
  try {
    const canvas = new Canvas(width, height);
    canvas.gpu = mode === "gpu";
    const context = canvas.getContext("2d");
    checkEngine(canvas, mode);
    return { canvas, context };
  } catch (error) {
    if (error instanceof BackendError) throw error;
    throw new BackendError(`无法初始化 Skia ${mode.toUpperCase()} 后端。`, { cause: error });
  }
}

async function render(width: number, height: number, draw: Draw, mode: "gpu" | "cpu"): Promise<PngRender> {
  const { canvas, context } = createSurface(width, height, mode);
  await draw(context);
  if (width > singleSurfaceDimension || height > singleSurfaceDimension) {
    // Keep the full drawing coordinate space, then replay the recorded drawing on bounded surfaces.
    const png = await encodeBandedPng(width, height, readBands(canvas, width, height, mode));
    return { png: markGeneratedImage(png), engine: checkEngine(canvas, mode) };
  }

  let png: Buffer;
  try {
    png = await canvas.toBuffer("png", { filters: "auto" });
  } catch (error) {
    throw new BackendError(`Skia ${mode.toUpperCase()} 编码 PNG 失败。`, { cause: error });
  }
  const engine = checkEngine(canvas, mode);
  return { png: markGeneratedImage(png), engine };
}

async function withBackend<T extends object>(
  mode: RenderMode,
  draw: (backend: "gpu" | "cpu") => Promise<T>,
): Promise<T & { fallbackReason?: string }> {
  if (mode !== "auto") return draw(mode);

  try {
    return await draw("gpu");
  } catch (error) {
    if (!(error instanceof BackendError)) throw error;
    console.warn(`[渲染] ${error.message} 改用 Skia CPU 后端。`);
    return { ...await draw("cpu"), fallbackReason: error.message };
  }
}

function renderByBackend(width: number, height: number, draw: Draw, mode: RenderMode): Promise<PngRender> {
  return withBackend(mode, (backend) => render(width, height, draw, backend));
}

function renderByMode(width: number, height: number, draw: Draw, mode: RenderMode): Promise<PngRender> {
  if (width > maxImageDimension || height > maxImageDimension || width > Math.floor(maxImagePixels / height)) {
    throw new ImageSizeLimitError("画布单边超过 1,048,576 像素，或总像素超过 2.56 亿。");
  }
  if (width <= singleSurfaceDimension && height <= singleSurfaceDimension) return renderByBackend(width, height, draw, mode);
  // GPU readbacks for oversized cards use one set of bounded surfaces at a time per process.
  const next = pendingBandedRender.then(() => renderByBackend(width, height, draw, mode));
  pendingBandedRender = next.then(() => {}, () => {});
  return next;
}

/** 为动图编码器导出固定像素尺寸的非预乘 RGBA 帧。 */
export async function renderRgba(width: number, height: number, draw: Draw, mode: RenderMode = "auto") {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 ||
      width > 8_192 || height > 8_192 || width * height > 24_000_000) {
    throw new ImageSizeLimitError("RGBA 帧单边须在 8,192 像素内，总像素须在 2,400 万内。");
  }

  return withBackend(mode, async (backend) => {
    const { canvas, context } = createSurface(width, height, backend);
    await draw(context);
    let rgba: Buffer;
    try {
      rgba = await canvas.toBuffer("raw", { colorType: "rgba", premultiplied: false });
      if (rgba.byteLength !== width * height * 4) throw new Error("RGBA 帧像素尺寸不匹配。");
    } catch (error) {
      throw new BackendError(`Skia ${backend.toUpperCase()} 导出 RGBA 帧失败。`, { cause: error });
    }
    return { rgba, engine: checkEngine(canvas, backend) };
  });
}

/** 缩略图采用固定的像素边长，不随聊天图片倍率缩小。 */
export async function renderRasterThumbnail(bytes: Buffer, maxSide: number, maxPixels: number, mode: RenderMode = "auto") {
  const image = await loadImage(bytes).catch(() => undefined);
  if (!image?.width || !image.height || image.width * image.height > maxPixels) return;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(scale * image.width));
  const height = Math.max(1, Math.round(scale * image.height));
  return renderByBackend(width, height, context => context.drawImage(image, 0, 0, width, height), mode);
}

function requirePositivePixels(width: number, height: number) {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RangeError("画布尺寸须为正整数。");
  }
}

/** 中间合成图保持指定像素尺寸，最终出图由调用方应用倍率。 */
export function renderExactPng(width: number, height: number, draw: Draw, mode: RenderMode = "auto") {
  requirePositivePixels(width, height);
  return renderByMode(width, height, draw, mode);
}

/** 绘制回调应可重试。只有按 4× 请求的业务调用方才应允许减半。 */
export async function renderPng(width: number, height: number, draw: Draw, mode: RenderMode = "auto",
  { allowHalfScale = false }: { readonly allowHalfScale?: boolean } = {}): Promise<PngRender> {
  requirePositivePixels(width, height);
  const initialScale = nativeImageRasterScale() / 4;
  const renderAt = (scale: number) => renderByMode(Math.ceil(width * scale), Math.ceil(height * scale),
    scale === 1 ? draw : context => {
      context.scale(scale, scale);
      return draw(context);
    }, mode);
  try {
    return await renderAt(initialScale);
  } catch (error) {
    if (!allowHalfScale || !(error instanceof BackendError || error instanceof ImageSizeLimitError)) throw error;
    const reduced = await renderAt(initialScale / 2);
    return { ...reduced, reducedScaleReason: error.message };
  }
}
