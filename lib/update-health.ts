import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { delimiter, dirname, isAbsolute } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { isGitRevision } from "./local-git.ts";
import { pluginProbeTokenEnvironment, pluginStartupGraceMs, readPluginLoading } from "./plugin-load-progress.ts";

const failure = $t("lib.update-health.text_02cecbc624");
const listenLine = /(?:^|\n)(?:\[\d{2}:\d{2}:\d{2}\.\d{3}\]\[(?:MARK|INFO)\] \[HTTP\] )?HTTP 正在监听 http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/status\r?\n/u;
const stopTimeout = 1_000;
const maxBodyBytes = 4_096;

function monitorPort(stream: ReadableStream<Uint8Array>) {
  const port = Promise.withResolvers<number | undefined>();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const draining = (async () => {
    let tail = "";
    let found = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (found) continue;
        const output = tail + decoder.decode(chunk.value, { stream: true });
        const match = listenLine.exec(stripVTControlCharacters(output));
        const value = match && Number(match[1]);
        if (value && value <= 65_535) {
          port.resolve(value);
          found = true;
          tail = "";
        } else {
          tail = output.slice(-256);
        }
      }
    } catch {
      // Do not retain or emit candidate output.
    } finally {
      port.resolve(undefined);
      reader.releaseLock();
    }
  })();
  return {
    port: port.promise,
    async close() {
      await reader.cancel().catch(() => undefined);
      await draining;
    },
  };
}

async function healthy(port: number, token: string, revision: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      redirect: "error", proxy: false, signal: AbortSignal.any([signal, AbortSignal.timeout(600)]),
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return false;
    }

    const decoder = new TextDecoder();
    let size = 0;
    let body = "";
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBodyBytes) return false;
      body += decoder.decode(chunk, { stream: true });
    }
    const value: unknown = JSON.parse(body + decoder.decode());
    return typeof value === "object" && value !== null && "status" in value && value.status === "ok" &&
      "revision" in value && value.revision === revision;
  } catch {
    return false;
  }
}

async function stopCandidate(child: Pick<Bun.Subprocess, "pid" | "exitCode" | "signalCode" | "kill" | "exited">) {
  if (child.exitCode === null && child.signalCode === null) {
    const timer = setTimeout(() => {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, stopTimeout);
    try {
      child.kill("SIGTERM");
      await child.exited;
    } finally {
      clearTimeout(timer);
    }
  }
  await child.exited;
}

export async function verifyUpdateHealth(directory: string, revision: string, signal?: AbortSignal): Promise<void> {
  if (!isGitRevision(revision) || signal?.aborted) throw new Error(failure);
  const token = crypto.randomUUID();
  const probeToken = crypto.randomUUID();
  const path = (process.env.PATH ?? "").split(delimiter).filter(isAbsolute);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:LANG|LANGUAGE|LC_[A-Z_]+|TZ)$/u.test(key))),
    PATH: [dirname(process.execPath), ...path].join(delimiter),
    LOTUS_LISTEN_HOST: "127.0.0.1",
    LOTUS_HTTP_PORT: "0",
    LOTUS_HTTP_TOKEN: token,
    [pluginProbeTokenEnvironment]: probeToken,
  };
  try {
    const lifetime = new AbortController();
    const ended = Promise.withResolvers<undefined>();
    const ipcPort = Promise.withResolvers<number>();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let nextIndex = 1;
    let watchingStartup = true;

    function finish() {
      lifetime.abort();
      ended.resolve(undefined);
    }
    function arm(wait = 0) {
      clearTimeout(watchdog);
      watchdog = setTimeout(finish, pluginStartupGraceMs + wait);
    }
    function onProgress(message: unknown) {
      if (!watchingStartup || lifetime.signal.aborted) return;
      if (typeof message === "object" && message !== null) {
        const { type, token: source, host, port } = message as Record<string, unknown>;
        if (type === "lotus-yunzai-probe-listener" && source === probeToken && host === "127.0.0.1" &&
            typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65_535) {
          ipcPort.resolve(port);
          return;
        }
      }
      const wait = readPluginLoading(message, probeToken, nextIndex);
      if (wait === undefined) return;
      nextIndex++;
      arm(wait);
    }

    const child = Bun.spawn([process.execPath, "run", "--no-env-file", "--no-orphans", "--no-install", "app.ts"], {
      cwd: directory, env, detached: true, stdin: "ignore", stdout: "pipe", stderr: "ignore", ipc: onProgress,
    });
    void child.exited.then(finish, finish);
    arm();
    const listener = monitorPort(child.stdout);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
    let verified = false;
    try {
      const port = await Promise.race([ipcPort.promise, listener.port, ended.promise]);
      if (port === undefined || lifetime.signal.aborted) throw new Error(failure);
      watchingStartup = false;
      arm();
      while (!lifetime.signal.aborted) {
        if (await healthy(port, token, revision, lifetime.signal) && !lifetime.signal.aborted) {
          verified = true;
          break;
        }
        await delay(50, undefined, { signal: lifetime.signal });
      }
    } finally {
      watchingStartup = false;
      clearTimeout(watchdog);
      signal?.removeEventListener("abort", finish);
      try {
        await stopCandidate(child);
      } finally {
        await listener.close();
      }
    }
    if (verified && !signal?.aborted) return;
  } catch {
    // Fail with a generic message regardless of child output or host error details.
  }
  throw new Error(failure);
}
