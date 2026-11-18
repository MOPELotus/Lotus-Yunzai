export const pluginStatuses = {
  loaded: "已加载",
  rejected: "已拒载",
  failed: "加载失败",
  skipped: "已跳过",
} as const;

export type PluginStatus = keyof typeof pluginStatuses;

interface RuntimeStatus {
  name: string;
  bun: string;
  status: string;
  uptime: number;
}

interface PluginRecord {
  name: string;
  status: PluginStatus;
  reason?: string;
}

export interface PanelSnapshot {
  runtime: RuntimeStatus;
  plugins: PluginRecord[];
}

export class CredentialsError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntime(value: unknown): value is RuntimeStatus {
  return isRecord(value) && typeof value.name === "string" && typeof value.bun === "string" &&
    typeof value.status === "string" && typeof value.uptime === "number" &&
    Number.isSafeInteger(value.uptime) && value.uptime >= 0;
}

function isPlugin(value: unknown): value is PluginRecord {
  return isRecord(value) && typeof value.name === "string" && typeof value.status === "string" &&
    Object.hasOwn(pluginStatuses, value.status) &&
    (value.reason === undefined || typeof value.reason === "string");
}

export async function readPanel(token: string, signal: AbortSignal): Promise<PanelSnapshot> {
  const options: RequestInit = {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    redirect: "error",
    signal,
  };
  let runtimeResponse: Response;
  let pluginsResponse: Response;
  try {
    [runtimeResponse, pluginsResponse] = await Promise.all([
      fetch(`${import.meta.env.BASE_URL}api/status`, options),
      fetch(`${import.meta.env.BASE_URL}api/plugins`, options),
    ]);
  } catch {
    throw new Error("暂时无法连接宿主，请重试。");
  }
  if (runtimeResponse.status === 401 || pluginsResponse.status === 401) {
    throw new CredentialsError("面板令牌无效，请重新输入。");
  }
  if (!runtimeResponse.ok || !pluginsResponse.ok) {
    throw new Error("宿主未能提供面板数据，请重试。");
  }
  const [runtime, report]: unknown[] = await Promise.all([runtimeResponse.json(), pluginsResponse.json()]).catch(() => []);
  if (!isRuntime(runtime) || !isRecord(report) || !Array.isArray(report.plugins) || !report.plugins.every(isPlugin)) {
    throw new Error("宿主返回了无法识别的面板数据。");
  }
  return { runtime, plugins: report.plugins };
}
