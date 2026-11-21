import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { lockFile, managedHostLockPath } from "./file-lock.ts";

const request = "lotus-stop-v1\n";
const busy = "当前目录已有托管宿主运行。";
const handshakeTimeout = 2_500;
const stopTimeout = 25_000;

function endpoint(root: string) {
  const uid = process.getuid?.();
  if (uid === undefined) return;
  // The socket name is independent of TMPDIR and stays below Unix's path length limit.
  const directory = join("/tmp", `lotus-yunzai-control-${uid}`);
  const file = join(directory, createHash("sha256").update(root).digest("hex") + ".sock");
  return { directory, file, uid };
}

async function present(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function privateDirectory(path: string, uid: number) {
  const stat = await present(path);
  if (stat && (!stat.isDirectory() || stat.uid !== uid || stat.mode & 0o077)) {
    throw new Error("前台控制目录须为当前用户独占的实体目录（权限 0700）。");
  }
  return stat;
}

async function ownedSocket(path: string, uid: number, privateMode = true) {
  const stat = await present(path);
  if (stat && (!stat.isSocket() || stat.uid !== uid || privateMode && stat.mode & 0o077)) {
    throw new Error("前台控制入口的类型、所有者或权限无法核实。");
  }
  return stat;
}

function listening(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const peer = createConnection(path);
    peer.setTimeout(handshakeTimeout, () => peer.destroy(new Error("前台控制入口没有响应。")));
    peer.once("connect", () => { peer.destroy(); resolve(true); });
    peer.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}

async function activeInstallation(root: string, uid: number): Promise<boolean> {
  const file = managedHostLockPath(root);
  const stat = await present(file);
  if (!stat) return false;
  if (!stat.isFile() || stat.uid !== uid || stat.mode & 0o022) {
    throw new Error("宿主管理锁的类型、所有者或权限无法核实。");
  }
  try {
    const lock = await lockFile(file, "托管宿主", 0, busy);
    lock.close();
    return false;
  } catch (error) {
    if (error instanceof Error && error.message === busy) return true;
    throw error;
  }
}

async function linuxProcess(pid: number | "self") {
  if (process.platform !== "linux") return;
  let stat: string;
  try { stat = await readFile(`/proc/${pid}/stat`, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (!fields[0] || !/^[0-9]+$/u.test(fields[19] ?? "")) throw new Error("无法核实前台主管的进程身份。");
  return { state: fields[0], start: fields[19]! };
}

async function stillRunning(pid: number, started: string): Promise<boolean> {
  if (process.platform === "linux") {
    const process = await linuxProcess(pid);
    return process !== undefined && process.start === started && process.state !== "Z" && process.state !== "X";
  }
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export async function serveForegroundControl(root: string, stop: () => void) {
  const target = endpoint(root);
  if (!target) return;
  const { directory, file, uid } = target;
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!await privateDirectory(directory, uid)) throw new Error("前台控制目录已丢失。");

  const previous = await ownedSocket(file, uid, false);
  if (previous) {
    if (await listening(file)) throw new Error("同一安装已有活动前台控制入口。");
    const current = await ownedSocket(file, uid, false);
    if (!current || current.ino !== previous.ino || current.dev !== previous.dev) {
      throw new Error("前台控制入口在启动期间被替换。");
    }
    await unlink(file);
  }
  const identity = await linuxProcess("self");
  if (process.platform === "linux" && !identity) throw new Error("无法核实前台主管的进程身份。");
  const receipt = `${process.pid} ${identity?.start ?? "-"}\n`;
  const pending = new Set<Socket>();
  const server = createServer(peer => {
    pending.add(peer);
    peer.unref();
    peer.on("error", () => {});
    peer.once("close", () => pending.delete(peer));
    peer.setTimeout(handshakeTimeout, () => peer.destroy());
    let command = "";
    peer.on("data", data => {
      if (command.length + data.length > request.length) return void peer.destroy();
      command += data.toString("utf8");
      if (!request.startsWith(command)) return void peer.destroy();
      if (command !== request) return;
      pending.delete(peer);
      peer.setTimeout(0);
      // Leave acknowledged connections open until the supervisor exits.
      peer.write(receipt);
      stop();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(file, () => { server.off("error", reject); resolve(); });
    });
    await chmod(file, 0o600);
    if (!await ownedSocket(file, uid)) throw new Error("前台控制入口已丢失。");
    server.unref();
  } catch (error) {
    server.close();
    for (const peer of pending) peer.destroy();
    throw error;
  }
  return () => {
    server.close();
    for (const peer of pending) peer.destroy();
  };
}

export async function stopForeground(root: string): Promise<boolean> {
  const target = endpoint(root);
  if (!target) throw new Error("当前系统不支持跨终端停止，请在运行终端按 Ctrl+C。");
  const { directory, file, uid } = target;
  const socket = await privateDirectory(directory, uid) && await ownedSocket(file, uid);
  const active = await activeInstallation(root, uid);
  if (!active) {
    if (socket) throw new Error("前台控制入口已过期，请重新启动宿主。");
    return false;
  }
  if (!socket) throw new Error("当前目录有活动托管宿主，无法核实前台停止入口。");

  const deadline = performance.now() + stopTimeout;
  const result = await new Promise<{ pid: number; started: string }>((resolve, reject) => {
    const peer = createConnection(file);
    let response = "";
    let acknowledged: { pid: number; started: string } | undefined;
    const timer = setTimeout(() => peer.destroy(new Error("等待前台宿主退出超时。")), stopTimeout);
    peer.setTimeout(handshakeTimeout, () => peer.destroy(new Error("前台控制入口没有响应。")));
    peer.once("connect", () => peer.write(request));
    peer.on("data", data => {
      if (response.length + data.length > 64) return void peer.destroy(new Error("前台控制回执无效。"));
      response += data.toString("utf8");
      if (!response.endsWith("\n")) return;
      const match = /^([1-9]\d{0,9}) ([0-9]+|-)\n$/u.exec(response);
      const pid = Number(match?.[1]);
      const started = match?.[2];
      if (!started || !Number.isSafeInteger(pid) || pid > 2_147_483_647 ||
          (process.platform === "linux") !== (started !== "-")) {
        return void peer.destroy(new Error("前台控制回执无效。"));
      }
      acknowledged = { pid, started };
      peer.setTimeout(0);
    });
    peer.once("error", error => {
      reject(new Error("无法完成前台停止，控制连接失败或超时。", { cause: error }));
    });
    peer.once("close", () => {
      clearTimeout(timer);
      if (acknowledged) resolve(acknowledged);
      else reject(new Error("前台控制连接在确认停止之前关闭。"));
    });
  });
  while (await stillRunning(result.pid, result.started)) {
    if (performance.now() >= deadline) throw new Error("等待原前台主管进程退出超时。");
    await Bun.sleep(25);
  }
  return true;
}
