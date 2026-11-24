import { fileURLToPath } from "node:url";
import type { CaptchaModelProgress } from "@lotus-yunzai/captcha";
import { createInitializationProgress } from "../initialization-progress.ts";

export interface CaptchaInitializationProgress {
  readonly stage: string;
  readonly message: string;
  readonly completed?: number;
  readonly total?: number;
  readonly unit?: string;
}
type Preparation = (options: {
  signal: AbortSignal;
  modelsDirectory: string;
  onProgress: (progress: CaptchaModelProgress) => void;
}) => Promise<unknown>;

function bytes(value: number) {
  return value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB`
    : `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Called only by whole-environment initialization, never by a business request. */
export async function initializeCaptchaModels(root: URL, signal: AbortSignal, {
  prepare = async options => (await import("@lotus-yunzai/captcha")).prepareCaptchaModels(options),
  report, onProgress,
}: { readonly prepare?: Preparation; readonly report?: (message: string) => void;
  readonly onProgress?: (progress: CaptchaInitializationProgress) => unknown } = {}) {
  signal.throwIfAborted();
  const display = !onProgress && !report ? createInitializationProgress("验证码模型", { signal }) : undefined;
  const emit = (event: CaptchaInitializationProgress, fallback: string) => {
    if (signal.aborted) return;
    try {
      if (onProgress) void Promise.resolve(onProgress(event)).catch(() => undefined);
      else if (report) report(fallback);
      else display?.update(event);
    } catch { /* A display failure does not invalidate a prepared model. */ }
  };
  try {
    emit({ stage: "captcha-models", message: "正在检查本地验证码模型，下载并校验缺失文件。" },
      "[初始化] 正在检查本地验证码模型，下载并校验缺失文件。");
    await prepare({ signal, modelsDirectory: fileURLToPath(new URL("data/captcha/models", root)),
      onProgress(progress) {
        if (signal.aborted) return;
        const { modelId, completed, total, stage, fileBytes, fileTotalBytes, cached } = progress;
        const ready = stage === "ready" || stage === undefined;
        const action = ready ? cached ? "缓存已校验" : "已就绪" : stage === "downloading" ? "下载" : stage === "verifying" ? "校验" : "检查缓存";
        const position = ready ? completed : Math.min(total, completed + 1);
        const retry = progress.attempt ? `（尝试 ${progress.attempt}/${progress.maxAttempts}）` : "";
        const message = `验证码模型 ${position}/${total}：${modelId} · ${action}${retry}`;
        const counters = ready ? { completed, total, unit: "个" } : fileTotalBytes !== undefined && fileBytes !== undefined
          ? { completed: fileBytes, total: fileTotalBytes, unit: "bytes" } : {};
        const suffix = !ready && fileBytes !== undefined && fileTotalBytes !== undefined
          ? ` ${bytes(fileBytes)}/${bytes(fileTotalBytes)}` : "";
        emit({ stage: `captcha-models:${modelId}:${stage ?? "ready"}`, message, ...counters }, `[初始化] ${message}${suffix}`);
      },
    });
    signal.throwIfAborted();
    if (display) display.complete("本地验证码模型已就绪。");
    else emit({ stage: "captcha-models", message: "本地验证码模型已就绪。" }, "[初始化] 本地验证码模型已就绪。");
  } catch (error) {
    display?.fail(signal.aborted ? "本地验证码模型准备已中止。" : "本地验证码模型准备失败。");
    throw error;
  } finally { display?.close(); }
}
