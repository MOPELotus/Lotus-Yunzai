import { createTranslator as createTextTranslator } from "../i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("hoyo-client", messageCatalog.messages);
const requestIdHeaders = ["x-request-id", "x-trace-id", "x-rpc-request_id", "cf-ray"] as const;
const mediaTypes = new Set([
  "application/json", "application/problem+json", "application/octet-stream", "text/html", "text/plain",
]);
const networkCodes = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "ABORT_ERR", "ERR_STREAM_PREMATURE_CLOSE",
]);

function requestIds(headers: Headers) {
  const ids: Partial<Record<typeof requestIdHeaders[number], string>> = {};
  for (const name of requestIdHeaders) {
    const value = headers.get(name);
    if (value && /^[A-Za-z0-9:_.-]{1,100}$/u.test(value) && /[A-Za-z]/u.test(value) && !/\d{8,}/u.test(value)) {
      ids[name] = value;
    }
  }
  return ids;
}

function networkCode(reason: unknown) {
  try {
    const direct = (reason as { code?: unknown } | null)?.code;
    if (typeof direct === "string" && networkCodes.has(direct)) return direct;
    const cause = reason instanceof Error ? (reason.cause as { code?: unknown } | null)?.code : undefined;
    if (typeof cause === "string" && networkCodes.has(cause)) return cause;
  } catch {
    // Treat unreadable error details the same as an unknown code.
  }
  return "NETWORK_ERROR";
}

/** Observe only a native, read-only request. Route is a code-defined path without parameters. */
export function observeCnRead(route: string, method: "GET" | "POST", callerSignal?: AbortSignal, timeout?: AbortSignal) {
  let started = 0;
  let reported = false;

  function report(stage: "http" | "connection" | "stream", response?: Response, reason?: unknown) {
    if (reported || callerSignal?.aborted) return;
    reported = true;
    try {
      const mime = response?.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      const ids = response && !response.redirected ? requestIds(response.headers) : undefined;
      const diagnostic = {
        route, method, stage, elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        status: response?.status ?? null,
        ...(mime && mediaTypes.has(mime) && { contentType: mime }),
        ...(ids && Object.keys(ids).length && { requestIds: ids }),
        ...(stage !== "http" && { networkCode: timeout?.aborted ? "ETIMEDOUT" : networkCode(reason) }),
      };
      void Promise.resolve(console.warn($t("cn-read-diagnostics.text_67e59761e6"), diagnostic)).catch(() => undefined);
    } catch {
      // A failed diagnostic sink must not change the request result.
    }
  }

  return {
    async read(request: () => Promise<Response>) {
      started = performance.now();
      let response: Response;
      try {
        response = await request();
      } catch (error) {
        report("connection", undefined, error);
        throw error;
      }
      if (!response.ok) report("http", response);
      return response;
    },
    stream(response: Response, error: unknown) {
      report("stream", response, error);
    },
  };
}
