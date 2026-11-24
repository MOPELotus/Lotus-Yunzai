import { fileURLToPath } from "node:url";

type Preparation = (options: {
  signal: AbortSignal;
  modelsDirectory: string;
  onProgress: (progress: { modelId: string; completed: number; total: number }) => void;
}) => Promise<unknown>;

/** Called only by whole-environment initialization, never by a business request. */
export async function initializeCaptchaModels(root: URL, signal: AbortSignal, {
  prepare = async options => (await import("@lotus-yunzai/captcha")).prepareCaptchaModels(options),
  report = (message: string) => console.info(message),
}: { readonly prepare?: Preparation; readonly report?: (message: string) => void } = {}) {
  signal.throwIfAborted();
  report("[初始化] 正在检查本地验证码模型，下载并校验缺失文件。");
  await prepare({ signal, modelsDirectory: fileURLToPath(new URL("data/captcha/models", root)),
    onProgress({ modelId, completed, total }) {
      if (!signal.aborted) report(`[初始化] 验证码模型 ${completed}/${total}：${modelId}`);
    },
  });
  signal.throwIfAborted();
  report("[初始化] 本地验证码模型已就绪。");
}
