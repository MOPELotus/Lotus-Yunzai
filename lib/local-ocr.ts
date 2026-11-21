type RunResult = { status: "ok"; output: string } | { status: "failed" | "timeout" | "cancelled" };

const maxOutput = 32 * 1024;
const requiredLanguages = ["chi_sim", "eng"] as const;

async function runTesseract(executable: string, args: string[], image: Uint8Array | undefined, signal: AbortSignal,
  timeoutMs: number, tessdata: string | undefined): Promise<RunResult> {
  if (signal.aborted) return { status: "cancelled" };

  let child: Bun.Subprocess<"ignore" | Uint8Array, "pipe", "ignore">;
  try {
    child = Bun.spawn([executable, ...args], {
      stdin: image ?? "ignore", stdout: "pipe", stderr: "ignore",
      env: { LANG: "C.UTF-8", OMP_THREAD_LIMIT: "1", ...(tessdata !== undefined ? { TESSDATA_PREFIX: tessdata } : {}) },
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
      if (size > maxOutput) {
        interrupt();
        return { status: "failed" };
      }
      output += decoder.decode(value, { stream: true });
    }
    const exit = await child.exited;
    if (signal.aborted) return { status: "cancelled" };
    if (clock.aborted) return { status: "timeout" };
    return exit === 0 ? { status: "ok", output: output + decoder.decode() } : { status: "failed" };
  } catch { return { status: "failed" }; }
  finally {
    active.removeEventListener("abort", interrupt);
    interrupt();
    await Promise.all([reader.cancel().catch(() => undefined), child.exited]);
    reader.releaseLock();
  }
}

export function createLocalOcr(timeoutMs = 12_000) {
  const tessdata = process.env.TESSDATA_PREFIX;
  let ready: { executable: string; until: number } | undefined;

  return {
    async prepare(signal: AbortSignal) {
      if (ready && ready.until > performance.now()) return { executable: ready.executable };
      const executable = Bun.which("tesseract");
      if (!executable) return { failure: "本机 OCR 未安装 Tesseract，请联系管理员。" };
      const models = await runTesseract(executable, ["--list-langs"], undefined, signal, 2_000, tessdata);
      if (models.status !== "ok") return { failure: "本机 OCR 暂时无法检查语言模型，请联系管理员。" };
      const installed = models.output.split(/\r?\n/u).map(line => line.trim());
      if (!requiredLanguages.every(language => installed.includes(language))) {
        return { failure: "本机 OCR 缺少简体中文或英语模型（chi_sim、eng），请联系管理员。" };
      }
      ready = { executable, until: performance.now() + 30_000 };
      return { executable };
    },
    async recognize(executable: string, image: Uint8Array, signal: AbortSignal) {
      const result = await runTesseract(executable,
        ["stdin", "stdout", "-l", requiredLanguages.join("+"), "--oem", "1", "--psm", "3"], image, signal, timeoutMs, tessdata);
      if (result.status === "timeout") return "图片文字识别超时，请缩小图片后重试。";
      if (result.status !== "ok") {
        ready = undefined;
        return "本机图片文字识别失败，请换一张图片后重试。";
      }
      return result.output.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "").trim().slice(0, 4_000).toWellFormed() || "未识别到文字。";
    },
  };
}
