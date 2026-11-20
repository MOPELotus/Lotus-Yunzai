import { isGitRevision } from "./local-git.ts";
import { encodeManagedUpdateRequest, isManagedPluginDirectory, isManagedUpdateProgress, isTerminalManagedUpdateProgress,
  managedUpdateDirectoryLimit, parseManagedUpdateRequest, type ManagedUpdateProgress, type ManagedUpdateRequest,
  type ManagedUpdateWireRequest } from "./managed-update-protocol.ts";

export type ManagedTlsListener = "https" | "wss";
export interface ManagedEndpoints {
  readonly tls?: ManagedTlsListener;
  readonly milky?: "webhook" | "ws";
  readonly valkey?: true;
}

interface ManagedHandoff {
  readonly managed: boolean;
  readonly accepting: boolean;
  readonly supportsAdapterReceipts: boolean;
  readonly pausedAt?: number;
  ready(revision: string | undefined, signal: AbortSignal, loadedPlugins?: readonly string[], endpoints?: ManagedEndpoints): Promise<void>;
  restart(pausedAt?: number): boolean;
  reportPower(pausedAt?: number): boolean;
  update(request: ManagedUpdateRequest, onProgress: (status: ManagedUpdateProgress) => void): boolean;
  cancelUpdate(): void;
  onDisconnect(handler: () => void): () => void;
}

type Notice =
  | ({ type: "lotus-ready"; revision?: string; plugins?: readonly string[] } & ManagedEndpoints)
  | { type: "lotus-restart"; pausedAt?: number }
  | { type: "lotus-power"; pausedAt?: number }
  | { type: "lotus-update"; requestId: string; request: ManagedUpdateWireRequest };

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const failed = () => new Error("受管进程未能完成启动交接。");

function validPausedAt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createManagedHandoff(): ManagedHandoff {
  const token = process.env.LOTUS_MANAGED_TOKEN;
  const held = process.env.LOTUS_MANAGED_HELD === "1";
  const paused = process.env.LOTUS_MANAGED_PAUSED_AT;
  const adapterReceipts = process.env.LOTUS_MANAGED_ADAPTER_RECEIPTS === "1";
  const scheduledAdapterReceipts = adapterReceipts && process.env.LOTUS_MANAGED_SCHEDULED_ADAPTER_RECEIPTS === "1";
  delete process.env.LOTUS_MANAGED_TOKEN;
  delete process.env.LOTUS_MANAGED_HELD;
  delete process.env.LOTUS_MANAGED_PAUSED_AT;
  delete process.env.LOTUS_MANAGED_ADAPTER_RECEIPTS;
  delete process.env.LOTUS_MANAGED_SCHEDULED_ADAPTER_RECEIPTS;

  if (!token || !uuid.test(token) || typeof process.send !== "function" || process.connected !== true) {
    return {
      managed: false,
      accepting: true,
      supportsAdapterReceipts: false,
      async ready() {},
      restart: () => false,
      reportPower: () => false,
      update: () => false,
      cancelUpdate() {},
      onDisconnect: () => () => {},
    };
  }

  const pausedAt = paused && /^[1-9]\d*$/u.test(paused) ? Number(paused) : 0;
  const send = process.send.bind(process);
  const handlers = new Set<() => void>();
  let accepting = !held;
  let disconnected = false;
  let restarting = false;
  let readiness: Promise<void> | undefined;
  let activated = false;
  let cancelUpdate: (() => void) | undefined;

  function connected() {
    return !disconnected && process.connected === true;
  }

  process.once("disconnect", () => {
    disconnected = true;
    accepting = false;
    cancelUpdate?.();
    for (const handler of handlers) handler();
    handlers.clear();
  });
  process.channel?.unref();

  function onDisconnect(handler: () => void) {
    if (connected()) handlers.add(handler);
    else handler();
    return () => { handlers.delete(handler); };
  }

  function notify(message: Notice, onFailure?: () => void): boolean {
    if (!connected()) return false;
    try {
      return send({ ...message, token }, (error) => { if (error) onFailure?.(); }) === true;
    } catch {
      return false;
    }
  }

  async function reportReady(revision: string | undefined, signal: AbortSignal, loadedPlugins?: readonly string[], endpoints?: ManagedEndpoints) {
    if (signal.aborted || !connected() || (held && revision === undefined) ||
        (revision !== undefined && !isGitRevision(revision))) throw failed();

    const plugins = loadedPlugins && [...new Set(loadedPlugins.filter(isManagedPluginDirectory))].slice(0, managedUpdateDirectoryLimit);
    const message = { type: "lotus-ready", ...(revision === undefined ? {} : { revision }),
      ...(plugins === undefined ? {} : { plugins }), ...endpoints } as const;
    if (!held) {
      if (!notify(message)) throw failed();
      activated = true;
      return;
    }

    const activation = Promise.withResolvers<boolean>();
    const abort = () => activation.resolve(false);
    const activate = (message: unknown) => {
      if (typeof message === "object" && message !== null && "type" in message && message.type === "lotus-activate" &&
          "token" in message && message.token === token) activation.resolve(true);
    };
    const stopWatching = onDisconnect(abort);
    signal.addEventListener("abort", abort, { once: true });
    process.on("message", activate);
    process.channel?.ref();
    try {
      if (!notify(message) || !await activation.promise || signal.aborted || !connected()) throw failed();
      accepting = true;
      activated = true;
    } finally {
      stopWatching();
      signal.removeEventListener("abort", abort);
      process.off("message", activate);
      process.channel?.unref();
    }
  }

  function update(request: ManagedUpdateRequest, onProgress: (status: ManagedUpdateProgress) => void): boolean {
    if (!activated || !accepting || restarting || !connected()) return false;
    const parsed = parseManagedUpdateRequest(request);
    if (!parsed) return false;
    const snapshot = encodeManagedUpdateRequest(parsed, scheduledAdapterReceipts);
    if (!adapterReceipts && (snapshot.target.type === "milky-group" || snapshot.target.type === "milky-private")) return false;
    if (cancelUpdate) {
      onProgress("busy");
      return true;
    }
    const requestId = crypto.randomUUID();

    function clear() {
      cancelUpdate = undefined;
      process.off("message", receive);
      process.channel?.unref();
    }

    function report(status: ManagedUpdateProgress) {
      if (cancelUpdate !== clear) return;
      if (isTerminalManagedUpdateProgress(status)) clear();
      void Promise.resolve().then(() => onProgress(status)).catch(() => {});
    }

    function receive(message: unknown) {
      if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "lotus-update-progress" ||
          !("token" in message) || message.token !== token || !("requestId" in message) || message.requestId !== requestId ||
          !("status" in message) || !isManagedUpdateProgress(message.status)) return;
      report(message.status);
    }

    cancelUpdate = clear;
    process.on("message", receive);
    process.channel?.ref();
    if (notify({ type: "lotus-update", requestId, request: snapshot }, () => report("failed"))) return true;
    clear();
    return false;
  }

  return {
    managed: true,
    supportsAdapterReceipts: adapterReceipts,
    pausedAt: validPausedAt(pausedAt) ? pausedAt : undefined,
    get accepting() { return accepting && connected(); },
    ready(revision, signal, loadedPlugins, endpoints) {
      return readiness ??= reportReady(revision, signal, loadedPlugins, endpoints);
    },
    restart(pausedAt) {
      if (!accepting || restarting || (pausedAt !== undefined && !validPausedAt(pausedAt))) return false;
      if (!notify({ type: "lotus-restart", ...(pausedAt === undefined ? {} : { pausedAt }) })) return false;
      restarting = true;
      return true;
    },
    reportPower(pausedAt) {
      if (!activated || !accepting || (pausedAt !== undefined && !validPausedAt(pausedAt))) return false;
      return notify({ type: "lotus-power", ...(pausedAt === undefined ? {} : { pausedAt }) });
    },
    update,
    cancelUpdate() { cancelUpdate?.(); },
    onDisconnect,
  };
}
