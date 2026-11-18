type JsonResult = { body: unknown } | { status: 400 | 408 | 413 | 415 };

const jsonLimit = 100 * 1024;
const jsonDeadline = 5_000;

export async function readWebhookJson(request: Request): Promise<JsonResult> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return { status: 415 };
  if (!request.body || request.bodyUsed || request.body.locked) return { status: 400 };

  const length = request.headers.get("Content-Length");
  if (length && /^\d+$/u.test(length) && Number(length) > jsonLimit) return { status: 413 };

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const abortRead = () => { void reader.cancel().catch(() => undefined); };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortRead();
  }, jsonDeadline);
  const { signal } = request;
  signal.addEventListener("abort", abortRead, { once: true });
  let bytes = 0;
  let raw = "";
  try {
    if (signal.aborted) return { status: 400 };
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) return { status: 408 };
      if (signal.aborted) return { status: 400 };
      if (done) return { body: JSON.parse(raw + decoder.decode()) as unknown };
      bytes += value.byteLength;
      if (bytes > jsonLimit) return { status: 413 };
      raw += decoder.decode(value, { stream: true });
    }
  } catch {
    return { status: timedOut ? 408 : 400 };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abortRead);
    abortRead();
    reader.releaseLock();
  }
}
