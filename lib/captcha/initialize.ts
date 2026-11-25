import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
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
  const display = !onProgress && !report ? createInitializationProgress($t("lib.captcha.initialize.text_dff4df816a"), { signal }) : undefined;
  const emit = (event: CaptchaInitializationProgress, fallback: string) => {
    if (signal.aborted) return;
    try {
      if (onProgress) void Promise.resolve(onProgress(event)).catch(() => undefined);
      else if (report) report(fallback);
      else display?.update(event);
    } catch { /* A display failure does not invalidate a prepared model. */ }
  };
  try {
    emit({ stage: "captcha-models", message: $t("lib.captcha.initialize.text_e258f976db") },
      $t("lib.captcha.initialize.text_1586cd0d7a"));
    await prepare({ signal, modelsDirectory: fileURLToPath(new URL("data/captcha/models", root)),
      onProgress(progress) {
        if (signal.aborted) return;
        const { modelId, completed, total, stage, fileBytes, fileTotalBytes, cached } = progress;
        const ready = stage === "ready" || stage === undefined;
        const action = ready ? cached ? $t("lib.captcha.initialize.text_8b5b5bbe29") : $t("lib.captcha.initialize.text_ab27f80d04") : stage === "downloading" ? $t("lib.captcha.initialize.text_4673a23061") : stage === "verifying" ? $t("lib.captcha.initialize.text_41b0af8c5c") : $t("lib.captcha.initialize.text_73e98fe5a1");
        const position = ready ? completed : Math.min(total, completed + 1);
        const retry = progress.attempt ? $t("lib.captcha.initialize.text_ac34d6ccad", { "attempt": progress.attempt, "maxAttempts": progress.maxAttempts }) : "";
        const message = $t("lib.captcha.initialize.text_b0b2ab059f", { "position": position, "total": total, "modelId": modelId, "action": action, "retry": retry });
        const counters = ready ? { completed, total, unit: $t("lib.captcha.initialize.text_3a116815bc") } : fileTotalBytes !== undefined && fileBytes !== undefined
          ? { completed: fileBytes, total: fileTotalBytes, unit: "bytes" } : {};
        const suffix = !ready && fileBytes !== undefined && fileTotalBytes !== undefined
          ? ` ${bytes(fileBytes)}/${bytes(fileTotalBytes)}` : "";
        emit({ stage: `captcha-models:${modelId}:${stage ?? "ready"}`, message, ...counters }, $t("lib.captcha.initialize.text_ab7c22b604", { "message": message, "suffix": suffix }));
      },
    });
    signal.throwIfAborted();
    if (display) display.complete($t("lib.captcha.initialize.text_a57a523374"));
    else emit({ stage: "captcha-models", message: $t("lib.captcha.initialize.text_a57a523374") }, $t("lib.captcha.initialize.text_446b0231e6"));
  } catch (error) {
    display?.fail(signal.aborted ? $t("lib.captcha.initialize.text_e855bcfc86") : $t("lib.captcha.initialize.text_85f022c660"));
    throw error;
  } finally { display?.close(); }
}
