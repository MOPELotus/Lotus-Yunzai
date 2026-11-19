import { readWebhookJson } from "../http-json.ts";
import { authorized, publicPostPath } from "../server.ts";
import type { MilkySettings } from "./milky-config.ts";
import { openMilkySession, type MilkySession, type MilkyTransportOptions } from "./milky-session.ts";

function status(code: number, headers?: HeadersInit) {
  return new Response(null, { status: code, headers });
}

export function createMilkyWebhook(settings: MilkySettings, options: MilkyTransportOptions) {
  const { signal } = options;
  const auth = settings.accessToken ? new Headers({ Authorization: `Bearer ${settings.accessToken}` }) : undefined;
  let account: MilkySession | undefined;
  let connection: AbortController | undefined;
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
    const current = new AbortController();
    connection = current;
    connecting = openMilkySession(settings, { ...options, signal: current.signal }).then((session) => {
      if (!running || signal.aborted) return;
      if (session) {
        account = session;
        options.onOnline?.(session.botId, current.signal, session.send, session.checkinNotify, session.ownGroupCardAccount);
      } else reconnect();
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
    connection?.abort();
    clearTimeout(retry);
  }

  signal.addEventListener("abort", deactivate, { once: true });

  async function handle(request: Request, listenerAuth: Headers): Promise<Response | undefined> {
    if (publicPostPath(new URL(request.url).pathname) !== settings.webhookPath || request.headers.has("Upgrade")) return;
    if (request.method !== "POST") return status(405, { Allow: "POST" });
    const required = auth ?? listenerAuth;
    if (required.keys().next().done || !authorized(request, required)) return status(401);
    const bound = account;
    if (!running || signal.aborted || !bound) return status(503);
    const parsed = await readWebhookJson(request);
    if (!running || signal.aborted || account !== bound) return status(503);
    if ("status" in parsed) return status(parsed.status);
    const result = bound.receive(parsed.body);
    if (result === "invalid") return status(400);
    if (result === "foreign") return status(403);
    if (result === "offline") {
      account = undefined;
      connection?.abort();
      reconnect();
    }
    return status(200);
  }

  return { start, handle, async stop() {
    signal.removeEventListener("abort", deactivate);
    deactivate();
    await connecting;
  } };
}
