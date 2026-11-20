import type { MilkySettings } from "./milky-config.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type MilkyConfirmation =
  | { readonly status: "confirmed"; readonly data: Record<string, unknown> }
  | { readonly status: "rejected" }
  | { readonly status: "unknown" };

export function createMilkyApi(settings: MilkySettings, signal: AbortSignal) {
  const base = new URL(settings.apiBase);
  const timeoutMs = settings.timeoutMs;
  const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
  if (settings.accessToken !== undefined) headers.set("Authorization", `Bearer ${settings.accessToken}`);

  async function confirmed(action: string, params: Record<string, unknown>, operation?: AbortSignal): Promise<MilkyConfirmation> {
    if (signal.aborted || operation?.aborted || !/^[a-z][a-z0-9_]*$/u.test(action) || !isRecord(params)) return { status: "rejected" };

    let request: Request;
    try {
      const body = JSON.stringify(params);
      if (!body?.startsWith("{")) return { status: "rejected" };
      const timeout = AbortSignal.timeout(timeoutMs);
      const deadline = AbortSignal.any(operation ? [signal, operation, timeout] : [signal, timeout]);
      request = new Request(new URL(action, base), {
        method: "POST", headers, body, redirect: "error", signal: deadline,
      });
    } catch {
      return { status: "rejected" };
    }
    if (request.signal.aborted) return { status: "rejected" };

    try {
      const response = await fetch(request, { proxy: false });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        const rejected = response.status === 401 || response.status === 404 || response.status === 415;
        return { status: !request.signal.aborted && rejected ? "rejected" : "unknown" };
      }
      const result: unknown = await response.json();
      if (request.signal.aborted || !isRecord(result)) return { status: "unknown" };
      if (result.status === "ok" && result.retcode === 0 && isRecord(result.data)) {
        return { status: "confirmed", data: result.data };
      }
      if (result.status === "failed" && Number.isSafeInteger(result.retcode) && result.retcode !== 0) {
        return { status: "rejected" };
      }
    } catch {
      // Caller cannot assume delivery. Gateway errors can include credentials or request contents.
    }
    return { status: "unknown" };
  }

  return Object.assign(async (action: string, params: Record<string, unknown>, operation?: AbortSignal) => {
    const result = await confirmed(action, params, operation);
    return result.status === "confirmed" ? result.data : undefined;
  }, { confirmed });
}
