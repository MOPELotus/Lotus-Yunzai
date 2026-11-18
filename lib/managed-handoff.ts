import { isGitRevision } from "./local-git.ts";

interface ManagedHandoff {
  readonly managed: boolean;
  readonly accepting: boolean;
  readonly pausedAt?: number;
  ready(revision: string | undefined, signal: AbortSignal): Promise<void>;
  restart(pausedAt?: number): boolean;
  onDisconnect(handler: () => void): () => void;
}

type Notice = { type: "lotus-ready"; revision?: string } | { type: "lotus-restart"; pausedAt?: number };

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const failed = () => new Error("受管进程未能完成启动交接。");

function validPausedAt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function createManagedHandoff(): ManagedHandoff {
  const token = process.env.LOTUS_MANAGED_TOKEN;
  const held = process.env.LOTUS_MANAGED_HELD === "1";
  const paused = process.env.LOTUS_MANAGED_PAUSED_AT;
  delete process.env.LOTUS_MANAGED_TOKEN;
  delete process.env.LOTUS_MANAGED_HELD;
  delete process.env.LOTUS_MANAGED_PAUSED_AT;

  if (!token || !uuid.test(token) || typeof process.send !== "function" || process.connected !== true) {
    return {
      managed: false,
      accepting: true,
      async ready() {},
      restart: () => false,
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

  function connected() {
    return !disconnected && process.connected === true;
  }

  process.once("disconnect", () => {
    disconnected = true;
    accepting = false;
    for (const handler of handlers) handler();
    handlers.clear();
  });
  process.channel?.unref();

  function onDisconnect(handler: () => void) {
    if (connected()) handlers.add(handler);
    else handler();
    return () => { handlers.delete(handler); };
  }

  function notify(message: Notice): boolean {
    if (!connected()) return false;
    try {
      return send({ ...message, token }, () => undefined) === true;
    } catch {
      return false;
    }
  }

  async function reportReady(revision: string | undefined, signal: AbortSignal) {
    if (signal.aborted || !connected() || (held && revision === undefined) ||
        (revision !== undefined && !isGitRevision(revision))) throw failed();

    const message = { type: "lotus-ready", ...(revision === undefined ? {} : { revision }) } as const;
    if (!held) {
      if (!notify(message)) throw failed();
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
    } finally {
      stopWatching();
      signal.removeEventListener("abort", abort);
      process.off("message", activate);
      process.channel?.unref();
    }
  }

  return {
    managed: true,
    pausedAt: validPausedAt(pausedAt) ? pausedAt : undefined,
    get accepting() { return accepting && connected(); },
    ready(revision, signal) {
      return readiness ??= reportReady(revision, signal);
    },
    restart(pausedAt) {
      if (!accepting || restarting || (pausedAt !== undefined && !validPausedAt(pausedAt))) return false;
      if (!notify({ type: "lotus-restart", ...(pausedAt === undefined ? {} : { pausedAt }) })) return false;
      restarting = true;
      return true;
    },
    onDisconnect,
  };
}
