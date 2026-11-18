import type { MilkySettings } from "./milky-config.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createMilkyApi(settings: MilkySettings, signal: AbortSignal) {
  const base = new URL(settings.apiBase);
  const timeoutMs = settings.timeoutMs;
  const headers = new Headers({ Accept: "application/json", "Content-Type": "application/json" });
  if (settings.accessToken !== undefined) headers.set("Authorization", `Bearer ${settings.accessToken}`);

  return async (action: string, params: Record<string, unknown>): Promise<Record<string, unknown> | undefined> => {
    if (signal.aborted || !/^[a-z][a-z0-9_]*$/u.test(action) || !isRecord(params)) return;

    try {
      const body = JSON.stringify(params);
      if (!body?.startsWith("{")) return;
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const response = await fetch(new URL(action, base), {
        method: "POST", headers, body, redirect: "error", proxy: false, signal: deadline,
      });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        return;
      }
      const result: unknown = await response.json();
      if (!deadline.aborted && isRecord(result) && result.status === "ok" && result.retcode === 0 && isRecord(result.data)) {
        return result.data;
      }
    } catch {
      // Caller cannot assume delivery. Gateway errors can include credentials or request contents.
    }
  };
}
