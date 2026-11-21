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

export type PanelAuth = { readonly kind: "session" } | { readonly kind: "bearer"; readonly token: string };
export const browserSession: PanelAuth = { kind: "session" };

export function panelFetch(path: string, auth: PanelAuth, options: RequestInit = {}) {
  const url = new URL(path, window.location.href);
  if (url.origin !== window.location.origin) throw new TypeError("面板请求须使用当前站点。");
  const headers = new Headers(options.headers);
  if (auth.kind === "bearer") headers.set("Authorization", `Bearer ${auth.token}`);
  else headers.set("X-Lotus-Panel-Session", "1");
  return fetch(url, {
    ...options, headers, cache: "no-store", redirect: "error",
    credentials: auth.kind === "session" ? "same-origin" : "omit",
  });
}

export async function claimPanelSession(ticket: string, signal: AbortSignal) {
  const expired = "登录链接无效或已过期，请私聊机器人发送 #管理面板 获取新链接。";
  if (!/^[A-Za-z0-9_-]{43}$/u.test(ticket)) throw new CredentialsError(expired);
  const response = await panelFetch(`${import.meta.env.BASE_URL}api/session/claim`, browserSession, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket }), signal,
  }).catch(() => { throw new Error("暂时无法连接宿主，请重新打开登录链接。"); });
  if ([400, 401, 403, 410].includes(response.status)) throw new CredentialsError(expired);
  if (response.status !== 204) throw new Error("宿主未能登录面板，请确认面板访问地址。");
}

export async function logoutPanelSession(signal: AbortSignal) {
  const response = await panelFetch(`${import.meta.env.BASE_URL}api/session/logout`, browserSession, { method: "POST", signal });
  if (response.status !== 204) throw new Error("宿主未确认退出。");
}

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

export async function readPanel(auth: PanelAuth, signal: AbortSignal): Promise<PanelSnapshot> {
  let runtimeResponse: Response;
  let pluginsResponse: Response;
  try {
    [runtimeResponse, pluginsResponse] = await Promise.all([
      panelFetch(`${import.meta.env.BASE_URL}api/status`, auth, { signal }),
      panelFetch(`${import.meta.env.BASE_URL}api/plugins`, auth, { signal }),
    ]);
  } catch {
    throw new Error("暂时无法连接宿主，请重试。");
  }
  if (runtimeResponse.status === 401 || pluginsResponse.status === 401) {
    throw new CredentialsError(auth.kind === "bearer" ? "面板令牌无效，请重新输入。" : "登录已失效，请重新获取登录链接。");
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
