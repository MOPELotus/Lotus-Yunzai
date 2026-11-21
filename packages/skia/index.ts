import { Canvas, type CanvasRenderingContext2D, type EngineDetails } from "skia-canvas";
import { encodeBandedPng, ImageSizeLimitError } from "./banded-png.ts";
import { markGeneratedImage } from "./generated-image.ts";

export { ImageSizeLimitError };

type RenderMode = "auto" | "gpu" | "cpu";
type Draw = (context: CanvasRenderingContext2D) => void | Promise<void>;
const singleSurfaceDimension = 32_768;
const maxImagePixels = 256_000_000;
const maxImageDimension = 1_048_576;
const tileSize = 8_192;
const bleed = 128;
const bandBudgetBytes = 32 * 1024 * 1024;
let pendingBandedRender = Promise.resolve();

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

async function render(width: number, height: number, draw: Draw, mode: "gpu" | "cpu"): Promise<PngRender> {
  let canvas: Canvas;
  let context: CanvasRenderingContext2D;
  try {
    canvas = new Canvas(width, height);
    canvas.gpu = mode === "gpu";
    context = canvas.getContext("2d");
    checkEngine(canvas, mode);
  } catch (error) {
    if (error instanceof BackendError) throw error;
    throw new BackendError(`无法初始化 Skia ${mode.toUpperCase()} 后端。`, { cause: error });
  }

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

async function renderByBackend(width: number, height: number, draw: Draw, mode: RenderMode): Promise<PngRender> {
  if (mode !== "auto") return render(width, height, draw, mode);

  try {
    return await render(width, height, draw, "gpu");
  } catch (error) {
    if (!(error instanceof BackendError)) throw error;
    console.warn(`[渲染] ${error.message} 改用 Skia CPU 后端。`);
    return { ...await render(width, height, draw, "cpu"), fallbackReason: error.message };
  }
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

/** 绘制回调应可重试。只有按 4× 请求的业务调用方才应允许减半。 */
export async function renderPng(width: number, height: number, draw: Draw, mode: RenderMode = "auto",
  { allowHalfScale = false }: { readonly allowHalfScale?: boolean } = {}): Promise<PngRender> {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RangeError("画布尺寸须为正整数。");
  }
  try {
    return await renderByMode(width, height, draw, mode);
  } catch (error) {
    if (!allowHalfScale || !(error instanceof BackendError || error instanceof ImageSizeLimitError)) throw error;
    const reduced = await renderByMode(Math.ceil(width / 2), Math.ceil(height / 2), context => {
      context.scale(0.5, 0.5);
      return draw(context);
    }, mode);
    return { ...reduced, reducedScaleReason: error.message };
  }
}
