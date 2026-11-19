export const pluginStartupGraceMs = 10_000;
export const maxPluginLoadMs = 2_147_483_647 - pluginStartupGraceMs;
export const pluginProbeTokenEnvironment = "LOTUS_PROBE_STARTUP_TOKEN";
export const defaultPluginLoadMs = 60_000;
const pluginLoadingType = "lotus-yunzai-plugin-loading";
const decimal = /^(?:\d+(?:\.\d*)?|\.\d+)$/u;

export function parsePluginLoadMilliseconds(value: unknown): number | undefined {
  if (value === undefined) return defaultPluginLoadMs;
  const seconds = typeof value === "string" && decimal.test(value.trim()) ? Number(value) : value;
  if (typeof seconds !== "number" || seconds < 0) return;
  const milliseconds = Math.ceil(seconds * 1_000);
  if (Number.isSafeInteger(milliseconds) && milliseconds <= maxPluginLoadMs) return milliseconds;
}

export function readPluginLoading(message: unknown, token: string, nextIndex: number): number | undefined {
  if (typeof message !== "object" || message === null) return;
  const { type, token: source, index, wait } = message as Record<string, unknown>;
  if ((type === pluginLoadingType || type === "lotus-plugin-loading") && source === token && index === nextIndex &&
      typeof wait === "number" && Number.isSafeInteger(wait) && wait >= 0 && wait <= maxPluginLoadMs) return wait;
}

export function createPluginLoadingReporter() {
  const token = process.env.LOTUS_MANAGED_TOKEN ?? process.env[pluginProbeTokenEnvironment];
  delete process.env[pluginProbeTokenEnvironment];
  if (!token || typeof process.send !== "function" || process.connected !== true) return;
  const send = process.send.bind(process);
  let index = 0;
  return (wait: number) => {
    if (process.connected !== true) return;
    try {
      send({ type: pluginLoadingType, token, index: ++index, wait });
    } catch {
      // A launcher can disconnect during shutdown.
    }
  };
}
