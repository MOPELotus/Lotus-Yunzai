import { setTimeout as delay } from "node:timers/promises";

export type ReadTransportInit = RequestInit & {
  readonly proxy?: false;
  /** This reader already owns its bounded retry loop. */
  readonly readRetry?: false;
  readonly readRetryGuard?: () => Promise<void>;
};
export type ReadTransport = (endpoint: URL, init: ReadTransportInit) => Promise<Response>;
const wrapped = new WeakMap<ReadTransport, { base: ReadTransport; canRetry: (endpoint: URL, method: string) => boolean; attempts: number }>();
const cache = new WeakMap<ReadTransport, WeakMap<(endpoint: URL, method: string) => boolean, Map<number, ReadTransport>>>();
const defaultRead = (_endpoint: URL, method: string) => method === "GET" || method === "HEAD";
const transientCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
  "ECONNABORTED", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "ERR_STREAM_PREMATURE_CLOSE",
  "ConnectionClosed", "ConnectionRefused", "Timeout",
]);

export function transientReadError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const value = error as { code?: unknown; cause?: unknown; name?: unknown; message?: unknown };
    if (typeof value.code === "string" && transientCodes.has(value.code)) return true;
    if (value.name === "TimeoutError") return true;
    if (value.name === "TypeError" && typeof value.message === "string" && /^(?:fetch failed|Failed to fetch|NetworkError)/u.test(value.message)) return true;
    error = value.cause;
  }
  return false;
}

export function transientReadResponse(response: Response): boolean {
  return !response.headers.has("Retry-After") && ([408, 500, 502, 503, 504].includes(response.status) ||
    (response.status === 410 && /^text\/html(?:\s*;|$)/iu.test(response.headers.get("Content-Type") ?? "")));
}

// Catch truncated API streams before handing a response to the reader. Keep
// the original Response (including its URL/redirect metadata) and cap tee data.
async function checkJsonStream(response: Response, signal = AbortSignal.timeout(15_000)) {
  const limit = 512 * 1024;
  if (!response.body || response.bodyUsed || Number(response.headers.get("Content-Length")) > limit ||
      !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/iu.test(response.headers.get("Content-Type") ?? "")) return;
  const reader = response.clone().body!.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) return;
      size += next.value.byteLength;
      if (size > limit) return;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Three total attempts, shared across client/host wrappers; caller deadline wins. */
export function withReadRetries(transport: ReadTransport, { canRetry = defaultRead, attempts: limit = 3 }: {
  canRetry?: (endpoint: URL, method: string) => boolean;
  attempts?: 1 | 2 | 3;
} = {}): ReadTransport {
  if (![1, 2, 3].includes(limit)) throw new Error("Invalid read retry limit");
  const previous = wrapped.get(transport);
  if (previous?.canRetry === canRetry && previous.attempts === limit) return transport;
  const base = previous?.base ?? transport;
  let policies = cache.get(base);
  if (!policies) { policies = new WeakMap(); cache.set(base, policies); }
  let limits = policies.get(canRetry);
  if (!limits) { limits = new Map(); policies.set(canRetry, limits); }
  const existing = limits.get(limit);
  if (existing) return existing;
  const request: ReadTransport = async (endpoint, init) => {
    const { readRetry, readRetryGuard, ...outgoing } = init;
    const retry = readRetry !== false && canRetry(endpoint, (init.method ?? "GET").toUpperCase()) &&
      (init.body === undefined || init.body === null || typeof init.body === "string");
    const attempts = retry ? limit : 1;
    for (let attempt = 0; ; attempt++) {
      init.signal?.throwIfAborted();
      if (attempt) {
        await delay(250 * attempt, undefined, { signal: init.signal ?? undefined });
        await readRetryGuard?.();
        init.signal?.throwIfAborted();
      }
      let response: Response | undefined;
      try {
        response = await base(endpoint, outgoing);
        if (retry && response.ok && !response.redirected && (!response.url || response.url === endpoint.href)) {
          await checkJsonStream(response, init.signal ?? undefined);
        }
      }
      catch (error) {
        void response?.body?.cancel().catch(() => undefined);
        if (init.signal?.aborted || attempt + 1 >= attempts || !transientReadError(error)) throw error;
        continue;
      }
      if (attempt + 1 >= attempts || !transientReadResponse(response) || response.redirected ||
          (response.url && response.url !== endpoint.href)) return response;
      await response.body?.cancel().catch(() => undefined);
    }
  };
  wrapped.set(request, { base, canRetry, attempts: limit });
  limits.set(limit, request);
  return request;
}
