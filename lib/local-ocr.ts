import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { isAbsolute } from "node:path";
import { devNull } from "node:os";
import { fileURLToPath } from "node:url";

type RunResult = { status: "ok"; output: string } | { status: "failed" | "timeout" | "cancelled" | "missing-engine" | "missing-model" };

export const localOcrImageBytes = 8 * 1024 * 1024;
export const localOcrOutputBytes = 32 * 1024;
const missingEngine = $t("lib.local-ocr.text_26c653646b");
const missingModel = $t("lib.local-ocr.text_7b42d5bc2d");
const worker = fileURLToPath(new URL("./local-ocr-worker.ts", import.meta.url));

async function runLocalOcr(image: Uint8Array | undefined, signal: AbortSignal,
  timeoutMs: number, env: NodeJS.ProcessEnv): Promise<RunResult> {
  if (signal.aborted) return { status: "cancelled" };

  let child: Bun.Subprocess<"ignore" | Uint8Array, "pipe", "ignore">;
  try {
    child = Bun.spawn([process.execPath, "--no-env-file", "--config=" + devNull, "--no-install",
      worker, image === undefined ? "prepare" : "recognize"], {
      stdin: image ?? "ignore", stdout: "pipe", stderr: "ignore", env,
    });
  } catch { return { status: "failed" }; }

  const clock = AbortSignal.timeout(timeoutMs);
  const active = AbortSignal.any([signal, clock]);
  const interrupt = () => { if (child.exitCode === null) child.kill("SIGKILL"); };
  active.addEventListener("abort", interrupt, { once: true });
  if (active.aborted) interrupt();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "", size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > localOcrOutputBytes) {
        interrupt();
        return { status: "failed" };
      }
      output += decoder.decode(value, { stream: true });
    }
    const exit = await child.exited;
    if (signal.aborted) return { status: "cancelled" };
    if (clock.aborted) return { status: "timeout" };
    if (exit === 2) return { status: "missing-engine" };
    if (exit === 3) return { status: "missing-model" };
    return exit === 0 ? { status: "ok", output: output + decoder.decode() } : { status: "failed" };
  } catch { return { status: "failed" }; }
  finally {
    active.removeEventListener("abort", interrupt);
    interrupt();
    await Promise.all([reader.cancel().catch(() => undefined), child.exited]);
    reader.releaseLock();
  }
}

function loaderPath(value: string | undefined) {
  return value?.split(/[:;]/u).filter(isAbsolute).join(":") || undefined;
}

export function createLocalOcr(timeoutMs = 12_000) {
  const env = {
    LANG: "C.UTF-8",
    OMP_THREAD_LIMIT: "1",
    TESSDATA_PREFIX: process.env.TESSDATA_PREFIX,
    LD_LIBRARY_PATH: loaderPath(process.env.LD_LIBRARY_PATH),
    DYLD_LIBRARY_PATH: loaderPath(process.env.DYLD_LIBRARY_PATH),
  };
  let readyUntil = 0;
  return {
    async prepare(signal: AbortSignal) {
      if (readyUntil > performance.now()) return { ready: true as const };
      const probe = await runLocalOcr(undefined, signal, 2_000, env);
      if (probe.status === "missing-engine") return { failure: missingEngine };
      if (probe.status === "missing-model") return { failure: missingModel };
      if (probe.status !== "ok") return { failure: $t("lib.local-ocr.text_0597503d76") };
      readyUntil = performance.now() + 30_000;
      return { ready: true as const };
    },
    async recognize(image: Uint8Array, signal: AbortSignal) {
      if (image.byteLength === 0 || image.byteLength > localOcrImageBytes) return $t("lib.local-ocr.text_281d121795");
      const result = await runLocalOcr(image, signal, timeoutMs, env);
      if (result.status === "timeout") return $t("lib.local-ocr.text_0cba453fd5");
      if (result.status !== "ok") {
        readyUntil = 0;
        if (result.status === "missing-engine") return missingEngine;
        if (result.status === "missing-model") return missingModel;
        return $t("lib.local-ocr.text_df5a99ef4f");
      }
      return result.output.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "").trim().slice(0, 4_000).toWellFormed() || $t("lib.local-ocr.text_05d39a014d");
    },
  };
}
