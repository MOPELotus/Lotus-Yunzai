import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lockFile } from "../lib/file-lock.ts";
import { backgroundCleanStop, backgroundStartupFailure } from "../lib/managed-exit.ts";
import { prepareStartup } from "./startup.ts";

const name = "lotus-yunzai";

function readCommand(args: string[]) {
  const [action, option, ...remaining] = args;
  if (action === "logs") return { action, options: args.slice(1) } as const;
  if (remaining.length === 0) {
    if (action === "init" && (option === undefined || option === "live" || option === "latest")) {
      return { action, channel: option as "live" | "latest" | undefined } as const;
    }
    if (option === undefined && (action === "start" || action === "start:bg" || action === "stop" || action === "status")) {
      return { action } as const;
    }
  }
  throw new Error("用法：bun run init [live|latest]、bun run start、bun run start:bg、bun run stop、bun run logs 或 bun run status。");
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

async function pm2(binary: string, root: string, action: "start:bg" | "stop" | "logs" | "status", options: readonly string[] = []) {
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
  async function application(path: string) {
    if (!await privateHome(path) || !await daemonListening(join(path, "rpc.sock"))) return;
    const lookup = Bun.spawn([binary, "jlist"], { ...spawnOptions(path), stdout: "pipe", timeout: 2_500 });
    const [code, result] = await Promise.all([lookup.exited, new Response(lookup.stdout).text()]);
    if (code !== 0) throw new Error("无法查询 PM2 应用。");
    let processes: unknown;
    try { processes = JSON.parse(result); }
    catch { throw new Error("无法读取 PM2 应用状态。"); }
    if (!Array.isArray(processes)) throw new Error("无法读取 PM2 应用状态。");
    const process = processes.find((item) => item?.name === name);
    if (!process) return;
    const status: unknown = process.pm2_env?.status;
    if (typeof status !== "string") throw new Error("无法读取 PM2 应用状态。");
    const pid: unknown = process.pid;
    return { path, active: status !== "stopped" && status !== "errored",
      pid: typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? String(pid) : undefined };
  }

  const current = await application(home);
  const legacy = current?.active ? undefined : await application(legacyHome);
  const active = [current, legacy].find((entry) => entry?.active);
  if (action !== "start:bg") {
    const selected = active ?? current ?? legacy;
    if (!selected) {
      if (action === "logs") throw new Error("当前目录暂无后台启动日志。");
      console.log("当前目录未启动后台托管。");
      return 0;
    }
    const args = action === "status" ? ["status"] : [action, name, ...options];
    return Bun.spawn([binary, ...args], spawnOptions(selected.path)).exited;
  }

  function readyPid(path: string) {
    return readFile(join(path, "host-ready"), "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    });
  }
  if (active) {
    if (!active.pid || active.pid !== await readyPid(active.path)) {
      throw new Error("当前目录已有后台进程。请运行 bun run status 查看状态。");
    }
    console.log("当前目录的后台宿主已运行。");
    return 0;
  }
  await mkdir(home, { mode: 0o700, recursive: true });
  await privateHome(home);
  const spawn = spawnOptions(home);
  const readyFile = join(home, "host-ready");
  const entry = await preparePm2Entry(home);
  await rm(readyFile, { force: true });
  const config = join(home, "host-process.json");
  await writeFile(config, JSON.stringify({ apps: [{
    name, cwd: parent, script: process.execPath, args: ["--no-env-file", entry, root, readyFile],
    interpreter: "none", autorestart: true, stop_exit_codes: [backgroundCleanStop, backgroundStartupFailure],
    min_uptime: 5_000, max_restarts: 5, wait_ready: true, listen_timeout: 120_000,
    kill_timeout: 20_000, vizion: false, pmx: false, treekill: false, time: true,
  }] }), { mode: 0o600 });
  const start = await Bun.spawn([binary, "start", config, "--only", name], spawn).exited;
  if (start !== 0) return start;

  // PM2 can report success after the child exits before ready or after its wait-ready timeout.
  // A new marker also proves readiness if the first worker has already entered crash recovery.
  if (/^[1-9]\d*$/u.test(await readyPid(home) ?? "")) return 0;
  await Bun.spawn([binary, "stop", name], spawn).exited;
  throw new Error("后台宿主未就绪。请运行 bun run logs --nostream 查看日志后重试。");
}

async function run() {
  const command = readCommand(Bun.argv.slice(2));
  const directory = await realpath(fileURLToPath(new URL("../", import.meta.url)));
  const root = pathToFileURL(directory + sep);
  if (command.action === "status" || command.action === "logs") {
    return pm2(pm2Executable(), directory, command.action, command.action === "logs" ? command.options : []);
  }

  // Managed replacement can rename the checkout while this lock is held.
  const lock = await lockFile(join(dirname(directory), `.${basename(directory)}.lotus-startup.sqlite`),
    "启动操作", 2_000, "当前目录正在执行启动操作，请稍后重试。");
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("启动操作已中止。"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (command.action === "stop") return await pm2(pm2Executable(), directory, "stop");
    const background = command.action === "start:bg" ? pm2Executable() : undefined;
    await prepareStartup(root, command.action === "init" ? command.channel : undefined, controller.signal);
    if (command.action === "init") {
      console.log("[初始化] 已就绪，可运行 bun run start 或 bun run start:bg。");
      return 0;
    }
    if (background) return await pm2(background, directory, "start:bg");
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    lock.close();
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
