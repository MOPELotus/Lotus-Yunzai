import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { managedDispatchPauseFile } from "../lib/managed-dispatch-pause.ts";
import { lockFile, managedStartupLockPath } from "../lib/file-lock.ts";
import { stopForeground } from "../lib/foreground-control.ts";
import { backgroundCleanStop, backgroundStartupFailure } from "../lib/managed-exit.ts";
import { recoverMigrationPublicationForStartup } from "../lib/migration-publication.ts";

const name = "lotus-yunzai";
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
  throw new Error("用法：bun run init [live|latest]、bun run start、bun run start:bg、bun run stop、bun run restart、bun run logs 或 bun run status。");
}

function pm2Executable() {
  if (process.platform === "win32") throw new Error("独立后台托管需要 Linux 或 macOS。可用 bun run start 前台运行。");
  const binary = Bun.which("pm2");
  if (!binary) throw new Error("后台托管需要 PATH 中的 PM2。可用 bun run start 前台运行。");
  return binary;
}

async function present(path: string) {
  return lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
  });
}

async function waitForLogs(child: Pick<Bun.Subprocess, "kill" | "exited">): Promise<number> {
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try { return await child.exited; }
  finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

async function readBackgroundLogFiles(home: string, options: readonly string[]): Promise<number | undefined> {
  const directory = join(home, "logs");
  if (!(await present(directory))?.isDirectory()) return;
  const out = join(directory, `${name}-out.log`);
  const error = join(directory, `${name}-error.log`);
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
      throw new Error("当前没有 PM2 登记。历史日志支持 --lines、--nostream、--raw、--out 或 --err。");
    }
  }
  if (!/^\d+$/u.test(lines) || !Number.isSafeInteger(Number(lines))) throw new Error("日志行数须为非负整数。");

  const tail = Bun.which("tail");
  if (!tail) throw new Error("读取 PM2 历史日志需要 PATH 中的 tail。");
  return waitForLogs(Bun.spawn([tail, "-n", lines, ...(follow ? ["-F"] : []), ...files], {
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
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
      reject(new Error("无法确认 PM2 守护进程状态。"));
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
  if (!bundle.success || !output) throw new Error("无法准备 PM2 宿主启动入口。");
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
  const home = join(parent, `.${basename(root)}.lotus-pm2`);
  const legacyHome = join(root, "data", ".pm2");
  async function privateHome(path: string) {
    const directory = await present(path);
    if (directory && (!directory.isDirectory() || directory.uid !== process.getuid?.() || directory.mode & 0o077)) {
      throw new Error("PM2 运行目录须为当前用户独占的实体目录（权限 0700）。");
    }
    return directory !== undefined;
  }
  // PM2 also accepts socket and state path overrides through environment variables.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PM2_")));
  const spawnOptions = (path: string) => ({
    cwd: parent, env: { ...env, PM2_HOME: path }, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  } as const);
  async function application(path: string, attempt?: string) {
    if (!await privateHome(path) || !await daemonListening(join(path, "rpc.sock"))) return;
    if (!binary) throw new Error("发现正在运行的 PM2，无法核实后台登记。请确保 PATH 中有 PM2。");
    const lookup = Bun.spawn([binary, "jlist"], { ...spawnOptions(path), stdout: "pipe", timeout: 2_500 });
    const [code, result] = await Promise.all([lookup.exited, new Response(lookup.stdout).text()]);
    if (code !== 0) throw new Error("无法查询 PM2 应用。");
    let processes: unknown;
    try { processes = JSON.parse(result); }
    catch { throw new Error("无法读取 PM2 应用状态。"); }
    if (!Array.isArray(processes)) throw new Error("无法读取 PM2 应用状态。");
    const named = processes.filter((item) => item?.name === name);
    if ((action === "restart" || action === "stop") && named.length > 1) {
      throw new Error("PM2 中存在多个同名登记，无法确认要操作的宿主。");
    }
    const process = named.find((item) => attempt === undefined || item.pm2_env?.env?.[startToken] === attempt);
    if (!process) return;
    const status: unknown = process.pm2_env?.status;
    if (typeof status !== "string") throw new Error("无法读取 PM2 应用状态。");
    const pid: unknown = process.pid;
    const id: unknown = process.pm_id;
    const token: unknown = process.pm2_env?.env?.[startToken];
    const args: unknown = process.pm2_env?.args;
    const cwd: unknown = process.pm2_env?.pm_cwd;
    const readyFile = join(path, "host-ready");
    const owned = Array.isArray(args) && process.pm2_env?.exec_interpreter === "none" &&
      (path === legacyHome
        ? cwd === root && args.length === 3 && args[0] === join(root, "scripts", "run-managed.ts") &&
          args[1] === root && args[2] === readyFile
        : cwd === parent && (args.length === 4 && token === undefined ||
          args.length === 5 && typeof token === "string" && args[4] === token) &&
          args[0] === "--no-env-file" && args[1] === join(path, "host-entry.js") && args[2] === root && args[3] === readyFile);
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
      console.log(stopped ? "当前目录的前台宿主已停止。" : "当前目录未启动托管宿主。");
      return 0;
    }
    if (!binary || !active.owned || active.id === undefined) throw new Error("无法核实当前目录的 PM2 登记。");
    const checked = await application(active.path, active.token);
    if (!checked?.active || !checked.owned || checked.id !== active.id || checked.pid !== active.pid || checked.token !== active.token) {
      throw new Error("PM2 登记在停止前发生变化，请重新确认状态。");
    }
    return Bun.spawn([binary, "stop", active.id], spawnOptions(active.path)).exited;
  }
  const selected = active ?? current ?? legacy;
  if (action === "logs" && !selected) {
    // A failed replacement may remove the stopped registration while leaving all of its logs.
    for (const path of [home, legacyHome]) {
      if (!await privateHome(path)) continue;
      const status = await readBackgroundLogFiles(path, options);
      if (status !== undefined) return status;
    }
    throw new Error("当前目录暂无后台启动日志。");
  }
  if (!binary) throw new Error("后台托管需要 PATH 中的 PM2。");
  const executable = binary;
  if (action !== "start:bg" && action !== "restart") {
    if (!selected) {
      console.log("当前目录未启动后台托管。");
      return 0;
    }
    const args = action === "status" ? ["status"] : [action, name, ...options];
    const client = Bun.spawn([binary, ...args], spawnOptions(selected.path));
    return action === "logs" ? waitForLogs(client) : client.exited;
  }

  signal?.throwIfAborted();
  function readMarker(path: string, marker: "host-ready" | "host-start-attempt") {
    return readFile(join(path, marker), "utf8").catch((error: unknown) => {
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
          throw new Error("等待期间后台宿主已停止或被替换。请运行 bun run status 查看状态。");
        }
        ready = observed.status === "online" && observed.pid === await readyPid(active.path);
      }
      signal?.throwIfAborted();
      if (!ready) throw new Error("后台工作进程尚未就绪。请运行 bun run logs --nostream 查看日志。");
    }
    signal?.throwIfAborted();
    if (!ready) {
      throw new Error("当前目录已有后台进程。请运行 bun run status 查看状态。");
    }
    console.log("当前目录的后台宿主已运行。");
    return 0;
  }
  if (action === "restart") {
    if ((current && !current.owned) || (legacy && !legacy.owned)) throw new Error("同名 PM2 登记不属于当前安装目录。");
    if (current?.active && legacy?.active) throw new Error("新旧 PM2 目录均有活动登记，无法确认要重启的宿主。");
    if (!active?.id || !active.pid) throw new Error("当前目录未启动后台托管。请运行 bun run start:bg。");
    if (active.status !== "online" || await readyPid(active.path) !== active.pid) {
      throw new Error("当前后台工作进程尚未就绪。请运行 bun run status 查看状态。");
    }
    if (!active.workerToken && startup && !await startup.prepare()) return 1;
    signal?.throwIfAborted();
    if (active.workerToken) {
      if (await readMarker(active.path, "host-start-attempt") !== active.workerToken) {
        throw new Error("当前后台启动登记已失效，请运行 bun run status 查看状态。");
      }
      // Refresh the bundle without replacing the registration or its pause state.
      await preparePm2Entry(active.path);
    }
    const before = await application(active.path);
    if (!before?.owned || before.id !== active.id || before.pid !== active.pid || before.token !== active.token ||
        before.status !== "online" || await readyPid(active.path) !== before.pid) {
      throw new Error("后台宿主已变更，请重新确认后重试。");
    }
    signal?.throwIfAborted();
    if (active.workerToken) {
      const until = performance.now() + listenTimeoutMs + 25_000;
      const code = await Bun.spawn([binary, "restart", active.id], { ...spawnOptions(active.path), timeout: listenTimeoutMs + 25_000 }).exited;
      if (code !== 0) return code;
      do {
        signal?.throwIfAborted();
        const restarted = await application(active.path, active.workerToken);
        if (!restarted?.owned || !restarted.active || restarted.id !== active.id) break;
        if (restarted.status === "online" && restarted.pid && restarted.pid !== active.pid &&
            restarted.pid === await readyPid(active.path)) {
          console.log("当前目录的后台宿主已重启。");
          return 0;
        }
        await Bun.sleep(100);
      } while (performance.now() < until);
      throw new Error("后台宿主重启后未就绪。请运行 bun run logs --nostream 查看日志。");
    }
    const code = await Bun.spawn([binary, "stop", active.id], { ...spawnOptions(active.path), timeout: 25_000 }).exited;
    if (code !== 0) return code;
    const stopped = await application(active.path);
    if (!stopped?.owned || stopped.id !== active.id || stopped.active || stopped.pid !== undefined) {
      throw new Error("旧后台宿主未确认停止，未启动替换宿主。");
    }
    current = await application(home);
    if (current && (!current.owned || current.active)) throw new Error("后台登记已变更，未启动替换宿主。");
  }
  if (action === "start:bg" && startup && !await startup.prepare()) return 1;
  signal?.throwIfAborted();
  await mkdir(home, { mode: 0o700, recursive: true });
  await privateHome(home);
  const spawn = spawnOptions(home);
  const readyFile = join(home, "host-ready");
  const attemptFile = join(home, "host-start-attempt");
  const entry = await preparePm2Entry(home);
  await rm(readyFile, { force: true });
  // A deliberate new registration starts a new session. PM2 recovery reuses the existing attempt.
  await rm(join(home, managedDispatchPauseFile), { force: true });
  const config = join(home, "host-process.json");
  const attempt = crypto.randomUUID();
  await writeFile(attemptFile, attempt, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ apps: [{
    name, cwd: parent, script: process.execPath, args: ["--no-env-file", entry, root, readyFile, attempt],
    env: { [startToken]: attempt, [workerReadiness]: "1" }, interpreter: "none", autorestart: true,
    stop_exit_codes: [backgroundCleanStop, backgroundStartupFailure],
    min_uptime: 5_000, max_restarts: 5, wait_ready: true, listen_timeout: listenTimeoutMs,
    kill_timeout: 20_000, vizion: false, pmx: false, treekill: false, time: true,
  }] }), { mode: 0o600 });
  signal?.throwIfAborted();

  // PM2 updates a registered application's environment by merging it into the old one.
  // Start with a fresh registration while retaining the daemon and its log files.
  if (current) {
    const retained = await application(home);
    signal?.throwIfAborted();
    if (retained && (retained.active || retained.pid !== undefined || retained.id === undefined ||
        retained.id !== current.id ||
        await Bun.spawn([binary, "delete", retained.id], { ...spawn, stdout: "ignore", timeout: 2_500 }).exited !== 0)) {
      throw new Error("无法替换已停止的 PM2 登记，请运行 bun run status 查看状态。");
    }
    signal?.throwIfAborted();
  }

  const start = Bun.spawn([binary, "start", config, "--only", name], spawn);
  const cancelled = Promise.withResolvers<void>();
  const interrupt = () => cancelled.resolve();
  signal?.addEventListener("abort", interrupt, { once: true });

  async function stopOwnedApplication(id: string | undefined) {
    if (id === undefined ||
        await Bun.spawn([executable, "stop", id], { ...spawn, timeout: 25_000 }).exited !== 0) {
      throw new Error("未能停止本次后台启动，请运行 bun run status 查看状态。");
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
      if (!revoked) throw new Error("无法撤销本次后台启动，请运行 bun run status 查看状态。");
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
      if (action === "restart") console.log("当前目录的后台宿主已重启。");
      return 0;
    }
    if (launched?.active && !/^[1-9]\d*$/u.test(ready ?? "")) await stopOwnedApplication(launched.id);
    throw new Error("后台宿主未就绪。请运行 bun run logs --nostream 查看日志后重试。");
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

async function run() {
  const command = readCommand(Bun.argv.slice(2));
  const directory = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  if (command.action === "status") return pm2(pm2Executable(), directory, "status");
  if (command.action === "logs") {
    const binary = process.platform === "win32" ? pm2Executable() : Bun.which("pm2") ?? undefined;
    return pm2(binary, directory, "logs", command.options);
  }

  // Managed replacement can rename the checkout while this lock is held.
  const lock = await lockFile(managedStartupLockPath(directory),
    "启动操作", 2_000, "当前目录正在执行启动操作，请稍后重试。");
  let lockHeld = true;
  function releaseStartup() {
    if (!lockHeld) return;
    lock.close();
    lockHeld = false;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("启动操作已中止。"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (command.action === "stop") return await pm2(Bun.which("pm2") ?? undefined, directory, "stop");
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
      console.log("[初始化] 已就绪，可运行 bun run start 或 bun run start:bg。");
      return 0;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    releaseStartup();
  }
  const { runManaged } = await import("./run-managed.ts");
  return runManaged(directory);
}

if (import.meta.main) {
  try {
    process.exitCode = await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "启动操作失败。");
    process.exitCode = 1;
  }
}
