import "../lib/i18n-preload.ts";
import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { formatTerminalLog, formattedLogLevel, installTerminalLogging } from "../lib/terminal-log-format.ts";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { managedDispatchPauseFile } from "../lib/managed-dispatch-pause.ts";
import { lockFile, managedStartupLockPath } from "../lib/file-lock.ts";
import { stopForeground } from "../lib/foreground-control.ts";
import { backgroundCleanStop, backgroundStartupFailure } from "../lib/managed-exit.ts";
import { recoverMigrationPublicationForStartup } from "../lib/migration-publication.ts";
import { realpathSync } from "node:fs";
import { userInfo } from "node:os";

const name = "LOTUS-YUNZAI";
const legacyName = "lotus-yunzai";
const startToken = "LOTUS_PM2_START_TOKEN";
const workerReadiness = "LOTUS_PM2_WORKER_READINESS";
const listenTimeoutMs = 120_000;
const registrationGraceMs = 5_000;
const cancelledRegistrationGraceMs = 750;

async function prepareStartup(directory: string, channel: "live" | "latest" | undefined, signal: AbortSignal, initialize = false) {
  signal.throwIfAborted();
  // Bun reads dotenv in the initialization and worker processes, not in their long-lived parent.
  const setup = Bun.spawn([process.execPath, "scripts/startup.ts", ...(initialize ? ["--initialize"] : []), ...(channel ? [channel] : [])], {
    cwd: directory, stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  const stop = () => setup.kill("SIGTERM");
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    const exit = await setup.exited;
    signal.throwIfAborted();
    return exit === 0;
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

function readCommand(args: string[]) {
  const [action, option, ...remaining] = args;
  if (action === "logs") return { action, options: args.slice(1) } as const;
  if (remaining.length === 0) {
    if (action === "init" && (option === undefined || option === "live" || option === "latest")) {
      return { action, channel: option as "live" | "latest" | undefined } as const;
    }
    if (option === undefined && (action === "start" || action === "start:bg" || action === "stop" || action === "restart" || action === "status")) {
      return { action } as const;
    }
  }
  throw new Error($t("scripts.launcher.text_1b1cad616b"));
}

function pm2Executable() {
  if (process.platform === "win32") throw new Error($t("scripts.launcher.text_ffe7c1e5d6"));
  const binary = Bun.which("pm2");
  if (!binary) throw new Error($t("scripts.launcher.text_306fc16aea"));
  return binary;
}

function pm2Command(binary: string, ...args: readonly string[]) {
  // The bundled CLI is JavaScript. Run it with the same Bun instead of relying
  // on its /usr/bin/env node shebang on a Bun-only installation.
  try {
    const local = fileURLToPath(new URL("../node_modules/pm2/bin/pm2", import.meta.url));
    if (realpathSync(binary) === realpathSync(local)) return [process.execPath, local, ...args];
  } catch { /* Global and test-provided PM2 executables keep their own interpreter. */ }
  return [binary, ...args];
}

async function present(path: string) {
  return lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  });
}

async function relayLogOutput(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let pending = "";
  const emit = (line: string) => process.stdout.write(
    /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\[[A-Z]+\]/u.test(line)
      ? formatTerminalLog(formattedLogLevel(line, "info"), line) + "\n" : line + "\n");
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) { emit(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (pending.length > 64_000) { process.stdout.write(pending); pending = ""; }
      if (done) break;
    }
    if (pending) emit(pending);
  } finally { reader.releaseLock(); }
}

async function waitForLogs(child: Pick<Bun.Subprocess, "kill" | "exited"> & { exitCode?: number | null; stdout?: ReadableStream<Uint8Array> | number | null }): Promise<number> {
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    if (child.exitCode !== undefined && child.exitCode !== null) return;
    child.kill("SIGINT");
  };
  const terminate = () => child.kill("SIGTERM");
  // A PTY (and Bun's run wrapper) can deliver Ctrl+C as a byte instead of an
  // OS signal. Own the viewer's TTY input and forward that key to this client only.
  const terminal = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
  const wasRaw = process.stdin.isRaw === true;
  const wasFlowing = process.stdin.readableFlowing === true;
  const keyboard = (chunk: Buffer | string) => {
    if (typeof chunk === "string" ? chunk.includes("\x03") : chunk.includes(3)) interrupt();
  };
  if (terminal) {
    process.stdin.setRawMode(true);
    process.stdin.on("data", keyboard);
    process.stdin.resume();
  }
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const [code] = await Promise.all([child.exited, child.stdout && typeof child.stdout !== "number" ? relayLogOutput(child.stdout) : undefined]);
    return interrupted && code === 130 ? 0 : code;
  }
  finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    if (terminal) {
      process.stdin.removeListener("data", keyboard);
      process.stdin.setRawMode(wasRaw);
      if (!wasFlowing) process.stdin.pause();
    }
  }
}

async function readBackgroundLogFiles(home: string, options: readonly string[], appName = name): Promise<number | undefined> {
  const directory = join(home, "logs");
  if (!(await present(directory))?.isDirectory()) return;
  const out = (await present(join(directory, `${appName}-out.log`)))?.isFile() ? join(directory, `${appName}-out.log`) : join(directory, `${legacyName}-out.log`);
  const error = (await present(join(directory, `${appName}-error.log`)))?.isFile() ? join(directory, `${appName}-error.log`) : join(directory, `${legacyName}-error.log`);
  const files = [];
  const errorsOnly = options.includes("--err");
  if (!errorsOnly && (await present(out))?.isFile()) files.push(out);
  if ((errorsOnly || !options.includes("--out")) && (await present(error))?.isFile()) files.push(error);
  if (!files.length) return;

  let lines = "15";
  let follow = true;
  for (let index = 0; index < options.length; index++) {
    const option = options[index]!;
    if (option === "--nostream") follow = false;
    else if (option === "--lines") lines = options[++index] ?? "";
    else if (option.startsWith("--lines=")) lines = option.slice("--lines=".length);
    else if (!["--raw", "--out", "--err"].includes(option)) {
      throw new Error($t("scripts.launcher.text_56ba72d1d6"));
    }
  }
  if (!/^\d+$/u.test(lines) || !Number.isSafeInteger(Number(lines))) throw new Error($t("scripts.launcher.text_a176d3bdd3"));

  const tail = Bun.which("tail");
  if (!tail) throw new Error($t("scripts.launcher.text_a128d37bc9"));
  return waitForLogs(Bun.spawn([tail, "-n", lines, ...(follow ? ["-F"] : []), ...files], {
    stdin: "ignore", stdout: "pipe", stderr: "inherit",
  }));
}

async function daemonListening(path: string): Promise<boolean> {
  if (!(await present(path))?.isSocket()) return false;
  // Invoking PM2 against a missing or stale socket can start a new daemon.
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(false);
      else reject(error);
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      reject(new Error($t("scripts.launcher.text_e513d679e6")));
    });
  });
}

async function preparePm2Entry(home: string) {
  const entry = join(home, "host-entry.js");
  const temporary = `${entry}.${crypto.randomUUID()}`;
  const bundle = await Bun.build({
    entrypoints: [fileURLToPath(new URL("managed-entry.ts", import.meta.url))], target: "bun",
  });
  const output = bundle.outputs[0];
  if (!bundle.success || !output) throw new Error($t("scripts.launcher.text_13086c28fe"));
  try {
    await writeFile(temporary, await output.text(), { mode: 0o600, flag: "wx" });
    await rename(temporary, entry);
  } finally {
    await rm(temporary, { force: true });
  }
  return entry;
}

async function pm2(binary: string | undefined, root: string, action: "start:bg" | "stop" | "restart" | "logs" | "status",
  options: readonly string[] = [], startup?: {
    readonly signal: AbortSignal;
    prepare(): Promise<boolean>;
    release(): void;
  },
) {
  const signal = startup?.signal;
  const parent = dirname(root);
  const stateHome = join(parent, `.${basename(root)}.lotus-pm2`);
  const handoffFile = join(root, "data", "pm2-handoff.json");
  const handoffInfo = await present(handoffFile);
  let handoff: { root: string; home: string; name: string; cli: string; rpcSocket?: string; pubSocket?: string } | undefined;
  if (handoffInfo) {
    if (!handoffInfo.isFile() || handoffInfo.uid !== process.getuid?.() || handoffInfo.mode & 0o077 ||
        handoffInfo.nlink !== 1 || handoffInfo.size > 16_384 || await realpath(handoffFile) !== handoffFile) {
      throw new Error($t("scripts.launcher.text_580d4426d4"));
    }
    const parsed = JSON.parse(await readFile(handoffFile, "utf8"));
    if (parsed.format !== 1 || parsed.root !== root || ![parsed.home, parsed.cli].every(value =>
      typeof value === "string" && value.startsWith("/") && !/[\r\n\0]/u.test(value)) ||
      typeof parsed.name !== "string" || !parsed.name || /[\\/\r\n\0]/u.test(parsed.name) || parsed.name === "." || parsed.name === ".." ||
      [parsed.rpcSocket, parsed.pubSocket].some(value => value !== undefined &&
        (typeof value !== "string" || !value.startsWith("/") || /[\r\n\0]/u.test(value)))) {
      throw new Error($t("scripts.launcher.text_580d4426d4"));
    }
    handoff = parsed;
    binary = handoff!.cli;
  }
  const home = handoff?.home ?? stateHome;
  const appName = handoff?.name ?? name;
  const markers = (path: string) => handoff && path === home ? stateHome : path;
  const legacyHome = join(root, "data", ".pm2");
  async function privateHome(path: string) {
    const directory = await present(path);
    if (directory && (!directory.isDirectory() || directory.uid !== process.getuid?.() ||
        directory.mode & (handoff && path === home ? 0o022 : 0o077) || await realpath(path) !== path)) {
      throw new Error($t("scripts.launcher.text_580d4426d4"));
    }
    return directory !== undefined;
  }
  // PM2 also accepts socket and state path overrides through environment variables.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PM2_")));
  const spawnOptions = (path: string) => ({
    cwd: parent, env: { ...env, PM2_HOME: path,
      ...(handoff?.rpcSocket && { PM2_RPC_PORT: handoff.rpcSocket }),
      ...(handoff?.pubSocket && { PM2_PUB_PORT: handoff.pubSocket }) }, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  } as const);
  async function application(path: string, attempt?: string) {
    if (!await privateHome(path) || !await daemonListening(handoff && path === home ? handoff.rpcSocket ?? join(path, "rpc.sock") : join(path, "rpc.sock"))) return;
    if (!binary) throw new Error($t("scripts.launcher.text_8e593cd64e"));
    const lookup = Bun.spawn(pm2Command(binary, "jlist"), { ...spawnOptions(path), stdout: "pipe", timeout: 2_500 });
    const [code, result] = await Promise.all([lookup.exited, new Response(lookup.stdout).text()]);
    if (code !== 0) throw new Error($t("scripts.launcher.text_d83512dfbd"));
    let processes: unknown;
    // A daemon/CLI version warning can precede jlist's JSON.
    for (let index = result.lastIndexOf("["); index >= 0; index = result.lastIndexOf("[", index - 1)) {
      try { const candidate: unknown = JSON.parse(result.slice(index)); if (Array.isArray(candidate)) { processes = candidate; break; } } catch {}
      if (index === 0) break;
    }
    if (!Array.isArray(processes)) throw new Error($t("scripts.launcher.text_539f1a325c"));
    const named = processes.filter((item) => item?.name === appName || !handoff && item?.name === legacyName);
    if ((action === "restart" || action === "stop") && named.length > 1) {
      throw new Error($t("scripts.launcher.text_b7c75acfc5"));
    }
    const process = named.find((item) => attempt === undefined || item.pm2_env?.env?.[startToken] === attempt);
    if (!process) return;
    const status: unknown = process.pm2_env?.status;
    if (typeof status !== "string") throw new Error($t("scripts.launcher.text_539f1a325c"));
    const pid: unknown = process.pid;
    const id: unknown = process.pm_id;
    const token: unknown = process.pm2_env?.env?.[startToken];
    const args: unknown = process.pm2_env?.args;
    const cwd: unknown = process.pm2_env?.pm_cwd;
    const readyFile = join(markers(path), "host-ready");
    const owned = Array.isArray(args) && process.pm2_env?.exec_interpreter === "none" &&
      (path === legacyHome
        ? cwd === root && args.length === 3 && args[0] === join(root, "scripts", "run-managed.ts") &&
          args[1] === root && args[2] === readyFile
        : cwd === parent && (args.length === 4 && token === undefined ||
          args.length === 5 && typeof token === "string" && args[4] === token) &&
          args[0] === "--no-env-file" && args[1] === join(markers(path), "host-entry.js") && args[2] === root && args[3] === readyFile);
    return { path, status, active: status !== "stopped" && status !== "errored",
      pid: typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? String(pid) : undefined,
      id: typeof id === "number" && Number.isSafeInteger(id) && id >= 0 ? String(id) : undefined,
      owned, token: typeof token === "string" ? token : undefined,
      workerToken: process.pm2_env?.env?.[workerReadiness] === "1" && typeof token === "string" ? token : undefined };
  }

  let current = await application(home);
  const legacy = current?.active && action !== "restart" ? undefined : await application(legacyHome);
  const active = [current, legacy].find((entry) => entry?.active);
  if (action === "stop") {
    if (!active) {
      const stopped = await stopForeground(root);
      console.log(stopped ? $t("scripts.launcher.text_eb2b9b4a60") : $t("scripts.launcher.text_08afaaff27"));
      return 0;
    }
    if (!binary || !active.owned || active.id === undefined) throw new Error($t("scripts.launcher.text_f8d1d9b3c0"));
    const checked = await application(active.path, active.token);
    if (!checked?.active || !checked.owned || checked.id !== active.id || checked.pid !== active.pid || checked.token !== active.token) {
      throw new Error($t("scripts.launcher.text_2021cc549c"));
    }
    return Bun.spawn(pm2Command(binary, "stop", active.id), spawnOptions(active.path)).exited;
  }
  const selected = active ?? current ?? legacy;
  if (handoff && selected && !selected.owned) throw new Error($t("scripts.launcher.text_f8d1d9b3c0"));
  if (action === "logs" && !selected) {
    // A failed replacement may remove the stopped registration while leaving all of its logs.
    for (const path of [home, legacyHome]) {
      if (!await privateHome(path)) continue;
      const status = await readBackgroundLogFiles(path, options, appName);
      if (status !== undefined) return status;
    }
    throw new Error($t("scripts.launcher.text_78a53b0efd"));
  }
  if (!binary) throw new Error($t("scripts.launcher.text_e6601e13ec"));
  const executable = binary;
  if (action !== "start:bg" && action !== "restart") {
    if (!selected) {
      console.log($t("scripts.launcher.text_8afec76506"));
      return 0;
    }
    const args = action === "status" ? ["status", ...(handoff && selected.id ? [selected.id] : [])] : [action, selected.id ?? appName, ...(action === "logs" && !options.includes("--raw") ? ["--raw"] : []), ...options];
    const client = Bun.spawn(pm2Command(binary, ...args), { ...spawnOptions(selected.path), ...(action === "logs" && { stdout: "pipe" as const }) });
    return action === "logs" ? waitForLogs(client) : client.exited;
  }

  signal?.throwIfAborted();
  function readMarker(path: string, marker: "host-ready" | "host-start-attempt") {
    return readFile(join(markers(path), marker), "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    });
  }
  const readyPid = (path: string) => readMarker(path, "host-ready");
  if (active && action === "start:bg") {
    let ready = active.status === "online" && !!active.pid && active.pid === await readyPid(active.path);
    if (!ready && active.workerToken && active.id && active.pid) {
      // Observing a registered supervisor does not need the lock held for creating or stopping one.
      startup?.release();
      const until = performance.now() + listenTimeoutMs;
      while (!ready && performance.now() < until) {
        signal?.throwIfAborted();
        await Bun.sleep(100);
        const observed = await application(active.path, active.workerToken);
        signal?.throwIfAborted();
        if (!observed?.active || observed.id !== active.id || observed.pid !== active.pid) {
          throw new Error($t("scripts.launcher.text_d860c70b85"));
        }
        ready = observed.status === "online" && observed.pid === await readyPid(active.path);
      }
      signal?.throwIfAborted();
      if (!ready) throw new Error($t("scripts.launcher.text_ed1ee39b7f"));
    }
    signal?.throwIfAborted();
    if (!ready) {
      throw new Error($t("scripts.launcher.text_38260bef39"));
    }
    console.log($t("scripts.launcher.text_2edbb0a5f4"));
    return 0;
  }
  if (action === "restart") {
    if ((current && !current.owned) || (legacy && !legacy.owned)) throw new Error($t("scripts.launcher.text_938f80f0f2"));
    if (current?.active && legacy?.active) throw new Error($t("scripts.launcher.text_ae51f77ba2"));
    if (active?.id === undefined || !active.pid) throw new Error($t("scripts.launcher.text_88f0ec7dc3"));
    if (active.status !== "online" || await readyPid(active.path) !== active.pid) {
      throw new Error($t("scripts.launcher.text_b4daf30f5d"));
    }
    if (!active.workerToken && startup && !await startup.prepare()) return 1;
    signal?.throwIfAborted();
    if (active.workerToken) {
      if (await readMarker(active.path, "host-start-attempt") !== active.workerToken) {
        throw new Error($t("scripts.launcher.text_9294ba0793"));
      }
      // Refresh the bundle without replacing the registration or its pause state.
      await preparePm2Entry(markers(active.path));
    }
    const before = await application(active.path);
    if (!before?.owned || before.id !== active.id || before.pid !== active.pid || before.token !== active.token ||
        before.status !== "online" || await readyPid(active.path) !== before.pid) {
      throw new Error($t("scripts.launcher.text_12abae5a77"));
    }
    signal?.throwIfAborted();
    if (active.workerToken) {
      const until = performance.now() + listenTimeoutMs + 25_000;
      const code = await Bun.spawn(pm2Command(binary, "restart", active.id), { ...spawnOptions(active.path), timeout: listenTimeoutMs + 25_000 }).exited;
      if (code !== 0) return code;
      do {
        signal?.throwIfAborted();
        const restarted = await application(active.path, active.workerToken);
        if (!restarted?.owned || !restarted.active || restarted.id !== active.id) break;
        if (restarted.status === "online" && restarted.pid && restarted.pid !== active.pid &&
            restarted.pid === await readyPid(active.path)) {
          console.log($t("scripts.launcher.text_fc5b32fd78"));
          return 0;
        }
        await Bun.sleep(100);
      } while (performance.now() < until);
      throw new Error($t("scripts.launcher.text_15dffcfc9e"));
    }
    const code = await Bun.spawn(pm2Command(binary, "stop", active.id), { ...spawnOptions(active.path), timeout: 25_000 }).exited;
    if (code !== 0) return code;
    const stopped = await application(active.path);
    if (!stopped?.owned || stopped.id !== active.id || stopped.active || stopped.pid !== undefined) {
      throw new Error($t("scripts.launcher.text_a20ff4248b"));
    }
    current = await application(home);
    if (current && (!current.owned || current.active)) throw new Error($t("scripts.launcher.text_b2878ee091"));
  }
  if (action === "start:bg" && startup && !await startup.prepare()) return 1;
  signal?.throwIfAborted();
  await mkdir(stateHome, { mode: 0o700, recursive: true });
  await privateHome(stateHome);
  await mkdir(home, { mode: 0o700, recursive: true });
  await privateHome(home);
  const spawn = spawnOptions(home);
  const readyFile = join(stateHome, "host-ready");
  const attemptFile = join(stateHome, "host-start-attempt");
  const entry = await preparePm2Entry(stateHome);
  await rm(readyFile, { force: true });
  // A deliberate new registration starts a new session. PM2 recovery reuses the existing attempt.
  await rm(join(stateHome, managedDispatchPauseFile), { force: true });
  const config = join(stateHome, "host-process.json");
  const attempt = crypto.randomUUID();
  await writeFile(attemptFile, attempt, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ apps: [{
    name: appName, cwd: parent, script: process.execPath, args: ["--no-env-file", entry, root, readyFile, attempt],
    env: { [startToken]: attempt, [workerReadiness]: "1" }, interpreter: "none", autorestart: true,
    stop_exit_codes: [backgroundCleanStop, backgroundStartupFailure],
    min_uptime: 5_000, max_restarts: 5, wait_ready: true, listen_timeout: listenTimeoutMs,
    kill_timeout: 20_000, vizion: false, pmx: false, treekill: false, time: false,
  }] }), { mode: 0o600 });
  signal?.throwIfAborted();

  // PM2 updates a registered application's environment by merging it into the old one.
  // Start with a fresh registration while retaining the daemon and its log files.
  if (current) {
    const retained = await application(home);
    signal?.throwIfAborted();
    if (retained && (retained.active || retained.pid !== undefined || retained.id === undefined ||
        retained.id !== current.id ||
        await Bun.spawn(pm2Command(binary, "delete", retained.id), { ...spawn, stdout: "ignore", timeout: 2_500 }).exited !== 0)) {
      throw new Error($t("scripts.launcher.text_ec937bf293"));
    }
    signal?.throwIfAborted();
  }

  const start = Bun.spawn(pm2Command(binary, "start", config, "--only", appName), spawn);
  const cancelled = Promise.withResolvers<void>();
  const interrupt = () => cancelled.resolve();
  signal?.addEventListener("abort", interrupt, { once: true });

  async function stopOwnedApplication(id: string | undefined) {
    if (id === undefined ||
        await Bun.spawn(pm2Command(executable, "stop", id), { ...spawn, timeout: 25_000 }).exited !== 0) {
      throw new Error($t("scripts.launcher.text_49e7c891f3"));
    }
  }

  async function waitForRegistration(ms: number) {
    const until = performance.now() + ms;
    do {
      const process = await application(home, attempt).catch(() => undefined);
      if (process) return process;
      await Bun.sleep(50);
    } while (performance.now() < until);
  }

  async function cancelStart() {
    try {
      // A configuration already submitted to the daemon may be registered after the client exits.
      const revoked = await rm(attemptFile, { force: true }).then(() => true, () => false);
      // Once started, the PM2 client can still be submitting its registration when the signal arrives.
      let launched = await waitForRegistration(registrationGraceMs);
      if (!launched && start.exitCode === null && start.signalCode === null) {
        start.kill("SIGKILL");
      }
      launched ??= await waitForRegistration(cancelledRegistrationGraceMs);
      if (launched?.active) await stopOwnedApplication(launched.id);
      if (!revoked) throw new Error($t("scripts.launcher.text_0253e26568"));
    } finally {
      if (start.exitCode === null && start.signalCode === null) start.kill("SIGKILL");
      await start.exited;
    }
  }

  try {
    const code = await Promise.race([start.exited, cancelled.promise]);
    signal?.throwIfAborted();
    if (code !== undefined && code !== 0) return code;

    // The marker can outlive the process that wrote it, even before PM2 returns from start.
    const launched = await application(home, attempt);
    const ready = await readyPid(home);
    signal?.throwIfAborted();
    if (launched?.status === "online" && launched.pid && launched.pid === ready) {
      if (action === "restart") console.log($t("scripts.launcher.text_fc5b32fd78"));
      return 0;
    }
    if (launched?.active && !/^[1-9]\d*$/u.test(ready ?? "")) await stopOwnedApplication(launched.id);
    throw new Error($t("scripts.launcher.text_cf71dcee13"));
  } catch (error) {
    if (signal?.aborted) {
      await cancelStart();
      signal.throwIfAborted();
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", interrupt);
  }
}

async function serviceOperation(root: string, command: ReturnType<typeof readCommand>): Promise<number | undefined> {
  if (command.action === "init") return;
  const path = join(root, "data", "boot-handoff", "service.json");
  const info = await present(path);
  if (!info) return;
  const messages = JSON.parse(await readFile(new URL("../i18n/legacy-migrate/zh-CN.json", import.meta.url), "utf8")).messages;
  const serviceText = createTextTranslator("legacy-migrate", messages);
  const failure = (key: string) => new Error(serviceText(key));
  if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.nlink !== 1 || info.size > 16_384 || await realpath(path) !== path) throw failure("systemd_identity");
  const mapping = JSON.parse(await readFile(path, "utf8"));
  if (mapping.format !== 1 || mapping.root !== root || mapping.uid !== process.getuid?.() ||
      !["user", "system"].includes(mapping.scope) || typeof mapping.unit !== "string" ||
      !/^[A-Za-z0-9_.@:\\-]+\.service$/u.test(mapping.unit) || mapping.unit.startsWith("-")) throw failure("systemd_identity");
  const systemctl = Bun.which("systemctl") ?? "/usr/bin/systemctl";
  const flags = [...(mapping.scope === "user" ? ["--user"] : []), "--no-ask-password", "--no-pager"];
  async function identity() {
    const lookup = Bun.spawn([systemctl, ...flags, "show", mapping.unit, "--property=MainPID,ActiveState,Type,WorkingDirectory,ExecStart,User"],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore", timeout: 5_000 });
    const [code, output] = await Promise.all([lookup.exited, new Response(lookup.stdout).text(), new Response(lookup.stderr).text()]);
    if (code !== 0) throw failure("systemd_permissions");
    const fields = Object.fromEntries(output.split(/\r?\n/u).flatMap(line => {
      const index = line.indexOf("="); return index > 0 ? [[line.slice(0, index), line.slice(index + 1)]] : [];
    }));
    if (fields.Type !== "simple" || fields.WorkingDirectory !== root || !fields.ExecStart?.includes(join(root, "scripts/launcher.ts")) ||
        mapping.scope === "system" && fields.User !== String(mapping.uid) && fields.User !== userInfo().username && !(mapping.uid === 0 && !fields.User)) throw failure("systemd_identity");
    const pid = Number(fields.MainPID);
    if (!Number.isSafeInteger(pid) || pid < 0) throw failure("systemd_identity");
    if (pid > 0) {
      const args = (await readFile(`/proc/${pid}/cmdline`)).toString().split("\0").filter(Boolean);
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      if (!args.includes(join(root, "scripts/launcher.ts")) || args.at(-1) !== "start" ||
          Number(/^Uid:\s+(\d+)/mu.exec(status)?.[1]) !== mapping.uid) throw failure("systemd_identity");
    }
    return { pid, active: fields.ActiveState };
  }
  const current = await identity();
  if (command.action === "start" && process.env.LOTUS_SERVICE_READY_FILE === join(root, "data/boot-handoff/service-ready.json")) {
    if (current.pid !== process.pid) throw failure("systemd_identity");
    return;
  }
  if (command.action === "logs") {
    const args = [...(mapping.scope === "user" ? ["--user"] : []), "--unit", mapping.unit, "--output=cat", "--no-pager"];
    if (!command.options.includes("--nostream")) args.push("--follow");
    const at = command.options.indexOf("--lines");
    const count = at < 0 ? "15" : command.options[at + 1];
    if (typeof count !== "string" || !/^\d{1,7}$/u.test(count)) throw failure("command");
    args.push("--lines", count);
    if (command.options.includes("--err")) args.push("--priority=err");
    else if (command.options.includes("--out")) args.push("PRIORITY=6");
    const viewer = Bun.spawn([Bun.which("journalctl") ?? "/usr/bin/journalctl", ...args], { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
    return waitForLogs(viewer);
  }
  async function operate(action: string): Promise<number> {
    await identity();
    const run = (prefix: string[]) => Bun.spawn([...prefix, ...flags, action, mapping.unit], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let child = run([systemctl]);
    let [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0 && mapping.scope === "system" && /(?:access denied|permission|authentication)/iu.test(error)) {
      await identity();
      child = run([Bun.which("sudo") ?? "/usr/bin/sudo", "-n", "--", systemctl]);
      [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    }
    if (output) process.stdout.write(output);
    if (error) process.stderr.write(error);
    return code;
  }
  const action = command.action === "start" || command.action === "start:bg" ? "start" : command.action;
  if (action === "restart") { const reset = await operate("reset-failed"); if (reset !== 0) return reset; }
  const code = await operate(action);
  if (code !== 0 || action === "status" || action === "stop") return code;
  const until = Date.now() + listenTimeoutMs;
  while (Date.now() < until) {
    const observed = await identity();
    const ready = JSON.parse(await readFile(join(root, "data/boot-handoff/service-ready.json"), "utf8").catch(() => "null"));
    if (observed.active === "active" && ready?.pid === observed.pid && ready.root === root) return 0;
    if (observed.active === "failed" || observed.active === "inactive") throw failure("systemd_ready");
    await Bun.sleep(100);
  }
  throw failure("systemd_ready");
}

async function run() {
  const command = readCommand(Bun.argv.slice(2));
  const directory = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const service = await serviceOperation(directory, command);
  if (service !== undefined) return service;
  if (command.action === "status") return pm2(pm2Executable(), directory, "status");
  if (command.action === "logs") {
    const binary = process.platform === "win32" ? pm2Executable() : Bun.which("pm2") ?? undefined;
    return pm2(binary, directory, "logs", command.options);
  }

  // Managed replacement can rename the checkout while this lock is held.
  const lock = await lockFile(managedStartupLockPath(directory),
    $t("scripts.launcher.text_837c8d2798"), 2_000, $t("scripts.launcher.text_c0b7ac1462"));
  let lockHeld = true;
  function releaseStartup() {
    if (!lockHeld) return;
    lock.close();
    lockHeld = false;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error($t("scripts.launcher.text_5893b8086e")));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (command.action === "stop") {
      const result = await pm2(Bun.which("pm2") ?? undefined, directory, "stop");
      if (result === 0 && await Bun.file(new URL("lib/managed-valkey.ts", Bun.pathToFileURL(directory + "/"))).exists()) {
        const { stopManagedValkey } = await import("../lib/managed-valkey.ts");
        await stopManagedValkey(Bun.pathToFileURL(directory + "/"));
      }
      return result;
    }
    await recoverMigrationPublicationForStartup(directory);
    if (command.action === "start:bg" || command.action === "restart") {
      return await pm2(pm2Executable(), directory, command.action, [], {
        signal: controller.signal,
        prepare: () => prepareStartup(directory, undefined, controller.signal),
        release: releaseStartup,
      });
    }
    if (!await prepareStartup(directory, command.action === "init" ? command.channel : undefined,
      controller.signal, command.action === "init")) return 1;
    if (command.action === "init") {
      console.log($t("scripts.launcher.text_4feb86a82c"));
      return 0;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    releaseStartup();
  }
  const { runManaged } = await import("./run-managed.ts");
  const readyPath = process.env.LOTUS_SERVICE_READY_FILE;
  let observe: ((ready: boolean) => Promise<void>) | undefined;
  if (readyPath !== undefined) {
    if (readyPath !== join(directory, "data", "boot-handoff", "service-ready.json")) {
      throw new Error($t("scripts.launcher.text_580d4426d4"));
    }
    for (const path of [join(directory, "data"), dirname(readyPath)]) {
      if (!await present(path)) await mkdir(path, { mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077 || await realpath(path) !== path) {
        throw new Error($t("scripts.launcher.text_580d4426d4"));
      }
    }
    let pending = Promise.resolve();
    observe = (ready) => pending = pending.catch(() => {}).then(async () => {
      if (!ready) { await rm(readyPath, { force: true }); return; }
      const temporary = readyPath + "." + crypto.randomUUID();
      try {
        await writeFile(temporary, JSON.stringify({ pid: process.pid, root: directory }) + "\n", { flag: "wx", mode: 0o600 });
        await rename(temporary, readyPath);
      } finally { await rm(temporary, { force: true }); }
    });
    await observe(false);
  }
  try {
    return await runManaged(directory, observe ? () => observe!(true) : undefined,
      observe ? (ready) => { void observe!(ready).catch(() => {}); } : undefined);
  }
  finally {
    await observe?.(false);
    if (await Bun.file(new URL("lib/managed-valkey.ts", Bun.pathToFileURL(directory + "/"))).exists()) {
      const { stopManagedValkey } = await import("../lib/managed-valkey.ts");
      await stopManagedValkey(Bun.pathToFileURL(directory + "/"));
    }
  }
}

if (import.meta.main) {
  installTerminalLogging();
  try {
    process.exitCode = await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : $t("scripts.launcher.text_b72f0f9e05"));
    process.exitCode = 1;
  }
}
