import type { MilkySettings } from "./milky-config.ts";
import { openMilkySession, type MilkyTransportOptions } from "./milky-session.ts";

interface Connection {
  readonly controller: AbortController;
  socket?: Bun.WebSocket;
  handshake?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
}

const BunWebSocket = WebSocket as unknown as new (url: URL, options: Bun.WebSocketOptions) => Bun.WebSocket;
const maxEventBytes = 1024 * 1024;

export function createMilkyWs(settings: MilkySettings, options: MilkyTransportOptions) {
  const headers = settings.accessToken ? { Authorization: `Bearer ${settings.accessToken}` } : undefined;
  let running = false;
  let stopped = false;
  let current: Connection | undefined;
  let connecting: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;

  function release(connection: Connection) {
    current = undefined;
    clearTimeout(connection.handshake);
    clearInterval(connection.heartbeat);
    connection.controller.abort();
    const { socket } = connection;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }

  function reconnect(connection: Connection) {
    if (connection !== current) return;
    release(connection);
    if (!running || options.signal.aborted || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      connect();
    }, settings.reconnectMs);
  }

  async function open(connection: Connection) {
    const { signal } = connection.controller;
    const session = await openMilkySession(settings, { ...options, signal });
    if (signal.aborted) return;
    if (!session) {
      reconnect(connection);
      return;
    }

    const socket = new BunWebSocket(settings.eventUrl, { headers, perMessageDeflate: false });
    connection.socket = socket;
    connection.handshake = setTimeout(() => reconnect(connection), settings.timeoutMs);
    let waitingForPong = false;
    socket.addEventListener("open", () => {
      clearTimeout(connection.handshake);
      options.onOnline?.(session.botId, signal, session.send);
      connection.heartbeat = setInterval(() => {
        if (waitingForPong || socket.readyState !== WebSocket.OPEN) {
          reconnect(connection);
          return;
        }
        waitingForPong = true;
        try {
          socket.ping();
        } catch {
          reconnect(connection);
        }
      }, settings.heartbeatMs);
    }, { once: true, signal });
    socket.addEventListener("pong", () => { waitingForPong = false; }, { signal });
    socket.addEventListener("message", ({ data }) => {
      if (signal.aborted || typeof data !== "string" || data.length > maxEventBytes || Buffer.byteLength(data) > maxEventBytes) return;
      let event: unknown;
      try {
        event = JSON.parse(data) as unknown;
      } catch {
        return;
      }
      if (session.receive(event) === "offline") reconnect(connection);
    }, { signal });
    const disconnected = () => reconnect(connection);
    socket.addEventListener("error", disconnected, { once: true, signal });
    socket.addEventListener("close", disconnected, { once: true, signal });
  }

  function connect() {
    if (!running || current || options.signal.aborted) return;
    const connection = { controller: new AbortController() };
    current = connection;
    const attempt = open(connection).catch(() => reconnect(connection)).finally(() => {
      if (connecting === attempt) connecting = undefined;
    });
    connecting = attempt;
  }

  function deactivate() {
    running = false;
    stopped = true;
    clearTimeout(retry);
    retry = undefined;
    if (current) release(current);
    options.signal.removeEventListener("abort", deactivate);
  }

  return {
    start() {
      if (running || stopped || options.signal.aborted) return;
      running = true;
      options.signal.addEventListener("abort", deactivate, { once: true });
      connect();
    },
    async stop() {
      deactivate();
      await connecting;
    },
  };
}
