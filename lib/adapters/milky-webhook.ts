import { readWebhookJson } from "../http-json.ts";
import type { MessageEvent } from "../messages.ts";
import { authorized, publicPostPath } from "../server.ts";
import { createMilkyApi } from "./milky-api.ts";
import type { MilkySettings } from "./milky-config.ts";
import { milkyMessage } from "./milky-message.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function status(code: number, headers?: HeadersInit) {
  return new Response(null, { status: code, headers });
}

export function createMilkyWebhook(
  settings: MilkySettings,
  options: {
    readonly signal: AbortSignal;
    readonly dispatch: (event: MessageEvent) => Promise<void>;
    readonly onSent?: (event: MessageEvent, message: unknown) => void;
  },
) {
  const { signal, dispatch, onSent } = options;
  const auth = settings.accessToken ? new Headers({ Authorization: `Bearer ${settings.accessToken}` }) : undefined;
  const call = createMilkyApi(settings, signal);
  let account: { readonly id: number } | undefined;
  let running = false;
  let connecting: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  function reconnect() {
    if (!running || signal.aborted || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      connect();
    }, settings.reconnectMs);
    retry.unref();
  }

  function connect() {
    if (!running || signal.aborted || connecting) return;
    connecting = call("get_login_info", {}).then((login) => {
      if (!running || signal.aborted) return;
      if (positiveId(login?.uin)) account = { id: login.uin };
      else reconnect();
    }).catch(reconnect).finally(() => { connecting = undefined; });
  }

  function start() {
    if (running || signal.aborted) return;
    running = true;
    connect();
  }

  function deactivate() {
    running = false;
    account = undefined;
    clearTimeout(retry);
  }

  signal.addEventListener("abort", deactivate, { once: true });

  async function handle(request: Request, listenerAuth: Headers): Promise<Response | undefined> {
    if (publicPostPath(new URL(request.url).pathname) !== settings.webhookPath || request.headers.has("Upgrade")) return;
    if (request.method !== "POST") return status(405, { Allow: "POST" });
    if (!authorized(request, auth ?? listenerAuth)) return status(401);
    const bound = account;
    if (!running || signal.aborted || !bound) return status(503);
    const parsed = await readWebhookJson(request);
    if (!running || signal.aborted || account !== bound) return status(503);
    if ("status" in parsed) return status(parsed.status);
    const body = parsed.body;
    if (!record(body) || !positiveId(body.self_id) || typeof body.event_type !== "string" ||
        !body.event_type || !record(body.data)) return status(400);
    if (body.self_id !== bound.id) return status(403);
    if (body.event_type === "bot_offline") {
      account = undefined;
      reconnect();
      return status(200);
    }
    const message = milkyMessage(body, bound.id, async (action, params) => {
      if (!running || signal.aborted || account !== bound) return;
      const result = await call(action, params);
      const sequence = result?.message_seq;
      if (message && typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0) {
        onSent?.(message, params.message);
      }
      return result;
    });
    if (message) void dispatch(message).catch(() => console.warn("[Milky] 处理 Webhook 事件失败。"));
    return status(200);
  }

  return { start, handle, async stop() {
    signal.removeEventListener("abort", deactivate);
    deactivate();
    await connecting;
  } };
}
