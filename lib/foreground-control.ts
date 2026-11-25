import { createTranslator as createTextTranslator } from "../packages/i18n/index.ts";
import messageCatalog from "../i18n/zh-CN.json";
const $t = createTextTranslator("core", messageCatalog.messages);
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { lockFile, managedHostLockPath } from "./file-lock.ts";

const request = "lotus-stop-v1\n";
const busy = $t("lib.foreground-control.text_b7751da923");
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
    throw new Error($t("lib.foreground-control.text_fac593cbfc"));
  }
  return stat;
}

async function ownedSocket(path: string, uid: number, privateMode = true) {
  const stat = await present(path);
  if (stat && (!stat.isSocket() || stat.uid !== uid || privateMode && stat.mode & 0o077)) {
    throw new Error($t("lib.foreground-control.text_1248258867"));
  }
  return stat;
}

function listening(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const peer = createConnection(path);
    peer.setTimeout(handshakeTimeout, () => peer.destroy(new Error($t("lib.foreground-control.text_0dfba97ef0"))));
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
    throw new Error($t("lib.foreground-control.text_c8074b808f"));
  }
  try {
    const lock = await lockFile(file, $t("lib.foreground-control.text_e533bb7ee6"), 0, busy);
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
  if (!fields[0] || !/^[0-9]+$/u.test(fields[19] ?? "")) throw new Error($t("lib.foreground-control.text_f8a6b0dbc7"));
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
  if (!await privateDirectory(directory, uid)) throw new Error($t("lib.foreground-control.text_986ee657c0"));

  const previous = await ownedSocket(file, uid, false);
  if (previous) {
    if (await listening(file)) throw new Error($t("lib.foreground-control.text_ec70ac8770"));
    const current = await ownedSocket(file, uid, false);
    if (!current || current.ino !== previous.ino || current.dev !== previous.dev) {
      throw new Error($t("lib.foreground-control.text_181167d66b"));
    }
    await unlink(file);
  }
  const identity = await linuxProcess("self");
  if (process.platform === "linux" && !identity) throw new Error($t("lib.foreground-control.text_f8a6b0dbc7"));
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
    if (!await ownedSocket(file, uid)) throw new Error($t("lib.foreground-control.text_18a608f245"));
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
  if (!target) throw new Error($t("lib.foreground-control.text_98f4ff6590"));
  const { directory, file, uid } = target;
  const socket = await privateDirectory(directory, uid) && await ownedSocket(file, uid);
  const active = await activeInstallation(root, uid);
  if (!active) {
    if (socket) throw new Error($t("lib.foreground-control.text_4536ff162e"));
    return false;
  }
  if (!socket) throw new Error($t("lib.foreground-control.text_b1faffe7ae"));

  const deadline = performance.now() + stopTimeout;
  const result = await new Promise<{ pid: number; started: string }>((resolve, reject) => {
    const peer = createConnection(file);
    let response = "";
    let acknowledged: { pid: number; started: string } | undefined;
    const timer = setTimeout(() => peer.destroy(new Error($t("lib.foreground-control.text_b9995e0e55"))), stopTimeout);
    peer.setTimeout(handshakeTimeout, () => peer.destroy(new Error($t("lib.foreground-control.text_0dfba97ef0"))));
    peer.once("connect", () => peer.write(request));
    peer.on("data", data => {
      if (response.length + data.length > 64) return void peer.destroy(new Error($t("lib.foreground-control.text_da34438891")));
      response += data.toString("utf8");
      if (!response.endsWith("\n")) return;
      const match = /^([1-9]\d{0,9}) ([0-9]+|-)\n$/u.exec(response);
      const pid = Number(match?.[1]);
      const started = match?.[2];
      if (!started || !Number.isSafeInteger(pid) || pid > 2_147_483_647 ||
          (process.platform === "linux") !== (started !== "-")) {
        return void peer.destroy(new Error($t("lib.foreground-control.text_da34438891")));
      }
      acknowledged = { pid, started };
      peer.setTimeout(0);
    });
    peer.once("error", error => {
      reject(new Error($t("lib.foreground-control.text_f69232dd07"), { cause: error }));
    });
    peer.once("close", () => {
      clearTimeout(timer);
      if (acknowledged) resolve(acknowledged);
      else reject(new Error($t("lib.foreground-control.text_37e608563f")));
    });
  });
  while (await stillRunning(result.pid, result.started)) {
    if (performance.now() >= deadline) throw new Error($t("lib.foreground-control.text_5a0bb26b43"));
    await Bun.sleep(25);
  }
  return true;
}
