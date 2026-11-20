import { Canvas, type CanvasRenderingContext2D, type EngineDetails } from "skia-canvas";

type RenderMode = "auto" | "gpu" | "cpu";
type Draw = (context: CanvasRenderingContext2D) => void | Promise<void>;

export interface PngRender {
  readonly png: Buffer;
  readonly engine: EngineDetails;
  readonly fallbackReason?: string;
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

  let png: Buffer;
  try {
    png = await canvas.toBuffer("png", { filters: "auto" });
  } catch (error) {
    throw new BackendError(`Skia ${mode.toUpperCase()} 编码 PNG 失败。`, { cause: error });
  }
  return { png, engine: checkEngine(canvas, mode) };
}

/** 绘制回调应可重试，自动模式可能在另一画布重新绘制。 */
export async function renderPng(width: number, height: number, draw: Draw, mode: RenderMode = "auto"): Promise<PngRender> {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new RangeError("画布尺寸须为正整数。");
  }
  if (mode !== "auto") return render(width, height, draw, mode);

  try {
    return await render(width, height, draw, "gpu");
  } catch (error) {
    if (!(error instanceof BackendError)) throw error;
    console.warn(`[渲染] ${error.message} 改用 Skia CPU 后端。`);
    return { ...await render(width, height, draw, "cpu"), fallbackReason: error.message };
  }
}
