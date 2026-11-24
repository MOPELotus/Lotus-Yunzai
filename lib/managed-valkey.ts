import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStorageClient, type StorageConnectionOptions } from "@lotus-yunzai/storage";
import { readOptionalLocalConfig } from "./config.ts";
import { parseStorageSettings } from "./valkey-config.ts";

// Published by https://valkey.io/download/releases/v8-1-12/ (official binary artifacts).
const release = {
  x64: ["x86_64", "4647bd3916c4220e64a8d7786fb22c4a97d5b5f9d04c0fcdc22e90f7e82c645a"],
  arm64: ["arm64", "b23349a6902295df4d3e49b1e56157706b0f0c88b0f63cba86f02b8148d91b22"],
} as const;
interface RecordFile { format: 1; password: string; socketPath: string; binary: string }
function location(root: URL) { return join(fileURLToPath(root), "data/valkey"); }
async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || await realpath(path) !== path) throw new Error("Valkey 目录必须为本机用户拥有的实体目录。");
  await chmod(path, 0o700);
}
async function record(root: URL, allowRelocate = false): Promise<RecordFile | undefined> {
  const filename = join(location(root), "managed.json");
  const info = await lstat(filename).catch(error => { if (error.code !== "ENOENT") throw error; });
  if (!info) return;
  if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077) throw new Error("托管 Valkey 配置权限必须为 0600。");
  const value = JSON.parse(await readFile(filename, "utf8")) as RecordFile;
  if (value.format !== 1 || !/^[a-f0-9]{64}$/u.test(value.password) || typeof value.binary !== "string" ||
      (!allowRelocate && value.socketPath !== socketPath(root))) throw new Error("托管 Valkey 配置无效或目录已迁移，请运行 bun run bootstrap 重新绑定本机实例。");
  return value;
}
function socketPath(root: URL) {
  const id = createHash("sha256").update(fileURLToPath(root)).digest("hex").slice(0, 24);
  return join(realpathSync(tmpdir()), `lotus-valkey-${process.getuid?.() ?? "user"}-${id}`, "server.sock");
}
export async function managedValkeyConnection(root: URL): Promise<StorageConnectionOptions | undefined> {
  const saved = await record(root);
  if (saved) return { host: "127.0.0.1", port: 0, database: 0, socketPath: saved.socketPath, password: saved.password };
}
async function explicitConnection(root: URL, env: Readonly<Record<string, string | undefined>>) {
  if (env.LOTUS_VALKEY_URL !== undefined) return env.LOTUS_VALKEY_URL;
  const config = await readOptionalLocalConfig(root, "redis");
  if (config?.enable === false) return false;
  return config ? parseStorageSettings(config) : undefined;
}
export async function verifyStorageConnection(connection: string | StorageConnectionOptions) {
  const client = createStorageClient(connection);
  client.on("error", () => {});
  try { await client.connect(); await client.ping(); }
  finally { if (client.isOpen) await client.disconnect(); }
}
async function command(argv: string[], cwd?: string, signal?: AbortSignal) {
  const child = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore", signal });
  if (await child.exited !== 0) throw new Error(`Valkey 工具执行失败：${argv[0]?.split("/").at(-1)}`);
}
async function usable(binary: string) {
  try { await command([binary, "--version"]); return true; } catch { return false; }
}
async function compileOfficial(directory: string, signal?: AbortSignal, progress?: (message: string) => void) {
  const make = Bun.which("make"), cc = Bun.which("cc"), tar = Bun.which("tar");
  if (!make || !cc || !tar) throw new Error("本机没有可兼容的 Valkey 二进制；编译需要 make、cc 和 tar，请安装后重新初始化。");
  progress?.("下载并校验官方 Valkey 8.1.12 源码，在项目目录编译");
  const response = await fetch("https://github.com/valkey-io/valkey/archive/refs/tags/8.1.12.tar.gz", { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error("Valkey 官方源码下载失败。");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== "675bd143a4c42022f7ce10fb012a7a61e0a70b139ff166e3e63fca2bdf05027b") throw new Error("Valkey 源码 SHA256 校验失败。");
  const source = join(directory, "source-build"), archive = join(directory, "source.tar");
  await privateDirectory(source); await writeFile(archive, Bun.gunzipSync(new Uint8Array(bytes)), { mode: 0o600 });
  await command([tar, "-xf", archive, "--strip-components=1", "-C", source], undefined, signal);
  await command([make, "-j2", "MALLOC=libc", "BUILD_TLS=no", "valkey-server"], source, signal);
  const binary = join(directory, "valkey-server");
  await copyFile(join(source, "src/valkey-server"), binary); await chmod(binary, 0o700);
  if (!await usable(binary)) throw new Error("Valkey 编译结果无法运行。");
  await rm(source, { recursive: true, force: true }); await rm(archive, { force: true });
  return binary;
}
async function prepareBinary(root: URL, install: boolean, signal?: AbortSignal, progress?: (message: string) => void) {
  const system = Bun.which("valkey-server");
  if (system && await usable(system)) { progress?.("使用系统 Valkey 可执行文件，启动本项目独立实例"); return system; }
  const directory = join(fileURLToPath(root), "data/tools/valkey");
  const binary = join(directory, "valkey-server");
  if (await usable(binary)) return binary;
  if (!install) throw new Error("Valkey 尚未初始化，请运行 bun run bootstrap。");
  if (process.platform === "win32") throw new Error("托管 Valkey 需要 Linux 或 macOS；Windows 请配置独立 Redis/Valkey 端点。");
  if (process.platform !== "linux" || !(process.arch in release)) { await privateDirectory(directory); return compileOfficial(directory, signal, progress); }
  const tar = Bun.which("tar");
  if (!tar) throw new Error("解包官方 Valkey 需要 tar，请安装后重新初始化。");
  await privateDirectory(directory);
  const [arch, digest] = release[process.arch as keyof typeof release];
  const url = `https://download.valkey.io/releases/valkey-8.1.12-jammy-${arch}.tar.gz`;
  const archive = join(directory, "release.tar");
  progress?.("下载并校验官方 Valkey 8.1.12");
  let bytes: Buffer | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error("下载失败");
      const candidate = Buffer.from(await response.arrayBuffer());
      if (candidate.length > 128 * 1024 ** 2 || createHash("sha256").update(candidate).digest("hex") !== digest) throw new Error("校验失败");
      bytes = candidate; break;
    } catch { signal?.throwIfAborted(); }
  }
  if (!bytes) throw new Error("官方 Valkey 下载或 SHA256 校验失败。");
  await writeFile(archive, Bun.gunzipSync(new Uint8Array(bytes)), { mode: 0o600 });
  const entries = await new Response(Bun.spawn([tar, "-tf", archive], { stdout: "pipe", stderr: "ignore" }).stdout).text();
  if (entries.split("\n").some(path => path.startsWith("/") || path.split("/").includes(".."))) throw new Error("Valkey 发布包路径无效。");
  // Only the executable is installed, not arbitrary archive contents or shell scripts.
  const member = entries.split("\n").find(path => path.endsWith("/bin/valkey-server") || path === "bin/valkey-server");
  if (!member) throw new Error("官方 Valkey 发布包缺少 valkey-server。");
  const extracted = Bun.spawn([tar, "-xOf", archive, member], { stdout: "pipe", stderr: "ignore" });
  const executable = await new Response(extracted.stdout).arrayBuffer();
  if (await extracted.exited !== 0) throw new Error("Valkey 解包失败。");
  await writeFile(binary, Buffer.from(executable), { mode: 0o700 });
  await rm(archive, { force: true });
  if (!await usable(binary)) return compileOfficial(directory, signal, progress);
  return binary;
}
async function socketListening(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const client = createConnection(path);
    const finish = (live: boolean) => { client.destroy(); resolve(live); };
    client.setTimeout(1_000);
    client.once("connect", () => finish(true));
    client.once("error", (error: NodeJS.ErrnoException) => finish(error.code !== "ENOENT" && error.code !== "ECONNREFUSED"));
    client.once("timeout", () => finish(true));
  });
}
async function assertRelocationHasNoWriter(directory: string) {
  const pid = Number(await readFile(join(directory, "valkey.pid"), "utf8").catch(() => ""));
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; }
  const refuse = () => new Error("旧 Valkey 实例仍可能使用迁移后的数据目录，请先停止原实例，再运行 bun run bootstrap。");
  if (process.platform !== "linux") throw refuse();
  const [current, working] = await Promise.all([stat(directory), stat(`/proc/${pid}/cwd`).catch(() => undefined)]);
  if (!working) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; }
    throw refuse();
  }
  if (current.dev === working.dev && current.ino === working.ino) throw refuse();
}
const quote = (text: string) => '"' + text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n") + '"';
/** Ordinary startup starts only an already-installed binary. It never downloads. */
export async function ensureManagedValkey(root: URL, { initialize = false, signal, env = Bun.env, progress }: {
  initialize?: boolean; signal?: AbortSignal; env?: Readonly<Record<string, string | undefined>>; progress?: (message: string) => void;
} = {}): Promise<{ managed: boolean; connection?: string | StorageConnectionOptions }> {
  const explicit = await explicitConnection(root, env);
  if (explicit === false) return { managed: false };
  if (explicit !== undefined) { await verifyStorageConnection(explicit); return { managed: false, connection: explicit }; }
  const directory = location(root);
  await privateDirectory(directory);
  const lock = join(directory, "startup.lock");
  const until = Date.now() + 20_000;
  while (true) {
    signal?.throwIfAborted();
    try { await mkdir(lock, { mode: 0o700 }); await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= until) throw new Error("Valkey 初始化锁被占用，请检查另一个启动进程。");
      try {
        const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8"));
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ESRCH") await rm(lock, { recursive: true, force: true }); }
        }
      } catch { const state = await lstat(lock).catch(() => undefined); if (state && Date.now() - state.mtimeMs > 30_000) await rm(lock, { recursive: true, force: true }); }
      await Bun.sleep(50);
    }
  }
  try {
    let saved = await record(root, initialize);
    if (saved && saved.socketPath !== socketPath(root)) {
      // A rename can preserve the live writer's cwd inode; a copy creates a separate directory.
      await assertRelocationHasNoWriter(directory);
      // A moved/copied data directory must never attach to the old checkout's socket.
      saved = { format: 1, binary: await prepareBinary(root, true, signal, progress), password: randomBytes(32).toString("hex"), socketPath: socketPath(root) };
      await rm(join(directory, "valkey.pid"), { force: true });
      await writeFile(join(directory, "managed.json"), JSON.stringify(saved), { mode: 0o600 });
    }
    if (!saved) {
      const binary = await prepareBinary(root, initialize, signal, progress);
      saved = { format: 1, binary, password: randomBytes(32).toString("hex"), socketPath: socketPath(root) };
      await writeFile(join(directory, "managed.json"), JSON.stringify(saved), { mode: 0o600, flag: "wx" });
    }
    const connection = (await managedValkeyConnection(root))!;
    try { await verifyStorageConnection(connection); return { managed: true, connection }; } catch { signal?.throwIfAborted(); }
    if (await socketListening(saved.socketPath)) throw new Error("本项目 Valkey Socket 已有服务，但认证或健康检查失败；不会接管该实例，请检查托管配置。");
    const pid = Number(await readFile(join(directory, "valkey.pid"), "utf8").catch(() => ""));
    if (Number.isSafeInteger(pid) && pid > 0) {
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
      if (alive) throw new Error("项目 Valkey 进程仍在运行但 Socket 不可用，拒绝重复启动，请检查本项目服务状态。");
    }
    if (!await usable(saved.binary)) {
      saved.binary = await prepareBinary(root, initialize, signal, progress);
      await writeFile(join(directory, "managed.json"), JSON.stringify(saved), { mode: 0o600 });
    }
    await privateDirectory(join(saved.socketPath, ".."));
    const config = join(directory, "valkey.conf");
    await writeFile(config + ".next", ["port 0", "protected-mode yes", `unixsocket ${quote(saved.socketPath)}`, "unixsocketperm 600",
      `requirepass ${quote(saved.password)}`, `dir ${quote(directory)}`, 'dbfilename "dump.rdb"', "appendonly yes", 'appendfsync everysec',
      'save 60 1', "daemonize yes", `pidfile ${quote(join(directory, "valkey.pid"))}`, `logfile ${quote(join(directory, "valkey.log"))}`].join("\n") + "\n", { mode: 0o600 });
    await (await import("node:fs/promises")).rename(config + ".next", config);
    progress?.("启动本项目 Valkey，检查本机独立 Socket 与持久化目录");
    await command([saved.binary, config], undefined, signal);
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      signal?.throwIfAborted();
      try { await verifyStorageConnection(connection); ready = true; break; } catch { await Bun.sleep(100); }
    }
    if (!ready) throw new Error("项目 Valkey 启动失败，请检查 data/valkey/valkey.log。");
    return { managed: true, connection };
  } finally { await rm(lock, { recursive: true, force: true }); }
}
async function managedWriterAlive(root: URL): Promise<boolean> {
  const directory = location(root);
  const text = await readFile(join(directory, "valkey.pid"), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (text === undefined) return false;
  const pid = Number(text.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("项目 Valkey PID 记录无效，无法确认停止状态。");
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  if (process.platform !== "linux") return true;
  const current = await stat(directory);
  const working = await stat(`/proc/${pid}/cwd`).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    const state = await readFile(`/proc/${pid}/stat`, "utf8").catch((failure: NodeJS.ErrnoException) => {
      if (failure.code !== "ENOENT") throw failure;
    });
    if (!state || /\) Z /u.test(state)) return;
    throw new Error("无法确认项目 Valkey 进程的数据目录。");
  });
  return Boolean(working && current.dev === working.dev && current.ino === working.ino);
}
/** Stop only this checkout's authenticated socket. Explicit external Redis is never stopped. */
export async function stopManagedValkey(root: URL): Promise<void> {
  const connection = await managedValkeyConnection(root);
  if (!connection) return;
  const socket = connection.socketPath!;
  const entry = await lstat(socket).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  if (entry && (!entry.isSocket() || entry.uid !== process.getuid?.())) throw new Error("项目 Valkey Socket 类型或所有者无效。");
  if (!entry || !await socketListening(socket)) {
    if (await managedWriterAlive(root)) throw new Error("项目 Valkey 进程仍在运行，但 Socket 不可用，请检查服务状态。");
    return; // Missing/refused socket plus no owned writer is an already-stopped service.
  }
  const client = createStorageClient(connection); client.on("error", () => {});
  try {
    try { await client.connect(); }
    catch (error) {
      // The daemon can complete a concurrent shutdown after the socket preflight.
      if (!await socketListening(socket) && !await managedWriterAlive(root)) return;
      throw error;
    }
    try { await client.sendCommand(["SHUTDOWN", "SAVE"]); }
    catch (error) {
      // Successful SHUTDOWN closes its socket without a Redis reply. Persistence
      // errors instead return an error reply and must remain visible to callers.
      if (!(error instanceof Error) || error.message !== "Socket closed unexpectedly") throw error;
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!await socketListening(socket) && !await managedWriterAlive(root)) return;
      await Bun.sleep(40);
    }
    throw new Error("项目 Valkey 尚未确认停止，请检查 data/valkey/valkey.log。");
  } finally { if (client.isOpen) await client.disconnect(); }
}
export async function initializeValkey(root: URL, signal: AbortSignal, progress?: (message: string) => void) {
  return ensureManagedValkey(root, { initialize: true, signal, progress });
}
