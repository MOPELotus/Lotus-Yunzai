export interface ResourceProgress {
  readonly stage: string;
  readonly message: string;
  readonly completed?: number;
  readonly total?: number;
  readonly unit?: string;
}
export type ResourceProgressCallback = (progress: ResourceProgress) => unknown;
export function reportResourceProgress(callback: ResourceProgressCallback | undefined, signal: AbortSignal | undefined,
  stage: string, message: string, completed?: number, total?: number, unit = "项") {
  if (signal?.aborted) return;
  try {
    const result = callback?.({ stage, message, ...(completed !== undefined && { completed }), ...(total !== undefined && { total }), unit });
    if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).catch(() => undefined);
  } catch { /* Progress must not alter resource preparation. */ }
}
