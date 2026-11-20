import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lockFile } from "../lib/file-lock.ts";
import { backgroundStartupFailure } from "../lib/managed-exit.ts";
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

async function pm2(binary: string, root: string, action: "start:bg" | "stop" | "logs" | "status", options: readonly string[] = []) {
  const home = join(root, "data", ".pm2");
  if (action === "start:bg") await mkdir(home, { recursive: true, mode: 0o700 });
  const directory = await present(home);
  if (!directory) {
    if (action === "logs") throw new Error("当前目录暂无后台启动日志。");
    console.log("当前目录未启动后台托管。");
    return 0;
  }
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || directory.mode & 0o077) {
    throw new Error("data/.pm2 须为当前用户独占的实体目录（权限 0700）。");
  }

  // PM2 also accepts socket and state path overrides through environment variables.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PM2_")));
  env.PM2_HOME = home;
  const spawn = { cwd: root, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" } as const;
  if (action !== "start:bg") {
    const args = action === "status" ? ["status"] : [action, name, ...options];
    return Bun.spawn([binary, ...args], spawn).exited;
  }

  const readyFile = join(home, "host-ready");
  async function runningPid() {
    const lookup = Bun.spawn([binary, "pid", name], { ...spawn, stdout: "pipe" });
    const [code, result] = await Promise.all([lookup.exited, new Response(lookup.stdout).text()]);
    const pid = result.trim();
    return code === 0 && /^[1-9]\d*$/u.test(pid) ? pid : undefined;
  }
  function readyPid() {
    return readFile(readyFile, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    });
  }
  if ((await present(join(home, "rpc.sock")))?.isSocket()) {
    const pid = await runningPid();
    if (pid) {
      if (pid !== await readyPid()) throw new Error("当前目录已有后台进程。请运行 bun run status 查看状态。");
      console.log("当前目录的后台宿主已运行。");
      return 0;
    }
  }
  await rm(readyFile, { force: true });
  const config = join(home, "host-process.json");
  await writeFile(config, JSON.stringify({ apps: [{
    name, cwd: root, script: process.execPath, args: [join(root, "scripts", "run-managed.ts"), root, readyFile],
    interpreter: "none", autorestart: true, stop_exit_codes: [0, backgroundStartupFailure],
    min_uptime: 5_000, max_restarts: 5, wait_ready: true, listen_timeout: 120_000,
    kill_timeout: 20_000, vizion: false, pmx: false, treekill: false, time: true,
  }] }), { mode: 0o600 });
  const start = await Bun.spawn([binary, "start", config, "--only", name], spawn).exited;
  if (start !== 0) return start;

  // PM2 can report success after the child exits before ready or after its wait-ready timeout.
  // A new marker also proves readiness if the first worker has already entered crash recovery.
  if (/^[1-9]\d*$/u.test(await readyPid() ?? "")) return 0;
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
