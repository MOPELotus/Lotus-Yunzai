import { chmod, lstat, readFile, realpath, unlink } from "node:fs/promises";
import { createServer, STATUS_CODES } from "node:http";
import * as modules from "node:module";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const loopback = "127.0.0.1";
const managementPath = "/__web-mount__";
const maxRpcBody = 64 * 1024;
const rpcTimeout = 5_000;
const routes = new Set(["GET /data", "GET /config", "POST /config", "POST /reload", "POST /reset"]);

class StartupError extends Error {}
class InputError extends Error {
  constructor(status) {
    super(STATUS_CODES[status]);
    this.status = status;
  }
}

async function lookup(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function sameFile(a, b) {
  return a && b && a.dev === b.dev && a.ino === b.ino;
}

async function socketDirectory(path) {
  const parent = await lookup(path);
  if (!parent?.isDirectory() || (parent.mode & 0o7777) !== 0o700 ||
      parent.uid !== process.getuid() || await realpath(path) !== path) {
    throw new StartupError("RPC socket 须位于当前用户独占的 0700 实体目录。");
  }
  return parent;
}

async function acquireSocketLock(socketFile) {
  // Keep a stable inode so independent launches always contend for the same lock.
  const lockPath = `${socketFile}.lock.sqlite3`;
  const existing = await lookup(lockPath);
  if (existing && (!existing.isFile() || existing.uid !== process.getuid())) {
    throw new StartupError("RPC socket 锁文件类型或属主不符合要求。");
  }
  const { DatabaseSync } = await import("node:sqlite").catch(() => {
    throw new StartupError("此 Node.js 版本不支持内置 SQLite。");
  });
  let lock;
  try {
    lock = new DatabaseSync(lockPath);
    lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    return lock;
  } catch (error) {
    lock?.close();
    if (error.errcode === 5) throw new StartupError("RPC socket 正由另一个端口挂载进程使用。");
    throw new StartupError("RPC socket 锁不可用。");
  }
}

async function checkSocketDirectory(path, expected) {
  if (!sameFile(expected, await socketDirectory(path))) throw new StartupError("RPC socket 目录已变更。");
}

async function reclaimSocket(socketFile, parentDir, expectedParent) {
  const previous = await lookup(socketFile);
  if (!previous) return;
  if (!previous.isSocket() || previous.uid !== process.getuid() || (previous.mode & 0o7777) !== 0o600) {
    throw new StartupError("RPC socket 路径已存在。");
  }
  const result = await new Promise(resolve => {
    const probe = createConnection({ path: socketFile });
    const finish = code => {
      probe.destroy();
      resolve(code);
    };
    probe.once("connect", () => finish("connected"));
    probe.once("error", error => finish(error.code));
    probe.setTimeout(500, () => finish("timeout"));
  });
  await checkSocketDirectory(parentDir, expectedParent);
  const current = await lookup(socketFile);
  if (!current && (result === "ECONNREFUSED" || result === "ENOENT")) return;
  if (result !== "ECONNREFUSED" || !sameFile(previous, current)) {
    throw new StartupError("RPC socket 已被占用或无法确认其监听状态。");
  }
  await unlink(socketFile);
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    const ready = () => {
      server.removeListener("error", reject);
      resolve();
    };
    server.once("error", reject);
    server.listen(endpoint, ready);
  });
}

function tracked(server) {
  const sockets = new Set();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return async () => {
    if (!server.listening) return;
    const stopped = new Promise(resolve => server.close(resolve));
    // Upgraded sockets and active SSE can outlive Server.close().
    const deadline = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
    }, 750);
    await stopped;
    clearTimeout(deadline);
    for (const socket of sockets) socket.destroy();
  };
}

function hiddenManagement(url) {
  const matches = path => path === managementPath || path.startsWith(managementPath + "/");
  // Upstream checks the raw path, including any dot segments, before routing business requests.
  if (matches(url.split("?", 1)[0])) return true;
  try {
    const path = decodeURIComponent(new URL(url, `http://${loopback}`).pathname).toLowerCase();
    return matches(path);
  } catch {
    return true;
  }
}

function rejectUpgrade(_req, socket) {
  socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

async function readRpcBody(req) {
  const length = Number(req.headers["content-length"] ?? 0);
  if (length > maxRpcBody) throw new InputError(413);
  if (!length && !req.headers["transfer-encoding"]) return;
  if (req.method !== "POST") throw new InputError(400);
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new InputError(415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxRpcBody) throw new InputError(413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new InputError(400);
  }
}

function rpcHandler(handlers, canServe) {
  return async (req, res) => {
    if (!canServe()) {
      req.resume();
      json(res, 503, { ok: false });
      return;
    }
    const key = `${req.method} ${req.url}`;
    const handler = handlers.get(key);
    if (!handler) {
      req.resume();
      json(res, 404, { ok: false });
      return;
    }
    const deadline = setTimeout(() => {
      if (!res.headersSent && !res.destroyed) {
        res.setHeader("Connection", "close");
        json(res, 408, { ok: false });
      }
    }, rpcTimeout);
    try {
      const body = await readRpcBody(req);
      if (res.writableEnded || res.destroyed) return;
      if (!canServe()) {
        json(res, 503, { ok: false });
        return;
      }
      if (key === "POST /config" && (!body || typeof body !== "object" || Array.isArray(body))) {
        throw new InputError(400);
      }
      let status = 200;
      const response = {
        status(code) {
          if (!Number.isInteger(code) || code < 200 || code > 599) throw new Error();
          status = code;
          return response;
        },
        json(data) {
          if (!res.headersSent && !res.destroyed) json(res, status, status >= 500 ? { ok: false } : data);
          return response;
        },
      };
      await handler({ body }, response);
      if (!res.headersSent && !res.destroyed) json(res, 500, { ok: false });
    } catch (error) {
      req.resume();
      if (!res.headersSent && !res.destroyed) {
        res.setHeader("Connection", "close");
        json(res, error instanceof InputError ? error.status : 500, { ok: false });
      }
    } finally {
      clearTimeout(deadline);
    }
  };
}

async function loadPlugin(entry) {
  if (typeof modules.registerHooks !== "function") throw new StartupError("此 Node.js 版本不支持 registerHooks。");
  const base = "data:text/javascript,export default class Plugin {}";
  const hooks = modules.registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === entry.href && specifier === "../../lib/plugins/plugin.js") {
        return next(base, context);
      }
      return next(specifier, context);
    },
  });
  try {
    return (await import(entry.href)).default;
  } finally {
    hooks.deregister();
  }
}

async function main() {
  const [pluginArg, socketFile, rawPort] = process.argv.slice(2);
  if (process.argv.length !== 5 || typeof process.getuid !== "function" ||
      !isAbsolute(pluginArg) || !isAbsolute(socketFile) || resolve(socketFile) !== socketFile ||
      !/^(?:0|[1-9]\d{0,4})$/.test(rawPort) || Number(rawPort) > 65_535) {
    throw new StartupError("用法：node scripts/web-mount-node.mjs <原版插件绝对目录> <私有 RPC socket 绝对路径> <回环端口>");
  }

  const directory = await realpath(pluginArg);
  const pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (pkg?.name !== "web-mount" || pkg.version !== "1.5.18" || pkg.type !== "module") {
    throw new StartupError("仅支持显式指定的原版 web-mount 1.5.18 目录。");
  }
  const parentDir = dirname(socketFile);
  const expectedParent = await socketDirectory(parentDir);

  process.umask(0o077);
  let lock;
  let middleware;
  let stopping = false;
  let shutdownRequested = false;
  let ready = false;
  let socketFileState;
  let runtimeState;
  const business = createServer((req, res) => {
    if (hiddenManagement(req.url)) {
      res.writeHead(404).end();
      return;
    }
    try {
      middleware(req, res, () => res.writeHead(404).end());
    } catch {
      if (res.headersSent) res.destroy();
      else res.writeHead(500).end();
    }
  });
  // The original plugin captures the host's upgrade listener for unmatched paths.
  business.on("upgrade", rejectUpgrade);

  const handlers = new Map();
  const rpc = createServer({ requestTimeout: rpcTimeout, headersTimeout: rpcTimeout },
    rpcHandler(handlers, () => ready && !stopping));
  const closeBusiness = tracked(business);
  const closeRpc = tracked(rpc);

  async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(runtimeState?.timer);
    try {
      await Promise.all([closeBusiness(), closeRpc()]);
      if (socketFileState) {
        await checkSocketDirectory(parentDir, expectedParent);
        if (sameFile(socketFileState, await lookup(socketFile))) await unlink(socketFile);
      }
    } finally {
      lock?.close();
    }
  }
  const shutdown = () => {
    shutdownRequested = true;
    if (ready) void stop().catch(() => { process.exitCode = 1; });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  globalThis.Bot = {
    server: business,
    express: {
      quiet: [],
      use(handler) {
        if (middleware || typeof handler !== "function") throw new Error("异常的 Node HTTP 注册。");
        middleware = handler;
      },
    },
  };
  // Upstream logs can include raw request headers or backend information.
  const quiet = () => {};
  globalThis.logger = { trace: quiet, debug: quiet, mark: quiet, info: quiet, warn: quiet, error: quiet };

  try {
    lock = await acquireSocketLock(socketFile);
    await reclaimSocket(socketFile, parentDir, expectedParent);
    const entry = pathToFileURL(join(directory, "index.js"));
    const Plugin = await loadPlugin(entry);
    ({ state: runtimeState } = await import(pathToFileURL(join(directory, "lib/status.js")).href));
    if (!await new Plugin().init() || !middleware) throw new StartupError("原版 web-mount 初始化失败。");

    const upgrade = business.listeners("upgrade");
    if (upgrade.length !== 1 || upgrade[0] === rejectUpgrade) {
      throw new StartupError("原版 web-mount 未注册预期的 WS 处理。");
    }
    business.removeListener("upgrade", upgrade[0]);
    business.on("upgrade", (req, socket, head) => {
      if (hiddenManagement(req.url)) {
        rejectUpgrade(req, socket);
        return;
      }
      upgrade[0].call(business, req, socket, head);
    });

    const guoba = await import(pathToFileURL(join(directory, "guoba/index.js")).href);
    guoba.init({
      logger: globalThis.logger,
      registerPage() {},
      registerApi(method, path, handler) {
        const key = `${method.toUpperCase()} ${path}`;
        if (!routes.has(key) || handlers.has(key) || typeof handler !== "function") throw new Error("异常的锅巴接口注册。");
        handlers.set(key, handler);
      },
    });
    if (handlers.size !== routes.size) throw new StartupError("原版 web-mount 未注册全部配置接口。");
    if (shutdownRequested) { await stop(); return; }

    // Apply a stricter mask while binding the Unix socket, without changing directory creation for the plugin.
    await checkSocketDirectory(parentDir, expectedParent);
    const fileMask = process.umask(0o177);
    try {
      await listen(rpc, { path: socketFile });
    } finally {
      process.umask(fileMask);
    }
    socketFileState = await lstat(socketFile);
    if (!socketFileState.isSocket() || socketFileState.uid !== process.getuid() ||
        !sameFile(expectedParent, await socketDirectory(parentDir))) {
      throw new StartupError("RPC socket 位置或属主不符合要求。");
    }
    await chmod(socketFile, 0o600);
    if (shutdownRequested) { await stop(); return; }
    try {
      await listen(business, { host: loopback, port: Number(rawPort) });
    } catch (error) {
      if (error.code === "EADDRINUSE") throw new StartupError(`端口挂载业务端口 ${rawPort} 已被占用。`);
      throw error;
    }
    if (shutdownRequested) { await stop(); return; }
    ready = true;
    console.log(JSON.stringify({ port: business.address().port }));
  } catch (error) {
    await stop();
    throw error;
  }
}

main().catch(error => {
  console.error(error instanceof StartupError ? error.message : "原版 web-mount 无法启动。");
  process.exitCode = 1;
});
