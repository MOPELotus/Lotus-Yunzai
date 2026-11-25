import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("skia", messageCatalog.messages);
import { prepareBuiltinFonts } from "./builtin-fonts.ts";
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
    throw new BackendError(engine.error || $t("index.text_87b1797b93"));
  }
  if (mode === "cpu" && engine.renderer !== "CPU") {
    throw new BackendError($t("index.text_2f7faeefc0"));
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
        if (raw.length !== tileWidth * tileHeight * 4) throw new Error($t("index.text_588387e089"));
      } catch (error) {
        if (error instanceof BackendError) throw error;
        throw new BackendError($t("index.text_121da2c6b1", { "value1": mode.toUpperCase() }), { cause: error });
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
  prepareBuiltinFonts();
  try {
    const canvas = new Canvas(width, height);
    canvas.gpu = mode === "gpu";
    const context = canvas.getContext("2d");
    checkEngine(canvas, mode);
    return { canvas, context };
  } catch (error) {
    if (error instanceof BackendError) throw error;
    throw new BackendError($t("index.text_722e85b72f", { "value1": mode.toUpperCase() }), { cause: error });
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
    throw new BackendError($t("index.text_8520a16020", { "value1": mode.toUpperCase() }), { cause: error });
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
    console.warn($t("index.text_03494cc773", { "message": error.message }));
    return { ...await draw("cpu"), fallbackReason: error.message };
  }
}

function renderByBackend(width: number, height: number, draw: Draw, mode: RenderMode): Promise<PngRender> {
  return withBackend(mode, (backend) => render(width, height, draw, backend));
}

function renderByMode(width: number, height: number, draw: Draw, mode: RenderMode): Promise<PngRender> {
  if (width > maxImageDimension || height > maxImageDimension || width > Math.floor(maxImagePixels / height)) {
    throw new ImageSizeLimitError($t("index.text_d4b5f4ba17"));
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
    throw new ImageSizeLimitError($t("index.text_d0d3691df5"));
  }

  return withBackend(mode, async (backend) => {
    const { canvas, context } = createSurface(width, height, backend);
    await draw(context);
    let rgba: Buffer;
    try {
      rgba = await canvas.toBuffer("raw", { colorType: "rgba", premultiplied: false });
      if (rgba.byteLength !== width * height * 4) throw new Error($t("index.text_fccec90d21"));
    } catch (error) {
      throw new BackendError($t("index.text_f6bae4175a", { "value1": backend.toUpperCase() }), { cause: error });
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
    throw new RangeError($t("index.text_8ddca93a07"));
  }
}

/** 中间合成图保持指定像素尺寸，最终出图由调用方应用倍率。 */
export function renderExactPng(width: number, height: number, draw: Draw, mode: RenderMode = "auto") {
  requirePositivePixels(width, height);
  return renderByMode(width, height, draw, mode);
}

/** renderScale 声明画布尺寸与绘制回调已应用的倍率，默认按 4× 请求处理。 */
export async function renderPng(width: number, height: number, draw: Draw, mode: RenderMode = "auto",
  { allowHalfScale = false, renderScale = 4 }: { readonly allowHalfScale?: boolean; readonly renderScale?: number } = {}): Promise<PngRender> {
  requirePositivePixels(width, height);
  if (!Number.isFinite(renderScale) || renderScale < 1 || renderScale > 4) {
    throw new RangeError($t("index.text_fd927083c4"));
  }
  const initialScale = Math.min(1, nativeImageRasterScale() / renderScale);
  const renderAt = (scale: number) => renderByMode(Math.ceil(width * scale), Math.ceil(height * scale),
    scale === 1 ? draw : context => {
      context.scale(scale, scale);
      return draw(context);
    }, mode);
  try {
    return await renderAt(initialScale);
  } catch (error) {
    if (!allowHalfScale || renderScale !== 4 || initialScale !== 1 ||
        !(error instanceof BackendError || error instanceof ImageSizeLimitError)) throw error;
    const reduced = await renderAt(initialScale / 2);
    return { ...reduced, reducedScaleReason: error.message };
  }
}
