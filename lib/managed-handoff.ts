import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { isGitRevision } from "./local-git.ts";
import { managedDispatchPause } from "./managed-dispatch-pause.ts";
import { parseStorageSnapshot, storageRevision, type StorageSnapshot } from "./valkey-config.ts";
import { encodeManagedUpdateRequest, isManagedPluginDirectory, isManagedUpdateProgress, isTerminalManagedUpdateProgress,
  managedUpdateDirectoryLimit, parseManagedUpdateRequest, type ManagedUpdateProgress, type ManagedUpdateRequest,
  type ManagedUpdateWireRequest } from "./managed-update-protocol.ts";

export type ManagedTlsListener = "https" | "wss";
export interface ManagedEndpoints {
  readonly tls?: ManagedTlsListener;
  readonly httpPort?: number;
  readonly oneBotPort?: number;
  readonly tlsPort?: number;
  readonly milky?: "webhook" | "ws";
  readonly valkey?: true;
}

interface ManagedHandoff {
  readonly managed: boolean;
  readonly accepting: boolean;
  readonly updating: boolean;
  readonly supportsAdapterReceipts: boolean;
  readonly pausedAt?: number;
  ready(revision: string | undefined, signal: AbortSignal, loadedPlugins?: readonly string[], endpoints?: ManagedEndpoints,
    scripts?: readonly string[], storage?: StorageSnapshot): Promise<void>;
  restoreStorage(signal: AbortSignal): Promise<StorageSnapshot | undefined>;
  verifyStorage(storage: StorageSnapshot): void;
  restart(pausedAt?: number, sent?: (error?: Error) => void): boolean;
  reportPower(pausedAt?: number): boolean;
  readonly powerState?: ReturnType<typeof managedDispatchPause>;
  update(request: ManagedUpdateRequest, onProgress: (status: ManagedUpdateProgress) => void): boolean;
  cancelUpdate(): void;
  onDisconnect(handler: () => void): () => void;
  onReplacement(handler: () => void): () => void;
}

type Notice =
  | ({ type: "lotus-ready"; revision?: string; plugins?: readonly string[]; scripts?: readonly string[]; activationAck?: true; replacementNotice?: true; storage?: StorageSnapshot } & ManagedEndpoints)
  | { type: "lotus-activated" }
  | { type: "lotus-request-storage" }
  | { type: "lotus-restart"; pausedAt?: number }
  | { type: "lotus-power"; pausedAt?: number }
  | { type: "lotus-update"; requestId: string; request: ManagedUpdateWireRequest };

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const failed = () => new Error($t("lib.managed-handoff.text_32e066620a"));

function validPausedAt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createManagedHandoff(): ManagedHandoff {
  const token = process.env.LOTUS_MANAGED_TOKEN;
  const held = process.env.LOTUS_MANAGED_HELD === "1";
  const paused = process.env.LOTUS_MANAGED_PAUSED_AT;
  const powerPath = process.env.LOTUS_MANAGED_POWER_PATH;
  const powerAttempt = process.env.LOTUS_MANAGED_POWER_ATTEMPT;
  const adapterReceipts = process.env.LOTUS_MANAGED_ADAPTER_RECEIPTS === "1";
  const scheduledAdapterReceipts = adapterReceipts && process.env.LOTUS_MANAGED_SCHEDULED_ADAPTER_RECEIPTS === "1";
  const activationAck = held && process.env.LOTUS_MANAGED_ACTIVATION_ACK === "1";
  const storageHandoff = process.env.LOTUS_MANAGED_STORAGE_HANDOFF === "1";
  const restore = process.env.LOTUS_MANAGED_RESTORE_STORAGE === "1";
  const expectedStorage = held ? process.env.LOTUS_MANAGED_EXPECT_STORAGE : undefined;
  delete process.env.LOTUS_MANAGED_TOKEN;
  delete process.env.LOTUS_MANAGED_HELD;
  delete process.env.LOTUS_MANAGED_PAUSED_AT;
  delete process.env.LOTUS_MANAGED_POWER_PATH;
  delete process.env.LOTUS_MANAGED_POWER_ATTEMPT;
  delete process.env.LOTUS_MANAGED_ADAPTER_RECEIPTS;
  delete process.env.LOTUS_MANAGED_SCHEDULED_ADAPTER_RECEIPTS;
  delete process.env.LOTUS_MANAGED_ACTIVATION_ACK;
  delete process.env.LOTUS_MANAGED_STORAGE_HANDOFF;
  delete process.env.LOTUS_MANAGED_RESTORE_STORAGE;
  delete process.env.LOTUS_MANAGED_EXPECT_STORAGE;

  if (!token || !uuid.test(token) || typeof process.send !== "function" || process.connected !== true) {
    return {
      managed: false,
      accepting: true,
      updating: false,
      supportsAdapterReceipts: false,
      async ready() {},
      async restoreStorage() { return undefined; },
      verifyStorage() {},
      restart: () => false,
      reportPower: () => false,
      update: () => false,
      cancelUpdate() {},
      onDisconnect: () => () => {},
      onReplacement: () => () => {},
    };
  }

  const pausedAt = paused && /^[1-9]\d*$/u.test(paused) ? Number(paused) : 0;
  const send = process.send.bind(process);
  const handlers = new Set<() => void>();
  const replacementHandlers = new Set<() => void>();
  let accepting = !held;
  let disconnected = false;
  let restarting = false;
  let readiness: Promise<void> | undefined;
  let activated = false;
  let cancelUpdate: (() => void) | undefined;
  let switching = false;

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

  function onReplacement(handler: () => void) {
    function receive(message: unknown) {
      if (activated && accepting && connected() && typeof message === "object" && message !== null &&
          "type" in message && message.type === "lotus-stop-for-replacement" &&
          "token" in message && message.token === token) handler();
    }
    const unsubscribe = () => {
      replacementHandlers.delete(unsubscribe);
      process.off("message", receive);
    };
    replacementHandlers.add(unsubscribe);
    process.on("message", receive);
    return unsubscribe;
  }

  function notify(message: Notice, onFailure?: () => void, sent?: (error?: Error) => void): boolean {
    if (!connected()) return false;
    try {
      return send({ ...message, token }, (error) => {
        if (error) onFailure?.();
        sent?.(error ?? undefined);
      }) === true;
    } catch {
      return false;
    }
  }

  async function reportReady(revision: string | undefined, signal: AbortSignal, loadedPlugins?: readonly string[], endpoints?: ManagedEndpoints,
    scripts?: readonly string[], storage?: StorageSnapshot) {
    if (signal.aborted || !connected() || (held && revision === undefined) ||
        (revision !== undefined && !isGitRevision(revision))) throw failed();

    const plugins = loadedPlugins && [...new Set(loadedPlugins.filter(isManagedPluginDirectory))].slice(0, managedUpdateDirectoryLimit);
    const message = { type: "lotus-ready", ...(replacementHandlers.size ? { replacementNotice: true as const } : {}),
      ...(revision === undefined ? {} : { revision }),
      ...(plugins === undefined ? {} : { plugins }), ...(held && scripts !== undefined ? { scripts } : {}),
      ...(activationAck ? { activationAck: true as const } : {}),
      ...(storageHandoff && storage !== undefined ? { storage } : {}), ...endpoints } as const;
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
      if (activationAck && !notify({ type: "lotus-activated" })) throw failed();
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
      if (status === "switching") switching = true;
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
    powerState: powerPath && powerAttempt ? managedDispatchPause(powerPath, powerAttempt) : undefined,
    get accepting() { return accepting && connected(); },
    get updating() { return switching || cancelUpdate !== undefined; },
    ready(revision, signal, loadedPlugins, endpoints, scripts, storage) {
      return readiness ??= reportReady(revision, signal, loadedPlugins, endpoints, scripts, storage);
    },
    async restoreStorage(signal) {
      if (!restore) return;
      const result = Promise.withResolvers<StorageSnapshot | undefined>();
      const abort = () => result.resolve(undefined);
      const removeDisconnect = onDisconnect(abort);
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(3_000)]);
      deadline.addEventListener("abort", abort, { once: true });
      const receive = (message: unknown) => {
        if (typeof message === "object" && message !== null && "type" in message && message.type === "lotus-storage" &&
            "token" in message && message.token === token && "storage" in message) {
          result.resolve(parseStorageSnapshot(message.storage));
        }
      };
      process.on("message", receive);
      process.channel?.ref();
      try {
        if (deadline.aborted || !notify({ type: "lotus-request-storage" }, abort)) throw failed();
        const storage = await result.promise;
        if (storage === undefined || deadline.aborted) throw failed();
        return storage;
      } finally {
        removeDisconnect();
        deadline.removeEventListener("abort", abort);
        process.off("message", receive);
        process.channel?.unref();
      }
    },
    verifyStorage(storage) {
      if (expectedStorage !== undefined && expectedStorage !== storageRevision(storage)) {
        throw new Error($t("lib.managed-handoff.text_01b5e74b37"));
      }
    },
    restart(pausedAt, sent) {
      if (!accepting || restarting || (pausedAt !== undefined && !validPausedAt(pausedAt))) return false;
      if (!notify({ type: "lotus-restart", ...(pausedAt === undefined ? {} : { pausedAt }) }, undefined, sent)) return false;
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
    onReplacement,
  };
}
